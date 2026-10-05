/**
 * Shared CLI plumbing for the SigilKit command-line tools.
 *
 * Hand-rolled argument parsing is where CLIs quietly rot: a missing value is read as
 * the next flag, `--port abc` becomes `NaN`, `--help` does nothing, and every failure
 * exits 1 with a stack trace. This module gives the three binaries one consistent
 * contract instead:
 *
 *   - `--help` / `-h` and `--version` / `-V` always work and exit 0
 *   - unknown options are rejected, with the closest known option suggested
 *   - a flag that needs a value but has none says so, by name
 *   - validation failures are reported as usage errors (exit 2), runtime failures as 1
 *   - `--flag=value` and `--flag value` are both accepted; repeated flags accumulate
 *
 * `parseArgs` and `helpText` are pure and unit-tested; `runCli` owns the process exit.
 */
import { assertAddress, assertBigInt, assertHash32, assertOneOf, assertUrl, assertUint, ValidationError } from "./validation.js";

/** Exit codes used by every SigilKit CLI. */
export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

/** Raised for anything the user could fix by changing the command line. */
export class CliUsageError extends Error {
  readonly exitCode = EXIT_USAGE;
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/**
 * A failure the operator can act on (missing file, unreachable RPC, unset variable).
 * Exits 1 like any runtime failure, but is printed as a single line — a stack trace
 * would only bury the message.
 */
export class UserError extends Error {
  readonly exitCode = EXIT_RUNTIME;
  /** Optional concrete next step, printed on its own line. */
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "UserError";
    this.hint = hint;
  }
}

/** One option a CLI accepts. `value` (e.g. `"<url>"`) means the flag takes an argument. */
export interface FlagSpec {
  /** Long form, including the dashes, e.g. `"--rpc"`. */
  name: string;
  /** Optional short form, e.g. `"-r"`. */
  alias?: string;
  /** Value placeholder. Presence marks the flag as value-taking. */
  value?: string;
  description: string;
  required?: boolean;
  default?: string;
  /** Allowed values, enforced at parse time. */
  choices?: readonly string[];
}

/** A runnable subcommand (e.g. `backfill`). */
export interface CommandSpec {
  name: string;
  description: string;
}

/** Everything `helpText` needs to render a complete usage page. */
export interface CliSpec {
  /** Binary name as invoked, e.g. `sigilkit-indexer`. */
  name: string;
  version: string;
  summary: string;
  /** Usage lines, without the leading `$`. */
  usage: readonly string[];
  commands?: readonly CommandSpec[];
  flags: readonly FlagSpec[];
  examples?: readonly string[];
  /** Extra paragraphs printed after the examples (env vars, notes). */
  notes?: readonly string[];
}

/** Parsed argument accessor with typed, validating getters. */
export interface ParsedArgs {
  /** Non-flag arguments, in order (command name first, when the CLI has commands). */
  readonly positionals: readonly string[];
  /** True when the flag was supplied (or has a default). */
  has(name: string): boolean;
  /** Last value supplied for the flag, or its default. */
  get(name: string): string | undefined;
  /** Every value supplied for the flag (repeated flags accumulate). */
  all(name: string): string[];
  /** Value or a usage error naming the flag. */
  require(name: string): string;
  int(name: string, opts?: { min?: number; max?: number }): number | undefined;
  bigint(name: string, opts?: { min?: bigint; max?: bigint }): bigint | undefined;
  address(name: string): `0x${string}` | undefined;
  hash32(name: string): `0x${string}` | undefined;
  url(name: string): string | undefined;
  oneOf<T extends string>(name: string, allowed: readonly T[]): T | undefined;
}

/** True for a token that is a flag rather than a value. */
function looksLikeFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-" && !/^-\d/.test(token);
}

/** Levenshtein distance, for "did you mean" suggestions. */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j] as number;
      row[j] = Math.min((row[j] as number) + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[n] as number;
}

function suggest(name: string, flags: readonly FlagSpec[]): string {
  const known = flags.flatMap((f) => (f.alias ? [f.name, f.alias] : [f.name]));
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of known) {
    const d = distance(name, candidate);
    if (d < bestScore) {
      bestScore = d;
      best = candidate;
    }
  }
  return best !== undefined && bestScore <= 3 ? ` (did you mean ${best}?)` : "";
}

