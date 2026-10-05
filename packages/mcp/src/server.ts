/**
 * @sigilkit/mcp — MCP (Model Context Protocol) server exposing SigilKit to agent
 * frameworks (enhancement E14). The compromised-agent threat model maps directly:
 * the model can ASK for actions through these tools, but the wallet path bounds
 * what it can DO — every proposed action is validated against the scope with the
 * same zero-gas logic the SDK uses, and every executed action is on-chain auditable
 * via the indexer.
 *
 * Minimal stdio MCP: newline-delimited JSON-RPC 2.0 (initialize / tools/list /
 * tools/call / ping). Deliberately protocol-minimal — no SDK dependency beyond
 * @sigilkit/core — so it stays stable across MCP spec churn.
 */
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";
import { createRequire } from "node:module";
import type { Address, Hash } from "viem";
import {
  assertAddress,
  assertBigInt,
  assertHash32,
  assertHex,
  assertNonEmptyString,
  assertOneOf,
  assertUint,
  decodeSigilKitError,
  parseActionRequest,
  targetLeaf,
  merkleRoot,
  validateAgainstScope,
  ValidationError,
  type Scope,
  type ActionRequest,
} from "@sigilkit/core";
import { RowLimitExceededError, SigilIndexer } from "@sigilkit/indexer";
import { readEnvChoice } from "@sigilkit/core/config";
// P0-3: the logger surface comes from the `/logger` subpath, not the barrel. `createLogger`
// and `type Logger` are declared there and nowhere else, so the barrel import of them was a
// second, redundant route to the same module — one import per source, merged here rather than
// added alongside the line below.
import { createLogger, LOG_FORMATS, LOG_LEVELS, type Logger } from "@sigilkit/core/logger";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** MCP speaks JSON-RPC over stdout, so all diagnostics go to stderr. */
const defaultLogger: Logger = createLogger({
  scope: "mcp",
  level: readEnvChoice(process.env, "SIGILKIT_LOG_LEVEL", LOG_LEVELS, "info"),
  format: readEnvChoice(process.env, "SIGILKIT_LOG_FORMAT", LOG_FORMATS, "text"),
  out: (line) => process.stderr.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
});

/**
 * One MCP tool: its advertised metadata plus the handler that backs it.
 *
 * Exported because `TOOLS` is: a `ToolDef[]` whose element type is not exported is
 * unusable by a consumer that wants to wrap, filter or re-register the tool surface
 * (an embedder building its own server, or a test asserting on `inputSchema`).
 */
export interface ToolDef {
  /** Tool name as it appears on the wire (`tools/call` `params.name`). */
  name: string;
  /** Human/model-facing description surfaced by `tools/list`. */
  description: string;
  /** JSON Schema for the tool arguments, returned verbatim by `tools/list`. */
  inputSchema: Record<string, unknown>;
  /**
   * Handler for one call. May be sync or async; a throw is converted by
   * {@link handleMessage} into an `isError: true` tool result rather than a
   * protocol-level error, so a bad argument never breaks the session.
   */
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

const ZERO_ROOT = ("0x" + "0".repeat(64)) as Hash;

/**
 * Whether a whitelist leaf is bound to exact calldata (`pinned`) or to a bare
 * (target, selector) pair (`wildcard`).
 *
 * Exported because it is part of the `build_scope` **response** — the `leafKinds`
 * array is positionally aligned with the caller's `targets` input, so a consumer that
 * wants to know which entries are argument-bound has to be able to name this type.
 */
export type LeafKind = "pinned" | "wildcard";

/** Upper bound on whitelist entries, so one call cannot force an unbounded Merkle build. */
const MAX_TARGETS = 256;

/** Upper bound on the calldata of a single pinned leaf (bounds hashing and response size). */
const MAX_TARGET_DATA_BYTES = 4096;

/**
 * Accepts only a real boolean for a scope flag.
 *
 * A bare `Boolean(x)` reads the JSON string `"false"` as TRUE, so a scope that asked for
 * the flag to be OFF would silently switch a policy check ON. A non-boolean is a caller bug
 * and is named here rather than silently coerced.
 */
function coerceBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new ValidationError(field, "expected a boolean");
}

function coerceScope(raw: unknown): Scope {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("scope", "expected an object");
  }
  const r = raw as Record<string, unknown>;
  const watchlist = r.tokenWatchlist ?? [];
  if (!Array.isArray(watchlist)) {
    throw new ValidationError("scope.tokenWatchlist", "expected an array of addresses");
  }
  return {
    expiresAt: r.expiresAt === undefined ? 0 : assertUint(r.expiresAt, "scope.expiresAt", { min: 0 }),
    windowSeconds: r.windowSeconds === undefined ? 600 : assertUint(r.windowSeconds, "scope.windowSeconds", { min: 1 }),
    perActionCap: r.perActionCap === undefined ? 0n : assertBigInt(r.perActionCap, "scope.perActionCap", { min: 0n }),
    perWindowCap: r.perWindowCap === undefined ? 0n : assertBigInt(r.perWindowCap, "scope.perWindowCap", { min: 0n }),
    merkleRoot: r.merkleRoot === undefined ? ZERO_ROOT : assertHash32(r.merkleRoot, "scope.merkleRoot"),
    countersignAbove: r.countersignAbove === undefined ? 0n : assertBigInt(r.countersignAbove, "scope.countersignAbove", { min: 0n }),
    enforceNativeDelta:
      r.enforceNativeDelta === undefined ? false : coerceBoolean(r.enforceNativeDelta, "scope.enforceNativeDelta"),
    tokenWatchlist: watchlist.map((a, i) => assertAddress(a, `scope.tokenWatchlist[${i}]`)),
  };
}

/**
 * SEC-04: the audit database whitelist.
 *
 * `audit_query` used to accept any `db` string and let SQLite open it. Combined with a
 * differentiated "database not found: <path>" reply (and SQLite's own "file is not a
 * database" / "no such table" errors), that turned the tool into a filesystem *existence
 * oracle*: a model could walk the user's disk one guess at a time and learn which files
 * exist, and which of them are SQLite stores, from the error text alone.
 *
 * The fix is a closed, operator-controlled allowlist:
 *  - `SIGILKIT_AUDIT_DB_ROOT` lists the only directory trees a database may live in. It is
 *    read ONCE at startup — a compromised agent cannot widen it later, because it only
 *    ever speaks JSON-RPC.
 *  - When it is unset the tool refuses EVERY path. Fail-closed: an unset whitelist is a
 *    deployment mistake, and quietly falling back to "any path goes" would restore the
 *    very oracle this removes.
 *  - Errors are deliberately uniform and never echo the path back, so a rejected probe
 *    reveals nothing about what the agent guessed.
 */

