/**
 * Environment-driven configuration for the SigilKit services.
 *
 * All knobs are optional and have working defaults, so `node dist/cli.js …` runs with
 * no `.env` at all. Each reader names the variable it read and explains the expected
 * shape when it rejects a value — a typo in a VALUE ("expected an integer, got \"abc\"")
 * beats a silent fallback, and a set-but-invalid value is an error rather than a default.
 *
 * A typo in a variable NAME is NOT detected here, and this module does not claim to detect
 * it: `readEnvString` returns the fallback for any name that is absent, so
 * `SIGILKIT_CHAIN_IDD` reads as unset and the default is used. Nothing rejects an
 * unrecognised `SIGILKIT_*` key; adding that would need a registry of every key the
 * indexer / MCP server / demo agent read, which is not this module's to own. When a
 * configured value appears to have no effect, grep the `SIGILKIT_` prefix first.
 *
 * The full list is documented in `.env.example` and `docs/CONFIGURATION.md`.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Address, Hex } from "viem";
import { assertAddress, assertBigInt, assertOneOf, assertPrivateKey, assertUint, assertUrl, ValidationError } from "./validation.js";
import { createLogger, LOG_FORMATS, LOG_LEVELS, type LogFormat, type Logger, type LogLevel } from "./logger.js";

/**
 * Loads `.env` then `.env.local`, once per process.
 *
 * The search starts at `cwd` and walks UP to the nearest ancestor holding a `.env`, so the
 * documented `cp .env.example .env` (repo root) works even when the process is launched from
 * a workspace directory. This matters because npm runs workspace scripts with
 * `process.cwd()` = the workspace, not the root: `npm run demo`, `npm run mcp` and the
 * indexer CLI would each miss the repo-root `.env` and silently fall back to defaults —
 * verified both ways against the built packages before this walk existed. An explicit
 * `cwd` argument remains authoritative and skips the walk.
 *
 * `cp .env.example .env` is the documented first step, so the file has to actually be read —
 * before this existed, a variable set there was silently ignored.
 *
 * **Effective precedence, highest first — read this before relying on `.env.local`:**
 *
 *   1. a real environment variable (CI, docker, the shell) — always wins;
 *   2. a key defined in `.env`;
 *   3. a key defined ONLY in `.env.local`.
 *
 * `.env.local` is loaded second but CANNOT override `.env`. Node's `process.loadEnvFile`
 * only fills variables that are not already set, and by the time `.env.local` is read every
 * `.env` key is already set. So `.env.local` is a *supplementary* file, not an override file.
 * Giving it real override precedence would mean parsing both files ourselves instead of
 * using the Node loader, which is a different design decision, not a bug fix.
 *
 * Returns the names of the files that were loaded, on the first call AND on every later call
 * (the list is remembered, so a repeat call reports the same thing instead of an empty list
 * that read like "no `.env` was found"). A missing file is not an error; a malformed one is,
 * because silently ignoring a typo'd `.env` is how this class of bug starts.
 *
 * Degrades to "no `.env` support" (an empty list) in any realm without a usable `process` —
 * browser, worker, edge — so it is safe to call unconditionally. It only marks itself loaded
 * once the load has actually happened, so a caller may retry after a parse failure.
 */
