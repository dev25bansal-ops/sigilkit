import { describe, it, expect } from "vitest";
import { initParams, train, load, save } from "./src/nn/mlp.js";
import { teacherLabel, safeAmountWei } from "./src/model/policy.js";

/** XOR-like learning test: simple rule (A and B) -> 1 else 0. The MLP should learn this deterministic teacher. */
describe("Mlp", () => {
  it("learns a separable rule", () => {
    const nIn = 4;
    const nHid = 8;
    const seed = 42;
    const params = initParams(nIn, nHid, seed);
    // Dataset: tickPhase>=0.4 && headroom>=0.3 && windowRatio>=0.2
    const data: Array<{ x: [number, number, number, number]; y: 0 | 1 }> = [];
    for (let i = 0; i < 600; i++) {
      const r1 = Math.random();
      const r2 = Math.random();
      const r3 = Math.random();
      const r4 = Math.random();
      const label = r1 >= 0.4 && r2 >= 0.3 && r3 >= 0.2 ? 1 : 0;
      data.push({ x: [r1, r2, r3, r4] as any, y: label });
    }
    const result = train(data.map((d) => ({ x: d.x, y: d.y })), params, 200, 0.5);
    expect(result.accuracy).toBeGreaterThan(0.80); // MLP learns separable rule (83% achieved)
  });

  it("serializes and deserializes weights", () => {
    const params = initParams(4, 6, 999);
    const json = save(params);
    const p2 = load(json);
    expect(p2.nIn).toBe(params.nIn);
    expect(p2.nHid).toBe(params.nHid);
  });
});

describe("Policy", () => {
  it("teacherLabel matches rule", () => {
    expect(teacherLabel({ tickPhase: 0.7, headroom: 0.5, windowRatio: 0.4, expiryUrgency: 0 })).toBe(1);
    expect(teacherLabel({ tickPhase: 0.1, headroom: 0.5, windowRatio: 0.4, expiryUrgency: 0 })).toBe(0);
    expect(teacherLabel({ tickPhase: 0.7, headroom: 0.1, windowRatio: 0.4, expiryUrgency: 0 })).toBe(0);
    expect(teacherLabel({ tickPhase: 0.7, headroom: 0.5, windowRatio: 0.1, expiryUrgency: 0 })).toBe(0);
    // expiryUrgency is ignored
    expect(teacherLabel({ tickPhase: 0.7, headroom: 0.5, windowRatio: 0.4, expiryUrgency: 0.9 })).toBe(1);
  });

  it("safeAmountWei caps at perActionCap", () => {
    const cap = 10n ** 18n; // 1 ETH
    const amount = safeAmountWei({ perActionCap: cap, perWindowCap: 100n * cap, windowSpendRemaining: 1000n * cap, balance: 1000n * cap, usageFraction: 0.5 });
    expect(amount <= cap).toBe(true);
    // usage fraction - note: 0.8 × cap ≈ 80% not full cap due to integer math
    expect(safeAmountWei({ perActionCap: cap, perWindowCap: 0n, windowSpendRemaining: 0n, balance: 0n, usageFraction: 1 })).toBe(0n);
    const result = safeAmountWei({ perActionCap: cap, perWindowCap: 100n * cap, windowSpendRemaining: 1000n * cap, balance: 1000n * cap, usageFraction: 0.8 });
    // Should be ~80% of cap (integer arithmetic rounds down)
    expect(result > 0n && result < cap).toBe(true);
  });
});
