/**
 * @sigilkit/agent — Real agent runtime that delegates decision-making to pluggable "brains",
 * enforcing on-chain scope guardrails. Models are advisory only; hard guardrails veto.
 *
 * Every type that appears in an exported signature is re-exported here as well. The
 * package's `exports` map declares only `.` and `./stub-brain`, so a deep import
 * (`@sigilkit/agent/dist/agent-runner.js`) fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
 * A consumer therefore cannot reach `RunnerConfig` — the required argument of the
 * headline `McpAgentRunner` constructor — by any other route. `Sample` is worse than a
 * convenience: it is a required parameter of the exported `trainMlp`, so the call
 * cannot be written at all without it.
 */

export { StubBrain } from "./brain/stub-brain.js";
export { LocalModelBrain } from "./brain/local-model-brain.js";
export type { DecisionProvider, AgentContext, BrainDecision } from "./types.js";
export { McpAgentRunner } from "./agent-runner.js";
export type { RunnerConfig, TickResult } from "./agent-runner.js";
export type { MlpParams, Sample, Activation } from "./nn/mlp.js";
export { initParams, train as trainMlp, load as loadParams, save as saveParams, forward, predict } from "./nn/mlp.js";
export { teacherLabel, safeAmountWei, clamp01 } from "./model/policy.js";
export type { PolicyFeatures, SafeAmountInput } from "./model/policy.js";
export type { LocalModelBrainConfig } from "./brain/local-model-brain.js";
