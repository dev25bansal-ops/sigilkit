/**
 * Indexer pipeline tests (E9): synthetic-but-canonical logs — built with the same
 * encoders the contracts use (keccak event topic + ABI-encoded data, exactly like
 * ActionLogger's declaration) — flow through ingest → SQLite → queries. The live
 * getLogs/watch wiring is a thin viem layer over the same ingest path.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeAbiParameters, keccak256, pad, toHex, type Hash, type Hex, type Log, type PublicClient } from "viem";
import { SigilIndexer } from "../src/indexer.js";
// P0-3: `silentLogger` is a logger symbol — it must come from the `/logger` subpath once
// the root barrel drops its `logger.ts` re-export. `ActionLogRecord` (client.ts) is not.
import { type ActionLogRecord } from "@sigilkit/core";
import { silentLogger } from "@sigilkit/core/logger";

const AGENT: Hash = ("0x" + "11".repeat(32)) as Hash;
const AGENT2: Hash = ("0x" + "12".repeat(32)) as Hash;
/** A proper 20-byte key address for WindowCharged's indexed `key` param. */
const KEY = "0x1111111111111111111111111111111111111111" as const;
const TARGET = "0x0000000000000000000000000000000000009001" as const;
const SELECTOR: Hex = "0x32145f90" as Hex;
const RATIONALE: Hash = ("0x" + "33".repeat(32)) as Hash;

/** Builds a log shaped exactly like ActionLogger.ActionLogged's on-chain output. */
function actionLog(opts: {
  agentId: Hash;
  value: bigint;
  ts: number;
  txHash: string;
  blockNumber: bigint;
}): Log {
  return {
    address: "0x0000000000000000000000000000000000000042",
    topics: [
      keccak256(toHex("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)")),
      pad(opts.agentId),
      pad(TARGET),
      pad(SELECTOR),
    ],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
      [opts.value, RATIONALE, BigInt(opts.ts)],
    ),
    blockNumber: opts.blockNumber,
    transactionHash: opts.txHash as Hash,
    blockHash: blockHashFor(opts.blockNumber),
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as Log;
}

describe("SigilIndexer (E9)", () => {
  it("closes its SQLite handle when initialization throws", () => {
    let handle: { prepare: (sql: string) => unknown } | undefined;
    const prototype = SigilIndexer.prototype as unknown as { migrate: () => void };
    const spy = vi.spyOn(prototype, "migrate").mockImplementation(function (this: unknown) {
      handle = (this as { db: typeof handle }).db;
      throw new Error("injected initialization failure");
    });
    try {
      expect(() => new SigilIndexer(":memory:", 31337)).toThrow("injected initialization failure");
      expect(handle).toBeDefined();
      expect(() => handle!.prepare("SELECT 1")).toThrow();
    } finally { spy.mockRestore(); }
  });

  it("preserves both initialization and cleanup failures", () => {
    const prototype = SigilIndexer.prototype as unknown as { migrate: () => void };
    const spy = vi.spyOn(prototype, "migrate").mockImplementation(function (this: unknown) {
      const db = (this as { db: { close: () => void } }).db;
      const close = db.close.bind(db);
      db.close = () => { close(); throw new Error("cleanup failure"); };
      throw new Error("initialization failure");
    });
    try {
      expect(() => new SigilIndexer(":memory:", 31337)).toThrow(/initialization failure.*cleanup failure/);
    } finally { spy.mockRestore(); }
  });

  it("ingests ActionLogged logs and answers spend/action queries", () => {
    const ix = new SigilIndexer(":memory:", 31337);
    const stored = ix.ingestLogs([
      actionLog({ agentId: AGENT, value: 10n ** 16n, ts: 1_700_000_000, txHash: "0x" + "a1".repeat(32), blockNumber: 1n }),
      actionLog({ agentId: AGENT, value: 15n * 10n ** 15n, ts: 1_700_000_100, txHash: "0x" + "a2".repeat(32), blockNumber: 2n }),
      actionLog({ agentId: AGENT2, value: 1n, ts: 1_700_000_200, txHash: "0x" + "a3".repeat(32), blockNumber: 3n }),
    ]);
    expect(stored).toBe(3);

    expect(ix.spendByAgent(AGENT)).toBe(25n * 10n ** 15n);
    expect(ix.spendByAgent(AGENT2)).toBe(1n);
    expect(ix.actionsForAgent(AGENT)).toHaveLength(2);
    expect(ix.actionsForAgent(AGENT)[0]!.ts).toBe(1_700_000_000);
    expect(ix.actionsForTarget(TARGET)).toHaveLength(3);
    expect(ix.summary()).toContain("3 audited actions across 2 agents");
  });

  it("is idempotent on re-ingest (backfill + watch overlap must not double-count)", () => {
    const ix = new SigilIndexer(":memory:", 31337);
    const log = actionLog({ agentId: AGENT, value: 5n, ts: 1, txHash: "0x" + "b1".repeat(32), blockNumber: 1n });
    expect(ix.ingestLogs([log])).toBe(1);
    expect(ix.ingestLogs([log])).toBe(1); // INSERT OR IGNORE — count returned, value unchanged
    expect(ix.spendByAgent(AGENT)).toBe(5n);
  });

  it("ignores foreign logs and stores WindowCharged records", () => {
    const ix = new SigilIndexer(":memory:", 31337);
    const foreign: Log = {
      address: "0x0000000000000000000000000000000000000042",
      topics: [keccak256(toHex("Transfer(address,address,uint256)")), pad(TARGET), pad(TARGET), pad(SELECTOR)],
      data: "0x",
      blockNumber: 1,
      transactionHash: ("0x" + "c1".repeat(32)) as Hash,
      blockHash: ("0x" + "ab".repeat(32)) as Hash,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    } as unknown as Log;
    expect(ix.ingestLogs([foreign])).toBe(0);

    const charge: Log = {
      address: "0x0000000000000000000000000000000000000042",
      topics: [
        keccak256(toHex("WindowCharged(address,address,uint256,uint48,uint256)")),
        pad("0x0000000000000000000000000000000000000042"),
        pad(KEY),
      ],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint48" }, { type: "uint256" }],
        [10n ** 16n, 1_700_000_000, 10n ** 16n],
      ),
      blockNumber: 1,
      transactionHash: ("0x" + "c2".repeat(32)) as Hash,
      blockHash: ("0x" + "ab".repeat(32)) as Hash,
      transactionIndex: 0,
      logIndex: 1,
      removed: false,
    } as unknown as Log;
    expect(ix.ingestLogs([charge])).toBe(1);
    const c = ix.latestWindowCharge(KEY)!;
    expect(c.spentThisWindow).toBe((10n ** 16n).toString());
    expect(c.windowStart).toBe(1_700_000_000);
  });
});

