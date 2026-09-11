// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ActionLogger} from "./ActionLogger.sol";

/// @title ActionLog7579Executor
/// @notice ERC-7579 EXECUTOR module that routes executions through the account while
///         emitting the mandatory `ActionLogged` audit event at EXECUTION time —
///         restoring the audit-trail guarantee on the standards-native path where
///         `SessionKey7579Module` (a VALIDATOR) cannot provide it (issues catalog A3:
///         validation passing ≠ execution landing, so a validator must not log).
/// @dev The installing account invokes `execute` itself (msg.sender == account), so
///      "who executed" is established by the account's own 7579 routing. Pair this
///      executor with the SigilKit validator: the validator bounds the scope, the
///      executor proves the call landed and logs it. Executions are attributed via the
///      account's installed `agentId` binding (`setAgentId`).
contract ActionLog7579Executor is ActionLogger {
    error NotAccount();
    error ExecutionFailed();
    error EmptyAgentId();

    /// @notice Emitted when the account installs the executor with an agentId binding.
    event AgentBound(address indexed account, bytes32 indexed agentId);
    /// @notice Emitted when the account changes or clears its agentId binding.
    event AgentUnbound(address indexed account);

    // ERC-7201 namespaced storage (cast index-erc7201 "sigilkit.storage.ActionLog7579Executor").
    bytes32 private constant _STORAGE_LOCATION =
        0x609299005b232a48674be0198b2716715ae30df841447244f8c03543071a0200;

    struct ExecutorStorage {
        mapping(address account => bytes32) agentIds;
        bool reentrancyLocked;
    }

    function _s() private pure returns (ExecutorStorage storage s) {
        assembly ("memory-safe") {
            s.slot := _STORAGE_LOCATION
        }
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 6; // EXECUTOR_MODULE
    }

    /// @notice Install hook — called BY the account. `data` optionally encodes a
    ///         `bytes32 agentId` to bind for audit attribution.
    function onInstall(bytes memory data) external {
        if (data.length != 0) {
            bytes32 agentId = abi.decode(data, (bytes32));
            _s().agentIds[msg.sender] = agentId;
            emit AgentBound(msg.sender, agentId);
        }
    }

    function onUninstall(bytes memory) external {
        delete _s().agentIds[msg.sender];
        emit AgentUnbound(msg.sender);
    }

    /// @notice Binds (or re-binds) the audit agentId used to attribute executions.
    function setAgentId(bytes32 agentId) external {
        _s().agentIds[msg.sender] = agentId;
        emit AgentBound(msg.sender, agentId);
    }

    function agentId(address account) external view returns (bytes32) {
        return _s().agentIds[account];
    }

    /// @notice ERC-7579 executor surface: the ACCOUNT calls this with the call it wants
    ///         executed, attaching `value` as msg.value (the account holds the funds —
    ///         the executor itself never holds a balance); the module forwards the call
    ///         and emits the mandatory audit record.
    function execute(address account, address target, uint256 value, bytes calldata callData)
        external
        payable
        returns (bytes memory ret)
    {
        if (msg.sender != account) revert NotAccount();
        if (msg.value != value) revert ExecutionFailed();
        ExecutorStorage storage s = _s();
        if (s.reentrancyLocked) revert ExecutionFailed();
        bytes32 auditId = s.agentIds[msg.sender];
        if (auditId == bytes32(0)) revert EmptyAgentId();

        s.reentrancyLocked = true;
        bool ok;
        (ok, ret) = target.call{value: value}(callData);
        if (!ok) revert ExecutionFailed();
        s.reentrancyLocked = false;

        // Mandatory audit (INV-3 on the executor path): no silent success.
        _logAction(auditId, target, bytes4(callData), value, bytes32(0));
    }
}
