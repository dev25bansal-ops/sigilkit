/**
 * Schema-migration tests (BUG-07).
 *
 * `migrate()` used to run its DDL bare, so a crash between
 * `DROP TABLE actions_legacy` and the `window_charges` rebuild left a database in a
 * *mixed schema* that no later `CREATE TABLE IF NOT EXISTS` would ever correct — and
 * `window_charges` could stay on the legacy schema forever. These tests pin the four
 * properties that replaced that behaviour: transactional boundaries, a `user_version`
 * stamp backed by a `STRICT` `_migrations` ledger, per-table re-entrancy so a
 * half-migrated database heals itself, and a fail-closed refusal to open a database
 * written by a newer build.
 *
 * Fixtures use the *real* pre-2026-09-12 schema (recovered from commit 15ea3fd), not a
 * hand-written approximation, and are seeded through a raw `node:sqlite` handle so the
 * indexer never sees them until it migrates.
 */
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hash } from "viem";
import { SigilIndexer } from "../src/indexer.js";
// P0-3: `silentLogger` is a logger symbol -> `/logger` subpath (root barrel drops it).
import { silentLogger } from "@sigilkit/core/logger";

/** Temp workspace under the OS temp dir — isolated per test and removed after (A11). */
const TMP_ROOT = join(tmpdir(), "sigilkit-migrate-tests");
/** Schema version this build stamps once the lossless keys are in place. */
const SCHEMA_VERSION = 1;

const AGENT = ("0x" + "11".repeat(32)) as Hash;
const AGENT2 = ("0x" + "12".repeat(32)) as Hash;
const TARGET = "0x0000000000000000000000000000000000009001";
const SELECTOR = "0x32145f90";
const RATIONALE = ("0x" + "33".repeat(32)) as Hash;
const KEY = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x0000000000000000000000000000000000000042";

/** Options for constructing an indexer without console noise. */
const QUIET = { logger: silentLogger() } as const;

/**
 * The pre-2026-09-12 `actions` table: keyed on the lossy
 * `(tx_hash, agent_id, target, selector, ts)`, with neither `log_index` nor
 * `block_hash`. Verbatim from commit 15ea3fd.
 */
const LEGACY_ACTIONS = `
  CREATE TABLE actions (
    tx_hash TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    target TEXT NOT NULL,
    selector TEXT NOT NULL,
    value TEXT NOT NULL,
    rationale_hash TEXT NOT NULL,
    ts INTEGER NOT NULL,
    chain_id INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, agent_id, target, selector, ts)
  );`;

/** The pre-2026-09-12 `window_charges` table — no primary key, no block height. */
const LEGACY_CHARGES = `
  CREATE TABLE window_charges (
    tx_hash TEXT NOT NULL,
    account TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    spent_this_window TEXT NOT NULL,
    chain_id INTEGER NOT NULL
  );`;

/** The post-2026-09-12 `actions` shape, used to build half-migrated fixtures. */
const CURRENT_ACTIONS = `
  CREATE TABLE actions (
    chain_id INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    block_hash TEXT,
    agent_id TEXT NOT NULL,
    target TEXT NOT NULL,
    selector TEXT NOT NULL,
    value TEXT NOT NULL,
    rationale_hash TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (chain_id, tx_hash, log_index)
  );`;

/** Three legacy `actions` rows: two for AGENT (to prove spend aggregates survive). */
const LEGACY_ACTIONS_SEED = `
  INSERT INTO actions (tx_hash, block_number, agent_id, target, selector, value, rationale_hash, ts, chain_id)
  VALUES
    ('0x${"a1".repeat(32)}', 10, '${AGENT}', '${TARGET}', '${SELECTOR}', '100', '${RATIONALE}', 1700000000, 31337),
    ('0x${"a2".repeat(32)}', 20, '${AGENT2}', '${TARGET}', '${SELECTOR}', '250', '${RATIONALE}', 1700000100, 31337),
    ('0x${"a3".repeat(32)}', 30, '${AGENT}', '${TARGET}', '${SELECTOR}', '7', '${RATIONALE}', 1700000200, 31337)`;

const LEGACY_CHARGES_SEED = `
  INSERT INTO window_charges (tx_hash, account, key, value, window_start, spent_this_window, chain_id)
  VALUES ('0x${"c1".repeat(32)}', '${ACCOUNT}', '${KEY}', '42', 1700000000, '99', 31337)`;

