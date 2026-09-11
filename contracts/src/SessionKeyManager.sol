// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SpendPolicy} from "./SpendPolicy.sol";
import {MerkleWhitelist} from "./MerkleWhitelist.sol";
import {ActionLogger} from "./ActionLogger.sol";

/// @title SessionKeyManager
/// @notice Agent-first session-key manager: scoped keys with on-chain spend caps,
///         rolling-window rate limits, Merkle target whitelists, and a mandatory
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

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------
    /// @notice Scope granted to a session key. All fields immutable once granted.
    struct Scope {
        uint48 expiresAt; // hard expiry; must be in the future at grant time
        uint48 windowSeconds; // rolling-window length for the spend cap
        uint256 perActionCap; // max native value per single action
        uint256 perWindowCap; // max cumulative native value per rolling window
        bytes32 merkleRoot; // root over keccak(target,selector) leaves; 0 = allow ALL (dangerous)
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
        _setSelectorDenied(this.grantSessionKey.selector, true);
        _setSelectorDenied(this.revokeSessionKey.selector, true);
        _setSelectorDenied(this.rotateSessionKey.selector, true);
        _setSelectorDenied(this.transferOwnership.selector, true);
        _setSelectorDenied(this.setSelectorDenied.selector, true);
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
        s.scopes[key] = scope;
        s.revoked[key] = false;
        emit SessionKeyGranted(key, scope.expiresAt);
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
        s.scopes[newKey] = newScope;
        s.revoked[newKey] = false;
        emit SessionKeyGranted(newKey, newScope.expiresAt);
        if (oldKey != address(0)) {
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
        if (uint256(scope.expiresAt) <= block.timestamp) revert InvalidScope(); // expiry in past
        if (scope.perActionCap == 0) revert InvalidScope(); // value cap zero
        if (scope.perWindowCap < scope.perActionCap) revert InvalidScope(); // window below action cap
        if (scope.windowSeconds == 0) revert InvalidScope();
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
    /// @param merkleProof Sorted-pair Merkle proof over keccak(abi.encode(target,selector));
    ///        required when the key's scope has a non-zero merkleRoot, ignored otherwise.
    function executeWithSessionKey(
        ActionRequest calldata request,
        bytes calldata signature,
        bytes32[] calldata merkleProof
    ) external payable nonReentrant {
        if (msg.value != 0) revert ValueNotAccepted(); // value flows from wallet balance, not relayer

        ManagerStorage storage s = _manager();

        // --- Signature & key state ---
        address signer = _recover(request, signature);
        Scope storage scope = s.scopes[signer];
        if (scope.expiresAt == 0) revert KeyUnknown();
        if (s.revoked[signer]) revert KeyRevoked();
        if (block.timestamp > scope.expiresAt) revert KeyExpired(); // INV-2
        if (block.timestamp > request.expiry) revert RequestExpired();

        // --- Replay protection ---
        if (request.nonce != s.nonces[signer]) revert NonceUsed();
        s.nonces[signer] = request.nonce + 1; // effect before interaction

        // --- Privilege containment (INV-4) ---
        if (s.ownerOnlySelectors[request.selector]) revert SelectorDenied(request.selector);

        // --- Target whitelist ---
        if (scope.merkleRoot != bytes32(0)) {
            bytes32 leaf = keccak256(abi.encode(request.target, request.selector));
            if (!MerkleWhitelist.verify(merkleProof, scope.merkleRoot, leaf)) {
                revert TargetNotAllowed(request.target, request.selector);
            }
        }
        // merkleRoot == 0 means "allow all" — documented as dangerous; owners should always
        // grant a real root in production.

        // --- Spend caps: checks + effects BEFORE the inner call (CEI) ---
        s.windows[signer].enforce(
            request.value, scope.perActionCap, scope.perWindowCap, scope.windowSeconds
        );

        // --- Interaction ---
        (bool ok,) =
            request.target.call{value: request.value}(abi.encodePacked(request.selector, request.data));
        if (!ok) revert InnerCallFailed();

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

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------
    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
    }

    function _recover(ActionRequest calldata request, bytes calldata signature)
        internal
        view
        returns (address)
    {
        bytes32 structHash = keccak256(
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        return _ecrecover(digest, signature);
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
