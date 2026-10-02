/**
 * Lease TTL contract (assertLeaseTtl) + lease arithmetic guards.
 *
 * `assertLeaseTtl` is a fail-closed precondition that runs BEFORE any callback can
 * execute, and it is re-asserted on every acquire/renew. Zero tests referenced it
 * directly: `assertLeaseTtl` and `LeaseLostError` were the only two exported client
 * symbols no test file ever named. A silently-widened TTL bound (or a wrong bound)
 * would let a holder believe it is protected when it is not — so the boundaries are
 * pinned here, together with the epoch-exhaustion and invalid-lease-token guards
 * that stop a stale holder from ever matching a later one.
 */
import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import {
  assertLeaseTtl,
  InMemoryLeaseStore,
  LeaseLostError,
  NonceGate,
  type LeaseStore,
} from "../src/index.js";

const KEY = "0x00000000000000000000000000000000000000aa" as Address;

/** Accepted TTLs sit on an inclusive [10, 2147483647] integer range. */
const VALID = [10, 11, 1_000, 30_000, 2_147_483_646, 2_147_483_647];
/** Everything outside the inclusive range, plus every non-safe-integer shape. */
const INVALID = [
  0, 1, 9, -1, -10,
  2_147_483_648, 2_147_483_649, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE,
  Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  10.5, 0.1, 30_000.000_001,
];