/** Parses `argv` (without the node/script prefix) against a flag spec. */
export function parseArgs(argv: readonly string[], flags: readonly FlagSpec[]): ParsedArgs {
  const byName = new Map<string, FlagSpec>();
  for (const f of flags) {
    byName.set(f.name, f);
    if (f.alias) byName.set(f.alias, f);
  }

  const values = new Map<string, string[]>();
  const positionals: string[] = [];

  const push = (canonical: string, value: string): void => {
    const existing = values.get(canonical);
    if (existing) existing.push(value);
    else values.set(canonical, [value]);
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (!looksLikeFlag(token)) {
      positionals.push(token);
      continue;
    }

    let name = token;
    let inline: string | undefined;
    const eq = token.indexOf("=");
    if (eq > 0) {
      name = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }

    const spec = byName.get(name);
    if (!spec) throw new CliUsageError(`unknown option ${name}${suggest(name, flags)}`);

    if (spec.value === undefined) {
      if (inline !== undefined) throw new CliUsageError(`${spec.name} does not take a value`);
      push(spec.name, "true");
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || looksLikeFlag(next)) {
        throw new CliUsageError(`${spec.name} requires a value ${spec.value}`);
      }
      value = next;
      i++;
    }
    if (spec.choices && !spec.choices.includes(value)) {
      throw new CliUsageError(`${spec.name} must be one of ${spec.choices.join(" | ")}, got "${value}"`);
    }
    push(spec.name, value);
  }

  const defaults = new Map<string, string>();
  for (const f of flags) if (f.default !== undefined) defaults.set(f.name, f.default);

  const get = (name: string): string | undefined => {
    const supplied = values.get(name);
    if (supplied && supplied.length > 0) return supplied[supplied.length - 1];
    return defaults.get(name);
  };

  const require_ = (name: string): string => {
    const v = get(name);
    if (v === undefined) throw new CliUsageError(`missing required option ${name}`);
    return v;
  };

  /** Wraps a validation failure as a usage error so it exits 2, not 1. */
  const usage = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ValidationError) throw new CliUsageError(err.message);
      throw err;
    }
  };

  const missing = flags.filter((f) => f.required && get(f.name) === undefined).map((f) => f.name);
  if (missing.length > 0) {
    throw new CliUsageError(`missing required option(s): ${missing.join(", ")}`);
  }

  return {
    positionals,
    has: (name) => get(name) !== undefined,
    get,
    all: (name) => [...(values.get(name) ?? [])],
    require: require_,
    int: (name, opts) => {
      const raw = get(name);
      return raw === undefined ? undefined : usage(() => assertUint(raw, name, opts));
    },
    bigint: (name, opts) => {
      const raw = get(name);
      return raw === undefined ? undefined : usage(() => assertBigInt(raw, name, opts));
    },
    address: (name) => {
      const raw = get(name);
      return raw === undefined ? undefined : usage(() => assertAddress(raw, name));
    },
    hash32: (name) => {
      const raw = get(name);
      return raw === undefined ? undefined : usage(() => assertHash32(raw, name));
    },
    url: (name) => {
      const raw = get(name);
      return raw === undefined ? undefined : usage(() => assertUrl(raw, name));
    },
    oneOf: <T extends string>(name: string, allowed: readonly T[]): T | undefined => {
      const raw = get(name);
      return raw === undefined ? undefined : usage(() => assertOneOf(raw, name, allowed));
    },
  };
}

/** Renders the usage page for a CLI. */
export function helpText(spec: CliSpec): string {
  const lines: string[] = [];
  lines.push(`${spec.name} ${spec.version}`);
  lines.push("");
  lines.push(spec.summary);
  lines.push("");
  lines.push("USAGE");
  for (const u of spec.usage) lines.push(`  ${u}`);

  if (spec.commands && spec.commands.length > 0) {
    lines.push("");
    lines.push("COMMANDS");
    const width = Math.max(...spec.commands.map((c) => c.name.length));
    for (const c of spec.commands) lines.push(`  ${c.name.padEnd(width)}  ${c.description}`);
  }

  if (spec.flags.length > 0) {
    lines.push("");
    lines.push("OPTIONS");
    const rendered = spec.flags.map((f) => {
      const short = f.alias ? `${f.alias}, ` : "    ";
      const value = f.value ? ` ${f.value}` : "";
      // A declared default is part of what a caller reads off `--help`, so render it.
      // It was declared on FlagSpec and applied by `parseArgs`, yet never printed, which
      // made the usage page disagree with the behaviour the flag actually has.
      const description =
        f.default === undefined ? f.description : `${f.description} (default: ${f.default})`;
      return { label: `${short}${f.name}${value}`, description };
    });
    const width = Math.max(...rendered.map((r) => r.label.length));
    for (const r of rendered) lines.push(`  ${r.label.padEnd(width)}  ${r.description}`);
  }

  if (spec.examples && spec.examples.length > 0) {
    lines.push("");
    lines.push("EXAMPLES");
    for (const e of spec.examples) lines.push(`  ${e}`);
  }

  if (spec.notes && spec.notes.length > 0) {
    lines.push("");
    for (const n of spec.notes) lines.push(n);
  }

  return lines.join("\n");
}

/** Outcome of interpreting `argv` against a spec. */
export type CliInvocation =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; args: ParsedArgs; command: string | undefined };