/** Extensions accepted for an audit store; anything else is refused before any open. */
const AUDIT_DB_EXTENSIONS = [".db", ".sqlite", ".sqlite3"] as const;

/** Path shapes that are refused outright, before resolution can normalize them away. */
const FORBIDDEN_PATH_TOKENS = ["\\\\", "//", "\\\\.\\", "\0"] as const;

/**
 * Uniform refusal codes. Deliberately constant strings — the path is never interpolated,
 * so a rejection cannot be turned into a probe of the agent's own guess.
 *  - DB_NOT_ALLOWED   : refused by policy (unset allowlist, forbidden shape, outside root).
 *  - DATABASE_NOT_FOUND: absent, a directory, not a regular file, wrong extension, or
 *                        present but not a readable SQLite store — all indistinguishable.
 */
const DB_NOT_ALLOWED = "DB_NOT_ALLOWED";
const DATABASE_NOT_FOUND = "DATABASE_NOT_FOUND";

/**
 * The single response to every "I could not serve you a database from that path" case.
 * One constant, reused verbatim, so the wording can never drift between rejection sites
 * and the agent cannot infer the failure mode from which sentence came back.
 */
const DB_NOT_FOUND_MESSAGE = `${DATABASE_NOT_FOUND}: no audit database at that path (path withheld)`;

/** One configured root: the display form plus the canonical form used for prefix checks. */
interface AuditDbRoot {
  /** As configured by the operator; safe to show back in errors and logs. */
  configured: string;
  /** `realpathSync.native` of the configured path, used as the containment prefix. */
  real: string;
}

/**
 * Reads and canonicalizes `SIGILKIT_AUDIT_DB_ROOT` at module load.
 *
 * A `;`-separated list allows several roots. Each entry must be an absolute path; a
 * relative entry is dropped rather than resolved against `cwd`, because cwd under an
 * agent host is not a meaningful trust boundary. Entries that do not exist yet are
 * resolved lexically so an operator can allowlist a directory before creating it.
 */
function readAuditDbRoots(env: NodeJS.ProcessEnv = process.env): AuditDbRoot[] {
  const raw = env.SIGILKIT_AUDIT_DB_ROOT;
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .flatMap((entry) => {
      if (!isAbsolute(entry)) {
        // Fail-closed on a bad entry: dropping it silently would make the operator believe
        // a root is allowed when it is not. Surface it and allow nothing from that entry.
        defaultLogger.warn("SIGILKIT_AUDIT_DB_ROOT: ignoring a relative entry; audit roots must be absolute", { entry });
        return [];
      }
      // `realpathSync.native` resolves symlinks, so an allowed root cannot be swapped for a
      // link that points elsewhere. If the directory is missing, fall back to the lexical
      // absolute form so a not-yet-created root still works.
      let real: string;
      try {
        real = statSync(entry).isDirectory()
          ? realpathSync.native(entry)
          : resolvePath(entry);
      } catch {
        try {
          real = resolvePath(entry);
        } catch {
          return [];
        }
      }
      return [{ configured: entry, real }];
    });
}

/**
 * The process-wide allowlist, resolved at import time. Empty ⇒ every path is refused.
 *
 * In production this is written exactly once, when the module loads, and never again —
 * the allowlist is part of the server's trust configuration, not a request-scoped value.
 */
let AUDIT_DB_ROOTS: readonly AuditDbRoot[] = Object.freeze(readAuditDbRoots());

/**
 * Re-reads `SIGILKIT_AUDIT_DB_ROOT` from the given environment — **test-only**.
 *
 * Exists because the production path deliberately latches the allowlist at startup, which
 * no test could otherwise exercise (every case needs a different root, or none at all).
 * Never call this from serving code: re-deriving trust from a mutable source mid-process
 * is exactly the widening this design is meant to prevent.
 */
export function __setAuditDbRootsForTests(env: NodeJS.ProcessEnv): void {
  AUDIT_DB_ROOTS = Object.freeze(readAuditDbRoots(env));
  // SEC-13: narrowing or clearing the allowlist invalidates every handle opened under the
  // previous policy, and a handle left open holds a Windows file lock that blocks the very
  // sandbox teardown the tests perform. The cache is policy-scoped, so it is dropped with
  // the policy. Idempotent, so a repeated reset (every afterEach) is free.
  closeAllAuditHandles();
}

/** True when `candidate` is `root` itself or a descendant of it. */
function isInsideRoot(candidate: string, root: string): boolean {
  // The trailing separator is what makes the check a *directory* test: without it,
  // "/data/evil" would pass as being inside "/data". Comparing on the case-insensitive
  // Windows path grammar keeps `C:\DATA\x.db` from escaping a `C:\Data` root.
  const prefix = root.endsWith(sep) ? root : root + sep;
  const a = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const b = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  return a === b || a.startsWith(b);
}

/**
 * SEC-14: the lexical pre-filter, and why it must accept *either* spelling of a root.
 *
 * The existence-oracle fix has to decide containment on a pure function of the input
 * string, before any syscall can report whether the target exists. That is only possible
 * on the lexical (unresolved) form — so the operator's root must be compared in the same
 * space the caller's string is in.
 *
 * A root can legitimately be named two ways: the operator may have written the path
 * through a symlink or a `\\?\` prefix (`C:\data` vs `C:\mnt\data`), in which case only
 * the canonical form matches a plainly-spelled request. Comparing both spellings is what
 * keeps the oracle closed *without* breaking a correct deployment: accepting a request
 * whose lexical form matches either spelling cannot grant access to anything the
 * post-realpath check would then refuse, so the second gate remains authoritative.
 */
function isLexicallyInsideAnyRoot(absolute: string): boolean {
  return AUDIT_DB_ROOTS.some(
    (root) => isInsideRoot(absolute, root.real) || isInsideRoot(absolute, root.configured),
  );
}

