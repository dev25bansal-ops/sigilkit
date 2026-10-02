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
 *  - Atomic     — schema migration runs inside one `BEGIN IMMEDIATE`…`COMMIT` and is
 *                 versioned by `PRAGMA user_version` plus a `STRICT` `_migrations`
 *                 ledger, so a crash can never leave a half-migrated (mixed-schema)
 *                 database and an already-migrated one is skipped entirely (BUG-07).
 *                 A database stamped by a newer build is refused rather than written.
 *  - Resilient  — getLogs is chunked to `maxBlockRange` and retried with exponential
 *                 backoff, so a large catch-up range degrades instead of dying (PERF-5/ARCH-3).
 *  - Multi-chain— `chain_id` is stored per row and accepted as a per-query filter; one
 *                 database can hold several chains (ARCH-4).
 *  - Read-only  — `{ readOnly: true }` performs no mkdir, no DDL and no writes (BUG-9).
 *  - Bound to a chain (SEC-15) — every range fetch first asks the RPC for its own
 *                 `eth_chainId` and refuses to continue when it is not the chain this
 *                 store is keyed by. This closes a silent-corruption hole the other
 *                 checks cannot reach: header/log hash agreement proves a log set is
 *                 *internally consistent*, not that it came from the intended chain, so
 *                 pointing `--rpc` at Base while `--chain-id` stays at Anvil's default
 *                 31337 would validate cleanly and then stamp every row 31337 — making
 *                 `audit_query{chainId: 8453}` return empty, a false negative in the one
 *                 place this moat is supposed to hold. An endpoint that cannot answer
 *                 `eth_chainId` is refused too. See `assertRpcChainIdentity`.
 *
 *  Chain identity is a *runtime* invariant, not a persisted one. A `meta`-style
 *  "expected chain id" row would give a three-way check (config ∧ RPC ∧ database) and
 *  would survive an operator editing `--chain-id` between runs, but that requires new
 *  schema — a new table or column, a `SCHEMA` entry and a `TABLE_MIGRATIONS` step — and
 *  `SCHEMA`/`migrate()` are owned outside this file, so the check is deliberately limited
 *  to the endpoint actually in use. **Consequence for operators: `--chain-id` (or
 *  `SIGILKIT_INDEXER_CHAIN_ID`) must be kept consistent with the `--rpc` endpoint; the
 *  indexer detects a mismatch on the first fetch of every run and stops, but a database
 *  re-pointed at a different chain with no fetch performed yet carries no marker saying so.**
 *
 * Query performance (PERF-01/02/03/05):
 *  - Indexed   — every read path resolves through an index. A `(chain_id, …)` index cannot
 *                serve a query that omits `chain_id`, so the `*_only` indexes lead with the
 *                filter column instead; without them `WHERE agent_id = ?` degraded to a full
 *                `SCAN actions` (measured 16.2 ms vs 0.009 ms indexed at 200k rows).
 *  - Bounded   — row-listing queries take a `limit` and return only the newest N rows. The
 *                previous `SELECT *` + caller-side `.slice(-n)` materialised every matching
 *                row (measured 3.9 s for 200k rows sharing one target) to keep 20.
 *  - Cached    — prepared statements are memoized per SQL text. `node:sqlite` does not cache
 *                them, and re-preparing dominated write throughput (measured 3.9–4.1x write
 *                amplification over 1 000 inserts).
 *  - Explicit  — reads project named columns rather than `SELECT *`, so adding a column to
 *                the schema cannot silently change the shape these methods return.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  decodeEventLog,
  formatUnits,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { ACTION_LOGGER_ABI, parseActionLogged, type ActionLogRecord } from "@sigilkit/core";
// P0-3: `createLogger`/`Logger` come from the `@sigilkit/core/logger` subpath, not the root
// barrel. The barrel is being stripped of its `logger.ts` re-export so core can be consumed
// in a browser, and a root-barrel import of a logger symbol would break this package at
// startup the moment that lands. The subpath is declared in `packages/core/package.json`
// (`"./logger": { types: ./dist/logger.d.ts, default: ./dist/logger.js }`) and
// `logger.ts` imports only `./validation.js` — no `node:` builtins — so it stays
// environment-neutral. `ACTION_LOGGER_ABI` (abis.ts), `parseActionLogged` and
// `ActionLogRecord` (client.ts) are NOT logger symbols and keep the root barrel.
import { createLogger, type Logger } from "@sigilkit/core/logger";

/**
 * One persisted `ActionLogged` row, as returned by the query methods.
 *
 * Field types are deliberately the *branded* viem types rather than `string`, because
 * these rows are consumed next to `@sigilkit/core`'s `ActionLogRecord` (which uses
 * `Hash`/`Address`/`Hex`) and by the MCP `audit_query` tool. Leaving them as bare
 * `string` made every consumer re-assert the shape (`as Address`) and let a malformed
 * row flow through unchecked — the brand is the only compile-time record that this
 * value came from a decoded, validated event.
 *
 * Note the deliberate name difference from `ActionLogRecord`: `timestamp` (seconds) is
 * stored here as `ts`, because `ts` is the column name, while `value` is a **decimal
 * string** rather than a `bigint` because SQLite has no bigint type. Consumers that need
 * a bigint convert with `BigInt(row.value)`; {@link SigilIndexer.spendByAgent} already
 * returns `bigint` so most callers never need the raw row for arithmetic.
 */
export interface StoredAction {
  chainId: number;
  /** Hash of the transaction that emitted the log. */
  txHash: Hash;
  /** Index of the log within its transaction — part of the natural key (lossless ingest). */
  logIndex: number;
  blockNumber: number;
  /** Canonical 32-byte block hash, or null for a row written without one. */
  blockHash: Hash | null;
  /** Operator-assigned agent identity (`bytes32`, indexed on-chain). */
  agentId: Hash;
  /** Contract the inner call was sent to. */
  target: Address;
  /** 4-byte function selector invoked on {@link StoredAction.target}. */
  selector: Hex;
  /** Wei as a decimal string (SQLite has no bigint). */
  value: string;
  /** keccak256 of the off-chain rationale; the plaintext never reaches the chain. */
  rationaleHash: Hash;
  /** Unix seconds (the audit event's block timestamp). */
  ts: number;
}

/**
 * One persisted `WindowCharged` row — the on-chain window position at the moment of
 * the charge. Mirrors the event's five data fields plus the store's own key columns.
 *
 * Like {@link StoredAction}, `value`/`spentThisWindow` are decimal strings and the
 * address fields are branded. `windowStart` is `uint48` seconds on-chain and is stored
 * as a JS `number`, which is exact for any realistic timestamp.
 */
