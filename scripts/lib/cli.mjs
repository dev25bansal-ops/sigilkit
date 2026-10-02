/**
 * CLI flag parsing and process execution — extracted, not yet migrated.
 *
 * ── WHERE THE FLAG PARSING CAME FROM ────────────────────────────────────────────
 * Six hand-written parsers, in three incompatible dialects:
 *
 *   A. boolean-only, `argv.includes(...)`:
 *        check-doc-counts.mjs:867, 873          `--write` / `--with-ts`
 *        check-package-artifacts.mjs:299, 311  `--json`
 *        check-runtime.mjs:227                  `--json`
 *        check-waivers.mjs:461                  `--strict`
 *        verify.mjs:57-60, 180-185              `--quick --no-forge --list --json` (+ stray rejection)
 *        sync-facts.mjs:1413-1429               known-set, unknown arg throws
 *        benchmark-indexer.mjs:136-169          strict `--key=value` only, range-checked
 *
 *   B. `--key=value` slice:
 *        verify.mjs:184-188              `--only=`
 *        check-waivers.mjs:462-463       `--today=`
 *        sync-facts.mjs:1417-1419        `--root=`
 *
 *   C. `--key value` pair, positional:
 *        assurance-inventory.mjs:321-335 `--root <dir>`
 *        clean.mjs:92-95                 `--root <dir>`
 *
 * The behaviours that genuinely differ and are therefore options, not bugs:
 *
 *   • **unknown-argument policy.** `verify.mjs:181-182` and `sync-facts.mjs:1422` reject an
 *     unrecognised argument; `check-runtime.mjs`, `check-package-artifacts.mjs`,
 *     `check-doc-counts.mjs` and `check-waivers.mjs` silently ignore one. A gate that
 *     silently ignores `--jsno` is a gate whose author believed a flag was on. The default
 *     is to reject, matching the two scripts that documented the choice; a caller that
 *     wants the lenient reading passes `allowUnknown: true`.
 *   • **value syntax.** `verify.mjs` accepts only `=`; `clean.mjs` and
 *     `assurance-inventory.mjs` accept only a space. {@link parseArgs} accepts both, which
 *     is a superset — a migrating script must confirm no existing caller passes a bare
 *     `--root` meaning something else.
 *   • **help.** `--help`/`-h` sets `help` and returns it as a query, never an error.
 *     `assurance-inventory.mjs:346-349`, `benchmark-indexer.mjs:740-743` and
 *     `clean.mjs:357-360` all exit 0 on it.
 *
 * ── WHERE THE PROCESS EXECUTION CAME FROM ───────────────────────────────────────
 * `execFileSync` / `spawnSync` / `spawn` with a hand-rolled capture-and-classify wrapper:
 *
 *   check-doc-counts.mjs:713-723   execFileSync + catch → console.error + process.exit(2)
 *   check-doc-counts.mjs:840-846   execFileSync + JSON.parse, no catch of its own
 *   check-doc-counts.mjs:960-969   execFileSync, status read off the thrown error
 *   assurance-inventory.mjs:253-261 spawnSync → null on error *or* non-zero
 *   benchmark-indexer.mjs:503-507   execFileSync ×2, catch → { commit: null, dirty: null }
 *   bootstrap.mjs:66, 81, 96, 118, 140  spawnSync, five call sites, four shapes
 *   verify.mjs:389, 450-452, 465   spawnSync probe / async spawn with a budget / taskkill
 *
 * The **critical divergence** the shared runner makes explicit:
 *
 *   • `assurance-inventory.mjs:255-258` returns `null` on `result.error` **or** non-zero —
 *     correct for a *best-effort* fact (`git rev-parse` in a repo with no commits is not a
 *     finding).
 *   • `check-doc-counts.mjs:716-723` treats the same failure as fatal and exits 2 — correct
 *     for a *required tool* (`forge test --list` cannot be faked, and a fake count would
 *     make the gate certify drift it never measured).
 *
 * So {@link runSync} exposes both as named modes ({@link Outcome}) rather than one
 * `throwOnError` boolean, and every call site must say which it is. `verify.mjs`'s async
 * `run()` with per-step wall-clock budgets and log teeing is deliberately **not** here: it
 * is an orchestrator, not a helper, and it already carries the deepest documentation in the
 * tree.
 */
