// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKey7579Module, PackedUserOperation} from "../src/SessionKey7579Module.sol";

/// @dev A minimal 7579-style smart account whose execute() decodes EXACTLY the
///      callData convention the module validates (callType byte at offset 0, payload
///      at [32:]), plus a validateAndExecute() entry point that runs validation in the
///      account's own context and then executes what was validated. This closes the
///      testing gap from the issues catalog (A5): until now, no test ever executed the
///      ExecTuple payloads the module accepts, so the callData-convention consistency
///      between the validator and a real account was unproven.
contract Account7579 {
    error ExecutionFailed();
    error UnsupportedCallType(bytes1 callType);

    SessionKey7579Module public module;

    constructor(SessionKey7579Module module_) {
        module = module_;
    }

    function install(bytes memory data) external {
        module.onInstall(data);
    }

    function uninstall() external {
        module.onUninstall("");
    }

    /// @notice Real accounts run validation modules in their own context, so the
    ///         account itself must be msg.sender for validateUserOp.
    function validate(PackedUserOperation memory op, bytes32 hash) external returns (uint256) {
        return module.validateUserOp(op, hash);
    }

    /// @notice Validate the userOp in the account's context, then execute its payload
    ///         through the account's own 7579 routing (same convention the validator
    ///         parsed). The account funds the executions.
    function validateAndExecute(PackedUserOperation memory op, bytes32 hash)
        external
        payable
        returns (uint256 validationData)
    {
        validationData = module.validateUserOp(op, hash);
        _executeBy7579Convention(op.callData);
    }

    /// @notice The account's own ERC-7579 execute() routing: decodes the same
    ///         callType || payload convention the module parses at validation.
    function execute(bytes calldata callData) external payable {
        _executeBy7579Convention(callData);
    }

    function _executeBy7579Convention(bytes memory cd) internal {
        if (cd.length < 32) revert ExecutionFailed();
        bytes1 callType = cd[0];
        bytes memory payload = _slice(cd, 32);
        if (callType == 0x00) {
            SessionKey7579Module.ExecTuple memory single = abi.decode(payload, (SessionKey7579Module.ExecTuple));
            (bool ok,) = single.target.call{value: single.value}(single.data);
            if (!ok) revert ExecutionFailed();
        } else if (callType == 0x01) {
            SessionKey7579Module.ExecTuple[] memory batch =
                abi.decode(payload, (SessionKey7579Module.ExecTuple[]));
            for (uint256 i = 0; i < batch.length; ++i) {
                (bool ok,) = batch[i].target.call{value: batch[i].value}(batch[i].data);
                if (!ok) revert ExecutionFailed();
            }
        } else {
            revert UnsupportedCallType(callType);
        }
    }

    /// @dev Memory arrays don't support range slicing; copy the payload out.
    function _slice(bytes memory b, uint256 from) private pure returns (bytes memory out) {
        out = new bytes(b.length - from);
        for (uint256 i = 0; i < out.length; ++i) {
            out[i] = b[from + i];
        }
    }

    receive() external payable {}
}

contract PayableCounter {
    uint256 public total;
    mapping(address => uint256) public bySender;

    function poke(uint256 by) external payable returns (uint256) {
        total += by;
        bySender[msg.sender] += by;
        return total;
    }

    receive() external payable {}
}

