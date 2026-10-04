#!/usr/bin/env node
/**
 * The full local gate, in one command: workflow lint, doc-count drift, typecheck, build,
 * contract tests, TypeScript tests.
 *
 *   npm run verify              # everything
 *   npm run verify -- --quick   # skip the Foundry suites (fast inner loop)
 *   npm run verify -- --no-forge
 *   npm run verify -- --only=typecheck   # one step, for a tight inner loop
 *   npm run verify -- --list              # every step, its selector, its budget
 *   npm run verify -- --json              # machine-readable; the document is stdout
 *
 * Each step is independent: a failure is recorded and reported, the remaining steps still
 * run, and the exit code is 1 if anything failed. That way one run tells you everything
 * that is broken instead of only the first thing.
 *
 * SK-15: a full run must mean every required check executed. A missing forge binary
 * fails the gate (it is not a successful skip); only an explicit --quick or --no-forge
 * run states its reduced scope. The guard/helper regression suites and the package
 * artifact check are gate steps, so they cannot rot outside the gate.
 *
 * DEBT-04: "one run tells you everything" used to degenerate into "one run hangs" — no
 * step had a timeout, and `stdio:"inherit"` left the gate holding no record to replay.
 * Every step now runs under a wall-clock budget and tees its output to
 * `outputs/verify/<timestamp>-<slug>.log`. A hung step is killed and recorded as a
 * TIMEOUT failure (fail-closed, like every other gate outcome), so a hang degrades into
 * "this one hung, here is its log" instead of into an indefinite stall.
 *
 * UX-02: colour is a layer, not a hard-coded prefix. `c.green` used to be written into
 * every line unconditionally, so a CI log or a `verify > out.txt` pipe collected raw ESC
 * sequences. Colour is now decided once, in {@link colorsEnabled}, and the raw sequences
 * are only ever emitted by `paint()`. Status is *always* spelled in words (PASS / FAIL /
 * SKIP / TIMEOUT) — colour only reinforces a label that already stands on its own, so the
 * output survives a colourless terminal, a redirect, and a screen reader. The same decision
 * is mirrored in `packages/core/src/logger.ts`; the two must agree, or a `verify` report and
 * a logger line would disagree about colour for the same terminal.
 *
 * UX-09: a failure has to be actionable. `--only=<label>` already existed and was never
 * advertised, so a red run only ever said *that* something broke. Now every failed row is
 * followed by a copy-pasteable `npm run verify -- --only=<label>`, the report always names
 * the CI gates this script cannot run, and `--list` / `--json` make the gate scriptable.
 *
 * `--json` owns stdout unconditionally, in every mode. A run emits `{ok, results:[…]}`;
 * `--list --json` emits `{ok, list:true, steps:[{key,label,why,budgetMs}]}`. The human
 * table is never written to stdout under `--json` — it goes to stderr — because a flag whose
 * stdout cannot be parsed is not a machine-readable flag, and the caller that combined the
 * two flags is exactly the one parsing the result.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const NO_FORGE = QUICK || args.includes("--no-forge");
const LIST = args.includes("--list");
const JSON_OUT = args.includes("--json");
const USAGE = "usage: verify [--quick] [--no-forge] [--only=<label>] [--list] [--json]";

/**
 * Every gate step: its display label, a one-line reason it exists, and a shell-safe short
 * key. The single source of truth for `--only` matching, `--only` validation, `--list`,
 * and the results report — declared before any step runs so a selector can be checked
 * against the real label set up front.
 *
 * UX-09: this was a bare `key → label` map. `--list` has to say what a step is *for*, not
 * just name it, and the short key is what makes the failure hint copy-pasteable: a display
 * label like "contract tests (unit + fuzz)" would need quoting in every shell, whereas
 * `--only=contracts` is paste-ready. The key is also now a valid selector, which it was not
 * before (`--only=contracts` matched nothing, because the key is not a substring of the
 * label — see {@link matchesOnly}).
 */
const LABELS = {
  lint: { label: "workflow lint", why: "actionlint over .github/workflows" },
  packaging: { label: "container packaging", why: "static Dockerfile invariants (no docker build)" },
  helpers: { label: "helper suites", why: "regression tests for the guard scripts themselves" },
  docs: { label: "doc counts", why: "documented counts still match the code" },
  docslocation: { label: "doc location", why: "no .md stranded outside docs/, where it would be unindexed and unshipped" },
  // P0-WIRE: the next three guards each had a full test suite (6/11/31 cases) and each was
  // referenced in this file ONLY inside the `helpers` --test list. Nothing ever executed them.
  // That is the inverse of a silent-pass gate: the tests were green, the guards were absent,
  // and `npm run verify` reported a clean run of a guard it never invoked. A gate that is not
  // run is not a gate, so each is now a step of its own rather than a name in a test list.
  //   helperregistry — the meta-guard. Without it, the `helpers` list above drifts again the
  //     next time a suite is added, which is how all three of these went missing in the first
  //     place: the list is hand-maintained and a hand-kept list cannot notice a later addition.
  //   trackedrefs    — every scripts/… path a committed workflow invokes must itself be
  //     committed. On a clean clone an uncommitted guard fails at the pipeline's FIRST job,
  //     hiding every later signal behind it.
  //   reparse        — a host capability probe (can this machine create AND traverse a link).
  //     It is a statement about the filesystem, not about the repo. On a Linux runner it is
  //     structurally always green, so it is a portability signal here, NOT a dependency gate;
  //     its own header says so explicitly and that wording is preserved in the step name.
  helperregistry: { label: "helper suite registry", why: "every *.test.mjs on disk is actually run by this gate" },
  trackedrefs: { label: "tracked script refs", why: "every scripts/… path a workflow invokes is committed" },
  reparse: { label: "host link capability", why: "this host can create and traverse a reparse point" },
  // P1-WIRE: the second register in docs/CI-WAIVERS.md — the "Item (not a CI job)" table, whose
  // rows promise "this Foundry test is red ON PURPOSE". `check-waivers.mjs` deliberately skips
  // that table (a failing Solidity test is not a `continue-on-error` job, so a row there would
  // read as a stale row and redden CI for no reason), which left it a human convention with no
  // teeth: a row survived its own removal criterion and went on claiming a red test that had
  // been rewritten green. This step is the machine half of THAT table.
  //
  // It is expected to be RED right now, and that is the correct outcome rather than a bug to
  // paper over: the SEC-10 row is stale, so a gate that reports it is the gate working. Do not
  // relax the check to get a green run — the red is the deliverable (see the P1 handoff).
  testwaivers: { label: "intentional test-failure waivers", why: "every registered intentional failure is still red" },
  build: { label: "workspace build", why: "workspace dist/*.d.ts are generated" },
  typecheck: { label: "workspace typecheck", why: "tsc over the workspaces" },
  artifacts: { label: "package artifacts", why: "entry points and dist layout resolve" },
  contracts: { label: "contract tests (unit + fuzz)", why: "forge test; invariant and fork suites excluded" },
  tests: { label: "TypeScript tests", why: "the workspace test suites" },
};
/** Display labels, in execution order. */
const STEPS = Object.values(LABELS).map((step) => step.label);
/** Short selector keys, in execution order. */
const STEP_KEYS = Object.keys(LABELS);

/**
 * The display label for a step key. Every call site names the step by key (`labelOf("lint")`)
 * rather than repeating the label string, so {@link LABELS} stays the only place a label is
 * written and a rename cannot leave one call site showing the old text.
 */
function labelOf(key) {
  const step = LABELS[key];
  if (step === undefined) throw new Error(`verify: unknown step key "${key}"`);
  return step.label;
}

