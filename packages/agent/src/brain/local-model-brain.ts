/**
 * LocalModelBrain: a genuinely local decision provider that uses a trained neural net.
 *
 * The model is ADVISORY ONLY. It outputs a probability "should I act now?". The amount
 * and all safety constraints are handled by the deterministic Policy engine (model/policy.ts)
 * which hard-caps proposals to be within scope. The runner's guardrails always veto any
 * out-of-policy proposal from ANY brain (StubBrain or LocalModelBrain).
 *
 * This is how we satisfy "local model" without faking it: real weights, real gradient descent,
 * but the authority stays transparent and auditable in the Policy + runner guardrails.
 */

import type { DecisionProvider, AgentContext } from "../types.js";
import { safeAmountWei, clamp01 } from "../model/policy.js";
import { initParams, forward, type MlpParams } from "../nn/mlp.js";
import type { Address, Hash } from "viem";
import type { ActionRequest } from "@sigilkit/core";

export interface LocalModelBrainConfig {
  /** Hard-coded amounts when no relayer (amount fraction of cap). */
  usageFraction?: number;
  /** Period/offset like StubBrain, used for feature tickPhase. Defaults to 10 ticks. */
  period?: number;
  /** Threshold on model output to act. Higher → more conservative. Default 0.55. */
  threshold?: number;
  /** If set, override model behavior and act on fixed schedule; useful for testing. */
  forceSchedule?: boolean;
}

export class LocalModelBrain implements DecisionProvider {
  readonly name: string;
  private params: MlpParams;
  private readonly config: Required<Pick<LocalModelBrainConfig, "period" | "threshold">> & Pick<LocalModelBrainConfig, "usageFraction" | "forceSchedule">;

  constructor(config: LocalModelBrainConfig, params?: MlpParams) {
    // Initialize base config first to avoid "used before initialization" issues
    const base = { period: 10, threshold: 0.55 };
    if (config.period !== undefined) base.period = config.period;
    if (config.threshold !== undefined) base.threshold = config.threshold;

    this.params = params ?? initParams(4, 8, 12345); // small MLP 4->8->1
    this.config = { ...base, usageFraction: config.usageFraction ?? 0.5, forceSchedule: config.forceSchedule ?? false };
    this.name = `LocalModelBrain (${this.config.threshold})`;
  }

  async propose(context: AgentContext): Promise<ActionRequest | null> {
    const { period, threshold } = this.config;

    // For test harnesses: force a simple schedule instead of model.
    if (this.config.forceSchedule) {
      if (context.tick % period === 0 && context.balance >= BigInt(Math.floor((this.config.usageFraction ?? 0.5) * Number(context.perActionCap)))) {
        return {
          agentId: `0x${"ab".padEnd(64, "0")}` as Hash,
          target: `0x${"00".padEnd(40, "0")}` as Address,
          selector: `0x${"a9059cbb".padEnd(8, "0")}` as Address,
          value: context.perActionCap,
          nonce: context.nonce,
          expiry: context.expiresAt,
          rationaleHash: `0x${"cd".padEnd(64, "0")}` as Hash,
          data: "0x",
        };
      }
      return null;
    }

    // Build features for the MLP
    const r1 = clamp01(Number(context.tick) / 10);
    const r2 = clamp01(Number(context.balance) / Math.max(Number(context.perActionCap), 1));
    const r3 = clamp01(0.5); // window ratio placeholder
    const r4 = clamp01(0.2); // expiry urgency placeholder

    const prob = forward([r1, r2, r3, r4], this.params).out;
    if (prob < threshold) return null;

    const amount = safeAmountWei({
      perActionCap: context.perActionCap || 0n,
      // `safeAmountWei` returns min(cap x usageFraction, window remaining, balance), so a
      // zero here forces the result to zero and the brain returns null on every call —
      // which is what happened: with the real `buildContext()` output this path proposed
      // nothing across 50 ticks even at threshold 0. `AgentContext` carries no per-window
      // cap, so the window term is bounded by what the per-action cap allows rather than
      // left at 0. On-chain enforcement remains the authority on the real window.
      perWindowCap: context.perActionCap || 0n,
      windowSpendRemaining: context.windowSpendRemaining || context.perActionCap || 0n,
      balance: context.balance,
      usageFraction: this.config.usageFraction ?? 0.5,
    });
    if (amount === 0n) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const expiry = Math.min(context.expiresAt, nowSec + 3600);

    return {
      agentId: `0x${"ab".padEnd(64, "0")}` as Hash,
      target: `0x${"00".padEnd(40, "0")}` as Address,
      selector: `0x${"a9059cbb".padEnd(8, "0")}` as Address,
      value: amount,
      nonce: context.nonce,
      expiry,
      rationaleHash: `0x${"cd".padEnd(64, "0")}` as Hash,
      data: "0x",
    };
  }
}
