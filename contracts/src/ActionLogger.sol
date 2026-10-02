// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title ActionLogger
/// @notice Mandatory on-chain audit trail for agent-driven actions.
/// @dev INV-3: the ActionLogged event is emitted if and only if the inner call succeeded.
///      No execution path may produce a state change without a corresponding audit event.
///      Only the keccak256 hash of the agent's rationale is stored on-chain (INV: information
///      disclosure) — plaintext rationale stays off-chain with the operator.
///
/// @dev CONSUMER CONTRACT (EVT-1) — this declaration is ABI-FROZEN, not merely stable.
///      Four independent consumers bind to its exact shape:
///
///      1. `packages/core/src/client.ts` computes
///         `keccak256("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)")`
///         at module load and additionally filters on `topics.length !== 4`. BOTH the
///         signature string and the topic COUNT are hardcoded: adding, removing or
///         reordering a parameter, or flipping any `indexed` flag, changes topic0 and/or
///         the topic count and makes the SDK silently skip every historical log — a
///         total, silent audit blackout rather than a decode error.
///      2. The indexer (`packages/indexer/src/indexer.ts`) decodes through
///         `ACTION_LOGGER_ABI` and stores a fixed 11-column row keyed by
///         (chain_id, tx_hash, log_index).
///      3. `abi-drift.test.ts` fails CI on any drift against the committed
///         `packages/core/abis/ActionLogger.json` (and against the copies inherited by
///         SessionKeyManager / SigilKitDelegator / ActionLog7579Executor).
///      4. `contracts/test/ActionLog7579Executor.t.sol` asserts the topic0 string
///         literally when proving INV-3 (a failed inner call emits no audit event).
///
///      A change therefore requires, in lockstep: a new event name, a regenerated
///      `abis/*.json` for all four inheriting contracts, a bumped `ACTION_LOGGED_TOPIC`,
///      and an updated `topics.length` guard. Evolve the schema by ADDING a new event,
///      never by reshaping this one.
///
/// @dev What this event deliberately does NOT carry (EVT-2). An indexer can reconstruct
///      "agent X told contract Y to run selector Z for value V at time T", but NOT the
///      surrounding authorization:
///
///      - `initiator` / `msg.sender` — absent. On the SessionKeyManager path the
///        relayer is permissionless, so the tx origin is NOT the actor; on the
///        ActionLog7579Executor path `msg.sender == account` by construction. Neither
///        is recoverable from the log.
///      - `sessionKey` — absent. The signing key is known on-chain (it is the WindowCharged
///        `key` and the EIP-712 `nonce`/`expiry` subject) but is not bound into this
///        event, so joining ActionLogged to a specific key requires inferring it from
///        surrounding logs in the same transaction.
///      - `calldata` / arguments — absent by design (only the 4-byte selector is kept), so
///        an indexer cannot distinguish two identical selectors with different arguments.
///      - `nonce` / `expiry` — absent, so replay-window forensics is impossible from logs
///        alone.
///      - `chainId` — absent, but correctly so: it is a property of the log's chain, and
///        adding it would be both redundant and a signature break.
///
/// @dev The `selector` field is NOT semantically uniform across emitters (EVT-3).
///      SessionKeyManager passes the EIP-712 `request.selector` verbatim, so it is always
///      a real selector. ActionLog7579Executor passes `_auditSelector(callData)`, which for
///      calldata shorter than 4 bytes returns `bytes4(keccak256(callData))` — a derived
///      marker that is deliberately NOT a real selector. An indexer that treats every
///      `selector` value as a callable selector will mis-classify native transfers and
///      short-payload calls (see that function's NatSpec for the exact discrimination rule).
abstract contract ActionLogger {
    /// @notice The single mandatory audit record. See the contract-level CONSUMER
    ///         CONTRACT note: this signature is ABI-frozen and topic0 is load-bearing.
    event ActionLogged(
        bytes32 indexed agentId,
        address indexed target,
        bytes4 indexed selector,
        uint256 value,
        bytes32 rationaleHash,
        uint48 timestamp
    );

    /// @notice Emits the audit record for one executed action.
    /// @param agentId Operator-assigned identifier of the acting agent.
    /// @param target Contract the inner call was sent to.
    /// @param selector Function selector invoked on `target`.
    /// @param value Native value transferred with the inner call.
    /// @param rationaleHash Hash of the off-chain rationale for this action.
    function _logAction(
        bytes32 agentId,
        address target,
        bytes4 selector,
        uint256 value,
        bytes32 rationaleHash
    ) internal {
        emit ActionLogged(agentId, target, selector, value, rationaleHash, uint48(block.timestamp));
    }
}