/**
 * Resolves and authorizes a caller-supplied `db` path, or throws a uniform refusal.
 *
 * Order matters. Cheap, input-only rejections (NUL byte, UNC, extension) run before any
 * syscall, so a malformed probe costs no `stat` and cannot be distinguished from a
 * well-formed one. The containment check runs against the `realpath` of the target, which
 * defuses symlink swaps and `..` traversal; only then do we look at the file's own
 * extension. Finally the path is opened, and a failure there — whether the file is
 * absent, a directory, not SQLite, or unreadable — collapses into one indistinguishable
 * `DATABASE_NOT_FOUND` so the error text never becomes a type oracle.
 */
function resolveAuditDbPath(raw: unknown): string {
  const db = assertNonEmptyString(raw, "db");

  // 1. Reject dangerous path shapes on the raw input, before any resolution.
  for (const token of FORBIDDEN_PATH_TOKENS) {
    if (db.includes(token)) {
      throw new ValidationError("db", `${DB_NOT_ALLOWED}: path contains a forbidden sequence (path withheld)`);
    }
  }

  // 2. Fail closed: no allowlist configured ⇒ no path is acceptable.
  if (AUDIT_DB_ROOTS.length === 0) {
    throw new ValidationError(
      "db",
      `${DB_NOT_ALLOWED}: audit_query is disabled because SIGILKIT_AUDIT_DB_ROOT is not set. ` +
        `Set it to the absolute directory that holds your audit database(s) ` +
        `(several roots may be separated by ";"). No path is accepted while it is unset.`,
    );
  }

  // 3. Make the path absolute, then resolve every symlink in it. realpathSync.native
  //    throws ENOENT/ENOTDIR when the target is missing.
  //
  //    SEC-14 (existence oracle, fixed here): the *code* used to depend on whether the
  //    target happened to exist. A path that resolved but landed outside every root was
  //    refused with DB_NOT_ALLOWED, while a path that failed to resolve — which is what an
  //    absent file, an absent parent, or a mistyped directory all produce — was refused
  //    with DATABASE_NOT_FOUND. An agent could therefore map the filesystem one guess at a
  //    time: DB_NOT_ALLOWED proved "this exact path exists and resolves", and its absence
  //    proved "it does not". The *ordering* below is what closes it — containment is now
  //    decided on the lexical form, which is a pure function of the input string, BEFORE
  //    any syscall can report on the target's existence. Only once the lexical form is
  //    already known to be inside a root does the resolver run at all, and by then every
  //    remaining failure is genuinely about a path the operator already declared in bounds.
  const absolute = resolvePath(db);
  if (!isLexicallyInsideAnyRoot(absolute)) {
    throw new ValidationError("db", `${DB_NOT_ALLOWED}: audit database is outside the configured root directories (path withheld)`);
  }

  let real: string;
  try {
    real = realpathSync.native(absolute);
  } catch {
    // A missing file, a missing parent directory, and a path whose parent is a file all
    // land here. All three are the same answer as far as the caller can tell, and none of
    // them is distinguished from "exists but is not a database" (step 5).
    throw new ValidationError("db", DB_NOT_FOUND_MESSAGE);
  }

  // 4. Containment of the RESOLVED path. The lexical test above cannot see through a
  //    symlink, so it is not sufficient on its own: an in-root `x.db` pointing at
  //    /etc/shadow passes it. Re-checking after realpath is what actually defuses the link
  //    swap, and it stays fail-closed because a target that is NOT inside the root is also
  //    a target the caller was never entitled to name.
  if (!AUDIT_DB_ROOTS.some((root) => isInsideRoot(real, root.real))) {
    throw new ValidationError("db", `${DB_NOT_ALLOWED}: audit database is outside the configured root directories (path withheld)`);
  }

  // 5. The target must be a regular file with a database extension. `statSync` follows
  //    symlinks, but step 4 already proved the *resolved* location is inside a root, so
  //    this cannot be used to launder an out-of-root target through an in-root symlink.
  let isFile = false;
  try {
    isFile = statSync(real).isFile();
  } catch {
    isFile = false; // vanished between realpath and stat ⇒ treated as not found (step 6)
  }
  if (!isFile) {
    throw new ValidationError("db", DB_NOT_FOUND_MESSAGE);
  }

  // 6. Extension gate, on the *resolved* path so a `x.db -> secrets.txt` style link
  //    cannot smuggle a non-database past the check. A file that exists and is regular but
  //    has the wrong suffix still reports "not found" rather than naming the extension, so
  //    the message does not confirm that the file exists.
  const lower = real.toLowerCase();
  if (!AUDIT_DB_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new ValidationError("db", DB_NOT_FOUND_MESSAGE);
  }

  return real;
}

// ── SEC-13: process-level resource bounds ───────────────────────────────────────────
//
// Every bound below is a *resource* bound rather than a correctness bound. A model chooses
// its own inputs, so anything the tool surface will accept is also something an attacker can
// replay at rate; without these ceilings a single peer can exhaust host memory or force a
// lock storm on the operator's audit database. The numbers are chosen to sit well above any
// legitimate request (a 256-leaf build_scope, a 1 000-row audit page) while still bounding
// the worst case to a few MiB.

/**
 * Longest single request line, in bytes, counted on the raw byte stream.
 *
 * 1 MiB is ~1 000× the largest legitimate MCP request (a 256-entry build_scope with 4 KiB
 * calldata is ~1 MiB of JSON, so the two bounds are deliberately the same order). It is
 * counted while chunks are read, never after a full line has been materialised: readline
 * buffers an unbounded line by design, so a 500 MB single line would already be resident
 * before any "is this too long?" question could be asked.
 */
const MAX_REQUEST_LINE_BYTES = 1_048_576;

/** How many tool calls may be in flight at once before further ones are refused. */
const MAX_INFLIGHT_TOOL_CALLS = 8;

/**
 * Largest serialized tool response, in bytes.
 *
 * Exceeding it is an *error*, never a truncation. A clipped audit page is not a smaller
 * truth, it is a false one: the agent would read a list that looks complete while silently
 * missing the very row it was looking for. So the reply is refused and the caller is told to
 * narrow the query.
 */
const MAX_RESPONSE_BYTES = 1_048_576;

/** Deepest nesting accepted anywhere in a decoded request, guarding the recursive walks below. */
const MAX_REQUEST_DEPTH = 8;

/** How many audit database handles may be held open at once, least-recently-used evicted. */
const MAX_CACHED_AUDIT_HANDLES = 8;

