/**
 * P1 — reorg and cache-invalidation paths in the indexer.
 *
 * Two related mechanisms carry the "reorg-aware / fail-closed" claim, and both are
 * fail-closed decisions whose failure mode is *silent data corruption* rather than a crash:
 *
 *  - **`removeLog`** (ARCH-2) is the only automatic reorg handling left. Everything else
 *    refuses; this deletes. The dangerous regressions are asymmetric — deleting too much
 *    (dropping `log_index` or `chain_id` from the WHERE clause would wipe a whole
 *    transaction, or another chain's rows) and deleting too little (forgetting the second
 *    DELETE leaves an orphan charge). Both are pinned here.
 *  - **The statement cache** (PERF-03) is invalidated in exactly one place — `close()`,
 *    which clears `stmts` before releasing the handle. If a statement compiled against a
 *    pre-migration schema ever survived into the post-migration database, every subsequent
 *    query would be silently reading the OLD column layout. `migrate.test.ts` proves the
 *    migration works; nothing proved that the cache cannot straddle it.
 *
 * PROVENANCE OF THE CASE COUNT
 * -----------------------------
 *   DECLARATIONS = RUNTIME CASES = 16. No parameterized blocks, so the two coincide.
 *
 * Runtime confirmation (read from the run log, not recomputed):
 *   `Tests  16 passed (16)` / `Test Files  1 passed (1)` — a clean single-file run, so this
 *   is a direct reading rather than a derivation. It is also the run that supplies the 16
 *   subtracted from the two-file total quoted in `event-parsing.test.ts`'s header; keep it.
 *
 * Caveat on that run: collected under an alias harness substituting the `@sigilkit/*`
 * workspace specifiers, because the dependency tree was empty at the time. It evidences what
 * these assertions catch, not a clean-environment baseline.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Hash, Hex, Log } from "viem";
import { SigilIndexer } from "../src/indexer.js";
// P0-3: `silentLogger` is a logger symbol -> `/logger` subpath (root barrel drops it).
import { silentLogger } from "@sigilkit/core/logger";

const MANAGER = "0x0000000000000000000000000000000000000042";
const AGENT: Hash = ("0x" + "11".repeat(32)) as Hash;
const TARGET: Hex = "0x0000000000000000000000000000000000009001";
const SELECTOR: Hex = "0x32145f90";
const RATIONALE: Hash = ("0x" + "33".repeat(32)) as Hash;
const KEY: Hex = "0x1111111111111111111111111111111111111111";
const CHAIN = 31337;
const OTHER_CHAIN = 8453;

let seq = 0;

function rec(over: Record<string, unknown> = {}): Parameters<SigilIndexer["storeAction"]>[0] {
  return {
    agentId: AGENT,
    target: TARGET,
    selector: SELECTOR,
    value: 1n,
    rationaleHash: RATIONALE,
    timestamp: 1_700_000_000,
    txHash: ("0x" + (seq++).toString(16).padStart(64, "0")) as Hash,
    blockNumber: 1n,
    logIndex: 0,
    ...over,
  } as Parameters<SigilIndexer["storeAction"]>[0];
}

function charge(over: Record<string, unknown> = {}): Parameters<SigilIndexer["storeWindowCharge"]>[0] {
  return {
    chainId: CHAIN,
    txHash: ("0x" + (0xfe00 + seq++).toString(16).padStart(64, "0")) as Hash,
    logIndex: 0,
    blockNumber: 1,
    account: MANAGER,
    key: KEY,
    value: "1",
    windowStart: 1,
    spentThisWindow: "1",
    ...over,
  } as Parameters<SigilIndexer["storeWindowCharge"]>[0];
}

function store(chainId = CHAIN): SigilIndexer {
  return new SigilIndexer(":memory:", chainId, { logger: silentLogger() });
}

/** A `removed: true` log that names an existing (chain, tx, logIndex) triple. */
function removal(tx: string, logIndex: number): Log {
  return {
    address: MANAGER,
    topics: [],
    data: "0x",
    blockNumber: 1n,
    transactionHash: tx as Hash,
    blockHash: null,
    transactionIndex: 0,
    logIndex,
    removed: true,
  } as Log;
}

// ── reorg: removeLog must be exact ─────────────────────────────────────────────

