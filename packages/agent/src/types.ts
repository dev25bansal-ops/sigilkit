import type { Address, Hash } from "viem";
import type { ActionRequest } from "@sigilkit/core";

/**
 * Pluggable decision provider: a "brain" that observes state and proposes actions.
 *
 * Real brains implement this to hook into LLMs (Anthropic/Claude, OpenAI, local models).
 * StubBrain implements it with deterministic logic for testing/demo purposes.
 *
 * The key invariant: brains can ONLY propose actions; they cannot execute them. All
 * execution passes through McpAgentRunner which validates against scope BEFORE any
 * signature or relayer submission occurs. This enforces SEC-06 role separation and
 * prevents model hallucination from violating on-chain bounds.
 */
export interface DecisionProvider {
  /** Human-readable name for telemetry/logging. */
  readonly name: string;

  /**
   * Observe on-chain + off-chain state and return a proposed action or null (idle).
   *
   * Return null when no action should be taken — brains must NOT force actions out
   * of a desire to act. Idle ticks are expected behavior.
   */
  propose(context: AgentContext): Promise<ActionRequest | null>;
}

/**
 * Context provided to a decision provider for making proposals.
 *
 * Includes read-only observations that a brain needs (balance, nonce, window state),
 * but NEVER includes keys capable of signing. Signing happens downstream in
 * McpAgentRunner via SigilKitClient after scope validation.
 */
export interface AgentContext {
  /** Current tick counter for time-series strategies. */
  tick: number;
  /** Manager address this agent operates under. */
  managerAddress: Address;
  /** Balance of the manager account (wei). */
  balance: bigint;
  /** Remaining spend for this session window (wei). */
  windowSpendRemaining: bigint;
  /** Per-action cap for immediate rejection checks. */
  perActionCap: bigint;
  /** Nonce used by session key (for replay detection). */
  nonce: bigint;
  /** Timestamp-based expiry seconds. */
  expiresAt: number;
  /** Last successfully executed transaction hash (if any). */
  lastTxHash?: Hash;
  /** Cumulative count of successful actions this run. */
  actionsExecuted: number;
}

/**
 * A validated proposal from a brain: an ActionRequest plus guardrail metadata.
 *
 * Guardrails verify before the brain returns: if any guardrail fails, the proposal
 * is dropped as { ok: false, reason }. If all pass, we proceed to zero-gas scope
 * check -> sign -> relay.
 */
export interface BrainDecision {
  /** True if all guardrails passed and this proposal may proceed. */
  ok: boolean;
  /** Reason code if rejected by guardrails (never throws). */
  reason?: string;
  /** The proposed ActionRequest if ok === true. */
  request?: ActionRequest;
}