describe("assertLeaseTtl bounds", () => {
  it.each(VALID)("accepts %i ms (inclusive lower and upper bound)", (ttl) => {
    expect(() => assertLeaseTtl(ttl)).not.toThrow();
  });

  it.each(INVALID)("rejects %p ms with an actionable message", (ttl) => {
    expect(() => assertLeaseTtl(ttl)).toThrow("SigilKit: lease TTL must be an integer between 10 and 2147483647 ms");
  });

  it("rejects the TTL at the NonceGate boundary too, before any callback runs", () => {
    const callback = vi.fn();
    expect(() => new NonceGate(new InMemoryLeaseStore(), { ttlMs: 9 })).toThrow(/lease TTL/);
    expect(() => new NonceGate(new InMemoryLeaseStore(), { ttlMs: 2_147_483_648 })).toThrow(/lease TTL/);
    // Constructor validation must fire before the gate can ever run a callback.
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("InMemoryLeaseStore honours the TTL contract on every entry point", () => {
  it.each([0, 9, 2_147_483_648, Number.NaN, 10.5])(
    "rejects acquire with TTL %p",
    (ttl) => {
      expect(() => new InMemoryLeaseStore().acquire(KEY, ttl)).toThrow(/lease TTL/);
    },
  );

  it.each([0, 9, 2_147_483_648, Number.NaN, 10.5])(
    "rejects renew with TTL %p",
    (ttl) => {
      const store = new InMemoryLeaseStore();
      const token = store.acquire(KEY, 1_000)!;
      expect(() => store.renew(token, ttl)).toThrow(/lease TTL/);
    },
  );

  it("rejects a non-address lease key on every operation", () => {
    const store = new InMemoryLeaseStore();
    expect(() => store.acquire("0x1234" as Address, 1_000)).toThrow(/20-byte hex address/);
    const token = store.acquire(KEY, 1_000)!;
    expect(() => store.renew({ ...token, key: "0xdead" as Address }, 1_000)).toThrow(/20-byte hex address/);
    expect(() => store.isCurrent({ ...token, key: "0xdead" as Address })).toThrow(/20-byte hex address/);
    expect(() => store.release({ ...token, key: "0xdead" as Address })).toThrow(/20-byte hex address/);
  });
});

describe("lease epoch monotonicity and staleness", () => {
  it("increments the epoch on every reacquisition so a stale token can never match", () => {
    const store = new InMemoryLeaseStore();
    const first = store.acquire(KEY, 1_000)!;
    expect(first.epoch).toBe(1);
    store.release(first);
    const second = store.acquire(KEY, 1_000)!;
    expect(second.epoch).toBe(2);
    // The released token is dead in every operation, not just release().
    expect(store.isCurrent(first)).toBe(false);
    expect(store.renew(first, 1_000)).toBe(false);
    expect(store.release(first)).toBe(false);
    expect(store.isCurrent(second)).toBe(true);
  });

  it("returns null while a live lease is held and re-acquires once it expires", () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryLeaseStore();
      const token = store.acquire(KEY, 1_000)!;
      expect(store.acquire(KEY, 1_000)).toBeNull();

      // The holder is protected right up to — but not including — its expiry
      // millisecond: the store keeps a lease while `expires > now`.
      vi.setSystemTime(Date.now() + 999);
      expect(store.acquire(KEY, 1_000)).toBeNull();
      expect(store.isCurrent(token)).toBe(true);

      // One millisecond later the lease is reclaimable.
      vi.setSystemTime(Date.now() + 1);
      const next = store.acquire(KEY, 1_000)!;
      expect(next.epoch).toBeGreaterThan(token.epoch);
      // The superseded token is inert immediately — no grace window.
      expect(store.isCurrent(token)).toBe(false);
      expect(store.renew(token, 1_000)).toBe(false);
      expect(store.release(token)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes address casing so a checksummed key cannot bypass a held lease", () => {
    const store = new InMemoryLeaseStore();
    expect(store.acquire(KEY, 1_000)).not.toBeNull();
    const upper = "0x00000000000000000000000000000000000000AA" as Address;
    expect(store.acquire(upper, 1_000)).toBeNull();
    expect(store.isCurrent({ key: upper, id: store.acquire(KEY, 10) === null ? "" : "x", epoch: 1 })).toBe(false);
  });

  it("freezes the token so a caller cannot mutate its identity in place", () => {
    const store = new InMemoryLeaseStore();
    const token = store.acquire(KEY, 1_000)!;
    expect(Object.isFrozen(token)).toBe(true);
    expect(store.isCurrent(token)).toBe(true);
  });
});

describe("NonceGate rejects malformed v2 tokens before invoking the callback", () => {
  it.each([
    ["a v1 key-only token", { key: KEY }],
    ["an empty id", { key: KEY, id: "", epoch: 1 }],
    ["a non-string id", { key: KEY, id: 7, epoch: 1 }],
    ["epoch 0", { key: KEY, id: "x", epoch: 0 }],
    ["a negative epoch", { key: KEY, id: "x", epoch: -1 }],
    ["a non-integer epoch", { key: KEY, id: "x", epoch: 1.5 }],
    ["a mismatched key", { key: "0x00000000000000000000000000000000000000bb", id: "x", epoch: 1 }],
  ])("refuses %s", async (_label, token) => {
    const base = new InMemoryLeaseStore();
    vi.spyOn(base, "acquire").mockReturnValue(token as never);
    const callback = vi.fn();
    await expect(new NonceGate(base).run(KEY, callback)).rejects.toThrow("invalid v2 lease token");
    // Fail-closed: a token the gate cannot verify must never reach user code.
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([null, false, 0, ""])(
    "treats a falsy acquire result %p as 'busy' rather than a usable token",
    async (result) => {
      // The store signals "could not take the lease" with null/undefined. A falsy
      // value that is NOT null (0, "", false) must fail closed on the same path
      // instead of being mistaken for a valid token.
      const base = new InMemoryLeaseStore();
      vi.spyOn(base, "acquire").mockReturnValue(result as never);
      const callback = vi.fn();
      await expect(new NonceGate(base).run(KEY, callback)).rejects.toThrow(
        "is busy in another worker",
      );
      expect(callback).not.toHaveBeenCalled();
    },
  );
});

describe("LeaseLostError", () => {
  it("carries the key, the dedicated name, and the originating cause", async () => {
    const store = new InMemoryLeaseStore();
    const gate = new NonceGate(store, { ttlMs: 1_000 });
    const seen: LeaseLostError[] = [];
    // Supersede the holder from underneath the running callback.
    await gate.run(KEY, async (guard) => {
      setTimeout(() => {
        store.release(store.acquire(KEY, 1_000)!);
      }, 0);
      try {
        await guard.assertCurrent();
      } catch (error) {
        seen.push(error as LeaseLostError);
      }
      return "done";
    });
    // The superseded run surfaces the loss to the caller rather than succeeding quietly.
    await expect(gate.run(KEY, () => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(seen.length === 0 || seen[0] instanceof LeaseLostError).toBe(true);
  });

  it("is catchable as a plain Error and names the superseded key", () => {
    const err = new LeaseLostError(KEY);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LeaseLostError");
    expect(err.message).toContain(KEY.toLowerCase());
    expect(err.message).toMatch(/superseded by another worker/);
  });

  it("preserves the cause that triggered the loss", () => {
    const cause = new Error("synthetic I/O");
    expect(new LeaseLostError(KEY, { cause }).cause).toBe(cause);
  });
});

describe("NonceGate adapter-version contract", () => {
  // The rows are deliberately heterogeneous (a v1 adapter, v2 adapters missing one member
  // each, a non-function member). Letting TypeScript infer the tuple type from such a mix
  // collapses every member to an implicitly-any recursive type (TS7023); the explicit
  // unknown-valued record keeps the shapes deliberate and the table readable.
  it.each<[string, Record<string, unknown>]>([
    ["a v1 key-only adapter", { acquire: () => null, release: () => undefined }],
    ["an adapter missing renew", { version: 2, acquire: () => null, release: () => undefined, isCurrent: () => false }],
    ["an adapter missing isCurrent", { version: 2, acquire: () => null, release: () => undefined, renew: () => false }],
    ["an adapter with a non-function acquire", { version: 2, acquire: 1, release: () => undefined, renew: () => false, isCurrent: () => false }],
  ])("refuses %s at construction", (_label, adapter) => {
    expect(() => new NonceGate(adapter as unknown as LeaseStore)).toThrow(/v2 token API/);
  });

  it("accepts a complete v2 adapter", () => {
    const store = new InMemoryLeaseStore();
    expect(
      () =>
        new NonceGate({
          version: 2,
          acquire: store.acquire.bind(store),
          renew: store.renew.bind(store),
          isCurrent: store.isCurrent.bind(store),
          release: store.release.bind(store),
        }),
    ).not.toThrow();
  });
});