/**
 * `unitExclude` from scripts/foundry-scope.json, or `null` when it cannot be read.
 *
 * That file's own `$comment` names itself the single source of truth for which forge suites the
 * PR gate excludes, and the pattern the `contracts` step passes to forge is a restatement of
 * its `unitExclude` field. The restatement has to stay a literal, because that is the shape
 * `sync-facts.mjs`'s SCOPE_CONSUMERS entry for this file reads — but sync-facts runs neither in
 * CI nor under `npm run verify` (it is listed in CI_ONLY_GATES above). So until this reader
 * existed, nothing in this gate compared the two: editing `unitExclude` changed what CI's
 * contract jobs ran while `npm run verify` kept running the old set, printed PASS, and nothing
 * anywhere noticed. This is the reader that closes that.
 *
 * A value it cannot produce is `null` and never a default. Defaulting here would re-open the
 * same hole with a guess inside it.
 */
function foundryUnitExclude() {
  try {
    const scope = JSON.parse(readFileSync(join(ROOT, "scripts", "foundry-scope.json"), "utf8"));
    const pattern = scope?.unitExclude;
    return typeof pattern === "string" && pattern !== "" ? pattern : null;
  } catch {
    return null;
  }
}

let ONLY;
/** Reverse index so a display label ("contract tests (unit + fuzz)") finds its step key. */
const KEY_BY_LABEL = new Map(Object.entries(LABELS).map(([key, step]) => [step.label.toLowerCase(), key]));

// ── colour (UX-02) ────────────────────────────────────────────────────────────
/**
 * Whether ANSI escapes may be emitted at all, decided once for the whole run.
 *
 * The hard-coded `c.green` prefixes that this replaces were written into every line
 * unconditionally, so a CI job log or a `verify > out.txt` redirect collected raw ESC
 * bytes — a non-rendering character that turns a failure report into noise.
 *
 * Off when any of these holds; each earns its place:
 *
 *   • `NO_COLOR` present at *any* value — https://no-color.org defines exactly that, and
 *     it is checked first so it also wins over `FORCE_COLOR`.
 *   • `TERM=dumb` — a terminal too weak for escapes.
 *   • `CI` set — GitHub Actions and friends render job logs with their own escape
 *     handling, and an ESC byte that their viewer drops is worse than no colour at all.
 *     This matters *even when the runner is a pseudo-terminal*, which is why `isTTY` alone
 *     is not sufficient. Read as a flag, so a local `CI=false` is still "not CI".
 *   • not a TTY — the pipe/redirect case: `verify | head`, or a captured stdout.
 *
 * `FORCE_COLOR=1` is the escape hatch, for the cases above are too blunt — chiefly this
 * suite's own tests, which run the gate with piped stdio and still need to assert that
 * colour is emitted when it should be. It does not beat `NO_COLOR`, whose spec says a
 * user-set `NO_COLOR` must disable colour unconditionally.
 *
 * The same decision is mirrored in `packages/core/src/logger.ts` for the text formatter.
 * The two must agree: they read the same environment on the same terminal, and a report
 * that colours its PASS lines while a logger line beside it does not would be a bug in
 * one of them. Change one, change the other.
 */
function colorsEnabled() {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === "dumb") return false;
  if (envFlag("CI")) return false;
  if (envFlag("FORCE_COLOR")) return true;
  return process.stdout.isTTY === true;
}

/** Reads an environment variable as a flag: present and not explicitly off. */
function envFlag(name) {
  const value = process.env[name];
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

const COLORS_ON = colorsEnabled();

/** SGR codes, by name. `reset` is applied by {@link paint}; callers never emit it. */
const SGR = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36 };

/**
 * Wraps `text` in the named SGR attributes, and in a reset — or returns it untouched when
 * colour is off. `code` is a space-separated list (`"bold cyan"`) so a composite style is
 * one call and still a single, well-formed reset.
 *
 * Never the sole carrier of meaning: every caller pairs this with a word, so switching
 * colour off loses emphasis, never information.
 */
function paint(code, text) {
  if (!COLORS_ON) return text;
  const names = code.split(" ").filter((name) => SGR[name] !== undefined);
  if (names.length === 0) return text;
  const open = names.map((name) => `\u001b[${SGR[name]}m`).join("");
  return `${open}${text}\u001b[0m`;
}

// ── flag validation ───────────────────────────────────────────────────────────
// Reject a bad invocation before any step runs, so `--only=<typo>` can never silently
// run zero steps and exit 0, and `--only=` can never fall back to running everything.
function abort(message) {
  process.stderr.write(`${paint("bold red", `verify: ${message}`)}\n`);
  process.stderr.write(`${paint("dim", USAGE)}\n`);
  process.exit(2);
}

const KNOWN_FLAGS = new Set(["--quick", "--no-forge", "--list", "--json"]);
const strayArgs = args.filter((a) => !KNOWN_FLAGS.has(a) && !a.startsWith("--only="));
if (strayArgs.length > 0) abort(`unrecognized argument(s): ${strayArgs.join(", ")}`);

const onlyFlags = args.filter((a) => a.startsWith("--only="));
if (onlyFlags.length > 1) abort("--only may be given at most once");

if (onlyFlags.length === 1) {
  ONLY = onlyFlags[0].slice("--only=".length);
  // `--list` is exempt: someone who mistyped a selector is asking "what are the valid
  // values?", and the list is the answer. Aborting them into an error instead would make the
  // one flag that fixes the problem unreachable in exactly the situation it is needed. The
  // selector is still validated on the next run without --list.
  if (!LIST) {
    if (ONLY.trim() === "") {
      abort(`--only needs a non-empty selector; run --list for the ${STEPS.length} steps`);
    }
    if (!selectsAnyStep(ONLY)) {
      abort(`--only=${ONLY} matches no step; run --list for the ${STEPS.length} steps`);
    }
  }
}

/** A selector matches a display label as a substring, or a short key exactly. */
function selectsAnyStep(selector) {
  const needle = selector.trim().toLowerCase();
  return STEP_KEYS.includes(needle) || STEPS.some((label) => label.toLowerCase().includes(needle));
}

/** True when no selector was given, or when `label` matches the selector. */
function matchesOnly(label) {
  if (ONLY === undefined) return true;
  const needle = ONLY.trim().toLowerCase();
  if (KEY_BY_LABEL.get(label.toLowerCase()) === needle) return true;
  return label.toLowerCase().includes(needle);
}

/** The paste-ready command that re-runs exactly one step (UX-09). */
function reproCommand(label) {
  return `npm run verify -- --only=${KEY_BY_LABEL.get(label.toLowerCase())}`;
}

// ── step budgets (DEBT-04) ────────────────────────────────────────────────────
// Wall-clock ceilings per step. Short pure-Node guards get a minute; the workspace
// build and typecheck get ten; the Foundry fuzz suite and the TypeScript suites get the
// long budgets, because a legitimately slow run must not be killed and then blamed for
// hanging. Every default sits far above the step's normal duration — the budget exists
// to turn an unbounded stall into a reported failure, not to police performance.
//
// PARALLEL-TABLE HAZARD (5th hand-maintained table in this file — see the note at LABELS).
// This table drifted from LABELS once already: `docslocation`, `helperregistry`, `trackedrefs`
// and `reparse` were added as steps and no budget was added with them, so they silently ran
// on FALLBACK_TIMEOUT_MS. Nothing failed, because the fallback is generous — the drift was
// invisible until someone diffed the two key sets.
//
// The invariant that actually matters: every key in LABELS has an entry HERE. A missing entry
// is not a crash, it is a silent downgrade, which is why the assertion below exists rather
// than a comment asking people to remember. Kept as a module-level check so a future step
// added without a budget fails the gate in development instead of in production.
const DEFAULT_STEP_TIMEOUTS = {
  lint: 60_000,
  packaging: 60_000,
  helpers: 300_000,
  docs: 60_000,
  // Pure-Node guards that shell out to `forge test --match-test` per registered row, or walk
  // the working tree. Minutes, not seconds — but still far above normal, per the rule above.
  docslocation: 60_000,
  helperregistry: 60_000,
  trackedrefs: 60_000,
  // The probe itself is fast; the budget covers a cold filesystem walk on a loaded runner.
  reparse: 60_000,
  // Re-runs one Foundry test per registered intentional-failure row, so its cost scales with
  // the number of rows in the second CI-WAIVERS table. 300s covers a table an order of
  // magnitude larger than today's while still bounding a wedged forge.
  testwaivers: 300_000,
  build: 600_000,
  typecheck: 600_000,
  artifacts: 120_000,
  contracts: 3_600_000,
  tests: 1_800_000,
};
/** Used only if a step is added without a budget entry, so no new step is ever unbounded. */
const FALLBACK_TIMEOUT_MS = 600_000;

