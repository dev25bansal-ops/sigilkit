/**
 * FileLeaseStore tests (ARCH-6).
 *
 * The lease store is the only thing standing between a multi-worker deployment and two
 * workers racing the same on-chain nonce, so it is tested against real filesystem semantics
 * rather than a mock: exclusive acquisition, refusal while held, TTL recovery after a
 * crashed holder, and the NonceGate integration that fails loudly instead of racing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Address } from "viem";
import { NonceGate, SigilKitClient } from "../src/index.js";
import { FileLeaseStore } from "../src/lease-fs.js";
import { foundry } from "viem/chains";

const KEY = "0x00000000000000000000000000000000000000aa" as Address;

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `sigilkit-lease-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileLeaseStore (ARCH-6)", () => {
  it("grants the lease once and refuses a second holder", () => {
    const a = new FileLeaseStore(dir);
    const b = new FileLeaseStore(dir); // a second "worker" on the same host

    expect(a.acquire(KEY, 30_000)).toBe(true);
    expect(b.acquire(KEY, 30_000), "a held lease must not be granted twice").toBe(false);
    expect(b.isHeld(KEY)).toBe(true);

    a.release(KEY);
    expect(b.acquire(KEY, 30_000), "after release the lease is available").toBe(true);
    b.release(KEY);
  });

  it("scopes leases per key", () => {
    const other = "0x00000000000000000000000000000000000000bb" as Address;
    const store = new FileLeaseStore(dir);
    expect(store.acquire(KEY, 30_000)).toBe(true);
    expect(store.acquire(other, 30_000), "a different key must not be blocked").toBe(true);
    store.release(KEY);
    store.release(other);
  });

  it("recovers a lease abandoned by a crashed holder past its TTL", () => {
    vi.useFakeTimers();
    try {
      const crashed = new FileLeaseStore(dir, { staleGraceMs: 1_000 });
      const survivor = new FileLeaseStore(dir, { staleGraceMs: 1_000 });

      expect(crashed.acquire(KEY, 5_000)).toBe(true);
      // The holder dies without releasing.
      expect(survivor.acquire(KEY, 5_000), "still within TTL — must not be stolen").toBe(false);

      vi.advanceTimersByTime(10_000); // past TTL + grace
      expect(survivor.acquire(KEY, 5_000), "an abandoned lease must be reclaimable").toBe(true);
      survivor.release(KEY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a lock whose stamp is missing or corrupt (crashed mid-write)", () => {
    vi.useFakeTimers();
    try {
      const store = new FileLeaseStore(dir, { staleGraceMs: 1_000 });
      // A lock directory with no `expires` stamp — the holder died between mkdir and write.
      mkdirSync(join(dir, `${KEY}.lock`));

      // Freshly created: respected (we cannot prove the holder is dead yet).
      expect(store.acquire(KEY, 5_000)).toBe(false);

      // Past the grace period the mtime fallback makes it reclaimable — crucially, a
      // missing stamp must NOT mean a permanent lock.
      vi.advanceTimersByTime(10_000);
      expect(store.acquire(KEY, 5_000)).toBe(true);
      store.release(KEY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leak a lock when the holder writes a future expiry", () => {
    const store = new FileLeaseStore(dir, { staleGraceMs: 0 });
    mkdirSync(join(dir, `${KEY}.lock`));
    writeFileSync(join(dir, `${KEY}.lock`, "expires"), String(Date.now() + 60_000));
    expect(store.acquire(KEY, 5_000), "a live lease must be respected").toBe(false);
    expect(store.isHeld(KEY)).toBe(true);
  });

  it("NonceGate fails loudly when another worker holds the lease", async () => {
    const holder = new FileLeaseStore(dir);
    holder.acquire(KEY, 30_000);

    const gate = new NonceGate(new FileLeaseStore(dir));
    await expect(gate.run(KEY, async () => "never")).rejects.toThrow(/busy in another worker/);

    holder.release(KEY);
    await expect(gate.run(KEY, async () => "ok")).resolves.toBe("ok");
  });

  it("SigilKitClient accepts a lease store through its config", () => {
    const client = new SigilKitClient({
      managerAddress: KEY,
      chain: foundry,
      leaseStore: new FileLeaseStore(dir),
    });
    expect(client.nonceGate).toBeInstanceOf(NonceGate);
  });

  it("release is idempotent and safe on a missing lock", () => {
    const store = new FileLeaseStore(dir);
    expect(() => store.release(KEY)).not.toThrow();
    store.acquire(KEY, 1_000);
    store.release(KEY);
    store.release(KEY);
    expect(existsSync(join(dir, `${KEY}.lock`))).toBe(false);
  });
});
