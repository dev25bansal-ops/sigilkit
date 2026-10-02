/**
 * E2E — Flow A: core generates the data, the indexer ingests it, the result must agree.
 *
 * Why this file exists
 * --------------------
 * Every other test in this repo is a *single-package* test: the indexer tests hand-build
 * `ActionLogRecord`s, and the core tests decode logs without ever storing them. That split
 * is exactly what hides the bugs this file is for. The seam between "core decodes an
 * ActionLogged log" and "the indexer persists what core decoded" is a *contract*, not a
 * type: both sides compile against `ActionLogRecord`, so a field that is present, spelled
 * right, and still stored wrong passes every unit test on both sides.
 *
 * The data here is built the way a real chain produces it — `encodeEventLog` over core's
 * own `ACTION_LOGGER_ABI`, i.e. the same ABI the contracts are compiled against — and then
 * pushed through the *real* production entry point (`SigilIndexer.ingestLogs`), not through
 * `storeAction` with a hand-made object. `ingestLogs` is the path `watch`/`backfill` use, so
 * a test that calls `storeAction` directly is testing a different program than the one that
 * runs.
 *
 * No network: the "chain" is a set of synthetic `Log` objects. `viem`'s encode/decode is
 * the only thing that touches cryptography, and it is pure.
 *
 * Each test names the integration bug class it defends against.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, keccak256, pad, toHex, type Address, type Hash, type Hex, type Log } from "viem";
import {
  ACTION_LOGGER_ABI,
  ACTION_LOGGED_TOPIC,
  SESSION_KEY_MANAGER_ABI,
  parseActionLogged,
  silentLogger,
  type ActionLogRecord,
  type Scope,
} from "@sigilkit/core";
import { SigilIndexer, type StoredAction } from "@sigilkit/indexer";

const CHAIN_ID = 31337;
const MANAGER = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const TARGET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address; // deliberately checksummed
const SELECTOR = "0x32145f90" as Hex;

/** Cleaned up after each test; Windows keeps a lock on an unclosed SQLite handle. */
const sandboxes: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "sigilkit-e2e-a-"));
  sandboxes.push(dir);
  return join(dir, "audit.db");
}

afterEach(() => {
  while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

/**
 * Builds a log exactly as an RPC node would return one for `ActionLogged`.
 *
 * The topic0 and the indexed/non-indexed split are derived from core's own
 * `ACTION_LOGGER_ABI` rather than hand-written, so this fixture cannot drift from the
 * decoder it exercises. A hard-coded topic list (the tempting shortcut) would keep passing
 * after core changed the real ABI — which is precisely the failure this file exists to
 * catch.
 */
function actionLoggedLog(opts: {
  agentId: Hash;
  value: bigint;
  txHash: Hash;
  logIndex: number;
  blockNumber: bigint;
  timestamp: number;
  address?: Address;
}): Log {
  const rationaleHash = keccak256(toHex(`rationale-${opts.logIndex}`));
  const [topic0, agentIdTopic, targetTopic, selectorTopic] = encodeEventTopics({
    abi: ACTION_LOGGER_ABI,
    eventName: "ActionLogged",
    args: { agentId: opts.agentId, target: TARGET, selector: SELECTOR },
  }) as [Hash, Hex, Hex, Hex];

  return {
    address: opts.address ?? MANAGER,
    topics: [topic0, agentIdTopic, targetTopic, selectorTopic],
    // Non-indexed params, in ABI order: value, rationaleHash, timestamp (uint48 → uint256 slot).
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint48" }],
      [opts.value, rationaleHash, BigInt(opts.timestamp)],
    ),
    blockNumber: opts.blockNumber,
    blockHash: keccak256(toHex(`block-${opts.blockNumber}`)),
    transactionHash: opts.txHash,
    transactionIndex: 0,
    logIndex: opts.logIndex,
    removed: false,
  } as Log;
}

/**
 * The `WindowCharged` counterpart: 2 indexed args ⇒ 3 topics, which is the *other* branch
 * of `ingestLogs`' dispatch. Same ABI-driven construction.
 */
function windowChargedLog(opts: { value: bigint; txHash: Hash; logIndex: number; blockNumber: bigint }): Log {
  const [topic0, accountTopic, keyTopic] = encodeEventTopics({
    abi: ACTION_LOGGER_ABI,
    eventName: "WindowCharged",
    args: { account: MANAGER, key: TARGET },
  }) as [Hash, Hex, Hex];

  return {
    address: MANAGER,
    topics: [topic0, accountTopic, keyTopic],
    // Non-indexed params in ABI order: value, windowStart (uint48), spentThisWindow.
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint48" }, { type: "uint256" }],
      [opts.value, BigInt(1_700_000_000), opts.value],
    ),
    blockNumber: opts.blockNumber,
    blockHash: keccak256(toHex(`block-${opts.blockNumber}`)),
    transactionHash: opts.txHash,
    transactionIndex: 0,
    logIndex: opts.logIndex,
    removed: false,
  } as Log;
}

