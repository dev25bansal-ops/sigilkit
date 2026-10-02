/**
 * P0 — indexer event-parsing error paths.
 *
 * `SigilIndexer.ingestLogs` is the single funnel every audit row passes through, and it is
 * written defensively: `parseActionLogged` returns null for anything that is not a
 * canonical `ActionLogged`, and the `WindowCharged` branch wraps `decodeEventLog` in a
 * `try/catch` that swallows a decode failure. Defensive code is exactly the code that rots
 * silently — nothing in production ever notices if a guard quietly stops guarding.
 *
 * So every test here is written as a *contract on the observable outcome*, never as "the
 * catch block was entered":
 *   - a malformed / foreign / unknown log must store **0** rows,
 *   - a batch containing one good log and one malformed log must store **exactly the good
 *     one** (partial loss is the dangerous failure, not total rejection),
 *   - nothing may throw out of `ingestLogs` for bad input.
 *
 * PROVENANCE OF THE CASE COUNT
 * -----------------------------
 *   DECLARATIONS = 18, and all 18 are plain `it(...)` — this file has no parameterized
 *   block, so declarations and runtime cases coincide and no expansion arithmetic applies.
 *
 * Runtime confirmation (read from the run log, not recomputed): the file was executed
 * together with `reorg-cache.test.ts`, giving `Tests  1 failed | 33 passed (34)` and
 * `Test Files  1 failed | 1 passed (2)`. This file's own count is therefore *derived* —
 * 34 minus `reorg-cache`'s independently logged 16 — so it is the one number among these
 * five files that rests on inference rather than a direct single-file reading. The single
 * failure is the INJECTED mutation (the `window_charges` DELETE in `removeLog` had its
 * `logIndex` pinned to 0), not a defect.
 *
 * Caveat on that run: collected under an alias harness substituting the `@sigilkit/*`
 * workspace specifiers, because the dependency tree was empty at the time. It evidences what
 * these assertions catch, not a clean-environment baseline.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, pad, toHex, type Hash, type Hex, type Log } from "viem";
import { SigilIndexer } from "../src/indexer.js";
// P0-3: `silentLogger` is a logger symbol -> `/logger` subpath (root barrel drops it).
import { silentLogger } from "@sigilkit/core/logger";

const MANAGER = "0x0000000000000000000000000000000000000042" as const;
const AGENT: Hash = ("0x" + "11".repeat(32)) as Hash;
const TARGET = "0x0000000000000000000000000000000000009001" as const;
const SELECTOR: Hex = "0x32145f90" as Hex;
const RATIONALE: Hash = ("0x" + "33".repeat(32)) as Hash;
const KEY = "0x1111111111111111111111111111111111111111" as const;

const ACTION_TOPIC = keccak256(toHex("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)"));
const CHARGE_TOPIC = keccak256(toHex("WindowCharged(address,address,uint256,uint48,uint256)"));

/** A canonical ActionLogged log, exactly the shape ActionLogger emits. */
function actionLog(over: Partial<Log> = {}, value = 7n, ts = 1_700_000_000, tx = "0x" + "a1".repeat(32)): Log {
  return {
    address: MANAGER,
    topics: [ACTION_TOPIC, pad(AGENT), pad(TARGET), pad(SELECTOR)],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
      [value, RATIONALE, BigInt(ts)],
    ),
    blockNumber: 1n,
    transactionHash: tx as Hash,
    blockHash: ("0x" + "ab".repeat(32)) as Hash,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    ...over,
  } as Log;
}

/** A canonical WindowCharged log. */
function chargeLog(over: Partial<Log> = {}, value = 5n, logIndex = 0): Log {
  return {
    address: MANAGER,
    topics: [CHARGE_TOPIC, pad(MANAGER), pad(KEY)],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint48" }, { type: "uint256" }],
      [value, 1_700_000_000n, value],
    ),
    blockNumber: 1n,
    transactionHash: ("0x" + "c2".repeat(32)) as Hash,
    blockHash: ("0x" + "ab".repeat(32)) as Hash,
    transactionIndex: 0,
    logIndex,
    removed: false,
    ...over,
  } as Log;
}

function store(): SigilIndexer {
  return new SigilIndexer(":memory:", 31337, { logger: silentLogger() });
}

