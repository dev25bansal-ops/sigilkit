/**
 * Query-plan and row-ceiling regressions for the read path (PERF-01/02/03/05).
 *
 * These assert on the *actual* SQL `SigilIndexer` executes: every call is captured off
 * `db.prepare` and the captured text is then handed to `EXPLAIN QUERY PLAN` with the same
 * bound arguments. Re-typing the query into the test would let the two drift apart — the
 * test would keep passing against a shape the product no longer uses, which is exactly the
 * regression these guard against.
 *
 * PERF-01 is the load-bearing one. The pre-fix schema led every index with `chain_id`, so
 * the default cross-chain queries could use none of them and fell back to a full table scan
 * (measured 12.2 ms vs 0.01 ms chain-scoped at 200k rows). These tests fail if those
 * indexes are dropped, renamed, or reordered — `EXPLAIN QUERY PLAN` is the only place that
 * truth is observable, and it is asserted on both the chain-scoped and chain-less paths.
 */
import { describe, expect, it } from "vitest";
import type { Address, Hash, Hex } from "viem";
import { SigilIndexer, type StoredAction } from "../src/indexer.js";
// P0-3: `silentLogger` is a logger symbol -> `/logger` subpath (root barrel drops it).
import { silentLogger } from "@sigilkit/core/logger";

const AGENT: Hash = ("0x" + "11".repeat(32)) as Hash;
const OTHER_AGENT: Hash = ("0x" + "12".repeat(32)) as Hash;
const TARGET: Address = "0x0000000000000000000000000000000000009001";
const OTHER_TARGET: Address = "0x0000000000000000000000000000000000009002";
const SELECTOR: Hex = "0x32145f90" as Hex;
const RATIONALE: Hash = ("0x" + "33".repeat(32)) as Hash;
const KEY: Address = "0x1111111111111111111111111111111111111111";
const CHAIN_A = 8453;
const CHAIN_B = 31337;

interface Call {
  sql: string;
  args: unknown[];
}

/**
 * Runs `fn` with `db.prepare` instrumented, returning every statement the call compiled.
 *
 * `SigilIndexer` memoizes statements (PERF-03), so a repeated query never reaches
 * `db.prepare` again — each capture therefore reflects a genuinely cold compile.
 */
function capture(ix: SigilIndexer, fn: () => void): Call[] {
  const db = (ix as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown } } }).db;
  const original = db.prepare.bind(db);
  const calls: Call[] = [];
  db.prepare = (sql: string) => {
    const statement = original(sql);
    calls.push({
      sql,
      args: [],
    });
    return {
      run: (...args: unknown[]) => { calls[calls.length - 1]!.args = args; return statement.run(...args); },
      all: (...args: unknown[]) => { calls[calls.length - 1]!.args = args; return statement.all(...args); },
      get: (...args: unknown[]) => { calls[calls.length - 1]!.args = args; return statement.get(...args); },
    };
  };
  try {
    fn();
  } finally {
    db.prepare = original;
  }
  return calls;
}

/** The SQLite plan rows for a captured statement, as human-readable detail strings. */
function explain(ix: SigilIndexer, call: Call): string[] {
  const db = (ix as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } }).db;
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.args) as Array<{ detail: string }>;
  return rows.map((r) => r.detail);
}

/** Index names present in the store, for the "the indexes are really there" assertion. */
function indexNames(ix: SigilIndexer): string[] {
  const db = (ix as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }).db;
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>)
    .map((r) => r.name)
    .sort();
}

let txCounter = 0;
/** A distinct natural key per call so each action is its own row (BUG-5 key shape). */
function record(i: number, chainId: number, overrides: Partial<Parameters<SigilIndexer["storeAction"]>[0]> = {}) {
  return {
    agentId: AGENT,
    target: TARGET,
    selector: SELECTOR,
    value: 1n,
    rationaleHash: RATIONALE,
    timestamp: 1_700_000_000 + i,
    txHash: ("0x" + (chainId * 1_000_000 + (txCounter++)).toString(16).padStart(64, "0")) as Hash,
    blockNumber: BigInt(1_000_000 + i),
    logIndex: 0,
    ...overrides,
  } as Parameters<SigilIndexer["storeAction"]>[0];
}