// A step with no budget is a silent downgrade rather than a failure, so it is worth failing
// loudly on. `LABELS` is the declaration and this table is the annotation; a key present in one
// and absent from the other is a defect in one of them, and neither can see the other.
for (const key of STEP_KEYS) {
  if (!Object.hasOwn(DEFAULT_STEP_TIMEOUTS, key)) {
    throw new Error(
      `verify: step "${key}" (${LABELS[key].label}) has no entry in DEFAULT_STEP_TIMEOUTS — ` +
        "every step needs a budget, otherwise it silently falls back to " +
        `${FALLBACK_TIMEOUT_MS}ms. Add one next to the step's normal duration.`,
    );
  }
}

/**
 * PERF-1: how much work may run at once, in cost units (see {@link STEP_COST}).
 *
 * Four, not "all of them": the `tests` step runs vitest, which starts its own worker pool, so
 * outer concurrency multiplies against inner concurrency. A developer on a 28-core box would
 * not notice the difference; a 2-core CI runner would get *slower* than the serial gate it
 * replaced. Four keeps the win on a big machine without making the small one worse.
 * `VERIFY_CONCURRENCY` overrides it; 1 restores fully-serial EXECUTION, but not the original
 * step ORDER — the wave order below differs from `LABELS` order, and has since PERF-1 landed.
 */
const DEFAULT_CONCURRENCY = 4;
/** Grace period between SIGTERM and SIGKILL on POSIX. */
const KILL_GRACE_MS = 5_000;
/** How many trailing log lines the failure report replays. */
const TAIL_LINES = 30;
const IS_WIN = process.platform === "win32";
const LOG_DIR = join(ROOT, "outputs", "verify");

/**
 * Applies VERIFY_STEP_TIMEOUT='<label>=<ms>,...' over the defaults. Accepts either the
 * short step key (`lint`) or the display label (`workflow lint`, spaces included).
 *
 * A malformed entry aborts the run instead of being ignored: a typo that silently fell
 * back to the default would restore exactly the unbounded-hang behaviour this exists to
 * remove, while appearing to have honoured the override.
 */
function resolveStepTimeouts() {
  const table = { ...DEFAULT_STEP_TIMEOUTS };
  const raw = process.env.VERIFY_STEP_TIMEOUT;
  if (raw === undefined || raw.trim() === "") return table;
  for (const entry of raw.split(",")) {
    const piece = entry.trim();
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    const name = (eq === -1 ? piece : piece.slice(0, eq)).trim().toLowerCase();
    const value = eq === -1 ? "" : piece.slice(eq + 1).trim();
    const key = Object.hasOwn(table, name) ? name : KEY_BY_LABEL.get(name);
    if (key === undefined) {
      abort(`VERIFY_STEP_TIMEOUT names unknown step "${name}"; known: ${Object.keys(table).join(", ")}`);
    }
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) {
      abort(`VERIFY_STEP_TIMEOUT value for "${key}" must be a positive number of milliseconds, got "${value}"`);
    }
    table[key] = Math.floor(ms);
  }
  return table;
}

const TIMEOUTS = resolveStepTimeouts();

/** Millisecond budget for a display label, honouring VERIFY_STEP_TIMEOUT. */
function budgetFor(label) {
  return TIMEOUTS[KEY_BY_LABEL.get(label.toLowerCase())] ?? FALLBACK_TIMEOUT_MS;
}

// ── output plumbing (DEBT-04) ─────────────────────────────────────────────────
// A gate piped into `head`/`Select-Object -First` closes the downstream pipe early.
// Writing to it then raises EPIPE, which surfaces as an unhandled 'error' event and
// would take the whole gate down mid-run. The stream handlers and the guarded writers
// below treat EPIPE as "nobody is listening any more", never as a gate failure.
const isBrokenPipe = (err) => Boolean(err) && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED");
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (!isBrokenPipe(err)) throw err;
  });
}
function writeOut(text) {
  try {
    process.stdout.write(text);
  } catch (err) {
    if (!isBrokenPipe(err)) throw err;
  }
}
/** Same guard, for the human report stream. */
function writeErr(text) {
  try {
    process.stderr.write(text);
  } catch (err) {
    if (!isBrokenPipe(err)) throw err;
  }
}
const say = (line = "") => writeOut(`${line}\n`);

/**
 * The checks that exist but never run under `npm run verify` — they are wired into
 * `.github/workflows/` instead. Declared before its first use at `--list`, so this constant has
 * to live above the listing block rather than beside the report footer that also reads it.
 *
 * The list is the answer to "my local run was green and CI went red, what did I miss?", so it
 * names the *script* rather than the concept: `check-waivers` tells a reader which command to
 * run, where "waiver registry" would not. The CI-only tail is a documentation claim, and a
 * documentation claim that is never tested rots the first time a gate is added to CI without
 * being added here.
 */
const CI_ONLY_GATES = "slither, gitleaks, halmos, fork, deep-fuzz, " +
  "check-waivers, check-vectors, sync-facts, generate-vectors";

/**
 * The human report's channel. With `--json`, stdout is reserved *exclusively* for the
 * document: the human report and the step-output tee both move to stderr. Anything else makes
 * `JSON.parse(stdout)` impossible, and a `--json` flag that cannot be parsed is not a
 * machine-readable flag. A caller that wants both reads stdout for the document and stderr for
 * the transcript, which is the conventional split and needs no extra flag.
 */
const sayHuman = (line = "") => (JSON_OUT ? writeErr(line + "\n") : say(line));

// ── --list ────────────────────────────────────────────────────────────────────
/**
 * Prints every step with its selector, purpose and budget, then exits without running
 * anything. Answers the question `--only` alone cannot: "which step do I actually want?".
 * A query, not a run — so it exits 0 whatever the gate's state, and it ignores any other
 * flag, so `--list --only=typo` prints the list rather than aborting on the typo (a
 * "what can I even select?" question should never need a correct guess to answer).
 */
if (LIST) {
  const keyWidth = Math.max(...STEP_KEYS.map((k) => k.length));
  const labelWidth = Math.max(...STEPS.map((label) => label.length));
  sayHuman(paint("bold", `SigilKit verification steps (${STEP_KEYS.length})`));
  for (const [key, step] of Object.entries(LABELS)) {
    sayHuman(
      `  ${paint("cyan", key.padEnd(keyWidth))}  ${step.label.padEnd(labelWidth)}  ` +
        `${paint("dim", `${(budgetFor(step.label) / 1000).toFixed(0)}s`)}  ${paint("dim", step.why)}`,
    );
  }
  sayHuman();
  sayHuman(`Re-run one step:  ${paint("cyan", "npm run verify -- --only=<key>")}`);
  sayHuman(paint("dim", `Other flags: --quick, --no-forge, --json.  Timeout override: VERIFY_STEP_TIMEOUT="lint=60000"`));
  sayHuman(paint("dim", `A green local run is not a green CI run: the CI-only checks (${CI_ONLY_GATES}) never run here. Only CI runs them.`));
  // `--json` means stdout is a document, not prose. A query with no results still has a
  // document, so honour the contract here too: emitting the table on stdout and exiting —
  // as this used to — handed a caller that combined the flags an unparseable stream, which
  // is the one thing `--json` promises never to do. `steps` is the listing, in the same
  // {key,label,budgetMs} shape a `results` consumer already reads.
  if (JSON_OUT) {
    say(JSON.stringify({ ok: true, list: true, steps: STEP_KEYS.map((key) => ({
      key,
      label: LABELS[key].label,
      why: LABELS[key].why,
      budgetMs: budgetFor(LABELS[key].label),
    })) }, null, 2));
  }
  // A query, not a run: nothing was executed, so the gate's own verdict does not apply.
  process.exit(0);
}