describe("ingestLogs — unknown and foreign events are ignored, never stored", () => {
  it("stores nothing for an event whose topic0 matches no known event", () => {
    // The most common real input: a SessionKeyManager emits plenty of events the indexer
    // does not care about (KeyRotated, FundsWithdrawn, …). Skipping them is the whole point,
    // but "skip" must be provable: a regression that stored them would inflate every spend
    // report the audit trail produces.
    const foreign = {
      ...actionLog(),
      topics: [keccak256(toHex("KeyRotated(address,address,uint48)")), pad(MANAGER), pad(AGENT)],
    } as Log;
    const ix = store();
    try {
      expect(ix.ingestLogs([foreign])).toBe(0);
      expect(ix.summary()).toContain("0 audited actions");
      expect(ix.summary()).toContain("0 window charges");
    } finally {
      ix.close();
    }
  });

  it("stores nothing for an ERC-20 Transfer on the manager address", () => {
    const transfer = {
      ...actionLog(),
      topics: [keccak256(toHex("Transfer(address,address,uint256)")), pad(MANAGER), pad(AGENT), pad(TARGET)],
    } as Log;
    const ix = store();
    try {
      expect(ix.ingestLogs([transfer])).toBe(0);
      expect(ix.chainIds()).toEqual([]);
    } finally {
      ix.close();
    }
  });

  it("stores nothing for a 3-topic log that decodes to neither ActionLogged nor WindowCharged", () => {
    // The `topics.length === 3` branch is reached by anything indexed-with-2-args, so it
    // must not store on a merely successful decode — only on `eventName === WindowCharged`.
    const unknownThree = {
      ...actionLog(),
      topics: [keccak256(toHex("Paused(address,uint48,uint256)")), pad(MANAGER), pad(AGENT)],
      data: encodeAbiParameters([{ type: "uint256" }], [1n]),
    } as Log;
    const ix = store();
    try {
      expect(ix.ingestLogs([unknownThree])).toBe(0);
      expect(ix.latestWindowCharge(KEY)).toBeNull();
    } finally {
      ix.close();
    }
  });

  it("stores nothing for an ActionLogged topic0 with the wrong topic count", () => {
    // parseActionLogged requires exactly 4 topics. A 3-topic log carrying the ActionLogged
    // signature is a truncated/malformed record; indexing it would attribute a phantom action.
    const truncated = { ...actionLog(), topics: [ACTION_TOPIC, pad(AGENT), pad(TARGET)] } as Log;
    const ix = store();
    try {
      expect(ix.ingestLogs([truncated])).toBe(0);
      expect(ix.spendByAgent(AGENT)).toBe(0n);
    } finally {
      ix.close();
    }
  });

  it("stores nothing when the ActionLogged data section is truncated", () => {
    // `strict: true` decoding must reject a data blob that is too short for the non-indexed
    // args. Silently zero-filling it would record value 0 / timestamp 0 as if it were real.
    const short = { ...actionLog(), data: "0x" } as Log;
    const ix = store();
    try {
      expect(ix.ingestLogs([short])).toBe(0);
      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
    } finally {
      ix.close();
    }
  });

  it("stores nothing when the ActionLogged data section is not valid ABI", () => {
    const garbage = { ...actionLog(), data: "0xdeadbeef" } as Log;
    const ix = store();
    try {
      expect(ix.ingestLogs([garbage])).toBe(0);
      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
    } finally {
      ix.close();
    }
  });

  it("stores nothing when the WindowCharged data section is undecodable", () => {
    // The `catch { continue; }` around decodeEventLog is the one place in ingestLogs that
    // silently swallows an error. Prove it still swallows *only* decode failures, by
    // showing a bad WindowCharged costs nothing and breaks nothing around it.
    const bad = { ...chargeLog(), data: "0xzz" } as Log;
    const ix = store();
    try {
      expect(ix.ingestLogs([bad])).toBe(0);
      expect(ix.latestWindowCharge(KEY)).toBeNull();
    } finally {
      ix.close();
    }
  });

  it("stores nothing for a 3-topic log with no data at all", () => {
    const ix = store();
    try {
      expect(ix.ingestLogs([{ ...chargeLog(), data: "0x" } as Log])).toBe(0);
      expect(ix.latestWindowCharge(KEY)).toBeNull();
    } finally {
      ix.close();
    }
  });

  it("ignores an empty batch and reports zero", () => {
    const ix = store();
    try {
      expect(ix.ingestLogs([])).toBe(0);
    } finally {
      ix.close();
    }
  });
});