describe("PERF-01: every read path resolves through an index", () => {
  /** A store with rows on two chains, so a chain filter actually discriminates. */
  function seeded(): SigilIndexer {
    const ix = new SigilIndexer(":memory:", CHAIN_A, { logger: silentLogger() });
    ix.storeAction(record(1, CHAIN_A), null, CHAIN_A);
    ix.storeAction(record(2, CHAIN_B, { agentId: OTHER_AGENT, target: OTHER_TARGET }), null, CHAIN_B);
    return ix;
  }

  it("creates the *_only indexes alongside the (chain_id, …) ones", () => {
    const ix = seeded();
    try {
      const names = indexNames(ix);
      // The chain-leading indexes must survive: they are still the right choice for a
      // chain-scoped query, and dropping them would regress multi-chain semantics.
      expect(names).toEqual(
        expect.arrayContaining([
          "idx_actions_agent",
          "idx_actions_target",
          "idx_charges_key",
          "idx_actions_agent_only",
          "idx_actions_target_only",
          "idx_charges_key_only",
        ]),
      );
    } finally {
      ix.close();
    }
  });

  // Each case: chain-scoped and cross-chain, so neither leading-column mistake can hide.
  const cases: Array<{ name: string; call: (ix: SigilIndexer) => void; table: string }> = [
    { name: "spendByAgent", table: "actions", call: (ix) => { ix.spendByAgent(AGENT); } },
    { name: "spendByAgent(agentId, chainId)", table: "actions", call: (ix) => { ix.spendByAgent(AGENT, CHAIN_A); } },
    { name: "actionsForAgent", table: "actions", call: (ix) => { ix.actionsForAgent(AGENT, undefined, 5); } },
    { name: "actionsForAgent(agentId, chainId)", table: "actions", call: (ix) => { ix.actionsForAgent(AGENT, CHAIN_A, 5); } },
    { name: "actionsForTarget", table: "actions", call: (ix) => { ix.actionsForTarget(TARGET, undefined, 5); } },
    { name: "actionsForTarget(target, chainId)", table: "actions", call: (ix) => { ix.actionsForTarget(TARGET, CHAIN_A, 5); } },
    { name: "latestWindowCharge", table: "window_charges", call: (ix) => { ix.latestWindowCharge(KEY); } },
    { name: "latestWindowCharge(key, chainId)", table: "window_charges", call: (ix) => { ix.latestWindowCharge(KEY, CHAIN_A); } },
  ];

  it.each(cases)("$name plans an indexed SEARCH, never a full scan", ({ call, table }) => {
    const ix = seeded();
    try {
      const calls = capture(ix, () => call(ix));
      expect(calls.length).toBeGreaterThan(0);
      for (const captured of calls) {
        const plan = explain(ix, captured);
        // `SCAN <table>` is the full-table fallback this whole suite exists to prevent.
        // Matching on the table name keeps an unrelated "SCAN (subquery-1)" (the
        // N-row sorter inside the LIMIT subquery) from being mistaken for one.
        expect(plan, `plan for ${captured.sql}`).not.toContain(`SCAN ${table}`);
        expect(plan.join(" "), `plan for ${captured.sql}`).toContain(`SEARCH ${table} USING INDEX`);
      }
    } finally {
      ix.close();
    }
  });

  it("spendByAgent cross-chain still aggregates every chain (index must not filter)", () => {
    const ix = new SigilIndexer(":memory:", CHAIN_A, { logger: silentLogger() });
    try {
      ix.storeAction(record(1, CHAIN_A, { value: 7n }), null, CHAIN_A);
      ix.storeAction(record(2, CHAIN_B, { value: 5n }), null, CHAIN_B);
      // The *_only index leads with agent_id, so the chain-less path spans both chains.
      expect(ix.spendByAgent(AGENT)).toBe(12n);
      expect(ix.spendByAgent(AGENT, CHAIN_A)).toBe(7n);
      expect(ix.spendByAgent(AGENT, CHAIN_B)).toBe(5n);
    } finally {
      ix.close();
    }
  });
});