import { spawnSync } from "node:child_process";
import { messageOf } from "./exit.mjs";

/**
 * @typedef {object} FlagSpec
 * @property {"boolean"|"string"|"number"} type
 * @property {boolean|string|number} [default]
 * @property {string} [placeholder] value name for the usage line, e.g. `<dir>`
 * @property {(value: number) => number} [coerce] applied to a `number` flag after parsing
 * @property {string[]} [choices] allowed values for a `string` flag
 * @property {string} [describe] one line, shown in the usage block
 */

/** Builds the "this is a usage error, exit 2" rejection. */
function usageError(message) {
  const error = new Error(message);
  error.usageError = true;
  return error;
}

/**
 * True when a thrown value is a flag/usage rejection rather than a real failure.
 *
 * Lets a CLI write one `catch` that returns `EXIT.USAGE` for a bad invocation and
 * `EXIT.FAIL` for everything else, without string-matching the message.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isUsageError(err) {
  return Boolean(err) && err.usageError === true;
}

/**
 * Parses `--flag`, `--key=value` and `--key value` into a typed object.
 *
 * Every rejection is loud and names the offending token: a flag typo that is silently
 * ignored is a check running with less coverage than its author believed, which is the
 * failure mode `verify.mjs:171-178` exists to prevent.
 *
 * @param {string[]} argv usually `process.argv.slice(2)`
 * @param {Record<string, FlagSpec>} spec
 * @param {object} [options]
 * @param {boolean} [options.allowUnknown] ignore unrecognised tokens instead of throwing
 * @returns {Record<string, any>} every declared flag is present, defaulted
 * @throws {Error} with `.usageError === true` for an unknown, malformed or valueless token
 */
export function parseArgs(argv, spec, { allowUnknown = false } = {}) {
  const out = {};
  for (const [name, flag] of Object.entries(spec)) {
    if (flag.default !== undefined) out[name] = flag.default;
    else if (flag.type === "boolean") out[name] = false;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      out.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      if (allowUnknown) continue;
      throw usageError(`unexpected argument ${JSON.stringify(token)}`);
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const flag = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (flag === undefined) {
      if (allowUnknown) continue;
      throw usageError(`unrecognized argument ${JSON.stringify(token)}`);
    }

    if (flag.type === "boolean") {
      if (eq !== -1) throw usageError(`--${name} takes no value`);
      out[name] = true;
      continue;
    }

    let raw;
    if (eq !== -1) {
      raw = token.slice(eq + 1);
    } else {
      raw = argv[i + 1];
      if (raw === undefined || raw.startsWith("--")) {
        throw usageError(
          `--${name} needs a value${flag.placeholder ? ` ${flag.placeholder}` : ""}`,
        );
      }
      i += 1;
    }

    if (flag.type === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw usageError(`--${name} must be a number, got ${JSON.stringify(raw)}`);
      }
      out[name] = flag.coerce ? flag.coerce(value) : value;
    } else {
      if (flag.choices && !flag.choices.includes(raw)) {
        throw usageError(
          `--${name} must be one of ${flag.choices.join(", ")}, got ${JSON.stringify(raw)}`,
        );
      }
      out[name] = raw;
    }
  }
  return out;
}

/**
 * Renders a usage block from a spec — the shape `clean.mjs:345-352` and
 * `assurance-inventory.mjs:298-319` already produce by hand.
 *
 * @param {string[]} lines header lines, already formatted
 * @param {Record<string, FlagSpec>} spec
 * @param {string[]} [extra] trailing notes
 * @returns {string}
 */
export function usage(lines, spec, extra = []) {
  const body = Object.entries(spec).map(([name, flag]) => {
    const value = flag.type === "boolean" ? "" : ` ${flag.placeholder ?? "<value>"}`;
    const suffix = flag.default !== undefined ? ` (default: ${flag.default})` : "";
    return `  --${name}${value}${suffix}${flag.describe ? `  ${flag.describe}` : ""}`;
  });
  return [...lines, ...body, ...extra].join("\n");
}

