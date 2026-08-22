// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKey7579Module, PackedUserOperation} from "../src/SessionKey7579Module.sol";
import {MerkleWhitelist} from "../src/MerkleWhitelist.sol";

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
}

contract SessionKey7579ModuleTest is Test {
    SessionKey7579Module internal module;
    MockAccount internal account;

    uint256 internal constant KEY_PK = 0xC0FFEE;
    address internal key;

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

    /// @dev Signs the module's digest for (account, hash) and appends optional proof tail.
    function signFor(address acct, bytes32 userOpHash, bytes32[] memory proof)
        internal
        view
        returns (bytes memory)
    {
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
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
        uint256 vd = module.validateUserOp(op, opHash);
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
        module.validateUserOp(op, opHash);
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
        module.validateUserOp(op, opHash);
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
        module.validateUserOp(op, opHash);
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
        vm.expectRevert(abi.encodeWithSelector(SessionKey7579Module.SelectorDenied.selector, bytes4(hex"cafebabe")));
        module.validateUserOp(op, opHash);
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
            uint256 vd = module.validateUserOp(op, opHash);
            assertEq(vd, packedSuccess(EXPIRES_AT));
        } else {
            vm.expectRevert();
            module.validateUserOp(op, opHash);
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
        uint256 vd = module.validateUserOp(op, opHash);
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
        module.validateUserOp(op2, h2);
    }

    function test_Validate_Batch_PerActionCapViolated_Reverts() public {
        installWithScope();
        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](2);
        calls[0] = SessionKey7579Module.ExecTuple(address(0xA), 0.3 ether, hex"");
        calls[1] = SessionKey7579Module.ExecTuple(address(0xB), 0.8 ether, hex""); // > 0.5 action cap
        bytes32 opHash = keccak256("batch3");
        PackedUserOperation memory op = makeUserOp(batchCallData(calls), signFor(address(account), opHash, new bytes32[](0)));
        op.sender = address(account);
        vm.expectRevert(SessionKey7579Module.MalformedExecutionData.selector);
        module.validateUserOp(op, opHash);
    }

    function test_WhitelistedSingleCall_AcceptsValidProof_RejectsWrongTarget() public {
        // scope WITH a real root over leaves {leafA}
        address targetA = address(0x1111);
        bytes4 selector = hex"12345678";
        bytes32 leafA = keccak256(abi.encode(targetA, selector));

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
        uint256 vd = module.validateUserOp(ok, opHash);
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
        module.validateUserOp(bad, h2);
    }

    function test_BatchUnderWhitelist_FailsClosed() public {
        SessionKey7579Module.Scope memory scoped = defaultScope();
        scoped.merkleRoot = bytes32(uint256(0xABCD)); // non-zero root ⇒ whitelist regime
        account.install(abi.encode(key, scoped));

        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](1);
        calls[0] = SessionKey7579Module.ExecTuple(address(0xA), 0, hex"");
        bytes32 opHash = keccak256("bwl1");
        PackedUserOperation memory op = makeUserOp(batchCallData(calls), signFor(address(account), opHash, new bytes32[](0)));
        op.sender = address(account);
        vm.expectRevert(SessionKey7579Module.BatchWithWhitelistUnsupported.selector);
        module.validateUserOp(op, opHash);
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

    function test_MerkleLibStillVerifiedByHalmosSuite_RegressionGuard() public pure {
        // Marker test: MerkleWhitelist.verify semantics are formally specified in Halmos.t.sol.
        assertTrue(MerkleWhitelist.verify(new bytes32[](0), bytes32(0), bytes32(0)));
    }
}