describe("address column casing (A8/R56 follow-up)", () => {
  // `agent_id` is a bytes32 hash stored lowercased by `storeAction`, so its query side
  // lowercases too. The `target` and `key` columns are ADDRESSES stored VERBATIM from the
  // decoded event args, which viem returns checksummed — lowercasing those queries instead
  // makes a checksummed lookup silently miss rows that exist. SQLite TEXT comparison is
  // BINARY, so there is no forgiving normalisation anywhere in the path.
  //
  // Both directions are pinned here. A review added `.toLowerCase()` to both query methods
  // on the assumption that ingest normalizes everything; demo-agent's `e2e-core-indexer-flow`
  // caught it. These cases would not have, because that fixture's lookup happens to use the
  // same string as its ingest.
  // A real checksummed address. `TARGET` above is all-numeric, so it has no case and cannot
  // distinguish a lowercasing query from a verbatim one — a fixture chosen without thinking
  // about case proves nothing here.
  const CKSUM = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
  const CKSUM_LOWER = CKSUM.toLowerCase();

  function store(ix: SigilIndexer): void {
    ix.storeAction({
      agentId: AGENT,
      target: CKSUM,
      selector: SELECTOR,
      value: 7n,
      rationaleHash: `0x${"11".repeat(32)}` as Hash,
      timestamp: 100,
      txHash: `0x${"dd".repeat(32)}` as Hash,
      blockNumber: 1n,
      logIndex: 0,
    });
    ix.storeWindowCharge({
      chainId: 31337,
      txHash: `0x${"dd".repeat(32)}` as Hash,
      logIndex: 1,
      blockNumber: 1,
      account: MANAGER,
      key: CKSUM,
      value: "7",
      windowStart: 100,
      spentThisWindow: "7",
    });
  }

  it("finds a checksummed target and key exactly as stored", () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0, logger: silentLogger() });
    try {
      store(ix);
      expect(ix.actionsForTarget(CKSUM)).toHaveLength(1);
      expect(ix.latestWindowCharge(CKSUM)).not.toBeNull();
    } finally {
      ix.close();
    }
  });

  it("finds an all-lowercase agent id, which IS stored lowercased", () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0, logger: silentLogger() });
    try {
      store(ix);
      // Mixed case must also resolve, because the column is lowercased on both sides.
      expect(ix.actionsForAgent(AGENT.toUpperCase() as typeof AGENT)).toHaveLength(1);
      expect(ix.actionsForAgent(AGENT.toLowerCase() as typeof AGENT)).toHaveLength(1);
    } finally {
      ix.close();
    }
  });
});

describe("window-charge persistence failures", () => {
  it("propagates write failures without advancing the backfill cursor", async () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0, logger: silentLogger() });
    const charge: Log = {
      ...actionLog({ agentId: AGENT, value: 1n, ts: 100, txHash: `0x${"cc".repeat(32)}`, blockNumber: 1n }),
      topics: [keccak256(toHex("WindowCharged(address,address,uint256,uint48,uint256)")), pad(MANAGER), pad(KEY)],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint48" }, { type: "uint256" }],
        [1n, 100, 1n],
      ),
    };
    const failure = new Error("synthetic persistence failure");
    const write = vi.spyOn(ix, "storeWindowCharge").mockImplementation(() => { throw failure; });
    try {
      await expect(ix.backfill(stubChain([charge], 1n), MANAGER, 1n, 1n)).rejects.toBe(failure);
      expect(ix.getCursor(MANAGER)).toBeNull();
      expect(ix.latestWindowCharge(KEY)).toBeNull();
      write.mockRestore();
      await expect(ix.backfill(stubChain([charge], 1n), MANAGER, 1n, 1n)).resolves.toBe(1);
      expect(ix.getCursor(MANAGER)?.lastBlock).toBe(1);
      expect(ix.latestWindowCharge(KEY)?.value).toBe("1");
    } finally {
      write.mockRestore();
      ix.close();
    }
  });
});

