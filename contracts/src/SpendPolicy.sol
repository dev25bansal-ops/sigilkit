// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title SpendPolicy
/// @notice On-chain per-action and rolling-window spend caps for agent session keys.
/// @dev INV-1: the sum of values transferred out via executeWithSessionKey within any window of
///      duration `windowSeconds` never exceeds `perWindowCap`.
///      All state updates here are EFFECTS: callers must invoke `enforce` before any external
///      interaction (Checks-Effects-Interactions).
library SpendPolicy {
    struct WindowState {
        // Start timestamp of the current rolling window. 0 = no window opened yet.
        uint48 windowStart;
        // Total value spent within the current window.
        uint256 spentThisWindow;
    }

    error PerActionCapExceeded(uint256 value, uint256 cap);
    error PerWindowCapExceeded(uint256 projectedWindowSpend, uint256 cap);

    /// @notice Checks `value` against the per-action cap and the rolling-window cap, then records
    ///         the spend against the window.
    /// @param window Storage slot holding the caller's rolling-window state.
    /// @param value Native value about to be transferred by the pending inner call.
    /// @param perActionCap Maximum value allowed for a single action.
    /// @param perWindowCap Maximum cumulative value allowed per rolling window.
    /// @param windowSeconds Length of the rolling window in seconds.
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
