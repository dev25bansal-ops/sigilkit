import { describe, it, expect } from "vitest";
import { initParams } from "../src/nn/mlp.js";
import { LocalModelBrain } from "../src/brain/local-model-brain.js";
import type { AgentContext } from "../src/types.js";

/**
 * Regression: the non-`forceSchedule` path of LocalModelBrain was dead code.
 *
 * `safeAmountWei` returns min(cap x usageFraction, window remaining, balance), and
 * `propose()` passed `perWindowCap: 0n` with `windowSpendRemaining` taken straight from the
 * context. `McpAgentRunner.buildContext()` sets that field to `0n` (it is not read on-chain),
 * so the minimum was always 0, the `if (amount === 0n) return null` guard fired every time,
 * and the brain proposed NOTHING — verified: 0 proposals across 50 ticks even at threshold 0.
 *
 * Every other test in this package used `forceSchedule: true`, which returns before the
 * amount is ever computed, so this was invisible. The safety property the file asserts (never
 * exceed perActionCap) was never at risk; the liveness property (the brain can act at all)
 * was broken.
 */
describe("LocalModelBrain — the advisory path can actually fire", () => {
  const ctxAt = (tick: number, cap: bigint): AgentContext => ({
    tick,
    managerAddress: "0x" + "00".repeat(20) as `0x${string}`,
    balance: 10n ** 24n,
    // Exactly what `buildContext()` produces today.
    windowSpendRemaining: 0n,
    perActionCap: cap,
    nonce: 0n,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    actionsExecuted: 0,
  });

  it("proposes at least once across a tick sweep with a real (non-forced) context", async () => {
    const cap = 10n ** 18n;
    const brain = new LocalModelBrain({ threshold: 0 }, initParams(4, 8, 42));
    const proposals = [];
    for (let t = 0; t < 50; t++) {
      const r = await brain.propose(ctxAt(t, cap));
      if (r !== null) proposals.push(r);
    }
    expect(proposals.length, "the advisory path returned null for every tick").toBeGreaterThan(0);
  });

  it("still never proposes above perActionCap on that path", () => {
    // The fix must not trade liveness for the safety property: sizing is still the
    // deterministic policy engine's job, bounded by the cap.
    const cap = 10n ** 18n;
    const brain = new LocalModelBrain({ threshold: 0, usageFraction: 1 }, initParams(4, 8, 42));
    return brain.propose(ctxAt(0, cap)).then((r) => {
      if (r !== null) expect(r.value).toBeLessThanOrEqual(cap);
    });
  });

  it("honours usageFraction as the fraction of the cap", async () => {
    const cap = 10n ** 18n;
    const half = new LocalModelBrain({ threshold: 0, usageFraction: 0.5 }, initParams(4, 8, 7));
    const r = await half.propose(ctxAt(0, cap));
    expect(r).not.toBeNull();
    // 50% of the cap, allowing for the flooring in safeAmountWei.
    expect(r!.value).toBeLessThanOrEqual(cap / 2n);
    expect(r!.value).toBeGreaterThan(0n);
  });

  it("declines when the per-action cap is zero", async () => {
    // A zero cap must still mean "cannot act" — the fix must not turn 0 into permission.
    const brain = new LocalModelBrain({ threshold: 0 }, initParams(4, 8, 42));
    expect(await brain.propose(ctxAt(0, 0n))).toBeNull();
  });
});