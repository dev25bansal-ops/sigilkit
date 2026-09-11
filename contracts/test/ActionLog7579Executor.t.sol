// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ActionLog7579Executor} from "../src/ActionLog7579Executor.sol";
import {ActionLogger} from "../src/ActionLogger.sol";

contract Counter {
    uint256 public count;
    event Poked(address caller, uint256 value);

    function poke(uint256 by) external payable returns (uint256) {
        count += by;
        emit Poked(msg.sender, msg.value);
        return count;
    }
}

contract BrokenTarget {
    function boom() external pure {
        revert("no");
    }
}

/// @dev Stand-in for a 7579 smart account: it installs/uses the executor in its own
///      context (msg.sender == account on every module call).
contract ExecutorUser {
    function install(ActionLog7579Executor ex, bytes memory data) external {
        ex.onInstall(data);
    }

    function setAgent(ActionLog7579Executor ex, bytes32 agentId) external {
        ex.setAgentId(agentId);
    }

    function run(ActionLog7579Executor ex, address target, uint256 value, bytes calldata cd)
        external
        payable
        returns (bytes memory)
    {
        return ex.execute{value: value}(address(this), target, value, cd);
    }
}

contract ActionLog7579ExecutorTest is Test {
    ActionLog7579Executor internal executor;
    Counter internal counter;
    BrokenTarget internal broken;
    ExecutorUser internal user;

    bytes32 internal constant AGENT_ID = keccak256("agent-777");

    function setUp() public {
        executor = new ActionLog7579Executor();
        counter = new Counter();
        broken = new BrokenTarget();
        user = new ExecutorUser();
        vm.deal(address(user), 10 ether);
    }

    function test_Install_BindsAgentId() public {
        user.install(executor, abi.encode(AGENT_ID));
        assertEq(executor.agentId(address(user)), AGENT_ID);
    }

    function test_IsModuleType6() public view {
        assertTrue(executor.isModuleType(6));
        assertFalse(executor.isModuleType(1));
    }

    function test_Execute_ForwardsCall_EmitsActionLogged() public {
        user.install(executor, abi.encode(AGENT_ID));

        vm.expectEmit(true, true, true, true, address(executor));
        emit ActionLogger.ActionLogged(
            AGENT_ID, address(counter), counter.poke.selector, 0.01 ether, bytes32(0), uint48(block.timestamp)
        );
        bytes memory ret = user.run(
            executor, address(counter), 0.01 ether, abi.encodeWithSelector(counter.poke.selector, uint256(7))
        );
        assertEq(abi.decode(ret, (uint256)), 7);
        assertEq(counter.count(), 7);
        assertEq(address(counter).balance, 0.01 ether);
    }

    function test_Execute_RevertsForNonAccount() public {
        // Direct call that is NOT from the account context: first param names `user`
        // but msg.sender is this test contract.
        vm.expectRevert(ActionLog7579Executor.NotAccount.selector);
        executor.execute(address(user), address(counter), 0, abi.encodeWithSelector(counter.poke.selector, 1));
    }

    function test_Execute_RevertsWhenNoAgentIdBound() public {
        user.install(executor, hex""); // install without attribution
        vm.expectRevert(ActionLog7579Executor.EmptyAgentId.selector);
        user.run(executor, address(counter), 0, abi.encodeWithSelector(counter.poke.selector, 1));
    }

    function test_Execute_RevertsWhenInnerCallFails_NoAudit() public {
        user.install(executor, abi.encode(AGENT_ID));

        // Negative INV-3: a failed inner call produces NO ActionLogged and reverts.
        vm.recordLogs();
        vm.expectRevert(ActionLog7579Executor.ExecutionFailed.selector);
        user.run(executor, address(broken), 0, abi.encodeWithSelector(BrokenTarget.boom.selector));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertFalse(
                logs[i].topics[0] == keccak256(
                    "ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)"
                ),
                "audit event must not fire on failed execution"
            );
        }
    }

    function test_Execute_ReentrantCallRejected() public {
        ReentrantUser r = new ReentrantUser(executor);
        vm.deal(address(r), 1 ether);
        r.install();
        // The reentrant target is the account itself: r.poke re-enters execute().
        vm.expectRevert(ActionLog7579Executor.ExecutionFailed.selector);
        r.run(address(r), 0, abi.encodeWithSelector(ReentrantUser.poke.selector, 1));
    }
}

/// @dev Account whose target call re-enters the executor — the lock must reject it.
contract ReentrantUser {
    ActionLog7579Executor internal executor;

    constructor(ActionLog7579Executor ex) {
        executor = ex;
    }

    function install() external {
        executor.onInstall(abi.encode(keccak256("reentrant")));
    }

    function run(address target, uint256 value, bytes calldata cd) external returns (bytes memory) {
        return executor.execute(address(this), target, value, cd);
    }

    function poke(uint256) external payable {
        // Re-enter the executor from inside the inner call.
        this.run(address(0xdeadbeef), 0, hex"");
    }
}
