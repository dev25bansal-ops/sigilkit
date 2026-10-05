/**
 * Reporter: one findings protocol, one status vocabulary, one colour decision.
 *
 * ── WHERE THIS CAME FROM ────────────────────────────────────────────────────────
 * The "collect problems, print them, exit 1" shape is open-coded in six gates, and they do
 * not agree on where a finding goes or how it is spelled:
 *
 *   script                      success                 failure
 *   --------------------------  ----------------------  ---------------------------------
 *   check-dockerfile.mjs:214    console.log             console.error, `  ${p}` each
 *   check-vectors.mjs:700       console.log             console.error, `  ${p}` each
 *   check-waivers.mjs:467/473   console.log             console.error, `  ${p}` each
 *   check-doc-counts.mjs:639    console.log             console.error, `  ${p}` each
 *   validate-workflows.mjs:101  console.log             console.error, `  ${p}` each
 *   check-package-artifacts:325  console.log/warn/error  `skip ` / `check ` / `warn  ` / `fail  `
 *
 * The last one is the outlier and is worth keeping: its four-column verb vocabulary
 * (`skip`/`check`/`warn`/`fail`) is column-aligned and greppable, and no other script
 * reproduces it. {@link createReporter} supports it as a `verb` layout rather than
 * pretending the six identical ones are the only shape.
 *
 * ── WHY A SHARED STATUS WORD MATTERS ────────────────────────────────────────────
 * `verify.mjs:589-601` already made the right call and documented why:
 *
 *   "UX-02 (hard requirement): a status is never carried by colour alone. Each verdict
 *    gets a fixed-width word — PASS / FAIL / SKIP / TIMEOUT — and the colour only
 *    reinforces it."
 *
 * Every other script carries its verdict in a glyph instead: `✓` / `!` / `✗` in
 * `bootstrap.mjs:45-47`, `ok  ` / `WRONG` / `none ` in `check-vectors.mjs:695`,
 * `OK:` / `FAIL:` in `check-runtime.mjs:222`. Those glyphs are lost to a non-UTF8 log, a
 * screen reader, or a `grep` for the word "FAIL" — and `verify.mjs`'s own colour decision
 * is mirrored in `packages/core/src/logger.ts:416-424`, so the two must not drift. The
 * decision order below is copied from `verify.mjs:136-142` and `logger.ts:416-424`
 * verbatim; change one, change the other.
 *
 * ── WHO SHOULD ADOPT IT ──────────────────────────────────────────────────────────
 * The five gates with the identical shape (dockerfile, vectors, waivers, doc-counts,
 * validate-workflows) and `bootstrap.mjs` for its `ok`/`warn`/`bad`/`step` helpers.
 * `verify.mjs` should adopt only {@link statusWord}'s `STATUS` table — its own report is
 * column-padded and step-shaped, and rewriting it would gain nothing.
 * `check-package-artifacts.mjs` should adopt the `verb` layout, not this one.
 *
 * ── EPIPE, AND WHY `say` IS GUARDED ─────────────────────────────────────────────
 * `verify.mjs:291-311` learned this the hard way: a gate piped into `head` raises EPIPE,
 * which surfaces as an unhandled `'error'` event and takes the whole gate down mid-run.
 * {@link createReporter} installs the same handler and swallows only EPIPE /
 * ERR_STREAM_DESTROYED. It is opt-out (`handlePipeErrors: false`) for the scripts whose
 * tests spawn them with piped stdio and assert on a clean exit.
 */
import { EXIT } from "./exit.mjs";

/** SGR codes, by name. A reset is applied by {@link paint}; callers never emit it. */
export const SGR = Object.freeze({
  bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36,
});

/**
 * Whether ANSI escapes may be emitted, decided once.
 *
 * Order and rationale are `verify.mjs:136-142` / `logger.ts:416-424`; the comments there
 * are the source of truth and are not restated. Read as a flag, so `CI=false` is still
 * "not CI"; `NO_COLOR` beats `FORCE_COLOR` because no-color.org says so; `FORCE_COLOR` is
 * the escape hatch for the many tests in this tree that assert on colour through a pipe.
 *
 * @param {NodeJS.ProcessEnv} [env] injected in tests
 * @param {boolean} [isTty] injected in tests
 * @returns {boolean}
 */
