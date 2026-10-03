/**
 * @sigilkit/agent — Real agent runtime that delegates decision-making to pluggable "brains",
 * enforcing on-chain scope guardrails. Models are advisory only; hard guardrails veto.
 */

export { StubBrain } from "./brain/stub-brain.js";
export { LocalModelBrain } from "./brain/local-model-brain.js";
export type { DecisionProvider, AgentContext, BrainDecision } from "./types.js";
export { McpAgentRunner } from "./agent-runner.js";
export type { MlpParams } from "./nn/mlp.js";
export { initParams, train as trainMlp, load as loadParams, save as saveParams, forward, predict } from "./nn/mlp.js";
export { teacherLabel, safeAmountWei, clamp01 } from "./model/policy.js";