export function loadDotEnv(cwd: string | undefined = undefined): string[] {
  // Replay the remembered list rather than a bare `[]`. Returning `[]` here used to be
  // indistinguishable from "there is no .env here", which is exactly the shape a caller
  // cannot act on: the files WERE loaded, and the answer to "did .env get read?" is yes.
  if (dotEnvLoaded) return [...dotEnvFiles];
  // When no cwd was given, resolve it by walking UP from process.cwd() to the nearest
  // ancestor that holds a `.env` or `.env.local`, falling back to process.cwd() itself.
  // This is what makes the repo-root `.env` load under npm workspace scripts.
  const resolvedCwd = cwd ?? findEnvDir(process.cwd());
  // The bare identifier must be tested FIRST. `typeof` only protects a bare identifier —
  // `typeof process.loadEnvFile` is a *member* expression, and in a realm with no `process`
  // it throws ReferenceError before `typeof` can report anything. Written the other way round
  // this guard looked correct and still crashed every non-Node caller. Same two-step form as
  // `textColorsEnabled` in `logger.ts`, which guards `process.env` the same way.
  //
  // `process.loadEnvFile` itself needs Node >= 20.12, so the two conditions are separate: a
  // realm can have a `process` and still lack the loader.
  if (typeof process === "undefined" || typeof process.loadEnvFile !== "function") return [];

  const loaded: string[] = [];
  for (const name of [".env", ".env.local"]) {
    const file = join(resolvedCwd, name);
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
      loaded.push(name);
    } catch (err) {
      throw new ValidationError(name, `could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // `dotEnvFiles` is set LAST, on the success path only, together with `dotEnvLoaded`, and
  // neither is "tidied" back to the top. `dotEnvLoaded` is a promise that the load already
  // happened; setting it before the work makes that promise on a promise. A throw from
  // `loadEnvFile` would then leave it set, and because the flag is checked first, every
  // *later* call would short-circuit and silently skip a .env that was merely malformed —
  // a silent no-op is far harder to notice than the exception that caused it, and the caller
  // could never retry.
  dotEnvFiles = loaded;
  dotEnvLoaded = true;
  return [...loaded];
}

let dotEnvLoaded = false;
/** Names of the files read by the first successful {@link loadDotEnv}; replayed afterwards. */

/**
 * Walks up from `start` to the nearest ancestor (inclusive) holding a `.env` or
 * `.env.local`, returning that directory; returns `start` when none is found.
 *
 * Bounded by depth 16 so a deeply nested temp path cannot turn this into a long walk, and
 * it stops at the filesystem root. The walk makes the repo-root `.env` load from npm
 * workspace cwds without ever loading a DIFFERENT `.env`: the closest ancestor with one
 * wins, matching the documented "in the working directory" mental model as closely as
 * Node's own cwd-relative behaviour, minus the silent-miss.
 */
function findEnvDir(start: string): string {
  let cur = start;
  for (let depth = 0; depth < 16; depth++) {
    if (existsSync(join(cur, ".env")) || existsSync(join(cur, ".env.local"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}
let dotEnvFiles: string[] = [];

/** Forgets that `.env` was loaded — test-only escape hatch. */
export function resetDotEnvForTests(): void {
  dotEnvLoaded = false;
  dotEnvFiles = [];
}

/** Anything that can supply environment values (process.env in production). */
export type EnvSource = Record<string, string | undefined>;

/** Reads a raw string; blank values are treated as unset. */
export function readEnvString(env: EnvSource, name: string, fallback?: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw;
}

/** Reads an integer within bounds, or returns `fallback`. */
export function readEnvInt(env: EnvSource, name: string, opts: { fallback: number; min?: number; max?: number }): number {
  const raw = readEnvString(env, name);
  if (raw === undefined) return opts.fallback;
  return assertUint(raw, name, opts);
}

/** Reads a boolean. Accepts 1/true/yes/on and 0/false/no/off (case-insensitive). */
export function readEnvBool(env: EnvSource, name: string, fallback: boolean): boolean {
  const raw = readEnvString(env, name);
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ValidationError(name, `expected a boolean (1/true/yes/on or 0/false/no/off), got "${raw}"`);
}

/** Reads an HTTP(S)/WS(S) URL, or returns `fallback`. */
export function readEnvUrl(env: EnvSource, name: string, fallback?: string): string | undefined {
  const raw = readEnvString(env, name);
  if (raw === undefined) return fallback;
  return assertUrl(raw, name);
}

/** Reads a 20-byte address, or returns `fallback`. */
export function readEnvAddress(env: EnvSource, name: string, fallback?: Address): Address | undefined {
  const raw = readEnvString(env, name);
  if (raw === undefined) return fallback;
  return assertAddress(raw, name);
}

/** Reads a 32-byte private key, or returns `fallback`. */
export function readEnvPrivateKey(env: EnvSource, name: string, fallback?: Hex): Hex | undefined {
  const raw = readEnvString(env, name);
  if (raw === undefined) return fallback;
  return assertPrivateKey(raw, name);
}

/**
 * Rejects a value that cannot be a well-formed database file path.
 *
 * Returns a short reason, or `null` when the path is acceptable. The VALUE IS NEVER
 * ECHOED — `logger.ts` treats `db`/`dbPath` as absolute-path carriers (SENSITIVE_KEY),
 * and `packages/mcp` `resolveAuditDbPath` likewise withholds every refused path, so an
 * error message is not allowed to become a filesystem oracle.
 *
 * What is refused, and why each one is a real failure rather than a style preference:
 *
 *  - **Control characters** (incl. NUL). A NUL in a path truncates it for any consumer
 *    that hands it to a C API, and SQLite's own error strings quote the path back. This is
 *    the concrete injection vector, and it is cheap to refuse outright.
 *  - **A `..` segment.** This value names the file the indexer WRITES, and it is the
 *    write-side counterpart of the read-side allowlist `packages/mcp` enforces with
 *    `SIGILKIT_AUDIT_DB_ROOT`. Traversal in a configured value is never legitimate here.
 *  - **A UNC prefix (`\\\\`).** Windows UNC paths resolve against the *share*, not the
 *    drive, so containment reasoning that holds for `C:\...` does not transfer.
 *  - **A leading `~`.** Nothing here expands it, so `~/audit.db` silently creates a file
 *    literally named `~` in the cwd. That is a misconfiguration bug, not a path.
 *  - **A trailing separator.** `SIGILKIT_DB_PATH` names a FILE; a value ending in `/` or
 *    `\` is a directory, and SQLite would fail with a much less actionable message.
 *
 * Relative paths are deliberately ACCEPTED (both `DEFAULT_DB_PATH` and the `.env.example`
 * value are relative, and a local `anvil` workflow depends on it) — only the *suspicious*
 * shapes above are refused.
 */
function dbPathProblem(value: string): string | null {
  // eslint-disable-next-line no-control-regex -- the point is to DETECT control characters.
  if (/[\u0000-\u001f\u007f]/.test(value)) return "contains a control character (incl. NUL)";
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) return "contains a `..` path segment";
  if (value.startsWith("\\\\")) return "must not be a UNC (\\\\share) path";
  if (value.startsWith("~")) return "must not start with `~` (no expansion is performed)";
  if (/[\\/]$/.test(value)) return "must name a file, not a directory (trailing separator)";
  return null;
}

/**
 * Reads the audit-database path, or returns `fallback`.
 *
 * Unlike {@link readEnvString}, a present-but-invalid value is an ERROR rather than a
 * silent pass-through. Every other knob in {@link loadServiceConfig} is allowlisted
 * (`assertUint` / `readEnvChoice` / `assertUrl`); this one was the sole raw string, and it
 * is the path the indexer opens for writing.
 */
export function readEnvDbPath(env: EnvSource, name: string, fallback: string): string {
  const raw = readEnvString(env, name);
  if (raw === undefined) return fallback;
  const problem = dbPathProblem(raw);
  if (problem !== null) {
    throw new ValidationError(name, `is not a usable database path — it ${problem} (value withheld)`);
  }
  return raw;
}

/** Reads a decimal amount (wei) as bigint, or returns `fallback`. */
export function readEnvBigInt(env: EnvSource, name: string, fallback: bigint): bigint {
  const raw = readEnvString(env, name);
  if (raw === undefined) return fallback;
  return assertBigInt(raw, name, { min: 0n });
}

/** Reads a required variable, with an actionable message when it is absent. */
export function requireEnv(env: EnvSource, name: string, hint?: string): string {
  const raw = readEnvString(env, name);
  if (raw === undefined) {
    throw new ValidationError(name, `is required but not set${hint ? ` — ${hint}` : ""}`);
  }
  return raw;
}

/**
 * Reads one of a fixed set of values (case-insensitive), or returns `fallback` when the
 * variable is absent. A present-but-unrecognized value is an error, so a typo is reported
 * rather than quietly ignored.
 */
export function readEnvChoice<T extends string>(
  env: EnvSource,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readEnvString(env, name);
  if (raw === undefined) return fallback;
  return assertOneOf(raw.trim().toLowerCase(), name, allowed);
}

/** Resolved configuration shared by the indexer, MCP server and demo agent. */
export interface ServiceConfig {
  /** JSON-RPC endpoint. */
  rpcUrl: string;
  /** Chain id used for signing, indexing and query scoping. */
  chainId: number;
  /** SQLite file for the audit store. */
  dbPath: string;
  /** Blocks to stay behind the head, so reorgs never land in the index. */
  confirmations: number;
  /** Largest block span per `eth_getLogs` call. */
  maxBlockRange: number;
  logLevel: LogLevel;
  logFormat: LogFormat;
}

export const DEFAULT_DB_PATH = "sigilkit-audit.db";
export const ANVIL_CHAIN_ID = 31337;

/**
 * Builds the service configuration from an environment source.
 * Never throws for a missing variable — only for a present-but-invalid one.
 */
export function loadServiceConfig(env: EnvSource = process.env): ServiceConfig {
  return {
    rpcUrl: readEnvUrl(env, "SIGILKIT_RPC_URL", "http://127.0.0.1:8545") as string,
    chainId: readEnvInt(env, "SIGILKIT_CHAIN_ID", { fallback: ANVIL_CHAIN_ID, min: 1 }),
    dbPath: readEnvDbPath(env, "SIGILKIT_DB_PATH", DEFAULT_DB_PATH),
    confirmations: readEnvInt(env, "SIGILKIT_CONFIRMATIONS", { fallback: 12, min: 0 }),
    maxBlockRange: readEnvInt(env, "SIGILKIT_MAX_BLOCK_RANGE", { fallback: 2_000, min: 1 }),
    // Strict, like every other variable: a typo in the log format should be reported, not
    // silently produce the wrong output shape for a log collector.
    logLevel: readEnvChoice(env, "SIGILKIT_LOG_LEVEL", LOG_LEVELS, "info"),
    logFormat: readEnvChoice(env, "SIGILKIT_LOG_FORMAT", LOG_FORMATS, "text"),
  };
}

/** Builds a logger from the resolved config, tagged with a component scope. */
export function loggerFor(config: Pick<ServiceConfig, "logLevel" | "logFormat">, scope: string): Logger {
  return createLogger({ level: config.logLevel, format: config.logFormat, scope });
}

/** Chain id for the indexer, which historically used its own variable name. */
export function indexerChainId(env: EnvSource, fallback: number): number {
  const specific = readEnvString(env, "SIGILKIT_INDEXER_CHAIN_ID");
  if (specific !== undefined) return assertUint(specific, "SIGILKIT_INDEXER_CHAIN_ID", { min: 1 });
  return readEnvInt(env, "SIGILKIT_CHAIN_ID", { fallback, min: 1 });
}
