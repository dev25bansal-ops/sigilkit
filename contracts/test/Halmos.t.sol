// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";
import {MerkleWhitelist} from "../src/MerkleWhitelist.sol";

/// @dev Wrapper holding a real WindowState in storage so SpendPolicy.enforce (storage
///      pointer param) can run, letting specs distinguish "reverted" from "returned".
contract SpendPolicyHarness {
    SpendPolicy.WindowState public window;

    function setWindow(uint48 windowStart, uint256 spentThisWindow) external {
        window.windowStart = windowStart;
        window.spentThisWindow = spentThisWindow;
    }

    function enforce(
        uint256 value,
        uint256 perActionCap,
        uint256 perWindowCap,
        uint48 windowSeconds
    ) external returns (uint256 spentAfter) {
        // Harness identity placeholders — the specs assert window math, not attribution.
        SpendPolicy.enforce(window, address(this), address(0), value, perActionCap, perWindowCap, windowSeconds);
        return window.spentThisWindow;
    }
}

/// @title HalmosTest — symbolic specs for the spend-cap core (INV-1) and Merkle boundary.
/// @notice Run: halmos --match-contract HalmosTest
/// @dev block.timestamp is a fresh symbolic in Halmos; keccak is uninterpreted, so specs
///      only assert equality/computation properties (never keccak inequality).
contract HalmosTest is Test {
    SpendPolicyHarness internal harness;

    function setUp() public {
        harness = new SpendPolicyHarness();
    }

    // ------------------------------------------------------------------
    // INV-1 core: the cap math
    // ------------------------------------------------------------------
    function checkRolled(SpendPolicy.WindowState memory w, uint48 windowSeconds)
        internal
        view
        returns (bool)
    {
        // Symbolic mirror of SpendPolicy's window-rollover predicate — time-based by design,
        // so `block.timestamp` is the modelled clock rather than a manipulable input.
        // forge-lint: disable-next-line(block-timestamp)
        return w.windowStart == 0 || block.timestamp >= uint256(w.windowStart) + windowSeconds;
    }

    /// @dev Whenever enforce succeeds (no rollover), the recorded window spend is exactly
    ///      prior spend + value — and therefore within the cap (it reverts otherwise).
    function check_enforce_RecordsExactSpend_WhenWithinWindowCap(
        SpendPolicy.WindowState memory w,
        uint256 value,
        uint256 perActionCap,
        uint256 perWindowCap,
        uint48 windowSeconds
    ) public {
        vm.assume(perActionCap > 0);
        vm.assume(value <= perActionCap);
        // Bound the domain to keep spent+value overflow-free and meaningful.
        vm.assume(w.spentThisWindow <= perWindowCap);
        vm.assume(perWindowCap < 2 ** 200);
        vm.assume(value <= perWindowCap);
        vm.assume(w.spentThisWindow + value <= perWindowCap); // the "within cap" regime
        vm.assume(!checkRolled(w, windowSeconds));

        harness.setWindow(w.windowStart, w.spentThisWindow);
        (bool ok, bytes memory ret) = address(harness).call(
            abi.encodeCall(
                SpendPolicyHarness.enforce,
                (value, perActionCap, perWindowCap, windowSeconds)
            )
        );
        assertTrue(ok, "should succeed when spend stays within cap");
        assertEq(abi.decode(ret, (uint256)), w.spentThisWindow + value, "exact spend recorded");
    }

    /// @dev If the new cumulative spend would exceed the window cap, enforce ALWAYS reverts.
    function check_enforce_Reverts_WhenOverWindowCap(
        SpendPolicy.WindowState memory w,
        uint256 value,
        uint256 perActionCap,
        uint256 perWindowCap,
        uint48 windowSeconds
    ) public {
        vm.assume(perActionCap > 0);
        vm.assume(value <= perActionCap);
        vm.assume(w.spentThisWindow <= perWindowCap);
        vm.assume(perWindowCap < 2 ** 200);
        vm.assume(value <= perWindowCap);
        vm.assume(w.spentThisWindow + value > perWindowCap); // the violating regime
        vm.assume(!checkRolled(w, windowSeconds));

        harness.setWindow(w.windowStart, w.spentThisWindow);
        (bool ok,) = address(harness).call(
            abi.encodeCall(
                SpendPolicyHarness.enforce,
                (value, perActionCap, perWindowCap, windowSeconds)
            )
        );
        assertFalse(ok, "over-cap spend must revert (INV-1)");
    }

    /// @dev A rolled window starts from zero: stale spend from a previous window can never
    ///      poison the new one, even if it exceeded the cap.
    function check_enforce_WindowRollover_ResetsPriorSpend(
        SpendPolicy.WindowState memory w,
        uint256 value,
        uint256 perActionCap,
        uint256 perWindowCap,
        uint48 windowSeconds
    ) public {
        vm.assume(perActionCap > 0);
        vm.assume(value <= perActionCap);
        vm.assume(w.windowStart != 0);
        // Symbolic precondition: model the window as already rolled. Time-based by design.
        // forge-lint: disable-next-line(block-timestamp)
        vm.assume(block.timestamp >= uint256(w.windowStart) + windowSeconds); // rolled
        vm.assume(w.spentThisWindow > perWindowCap); // stale window is "poisoned"
        vm.assume(perWindowCap < 2 ** 200);
        vm.assume(value <= perWindowCap);

        harness.setWindow(w.windowStart, w.spentThisWindow);
        (bool ok, bytes memory ret) = address(harness).call(
            abi.encodeCall(
                SpendPolicyHarness.enforce,
                (value, perActionCap, perWindowCap, windowSeconds)
            )
        );
        assertTrue(ok, "rolled window must start clean");
        assertEq(abi.decode(ret, (uint256)), value, "fresh window counts only this action");
    }

    /// @dev The per-action cap reverts regardless of window state.
    function check_enforce_Reverts_WhenOverPerActionCap(
        SpendPolicy.WindowState memory w,
        uint256 value,
        uint256 perActionCap,
        uint256 perWindowCap,
        uint48 windowSeconds
    ) public {
        vm.assume(perActionCap > 0);
        vm.assume(value > perActionCap);
        vm.assume(perWindowCap < 2 ** 200);
        vm.assume(value <= perWindowCap); // isolate the per-action cap as the trigger

        harness.setWindow(w.windowStart, w.spentThisWindow);
        (bool ok,) = address(harness).call(
            abi.encodeCall(
                SpendPolicyHarness.enforce,
                (value, perActionCap, perWindowCap, windowSeconds)
            )
        );
        assertFalse(ok, "over-action-cap spend must revert");
    }

    // ------------------------------------------------------------------
    // Merkle boundary behavior
    // ------------------------------------------------------------------
    /// @dev With an empty proof, verification reduces to identity: leaf == root.
    function check_merkle_EmptyProof_IsIdentity(bytes32 leaf, bytes32 root) public pure {
        bytes32[] memory noProof = new bytes32[](0);
        bool result = MerkleWhitelist.verify(noProof, root, leaf);
        assertTrue(result == (leaf == root), "empty-proof verification must be identity");
    }

    /// @dev A one-level proof recomputes the root exactly (sorted-pair hashing).
    function check_merkle_SingleLevel_ProofCompleteness(bytes32 leaf, bytes32 sibling)
        public
        pure
    {
        vm.assume(leaf != sibling);
        // Build the root the same way an indexer would: hash the pair in SORTED order.
        bytes32 root = leaf < sibling
            ? keccak256(abi.encodePacked(leaf, sibling))
            : keccak256(abi.encodePacked(sibling, leaf));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        assertTrue(MerkleWhitelist.verify(proof, root, leaf), "valid proof must verify");
    }
}
