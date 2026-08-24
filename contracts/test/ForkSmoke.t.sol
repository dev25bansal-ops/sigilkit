// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @title ForkSmoke — minimal smoke test against a live network fork.
/// @notice Requires an RPC: run with
///         `forge test --match-contract ForkSmoke --fork-url $RPC_BASE`
///         (CI: nightly `forge-fork-base` job). Not runnable without --fork-url;
///         CI is the gate, there is no local skip path by design.
contract ForkSmokeTest is Test {
    SessionKeyManager internal skm;
    address internal expectedOwner;

    function setUp() public {
        expectedOwner = vm.addr(0xA11CE);
        skm = new SessionKeyManager(expectedOwner);
    }

    /// @dev Deploys against forked state and checks core invariants of construction:
    ///      ownership recorded and EIP-712 domain separator derived (chainid-dependent,
    ///      so exercising it under a real chain id is meaningful).
    function test_Fork_DomainSeparatorAndOwner() public view {
        assertEq(skm.owner(), expectedOwner, "owner mismatch");
        assertNotEq(skm.DOMAIN_SEPARATOR(), bytes32(0), "empty DOMAIN_SEPARATOR");
    }
}