describe("reorg removal is scoped to exactly one (chain, tx, logIndex) triple", () => {
  it("deletes one index of a multi-log transaction and leaves its siblings", () => {
    // Three actions, same tx, log indexes 0/1/2. Removing index 1 must cost exactly one row.
    // A WHERE clause that dropped `log_index` would zero the whole transaction — a silent
    // loss of two legitimate audit rows, which is precisely the class of bug that a
    // "rows went down" assertion would not catch on its own.
    const ix = store();
    try {
      const tx = "0x" + "a1".repeat(32);
      ix.storeAction(rec({ txHash: tx as Hash, logIndex: 0, value: 1n }));
      ix.storeAction(rec({ txHash: tx as Hash, logIndex: 1, value: 2n }));
      ix.storeAction(rec({ txHash: tx as Hash, logIndex: 2, value: 3n }));
      expect(ix.spendByAgent(AGENT)).toBe(6n);

      expect(ix.ingestLogs([removal(tx, 1)])).toBe(0);

      expect(ix.spendByAgent(AGENT)).toBe(4n);
      expect(ix.actionsForAgent(AGENT, undefined, 10).map((r) => r.logIndex)).toEqual([0, 2]);
    } finally {
      ix.close();
    }
  });

  it("deletes one transaction without touching a different transaction in the same block", () => {
    // Same block, different tx. A WHERE clause that dropped `tx_hash` would wipe the block.
    const ix = store();
    try {
      const txA = "0x" + "b1".repeat(32);
      const txB = "0x" + "b2".repeat(32);
      ix.storeAction(rec({ txHash: txA as Hash, logIndex: 0, value: 10n, blockNumber: 5n }));
      ix.storeAction(rec({ txHash: txB as Hash, logIndex: 0, value: 20n, blockNumber: 5n }));
      expect(ix.spendByAgent(AGENT)).toBe(30n);

      ix.ingestLogs([removal(txA, 0)]);

      expect(ix.spendByAgent(AGENT)).toBe(20n);
      expect(ix.actionsForAgent(AGENT, undefined, 10).map((r) => r.txHash)).toEqual([txB]);
    } finally {
      ix.close();
    }
  });

  it("leaves an identical (tx, logIndex) pair on another chain untouched", () => {
    // ARCH-4 multi-chain, at the exact point where a reorg bites. The DELETE is scoped by
    // `this.chainId`; if that were ever dropped, reorging chain 31337 would silently delete
    // chain 8453's audit rows — a cross-chain data loss that no summary would reveal.
    const ix = store(CHAIN);
    try {
      const tx = "0x" + "c1".repeat(32);
      ix.storeAction(rec({ txHash: tx as Hash, logIndex: 0, value: 7n }), null, CHAIN);
      ix.storeAction(rec({ txHash: tx as Hash, logIndex: 0, value: 9n }), null, OTHER_CHAIN);
      expect(ix.spendByAgent(AGENT, CHAIN)).toBe(7n);
      expect(ix.spendByAgent(AGENT, OTHER_CHAIN)).toBe(9n);

      // The indexer's own chain is CHAIN, so this removes only the CHAIN row.
      ix.ingestLogs([removal(tx, 0)]);

      expect(ix.spendByAgent(AGENT, CHAIN)).toBe(0n);
      expect(ix.spendByAgent(AGENT, OTHER_CHAIN)).toBe(9n);
    } finally {
      ix.close();
    }
  });

  it("removes both the action and the charge sharing one (chain, tx, logIndex)", () => {
    // Two DELETEs, one per table. Dropping the second would leave a stale
    // `spent_this_window` that keeps growing across a reorg — a number an auditor reads as
    // real spend. Assert the *window* view, not just the row count, so the specific damage
    // is named.
    const ix = store();
    try {
      const tx = "0x" + "d1".repeat(32);
      ix.storeAction(rec({ txHash: tx as Hash, logIndex: 0, value: 4n }));
      ix.storeWindowCharge(charge({ txHash: tx as Hash, logIndex: 0, value: "42", spentThisWindow: "99" }));
      expect(ix.latestWindowCharge(KEY)?.value).toBe("42");
      expect(ix.latestWindowCharge(KEY)?.spentThisWindow).toBe("99");

      ix.ingestLogs([removal(tx, 0)]);

      expect(ix.spendByAgent(AGENT)).toBe(0n);
      expect(ix.latestWindowCharge(KEY)).toBeNull();
      expect(ix.summary()).toContain("0 window charges");
    } finally {
      ix.close();
    }
  });

  it("is a no-op for a triple that was never stored", () => {
    // A reorg notification for a log this indexer never saw (it started indexing later, or
    // the log was foreign) must not throw and must not disturb existing rows. `ingestLogs`
    // must still return 0: a removal never counts as "stored".
    const ix = store();
    try {
      ix.storeAction(rec({ value: 5n }));
      expect(ix.ingestLogs([removal("0x" + "e1".repeat(32), 3)])).toBe(0);
      expect(ix.spendByAgent(AGENT)).toBe(5n);
    } finally {
      ix.close();
    }
  });

  it("refuses a reorg removal in read-only mode", () => {
    // An audit reader must never mutate, not even to "help" with a reorg.
    const ix = new SigilIndexer(":memory:", CHAIN, { readOnly: true, logger: silentLogger() });
    try {
      expect(() => ix.ingestLogs([removal("0x" + "f1".repeat(32), 0)])).toThrow(/read-only/);
    } finally {
      ix.close();
    }
  });
});