const TX_A = "0x" + "a1".repeat(32) as Hash;
const TX_B = "0x" + "b2".repeat(32) as Hash;
const AGENT = "0x" + "11".repeat(32) as Hash;

describe("Flow A — core decode → indexer persist → agree", () => {
  it("round-trips a core ActionLogRecord through the indexer without losing a field", () => {
    // Guards: a cross-package field-name/shape drift. `ActionLogRecord` is declared in
    // core and *consumed* by the indexer's `storeAction`, but the persisted shape is
    // `StoredAction` — a different interface with different names (timestamp → ts,
    // bigint → decimal string). If core adds or renames a field and the indexer does not
    // follow, both packages still typecheck and the value is silently dropped on the way
    // into SQLite. Asserting the FULL round-trip catches that; asserting only `value`
    // would not.
    const log = actionLoggedLog({
      agentId: AGENT,
      value: 4_000_000_000_000_000n,
      txHash: TX_A,
      logIndex: 0,
      blockNumber: 100n,
      timestamp: 1_700_000_500,
    });

    // 1. core decodes. This is the object every other package treats as authoritative.
    const record = parseActionLogged([log]);
    expect(record, "core must decode the log it is the ABI owner for").not.toBeNull();
    const core: ActionLogRecord = record!;

    // 2. the indexer ingests it through the production path.
    const ix = new SigilIndexer(tempDb(), CHAIN_ID, { logger: silent() });
    try {
      expect(ix.ingestLogs([log])).toBe(1);

      const stored = ix.actionsForAgent(core.agentId);
      expect(stored).toHaveLength(1);
      const row: StoredAction = stored[0]!;

      // Every field, by name, across the package boundary.
      expect(row.agentId).toBe(core.agentId);
      expect(row.txHash).toBe(core.txHash);
      expect(row.logIndex).toBe(core.logIndex);
      expect(row.blockNumber).toBe(Number(core.blockNumber));
      expect(row.target).toBe(core.target);
      expect(row.selector).toBe(core.selector);
      expect(row.rationaleHash).toBe(core.rationaleHash);
      expect(row.value).toBe(core.value.toString());
      // The one genuinely lossy edge, pinned on purpose: uint48 seconds → INTEGER, and
      // bigint → TEXT because SQLite has no bigint. A future "optimisation" that stores
      // wei as a JS number would pass every other assertion in this file.
      expect(row.ts).toBe(core.timestamp);
      expect(row.chainId).toBe(CHAIN_ID);
    } finally {
      ix.close();
    }
  });

  it("keeps two ActionLogged events from ONE transaction as two rows", () => {
    // Guards: the natural-key contract. `ActionLogRecord` carries `logIndex` precisely
    // because two actions in the same tx share txHash/block/timestamp (BUG-5 in core's own
    // comment). The indexer's PK is (chain_id, tx_hash, log_index). If a future indexer
    // "simplified" the key, or if core stopped populating `logIndex`, both actions in one
    // tx would collapse into one row and the audit store would under-report spend —
    // silently, with no error anywhere. The demo agent's strategy can fire twice in one
    // block, so this is reachable in normal operation, not a contrived case.
    const logs = [
      actionLoggedLog({ agentId: AGENT, value: 1n, txHash: TX_A, logIndex: 0, blockNumber: 7n, timestamp: 1_700_000_000 }),
      actionLoggedLog({ agentId: AGENT, value: 2n, txHash: TX_A, logIndex: 1, blockNumber: 7n, timestamp: 1_700_000_000 }),
    ];
    // Both really are distinct logs in one tx — otherwise the test would be vacuous.
    expect(logs[0]!.transactionHash).toBe(logs[1]!.transactionHash);
    expect(logs[0]!.logIndex).not.toBe(logs[1]!.logIndex);

    const ix = new SigilIndexer(tempDb(), CHAIN_ID, { logger: silent() });
    try {
      expect(ix.ingestLogs(logs)).toBe(2);
      const rows = ix.actionsForAgent(AGENT);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.logIndex).sort()).toEqual([0, 1]);
      // And the money adds up, which is the property that actually matters downstream.
      expect(ix.spendByAgent(AGENT)).toBe(3n);
    } finally {
      ix.close();
    }
  });

  it("ingests ActionLogged and WindowCharged from the same log batch", () => {
    // Guards: the two-event ABI dispatch. `ingestLogs` routes on `topics.length` — 4 means
    // ActionLogged (3 indexed), 3 means WindowCharged (2 indexed). Both events live in
    // core's single `ACTION_LOGGER_ABI`. If a core ABI change altered either event's
    // indexed-ness (e.g. someone un-indexes `key` to save a topic), the indexer would
    // silently mis-route: a WindowCharged with 3 topics would be attempted as an
    // ActionLogged, fail to decode, and be *dropped without error*. Counting the return
    // value is what makes the drop visible.
    const ix = new SigilIndexer(tempDb(), CHAIN_ID, { logger: silent() });
    try {
      const stored = ix.ingestLogs([
        actionLoggedLog({ agentId: AGENT, value: 500n, txHash: TX_A, logIndex: 0, blockNumber: 9n, timestamp: 1_700_000_900 }),
        windowChargedLog({ value: 500n, txHash: TX_A, logIndex: 1, blockNumber: 9n }),
      ]);
      expect(stored, "both events in one batch must be stored").toBe(2);

      const charge = ix.latestWindowCharge(TARGET);
      expect(charge, "WindowCharged must reach window_charges, not be dropped").not.toBeNull();
      expect(charge!.value).toBe("500");
      expect(charge!.spentThisWindow).toBe("500");
      // Cross-table agreement: the charge is scoped to the key, the action to the agent.
      expect(ix.spendByAgent(AGENT)).toBe(500n);
    } finally {
      ix.close();
    }
  });

  it("keeps core's agentId byte form, so a mixed-case query silently finds nothing", () => {
    // Documents a REAL cross-package defect (not a hypothetical): core's
    // `parseActionLogged` returns the agentId as viem decoded it (lowercase), the indexer
    // stores that string verbatim, and SQLite compares TEXT with BINARY collation — so
    // the lookup is case-SENSITIVE end to end. Meanwhile core's own `assertHash32` (what
    // the MCP `audit_query` tool runs) returns the caller's string *verbatim* too, so a
    // checksummed or uppercase agentId from a model returns 0 spend against a store that
    // plainly holds the rows. Neither package is wrong on its own: core never promised to
    // normalise, and the indexer faithfully stores what it was given. It only breaks in
    // composition — which is why a single-package review cannot see it.
    //
    // This test is written to document CURRENT behaviour, so the risk stays visible and
    // any future normalisation shows up as a deliberate, reviewed change.
    const log = actionLoggedLog({ agentId: AGENT, value: 42n, txHash: TX_A, logIndex: 0, blockNumber: 3n, timestamp: 1_700_000_000 });
    const record = parseActionLogged([log])!;

    // core hands the indexer a lowercase bytes32.
    expect(record.agentId).toBe(record.agentId.toLowerCase());

    const ix = new SigilIndexer(tempDb(), CHAIN_ID, { logger: silent() });
    try {
      ix.ingestLogs([log]);
      // Exact form: matches (this is the only spelling the system currently supports).
      expect(ix.spendByAgent(AGENT)).toBe(42n);
      // Any other case: no match, and no error either — the silent false negative.
      const MIXED = ("0x" + "Ab".repeat(32)) as Hash;
      expect(ix.spendByAgent(MIXED)).toBe(0n);
      expect(ix.actionsForAgent(MIXED)).toEqual([]);
    } finally {
      ix.close();
    }
  });

  it("keeps SessionKeyManager.grantSessionKey's tuple in step with core's Scope", () => {
    // Guards the ABI the demo agent depends on. `TreasuryAgent`'s sibling
    // (`smoke.e2e.test.ts`) and `fleet.ts` both do
    // `encodeFunctionData({ abi: SESSION_KEY_MANAGER_ABI, functionName: "grantSessionKey",
    // args: [key, scope] })`, passing a core `Scope` straight in. viem encodes a struct
    // argument by *component name*, so renaming a field on either side — in `Scope` or in
    // the ABI's `scope` tuple — makes the grant encode with a missing/extra component.
    // The failure is deferred: the call still returns data, and it is the *contract* that
    // reverts (or, worse, silently mis-maps a cap). Nothing in core's own tests catches
    // it, because core's tests use `Scope` and the ABI in the same file.
    const grant = SESSION_KEY_MANAGER_ABI.find(
      (f) => f.type === "function" && f.name === "grantSessionKey",
    );
    expect(grant, "grantSessionKey must exist in the published ABI").toBeDefined();

    const scopeTuple = grant!.inputs[1]!;
    expect(scopeTuple.type).toBe("tuple");

    // The Scope keys are exactly the tuple's component names.
    const scopeKeys = Object.keys({
      expiresAt: 0,
      windowSeconds: 0,
      perActionCap: 0,
      perWindowCap: 0,
      merkleRoot: 0,
      countersignAbove: 0,
      enforceNativeDelta: 0,
      tokenWatchlist: 0,
    } satisfies Scope).sort();
    const componentNames = (scopeTuple as { components: readonly { name: string }[] }).components
      .map((c) => c.name)
      .sort();
    expect(componentNames, "SessionKeyManager.grantSessionKey's scope tuple must match core's Scope exactly").toEqual(scopeKeys);
  });

  it("exposes core's ActionLogged topic0 to the indexer unchanged", () => {
    // Guards the lowest-level seam: the indexer filters on `ACTION_LOGGED_TOPIC` via
    // core's `parseActionLogged`, and the contracts emit the real topic. If core's
    // hand-written constant drifted from the ABI, every log would decode to `null` and
    // `ingestLogs` would return 0 with no error — the indexer would look healthy and
    // quietly index nothing. Recomputing the topic from the ABI and from the canonical
    // signature string pins both sides.
    const fromAbi = encodeEventTopics({
      abi: ACTION_LOGGER_ABI,
      eventName: "ActionLogged",
      args: { agentId: AGENT, target: TARGET, selector: SELECTOR },
    })[0]!;
    expect(fromAbi.toLowerCase()).toBe(ACTION_LOGGED_TOPIC.toLowerCase());
    // And the canonical signature string that generated it.
    expect(ACTION_LOGGED_TOPIC).toBe(
      keccak256(toHex("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)")),
    );
  });
});

/** A logger that keeps the test output clean without changing behaviour. */
function silent() {
  return silentLogger;
}
