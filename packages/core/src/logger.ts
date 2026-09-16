/**
 * Minimal leveled logger for the SigilKit services (indexer, MCP, demo agent).
 *
 * Deliberately dependency-free and tiny: the toolkit ships to agent operators who run
 * long-lived processes, so what matters is (a) a level floor they can raise in
 * production, (b) machine-readable output when a log collector is watching, and
 * (c) never throwing because logging failed.
 *
 * Configured from the environment:
 *   SIGILKIT_LOG_LEVEL   debug | info | warn | error | silent   (default: info)
 *   SIGILKIT_LOG_FORMAT  text | json                            (default: text)
 *
 * `text`  → `2026-09-15T05:36:20.123Z  INFO   indexer  message  key=value`
 * `json`  → `{"ts":"…","level":"info","scope":"indexer","msg":"…","key":…}`
 */
import { assertOneOf, ValidationError } from "./validation.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_FORMATS = ["text", "json"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Parses a level string, falling back to `fallback` for undefined/blank input. */
export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  try {
    return assertOneOf(normalized, "SIGILKIT_LOG_LEVEL", LOG_LEVELS);
  } catch (err) {
    if (err instanceof ValidationError) return fallback;
    throw err;
  }
}

/** Parses an output format, falling back to `text`. */
export function parseLogFormat(value: string | undefined, fallback: LogFormat = "text"): LogFormat {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  try {
    return assertOneOf(normalized, "SIGILKIT_LOG_FORMAT", LOG_FORMATS);
  } catch (err) {
    if (err instanceof ValidationError) return fallback;
    throw err;
  }
}

/** Extra structured fields attached to a log line. */
export type LogFields = Record<string, unknown>;

/** A logger bound to a scope (usually the component name). */
export interface Logger {
  readonly level: LogLevel;
  readonly scope: string;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields, err?: unknown): void;
  /** A logger that writes the same stream with a `parent.child` scope. */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  scope?: string;
  /** Sink for non-error lines. Defaults to stdout. */
  out?: (line: string) => void;
  /** Sink for error lines. Defaults to stderr. */
  err?: (line: string) => void;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

function formatText(ts: string, level: LogLevel, scope: string, msg: string, fields?: LogFields): string {
  const levelTag = level.toUpperCase().padEnd(5);
  const scopeTag = scope ? ` ${scope}` : "";
  const extras = fields
    ? Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ` ${k}=${typeof v === "string" ? v : JSON.stringify(serialize(v))}`)
        .join("")
    : "";
  return `${ts}  ${levelTag}${scopeTag}  ${msg}${extras}`;
}

function formatJson(ts: string, level: LogLevel, scope: string, msg: string, fields?: LogFields, err?: unknown): string {
  const payload: Record<string, unknown> = { ts, level, scope, msg };
  if (fields) for (const [k, v] of Object.entries(fields)) payload[k] = serialize(v);
  if (err !== undefined) {
    payload.error = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : serialize(err);
  }
  return JSON.stringify(payload);
}

/**
 * Creates a logger. Output never throws: a broken sink is swallowed rather than
 * taking down the process that was only trying to report something.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const format = options.format ?? "text";
  const scope = options.scope ?? "";
  const out = options.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const errSink = options.err ?? ((line: string) => process.stderr.write(line + "\n"));
  const clock = options.now ?? (() => new Date());

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields, err?: unknown): void => {
    if (RANK[lvl] < RANK[level]) return;
    const ts = clock().toISOString();
    const line = format === "json" ? formatJson(ts, lvl, scope, msg, fields, err) : formatText(ts, lvl, scope, msg, fields);
    try {
      if (lvl === "error") errSink(line);
      else out(line);
    } catch {
      /* logging must never be the reason a process dies */
    }
  };

  return {
    level,
    scope,
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields, err) => emit("error", msg, fields, err),
    child: (childScope) =>
      createLogger({
        level,
        format,
        scope: scope ? `${scope}.${childScope}` : childScope,
        out,
        err: errSink,
        now: clock,
      }),
  };
}

/** A logger that discards everything — useful as a default in library code. */
export function silentLogger(): Logger {
  return createLogger({ level: "silent" });
}
