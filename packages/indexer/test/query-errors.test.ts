/**
 * P0 — read-only query-surface error paths.
 *
 * `SigilIndexer`'s query methods are the only surface the MCP `audit_query` tool and the
 * indexer CLI ever touch, and they are the surface an auditor runs by hand. Two properties
 * make that worth pinning directly:
 *
 *  - **Fail-closed row ceiling (PERF-02).** Omitting `limit` means "every matching row", and
 *    more than 1 000 must THROW rather than silently truncate. A truncated audit listing is
 *    worse than a refusal: it looks complete. `query-plan.test.ts` covers the ceiling, so
 *    this file covers what surrounds it — the exact ceiling, the per-column symmetry, and
 *    the `limit` validation contract that decides which of the two branches runs.
 *  - **Explicit projection (PERF-05).** Reads project named columns, so a schema addition
 *    cannot silently change the returned shape. That is a *shape* guarantee, and it is only
 *    checkable from the outside: by adding a column and observing the result object.
 *
 * PROVENANCE OF THE CASE COUNT (read before quoting a number for this file)
 * -----------------------------------------------------------------------
 * This file holds the only parameterized block among the suites added for this package, so
 * its case count is the one most easily misquoted. Two different numbers are both correct:
 *
 *   DECLARATIONS = 18   17 plain `it(...)` + 1 `it.each([...])` call site
 *   RUNTIME CASES = 22  the single `it.each` in this file expands to 5 values
 *
 * The arithmetic: `17 + 5 = 22`. The `it.each` declaration IS one of the 18 declaration
 * sites, so `18 - 1 + 5 = 22` is the same number by a different route — but subtracting it
 * and then forgetting to add the expansion gives 17, which is wrong. Quote the pair, never a
 * bare integer.
 *
 * CORRECTION (2026-10-04): this header previously read "RUNTIME CASES = 22 (17 + 5)" while
 * also describing the block as "1 `it.each` call site" — those agree — but the surrounding
 * prose claimed `17 + 4`. It is 5 values (line 129), so 17 + 5 = 22 is correct.
 *
 * Runtime confirmation, re-measured 2026-10-04 under plain vitest on a populated tree:
 *   `Tests  22 passed (22)` / `Test Files  1 passed (1)`
 *
 * The earlier caveat — that these counts were collected under an alias harness because the
 * dependency tree was empty — no longer applies. `node_modules/@sigilkit/*` all resolve and
 * the suite runs green unmodified.
 *
 * Caveat on that run: it was collected under an alias harness that substitutes the
 * `@sigilkit/*` workspace specifiers, because the dependency tree was empty at the time. It
 * therefore evidences what these assertions catch, not a clean-environment baseline.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Hash, Hex } from "viem";
import { SigilIndexer } from "../src/indexer.js";
// P0-3: `silentLogger` is a logger symbol -> `/logger` subpath (root barrel drops it).
import { silentLogger } from "@sigilkit/core/logger";

const AGENT: Hash = ("0x" + "11".repeat(32)) as Hash;
const TARGET = "0x0000000000000000000000000000000000009001" as Hex;
const SELECTOR: Hex = "0x32145f90" as Hex;
const RATIONALE: Hash = ("0x" + "33".repeat(32)) as Hash;
const CHAIN = 8453;

let seq = 0;
/** A record whose natural key never collides with another call's. */
function rec(over: Record<string, unknown> = {}) {
  return {
    agentId: AGENT,
    target: TARGET,
    selector: SELECTOR,
    value: 1n,
    rationaleHash: RATIONALE,
    timestamp: 1_700_000_000,
    txHash: ("0x" + (seq++).toString(16).padStart(64, "0")) as Hash,
    blockNumber: 1_000n,
    logIndex: 0,
    ...over,
  } as Parameters<SigilIndexer["storeAction"]>[0];
}