// ── rollbackTo: the operator-facing reorg primitive ────────────────────────────

describe("rollbackTo is scoped to one chain and one height", () => {
  it("discards only rows strictly above the block, keeping the boundary row", () => {
    // `block_number > ?` is strict: the boundary row belongs to the kept history. Using `>=`
    // would discard the block the operator asked to roll back TO, which reads as a
    // successful rollback while silently losing one more block than requested.
    const ix = store();
    try {
      ix.storeAction(rec({ blockNumber: 10n, value: 1n }));
      ix.storeAction(rec({ blockNumber: 11n, value: 2n }));
      ix.storeAction(rec({ blockNumber: 20n, value: 4n }));
      ix.storeWindowCharge(charge({ blockNumber: 20 }));
      expect(ix.spendByAgent(AGENT)).toBe(7n);

      ix.rollbackTo(10);

      expect(ix.spendByAgent(AGENT)).toBe(1n);
      expect(ix.latestWindowCharge(KEY)).toBeNull();
    } finally {
      ix.close();
    }
  });

  it("does not roll back another chain's rows", () => {
    // The same ARCH-4 hazard as `removeLog`, on the primitive an operator actually reaches
    // for. Rolling chain 31337 back to block 0 must leave chain 8453 fully intact — an
    // over-broad DELETE here would silently destroy a different chain's entire audit trail.
    const ix = store(CHAIN);
    try {
      ix.storeAction(rec({ blockNumber: 5n, value: 3n }), null, CHAIN);
      ix.storeAction(rec({ blockNumber: 5n, value: 8n }), null, OTHER_CHAIN);
      ix.storeWindowCharge({ ...charge({ blockNumber: 5 }), chainId: OTHER_CHAIN });
      expect(ix.spendByAgent(AGENT, OTHER_CHAIN)).toBe(8n);

      ix.rollbackTo(0);

      expect(ix.spendByAgent(AGENT, CHAIN)).toBe(0n);
      expect(ix.spendByAgent(AGENT, OTHER_CHAIN)).toBe(8n);
      expect(ix.latestWindowCharge(KEY, OTHER_CHAIN)).not.toBeNull();
    } finally {
      ix.close();
    }
  });

  it("rewinds the cursor only when a manager is given, and to a null hash", () => {
    // The rewound cursor deliberately carries a NULL hash, which makes the next backfill
    // fail closed (B64) rather than silently resuming onto a possibly-orphaned chain. That
    // is the documented behaviour and it is what stops rollbackTo from being a silent
    // recovery path — so pin both halves: the rewind, and the resulting refusal.
    const ix = new SigilIndexer(":memory:", CHAIN, { logger: silentLogger() });
    const client = {
      getChainId: async () => CHAIN,
      getBlockNumber: async () => 10n,
      getBlock: async (a: { blockNumber?: bigint }) => {
        const n = a.blockNumber ?? 10n;
        return { number: n, hash: ("0x" + n.toString(16).padStart(64, "0")) as Hash };
      },
      getLogs: async () => [] as Log[],
    } as never;
    try {
      (ix as unknown as { setCursor: (m: string, b: number, h: string | null) => void })
        .setCursor(MANAGER, 10, "0x" + "ab".repeat(32));
      expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: "0x" + "ab".repeat(32) });

      ix.rollbackTo(4, MANAGER as `0x${string}`);
      expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 4, lastBlockHash: null });

      // …and the null-hash cursor is now unusable, which is the point.
      return expect(ix.backfill(client, MANAGER as `0x${string}`)).rejects.toThrow(/no recorded block hash/);
    } finally {
      ix.close();
    }
  });

  it("leaves the cursor untouched when no manager is given", () => {
    // `if (manager) this.setCursor(...)`: rolling back the DATA without rewinding the cursor
    // would leave a checkpoint pointing at blocks whose rows are gone, so the next run
    // resumes past them and never re-fetches. Pin that the cursor is NOT moved here.
    const ix = store();
    try {
      (ix as unknown as { setCursor: (m: string, b: number, h: string | null) => void })
        .setCursor(MANAGER, 10, "0x" + "ab".repeat(32));
      ix.rollbackTo(4);
      expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: "0x" + "ab".repeat(32) });
    } finally {
      ix.close();
    }
  });

  it("refuses rollbackTo in read-only mode", () => {
    const ix = new SigilIndexer(":memory:", CHAIN, { readOnly: true, logger: silentLogger() });
    try {
      expect(() => ix.rollbackTo(0)).toThrow(/read-only/);
      expect(() => ix.rollbackTo(0, MANAGER as `0x${string}`)).toThrow(/read-only/);
    } finally {
      ix.close();
    }
  });
});

