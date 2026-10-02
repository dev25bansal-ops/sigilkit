// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SpendPolicy} from "./SpendPolicy.sol";
import {MerkleWhitelist} from "./MerkleWhitelist.sol";

/// @dev Canonical EIP-4337 v0.7 PackedUserOperation (declared locally to stay dependency-free).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @title SessionKey7579Module
/// @notice ERC-7579 VALIDATION module: lets ERC-4337 smart accounts (Kernel, Safe{Core}, …)
///         authorize user operations signed by scoped session keys with on-chain spend caps,
///         fixed-window (tumbling) rate limits, Merkle target whitelists, and selector denylists.
/// @dev Security model. The SCOPE ENFORCEMENT below mirrors `SessionKeyManager` — same caps,
///      same denylist, same window accounting — but the two are NOT interchangeable, and
///      the difference that matters most to an integrator is this:
///
///      - SIGNATURE VERIFICATION IS ECDSA-ONLY HERE. This module has NO ERC-1271 branch
///        (D-16), so a contract session key (Safe, smart account, EIP-7702-delegated EOA)
///        works on the manager path and is structurally impossible here. See `_recover`
///        for why adding it is a wire-format change rather than a copy-paste. Any doc that
///        advertises "session keys" for this path must mean EOA keys.
///
///      - The session key holder is UNTRUSTED. All scope enforcement happens HERE at
///        validation time; a compromised agent cannot exceed the granted scope.
///      - The EIP-712 domain binds to the installing ACCOUNT (not `address(this)`), so a
///        signature cannot be replayed through a different account.
///      - Window spend state mutates during validation (checks + effects BEFORE the account
///        executes): conservative — a validated-but-dropped op still counts against the
///        window. Prefer tight windows.
///      - AUDIT NOTE (precise, R10/R06): validation passing ≠ execution landing (a bundler
///        may drop the op), so this module deliberately does NOT emit ActionLogged itself.
///        On the 7579 path the audit trail is CONDITIONAL, not mandatory: it exists only if
///        the account also installs `ActionLog7579Executor` AND an `agentId` is bound for it
///        (via install data or `setAgentId`). With no binding, the executor's `execute`
///        reverts `EmptyAgentId` rather than logging an unattributed action — so a 7579
///        deployment wired for audit must install BOTH modules; this validator alone proves
///        nothing about what landed.
///
/// Signature wire format for validateUserOp:
///   [0..64]    65-byte EIP-2098-unpacked ECDSA (r, vs, yParity∈{27,28})
///   [65..66]   uint16 big-endian merkle-proof element count (0 when root == 0)
///   [67..]     proofCount × bytes32 sorted-pair proof elements (single-call ops only)
///
/// Whitelist semantics: scope.merkleRoot == 0 ⇒ allow all targets (dangerous; documented).
/// With a non-zero root, SINGLE-call ops MUST carry one proof; BATCH ops carry one proof
/// PER TUPLE (E16): [uint16 tupleCount][tupleCount × {uint16 proofLen, proofLen × bytes32}]
/// after the 65-byte signature, gas-bounded by MAX_TOTAL_PROOF_ELEMENTS.
///
/// Proof elements are gas-bounded on BOTH paths (C-01): MAX_TOTAL_PROOF_ELEMENTS across a
/// whole batch, and MAX_SINGLE_PROOF_ELEMENTS per proof. A uint16 element count is attacker
/// chosen, so an unbounded path would let anyone burn a bundler's whole verification-gas
/// limit on a ~2 MB signature and degrade every other op on the same EntryPoint.
contract SessionKey7579Module {
    using SpendPolicy for SpendPolicy.WindowState;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error AlreadyInitialized();
    error NotInitialized();
    error NotAuthorizedCaller();
    error KeyUnknown();
    error KeyRevoked();
    error KeyExpired();
    error SelectorDenied(bytes4 selector);
    error TargetNotAllowed(address target, bytes4 selector);
    error UnsupportedCallType(bytes1 callType);
    error InvalidSignature();
    error MalformedExecutionData();

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------
    struct Scope {
        uint48 expiresAt; // hard expiry; must be future at grant time
        uint48 windowSeconds; // fixed (tumbling) window length
        uint256 perActionCap; // max value per SINGLE inner call
        uint256 perWindowCap; // max cumulative value per fixed (tumbling) window
        bytes32 merkleRoot; // root over keccak(target,selector,argsHash) leaves (v2: argsHash binds calldata, 0 = wildcard); 0 = allow all
    }

    // SDK CONTRACT (R41-A1): this 5-field struct is the wire shape of `onInstall` data —
    // `abi.encode(address key, Scope)` in exactly this field order/types. The SDK Scope
    // (packages/core/src/types.ts) has THREE extra manager-only fields
    // (countersignAbove, enforceNativeDelta, tokenWatchlist) that this module has no storage
    // or code for, so an SDK Scope cannot be reused verbatim. The install encoder that does
    // the narrowing lives in @sigilkit/core: `encode7579InstallData`
    // (packages/core/src/accounts.ts) — it encodes precisely this tuple and REJECTS scopes
    // that set any of the three manager-only fields rather than silently dropping them. Do
    // not change this struct's layout without updating (and re-testing) that encoder.

    /// @notice ERC-7579 ExecTuple used by single (wrapped) and batch executions alike.
    struct ExecTuple {
        address target;
        uint256 value;
        bytes data;
    }

    /// @dev ERC-7201 namespaced storage (computed via `cast index-erc7201
    ///      "sigilkit.storage.SessionKey7579Module"`).
    bytes32 private constant _STORAGE_LOCATION =
        0x37fff519afacb07519d05d86325a08e1838a39976731130004177cffe6d58f00;

    // ------------------------------------------------------------------
    // Wire-format constants
    //
    // CQ-1: these are ERC-7579 / EIP-712 / secp256k1 wire values, not choices made by
    // this codebase. Naming them records which standard each literal comes from, so
    // the encoding can be audited in one pass instead of by recognising hex on sight.
    // ------------------------------------------------------------------

    /// @dev ERC-7579 `CALL_TYPE` prefix of `msg.senderData`: 0x00 = single call, and
    ///      0x01 is reserved for `executeBatch` (ERC-7579's own batch mode, which this
    ///      module does not implement). Every other value reverts UnsupportedCallType.
    bytes1 private constant _CALL_TYPE_SINGLE = 0x00;
    bytes1 private constant _CALL_TYPE_BATCH = 0x01;

    /// @dev Length of the fixed head that precedes the caller-supplied `ExecTuple`
    ///      payload in `msg.senderData`: 1 byte CALL_TYPE + 31 bytes of reserved
    ///      zero padding. The payload starts at offset 32, so `callData.length < 32`
    ///      means the head itself is truncated.
    uint256 private constant _MSG_SENDER_DATA_HEAD_LENGTH = 32;

    /// @dev Length of a 65-byte (r ‖ vs ‖ yParity) ECDSA signature, which is the
    ///      immutable prefix of every accepted `userOp.signature`.
    uint256 private constant _ECDSA_SIGNATURE_LENGTH = 65;
    /// @dev A proof section starts with a big-endian uint16 element count immediately
    ///      after that signature.
    uint256 private constant _PROOF_COUNT_LENGTH = 2;
    /// @dev One proof element is one sorted-pair Merkle node, i.e. a full ABI word.
    uint256 private constant _PROOF_ELEMENT_LENGTH = 32;

    /// @dev Offset of the proof-element section within `userOp.signature`.
    uint256 private constant _PROOF_SECTION_OFFSET = _ECDSA_SIGNATURE_LENGTH + _PROOF_COUNT_LENGTH;

    /// @dev EIP-712 domain-separation PREFIX `"\x19\x01"`, kept as ONE `bytes2` because
    ///      that is what it is: a single 2-byte literal prepended to the digest preimage
    ///      keccak("\x19\x01" ‖ domainSeparator ‖ structHash). Named for its ROLE (the
    ///      EIP-712 prefix) rather than for the standard that happens to define the byte
    ///      values, because the role is what a caller must not get wrong.
    ///
    ///      The two bytes are NOT the same thing and must not be read as one field:
    ///      0x19 is the EIP-191 sign-prefix marker and 0x01 is EIP-191's version byte,
    ///      chosen by EIP-712 — but NEITHER is EIP-712's own `version` domain field, which
    ///      is `keccak("1")` (`_VERSION_HASH`) and lives INSIDE the domain separator. An
    ///      earlier revision split these into `_EIP712_PREFIX` / `_EIP712_VERSION`, and
    ///      the latter name was actively misleading: it invited the reader to link 0x01 to
    ///      `_VERSION_HASH`. A second revision then renamed it `_EIP191_VERSION`, which
    ///      fixed that confusion but introduced a worse one — the NatSpec calls this the
    ///      EIP-712 prefix while the identifier claims EIP-191, so the code now
    ///      contradicts its own documentation. `_EIP712_PREFIX` is restored for that
    ///      reason: it is the one name that is true of both the role and the value.
    ///
    ///      `encodePacked` of this `bytes2` and of the original `"\x19\x01"` string literal
    ///      are byte-identical, so the digest is unchanged (verified against the committed
    ///      golden vectors in vectors/actionrequest.json).
    bytes2 private constant _EIP712_PREFIX = hex"1901";
    /// @dev EIP-712 domain field values for this module. They are local rather than
    ///      inherited from SessionKeyManager: this contract does not extend it, and a
    ///      7579 signature is scoped to a userOpHash, never to an ActionRequest.
    bytes32 private constant _NAME_HASH = keccak256("SigilKit7579");
    bytes32 private constant _VERSION_HASH = keccak256("1");

    /// @dev secp256k1 group order N. Anything above N/2 is a malleable twin of a
    ///      signature that already verifies (EIP-2), so recovery rejects it.
    uint256 private constant _SECP256K1_HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @notice Upper bound on batch executions enforced at validation (gas + DoS bound).
    uint256 private constant MAX_BATCH_SIZE = 8;
    /// @notice Gas bound on the combined per-tuple proof elements of one batch (E16).
    uint256 private constant MAX_TOTAL_PROOF_ELEMENTS = 32;
    /// @notice Gas bound on ONE proof (C-01) - a single call, or ONE tuple of a batch.
    /// @dev The single-call path parses the same attacker-controlled uint16 element count as
    ///      the batch path but had no ceiling of its own, so a ~2 MB signature could pin a
    ///      bundler's whole verification-gas budget on 65535 pointless keccak rounds. 8 covers
    ///      any realistic whitelist (a 2^8-leaf tree is already 256x the 1-leaf case the SDK
    ///      pins in its own tests) at ~1/8000th of the worst-case cost. Purely tightening:
    ///      the deepest proof the existing suite uses is 1 element.
    uint256 private constant MAX_SINGLE_PROOF_ELEMENTS = 8;

    /// @dev Minimum length of a tuple's inline proof record:
    ///      {uint16 proofLen} alone, i.e. a proof with zero elements.
    uint256 private constant _TUPLE_PROOF_LEN_PREFIX = _PROOF_COUNT_LENGTH;

    struct ModuleStorage {
        mapping(address account => mapping(address key => Scope)) scopes;
        mapping(address account => mapping(address key => bool)) revoked;
        mapping(address account => mapping(address key => SpendPolicy.WindowState)) windows;
        mapping(address account => mapping(bytes4 selector => bool)) deniedSelectors;
        mapping(address account => bool) initialized;
    }

    function _m() private pure returns (ModuleStorage storage s) {
        assembly ("memory-safe") {
            s.slot := _STORAGE_LOCATION
        }
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event ScopeGranted(address indexed account, address indexed key, uint48 expiresAt);
    event ScopeRevoked(address indexed account, address indexed key);
    event SelectorDenylistSet(address indexed account, bytes4 indexed selector, bool denied);
    event ModuleUninstalled(address indexed account);

    // ------------------------------------------------------------------
    // ERC-7579 module surface
    // ------------------------------------------------------------------
    /// @notice ERC-7579 module-type query. The account calls this to check compatibility
    ///         before installing.
    /// @param moduleTypeId ERC-7579 module type; this contract is type 1 (VALIDATION).
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 1; // VALIDATION_MODULE
    }

    /// @notice Whether an account currently has this module installed.
    /// @dev After `onUninstall` the flag is cleared, which is what makes the retained
    ///      scopes and windows inert: `validateUserOp` re-checks it, so a reinstalled
    ///      module starts from the OLD scopes unless the account re-grants.
    function isInitialized(address account) external view returns (bool) {
        return _m().initialized[account];
    }

    /// @notice Install hook — called BY the account. `data` encodes (key, Scope) to grant
    ///         immediately, or empty to install without keys.
    function onInstall(bytes memory data) external {
        ModuleStorage storage s = _m();
        if (s.initialized[msg.sender]) revert AlreadyInitialized();
        s.initialized[msg.sender] = true;
        if (data.length != 0) {
            (address key, Scope memory scope) = abi.decode(data, (address, Scope));
            _grant(msg.sender, key, scope);
        }
    }

    function onUninstall(bytes memory) external {
        ModuleStorage storage s = _m();
        if (!s.initialized[msg.sender]) revert NotInitialized();
        delete s.initialized[msg.sender];
        // Scopes/windows intentionally retained for audit reconstruction; validateUserOp
        // refuses to honor them until the account re-initializes via onInstall.
        emit ModuleUninstalled(msg.sender);
    }

    // ------------------------------------------------------------------
    // Account-gated key lifecycle (msg.sender = the account itself)
    // ------------------------------------------------------------------
    /// @notice Grants `key` an execution scope. Callable only by the account itself.
    /// @dev Re-granting the same key overwrites the previous scope outright — there is no
    ///      overlap window here (unlike SessionKeyManager.rotateSessionKey), so a
    ///      re-grant is a hard replacement.
    function grantSessionKey(address key, Scope calldata scope) external {
        _requireInitialized(msg.sender);
        _grant(msg.sender, key, scope);
    }

    /// @notice Revokes `key`, blocking it from authorizing any further user operation.
    /// @dev The scope itself is retained (for audit reconstruction) and a later
    ///      `grantSessionKey` for the same key clears the revocation, matching
    ///      SessionKeyManager.grantSessionKey.
    function revokeSessionKey(address key) external {
        _requireInitialized(msg.sender);
        ModuleStorage storage s = _m();
        if (s.scopes[msg.sender][key].expiresAt == 0) revert KeyUnknown();
        s.revoked[msg.sender][key] = true;
        emit ScopeRevoked(msg.sender, key);
    }

    /// @notice Adds/removes a selector from this account's denylist. A denied selector is
    ///         refused on EVERY target, on both the single-call and batch paths.
    /// @dev Unlike SessionKeyManager, this module does NOT self-seal: there is no
    ///      `onlyOwner` here, and the account (not a session key) is the only caller, so
    ///      the seaming invariant INV-4 leans on does not apply. The denylist is an
    ///      additional filter the account opts into, not a containment guarantee.
    function setSelectorDenied(bytes4 selector, bool denied) external {
        _requireInitialized(msg.sender);
        _m().deniedSelectors[msg.sender][selector] = denied;
        emit SelectorDenylistSet(msg.sender, selector, denied);
    }

    /// @dev Grant-time validation and persistence. The scope is stored verbatim: this
    ///      module's Scope carries no `tokenWatchlist`, so the E11 balance-delta check has
    ///      no watchlist to read here and only the manager enforces it.
    function _grant(address account, address key, Scope memory scope) internal {
        if (key == address(0)) revert KeyUnknown();
        // Grant-time sanity check: the expiry must be in the future. Time-based by design;
        // validator drift of seconds cannot grant a key that is already expired.
        // forge-lint: disable-next-line(block-timestamp)
        if (uint256(scope.expiresAt) <= block.timestamp) revert KeyExpired(); // expiry in past
        if (scope.perActionCap == 0 || scope.perWindowCap < scope.perActionCap) {
            revert MalformedExecutionData();
        }
        if (scope.windowSeconds == 0) revert MalformedExecutionData();
        ModuleStorage storage s = _m();
        s.scopes[account][key] = scope;
        s.revoked[account][key] = false;
        emit ScopeGranted(account, key, scope.expiresAt);
    }

    function _requireInitialized(address account) internal view {
        if (!_m().initialized[account]) revert NotInitialized();
    }

    // ------------------------------------------------------------------
    // Validation
    // ------------------------------------------------------------------
    /// @notice Validates a user operation against the signing key's scope.
    /// @return validationData Packed per ERC-4337: validAfter<<200 | validUntil<<160 | authorizer.
    ///         On success authorizer=0 and validUntil = scope expiry; any violation or bad
    ///         signature reverts (entrypoint treats reverting validators as failure).
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) external returns (uint256 validationData) {
        // Only the account that owns this userOp may run validation: window state mutates
        // here (checks+effects), so a mempool-copied op must not burn a victim's spend
        // window when invoked directly. ERC-4337/7579 accounts invoke validation modules
        // in their own context, so msg.sender == userOp.sender holds on the happy path.
        if (msg.sender != userOp.sender) revert NotAuthorizedCaller();

        ModuleStorage storage s = _m();
        address account = userOp.sender;
        if (!s.initialized[account]) revert NotInitialized();

        // --- Recover the session key over the account-bound domain ---
        address signer = _recover(account, userOpHash, userOp.signature);
        Scope storage scope = s.scopes[account][signer];
        if (scope.expiresAt == 0) revert KeyUnknown();
        if (s.revoked[account][signer]) revert KeyRevoked();
        // INV-2: key hard expiry. Time-based by design; validator drift of seconds only
        // tightens or loosens the key's final moments, never the spend caps.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > scope.expiresAt) revert KeyExpired();

        _validateExecution(account, signer, scope, userOp);

        // Success: bind the authorization to the scope's hard expiry (authorizer=0).
        return uint256(scope.expiresAt) << 160;
    }

    /// @dev Dispatches the requested execution shape and runs the enforcement for it.
    ///      Extracted from `validateUserOp` so the credential checks and the payload
    ///      handling read as two separate steps; `scope` is a storage pointer, so the
    ///      helper still mutates the caller's own slot and the returned
    ///      `validationData` is unchanged.
    function _validateExecution(
        address account,
        address signer,
        Scope storage scope,
        PackedUserOperation calldata userOp
    ) private {
        // --- Decode the execution payload (ERC-7579 callData convention) ---
        if (userOp.callData.length < _MSG_SENDER_DATA_HEAD_LENGTH) {
            revert MalformedExecutionData();
        }
        bytes1 callType = userOp.callData[0];
        bytes calldata execPayload = userOp.callData[_MSG_SENDER_DATA_HEAD_LENGTH:];
        // BUG-19: `callData.length == 32` clears the length check above yet leaves
        // `execPayload` empty. `abi.decode` on empty data reverts with a low-level ABI
        // panic instead of a semantic error, and relayers/indexers cannot tell a malformed
        // payload from an internal failure. Mirrors the explicit `batch.length == 0`
        // rejection on the batch path below.
        if (execPayload.length == 0) revert MalformedExecutionData();

        if (callType == _CALL_TYPE_SINGLE) {
            // Single call: proof (if any) rides after the 65-byte signature.
            ExecTuple memory single = abi.decode(execPayload, (ExecTuple));
            bytes32[] memory proof = _parseTrailingProof(userOp.signature);
            if (scope.merkleRoot != bytes32(0)) {
                if (!_whitelisted(scope.merkleRoot, single.target, single.data, proof)) {
                    revert TargetNotAllowed(single.target, _selectorOf(single.data));
                }
            }
            _enforceSingle(account, signer, scope, single);
        } else if (callType == _CALL_TYPE_BATCH) {
            ExecTuple[] memory batch = abi.decode(execPayload, (ExecTuple[]));
            // C-01: the batch-size bound is asserted HERE, before the proof tail is parsed,
            // not only in `_enforceBatch` below. `_parseBatchProofs` sizes its outer array
            // from `batch.length`, so parsing first lets a caller force a
            // `new bytes32[][](batchLen)` allocation for a batch that is about to be rejected
            // as oversized. Same bound, same `MalformedExecutionData`; `_enforceBatch` keeps
            // its own copy as defence in depth for any future caller.
            if (batch.length == 0 || batch.length > MAX_BATCH_SIZE) revert MalformedExecutionData();
            // Per-tuple proofs (E16): required under a non-zero root, one per tuple.
            bytes32[][] memory batchProofs = scope.merkleRoot != bytes32(0)
                ? _parseBatchProofs(userOp.signature, batch.length)
                : new bytes32[][](0);
            _enforceBatch(account, signer, scope, batch, batchProofs);
        } else {
            revert UnsupportedCallType(callType);
        }
    }

    // ------------------------------------------------------------------
    // Enforcement internals
    // ------------------------------------------------------------------
    function _enforceSingle(
        address account,
        address signer,
        Scope storage scope,
        ExecTuple memory call_
    ) internal {
        ModuleStorage storage s = _m();
        // BUG-19: the denylist deliberately KEEPS the `bytes4` zero-padding convention rather
        // than reverting on sub-4-byte calldata: the native-ETH-transfer encoding is empty
        // `data` with a non-zero `value`, so a length gate here would break a supported path.
        // That is sound because the denylist is a strict subset test — padding empty calldata
        // to `0x00000000` means "deny selector 0x00000000" is honoured for exactly the empty
        // calldata that produces it, and no other call can be smuggled through it. The
        // leaf-construction side, where a padded selector would become a *whitelist* leaf
        // that matches unintended calldata, is length-checked in `_selectorOf`.
        bytes4 selector = bytes4(call_.data);
        if (s.deniedSelectors[account][selector]) revert SelectorDenied(selector);
        s.windows[account][signer].enforce(
            account, signer, call_.value, scope.perActionCap, scope.perWindowCap, scope.windowSeconds
        );
    }

    function _enforceBatch(
        address account,
        address signer,
        Scope storage scope,
        ExecTuple[] memory batch,
        bytes32[][] memory batchProofs
    ) internal {
        ModuleStorage storage s = _m();
        if (batch.length == 0 || batch.length > MAX_BATCH_SIZE) revert MalformedExecutionData();

        // Checks across every tuple first…
        uint256 totalValue = 0;
        for (uint256 i = 0; i < batch.length; ++i) {
            bytes4 selector = bytes4(batch[i].data);
            if (s.deniedSelectors[account][selector]) revert SelectorDenied(selector);
            if (batch[i].value > scope.perActionCap) {
                // Dedicated error (not MalformedExecutionData) so relayers and indexers
                // can distinguish a policy violation from a malformed payload.
                revert SpendPolicy.PerActionCapExceeded(batch[i].value, scope.perActionCap);
            }
            // Per-tuple whitelist (E16): under a non-zero root every tuple must carry
            // its own proof (v2 pinned-or-wildcard leaf) — batching is no longer
            // locked out of the whitelist regime.
            if (scope.merkleRoot != bytes32(0)) {
                if (!_whitelisted(scope.merkleRoot, batch[i].target, batch[i].data, batchProofs[i])) {
                    revert TargetNotAllowed(batch[i].target, _selectorOf(batch[i].data));
                }
            }
            // CHECKED accumulation (this block used to be `unchecked`). The summed total is
            // the ONLY thing bounding the window on this path — each tuple was checked
            // individually against `perActionCap` above, and `enforce` is then called with
            // `perActionCap = type(uint256).max` so that the aggregate is judged solely
            // against `perWindowCap`. A wrap therefore would not merely skip a check: it
            // would hand `enforce` a small number, defeating `perWindowCap`, AND the
            // wrapped value is what gets PERSISTED to `windows[account][signer].spentThisWindow`
            // — leaving the owner reading a false window balance. A silent accounting
            // corruption is not made acceptable by being unreachable.
            //
            // Reachability, stated honestly: wrapping requires a true sum of 2^256 wei, i.e.
            // a mean tuple value of 2^253 wei (~1.4e76) with MAX_BATCH_SIZE = 8 — roughly
            // 10^50x the entire ETH supply. So this is NOT an exploitable drain; it is a
            // latent integrity defect. It is fixed on integrity grounds, not exploitability.
            //
            // A revert on overflow is the correct failure mode: it rejects the batch rather
            // than charging a window balance that never existed.
            totalValue += batch[i].value;
        }
        // …then ONE window charge for the batch total. The aggregate deliberately bypasses
        // the per-action check (each tuple was checked individually above).
        s.windows[account][signer].enforce(
            account, signer, totalValue, type(uint256).max, scope.perWindowCap, scope.windowSeconds
        );
    }

    /// @notice Selector derived from an ExecTuple's calldata, rejecting sub-selector lengths.
    /// @dev BUG-19: `bytes4(data)` silently RIGHT-PADS calldata shorter than 4 bytes, so an
    ///      empty payload derives `0x00000000` and a 2-byte one `0xab000000` — both
    ///      indistinguishable from a real selector. A whitelist leaf can therefore be minted
    ///      for a zero selector, i.e. one that no real contract implements but that matches
    ///      any sub-4-byte call. Only the leaf/report path demands a real selector, so that
    ///      is where the length is enforced: the native-ETH-transfer encoding (empty `data`
    ///      with a non-zero `value`) stays legal, and the denylist cast is left on the
    ///      documented zero-padding convention (see `_enforceSingle`).
    function _selectorOf(bytes memory data) internal pure returns (bytes4) {
        if (data.length < 4) revert MalformedExecutionData();
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes4(data);
    }

    function _whitelisted(
        bytes32 root,
        address target,
        bytes memory data,
        bytes32[] memory proof
    ) internal pure returns (bool) {
        // C-01 defense in depth: the single-call parser already caps its element count, but
        // the loop below is the actual gas sink, so re-assert the bound here. A future caller
        // that reaches this verifier with an unparsed/unbounded proof is stopped before it
        // can turn one keccak round per element into a verification-gas bomb.
        //
        // SCOPE, stated because the constant's name is singular: this bound is per-PROOF, so
        // it applies to a BATCH tuple's proof exactly as it does to a single call's. The
        // batch parser's own ceiling is the aggregate MAX_TOTAL_PROOF_ELEMENTS (= 32), which
        // is the LOOSER of the two here — so the effective per-tuple limit is this constant
        // (8), and MAX_TOTAL_PROOF_ELEMENTS only starts to bind once a batch spreads proof
        // elements across four or more tuples. Changing that interaction is a constant-value
        // decision, not a comment fix, so it is recorded rather than silently adjusted.
        if (proof.length > MAX_SINGLE_PROOF_ELEMENTS) revert InvalidSignature();
        // Leaf format v2 (mirrors SessionKeyManager._targetAllowed): the proof must
        // verify against the pinned leaf (commits keccak256(data)) or the wildcard
        // leaf (argsHash == 0 — any calldata for this target+selector).
        bytes32 argsHash = keccak256(data);
        // `_selectorOf` is the SINGLE selector-derivation rule for this contract (BUG-19).
        // It rejects sub-4-byte calldata instead of letting `bytes4` right-pad it, so a leaf
        // can never be minted for a padded selector such as `0x00000000`. For the >= 4-byte
        // case it is byte-identical to the SDK's `targetLeaf`, which applies the same
        // truncation — the whitelist only accepts a leaf the owner built with this convention.
        bytes4 selector = _selectorOf(data);
        if (MerkleWhitelist.verify(proof, root, keccak256(abi.encode(target, selector, argsHash)))) {
            return true;
        }
        if (
            argsHash != bytes32(0)
                && MerkleWhitelist.verify(
                    // Same selector-extraction convention as above (wildcard leaf).
                    proof, root, keccak256(abi.encode(target, selector, bytes32(0)))
                )
        ) {
            return true;
        }
        return false;
    }

    /// @dev Parses the optional [uint16 count][count × bytes32] tail after the 65-byte ECDSA.
    ///      `count` is attacker-controlled, so it is capped BEFORE any allocation or hashing
    ///      (C-01) — checking the length first would only prove the attacker paid for the bytes.
    ///      The `== 65` fast path is the common case: a scope with no Merkle root never
    ///      appends a proof section, so the tail is absent entirely rather than a zero count.
    function _parseTrailingProof(bytes calldata signature)
        internal
        pure
        returns (bytes32[] memory proof)
    {
        proof = new bytes32[](0);
        if (signature.length == _ECDSA_SIGNATURE_LENGTH) return proof; // no proof section
        if (signature.length < _PROOF_SECTION_OFFSET) revert InvalidSignature();
        uint16 count =
            (uint16(uint8(signature[_ECDSA_SIGNATURE_LENGTH])) << 8)
                | uint16(uint8(signature[_ECDSA_SIGNATURE_LENGTH + 1]));
        if (count > MAX_SINGLE_PROOF_ELEMENTS) revert InvalidSignature();
        if (signature.length != _PROOF_SECTION_OFFSET + uint256(count) * _PROOF_ELEMENT_LENGTH) {
            revert InvalidSignature();
        }
        proof = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            uint256 start = _PROOF_SECTION_OFFSET + i * _PROOF_ELEMENT_LENGTH;
            proof[i] = bytes32(signature[start:start + _PROOF_ELEMENT_LENGTH]);
        }
    }

    /// @dev Per-tuple proof tail for batches (E16), after the 65-byte ECDSA:
    ///      [uint16 tupleCount][tupleCount × {uint16 proofLen, proofLen × bytes32}].
    ///      tupleCount must equal the decoded batch length and the tail must be
    ///      exactly consumed; total proof elements are gas-bounded by MAX_TOTAL_PROOF_ELEMENTS.
    ///      The bounds are re-checked against the signature length as `offset` advances
    ///      rather than once up front, so a truncated tail can never make the copy loop
    ///      read past the end of `signature`.
    function _parseBatchProofs(bytes calldata signature, uint256 batchLen)
        internal
        pure
        returns (bytes32[][] memory proofs)
    {
        if (signature.length < _PROOF_SECTION_OFFSET) revert InvalidSignature();
        uint256 tupleCount = (uint16(uint8(signature[_ECDSA_SIGNATURE_LENGTH])) << 8)
            | uint16(uint8(signature[_ECDSA_SIGNATURE_LENGTH + 1]));
        if (tupleCount != batchLen) revert InvalidSignature();
        proofs = new bytes32[][](tupleCount);
        uint256 offset = _PROOF_SECTION_OFFSET;
        uint256 totalElements = 0;
        for (uint256 i = 0; i < tupleCount; ++i) {
            if (offset + _TUPLE_PROOF_LEN_PREFIX > signature.length) revert InvalidSignature();
            uint256 proofLen = (uint16(uint8(signature[offset])) << 8) | uint16(uint8(signature[offset + 1]));
            offset += _TUPLE_PROOF_LEN_PREFIX;
            if (offset + proofLen * _PROOF_ELEMENT_LENGTH > signature.length) revert InvalidSignature();
            // C-01: `proofLen` is attacker-chosen, and the aggregate ceiling is the only
            // thing bounding the per-tuple copy below. Gate it BEFORE allocating (mirroring
            // `_parseTrailingProof`'s ordering): with the check after the copy, a single
            // tuple declaring 65535 elements forces a ~2 MB allocation plus 65535 calldata
            // slices only to be rejected on the following line.
            totalElements += proofLen;
            if (totalElements > MAX_TOTAL_PROOF_ELEMENTS) revert InvalidSignature();
            proofs[i] = new bytes32[](proofLen);
            for (uint256 j = 0; j < proofLen; ++j) {
                proofs[i][j] = bytes32(signature[offset:offset + _PROOF_ELEMENT_LENGTH]);
                offset += _PROOF_ELEMENT_LENGTH;
            }
        }
        if (offset != signature.length) revert InvalidSignature();
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    /// @notice The scope granted to `key` by `account`. An all-zero scope means no grant
    ///         exists (or it was revoked — check `isInitialized`/`onUninstall` semantics:
    ///         revocation does not clear the scope).
    function getScope(address account, address key) external view returns (Scope memory) {
        return _m().scopes[account][key];
    }

    /// @notice Current fixed-window accounting for `key` under `account`. `windowStart`
    ///         is 0 until the first charged action opens a window.
    function getWindowState(address account, address key)
        external
        view
        returns (uint48 windowStart, uint256 spentThisWindow)
    {
        SpendPolicy.WindowState storage w = _m().windows[account][key];
        return (w.windowStart, w.spentThisWindow);
    }

    /// @notice Whether `account` refuses `selector` on every target.
    function isSelectorDenied(address account, bytes4 selector) external view returns (bool) {
        return _m().deniedSelectors[account][selector];
    }

    // ------------------------------------------------------------------
    // EIP-712 recovery (domain bound to the installing account)
    // ------------------------------------------------------------------
    bytes32 private constant _USEROP_TYPEHASH =
        keccak256("UserOp(address sender,uint256 nonce,bytes32 userOpHash)");
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev EIP-712 domain of a userOp signature. `verifyingContract` is the INSTALLING
    ///      ACCOUNT, not this module: a 7579 module is stateless with respect to who calls
    ///      it, so pinning the domain to `address(this)` would let one account's signed op
    ///      be replayed against a different account that installed the same module.
    function _domainSeparator(address account) private view returns (bytes32) {
        return keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, account)
        );
    }

    /// @dev Recovers the session key that signed a userOp. **EIP-191 ECDSA only.**
    ///
    ///      D-16 (OPEN — capability asymmetry, deliberate for now, NOT an oversight):
    ///      this validator has NO ERC-1271 branch, while `SessionKeyManager._recover`
    ///      does. So a CONTRACT session key — a Safe, another smart account, or an
    ///      EIP-7702-delegated EOA, all of which answer `isValidSignature` rather than
    ///      producing an ECDSA signature — is structurally impossible on the 7579 path,
    ///      even though the identical key works on the manager path. Two consequences
    ///      worth stating plainly, because the asymmetry is easy to assume away:
    ///
    ///        1. There is no silent fallback. A 1271 key that tries this path reverts
    ///           `InvalidSignature` here rather than being downgraded, so an integrator
    ///           sees a rejected signature, not a mis-scoped authorization.
    ///        2. The 7579 signature format is also structurally 1271-hostile: the proof
    ///           tail is parsed positionally from the bytes AFTER the 65-byte ECDSA
    ///           (see `_parseTrailingProof`), so there is no length-prefixed signature
    ///           field to hold a variable-length 1271 blob. Adding 1271 here is therefore
    ///      a WIRE-FORMAT change, not just a branch — see C-09 in
    ///      docs/ENHANCEMENTS-2026-09-25.md, which proposes the
    ///      `[uint16 sigLen][sig][fixed proof tail]` split and correctly lists it as
    ///      **breaking**.
    ///
    ///      Do not "fix" this by copying the manager's 1271 branch across: that branch
    ///      assumes a 65-byte-or-longer prefix and would mis-parse the proof tail.
    function _recover(address account, bytes32 userOpHash, bytes calldata signature)
        internal
        view
        returns (address)
    {
        if (signature.length < _ECDSA_SIGNATURE_LENGTH) revert InvalidSignature();
        bytes32 structHash =
            keccak256(abi.encode(_USEROP_TYPEHASH, account, 0, userOpHash)); // nonce bound via hash anyway
        bytes32 digest =
            keccak256(abi.encodePacked(_EIP712_PREFIX, _domainSeparator(account), structHash));
        bytes32 r = bytes32(signature[0:32]);
        bytes32 vs = bytes32(signature[32:64]);
        uint8 yParity = uint8(signature[64]);
        if (yParity != 27 && yParity != 28) revert InvalidSignature();
        // EIP-2: reject malleable high-s signatures (s' = N - s verifies identically).
        if (uint256(vs) > _SECP256K1_HALF_ORDER) {
            revert InvalidSignature();
        }
        address recovered = ecrecover(digest, yParity, r, vs);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }
}