/** Interprets `argv`, handling `--help`/`--version` before any validation. */
export function parseCli(argv: readonly string[], spec: CliSpec): CliInvocation {
  // Help and version win over everything else — including missing required flags.
  for (const token of argv) {
    if (token === "--help" || token === "-h") return { kind: "help" };
    if (token === "--version" || token === "-V") return { kind: "version" };
  }
  const args = parseArgs(argv, spec.flags);
  const command = spec.commands && spec.commands.length > 0 ? args.positionals[0] : undefined;
  if (spec.commands && spec.commands.length > 0) {
    if (command === undefined) {
      throw new CliUsageError(`a command is required — run \`${spec.name} --help\` to list them`);
    }
    if (!spec.commands.some((c) => c.name === command)) {
      const names = spec.commands.map((c) => c.name).join(" | ");
      throw new CliUsageError(`unknown command "${command}" — expected one of: ${names}`);
    }
  }
  return { kind: "run", args, command };
}

/** Injectable process surface, so `runCli` is testable without spawning. */
export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  exit: (code: number) => void;
}

/**
 * The host's stdout, or `undefined` when there is none.
 *
 * Same two-step guard `logger.ts` uses for the same reason: `typeof` protects a BARE
 * identifier, so `typeof process === "undefined"` has to be tested FIRST — evaluating
 * `process.stdout` in a realm with no `process` throws ReferenceError before the logger-
 * style fallback can run. Without this, `runCli` without an injected `io` rejected with
 * `ReferenceError: process is not defined` for `--help` and for a normal run alike.
 */
function hostStdout(): { write: (chunk: string) => unknown } | undefined {
  if (typeof process === "undefined") return undefined;
  return process.stdout;
}

/** As {@link hostStdout}, for stderr. */
function hostStderr(): { write: (chunk: string) => unknown } | undefined {
  if (typeof process === "undefined") return undefined;
  return process.stderr;
}

const defaultIo: CliIo = {
  // The two sinks degrade to a no-op, exactly as `logger.ts`'s default sinks do: a broken
  // stream must not take down the process that was only trying to report something.
  stdout: (line) => hostStdout()?.write(line + "\n"),
  stderr: (line) => hostStderr()?.write(line + "\n"),
  exit: (code) => {
    // Exiting is NOT degradable — a no-op here would let a failing CLI report success to
    // whatever invoked it — so say so loudly instead of silently doing nothing.
    if (typeof process === "undefined") {
      throw new Error("runCli: no `process` global; inject `options.io` to supply exit()");
    }
    process.exit(code);
  },
};

export interface RunCliOptions {
  io?: CliIo;
  /** Maps a thrown error to an exit code. Defaults: usage → 2, anything else → 1. */
  classify?: (err: unknown) => number;
}

/**
 * Runs a CLI end to end: parse, dispatch, report failures, exit with a meaningful code.
 *
 * The `main` callback receives the parsed args and the resolved command; it may return
 * an exit code or nothing (treated as 0).
 */
export async function runCli(
  spec: CliSpec,
  argv: readonly string[],
  main: (args: ParsedArgs, command: string | undefined) => Promise<number | void> | number | void,
  options: RunCliOptions = {},
): Promise<void> {
  const io = options.io ?? defaultIo;
  const classify = options.classify ?? ((err: unknown) => (err instanceof CliUsageError ? EXIT_USAGE : EXIT_RUNTIME));

  let invocation: CliInvocation;
  try {
    invocation = parseCli(argv, spec);
  } catch (err) {
    if (err instanceof CliUsageError) {
      io.stderr(`error: ${err.message}`);
      io.stderr("");
      io.stderr(`run \`${spec.name} --help\` for usage.`);
      io.exit(EXIT_USAGE);
      return;
    }
    throw err;
  }

  if (invocation.kind === "help") {
    io.stdout(helpText(spec));
    io.exit(EXIT_OK);
    return;
  }
  if (invocation.kind === "version") {
    io.stdout(spec.version);
    io.exit(EXIT_OK);
    return;
  }

  try {
    const code = await main(invocation.args, invocation.command);
    io.exit(typeof code === "number" ? code : EXIT_OK);
  } catch (err) {
    const code = classify(err);
    // Usage mistakes and expected failures get one line; only unexpected errors earn a
    // stack trace, because that is the only case where the stack is the useful part.
    const expected = err instanceof CliUsageError || err instanceof UserError;
    if (err instanceof Error) {
      io.stderr(`error: ${err.message}`);
      if (err instanceof UserError && err.hint) io.stderr(`hint: ${err.hint}`);
      if (code === EXIT_RUNTIME && !expected && err.stack) {
        io.stderr(err.stack.split("\n").slice(1).join("\n"));
      }
    } else {
      io.stderr(`error: ${String(err)}`);
    }
    io.exit(code);
  }
}
