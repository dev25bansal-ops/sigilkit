/**
 * Cross-process `LeaseStore` for single-host fleets (ARCH-6).
 *
 * `NonceGate` serializes per-key execution *within* one process, and the `LeaseStore` seam
 * exists so that multiple processes sharing one session key can coordinate. Until now the only
 * implementation was `InMemoryLeaseStore` — in-process only — so the seam had no production
 * backend and a multi-worker deployment could still race two `prepareExecution` calls onto the
 * same on-chain nonce (fail-safe: the loser reverts after spending gas, but confusing).
 *
 * `FileLeaseStore` closes that gap for the common "several workers on one host" topology using
 * nothing but atomic directory creation — `mkdir` is atomic on POSIX and NTFS, and it is
 * fail-if-exists by default, which is exactly a compare-and-swap.
 *
 *   import { FileLeaseStore } from "@sigilkit/core/lease-fs";
 *   const client = new SigilKitClient({ ..., nonceGate: new NonceGate(new FileLeaseStore("/var/run/sigilkit")) });
 *
 * Scope: ONE HOST. It does not coordinate across machines — a shared filesystem (NFS) is not a
 * reliable mutex. For a distributed fleet use a real lock service (Redis `SET key owner NX PX
 * ttl` with a check-and-delete release, etcd, or your orchestrator's leader election); the
 * interface is deliberately tiny so that adapter is ~20 lines.
 *
 * This module is a separate entry point (`@sigilkit/core/lease-fs`) because it imports
 * `node:fs`; the main entry stays free of Node built-ins so browser/edge bundlers are unaffected.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import type { LeaseStore } from "./client.js";

export interface FileLeaseStoreOptions {
  /** Create the lease directory if it does not exist. Default true. */
  createDir?: boolean;
  /**
   * How long past its TTL a lease directory may live before another process may break it.
   * Guards against a crashed holder leaving a permanent lock. Default 5_000 ms.
   */
  staleGraceMs?: number;
}

export class FileLeaseStore implements LeaseStore {
  private readonly dir: string;
  private readonly staleGraceMs: number;

  constructor(dir: string, options: FileLeaseStoreOptions = {}) {
    this.dir = dir;
    this.staleGraceMs = options.staleGraceMs ?? 5_000;
    if (options.createDir !== false) mkdirSync(dir, { recursive: true });
  }

  private lockPath(key: Address): string {
    return join(this.dir, `${key.toLowerCase()}.lock`);
  }

  /**
   * Expiry stamp written by the holder, or the directory's mtime when the stamp is missing or
   * corrupt (a holder that crashed between `mkdir` and `writeFileSync`). Falling back to the
   * mtime matters: without it, an unreadable stamp would look like "expiry 0" and could never
   * be broken, leaving a permanent lock on that key.
   */
  private expiryOf(path: string): number {
    try {
      const v = Number(readFileSync(join(path, "expires"), "utf8"));
      if (Number.isFinite(v) && v > 0) return v;
    } catch {
      /* no stamp — fall through to mtime */
    }
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0; // the lock vanished under us; treat as absent
    }
  }

  acquire(key: Address, ttlMs: number): boolean {
    const path = this.lockPath(key);
    const now = Date.now();

    // Fast path: atomic create. Throws EEXIST when another holder got there first.
    try {
      mkdirSync(path);
      writeFileSync(join(path, "expires"), String(now + ttlMs));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // Held. Break it only if the holder is provably past its TTL plus the grace period.
    const expiry = this.expiryOf(path);
    const isStale = expiry !== 0 && now > expiry + this.staleGraceMs;
    if (!isStale) return false;

    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      return false; // someone else is breaking it concurrently
    }
    // Re-race for the lock; exactly one process can win this mkdir.
    try {
      mkdirSync(path);
      writeFileSync(join(path, "expires"), String(now + ttlMs));
      return true;
    } catch {
      return false;
    }
  }

  release(key: Address): void {
    rmSync(this.lockPath(key), { recursive: true, force: true });
  }

  /** True when a live (non-stale) lease exists for the key — diagnostic helper. */
  isHeld(key: Address): boolean {
    const path = this.lockPath(key);
    if (!existsSync(path)) return false;
    const expiry = this.expiryOf(path);
    return expiry !== 0 && Date.now() <= expiry + this.staleGraceMs;
  }
}