export interface StoredWindowCharge {
  chainId: number;
  /** Hash of the transaction that emitted the log. */
  txHash: Hash;
  /** Index of the log within its transaction — part of the natural key. */
  logIndex: number;
  blockNumber: number;
  /** The wallet whose funds were spent (the manager, or the 7579 smart account). */
  account: Address;
  /** The session key charged for this action. */
  key: Address;
  /** Wei charged by this action, as a decimal string. */
  value: string;
  /** Start of the fixed window this charge falls in (Unix seconds, `uint48`). */
  windowStart: number;
  /** Cumulative wei spent in that window after this charge, as a decimal string. */
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

/**
 * Row ceiling applied when a caller does **not** pass an explicit `limit` (PERF-02).
 *
 * It is a fail-closed cap, not a silent truncation: when a filter matches more than this
 * many rows the query throws rather than quietly returning a subset, because an audit
 * listing that looks complete but is not is worse than one that refuses to render. The
 * value is well above the CLI's `--limit` default of 20, so realistic single-agent stores
 * are unaffected; a caller that genuinely wants to page past it passes `limit` explicitly.
 */
const DEFAULT_QUERY_LIMIT = 1_000;

/**
 * Marks "the caller did not choose a size" (PERF-02) — the default for the `limit`
 * parameter, in a slot that no caller can occupy by accident.
 *
 * It must be a value `latestRows` cannot mistake for a real request. A plain number would
 * collide: with the ceiling at 1 000, an *explicit* `limit: 1000` is indistinguishable from
 * omitting the argument, so asking for exactly the ceiling rows would fail closed even
 * though the caller asked for that size on purpose. `undefined` has exactly the required
 * semantics — it is the parameter's own default, and no call site binds it — and the
 * ceiling stays a single named constant instead of being duplicated in a signature.
 */
const NO_ROW_LIMIT = undefined;

/**
 * Explicit projection for `actions` (PERF-05). `SELECT *` would make the returned shape
 * an implicit function of the schema, so adding a column could silently widen every result.
 */
const ACTION_COLUMNS =
  "chain_id, tx_hash, log_index, block_number, block_hash, agent_id, target, selector, value, rationale_hash, ts";

/** Explicit projection for `window_charges` (PERF-05) — mirrors `ACTION_COLUMNS`. */
const CHARGE_COLUMNS =
  "chain_id, tx_hash, log_index, block_number, account, key, value, window_start, spent_this_window";

/**
 * Predicate for a filter column, optionally chain-scoped. `chainId === undefined` means
 * "every chain" (ARCH-4) and therefore leaves `chain_id` out of the predicate entirely —
 * which is precisely the shape the `*_only` indexes are built to serve (PERF-01).
 */
const chainScoped = (column: string, chainId: number | undefined): string =>
  chainId === undefined ? `${column} = ?` : `${column} = ? AND chain_id = ?`;

/**
 * Bind arguments matching `chainScoped`, in the same order.
 *
 * Note the coercion: `node:sqlite` binds a JS string to TEXT, and the audit ids are
 * compared as TEXT columns, so these are passed through verbatim. Callers that pass a
 * non-string (e.g. `undefined`) would bind NULL and match nothing rather than erroring,
 * so every call site passes a validated value.
 */
const chainArgs = (value: string | number, chainId: number | undefined): Array<string | number> =>
  chainId === undefined ? [value] : [value, chainId];

// ── hot statements (PERF-03) ────────────────────────────────────────────────────
// Hoisted to module scope so each distinct SQL text is compiled once per process. The
// memoized instances live in `SigilIndexer.stmts`; these constants only fix the text.

const STORE_ACTION_SQL = `
  INSERT INTO actions
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
    ts           = excluded.ts`;

const STORE_CHARGE_SQL = `
  INSERT INTO window_charges
    (chain_id, tx_hash, log_index, block_number, account, key, value, window_start, spent_this_window)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(chain_id, tx_hash, log_index) DO UPDATE SET
    block_number      = excluded.block_number,
    account           = excluded.account,
    key               = excluded.key,
    value             = excluded.value,
    window_start      = excluded.window_start,
    spent_this_window = excluded.spent_this_window`;

const SET_CURSOR_SQL = `
  INSERT INTO sync_state (chain_id, manager, last_block, last_block_hash, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(chain_id, manager) DO UPDATE SET
    last_block = excluded.last_block,
    last_block_hash = excluded.last_block_hash,
    updated_at = excluded.updated_at`;

/**
 * Newest-N-rows query for a filter column (PERF-02).
 *
 * The inner query walks the `*_only` index *backwards* (DESC) and stops after `limit` rows,
 * so SQLite never materialises more than N; the outer query restores the ascending order
 * the API promises, sorting only those N rows. `probe = 1` asks for one row beyond the
 * limit so the caller can distinguish "exactly at the limit" from "truncated" and fail
 * closed (see `latestRows`).
 */
function latestRowsSql(column: string, chainId: number | undefined, probe: boolean): string {
  return `
    SELECT ${ACTION_COLUMNS} FROM (
      SELECT ${ACTION_COLUMNS} FROM actions
      WHERE ${chainScoped(column, chainId)}
      ORDER BY block_number DESC, log_index DESC
      LIMIT ${probe ? "? + 1" : "?"}
    ) ORDER BY block_number ASC, log_index ASC`;
}

/**
 * Sleep that an `AbortSignal` can cut short (BUG-17).
 *
 * A bare `setTimeout` + `setTimeout`-only check of a `stopped` flag is not enough: the flag
 * is only read at the loop boundary, so a `stop()` during an in-flight `await sleep(pollMs)`
 * cannot wake the loop. Passing the signal to the timer lets `stop()` resolve the pending
 * sleep immediately instead of leaving the process pinned to the next tick boundary.
 *
 * `clearTimeout` + the abort listener is implemented directly rather than
 * `timers/promises.setTimeout(ms, undefined, { signal })` because the latter is unavailable
 * in the Node versions this package supports. The listener is always removed in `finally`,
 * so a long-lived `watch` loop must not accumulate one per poll interval.
 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

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
  /**
   * Set by `watch`'s disposer to end the polling loop (BUG-17).
   *
   * It is an instance field rather than a closure variable so the loop, the disposer and any
   * future owner (`/healthz`, a coordinator) observe the *same* shutdown intent. It is also
   * the guard against a second `watch` on one handle: the loop checks it, so calling
   * `watch` twice would make the second loop stop as soon as the first one is disposed.
   */
  private stopRequested = false;
  /**
   * The running `watch` loop's promise, kept so the disposer can hand back an already-
   * settled or in-flight `done` on repeated calls (`stop()` is idempotent). Null when no
   * loop has ever been started.
   */
  private watchDone: Promise<void> | null = null;
  /**
   * Memoized prepared statements keyed by SQL text (PERF-03). `node:sqlite` compiles a
   * fresh statement on every `prepare()` call, so re-preparing a hot write path cost
   * ~3.9x the run time of reusing one. Populated lazily by `stmt()` — see that method for
   * why construction cannot pre-compile the whole set.
   */
  private readonly stmts = new Map<string, StatementSync>();

