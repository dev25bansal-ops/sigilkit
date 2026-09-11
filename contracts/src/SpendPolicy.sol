// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title SpendPolicy
/// @notice On-chain per-action and fixed-window (tumbling) spend caps for agent session keys.
/// @dev INV-1 (tumbling window): the sum of values transferred out via executeWithSessionKey
///      within any single window of duration `windowSeconds` never exceeds `perWindowCap`.
///      The window is FIXED, not sliding: once fully elapsed it resets to zero, so a spender
///      acting at the boundary can spend up to perWindowCap in the closing seconds of window N
///      and up to perWindowCap again immediately after rollover — at most ~2× perWindowCap
///      within any sliding window of the same length. Integrators needing smooth budgeting
///      should size windows so that a 2× boundary burst is acceptable.
///      All state updates here are EFFECTS: callers must invoke `enforce` before any external
///      interaction (Checks-Effects-Interactions).
library SpendPolicy {
    struct WindowState {
        // Start timestamp of the current fixed (tumbling) window. 0 = none opened yet.
        uint48 windowStart;
        // Total value spent within the current window.
        uint256 spentThisWindow;
    }

    error PerActionCapExceeded(uint256 value, uint256 cap);
    error PerWindowCapExceeded(uint256 projectedWindowSpend, uint256 cap);

    /// @notice Checks `value` against the per-action cap and the fixed-window cap, then records
    ///         the spend against the window.
    /// @param window Storage slot holding the caller's fixed-window state.
    /// @param value Native value about to be transferred by the pending inner call.
    /// @param perActionCap Maximum value allowed for a single action.
    /// @param perWindowCap Maximum cumulative value allowed per fixed window.
    /// @param windowSeconds Length of the fixed window in seconds.
    function enforce(
        WindowState storage window,
        uint256 value,
        uint256 perActionCap,
        uint256 perWindowCap,
        uint48 windowSeconds
    ) internal {
        // --- Checks ---
        if (value > perActionCap) revert PerActionCapExceeded(value, perActionCap);

        uint48 start = window.windowStart;
        uint256 spent = window.spentThisWindow;

        // Roll the window forward once it has fully elapsed.
        if (start == 0 || block.timestamp >= uint256(start) + windowSeconds) {
            start = uint48(block.timestamp);
            spent = 0;
        }

        uint256 projected = spent + value;
        if (projected > perWindowCap) revert PerWindowCapExceeded(projected, perWindowCap);

        // --- Effects (before any interaction) ---
        window.windowStart = start;
        window.spentThisWindow = projected;
    }
}