contract Module7579AccountE2ETest is Test {
    SessionKey7579Module internal module;
    Account7579 internal account;
    PayableCounter internal counter;

    uint256 internal constant KEY_PK = 0xC0FFEE;
    address internal key;

    uint48 internal constant EXPIRES_AT = 1_900_000_000;
    uint48 internal constant WINDOW_SECONDS = 600;

    function setUp() public {
        vm.warp(1_700_000_000);
        module = new SessionKey7579Module();
        account = new Account7579(module);
        counter = new PayableCounter();
        key = vm.addr(KEY_PK);

        account.install(
            abi.encode(
                key,
                SessionKey7579Module.Scope({
                    expiresAt: EXPIRES_AT,
                    windowSeconds: WINDOW_SECONDS,
                    perActionCap: 0.5 ether,
                    perWindowCap: 1 ether,
                    merkleRoot: bytes32(0)
                })
            )
        );
        vm.deal(address(account), 10 ether);
    }

    // ------------------------------------------------------------------
    // Helpers (same convention as SessionKey7579Module.t.sol)
    // ------------------------------------------------------------------
    function singleCallData(address target, uint256 value, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            bytes32(uint256(0x00)),
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

    function signFor(address acct, bytes32 userOpHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY_PK, digestFor(acct, userOpHash));
        return abi.encodePacked(r, s, v);
    }

    function makeUserOp(bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = PackedUserOperation({
            sender: address(0),
            nonce: 0,
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32(0),
            preVerificationGas: 0,
            gasFees: bytes32(0),
            paymasterAndData: "",
            signature: new bytes(0)
        });
        op.sender = address(account);
        op.signature = signFor(address(account), keccak256(op.callData));
    }

    // ------------------------------------------------------------------
    // The E2E: validate → execute → state landed, window charged once
    // ------------------------------------------------------------------
    function test_ValidateThenExecute_SingleCall_LandsValueAndChargesWindowOnce() public {
        PackedUserOperation memory op = makeUserOp(
            singleCallData(address(counter), 0.3 ether, abi.encodeWithSelector(counter.poke.selector, uint256(3)))
        );
        bytes32 opHash = keccak256(op.callData);

        uint256 vd = account.validateAndExecute(op, opHash);
        assertEq(vd, uint256(EXPIRES_AT) << 160, "validation data should bind scope expiry");

        // The execution actually LANDED (previously never proven).
        assertEq(counter.total(), 3);
        assertEq(counter.bySender(address(account)), 3);
        assertEq(address(counter).balance, 0.3 ether);

        // …and the window was charged EXACTLY once for the 0.3 ETH.
        (, uint256 spent) = module.getWindowState(address(account), key);
        assertEq(spent, 0.3 ether);
    }

    function test_ValidateThenExecute_Batch_AllTuplesLand_WindowChargedOnce() public {
        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](2);
        calls[0] = SessionKey7579Module.ExecTuple(address(counter), 0.2 ether, abi.encodeWithSelector(counter.poke.selector, uint256(1)));
        calls[1] = SessionKey7579Module.ExecTuple(address(counter), 0.2 ether, abi.encodeWithSelector(counter.poke.selector, uint256(1)));
        PackedUserOperation memory op = makeUserOp(batchCallData(calls));
        bytes32 opHash = keccak256(op.callData);

        account.validateAndExecute(op, opHash);

        assertEq(counter.total(), 2);
        assertEq(address(counter).balance, 0.4 ether);
        (, uint256 spent) = module.getWindowState(address(account), key);
        assertEq(spent, 0.4 ether, "batch must charge the window once for the total");
    }

    function test_CapEnforcedAcrossExecutedOps() public {
        // 3 × 0.3 ETH executed within the 1 ETH window; the 4th validates against a
        // 1.2 ETH total and reverts at validation (before any execution).
        for (uint256 i = 0; i < 3; ++i) {
            PackedUserOperation memory op =
                makeUserOp(singleCallData(address(counter), 0.3 ether, abi.encodeWithSelector(counter.poke.selector, uint256(1))));
            account.validateAndExecute(op, keccak256(op.callData));
        }
        (, uint256 spent) = module.getWindowState(address(account), key);
        assertEq(spent, 0.9 ether);
        assertEq(counter.total(), 3);

        PackedUserOperation memory over =
            makeUserOp(singleCallData(address(counter), 0.3 ether, abi.encodeWithSelector(counter.poke.selector, uint256(1))));
        vm.expectRevert(); // PerWindowCapExceeded via SpendPolicy
        account.validateAndExecute(over, keccak256(over.callData));
        // Nothing landed, nothing was charged by the reverted op.
        (, spent) = module.getWindowState(address(account), key);
        assertEq(spent, 0.9 ether);
        assertEq(counter.total(), 3);
    }

    function test_AccountRoutingRejectsUnsupportedCallType() public {
        // The account's own execute() must decode the same convention — an unknown
        // callType is rejected by the account's routing, mirroring the validator.
        bytes memory bogus = abi.encodePacked(bytes32(uint256(0x02 << 248)), abi.encode("x"));
        vm.expectRevert(); // UnsupportedCallType via account routing
        account.execute(bogus);
    }
}