/**
 * How a non-zero child exit is classified. Named, because the choice matters and a boolean
 * would hide it.
 *
 * @readonly
 * @enum {string}
 */
export const Outcome = Object.freeze({
  /** Non-zero is a fact about the world; the caller records `null` and carries on. */
  TOLERATE: "tolerate",
  /** Non-zero means the tool could not do its job; the caller must fail. */
  REQUIRE: "require",
});

/**
 * Runs a command synchronously and classifies the result.
 *
 * Never throws for a non-zero exit in either mode — a caller that wants an exception reads
 * `.error` and throws itself. This is the single most important property: the existing
 * wrappers disagree about whether a failed child is a finding, and
 * `check-doc-counts.mjs:718-722` versus `assurance-inventory.mjs:255-258` are the two
 * documented examples of *both* answers being correct for different callers.
 *
 * @param {string} file executable, or a path to one. Always an executable: a pre-joined
 *   command string is NOT accepted. A shell re-parses its input, so a command string turns
 *   every argv element into shell *syntax* — `;`, `` ` ``, `$()` and `|` in any of them
 *   execute. This signature has no `shell` option precisely so that form cannot be
 *   requested; callers that need npm on Windows resolve npm's JS entry point and run it with
 *   `node`, which keeps a real argv array end to end (see `resolveNpm` in `verify.mjs`).
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env] merged over `process.env` when given
 * @param {Outcome} [options.outcome] default {@link Outcome.TOLERATE}, because a child
 *   that failed is far more often a *fact to record* than a reason to abort — a probe that
 *   aborts by default is a probe that turns a missing optional tool into a red build. A
 *   caller that genuinely cannot proceed without the tool must say
 *   `outcome: Outcome.REQUIRE` explicitly.
 * @param {number} [options.timeout] milliseconds
 * @param {string} [options.input] written to the child's stdin
 * @returns {{
 *   ok: boolean, code: number|null, signal: string|null,
 *   stdout: string, stderr: string, error: Error|null, text: string|null,
 * }} `text` is the trimmed stdout on success and `null` otherwise, so a caller that only
 *   wants the value does not have to remember to trim it — and cannot accidentally read a
 *   partial buffer as a fact.
 */
export function runSync(file, args, options = {}) {
  const { cwd, env, outcome = Outcome.TOLERATE, timeout, input } = options;
  const command = args.length ? `${file} ${args.join(" ")}` : file;
  let result;
  try {
    result = spawnSync(file, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      encoding: "utf8",
      timeout,
      input,
      windowsHide: true,
    });
  } catch (err) {
    return {
      ok: false, code: null, signal: null, stdout: "", stderr: "",
      error: err instanceof Error ? err : new Error(messageOf(err)), text: null,
    };
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) {
    return { ok: false, code: null, signal: null, stdout, stderr, error: result.error, text: null };
  }
  if (result.status === 0) {
    return { ok: true, code: 0, signal: null, stdout, stderr, error: null, text: stdout.trim() };
  }
  if (outcome === Outcome.TOLERATE) {
    return {
      ok: false, code: result.status, signal: result.signal, stdout, stderr,
      error: null, text: null,
    };
  }
  const error = new Error(`${command} exited ${result.status}${stderr ? `: ${stderr.trim()}` : ""}`);
  error.status = result.status;
  return { ok: false, code: result.status, signal: result.signal, stdout, stderr, error, text: null };
}

/**
 * Runs a command synchronously and returns its **parsed JSON** stdout, or `null` on any
 * failure whatsoever.
 *
 * Covers `forge config --json` at `check-doc-counts.mjs:841-845`, which today has no
 * `try`/`catch` of its own and relies on its caller at lines 899-903 — so the message the
 * user finally sees is written for a *different* failure. Use this where a missing or
 * malformed tool output is simply "no fact available".
 *
 * @param {string} file
 * @param {string[]} args
 * @param {object} [options] as {@link runSync}
 * @returns {any|null}
 */
export function runJsonSync(file, args, options = {}) {
  const result = runSync(file, args, { ...options, outcome: Outcome.TOLERATE });
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}
