/**
 * Indexer pipeline tests (E9): synthetic-but-canonical logs — built with the same
 * encoders the contracts use (keccak event topic + ABI-encoded data, exactly like
 * ActionLogger's declaration) — flow through ingest → SQLite → queries. The live
 * getLogs/watch wiring is a thin viem layer over the same ingest path.
 */
import { describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeAbiParameters, keccak256, pad, toHex, type Hash, type Hex, type Log, type PublicClient } from "viem";
import { SigilIndexer } from "../src/indexer.js";
import type { ActionLogRecord } from "@sigilkit/core";

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
      AGENT === opts.agentId ? pad(opts.agentId) : pad(opts.agentId),
      pad(TARGET),
      pad(SELECTOR),
    ],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
      [opts.value, RATIONALE, BigInt(opts.ts)],
    ),
    blockNumber: opts.blockNumber,
    transactionHash: opts.txHash as Hash,
    blockHash: ("0x" + "aa".repeat(32)) as Hash,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as Log;
}

describe("SigilIndexer (E9)", () => {
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
      blockNumber: 1n,
      transactionHash: ("0x" + "c1".repeat(32)) as Hash,
      blockHash: ("0x" + "ab".repeat(32)) as Hash,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    } as Log;
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
        [10n ** 16n, 1_700_000_000n, 10n ** 16n],
      ),
      blockNumber: 1n,
      transactionHash: ("0x" + "c2".repeat(32)) as Hash,
      blockHash: ("0x" + "ab".repeat(32)) as Hash,
      transactionIndex: 0,
      logIndex: 1,
      removed: false,
    } as Log;
    expect(ix.ingestLogs([charge])).toBe(1);
    const c = ix.latestWindowCharge(KEY)!;
    expect(c.spentThisWindow).toBe((10n ** 16n).toString());
    expect(c.windowStart).toBe(1_700_000_000);
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

/** Minimal PublicClient stub: getBlockNumber + a block-range-filtered getLogs. */
function stubChain(logs: Log[], head: bigint): PublicClient {
  return {
    getBlockNumber: async () => head,
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
        [10n ** 16n, 1_700_000_000n, 10n ** 16n],
      ),
      blockNumber: 1n,
      transactionHash: ("0x" + "f1".repeat(32)) as Hash,
      blockHash: ("0x" + "ab".repeat(32)) as Hash,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    } as Log;

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
    expect(ix.getCursor(MANAGER)).toEqual({ lastBlock: 10, lastBlockHash: null });

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
      getBlockNumber: async () => 5n,
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

  it("read-only mode performs no writes and no DDL (BUG-9)", () => {
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