describe("PERF-02: row ceiling is pushed into SQL, not applied after materialization", () => {
  /** 1 000 rows for one agent, one per block, so "most recent" is unambiguous. */
  function withRows(count: number): SigilIndexer {
    const ix = new SigilIndexer(":memory:", CHAIN_A, { logger: silentLogger() });
    for (let i = 0; i < count; i++) ix.storeAction(record(i, CHAIN_A), null, CHAIN_A);
    return ix;
  }

  it("returns exactly the newest N rows for an explicit limit", () => {
    const ix = withRows(1_000);
    try {
      const rows = ix.actionsForAgent(AGENT, undefined, 10);
      expect(rows).toHaveLength(10);
      // The most recent 10, still returned oldest-first as the API promises.
      const blocks = rows.map((r) => r.blockNumber);
      expect(blocks).toEqual([1_000_990, 1_000_991, 1_000_992, 1_000_993, 1_000_994, 1_000_995, 1_000_996, 1_000_997, 1_000_998, 1_000_999]);
      // …and identical to the tail of the unbounded listing, not merely "10 rows".
      const all = ix.actionsForAgent(AGENT, undefined, 1_000);
      expect(rows).toEqual(all.slice(-10));
    } finally {
      ix.close();
    }
  });

  it("bounds the row set in SQL — the inner query carries the LIMIT", () => {
    const ix = withRows(1_000);
    try {
      const calls = capture(ix, () => { ix.actionsForAgent(AGENT, undefined, 10); });
      expect(calls).toHaveLength(1);
      // A caller-side `.slice(-n)` cannot be fixed in SQL; the DESC/LIMIT subquery can.
      // DESC inside plus ASC outside is the shape that walks the index backwards and stops
      // at N, rather than reading every matching row and discarding most of them.
      expect(calls[0]!.sql).toMatch(/ORDER BY block_number DESC, log_index DESC\s+LIMIT/i);
      expect(calls[0]!.sql).toMatch(/ORDER BY block_number ASC, log_index ASC/);
    } finally {
      ix.close();
    }
  });

  it("returns fewer than the limit when fewer rows match", () => {
    const ix = withRows(3);
    try {
      expect(ix.actionsForAgent(AGENT, undefined, 10)).toHaveLength(3);
      expect(ix.actionsForTarget(TARGET, undefined, 10)).toHaveLength(3);
    } finally {
      ix.close();
    }
  });

  it("applies the same ceiling to actionsForTarget", () => {
    const ix = new SigilIndexer(":memory:", CHAIN_A, { logger: silentLogger() });
    try {
      for (let i = 0; i < 50; i++) {
        ix.storeAction(record(i, CHAIN_A, { target: TARGET }), null, CHAIN_A);
        ix.storeAction(record(1000 + i, CHAIN_A, { target: OTHER_TARGET }), null, CHAIN_A);
      }
      const recent = ix.actionsForTarget(TARGET, undefined, 5);
      expect(recent).toHaveLength(5);
      expect(recent.every((r: StoredAction) => r.target === TARGET)).toBe(true);
      expect(recent.map((r) => r.blockNumber)).toEqual([1_000_045, 1_000_046, 1_000_047, 1_000_048, 1_000_049]);
    } finally {
      ix.close();
    }
  });

  // Fail-closed: an implicit call over the ceiling must refuse, never quietly truncate.
  it("throws rather than silently truncating when the implicit ceiling is exceeded", () => {
    const ix = withRows(1_001);
    try {
      expect(() => ix.actionsForAgent(AGENT)).toThrow(/Refusing to silently truncate/);
      expect(() => ix.actionsForTarget(TARGET)).toThrow(/Refusing to silently truncate/);
      // The message must say what to do, not just that it failed.
      expect(() => ix.actionsForAgent(AGENT)).toThrow(/pass an explicit limit/);
      // An explicit limit is the documented way through, and must not throw.
      expect(ix.actionsForAgent(AGENT, undefined, 1_001)).toHaveLength(1_001);
    } finally {
      ix.close();
    }
  });

  it("stays backward compatible: no limit keeps returning every matching row", () => {
    const ix = withRows(1_000);
    try {
      // Exactly at the ceiling is not "over" it — the historical call must still work.
      expect(ix.actionsForAgent(AGENT)).toHaveLength(1_000);
      expect(ix.actionsForAgent(AGENT, CHAIN_A)).toHaveLength(1_000);
    } finally {
      ix.close();
    }
  });

  // A sentinel that reused the ceiling's own value could not tell "the caller asked for
  // 1 000" from "the caller asked for nothing", so the explicit request wrongly threw.
  it("honours an explicit limit equal to the implicit ceiling", () => {
    const ix = withRows(1_500);
    try {
      expect(ix.actionsForAgent(AGENT, undefined, 1_000)).toHaveLength(1_000);
      expect(ix.actionsForTarget(TARGET, undefined, 1_000)).toHaveLength(1_000);
      // …while omitting it still fails closed over the ceiling.
      expect(() => ix.actionsForAgent(AGENT)).toThrow(/Refusing to silently truncate/);
    } finally {
      ix.close();
    }
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects a non-positive-integer limit (%s)", (bad) => {
    const ix = withRows(5);
    try {
      expect(() => ix.actionsForAgent(AGENT, undefined, bad)).toThrow(/positive integer/);
    } finally {
      ix.close();
    }
  });
});

