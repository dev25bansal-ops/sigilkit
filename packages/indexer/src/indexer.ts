/**
 * @sigilkit/indexer — turns SigilKit's mandatory audit events into queryable spend
 * reports (enhancement E9). The "mandatory audit" moat terminates at the log; this
 * package is its consumer: ActionLogged (per-action) + WindowCharged (per-charge)
 * land in SQLite (node:sqlite, zero native deps) with query helpers for per-agent
 * spend, per-target activity, and window reconciliation.
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
  txHash: string;
  blockNumber: number;
  agentId: string;
  target: string;
  selector: string;
  /** Wei as decimal string (SQLite has no bigint). */
  value: string;
  rationaleHash: string;
  /** Unix seconds (the audit event's block timestamp). */
  ts: number;
  chainId: number;
}

export interface StoredWindowCharge {
  txHash: string;
  account: string;
  key: string;
  value: string;
  windowStart: number;
  spentThisWindow: string;
  chainId: number;
}

export class SigilIndexer {
  private readonly db: DatabaseSync;
  readonly chainId: number;

  constructor(dbPath: string, chainId: number) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.chainId = chainId;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS actions (
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
      CREATE TABLE IF NOT EXISTS window_charges (
        tx_hash TEXT NOT NULL,
        account TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        spent_this_window TEXT NOT NULL,
        chain_id INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_actions_agent ON actions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_actions_target ON actions(target);
      CREATE INDEX IF NOT EXISTS idx_charges_key ON window_charges(key);
    `);
  }

  /** Stores one decoded ActionLogged record (idempotent per tx+action). */
  storeAction(r: ActionLogRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO actions
         (tx_hash, block_number, agent_id, target, selector, value, rationale_hash, ts, chain_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.txHash,
        Number(r.blockNumber),
        r.agentId,
        r.target,
        r.selector,
        r.value.toString(),
        r.rationaleHash,
        r.timestamp,
        this.chainId,
      );
  }

  storeWindowCharge(c: StoredWindowCharge): void {
    this.db
      .prepare(
        `INSERT INTO window_charges
         (tx_hash, account, key, value, window_start, spent_this_window, chain_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.txHash, c.account, c.key, c.value, c.windowStart, c.spentThisWindow, c.chainId);
  }

  /**
   * Decodes raw receipt logs and stores every SigilKit event found. Returns the
   * number of events stored (actions + window charges).
   */
  ingestLogs(logs: Log[]): number {
    let stored = 0;
    for (const log of logs) {
      const action = parseActionLogged(logs.length ? [log] : []);
      if (action) {
        this.storeAction(action);
        stored++;
        continue;
      }
      if (log.topics.length === 3) {
        try {
          const decoded = decodeEventLog({ abi: ACTION_LOGGER_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === "WindowCharged") {
            const a = decoded.args as unknown as Record<string, unknown>;
            this.storeWindowCharge({
              txHash: log.transactionHash as string,
              account: String(a.account),
              key: String(a.key),
              value: (a.value as bigint).toString(),
              windowStart: Number(a.windowStart),
              spentThisWindow: (a.spentThisWindow as bigint).toString(),
              chainId: this.chainId,
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

  /** Backfills from `fromBlock` (default: genesis) and returns stored event count. */
  async backfill(client: PublicClient, managerAddress: Address, fromBlock?: bigint): Promise<number> {
    const logs = await client.getLogs({
      address: managerAddress,
      fromBlock: fromBlock ?? 0n,
      toBlock: "latest",
    });
    return this.ingestLogs(logs);
  }

  /**
   * Follows live events until the returned disposer is called. Errors during
   * polling are logged, never thrown — an indexer must not die mid-stream.
   */
  watch(client: PublicClient, managerAddress: Address, pollMs = 4000): () => void {
    let lastBlock = 0n;
    let stopped = false;
    const tick = async () => {
      while (!stopped) {
        try {
          const head = await client.getBlockNumber();
          if (lastBlock === 0n) lastBlock = head; // start from "now"
          if (head > lastBlock) {
            const logs = await client.getLogs({
              address: managerAddress,
              fromBlock: lastBlock + 1n,
              toBlock: head,
            });
            this.ingestLogs(logs);
            lastBlock = head;
          }
        } catch (err) {
          console.error("[sigilkit-indexer] poll failed:", err instanceof Error ? err.message : err);
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    };
    void tick();
    return () => {
      stopped = true;
    };
  }

  /** Cumulative native spend per agent (wei) — summed in JS to avoid 64-bit overflow. */
  spendByAgent(agentId: Hash): bigint {
    const rows = this.db
      .prepare(`SELECT value FROM actions WHERE agent_id = ?`)
      .all(agentId) as Array<{ value: string }>;
    return rows.reduce((acc, r) => acc + BigInt(r.value), 0n);
  }

  actionsForAgent(agentId: Hash): StoredAction[] {
    return this.db
      .prepare(`SELECT * FROM actions WHERE agent_id = ? ORDER BY ts ASC`)
      .all(agentId) as unknown as StoredAction[];
  }

  actionsForTarget(target: Address): StoredAction[] {
    return this.db
      .prepare(`SELECT * FROM actions WHERE target = ? ORDER BY ts ASC`)
      .all(target) as unknown as StoredAction[];
  }

  /** Latest window charge row for a key — the on-chain window position. */
  latestWindowCharge(key: Address): StoredWindowCharge | null {
    const row = this.db
      .prepare(
        `SELECT * FROM window_charges WHERE key = ? ORDER BY window_start DESC, rowid DESC LIMIT 1`,
      )
      .get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      txHash: String(row.tx_hash),
      account: String(row.account),
      key: String(row.key),
      value: String(row.value),
      windowStart: Number(row.window_start),
      spentThisWindow: String(row.spent_this_window),
      chainId: Number(row.chain_id),
    };
  }

  /** Human summary for CLI output. */
  summary(): string {
    const actions = (this.db.prepare(`SELECT COUNT(*) AS n FROM actions`).get() as { n: number }).n;
    const charges = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM window_charges`).get() as { n: number }
    ).n;
    const agents = (this.db.prepare(`SELECT COUNT(DISTINCT agent_id) AS n FROM actions`).get() as { n: number }).n;
    return `chain ${this.chainId}: ${actions} audited actions across ${agents} agents, ${charges} window charges`;
  }

  /** Formatted (decimal) value for display. */
  static formatWei(wei: string, decimals = 18): string {
    return formatUnits(BigInt(wei), decimals);
  }
}
