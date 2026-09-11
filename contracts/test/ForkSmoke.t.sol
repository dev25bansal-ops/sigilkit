// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @title ForkSmoke — smoke test against a live Base fork.
/// @notice Requires an RPC: run with
///         `forge test --match-contract ForkSmoke --fork-url $RPC_BASE`
///         (CI: nightly `forge-fork-base` job). Assertions are fork-specific BY
///         DESIGN: on a local non-Base chain this test fails — that is the point.
///         Exclude it from local/plain runs with --no-match-contract '.*Fork'.
contract ForkSmokeTest is Test {
    SessionKeyManager internal skm;
    address internal expectedOwner;

    /// @notice Canonical Multicall3 deployment — same deterministic address on Base
    ///         and virtually every EVM chain; its presence proves live-forked state.
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    function setUp() public {
        expectedOwner = vm.addr(0xA11CE);
        skm = new SessionKeyManager(expectedOwner);
    }

    /// @dev Deploys against forked Base state and asserts the chain-specific behaviors
    ///      a fork test exists for: the chain id, the chain-bound EIP-712 domain
    ///      separator, and real live network state.
    function test_Fork_BaseChainBindingAndLiveState() public view {
        assertEq(skm.owner(), expectedOwner, "owner mismatch");

        // The fork actually forked Base mainnet.
        assertEq(block.chainid, 8453, "not a Base mainnet fork");

        // DOMAIN_SEPARATOR must incorporate the forked chain id: derive the expected
        // value locally and compare — the chain binding is the fork-specific behavior.
        bytes32 expectedDs = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("SigilKit"),
                keccak256("1"),
                block.chainid,
                address(skm)
            )
        );
        assertEq(skm.DOMAIN_SEPARATOR(), expectedDs, "domain separator not chain-bound");

        // Live Base state: the canonical Multicall3 deployment must exist there.
        assertTrue(MULTICALL3.code.length > 0, "Multicall3 missing on forked chain");
    }
}