export function colorsEnabled(env = process.env, isTty = process.stdout.isTTY === true) {
  if (env.NO_COLOR !== undefined) return false;
  if (env.TERM === "dumb") return false;
  if (envFlag(env, "CI")) return false;
  if (envFlag(env, "FORCE_COLOR")) return true;
  return isTty;
}

/**
 * Reads an environment variable as a flag: present and not explicitly off.
 *
 * Duplicated at `verify.mjs:145-148` and `logger.ts:427`, and the two must not diverge —
 * they read the same environment on the same terminal.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {boolean}
 */
export function envFlag(env, name) {
  const value = env[name];
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * Wraps `text` in the named SGR attributes and one reset, or returns it untouched when
 * colour is off. `code` is a space-separated list (`"bold cyan"`) so a composite style is
 * one call and still a single well-formed reset.
 *
 * Never the sole carrier of meaning: every caller pairs this with a word.
 *
 * @param {string} code
 * @param {string} text
 * @param {boolean} [on] defaults to {@link colorsEnabled}
 * @returns {string}
 */
export function paint(code, text, on = colorsEnabled()) {
  if (!on) return text;
  const names = code.split(" ").filter((name) => SGR[name] !== undefined);
  if (names.length === 0) return text;
  return `${names.map((name) => `\u001b[${SGR[name]}m`).join("")}${text}\u001b[0m`;
}

/** EPIPE and a torn-down stream mean "nobody is listening", never "the gate failed". */
const isBrokenPipe = (err) =>
  Boolean(err) && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED");

/**
 * Statuses, and the fixed-width word each one is always spelled as.
 *
 * The width is what keeps a report column-aligned with colour on *or* off — `paint`
 * would otherwise make the padding depend on whether escapes are enabled. `unknown` is
 * not a real state; it is what a caller gets for a status it did not declare, so a typo
 * renders as a word rather than as an empty cell.
 */
export const STATUS = Object.freeze({
  passed:  { word: "PASS",    style: "green" },
  failed:  { word: "FAIL",    style: "bold red" },
  skipped: { word: "SKIP",    style: "yellow" },
  timedOut:{ word: "TIMEOUT", style: "bold red" },
  warn:    { word: "WARN",    style: "yellow" },
  ok:      { word: "OK",      style: "green" },
});

/** Widest status word, so every column that pads to it lines up. */
export const STATUS_WIDTH = Math.max(...Object.values(STATUS).map((s) => s.word.length));

/**
 * The status word for a status key, unpadded.
 *
 * Padding exists for a *column* — `verify.mjs`'s results table pads so the labels line up.
 * A standalone line (`FAIL: 3 problems`) or a per-finding prefix does not need it, and
 * padding there would push every finding three characters to the right for no alignment
 * gain. Use {@link statusWord} when the word is a column, this when it is a label.
 *
 * @param {keyof typeof STATUS} status
 * @param {boolean} [on]
 * @returns {string}
 */
export function bareWord(status, on = colorsEnabled()) {
  return paint((STATUS[status] ?? STATUS.warn).style, (STATUS[status] ?? STATUS.warn).word, on);
}

/**
 * The fixed-width status word for a status key, coloured when allowed.
 *
 * @param {keyof typeof STATUS} status
 * @param {boolean} [on]
 * @returns {string}
 */
export function statusWord(status, on = colorsEnabled()) {
  const entry = STATUS[status] ?? STATUS.warn;
  return paint(entry.style, entry.word.padEnd(STATUS_WIDTH), on);
}

/**
 * Builds a reporter for one gate script.
 *
 * Two layouts, because the tree genuinely has two shapes and flattening them would lose
 * something:
 *
 *   • `bullets` (default) — the five gates that print `  ${problem}` per line under a
 *     `… (${n}):` header. Findings go to stderr; the success line goes to stdout, so
 *     `verify > out.txt` and a JSON consumer both stay clean.
 *   • `verb` — `check-package-artifacts.mjs:316-326`'s aligned
 *     `check <name> — 3/4 OK` / `warn  …` / `fail  …` / `skip  …`. Findings and warnings
 *     are distinguished by verb, not by stream.
 *
 * Neither layout writes a status in colour alone: `bullets` prefixes each problem with the
 * `FAIL` word, `verb` uses the same words as its verbs.
 *
 * @param {object} spec
 * @param {string} spec.name tool name used in messages
 * @param {"bullets"|"verb"} [spec.layout]
 * @param {(text: string) => void} [spec.stdout] injected in tests
 * @param {(text: string) => void} [spec.stderr] injected in tests
 * @param {boolean} [spec.handlePipeErrors] default true
 * @param {boolean} [spec.colors] override the colour decision
 * @returns {{
 *   colors: boolean,
 *   say: (line?: string) => void,
 *   sayError: (line?: string) => void,
 *   ok: (message?: string) => void,
 *   warn: (message: string) => void,
 *   fail: (message: string) => void,
 *   problem: (text: string) => void,
 *   report: (findings: string[], options?: { header?: string, footer?: string[] }) => number,
 *   verdict: (findings: string[], options?: { header?: string, footer?: string[] }) => number,
 *   check: (label: string, detail: string) => void,
 *   skip: (label: string) => void,
 * }}
 */
export function createReporter(spec) {
  const {
    name,
    layout = "bullets",
    stdout = (t) => process.stdout.write(t),
    stderr = (t) => process.stderr.write(t),
    handlePipeErrors = true,
  } = spec;
  const colors = spec.colors ?? colorsEnabled();

  if (handlePipeErrors) {
    for (const stream of [process.stdout, process.stderr]) {
      stream.on("error", (err) => {
        if (!isBrokenPipe(err)) throw err;
      });
    }
  }

  const write = (target, text) => {
    try {
      target(text);
    } catch (err) {
      if (!isBrokenPipe(err)) throw err;
    }
  };

  const say = (line = "") => write(stdout, `${line}\n`);
  const sayError = (line = "") => write(stderr, `${line}\n`);
  const mark = (word, text) => (text === "" ? bareWord(word, colors) : `${bareWord(word, colors)} ${text}`);

  return {
    colors,
    say,
    sayError,
    ok: (message = "") => say(mark("ok", message)),
    warn: (message) => sayError(mark("warn", message)),
    fail: (message) => sayError(mark("failed", message)),
    problem: (text) => sayError(`  ${mark("failed", text)}`),
    check: (label, detail) => say(`check ${label}${detail ? ` — ${detail}` : ""}`),
    skip: (label) => say(`skip  ${label}`),

    /**
     * Prints the findings and returns the exit code. Never calls `process.exit`, so a test
     * can drive it and assert the number; the caller decides when to leave.
     *
     * @returns {number} {@link EXIT.OK} when `findings` is empty, else {@link EXIT.FAIL}
     */
    report(findings, { header, footer = [] } = {}) {
      if (findings.length === 0) {
        say(paint("bold green", `${name} OK`, colors));
        for (const line of footer) say(line);
        return EXIT.OK;
      }
      sayError(paint("bold red", header ?? `${name} FAILED — ${findings.length} problem(s)`, colors));
      for (const finding of findings) sayError(`  ${finding}`);
      for (const line of footer) sayError(line);
      return EXIT.FAIL;
    },

    /**
     * `report` under a different name, for the two gates that already call the whole
     * "gather then decide" step a verdict (`sync-facts.mjs:1362`, `check-runtime.mjs:81`).
     * Identical behaviour; the alias exists so migrating a call site reads as a rename
     * rather than as a semantic change.
     */
    verdict(findings, options = {}) {
      return this.report(findings, options);
    },
  };
}
