import { describe, it, expect } from "vitest";
import type { DecisionProvider } from "../src/types.js";
import { initParams } from "../src/nn/mlp.js";
import { LocalModelBrain } from "../src/brain/local-model-brain.js";
import { safeAmountWei } from "../src/model/policy.js";

/** LocalModelBrain must NEVER propose an amount exceeding perActionCap; that's hard safety. */
describe("LocalModelBrain", () => {
  const ctx = (): {
    tick: number;
    managerAddress: `0x${string}`;
    balance: bigint;
    windowSpendRemaining: bigint;
    perActionCap: bigint;
    nonce: bigint;
    expiresAt: number;
    lastTxHash?: string;
    actionsExecuted: number;
  } => ({
    tick: 10,
    managerAddress: "0x" + "00".repeat(20) as `0x${string}`,
    balance: 10n ** 24n, // 10M ETH (plenty)
    windowSpendRemaining: 10n ** 24n,
    perActionCap: 10n ** 18n, // 1 ETH cap
    nonce: 0n,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    actionsExecuted: 0,
  });

  it("never exceeds perActionCap in proposed amount", async () => {
    const cap = 10n ** 18n; // 1 ETH
    const brain = new LocalModelBrain({ threshold: 0.55, period: 10 }, initParams(4, 8, 99));
    const c = ctx();
    c.perActionCap = cap;
    c.balance = 100n * cap; // huge balance
    const result = await brain.propose(c);
    if (!result) return;
    expect(result.amount).toBeLessThanOrEqual(cap);
    expect(result.amount).toBeGreaterThanOrEqual(0n);
  });

  it("advisory only: proposed action respects perActionCap", async () => {
    const cap = 10n ** 18n;
    const brain = new LocalModelBrain({ threshold: 0.55, period: 10, forceSchedule: true }, initParams(4, 8, 77));
    const c = ctx();
    c.tick = 10;
    c.perActionCap = cap;
    c.balance = 100n * cap;
    const result = await brain.propose(c);
    expect(result !== null).toBe(true); // proposal should be non-null in forceSchedule mode
    expect(result!.value <= cap).toBe(true); // value must respect cap regardless of amount computation
  });

  it("proposes consistently for same state", async () => {
    const cap = 10n ** 18n;
    const brain = new LocalModelBrain({ threshold: 0.55, period: 10 }, initParams(4, 8, 1));
    const c = ctx();
    c.tick = 10;
    c.perActionCap = cap;
    const r1 = await brain.propose(c);
    const r2 = await brain.propose(c);
    expect(r1?.amount).toEqual(r2?.amount);
  });
});