describe("PERF-03: prepared statements are memoized across calls", () => {
  it("compiles a hot write statement once and reuses it", () => {
    const ix = new SigilIndexer(":memory:", CHAIN_A, { logger: silentLogger() });
    try {
      // First call compiles; the statement is cached, so later calls never reach prepare.
      const first = capture(ix, () => { ix.storeAction(record(1, CHAIN_A), null, CHAIN_A); });
      expect(first).toHaveLength(1);
      const second = capture(ix, () => { ix.storeAction(record(2, CHAIN_A), null, CHAIN_A); });
      expect(second).toHaveLength(0);
      // The row still landed — caching must not change the write's effect.
      expect(ix.actionsForAgent(AGENT, CHAIN_A, 10)).toHaveLength(2);
    } finally {
      ix.close();
    }
  });

  it("reuses the cursor statements across reads and writes", () => {
    const ix = new SigilIndexer(":memory:", CHAIN_A, { logger: silentLogger() });
    const MANAGER = "0x0000000000000000000000000000000000000042" as Address;
    try {
      // Both are memoized, so repeated calls issue no further prepare() work.
      const first = capture(ix, () => {
        ix.getCursor(MANAGER);
        ix.storeAction(record(1, CHAIN_A), null, CHAIN_A);
      });
      expect(first.length).toBeGreaterThanOrEqual(1);
      const second = capture(ix, () => {
        ix.getCursor(MANAGER);
        ix.storeAction(record(2, CHAIN_A), null, CHAIN_A);
      });
      expect(second).toHaveLength(0);
    } finally {
      ix.close();
    }
  });
});

describe("PERF-05: reads project named columns", () => {
  it("does not use SELECT * in the row-listing or window paths", () => {
    const ix = new SigilIndexer(":memory:", CHAIN_A, { logger: silentLogger() });
    try {
      const calls = capture(ix, () => {
        ix.actionsForAgent(AGENT, CHAIN_A, 5);
        ix.actionsForTarget(TARGET, CHAIN_A, 5);
        ix.latestWindowCharge(KEY, CHAIN_A);
      });
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.sql, `unexpected SELECT * in ${call.sql}`).not.toMatch(/SELECT\s+\*/i);
      }
    } finally {
      ix.close();
    }
  });
});