let seq = 0;

/** A unique, isolated path per test. Callers clean up in `finally`. */
function tempPath(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return join(TMP_ROOT, `${label}-${process.pid}-${++seq}`);
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* the sandbox's bulk-delete guard can refuse a late rmSync; never fail a passing test */
  }
}

/** Opens a throwaway handle, runs `body`, and always closes it. */
function withDb<T>(path: string, body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

/** Creates a genuine legacy database: old schema, `user_version` 0, seeded rows. */
function seedLegacyDb(path: string, options: { charges?: boolean } = {}): void {
  withDb(path, (db) => {
    db.exec(`${LEGACY_ACTIONS}${LEGACY_CHARGES}`);
    db.exec(LEGACY_ACTIONS_SEED);
    if (options.charges !== false) db.exec(LEGACY_CHARGES_SEED);
  });
}

// ── introspection (raw handle, independent of the indexer under test) ──────────

const userVersion = (path: string): number =>
  withDb(path, (db) => Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version));

const tables = (path: string): string[] =>
  withDb(path, (db) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((t) => t.name)
      .sort(),
  );

const columns = (path: string, table: string): string[] =>
  withDb(path, (db) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  );

const countRows = (path: string, table: string): number =>
  withDb(path, (db) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n));

const rows = (path: string, table: string): Array<Record<string, unknown>> =>
  withDb(path, (db) => db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>);

const ledger = (path: string): Array<{ version: number; name: string; applied_at: number }> =>
  withDb(path, (db) =>
    db.prepare("SELECT version, name, applied_at FROM _migrations ORDER BY version").all() as Array<{
      version: number;
      name: string;
      applied_at: number;
    }>,
  );

/**
 * Reproduces the exact state the old non-transactional `migrate()` could leave behind:
 * `actions` rebuilt and copied, `actions_legacy` still present (the `DROP` never ran),
 * and `window_charges` still on the legacy schema (its step never started).
 */
function seedHalfMigratedDb(path: string): void {
  withDb(path, (db) => {
    db.exec(`${LEGACY_ACTIONS}${LEGACY_CHARGES}`);
    db.exec(LEGACY_ACTIONS_SEED);
    db.exec(LEGACY_CHARGES_SEED);
    // Crash after `CREATE TABLE actions`, before `DROP TABLE actions_legacy`:
    db.exec("ALTER TABLE actions RENAME TO actions_legacy");
    db.exec(CURRENT_ACTIONS);
    db.exec(`
      INSERT INTO actions
        (chain_id, tx_hash, log_index, block_number, block_hash, agent_id, target, selector, value, rationale_hash, ts)
      SELECT chain_id, tx_hash, rowid, block_number, NULL, agent_id, target, selector, value, rationale_hash, ts
      FROM actions_legacy`);
  });
}

/** The raw handle of a live indexer, for fault injection. */
const rawDb = (ix: SigilIndexer): DatabaseSync => (ix as unknown as { db: DatabaseSync }).db;

/** A `storeAction` record whose key is guaranteed not to collide with a fixture row. */
const freshRecord = (tx: string, value: bigint, logIndex = 0): Parameters<SigilIndexer["storeAction"]>[0] => ({
  agentId: AGENT,
  target: TARGET as `0x${string}`,
  selector: SELECTOR as `0x${string}`,
  value,
  rationaleHash: RATIONALE,
  timestamp: 1_700_000_500,
  txHash: tx as Hash,
  blockNumber: 40n,
  logIndex,
});