/** `outputs/verify/<timestamp>-<key>-<slug>.log` — millisecond precision keeps steps distinct. */
function logPathFor(label, startedAt) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  // PERF-1: the step key is part of the name, not just the slug. Under concurrency two steps
  // can start inside the same millisecond, and the slug alone is not unique (`docs` vs
  // `docslocation` differ, but a renamed label would collide) — so an append-to-same-file race
  // would silently interleave two steps' output into one log.
  const key = KEY_BY_LABEL.get(label.toLowerCase()) ?? "step";
  return join(LOG_DIR, `${stamp}-${key}-${slug}.log`);
}

/** Trailing `count` lines of a step log, for the failure report. */
function tailLines(path, count) {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.length > count ? lines.slice(-count) : lines;
  } catch (err) {
    return [`<could not read ${path}: ${err.message}>`];
  }
}

/**
 * PERF-1: how many runs' worth of step logs to keep under `outputs/verify/`.
 *
 * Nothing in the repository ever removed these. `clean.mjs` — the one script that deletes
 * build output — deliberately does NOT target `outputs/`: it registers the path in
 * DANGEROUS_PATHS and refuses (or prompts) on it, on the grounds that `outputs/` is scratch
 * that may hold credential-bearing logs. That is a defensible reason not to have `clean.mjs`
 * sweep it, and it is exactly why the retention has to live HERE instead. Delegating it to
 * `clean.mjs` would have been the obvious-looking fix and a no-op forever.
 *
 * Measured: 212 files had accumulated before this policy existed, growing by up to one file
 * per step per run. Kept as RUNS rather than as a file count because a run's logs are only
 * useful as a set — the report replays a failing step's log minutes or hours after the run,
 * and a file-count cap can slice a single run in half.
 */
const LOG_RETENTION_RUNS = 20;

/** Leading ISO-ish stamp of a log filename, as a sortable number; NaN when unrecognised. */
function logRunStamp(fileName) {
  const match = /^(\d{4}-\d{2}-\d{2}T[\d-]+Z)-/.exec(fileName);
  if (match === null) return Number.NaN;
  // The stamp is filesystem-safe (':' and '.' replaced by '-'), so compare on the string
  // form: it is zero-padded and fixed-width, so lexicographic order IS chronological order.
  // Restoring the separators would be tidier but buys nothing here and risks a parse bug.
  return match[1];
}

/**
 * Deletes all but the most recent {@link LOG_RETENTION_RUNS} runs of step logs.
 *
 * Only files whose name carries a parseable timestamp are ever considered, so an unrelated
 * file dropped in `outputs/verify/` by something else is never a deletion candidate. Failures
 * are swallowed: a log that cannot be removed costs disk, not correctness, and the run that
 * owns it still has its own report. Best-effort by design — this runs before any step, so a
 * throw here would take down a gate that had not yet reported anything.
 */
function pruneOldLogs() {
  let entries;
  try {
    entries = readdirSync(LOG_DIR);
  } catch {
    return; // No log directory yet: nothing has ever run, so there is nothing to prune.
  }
  const runs = new Map();
  for (const fileName of entries) {
    if (!fileName.endsWith(".log")) continue;
    const stamp = logRunStamp(fileName);
    if (stamp === null) continue;
    const bucket = runs.get(stamp);
    if (bucket === undefined) runs.set(stamp, [fileName]);
    else bucket.push(fileName);
  }
  // Descending, so index 0 is the newest run and the cut keeps the tail end.
  const ordered = [...runs.keys()].sort().reverse();
  for (const stamp of ordered.slice(LOG_RETENTION_RUNS)) {
    for (const fileName of runs.get(stamp)) {
      try {
        unlinkSync(join(LOG_DIR, fileName));
      } catch {
        /* a log we cannot delete costs disk, not correctness */
      }
    }
  }
}

function resolveForge() {
  // Test hook for verify.test.mjs: forces the missing-tool path so the fail-closed
  // behaviour is checkable on machines that have forge. It can only make the gate
  // stricter (a failed contracts check), never let a failing gate pass.
  if (process.env.VERIFY_FORCE_NO_FORGE === "1") return null;
  if (process.env.FORGE_BIN && existsSync(process.env.FORGE_BIN)) return process.env.FORGE_BIN;
  const local = join(homedir(), ".foundry", "bin", IS_WIN ? "forge.exe" : "forge");
  if (existsSync(local)) return local;
  const probe = spawnSync("forge", ["--version"], { encoding: "utf8", timeout: 30_000 });
  return probe.status === 0 ? "forge" : null;
}

const FORGE = resolveForge();

/**
 * The npm invocation, as [command, prefix-args] with NO shell.
 *
 * SEC-11: this used to be `spawn([npmCmd, ...argv].join(" "), { shell: true })` — a command
 * string handed to a shell. A shell re-parses its input, so every argv element became shell
 * *syntax* rather than an opaque argument, and `;`/`` ` ``/`$()`/`|` in any element were
 * executed. The argv here is partly derived from repository files (workspace names come from
 * `package.json`, which a pull request can edit), so that is a live injection primitive: a PR
 * adding a workspace or a build script could execute arbitrary commands as the gate.
 *
 * The shell cannot simply be dropped, because on Windows `npm` is `npm.cmd`, and Node refuses
 * to spawn a `.cmd` with an args array and no shell (EINVAL) — the CVE-2024-27980 mitigation.
 * So instead of going through a shell, this resolves npm's *JavaScript entry point* and runs
 * it with the current `node`. The result is a real argv array end to end: no shell, no
 * re-parsing, and no reliance on `PATHEXT` resolution.
 *
 * Resolution order, first existing wins:
 *   1. `npm_execpath` — set by npm when the gate is itself started via an npm script, and
 *      points at the exact npm that launched us.
 *   2. `<dirname(node)>/node_modules/npm/bin/npm-cli.js` — the standard Windows install
 *      layout, and the POSIX equivalent under a versioned node prefix.
 * If neither exists we fall back to the bare `npm` name with no shell; that still refuses to
 * run a `.cmd` on Windows, but it fails loudly at spawn time instead of silently invoking a
 * shell.
 */
function resolveNpm() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && candidate !== "");
  for (const candidate of candidates) {
    if (existsSync(candidate)) return [process.execPath, [candidate]];
  }
  return [IS_WIN ? "npm.cmd" : "npm", []];
}

/** `[command, prefixArgs]` for the resolved npm; spread as `NPM[0], [...NPM[1], …]`. */
const NPM = resolveNpm();

/**
 * Runs one gate step and records the outcome.
 *
 * No step runs through a shell (SEC-11). A shell re-parses its input, so argv elements would
 * be shell *syntax*, not opaque arguments — and the `|` inside forge's
 * `--no-match-contract '.*Invariant|.*Fork'` would become a pipe, while an absolute `C:/…`
 * executable path would be mangled. npm is invoked through its resolved JavaScript entry
 * point ({@link resolveNpm}) precisely so that the Windows `.cmd` shim never forces a shell
 * back in; node and forge are launched directly.
 *
 * Uses async `spawn` rather than `spawnSync` for two reasons that both matter here:
 * `spawnSync` buffers a step's whole output and returns it only at exit, so nothing can
 * be forwarded live and nothing reaches the log until the step has already finished; and
 * its `timeout` kills only the direct child, with no way to reach a process tree. Chunks
 * are teed to the console and the log as they arrive, and the budget is enforced here so
 * the kill can be platform-correct.
 */
