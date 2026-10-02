// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKey7579Module, PackedUserOperation} from "../src/SessionKey7579Module.sol";
import {MerkleWhitelist} from "../src/MerkleWhitelist.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";

/// @dev Mock 7579 account: installs the module and forwards validateUserOp.
contract MockAccount {
    SessionKey7579Module public module;
    bool public installed;

    constructor(SessionKey7579Module module_) {
        module = module_;
    }

    function install(bytes memory data) external {
        module.onInstall(data);
        installed = true;
    }

    function uninstall() external {
        module.onUninstall("");
    }

    /// @dev Real accounts run validation modules in their own context (ERC-4337/7579),
    ///      so the account itself must be msg.sender for validateUserOp.
    function validate(PackedUserOperation memory op, bytes32 hash)
        external
        returns (uint256)
    {
        return module.validateUserOp(op, hash);
    }
}

contract SessionKey7579ModuleTest is Test {
    SessionKey7579Module internal module;
    MockAccount internal account;

    uint256 internal constant KEY_PK = 0xC0FFEE;
    address internal key;

    /// @dev Group order N of secp256k1 (used to craft high-s malleated signatures).
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    uint48 internal constant EXPIRES_AT = 1_900_000_000; // far future vs 2026 timestamps
    uint48 internal constant WINDOW_SECONDS = 600;

    function setUp() public {
        // Foundry's default block.timestamp is 1 — move to a realistic epoch so
        // "expiry in the past" tests exercise the intended branch.
        vm.warp(1_700_000_000);
        module = new SessionKey7579Module();
        account = new MockAccount(module);
        key = vm.addr(KEY_PK);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function defaultScope() internal pure returns (SessionKey7579Module.Scope memory) {
        return SessionKey7579Module.Scope({
            expiresAt: EXPIRES_AT,
            windowSeconds: WINDOW_SECONDS,
            perActionCap: 0.5 ether,
            perWindowCap: 1 ether,
            merkleRoot: bytes32(0)
        });
    }

    function installWithScope() internal {
        account.install(abi.encode(key, defaultScope()));
    }

    /// @dev userOp.callData for a single ERC-7579 call: mode(32) || abi.encode(ExecTuple).
    function singleCallData(address target, uint256 value, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            bytes32(uint256(0x00)), // callType = call
            abi.encode(SessionKey7579Module.ExecTuple({target: target, value: value, data: data}))
        );
    }

    function batchCallData(SessionKey7579Module.ExecTuple[] memory calls)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(bytes32(uint256(0x01 << 248)), abi.encode(calls));
    }

    /// @dev Recomputes the module's EIP-712 digest for (account, userOpHash).
    function digestFor(address acct, bytes32 userOpHash) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("UserOp(address sender,uint256 nonce,bytes32 userOpHash)"),
                acct,
                0,
                userOpHash
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("SigilKit7579"),
                keccak256("1"),
                block.chainid,
                acct
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// @dev Signs the module's digest for (account, hash) and appends optional proof tail.
    function signFor(address acct, bytes32 userOpHash, bytes32[] memory proof)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = digestFor(acct, userOpHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY_PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        if (proof.length != 0) {
            sig = abi.encodePacked(sig, uint16(proof.length));
            for (uint256 i = 0; i < proof.length; ++i) {
                sig = abi.encodePacked(sig, proof[i]);
            }
        }
        return sig;
    }

    function makeUserOp(bytes memory callData, bytes memory signature)
        internal
        pure
        returns (PackedUserOperation memory)
    {
        return PackedUserOperation({
            sender: address(0), // filled by caller
            nonce: 0,
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32(0),
            preVerificationGas: 0,
            gasFees: bytes32(0),
            paymasterAndData: "",
            signature: signature
        });
    }

    function packedSuccess(uint48 validUntil) internal pure returns (uint256) {
        return uint256(validUntil) << 160; // validAfter=0, authorizer=0
    }

    /// @dev Signs and appends an EXPLICIT proof tail, bypassing `signFor`'s "omit when
    ///      empty" shortcut. Needed to drive the C-01 element-count ceiling: a zero-element
    ///      tail still has to be spelled out to be distinguishable from a bare 65-byte sig.
    function signWithExplicitProofTail(address acct, bytes32 userOpHash, uint16 count, uint256 fill)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = digestFor(acct, userOpHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY_PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v, count);
        for (uint256 i = 0; i < count; ++i) {
            sig = abi.encodePacked(sig, keccak256(abi.encode("proof", fill, i)));
        }
        return sig;
    }

    /// @dev A single-call proof tail of exactly `count` elements, as bytes.
    function singleProofTail(uint16 count, uint256 fill) internal pure returns (bytes memory) {
        bytes memory tail = abi.encodePacked(count);
        for (uint256 i = 0; i < count; ++i) {
            tail = abi.encodePacked(tail, keccak256(abi.encode("proof", fill, i)));
        }
        return tail;
    }

    /// @dev Builds a batch proof tail: [uint16 tupleCount][n × {uint16 len, len × bytes32}].
    ///      `lens[i]` is the element count for tuple i.
    function batchProofTail(uint16[] memory lens) internal pure returns (bytes memory) {
        bytes memory tail = abi.encodePacked(uint16(lens.length));
        for (uint256 i = 0; i < lens.length; ++i) {
            tail = abi.encodePacked(tail, lens[i]);
            for (uint256 j = 0; j < lens[i]; ++j) {
                tail = abi.encodePacked(tail, keccak256(abi.encode("elem", i, j)));
            }
        }
        return tail;
    }

    /// @dev `callType` byte followed by an EMPTY payload — the exact `callData.length == 32`
    ///      boundary that BUG-19 is about.
    function emptyPayloadCallData(uint256 callType) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(callType << 248));
    }

    /// @dev callData for an arbitrary callType byte plus an arbitrary (possibly truncated)
    ///      body — lets a test land on an exact total length.
    function rawCallData(uint256 callType, bytes memory body) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(callType << 248), body);
    }

    // ------------------------------------------------------------------
    // Module surface
    // ------------------------------------------------------------------
    function test_IsValidatorModuleType() public view {
        assertTrue(module.isModuleType(1));
        assertFalse(module.isModuleType(2));
        assertFalse(module.isModuleType(3));
    }

    function test_OnInstallGrantsInitialScope() public {
        installWithScope();
        assertTrue(module.isInitialized(address(account)));
        SessionKey7579Module.Scope memory s = module.getScope(address(account), key);
        assertEq(s.perActionCap, 0.5 ether);
        assertEq(s.expiresAt, EXPIRES_AT);
    }

    function test_DoubleInstall_Reverts() public {
        installWithScope();
        vm.prank(address(account));
        vm.expectRevert(SessionKey7579Module.AlreadyInitialized.selector);
        module.onInstall("");
    }

    function test_GrantRequiresInitializedCaller() public {
        vm.expectRevert(SessionKey7579Module.NotInitialized.selector);
        module.grantSessionKey(key, defaultScope());
    }

    function test_GrantRejectsPastExpiry_AndBadCaps() public {
        account.install("");

        vm.prank(address(account));
        SessionKey7579Module.Scope memory past = defaultScope();
        past.expiresAt = 1000; // in the past
        vm.expectRevert(SessionKey7579Module.KeyExpired.selector);
        module.grantSessionKey(key, past);

        vm.prank(address(account));
        SessionKey7579Module.Scope memory zeroCap = defaultScope();
        zeroCap.perActionCap = 0;
        vm.expectRevert(SessionKey7579Module.MalformedExecutionData.selector);
        module.grantSessionKey(key, zeroCap);

        vm.prank(address(account));
        SessionKey7579Module.Scope memory inverted = defaultScope();
        inverted.perWindowCap = 0.1 ether; // < perActionCap
        vm.expectRevert(SessionKey7579Module.MalformedExecutionData.selector);
        module.grantSessionKey(key, inverted);
    }

    // ------------------------------------------------------------------
    // Validation
    // ------------------------------------------------------------------
    function test_Validate_SingleCall_Success_BindsValidUntil() public {
        installWithScope();
        bytes32 opHash = keccak256("op1");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0.1 ether, hex"deadbeef"),
            signFor(address(account), opHash, new bytes32[](0))
        );
        op.sender = address(account);
        uint256 vd = account.validate(op, opHash);
        assertEq(vd, packedSuccess(EXPIRES_AT), "validation binds authorization to scope expiry");
    }

    function test_Validate_WrongSigner_Reverts() public {
        installWithScope();
        bytes32 opHash = keccak256("op2");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0, ""),
            signFor(address(0xDEAD), opHash, new bytes32[](0)) // signed by other "account"
        );
        op.sender = address(account);
        vm.expectRevert(SessionKey7579Module.KeyUnknown.selector);
        account.validate(op, opHash);
    }

    function test_Validate_CrossAccountReplay_Fails() public {
        installWithScope();
        MockAccount other = new MockAccount(module);
        vm.prank(address(other));
        module.onInstall(abi.encode(key, defaultScope()));

        bytes32 opHash = keccak256("op3");
        // Signature made for `account` presented against `other`
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0, ""),
            signFor(address(account), opHash, new bytes32[](0))
        );
        op.sender = address(other);
        vm.expectRevert(); // KeyUnknown — recovered signer differs under other's domain
        other.validate(op, opHash);
    }

    function test_Validate_ExpiredKey_Reverts() public {
        installWithScope();
        warpPastExpiry();
        bytes32 opHash = keccak256("op4");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0, ""),
            signFor(address(account), opHash, new bytes32[](0))
        );
        op.sender = address(account);
        vm.expectRevert(SessionKey7579Module.KeyExpired.selector);
        account.validate(op, opHash);
    }

    function warpPastExpiry() internal {
        vm.warp(EXPIRES_AT + 1);
    }

    function test_Validate_DeniedSelector_Reverts() public {
        installWithScope();
        vm.prank(address(account));
        module.setSelectorDenied(hex"cafebabe", true);

        bytes32 opHash = keccak256("op5");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0, hex"cafebabe"),
            signFor(address(account), opHash, new bytes32[](0))
        );
        op.sender = address(account);
        // `hex"cafebabe"` is exactly 4 bytes, so the cast is a widening/label change, not a
        // truncation — it only names the selector for the expected-revert matcher.
        // forge-lint: disable-next-line(unsafe-typecast)
        vm.expectRevert(abi.encodeWithSelector(SessionKey7579Module.SelectorDenied.selector, bytes4(hex"cafebabe")));
        account.validate(op, opHash);
    }

    function test_Validate_WindowAccumulatesAndRolloverResets() public {
        installWithScope();
        // Every call stays within the per-action cap (0.5); the THIRD crosses the
        // window cap (0.5 + 0.3 + 0.25 = 1.05 > 1.0) and must revert on the window.
        _expectWindowSpend(0.5 ether, true);
        _expectWindowSpend(0.3 ether, true);
        _expectWindowSpend(0.25 ether, false); // window cap, not action cap

        vm.warp(block.timestamp + WINDOW_SECONDS + 1);
        _expectWindowSpend(0.25 ether, true); // fresh window
    }

    function _expectWindowSpend(uint256 value, bool shouldPass) internal {
        bytes32 opHash = keccak256(abi.encode("opW", value, shouldPass));
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), value, hex""),
            signFor(address(account), opHash, new bytes32[](0))
        );
        op.sender = address(account);
        if (shouldPass) {
            uint256 vd = account.validate(op, opHash);
            assertEq(vd, packedSuccess(EXPIRES_AT));
        } else {
            vm.expectRevert();
            account.validate(op, opHash);
        }
    }

    // ------------------------------------------------------------------
    // Batch + whitelist semantics
    // ------------------------------------------------------------------
    function test_Validate_Batch_ChargesTotalAgainstWindow() public {
        installWithScope();
        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](2);
        calls[0] = SessionKey7579Module.ExecTuple(address(0xA), 0.4 ether, hex"");
        calls[1] = SessionKey7579Module.ExecTuple(address(0xB), 0.5 ether, hex"");

        bytes32 opHash = keccak256("batch1");
        PackedUserOperation memory op = makeUserOp(
            batchCallData(calls),
            signFor(address(account), opHash, new bytes32[](0))
        );
        op.sender = address(account);
        uint256 vd = account.validate(op, opHash);
        assertEq(vd, packedSuccess(EXPIRES_AT));

        (, uint256 spent) = module.getWindowState(address(account), key);
        assertEq(spent, 0.9 ether, "batch total charged once");

        // A further 0.2 must now exceed the window cap.
        SessionKey7579Module.ExecTuple[] memory more = new SessionKey7579Module.ExecTuple[](1);
        more[0] = SessionKey7579Module.ExecTuple(address(0xC), 0.2 ether, hex"");
        bytes32 h2 = keccak256("batch2");
        PackedUserOperation memory op2 = makeUserOp(batchCallData(more), signFor(address(account), h2, new bytes32[](0)));
        op2.sender = address(account);
        vm.expectRevert();
        account.validate(op2, h2);
    }

    function test_Validate_Batch_PerActionCapViolated_Reverts() public {
        installWithScope();
        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](2);
        calls[0] = SessionKey7579Module.ExecTuple(address(0xA), 0.3 ether, hex"");
        calls[1] = SessionKey7579Module.ExecTuple(address(0xB), 0.8 ether, hex""); // > 0.5 action cap
        bytes32 opHash = keccak256("batch3");
        PackedUserOperation memory op = makeUserOp(batchCallData(calls), signFor(address(account), opHash, new bytes32[](0)));
        op.sender = address(account);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpendPolicy.PerActionCapExceeded.selector, 0.8 ether, 0.5 ether
            )
        );
        account.validate(op, opHash);
    }

    function test_WhitelistedSingleCall_AcceptsValidProof_RejectsWrongTarget() public {
        // scope WITH a real root over leaves {leafA} — leaf format v2 wildcard leaf
        address targetA = address(0x1111);
        bytes4 selector = hex"12345678";
        bytes32 leafA = keccak256(abi.encode(targetA, selector, bytes32(0)));

        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = leafA; // single-leaf tree; empty proof path == identity? No:
        // sorted-pair verify with EMPTY proof reduces to leaf == root → works for 1-leaf tree.

        account.install(abi.encode(key, scoped));

        bytes32 opHash = keccak256("wl1");
        PackedUserOperation memory ok = makeUserOp(
            singleCallData(targetA, 0, abi.encodePacked(selector)),
            signFor(address(account), opHash, new bytes32[](0)) // empty proof suffices for 1-leaf root
        );
        ok.sender = address(account);
        uint256 vd = account.validate(ok, opHash);
        assertEq(vd, packedSuccess(EXPIRES_AT));

        // different target → not whitelisted
        bytes32 h2 = keccak256("wl2");
        PackedUserOperation memory bad = makeUserOp(
            singleCallData(address(0x2222), 0, abi.encodePacked(selector)),
            signFor(address(account), h2, new bytes32[](0))
        );
        bad.sender = address(account);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKey7579Module.TargetNotAllowed.selector,
                address(0x2222),
                selector
            )
        );
        account.validate(bad, h2);
    }

    function test_BatchUnderWhitelist_PerTupleProofs_Accept() public {
        // E16: batching is no longer locked out of the whitelist regime — each tuple
        // carries its own proof in the signature tail
        // [uint16 tupleCount][tupleCount × {uint16 proofLen, proofLen × bytes32}].
        address targetA = address(0x1111);
        address targetB = address(0x2222);
        bytes4 selector = hex"12345678";
        bytes32 leafA = keccak256(abi.encode(targetA, selector, bytes32(0)));
        bytes32 leafB = keccak256(abi.encode(targetB, selector, bytes32(0)));
        bytes32 root = leafA < leafB
            ? keccak256(abi.encodePacked(leafA, leafB))
            : keccak256(abi.encodePacked(leafB, leafA));

        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = root;
        account.install(abi.encode(key, scoped));

        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](2);
        calls[0] = SessionKey7579Module.ExecTuple(targetA, 0.1 ether, abi.encodePacked(selector));
        calls[1] = SessionKey7579Module.ExecTuple(targetB, 0.1 ether, abi.encodePacked(selector));

        // Proof for tuple 0 is leafB; for tuple 1 is leafA (2-leaf sorted tree).
        bytes32 proofForA = leafB;
        bytes32 proofForB = leafA;
        bytes memory tail = abi.encodePacked(
            uint16(2), // tuple count
            uint16(1), proofForA, // tuple 0: one proof element
            uint16(1), proofForB // tuple 1: one proof element
        );
        bytes32 opHash = keccak256("bwl-accept");
        PackedUserOperation memory op = makeUserOp(
            batchCallData(calls), abi.encodePacked(signFor(address(account), opHash, new bytes32[](0)), tail)
        );
        op.sender = address(account);
        uint256 vd = account.validate(op, opHash);
        assertEq(vd, packedSuccess(EXPIRES_AT), "whitelisted batch with per-tuple proofs should validate");
    }

    function test_BatchUnderWhitelist_TamperedProof_Reverts() public {
        address targetA = address(0x1111);
        bytes4 selector = hex"12345678";
        bytes32 leafA = keccak256(abi.encode(targetA, selector, bytes32(0)));
        bytes32 leafB = keccak256(abi.encode(address(0x2222), selector, bytes32(0)));
        bytes32 root = leafA < leafB
            ? keccak256(abi.encodePacked(leafA, leafB))
            : keccak256(abi.encodePacked(leafB, leafA));

        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = root;
        account.install(abi.encode(key, scoped));

        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](1);
        calls[0] = SessionKey7579Module.ExecTuple(targetA, 0, abi.encodePacked(selector));
        // Wrong proof: the element is NOT leafA's sibling.
        bytes32 wrong = keccak256("wrong");
        bytes memory tail = abi.encodePacked(uint16(1), uint16(1), wrong);
        bytes32 opHash = keccak256("bwl-bad");
        PackedUserOperation memory op = makeUserOp(
            batchCallData(calls), abi.encodePacked(signFor(address(account), opHash, new bytes32[](0)), tail)
        );
        op.sender = address(account);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKey7579Module.TargetNotAllowed.selector, targetA, selector)
        );
        account.validate(op, opHash);
    }

    function test_BatchUnderWhitelist_MalformedTail_Reverts() public {
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = bytes32(uint256(0xABCD));
        account.install(abi.encode(key, scoped));

        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](2);
        calls[0] = SessionKey7579Module.ExecTuple(address(0xA), 0, hex"");
        calls[1] = SessionKey7579Module.ExecTuple(address(0xB), 0, hex"");
        // Tail declares 1 tuple but the batch has 2 → InvalidSignature.
        bytes memory tail = abi.encodePacked(uint16(1), uint16(0));
        bytes32 opHash = keccak256("bwl-malformed");
        PackedUserOperation memory op = makeUserOp(
            batchCallData(calls), abi.encodePacked(signFor(address(account), opHash, new bytes32[](0)), tail)
        );
        op.sender = address(account);
        vm.expectRevert(SessionKey7579Module.InvalidSignature.selector);
        account.validate(op, opHash);
    }

    // ------------------------------------------------------------------
    // Lifecycle edge
    // ------------------------------------------------------------------
    function test_UninstallThenGrant_RevertsNotInitialized() public {
        installWithScope();
        vm.prank(address(account));
        module.revokeSessionKey(key);
        vm.prank(address(account));
        module.onUninstall("");
        vm.prank(address(account));
        vm.expectRevert(SessionKey7579Module.NotInitialized.selector);
        module.grantSessionKey(key, defaultScope());
    }

    // ------------------------------------------------------------------
    // Security hardening (audit fixes)
    // ------------------------------------------------------------------
    /// @dev FIX: anyone mempool-copying a userOp must not be able to invoke
    ///      validateUserOp directly and burn the victim's spend window.
    function test_Validate_DirectCallFromNonSender_RevertsNotAuthorizedCaller() public {
        installWithScope();
        bytes32 opHash = keccak256("sec1");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0.1 ether, hex""),
            signFor(address(account), opHash, new bytes32[](0))
        );
        op.sender = address(account);

        vm.prank(address(0xE17));
        vm.expectRevert(SessionKey7579Module.NotAuthorizedCaller.selector);
        module.validateUserOp(op, opHash);

        // The rejected call must not have mutated window state.
        (, uint256 spent) = module.getWindowState(address(account), key);
        assertEq(spent, 0, "direct-call attempt must not burn spend window");
    }

    /// @dev FIX: uninstalled accounts' retained scopes must not keep validating.
    function test_Validate_AfterUninstall_RevertsNotInitialized() public {
        installWithScope();
        account.uninstall();
        assertFalse(module.isInitialized(address(account)));

        bytes32 opHash = keccak256("sec2");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0, ""),
            signFor(address(account), opHash, new bytes32[](0))
        );
        op.sender = address(account);

        // Scope storage is intentionally retained post-uninstall, so hitting
        // NotInitialized (not KeyUnknown) proves validation gates on initialized.
        vm.expectRevert(SessionKey7579Module.NotInitialized.selector);
        account.validate(op, opHash);
    }

    /// @dev FIX: EIP-2 malleability — s' = N - s recovers the same key but must reject.
    function test_Validate_HighS_MalleatedSig_RevertsInvalidSignature() public {
        installWithScope();
        bytes32 opHash = keccak256("sec3");
        bytes32 digest = digestFor(address(account), opHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY_PK, digest);
        assertTrue(uint256(s) <= SECP256K1_N / 2, "precondition: vm.sign emits low-s");

        // Malleate: negating s flips the curve-point parity; ecrecover still yields
        // the session key when presented with the flipped v.
        uint256 sHigh = SECP256K1_N - uint256(s);
        uint8 vFlipped = uint8(27 + ((v - 27) ^ 1));
        assertEq(ecrecover(digest, vFlipped, r, bytes32(sHigh)), key, "malleation recovers same key");

        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0, ""),
            abi.encodePacked(r, bytes32(sHigh), vFlipped)
        );
        op.sender = address(account);

        vm.expectRevert(SessionKey7579Module.InvalidSignature.selector);
        account.validate(op, opHash);
    }

    /// @dev FIX: empty batches are rejected outright.
    function test_Validate_EmptyBatch_RevertsMalformedExecutionData() public {
        installWithScope();
        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](0);
        bytes32 opHash = keccak256("sec4");
        PackedUserOperation memory op = makeUserOp(
            batchCallData(calls),
            signFor(address(account), opHash, new bytes32[](0))
        );
        op.sender = address(account);

        vm.expectRevert(SessionKey7579Module.MalformedExecutionData.selector);
        account.validate(op, opHash);
    }

    /// @dev FIX: batches above MAX_BATCH_SIZE (= 8) are rejected; 8 still passes.
    function test_Validate_BatchOverMaxSize_Reverts_EightStillPasses() public {
        installWithScope();

        SessionKey7579Module.ExecTuple[] memory maxBatch = new SessionKey7579Module.ExecTuple[](8);
        for (uint256 i = 0; i < maxBatch.length; ++i) {
            // Test fixture: distinct small target addresses (1..8) — the narrowing is bounded
            // by the loop index and cannot truncate.
            // forge-lint: disable-next-line(unsafe-typecast)
            maxBatch[i] = SessionKey7579Module.ExecTuple(address(uint160(i + 1)), 0, hex"");
        }
        bytes32 okHash = keccak256("sec5-ok");
        PackedUserOperation memory ok =
            makeUserOp(batchCallData(maxBatch), signFor(address(account), okHash, new bytes32[](0)));
        ok.sender = address(account);
        assertEq(account.validate(ok, okHash), packedSuccess(EXPIRES_AT), "batch of 8 allowed");

        SessionKey7579Module.ExecTuple[] memory tooBig = new SessionKey7579Module.ExecTuple[](9);
        for (uint256 i = 0; i < tooBig.length; ++i) {
            // Test fixture: bounded loop index, cannot truncate.
            // forge-lint: disable-next-line(unsafe-typecast)
            tooBig[i] = SessionKey7579Module.ExecTuple(address(uint160(i + 1)), 0, hex"");
        }
        bytes32 badHash = keccak256("sec5-bad");
        PackedUserOperation memory bad =
            makeUserOp(batchCallData(tooBig), signFor(address(account), badHash, new bytes32[](0)));
        bad.sender = address(account);

        vm.expectRevert(SessionKey7579Module.MalformedExecutionData.selector);
        account.validate(bad, badHash);
    }

    /// @dev PERF-4: bounds the ERC-4337 verification-gas cost of the worst-case batch.
    ///
    ///      This is the failure mode that actually bites in production: a bundler
    ///      simulates `validateUserOp` and rejects the userOp outright when validation
    ///      exceeds its verification-gas ceiling — with no on-chain trace and no CI
    ///      signal, because nothing measured it. MAX_BATCH_SIZE (8) and
    ///      MAX_TOTAL_PROOF_ELEMENTS (32) are static proxies for a gas bound that was
    ///      never measured; this test supplies the real one.
    function test_Gas_ValidateMaxBatch_WithinVerificationBudget() public {
        installWithScope();

        SessionKey7579Module.ExecTuple[] memory maxBatch = new SessionKey7579Module.ExecTuple[](8);
        for (uint256 i = 0; i < maxBatch.length; ++i) {
            // Test fixture: distinct small target addresses (1..8) — the narrowing is bounded
            // by the loop index and cannot truncate.
            // forge-lint: disable-next-line(unsafe-typecast)
            maxBatch[i] = SessionKey7579Module.ExecTuple(address(uint160(i + 1)), 0, hex"");
        }
        bytes32 opHash = keccak256("gas-max-batch");
        PackedUserOperation memory op =
            makeUserOp(batchCallData(maxBatch), signFor(address(account), opHash, new bytes32[](0)));
        op.sender = address(account);

        uint256 before = gasleft();
        uint256 vd = account.validate(op, opHash);
        uint256 used = before - gasleft();

        assertEq(vd, packedSuccess(EXPIRES_AT), "max batch should validate");
        emit log_named_uint("gas: validateUserOp (8-tuple batch)", used);
        // Typical bundler ceilings are ~150-200k; the budget is set below that so a
        // regression fails here rather than as a silent production rejection.
        assertLt(used, 120_000, "8-tuple validation exceeded the 4337 verification-gas budget");
    }

    // NOTE: a `test_MerkleLibStillVerifiedByHalmosSuite_RegressionGuard` marker used to
    // live here. It asserted `MerkleWhitelist.verify(0, 0, 0)` — three compile-time
    // constants, so it could not fail and tested nothing. Its docstring claimed it
    // guarded the Halmos specification, but `HalmosTest` (Halmos.t.sol:34) is a separate
    // contract: `halmos --match-contract HalmosTest` never selects this suite, and the
    // real (stronger) symbolic coverage of `verify` lives at Halmos.t.sol:167.
    // Removed rather than left in place, because a green test that guards nothing is
    // worse than no test — it reads as evidence during review.

    // ------------------------------------------------------------------
    // C-01: single-call proof element ceiling (validation gas bomb)
    // ------------------------------------------------------------------

    /// @dev C-01 regression. `count` is a uint16 read straight out of the attacker-supplied
    ///      signature, so before the fix a ~2 MB tail (65535 elements) drove 65535 keccak
    ///      rounds plus a 2 MB `new bytes32[]` allocation inside `validateUserOp` — burning
    ///      a bundler's entire verification-gas limit and degrading unrelated ops sharing
    ///      the EntryPoint. Now bounded by MAX_SINGLE_PROOF_ELEMENTS.
    function test_Validate_SingleCallProofOverMaxElements_Reverts() public {
        installWithScope();
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = keccak256("some-root");
        account.uninstall();
        account.install(abi.encode(key, scoped));

        bytes32 opHash = keccak256("c01-over-max");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0, hex"12345678"),
            signWithExplicitProofTail(address(account), opHash, 9, 1) // 9 > 8
        );
        op.sender = address(account);

        vm.expectRevert(SessionKey7579Module.InvalidSignature.selector);
        account.validate(op, opHash);
    }

    /// @dev The ceiling is exactly 8: an 8-element tail clears the length check and is
    ///      processed, so this pins the boundary (9 reverts, 8 does not) rather than only
    ///      the reject side. The tail is bogus, so the op then fails at the whitelist —
    ///      which is exactly the point: it must fail with `TargetNotAllowed`, proving the
    ///      proof was PARSED and hashed, not rejected by the count ceiling.
    function test_Validate_SingleCallProofAtMaxElements_IsParsedNotRejected() public {
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = keccak256("some-root");
        account.install(abi.encode(key, scoped));

        bytes32 opHash = keccak256("c01-at-max");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0, hex"12345678"),
            signWithExplicitProofTail(address(account), opHash, 8, 2)
        );
        op.sender = address(account);

        // Reached the Merkle check with 8 elements in hand → not a parse rejection.
        vm.expectRevert(
            abi.encodeWithSelector(
                // Test fixture: a 4-byte literal, so this is a pure label change, not a truncation.
                // forge-lint: disable-next-line(unsafe-typecast)
                SessionKey7579Module.TargetNotAllowed.selector, address(0xBEEF), bytes4(hex"12345678")
            )
        );
        account.validate(op, opHash);
    }

    /// @dev Defense in depth for C-01: the ceiling must not be load-bearing. An EMPTY
    ///      single-call tail is the legitimate zero-element case and must still work, so
    ///      `_whitelisted`'s own `proof.length` guard is never the thing that fires.
    function test_Validate_SingleCallProofEmpty_StillVerifies() public {
        address targetA = address(0x1111);
        bytes4 selector = hex"12345678";
        bytes32 leafA = keccak256(abi.encode(targetA, selector, bytes32(0)));
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = leafA;
        account.install(abi.encode(key, scoped));

        // Explicit `[uint16 0]` tail (67 bytes) — distinct from a bare 65-byte signature.
        bytes32 opHash = keccak256("c01-empty");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(targetA, 0, abi.encodePacked(selector)),
            signWithExplicitProofTail(address(account), opHash, 0, 3)
        );
        op.sender = address(account);

        assertEq(account.validate(op, opHash), packedSuccess(EXPIRES_AT), "0-element proof must verify");
    }

    // ------------------------------------------------------------------
    // MAX_TOTAL_PROOF_ELEMENTS (= 32) — previously had zero coverage
    // ------------------------------------------------------------------

    /// @dev Pins the batch aggregate ceiling. 8 tuples × 4 elements = 32 is the maximum
    ///      legal shape; 33 must be rejected. The constant was previously exercised by
    ///      nothing at all, so a silent edit to it (e.g. a well-meaning "raise the gas
    ///      ceiling" bump) would have gone unnoticed.
    function test_ParseBatchProofs_TotalElements_AtCeiling_AndOneOver() public {
        // --- 8 × 4 = 32: exactly at the ceiling, must be ACCEPTED ---
        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](8);
        for (uint256 i = 0; i < calls.length; ++i) {
            // Test fixture: bounded loop index, cannot truncate.
            // forge-lint: disable-next-line(unsafe-typecast)
            calls[i] = SessionKey7579Module.ExecTuple(address(uint160(i + 1)), 0, hex"12345678");
        }
        uint16[] memory lens32 = new uint16[](8);
        for (uint256 i = 0; i < lens32.length; ++i) {
            lens32[i] = 4;
        }

        // Root is irrelevant here: use a non-zero root so the tail IS parsed, and a leaf
        // that cannot verify, so a 32-element tail is proven ACCEPTED-by-the-parser by
        // failing at the Merkle check (TargetNotAllowed) instead of at the count ceiling
        // (InvalidSignature).
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = keccak256("root32");
        account.install(abi.encode(key, scoped));

        bytes32 opHash = keccak256("mt-32");
        PackedUserOperation memory op = makeUserOp(
            batchCallData(calls),
            abi.encodePacked(
                signFor(address(account), opHash, new bytes32[](0)), batchProofTail(lens32)
            )
        );
        op.sender = address(account);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKey7579Module.TargetNotAllowed.selector,
                address(uint160(1)),
                // Test fixture: a 4-byte literal widened to bytes4 — a label change, not a truncation.
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes4(hex"12345678")
            )
        );
        account.validate(op, opHash);

        // --- 33 elements: one over the ceiling, must be REJECTED at the count check ---
        uint16[] memory lens33 = new uint16[](8);
        for (uint256 i = 0; i < lens33.length; ++i) {
            lens33[i] = 4;
        }
        lens33[7] = 5; // 7×4 + 5 = 33

        bytes32 opHash2 = keccak256("mt-33");
        PackedUserOperation memory op2 = makeUserOp(
            batchCallData(calls),
            abi.encodePacked(
                signFor(address(account), opHash2, new bytes32[](0)), batchProofTail(lens33)
            )
        );
        op2.sender = address(account);
        vm.expectRevert(SessionKey7579Module.InvalidSignature.selector);
        account.validate(op2, opHash2);
    }

    /// @dev MAX_TOTAL_PROOF_ELEMENTS is also reachable through a SINGLE oversized tuple
    ///      under the ceiling, which is why the 33-case above must use 8×4+5 (spanning
    ///      tuples) rather than one fat tuple: one tuple of 33 would be caught by the
    ///      per-tuple `proofLen * 32` bounds check first, not by the total-elements ceiling.
    function test_ParseBatchProofs_OverCeilingInSingleTuple_Reverts() public {
        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](1);
        calls[0] = SessionKey7579Module.ExecTuple(address(0xA), 0, hex"12345678");
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = keccak256("root33-single");
        account.install(abi.encode(key, scoped));

        uint16[] memory lens = new uint16[](1);
        lens[0] = 33; // a single tuple declaring 33 elements
        bytes32 opHash = keccak256("mt-single-33");
        PackedUserOperation memory op = makeUserOp(
            batchCallData(calls),
            abi.encodePacked(
                signFor(address(account), opHash, new bytes32[](0)), batchProofTail(lens)
            )
        );
        op.sender = address(account);
        vm.expectRevert(SessionKey7579Module.InvalidSignature.selector);
        account.validate(op, opHash);
    }

    // ------------------------------------------------------------------
    // _parseBatchProofs — 4 boundary cases, previously zero coverage
    // ------------------------------------------------------------------

    /// @dev _parseBatchProofs boundary #1: a tail shorter than the 2-byte tupleCount
    ///      header reverts, and so does a signature with no tail at all under a non-zero
    ///      root (`length < 67`). Neither reaches the tuple loop.
    function test_ParseBatchProofs_TailTooShort_Reverts() public {
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = keccak256("root-short");
        account.install(abi.encode(key, scoped));

        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](1);
        calls[0] = SessionKey7579Module.ExecTuple(address(0xA), 0, hex"12345678");

        // (a) no tail at all: signature is exactly the 65-byte ECDSA.
        bytes32 h1 = keccak256("bp-none");
        PackedUserOperation memory op1 =
            makeUserOp(batchCallData(calls), signFor(address(account), h1, new bytes32[](0)));
        op1.sender = address(account);
        vm.expectRevert(SessionKey7579Module.InvalidSignature.selector);
        account.validate(op1, h1);

        // (b) a 1-byte tail: past the `length < 67` gate but short of the tupleCount read.
        bytes32 h2 = keccak256("bp-1byte");
        PackedUserOperation memory op2 = makeUserOp(
            batchCallData(calls), abi.encodePacked(signFor(address(account), h2, new bytes32[](0)), hex"01")
        );
        op2.sender = address(account);
        vm.expectRevert(SessionKey7579Module.InvalidSignature.selector);
        account.validate(op2, h2);
    }

    /// @dev _parseBatchProofs boundary #2: `offset + 2 > signature.length` — the tail
    ///      declares its tuples but is TRUNCATED mid-way through a proofLen header, so
    ///      the per-tuple length read would run off the end of calldata.
    function test_ParseBatchProofs_TruncatedProofLenHeader_Reverts() public {
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = keccak256("root-trunclen");
        account.install(abi.encode(key, scoped));

        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](2);
        calls[0] = SessionKey7579Module.ExecTuple(address(0xA), 0, hex"12345678");
        calls[1] = SessionKey7579Module.ExecTuple(address(0xB), 0, hex"12345678");

        // tupleCount = 2, tuple 0 gets len 0, then the tail ENDS — tuple 1's 2-byte
        // proofLen header is missing entirely.
        bytes memory tail = abi.encodePacked(uint16(2), uint16(0));
        bytes32 opHash = keccak256("bp-trunc-len");
        PackedUserOperation memory op = makeUserOp(
            batchCallData(calls), abi.encodePacked(signFor(address(account), opHash, new bytes32[](0)), tail)
        );
        op.sender = address(account);
        vm.expectRevert(SessionKey7579Module.InvalidSignature.selector);
        account.validate(op, opHash);
    }

    /// @dev _parseBatchProofs boundary #3: `offset + proofLen * 32 > signature.length` — the
    ///      proofLen header is present and in range, but the declared element bytes are
    ///      missing. This is the case that must NOT be trusted: without the length check a
    ///      short read would surface as a calldata-slice panic instead of InvalidSignature.
    function test_ParseBatchProofs_TruncatedProofElements_Reverts() public {
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = keccak256("root-trunc-elem");
        account.install(abi.encode(key, scoped));

        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](1);
        calls[0] = SessionKey7579Module.ExecTuple(address(0xA), 0, hex"12345678");

        // tupleCount = 1, proofLen = 4 declared, but ZERO element bytes supplied.
        bytes memory tail = abi.encodePacked(uint16(1), uint16(4));
        bytes32 opHash = keccak256("bp-trunc-elem");
        PackedUserOperation memory op = makeUserOp(
            batchCallData(calls), abi.encodePacked(signFor(address(account), opHash, new bytes32[](0)), tail)
        );
        op.sender = address(account);
        vm.expectRevert(SessionKey7579Module.InvalidSignature.selector);
        account.validate(op, opHash);
    }

    /// @dev _parseBatchProofs boundary #4: `offset != signature.length` trailing garbage.
    ///      The tail is otherwise perfectly valid (1 tuple, 0 elements) but carries an
    ///      extra byte, so it must be rejected rather than silently ignoring the surplus.
    function test_ParseBatchProofs_TrailingGarbage_Reverts() public {
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = keccak256("root-garbage");
        account.install(abi.encode(key, scoped));

        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](1);
        calls[0] = SessionKey7579Module.ExecTuple(address(0xA), 0, hex"12345678");

        // Valid: [tupleCount=1][proofLen=0]; then one stray byte.
        bytes memory tail = abi.encodePacked(uint16(1), uint16(0), hex"ff");
        bytes32 opHash = keccak256("bp-garbage");
        PackedUserOperation memory op = makeUserOp(
            batchCallData(calls), abi.encodePacked(signFor(address(account), opHash, new bytes32[](0)), tail)
        );
        op.sender = address(account);
        vm.expectRevert(SessionKey7579Module.InvalidSignature.selector);
        account.validate(op, opHash);
    }

    // ------------------------------------------------------------------
    // BUG-19: callData length / payload and selector derivation
    // ------------------------------------------------------------------

    /// @dev BUG-19 regression. `callData.length == 32` clears the `length < 32` gate but
    ///      leaves an EMPTY payload. `abi.decode(execPayload, (ExecTuple))` on empty data
    ///      reverts with a low-level ABI error, so a relayer/indexer could not distinguish
    ///      a malformed payload from an internal failure. Asserts the SEMANTIC error.
    ///
    ///      The paired negative assertion (that it is NOT an ABI panic) is what makes this
    ///      a real regression test: `vm.expectRevert(MalformedExecutionData.selector)`
    ///      matches the 4-byte selector only, so an ABI-encoded revert (which carries extra
    ///      data) would not satisfy it.
    function test_Validate_CallDataExactly32Bytes_RevertsMalformedExecutionData_NotAbiPanic() public {
        installWithScope();

        // (a) callType 0x00 (single)
        bytes32 h1 = keccak256("b19-32-single");
        PackedUserOperation memory op1 =
            makeUserOp(emptyPayloadCallData(0x00), signFor(address(account), h1, new bytes32[](0)));
        op1.sender = address(account);
        assertEq(op1.callData.length, 32, "precondition: callData is exactly 32 bytes");
        vm.expectRevert(SessionKey7579Module.MalformedExecutionData.selector);
        account.validate(op1, h1);

        // (b) callType 0x01 (batch) — same boundary, same semantic error.
        bytes32 h2 = keccak256("b19-32-batch");
        PackedUserOperation memory op2 =
            makeUserOp(emptyPayloadCallData(0x01), signFor(address(account), h2, new bytes32[](0)));
        op2.sender = address(account);
        vm.expectRevert(SessionKey7579Module.MalformedExecutionData.selector);
        account.validate(op2, h2);
    }

    /// @dev BUG-19 regression: `bytes4(data)` silently right-pads sub-4-byte calldata, so an
    ///      empty payload would derive `0x00000000` and a whitelist LEAF could be minted for
    ///      that zero selector — matching any sub-4-byte call while looking like a real one.
    ///      `_selectorOf` must reject it explicitly. Uses a root that genuinely contains the
    ///      `0x00000000` leaf, so the test proves the LENGTH gate fires rather than merely
    ///      observing an unrelated proof failure.
    function test_Validate_WhitelistedSub4ByteCalldata_Reverts_NotPaddedSelector() public {
        address targetA = address(0x1111);
        // The zero-selector leaf the old code would have matched on empty calldata.
        bytes32 zeroSelectorLeaf = keccak256(abi.encode(targetA, bytes4(0), bytes32(0)));
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = zeroSelectorLeaf;
        account.install(abi.encode(key, scoped));

        // Empty calldata: `bytes4("")` == 0x00000000 would have matched the leaf above.
        bytes32 opHash = keccak256("b19-sub4");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(targetA, 0, hex""),
            signWithExplicitProofTail(address(account), opHash, 0, 4)
        );
        op.sender = address(account);

        vm.expectRevert(SessionKey7579Module.MalformedExecutionData.selector);
        account.validate(op, opHash);
    }

    /// @dev The 3-byte case must be rejected too — it padded to `0xab000000`, a selector no
    ///      contract implements but which matched every 3-byte call sharing a prefix.
    function test_Validate_WhitelistedThreeByteCalldata_Reverts() public {
        address targetA = address(0x1111);
        // The literal is ALREADY the 4-byte padded form `bytes4("abcdef")` would produce —
        // this test asserts the padding itself is what the module must refuse to match.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 paddedLeaf = keccak256(abi.encode(targetA, bytes4(hex"ab000000"), bytes32(0)));
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = paddedLeaf;
        account.install(abi.encode(key, scoped));

        bytes32 opHash = keccak256("b19-3byte");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(targetA, 0, hex"abcdef"),
            signWithExplicitProofTail(address(account), opHash, 0, 5)
        );
        op.sender = address(account);

        vm.expectRevert(SessionKey7579Module.MalformedExecutionData.selector);
        account.validate(op, opHash);
    }

    /// @dev Control: the SAME native-ETH-transfer shape stays legal when NO whitelist is in
    ///      force. Guards against over-tightening `_enforceSingle`'s denylist cast into a
    ///      regression that would break empty-calldata value transfers outright.
    function test_Validate_NativeTransferEmptyCalldata_StillAllowedWithoutRoot() public {
        installWithScope();
        bytes32 opHash = keccak256("b19-native");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0.1 ether, hex""),
            signFor(address(account), opHash, new bytes32[](0))
        );
        op.sender = address(account);
        assertEq(account.validate(op, opHash), packedSuccess(EXPIRES_AT), "native transfer must stay legal");
    }

    /// @dev The denylist keeps the zero-padding convention on purpose (documented on
    ///      `_enforceSingle`): denying `0x00000000` must still block an empty-calldata
    ///      transfer, i.e. the padded selector is honoured rather than silently skipped.
    function test_Validate_NativeTransferDeniedSelector_StillBlocked() public {
        installWithScope();
        vm.prank(address(account));
        module.setSelectorDenied(bytes4(0), true);

        bytes32 opHash = keccak256("b19-native-denied");
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(0xBEEF), 0.1 ether, hex""),
            signFor(address(account), opHash, new bytes32[](0))
        );
        op.sender = address(account);

        vm.expectRevert(
            abi.encodeWithSelector(SessionKey7579Module.SelectorDenied.selector, bytes4(0))
        );
        account.validate(op, opHash);
    }

    /// @dev An unknown callType must be rejected by the MODULE itself. The E2E suite only
    ///      covered the ACCOUNT's own routing (`Account7579.execute`), never the validator,
    ///      so this branch had no coverage at all.
    function test_Validate_UnsupportedCallType_Reverts_ThroughModule() public {
        installWithScope();

        // callType 0x02 is neither 0x00 nor 0x01. The body is deliberately a well-formed
        // ExecTuple so the ONLY reason to fail is the callType branch.
        bytes1[3] memory callTypes = [bytes1(0x02), bytes1(0x03), bytes1(0xff)];
        for (uint256 i = 0; i < callTypes.length; ++i) {
            bytes32 opHash = keccak256(abi.encode("b19-calltype", callTypes[i]));
            PackedUserOperation memory op = makeUserOp(
                rawCallData(
                    uint256(uint8(callTypes[i])),
                    abi.encode(SessionKey7579Module.ExecTuple({target: address(0xBEEF), value: 0, data: hex"12345678"}))
                ),
                signFor(address(account), opHash, new bytes32[](0))
            );
            op.sender = address(account);
            vm.expectRevert(
                abi.encodeWithSelector(SessionKey7579Module.UnsupportedCallType.selector, callTypes[i])
            );
            account.validate(op, opHash);
        }
    }
}
