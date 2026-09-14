// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @title ForkSmoke — smoke test against a live Base fork.
/// @notice Run with `forge test --match-contract ForkSmoke --fork-url $RPC_BASE`
///         (CI: nightly `forge-fork-base` job). On a non-Base chain the test
///         SKIPS cleanly (visible, not a failure), so a plain `forge test` stays
///         green locally. The fork-specific assertions (chain id, chain-bound
///         EIP-712 domain, live Base state) still run in full against a real fork.
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
    ///
    ///      On a non-Base chain (i.e. a plain `forge test` without --fork-url) this
    ///      test SKIPS cleanly rather than failing, so a plain local run is green and
    ///      the skip is visible. The fork-specific assertions below still run in full
    ///      on the nightly Base fork (CI `forge-fork-base` job).
    function test_Fork_BaseChainBindingAndLiveState() public {
        if (block.chainid != 8453) {
            vm.skip(
                true,
                "not a Base mainnet fork (chainid != 8453); run: forge test --match-contract ForkSmoke --fork-url $RPC_BASE"
            );
        }

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
