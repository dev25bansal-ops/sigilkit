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
/// @dev Security model (mirrors SessionKeyManager):
///      - The session key holder is UNTRUSTED. All scope enforcement happens HERE at
///        validation time; a compromised agent cannot exceed the granted scope.
///      - The EIP-712 domain binds to msg.sender (the installing account), so a signature
///        cannot be replayed through a different account.
///      - Window spend state mutates during validation (checks + effects BEFORE the account
///        executes): conservative — a validated-but-dropped op still counts against the
///        window. Prefer tight windows.
///      - AUDIT NOTE: validation passing ≠ execution landing (bundler may drop the op), so
///        this module does NOT emit ActionLogged; pair with an executor/hook for audit trails.
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

    /// @notice Upper bound on batch executions enforced at validation (gas + DoS bound).
    uint256 private constant MAX_BATCH_SIZE = 8;
    /// @notice Gas bound on the combined per-tuple proof elements of one batch (E16).
    uint256 private constant MAX_TOTAL_PROOF_ELEMENTS = 32;

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
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 1; // VALIDATION_MODULE
    }

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
    function grantSessionKey(address key, Scope calldata scope) external {
        _requireInitialized(msg.sender);
        _grant(msg.sender, key, scope);
    }

    function revokeSessionKey(address key) external {
        _requireInitialized(msg.sender);
        ModuleStorage storage s = _m();
        if (s.scopes[msg.sender][key].expiresAt == 0) revert KeyUnknown();
        s.revoked[msg.sender][key] = true;
        emit ScopeRevoked(msg.sender, key);
    }

    function setSelectorDenied(bytes4 selector, bool denied) external {
        _requireInitialized(msg.sender);
        _m().deniedSelectors[msg.sender][selector] = denied;
        emit SelectorDenylistSet(msg.sender, selector, denied);
    }

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

        // --- Decode the execution payload (ERC-7579 callData convention) ---
        if (userOp.callData.length < 32) revert MalformedExecutionData();
        bytes1 callType = userOp.callData[0];
        bytes calldata execPayload = userOp.callData[32:];

        if (callType == 0x00) {
            // Single call: proof (if any) rides after the 65-byte signature.
            ExecTuple memory single = abi.decode(execPayload, (ExecTuple));
            bytes32[] memory proof = _parseTrailingProof(userOp.signature);
            if (scope.merkleRoot != bytes32(0)) {
                if (!_whitelisted(scope.merkleRoot, single.target, single.data, proof)) {
                    revert TargetNotAllowed(single.target, bytes4(single.data));
                }
            }
            _enforceSingle(account, signer, scope, single);
        } else if (callType == 0x01) {
            ExecTuple[] memory batch = abi.decode(execPayload, (ExecTuple[]));
            // Per-tuple proofs (E16): required under a non-zero root, one per tuple.
            bytes32[][] memory batchProofs =
                scope.merkleRoot != bytes32(0) ? _parseBatchProofs(userOp.signature, batch.length) : new bytes32[][](0);
            _enforceBatch(account, signer, scope, batch, batchProofs);
        } else {
            revert UnsupportedCallType(callType);
        }

        // Success: bind the authorization to the scope's hard expiry (authorizer=0).
        return uint256(scope.expiresAt) << 160;
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
                    revert TargetNotAllowed(batch[i].target, bytes4(batch[i].data));
                }
            }
            unchecked {
                totalValue += batch[i].value;
            }
        }
        // …then ONE window charge for the batch total. The aggregate deliberately bypasses
        // the per-action check (each tuple was checked individually above).
        s.windows[account][signer].enforce(
            account, signer, totalValue, type(uint256).max, scope.perWindowCap, scope.windowSeconds
        );
    }

    function _whitelisted(
        bytes32 root,
        address target,
        bytes memory data,
        bytes32[] memory proof
    ) internal pure returns (bool) {
        // Leaf format v2 (mirrors SessionKeyManager._targetAllowed): the proof must
        // verify against the pinned leaf (commits keccak256(data)) or the wildcard
        // leaf (argsHash == 0 — any calldata for this target+selector).
        bytes32 argsHash = keccak256(data);
        // `bytes4(data)` extracts the selector for leaf matching. Truncation is intended and
        // must match the SDK's `targetLeaf` byte-for-byte, which applies the identical cast —
        // the whitelist only accepts a leaf the owner built with this same convention.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (MerkleWhitelist.verify(proof, root, keccak256(abi.encode(target, bytes4(data), argsHash))))
        {
            return true;
        }
        if (
            argsHash != bytes32(0)
                && MerkleWhitelist.verify(
                    // Same selector-extraction convention as above (wildcard leaf).
                    // forge-lint: disable-next-line(unsafe-typecast)
                    proof, root, keccak256(abi.encode(target, bytes4(data), bytes32(0)))
                )
        ) {
            return true;
        }
        return false;
    }

    /// @dev Parses the optional [uint16 count][count × bytes32] tail after the 65-byte ECDSA.
    function _parseTrailingProof(bytes calldata signature)
        internal
        pure
        returns (bytes32[] memory proof)
    {
        proof = new bytes32[](0);
        if (signature.length == 65) return proof; // no proof section
        if (signature.length < 67) revert InvalidSignature();
        uint16 count = (uint16(uint8(signature[65])) << 8) | uint16(uint8(signature[66]));
        if (signature.length != 67 + uint256(count) * 32) revert InvalidSignature();
        proof = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            uint256 start = 67 + i * 32;
            proof[i] = bytes32(signature[start:start + 32]);
        }
    }

    /// @dev Per-tuple proof tail for batches (E16), after the 65-byte ECDSA:
    ///      [uint16 tupleCount][tupleCount × {uint16 proofLen, proofLen × bytes32}].
    ///      tupleCount must equal the decoded batch length and the tail must be
    ///      exactly consumed; total proof elements are gas-bounded by MAX_TOTAL_PROOF_ELEMENTS.
    function _parseBatchProofs(bytes calldata signature, uint256 batchLen)
        internal
        pure
        returns (bytes32[][] memory proofs)
    {
        if (signature.length < 67) revert InvalidSignature();
        uint256 tupleCount = (uint16(uint8(signature[65])) << 8) | uint16(uint8(signature[66]));
        if (tupleCount != batchLen) revert InvalidSignature();
        proofs = new bytes32[][](tupleCount);
        uint256 offset = 67;
        uint256 totalElements = 0;
        for (uint256 i = 0; i < tupleCount; ++i) {
            if (offset + 2 > signature.length) revert InvalidSignature();
            uint256 proofLen = (uint16(uint8(signature[offset])) << 8) | uint16(uint8(signature[offset + 1]));
            offset += 2;
            if (offset + proofLen * 32 > signature.length) revert InvalidSignature();
            proofs[i] = new bytes32[](proofLen);
            for (uint256 j = 0; j < proofLen; ++j) {
                proofs[i][j] = bytes32(signature[offset:offset + 32]);
                offset += 32;
            }
            totalElements += proofLen;
            if (totalElements > MAX_TOTAL_PROOF_ELEMENTS) revert InvalidSignature();
        }
        if (offset != signature.length) revert InvalidSignature();
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    function getScope(address account, address key) external view returns (Scope memory) {
        return _m().scopes[account][key];
    }

    function getWindowState(address account, address key)
        external
        view
        returns (uint48 windowStart, uint256 spentThisWindow)
    {
        SpendPolicy.WindowState storage w = _m().windows[account][key];
        return (w.windowStart, w.spentThisWindow);
    }

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

    function _recover(address account, bytes32 userOpHash, bytes calldata signature)
        internal
        view
        returns (address)
    {
        if (signature.length < 65) revert InvalidSignature();
        bytes32 structHash =
            keccak256(abi.encode(_USEROP_TYPEHASH, account, 0, userOpHash)); // nonce bound via hash anyway
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                keccak256(
                    abi.encode(
                        _DOMAIN_TYPEHASH,
                        keccak256("SigilKit7579"),
                        keccak256("1"),
                        block.chainid,
                        account
                    )
                ),
                structHash
            )
        );
        bytes32 r = bytes32(signature[0:32]);
        bytes32 vs = bytes32(signature[32:64]);
        uint8 yParity = uint8(signature[64]);
        if (yParity != 27 && yParity != 28) revert InvalidSignature();
        // EIP-2: reject malleable high-s signatures (s' = N - s verifies identically).
        if (uint256(vs) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert InvalidSignature();
        }
        address recovered = ecrecover(digest, yParity, r, vs);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }
}