describe("atomic range persistence", () => {
  it.each(["cursor", "commit"] as const)("preserves existing rows/checkpoint on %s failure and retries", async (stage) => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0, logger: silentLogger() });
    const db = ix["db"];
    const exec = db.exec.bind(db);
    const logs = [1n, 2n].map((blockNumber) => actionLog({
      agentId: AGENT, value: blockNumber, ts: 100,
      txHash: blockHashFor(blockNumber), blockNumber,
    }));
    let failCommit = false;
    const commit = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (failCommit && sql === "COMMIT") throw new Error("synthetic commit failure");
      return exec(sql);
    });
    try {
      await ix.backfill(stubChain(logs, 1n), MANAGER);
      const before = ix.getCursor(MANAGER);
      const rows = ix.actionsForAgent(AGENT);
      if (stage === "cursor") {
        exec("CREATE TEMP TRIGGER reject_cursor BEFORE UPDATE ON sync_state BEGIN SELECT RAISE(ABORT, 'synthetic cursor failure'); END");
      } else {
        failCommit = true;
      }
      await expect(ix.backfill(stubChain(logs, 2n), MANAGER)).rejects.toThrow(`synthetic ${stage} failure`);
      expect(ix.getCursor(MANAGER)).toEqual(before);
      expect(ix.actionsForAgent(AGENT)).toEqual(rows);
      failCommit = false;
      if (stage === "cursor") exec("DROP TRIGGER reject_cursor");
      expect(await ix.backfill(stubChain(logs, 2n), MANAGER)).toBe(1);
      expect(ix.getCursor(MANAGER)?.lastBlock).toBe(2);
      expect(ix.spendByAgent(AGENT)).toBe(3n);
    } finally {
      commit.mockRestore();
      ix.close();
    }
  });

  it("watch rolls back a failed commit and retries from the unchanged checkpoint", async () => {
    vi.useFakeTimers();
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0, backoffMs: 5, logger: silentLogger() });
    const db = ix["db"];
    const exec = db.exec.bind(db);
    let fail = false;
    let stop: (() => void) | undefined;
    const commit = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (fail && sql === "COMMIT") throw new Error("synthetic watch commit failure");
      return exec(sql);
    });
    try {
      await ix.backfill(stubChain([], 1n), MANAGER);
      const before = ix.getCursor(MANAGER);
      fail = true;
      stop = ix.watch(stubChain([actionLog({ agentId: AGENT, value: 2n, ts: 100, txHash: blockHashFor(2n), blockNumber: 2n })], 2n), MANAGER, 5);
      await vi.advanceTimersByTimeAsync(0);
      expect(commit).toHaveBeenCalledWith("ROLLBACK");
      expect(ix.getCursor(MANAGER)).toEqual(before);
      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
      fail = false;
      await vi.advanceTimersByTimeAsync(6);
      expect(ix.getCursor(MANAGER)?.lastBlock).toBe(2);
      expect(ix.spendByAgent(AGENT)).toBe(2n);
    } finally {
      stop?.();
      await vi.advanceTimersByTimeAsync(20);
      commit.mockRestore();
      ix.close();
      vi.useRealTimers();
    }
  });

  it("rolls back earlier rows when a later write fails and retries cleanly", async () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0, logger: silentLogger() });
    const logs = [1n, 2n].map((block) => actionLog({
      agentId: AGENT, value: block, ts: 100, txHash: `0x${block.toString(16).padStart(64, "0")}`, blockNumber: block,
    }));
    const original = ix.storeAction.bind(ix);
    const failure = new Error("synthetic second write failure");
    const write = vi.spyOn(ix, "storeAction").mockImplementation((...args) => {
      if (args[0].blockNumber === 2n) throw failure;
      return original(...args);
    });
    try {
      await expect(ix.backfill(stubChain(logs, 2n), MANAGER, 1n, 2n)).rejects.toBe(failure);
      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
      expect(ix.getCursor(MANAGER)).toBeNull();
      write.mockRestore();
      await expect(ix.backfill(stubChain(logs, 2n), MANAGER, 1n, 2n)).resolves.toBe(2);
      expect(ix.spendByAgent(AGENT)).toBe(3n);
      expect(ix.getCursor(MANAGER)?.lastBlock).toBe(2);
    } finally {
      write.mockRestore();
      ix.close();
    }
  });
});

// ── 2026-09-12 durability hardening ──────────────────────────────────────────────

const MANAGER = "0x0000000000000000000000000000000000000042" as const;

function record(overrides: Partial<ActionLogRecord> = {}): ActionLogRecord {
  return {
    agentId: AGENT,
    target: TARGET,
    selector: SELECTOR,
    value: 1n,
    rationaleHash: RATIONALE,
    timestamp: 1_700_000_000,
    txHash: ("0x" + "e1".repeat(32)) as Hash,
    blockNumber: 1n,
    logIndex: 0,
    ...overrides,
  };
}

