/**
 * E2E — Flow B: the MCP tool call chain, end to end, against its declared schema.
 *
 * What this covers that the existing MCP tests do not
 * ---------------------------------------------------
 * `mcp/test/validation.test.ts` and `mcp/test/mcp.test.ts` test the MCP package against
 * fixtures it builds itself. This file instead drives the *whole* chain across three
 * packages: a real JSON-RPC `tools/call` message goes through `handleMessage`, into the
 * tool body, down into `SigilIndexer` over a real SQLite file that the *indexer* wrote —
 * and then back out as the JSON text a model would receive.
 *
 * The point is the return *contract*. An MCP tool advertises a JSON Schema to the model,
 * but hands the model a `JSON.stringify`d string; nothing type-checks the two. A tool can
 * satisfy every existing test and still hand back a shape the schema never promised.
 * Each test here therefore validates the response against the tool's OWN `inputSchema`
 * and against the shape a consumer would actually destructure.
 *
 * No network and no child process: `handleMessage` is the same function `serveStdio` calls
 * per line, so this exercises the real dispatcher without a transport. The `stdout`
 * framing (`content[0].text` being a JSON *string*) is part of what we assert.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Address, type Hash, type Hex, type Log } from "viem";
import { ACTION_LOGGER_ABI, SIGILKIT_ERRORS_ABI } from "@sigilkit/core";
// P0-3: `silentLogger` is declared in `logger.ts` and is moving off the barrel. Only the
// logger symbol moves — the ABIs stay on the root entry, since `abis.ts` is not being touched.
import { silentLogger } from "@sigilkit/core/logger";
import { SigilIndexer } from "@sigilkit/indexer";
import { handleMessage, TOOLS, __setAuditDbRootsForTests } from "../../mcp/src/server.js";

const CHAIN_ID = 31337;
const MANAGER = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const TARGET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const SELECTOR = "0x32145f90" as Hex;
const AGENT = "0x" + "11".repeat(32) as Hash;
const OTHER_AGENT = "0x" + "99".repeat(32) as Hash;

/**
 * Wei amounts for AGENT, chosen so that a lossy `Number(...)` anywhere on the
 * indexer→MCP path is DETECTABLE.
 *
 * Being merely "large" is not enough: doubles have 53 significant bits, and near 3.7e18
 * the representable values are spaced 512 apart, so a round total like 3.7e18 IS exactly
 * representable and would sail through a `Number()` cast unchanged. These amounts are
 * therefore given odd low-order residues, which puts them off the 512-grid and makes
 * `String(Number(x)) !== x.toString()`. The `spend` test asserts that property of the
 * fixture itself, so if it ever stops holding, the fixture says so instead of quietly
 * becoming a test that cannot fail.
 */
const V1 = 1_200_000_000_000_000_007n;
const V2 = 2_500_000_000_000_000_009n;
const V1_PLUS_V2 = V1 + V2; // 3_700_000_000_000_000_016n — off the double grid
/** A second agent's spend, so a broken agent filter cannot coincide with the right answer. */
const V_OTHER = 777_000_000_000_000_777n;

/** Sandbox roots removed after each test; Windows holds a file lock on an open handle. */
const sandboxes: string[] = [];

/** A real, populated audit store, plus the allowlist entry that makes it reachable. */
function seededStore(): { db: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-e2e-b-"));
  sandboxes.push(root);
  const db = join(root, "audit.db");

  // The WRITER is the indexer, in its normal writable mode — not a hand-built SQLite file
  // with the right columns. If core and the indexer ever disagree about the event shape,
  // this is where the store stops matching what `audit_query` promises to read.
  const ix = new SigilIndexer(db, CHAIN_ID, { logger: silentLogger() });
  try {
    ix.ingestLogs([
      actionLoggedLog({ value: V1, txHash: ("0x" + "a1".repeat(32)) as Hash, logIndex: 0, blockNumber: 10n, timestamp: 1_700_000_000 }),
      actionLoggedLog({ value: V2, txHash: ("0x" + "b2".repeat(32)) as Hash, logIndex: 0, blockNumber: 11n, timestamp: 1_700_000_100 }),
    ]);
    ix.storeAction(
      // A second agent, so a `spend` query scoped to AGENT is a real filter and not a
      // coincidence that would make a broken WHERE clause look correct.
      coreRecord({
        agentId: OTHER_AGENT,
        value: V_OTHER,
        txHash: ("0x" + "c3".repeat(32)) as Hash,
        logIndex: 0,
        blockNumber: 12n,
        timestamp: 1_700_000_200,
      }),
    );
  } finally {
    ix.close();
  }

  // The MCP allowlist is module-global and latched; the test hook is the only way to set it.
  __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });
  return { db, root };
}