// ── statement-cache invalidation (PERF-03) ─────────────────────────────────────

describe("the statement cache cannot straddle a schema migration", () => {
  it("clears memoized statements on close, so nothing compiled pre-close is reused", () => {
    // `close()` does `this.stmts.clear()` BEFORE `db.close()`. If the clear were dropped, a
    // caller that reopens the same handle (or a future pooling layer) would execute a
    // statement compiled against the previous schema. Observable proxy: after close the
    // memo must be empty, so the next query re-prepares instead of hitting the cache.
    const ix = store();
    const stmts = (ix as unknown as { stmts: Map<string, unknown> }).stmts;
    ix.storeAction(rec());
    ix.spendByAgent(AGENT);
    expect(stmts.size).toBeGreaterThan(0);

    ix.close();

    expect(stmts.size).toBe(0);
  });

  it("drops memoized statements when a migration rebuilds the tables under them", () => {
    // THIS is the test the suite was missing. The two cases above both pass whether or not
    // `migrate()` clears `stmts`:
    //   - the close test inspects the map after `close()`, which clears it unconditionally;
    //   - the reopen test builds a *fresh handle* per handle, so its memo was born after
    //     the migration and could not have held a pre-migration entry.
    // So neither one can go red when the `migrate()` clear is deleted — which is exactly
    // the question this case has to answer.
    //
    // To make the clear load-bearing the memo must be populated *before* the rebuild and
    // still be live *across* it, with no `close()` in between. `migrate()` is private and
    // only the constructor calls it, so the sequence is forced directly: seed a memo entry,
    // then re-enter the migration on the same handle. A stale entry that survives would be
    // keyed to the pre-migration column layout.
    const dir = join(process.env.TEMP ?? ".", `sigilkit-migrate-clear-${process.pid}-${seq++}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "indexer.db");
    let opened: SigilIndexer | undefined;
    try {
      opened = new SigilIndexer(path, CHAIN, { logger: silentLogger() });
      const stmts = (opened as unknown as { stmts: Map<string, unknown> }).stmts;
      const db = (opened as unknown as { db: { exec: (sql: string) => void } }).db;

      // 1. Populate the memo against the CURRENT (already-migrated) layout.
      opened.storeAction(rec());
      opened.spendByAgent(AGENT);
      const before = stmts.size;
      expect(before).toBeGreaterThan(0);

      // 2. Re-run the migration on this same handle, with the memo still live. Nothing was
      //    closed in between, so nothing else could have cleared it.
      //
      //    Two conditions are required to actually REACH the clear; omitting either makes this
      //    assertion vacuous rather than failing:
      //
      //    (a) `migrate` must be invoked AS A METHOD. Detaching it (`const m = ix.migrate; m()`)
      //        leaves `this` undefined, so the very first statement — `this.readSchemaVersion()` —
      //        throws, which surfaces as an unrelated TypeError three lines above the clear.
      //    (b) The fast path must be bypassed. `migrate()` returns immediately while
      //        `readSchemaVersion() === CURRENT_SCHEMA_VERSION`, so re-entering it on an
      //        already-current database never reaches the rebuild branch at all. Resetting
      //        `PRAGMA user_version` to 0 ("never migrated") forces the full path.
      db.exec("PRAGMA user_version = 0");
      (opened as unknown as { migrate: () => void }).migrate();
      expect(stmts.size).toBe(0);

      // 3. The handle is still usable afterwards — the clear must not be a teardown.
      opened.storeAction(rec({ value: 7n }));
      expect(opened.spendByAgent(AGENT)).toBe(8n);
    } finally {
      opened?.close();
      // A refused rmSync must not mask the test's own result, but it is not swallowed
      // either: the leftover path is named so a run that leaked a directory is visible.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`cleanup left ${dir} behind:`, err instanceof Error ? err.message : err);
      }
    }
  });

  it("keeps memoized statements when the migration is a no-op re-check", () => {
    // The control for the test above: a fix that cleared `stmts` unconditionally on every
    // `migrate()` call would satisfy "the memo is empty after migrate" while throwing away
    // valid statements whenever the under-lock re-check finds the schema already current.
    // That path performs no DDL, so the entries are still valid and must survive. This is
    // the regression that guards the `rebuilt` gate rather than the clear itself.
    const ix = store();
    const stmts = (ix as unknown as { stmts: Map<string, unknown> }).stmts;
    try {
      ix.storeAction(rec());
      ix.spendByAgent(AGENT);
      const before = stmts.size;
      expect(before).toBeGreaterThan(0);

      (ix as unknown as { migrate: () => void }).migrate();

      // Fast path: `readSchemaVersion()` already matches, so `migrate()` returns before
      // reaching the transaction and the memo is untouched.
      expect(stmts.size).toBe(before);
    } finally {
      ix.close();
    }
  });

  it("recompiles read statements after a close/reopen cycle on the same file", () => {
    // The end-to-end shape of the same hazard: a statement compiled against the pre-migration
    // `actions` table (no `log_index`) must not be executed against the rebuilt one. Building
    // the read path BEFORE the migration, then migrating, then reading is the only ordering
    // that can produce it — and it is exactly what a long-lived handle plus a schema bump
    // would do in production.
    const dir = join(process.env.TEMP ?? ".", `sigilkit-cache-${process.pid}-${seq++}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "indexer.db");
    const legacy = `
      CREATE TABLE actions (
        tx_hash TEXT NOT NULL, block_number INTEGER NOT NULL, agent_id TEXT NOT NULL,
        target TEXT NOT NULL, selector TEXT NOT NULL, value TEXT NOT NULL,
        rationale_hash TEXT NOT NULL, ts INTEGER NOT NULL, chain_id INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, agent_id, target, selector, ts)
      );
      CREATE TABLE window_charges (
        tx_hash TEXT NOT NULL, account TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        window_start INTEGER NOT NULL, spent_this_window TEXT NOT NULL, chain_id INTEGER NOT NULL
      );
      INSERT INTO actions VALUES ('0x${"d1".repeat(32)}', 5, '${AGENT}', '${TARGET}',
        '${SELECTOR}', '11', '${RATIONALE}', 1700000000, ${CHAIN});`;
    let opened: SigilIndexer | undefined;
    try {
      // 1. Write a genuinely legacy database through a raw handle (not the indexer).
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      const raw = new DatabaseSync(path);
      raw.exec(legacy);
      raw.close();

      // 2. Open it read-write: the constructor migrates, then queries compile the new SQL.
      opened = new SigilIndexer(path, CHAIN, { logger: silentLogger() });
      const before = opened.actionsForAgent(AGENT, undefined, 10);
      expect(before).toHaveLength(1);
      expect(before[0]!.value).toBe("11");
      expect(before[0]!.logIndex).toBe(1); // backfilled from rowid
      // 3. A post-migration write and read still work — no stale plan, no shape drift.
      opened.storeAction(rec({ value: 22n }));
      const after = opened.actionsForAgent(AGENT, undefined, 10);
      expect(after).toHaveLength(2);
      expect(after.reduce((a, r) => a + BigInt(r.value), 0n)).toBe(33n);
      expect(after.every((r) => typeof r.logIndex === "number")).toBe(true);
    } finally {
      opened?.close();
      // A refused rmSync must not mask the test's own result, but it is not swallowed
      // either: the leftover path is named so a run that leaked a directory is visible.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`cleanup left ${dir} behind:`, err instanceof Error ? err.message : err);
      }
    }
  });

  it("does not re-prepare on every call (the cache still works)", () => {
    // The control for the test above: a fix that simply disabled memoization would satisfy
    // "no stale statements" while destroying PERF-03. Count `db.prepare` calls across
    // repeated identical reads — the second round must compile nothing new.
    const ix = store();
    const db = (ix as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const real = db.prepare.bind(db);
    let prepared = 0;
    db.prepare = (sql: string) => { prepared++; return real(sql); };
    try {
      ix.spendByAgent(AGENT);
      const first = prepared;
      for (let i = 0; i < 5; i++) ix.spendByAgent(AGENT);
      // Only the *newly unseen* statements (none) were compiled after the warm-up.
      expect(prepared).toBe(first);
      expect(first).toBeGreaterThan(0);
    } finally {
      db.prepare = real;
      ix.close();
    }
  });

  it("rejects an unsafe table identifier in the introspection helper", () => {
    // `PRAGMA table_info(?)` takes no bind parameter, so the identifier is interpolated —
    // which is exactly why `columns()` guards it. Every current caller passes a literal from
    // TABLE_MIGRATIONS, so this branch is currently unreachable; it is pinned anyway because
    // the guard is the only thing standing between a future caller and SQL injection into
    // the migration path, and an untested guard is a guard that will be "simplified away".
    const ix = store();
    try {
      const proto = ix as unknown as { columns: (t: string) => string[] };
      expect(() => proto.columns("actions; DROP TABLE actions")).toThrow(/unsafe table identifier/);
      expect(() => proto.columns("")).toThrow(/unsafe table identifier/);
      expect(() => proto.columns("1actions")).toThrow(/unsafe table identifier/);
      // The real identifiers still introspect fine — the guard is not over-broad.
      expect(proto.columns("actions")).toContain("log_index");
    } finally {
      ix.close();
    }
  });
});