function run(label, cmd, argv, opts = {}) {
  if (!matchesOnly(label)) return Promise.resolve(null);
  const budget = budgetFor(label);
  const started = Date.now();
  const budgetSeconds = `${(budget / 1000).toFixed(0)}s`;
  sayHuman();
  sayHuman(paint("bold cyan", `▶ ${label}`));
  sayHuman(paint("dim", `$ ${cmd} ${argv.join(" ")}   (timeout ${budgetSeconds})`));

  let logPath = logPathFor(label, started);
  let logFd = null;
  const toLog = (chunk) => {
    if (logFd === null) return;
    try {
      writeSync(logFd, chunk);
    } catch (err) {
      if (isBrokenPipe(err)) return;
      // A real write failure retires the log, but it has to be CLOSED, not merely forgotten:
      // nulling the handle without closing it leaks the descriptor for the rest of the run.
      // `finish` checks `logFd !== null`, so it cannot be relied on to do this later.
      try {
        closeSync(logFd);
      } catch {
        /* already unusable; the handle is being discarded either way */
      }
      logFd = null;
    }
  };
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    logFd = openSync(logPath, "a");
    toLog(`=== verify step: ${label}\n=== $ ${cmd} ${argv.join(" ")}\n`);
    toLog(`=== budget: ${budget}ms   started: ${new Date(started).toISOString()}\n\n`);
  } catch (err) {
    // A log we cannot open costs replay, not correctness: the step still runs and still
    // reports. Degrade loudly rather than failing a check that may well be green.
    logPath = null;
    if (!warnedAboutLogs) {
      warnedAboutLogs = true;
      sayHuman(`${paint("yellow", "!")} could not open step logs under ${LOG_DIR}: ${err.message}\n`);
    }
  }

  return new Promise((resolve) => {
    const env = opts.env ? { ...process.env, ...opts.env } : process.env;
    // SEC-11: no step runs through a shell. `shell: true` would re-parse argv as shell syntax
    // and turn any `;`/`` ` ``/`$()` in an argument into executed commands; npm is invoked via
    // its resolved JS entry point instead (see {@link resolveNpm}), so an args array is always
    // enough. Every step therefore uses one code path, and there is no shell flag left to
    // mis-set at a call site.
    // `detached: true` puts the child in its OWN process group on POSIX, so the timeout can
    // signal the whole tree with `process.kill(-pid, …)`.
    //
    // WITHOUT IT the POSIX path signalled only the direct child. `child.kill()` does not
    // reach grandchildren, and the steps that hang are exactly the ones that spawn trees:
    // `npm run build` is npm → tsc → esbuild, `npm run test` is vitest → its workers. A
    // timed-out step therefore left that whole tree running after the gate reported failure
    // — the precise "kills only the direct child, with no way to reach a process tree" hazard
    // the file header documents. It surfaced as an intermittently red `workflow lint` job:
    // the test asserts the grandchild is gone, and whether the OS had reaped it yet is a race.
    // Windows is unaffected — it has no process-group signal and uses `taskkill /T /F`.
    const child = spawn(cmd, argv, {
      cwd: ROOT,
      env,
      stdio: ["inherit", "pipe", "pipe"],
      detached: !IS_WIN,
    });

    let timedOut = false;
    let timer = null;
    let killTimer = null;
    let spawnFallback = null;
    let settled = false;

    // Windows has no process-group signal: Node rejects any non-signal `killSignal`
    // (ERR_UNKNOWN_SIGNAL), and a bare kill() would leave grandchildren running — for
    // `npm run build` that is the whole tsc/esbuild tree. `taskkill /T /F` reaps the tree.
    const terminate = () => {
      if (IS_WIN) {
        if (child.pid === undefined) return;
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore", windowsHide: true, timeout: 15_000,
        });
        return;
      }
      // Signal the whole process group, not just the direct child — see the `detached`
      // note at the spawn. The negative pid is the group id; if the group is already gone
      // ESRCH is thrown and the kill is a no-op, which is the correct outcome here.
      const signalGroup = (signal) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // Group already reaped, or the platform refused. Fall back to the direct child so
          // a single-shot failure still stops the step rather than leaving it running.
          try { child.kill(signal); } catch { /* already gone */ }
        }
      };
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    };

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (spawnFallback) clearTimeout(spawnFallback);
      if (logFd !== null) {
        try {
          writeSync(logFd, `\n=== exit: code=${code} signal=${signal} timedOut=${timedOut} elapsed=${Date.now() - started}ms\n`);
          closeSync(logFd);
        } catch {
          /* the recorded result is what the gate acts on */
        }
        logFd = null;
      }
      const ms = Date.now() - started;
      const passed = !timedOut && code === 0;
      if (timedOut) {
        sayHuman(`${paint("bold red", "✗ TIMEOUT")} ${label} exceeded ${budgetSeconds} — process tree killed, recorded as a failure\n`);
        toLog(`\n=== TIMEOUT: budget of ${budget}ms exhausted; process tree terminated\n`);
      }
      results.push({ label, passed, ms, skipped: false, timedOut, budget, log: logPath });
      resolve(passed);
    };

    // With `--json`, stdout belongs to the document alone, so a step's own stdout is teed to
    // stderr instead (see {@link sayHuman}). A child writing to stdout must not corrupt the
    // document the caller is about to parse.
    const teeTargets = JSON_OUT
      ? [[child.stdout, process.stderr], [child.stderr, process.stderr]]
      : [[child.stdout, process.stdout], [child.stderr, process.stderr]];
    for (const [stream, target] of teeTargets) {
      if (stream === null) continue;
      stream.on("data", (chunk) => {
        toLog(chunk);
        try {
          target.write(chunk);
        } catch (err) {
          if (!isBrokenPipe(err)) throw err;
        }
      });
    }
    child.on("error", (err) => {
      sayHuman(`${paint("bold red", `✗ ${label} could not start:`)} ${err.message}\n`);
      toLog(`\n=== spawn error: ${err.message}\n`);
      // 'close' normally follows a spawn failure and carries the verdict. The fallback
      // exists so a pathological child cannot strand the gate — the very hang this
      // budget was added to prevent. It is tracked in `spawnFallback` so `finish` can cancel
      // it: a pending timer holds the event loop open for its full 2s after the step is
      // already accounted for, and under concurrency that is paid once per failed spawn.
      spawnFallback = setTimeout(() => finish(null, null), 2_000);
    });
    child.on("close", (code, signal) => finish(code, signal));

    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, budget);
  });
}

const results = [];
let warnedAboutLogs = false;

// Before any step opens its log, not after: a step that fails still has to be able to write
// its own log, and pruning afterwards would race the report's `tailLines` replay.
pruneOldLogs();

function skip(label, why) {
  if (!matchesOnly(label)) return;
  results.push({ label, passed: true, ms: 0, skipped: true, why, timedOut: false, log: null });
}

sayHuman(paint("bold", "SigilKit verification") + (QUICK ? paint("dim", "  (quick: Foundry suites skipped)") : ""));

/**
 * PERF-1 — run a wave of steps concurrently, capped.
 *
 * The gate was fully serial: its step sum equalled its wall clock to within 140ms, so a run
 * spent all of its time waiting on one step at a time even though 87% of that time sat in two
 * independent steps. Each wave below is a set of steps with no data dependency on one another,
 * so they overlap. The cap exists because "all of them at once" is not free: the `tests` step
 * runs vitest, which starts its own workers, so outer concurrency multiplies against inner
 * concurrency and a 2-core CI runner gets *slower*, not faster.
 *
 * `VERIFY_CONCURRENCY` overrides the cap. It is read once PER WAVE, not once per run: the two
 * waves each call `concurrencyLimit()`. That is safe and intentional — `process.env` is
 * immutable for the life of the process and the waves run sequentially at top level, so both
 * reads necessarily return the same number. The earlier comment here claimed a single read
 * that the code never performed; a comment asserting a guarantee the code does not implement
 * is worse than no comment, because a reader checking the behaviour finds the opposite.
 *
 * A malformed value ABORTS (see below), so a typo cannot quietly give one wave a different
 * cap from another.
 */
function concurrencyLimit() {
  const raw = process.env.VERIFY_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONCURRENCY;
  const n = Number(raw);
  // A malformed or non-positive cap ABORTS, for the same reason a malformed
  // VERIFY_STEP_TIMEOUT does (see resolveStepTimeouts): a typo that silently fell back to the
  // default is a knob that appears to be honoured while it is not. The two knobs are read the
  // same way and must be validated the same way — "the gate's job is to report on the
  // repository" is an argument against a tuning knob changing the gate's *work*, not against
  // refusing to start under a setting nobody meant to set.
  if (!Number.isFinite(n) || n < 1) {
    abort(`VERIFY_CONCURRENCY must be a positive integer, got "${raw}"`);
  }
  return Math.floor(n);
}