/** One `ActionLogged` log, encoded from core's ABI exactly as a node would return it. */
function actionLoggedLog(opts: {
  value: bigint;
  txHash: Hash;
  logIndex: number;
  blockNumber: bigint;
  timestamp: number;
}): Log {
  const [topic0, agentIdTopic, targetTopic, selectorTopic] = encodeEventTopics({
    abi: ACTION_LOGGER_ABI,
    eventName: "ActionLogged",
    args: { agentId: AGENT, target: TARGET, selector: SELECTOR },
  }) as [Hash, Hex, Hex, Hex];
  return {
    address: MANAGER,
    topics: [topic0, agentIdTopic, targetTopic, selectorTopic],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint48" }],
      [opts.value, keccak256(toHex("rationale")), opts.timestamp],
    ),
    blockNumber: opts.blockNumber,
    blockHash: keccak256(toHex(`block-${opts.blockNumber}`)),
    transactionHash: opts.txHash,
    transactionIndex: 0,
    logIndex: opts.logIndex,
    removed: false,
  } as Log;
}

/** What core's decoder produces, for the `storeAction` path (the non-log ingest route). */
function coreRecord(o: {
  agentId: Hash;
  value: bigint;
  txHash: Hash;
  logIndex: number;
  blockNumber: bigint;
  timestamp: number;
}): Parameters<SigilIndexer["storeAction"]>[0] {
  return {
    agentId: o.agentId,
    target: TARGET,
    selector: SELECTOR,
    value: o.value,
    rationaleHash: keccak256(toHex("rationale")),
    timestamp: o.timestamp,
    txHash: o.txHash,
    blockNumber: o.blockNumber,
    logIndex: o.logIndex,
  };
}

afterEach(() => {
  // Restores the fail-closed production default, so a leak can only make a later test
  // stricter — never looser.
  __setAuditDbRootsForTests({});
  while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

/** Sends one real JSON-RPC `tools/call` and returns the MCP envelope fields. */
async function callTool(name: string, args: Record<string, unknown>, id = 1): Promise<{
  isError: boolean;
  /** The `content[0].text` payload — a JSON *string*, which is what a model actually reads. */
  text: string;
  /** `text` parsed, when it is JSON. */
  json: <T = unknown>() => T;
  /** The full JSON-RPC envelope, for error-path assertions. */
  envelope: Record<string, unknown>;
}> {
  const res = await handleMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = res!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  return {
    isError: result.isError === true,
    text,
    json: <T,>() => JSON.parse(text) as T,
    envelope: res!,
  };
}

/** The declared schema for a tool, so a test can never check against a stale copy. */
function schemaOf(toolName: string): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === toolName);
  expect(tool, `${toolName} must exist in the tool surface`).toBeDefined();
  return tool!.inputSchema as Record<string, unknown>;
}

/** First row of a non-empty result, with a message instead of a bare undefined. */
function row0(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  expect(rows.length, "expected at least one row").toBeGreaterThan(0);
  return rows[0]!;
}