  /**
   * Returns the prepared statement for `sql`, compiling it on first use.
   *
   * Memoization is lazy rather than eager for two reasons. A `{ readOnly: true }` open runs
   * no DDL (BUG-9), so the tables may legitimately not exist yet — and `prepare()` on a
   * missing table *throws* `no such table` — which would turn every read-only open of a
   * fresh/foreign file into a constructor failure. Lazily, that same statement is simply
   * never reached by a reader, and is only compiled if a path that needs it actually runs.
   * `prepare()` writes nothing, so caching is equally valid in both modes.
   *
   * The memo is keyed on **SQL text alone** — it carries no schema version, so an entry
   * compiled against one table layout stays "valid" in the map after `migrate()` has
   * rebuilt those tables underneath it, and the stale compilation assumptions would be
   * reused forever. The two places that can invalidate it are therefore exactly the two
   * places that can change or destroy the schema: `migrate()` clears it as part of the
   * rebuild, and `close()` clears it before releasing the handle. Nothing else needs to —
   * `prepare()` is read-only with respect to the schema, and every other write path
   * (including `rollbackTo`) leaves the table layout untouched.
   */
  private stmt(sql: string): StatementSync {
    let cached = this.stmts.get(sql);
    if (cached === undefined) {
      cached = this.db.prepare(sql);
      this.stmts.set(sql, cached);
    }
    return cached;
  }

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
   * Brings a pre-2026-09-12 database up to the lossless schema (BUG-5/BUG-6/BUG-07).
   * SQLite cannot alter a PRIMARY KEY in place, so the affected tables are rebuilt.
   * Legacy rows have no recorded log index; `rowid` is used as a stable stand-in so
   * no existing audit data is lost.
   *
   * Four properties make this safe to run against a database of unknown provenance
   * (BUG-07). Before this fix the statements ran bare, so a crash between
   * `DROP TABLE actions_legacy` and the `window_charges` rebuild left a *mixed schema*
   * that no later `CREATE TABLE IF NOT EXISTS` would ever correct.
   *  - Transactional — the whole migration is one `BEGIN IMMEDIATE`…`COMMIT`. SQLite
   *    gives DDL transactional semantics, so a failure anywhere (including a
   *    rollback failure, which closes the handle and reports both errors) leaves the
   *    database exactly as it was found.
   *  - Versioned  — `PRAGMA user_version` records the applied schema version and a
   *    `STRICT` `_migrations` table records when and under what name it was applied,
   *    so "is this database migrated?" is a query rather than an inference.
   *  - Fail-closed — a database newer than this build is refused outright, because an
   *    older binary would write rows the newer schema cannot represent.
   *  - Re-entrant— each table is an independent step that first asks whether it is
   *    already migrated (`log_index` present) and, if a `_legacy` table survives beside
   *    an already-migrated table, finishes the interrupted copy and drops the residue.
   *    A database left half-migrated by an *older* build therefore repairs itself on
   *    the next open.
   */
  private migrate(): void {
    // Fast path — an up-to-date database takes no write lock and runs no DDL.
    if (this.readSchemaVersion() === CURRENT_SCHEMA_VERSION) return;
    this.assertSchemaVersionSupported();

    let rebuilt = false;
    this.inTransaction(() => {
      // Authoritative re-check under the write lock: the pre-flight read above raced
      // another process, which may have migrated or replaced the file in between.
      this.assertSchemaVersionSupported();
      if (this.readSchemaVersion() === CURRENT_SCHEMA_VERSION) return;

      for (const step of TABLE_MIGRATIONS) this.migrateTable(step);
      rebuilt = true;

      this.db.exec(MIGRATIONS_TABLE);
      this.db
        .prepare(
          `INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)
           ON CONFLICT(version) DO UPDATE SET name = excluded.name, applied_at = excluded.applied_at`,
        )
        .run(CURRENT_SCHEMA_VERSION, SCHEMA_MIGRATION_NAME, Math.floor(Date.now() / 1000));
      // `user_version` is stored in the database header and is transactional, so the
      // version stamp and the rows it describes commit and roll back together.
      this.db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    });
    // Invalidate the prepared-statement memo once the tables have been rebuilt. Placement
    // is load-bearing in two ways:
    //  - AFTER `inTransaction`, not inside it: a rolled-back migration leaves the original
    //    tables in place, so its entries would still be valid and re-preparing is pure loss.
    //  - GATED on `rebuilt`: the under-lock re-check above can return without having
    //    touched any table, and clearing then would discard perfectly good statements.
    // Past this point every surviving entry was compiled against the pre-migration layout
    // and is stale by construction, because the memo is keyed on SQL text with no schema
    // version attached. (PERF-03/P0-1)
    //
    // Reachability, stated honestly: `migrate()` is private and the constructor is its ONLY
    // caller, and the constructor runs it before any `stmt()` can have been called, so today
    // no entry can actually exist here — the clear is a guard against a FUTURE caller (a
    // re-migration entry point, a connection pool, a "migrate on open" path), not a fix for
    // an observable corruption. It is kept because the invariant it protects is real, the
    // cost is one `Map.clear()` on an already-exclusive code path, and the alternative is
    // relying on "the only caller happens to run first" as the sole enforcement of it.
    if (rebuilt) this.stmts.clear();
  }