describe("ingestLogs — a malformed log does not cost a good one", () => {
  it("stores the good log and skips the bad one in the same batch", () => {
    // Partial loss is the failure that matters. Rejecting the whole batch would be visible
    // (a count of 0); accepting the whole batch would corrupt spend. Only "1 of 2" is right.
    const ix = store();
    try {
      const stored = ix.ingestLogs([
        actionLog({ transactionHash: ("0x" + "d1".repeat(32)) as Hash, logIndex: 0 }),
        { ...actionLog(), data: "0xdeadbeef", transactionHash: ("0x" + "d2".repeat(32)) as Hash, logIndex: 1 } as Log,
        actionLog({ transactionHash: ("0x" + "d3".repeat(32)) as Hash, logIndex: 2 }, 3n),
      ]);
      expect(stored).toBe(2);
      expect(ix.spendByAgent(AGENT)).toBe(10n); // 7 + 3, never the bad log's 7
    } finally {
      ix.close();
    }
  });

  it("keeps WindowCharged and ActionLogged accounting independent within one batch", () => {
    // A malformed action must not stop a later charge from landing, and vice versa: the two
    // branches of ingestLogs are independent, and the audit trail depends on both.
    const ix = store();
    try {
      const stored = ix.ingestLogs([
        { ...actionLog(), data: "0xdeadbeef" } as Log,
        chargeLog({ logIndex: 0 }),
      ]);
      expect(stored).toBe(1);
      expect(ix.spendByAgent(AGENT)).toBe(0n);
      expect(ix.latestWindowCharge(KEY)?.value).toBe("5");
    } finally {
      ix.close();
    }
  });
});

describe("ingestLogs — removed logs delete from BOTH tables", () => {
  it("removes a stored action and a stored charge addressed by the same (tx, logIndex)", () => {
    // `removeLog` issues two DELETEs. If either were dropped, a reorg would leave one of the
    // two tables holding an orphan — and the orphan in `actions` inflates the very spend
    // number an auditor relies on. Both rows must go, keyed identically.
    const ix = store();
    try {
      const tx = "0x" + "e1".repeat(32);
      const stored = ix.ingestLogs([actionLog({ transactionHash: tx as Hash, logIndex: 0 }, 9n)]);
      expect(stored).toBe(1);
      const charge = chargeLog({ transactionHash: tx as Hash, logIndex: 0 }, 9n);
      expect(ix.ingestLogs([charge])).toBe(1);
      expect(ix.latestWindowCharge(KEY)).not.toBeNull();

      // The reorged-out log: same (chain, tx, logIndex) pair.
      const removal = { ...actionLog({ transactionHash: tx as Hash, logIndex: 0 }), removed: true } as Log;
      expect(ix.ingestLogs([removal])).toBe(0); // a removal stores nothing
      expect(ix.spendByAgent(AGENT)).toBe(0n);
      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
      expect(ix.latestWindowCharge(KEY)).toBeNull();
    } finally {
      ix.close();
    }
  });

  it("removes a window charge addressed by a log index that has no matching action", () => {
    // The reverse asymmetry: a charge-only log index must still be deletable, otherwise a
    // reorg of a charge-only transaction leaves a stale `spent_this_window` forever.
    const ix = store();
    try {
      const tx = "0x" + "e2".repeat(32);
      ix.ingestLogs([chargeLog({ transactionHash: tx as Hash, logIndex: 7 }, 3n)]);
      expect(ix.latestWindowCharge(KEY)?.value).toBe("3");
      ix.ingestLogs([{ ...chargeLog({ transactionHash: tx as Hash, logIndex: 7 }), removed: true } as Log]);
      expect(ix.latestWindowCharge(KEY)).toBeNull();
    } finally {
      ix.close();
    }
  });

  it("does not let a removed log delete a DIFFERENT chain's rows", () => {
    // The DELETE is scoped by `this.chainId`. A multi-chain store must not lose its other
    // chain's rows when one chain reorgs — the store is explicitly multi-chain (ARCH-4).
    const ix = new SigilIndexer(":memory:", 31337, { logger: silentLogger() });
    try {
      const tx = "0x" + "e3".repeat(32);
      ix.storeAction(
        {
          agentId: AGENT, target: TARGET, selector: SELECTOR, value: 11n,
          rationaleHash: RATIONALE, timestamp: 1, txHash: tx as Hash, blockNumber: 1n, logIndex: 0,
        },
        null,
        8453,
      );
      expect(ix.spendByAgent(AGENT, 8453)).toBe(11n);
      ix.ingestLogs([{ ...actionLog({ transactionHash: tx as Hash, logIndex: 0 }), removed: true } as Log]);
      // Scoped to 31337, so the 8453 row is untouched.
      expect(ix.spendByAgent(AGENT, 8453)).toBe(11n);
    } finally {
      ix.close();
    }
  });

  it("refuses to delete when a removed log carries no logIndex (A3)", () => {
    // A3: a removed log with no logIndex must NOT default to index 0 — deleting the
    // (tx, 0) key for a log whose index the RPC omitted would silently delete an
    // unrelated row. The old `Number(log.logIndex ?? 0)` did exactly that; the fix
    // skips the delete with a warning, so every row of the transaction survives.
    const ix = store();
    try {
      const tx = "0x" + "e4".repeat(32);
      ix.ingestLogs([actionLog({ transactionHash: tx as Hash, logIndex: 0 }, 4n)]);
      ix.ingestLogs([actionLog({ transactionHash: tx as Hash, logIndex: 1 }, 5n)]);
      expect(ix.spendByAgent(AGENT)).toBe(9n);

      const { logIndex: _dropped, ...withoutIndex } = actionLog({ transactionHash: tx as Hash });
      ix.ingestLogs([{ ...withoutIndex, removed: true } as Log]);

      // Nothing was deleted — index 0 AND index 1 both survive.
      expect(ix.spendByAgent(AGENT)).toBe(9n);
      expect(ix.actionsForAgent(AGENT).map((r) => r.logIndex)).toEqual([0, 1]);
    } finally {
      ix.close();
    }
  });
});

