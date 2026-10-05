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
    /// @dev Deliberately overloaded across three distinct, operator-actionable
    ///      conditions: a `msg.value != value` mismatch by the forwarding relayer, a
    ///      reentrancy attempt, and a reverting inner call. Kept as ONE error because
    ///      all three mean the same thing to the account (this execution did not land)
    ///      and none of them is attacker-actionable — the account's own routing is what
    ///      establishes authority here. The cost is diagnosability: a client cannot tell
    ///      them apart from revert data alone. Splitting it is a deliberate API change,
    ///      not a cleanup, so it needs an owner decision rather than a lint pass.
    error ExecutionFailed();
    error EmptyAgentId();

    /// @notice Emitted when the account installs the executor with an agentId binding.
    /// @dev Semantics: emitted from BOTH `onInstall` (the pinning path, see the trust
    ///      boundary note on `setAgentId`) and `setAgentId` (the mutable path). The two are
    ///      NOT distinguishable from the log: a first-time install and a later self-relabel
    ///      produce byte-identical events, so an indexer cannot tell "the operator pinned
    ///      this at install time" from "the account relabelled itself later" — which is
    ///      precisely the distinction the trust-boundary NatSpec asks operators to police.
    ///      This is safe to evolve (nothing in the repo decodes these two events) but the
    ///      fix is a NEW event, not a field on this one: `AgentBound` is covered by the
    ///      ABI drift gate like every other declaration.
    event AgentBound(address indexed account, bytes32 indexed agentId);
    /// @notice Emitted when the account changes or clears its agentId binding.
    /// @dev Emitted ONLY by `onUninstall`. `setAgentId(bytes32(0))` — the documented
    ///      "or clears" case on the sibling event — clears the mapping but emits
    ///      `AgentBound(account, 0)` instead, so a consumer that watches only for
    ///      `AgentUnbound` will keep a stale binding for an account that unlabelled
    ///      itself. See EVT-4 in the report: an indexer must treat `AgentBound` with a
    ///      zero agentId as an unbind.
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

    /// @notice ERC-7579 module-type query. The account calls this to check compatibility
    ///         before installing.
    /// @dev D-04 (RESOLVED — 1-indexed per ERC-7579, the numbering this repo already uses):
    ///      the spec defines `VALIDATOR = 1, EXECUTOR = 2, FALLBACK = 3, HOOK = 4`. This
    ///      contract previously answered `6`, which is unassigned under the spec — so a
    ///      spec-compliant account filtering executor modules by type would never install
    ///      it, and the 7579 path would emit NO `ActionLogged` at all: INV-3 silently inert.
    ///
    ///      A "which convention?" question was raised and then withdrawn: there is no
    ///      convention to choose. `SessionKey7579Module` already answers `1` for
    ///      validation, which matches the spec exactly, so the codebase had already
    ///      adopted 1-indexed and `2` is the only id that can be meant. Whether the
    ///      original `6` was a typo or a deliberate alternative scheme is NOT recoverable
    ///      from the tree — it is recorded here as "unknown", not as a conclusion, because
    ///      the fix is the same either way and guessing at intent would be exactly the
    ///      failure mode described below. That sibling agreement is also the regression
    ///      guard: the two modules must answer DIFFERENT ids (1 and 2), and each must
    ///      reject the other's.
    ///
    ///      A "0-indexed ecosystem uses 0/1/2/3/4" claim also circulated during triage and
    ///      is DELIBERATELY NOT repeated here: docs/ARCH-CONTRACTS-2026-09-26.md §4.2.1
    ///      records that it came from an unverified fetch and never checked out. It is
    ///      noted only because it nearly became a second false certainty in this file —
    ///      the same shape of error as the `type 6` line below.
    ///
    ///      HISTORY, kept because the failure mode is worth remembering: an earlier
    ///      revision of this comment read "this contract is type 6 (EXECUTOR)" — an
    ///      undocumented literal restated in the register of a citation, which is worse
    ///      than the bare `6` it replaced, because the wording told the next reader the
    ///      value had been checked. A comment is not a specification; where a literal
    ///      encodes an external standard, say which standard and cite it, or say plainly
    ///      that it is unverified. `forge inspect … abi` is unaffected by this value: the
    ///      ABI carries the signature `isModuleType(uint256) pure returns (bool)`, not the
    ///      body, so no committed ABI was regenerated for the `6 -> 2` correction.
    /// @param moduleTypeId ERC-7579 module type; this contract is type 2 (EXECUTOR).
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 2; // EXECUTOR_MODULE (ERC-7579: VALIDATOR=1, EXECUTOR=2, FALLBACK=3, HOOK=4)
    }

    /// @notice Install hook — called BY the account. `data` optionally encodes a
    ///         `bytes32 agentId` to bind for audit attribution. Installing with no data
    ///         is legal: the account can then call `setAgentId` itself, and any `execute`
    ///         before the binding exists reverts `EmptyAgentId` rather than logging an
    ///         unattributed action.
    function onInstall(bytes memory data) external {
        if (data.length != 0) {
            // CQ-1: named `boundAgentId`, not `agentId` — the latter shadows the public
            // `agentId(address)` view below (solc warning 8760).
            bytes32 boundAgentId = abi.decode(data, (bytes32));
            _s().agentIds[msg.sender] = boundAgentId;
            emit AgentBound(msg.sender, boundAgentId);
        }
    }

    /// @notice Uninstall hook — called BY the account. Clears the agentId binding, after
    ///         which this contract no longer accepts executions (they revert
    ///         `EmptyAgentId`), so the audit trail cannot continue under a stale identity.
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
        if (target == address(0)) revert ExecutionFailed(); // zero target would burn value
        ExecutorStorage storage s = _s();
        // C-01: reentrancy guard. This is REACHABLE and NECESSARY, not defence in depth.
        //
        // A previous version of this comment claimed the guard was "structurally
        // unreachable", reasoning that every check above reverts unless
        // `msg.sender == account`, and that the only address satisfying that is the
        // account itself — which "cannot re-enter through its own `execute`". That
        // reasoning is wrong: an account CAN re-enter its own `execute`, and on that
        // second entry `msg.sender` is STILL the account, so the guard condition holds
        // and the reentrant frame passes every check above. Concretely
        // (test_Execute_ReentrantCallRejected): the account's inner call target re-enters
        // `execute`, passing `msg.sender == account`, a matching `msg.value`, and a
        // non-zero `target` — reaching this line for the first time with the lock unset,
        // then finding it set on the way back in.
        //
        // So the lock is the ONLY thing standing between a target and a third nested
        // frame: without it, the inner frame would clear `reentrancyLocked` at the end
        // of its own (still-executing) call, re-opening the door while the outer frame
        // has not yet logged its audit event. That is a real event-ordering hazard as
        // well as a reentrancy one, which is why INV-3 cannot be assumed here.
        //
        // SCOPE OF THE LOCK, recorded because the struct makes it easy to over-read.
        // `reentrancyLocked` is ONE bool in the ERC-7201 struct, not keyed per account, and
        // `execute` is the shared surface for every account that installs this module. So the
        // guard is contract-WIDE: while account A sits inside its inner `call`, a nested
        // `execute` from a DIFFERENT account B also reverts `ExecutionFailed`. That direction
        // is safe — the guard over-blocks and never under-blocks, so it cannot be used to slip
        // past the reentrancy check — but it is an availability coupling between otherwise
        // independent accounts, and an integrator reasoning about per-account isolation should
        // not assume it. Re-entrancy that actually threatens the audit trail stays within one
        // account's own `execute` (the case `test_Execute_ReentrantCallRejected` covers).
        //
        // Making the lock per-account would mean adding a mapping to `ExecutorStorage`, i.e.
        // a STORAGE-LAYOUT change on a live module; that is a deployment decision, not a drive-by
        // fix, so the contract-wide scope is documented here instead of silently changed.
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
        //
        // EVT-5: the hardcoded `bytes32(0)` rationaleHash is a MANDATORY SENTINEL here,
        // not a missing field. There is no rationale to hash on this path — the account
        // calls `execute` directly, so no off-chain rationale exists. An indexer must
        // therefore NOT read a zero rationaleHash as "rationale lost in transit" or
        // "unverified action"; it is the positive marker for "this action was authorised
        // by the account's own 7579 routing rather than by a signed, agent-attributed
        // SessionKeyManager request". Any consumer reconciling the two execution paths
        // has to branch on it.
        _logAction(auditId, target, _auditSelector(callData), value, bytes32(0));
    }
}