  /**
   * Wraps a unit of work in `BEGIN IMMEDIATE`…`COMMIT`, mirroring
   * `FileLeaseStore.write()` (core/src/lease-fs.ts). `IMMEDIATE` takes the write lock
   * up front so the migration cannot fail partway with a read lock already held. If the
   * rollback itself fails the handle is closed and both errors are reported: an
   * unrecoverable transaction must not leave a caller reusing a suspect connection.
   */
  private inTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        this.close();
        throw new AggregateError([error, rollbackError], "SigilIndexer: schema migration rollback failed");
      }
      throw error;
    }
  }

  /** Schema version recorded in `PRAGMA user_version` (0 = never migrated). */
  private readSchemaVersion(): number {
    const row = this.db.prepare(`PRAGMA user_version`).get() as { user_version: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  /**
   * Refuses to open a database written by a newer build. Writing with an older binary
   * would be silently destructive — rows it inserts can lack the columns the newer
   * schema requires — so this fails closed at construction time instead.
   */
  private assertSchemaVersionSupported(): void {
    const version = this.readSchemaVersion();
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `SigilIndexer: database schema version is ${version}, but this build only understands up to ` +
          `${CURRENT_SCHEMA_VERSION}. Refusing to open it: an older @sigilkit/indexer would write rows the newer ` +
          `schema cannot represent. Upgrade @sigilkit/indexer to a build that understands this database, or point ` +
          `--db at a different file. No rows were read or written.`,
      );
    }
  }

  /**
   * Runs one table's migration step. Idempotent by construction — it inspects the live
   * schema instead of trusting a flag — which is what lets an interrupted pre-BUG-07
   * migration heal on the next open:
   *  - neither table present → a fresh database; `SCHEMA` creates the right shape.
   *  - main table already carries `log_index` → already migrated. A surviving
   *    `<table>_legacy` is crash residue: the old code could die after `CREATE` but
   *    before `DROP`, so re-run the copy (a no-op once it has been applied, and it
   *    never overwrites a row) and drop the residue.
   *  - main table in the legacy shape, or only the legacy table present (a crash
   *    between `RENAME` and `CREATE`) → rebuild from the legacy rows.
   * Every branch ends with the same losslessness assertion, so a silent row loss fails
   * the whole migration and rolls back rather than committing a half-copied table.
   */
  private migrateTable(step: TableMigration): void {
    const mainExists = this.tableExists(step.table);
    const legacyExists = this.tableExists(step.legacy);
    if (!mainExists && !legacyExists) return;

    if (mainExists && this.columns(step.table).includes(step.probeColumn)) {
      if (!legacyExists) return;
      this.db.exec(step.copy);
      this.assertNoRowsLost(step);
      this.db.exec(`DROP TABLE ${step.legacy}`);
    } else {
      if (mainExists) this.db.exec(`ALTER TABLE ${step.table} RENAME TO ${step.legacy}`);
      this.db.exec(step.create);
      this.db.exec(step.copy);
      this.assertNoRowsLost(step);
      this.db.exec(`DROP TABLE ${step.legacy}`);
    }
  }

  /**
   * Losslessness gate, evaluated *before* the legacy table is dropped. Every legacy row
   * must be reachable in the rebuilt table under its new key; the copy reuses `rowid`
   * as `log_index`, so a missing count means rows would have been silently discarded.
   * Throwing here aborts the surrounding transaction, restoring the original database.
   */
  private assertNoRowsLost(step: TableMigration): void {
    const missing = Number((this.db.prepare(step.verify).get() as { missing: number }).missing);
    if (missing > 0) {
      throw new Error(
        `SigilIndexer: migrating ${step.legacy} lost ${missing} row(s) — every legacy row must be reachable in ` +
          `${step.table} under the (chain_id, tx_hash, log_index) key. Aborting without committing; the database ` +
          `is unchanged.`,
      );
    }
  }

  private tableExists(table: string): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined
    );
  }

  /**
   * Column names of `table` (empty when the table does not exist). `PRAGMA table_info`
   * takes no bind parameter, so the identifier is interpolated — hence the guard: every
   * caller passes a literal from `TABLE_MIGRATIONS`, and this makes that checkable.
   */
  private columns(table: string): string[] {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`SigilIndexer: refusing to introspect unsafe table identifier ${JSON.stringify(table)}`);
    }
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  }

  // ── writes ────────────────────────────────────────────────────────────────────

  private assertWritable(op: string): void {
    if (this.readOnly) throw new Error(`SigilIndexer: ${op} is not available in read-only mode`);
  }

  /**
   * Stores one decoded `ActionLogged` record (idempotent on chain+tx+logIndex).
   *
   * Takes the branded `ActionLogRecord` from `@sigilkit/core` verbatim, so the value
   * that is written is the same value the event decoder produced — no intermediate
   * untyped shape where a field could be dropped or misspelled.
   *
   * `agent_id` is normalized to lowercase here (A8/R56): SQLite compares TEXT with
   * BINARY collation, and the query side normalizes to match, so a caller that submits
   * the same id in a different case cannot silently miss rows that exist.
   */
  storeAction(r: ActionLogRecord, blockHash: Hash | null = null, chainId = this.chainId): void {
    this.assertWritable("storeAction");
    this.stmt(STORE_ACTION_SQL)
      .run(
        chainId,
        r.txHash,
        r.logIndex,
        Number(r.blockNumber),
        blockHash,
        r.agentId.toLowerCase(),
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
    this.stmt(STORE_CHARGE_SQL)
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
   *
   * `chainId` is an explicit parameter (R56/A13): the caller supplies the chain the
   * affected cursor/processor state was reading, so a removed log from one chain can
   * never delete or overwrite another chain's rows through a silent `this.chainId`
   * default. It is optional only for backward compatibility — internal callers always
   * pass the processor's chain explicitly.
   */
  ingestLogs(logs: Log[], chainId: number = this.chainId): number {
    this.assertWritable("ingestLogs");
    let stored = 0;
    for (const raw of logs) {
      const log = raw as MaybeRemovedLog;
      if (log.removed) {
        this.removeLog(log, chainId);
        continue;
      }
      const action = parseActionLogged([log]);
      if (action) {
        this.storeAction(action, (log.blockHash as Hash | null) ?? null, chainId);
        stored++;
        continue;
      }
      if (log.topics.length === 3) {
        // A3: a charge log without a usable height or index cannot be keyed under the
        // natural key. Defaulting them to 0 would silently insert (or, on the removed
        // path, DELETE) row 0 — the exact silent corruption fail-loud ingests forbid.
        // Log and skip instead.
        if (
          log.logIndex === null ||
          log.logIndex === undefined ||
          log.blockNumber === null ||
          log.blockNumber === undefined
        ) {
          this.log.warn("ingestLogs: skipping WindowCharged log with missing log_index/block_number", {
            txHash: String(log.transactionHash ?? "null"),
            logIndex: String(log.logIndex ?? "null"),
            blockNumber: String(log.blockNumber ?? "null"),
          });
          continue;
        }
        let decoded;
        try {
          decoded = decodeEventLog({ abi: ACTION_LOGGER_ABI, data: log.data, topics: log.topics });
        } catch (err) {
          // A5: decode failures used to be swallowed with no trace at all, so a silently
          // dropped WindowCharged was indistinguishable from "no event". Keep skipping
          // (one malformed log must not kill a range commit) but say which log and why.
          this.log.warn("ingestLogs: skipping 3-topic log that failed to decode", {
            txHash: String(log.transactionHash ?? "null"),
            logIndex: String(log.logIndex),
            blockNumber: String(log.blockNumber),
            reason: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (decoded.eventName === "WindowCharged") {
          const a = decoded.args;
          this.storeWindowCharge({
            chainId,
            txHash: log.transactionHash as Hash,
            logIndex: Number(log.logIndex),
            blockNumber: Number(log.blockNumber),
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

  /**
   * Deletes the rows for a log that a reorg removed (ARCH-2).
   *
   * `chainId` is deliberately NOT defaulted (R56/A13): a `removed` log describes a row
   * the *processor* was reading, and a silent `this.chainId` here could delete another
   * chain's rows whose tx hash happens to collide. The caller threads the affected
   * chain from its own state.
   *
   * A missing `logIndex` is refused with a warning rather than `?? 0`: deleting the
   * (chain, tx, log_index = 0) key for a log whose index the RPC omitted would be a
   * silent delete of an unrelated row.
   */
  private removeLog(log: MaybeRemovedLog, chainId: number): void {
    const txHash = log.transactionHash;
    const logIndex = log.logIndex as number | null;
    if (txHash === null || txHash === undefined || logIndex === null || logIndex === undefined) {
      this.log.warn("removeLog: reorged-out log carries no tx_hash/log_index; refusing to delete", {
        txHash: String(txHash ?? "null"),
        logIndex: String(logIndex ?? "null"),
      });
      return;
    }
    this.db
      .prepare(`DELETE FROM actions WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`)
      .run(chainId, txHash, logIndex);
    this.db
      .prepare(`DELETE FROM window_charges WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`)
      .run(chainId, txHash, logIndex);
  }

  /**
   * Rolls the index back to a block, discarding anything above it and rewinding the
   * persisted cursor (ARCH-2).
   *
   * Atomic: both tables and the cursor rewind commit or roll back together, so an
   * interrupted rollback can never leave actions deleted and charges retained.
   *
   * Note: the rewound cursor carries a null hash, so this is a *clearing* primitive, not a
   * recovery path for the B64 fail-closed check — `validateCursor` rejects a hash-less
   * cursor outright, so a reorg that it detected must be resolved by rebuilding a separate
   * database. Passing `manager` therefore leaves this store needing a fresh sync before it
   * will run again; it is here to clear known-orphaned ranges, not to recover from one.
   */
  rollbackTo(blockNumber: number, manager?: Address): void {
    this.assertWritable("rollbackTo");
    // Atomic: the two DELETEs must both land or neither. A failure between them would
    // discard the action rows above `blockNumber` while leaving their window_charges
    // behind — a state that looks like a successful rollback while silently orphaning
    // charges, and that no later run would ever reconcile.
    this.inTransaction(() => {
      this.db.prepare(`DELETE FROM actions WHERE chain_id = ? AND block_number > ?`).run(
        this.chainId,
        blockNumber,
      );
      this.db.prepare(`DELETE FROM window_charges WHERE chain_id = ? AND block_number > ?`).run(
        this.chainId,
        blockNumber,
      );
      if (manager) this.setCursor(manager, blockNumber, null);
    });
  }

  // ── cursor (BUG-7) ────────────────────────────────────────────────────────────

  /** Persisted sync cursor for a (chain, manager) pair, or null when unset. */
  getCursor(manager: Address): { lastBlock: number; lastBlockHash: string | null } | null {
    const row = this.stmt(
      `SELECT last_block, last_block_hash FROM sync_state WHERE chain_id = ? AND manager = ?`,
    ).get(this.chainId, manager.toLowerCase()) as
      | { last_block: number; last_block_hash: string | null }
      | undefined;
    if (!row) return null;
    return { lastBlock: Number(row.last_block), lastBlockHash: row.last_block_hash };
  }

  private setCursor(manager: Address, lastBlock: number, lastBlockHash: string | null): void {
    this.assertWritable("setCursor");
    this.stmt(SET_CURSOR_SQL).run(
      this.chainId,
      manager.toLowerCase(),
      lastBlock,
      lastBlockHash,
      Math.floor(Date.now() / 1000),
    );
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
      // A13/R56: the chain id is threaded EXPLICITLY from processor state. These logs
      // were fetched and validated on this store's chain (assertRpcChainIdentity inside
      // fetchRangeWithStableEnd), so `this.chainId` IS the affected chain here — saying
      // so at the call site keeps any future multi-chain processor from letting a
      // removed log delete another chain's rows.
      const stored = this.ingestLogs(logs, this.chainId);
      this.setCursor(manager, Number(end), endHash);
      this.db.exec("COMMIT");
      return stored;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        // A4: mirrors the ownership model `inTransaction` establishes — this instance
        // owns the connection, and after a failed ROLLBACK the transaction state on it
        // is unknown, so reusing it could later commit a half-applied range. Close the
        // handle and report both errors together instead.
        this.close();
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
   * Reads the RPC's own identity and fails closed when it is not the chain this store is
   * keyed by (SEC-15).
   *
   * Why this must exist: every other check in this file proves the fetched data is
   * *internally consistent* — the `toBlock` header is stable across the fetch, each log's
   * `blockHash` matches the header at its own height, membership is in range. None of them
   * prove the data came from the *intended* chain. A perfectly self-consistent Base log
   * fetched through a Base node passes every one of those checks, and `storeAction` stamps
   * the row with the *configured* `chainId` (`this.chainId`, default 31337 from Anvil), so
   * the audit database would be attributed to chain 31337 while `audit_query{chainId: 8453}`
   * returns empty — a silent false negative in the one place the moat is supposed to hold.
   *
   * `client.getChainId()` issues a real `eth_chainId` JSON-RPC call (it does not echo the
   * configured `chain` object), so it observes the endpoint rather than the configuration.
   *
   * Fail-closed in every direction:
   *  - a mismatch throws, before any row is written and before the cursor moves;
   *  - an endpoint that cannot answer `eth_chainId` also throws, because "unknown identity"
   *    is not evidence of a match;
   *  - the message names both ids so the operator can see which flag to fix.
   *
   * This is a *runtime* check only. It is deliberately not persisted: a chain-id column in
   * `sync_state`/a new `meta` table would be new schema, and `SCHEMA`/`migrate()` are owned
   * elsewhere (see the class comment's "Chain identity" note).
   */
  private async assertRpcChainIdentity(client: PublicClient): Promise<void> {
    let onChain: number;
    try {
      onChain = await client.getChainId();
    } catch (err) {
      throw new Error(
        `SigilIndexer: cannot determine the chain identity of the RPC endpoint ` +
          `(${err instanceof Error ? err.message : String(err)}); expected chain ${this.chainId}. ` +
          `Fail-closed: refusing to index, because an endpoint that will not answer eth_chainId ` +
          `cannot be shown to be the intended chain and its logs would be stored under the ` +
          `configured chain id. Check --rpc / SIGILKIT_RPC_URL. No rows were written and the cursor did not move.`,
      );
    }
    if (onChain !== this.chainId) {
      throw new Error(
        `SigilIndexer: RPC endpoint reports chain id ${onChain} but this indexer is configured for chain ` +
          `${this.chainId}. Fail-closed: refusing to index, because every log would be validated against ` +
          `the wrong chain's headers, stored under chain id ${this.chainId} and then be invisible to ` +
          `audit_query{chainId: ${onChain}} — a silent false negative rather than a visible failure. ` +
          `Fix the configuration: pass --chain-id ${onChain} (or set SIGILKIT_INDEXER_CHAIN_ID), or point ` +
          `--rpc at a node serving chain ${this.chainId}. No rows were written and the cursor did not move.`,
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
    // SEC-15: identity first. Every other check below is chain-relative, so they would all
    // pass on the wrong chain; this is the only one that can tell the chains apart.
    await this.assertRpcChainIdentity(client);
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
    // AC-32: on a chain younger than `confirmations` the window is below genesis and
    // backfill would silently persist an advanced cursor while storing nothing.
    // Fail loud instead: the operator must consciously shrink confirmations (or wait).
    //
    // BUG-16: this guard used to be conditioned on `toBlock === undefined`, which meant an
    // explicit `--to 100` walked straight past it — exactly the short-chain case it exists
    // to catch. It no longer depends on how the end was chosen: if the operator asked for a
    // range above a head that cannot support it, the request is refused either way, and
    // `--to` is *not* a way to opt out of a safety check. (As before, confirmations is
    // irrelevant when the caller pinned an end: it only ever shortened the default.)
    if (this.confirmations > 0 && head <= BigInt(this.confirmations)) {
      throw new Error(
        `SigilIndexer: chain head ${head} is at or below confirmations (${this.confirmations}); ` +
          `backfill would index nothing and still advance the cursor. ` +
          `Pass --confirmations 0 for local/dev chains, a smaller value, or wait for the chain to grow.` +
          (toBlock === undefined
            ? ""
            : ` (Requested --to ${toBlock}, but the guard fires on the chain head, not the end you asked for.)`),
      );
    }
    const safeHead = head - BigInt(this.confirmations);
    const end = toBlock ?? (safeHead > 0n ? safeHead : 0n);
    if (end < start) {
      // BUG-16: this path used to `return 0` in silence, so an operator who passed
      // `--from 500 --to 100` (or sat behind a cursor above the requested end) saw
      // "backfill stored 0 event(s)" plus a normal summary and exit code 0 — the exact
      // silence AC-32 forbids. A zero-row backfill is ambiguous (caught up? empty range?
      // clipped by confirmations? typo?), so every branch now says which of those it was.
      // Still a `return 0` rather than a throw: an already-indexed range genuinely has
      // nothing to do, and that is not an error. What is no longer allowed is doing it
      // unremarked.
      if (toBlock === undefined) {
        // Distinguish "caught up" from "confirmations clipped the range": on short
        // chains (local dev, fresh testnets) a large confirmations default can push
        // safeHead below the requested start, silently indexing nothing.
        this.log.warn(
          "backfill window is empty: head is below start + confirmations",
          { head: head.toString(), start: start.toString(), confirmations: this.confirmations },
        );
        this.log.warn("pass --confirmations 0 for local/dev chains");
      } else {
        this.log.warn(
          "backfill range is empty: requested end is below the start; nothing was indexed and the cursor did not move",
          {
            from: start.toString(),
            to: toBlock.toString(),
            head: head.toString(),
            confirmations: this.confirmations,
            cursor: cursor === null ? "none" : String(cursor.lastBlock),
          },
        );
        this.log.warn(
          "check the --from/--to block numbers, or drop --to to resume from the persisted cursor",
        );
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
   *
   * SEC-15: every tick that reaches the chain goes through
   * `fetchRangeWithStableEnd`, which now checks the RPC's own `eth_chainId` first, so a
   * mis-pointed `--rpc` degrades into a logged backoff-and-retry instead of writing rows
   * attributed to the wrong chain.
   *
   * Stopping (BUG-17). The returned disposer is `() => Promise<void>` and is *awaitable*:
   * it resolves once the in-flight tick has actually finished, so a caller can shut down
   * without racing it. Two mechanisms make that reachable:
   *  - an `AbortController` whose signal is passed to every `sleep`, so a `stop()` during a
   *    pending poll or backoff wait wakes the loop immediately instead of leaving the
   *    process pinned to the next tick boundary (previously the `stopped` flag was only
   *    read at the loop edge, so a 60s poll slept for 60s after `stop()`);
   *  - the `close` check *after* each await below, so a tick that was already past its
   *    sleep when `stop()` arrived does not start one more round of RPC against a handle
   *    the caller may be closing.
   *
   * Signature trade-off: `cli.ts` (which this package must not break) calls
   * `const stop = indexer.watch(client, manager)` and then `stop()` as a fire-and-forget
   * statement, immediately after which it resolves its shutdown promise and `close()`s the
   * database. Changing `watch` to return `Promise<void>` or an object would break that call
   * site, and changing `close()` semantics is out of scope here, so the disposer stays a
   * plain function that is safe to call without awaiting *and* safe to await. The fire-and-
   * forget path is not fully clean on its own — `cli.ts` does not await `stop()`, so it can
   * still `close()` while a tick is mid-RPC — but that window is now bounded by one in-flight
   * tick instead of an unbounded sleep, and `stopRequested` lets a future caller drain
   * properly. A tick interrupted mid-`commitRange` cannot corrupt data: the range commit is
   * a single `BEGIN IMMEDIATE`…`COMMIT`, and the error it would raise is caught, logged and
   * answered by the abort check at the loop edge.
   */
  watch(client: PublicClient, managerAddress: Address, pollMs = 4000): () => Promise<void> {
    this.assertWritable("watch");
    const controller = new AbortController();
    // Exposed so an owner can observe the shutdown intent without holding the disposer
    // (and so a second `watch` cannot silently run two loops on one handle).
    this.stopRequested = false;

    const tick = async (): Promise<void> => {
      let consecutiveFailures = 0;
      while (!this.stopRequested) {
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
            await sleep(pollMs, controller.signal);
            if (this.stopRequested) break;
            continue;
          }
          // A1 (reorg-safety, intentional): with NO persisted cursor this loop starts
          // at `safeHead`, never at genesis. watch() is the live-follow mode — each tick
          // must stay bounded to one confirmations window, and historical indexing is
          // backfill()'s job; starting at genesis here would turn one tick into an
          // unbounded full-chain fetch the per-tick checks were never sized for.
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
          // A stop requested *while the tick was running* is a normal shutdown, not a
          // poll failure: logging it as an error (and then sleeping through a backoff)
          // would turn Ctrl+C into a spurious "poll failed" line and delay the exit.
          if (this.stopRequested) break;
          consecutiveFailures++;
          const delay = Math.min(this.backoffMs * 2 ** (consecutiveFailures - 1), 60_000);
          this.log.error("poll failed; backing off", { attempt: consecutiveFailures, delayMs: delay }, err);
          await sleep(delay, controller.signal);
          continue;
        }
        await sleep(pollMs, controller.signal);
      }
    };

    const done = tick().finally(() => {
      this.stopRequested = true;
      this.watchDone = done;
    });

    return () => {
      if (this.stopRequested) return done;
      this.stopRequested = true;
      controller.abort();
      return done;
    };
  }

  // ── queries (chainId is an optional filter — ARCH-4) ──────────────────────────

  /**
   * Cumulative native spend per agent (wei).
   *
   * PERF-02: aggregated in SQL rather than materialising one TEXT row per action.
   * SQLite's `SUM` is exact only inside 64-bit integers — it silently widens to REAL
   * for out-of-range operands and *throws* on total overflow — while the historical
   * JS BigInt accumulator is exact for any input. The SQL path therefore runs only
   * behind a probe proving every matching `value` is a canonical decimal of at most
   * 18 digits (guaranteed to fit int64); any non-canonical value, or a SUM overflow,
   * falls back to the exact per-row BigInt summation, keeping the result identical to
   * the historical implementation for every input.
   *
   * A8/R56: the id is normalized to lowercase to match the case-normalized rows the
   * ingest path stores — SQLite TEXT comparison is BINARY, so a mixed-case id must not
   * silently sum zero against rows that exist.
   */
  spendByAgent(agentId: Hash, chainId?: number): bigint {
    const id = agentId.toLowerCase() as Hash;
    const bad = (
      this.stmt(
        `SELECT COUNT(*) AS n FROM actions
         WHERE ${chainScoped("agent_id", chainId)} AND (value NOT GLOB '[0-9]*' OR length(value) > 18)`,
      ).get(...chainArgs(id, chainId)) as { n: number }
    ).n;
    if (bad === 0) {
      try {
        // CAST to TEXT keeps node:sqlite from widening the 64-bit sum to a float on
        // the way out; the BigInt conversion below is then exact.
        const row = this.stmt(
          `SELECT CAST(COALESCE(SUM(CAST(value AS INTEGER)), 0) AS TEXT) AS total
           FROM actions WHERE ${chainScoped("agent_id", chainId)}`,
        ).get(...chainArgs(id, chainId)) as { total: string };
        return BigInt(row.total);
      } catch (err) {
        this.log.debug("spendByAgent: SQL SUM overflowed; falling back to per-row BigInt summation", { agentId: id }, err);
      }
    }
    const rows = this.stmt(`SELECT value FROM actions WHERE ${chainScoped("agent_id", chainId)}`).all(
      ...chainArgs(id, chainId),
    ) as Array<{ value: string }>;
    return rows.reduce((acc, r) => acc + BigInt(r.value), 0n);
  }

  /**
   * Audited actions for one agent, oldest first.
   *
   * `limit` bounds how many rows are materialised. Pass it explicitly to get "the newest
   * N" — exactly N rows when that many exist. Omit it to keep the historical "every
   * matching row" contract, which now throws instead of silently truncating once a filter
   * exceeds `DEFAULT_QUERY_LIMIT` (1 000) rows. See `latestRows` for the rationale.
   */
  actionsForAgent(
    agentId: Hash,
    chainId?: number,
    limit: number | undefined = NO_ROW_LIMIT,
  ): StoredAction[] {
    // A8/R56: query-side case normalization to match the case-normalized ingest side.
    return this.latestRows("agent_id", agentId.toLowerCase(), chainId, limit);
  }

  /** Audited actions against one target, oldest first. Same `limit` contract as `actionsForAgent`. */
  actionsForTarget(
    target: Address,
    chainId?: number,
    limit: number | undefined = NO_ROW_LIMIT,
  ): StoredAction[] {
    return this.latestRows("target", target, chainId, limit);
  }

  /** Latest window charge row for a key — the on-chain window position. */
  latestWindowCharge(key: Address, chainId?: number): StoredWindowCharge | null {
    const row = this.stmt(
      `SELECT ${CHARGE_COLUMNS} FROM window_charges
       WHERE ${chainScoped("key", chainId)}
       ORDER BY window_start DESC, block_number DESC, log_index DESC
       LIMIT 1`,
    ).get(...chainArgs(key, chainId)) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      chainId: Number(row.chain_id),
      txHash: hex(row.tx_hash),
      logIndex: Number(row.log_index),
      blockNumber: Number(row.block_number),
      account: hex(row.account) as Address,
      key: hex(row.key) as Address,
      value: String(row.value),
      windowStart: Number(row.window_start),
      spentThisWindow: String(row.spent_this_window),
    };
  }

  /**
   * Runs `latestRowsSql` and enforces the row ceiling (PERF-02).
   *
   * The `limit` parameter distinguishes two intents, and they must behave differently:
   *
   *  - **Explicit** `limit` — the caller asked for "the newest N". The query is bounded by
   *    `LIMIT N` and returns N rows if that many exist, fewer if not. This is a deliberate
   *    request for a page, so returning exactly N is the correct, documented answer.
   *  - **Implicit** default — the caller did not choose a size, so the historical
   *    contract is "every matching row". A silent cap here would be a behaviour change
   *    that hides audit rows, so instead the query probes for `limit + 1` and **throws** if
   *    the extra row exists. Fail-closed: no consumer is ever handed a list that looks
   *    complete but is not. The caller retries with an explicit, larger `limit`.
   *
   * `NO_ROW_LIMIT` is the sentinel distinguishing the two. Keeping the default
   * fail-closed is what makes adding a parameter backward compatible: every existing
   * caller that passes no `limit` keeps seeing all of its rows.
   */
  private latestRows(
    column: string,
    value: string,
    chainId: number | undefined,
    limit: number | typeof NO_ROW_LIMIT,
  ): StoredAction[] {
    // `undefined` means the caller did not choose a size: fetch up to the ceiling and
    // probe for one row more, so a result that would be silently truncated can fail
    // closed instead. An explicit limit is a deliberate page request and is honoured as-is.
    const probe = limit === NO_ROW_LIMIT;
    const bound = probe ? DEFAULT_QUERY_LIMIT : limit;
    if (!probe && (!Number.isInteger(bound) || (bound as number) < 1)) {
      throw new Error(
        `SigilIndexer: limit must be a positive integer, received ${String(bound)}`,
      );
    }
    const rows = this.stmt(latestRowsSql(column, chainId, probe)).all(
      ...chainArgs(value, chainId),
      bound,
    ) as Array<Record<string, unknown>>;
    if (probe && rows.length > DEFAULT_QUERY_LIMIT) {
      throw new Error(
        `SigilIndexer: more than ${DEFAULT_QUERY_LIMIT} rows match ${column} ${value}` +
          `${chainId === undefined ? "" : ` on chain ${chainId}`}. ` +
          `Refusing to silently truncate an audit listing — pass an explicit limit to page through them.`,
      );
    }
    return rows.map(toStoredAction);
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
    // Drop the memoized statements before the handle so no statement outlives the
    // connection it was compiled against. `db.close()` tolerates live statements, but
    // releasing them here keeps the map from pinning compiled SQL after teardown.
    this.stmts.clear();
    this.db.close();
  }
}

function toStoredAction(row: Record<string, unknown>): StoredAction {
  return {
    chainId: Number(row.chain_id),
    txHash: hex(row.tx_hash),
    logIndex: Number(row.log_index),
    blockNumber: Number(row.block_number),
    blockHash: row.block_hash === null || row.block_hash === undefined ? null : hex(row.block_hash),
    agentId: hex(row.agent_id),
    target: hex(row.target) as Address,
    selector: hex(row.selector) as Hex,
    value: String(row.value),
    rationaleHash: hex(row.rationale_hash),
    ts: Number(row.ts),
  };
}

/**
 * Narrows a raw SQLite TEXT cell to a `0x`-prefixed hex string.
 *
 * Rows only ever enter this store through `storeAction`/`storeWindowCharge`, which take
 * viem-typed values, so a malformed cell means the file was hand-edited or produced by a
 * different tool. That is exactly the case where a silent `String(...)` cast is worst:
 * it would hand a consumer a branded `Address`/`Hash` that is not one, and the brand
 * would suppress the very check it exists to enable. So a value that is not hex at all
 * throws, naming the problem, rather than being laundered into a trusted-looking type.
 *
 * Deliberately checks *shape only* (`0x` followed by hex digits), NOT the exact byte
 * width of the target field, and NOT even digit parity. Both of those are properties of
 * the chain and of the test fixtures, not of this library: the store accepts whatever the
 * event decoder produced, and existing fixtures legitimately build short synthetic
 * values (e.g. a tx hash assembled from a counter plus a repeated byte). Enforcing width
 * or parity here would reject rows this library itself wrote, turning a type-level
 * improvement into a runtime behaviour change — which is exactly the kind of change that
 * does not belong in an API/types pass.
 */
function hex(value: unknown): `0x${string}` {
  const s = String(value);
  if (!/^0x[0-9a-fA-F]*$/.test(s)) {
    throw new Error(
      `SigilIndexer: corrupt audit row — expected a 0x-prefixed hex string, got ${JSON.stringify(s)}. ` +
        `The database was likely modified outside this library.`,
    );
  }
  return s as `0x${string}`;
}

/**
 * Schema version this build understands. `0` means "pre-2026-09-12, never migrated";
 * anything at or above `1` carries the lossless `(chain_id, tx_hash, log_index)` keys
 * plus a populated `_migrations` ledger. Bump only together with a new step in
 * `TABLE_MIGRATIONS`.
 */
const CURRENT_SCHEMA_VERSION = 1;

/** Human-readable name recorded in `_migrations` for the current version. */
const SCHEMA_MIGRATION_NAME = "lossless-log-index-keys";

/**
 * The `_migrations` ledger. `STRICT` so a hand-edited or wrongly-typed row cannot be
 * written by accident, and `applied_at` constrained to the SQLite integer range so
 * `Unix seconds` is the only representable interpretation.
 */
const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL CHECK(applied_at >= 0)
  ) STRICT`;

/**
 * One table's migration step, expressed so it can be re-run safely. SQLite cannot
 * change a PRIMARY KEY in place, so each table is rebuilt by rename → create → copy →
 * drop. `probeColumn` is the marker that distinguishes an already-migrated table from
 * a legacy one; `verify` counts rows the rebuild failed to carry over, so a lossy
 * migration throws instead of committing a partially copied table.
 */
interface TableMigration {
  readonly table: string;
  readonly legacy: string;
  /** Column present only after the rebuild — the "already migrated?" probe. */
  readonly probeColumn: string;
  readonly create: string;
  readonly copy: string;
  readonly verify: string;
}

const TABLE_MIGRATIONS: readonly TableMigration[] = [
  {
    table: "actions",
    legacy: "actions_legacy",
    probeColumn: "log_index",
    // `block_hash` did not exist pre-09-12; legacy rows are backfilled with NULL
    // (hashes are only trustworthy for rows this build fetched itself).
    create: `
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
      )`,
    copy: `
      INSERT OR IGNORE INTO actions
        (chain_id, tx_hash, log_index, block_number, block_hash, agent_id, target, selector, value, rationale_hash, ts)
      SELECT chain_id, tx_hash, rowid, block_number, NULL, agent_id, target, selector, value, rationale_hash, ts
      FROM actions_legacy`,
    // Every legacy rowid must be reachable as a `log_index`; the rebuild copies
    // `rowid` verbatim, so a non-zero count means rows were silently dropped.
    verify: `SELECT COUNT(*) AS missing FROM actions_legacy
             WHERE rowid NOT IN (SELECT log_index FROM actions)`,
  },
  {
    table: "window_charges",
    legacy: "window_charges_legacy",
    probeColumn: "log_index",
    create: `
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
      )`,
    // The legacy table recorded no block height, so `block_number` is backfilled to 0
    // exactly as before — it only orders rows and never keys them.
    copy: `
      INSERT OR IGNORE INTO window_charges
        (chain_id, tx_hash, log_index, block_number, account, key, value, window_start, spent_this_window)
      SELECT chain_id, tx_hash, rowid, 0, account, key, value, window_start, spent_this_window
      FROM window_charges_legacy`,
    verify: `SELECT COUNT(*) AS missing FROM window_charges_legacy
             WHERE rowid NOT IN (SELECT log_index FROM window_charges)`,
  },
];

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
  -- PERF-01: the three indexes above all *lead* with chain_id, so they cannot serve the
  -- default cross-chain queries (spendByAgent/actionsForAgent/actionsForTarget/
  -- latestWindowCharge with no chainId). Without these, WHERE agent_id = ? degraded to a
  -- full SCAN actions — measured 12.2 ms vs 0.01 ms for the chain-scoped form at 200k rows.
  -- These are *added*, never substituted: the (chain_id, …) variants remain the right
  -- choice whenever a query does constrain the chain, and dropping them would regress
  -- multi-chain semantics. The trailing block_number/log_index columns let the same index
  -- satisfy ORDER BY directly, removing the TEMP B-TREE sort. IF NOT EXISTS keeps the
  -- whole block idempotent, so an existing database picks them up on the next open.
  CREATE INDEX IF NOT EXISTS idx_actions_agent_only ON actions(agent_id, block_number, log_index);
  CREATE INDEX IF NOT EXISTS idx_actions_target_only ON actions(target, block_number, log_index);
  CREATE INDEX IF NOT EXISTS idx_charges_key_only ON window_charges(key, window_start DESC, block_number DESC, log_index DESC);
`;
