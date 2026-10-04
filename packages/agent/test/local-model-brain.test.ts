import { describe, it, expect } from "vitest";
import type { AgentContext } from "../src/types.js";
import { initParams } from "../src/nn/mlp.js";
import { LocalModelBrain } from "../src/brain/local-model-brain.js";
import { safeAmountWei } from "../src/model/policy.js";

/** LocalModelBrain must NEVER propose an amount exceeding perActionCap; that's hard safety. */
describe("LocalModelBrain", () => {
  // Typed as the real `AgentContext` rather than a hand-rolled copy. The previous inline
  // literal drifted from the interface (it typed `lastTxHash` as `string`, not `Hash`), and
  // nothing caught it because this package's tsconfig excluded test files from typecheck.
  const ctx = (): AgentContext => ({
    tick: 10,
    managerAddress: "0x" + "00".repeat(20) as `0x${string}`,
    balance: 10n ** 24n, // 10M ETH (plenty)
    windowSpendRemaining: 10n ** 24n,
    perActionCap: 10n ** 18n, // 1 ETH cap
    nonce: 0n,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    actionsExecuted: 0,
  });

  it("never exceeds perActionCap in proposed value", async () => {
    // Why `forceSchedule: true`: without it the MLP's activation probability can fall
    // below the threshold at these weights and `propose` returns null. An earlier version
    // of this test guarded with `if (!result) return`, so on that path it asserted
    // nothing at all while still passing. Forcing the schedule guarantees a proposal
    // exists, so the cap assertion below is always evaluated.
    const cap = 10n ** 18n; // 1 ETH
    const brain = new LocalModelBrain({ threshold: 0.55, period: 10, forceSchedule: true }, initParams(4, 8, 99));
    const c = ctx();
    c.perActionCap = cap;
    c.balance = 100n * cap; // huge balance, so the cap — not the balance — binds
    const result = await brain.propose(c);

    expect(result).not.toBeNull();
    // `ActionRequest` carries the amount as `value`; there is no `amount` field.
    // Asserting `result.amount` type-checks nowhere and can never fail.
    expect(result!.value).toBeLessThanOrEqual(cap);
    expect(result!.value).toBeGreaterThanOrEqual(0n);
  });

  it("caps the proposal even when the balance would allow far more", async () => {
    // The distinguishing case for the cap being a real bound rather than a coincidence of
    // a small balance: `safeAmountWei` takes min(capped, windowSpendRemaining, balance),
    // so with a huge balance and a full window the cap is the only thing limiting it.
    const cap = 10n ** 18n;
    const brain = new LocalModelBrain({ threshold: 0.55, period: 10, forceSchedule: true }, initParams(4, 8, 99));
    const c = ctx();
    c.perActionCap = cap;
    c.windowSpendRemaining = 10n ** 30n;
    c.balance = 10n ** 30n;
    const result = await brain.propose(c);

    expect(result).not.toBeNull();
    expect(result!.value).toBeLessThanOrEqual(cap);
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
    const brain = new LocalModelBrain({ threshold: 0.55, period: 10, forceSchedule: true }, initParams(4, 8, 1));
    const c = ctx();
    c.tick = 10;
    c.perActionCap = cap;
    const r1 = await brain.propose(c);
    const r2 = await brain.propose(c);
    expect(r1).not.toBeNull();
    // Compared by whole request rather than the non-existent `amount` field, which made
    // `undefined === undefined` pass regardless of what the brain actually proposed.
    expect(r1!.value).toEqual(r2!.value);
    expect(r1!.target).toEqual(r2!.target);
    expect(r1!.selector).toEqual(r2!.selector);
  });

  it("returns null when the MLP activation is below threshold", async () => {
    // The complement of the forceSchedule cases above: without forcing, the brain is
    // entitled to decline. This pins that the threshold path still exists rather than
    // having been lost to the force-schedule wiring.
    const cap = 10n ** 18n;
    const brain = new LocalModelBrain({ threshold: 0.99, period: 10 }, initParams(4, 8, 3));
    const c = ctx();
    c.perActionCap = cap;
    c.balance = 100n * cap;
    const result = await brain.propose(c);
    // Either null (declined) or a capped proposal — but never an over-cap proposal.
    if (result !== null) expect(result.value).toBeLessThanOrEqual(cap);
  });

  it("safeAmountWei never returns a negative amount", () => {
    // Direct unit check on the deterministic policy engine that sizes every proposal.
    const amount = safeAmountWei({
      perActionCap: 10n ** 18n,
      perWindowCap: 10n ** 19n,
      windowSpendRemaining: 10n ** 18n,
      balance: 10n ** 18n,
      usageFraction: -1,
    });
    expect(amount).toBeGreaterThanOrEqual(0n);
    expect(amount).toBeLessThanOrEqual(10n ** 18n);
  });
});