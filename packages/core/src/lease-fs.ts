/**
 * Single-host LeaseStore v2, backed by atomic SQLite statements (Node >=24).
 * Stop ALL old workers before migrating to a fresh coordination directory. Legacy
 * .lock directories are rejected and never removed. Do not mix adapter versions,
 * delete/replace the database while workers run, or use a network filesystem.
 * All workers for a key must use the same database and clock/grace policy.
 * Epochs survive release, but not database replacement. They do not fence a remote
 * relayer/contract unless that receiver enforces them. Close when workers finish.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Address } from "viem";
import { assertLeaseTtl, type LeaseStore, type LeaseToken } from "./client.js";
import { assertAddress } from "./validation.js";

export interface FileLeaseStoreOptions {
  createDir?: boolean;
  /** Recovery delay after expiry. Does not extend the holder's validity. */
  staleGraceMs?: number;
}

export class FileLeaseStore implements LeaseStore {
  readonly version = 2 as const;
  private readonly db: DatabaseSync;
  private readonly staleGraceMs: number;
  private closed = false;

  constructor(private readonly dir: string, options: FileLeaseStoreOptions = {}) {
    this.staleGraceMs = options.staleGraceMs ?? 5_000;
    if (!Number.isSafeInteger(this.staleGraceMs) || this.staleGraceMs < 0 || this.staleGraceMs > 2_147_483_647) {
      throw new Error("SigilKit: invalid lease recovery grace");
    }
    if (options.createDir !== false) mkdirSync(dir, { recursive: true });
    this.checkLegacy();
    this.db = new DatabaseSync(join(dir, "leases-v2.sqlite"));
    try {
      this.db.exec(`PRAGMA busy_timeout = 1000;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS leases (
          key TEXT PRIMARY KEY, owner TEXT,
          epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
          expires INTEGER NOT NULL CHECK(expires BETWEEN 0 AND 9007199254740991),
          reclaim_after INTEGER NOT NULL CHECK(reclaim_after BETWEEN expires AND 9007199254740991),
          CHECK((owner IS NULL AND expires = 0 AND reclaim_after = 0) OR length(owner) > 0)
        ) STRICT`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private checkLegacy(): void {
    if (readdirSync(this.dir).some((name) => name.endsWith(".lock"))) {
      throw new Error("SigilKit: legacy lease directory; stop all workers and migrate to a fresh directory");
    }
  }

  acquire(key: Address, ttlMs: number): LeaseToken | null {
    assertLeaseTtl(ttlMs);
    key = assertAddress(key, "key").toLowerCase() as Address;
    this.checkLegacy();
    return this.write(() => {
      const now = this.now(ttlMs);
      const id = randomUUID();
      const previous = this.db.prepare("SELECT epoch FROM leases WHERE key = ?").get(key) as { epoch: number } | undefined;
      if (previous && (!Number.isSafeInteger(previous.epoch) || previous.epoch >= Number.MAX_SAFE_INTEGER)) {
        throw new Error("SigilKit: lease epoch exhausted or invalid");
      }
      const row = this.db.prepare(`
        INSERT INTO leases (key, owner, epoch, expires, reclaim_after) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(key) DO UPDATE SET owner = excluded.owner, epoch = leases.epoch + 1,
          expires = excluded.expires, reclaim_after = excluded.reclaim_after
        WHERE leases.owner IS NULL OR leases.reclaim_after <= ?
        RETURNING epoch
      `).get(key, id, now + ttlMs, now + ttlMs + this.staleGraceMs, now) as { epoch: number } | undefined;
      return row ? Object.freeze({ key, id, epoch: row.epoch }) : null;
    });
  }

  renew(token: LeaseToken, ttlMs: number): boolean {
    assertLeaseTtl(ttlMs);
    const key = assertAddress(token.key, "key").toLowerCase();
    return this.write(() => {
      const now = this.now(ttlMs);
      return this.db.prepare(`UPDATE leases SET expires = ?, reclaim_after = ?
        WHERE key = ? AND owner = ? AND epoch = ? AND expires > ?`)
        .run(now + ttlMs, now + ttlMs + this.staleGraceMs, key, token.id, token.epoch, now).changes === 1;
    });
  }

  isCurrent(token: LeaseToken): boolean {
    const key = assertAddress(token.key, "key").toLowerCase();
    const row = this.db.prepare("SELECT expires FROM leases WHERE key = ? AND owner = ? AND epoch = ?")
      .get(key, token.id, token.epoch) as { expires: number } | undefined;
    return !!row && Number.isSafeInteger(row.expires) && row.expires > this.now();
  }

  release(token: LeaseToken): boolean {
    const key = assertAddress(token.key, "key").toLowerCase();
    return this.db.prepare("UPDATE leases SET owner = NULL, expires = 0, reclaim_after = 0 WHERE key = ? AND owner = ? AND epoch = ?")
      .run(key, token.id, token.epoch).changes === 1;
  }

  /** Diagnostic only; this is not an ownership check. */
  isHeld(key: Address): boolean {
    return this.db.prepare("SELECT 1 FROM leases WHERE key = ? AND owner IS NOT NULL AND reclaim_after > ?")
      .get(assertAddress(key, "key").toLowerCase(), Date.now()) !== undefined;
  }

  private now(ttlMs = 0): number {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + ttlMs + this.staleGraceMs)) {
      throw new Error("SigilKit: invalid lease time arithmetic");
    }
    return now;
  }

  private write<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); }
      catch (rollbackError) {
        this.close();
        throw new AggregateError([error, rollbackError], "SigilKit: lease transaction rollback failed");
      }
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
