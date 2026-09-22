/**
 * @sigilkit/indexer — turns SigilKit's mandatory audit events into queryable spend
 * reports (enhancement E9). The "mandatory audit" moat terminates at the log; this
 * package is its consumer: ActionLogged (per-action) + WindowCharged (per-charge)
 * land in SQLite (node:sqlite, zero native deps) with query helpers for per-agent
 * spend, per-target activity, and window reconciliation.
 *
 * Durability guarantees (2026-09-12 hardening):
 *  - Lossless   — rows are keyed by (chain_id, tx_hash, log_index), so N actions in one
 *                 transaction produce N rows (BUG-5). Previously the key omitted the log
 *                 index, and `INSERT OR IGNORE` silently dropped same-shape siblings.
 *  - Idempotent — every write is an upsert on that natural key, so re-indexing a range
 *                 never duplicates rows (BUG-6).
 *  - Resumable  — the sync cursor lives in `sync_state`, not in a local variable, so a
 *                 restart resumes exactly where it stopped instead of jumping to the head
 *                 and silently skipping blocks (BUG-7).
 *  - Reorg-aware— `block_hash` is stored, `removed` logs are deleted, and polling stops
 *                 `confirmations` blocks behind the head (ARCH-2).
 *  - Fail-closed— the persisted cursor stores the `end` block hash and it is re-validated
 *                 before every range fetch; a missing, unavailable or mismatched header
 *                 stops the run *before any write* (B64). The indexer never rolls back
 *                 automatically — a reorg must be resolved by the operator, because the
 *                 schema has no manager-scoped row ownership and an automatic delete
 *                 could remove another manager's rows.
 *  - Resilient  — getLogs is chunked to `maxBlockRange` and retried with exponential
 *                 backoff, so a large catch-up range degrades instead of dying (PERF-5/ARCH-3).
 *  - Multi-chain— `chain_id` is stored per row and accepted as a per-query filter; one
 *                 database can hold several chains (ARCH-4).
 *  - Read-only  — `{ readOnly: true }` performs no mkdir, no DDL and no writes (BUG-9).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  decodeEventLog,
  formatUnits,
  type Address,
  type Hash,
  type Log,
  type PublicClient,
} from "viem";
import { ACTION_LOGGER_ABI, createLogger, parseActionLogged, type ActionLogRecord, type Logger } from "@sigilkit/core";

export interface StoredAction {
  chainId: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string | null;
  agentId: string;
  target: string;
  selector: string;
  /** Wei as decimal string (SQLite has no bigint). */
  value: string;
  rationaleHash: string;
  /** Unix seconds (the audit event's block timestamp). */
  ts: number;
}

export interface StoredWindowCharge {
  chainId: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  account: string;
  key: string;
  value: string;
  windowStart: number;
  spentThisWindow: string;
}

export interface SigilIndexerOptions {
  /**
   * Open the database read-only (BUG-9): no directory creation, no DDL, no writes.
   * Used by the MCP `audit_query` tool, which advertises itself as read-only.
   */
  readOnly?: boolean;
  /**
   * Blocks to stay behind the chain head while watching (ARCH-2). Default 12 — deep
   * enough for Base-class finality assumptions; raise it for chains with deeper reorgs.
   */
  confirmations?: number;
  /** Maximum block span per `eth_getLogs` call (PERF-5). Default 2_000. */
  maxBlockRange?: number;
  /** Base backoff in ms for a failed poll; doubles per attempt (ARCH-3). Default 1_000. */
  backoffMs?: number;
  /** Max attempts per `eth_getLogs` chunk before giving up on that chunk. Default 5. */
  maxRetries?: number;
  /**
   * Logger for progress and poll failures. Defaults to a console-backed logger at
   * `info`, so an embedder that supplies nothing still sees warnings. Pass
   * `silentLogger()` to make the indexer completely quiet.
   */
  logger?: Logger;
}

