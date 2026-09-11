/**
 * Indexer pipeline tests (E9): synthetic-but-canonical logs — built with the same
 * encoders the contracts use (keccak event topic + ABI-encoded data, exactly like
 * ActionLogger's declaration) — flow through ingest → SQLite → queries. The live
 * getLogs/watch wiring is a thin viem layer over the same ingest path.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, pad, toHex, type Hash, type Hex, type Log } from "viem";
import { SigilIndexer } from "../src/indexer.js";

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