/**
 * PERF-1: what one unit of the concurrency cap is actually worth.
 *
 * A flat "number of steps in flight" is the wrong unit when the members of a wave differ in
 * cost by an order of magnitude. `tests` runs vitest, which starts its own worker pool sized
 * from the host's core count, so admitting it alongside three other steps multiplies outer
 * concurrency against inner concurrency — the exact scenario the cap exists to prevent, and
 * one a count-based pool cannot express. The earlier comment here acknowledged that risk in
 * prose while the code ignored it, which is a comment claiming a guarantee the code does not
 * make. The weight makes it structural: `tests` occupies three slots, so the cap is a budget
 * in units of work rather than a headcount.
 *
 * Measured cost, not vibes: `tests` was 87% of gate wall clock in the serial baseline the
 * PERF-1 work started from, and it is the only step that forks a worker pool.
 */
const STEP_COST = { tests: 3 };
/** Cost units for a step key; 1 is the common case, so only the exceptions are listed. */
function costOf(key) {
  return STEP_COST[key] ?? 1;
}

/**
 * Runs `tasks` ({@link step} entries) with at most `limit` cost units in flight.
 *
 * Work is claimed in DECLARATION order, not completion order. That is a deliberate change from
 * the previous `next++` pool, which handed the next slot to whichever worker freed up first:
 * under a cost cap a cheap step that finishes early admits more work, so start order would
 * become a function of step durations rather than of the source. Declaration order keeps a
 * wave's behaviour a property of the source, which is the only version that is reviewable.
 * `results` is indexed by position, so the report is unaffected either way.
 */
