/**
 * Shared ABI fragments for events and custom errors across SigilKit contracts
 * (enhancements E3/E4). These are ALSO generated to packages/core/abis/*.json by
 * CI from the compiled contracts (E5) — the entries here must stay in sync with
 * those files; packages/core/test/abi-drift.test.ts enforces it.
 */
import type { Abi } from "viem";

/** Events emitted by ActionLogger (via SessionKeyManager and ActionLog7579Executor). */
export const ACTION_LOGGER_ABI = [
  {
    type: "event",
    name: "ActionLogged",
    inputs: [
      { name: "agentId", type: "bytes32", indexed: true },
      { name: "target", type: "address", indexed: true },
      { name: "selector", type: "bytes4", indexed: true },
      { name: "value", type: "uint256", indexed: false },
      { name: "rationaleHash", type: "bytes32", indexed: false },
      { name: "timestamp", type: "uint48", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WindowCharged",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "key", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
      { name: "windowStart", type: "uint48", indexed: false },
      { name: "spentThisWindow", type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * Every custom error across the SigilKit contract surface. Identical error names
 * (e.g. KeyUnknown on both manager and module) are declared once — their selectors
 * and argument types are identical by construction.
 */
export const SIGILKIT_ERRORS_ABI = [
  // SessionKeyManager
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "KeyUnknown", inputs: [] },
  { type: "error", name: "KeyRevoked", inputs: [] },
  { type: "error", name: "KeyExpired", inputs: [] },
  { type: "error", name: "RequestExpired", inputs: [] },
  { type: "error", name: "NonceUsed", inputs: [] },
  { type: "error", name: "SelectorDenied", inputs: [{ name: "selector", type: "bytes4" }] },
  {
    type: "error",
    name: "TargetNotAllowed",
    inputs: [
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
    ],
  },
  { type: "error", name: "InnerCallFailed", inputs: [] },
  { type: "error", name: "ValueNotAccepted", inputs: [] },
  { type: "error", name: "InvalidScope", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
  { type: "error", name: "OverlapBeyondOldExpiry", inputs: [] },
  { type: "error", name: "WithdrawFailed", inputs: [] },
  { type: "error", name: "OwnerCountersignRequired", inputs: [] },
  { type: "error", name: "InvalidOwnerApproval", inputs: [] },
  { type: "error", name: "NativeDeltaExceeded", inputs: [
      { name: "balanceBefore", type: "uint256" },
      { name: "balanceAfter", type: "uint256" },
      { name: "declared", type: "uint256" },
    ] },
  // SessionKey7579Module
  { type: "error", name: "AlreadyInitialized", inputs: [] },
  { type: "error", name: "NotInitialized", inputs: [] },
  { type: "error", name: "NotAuthorizedCaller", inputs: [] },
  { type: "error", name: "UnsupportedCallType", inputs: [{ name: "callType", type: "bytes1" }] },
  { type: "error", name: "MalformedExecutionData", inputs: [] },
  // ActionLog7579Executor
  { type: "error", name: "NotAccount", inputs: [] },
  { type: "error", name: "ExecutionFailed", inputs: [] },
  { type: "error", name: "EmptyAgentId", inputs: [] },
  // SpendPolicy
  {
    type: "error",
    name: "PerActionCapExceeded",
    inputs: [
      { name: "value", type: "uint256" },
      { name: "cap", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "PerWindowCapExceeded",
    inputs: [
      { name: "projectedWindowSpend", type: "uint256" },
      { name: "cap", type: "uint256" },
    ],
  },
] as const satisfies Abi;