describe("Flow B — MCP tool chain (core + indexer) against the declared schema", () => {
  it("tools/list advertises a schema for every tool the dispatcher will actually route", async () => {
    // Guards: registry/dispatch drift. `tools/list` is built by mapping `TOOLS`, and
    // `tools/call` looks the tool up in the same array — so these cannot actually diverge
    // today. The assertion that matters is the last one: a tool with NO `required` array
    // cannot get the "missing required argument(s)" pre-flight check, which is the only
    // thing standing between a missing argument and a TypeError inside the handler.
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (res!.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;

    expect(tools.map((t) => t.name).sort()).toEqual(["audit_query", "build_scope", "decode_error", "validate_request"]);
    for (const t of tools) {
      expect(t.inputSchema, `${t.name} must declare an object schema`).toMatchObject({ type: "object" });
      expect(Array.isArray(t.inputSchema.required), `${t.name} must declare 'required' so tools/call can pre-validate`).toBe(true);
      expect((t.inputSchema.required as string[]).length, `${t.name} must require at least one argument`).toBeGreaterThan(0);
    }
  });

  it("audit_query{spend} returns the wei the indexer stored, as a decimal string", async () => {
    // Guards: the core → indexer → MCP value contract. `spendByAgent` returns a JS
    // bigint; the tool must not let `JSON.stringify` throw on it (bigint is not
    // serialisable) and must not silently lose precision by routing through `number`.
    // The V1/V2 fixture is built so a `Number(...)` cast anywhere on this path provably
    // changes the answer (see the assertion at the end, and the constants' own comment).
    const { db } = seededStore();

    const res = await callTool("audit_query", { db, query: "spend", agentId: AGENT });
    expect(res.isError, res.text).toBe(false);

    const body = res.json<{ agentId: string; chainId: number | null; totalWei: string }>();
    expect(body.agentId).toBe(AGENT);
    expect(body.chainId).toBeNull();
    // V1 + V2 for AGENT; the other agent's spend must NOT be folded in.
    expect(body.totalWei).toBe(V1_PLUS_V2.toString());
    // Round-trips as an exact integer.
    expect(BigInt(body.totalWei)).toBe(V1_PLUS_V2);

    // Precondition of this whole test: the fixture must be a value a double CANNOT
    // represent exactly. Without this, the assertions above would still pass against a
    // lossy implementation and the test would be decorative. Asserted here so that
    // changing V1/V2 to rounder numbers fails loudly instead of weakening the guard.
    expect(String(Number(V1_PLUS_V2))).not.toBe(V1_PLUS_V2.toString());
    expect(V1_PLUS_V2 > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("audit_query{spend} keeps the agent filter honest across the indexer boundary", async () => {
    // Guards: a WHERE clause that silently stopped filtering. `seededStore` writes two
    // agents; if `audit_query` ever dropped `agentId` from the query (or the indexer
    // ignored it), the answer would be V1+V2+V_OTHER instead of V1+V2. The two-agent
    // fixture exists specifically so "no filter" and "correct filter" cannot coincide.
    const { db } = seededStore();

    const scoped = await callTool("audit_query", { db, query: "spend", agentId: AGENT });
    const other = await callTool("audit_query", { db, query: "spend", agentId: OTHER_AGENT });
    const absent = await callTool("audit_query", { db, query: "spend", agentId: "0x" + "ee".repeat(32) });

    expect(scoped.json<{ totalWei: string }>().totalWei).toBe(V1_PLUS_V2.toString());
    expect(other.json<{ totalWei: string }>().totalWei).toBe(V_OTHER.toString());
    // An unknown agent is 0, not an error — and it is genuinely absent, not just filtered.
    expect(absent.json<{ totalWei: string }>().totalWei).toBe("0");
    // The unfiltered total must be strictly larger, so a dropped filter is detectable.
    expect(V1_PLUS_V2 + V_OTHER).toBeGreaterThan(V1_PLUS_V2);
  });

  it("audit_query{actions} returns exactly the 11 indexer fields, with the types the indexer actually produces", async () => {
    // The authoritative field list for anyone writing `audit_query`'s `outputSchema`.
    //
    // This was MEASURED, not copied from core's `ActionLogRecord` — running a real
    // `storeAction` + `actionsForAgent` round trip and reading `typeof` on every field.
    // That distinction is the whole point: three of these types differ from what core's
    // type says, and anyone transcribing from core would get all three wrong.
    //
    //   field          runtime  core's `ActionLogRecord` says   why they differ
    //   value          string   bigint                           SQLite has no bigint
    //   ts             number   number (named `timestamp`)       renamed to the column name
    //   blockNumber    number   bigint                           SQLite INTEGER, fits in double
    //   blockHash      string   Hash (non-null)                   nullable in the indexer
    //
    // `blockHash` is the trap, and it cuts BOTH ways: it is `string` via `ingestLogs`
    // (this fixture) but `null` via `storeAction` (whose parameter defaults to null).
    // So an outputSchema must declare it nullable — see the dedicated case below, which
    // covers the `storeAction` path so neither route can drift.
    const { db } = seededStore();

    const res = await callTool("audit_query", { db, query: "actions", agentId: AGENT });
    expect(res.isError, res.text).toBe(false);
    const rows = res.json<{ actions: Array<Record<string, unknown>> }>().actions;
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      // Exactly the documented set — no more, no fewer. A new column appearing in a row
      // is caught here rather than silently reaching a model undocumented.
      //
      // NOTE FOR THE NEXT READER — this list is a FLOOR, not a freeze. It deliberately does
      // NOT block the planned work: when the indexer owner migrates `ts` to `timestamp`
      // (or MCP adds a `timestamp` alias), this assertion is EXPECTED to need updating, and
      // that update is the migration landing — not a regression to be worked around. The
      // test below additionally REQUIRES any `timestamp` alias to carry the identical value
      // as `ts`, so the migration cannot produce two disagreeing spellings of one time.
      //
      // This is a deliberate application of "pin the invariant, not the snapshot": an
      // earlier draft asserted `not.toHaveProperty("timestamp")`, which turned the fix into
      // a test failure and would have blocked the migration outright.
      expect(Object.keys(row).sort()).toEqual([
        "agentId", "blockHash", "blockNumber", "chainId", "logIndex",
        "rationaleHash", "selector", "target", "ts", "txHash", "value",
      ]);
      // The measured runtime type of every field.
      const types = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, v === null ? "null" : typeof v]),
      );
      expect(types).toEqual({
        chainId: "number",
        txHash: "string",
        logIndex: "number",
        blockNumber: "number",
        // `string` here because this fixture goes through `ingestLogs`, which supplies a
        // block hash. The `storeAction` path yields `null` — covered separately below.
        blockHash: "string",
        agentId: "string",
        target: "string",
        selector: "string",
        value: "string",
        rationaleHash: "string",
        ts: "number",
      });
    }

  });

  it("audit_query{actions} reports blockHash as null for rows written without one", async () => {
    // The nullable-blockHash contract via the `storeAction` write path.
    //
    // NOTE ON JUSTIFICATION: an earlier draft of this test justified nullability with "MCP
    // might read a row written by `storeAction`". That reasoning is WRONG — MCP opens the
    // store `readOnly` and only ever calls `spendByAgent` / `actionsForAgent` / `summary` /
    // `chainIds`; it never writes, and `storeAction` would throw `assertWritable`. So no MCP
    // caller can reach this path.
    //
    // It is kept because `storeAction(r, blockHash = null)` (indexer.ts:589) is public API of
    // `@sigilkit/indexer`, and other consumers do use the indexer as a library. But it is
    // NOT the reason an MCP `outputSchema` must declare `blockHash` nullable — the real
    // reason is the migration path, pinned in the next test, which is reachable by MCP
    // without anyone writing anything.
    const root = mkdtempSync(join(tmpdir(), "sigilkit-e2e-nobh-"));
    sandboxes.push(root);
    const db = join(root, "audit.db");

    const ix = new SigilIndexer(db, CHAIN_ID, { logger: silentLogger() });
    try {
      ix.storeAction({
        agentId: AGENT,
        target: TARGET,
        selector: SELECTOR,
        value: 42n,
        rationaleHash: keccak256(toHex("r")),
        timestamp: 1_700_000_000,
        txHash: ("0x" + "d4".repeat(32)) as Hash,
        blockNumber: 13n,
        logIndex: 0,
      });
    } finally {
      ix.close();
    }
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });

    const res = await callTool("audit_query", { db, query: "actions", agentId: AGENT });
    expect(res.isError, res.text).toBe(false);
    const row = row0(res.json<{ actions: Array<Record<string, unknown>> }>().actions);

    // Present-but-null, NOT absent. The distinction matters to a schema author:
    // `"blockHash": null` is a declared nullable field, whereas a missing key means the
    // field does not exist at all and every consumer must guard with `in`.
    expect(row).toHaveProperty("blockHash");
    expect(row.blockHash).toBeNull();
    // The key set is identical to the ingestLogs path — only the value's nullability
    // differs, so the two paths cannot drift into different shapes.
    expect(Object.keys(row).sort()).toEqual([
      "agentId", "blockHash", "blockNumber", "chainId", "logIndex",
      "rationaleHash", "selector", "target", "ts", "txHash", "value",
    ]);
  });

  it("audit_query{actions} reports null blockHash for rows from a pre-migration store", async () => {
    // THE reason an MCP `outputSchema` must declare `blockHash` nullable — and it has
    // nothing to do with anyone calling `storeAction`. MCP opens the store read-only and
    // never writes, so no MCP code path can produce a hashless row. This one can.
    //
    // `TABLE_MIGRATIONS[0]` (indexer.ts:1409-1440) rebuilds a pre-09-12 `actions` table and
    // its `copy` statement writes `NULL` into `block_hash`, because the column did not exist
    // before that date. The migration runs when the store is OPENED — so any audit database
    // created before 09-12 and read by a current build yields rows whose `blockHash` is
    // null, with nobody having called a write API. Those databases are precisely the ones
    // the migration exists to preserve.
    //
    // So `null` is the NORMAL state of historical audit data, not an edge case. That is
    // what an `outputSchema` author (and the `description` shown to the model) needs to
    // know: a null `blockHash` means "this row predates block-hash tracking, so it cannot
    // be reorg-verified", which is materially different from "no block hash was supplied".
    //
    // The legacy table is built by hand here on purpose: it is the pre-09-12 shape, which
    // the current writer can no longer produce.
    const root = mkdtempSync(join(tmpdir(), "sigilkit-e2e-legacy-"));
    sandboxes.push(root);
    const db = join(root, "legacy.db");

    // A pre-09-12 store: the legacy `actions` table has NEITHER `block_hash` NOR
    // `log_index` — `log_index` is the migration's `probeColumn`, i.e. its absence is
    // exactly the "not yet migrated" signal. Column set mirrors
    // `packages/indexer/test/migrate.test.ts:48-59`.
    const legacy = new DatabaseSync(db);
    legacy.exec(`
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
      );
    `);
    legacy.prepare(
      `INSERT INTO actions (tx_hash, block_number, agent_id, target, selector, value, rationale_hash, ts, chain_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "0x" + "e5".repeat(32),
      7,
      AGENT,
      TARGET,
      SELECTOR,
      "1200000000000000007",
      keccak256(toHex("r")),
      1_699_000_000,
      CHAIN_ID,
    );
    legacy.close();

    // Opening the store is all it takes — no write API involved.
    const ix = new SigilIndexer(db, CHAIN_ID, { logger: silentLogger() });
    try {
      const rows = ix.actionsForAgent(AGENT);
      expect(rows, "the migration must carry the legacy row forward").toHaveLength(1);
      // The row survived the rebuild, and `blockHash` is null purely because of the
      // migration's backfill.
      expect(rows[0]!.blockHash).toBeNull();
      // `logIndex` for a migrated row is the legacy SQLite `rowid`, NOT the on-chain log
      // index — the legacy table had no `log_index` column at all, so the migration's
      // `copy` substitutes `rowid` (indexer.ts:1434). Here rowid is 1 (SQLite rowids are
      // 1-based), which is itself proof the value is a stand-in: the row I inserted is the
      // first in the table, and its real chain log index was never recorded anywhere.
      //
      // PRECISION (an earlier draft of this comment overstated the consequence, and the
      // correction matters because a false warning is worse than no warning):
      //
      // (chain_id, tx_hash, log_index) IS the primary key, so a stand-in value does sit in
      // de-duplication semantics. But migrated rows CANNOT overwrite each other: the legacy
      // primary key was (tx_hash, agent_id, target, selector, ts), so two legacy rows in the
      // same transaction necessarily differ in one of those columns, get distinct `rowid`s,
      // and therefore distinct `log_index` values. De-duplication between migrated rows is
      // therefore correct.
      //
      // The only collision path is a migrated row vs a NEWLY written row for the same
      // (chain_id, tx_hash) whose real log index happens to equal some migrated row's rowid.
      // That is a genuine but narrow, theoretical case — and a false alarm here would tell a
      // model the audit store may lose rows, which is not a risk that exists.
      expect(rows[0]!.logIndex).toBe(1);
    } finally {
      ix.close();
    }

    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });
    const res = await callTool("audit_query", { db, query: "actions", agentId: AGENT });
    expect(res.isError, res.text).toBe(false);
    const row = row0(res.json<{ actions: Array<Record<string, unknown>> }>().actions);

    expect(row.blockHash).toBeNull();
    // Identical key set to a freshly-written store: migration changes a VALUE's
    // nullability, never the row's shape.
    expect(Object.keys(row).sort()).toEqual([
      "agentId", "blockHash", "blockNumber", "chainId", "logIndex",
      "rationaleHash", "selector", "target", "ts", "txHash", "value",
    ]);
  });

  it("two legacy rows in ONE transaction survive migration as two rows, not one", async () => {
    // Proves the correction to my own overstated comment above, as an executable fact.
    //
    // I had written that a rowid stand-in "participates in de-duplication semantics it does
    // not really mean", which reads as "the audit store can lose rows". That is a false
    // alarm, and a false alarm about audit data is worse than silence. The reason it is
    // false is a specific, checkable property of the LEGACY primary key:
    //
    //   legacy PK = (tx_hash, agent_id, target, selector, ts)
    //
    // Two legacy rows in the same transaction must therefore differ in agent_id, target,
    // selector or ts. Two distinct legacy rows always got distinct SQLite `rowid`s, so
    // after migration they get distinct `log_index` values and cannot collide under the new
    // (chain_id, tx_hash, log_index) primary key. De-duplication among migrated rows is
    // therefore correct.
    //
    // This test builds exactly that case — same tx, two different actions — because it is
    // the case that would expose a collision if the claim were wrong. Without it, "they
    // cannot collide" would be an unchecked assertion in a comment, which is precisely the
    // failure mode this whole file exists to catch.
    const root = mkdtempSync(join(tmpdir(), "sigilkit-e2e-legacy2-"));
    sandboxes.push(root);
    const db = join(root, "legacy.db");

    const legacy = new DatabaseSync(db);
    legacy.exec(`
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
      );
    `);
    // Same tx_hash, same block, different selector and ts — two distinct actions in one tx.
    const ins = legacy.prepare(
      `INSERT INTO actions (tx_hash, block_number, agent_id, target, selector, value, rationale_hash, ts, chain_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const sharedTx = "0x" + "e6".repeat(32);
    ins.run(sharedTx, 9, AGENT, TARGET, "0x11111111", "11", keccak256(toHex("r")), 1_699_000_000, CHAIN_ID);
    ins.run(sharedTx, 9, AGENT, TARGET, "0x22222222", "22", keccak256(toHex("r")), 1_699_000_001, CHAIN_ID);
    legacy.close();

    const ix = new SigilIndexer(db, CHAIN_ID, { logger: silentLogger() });
    let rows: Array<{ logIndex: number; selector: string }>;
    try {
      rows = ix.actionsForAgent(AGENT);
    } finally {
      ix.close();
    }

    // Two rows, not one: the migration did not collapse them.
    expect(rows, "two actions in one tx must not be de-duplicated into a single row").toHaveLength(2);
    // Distinct rowid-derived log indexes — the mechanism that makes this safe.
    const logIndexes = rows.map((r) => r.logIndex).sort((a, b) => a - b);
    expect(new Set(logIndexes).size, "migrated rows must have distinct log_index values").toBe(2);
    // And both selectors survived, so they are genuinely two different actions rather than
    // one row written twice.
    expect(rows.map((r) => r.selector.toLowerCase()).sort()).toEqual(["0x11111111", "0x22222222"]);

    // Non-vacuity: the assertions above must be capable of failing. The legacy table's
    // primary key is what guarantees distinct rows in the first place, so prove the PK
    // really is rejecting a true duplicate — otherwise "two rows survive" could be passing
    // because the insert silently never happened twice.
    const dup = new DatabaseSync(db, { readOnly: true });
    let pkRejectsDuplicate = false;
    try {
      dup.prepare(
        `INSERT INTO actions_legacy (tx_hash, block_number, agent_id, target, selector, value, rationale_hash, ts, chain_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(sharedTx, 9, AGENT, TARGET, "0x11111111", "11", keccak256(toHex("r")), 1_699_000_000, CHAIN_ID);
    } catch {
      pkRejectsDuplicate = true; // UNIQUE/PK violation — the guarantee we rely on
    } finally {
      dup.close();
    }
    expect(pkRejectsDuplicate, "the legacy primary key must reject an exact duplicate").toBe(true);
  });

  it("audit_query{actions} returns StoredAction rows whose fields survive JSON encoding", async () => {
    // Guards: the biggest cross-package shape seam in the codebase. The row travels
    // indexer `StoredAction` → `JSON.stringify` → model. Two values are typed
    // differently on each side of that seam, both deliberately:
    //   - `value` is wei-as-TEXT in the indexer (SQLite has no bigint) but a bigint in
    //     core, so a lossy number anywhere silently corrupts money;
    //   - the timestamp is `ts` in the indexer (its column name) but `timestamp` in
    //     core, so a consumer reading the core name gets `undefined`.
    // A consumer that assumed the core shapes would see an audit trail with no amounts
    // and no times on it.
    const { db } = seededStore();

    const res = await callTool("audit_query", { db, query: "actions", agentId: AGENT });
    expect(res.isError, res.text).toBe(false);

    const body = res.json<{ actions: Array<Record<string, unknown>> }>();
    expect(body.actions).toHaveLength(2);
    for (const row of body.actions) {
      // Every field the indexer documents, present and correctly typed after serialisation.
      expect(row).toMatchObject({
        chainId: expect.any(Number),
        txHash: expect.any(String),
        logIndex: expect.any(Number),
        blockNumber: expect.any(Number),
        agentId: AGENT,
        target: TARGET,
        selector: SELECTOR,
        rationaleHash: expect.any(String),
      });
      // wei survives as a *string*, not a lossy double.
      expect(typeof row.value).toBe("string");

      // Timestamp. The indexer's authoritative name is `ts` (it is the SQLite column
      // name) while core's `ActionLogRecord` calls the same value `timestamp` — that is a
      // DELIBERATE, documented difference (indexer.ts:94-96), not two competing fields.
      // So the invariant is *one value, at most one extra alias*, never a third spelling:
      //   - `ts` must exist and be the unix-seconds number;
      //   - if a `timestamp` alias is ever added, it must carry the IDENTICAL value, so a
      //     consumer reading either name cannot disagree about when the action happened;
      //   - no other spelling may appear.
      expect(typeof row.ts).toBe("number");
      if ("timestamp" in row) expect(row.timestamp).toBe(row.ts);
      for (const third of ["time", "blockTime", "eventTime", "blockTimestamp"]) {
        expect(row, `no third spelling of the timestamp may appear`).not.toHaveProperty(third);
      }
      // Self-check on the guards above, so they cannot silently become vacuous:
      //   - the `not.toHaveProperty` form used in the loop really does fire when the
      //     property IS present (i.e. the loop is capable of catching a new spelling);
      //   - the alias rule accepts a CONSISTENT alias and rejects a DIVERGENT one.
      expect(() => expect({ blockTime: 1 }).not.toHaveProperty("blockTime")).toThrow();
      expect(() => expect({ blockTime: 1 }).not.toHaveProperty("nothingHere")).not.toThrow();
      const consistent = { ts: 5, timestamp: 5 };
      const divergent = { ts: 5, timestamp: 6 };
      expect(() => { if ("timestamp" in consistent) expect(consistent.timestamp).toBe(consistent.ts); }).not.toThrow();
      expect(() => { if ("timestamp" in divergent) expect(divergent.timestamp).toBe(divergent.ts); }).toThrow();
      // `rationaleHash` is the one name both packages agree on; anything else is a typo.
      expect(row).not.toHaveProperty("rationaleHash32");
    }
    // The exact decimal strings, beyond 2^53 — a lossy cast cannot produce these.
    expect(body.actions.map((r) => r.value).sort()).toEqual([V1.toString(), V2.toString()].sort());
    for (const row of body.actions) {
      expect(BigInt(row.value as string)).toBe(row.value === V1.toString() ? V1 : V2);
    }
  });

  it("audit_query{actions} honours an explicit limit and keeps the newest rows", async () => {
    // Guards the `limit` parameter across the MCP→indexer call. The indexer treats
    // "omitted" and "explicit" differently (omitted = fail-closed probe), so passing
    // `limit: undefined` straight through would change behaviour; the tool must forward a
    // *number* or nothing at all. `limit: 1` returning the OLDER row would mean the
    // ordering contract ("the newest N") was lost in translation.
    const { db } = seededStore();

    const res = await callTool("audit_query", { db, query: "actions", agentId: AGENT, limit: 1 });
    expect(res.isError, res.text).toBe(false);
    const body = res.json<{ actions: Array<{ blockNumber: number; value: string }> }>();
    expect(body.actions).toHaveLength(1);
    // Newest = block 11 (V2), not block 10 (V1).
    expect(body.actions[0]!.value).toBe(V2.toString());
    expect(body.actions[0]!.blockNumber).toBe(11);
  });

  it("audit_query{summary} reports both chains and matches the indexed row count", async () => {
    // Guards: the summary string is built by the indexer from SQL, and the response shape
    // is assembled by MCP. If either drifted — say the indexer changed "audited actions"
    // to "actions", or MCP renamed `chains` — a monitoring dashboard would read
    // `undefined` while the tool still reported success.
    const { db } = seededStore();

    const res = await callTool("audit_query", { db });
    expect(res.isError, res.text).toBe(false);

    const body = res.json<{ summary: string; chains: number[] }>();
    expect(body.chains).toEqual([CHAIN_ID]);
    expect(body.summary).toContain("audited actions");
    // 3 rows total: two for AGENT, one for the second agent.
    expect(body.summary).toContain("3 audited actions");
    expect(body.summary).toContain("2 agents");
  });

  it("audit_query echoes the arguments a model sent, and declares no output schema", async () => {
    // Documents a REAL gap in the MCP surface: `tools/list` advertises only an
    // `inputSchema`. No tool here declares an `outputSchema`, so the response shape is
    // documented *only* by the prose description and by the handler body. Nothing
    // type-checks them, which is why every other test in this file pins the response
    // shape explicitly rather than validating it against a declared contract.
    //
    // A response that DID carry a usable outputSchema is a precondition for that to change,
    // so it is asserted here: this test fails the day someone adds one, at which point the
    // response assertions in this file should be re-pointed at it.
    const { db } = seededStore();
    const schema = schemaOf("audit_query");
    expect(schema.outputSchema, "no tool declares an output schema today — see the note above").toBeUndefined();

    for (const args of [
      { db },
      { db, query: "spend", agentId: AGENT },
      { db, query: "actions", agentId: AGENT },
      { db, query: "spend", agentId: AGENT, chainId: CHAIN_ID },
    ]) {
      const res = await callTool("audit_query", args);
      expect(res.isError, `${JSON.stringify(args)} → ${res.text}`).toBe(false);
      const body = res.json<Record<string, unknown>>();

      // The response must be shaped by the mode that was requested — a body whose keys
      // match none of the modes is indistinguishable from a tool that ignored its args.
      const mode = (args.query as string | undefined) ?? "summary";
      const expectedKey = mode === "spend" ? "totalWei" : mode === "actions" ? "actions" : "summary";
      expect(Object.keys(body), `query:${mode} must return its own discriminator`).toContain(expectedKey);

      // The arguments a model can observe are echoed back unchanged. `chainId` is
      // normalised to `null` for "all chains" — the one deliberate transformation, pinned
      // so it cannot become a silent one.
      if (mode === "summary") {
        expect(body).toMatchObject({ summary: expect.any(String), chains: expect.any(Array) });
      } else {
        expect(body.agentId).toBe(args.agentId);
        expect(body.chainId).toBe(args.chainId ?? null);
      }
    }
  });

  it("refuses a database outside the allowlist, without echoing the path", async () => {
    // Guards the MCP→filesystem boundary that the indexer knows nothing about. The tool
    // advertises itself read-only and policy-gated; `audit_query` must not become a way
    // to probe the disk. The indexer, opened directly, would happily serve any path it is
    // given — the allowlist is MCP's job, so nothing in the indexer's own tests covers it.
    const inside = seededStore();
    const outsideRoot = mkdtempSync(join(tmpdir(), "sigilkit-e2e-outside-"));
    sandboxes.push(outsideRoot);
    const outsideDb = join(outsideRoot, "loot.db");
    const ix = new SigilIndexer(outsideDb, CHAIN_ID, { logger: silentLogger() });
    ix.close();

    // Only `inside.root` is allowlisted.
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: inside.root });

    const res = await callTool("audit_query", { db: outsideDb, query: "summary" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("DB_NOT_ALLOWED");
    // No confirmation or denial of the guess — that is the whole point of the uniform error.
    expect(res.text).not.toContain(outsideDb);
    expect(res.text).not.toContain("loot.db");
  });

  it("stays read-only: a query against a real store mutates nothing on disk", async () => {
    // Guards: `audit_query` opens the indexer with `{ readOnly: true }`. If that flag were
    // dropped, SQLite would happily migrate/create tables — so the FIRST query against a
    // store written by a *newer* schema could silently rewrite it. Asserting the file is
    // byte-identical before and after is the only check that actually proves read-only;
    // the indexer's own tests assert the flag, not the on-disk effect.
    const { db } = seededStore();
    const before = readFileBytes(db);

    for (const args of [
      { db, query: "spend", agentId: AGENT },
      { db, query: "actions", agentId: AGENT },
      { db, query: "summary" },
    ]) {
      expect((await callTool("audit_query", args)).isError).toBe(false);
    }

    expect(readFileBytes(db), "audit_query must not write, migrate or vacuum the store").toEqual(before);
  });

  it("validate_request and build_scope agree on the Merkle root core will verify", async () => {
    // Guards the MCP→core policy chain, and the only cross-package *crypto* seam.
    // `build_scope` returns a root computed by core's `merkleRoot`; `validate_request`
    // checks membership with core's `validateAgainstScope`. But the MCP tool never passes a
    // `merkleProof` (`merkleProof: undefined`, hard-coded), so any scope with a non-zero
    // root is ALWAYS rejected — including one `build_scope` just produced. That is a
    // genuine, currently-live inconsistency between two tools in the same package, and it
    // is invisible from either side alone: `build_scope`'s tests only check the root is
    // non-zero, and `validate_request`'s tests only use a zero (allow-all) root.
    const built = await callTool("build_scope", {
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      perActionCap: "1000000000000000000",
      perWindowCap: "2000000000000000000",
      targets: [{ target: TARGET, selector: SELECTOR }],
    });
    expect(built.isError, built.text).toBe(false);
    const scope = built.json<{ scope: { merkleRoot: string } }>().scope;
    expect(scope.merkleRoot).not.toBe("0x" + "0".repeat(64));

    const verdict = await callTool("validate_request", {
      request: {
        agentId: AGENT,
        target: TARGET,
        selector: SELECTOR,
        value: "0",
        nonce: "0",
        expiry: Math.floor(Date.now() / 1000) + 600,
        rationaleHash: "0x" + "22".repeat(32),
        data: "0x",
      },
      scope,
    });
    expect(verdict.isError, verdict.text).toBe(false);
    // DOCUMENTED CURRENT BEHAVIOUR: the tool rejects the very scope build_scope minted,
    // because no proof can be supplied through this interface. Pinned so that fixing it
    // is a deliberate, visible change rather than a silent behaviour change.
    expect(verdict.json<{ ok: boolean; reason?: string }>()).toMatchObject({
      ok: false,
      reason: "target not whitelisted",
    });
  });

  it("decode_error decodes a revert built from core's own error ABI", async () => {
    // Guards: MCP→core error decoding. `decodeSigilKitError` matches on a 4-byte selector
    // against `SIGILKIT_ERRORS_ABI`. If core's ABI list and its selector table drift apart,
    // a real `PerActionCapExceeded` revert would decode to "unknown error" and an operator
    // debugging a refused action would get nothing. The data here is assembled the way the
    // contract assembles it, from the ABI that ships in core.
    const errors = coreSigilitKitErrors();
    const perActionCap = errors.find((e) => e.type === "error" && e.name === "PerActionCapExceeded");
    expect(perActionCap, "core must publish PerActionCapExceeded").toBeDefined();

    const selector = keccak256(toHex("PerActionCapExceeded(uint256,uint256)")).slice(0, 10);
    const args = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [1_200n, 500n],
    );
    const res = await callTool("decode_error", { data: selector + args.slice(2) });
    expect(res.isError, res.text).toBe(false);
    const body = res.json<{ name: string; args: string[] }>();
    expect(body.name).toBe("PerActionCapExceeded");
    // bigint args must be JSON-safe; `JSON.stringify` throws on a raw bigint, so the
    // dispatcher's bigint replacer is load-bearing for every decode_error response.
    expect(body.args).toEqual(["1200", "500"]);
  });
});

/** core's error ABI, re-read per call so a rename cannot hide behind a stale import. */
function coreSigilitKitErrors(): ReadonlyArray<Record<string, unknown>> {
  return SIGILKIT_ERRORS_ABI as unknown as ReadonlyArray<Record<string, unknown>>;
}

/** Reads the store's bytes, so "read-only" is a fact about the file and not a claim. */
function readFileBytes(path: string): Buffer {
  return readFileSync(path) as Buffer;
}