/** Deterministic, self-describing block hash for a height (distinct per block). */
function blockHashFor(n: bigint): Hash {
  return ("0x" + n.toString(16).padStart(64, "0")) as Hash;
}

interface StubChainOptions {
  /** Override the hash served at a height — used to simulate a reorg. */
  hashes?: Map<bigint, Hash | null>;
  /** Heights whose header request must fail (pruned / unavailable block). */
  missing?: Set<bigint>;
  /** Called after each header's value is chosen, so a test can flip the next read. */
  onGetBlock?: (n: bigint) => void;
  /**
   * Chain id this stub claims over `eth_chainId` (SEC-15). Defaults to 31337, the
   * Anvil chain every `SigilIndexer` in this file is constructed with. A test that wants
   * to reproduce a mis-pointed `--rpc` passes a different id and expects backfill to
   * refuse. Note the stub is a double, not a configured client: this is deliberately a
   * *separate* value from the indexer's own `chainId`, which is what makes the mismatch
   * expressible at all.
   */
  chainId?: number;
}

/** Minimal PublicClient stub: getChainId + getBlockNumber + getBlock + getLogs. */
function stubChain(logs: Log[], head: bigint, opts: StubChainOptions = {}): PublicClient {
  return {
    // SEC-15: every range fetch asks the endpoint who it is before trusting its logs.
    getChainId: async () => opts.chainId ?? 31337,
    getBlockNumber: async () => head,
    getBlock: async (a: { blockNumber?: bigint }) => {
      const n = a.blockNumber ?? head;
      if (opts.missing?.has(n)) throw new Error(`header for block ${n} unavailable`);
      const hash = opts.hashes?.has(n) ? opts.hashes.get(n)! : blockHashFor(n);
      opts.onGetBlock?.(n);
      return hash === null ? null : ({ number: n, hash, parentHash: blockHashFor(n > 0n ? n - 1n : 0n) } as unknown);
    },
    getLogs: async (a: { fromBlock?: bigint; toBlock?: bigint }) =>
      logs.filter(
        (l) =>
          (l.blockNumber ?? 0n) >= (a.fromBlock ?? 0n) && (l.blockNumber ?? 0n) <= (a.toBlock ?? head),
      ),
  } as unknown as PublicClient;
}