describe("migrate() — legacy database is migrated losslessly (BUG-07)", () => {
  it("preserves rows, backfills log_index from rowid, drops _legacy and stamps the version", () => {
    const path = tempPath("happy");
    let ix: SigilIndexer | undefined;
    try {
      seedLegacyDb(path);
      expect(userVersion(path)).toBe(0);
      expect(columns(path, "actions")).not.toContain("log_index");

      ix = new SigilIndexer(path, 31337, QUIET);

      // Row counts survive the table rebuild exactly.
      expect(countRows(path, "actions")).toBe(3);
      expect(countRows(path, "window_charges")).toBe(1);

      // `log_index` is backfilled from the legacy `rowid`; `block_hash` from NULL.
      const actions = rows(path, "actions").sort((a, b) => Number(a.block_number) - Number(b.block_number));
      expect(actions.map((r) => r.log_index)).toEqual([1, 2, 3]);
      expect(actions.every((r) => r.block_hash === null)).toBe(true);
      expect(actions.map((r) => r.value)).toEqual(["100", "250", "7"]);

      const charges = rows(path, "window_charges");
      expect(charges).toHaveLength(1);
      expect(charges[0]!.log_index).toBe(1);
      expect(charges[0]!.block_number).toBe(0); // the legacy table recorded no height
      expect(charges[0]!.value).toBe("42");

      // The new shape is in place and the rebuild residue is gone.
      expect(columns(path, "actions")).toEqual(expect.arrayContaining(["log_index", "block_hash"]));
      expect(columns(path, "window_charges")).toContain("log_index");
      expect(tables(path)).not.toContain("actions_legacy");
      expect(tables(path)).not.toContain("window_charges_legacy");

      // Version stamp + audit ledger.
      expect(userVersion(path)).toBe(SCHEMA_VERSION);
      expect(ledger(path)).toEqual([
        { version: SCHEMA_VERSION, name: "lossless-log-index-keys", applied_at: expect.any(Number) },
      ]);
      expect(ledger(path)[0]!.applied_at).toBeGreaterThan(1_600_000_000);

      // The migrated database is immediately usable, and the legacy keying is gone.
      expect(ix.summary()).toContain("3 audited actions across 2 agents");
      expect(ix.spendByAgent(AGENT)).toBe(107n); // 100 + 7, summed across both rows
      expect(ix.latestWindowCharge(KEY)?.value).toBe("42");
    } finally {
      ix?.close();
      removeQuietly(path);
    }
  });

  it("records the migration in a STRICT _migrations ledger that rejects bad rows", () => {
    const path = tempPath("ledger");
    let ix: SigilIndexer | undefined;
    try {
      seedLegacyDb(path, { charges: false });
      ix = new SigilIndexer(path, 31337, QUIET);
      ix.close();
      ix = undefined;

      // STRICT: a wrongly-typed row is rejected instead of being silently coerced.
      expect(() =>
        withDb(path, (db) =>
          db.prepare("INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)").run(2, "manual", "nope"),
        ),
      ).toThrow();

      // A read-only reopen sees the same rows — the ledger is a plain queryable table.
      const ro = new SigilIndexer(path, 31337, { ...QUIET, readOnly: true });
      expect(ro.summary()).toContain("3 audited actions");
      ro.close();
      expect(ledger(path)).toHaveLength(1);
    } finally {
      ix?.close();
      removeQuietly(path);
    }
  });
});

describe("migrate() — idempotency", () => {
  it("re-opening an already-migrated database re-runs nothing and never throws", () => {
    const path = tempPath("idempotent");
    let ix: SigilIndexer | undefined;
    try {
      seedLegacyDb(path);
      ix = new SigilIndexer(path, 31337, QUIET);
      // A post-migration write proves the reopened database stays fully functional.
      ix.storeAction(freshRecord("0x" + "e5".repeat(32), 9n), null);
      ix.close();
      ix = undefined;

      // Reopen repeatedly: no re-migration, no duplicated rows, version pinned.
      for (let i = 0; i < 3; i++) {
        const again = new SigilIndexer(path, 31337, QUIET);
        expect(again.summary()).toContain("4 audited actions");
        expect(again.latestWindowCharge(KEY)?.value).toBe("42");
        again.close();
      }

      expect(userVersion(path)).toBe(SCHEMA_VERSION);
      expect(countRows(path, "actions")).toBe(4);
      expect(countRows(path, "window_charges")).toBe(1);
      expect(ledger(path)).toHaveLength(1); // no duplicate ledger rows
      expect(tables(path)).not.toContain("actions_legacy");
    } finally {
      ix?.close();
      removeQuietly(path);
    }
  });
});