/** One cached audit handle: the handle itself plus its LRU bookkeeping. */
interface AuditHandle {
  readonly indexer: SigilIndexer;
  /**
   * Chain identity this handle was constructed with. The cache is keyed by resolved path
   * alone, so a request naming a DIFFERENT chain must not inherit a handle built for
   * another one.
   */
  readonly chainId: number;
  /**
   * Monotonic use counter, not a wall clock. Two handles touched in the same millisecond
   * must still order deterministically, and a clock that jumps backwards (NTP) must never
   * promote a cold entry over a hot one.
   */
  lastUsed: number;
}

/**
 * Open audit databases, keyed by the path `resolveAuditDbPath` returned.
 *
 * The key is the *resolved* realpath, which is exactly the string the SEC-04 checks operate
 * on. That matters for two reasons: two spellings of one file (`x.db` and `link -> x.db`)
 * collapse onto one handle instead of opening the same file twice, and a caller cannot use
 * an alias to smuggle a second handle past the eviction bound. The bound is on distinct
 * *resolved* paths, so it cannot be inflated by aliases.
 *
 * Previously every call opened and closed its own handle. Under a burst that is a lock
 * storm: Windows holds an exclusive lock on an open SQLite file, so N concurrent queries
 * against one database made N open/close cycles racing for the same file, and each `close()`
 * threw `ERR_INVALID_STATE` if a rejected open had left nothing to close. One handle per
 * resolved path, reused, removes both the churn and the double-close.
 */
const AUDIT_HANDLES = new Map<string, AuditHandle>();

/** Source of the monotonically increasing LRU stamp; never wraps in any realistic run. */
let auditHandleClock = 0;

/**
 * Returns the shared read-only handle for `db` (already resolved and authorized), opening
 * it on first use.
 *
 * A cached handle is only ever *reused*, never closed here — the caller must not close
 * what it borrowed. `close()` is idempotent in `SigilIndexer`, but the point stands that
 * ownership is the cache's alone.
 */
