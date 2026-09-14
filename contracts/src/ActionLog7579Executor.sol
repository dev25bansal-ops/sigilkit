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
            // CQ-1: named `boundAgentId`, not `agentId` — the latter shadows the public
            // `agentId(address)` view below (solc warning 8760).
            bytes32 boundAgentId = abi.decode(data, (bytes32));
            _s().agentIds[msg.sender] = boundAgentId;
            emit AgentBound(msg.sender, boundAgentId);
        }
    }

    function onUninstall(bytes memory) external {
        delete _s().agentIds[msg.sender];
        emit AgentUnbound(msg.sender);
    }

    /// @notice Binds (or re-binds) the audit agentId used to attribute executions.
    /// @dev TRUST BOUNDARY: the binding is strictly self-scoped — it is written under
    ///      `msg.sender` and read in `execute` as `agentIds[msg.sender]`, where
    ///      `msg.sender` must equal `account`. An address therefore can only ever label
    ///      its OWN executions, and cannot forge another account's attribution. What it
    ///      CAN do is relabel itself at any time, so the agentId in `ActionLogged` is an
    ///      account-asserted claim, not a third-party attestation. Operators who need a
    ///      trustworthy agent identity must pin the binding at install time (via
    ///      `onInstall`) and treat later `AgentBound` events as governance-relevant.
    /// @dev The parameter is `boundAgentId` rather than `agentId` so it does not shadow the
    ///      `agentId(address)` view below (solc warning 8760).
    function setAgentId(bytes32 boundAgentId) external {
        _s().agentIds[msg.sender] = boundAgentId;
        emit AgentBound(msg.sender, boundAgentId);
    }

    function agentId(address account) external view returns (bytes32) {
        return _s().agentIds[account];
    }

    /// @dev Selector recorded in the audit event for a call.
    ///
    ///      `bytes4(callData)` silently right-pads input shorter than 4 bytes: empty
    ///      calldata becomes `0x00000000` (which collides with ERC-165's reserved
    ///      selector space) and 2-byte calldata becomes `0xab000000` — both
    ///      indistinguishable in the log from a genuine selector. For calldata shorter
    ///      than a selector we therefore record `bytes4(keccak256(callData))`: a
    ///      deterministic, reproducible derivation (empty calldata -> `0xc5d24601`, the
    ///      well-known keccak of the empty string) that is explicitly NOT a real selector,
    ///      so an indexer can always tell the two cases apart.
    function _auditSelector(bytes calldata callData) private pure returns (bytes4) {
        // Both branches truncate deliberately: the first takes a real 4-byte selector, the
        // second derives a marker from the calldata hash. See the NatSpec above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return callData.length >= 4 ? bytes4(callData) : bytes4(keccak256(callData));
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
        // SEC-3: `_auditSelector` keeps empty/truncated calldata from masquerading as
        // 0x00000000 (see its NatSpec).
        _logAction(auditId, target, _auditSelector(callData), value, bytes32(0));
    }
}