async function runWave(tasks, limit) {
  // Call sites pass `[key, thunk]` ARRAY entries. The queue filter previously tested
  // `typeof task.thunk === "function"`, and an array has no `.thunk` — so every entry
  // matched the "not a task" branch and the entire wave ran ZERO steps while `results`
  // stayed empty and the report printed "All N check(s) passed" for the survivors only.
  // That is the exact shape of a silent gate: everything about the source (SK-15, the
  // P0-WIRE wiring notes, the CI-parity comments) says the wave steps are mandatory, and
  // nothing at runtime disagreed. Recovered 2026-10-02 when a full run was audited step
  // by step. Normalise once, up front, so both shapes work and neither can silently vanish.
  //
  // A malformed entry is a defect, not an absence. Filtering it out would leave this gate
  // reporting "All N check(s) passed" for N fewer steps than it declares — the very class of
  // false green this block exists to prevent, with only the trigger shape changed. Refusing
  // the whole run means a typo in a wave list can never look like a pass.
  const queue = tasks
    .filter((task) => task !== null && task !== undefined)
    .map((task) => (Array.isArray(task) ? { key: task[0], thunk: task[1] } : task));
  for (const task of queue) {
    if (typeof task?.thunk !== "function" || typeof task?.key !== "string") {
      throw new Error(
        `runWave: every entry must be [key, thunk] or { key, thunk }; got ${JSON.stringify(task)}. ` +
          `A malformed entry is refused rather than dropped — dropping it would silently reduce the ` +
          `number of checks this gate reports, which is the false green this block exists to prevent.`,
      );
    }
  }
  const results = new Array(queue.length);
  let next = 0;
  let inFlight = 0;
  /** Resolvers for every worker parked because the next task does not fit the budget. */
  const parked = [];
  /** Wakes every parked worker. Budget returned, or the queue drained — both unblock all. */
  const broadcast = () => {
    while (parked.length > 0) parked.shift()();
  };
  const tooTight = (cost) => inFlight > 0 && inFlight + cost > limit;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      // Re-check after every wake: a wake means "budget may have changed", not "go now".
      // The gap between the `tooTight` test and the push onto `parked` contains no `await`,
      // and JS is single-threaded, so no budget change can slip in between them — that is what
      // makes parking safe without a lock.
      while (next < queue.length && tooTight(costOf(queue[next].key))) {
        await new Promise((resolve) => parked.push(resolve));
      }
      if (next >= queue.length) {
        // Queue drained: a worker parked on it would otherwise wait for a wake that is never
        // coming, and the wave would never settle.
        broadcast();
        return;
      }
      const index = next++;
      const admitted = queue[index];
      inFlight += costOf(admitted.key);
      try {
        results[index] = await admitted.thunk();
      } finally {
        inFlight -= costOf(admitted.key);
        broadcast();
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// Wave 1 — no step depends on another's output. Two deliberate exclusions:
//   `docs` shells out to forge three times and `contracts` runs forge again, so those two are
//   sequenced below rather than risk two forge processes rebuilding the same output directory.
//   `tests` reads dist/ (see wave 2), so it runs after `build`, not beside it.
await runWave([
  ["lint", () => run(labelOf("lint"), process.execPath, ["scripts/validate-workflows.mjs"])],
  ["packaging", () => run(labelOf("packaging"), process.execPath, ["scripts/check-dockerfile.mjs"])],
  // SK-15: the guard/helper regression suites are part of the gate, mirroring CI's
  // workflow-lint job, so a broken helper cannot hide outside CI.
  ["helpers", () => run(labelOf("helpers"), process.execPath, [
  "--test",
  "scripts/check-dockerfile.test.mjs",
  "scripts/check-doc-counts.test.mjs",
  "scripts/verify.test.mjs",
  "scripts/check-package-artifacts.test.mjs",
  "scripts/check-runtime.test.mjs",
  "scripts/assurance-inventory.test.mjs",
  "scripts/benchmark-indexer.test.mjs",
  // DEBT-06: these two guard scripts were gate steps in two places (the `lint` step here and
  // CI's workflow-lint job) with no test of their own, so a regression in either could land
  // unnoticed. Their suites are now part of the gate, alongside the others.
  "scripts/validate-workflows.test.mjs",
  "scripts/bootstrap.test.mjs",
  // CI-PARITY: `check-waivers` and `check-vectors` are gate steps in ci.yml (:59 and :190)
  // with their own suites (:57 and :192), but neither the gate script nor its test ran here.
  // A regression in either was therefore invisible to `npm run verify` while still able to
  // redden CI — the local gate looked greener than the thing it was standing in for.
  "scripts/check-waivers.test.mjs",
  "scripts/check-vectors.test.mjs",
  // The doc-location guard went through a version that allow-listed packages/ and
  // contracts/ wholesale and therefore printed OK while counting two real strays.
  // Its suite drives a throwaway git index, so it can prove the guard goes red
  // without creating a file in the working tree.
  "scripts/check-doc-location.test.mjs",
  "scripts/clean.test.mjs",
  "scripts/sync-facts.test.mjs",
  // The process-contract suite: exit codes, stream discipline and cross-gate isolation, which
  // no unit suite can see because they only exist at the process boundary. It was previously
  // executed by nothing at all — not here, not in ci.yml — so a broken gate binary could sit
  // unnoticed. ~22s against a 300s budget; the one gate it cannot isolate (check-doc-counts,
  // which shells out to forge) substitutes a stand-in, so it needs no forge on the runner.
  "scripts/e2e-gates.test.mjs",
  // P1: the seven suites below existed on disk and ran nowhere — not here, not in ci.yml.
  // 129 passing tests, invisible, because this list was maintained by hand and a hand-kept
  // list does not notice a file added after it was written. The five under scripts/lib/ were
  // the worst case: a top-level-only reading of `scripts/` cannot see them at all.
  // `scripts/check-helper-suites.mjs` (below) is what stops this list drifting again.
  "scripts/lib/cli.test.mjs",
  "scripts/lib/exit.test.mjs",
  "scripts/lib/fs-json.test.mjs",
  "scripts/lib/paths.test.mjs",
  "scripts/lib/reporter.test.mjs",
  // The guard that asserts every workflow-invoked `scripts/…` path is committed, plus the
  // reparse-point guard and the drift guard added with it.
  "scripts/check-tracked-refs.test.mjs",
  "scripts/check-reparse-points.test.mjs",
  "scripts/check-helper-suites.test.mjs",
  // The intentional-test-failure waiver guard's own suite. Registered because the guard above
  // exists to catch exactly this: a suite on disk that no gate runs is a guard nobody is
  // holding. Reporting an unregistered suite is only credible while the guard itself is honest,
  // and it found this one the moment it could read the list properly.
  "scripts/check-test-waivers.test.mjs",
  ])],
  // Every audit/research document must be findable in docs/STATUS.md's layer tables. A
  // deliverable written into a package or scripts/ directory is in no layer table AND in
  // no npm tarball (files[] is ["dist","README.md"]) — invisible twice over. Three such
  // files existed on 2026-09-26. Separate from `docs` because it needs no forge and
  // answers a different question: not "are the numbers right" but "can this be found".
  // It is safe to overlap with `docs`: both only *read* docs/STATUS.md, and read-read is
  // not contention (its subprocess is `git ls-files`, not forge).
  ["docslocation", () => run(labelOf("docslocation"), process.execPath, ["scripts/check-doc-location.mjs"])],
  // P0-WIRE: see the LABELS note. These three were suite-only — present in the `helpers`
  // --test list above, executed by nothing. Each is now a real step, so a regression in any
  // of them reddens `npm run verify` instead of sitting inert behind a green test run.
  // Ordering note: helperregistry reads verify.mjs's own source, so it must run against the
  // file as committed — it is unaffected by the run order here, but it is the reason a
  // hand-kept list is a liability rather than a convenience.
  ["helperregistry", () => run(labelOf("helperregistry"), process.execPath, ["scripts/check-helper-suites.mjs"])],
  ["trackedrefs", () => run(labelOf("trackedrefs"), process.execPath, ["scripts/check-tracked-refs.mjs"])],
  // Exit 2 here means "no verdict" (bad flags / host too broken to create a directory), not
  // a pass, and `run()` treats any non-zero as a failed step — which is the correct reading.
  ["reparse", () => run(labelOf("reparse"), process.execPath, ["scripts/check-reparse-points.mjs"])],
  // P1-WIRE: the intentional-failure register's machine half. Overlaps nothing here — it
  // spawns its own `forge test` per row, exactly like `contracts`, and touches no dist/ output,
  // so it is independent of every other step in this wave.
  //
  // Ordering caveat worth stating: this step reads docs/CI-WAIVERS.md and runs Foundry. It
  // therefore has the same "cannot run without forge" property as `contracts`, and — unlike
  // `contracts` — it exits 2 rather than 1 when forge is missing. A non-zero exit is a failed
  // step either way, so `run()` records it as FAIL. That is the right reading (an unverifiable
  // waiver is not a satisfied one) but it means a machine with no forge cannot get a green
  // `npm run verify` — which is already true of `contracts`, so this adds no new constraint.
  ["testwaivers", () => run(labelOf("testwaivers"), process.execPath, ["scripts/check-test-waivers.mjs"])],
  // Consumers resolve @sigilkit/core through dist/*.d.ts, absent on a fresh checkout.
  // Match CI: generate workspace outputs before checking their dependent types.
  ["build", () => run(labelOf("build"), NPM[0], [...NPM[1], "run", "build", "--workspaces", "--if-present"])],
], concurrencyLimit());

// `docs` runs alone: it shells out to forge three times (`test --list` plus `config --json`
// twice), and `contracts` runs forge again. Overlapping the two forge steps risks two
// processes rebuilding the same output directory at once — so they are sequenced instead.
// The cost is negligible: `docs` is ~5s against a ~90s gate.
await run(labelOf("docs"), process.execPath, ["scripts/check-doc-counts.mjs"], FORGE ? { env: { FORGE_BIN: FORGE } } : {});

// Wave 2 — every step here depends on `build` having produced dist/, and none depends on
// another. `tests` is here for the same reason typecheck and artifacts are, and the reason is
// a real data dependency, not a preference:
//
//   packages/mcp/test/mcp.test.ts    spawns `dist/cli.js` and times out with
//                                    "is dist/ built and are workspace deps resolvable?"
//   packages/core/test/lease-fs.test.ts imports `../dist/lease-fs.js` in a child process.
//
// `tests` used to sit in wave 1, CONCURRENT WITH `build`, and `runWave` hands out work by
// `next++` as workers free up — i.e. in completion order, not declaration order. On a fresh
// checkout (no dist/) the suite could therefore read a half-written or missing dist/ and fail.
// Only 2 of 52 test files touch dist/, so the failure is INTERMITTENT, which is strictly worse
// than a consistent one: a deterministic break gets found and fixed, an intermittent one gets
// filed as "flaky, probably the environment" and lives forever. Intermittent defects are a
// reason to raise priority, not to lower it.
await runWave([
  ["typecheck", () => run(labelOf("typecheck"), NPM[0], [...NPM[1], "run", "lint", "--workspaces", "--if-present"])],
  // SK-15/V66-1: static entry-point guard, after build so dist/ exists (fresh checkouts
  // have none). Mirrors the ts-sdk ordering in ci.yml. Static working-tree check only —
  // NOT a clean-install smoke test.
  ["artifacts", () => run(labelOf("artifacts"), process.execPath, ["scripts/check-package-artifacts.mjs"])],
  // The heaviest step, overlapped against typecheck and artifacts. It runs vitest, which
  // starts its own workers — hence STEP_COST below rather than unbounded fan-out.
  ["tests", () => run(labelOf("tests"), NPM[0], [...NPM[1], "test", "--workspaces", "--if-present"])],
], concurrencyLimit());

if (NO_FORGE) {
  skip(labelOf("contracts"), QUICK ? "--quick" : "--no-forge");
} else if (!FORGE) {
  // SK-15: an unavailable required tool makes the gate incomplete — a failed check,
  // not a successful skip. Only --quick/--no-forge declare a reduced scope up front.
  if (matchesOnly(labelOf("contracts"))) {
    results.push({ label: labelOf("contracts"), passed: false, ms: 0, skipped: false, timedOut: false, log: null });
    sayHuman(`\n${paint("red", "!")} forge not found — contract tests did not run; the gate is incomplete. Install: curl -L https://foundry.paradigm.xyz | bash && foundryup`);
  }
// A selector that names some other step must leave contracts' preconditions alone too:
// without this gate a `--only=doc counts` run could FAIL because THIS machine's scope
// owner disagree, i.e. a targeted run executing a different step's checks. The
// `!FORGE` branch above has the same shape for the same reason.
} else if (matchesOnly(labelOf("contracts"))) {
  // The literal below restates foundry-scope.json's `unitExclude`, and sync-facts.mjs asserts
  // that restatement — but sync-facts runs nowhere in this gate, so until now that assertion had
  // no effect here. Compare the two before running anything, and refuse on a disagreement:
  // running a suite set that contradicts its own owner is not a weaker contract test, it is a
  // different one reported as PASS. Neither branch below runs what the other would not.
  const scopeOwner = foundryUnitExclude();
  const contractsFailed = { label: labelOf("contracts"), passed: false, ms: 0, skipped: false, timedOut: false, log: null };
  if (scopeOwner === null) {
    results.push(contractsFailed);
    sayHuman(`\n${paint("red", "!")} scripts/foundry-scope.json has no usable "unitExclude" — the gate will not guess which contract suites to run.`);
  } else if (scopeOwner !== ".*Invariant|.*Fork") {
    results.push(contractsFailed);
    sayHuman(`\n${paint("red", "!")} scripts/foundry-scope.json unitExclude is ${JSON.stringify(scopeOwner)} and no longer agrees with the suites this step runs; refusing rather than testing a set its owner does not describe.`);
  } else {
    await run(labelOf("contracts"), FORGE, ["test", "--no-match-contract", ".*Invariant|.*Fork"]);
  }
}

// PERF-1: `results` is pushed in completion order, which under concurrency is not declaration
// order. The report and the `--json` document must both read in the order `LABELS` declares,
// or the table (and any consumer diffing two runs) reshuffles between runs. Sorting here —
// once, at the boundary — is what keeps the report deterministic.
results.sort((a, b) => STEP_KEYS.indexOf(KEY_BY_LABEL.get(a.label.toLowerCase()))
  - STEP_KEYS.indexOf(KEY_BY_LABEL.get(b.label.toLowerCase())));

// ── report ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.passed);
const ran = results.filter((r) => !r.skipped);

// The count below must state what this gate CLAIMED to run, not merely what survived to
// produce a result. `results` is populated only by steps that ran, so deriving the total
// from it can never detect a step that was skipped, dropped or never dispatched — the
// false green that this file once shipped for its whole wave list. On an unqualified run
// (no --only / --quick / --no-forge) the executed set must therefore equal the declared
// set exactly, and a shortfall fails the gate rather than shrinking the summary.
if (ONLY === undefined && !QUICK && !NO_FORGE) {
  // `LABELS` is keyed by STEP KEYS ("trackedrefs") and its `label` is the display string
  // ("tracked script refs") that lands in `results`. Compare like with like: build the
  // expected set from the labels, not from the keys — KEY_BY_LABEL is the reverse map and
  // indexing it with a key returns undefined, which would make every step look missing and
  // refuse a healthy run.
  const executed = new Set(results.map((r) => String(r.label).toLowerCase()));
  const missing = STEP_KEYS.filter((key) => !executed.has(LABELS[key].label.toLowerCase()));
  if (missing.length > 0) {
    const verdict = { gate: "verify", verdict: "incomplete", missing };
    sayHuman(`\n${paint("red", "!")} ${missing.length} declared step(s) produced no result: ${missing.join(", ")}`);
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    process.exit(2);
  }
}

// UX-02 (hard requirement): a status is never carried by colour alone. Each verdict gets a
// fixed-width word — PASS / FAIL / SKIP / TIMEOUT — and the colour only reinforces it. The
// width is fixed so the report stays column-aligned with colour on *or* off; `paint` would
// otherwise make the padding depend on whether escapes are enabled.
const STATUS = {
  passed: { word: "PASS", style: "green" },
  failed: { word: "FAIL", style: "bold red" },
  timedOut: { word: "TIMEOUT", style: "bold red" },
  skipped: { word: "SKIP", style: "yellow" },
};
const STATUS_WIDTH = Math.max(...Object.values(STATUS).map((s) => s.word.length));

/** `PASS` / `FAIL` / `SKIP` / `TIMEOUT`, coloured when allowed and always spelled out. */
function statusWord(r) {
  const s = r.skipped ? STATUS.skipped : r.timedOut ? STATUS.timedOut : r.passed ? STATUS.passed : STATUS.failed;
  return paint(s.style, s.word.padEnd(STATUS_WIDTH));
}

// UX-09: the tail of the report is the part people actually read. It must (a) say what failed,
// (b) say how to re-run exactly that, and (c) say what this run did *not* cover. A local green
// is not a CI green, and the cheapest possible way to stop that being a surprise is to print it.
/**
 * The "this is not CI" footer. Two lines rather than one because a single long line wraps in
 * an 80-column terminal and loses the shape of the message; the second line is the actionable
 * half (only CI runs them). Dim so it reads as a footnote, not as a failure — the gate's own
 * verdict is above it and must not be diluted.
 */
function sayUncoveredCiGates() {
  sayHuman(paint("dim", `not covered by npm run verify (CI-only): ${CI_ONLY_GATES}`));
  sayHuman(paint("dim", "a green local run is not a green CI run — only CI runs those checks."));
}

sayHuman();
sayHuman(paint("bold", "Results"));
const width = results.length === 0 ? 0 : Math.max(...results.map((r) => r.label.length));
for (const r of results) {
  const time = r.skipped ? paint("dim", "—") : paint("dim", `${(r.ms / 1000).toFixed(1)}s`);
  const why = r.skipped && r.why ? ` ${paint("dim", `(${r.why})`)}` : "";
  sayHuman(`  ${statusWord(r)}  ${r.label.padEnd(width)}  ${time}${why}`);
}

if (failed.length > 0) {
  sayHuman();
  sayHuman(`${paint("bold red", `${failed.length} of ${ran.length} check(s) failed:`)} ${failed.map((f) => f.label).join(", ")}`);
  // UX-09: the copy-pasteable re-run. `--only` existed but was never advertised, so a red run
  // only said *that* something broke. Short key, not display label: a label like
  // "contract tests (unit + fuzz)" needs shell quoting, and a command that must be edited
  // before it runs is not copy-pasteable.
  sayHuman(paint("dim", "Re-run one failing step on its own:"));
  for (const f of failed) {
    sayHuman(`  ${paint("cyan", reproCommand(f.label))}`);
  }
  // Replay, so a failed run is diagnosable from the terminal alone — the promise a bare
  // `stdio:"inherit"` gate could not keep once a step hung or a scrollback was lost.
  for (const f of failed) {
    if (f.log === null) continue;
    const why = f.timedOut ? "timed out" : "failed";
    sayHuman();
    sayHuman(paint("dim", `── last ${TAIL_LINES} lines · ${f.label} (${why}) · ${f.log}`));
    for (const line of tailLines(f.log, TAIL_LINES)) sayHuman(paint("dim", `  │ ${line}`));
  }
} else if (ONLY !== undefined || NO_FORGE) {
  // A reduced-scope run still has a verdict, and it is still honest to state it: the
  // qualifier and the result are independent lines, not alternatives. Printing only the
  // qualifier would make a green `--only` run look like nothing was proven.
  const scope = ONLY !== undefined ? `--only=${ONLY}` : QUICK ? "--quick" : "--no-forge";
  sayHuman(`\n${paint("yellow", `Partial verification (${scope}); not a full gate.`)}`);
  if (ran.length === 0) {
    sayHuman("No checks executed; selected checks were explicitly skipped.");
  } else {
    sayHuman(paint("bold green", `All ${ran.length} check(s) passed.`));
  }
} else if (ran.length === 0) {
  sayHuman("No checks executed; selected checks were explicitly skipped.");
} else {
  sayHuman(`\n${paint("bold green", `All ${ran.length} check(s) passed.`)}`);
}

// UX-09: the honest footer. `npm run verify` is a *local* gate and cannot run the checks that
// only CI has the toolchain for. Printed on every run — green included — because the exact
// moment it matters is when a developer is about to push a green run and assume CI agrees.
// Printed for --quick/--no-forge/--only runs too: those reduce scope further, and the line
// already says this run is not the whole gate.
sayHuman();
sayUncoveredCiGates();

// ── --json ────────────────────────────────────────────────────────────────────
/**
 * Machine-readable report on stdout, for a wrapper that needs a verdict without scraping
 * prose. Contract:
 *
 *   { ok, version?, results: [{ label, key, passed, timedOut, skipped, durationMs, logPath? }] }
 *
 * `ok` is true when nothing failed — it is the whole point of the flag, so it is computed
 * from `failed.length === 0` and never inferred from the exit code elsewhere. `logPath` is
 * present only when a log exists (a skip, or a step that could not be logged), and it is an
 * absolute host path, so the document is consumable as-is by a wrapper on this machine.
 */
if (JSON_OUT) {
  say(JSON.stringify({
    ok: failed.length === 0,
    results: results.map((r) => ({
      label: r.label,
      key: KEY_BY_LABEL.get(r.label.toLowerCase()),
      passed: r.passed,
      timedOut: r.timedOut,
      skipped: r.skipped,
      durationMs: r.ms,
      ...(r.log === null ? {} : { logPath: r.log }),
    })),
  }, null, 2));
}

// The exit code is decided here, last, so both output modes have already been written. An
// earlier `process.exit(1)` in the failure branch would have truncated a `--json` run's
// document — the one case where the caller most needs it.
process.exit(failed.length === 0 ? 0 : 1);