describe("SigilIndexer durability (BUG-5/6/7, BUG-9, ARCH-2/3/4)", () => {
  it("keeps distinct actions that share a transaction (BUG-5)", () => {
    const ix = new SigilIndexer(":memory:", 31337);
    const tx = "0x" + "d1".repeat(32);
    // Two same-shape actions in one tx: identical agent/target/selector/timestamp,
    // differing only in value and log index. The old key collapsed them into one row.
    const a = { ...actionLog({ agentId: AGENT, value: 1n, ts: 100, txHash: tx, blockNumber: 1n }), logIndex: 0 } as Log;
    const b = { ...actionLog({ agentId: AGENT, value: 2n, ts: 100, txHash: tx, blockNumber: 1n }), logIndex: 1 } as Log;

    expect(ix.ingestLogs([a, b])).toBe(2);
    expect(ix.actionsForAgent(AGENT)).toHaveLength(2);
    expect(ix.spendByAgent(AGENT)).toBe(3n);
    expect(ix.actionsForAgent(AGENT).map((r) => r.logIndex)).toEqual([0, 1]);
  });

  it("window charges are idempotent on re-ingest (BUG-6)", () => {
    const ix = new SigilIndexer(":memory:", 31337);
    const charge: Log = {
      address: MANAGER,
      topics: [
        keccak256(toHex("WindowCharged(address,address,uint256,uint48,uint256)")),
        pad(MANAGER),
        pad(KEY),
      ],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint48" }, { type: "uint256" }],
        [10n ** 16n, 1_700_000_000, 10n ** 16n],
      ),
      blockNumber: 1,
      transactionHash: ("0x" + "f1".repeat(32)) as Hash,
      blockHash: ("0x" + "ab".repeat(32)) as Hash,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    } as unknown as Log;

    ix.ingestLogs([charge]);
    ix.ingestLogs([charge]); // re-index of the same range
    ix.ingestLogs([charge]);
    // Previously a plain INSERT duplicated the row on every pass.
    expect(ix.summary()).toContain("1 window charges");
    expect(ix.latestWindowCharge(KEY)!.spentThisWindow).toBe((10n ** 16n).toString());
  });

  it("deletes rows for reorged-out (removed) logs (ARCH-2)", () => {
    const ix = new SigilIndexer(":memory:", 31337);
    const log = actionLog({ agentId: AGENT, value: 5n, ts: 1, txHash: "0x" + "a9".repeat(32), blockNumber: 1n });
    ix.ingestLogs([log]);
    expect(ix.spendByAgent(AGENT)).toBe(5n);

    ix.ingestLogs([{ ...log, removed: true } as Log]);
    expect(ix.spendByAgent(AGENT)).toBe(0n);
    expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
  });

  it("rollbackTo discards rows above a block and rewinds the cursor (ARCH-2)", () => {
    const ix = new SigilIndexer(":memory:", 31337);
    ix.ingestLogs([
      actionLog({ agentId: AGENT, value: 1n, ts: 1, txHash: "0x" + "b9".repeat(32), blockNumber: 10n }),
      actionLog({ agentId: AGENT, value: 2n, ts: 2, txHash: "0x" + "ba".repeat(32), blockNumber: 20n }),
    ]);
    expect(ix.spendByAgent(AGENT)).toBe(3n);

    ix.rollbackTo(10, MANAGER);
    expect(ix.spendByAgent(AGENT)).toBe(1n);
    expect(ix.getCursor(MANAGER)!.lastBlock).toBe(10);
  });

  it("persists the sync cursor so a restart resumes instead of skipping (BUG-7)", async () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0 });
    const logs = [
      actionLog({ agentId: AGENT, value: 7n, ts: 1, txHash: "0x" + "c9".repeat(32), blockNumber: 5n }),
    ];
    const client = stubChain(logs, 10n);

    expect(await ix.backfill(client, MANAGER)).toBe(1);
    expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: blockHashFor(10n) });

    // A second pass with no new blocks is a clean no-op — not a replay (no duplicates).
    expect(await ix.backfill(client, MANAGER)).toBe(0);
    expect(ix.spendByAgent(AGENT)).toBe(7n);
    expect(ix.actionsForAgent(AGENT)).toHaveLength(1);
  });

  it("honours `confirmations` by staying behind the head (ARCH-2)", async () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 5 });
    const logs = [
      actionLog({ agentId: AGENT, value: 1n, ts: 1, txHash: "0x" + "d9".repeat(32), blockNumber: 10n }),
      actionLog({ agentId: AGENT, value: 1n, ts: 2, txHash: "0x" + "da".repeat(32), blockNumber: 12n }),
    ];
    const client = stubChain(logs, 12n);

    // head 12 − 5 confirmations = safe head 7, so neither log (10, 12) is indexed yet.
    expect(await ix.backfill(client, MANAGER)).toBe(0);
    expect(ix.getCursor(MANAGER)!.lastBlock).toBe(7);
  });

  it("chunks getLogs to maxBlockRange and sums every chunk (PERF-5)", async () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0, maxBlockRange: 3 });
    const logs = [1n, 2n, 3n, 4n, 5n].map((b, i) =>
      actionLog({ agentId: AGENT, value: 1n, ts: i, txHash: ("0x" + (i + 1).toString(16).padStart(2, "0") + "9".repeat(31)) as Hash, blockNumber: b }),
    );
    const ranges: Array<[bigint, bigint]> = [];
    const client = {
      getChainId: async () => 31337, // SEC-15: matches this indexer's chainId
      getBlockNumber: async () => 5n,
      getBlock: async (a: { blockNumber?: bigint }) => ({ number: a.blockNumber ?? 5n, hash: blockHashFor(a.blockNumber ?? 5n) }),
      getLogs: async (a: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push([a.fromBlock, a.toBlock]);
        return logs.filter((l) => (l.blockNumber ?? 0n) >= a.fromBlock && (l.blockNumber ?? 0n) <= a.toBlock);
      },
    } as unknown as PublicClient;

    expect(await ix.backfill(client, MANAGER, 1n)).toBe(5);
    expect(ix.actionsForAgent(AGENT)).toHaveLength(5);
    // 5 blocks from block 1 at a 3-block ceiling → [1,3] then [4,5].
    expect(ranges).toEqual([
      [1n, 3n],
      [4n, 5n],
    ]);
  });

  it("aggregates across chains and filters by chainId (ARCH-4)", () => {
    const ix = new SigilIndexer(":memory:", 1);
    ix.storeAction(record({ value: 1n, txHash: ("0x" + "aa".repeat(32)) as Hash, logIndex: 0 }), null, 1);
    ix.storeAction(record({ value: 2n, txHash: ("0x" + "bb".repeat(32)) as Hash, logIndex: 0 }), null, 8453);

    expect(ix.chainIds()).toEqual([1, 8453]);
    expect(ix.spendByAgent(AGENT)).toBe(3n); // every chain
    expect(ix.spendByAgent(AGENT, 8453)).toBe(2n); // filtered
    expect(ix.actionsForAgent(AGENT, 1)).toHaveLength(1);
  });

  it("read-only mode performs no writes and no DDL (BUG-9)", async () => {
    const path = join(tmpdir(), `sigilkit-ro-${process.pid}-${Date.now()}.db`);
    const missing = join(tmpdir(), `sigilkit-missing-${process.pid}-${Date.now()}.db`);
    const rw = new SigilIndexer(path, 31337);
    let ro: SigilIndexer | undefined;
    try {
      rw.storeAction(record());
      expect(rw.summary()).toContain("1 audited actions");
      rw.close();

      ro = new SigilIndexer(path, 31337, { readOnly: true });
      expect(ro.readOnly).toBe(true);
      expect(ro.summary()).toContain("1 audited actions");
      // Every write path must refuse.
      expect(() => ro!.storeAction(record())).toThrow(/read-only/);
      expect(() => ro!.ingestLogs([])).toThrow(/read-only/);
      expect(() => ro!.rollbackTo(0)).toThrow(/read-only/);
      // backfill must refuse before any RPC: the empty client would throw if it were reached.
      await expect(ro!.backfill({} as PublicClient, MANAGER)).rejects.toThrow(/read-only/);
      ro.close();
      ro = undefined;

      // A read-only open must NOT create the file or its directory.
      expect(() => new SigilIndexer(missing, 31337, { readOnly: true })).toThrow();
      expect(existsSync(missing)).toBe(false);
    } finally {
      ro?.close();
      rw.close();
      rmSync(path, { force: true });
      rmSync(missing, { force: true });
    }
  });
});