describe("migrate() — self-heals a half-migrated database", () => {
  it("completes the actions copy, repairs window_charges and clears the _legacy residue", () => {
    const path = tempPath("self-heal");
    let ix: SigilIndexer | undefined;
    try {
      // Precondition: the fixture really is in the mixed state described in BUG-07.
      seedHalfMigratedDb(path);
      expect(tables(path)).toContain("actions_legacy");
      expect(columns(path, "actions")).toContain("log_index");
      expect(columns(path, "window_charges")).not.toContain("log_index");
      expect(userVersion(path)).toBe(0);

      ix = new SigilIndexer(path, 31337, QUIET);

      // Both tables are now on the new schema and the residue is gone.
      expect(columns(path, "window_charges")).toContain("log_index");
      expect(tables(path)).not.toContain("actions_legacy");
      expect(tables(path)).not.toContain("window_charges_legacy");
      expect(countRows(path, "actions")).toBe(3);
      expect(countRows(path, "window_charges")).toBe(1);
      expect(userVersion(path)).toBe(SCHEMA_VERSION);
      expect(ix.summary()).toContain("3 audited actions across 2 agents");
      expect(ix.latestWindowCharge(KEY)?.value).toBe("42");
    } finally {
      ix?.close();
      removeQuietly(path);
    }
  });

  it("recovers rows that a crash left uncopied, using the surviving _legacy table", () => {
    const path = tempPath("self-heal-uncopied");
    let ix: SigilIndexer | undefined;
    try {
      // The harsher residue: the rebuild succeeded but the INSERT…SELECT never ran, so
      // the new table is empty and `actions_legacy` holds every original row.
      withDb(path, (db) => {
        db.exec(`${LEGACY_ACTIONS}${LEGACY_CHARGES}`);
        db.exec(LEGACY_ACTIONS_SEED);
        db.exec(LEGACY_CHARGES_SEED);
        db.exec("ALTER TABLE actions RENAME TO actions_legacy");
        db.exec(CURRENT_ACTIONS); // created, never populated
      });
      expect(countRows(path, "actions")).toBe(0);

      ix = new SigilIndexer(path, 31337, QUIET);

      // The interrupted copy is completed and the residue dropped.
      expect(countRows(path, "actions")).toBe(3);
      expect(ix.spendByAgent(AGENT)).toBe(107n);
      expect(tables(path)).not.toContain("actions_legacy");
      expect(userVersion(path)).toBe(SCHEMA_VERSION);
    } finally {
      ix?.close();
      removeQuietly(path);
    }
  });
});

describe("migrate() — fail-closed on a newer database", () => {
  it("refuses to open a database stamped with a newer user_version", () => {
    const path = tempPath("future");
    try {
      seedLegacyDb(path);
      withDb(path, (db) => db.exec("PRAGMA user_version = 99"));

      expect(() => new SigilIndexer(path, 31337, QUIET)).toThrow(/schema version is 99/);
      expect(() => new SigilIndexer(path, 31337, QUIET)).toThrow(/Refusing to open/);

      // Fail-closed: nothing was read, migrated or written.
      expect(userVersion(path)).toBe(99);
      expect(columns(path, "actions")).not.toContain("log_index");
      expect(countRows(path, "actions")).toBe(3);
      expect(tables(path)).not.toContain("actions_legacy");
      expect(tables(path)).not.toContain("_migrations");
    } finally {
      removeQuietly(path);
    }
  });
});