function seeded(count: number, target: Hex = TARGET): SigilIndexer {
  const ix = new SigilIndexer(":memory:", CHAIN, { logger: silentLogger() });
  for (let i = 0; i < count; i++) ix.storeAction(rec({ target, blockNumber: BigInt(1_000 + i) }), null, CHAIN);
  return ix;
}

describe("row ceiling (PERF-02) — the exact boundary", () => {
  it("serves every row at exactly the ceiling when the caller did not ask for a size", () => {
    // 1 000 is the documented ceiling. "Exactly at the limit is not over it" is the whole
    // point of the fail-closed design: refusing here would make the threshold arbitrary.
    const ix = seeded(1_000);
    try {
      expect(ix.actionsForAgent(AGENT)).toHaveLength(1_000);
      expect(ix.actionsForTarget(TARGET)).toHaveLength(1_000);
    } finally {
      ix.close();
    }
  });

  it("throws one row past the ceiling and names the remedy", () => {
    const ix = seeded(1_001);
    try {
      expect(() => ix.actionsForAgent(AGENT)).toThrow(/more than 1000 rows match agent_id/);
      // The message must name the filter and the chain so an operator can act on it.
      expect(() => ix.actionsForAgent(AGENT, CHAIN)).toThrow(/on chain 8453/);
      // …and the remedy must be an explicit limit, not "use a different query".
      expect(() => ix.actionsForAgent(AGENT)).toThrow(/pass an explicit limit/);
    } finally {
      ix.close();
    }
  });

  it("applies the ceiling per filter column, not to the whole table", () => {
    // 600 rows for TARGET and 600 for a second target must NOT trip the 1 000 ceiling on the
    // TARGET query. A regression that counted table-wide (or reused the wrong index) would
    // refuse a query whose own result set is comfortably under the limit.
    const OTHER = "0x0000000000000000000000000000000000009002" as Hex;
    const ix = new SigilIndexer(":memory:", CHAIN, { logger: silentLogger() });
    try {
      for (let i = 0; i < 600; i++) ix.storeAction(rec({ target: TARGET, blockNumber: BigInt(2_000 + i) }), null, CHAIN);
      for (let i = 0; i < 600; i++) ix.storeAction(rec({ target: OTHER, blockNumber: BigInt(3_000 + i) }), null, CHAIN);
      expect(ix.actionsForTarget(TARGET)).toHaveLength(600);
      expect(ix.actionsForTarget(OTHER)).toHaveLength(600);
      expect(ix.spendByAgent(AGENT)).toBe(1_200n);
    } finally {
      ix.close();
    }
  });

  it("honours an explicit limit equal to the ceiling and one above it", () => {
    const ix = seeded(1_500);
    try {
      expect(ix.actionsForAgent(AGENT, undefined, 1_000)).toHaveLength(1_000);
      expect(ix.actionsForAgent(AGENT, undefined, 1_500)).toHaveLength(1_500);
      // Omitting the limit is the *other* branch and still fails closed.
      expect(() => ix.actionsForAgent(AGENT)).toThrow(/Refusing to silently truncate/);
    } finally {
      ix.close();
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the non-positive-integer limit %s before touching SQLite",
    (bad) => {
      const ix = seeded(2);
      try {
        expect(() => ix.actionsForAgent(AGENT, undefined, bad as number)).toThrow(/positive integer/);
        expect(() => ix.actionsForTarget(TARGET, undefined, bad as number)).toThrow(/positive integer/);
      } finally {
        ix.close();
      }
    },
  );

  it("returns the newest N in ascending order, and it is a true tail of the full listing", () => {
    // PERF-02's inner query walks the index backwards and the outer one restores ascending
    // order. Getting the order wrong would make "recent N" return the OLDEST N, which reads
    // as a plausible answer rather than an obvious bug.
    const ix = seeded(20);
    try {
      const page = ix.actionsForAgent(AGENT, undefined, 5);
      // `StoredAction.blockNumber` is a `number`, not a `bigint`: the column is INTEGER and
      // `toStoredAction` coerces with `Number(...)`. The demo-agent consumer asserts the
      // same contract (`Number(core.blockNumber)`), so bigint here would be a breaking
      // change to a published type, not a fix.
      expect(page.map((r) => r.blockNumber)).toEqual([1_015, 1_016, 1_017, 1_018, 1_019]);
      const all = ix.actionsForAgent(AGENT, undefined, 20);
      expect(page).toEqual(all.slice(-5));
    } finally {
      ix.close();
    }
  });
});

describe("explicit projection (PERF-05) — reads cannot widen silently", () => {
  it("does not surface a newly added actions column in the returned shape", () => {
    // `SELECT *` would make the return type an implicit function of the schema. Adding a
    // column here and asserting the result object is unchanged is the only way to observe
    // that from outside the module — and it is exactly the regression the projection
    // prevents (a consumer spreading a row into a log line would start emitting the new
    // column without any code change).
    const ix = seeded(1);
    try {
      const before = ix.actionsForAgent(AGENT, undefined, 10)[0]!;
      expect(Object.keys(before).sort()).toEqual(
        ["agentId", "blockHash", "blockNumber", "chainId", "logIndex", "rationaleHash", "selector", "target", "ts", "txHash", "value"].sort(),
      );
      const db = (ix as unknown as { db: DatabaseSync }).db;
      db.exec("ALTER TABLE actions ADD COLUMN injected TEXT");
      db.prepare("UPDATE actions SET injected = 'leak'").run();
      const after = ix.actionsForAgent(AGENT, undefined, 10)[0]!;
      expect(after).toEqual(before);
      expect(Object.keys(after)).not.toContain("injected");
      expect(JSON.stringify(after)).not.toContain("leak");
    } finally {
      ix.close();
    }
  });

  it("does not surface a newly added window_charges column", () => {
    const ix = new SigilIndexer(":memory:", CHAIN, { logger: silentLogger() });
    try {
      ix.storeWindowCharge({
        chainId: CHAIN,
        txHash: ("0x" + "1a".repeat(32)) as Hash,
        logIndex: 0,
        blockNumber: 1,
        account: TARGET,
        key: TARGET,
        value: "1",
        windowStart: 1,
        spentThisWindow: "1",
      });
      const before = ix.latestWindowCharge(TARGET)!;
      expect(Object.keys(before).sort()).toEqual(
        ["account", "blockNumber", "chainId", "key", "logIndex", "spentThisWindow", "txHash", "value", "windowStart"].sort(),
      );
      const db = (ix as unknown as { db: DatabaseSync }).db;
      db.exec("ALTER TABLE window_charges ADD COLUMN injected TEXT");
      const after = ix.latestWindowCharge(TARGET)!;
      expect(after).toEqual(before);
    } finally {
      ix.close();
    }
  });

  it("keeps a null block_hash as null rather than the string \"null\"", () => {
    // Legacy rows and any row inserted without a block hash carry NULL. Coercing it to the
    // text "null" would make a reorg-detection check (`blockHash === null`) fail open.
    const ix = seeded(1);
    try {
      const rows = ix.actionsForAgent(AGENT, undefined, 10);
      expect(rows[0]!.blockHash).toBeNull();
      const withHash = new SigilIndexer(":memory:", CHAIN, { logger: silentLogger() });
      try {
        withHash.storeAction(rec(), ("0x" + "cd".repeat(32)) as Hash, CHAIN);
        expect(withHash.actionsForAgent(AGENT, undefined, 10).every((r) => r.blockHash === "0x" + "cd".repeat(32))).toBe(true);
      } finally {
        withHash.close();
      }
    } finally {
      ix.close();
    }
  });
});

describe("query filters and multi-chain scoping", () => {
  it("returns null (not a throw) when a key has no window charge", () => {
    // The CLI and the MCP tool both branch on null, so a throw here would turn "no data"
    // into a runtime failure.
    const ix = seeded(1);
    try {
      expect(ix.latestWindowCharge("0x000000000000000000000000000000000000dEaD" as Hex)).toBeNull();
    } finally {
      ix.close();
    }
  });

  it("returns 0n (not null) for an agent with no spend", () => {
    // Summed in JS from an empty row set: 0n is the answer, and callers format it directly.
    const ix = seeded(1);
    try {
      expect(ix.spendByAgent(("0x" + "99".repeat(32)) as Hash)).toBe(0n);
    } finally {
      ix.close();
    }
  });

  it("scopes every read path by chainId, and leaves other chains invisible when scoped", () => {
    // ARCH-4's contract. An audit query pointed at the wrong chain must return empty rather
    // than another chain's rows — that false negative is the whole moat.
    const ix = new SigilIndexer(":memory:", CHAIN, { logger: silentLogger() });
    try {
      const OTHER_CHAIN = 31337;
      const tx = ("0x" + "2a".repeat(32)) as Hash;
      ix.storeAction(rec({ txHash: tx, value: 5n, blockNumber: 1n }), null, CHAIN);
      ix.storeAction(rec({ txHash: tx, value: 7n, blockNumber: 1n }), null, OTHER_CHAIN);
      expect(ix.chainIds()).toEqual([OTHER_CHAIN, CHAIN].sort((a, b) => a - b));
      expect(ix.spendByAgent(AGENT, CHAIN)).toBe(5n);
      expect(ix.spendByAgent(AGENT, OTHER_CHAIN)).toBe(7n);
      expect(ix.spendByAgent(AGENT)).toBe(12n);
      expect(ix.actionsForAgent(AGENT, CHAIN, 10)).toHaveLength(1);
      expect(ix.summary(CHAIN)).toContain("chain 8453");
      expect(ix.summary(OTHER_CHAIN)).toContain("chain 31337");
      expect(ix.summary()).toContain("chains 8453, 31337");
    } finally {
      ix.close();
    }
  });

  it("formats a summary naming 'none' when the store holds no chains", () => {
    // The CLI prints this string verbatim, so "chains none" must not read as a bug.
    const ix = new SigilIndexer(":memory:", CHAIN, { logger: silentLogger() });
    try {
      expect(ix.summary()).toBe(`chains none: 0 audited actions across 0 agents, 0 window charges`);
      expect(ix.chainIds()).toEqual([]);
    } finally {
      ix.close();
    }
  });
});

describe("formatWei (display helper)", () => {
  // Zero coverage until now: no test in the repo calls it, yet the CLI's `spend` command
  // prints its output directly to the operator, so a wrong decimal scale would misreport
  // spend by orders of magnitude with no error anywhere.
  it("renders wei as an 18-decimal ETH string", () => {
    expect(SigilIndexer.formatWei("1000000000000000000")).toBe("1");
    expect(SigilIndexer.formatWei("1500000000000000000")).toBe("1.5");
    expect(SigilIndexer.formatWei("1")).toBe("0.000000000000000001");
  });

  it("renders zero without an exponent or a trailing noise digit", () => {
    expect(SigilIndexer.formatWei("0")).toBe("0");
  });

  it("honours an explicit decimals count", () => {
    expect(SigilIndexer.formatWei("1000000", 6)).toBe("1");
    expect(SigilIndexer.formatWei("1234567", 6)).toBe("1.234567");
  });

  it("throws on a non-numeric value instead of rendering NaN", () => {
    // `BigInt("nonsense")` throws, which is the desired behaviour: a garbage DB value must
    // not surface to an operator as "NaN ETH total spend".
    expect(() => SigilIndexer.formatWei("not-a-number")).toThrow();
  });
});

describe("close() is idempotent and releases the handle", () => {
  it("can be called repeatedly and then refuses further queries", () => {
    // The MCP eviction path calls `close()` on handles it no longer owns, and `stop()` may be
    // invoked twice; a double close that threw would surface as a shutdown stack trace.
    const ix = seeded(1);
    ix.close();
    expect(() => ix.close()).not.toThrow();
    expect(() => ix.close()).not.toThrow();
    expect(() => ix.spendByAgent(AGENT)).toThrow();
  });
});
