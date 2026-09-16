/**
 * Environment-driven configuration for the SigilKit services.
 *
 * All knobs are optional and have working defaults, so `node dist/cli.js …` runs with
 * no `.env` at all. Each reader names the variable it read and explains the expected
 * shape when it rejects a value — the common production failure is a typo'd variable
 * name, and "expected an integer, got \"abc\"" beats a silent fallback.
 *
 * The full list is documented in `.env.example` and `docs/CONFIGURATION.md`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { assertAddress, assertBigInt, assertOneOf, assertPrivateKey, assertUint, assertUrl, ValidationError } from "./validation.js";
import { createLogger, LOG_FORMATS, LOG_LEVELS, type LogFormat, type Logger, type LogLevel } from "./logger.js";

/**
 * Loads `.env` then `.env.local` from `cwd`, once per process.
 *
 * `cp .env.example .env` is the documented first step, so the file has to actually be read —
 * before this existed, a variable set there was silently ignored. Uses Node's built-in loader,
 * which only fills in variables that are not already set, so a real environment variable
 * always wins (the usual convention, and what CI relies on).
 *
 * Returns the names of the files that were loaded. A missing file is not an error; a
 * malformed one is, because silently ignoring a typo'd `.env` is how this class of bug starts.
 */
export function loadDotEnv(cwd: string = process.cwd()): string[] {
  if (dotEnvLoaded) return [];
  dotEnvLoaded = true;
  // `process.loadEnvFile` needs Node >= 20.12; degrade to "no .env support" rather than throw.
  if (typeof process.loadEnvFile !== "function") return [];

  const loaded: string[] = [];
  for (const name of [".env", ".env.local"]) {
    const file = join(cwd, name);
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
      loaded.push(name);
    } catch (err) {
      throw new ValidationError(name, `could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return loaded;
}

let dotEnvLoaded = false;

/** Forgets that `.env` was loaded — test-only escape hatch. */
export function resetDotEnvForTests(): void {
  dotEnvLoaded = false;
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
    dbPath: readEnvString(env, "SIGILKIT_DB_PATH", DEFAULT_DB_PATH) as string,
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