describe("migrate() — transactional boundary", () => {
  /** Makes the `n`-th call to `migrateTable` throw, to fail at a chosen step. */
  function failMigrateTableAt(call: number): () => void {
    const proto = SigilIndexer.prototype as unknown as { migrateTable: (step: unknown) => void };
    // Captured before the spy replaces it, so the first step runs for real and only the
    // chosen call throws — the database is left in a genuinely partial state.
    const real = proto.migrateTable;
    let calls = 0;
    const spy = vi.spyOn(proto, "migrateTable").mockImplementation(function (this: SigilIndexer, step: unknown) {
      if (++calls === call) throw new Error("synthetic migration failure");
      return real.call(this, step);
    });
    return () => spy.mockRestore();
  }

  it("leaves no mixed schema when a step fails after the first table was rebuilt", () => {
    const path = tempPath("rollback");
    try {
      seedLegacyDb(path);
      const restore = failMigrateTableAt(2); // actions rebuilt+copied, then throw
      try {
        expect(() => new SigilIndexer(path, 31337, QUIET)).toThrow("synthetic migration failure");
      } finally {
        restore();
      }

      // The RENAME/CREATE/INSERT/DROP of `actions` is rolled back with everything else:
      // the database is byte-for-byte the legacy shape it started as.
      expect(userVersion(path)).toBe(0);
      expect(columns(path, "actions")).not.toContain("log_index");
      expect(tables(path)).not.toContain("actions_legacy");
      expect(tables(path)).not.toContain("_migrations");
      expect(countRows(path, "actions")).toBe(3);
      expect(countRows(path, "window_charges")).toBe(1);
      expect(columns(path, "window_charges")).not.toContain("log_index");

      // …and a clean restart afterwards migrates it properly.
      const ix = new SigilIndexer(path, 31337, QUIET);
      expect(ix.summary()).toContain("3 audited actions");
      expect(userVersion(path)).toBe(SCHEMA_VERSION);
      ix.close();
    } finally {
      removeQuietly(path);
    }
  });

  it("leaves the database untouched when the very first step fails", () => {
    const path = tempPath("rollback-first");
    try {
      seedLegacyDb(path);
      const restore = failMigrateTableAt(1);
      try {
        expect(() => new SigilIndexer(path, 31337, QUIET)).toThrow("synthetic migration failure");
      } finally {
        restore();
      }
      expect(userVersion(path)).toBe(0);
      expect(tables(path)).not.toContain("_migrations");
      expect(countRows(path, "actions")).toBe(3);
    } finally {
      removeQuietly(path);
    }
  });

  it("reports the migration and rollback failures together when ROLLBACK itself fails", () => {
    const path = tempPath("rollback-fail");
    let handle: DatabaseSync | undefined;
    try {
      seedLegacyDb(path);
      // Pre-open the file so the test can poison the indexer's ROLLBACK via the prototype.
      const proto = SigilIndexer.prototype as unknown as { migrateTable: () => void };
      const step = vi.spyOn(proto, "migrateTable").mockImplementation(() => {
        throw new Error("synthetic migration failure");
      });
      // Poison every ROLLBACK on the class, so the indexer's own connection hits it.
      const execProto = DatabaseSync.prototype as unknown as { exec: (sql: string) => void };
      const realExec = execProto.exec;
      execProto.exec = function (this: DatabaseSync, sql: string) {
        if (sql === "ROLLBACK") throw new Error("synthetic rollback failure");
        return realExec.call(this, sql);
      };
      try {
        expect(() => new SigilIndexer(path, 31337, QUIET)).toThrow(
          /schema migration rollback failed/,
        );
      } finally {
        execProto.exec = realExec;
        step.mockRestore();
      }
      // The handle was closed rather than reused, and the on-disk version is untouched.
      expect(userVersion(path)).toBe(0);
      expect(countRows(path, "actions")).toBe(3);
    } finally {
      try {
        handle?.close();
      } catch {
        /* already closed by the AggregateError path */
      }
      removeQuietly(path);
    }
  });

  it("aborts the whole migration if the rebuild would lose a row", () => {
    const path = tempPath("lossless-gate");
    try {
      seedLegacyDb(path);
      // Force a lossy rebuild: a legacy rowid that cannot become a log_index.
      const proto = SigilIndexer.prototype as unknown as { assertNoRowsLost: () => void };
      const gate = vi.spyOn(proto, "assertNoRowsLost").mockImplementation(() => {
        throw new Error("synthetic losslessness failure");
      });
      try {
        expect(() => new SigilIndexer(path, 31337, QUIET)).toThrow("synthetic losslessness failure");
      } finally {
        gate.mockRestore();
      }
      // The abort rolled the rebuild back: still the untouched legacy database.
      expect(userVersion(path)).toBe(0);
      expect(columns(path, "actions")).not.toContain("log_index");
      expect(countRows(path, "actions")).toBe(3);
    } finally {
      removeQuietly(path);
    }
  });

  it("uses BEGIN IMMEDIATE so the migration cannot fail holding only a read lock", () => {
    const path = tempPath("begin-immediate");
    let ix: SigilIndexer | undefined;
    try {
      seedLegacyDb(path);
      const execProto = DatabaseSync.prototype as unknown as { exec: (sql: string) => void };
      const realExec = execProto.exec;
      const seen: string[] = [];
      execProto.exec = function (this: DatabaseSync, sql: string) {
        seen.push(sql.trim());
        return realExec.call(this, sql);
      };
      try {
        ix = new SigilIndexer(path, 31337, QUIET);
      } finally {
        execProto.exec = realExec;
      }
      expect(seen).toContain("BEGIN IMMEDIATE");
      expect(seen).toContain("COMMIT");
      expect(seen).not.toContain("ROLLBACK");
      // The version stamp is written inside the same transaction.
      expect(seen.some((sql) => sql.includes("user_version"))).toBe(true);
    } finally {
      ix?.close();
      removeQuietly(path);
    }
  });
});