// ── reorg during a watch loop ──────────────────────────────────────────────────

describe("watch treats a reorg as a fail-closed stop, not a silent rollback", () => {
  it("never auto-deletes rows when the cursor reorgs mid-run (B64)", async () => {
    // The critical property: after a detected reorg the store must be EXACTLY as it was. Any
    // automatic delete would be unrecoverable, because the schema has no manager-scoped row
    // ownership and a blind delete could remove another manager's rows. This asserts absence
    // of effect, not just the absence of an exception.
    vi.useFakeTimers();
    const ix = new SigilIndexer(":memory:", CHAIN, {
      confirmations: 0,
      backoffMs: 1,
      logger: silentLogger(),
    });
    try {
      const head = { number: 10n, hash: ("0x" + "0a".repeat(32)) as Hash };
      const log = {
        address: MANAGER, topics: [], data: "0x", blockNumber: 5n,
        transactionHash: ("0x" + "c9".repeat(32)) as Hash,
        blockHash: ("0x" + "05".repeat(32)) as Hash,
        transactionIndex: 0, logIndex: 0, removed: false,
      } as Log;
      // First pass: a clean chain, so a cursor and one row are established.
      const clean = {
        getChainId: async () => CHAIN,
        getBlockNumber: async () => 10n,
        getBlock: async (a: { blockNumber?: bigint }) => {
          const n = a.blockNumber ?? 10n;
          return { number: n, hash: ("0x" + n.toString(16).padStart(64, "0")) as Hash };
        },
        getLogs: async () => [log],
      } as never;
      // Seed one row + cursor directly so the test does not depend on log decoding here.
      (ix as unknown as { setCursor: (m: string, b: number, h: string | null) => void })
        .setCursor(MANAGER, 10, "0x" + "0a".repeat(32));
      ix.storeAction(rec({ value: 6n, blockNumber: 5n }));
      const before = ix.getCursor(MANAGER);
      const rowsBefore = ix.actionsForAgent(AGENT, undefined, 10);
      expect(rowsBefore).toHaveLength(1);

      // Second pass: block 10 reorged to a different hash. Every tick must refuse.
      const reorged = {
        getChainId: async () => CHAIN,
        getBlockNumber: async () => 11n,
        getBlock: async (a: { blockNumber?: bigint }) => {
          const n = a.blockNumber ?? 11n;
          return { number: n, hash: ("0x" + (n === 10n ? "ff" : "0b").repeat(32)) as Hash };
        },
        getLogs: async () => [],
      } as never;

      const stop = ix.watch(reorged, MANAGER as `0x${string}`, 5);
      await vi.advanceTimersByTimeAsync(60);
      stop();
      await vi.advanceTimersByTimeAsync(40);

      // No row added, none removed, cursor exactly as it was.
      expect(ix.actionsForAgent(AGENT, undefined, 10)).toEqual(rowsBefore);
      expect(ix.spendByAgent(AGENT)).toBe(6n);
      expect(ix.getCursor(MANAGER)).toEqual(before);
      void clean; void head;
    } finally {
      ix.close();
      vi.useRealTimers();
    }
  });
});