// ── 2026-09-17 fail-closed cursor-hash validation (B64) ─────────────────────────
// Conservative detection only: every failure stops before a write and never deletes
// user data. Resolving a reorg stays an explicit operator action (rollbackTo).

/** Temp workspace under the OS temp dir — isolated per test and removed after (A11). */
const TMP_ROOT = join(tmpdir(), "sigilkit-indexer-tests");

describe("range continuity", () => {
  it.each(["parent", "checkpoint", "missing checkpoint", "height", "log hash", "concurrent writer"] as const)("rejects inconsistent %s evidence without losing prior state", async (kind) => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0, logger: silentLogger() });
    try {
      await ix.backfill(stubChain([], 1n), MANAGER);
      const before = ix.getCursor(MANAGER);
      const hashes = new Map<bigint, Hash | null>();
      const missing = new Set<bigint>();
      const log = actionLog({ agentId: AGENT, value: 2n, ts: 100, txHash: blockHashFor(2n), blockNumber: 2n });
      const client = stubChain([kind === "log hash" ? { ...log, blockHash: blockHashFor(99n) } : log], 2n, { hashes, missing });
      const getLogs = client.getLogs.bind(client);
      const getBlock = client.getBlock.bind(client);
      vi.spyOn(client, "getLogs").mockImplementation(async (args) => {
        const logs = await getLogs(args);
        if (kind === "checkpoint") hashes.set(1n, blockHashFor(99n));
        if (kind === "missing checkpoint") missing.add(1n);
        if (kind === "concurrent writer") ix["setCursor"](MANAGER, 3, blockHashFor(3n));
        return logs;
      });
      vi.spyOn(client, "getBlock").mockImplementation(async (args) => {
        const header = await getBlock(args);
        if (args?.blockNumber === 2n && kind === "parent") return { ...header, parentHash: blockHashFor(99n) };
        if (args?.blockNumber === 2n && kind === "height") return { ...header, number: 99n };
        return header;
      });
      const reason = { parent: /parent/, checkpoint: /reorg detected/, "missing checkpoint": /cannot verify cursor/,
        height: /malformed/, "log hash": /hash mismatch/, "concurrent writer": /checkpoint changed/ }[kind];
      await expect(ix.backfill(client, MANAGER)).rejects.toThrow(reason);
      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
      expect(ix.getCursor(MANAGER)).toEqual(kind === "concurrent writer" ? { lastBlock: 3, lastBlockHash: blockHashFor(3n) } : before);
    } finally {
      ix.close();
    }
  });

  it("watch rejects a checkpoint that changes during collection", async () => {
    vi.useFakeTimers();
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0, backoffMs: 5, logger: silentLogger() });
    let stop: (() => void) | undefined;
    try {
      await ix.backfill(stubChain([], 1n), MANAGER);
      const before = ix.getCursor(MANAGER);
      const hashes = new Map<bigint, Hash | null>();
      const client = stubChain([actionLog({ agentId: AGENT, value: 2n, ts: 100, txHash: blockHashFor(2n), blockNumber: 2n })], 2n, { hashes });
      const getLogs = client.getLogs.bind(client);
      const fetch = vi.spyOn(client, "getLogs").mockImplementation(async (args) => {
        const logs = await getLogs(args);
        hashes.set(1n, blockHashFor(99n));
        return logs;
      });
      stop = ix.watch(client, MANAGER, 5);
      await vi.advanceTimersByTimeAsync(20);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(ix.getCursor(MANAGER)).toEqual(before);
      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
    } finally {
      stop?.();
      await vi.advanceTimersByTimeAsync(40);
      ix.close();
      vi.useRealTimers();
    }
  });
});