const DEFAULT_OPTIONS: Required<Omit<SigilIndexerOptions, "readOnly" | "logger">> = {
  confirmations: 12,
  maxBlockRange: 2_000,
  backoffMs: 1_000,
  maxRetries: 5,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A canonical 32-byte block hash: `0x` + exactly 64 hex chars (B64). */
const BLOCK_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** A log as it appears in a `removed` (reorged-out) response. */
type MaybeRemovedLog = Log & { removed?: boolean };

export class SigilIndexer {
  private readonly db: DatabaseSync;
  /** Default chain for writes; queries may override or omit it (ARCH-4). */
  readonly chainId: number;
  readonly readOnly: boolean;
  private readonly confirmations: number;
  private readonly maxBlockRange: number;
  private readonly backoffMs: number;
  private readonly maxRetries: number;
  private readonly log: Logger;
  private closed = false;

  constructor(dbPath: string, chainId: number, options: SigilIndexerOptions = {}) {
    this.chainId = chainId;
    this.readOnly = options.readOnly === true;
    this.confirmations = options.confirmations ?? DEFAULT_OPTIONS.confirmations;
    this.maxBlockRange = options.maxBlockRange ?? DEFAULT_OPTIONS.maxBlockRange;
    this.backoffMs = options.backoffMs ?? DEFAULT_OPTIONS.backoffMs;
    this.maxRetries = options.maxRetries ?? DEFAULT_OPTIONS.maxRetries;
    this.log = options.logger ?? createLogger({ scope: "indexer" });

    if (!this.readOnly && dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, this.readOnly ? { readOnly: true } : {});
    try {
      if (!this.readOnly) {
        this.migrate();
        this.db.exec(SCHEMA);
      }
    } catch (error) {
      try { this.db.close(); }
      catch (closeError) {
        throw new AggregateError([error, closeError], `Indexer initialization failed: ${String(error)}; cleanup failed: ${String(closeError)}`);
      }
      throw error;
    }
  }

  /**
   * Brings a pre-2026-09-12 database up to the lossless schema (BUG-5/BUG-6).
   * SQLite cannot alter a PRIMARY KEY in place, so the affected tables are rebuilt.
   * Legacy rows have no recorded log index; `rowid` is used as a stable stand-in so
   * no existing audit data is lost.
   */
  private migrate(): void {
    const columns = (table: string): string[] =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );

    const tables = (
      this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>
    ).map((t) => t.name);

    if (tables.includes("actions") && !columns("actions").includes("log_index")) {
      this.db.exec(`
        ALTER TABLE actions RENAME TO actions_legacy;
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
        );
        INSERT INTO actions
          (chain_id, tx_hash, log_index, block_number, block_hash, agent_id, target, selector, value, rationale_hash, ts)
        SELECT chain_id, tx_hash, rowid, block_number, NULL, agent_id, target, selector, value, rationale_hash, ts
        FROM actions_legacy;
        DROP TABLE actions_legacy;
      `);
    }

    if (tables.includes("window_charges") && !columns("window_charges").includes("log_index")) {
      this.db.exec(`
        ALTER TABLE window_charges RENAME TO window_charges_legacy;
        CREATE TABLE window_charges (
          chain_id INTEGER NOT NULL,
          tx_hash TEXT NOT NULL,
          log_index INTEGER NOT NULL,
          block_number INTEGER NOT NULL,
          account TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          spent_this_window TEXT NOT NULL,
          PRIMARY KEY (chain_id, tx_hash, log_index)
        );
        INSERT INTO window_charges
          (chain_id, tx_hash, log_index, block_number, account, key, value, window_start, spent_this_window)
        SELECT chain_id, tx_hash, rowid, 0, account, key, value, window_start, spent_this_window
        FROM window_charges_legacy;
        DROP TABLE window_charges_legacy;
      `);
    }
  }

  // ── writes ────────────────────────────────────────────────────────────────────

  private assertWritable(op: string): void {
    if (this.readOnly) throw new Error(`SigilIndexer: ${op} is not available in read-only mode`);
  }

  /** Stores one decoded ActionLogged record (idempotent on chain+tx+logIndex). */
  storeAction(r: ActionLogRecord, blockHash: string | null = null, chainId = this.chainId): void {
    this.assertWritable("storeAction");
    this.db
      .prepare(
        `INSERT INTO actions
           (chain_id, tx_hash, log_index, block_number, block_hash, agent_id, target, selector, value, rationale_hash, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, tx_hash, log_index) DO UPDATE SET
           block_number = excluded.block_number,
           block_hash   = excluded.block_hash,
           agent_id     = excluded.agent_id,
           target       = excluded.target,
           selector     = excluded.selector,
           value        = excluded.value,
           rationale_hash = excluded.rationale_hash,
           ts           = excluded.ts`,
      )
      .run(
        chainId,
        r.txHash,
        r.logIndex,
        Number(r.blockNumber),
        blockHash,
        r.agentId,
        r.target,
        r.selector,
        r.value.toString(),
        r.rationaleHash,
        r.timestamp,
      );
  }

  /** Stores one WindowCharged record (idempotent on chain+tx+logIndex). */
  storeWindowCharge(c: StoredWindowCharge): void {
    this.assertWritable("storeWindowCharge");
    this.db
      .prepare(
        `INSERT INTO window_charges
           (chain_id, tx_hash, log_index, block_number, account, key, value, window_start, spent_this_window)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, tx_hash, log_index) DO UPDATE SET
           block_number      = excluded.block_number,
           account           = excluded.account,
           key               = excluded.key,
           value             = excluded.value,
           window_start      = excluded.window_start,
           spent_this_window = excluded.spent_this_window`,
      )
      .run(
        c.chainId,
        c.txHash,
        c.logIndex,
        c.blockNumber,
        c.account,
        c.key,
        c.value,
        c.windowStart,
        c.spentThisWindow,
      );
  }

  /**
   * Decodes raw receipt logs and stores every SigilKit event found. Returns the number
   * of events stored. Reorged-out (`removed: true`) logs are deleted instead of inserted
   * (ARCH-2).
   */
  ingestLogs(logs: Log[]): number {
    this.assertWritable("ingestLogs");
    let stored = 0;
    for (const raw of logs) {
      const log = raw as MaybeRemovedLog;
      if (log.removed) {
        this.removeLog(log);
        continue;
      }
      const action = parseActionLogged([log]);
      if (action) {
        this.storeAction(action, (log.blockHash as string | null) ?? null);
        stored++;
        continue;
      }
      if (log.topics.length === 3) {
        let decoded;
        try {
          decoded = decodeEventLog({ abi: ACTION_LOGGER_ABI, data: log.data, topics: log.topics });
        } catch {
          continue;
        }
        if (decoded.eventName === "WindowCharged") {
          const a = decoded.args;
          this.storeWindowCharge({
            chainId: this.chainId,
            txHash: log.transactionHash as string,
            logIndex: Number(log.logIndex ?? 0),
            blockNumber: Number(log.blockNumber ?? 0),
            account: a.account,
            key: a.key,
            value: a.value.toString(),
            windowStart: Number(a.windowStart),
            spentThisWindow: a.spentThisWindow.toString(),
          });
          stored++;
        }
      }
    }
    return stored;
  }

  /** Deletes the rows for a log that a reorg removed (ARCH-2). */
  private removeLog(log: MaybeRemovedLog): void {
    const chainId = this.chainId;
    const txHash = log.transactionHash as string;
    const logIndex = Number(log.logIndex ?? 0);
    this.db
      .prepare(`DELETE FROM actions WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`)
      .run(chainId, txHash, logIndex);
    this.db
      .prepare(`DELETE FROM window_charges WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`)
      .run(chainId, txHash, logIndex);
  }

  /**
   * Rolls the index back to a block, discarding anything above it and rewinding the
   * persisted cursor (ARCH-2). Note: the rewound cursor carries a null hash, so this is a
   * *clearing* primitive, not a recovery path for the B64 fail-closed check — a reorg that
   * `validateCursor` detected must be resolved by rebuilding a separate database.
   */
  rollbackTo(blockNumber: number, manager?: Address): void {
    this.assertWritable("rollbackTo");
    this.db.prepare(`DELETE FROM actions WHERE chain_id = ? AND block_number > ?`).run(
      this.chainId,
      blockNumber,
    );
    this.db.prepare(`DELETE FROM window_charges WHERE chain_id = ? AND block_number > ?`).run(
      this.chainId,
      blockNumber,
    );
    if (manager) this.setCursor(manager, blockNumber, null);
  }

  // ── cursor (BUG-7) ────────────────────────────────────────────────────────────

  /** Persisted sync cursor for a (chain, manager) pair, or null when unset. */
  getCursor(manager: Address): { lastBlock: number; lastBlockHash: string | null } | null {
    const row = this.db
      .prepare(`SELECT last_block, last_block_hash FROM sync_state WHERE chain_id = ? AND manager = ?`)
      .get(this.chainId, manager.toLowerCase()) as
      | { last_block: number; last_block_hash: string | null }
      | undefined;
    if (!row) return null;
    return { lastBlock: Number(row.last_block), lastBlockHash: row.last_block_hash };
  }

  private setCursor(manager: Address, lastBlock: number, lastBlockHash: string | null): void {
    this.assertWritable("setCursor");
    this.db
      .prepare(
        `INSERT INTO sync_state (chain_id, manager, last_block, last_block_hash, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, manager) DO UPDATE SET
           last_block = excluded.last_block,
           last_block_hash = excluded.last_block_hash,
           updated_at = excluded.updated_at`,
      )
      .run(this.chainId, manager.toLowerCase(), lastBlock, lastBlockHash, Math.floor(Date.now() / 1000));
  }

  private commitRange(
    logs: Log[], manager: Address, end: bigint, endHash: Hash,
    expectedCursor: ReturnType<SigilIndexer["getCursor"]>,
  ): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getCursor(manager);
      if (current?.lastBlock !== expectedCursor?.lastBlock || current?.lastBlockHash !== expectedCursor?.lastBlockHash) {
        throw new Error("SigilIndexer: checkpoint changed during collection; retry from the current checkpoint");
      }
      const stored = this.ingestLogs(logs);
      this.setCursor(manager, Number(end), endHash);
      this.db.exec("COMMIT");
      return stored;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "SigilIndexer: range commit and rollback failed");
      }
      throw error;
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────────

  /** Fetches a range in `maxBlockRange` chunks, retrying each chunk with backoff. */
  private async fetchLogsChunked(
    client: PublicClient,
    managerAddress: Address,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Log[]> {
    const out: Log[] = [];
    const span = BigInt(this.maxBlockRange);
    let cursor = fromBlock;
    while (cursor <= toBlock) {
      const end = cursor + span - 1n > toBlock ? toBlock : cursor + span - 1n;
      out.push(...(await this.getLogsWithRetry(client, managerAddress, cursor, end)));
      cursor = end + 1n;
    }
    return out;
  }

  private async getLogsWithRetry(
    client: PublicClient,
    managerAddress: Address,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Log[]> {
    let attempt = 0;
    for (;;) {
      try {
        return await client.getLogs({ address: managerAddress, fromBlock, toBlock });
      } catch (err) {
        attempt++;
        if (attempt >= this.maxRetries) throw err;
        const delay = this.backoffMs * 2 ** (attempt - 1);
        this.log.warn("getLogs failed; retrying", {
          from: fromBlock.toString(),
          to: toBlock.toString(),
          attempt,
          maxRetries: this.maxRetries,
          delayMs: delay,
          reason: err instanceof Error ? err.message : String(err),
        });
        await sleep(delay);
      }
    }
  }

  /**
   * Reads the hash of a single block header. Throws when the node cannot serve the
   * header (unknown/future/pruned block, transient RPC failure) or serves a value that is
   * not a canonical 32-byte hash — the caller must treat that as fail-closed, never as
   * "no reorg".
   */
  private async getBlockHash(client: PublicClient, blockNumber: bigint): Promise<Hash> {
    const block = await client.getBlock({ blockNumber });
    const hash = (block as { hash?: unknown } | null)?.hash;
    if (block?.number !== blockNumber || typeof hash !== "string" || !BLOCK_HASH_RE.test(hash)) {
      throw new Error(
        `block ${blockNumber} header unavailable or malformed ` +
          `(expected 0x + 64 hex chars, got ${String(hash)})`,
      );
    }
    return hash as Hash;
  }

  /**
   * Fail-closed validation of a persisted cursor (B64). A cursor is only usable when it
   * carries a block hash that the RPC still serves at that exact height:
   *  - null hash  → legacy database. We cannot tell whether the rows below it are
   *                 canonical, so resuming could permanently anchor orphaned rows.
   *  - mismatch   → the chain reorged past the cursor; re-fetching from here would mix
   *                 orphaned and canonical rows.
   *  - unavailable→ we cannot prove the cursor is canonical.
   * All three throw *before* any row is written. No automatic rollback is attempted: the
   * schema keys rows only by (chain_id, tx_hash, log_index), with no manager ownership, so
   * a blind delete could destroy another manager's data. Resolution is the operator's call.
   */
  private async validateCursor(
    client: PublicClient,
    cursor: { lastBlock: number; lastBlockHash: string | null },
    manager: Address,
  ): Promise<void> {
    if (cursor.lastBlockHash === null) {
      throw new Error(
        `SigilIndexer: sync cursor for manager ${manager} at block ${cursor.lastBlock} has no recorded block hash ` +
          `(legacy database written before cursor-hash hardening). Fail-closed: refusing to continue, because a ` +
          `hash-less cursor cannot be checked for reorgs and resuming could silently anchor orphaned rows. ` +
          `Preserve this database as-is, then rebuild a separate fresh database (a new --db path) and re-index ` +
          `from a clean sync; do not delete this file. No rows were modified.`,
      );
    }
    let actual: Hash;
    try {
      actual = await this.getBlockHash(client, BigInt(cursor.lastBlock));
    } catch (err) {
      throw new Error(
        `SigilIndexer: cannot verify cursor block ${cursor.lastBlock} for manager ${manager} ` +
          `(${err instanceof Error ? err.message : String(err)}). Fail-closed: stopping before any writes.`,
      );
    }
    if (actual.toLowerCase() !== cursor.lastBlockHash.toLowerCase()) {
      throw new Error(
        `SigilIndexer: reorg detected at cursor block ${cursor.lastBlock} for manager ${manager}: ` +
          `stored hash ${cursor.lastBlockHash} != chain hash ${actual}. Fail-closed: stopping before any writes and ` +
          `leaving the cursor unchanged. Inspect the reorg, preserve this database as-is, and rebuild a separate ` +
          `fresh database (a new --db path) from a clean sync; do not delete this file. Do not use rollbackTo to ` +
          `recover: it clears the cursor hash, so the rewound cursor cannot be validated and the next run fails ` +
          `closed again. No rows were deleted automatically.`,
      );
    }
  }

  /**
   * Validates log membership and rechecks the range end and prior checkpoint after
   * collection. Requires a trusted, consistent canonical-header RPC: these reads do
   * not prove ancestry or log completeness against a dishonest/inconsistent provider.
   * All RPC work completes before opening the persistence transaction.
   */
  private async fetchRangeWithStableEnd(
    client: PublicClient,
    managerAddress: Address,
    fromBlock: bigint,
    toBlock: bigint,
    cursor: ReturnType<SigilIndexer["getCursor"]>,
  ): Promise<{ logs: Log[]; endHash: Hash }> {
    const before = await this.getBlockHash(client, toBlock);
    const logs = await this.fetchLogsChunked(client, managerAddress, fromBlock, toBlock);
    const headers = new Map<bigint, Hash>([[toBlock, before]]);
    for (const log of logs) {
      if (log.removed || log.blockNumber === null || log.blockNumber < fromBlock || log.blockNumber > toBlock ||
          log.blockHash === null || !BLOCK_HASH_RE.test(log.blockHash) ||
          log.address.toLowerCase() !== managerAddress.toLowerCase()) {
        throw new Error("SigilIndexer: invalid log membership in fetched range; refusing to commit");
      }
      let hash = headers.get(log.blockNumber);
      if (hash === undefined) {
        hash = await this.getBlockHash(client, log.blockNumber);
        headers.set(log.blockNumber, hash);
      }
      if (log.blockHash.toLowerCase() !== hash.toLowerCase()) {
        throw new Error("SigilIndexer: log/header hash mismatch; refusing to commit");
      }
    }
    const after = await this.getBlockHash(client, toBlock);
    if (before.toLowerCase() !== after.toLowerCase()) {
      throw new Error(
        `SigilIndexer: block ${toBlock} changed while fetching logs (${before} -> ${after}). ` +
          `Fail-closed: discarding the fetched range without writing rows or advancing the cursor.`,
      );
    }
    if (cursor) {
      const nextBlock = BigInt(cursor.lastBlock) + 1n;
      if (fromBlock > nextBlock) {
        throw new Error("SigilIndexer: range skips blocks after the checkpoint; refusing to commit");
      }
      if (toBlock >= nextBlock) {
        const first = await client.getBlock({ blockNumber: nextBlock });
        if (first?.number !== nextBlock || typeof first.hash !== "string" || !BLOCK_HASH_RE.test(first.hash) ||
            typeof first.parentHash !== "string" || !BLOCK_HASH_RE.test(first.parentHash) ||
            first.parentHash.toLowerCase() !== cursor.lastBlockHash?.toLowerCase() ||
            (headers.has(nextBlock) && first.hash.toLowerCase() !== headers.get(nextBlock)?.toLowerCase())) {
          throw new Error("SigilIndexer: checkpoint parent boundary unavailable or inconsistent; refusing to commit");
        }
      }
      await this.validateCursor(client, cursor, managerAddress);
    }
    return { logs, endHash: after };
  }

  /**
   * Backfills from `fromBlock` (default: the persisted cursor, else genesis) up to
   * `toBlock` (default: head − confirmations) and persists the cursor with the `end`
   * block hash (BUG-7, ARCH-2, B64). Returns the number of events stored.
   *
   * Fail-closed: the existing cursor hash is validated even when there is nothing new to
   * fetch, the `end` header must be stable across the fetch, and any failure throws before
   * a single row is written. No automatic rollback ever runs.
   */
  async backfill(
    client: PublicClient,
    managerAddress: Address,
    fromBlock?: bigint,
    toBlock?: bigint,
  ): Promise<number> {
    this.assertWritable("backfill");
    const cursor = this.getCursor(managerAddress);
    // Validate before any RPC that fetches logs — including when caught up — so a reorg
    // at the cursor is detected instead of being skipped over (B64).
    if (cursor) await this.validateCursor(client, cursor, managerAddress);

    const start = fromBlock ?? (cursor ? BigInt(cursor.lastBlock) + 1n : 0n);
    const head = await client.getBlockNumber();
    const safeHead = head - BigInt(this.confirmations);
    const end = toBlock ?? (safeHead > 0n ? safeHead : 0n);
    if (end < start) {
      // Distinguish "caught up" from "confirmations clipped the range": on short
      // chains (local dev, fresh testnets) a large confirmations default can push
      // safeHead below the requested start, silently indexing nothing.
      if (toBlock === undefined && head < start + BigInt(this.confirmations)) {
        this.log.warn(
          "backfill window is empty: head is below start + confirmations",
          { head: head.toString(), start: start.toString(), confirmations: this.confirmations },
        );
        this.log.warn("pass --confirmations 0 for local/dev chains");
      }
      return 0;
    }

    const { logs, endHash } = await this.fetchRangeWithStableEnd(
      client,
      managerAddress,
      start,
      end,
      cursor,
    );
    return this.commitRange(logs, managerAddress, end, endHash, cursor);
  }

  /**
   * Follows live events until the returned disposer is called. Stays `confirmations`
   * blocks behind the head (ARCH-2), chunks getLogs (PERF-5) and backs off on failure
   * (ARCH-3). Errors are logged, never thrown — an indexer must not die mid-stream.
   *
   * Fail-closed (B64): each tick re-validates the persisted cursor hash — before the
   * short-head skip, so an empty safe window cannot hide a reorg — and requires a stable
   * `safeHead` header across the fetch. A reorg or an unavailable header makes the tick
   * throw, which the existing catch turns into a logged backoff-and-retry; the cursor is
   * not advanced and no rollback is attempted until an operator resolves it.
   */
  watch(client: PublicClient, managerAddress: Address, pollMs = 4000): () => void {
    this.assertWritable("watch");
    let stopped = false;

    const tick = async (): Promise<void> => {
      let consecutiveFailures = 0;
      while (!stopped) {
        try {
          const head = await client.getBlockNumber();
          const safeHead = head - BigInt(this.confirmations);
          // Cursor is re-read each tick so an external rollback is respected (BUG-7).
          const cursor = this.getCursor(managerAddress);
          // Validate *before* the short-head skip (B64): a reorg at the cursor must stop
          // the tick even when the safe window is still empty and there is nothing to
          // fetch, otherwise the divergence would be silently ignored until the head
          // advances past it.
          if (cursor) await this.validateCursor(client, cursor, managerAddress);
          if (safeHead <= 0n) {
            consecutiveFailures = 0;
            await sleep(pollMs);
            continue;
          }
          const from = cursor ? BigInt(cursor.lastBlock) + 1n : safeHead;
          if (safeHead >= from) {
            const { logs, endHash } = await this.fetchRangeWithStableEnd(
              client,
              managerAddress,
              from,
              safeHead,
              cursor,
            );
            this.commitRange(logs, managerAddress, safeHead, endHash, cursor);
          }
          consecutiveFailures = 0;
        } catch (err) {
          consecutiveFailures++;
          const delay = Math.min(this.backoffMs * 2 ** (consecutiveFailures - 1), 60_000);
          this.log.error("poll failed; backing off", { attempt: consecutiveFailures, delayMs: delay }, err);
          await sleep(delay);
          continue;
        }
        await sleep(pollMs);
      }
    };

    void tick();
    return () => {
      stopped = true;
    };
  }

  // ── queries (chainId is an optional filter — ARCH-4) ──────────────────────────

  /** Cumulative native spend per agent (wei) — summed in JS to avoid 64-bit overflow. */
  spendByAgent(agentId: Hash, chainId?: number): bigint {
    const rows = (
      chainId === undefined
        ? this.db.prepare(`SELECT value FROM actions WHERE agent_id = ?`).all(agentId)
        : this.db
            .prepare(`SELECT value FROM actions WHERE agent_id = ? AND chain_id = ?`)
            .all(agentId, chainId)
    ) as Array<{ value: string }>;
    return rows.reduce((acc, r) => acc + BigInt(r.value), 0n);
  }

  actionsForAgent(agentId: Hash, chainId?: number): StoredAction[] {
    const rows =
      chainId === undefined
        ? this.db
            .prepare(`SELECT * FROM actions WHERE agent_id = ? ORDER BY block_number ASC, log_index ASC`)
            .all(agentId)
        : this.db
            .prepare(
              `SELECT * FROM actions WHERE agent_id = ? AND chain_id = ? ORDER BY block_number ASC, log_index ASC`,
            )
            .all(agentId, chainId);
    return (rows as Array<Record<string, unknown>>).map(toStoredAction);
  }

  actionsForTarget(target: Address, chainId?: number): StoredAction[] {
    const rows =
      chainId === undefined
        ? this.db
            .prepare(`SELECT * FROM actions WHERE target = ? ORDER BY block_number ASC, log_index ASC`)
            .all(target)
        : this.db
            .prepare(
              `SELECT * FROM actions WHERE target = ? AND chain_id = ? ORDER BY block_number ASC, log_index ASC`,
            )
            .all(target, chainId);
    return (rows as Array<Record<string, unknown>>).map(toStoredAction);
  }

  /** Latest window charge row for a key — the on-chain window position. */
  latestWindowCharge(key: Address, chainId?: number): StoredWindowCharge | null {
    const row = (
      chainId === undefined
        ? this.db
            .prepare(
              `SELECT * FROM window_charges WHERE key = ? ORDER BY window_start DESC, block_number DESC, log_index DESC LIMIT 1`,
            )
            .get(key)
        : this.db
            .prepare(
              `SELECT * FROM window_charges WHERE key = ? AND chain_id = ? ORDER BY window_start DESC, block_number DESC, log_index DESC LIMIT 1`,
            )
            .get(key, chainId)
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      chainId: Number(row.chain_id),
      txHash: String(row.tx_hash),
      logIndex: Number(row.log_index),
      blockNumber: Number(row.block_number),
      account: String(row.account),
      key: String(row.key),
      value: String(row.value),
      windowStart: Number(row.window_start),
      spentThisWindow: String(row.spent_this_window),
    };
  }

  /** Distinct chain ids present in the store (ARCH-4). */
  chainIds(): number[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT chain_id FROM actions
           UNION SELECT DISTINCT chain_id FROM window_charges
           ORDER BY chain_id ASC`,
        )
        .all() as Array<{ chain_id: number }>
    ).map((r) => Number(r.chain_id));
  }

  /** Human summary for CLI output. Pass a chainId to scope it to one chain. */
  summary(chainId?: number): string {
    const where = chainId === undefined ? "" : " WHERE chain_id = ?";
    const args = chainId === undefined ? [] : [chainId];
    const one = (sql: string): number =>
      Number((this.db.prepare(sql).get(...args) as { n: number }).n);
    const actions = one(`SELECT COUNT(*) AS n FROM actions${where}`);
    const charges = one(`SELECT COUNT(*) AS n FROM window_charges${where}`);
    const agents = one(`SELECT COUNT(DISTINCT agent_id) AS n FROM actions${where}`);
    const scope = chainId === undefined ? `chains ${this.chainIds().join(", ") || "none"}` : `chain ${chainId}`;
    return `${scope}: ${actions} audited actions across ${agents} agents, ${charges} window charges`;
  }

  /** Formatted (decimal) value for display. */
  static formatWei(wei: string, decimals = 18): string {
    return formatUnits(BigInt(wei), decimals);
  }

  /**
   * Releases the underlying SQLite handle. Call this when finished (and before
   * deleting the database file — Windows keeps an exclusive lock otherwise).
   * Idempotent: repeated calls are a no-op.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function toStoredAction(row: Record<string, unknown>): StoredAction {
  return {
    chainId: Number(row.chain_id),
    txHash: String(row.tx_hash),
    logIndex: Number(row.log_index),
    blockNumber: Number(row.block_number),
    blockHash: row.block_hash === null || row.block_hash === undefined ? null : String(row.block_hash),
    agentId: String(row.agent_id),
    target: String(row.target),
    selector: String(row.selector),
    value: String(row.value),
    rationaleHash: String(row.rationale_hash),
    ts: Number(row.ts),
  };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS actions (
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
  );
  CREATE TABLE IF NOT EXISTS window_charges (
    chain_id INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    account TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    spent_this_window TEXT NOT NULL,
    PRIMARY KEY (chain_id, tx_hash, log_index)
  );
  CREATE TABLE IF NOT EXISTS sync_state (
    chain_id INTEGER NOT NULL,
    manager TEXT NOT NULL,
    last_block INTEGER NOT NULL,
    last_block_hash TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chain_id, manager)
  );
  CREATE INDEX IF NOT EXISTS idx_actions_agent ON actions(chain_id, agent_id);
  CREATE INDEX IF NOT EXISTS idx_actions_target ON actions(chain_id, target);
  CREATE INDEX IF NOT EXISTS idx_charges_key ON window_charges(chain_id, key);
`;