describe("ingestLogs — missing optional log fields fail loud instead of writing row 0", () => {
  it("skips a WindowCharged whose logIndex/blockNumber are missing (A3)", () => {
    // A3: `Number(log.logIndex ?? 0)` / `Number(log.blockNumber ?? 0)` used to insert the
    // charge under key index 0 — a silently WRONG row (and the same deletion hazard on
    // the removed path). Missing ids now skip the log with a warning rather than
    // fabricating row 0: the charge is not stored, nothing else in the batch is harmed,
    // and a well-formed charge still lands.
    const ix = store();
    try {
      const bare = chargeLog();
      const { logIndex: _l, blockNumber: _b, ...rest } = bare;
      expect(ix.ingestLogs([{ ...rest } as Log])).toBe(0);
      expect(ix.latestWindowCharge(KEY)).toBeNull();
      expect(ix.summary()).toContain("0 window charges");

      // The skip is per-log: a complete charge in the same batch stores normally.
      expect(ix.ingestLogs([chargeLog({ logIndex: 2, blockNumber: 3n }, 7n)])).toBe(1);
      expect(ix.latestWindowCharge(KEY)?.value).toBe("7");
    } finally {
      ix.close();
    }
  });

  it("keeps two same-tx charges distinct when their log indexes differ", () => {
    // The (chain, tx, logIndex) natural key is what makes multiple charges in one
    // transaction lossless. Two identical charges at the same index must collapse to one
    // (idempotent re-index), and at different indexes must not.
    const ix = store();
    try {
      const tx = "0x" + "e5".repeat(32);
      ix.ingestLogs([chargeLog({ transactionHash: tx as Hash, logIndex: 0 }, 1n)]);
      ix.ingestLogs([chargeLog({ transactionHash: tx as Hash, logIndex: 0 }, 1n)]); // re-index
      ix.ingestLogs([chargeLog({ transactionHash: tx as Hash, logIndex: 1 }, 2n)]);
      expect(ix.summary()).toContain("2 window charges");
      // latestWindowCharge orders by window_start then block then log index: the newest wins.
      expect(ix.latestWindowCharge(KEY)?.value).toBe("2");
    } finally {
      ix.close();
    }
  });
});

describe("ingestLogs — read-only mode refuses before parsing anything", () => {
  it("refuses ingestLogs outright in read-only mode, including a malformed batch", () => {
    // The read-only refusal must come FIRST: if parsing ran first, a malformed log could
    // produce a different error than the policy refusal, and the tool's read-only guarantee
    // would depend on input shape.
    const ix = new SigilIndexer(":memory:", 31337, { readOnly: true, logger: silentLogger() });
    try {
      expect(() => ix.ingestLogs([{ ...actionLog(), data: "0xdeadbeef" } as Log])).toThrow(/read-only/);
    } finally {
      ix.close();
    }
  });
});