describe("SigilIndexer fail-closed cursor validation (B64)", () => {
  it("re-validates a stable cursor and resumes when the chain advances", async () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0 });
    const block5 = [
      actionLog({ agentId: AGENT, value: 5n, ts: 1, txHash: "0x" + "4a".repeat(32), blockNumber: 5n }),
    ];
    const client = stubChain(block5, 10n);

    expect(await ix.backfill(client, MANAGER)).toBe(1);
    expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: blockHashFor(10n) });

    // Nothing new: the cursor hash still matches, so this is a clean no-op — not a replay.
    expect(await ix.backfill(client, MANAGER)).toBe(0);
    expect(ix.spendByAgent(AGENT)).toBe(5n);
    expect(ix.actionsForAgent(AGENT)).toHaveLength(1);

    // A new block arrives: only the delta is fetched and the cursor advances with its hash.
    const advanced = stubChain(
      [
        ...block5,
        actionLog({ agentId: AGENT, value: 2n, ts: 2, txHash: "0x" + "4b".repeat(32), blockNumber: 11n }),
      ],
      11n,
    );
    expect(await ix.backfill(advanced, MANAGER)).toBe(1);
    expect(ix.spendByAgent(AGENT)).toBe(7n);
    expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 11, lastBlockHash: blockHashFor(11n) });
  });

  it("fails closed on a cursor hash mismatch: no writes and no cursor advance", async () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0 });
    const block5 = [
      actionLog({ agentId: AGENT, value: 7n, ts: 1, txHash: "0x" + "5a".repeat(32), blockNumber: 5n }),
    ];
    expect(await ix.backfill(stubChain(block5, 10n), MANAGER)).toBe(1);

    // Block 10 reorged (new hash) and block 11 carries a fresh action.
    const hashes = new Map<bigint, Hash>([[10n, ("0x" + "ff".repeat(32)) as Hash]]);
    const reorged = stubChain(
      [
        ...block5,
        actionLog({ agentId: AGENT, value: 100n, ts: 2, txHash: "0x" + "5b".repeat(32), blockNumber: 11n }),
      ],
      11n,
      { hashes },
    );
    await expect(ix.backfill(reorged, MANAGER)).rejects.toThrow(/reorg detected/);

    // The mismatch was caught before the range fetch: nothing ingested, cursor untouched.
    expect(ix.spendByAgent(AGENT)).toBe(7n);
    expect(ix.actionsForAgent(AGENT)).toHaveLength(1);
    expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: blockHashFor(10n) });
  });

  it("aborts when the end header changes mid-fetch: no ingest, no cursor advance", async () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0 });
    const logs = [
      actionLog({ agentId: AGENT, value: 3n, ts: 1, txHash: "0x" + "6a".repeat(32), blockNumber: 10n }),
    ];
    let headerReads = 0;
    const hashes = new Map<bigint, Hash>([[10n, blockHashFor(10n)]]);
    const client = stubChain(logs, 10n, {
      hashes,
      onGetBlock: (n) => {
        // Flip the header after the pre-fetch read so the post-fetch read disagrees.
        if (n === 10n && ++headerReads === 1) hashes.set(10n, ("0x" + "ee".repeat(32)) as Hash);
      },
    });

    await expect(ix.backfill(client, MANAGER)).rejects.toThrow(/changed while fetching logs/);
    expect(ix.spendByAgent(AGENT)).toBe(0n);
    expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
    expect(ix.getCursor(MANAGER)).toBeNull();
  });

  it("fails closed on a legacy cursor with no block hash — no silent resume", async () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0 });
    const logs = [
      actionLog({ agentId: AGENT, value: 8n, ts: 1, txHash: "0x" + "2a".repeat(32), blockNumber: 10n }),
    ];
    expect(await ix.backfill(stubChain(logs, 10n), MANAGER)).toBe(1);

    // Simulate a pre-hardening database: a cursor row whose hash was never recorded.
    ix.rollbackTo(10, MANAGER);
    expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: null });

    await expect(ix.backfill(stubChain(logs, 10n), MANAGER)).rejects.toThrow(/no recorded block hash/);
    // The rows are left exactly as they were — no auto-delete and no cursor rewrite.
    expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: null });
    expect(ix.spendByAgent(AGENT)).toBe(8n);
  });

  it("fails closed when a required header is unavailable", async () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0 });
    const logs = [
      actionLog({ agentId: AGENT, value: 4n, ts: 1, txHash: "0x" + "3a".repeat(32), blockNumber: 10n }),
    ];

    // End header unavailable with no cursor yet → nothing written, no cursor row created.
    await expect(
      ix.backfill(stubChain(logs, 10n, { missing: new Set([10n]) }), MANAGER),
    ).rejects.toThrow(/unavailable/);
    expect(ix.spendByAgent(AGENT)).toBe(0n);
    expect(ix.getCursor(MANAGER)).toBeNull();

    // Cursor block unavailable → the pre-fetch validation stops the run and keeps the cursor.
    expect(await ix.backfill(stubChain(logs, 10n), MANAGER)).toBe(1);
    await expect(
      ix.backfill(stubChain(logs, 10n, { missing: new Set([10n]) }), MANAGER),
    ).rejects.toThrow(/cannot verify cursor block 10/);
    expect(ix.actionsForAgent(AGENT)).toHaveLength(1);
    expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: blockHashFor(10n) });
  });

  it("persists and re-validates the cursor hash across a real close/reopen", async () => {
    const dir = join(TMP_ROOT, `reopen-${process.pid}-${Date.now()}`);
    const dbPath = join(dir, "indexer.db");
    mkdirSync(dir, { recursive: true });
    const logs = [
      actionLog({ agentId: AGENT, value: 9n, ts: 1, txHash: "0x" + "7a".repeat(32), blockNumber: 5n }),
    ];
    const client = stubChain(logs, 10n);
    let ix: SigilIndexer | undefined;
    try {
      ix = new SigilIndexer(dbPath, 31337, { confirmations: 0 });
      expect(await ix.backfill(client, MANAGER)).toBe(1);
      const persisted = ix.getCursor(MANAGER)!;
      expect(persisted).toEqual({ lastBlock: 10, lastBlockHash: blockHashFor(10n) });
      ix.close();
      ix = undefined;

      // Reopen the same file: the hash must still validate, so the resume is a clean no-op.
      ix = new SigilIndexer(dbPath, 31337, { confirmations: 0 });
      expect(ix.getCursor(MANAGER)).toEqual(persisted);
      expect(await ix.backfill(client, MANAGER)).toBe(0);
      expect(ix.spendByAgent(AGENT)).toBe(9n);
    } finally {
      ix?.close();
      // Best-effort cleanup. The sandbox's bulk-delete guard can refuse a late rmSync in a
      // long run; a blocked cleanup must not fail an otherwise-passing test. The folder is
      // isolated under the OS temp dir (sigilkit-indexer-tests) and never inside the repo.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`cleanup left ${dir} behind:`, err instanceof Error ? err.message : err);
      }
    }
  });

  it("watch stops on a cursor hash mismatch without writing (B64)", async () => {
    vi.useFakeTimers();
    const ix = new SigilIndexer(":memory:", 31337, {
      confirmations: 0,
      backoffMs: 1,
      logger: silentLogger(),
    });
    try {
      const block5 = [
        actionLog({ agentId: AGENT, value: 7n, ts: 1, txHash: "0x" + "9a".repeat(32), blockNumber: 5n }),
      ];
      expect(await ix.backfill(stubChain(block5, 10n), MANAGER)).toBe(1);

      // Block 10 reorged (new hash) and block 11 carries a fresh action that must not land.
      const hashes = new Map<bigint, Hash>([[10n, ("0x" + "dd".repeat(32)) as Hash]]);
      const reorged = stubChain(
        [
          ...block5,
          actionLog({ agentId: AGENT, value: 100n, ts: 2, txHash: "0x" + "9b".repeat(32), blockNumber: 11n }),
        ],
        11n,
        { hashes },
      );

      const stop = ix.watch(reorged, MANAGER, 5);
      await vi.advanceTimersByTimeAsync(40);
      stop();
      await vi.advanceTimersByTimeAsync(40);

      // Fail-closed: the block-11 action was never fetched or stored, cursor untouched.
      expect(ix.spendByAgent(AGENT)).toBe(7n);
      expect(ix.actionsForAgent(AGENT)).toHaveLength(1);
      expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: blockHashFor(10n) });
    } finally {
      ix.close();
      vi.useRealTimers();
    }
  });

  it("watch validates the cursor before the short-head skip (B64)", async () => {
    vi.useFakeTimers();
    const dir = join(TMP_ROOT, `watch-shorthead-${process.pid}-${Date.now()}`);
    const dbPath = join(dir, "indexer.db");
    mkdirSync(dir, { recursive: true });
    let seeded: SigilIndexer | undefined;
    let watching: SigilIndexer | undefined;
    try {
      const logs = [
        actionLog({ agentId: AGENT, value: 6n, ts: 1, txHash: "0x" + "8a".repeat(32), blockNumber: 5n }),
      ];
      // Seed a cursor at block 10 while the head is still high.
      seeded = new SigilIndexer(dbPath, 31337, { confirmations: 0 });
      expect(await seeded.backfill(stubChain(logs, 10n), MANAGER)).toBe(1);
      expect(seeded.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: blockHashFor(10n) });
      seeded.close();
      seeded = undefined;

      // Head 5 with confirmations 12 → safeHead < 0, so the short-head skip fires. The
      // cursor block has reorged, so validation must still run and stop the tick.
      const headerReads: bigint[] = [];
      const client = stubChain(logs, 5n, {
        hashes: new Map<bigint, Hash>([[10n, ("0x" + "cc".repeat(32)) as Hash]]),
        onGetBlock: (n) => headerReads.push(n),
      });

      watching = new SigilIndexer(dbPath, 31337, {
        confirmations: 12,
        backoffMs: 1,
        logger: silentLogger(),
      });
      const stop = watching.watch(client, MANAGER, 5);
      await vi.advanceTimersByTimeAsync(40);
      stop();
      await vi.advanceTimersByTimeAsync(40);

      // The cursor header was read despite the empty safe window — validation ran first.
      expect(headerReads).toContain(10n);
      // Fail-closed: no writes and the cursor is unchanged.
      expect(watching.spendByAgent(AGENT)).toBe(6n);
      expect(watching.actionsForAgent(AGENT)).toHaveLength(1);
      expect(watching.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: blockHashFor(10n) });
    } finally {
      watching?.close();
      seeded?.close();
      vi.useRealTimers();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`cleanup left ${dir} behind:`, err instanceof Error ? err.message : err);
      }
    }
  });
});

describe("fresh-chain backfill (AC-32)", () => {
  it("fails loudly instead of storing nothing when the chain is younger than confirmations", async () => {
    const ix = new SigilIndexer(":memory:", 31337); // default confirmations: 12
    const log = actionLog({
      agentId: AGENT,
      value: 1n,
      ts: 1,
      txHash: "0x" + "c1".repeat(32),
      blockNumber: 4n,
    });
    await expect(ix.backfill(stubChain([log], 7n), MANAGER)).rejects.toThrow(
      /younger than .* confirmations|--confirmations/,
    );
    ix.close();
  });

  it("does not fail at genesis when the operator explicitly passed confirmations 0", async () => {
    const ix = new SigilIndexer(":memory:", 31337, { confirmations: 0 });
    await expect(ix.backfill(stubChain([], 0n), MANAGER)).resolves.toBe(0);
    ix.close();
  });
});
