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

  it("serializes equivalent address casing without retaining completed queues", async () => {
    const gate = new NonceGate();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const order: string[] = [];
    const first = gate.run(KEY_A, async () => {
      order.push("first");
      await held;
      order.push("finished");
    });
    const second = gate.run("0x00000000000000000000000000000000000000AA", async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first"]);
    finish();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "finished", "second"]);
    expect(gate["chains"].size).toBe(0);
  });

  it("removes completed queues after failures", async () => {
    const gate = new NonceGate();
    await expect(gate.run(KEY_A, async () => { throw new Error("synthetic failure"); })).rejects.toThrow("synthetic failure");
    expect(gate["chains"].size).toBe(0);
    await expect(gate.run(KEY_A, async () => "retry")).resolves.toBe("retry");
    expect(gate["chains"].size).toBe(0);
  });

  it("propagates the wrapped result value", async () => {
    const gate = new NonceGate();
    const result = await gate.run(KEY_A, async () => ({ audited: true }));
    expect(result).toEqual({ audited: true });
  });
});

import { InMemoryLeaseStore, type ExecutionGuard, type LeaseStore } from "../src/index.js";
import { afterEach, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("owned run lifecycle", () => {
  it("renews slow work and invalidates its context without leaking timers", async () => {
    vi.useFakeTimers();
    const store = new InMemoryLeaseStore();
    const renew = vi.spyOn(store, "renew");
    const gate = new NonceGate(store, { ttlMs: 100 });
    let context!: ExecutionGuard;
    let finish!: () => void;
    const body = new Promise<void>((resolve) => { finish = resolve; });
    const run = gate.run(KEY_A, async (guard) => { context = guard; await body; return 7; });
    await vi.advanceTimersByTimeAsync(350);
    expect(renew).toHaveBeenCalledTimes(7);
    expect(store.acquire(KEY_A, 100)).toBeNull();
    await context.assertCurrent();
    finish();
    expect(await run).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
    expect(context.signal.aborted).toBe(true);
    await expect(context.assertCurrent()).rejects.toThrow("finished");
    expect(store.acquire(KEY_A, 100)).not.toBeNull();
  });

  it.each([false, "throw"])("cooperatively aborts on renewal failure %s without releasing a running body", async (mode) => {
    vi.useFakeTimers();
    const store = new InMemoryLeaseStore();
    vi.spyOn(store, "renew").mockImplementation(() => {
      if (mode === "throw") throw new Error("synthetic I/O");
      return false;
    });
    const release = vi.spyOn(store, "release");
    const gate = new NonceGate(store, { ttlMs: 100 });
    let context!: ExecutionGuard;
    let finish!: () => void;
    const body = new Promise<void>((resolve) => { finish = resolve; });
    const run = gate.run(KEY_A, async (guard) => { context = guard; await body; });
    const result = expect(run).rejects.toThrow("superseded");
    await vi.advanceTimersByTimeAsync(50);
    expect(context.signal.aborted).toBe(true);
    await expect(context.assertCurrent()).rejects.toThrow("superseded");
    expect(release).not.toHaveBeenCalled();
    finish();
    await result;
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("joins a pending renewal before release and never overlaps renewals", async () => {
    vi.useFakeTimers();
    const store = new InMemoryLeaseStore();
    let renewed!: (value: boolean) => void;
    const renewal = new Promise<boolean>((resolve) => { renewed = resolve; });
    const renew = vi.fn(() => renewal);
    const release = vi.spyOn(store, "release");
    const adapter: LeaseStore = {
      version: 2, acquire: store.acquire.bind(store), renew,
      isCurrent: store.isCurrent.bind(store), release: store.release.bind(store),
    };
    let finish!: () => void;
    const body = new Promise<void>((resolve) => { finish = resolve; });
    const run = new NonceGate(adapter, { ttlMs: 1000 }).run(KEY_A, async () => { await body; });
    await vi.advanceTimersByTimeAsync(600);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(release).not.toHaveBeenCalled();
    expect(renew).toHaveBeenCalledTimes(1);
    renewed(true);
    await run;
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects legacy, partial, and malformed adapters before callback invocation", async () => {
    expect(() => new NonceGate({ acquire: () => true, release: () => undefined } as unknown as LeaseStore)).toThrow("v2");
    expect(() => new NonceGate({ version: 2 } as LeaseStore)).toThrow("v2");
    const base = new InMemoryLeaseStore();
    const callback = vi.fn();
    vi.spyOn(base, "acquire").mockReturnValue(true as unknown as ReturnType<InMemoryLeaseStore["acquire"]>);
    await expect(new NonceGate(base).run(KEY_A, callback)).rejects.toThrow("invalid v2 lease token");
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["acquire", "release"] as const)("reports %s errors without poisoning the queue", async (method) => {
    const store = new InMemoryLeaseStore();
    const gate = new NonceGate(store);
    const original = store[method].bind(store);
    if (method === "acquire") {
      vi.spyOn(store, "acquire").mockImplementationOnce(() => { throw new Error("synthetic I/O"); });
    } else {
      vi.spyOn(store, "release").mockImplementationOnce((token) => {
        (original as InMemoryLeaseStore["release"])(token);
        throw new Error("synthetic I/O");
      });
    }
    await expect(gate.run(KEY_A, async () => 1)).rejects.toThrow("synthetic I/O");
    await expect(gate.run(KEY_A, async () => 2)).resolves.toBe(2);
  });
});

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
    expect(store.acquire(KEY_A, 10)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 15));
    expect(store.acquire(KEY_A, 10)).not.toBeNull(); // expired → acquirable again
  });
});