function acquireAuditHandle(db: string, chainId: number): SigilIndexer {
  const hit = AUDIT_HANDLES.get(db);
  if (hit !== undefined) {
    if (hit.chainId === chainId) {
      hit.lastUsed = ++auditHandleClock;
      return hit.indexer;
    }
    // The cache key is the resolved path, so a request for another chain would otherwise be
    // answered by an indexer constructed with the FIRST call's chainId — 0 whenever the
    // common unfiltered call came first. The stale handle is released BEFORE the new one is
    // opened: a second open of the same SQLite file hits the lock the first one still holds.
    AUDIT_HANDLES.delete(db);
    try {
      hit.indexer.close();
    } catch (err) {
      defaultLogger.error("failed to close an audit database handle held for another chain", { db }, err);
    }
  }

  // BUG-9: this tool advertises itself as read-only, so it must not create directories, run
  // DDL, or write a single row. readOnly opens with SQLite's readOnly flag and skips
  // mkdir/migrate/schema entirely.
  let indexer: SigilIndexer;
  try {
    indexer = new SigilIndexer(db, chainId, { readOnly: true, logger: defaultLogger });
  } catch {
    // The store exists, is readable and carries a database extension, yet SQLite refused it.
    // Do not surface its message: "file is not a database", "unable to open database file"
    // and "permission denied" are exactly the signals a probe would use to learn what sits
    // at a guessed path. One uniform code instead.
    throw new ValidationError("db", DB_NOT_FOUND_MESSAGE);
  }

  AUDIT_HANDLES.set(db, { indexer, chainId, lastUsed: ++auditHandleClock });

  // Evict oldest-first, *including the entry just added* if the cache was already full —
  // the bound is a hard ceiling on open descriptors, never a soft one.
  while (AUDIT_HANDLES.size > MAX_CACHED_AUDIT_HANDLES) {
    let oldestKey: string | undefined;
    let oldestStamp = Number.POSITIVE_INFINITY;
    for (const [key, entry] of AUDIT_HANDLES) {
      if (entry.lastUsed < oldestStamp) {
        oldestStamp = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    const evicted = AUDIT_HANDLES.get(oldestKey);
    AUDIT_HANDLES.delete(oldestKey);
    if (evicted !== undefined) {
      // Best-effort: a handle that refuses to close must not stop the eviction of the next.
      try {
        evicted.indexer.close();
      } catch (err) {
        // `error` rather than `warn`: only the 3-arg overload renders `err` natively, and a
        // caught Error stuffed into LogFields would be redacted down to "CIRCULAR".
        defaultLogger.error("failed to close an evicted audit database handle", { db: oldestKey }, err);
      }
    }
  }
  return indexer;
}

/**
 * Closes every cached audit handle. Idempotent, and safe to call from a `process.on("exit")`
 * handler where only synchronous work is permitted.
 *
 * Nothing is thrown: this runs on the shutdown path, and a throw here would replace a clean
 * exit with a stack trace while the handles are being released anyway.
 */
function closeAllAuditHandles(): void {
  for (const [key, entry] of AUDIT_HANDLES) {
    try {
      entry.indexer.close();
    } catch (err) {
      defaultLogger.error("failed to close an audit database handle during shutdown", { db: key }, err);
    }
  }
  AUDIT_HANDLES.clear();
}

/**
 * Number of audit handles currently cached. Test-only.
 *
 * The LRU bound was previously observed indirectly, through whether a cached file could be
 * unlinked — which only distinguishes a cached handle on Windows. That made the SEC-13 bound
 * untested on POSIX, where an open file is unlinkable. This exposes the count so the test can
 * assert the property directly on every platform.
 */
export function __auditHandleCacheSizeForTests(): number {
  return AUDIT_HANDLES.size;
}

/**
 * Runs {@link parseActionRequest} and re-labels its failures for the tool boundary.
 *
 * `parseActionRequest` is the shared SDK parser, and its messages are already good, but two
 * things are wrong for an MCP caller specifically:
 *
 *  1. **No field prefix.** It reports `agentId must be 32-byte hex`, while every other
 *     validation on this surface says `scope.tokenWatchlist[1]: …`. An agent that has to
 *     map a sentence back to a field is doing bookkeeping the tool should have done, and
 *     the JSON-RPC layer's `required` pre-check already teaches it to expect the
 *     `request.x` shape. Prefixing makes the three tools agree.
 *  2. **It throws a bare `Error`, not a `ValidationError`.** That means it is not
 *     distinguishable from a genuine internal fault, so the generic handler in
 *     `handleMessage` cannot tell "the model sent a bad field" from "the server broke".
 *
 * The original message is preserved as the detail, so nothing actionable is lost. Anything
 * that is already a `ValidationError` (a future core change) is passed through untouched.
 */
function parseActionRequestIn(field: string, raw: unknown): ActionRequest {
  try {
    return parseActionRequest(raw);
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    // The parser's sentences are all of the form
    //   `parseActionRequest: <fieldName> <what went wrong>`
    // (or `missing required field '<fieldName>'`). Recovering `<fieldName>` and re-qualifying
    // it turns `agentId must be 32-byte hex, got 2 bytes` into
    // `request.agentId: 32-byte hex expected, got 2 bytes` — the exact `request.x` shape the
    // `required` pre-check already teaches the caller, and the shape every other validation
    // on this surface uses.
    //
    // When the field cannot be recovered (a non-object `request`, say) the whole argument is
    // named instead, which is still actionable. Nothing is ever dropped: the original
    // sentence is kept as a trailing clause so no diagnostic detail is lost.
    const named = /^(?:parseActionRequest: )?([A-Za-z_][A-Za-z0-9_]*) /.exec(detail);
    const inner = named?.[1];
    if (inner === undefined) {
      throw new ValidationError(field, detail.replace(/^parseActionRequest: /, ""));
    }
    // Both the prefix and the tail mention the field, so it is stripped from the tail
    // rather than printed twice: `request.agentId: 32-byte hex expected, got 2 bytes`.
    const tail = detail
      .replace(new RegExp(`^(?:parseActionRequest: )?${inner}\\b`), "")
      .replace(/^[:,]\s*/, "");
    throw new ValidationError(`${field}.${inner}`, tail);
  }
}

/** True when `value` nests deeper than `limit` levels of plain objects/arrays. */
function exceedsDepth(value: unknown, limit: number): boolean {
  // Depth is carried *per path*, not as a single running counter. A counter would make this
  // a node-count test instead of a nesting test, and a legitimate 256-entry `targets` array
  // (256 sibling objects) would trip it. An explicit stack rather than recursion: the very
  // input this walks may be deep enough to be an attack, so the walk itself must not be the
  // thing that overflows the call stack.
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (node === null || typeof node !== "object") continue;
    if (depth > limit) return true;
    for (const child of Object.values(node as Record<string, unknown>)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
}

/** The tool surface. Each tool is a pure, auditable operation — no key material. */
export const TOOLS: ToolDef[] = [
  {
    name: "validate_request",
    description:
      "Zero-gas policy check of an ActionRequest against a session-key scope, exactly mirroring the on-chain enforcement (caps, window, expiry, whitelist membership). Returns ok:false with the precise reason when the wallet would reject the action.",
    inputSchema: {
      type: "object",
      required: ["request", "scope"],
      properties: {
        request: { type: "object", description: "ActionRequest (value/nonce as strings or numbers)" },
        scope: { type: "object", description: "Scope (bigint caps as strings)" },
        windowState: { type: "object", description: "Optional {windowStart, spentThisWindow} from getWindowState" },
        merkleProof: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional sorted-pair Merkle proof (32-byte hex nodes) proving this request's (target, selector[, data]) leaf is in the scope's whitelist. Required when scope.merkleRoot is non-zero: without it, membership cannot be proven and the answer is always 'target not whitelisted'.",
        },
      },
    },
    run: (args) => {
      const request = parseActionRequestIn("request", args.request);
      const scope = coerceScope(args.scope);
      const rawWindow = args.windowState;
      if (rawWindow !== undefined && (rawWindow === null || typeof rawWindow !== "object")) {
        throw new ValidationError("windowState", "expected an object {windowStart, spentThisWindow}");
      }
      const ws = rawWindow as Record<string, unknown> | undefined;
      // Whitelist membership is PROVEN by a sorted-pair Merkle proof over the scope's
      // leaves. This used to pass `merkleProof: undefined` unconditionally, which made
      // validateAgainstScope answer "target not whitelisted" for every request against a
      // non-zero merkleRoot — a pinned whitelist could therefore never be checked at all.
      // The check is NOT loosened: the caller supplies the same bytes32[] proof the
      // transaction carries, and every element is validated before it is walked.
      const rawProof = args.merkleProof;
      if (rawProof !== undefined && !Array.isArray(rawProof)) {
        throw new ValidationError("merkleProof", "expected an array of 32-byte hex nodes");
      }
      const merkleProof = (rawProof as unknown[] | undefined)?.map((node, i) =>
        assertHash32(node, `merkleProof[${i}]`),
      );
      return validateAgainstScope({
        request,
        scope,
        merkleProof,
        windowState: ws
          ? {
              windowStart: assertUint(ws.windowStart ?? 0, "windowState.windowStart", { min: 0 }),
              spentThisWindow: assertBigInt(ws.spentThisWindow ?? "0", "windowState.spentThisWindow", { min: 0n }),
            }
          : undefined,
      });
    },
  },
  {
    name: "build_scope",
    description:
      "Builds a Scope grant spec and the Merkle root over a target list. Owners pass this to grantSessionKey. Each entry whitelists one (target, selector) pair; supplying `data` additionally binds that leaf to the exact calldata (pinned, argument-bound) instead of accepting any calldata for the selector (wildcard). `targets` is required and must be non-empty — an empty list is rejected rather than silently yielding an allow-all root. Set allowAllTargets:true with targets:[] to build an allow-all scope deliberately.",
    inputSchema: {
      type: "object",
      required: ["expiresAt", "perActionCap", "perWindowCap", "targets"],
      properties: {
        expiresAt: { type: "number" },
        windowSeconds: { type: "number" },
        perActionCap: { type: "string" },
        perWindowCap: { type: "string" },
        countersignAbove: { type: "string" },
        enforceNativeDelta: { type: "boolean" },
        allowAllTargets: {
          type: "boolean",
          description:
            "Escape hatch: permit an empty targets list to yield the allow-all root 0. Off by default; prefer explicit (target, selector[, data]) leaves.",
        },
        targets: {
          type: "array",
          minItems: 1,
          maxItems: MAX_TARGETS,
          description: `Whitelist entries [{target, selector, data?}], 1..${MAX_TARGETS} of them. Omitting data yields a wildcard leaf (any calldata for that selector); supplying it yields a pinned leaf bound to that exact calldata.`,
          items: {
            type: "object",
            required: ["target", "selector"],
            properties: {
              target: { type: "string", description: "20-byte hex address of the callee contract" },
              selector: { type: "string", description: "4-byte function selector" },
              data: {
                type: "string",
                description: `Optional exact calldata (0x-prefixed, even length, max ${MAX_TARGET_DATA_BYTES} bytes) binding the leaf to that one call. Omit for a wildcard leaf.`,
              },
            },
          },
        },
      },
    },
    run: (args) => {
      const rawTargets = args.targets;
      if (!Array.isArray(rawTargets)) {
        throw new ValidationError("targets", "expected an array of {target, selector, data?}");
      }
      // SEC-03: an absent/empty list used to return the allow-all root 0, so simply
      // omitting `targets` granted every target. That is now an explicit error; the
      // only way to allow all is to ask for it via allowAllTargets.
      const allowAll = args.allowAllTargets === true;
      if (rawTargets.length === 0 && !allowAll) {
        throw new ValidationError(
          "targets",
          "at least one target is required (an empty list would build an allow-all root). Pass {target, selector, data?} entries, or set allowAllTargets:true to opt into allow-all deliberately.",
        );
      }
      // SEC-13: MAX_TARGETS bounds how many *siblings* there are, not how deep they nest.
      // A single entry whose `data`/extra keys carry an arbitrarily deep object would still
      // walk forever through any recursive shape helper, so the whole request is depth-checked
      // before the Merkle build starts.
      if (exceedsDepth(rawTargets, MAX_REQUEST_DEPTH)) {
        throw new ValidationError(
          "targets",
          `expected at most ${MAX_REQUEST_DEPTH} levels of nesting, which is exceeded. Flatten the target entries to {target, selector, data?}.`,
        );
      }
      // DoS guard: bound both the Merkle construction and the size of the response.
      if (rawTargets.length > MAX_TARGETS) {
        throw new ValidationError("targets", `expected at most ${MAX_TARGETS} entries, got ${rawTargets.length}`);
      }

      const targets = rawTargets.map((t, i) => {
        if (t === null || typeof t !== "object" || Array.isArray(t)) {
          throw new ValidationError(`targets[${i}]`, "expected an object {target, selector, data?}");
        }
        const entry = t as Record<string, unknown>;
        // The third argument of targetLeaf is what distinguishes a pinned leaf
        // (argsHash = keccak(data)) from a wildcard one (argsHash = 0); it was
        // structurally unreachable before, which made argument binding a fiction.
        const data = entry.data === undefined ? undefined : assertHex(entry.data, `targets[${i}].data`);
        // assertHex pins the format; the size cap lives here because the core helper
        // takes no maxBytes option and this file owns the tool's input contract.
        if (data !== undefined && (data.length - 2) / 2 > MAX_TARGET_DATA_BYTES) {
          throw new ValidationError(
            `targets[${i}].data`,
            `expected at most ${MAX_TARGET_DATA_BYTES} bytes of calldata, got ${(data.length - 2) / 2}`,
          );
        }
        return {
          target: assertAddress(entry.target, `targets[${i}].target`),
          selector: assertHex(entry.selector, `targets[${i}].selector`, { bytes: 4 }),
          data,
        };
      });

      // With allowAllTargets and no entries there is no tree to build (merkleRoot
      // rejects an empty leaf set), so the root stays the allow-all sentinel.
      const leafKinds: LeafKind[] = [];
      let root: Hash = ZERO_ROOT;
      let leaves: Hash[] = [];
      if (targets.length > 0) {
        leaves = targets.map((t) => targetLeaf(t.target, t.selector, t.data));
        for (const t of targets) leafKinds.push(t.data === undefined ? "wildcard" : "pinned");
        root = merkleRoot(leaves);
      }
      const perActionCap = assertBigInt(
        args.perActionCap,
        "perActionCap",
        { min: 0n },
      ).toString();
      const perWindowCap = assertBigInt(
        args.perWindowCap,
        "perWindowCap",
        { min: 0n },
      ).toString();
      // Mirror the contract's InvalidScope() conditions, not merely the field shapes.
      // Assembly with perActionCap == 0 or perWindowCap < perActionCap reverts on-chain
      // (SessionKeyManager.sol:513-514), and core's encode7579InstallData throws on the
      // same two (accounts.ts:137,143) — so a scope the tool assembles must not be one the
      // chain refuses. Rejecting here gives the agent the cause at build time instead of a
      // revert at execution.
      if (BigInt(perActionCap) === 0n) {
        throw new ValidationError("perActionCap", "must be greater than zero");
      }
      if (BigInt(perWindowCap) < BigInt(perActionCap)) {
        throw new ValidationError("perWindowCap", "must be >= perActionCap");
      }
      return {
        scope: {
          expiresAt: assertUint(args.expiresAt, "expiresAt", { min: 1 }),
          windowSeconds: args.windowSeconds === undefined ? 600 : assertUint(args.windowSeconds, "windowSeconds", { min: 1 }),
          perActionCap,
          perWindowCap,
          merkleRoot: root,
          countersignAbove: args.countersignAbove === undefined ? "0" : assertBigInt(args.countersignAbove, "countersignAbove", { min: 0n }).toString(),
          enforceNativeDelta:
            args.enforceNativeDelta === undefined
              ? false
              : coerceBoolean(args.enforceNativeDelta, "enforceNativeDelta"),
          tokenWatchlist: [],
        },
        leaves,
        leafKinds,
        note:
          targets.length === 0
            ? "merkleRoot 0 = allow ALL targets (dangerous) — produced because allowAllTargets:true was set explicitly."
            : "Each entry is a wildcard leaf unless data was supplied (pinned, bound to that exact calldata). Prefer pinned leaves for value-bearing calls.",
      };
    },
  },
  {
    name: "decode_error",
    description: "Decodes SigilKit revert data into a named error with arguments (e.g. PerActionCapExceeded(value, cap)).",
    inputSchema: { type: "object", required: ["data"], properties: { data: { type: "string", description: "0x revert data" } } },
    run: (args) => decodeSigilKitError(assertHex(args.data, "data")),
  },
  {
    name: "audit_query",
    description:
      "Queries the indexer's SQLite database (built by @sigilkit/indexer): cumulative spend per agent, recent audited actions, or a summary. Strictly read-only: the database is opened with SQLite's readOnly flag, so no directory, table, index or row is ever created or modified. Pass chainId to scope a query to one chain; omit it to aggregate across every chain in the store. The db path must resolve inside a directory whitelisted by the operator in SIGILKIT_AUDIT_DB_ROOT; when that variable is unset the tool refuses every path, so this tool is inert until it is configured.",
    inputSchema: {
      type: "object",
      required: ["db"],
      properties: {
        db: {
          type: "string",
          description:
            "Audit database path (must resolve inside a root directory whitelisted by the operator in SIGILKIT_AUDIT_DB_ROOT; refused entirely when that variable is unset)",
        },
        query: { type: "string", enum: ["spend", "actions", "summary"], description: "Default: summary" },
        agentId: { type: "string" },
        chainId: {
          type: "number",
          description: "Optional chain filter. Omit to aggregate across all chains in the store.",
        },
        limit: {
          type: "number",
          description: `Optional page size for query:"actions" — the newest N rows. Omit it to keep the full result, which is refused (not truncated) once the response would exceed ${MAX_RESPONSE_BYTES} bytes.`,
        },
      },
    },
    run: (args) => {
      // Argument shape is validated *before* the path is touched: a malformed `query` or
      // `chainId` is a caller bug, and reporting it must not require a filesystem probe.
      const query = assertOneOf(args.query ?? "summary", "query", ["spend", "actions", "summary"] as const);
      const filter = args.chainId === undefined ? undefined : assertUint(args.chainId, "chainId", { min: 1 });
      const wantedAgentId =
        query === "summary" ? undefined : assertHash32(args.agentId, "agentId");
      // SEC-13: an explicit page size is the documented remedy for an oversized response, so
      // it is validated here rather than at serialisation time where the caller could not
      // act on the advice. Omitting it keeps the "every matching row" contract.
      const limit = args.limit === undefined ? undefined : assertUint(args.limit, "limit", { min: 1 });

      // SEC-04: `db` is a caller-controlled path, so it is never passed to SQLite until
      // resolveAuditDbPath has (a) rejected the dangerous shapes, (b) proven the *resolved*
      // location sits inside an operator-configured root, and (c) confirmed a regular
      // database file. The old `existsSync` + differentiated error text is gone: realpath
      // covers existence, and every failure below now collapses into one of two uniform
      // messages that never echo the path, so the tool is no longer a filesystem oracle.
      const db = resolveAuditDbPath(args.db);

      // SEC-13: borrow the process-wide read-only handle for this resolved path instead of
      // opening one per call. Ownership stays with the cache: a hit must NOT be closed here,
      // because the same handle is the one the next call will reuse. A miss that fails to
      // open is reported with the same uniform message as before, so nothing here becomes a
      // path oracle.
      const ix = acquireAuditHandle(db, filter ?? 0);
      try {
        if (query === "spend") {
          return {
            agentId: wantedAgentId,
            chainId: filter ?? null,
            totalWei: ix.spendByAgent(wantedAgentId!, filter).toString(),
          };
        }
        if (query === "actions") {
          return {
            agentId: wantedAgentId,
            chainId: filter ?? null,
            actions: ix.actionsForAgent(wantedAgentId!, filter, limit),
          };
        }
        return { summary: ix.summary(filter), chains: ix.chainIds() };
      } catch (err) {
        // Same reasoning for the query phase: a valid-but-foreign SQLite file raises
        // "no such table: actions" — free confirmation that the guessed path really is
        // a database. Mask it, but let our own argument validation (a bad agentId, an
        // unknown query mode) keep its specific, actionable message.
        //
        // The row ceiling is the same kind of our-own error: it means the filter matched
        // more rows than the indexer will list without an explicit limit. Masking that as
        // "database not found" told a caller with a real database the wrong thing, so it
        // is re-thrown with its own message. Only genuinely unrecognised failures — the
        // ones that could confirm a path — stay masked.
        if (err instanceof ValidationError) throw err;
        if (err instanceof RowLimitExceededError) {
          throw new ValidationError("limit", err.message);
        }
        throw new ValidationError("db", DB_NOT_FOUND_MESSAGE);
      }
    },
  },
];

/**
 * SEC-13: how many tool calls may be in flight at once.
 *
 * A cheap counting semaphore. It is deliberately *not* a queue: a caller that is already
 * saturated should be told so immediately and be free to retry, rather than having its
 * requests parked in an unbounded backlog where they would hold a request id and a live
 * SQLite handle while the client waits. Refusing keeps the server's own footprint flat under
 * load instead of trading it for latency and memory.
 */
let inflightToolCalls = 0;

/** JSON-RPC code used for a refusal the caller may usefully retry. */
const SERVER_BUSY = -32000;

/** Dispatches one JSON-RPC message; returns the response object or null (notification). */
export async function handleMessage(msg: {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  const { id, method, params = {} } = msg;
  if (!method) return null;
  const respond = (result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });

  switch (method) {
    case "initialize":
      return respond({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sigilkit-mcp", version: pkg.version },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response
    case "ping":
      return respond({});
    case "tools/list":
      return respond({
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = params.name as string;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return error(-32602, `unknown tool: ${name}`);
      // Enforce the tool's declared `required` fields before dispatch: the JSON-RPC
      // layer does not validate them, and a missing argument would otherwise surface
      // as a cryptic TypeError from inside the handler (e.g. "reading 'slice'").
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      const missing = required.filter((k) => args[k] === undefined);
      if (missing.length > 0) {
        return respond({
          content: [{ type: "text", text: `missing required argument(s): ${missing.join(", ")}` }],
          isError: true,
        });
      }
      // SEC-13: cap the *nesting* of the whole request before any handler sees it. The
      // per-tool guards (build_scope's depth check) cover the shapes that recurse; this is
      // the transport-level backstop for any future tool that forgets to add its own.
      if (exceedsDepth(params, MAX_REQUEST_DEPTH)) {
        return respond({
          content: [
            {
              type: "text",
              text: `tool error: params: request nests deeper than ${MAX_REQUEST_DEPTH} levels; flatten the arguments and retry`,
            },
          ],
          isError: true,
        });
      }
      // SEC-13: bounded concurrency. Acquire *after* the cheap rejections above, so a
      // malformed call never consumes a slot, and release in `finally` so a throwing tool
      // cannot leak capacity and wedge the server permanently at zero slots.
      if (inflightToolCalls >= MAX_INFLIGHT_TOOL_CALLS) {
        return error(SERVER_BUSY, `server busy: at most ${MAX_INFLIGHT_TOOL_CALLS} tool calls may be in flight; retry`);
      }
      inflightToolCalls++;
      try {
        const result = await tool.run(args);
        // SEC-13: bound the response on the *serialized* bytes, which is what actually
        // travels over the pipe. Measured after stringify because that is the real cost;
        // refusing rather than slicing is deliberate — a truncated audit list reads as
        // complete while quietly missing rows, and silently wrong audit data is worse than
        // no answer at all.
        const text = JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > MAX_RESPONSE_BYTES) {
          return respond({
            content: [
              {
                type: "text",
                text:
                  `tool error: ${tool.name}: response is ${bytes} bytes, over the ${MAX_RESPONSE_BYTES}-byte limit. ` +
                  `It is refused rather than truncated, because a clipped result would look complete while missing rows. ` +
                  `Narrow the query — for audit_query pass a smaller "limit" (and/or "chainId"); ` +
                  `for build_scope pass fewer "targets".`,
              },
            ],
            isError: true,
          });
        }
        return respond({ content: [{ type: "text", text }] });
      } catch (err) {
        return respond({
          content: [{ type: "text", text: `tool error: ${err instanceof Error ? err.message : err}` }],
          isError: true,
        });
      } finally {
        inflightToolCalls--;
      }
    }
    default:
      return id === undefined || id === null ? null : error(-32601, `method not found: ${method}`);
  }
}

/**
 * SEC-13: a byte-counting pass in front of readline that refuses an over-long line *while
 * it is still arriving*.
 *
 * This cannot be done in the `line` handler. readline has no length ceiling — it keeps
 * concatenating chunks into one string until it sees a newline — so by the time a `line`
 * event fires, a 500 MB request is already fully resident, and a check there would only
 * decide what to do with memory that has already been allocated. Counting on the raw chunk
 * stream means the decision is made after at most `limit` bytes have been touched, and the
 * rest of the attack never enters this process.
 *
 * The count is per line, not cumulative: a long conversation of small requests is
 * unlimited, which is what an agent host actually does, while a single absurd line is not.
 * A line of exactly `limit` bytes is allowed (the newline is not part of it); `limit + 1`
 * is refused.
 *
 * On overflow the guard latches, stops forwarding, and invokes `onOverflow` exactly once —
 * further chunks are dropped rather than parsed, so the attacker cannot recover the
 * connection by continuing to write.
 */
function createLineLengthGuard(limit: number, onOverflow: () => void): Transform {
  let lineBytes = 0;
  let overflowed = false;
  return new Transform({
    decodeStrings: true,
    transform(chunk, _encoding, callback) {
      if (overflowed) {
        callback();
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      let start = 0;
      while (start < buf.length) {
        const nl = buf.indexOf(0x0a, start);
        const end = nl === -1 ? buf.length : nl;
        const segment = end - start;
        if (lineBytes + segment > limit) {
          overflowed = true;
          // Drop this chunk without forwarding it: the offending line is never completed,
          // so it can never reach JSON.parse.
          callback();
          onOverflow();
          return;
        }
        lineBytes += segment;
        // A newline closes the current line, so the next segment starts a fresh count.
        if (nl !== -1) lineBytes = 0;
        start = nl === -1 ? buf.length : nl + 1;
      }
      callback(null, buf);
    },
  });
}

/** Stdio entry: newline-delimited JSON-RPC in, responses out. Returns a stop function. */
export function serveStdio(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  logger: Logger = defaultLogger,
): () => void {
  /** A closed pipe (client exited) must not crash the server with an unhandled EPIPE. */
  const write = (payload: Record<string, unknown>): void => {
    try {
      output.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      logger.warn("failed to write response; client may have disconnected", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // SEC-13: the byte budget is enforced here, upstream of readline, so an over-long line is
  // refused while it is still arriving instead of after it has been buffered in full. The
  // guard reports once, then closes the interface: continuing to read would only consume
  // more of an attack we have already decided to refuse.
  let reportedOverflow = false;
  const guarded = createLineLengthGuard(MAX_REQUEST_LINE_BYTES, () => {
    if (reportedOverflow) return;
    reportedOverflow = true;
    logger.warn("refused an over-long request line", { limitBytes: MAX_REQUEST_LINE_BYTES });
    write({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: `message too large: a request line may not exceed ${MAX_REQUEST_LINE_BYTES} bytes`,
      },
    });
    rl.close();
  });

  const rl = createInterface({ input: guarded });

  // The guard is in the pipeline *between* the client and readline: it only counts bytes if
  // the raw stream actually flows through it. Without this pipe readline would sit on an
  // empty transform and the server would answer nothing at all.
  const upstream = input as NodeJS.ReadableStream & { pipe?: unknown };
  if (typeof (upstream as { pipe?: unknown }).pipe === "function") {
    (upstream as unknown as { pipe: (dest: NodeJS.WritableStream) => unknown }).pipe(guarded);
  }

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: expected a JSON object" } });
      return;
    }
    void handleMessage(msg as Parameters<typeof handleMessage>[0])
      .then((res) => {
        if (res) write(res);
      })
      .catch((err: unknown) => {
        // handleMessage is written not to throw; if it ever does, report it in-band
        // rather than leaving the client waiting for a response that never comes.
        const id = (msg as { id?: number | string | null }).id ?? null;
        logger.error("unhandled error while dispatching request", {}, err);
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: `internal error: ${err instanceof Error ? err.message : String(err)}` },
        });
      });
  });

  rl.on("close", () => logger.debug("stdin closed; server idle"));

  logger.info("sigilkit-mcp listening on stdio", { version: pkg.version });
  // SEC-13: cached audit handles are process-wide state, so they outlive a single
  // connection. The disposer releases them (idempotently, so the existing
  // "call stop() twice" contract still holds) and the process-exit hook is a backstop for
  // an exit path that never calls the disposer at all. Only synchronous work is legal in
  // an `exit` handler, which is why closing is a synchronous `DatabaseSync.close()`.
  // Registered once per serveStdio() call, so it is also REMOVED once per call: a process
  // that serves several connections in turn would otherwise accumulate one "exit" listener
  // per connection (an EventEmitter leak, and a MaxListeners warning past ten).
  const onProcessExit = (): void => closeAllAuditHandles();
  process.on("exit", onProcessExit);
  const stop = (): void => {
    process.off("exit", onProcessExit);
    rl.close();
    closeAllAuditHandles();
  };
  return stop;
}
