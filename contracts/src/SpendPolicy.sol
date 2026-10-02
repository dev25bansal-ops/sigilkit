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
///
/// @dev INV-1 scope: the cap is PER KEY, not per owner and not per key-lineage. Window state
///      is keyed by the session key that spent, and NOTHING else consolidates it. Two
///      consequences, both intended (owner-ruled, resolving SEC-10):
///
///      1. **A rotation starts the new key on a fresh window.** `SessionKeyManager`'s
///         `windows` is a per-key mapping, and its grant/rotate path deliberately does not
///         carry a window across a rotation: the successor key's slot has never been used,
///         so its window opens at zero. `perWindowCap` therefore bounds a SINGLE KEY's
///         rate — it is not an aggregate ceiling on how fast an owner may rotate.
///
///      2. **A re-grant over the SAME key preserves that key's window.** The window lives
///         outside the scope record, so replacing a scope does not clear it. This is the
///         deliberate asymmetry with (1): rotation moves to a different key, re-grant does
///         not.
///
///      **Why this is not an agent-reachable bypass.** Both `grantSessionKey` and
///      `rotateSessionKey` are `onlyOwner`, so an agent CANNOT rotate or re-grant itself out
///      of an exhausted window — there is no path from inside the trust boundary to a fresh
///      budget. What a rotation resets is the OWNER's own bookkeeping, and the owner is the
///      same party that chose the cap and the rotation cadence. The security boundary is
///      intact; the risk is a CONFIGURATION one: an owner who rotates on a schedule faster
///      than `windowSeconds` will authorise a higher aggregate rate than a single key's
///      `perWindowCap` suggests. Owners wanting a hard aggregate ceiling must either set
///      `windowSeconds` comfortably above their rotation cadence, or not rotate.
///
///      @dev All state updates here are EFFECTS: callers must invoke `enforce` before any
///      external interaction (Checks-Effects-Interactions).
library SpendPolicy {
    struct WindowState {
        // Start timestamp of the current fixed (tumbling) window. 0 = none opened yet.
        uint48 windowStart;
        // Total value spent within the current window.
        uint256 spentThisWindow;
    }

    error PerActionCapExceeded(uint256 value, uint256 cap);
    error PerWindowCapExceeded(uint256 projectedWindowSpend, uint256 cap);

    /// @notice Emitted on every successful window charge — the off-chain mirror of the
    ///         window accounting (enhancement E1). Pairs with ActionLogged: for value=0
    ///         actions and for the 7579 validator path (which emits no ActionLogged),
    ///         this is the observable spend signal for reconciliation/indexing.
    event WindowCharged(
        address indexed account,
        address indexed key,
        uint256 value,
        uint48 windowStart,
        uint256 spentThisWindow
    );

    /// @notice Checks `value` against the per-action cap and the fixed-window cap, then records
    ///         the spend against the window.
    /// @dev The batch path (SessionKey7579Module._enforceBatch) calls this ONCE for the
    ///      batch total with `perActionCap = type(uint256).max`, having already checked each
    ///      tuple individually — so this function must never be the only per-action check
    ///      on a path. A future caller that passes the aggregate as a single `value` with a
    ///      real cap would silently get different semantics.
    /// @param window Storage slot holding the caller's fixed-window state.
    /// @param account The wallet whose funds are being spent (the manager, or the smart
    ///        account on the 7579 path) — indexed identity for WindowCharged.
    /// @param key The session key charged for this action.
    /// @param value Native value about to be transferred by the pending inner call.
    /// @param perActionCap Maximum value allowed for a single action.
    /// @param perWindowCap Maximum cumulative value allowed per fixed window.
    /// @param windowSeconds Length of the fixed window in seconds.
    function enforce(
        WindowState storage window,
        address account,
        address key,
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
        // A fixed (tumbling) window is time-based by design, so `block.timestamp` is the
        // correct clock here. A validator can nudge it by seconds, which shifts a window
        // boundary — it cannot push the summed spend past `perWindowCap`, because the
        // projection below is still capped inside whichever window is in effect.
        // forge-lint: disable-next-line(block-timestamp)
        if (start == 0 || block.timestamp >= uint256(start) + windowSeconds) {
            start = uint48(block.timestamp);
            spent = 0;
        }

        uint256 projected = spent + value;
        if (projected > perWindowCap) revert PerWindowCapExceeded(projected, perWindowCap);

        // --- Effects (before any interaction) ---
        window.windowStart = start;
        window.spentThisWindow = projected;

        emit WindowCharged(account, key, value, start, projected);
    }
}
