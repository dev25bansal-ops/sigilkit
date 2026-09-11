// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @title GovernanceRecovery — covers the S5/S6 fixes from the issues catalog:
///         reinstatement of a revoked key is an observable event, and the owner has a
///         sanctioned treasury-recovery path that session keys can never reach.
contract GovernanceRecoveryTest is Test {
    SessionKeyManager internal skm;

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xB0B;
    address internal agent = vm.addr(AGENT_KEY);

    function setUp() public {
        skm = new SessionKeyManager(vm.addr(OWNER_KEY));
        vm.deal(address(skm), 10 ether);
    }

    function _grant() internal {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(
            agent,
            SessionKeyManager.Scope({
                expiresAt: uint48(block.timestamp + 1 days),
                windowSeconds: 1 hours,
                perActionCap: 0.5 ether,
                perWindowCap: 1 ether,
                merkleRoot: bytes32(0)
            })
        );
    }

    // S5: revocation → fresh grant of the same address emits SessionKeyReinstated.
    function test_RevokeThenRegrant_EmitsReinstated() public {
        _grant();
        vm.prank(vm.addr(OWNER_KEY));
        skm.revokeSessionKey(agent);
        assertTrue(skm.isRevoked(agent));

        vm.expectEmit(true, true, true, true, address(skm));
        emit SessionKeyManager.SessionKeyReinstated(agent);
        _grant();
        assertFalse(skm.isRevoked(agent), "regrant must reinstate (documented semantics)");
    }

    // S5: a plain first grant must NOT emit Reinstated.
    function test_FirstGrant_DoesNotEmitReinstated() public {
        vm.recordLogs();
        _grant();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertFalse(
                logs[i].topics[0]
                    == keccak256("SessionKeyReinstated(address)"),
                "first grant must not emit SessionKeyReinstated"
            );
        }
    }

    // S6: owner recovery path exists and works.
    function test_Withdraw_OwnerCanRecoverFunds() public {
        address payable treasury = payable(makeAddr("treasury"));
        uint256 before = treasury.balance;
        vm.prank(vm.addr(OWNER_KEY));
        skm.withdraw(treasury, 3 ether);
        assertEq(treasury.balance, before + 3 ether);
    }

    // S6: non-owners cannot withdraw (onlyOwner) — and session keys are additionally
    // blocked by the default denylist (defense in depth, INV-4).
    function test_Withdraw_RevertsForNonOwner() public {
        vm.prank(agent);
        vm.expectRevert(SessionKeyManager.NotOwner.selector);
        skm.withdraw(payable(agent), 1 ether);
        assertTrue(skm.isSelectorDenied(skm.withdraw.selector), "withdraw must be denylisted");
    }

    // S6: a session key with an allow-all scope still cannot reach withdraw through
    // executeWithSessionKey (denylisted selector on any target).
    function test_Withdraw_UnreachableViaSessionKey() public {
        _grant();
        SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
            agentId: keccak256("agent-1"),
            target: address(skm),
            selector: skm.withdraw.selector,
            value: 0,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("attempt"),
            data: abi.encode(agent, 1 ether)
        });
        bytes32 ds = skm.DOMAIN_SEPARATOR();
        bytes32 structHash = keccak256(
            abi.encode(
                skm.ACTION_REQUEST_TYPEHASH(),
                req.agentId,
                req.target,
                req.selector,
                req.value,
                req.nonce,
                req.expiry,
                req.rationaleHash,
                keccak256(req.data)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ds, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, digest);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyManager.SelectorDenied.selector, skm.withdraw.selector));
        skm.executeWithSessionKey(req, abi.encodePacked(r, s, v), new bytes32[](0));
    }
}
