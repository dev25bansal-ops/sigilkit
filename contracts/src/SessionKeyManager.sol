// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SpendPolicy} from "./SpendPolicy.sol";
import {MerkleWhitelist} from "./MerkleWhitelist.sol";
import {ActionLogger} from "./ActionLogger.sol";

/// @title SessionKeyManager
/// @notice Agent-first session-key manager: scoped keys with on-chain spend caps,
///         fixed-window (tumbling) rate limits, Merkle target whitelists, and a mandatory
///         audit event per executed action.
/// @dev Security model:
///      - The agent (session key holder) is treated as UNTRUSTED. A compromised agent or SDK
///        cannot exceed the granted scope: caps are enforced here, not off-chain.
///      - Owner-only functions are unreachable through executeWithSessionKey (INV-4): they are
///        gated by onlyOwner, and additionally every selector in `ownerOnlySelectors` is denied
///        to session keys even when targeting other contracts.
///      - Every successful inner call emits ActionLogged (INV-3); there is no silent success path.
///      - Storage uses an ERC-7201 namespaced slot so the manager can sit behind proxies or
///        coexist with facet storage without collision.
contract SessionKeyManager is ActionLogger {
    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error NotOwner();
    error KeyUnknown();
    error KeyRevoked();
    error KeyExpired();
    error RequestExpired();
    error NonceUsed();
    error SelectorDenied(bytes4 selector);
    error TargetNotAllowed(address target, bytes4 selector);
    error InnerCallFailed();
    error ValueNotAccepted();
    error InvalidScope();
    error InvalidSignature();
    error OverlapBeyondOldExpiry();
    error WithdrawFailed();
    error OwnerCountersignRequired();
    error InvalidOwnerApproval();
    error NativeDeltaExceeded(uint256 balanceBefore, uint256 balanceAfter, uint256 declared);

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------
    /// @notice Scope granted to a session key. All fields immutable once granted.
    struct Scope {
        uint48 expiresAt; // hard expiry; must be in the future at grant time
        uint48 windowSeconds; // fixed (tumbling) window length for the spend cap
        uint256 perActionCap; // max native value per single action
        uint256 perWindowCap; // max cumulative native value per fixed (tumbling) window
        bytes32 merkleRoot; // root over keccak(target,selector,argsHash) leaves (v2: argsHash binds calldata, 0 = wildcard); 0 = allow ALL (dangerous)
        uint256 countersignAbove; // E10: actions with value > this need an owner approval signature; 0 = never
        bool enforceNativeDelta; // E11: the inner call must not siphon native value beyond `value`
        address[] tokenWatchlist; // E11: up to 8 tokens whose balances must not net-decrease beyond declared amounts
    }

    /// @notice EIP-712 signed action request.
    struct ActionRequest {
        bytes32 agentId;
        address target;
        bytes4 selector;
        uint256 value;
        uint256 nonce;
        uint48 expiry; // request-level expiry (<= key expiry recommended)
        bytes32 rationaleHash; // hash of off-chain rationale; plaintext never on-chain
        bytes data; // calldata suffix appended after `selector`
    }

    using SpendPolicy for SpendPolicy.WindowState;

    // ERC-7201 namespaced storage slot (cast index-erc7201 "sigilkit.storage.SessionKeyManager").
    bytes32 private constant _STORAGE_LOCATION =
        0xff085e2083c01c9e351b5b4768e82a6e2037764ef8b048b601e1aeafbe014800;

    struct ManagerStorage {
        address owner;
        mapping(address key => Scope scope) scopes;
        mapping(address key => bool revoked) revoked;
        mapping(address key => SpendPolicy.WindowState) windows;
        mapping(address key => uint256 nonce) nonces;
        mapping(bytes4 selector => bool denied) ownerOnlySelectors;
        bool reentrancyLocked;
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SessionKeyGranted(address indexed key, uint48 expiresAt);
    event SessionKeyRevoked(address indexed key);
    event SessionKeyRotated(address indexed oldKey, address indexed newKey, uint48 overlapEnds);
    event OwnerOnlySelectorSet(bytes4 indexed selector, bool denied);
    /// @notice A previously revoked key was reinstated by a fresh grant of the same address.
    event SessionKeyReinstated(address indexed key);
    event TreasuryWithdrawal(address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // EIP-712
    // ------------------------------------------------------------------
    bytes32 private constant _ACTION_REQUEST_TYPEHASH =
        keccak256(
            "ActionRequest(bytes32 agentId,address target,bytes4 selector,uint256 value,uint256 nonce,uint48 expiry,bytes32 rationaleHash,bytes data)"
        );
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("SigilKit");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    /// @notice E10: owner countersignature typehash over a request digest.
    bytes32 private constant _REQUEST_APPROVAL_TYPEHASH =
        keccak256("RequestApproval(bytes32 requestDigest)");
    /// @notice E11: hard cap on watchlist length (gas bound on balance snapshots).
    uint256 private constant MAX_WATCHED_TOKENS = 8;

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------
    modifier onlyOwner() {
        if (msg.sender != _manager().owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        ManagerStorage storage s = _manager();
        if (s.reentrancyLocked) revert InnerCallFailed();
        s.reentrancyLocked = true;
        _;
        s.reentrancyLocked = false;
    }

    // ------------------------------------------------------------------
    // Construction / ownership
    // ------------------------------------------------------------------
    constructor(address owner_) {
        if (owner_ == address(0)) revert NotOwner();
        _manager().owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        // Deny self-administration from session keys by default (defense in depth; these are
        // already onlyOwner-gated).
        //
        // CQ-1: use the contract-qualified selector form rather than `this.f.selector`.
        // `this` in a constructor trips solc warning 5805 ("external functions cannot be
        // called while constructing") — the selectors are compile-time constants, so the
        // qualified form is both warning-free and clearer about intent.
        _setSelectorDenied(SessionKeyManager.grantSessionKey.selector, true);
        _setSelectorDenied(SessionKeyManager.revokeSessionKey.selector, true);
        _setSelectorDenied(SessionKeyManager.rotateSessionKey.selector, true);
        _setSelectorDenied(SessionKeyManager.transferOwnership.selector, true);
        _setSelectorDenied(SessionKeyManager.setSelectorDenied.selector, true);
        _setSelectorDenied(SessionKeyManager.withdraw.selector, true);
    }

    receive() external payable {} // fund the wallet so agents can spend from it

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert NotOwner();
        emit OwnershipTransferred(_manager().owner, newOwner);
        _manager().owner = newOwner;
    }

    function owner() external view returns (address) {
        return _manager().owner;
    }

    // ------------------------------------------------------------------
    // Admin: key lifecycle (owner only)
    // ------------------------------------------------------------------
    function grantSessionKey(address key, Scope calldata scope) external onlyOwner {
        _validateScope(key, scope);
        ManagerStorage storage s = _manager();
        if (s.revoked[key]) {
            // This grant reinstates a previously revoked key — make the reversal
            // observable instead of silently clearing the revocation (issues catalog S5).
            emit SessionKeyReinstated(key);
        }
        s.scopes[key] = scope;
        s.revoked[key] = false;
        emit SessionKeyGranted(key, scope.expiresAt);
    }

    /// @notice Owner-only treasury recovery (issues catalog S6): the only sanctioned way
    ///         to move funds out besides scoped agent execution. Denylisted from session
    ///         keys by default like the other admin selectors.
    /// @dev Slither missing-zero-check: a zero `to` would permanently burn the funds
    ///      (no burn semantics intended), so it is rejected outright.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert WithdrawFailed();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit TreasuryWithdrawal(to, amount);
    }

    function revokeSessionKey(address key) external onlyOwner {
        if (_manager().scopes[key].expiresAt == 0) revert KeyUnknown();
        _manager().revoked[key] = true;
        emit SessionKeyRevoked(key);
    }

    /// @notice Grants `newKey` and shortens `oldKey`'s life to `overlapEnds` (bounded by its
    ///         existing expiry). Overlap avoids an agent blackout between rotation steps.
    function rotateSessionKey(address oldKey, address newKey, Scope calldata newScope, uint48 overlapEnds)
        external
        onlyOwner
    {
        // Reject unknown keys outright: with expiresAt==0 the only surviving path
        // (overlapEnds==0) would emit spurious Revoked/Rotated events for a key
        // that never existed.
        if (oldKey != address(0) && _manager().scopes[oldKey].expiresAt == 0) revert KeyUnknown();
        if (overlapEnds > _manager().scopes[oldKey].expiresAt) revert OverlapBeyondOldExpiry();
        _grant(oldKey, newKey, newScope, overlapEnds);
    }

    function _grant(address oldKey, address newKey, Scope calldata newScope, uint48 overlapEnds)
        internal
    {
        _validateScope(newKey, newScope);
        ManagerStorage storage s = _manager();
        if (s.revoked[newKey]) {
            emit SessionKeyReinstated(newKey); // rotation reinstates a revoked newKey
        }
        s.scopes[newKey] = newScope;
        s.revoked[newKey] = false;
        emit SessionKeyGranted(newKey, newScope.expiresAt);
        if (oldKey != address(0)) {
            // Rotation overlap: if the overlap already elapsed, revoke the old key outright.
            // Time-based by design; validator drift of seconds only affects whether the old
            // key is revoked now or expires naturally at `overlapEnds`.
            // forge-lint: disable-next-line(block-timestamp)
            if (overlapEnds <= block.timestamp) {
                s.revoked[oldKey] = true;
                emit SessionKeyRevoked(oldKey);
            } else {
                s.scopes[oldKey].expiresAt = overlapEnds;
            }
            emit SessionKeyRotated(oldKey, newKey, overlapEnds);
        }
    }

    function _validateScope(address key, Scope calldata scope) internal view {
        if (key == address(0)) revert InvalidScope();
        // Grant-time sanity check: the expiry must be in the future. Time-based by design.
        // forge-lint: disable-next-line(block-timestamp)
        if (uint256(scope.expiresAt) <= block.timestamp) revert InvalidScope(); // expiry in past
        if (scope.perActionCap == 0) revert InvalidScope(); // value cap zero
        if (scope.perWindowCap < scope.perActionCap) revert InvalidScope(); // window below action cap
        if (scope.windowSeconds == 0) revert InvalidScope();
        if (scope.tokenWatchlist.length > MAX_WATCHED_TOKENS) revert InvalidScope(); // E11 gas bound
    }

    /// @notice Adds/removes a selector from the session-key denylist. Session keys can NEVER
    ///         call a denied selector on ANY target (INV-4, defense in depth beyond onlyOwner).
    function setSelectorDenied(bytes4 selector, bool denied) external onlyOwner {
        _setSelectorDenied(selector, denied);
    }

    function _setSelectorDenied(bytes4 selector, bool denied) internal {
        _manager().ownerOnlySelectors[selector] = denied;
        emit OwnerOnlySelectorSet(selector, denied);
    }

    // ------------------------------------------------------------------
    // Agent execution path
    // ------------------------------------------------------------------
    /// @notice Executes `request` if it carries a valid signature from an active, in-scope
    ///         session key. Permissionless to call (anyone may relay); authorization comes
    ///         entirely from the signature.
    /// @param request The signed action request.
    /// @param signature EIP-712 signature over the request, from the session key.
    /// @param merkleProof Sorted-pair Merkle proof over the v2 whitelist leaves;
    ///        required when the key's scope has a non-zero merkleRoot, ignored otherwise.
    /// @param ownerApproval EIP-712 owner signature over `RequestApproval(requestDigest)`
    ///        — required (non-empty) iff the scope sets `countersignAbove` and
    ///        `request.value` exceeds it (graduated authority, enhancement E10). The
    ///        digest binding makes approvals single-use by construction. Ignored
    ///        otherwise; the owner's own key is always exempt.
    function executeWithSessionKey(
        ActionRequest calldata request,
        bytes calldata signature,
        bytes32[] calldata merkleProof,
        bytes calldata ownerApproval
    ) external payable nonReentrant {
        if (msg.value != 0) revert ValueNotAccepted(); // value flows from wallet balance, not relayer

        ManagerStorage storage s = _manager();

        // --- Signature & key state ---
        address signer = _recover(request, signature);
        Scope storage scope = s.scopes[signer];
        if (scope.expiresAt == 0) revert KeyUnknown();
        if (s.revoked[signer]) revert KeyRevoked();
        // INV-2: key hard expiry, and the request's own expiry. Both are time-based by
        // design; a validator shifting the clock by seconds can only tighten or loosen the
        // final moments of a key — it cannot exceed the spend caps, which are enforced
        // independently below.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > scope.expiresAt) revert KeyExpired(); // INV-2
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > request.expiry) revert RequestExpired();

        // --- Graduated authority (E10): owner countersign for large actions ---
        if (scope.countersignAbove != 0 && request.value > scope.countersignAbove) {
            if (signer != s.owner) {
                if (ownerApproval.length == 0) revert OwnerCountersignRequired();
                bytes32 requestDigest = _requestDigest(request);
                bytes32 approvalDigest = keccak256(
                    abi.encodePacked("\x19\x01", _domainSeparator(), _approvalStructHash(requestDigest))
                );
                if (_ecrecover(approvalDigest, ownerApproval) != s.owner) {
                    revert InvalidOwnerApproval();
                }
            }
            // The owner's own session key carries owner authority — exempt.
        }
        // Approval binds the full request digest → single-use by nonce uniqueness.

        // --- Replay protection ---
        if (request.nonce != s.nonces[signer]) revert NonceUsed();
        s.nonces[signer] = request.nonce + 1; // effect before interaction

        // --- Privilege containment (INV-4) ---
        if (s.ownerOnlySelectors[request.selector]) revert SelectorDenied(request.selector);

        // --- Target whitelist ---
        // Leaf format v2: leaves commit the calldata too, so a whitelisted entry can
        // bind the EXACT arguments (e.g. one specific token transfer) — the fix for
        // "whitelisted token selectors are uncapped". argsHash == 0 is the wildcard
        // leaf (selector whitelisted for any calldata); keccak256 of real data is
        // never zero, so pinned and wildcard leaves never collide.
        if (scope.merkleRoot != bytes32(0)) {
            if (!_targetAllowed(scope.merkleRoot, request.target, request.selector, request.data, merkleProof))
            {
                revert TargetNotAllowed(request.target, request.selector);
            }
        }
        // merkleRoot == 0 means "allow all" — documented as dangerous; owners should always
        // grant a real root in production.

        // --- Spend caps: checks + effects BEFORE the inner call (CEI) ---
        s.windows[signer].enforce(
            address(this), signer, request.value, scope.perActionCap, scope.perWindowCap, scope.windowSeconds
        );

        // --- Interaction + balance-delta verification (E2/E11) ---
        _interact(scope, request);

        // --- Mandatory audit (INV-3): no silent success path ---
        _logAction(request.agentId, request.target, request.selector, request.value, request.rationaleHash);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    function getScope(address key) external view returns (Scope memory) {
        return _manager().scopes[key];
    }

    function isRevoked(address key) external view returns (bool) {
        return _manager().revoked[key];
    }

    function getNonce(address key) external view returns (uint256) {
        return _manager().nonces[key];
    }

    function getWindowState(address key) external view returns (SpendPolicy.WindowState memory) {
        return _manager().windows[key];
    }

    function isSelectorDenied(bytes4 selector) external view returns (bool) {
        return _manager().ownerOnlySelectors[selector];
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator();
    }

    function ACTION_REQUEST_TYPEHASH() external pure returns (bytes32) {
        return _ACTION_REQUEST_TYPEHASH;
    }

    function REQUEST_APPROVAL_TYPEHASH() external pure returns (bytes32) {
        return _REQUEST_APPROVAL_TYPEHASH;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------
    /// @dev The interaction step, isolated in its own frame (stack-depth): snapshot
    ///      balances (E11), make the inner call with revert-data bubbling (E2), then
    ///      verify balances. Runs inside the reentrancy lock; reverts roll everything
    ///      back, so the CEI ordering is preserved.
    /// @dev Slither arbitrary-send-eth: the sole production call site is
    ///      executeWithSessionKey, AFTER recovery of an active owner-granted key,
    ///      request/nonce/selector checks, the scope's Merkle check, and native
    ///      per-action/per-window charging. The signature binds target and value;
    ///      a zero Merkle root deliberately authorizes any target within those caps.
    ///      Keep those checks before every call to this helper (including subclasses).
    ///      Regression coverage: NativeTransferAuthorizationTest.
    // slither-disable-next-line arbitrary-send-eth
    function _interact(Scope storage scope, ActionRequest calldata request) internal {
        BalanceSnapshot memory snap = _snapshotBalances(scope);
        (bool ok, bytes memory ret) =
            request.target.call{value: request.value}(abi.encodePacked(request.selector, request.data));
        if (!ok) _revertInnerCall(ret);
        _verifyBalances(scope, snap, request.value, _declaredTokenOutflow(request.selector, request.data));
    }

    /// @dev Pre/post balance capture for the E11 delta check. One memory struct keeps
    ///      the execution frame shallow.
    struct BalanceSnapshot {
        uint256 nativeBefore;
        uint256[] tokenBalances;
    }

    function _snapshotBalances(Scope storage scope) internal view returns (BalanceSnapshot memory snap) {
        if (!scope.enforceNativeDelta) return snap;
        snap.nativeBefore = address(this).balance;
        uint256 n = scope.tokenWatchlist.length;
        if (n > MAX_WATCHED_TOKENS) n = MAX_WATCHED_TOKENS;
        snap.tokenBalances = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            snap.tokenBalances[i] = _erc20BalanceOf(scope.tokenWatchlist[i], address(this));
        }
    }

    /// @dev After the inner call: native balance must not have dropped by more than the
    ///      declared value, and watched tokens must not have net-decreased by more than
    ///      the amount their standard transfer selector declared (0 otherwise).
    function _verifyBalances(
        Scope storage scope,
        BalanceSnapshot memory snap,
        uint256 declaredNative,
        uint256 declaredTokens
    ) internal view {
        if (!scope.enforceNativeDelta) return;
        if (address(this).balance < snap.nativeBefore - declaredNative) {
            revert NativeDeltaExceeded(snap.nativeBefore, address(this).balance, declaredNative);
        }
        for (uint256 i = 0; i < snap.tokenBalances.length; ++i) {
            uint256 afterBal = _erc20BalanceOf(scope.tokenWatchlist[i], address(this));
            if (snap.tokenBalances[i] > afterBal + declaredTokens) {
                revert NativeDeltaExceeded(snap.tokenBalances[i], afterBal, declaredTokens);
            }
        }
    }

    /// @dev Bubbles recognizable inner revert reasons (enhancement E2): empty reason
    ///      (plain require(false)) is indistinguishable from a bare failure and stays
    ///      InnerCallFailed; Error(string)/Panic and known SigilKit errors pass through
    ///      so integrators see WHY the target failed. Unknown selectors keep the
    ///      blanket error — INV: every revert of this contract is identifiable.
    function _revertInnerCall(bytes memory reason) internal pure {
        if (reason.length >= 4) {
            // Canonical selectors: Error(string) = 0x08c379a0, Panic(uint256) = 0x4e487b71.
            // The length check above guarantees a full selector is present, so the cast
            // truncates padding, not data.
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes4 sel = bytes4(reason);
            if (
                sel == 0x08c379a0 || sel == 0x4e487b71
                    || sel == SpendPolicy.PerActionCapExceeded.selector
                    || sel == SpendPolicy.PerWindowCapExceeded.selector
            ) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
        }
        revert InnerCallFailed();
    }

    /// @dev Whitelist check against leaf format v2: the proof must verify against
    ///      either the pinned leaf (commits keccak256(data)) or the wildcard leaf
    ///      (argsHash == 0 — any calldata for this target+selector).
    function _targetAllowed(
        bytes32 root,
        address target,
        bytes4 selector,
        bytes calldata data,
        bytes32[] calldata proof
    ) internal pure returns (bool) {
        bytes32 argsHash = keccak256(data);
        if (MerkleWhitelist.verify(proof, root, keccak256(abi.encode(target, selector, argsHash)))) {
            return true;
        }
        if (
            argsHash != bytes32(0)
                && MerkleWhitelist.verify(
                    proof, root, keccak256(abi.encode(target, selector, bytes32(0)))
                )
        ) {
            return true;
        }
        return false;
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
    }

    /// @dev Internal-virtual so symbolic-verification harnesses can pin the recovered
    ///      signer and spec the non-signature properties (replay, expiry, denylist,
    ///      nonce accounting) independently of ECDSA — Halmos models ecrecover as an
    ///      uninterpreted function, so the recovery result must be assumed, not proven.
    function _recover(ActionRequest calldata request, bytes calldata signature)
        internal
        view
        virtual
        returns (address)
    {
        bytes32 digest = _requestDigest(request);
        // 65-byte signatures take the ECDSA path. Any other length is an ERC-1271
        // smart-account session key (E17): address(keyContract) || 1271 signature.
        // The owner grants the scope to the 1271 CONTRACT's address; the contract
        // proves control of the digest via isValidSignature (staticcall — read-only,
        // so no reentrancy surface before the effects).
        if (signature.length != 65) {
            if (signature.length < 20) revert InvalidSignature();
            address keyContract = address(bytes20(signature[0:20]));
            uint256 codeSize;
            assembly ("memory-safe") {
                codeSize := extcodesize(keyContract)
            }
            if (codeSize == 0) revert InvalidSignature();
            (bool ok, bytes memory ret) =
                keyContract.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, signature[20:]));
            // 0x1626ba7e = isValidSignature(bytes32,bytes) success magic. Accept the
            // word in either alignment (standard low-aligned ABI or high-aligned).
            if (
                ok
                    && ret.length >= 32
                    // The `ret.length >= 32` guard above makes both casts safe: the first
                    // reads the whole first word, the second its leading 4 bytes.
                    // forge-lint: disable-next-line(unsafe-typecast)
                    && (uint256(bytes32(ret)) == uint256(0x1626ba7e) || bytes4(ret) == bytes4(0x1626ba7e))
            ) {
                return keyContract;
            }
            revert InvalidSignature();
        }
        return _ecrecover(digest, signature);
    }

    function _requestStructHash(ActionRequest calldata request) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _ACTION_REQUEST_TYPEHASH,
                request.agentId,
                request.target,
                request.selector,
                request.value,
                request.nonce,
                request.expiry,
                request.rationaleHash,
                keccak256(request.data)
            )
        );
    }

    /// @dev Full EIP-712 digest of an ActionRequest — also bound into owner approvals
    ///      (E10) so a countersignature authorizes exactly one request.
    function _requestDigest(ActionRequest calldata request) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), _requestStructHash(request)));
    }

    function _approvalStructHash(bytes32 requestDigest) internal pure returns (bytes32) {
        return keccak256(abi.encode(_REQUEST_APPROVAL_TYPEHASH, requestDigest));
    }

    /// @dev Reads `balanceOf(holder)` on a watchlist token. Non-standard tokens (call
    ///      fails / short data) read as 0 — the watchlist is opt-in and entries must be
    ///      standard ERC-20s; a non-standard entry simply contributes no delta check.
    function _erc20BalanceOf(address token, address holder) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSelector(0x70a08231, holder)); // balanceOf(address)
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// @dev Declared token outflow for standard transfer selectors: `transfer` and
    ///      `transferFrom` declare their amount in the calldata; any other selector
    ///      declares nothing (zero tolerance on watched tokens). NOTE: request.data
    ///      EXCLUDES the 4-byte selector — amounts sit at the ABI arg offsets.
    function _declaredTokenOutflow(bytes4 selector, bytes calldata data)
        internal
        pure
        returns (uint256)
    {
        if (selector == 0xa9059cbb && data.length >= 64) {
            // transfer(address,uint256): amount is the 2nd arg → bytes 32..64
            return uint256(bytes32(data[32:64]));
        }
        if (selector == 0x23b872dd && data.length >= 96) {
            // transferFrom(address,address,uint256): amount is the 3rd arg → bytes 64..96
            return uint256(bytes32(data[64:96]));
        }
        return 0;
    }

    function _ecrecover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 vs = bytes32(signature[32:64]);
        uint8 yParity = uint8(signature[64]);
        if (yParity != 27 && yParity != 28) revert InvalidSignature();
        // EIP-2: reject malleable high-s signatures (s' = N - s verifies identically).
        // Mirrors SessionKey7579Module._recover.
        if (uint256(vs) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert InvalidSignature();
        }
        address recovered = ecrecover(digest, yParity, r, vs);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }

    function _manager() internal pure returns (ManagerStorage storage s) {
        assembly ("memory-safe") {
            s.slot := _STORAGE_LOCATION
        }
    }
}
