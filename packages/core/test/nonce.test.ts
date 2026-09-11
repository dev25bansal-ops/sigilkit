/**
 * NonceGate unit tests — per-key execution serialization (issues catalog P1).
 * The on-chain contract enforces strictly-sequential per-key nonces; the gate makes
 * concurrent SDK users of one key queue instead of racing for the same nonce.
 */
import { describe, expect, it } from "vitest";
import { NonceGate } from "../src/index.js";

const KEY_A = "0x00000000000000000000000000000000000000aa" as const;
const KEY_B = "0x00000000000000000000000000000000000000bb" as const;

describe("NonceGate", () => {
  it("serializes concurrent runs for the same key (each sees the prior nonce)", async () => {
    const gate = new NonceGate();
    let nonce = 0;
    const observed: number[] = [];

    await Promise.all(
      Array.from({ length: 5 }, () =>
        gate.run(KEY_A, async () => {
          const myNonce = nonce; // fetch-on-fire (readContract in real use)
          await new Promise((r) => setTimeout(r, 5)); // "send + confirm" latency
          nonce = myNonce + 1; // nonce consumed on-chain
          observed.push(myNonce);
        }),
      ),
    );

    expect(observed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(nonce).toBe(5);
  });

  it("does not serialize different keys", async () => {
    const gate = new NonceGate();
    let inside = 0;
    let overlapSeen = false;

    const hold = gate.run(KEY_A, async () => {
      inside++;
      await new Promise((r) => setTimeout(r, 30));
      inside--;
    });
    await new Promise((r) => setTimeout(r, 5));
    const other = gate.run(KEY_B, async () => {
      if (inside > 0) overlapSeen = true; // expected: KEY_B is NOT blocked by KEY_A
    });
    await Promise.all([hold, other]);
    expect(overlapSeen).toBe(true);
  });

  it("a failing run does not poison the queue", async () => {
    const gate = new NonceGate();
    await expect(
      gate.run(KEY_A, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(gate.run(KEY_A, async () => "ok")).resolves.toBe("ok");
  });

  it("propagates the wrapped result value", async () => {
    const gate = new NonceGate();
    const result = await gate.run(KEY_A, async () => ({ audited: true }));
    expect(result).toEqual({ audited: true });
  });
});

import { InMemoryLeaseStore } from "../src/index.js";

describe("NonceGate with a LeaseStore (E18: cross-worker coordination seam)", () => {
  it("rejects a run when another worker holds the lease", async () => {
    const store = new InMemoryLeaseStore();
    const gateA = new NonceGate(store);
    const gateB = new NonceGate(store); // second "worker" sharing the store
    let release: (() => void) | undefined;
    const held = gateA.run(KEY_A, () => new Promise((r) => (release = () => r(null))));
    await new Promise((r) => setTimeout(r, 5));
    await expect(gateB.run(KEY_A, async () => "should not run")).rejects.toThrow("busy in another worker");
    release!();
    await held;
    await expect(gateB.run(KEY_A, async () => "ok now")).resolves.toBe("ok now");
  });

  it("expired leases free the key (TTL safety net)", async () => {
    const store = new InMemoryLeaseStore();
    expect(store.acquire(KEY_A, 10)).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    expect(store.acquire(KEY_A, 10)).toBe(true); // expired → acquirable again
  });
});
