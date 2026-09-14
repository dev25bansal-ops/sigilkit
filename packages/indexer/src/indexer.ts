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
import { ACTION_LOGGER_ABI, parseActionLogged, type ActionLogRecord } from "@sigilkit/core";

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
}

const DEFAULT_OPTIONS: Required<Omit<SigilIndexerOptions, "readOnly">> = {
  confirmations: 12,
  maxBlockRange: 2_000,
  backoffMs: 1_000,
  maxRetries: 5,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  private closed = false;

  constructor(dbPath: string, chainId: number, options: SigilIndexerOptions = {}) {
    this.chainId = chainId;
    this.readOnly = options.readOnly === true;
    this.confirmations = options.confirmations ?? DEFAULT_OPTIONS.confirmations;
    this.maxBlockRange = options.maxBlockRange ?? DEFAULT_OPTIONS.maxBlockRange;
    this.backoffMs = options.backoffMs ?? DEFAULT_OPTIONS.backoffMs;
    this.maxRetries = options.maxRetries ?? DEFAULT_OPTIONS.maxRetries;

    if (!this.readOnly && dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, this.readOnly ? { readOnly: true } : {});
    if (!this.readOnly) {
      this.migrate();
      this.db.exec(SCHEMA);
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
        try {
          const decoded = decodeEventLog({ abi: ACTION_LOGGER_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === "WindowCharged") {
            const a = decoded.args as unknown as Record<string, unknown>;
            this.storeWindowCharge({
              chainId: this.chainId,
              txHash: log.transactionHash as string,
              logIndex: Number(log.logIndex ?? 0),
              blockNumber: Number(log.blockNumber ?? 0),
              account: String(a.account),
              key: String(a.key),
              value: (a.value as bigint).toString(),
              windowStart: Number(a.windowStart),
              spentThisWindow: (a.spentThisWindow as bigint).toString(),
            });
            stored++;
          }
        } catch {
          // not a SigilKit event — skip
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
   * persisted cursor. Call after detecting a reorg at `blockNumber` (ARCH-2).
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
        console.error(
          `[sigilkit-indexer] getLogs ${fromBlock}-${toBlock} failed (attempt ${attempt}/${this.maxRetries}), retrying in ${delay}ms:`,
          err instanceof Error ? err.message : err,
        );
        await sleep(delay);
      }
    }
  }

  /**
   * Backfills from `fromBlock` (default: the persisted cursor, else genesis) up to
   * `toBlock` (default: head − confirmations) and persists the cursor (BUG-7, ARCH-2).
   * Returns the number of events stored.
   */
  async backfill(
    client: PublicClient,
    managerAddress: Address,
    fromBlock?: bigint,
    toBlock?: bigint,
  ): Promise<number> {
    const cursor = this.getCursor(managerAddress);
    const start = fromBlock ?? (cursor ? BigInt(cursor.lastBlock) + 1n : 0n);
    const head = await client.getBlockNumber();
    const safeHead = head - BigInt(this.confirmations);
    const end = toBlock ?? (safeHead > 0n ? safeHead : 0n);
    if (end < start) {
      // Distinguish "caught up" from "confirmations clipped the range": on short
      // chains (local dev, fresh testnets) a large confirmations default can push
      // safeHead below the requested start, silently indexing nothing.
      if (toBlock === undefined && head < start + BigInt(this.confirmations)) {
        console.warn(
          `[sigilkit-indexer] head=${head} < start=${start} + confirmations=${this.confirmations}: ` +
            `backfill window is empty. Pass --confirmations 0 for local/dev chains.`,
        );
      }
      return 0;
    }

    const logs = await this.fetchLogsChunked(client, managerAddress, start, end);
    const stored = this.ingestLogs(logs);
    this.setCursor(managerAddress, Number(end), null);
    return stored;
  }

  /**
   * Follows live events until the returned disposer is called. Stays `confirmations`
   * blocks behind the head (ARCH-2), chunks getLogs (PERF-5) and backs off on failure
   * (ARCH-3). Errors are logged, never thrown — an indexer must not die mid-stream.
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
          if (safeHead <= 0n) {
            consecutiveFailures = 0;
            await sleep(pollMs);
            continue;
          }
          // Cursor is re-read each tick so an external rollback is respected (BUG-7).
          const cursor = this.getCursor(managerAddress);
          const from = cursor ? BigInt(cursor.lastBlock) + 1n : safeHead;
          if (safeHead >= from) {
            const logs = await this.fetchLogsChunked(client, managerAddress, from, safeHead);
            this.ingestLogs(logs);
            this.setCursor(managerAddress, Number(safeHead), null);
          }
          consecutiveFailures = 0;
        } catch (err) {
          consecutiveFailures++;
          const delay = Math.min(this.backoffMs * 2 ** (consecutiveFailures - 1), 60_000);
          console.error(
            `[sigilkit-indexer] poll failed (${consecutiveFailures}):`,
            err instanceof Error ? err.message : err,
          );
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
