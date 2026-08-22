// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title ActionLogger
/// @notice Mandatory on-chain audit trail for agent-driven actions.
/// @dev INV-3: the ActionLogged event is emitted if and only if the inner call succeeded.
///      No execution path may produce a state change without a corresponding audit event.
///      Only the keccak256 hash of the agent's rationale is stored on-chain (INV: information
///      disclosure) — plaintext rationale stays off-chain with the operator.
abstract contract ActionLogger {
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
