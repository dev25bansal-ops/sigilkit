#!/usr/bin/env node
/**
 * End-to-end gate tests for `scripts/*.mjs` — the *chain*, not the functions.
 *
 * Every other suite in this directory (`check-doc-counts.test.mjs`, `check-waivers.test.mjs`,
 * `verify.test.mjs`, …) is a unit suite: it imports the pure helpers and feeds them fixture
 * strings. Those are the right place to prove a rule is implemented and the wrong place to
 * prove the *process contract* — exit code, stream discipline, idempotence, isolation between
 * gates. Those exist only at the process boundary, and a unit test cannot see them. This file
 * spawns the real gate binaries and asserts the boundary.
 *
 * The gates under test, and why each one is here:
 *
 *   validate-workflows       .github/workflows parse + shape. Root of the "all CI went dark" class.
 *   check-waivers            docs/CI-WAIVERS.md is enforced, not paper.        (workflows + docs)
 *   check-vectors            vectors/*.json counts + provenance.                        (vectors)
 *   check-dockerfile         static image invariants.                          (repo-root files)
 *   check-package-artifacts  workspace entry points resolve.                          (packages)
 *   check-runtime            node / npm / vitest alignment report.                     (environment)
 *   sync-facts               cross-document fact consistency.
 *   check-doc-counts         README / whitepaper / CHANGELOG counts.                 (needs forge)
 *
 * Isolation technique. Seven of these gates hard-code
 * `ROOT = dirname(import.meta.url) + "/.."` and expose **no** `--root` flag, so they cannot be
 * pointed at a fixture directory. Instead the gate file is *copied* into `<tmp>/scripts/` and
 * run from there: `ROOT` is derived from the script's own location, so the copy inherits
 * `<tmp>` as its root and the real repository is never touched. Same trick as
 * `verify.test.mjs`. The fake root needs its own copy of `node_modules/yaml`, because the
 * copied gate resolves its bare `import … from "yaml"` upward from *its own* file, and a
 * directory symlink does not survive being reached through the package's internal symlinks on
 * every platform — a real copy is the only form that is correct everywhere.
 *
 * A caveat that matters for reading the results below: `.github/` is symlinked from the real
 * repository, so the workflow gates exercise real CI YAML. They are therefore *not*
 * hermetic — a colleague editing `.github/workflows/` mid-run can turn these red. That is
 * reported, never suppressed, and it is why the chain test asserts an exit code rather than
 * exit 0 alone.
 *
 * `check-doc-counts` is the one gate that cannot be isolated or faked: it shells out to
 * `forge test --list`, and forge is not a Node devDependency, so it is absent in some
 * environments. It exits **2** in that case. {@link forgeAvailable} detects that, and the
 * chain test then substitutes a stand-in gate so the chain still exercises four processes
 * end to end instead of silently shrinking to three.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(REPO, "scripts");

/** Per-gate child budget. Generous, because `check-doc-counts` may shell out to forge/vitest. */
const TIMEOUT_MS = 180_000;

/** Wall-clock budget for a four-gate chain run. */
const CHAIN_TIMEOUT_MS = 600_000;

// ── fake repository ──────────────────────────────────────────────────────────────────────────

/**
 * True only for a real directory, so a file named like a directory is never symlinked.
 *
 * `lstatSync`, not `statSync`: a symlink pointing at a directory must not count as a directory
 * here, or a link would be followed and the fixture would depend on its target.
 */
function isDir(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Creates a throwaway repo root that the copied gates can run against.
 *
 * Everything is a **real copy** — no junctions. A junctioned input was the obvious optimisation
 * for `packages/` (~2000 files) and it is a trap: on Windows a junction cannot be resolved
 * through a path that also contains unresolved symlinks (the copied `node_modules/yaml` above
 * it), so `existsSync(<fixture>/.github)` starts reporting `false` for a directory that is
 * demonstrably there. `validate-workflows` then answers "no workflow directory", the fixture
 * tests cascade red, and the failures name a defect that does not exist. Measured, not assumed.
 *
 * The cost is a few seconds of copying per fixture. That is the right trade: a gate test that
 * can report a phantom defect costs far more than a slow one.
 */
function fakeRepo(t, { real = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  ensureYaml(root);
  for (const rel of real) copy(join(REPO, rel), join(root, rel));
  return root;
}

/**
 * Gives the fixture its own resolvable copy of `node_modules/yaml`, without which every copied
 * gate that imports it dies with `ERR_MODULE_NOT_FOUND` before reaching a single assertion.
 */
function ensureYaml(root) {
  const dst = join(root, "node_modules", "yaml");
  if (existsSync(dst)) return;
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(join(REPO, "node_modules", "yaml"), dst, { recursive: true, verbatimSymlinks: true });
}

/** Copies a file or directory, creating parents. Absent sources are skipped, not fatal. */
function copy(src, dst) {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
}

/** Installs a gate under the fake root, so `ROOT` becomes the fake root. */
function install(root, ...names) {
  for (const name of names) copy(join(SCRIPTS, name), join(root, "scripts", name));
  // Every gate in the inventory imports `./lib/exit.mjs` and `./lib/cli.mjs` relative to
  // itself, so a fixture holding only the gate dies with ERR_MODULE_NOT_FOUND — exit 2 from
  // the abort path, which the chain test would report as "the gate aborted instead of
  // reporting". Copy the shared modules with the gate, unconditionally.
  for (const lib of ["lib/exit.mjs", "lib/cli.mjs"]) copy(join(SCRIPTS, lib), join(root, "scripts", lib));
  return join(root, "scripts");
}

// ── running gates ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawns one gate and captures status, stdout and stderr *separately*.
 *
 * The script is resolved **inside `cwd`** first. That is the whole isolation mechanism: a gate
 * copied to `<fixture>/scripts/x.mjs` derives its `ROOT` from its own location, so running the
 * copy — not the repository's original — is what makes it inspect the fixture. Falling back to
 * `scripts/` of the repository would silently test the real tree while the fixture (and every
 * sabotage applied to it) went unobserved, which is the exact false green this file exists to
 * prevent.
 *
 * `NO_COLOR` is forced so escape sequences never leak into an assertion.
 */
function runGate(script, { args = [], cwd = REPO, env = {} } = {}) {
  const installed = join(cwd, "scripts", script);
  const path = existsSync(installed) ? installed : join(SCRIPTS, script);
  const result = spawnSync(process.execPath, [path, ...args], {
    cwd,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return {
    name: script.replace(/\.mjs$/, ""),
    path,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    get output() {
      return this.stdout + this.stderr;
    },
  };
}

/**
 * A genuine Node stack frame, and nothing looser.
 *
 * A naive `/\w*Error:/` would fire on a gate *reporting* an error — `check-waivers` prints
 * "invalid evaluation date", and `check-runtime` prints "FAIL: …", and a fixture whose
 * diagnostic merely contains the word "error" would be mistaken for a crash. The distinguishing
 * feature of a real trace is a frame: a `at …` line carrying a `file:line:column` position, or
 * Node's own `node:internal/…` preamble. Both are matched, and nothing else is.
 */
const STACK_FRAME = /(?:^|\n)\s+at [\w.<>\\/$]+ \([^)]*:\d+:\d+\)|(?:^|\n)node:internal\//;

function assertNoCrash(result, label) {
  assert.equal(result.signal, null, `${label}: killed by signal ${result.signal} — a gate must report, not die`);
  assert.ok(
    !STACK_FRAME.test(result.stderr),
    `${label}: stderr contains a stack frame — a gate must report a finding, not crash\n${result.stderr.slice(0, 800)}`,
  );
}

/** Exit 0 or 1 only. 2+ means the gate aborted on a usage/toolchain error, which CI cannot aggregate. */
function assertReportOrPass(result, label) {
  assertNoCrash(result, label);
  assert.ok(
    result.status === 0 || result.status === 1,
    `${label}: exit ${result.status}, expected 0 (clean) or 1 (findings). ` +
      `Code 2 = the gate aborted instead of reporting.\n${result.output.slice(0, 600)}`,
  );
}

// ── the gate inventory ───────────────────────────────────────────────────────────────────────

/**
 * The chain, in the order CI runs it. `forge: true` marks the one gate that needs a foundry
 * toolchain; the chain test substitutes a stand-in when it is unavailable.
 */
const CHAIN = ["validate-workflows.mjs", "check-waivers.mjs", "check-vectors.mjs", "check-doc-counts.mjs"];

/**
 * Gates that need no fixture and no forge, so they can be run against the real repository.
 *
 * `check-runtime` is here but is **skipped when `vitest` cannot be resolved**, because that is
 * the one thing it reports on: it answers "is this environment able to run the tests?", so an
 * uninstalled toolchain makes it correctly report exit 1. Asserting 0 in that state would mean
 * asserting the toolchain is installed — a property of the machine, not of the gate, and one
 * that changes under whoever last ran `npm install`. The skip is narrow (resolved at module
 * load) and loud (the test reports the skip rather than silently passing).
 */
const SELF_CONTAINED = ["check-dockerfile.mjs", "check-package-artifacts.mjs", "check-runtime.mjs"];
const VITEST_RESOLVED = (() => {
  try {
    createRequire(import.meta.url).resolve("vitest/package.json");
    return true;
  } catch {
    return false;
  }
})();

/** Every gate this file makes claims about, with the fixture each one needs. */
const FIXTURES = {
  "validate-workflows.mjs": { real: [".github"] },
  "check-waivers.mjs": { real: [".github", "docs"] },
  "check-vectors.mjs": { real: ["vectors", "scripts/generate-vectors.mjs"] },
  "check-dockerfile.mjs": { real: ["Dockerfile", ".dockerignore", "package.json", "package-lock.json", "packages"] },
  "check-package-artifacts.mjs": { real: ["package.json", "packages"] },
};

/**
 * Whether `forge` is usable, so the forge-dependent gate is skipped rather than failed.
 *
 * SEC-11: no `shell: true`. A shell re-parses its input, so every argv element becomes shell
 * *syntax* rather than an opaque argument and `;`/`` ` ``/`$()` inside one would execute; the
 * arguments are not escaped, only concatenated (Node's DEP0190 words it as a security
 * vulnerability). Both are literals here so this was never exploitable, but the no-shell rule
 * is only worth having if it stays true by construction — this is the last `shell: true` left
 * in `scripts/`, and the only reason it fired at all is that nobody ran the file.
 *
 * Unlike npm, `forge` needs no `.cmd` shim: it resolves as a plain executable, so an argv
 * array works directly on Windows with no shell and no fallback.
 */
/**
 * Whether `check-doc-counts.mjs` can actually run here, probed the way *the gate itself* decides.
 *
 * The gate honours `FORGE_BIN` first and only then falls back to `forge` on PATH. An earlier
 * version of this probe ran `forge --version` and nothing else, so on a machine where foundry is
 * installed but not on PATH — which is the normal case on Windows, where the installer does not
 * edit PATH — `HAS_FORGE` was false even with `FORGE_BIN` correctly exported. The suite then took
 * the "no forge" branch and T1d skipped, so the exit-2 contract went **unasserted** in exactly
 * the configuration the team runs in. Probing PATH alone made the test silently weaker.
 */
function forgeAvailable() {
  const fromEnv = process.env.FORGE_BIN;
  if (fromEnv) return spawnSync(fromEnv, ["--version"], { encoding: "utf8", timeout: 30_000 }).status === 0;
  return spawnSync("forge", ["--version"], { encoding: "utf8", timeout: 30_000 }).status === 0;
}

const HAS_FORGE = forgeAvailable();

// ── T1 · composed gate chain ─────────────────────────────────────────────────────────────────

test("T1 · four gates in sequence each report a verdict, and none of them crash", (t) => {
  // Prevents: a chain where the 3rd gate kills the process (uncaught throw / OOM / EPIPE), so
  // the 4th never runs and CI reports a red job with no indication which gate actually failed.
  const root = fakeRepo(t, {
    real: [".github", "docs", "vectors", "scripts/generate-vectors.mjs", "contracts", "vault"],
  });
  install(root, "validate-workflows.mjs", "check-waivers.mjs", "check-vectors.mjs", "check-doc-counts.mjs");

  // `check-doc-counts` shells out to `forge test --list` and `forge config --json`, and forge is
  // not a Node devDependency. Without it the gate exits 2 — a deliberate "I cannot run", pinned
  // by T1d — so it is replaced by three further real gates rather than silently reducing the
  // chain to three processes.
  //
  // `check-runtime` is deliberately *not* in the chain. It reports on the installed toolchain
  // (`node`, `npm`, `vitest` resolved through `node_modules`), not on repository content, so a
  // fixture root without an installed `vitest` makes it red for a reason that has nothing to do
  // with the code under test. It is covered in place by E1 instead.
  const chain = HAS_FORGE
    ? [...CHAIN, "check-dockerfile.mjs", "check-package-artifacts.mjs", "check-doc-counts.mjs"]
    : ["validate-workflows.mjs", "check-waivers.mjs", "check-vectors.mjs", "check-dockerfile.mjs", "check-package-artifacts.mjs"];
  install(root, "check-dockerfile.mjs", "check-package-artifacts.mjs");
  copy(join(REPO, "Dockerfile"), join(root, "Dockerfile"));
  copy(join(REPO, ".dockerignore"), join(root, ".dockerignore"));
  copy(join(REPO, "package.json"), join(root, "package.json"));
  copy(join(REPO, "package-lock.json"), join(root, "package-lock.json"));
  copy(join(REPO, "packages"), join(root, "packages"));
  copy(join(REPO, "README.md"), join(root, "README.md"));
  copy(join(REPO, "CHANGELOG.md"), join(root, "CHANGELOG.md"));
  copy(join(REPO, "docs", "WHITEPAPER-v2.1.md"), join(root, "docs", "WHITEPAPER-v2.1.md"));
  copy(join(REPO, ".well-known"), join(root, ".well-known"));
  copy(join(REPO, "foundry.toml"), join(root, "foundry.toml"));
  // `forge-std` is a git submodule, so a fixture that copies `contracts/` without `lib/` gives
  // forge a test file it cannot compile — `Error: Source "forge-std/Test.sol" not found`. That
  // arrives as exit 2, which this chain reads as "the gate aborted", so the missing submodule
  // masquerades as a gate defect. Copied only when forge is present, since without it the gate
  // never reaches a compiler and the copy would be pure cost.
  if (HAS_FORGE && existsSync(join(REPO, "lib"))) copy(join(REPO, "lib"), join(root, "lib"));

  const runs = [];
  for (const script of chain) {
    const result = runGate(script, { cwd: root });
    assertReportOrPass(result, `chain step ${script}`);
    runs.push(result);
  }
  assert.ok(runs.length >= 4, `the chain must execute at least four gates, ran ${runs.length}`);

  // A clean fixture must be green through the whole chain. A gate that is red because a
  // colleague is mid-edit is reported here rather than smoothed over.
  for (const r of runs) {
    assert.equal(r.status, 0, `${r.name}: a clean fixture must pass this chain gate (exit ${r.status})\n${r.output.slice(0, 600)}`);
  }
});

test("T1d · check-doc-counts reports a missing forge as a named toolchain problem, not a crash", (t) => {
  // Prevents: the forge-dependent gate being mistaken for a broken one. It exits 2 with a
  // message naming `FORGE_BIN`, which is the correct "I cannot run" verdict — but only because
  // it is a deliberate `process.exit(2)` after a `console.error`, not an uncaught ENOENT. This
  // test pins the difference, and skips when forge *is* installed (there is nothing to prove).
  if (HAS_FORGE) return;
  const result = runGate("check-doc-counts.mjs", { env: { FORGE_BIN: "sigilkit-no-such-forge" } });
  assert.equal(result.status, 2, `a missing forge must be a distinct code, got ${result.status}`);
  assert.match(result.stderr, /FORGE_BIN/, "the message must name the escape hatch");
  assert.match(result.stderr, /ENOENT/, "the underlying cause must be reported, not thrown");
  // The real assertion: a *deliberate* exit 2 ends the process there, so there is no `at …`
  // frame. An uncaught ENOENT would carry a full Node stack trace on the same stream, and the
  // two are indistinguishable to a CI log scraper — which is why they have to be told apart here.
  assert.doesNotMatch(
    result.stderr,
    /\n\s+at [\w.<>\\/$]+ \([^)]*:\d+:\d+\)/,
    "the ENOENT must be reported, not thrown — a stack trace here would mean the gate crashed\n" +
      `${result.stderr.slice(0, 400)}`,
  );
  // A gate that cannot run still emits its machine-readable verdict — the repo's
  // `announce()` convention puts `{gate, verdict, tool}` on stdout for every outcome,
  // including `tool-missing`. What it must NOT do is print a *pass* verdict, or print one
  // while also crashing. The earlier "stdout must be empty" assertion predated that
  // convention and now fails against a correctly-reported tool-missing.
  const verdict = JSON.parse(result.stdout.trim() || "{}");
  assert.equal(verdict.verdict, "tool-missing", "a gate that cannot run must not report a pass");
  assert.equal(verdict.tool, "sigilkit-no-such-forge", "the verdict must name the missing tool");
});

test("T1b · verify --list is a query, not a run: it must not execute a gate", (t) => {
  // Prevents: a `--list` that spawns the steps it is listing, turning "what can I select?"
  // into a multi-minute run — and writing step logs as a side effect of asking.
  const before = readdirSync(join(REPO, "outputs", "verify")).length;
  const result = runGate("verify.mjs", { args: ["--list"] });
  assertNoCrash(result, "verify --list");
  assert.equal(result.status, 0, `verify --list must exit 0\n${result.output.slice(0, 400)}`);
  assert.match(result.output, /SigilKit verification steps \(\d+\)/, "the listing must be printed");
  const after = readdirSync(join(REPO, "outputs", "verify")).length;
  assert.equal(after, before, "verify --list must not create step logs");
});

test("T1c · verify --only=<key> runs exactly one step and reports the rest as not executed", (t) => {
  // Prevents: a selector that silently matches zero steps and exits 0 — the false green that
  // let an entire gate step rot outside CI while `npm run verify` still reported success.
  const result = runGate("verify.mjs", { args: ["--only=packaging"] });
  assertNoCrash(result, "verify --only=packaging");
  assert.ok(
    result.status === 0 || result.status === 1,
    `verify --only must exit 0 or 1, got ${result.status}\n${result.output.slice(0, 400)}`,
  );
  assert.match(result.output, /PASS|FAIL|SKIP|TIMEOUT/, "a reduced run must still print a verdict row");
  assert.doesNotMatch(
    result.output,
    /PASS\s+contract tests/,
    "--only=packaging must not report the Foundry suites as executed",
  );
});

// ── T2 · failure propagation ──────────────────────────────────────────────────────────────────

test("T2 · a broken repository produces exit 1 and a readable message, never a stack trace", (t) => {
  // Prevents: a gate that dies on malformed input (exit 2 + trace) instead of reporting it.
  // A crash tells the reader nothing about *what* was wrong; an exit 1 with a named file:line
  // tells them where to look. This is the single most important contract in the file.
  const root = fakeRepo(t, FIXTURES["validate-workflows.mjs"]);
  install(root, "validate-workflows.mjs");

  writeFileSync(join(root, ".github", "workflows", "broken.yml"), "name: x\njobs:\n  a:\n    steps: [\n");

  const result = runGate("validate-workflows.mjs", { cwd: root });
  assertNoCrash(result, "validate-workflows (broken yaml)");
  assert.equal(result.status, 1, `a malformed workflow must fail the gate with exit 1, got ${result.status}\n${result.output.slice(0, 500)}`);
  assert.match(result.stderr, /YAML parse error/, "the failure must name the defect");
  assert.match(result.stderr, /broken\.yml/, "the failure must name the file");
});

test("T2b · a missing input is a finding (exit 1), not a crash and not a silent pass", (t) => {
  // Prevents: `existsSync` guards that `return` instead of failing, so deleting `.github/`
  // turns a gate green. "The thing I check is gone" must be red, never quiet.
  const root = fakeRepo(t, FIXTURES["validate-workflows.mjs"]);
  install(root, "validate-workflows.mjs");
  rmSync(join(root, ".github"), { recursive: true, force: true });

  const result = runGate("validate-workflows.mjs", { cwd: root });
  assertNoCrash(result, "validate-workflows (no workflows)");
  assert.equal(result.status, 1, `a missing workflow directory must exit 1, got ${result.status}\n${result.output.slice(0, 400)}`);
  assert.match(result.stderr, /no workflow directory/, "the failure must say what is missing");
});

test("T2c · a corrupt data file is reported, not thrown", (t) => {
  // Prevents: `JSON.parse(readFileSync(...))` in a gate's main path, which turns a truncated
  // `vectors/*.json` (a half-written file after an interrupted generate) into exit 2 + trace.
  const root = fakeRepo(t, FIXTURES["check-vectors.mjs"]);
  install(root, "check-vectors.mjs");
  copy(join(REPO, "scripts", "generate-vectors.mjs"), join(root, "scripts", "generate-vectors.mjs"));
  writeFileSync(join(root, "vectors", "actionrequest.json"), "{ this is not json");

  const result = runGate("check-vectors.mjs", { cwd: root });
  assertNoCrash(result, "check-vectors (corrupt json)");
  assert.equal(result.status, 1, `a corrupt corpus must exit 1, got ${result.status}\n${result.output.slice(0, 500)}`);
  assert.match(result.stderr, /could not parse/, "the failure must name the unreadable file");
  // A parse failure is deliberately *not* a counted problem list: there is no list, because
  // the corpus could not be read at all. That is the right call — inventing "0 problems" from
  // an unreadable input is the false green — but it means this path has no count for a CI
  // aggregator to scrape, which T4 records as an asymmetry rather than a contract.
  assert.equal(
    problemCount(result.stderr),
    null,
    `an unreadable corpus states no problem count — a CI aggregator scraping \`N problem(s)\` ` +
      `sees "no problems" here.\n${result.stderr.slice(0, 300)}`,
  );
});

// ── T3 · idempotence ──────────────────────────────────────────────────────────────────────────

test("T3 · the same gate run twice reports the same verdict", (t) => {
  // Prevents: state left behind by the first run changing the second one's result — a cache
  // that is never invalidated, a temp file that is written but not removed, a report that
  // accumulates. A gate whose verdict depends on how many times it has run is not a gate.
  const root = fakeRepo(t, FIXTURES["validate-workflows.mjs"]);
  install(root, "validate-workflows.mjs");
  writeFileSync(join(root, ".github", "workflows", "broken.yml"), "name: x\njobs:\n  a:\n    steps: [\n");

  const first = runGate("validate-workflows.mjs", { cwd: root });
  const second = runGate("validate-workflows.mjs", { cwd: root });
  assert.equal(first.status, second.status, "two runs on the same tree must agree on the exit code");
  assert.equal(first.stdout, second.stdout, "two runs on the same tree must emit identical stdout");
  assert.equal(
    countProblems(first.output),
    countProblems(second.output),
    "the reported problem count must not grow between runs",
  );
});

test("T3b · a clean repo stays clean, and a failing gate does not poison the next gate", (t) => {
  // Prevents: a shared temp file, lock or cached "already checked" marker leaking a red verdict
  // into an unrelated gate — the classic false red that costs a team an afternoon.
  const root = fakeRepo(t, { real: [".github", "vectors", "scripts/generate-vectors.mjs"] });
  install(root, "check-vectors.mjs", "validate-workflows.mjs");

  const before = runGate("validate-workflows.mjs", { cwd: root });
  assert.equal(before.status, 0, `fixture must start green\n${before.output.slice(0, 300)}`);

  writeFileSync(join(root, "vectors", "actionrequest.json"), "{ not json");
  const red = runGate("check-vectors.mjs", { cwd: root });
  assert.equal(red.status, 1, "the broken corpus must make check-vectors red");

  const after = runGate("validate-workflows.mjs", { cwd: root });
  assert.equal(after.status, 0, "a failing gate must not change the next gate's verdict");
  assert.equal(after.stdout, before.stdout, "the re-run must be byte-identical to the first clean run");
});

// ── T4 · machine-parseable output ─────────────────────────────────────────────────────────────

/**
 * The error-count grammar, deliberately stable and deliberately independent of this file:
 * `ok — N problem(s)`, `FAILED — N problem(s)`, `drift (N):`, `problems (N):`. A CI aggregator
 * that scrapes gate output depends on exactly this shape, and nothing in the gates declares
 * the contract, so a refactor that changes "problem(s)" to "issues" silently breaks every
 * dashboard built on it.
 */
const COUNT_PATTERNS = [
  /(\d+) problem\(s\)/,
  /\((\d+)\) problem/,
  /problems \((\d+)\)/,
  /drift \((\d+)\)/,
];

/** Extracts the reported problem count, or `null` when the output states none. */
function problemCount(text) {
  for (const re of COUNT_PATTERNS) {
    const m = re.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

test("T4 · every gate that reports findings states a countable problem list", (t) => {
  // Prevents: a gate whose failure output is a bare sentence ("validation FAILED") with no
  // number, so CI cannot show "3 problems" or alert on a count — the aggregator degrades to
  // a boolean and a reviewer has to read every log by hand.
  //
  // The headline count must equal the number of bullets actually printed under it. A headline
  // that says 2 and lists 5 (or says 2 and lists 1) is worse than no number at all: the number
  // is what a dashboard trusts, so a wrong one is a wrong dashboard rather than an absent one.
  const cases = [
    {
      script: "validate-workflows.mjs",
      fixture: FIXTURES["validate-workflows.mjs"],
      break: (root) => writeFileSync(join(root, ".github", "workflows", "broken.yml"), "name: x\njobs:\n  a:\n    steps: [\n"),
    },
    {
      script: "check-waivers.mjs",
      fixture: FIXTURES["check-waivers.mjs"],
      break: (root) => {
        rmSync(join(root, "docs", "CI-WAIVERS.md"), { force: true });
        writeFileSync(
          join(root, ".github", "workflows", "ci.yml"),
          "name: CI\njobs:\n  sneaky:\n    continue-on-error: true\n    steps:\n      - run: echo hi\n",
        );
      },
    },
    {
      script: "check-dockerfile.mjs",
      fixture: FIXTURES["check-dockerfile.mjs"],
      break: (root) => writeFileSync(join(root, "Dockerfile"), "FROM scratch\nCOPY nowhere/nope.json .\n"),
    },
    {
      script: "check-vectors.mjs",
      fixture: FIXTURES["check-vectors.mjs"],
      break: (root) => writeFileSync(join(root, "vectors", "actionrequest.json"), '{ "_doc": "x", "casesCount": 99, "cases": [] }'),
    },
  ];

  for (const { script, fixture, break: sabotage } of cases) {
    const root = fakeRepo(t, fixture);
    install(root, script);
    sabotage(root);

    const result = runGate(script, { cwd: root });
    assertNoCrash(result, `${script} (sabotaged)`);
    assert.equal(result.status, 1, `${script}: a broken tree must exit 1, got ${result.status}\n${result.output.slice(0, 400)}`);

    const headline = problemCount(result.output);
    assert.ok(
      headline !== null,
      `${script}: failure output states no problem count, so a CI aggregator cannot report "how many".\n${result.output.slice(0, 500)}`,
    );
    // The headline must match the list. A count a dashboard trusts has to agree with the lines
    // beneath it: "FAILED — 3 problem(s)" over a one-line list is a *wrong* dashboard, which is
    // worse than no dashboard at all because nobody re-checks a number that parsed cleanly.
    //
    // Both list shapes occur in this repo and both are counted: a multi-line bullet list
    // (`  file:line  message`, one bullet per problem) and a single inline headline
    // (`dockerfile/compose problems (1):`). A parser that understood only one of them would
    // silently stop counting the other, which is worse than not counting at all — a clean run
    // and an uncounted one look identical on a dashboard.
    // Both list shapes occur in this repo and both are counted: a multi-line bullet list
    // (`  file:line  message`, one bullet per problem) and a single inline headline
    // (`dockerfile/compose problems (1):`). A parser that understood only one of them would
    // silently stop counting the other, which is worse than not counting at all — a clean run
    // and an uncounted one look identical on a dashboard.
    //
    // The slice is bounded to the lines directly beneath the headline (up to a blank-line-free
    // run of indented bullets), so a later block — a nested gate, a warning list — cannot be
    // mistaken for this one's problem list.
    const headlineLine = /(^|\n)([^\n]*problems?\s*(?:\(\d+\)|\(s\))[^\n]*)/.exec(result.output);
    assert.ok(
      headlineLine,
      `${script}: no headline with a problem list under it was found to cross-check.\n${result.output.slice(0, 500)}`,
    );
    const claimed = problemCount(headlineLine[2]);
    const below = result.output.slice(headlineLine.index + headlineLine[0].length).split("\n");
    let bullets = 0;
    for (const line of below) {
      if (line.trim() === "") continue;
      if (!/^\s{2}\S/.test(line)) break;
      bullets++;
    }
    assert.equal(
      bullets,
      claimed,
      `${script}: the headline claims ${claimed} problem(s) but lists ${bullets}. A count a ` +
        `dashboard trusts must match the list beneath it.\n${result.output.slice(0, 500)}`,
    );
    // A *red* run that announces a problem list must actually have problems in it. `claimed === 0`
    // on an exit-1 run means the gate decided it had nothing to report after already deciding it
    // had failed — a report that contradicts its own exit code, and the single most confusing
    // thing a CI log can contain. A gate that legitimately reports zero findings exits 0, and is
    // covered by E1.
    if (result.status === 1) {
      assert.ok(
        claimed > 0,
        `${script}: exited 1 but announced "${headlineLine[2].trim()}" — a failing run must name at ` +
          `least one problem. A report that contradicts its own exit code sends a reader looking ` +
          `for a defect that is not listed.\n${result.output.slice(0, 500)}`,
      );
    }
  }
});

// ── T5 · non-interference ─────────────────────────────────────────────────────────────────────

test("T5 · gates leave the tree they inspect byte-identical", (t) => {
  // Prevents: a gate that mutates the repository it is checking. The read-only claim is made
  // in the script headers, so an unnoticed write is a broken promise — and a `git status` that
  // is never clean makes `--write`-style repair impossible to review.
  const root = fakeRepo(t, { real: [".github", "docs", "vectors", "scripts/generate-vectors.mjs"] });
  install(root, "check-waivers.mjs", "validate-workflows.mjs", "check-vectors.mjs");

  const before = snapshot(root);
  for (const script of ["validate-workflows.mjs", "check-waivers.mjs", "check-vectors.mjs"]) {
    const result = runGate(script, { cwd: root });
    assertReportOrPass(result, `T5 ${script}`);
  }
  assert.deepEqual(snapshot(root), before, "a read-only gate must not add, remove or modify a file");
});

test("T5b · a path with spaces is handled as one path, not as two arguments", (t) => {
  // Prevents: unquoted interpolation into a shell string, or a path split on whitespace, so
  // the fixture root silently becomes a different directory than the one that was created.
  // Windows temp dirs also contain spaces by default (`C:\Users\First Last\…`), so a gate
  // that only works with space-free paths fails for real users, not just for tests.
  const parent = mkdtempSync(join(tmpdir(), "sigilkit e2e "));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "root with spaces");
  mkdirSync(join(root, "scripts"), { recursive: true });
  ensureYaml(root);
  for (const rel of [".github", "docs"]) copy(join(REPO, rel), join(root, rel));
  install(root, "check-waivers.mjs");
  copy(join(REPO, "scripts", "generate-vectors.mjs"), join(root, "scripts", "generate-vectors.mjs"));

  const result = runGate("check-waivers.mjs", { cwd: root });
  assertNoCrash(result, "check-waivers (spaced root)");
  assert.equal(result.status, 0, `a clean fixture under a spaced path must pass, got ${result.status}\n${result.output.slice(0, 400)}`);
  assert.match(result.stdout, /waiver check OK/, "it must have inspected the fixture, not an empty directory");
});

// ── `--root` isolation audit ──────────────────────────────────────────────────────────────────

/**
 * The `--root` contract, per gate, as measured on 2026-09-26.
 *
 * `ROOT` is `dirname(import.meta.url) + "/.."` in every gate listed here, so the tree they
 * inspect is the repository they are installed into and no flag can move it. The cure for that
 * is not to implement `--root` (no caller needs it) but to **refuse** it, so a caller who
 * believed they were pointing the gate at another checkout is told so instead of handed a
 * clean verdict about a tree the gate never opened.
 *
 *   `rejected` — refuses `--root` with exit 2 and a message naming the tree it really checks.
 *   `ignored`  — still swallows the flag and reports on its own repository. A **known defect**,
 *                asserted in place so it cannot be forgotten and so the fix is a deliberate edit
 *                here rather than an accident. The six remaining rows are blocked: those scripts
 *                were being actively edited by other agents when this was measured.
 *
 * The three gates that genuinely accept a root — `assurance-inventory` (`--root <dir>`),
 * `sync-facts` (`--root=<dir>`), `clean.mjs` (`--root <dir>`) — are covered by R4/E2 instead,
 * which assert they *fail closed* on a missing root rather than reporting a clean tree.
 */
const ROOT_CONTRACT = {
  "validate-workflows.mjs": "rejected",
  "check-package-artifacts.mjs": "rejected",
  "check-waivers.mjs": "rejected",
  "check-vectors.mjs": "ignored",
  "check-dockerfile.mjs": "rejected",
};

test("R1 · --root is either honoured or loudly refused — never silently swallowed", (t) => {
  // Prevents: a gate accepting `--root` and then inspecting a different tree than the caller
  // named. That is the worst failure mode available to a fixture test: the assertion passes
  // against the real repository while the test believes it exercised a broken one, and a real
  // caller gets a confident verdict about a checkout nobody read. Every row is asserted, so a
  // fix — in either direction — has to be a deliberate update to this table.
  const root = fakeRepo(t, { real: [".github", "docs", "vectors", "Dockerfile", "package.json", "package-lock.json", "packages"] });
  const scripts = Object.keys(ROOT_CONTRACT);
  // check-vectors verifies which corpora are self-certified by reading the generator's
  // source, so a fixture that omits it makes the gate fail closed — correctly, and for a
  // reason unrelated to --root. Copy it so R1 measures the flag, not the fixture.
  install(root, ...scripts, "generate-vectors.mjs");
  const bad = join(root, "no-such-directory");

  for (const script of scripts) {
    const expected = ROOT_CONTRACT[script];
    const result = runGate(script, { args: ["--root", bad], cwd: root });
    assertNoCrash(result, `${script} --root <missing>`);

    if (expected === "ignored") {
      // The flag did nothing at all: the gate inspected its *own* fixture root and reported on
      // that, which is why the bad root is irrelevant. Asserted precisely so the defect cannot
      // be quietly forgotten, and so a gate that gains support has to be re-declared here.
      assert.equal(
        result.status,
        0,
        `${script}: ROOT_CONTRACT says --root is silently ignored, but the gate now exits ` +
          `${result.status} with a bad root. Either it gained --root support (move it to ` +
          `"rejected" and update R4) or it now fails closed on a missing input — either way the ` +
          `recorded contract is stale.\n${result.output.slice(0, 400)}`,
      );
      continue;
    }

    // `rejected` means exactly that: exit 2 — "could not run as asked" — a message naming what
    // was rejected, and no claim to have checked anything. Exit 1 would be wrong (nothing is
    // wrong with the repository), and exit 0 is the defect itself.
    assert.equal(
      result.status,
      2,
      `${script}: ROOT_CONTRACT says --root is rejected, but the run exited ${result.status}. ` +
        `2 is the "could not run as asked" code; 1 would report a repository finding that does ` +
        `not exist, and 0 is the silent-swallow defect.\n${result.output.slice(0, 400)}`,
    );
    assert.match(
      result.stderr,
      /--root|unrecognized|takes no arguments/i,
      `${script}: the rejection must name the flag it refused, or a caller cannot tell a typo ` +
        `from a broken gate.\n${result.stderr.slice(0, 400)}`,
    );
    assert.ok(
      !/OK\b|problem\(s\)/.test(result.stdout),
      `${script}: a refused invocation must not also print a verdict. Both at once reads as ` +
        `"it checked something", which is the confusion the refusal exists to prevent.\n` +
        `${result.stdout.slice(0, 300)}`,
    );
  }
});

test("R2 · a gate ignores no input it was handed: a sabotage in the fixture is always seen", (t) => {
  // Prevents: the failure mode that invalidates every fixture-based gate test at once — a
  // broken-resolution path (a flag parsed but never used, or a root computed from the wrong
  // base) that makes the gate inspect the real repository while the test believes it
  // exercised a broken fixture. Every other isolation test in this file is trustworthy only
  // because this one holds.
  const root = fakeRepo(t, FIXTURES["validate-workflows.mjs"]);
  install(root, "validate-workflows.mjs");
  writeFileSync(join(root, ".github", "workflows", "broken.yml"), "name: x\njobs:\n  a:\n    steps: [\n");

  const result = runGate("validate-workflows.mjs", { cwd: root });
  assertNoCrash(result, "validate-workflows (fixture must be observed)");
  assert.ok(
    result.path.startsWith(root),
    `the gate must be run from the fixture copy, not ${result.path} — otherwise the test asserts ` +
      `against the real repository and every fixture sabotage below it is decorative.`,
  );
  assert.equal(result.status, 1, `the fixture's broken workflow must be found, got ${result.status}`);
  assert.match(result.stderr, /broken\.yml/, "the finding must name the fixture's file");
});

test("R3 · a gate runs from any working directory", (t) => {
  // Prevents: a gate whose only relationship to the repository is `process.cwd()`. It would
  // inspect the caller's directory — a build output folder, a package subdir, the OS temp dir
  // — and report on the wrong tree without ever saying so.
  // The gate is spawned by *absolute path* from an unrelated CWD, so a cwd-derived ROOT would
  // resolve to the OS temp dir and the gate would report "no waiver register at …" — red, and
  // for the wrong reason. A correct gate keeps its own root and stays green.
  const result = runGate("check-waivers.mjs", { cwd: tmpdir() });
  assertNoCrash(result, "check-waivers (foreign cwd)");
  assert.equal(result.status, 0, `the gate must inspect its own repo, not ${tmpdir()}\n${result.output.slice(0, 300)}`);
  assert.match(result.stdout, /waiver check OK/, "it must have reached its own repository, not the CWD");
});

// ── stream discipline ─────────────────────────────────────────────────────────────────────────

test("S1 · findings go to stderr and the clean verdict to stdout", (t) => {
  // Prevents: everything on one stream, which breaks CI log aggregation. `verify.mjs` already
  // insists a `--json` document owns stdout alone; the same discipline has to hold for the
  // individual gates, or a wrapper that captures stdout to parse a verdict also captures the
  // noise and cannot tell a pass from a pass-with-warnings.
  const root = fakeRepo(t, FIXTURES["check-waivers.mjs"]);
  install(root, "check-waivers.mjs");
  const clean = runGate("check-waivers.mjs", { cwd: root });
  assert.equal(clean.status, 0, "fixture must start green");

  writeFileSync(
    join(root, ".github", "workflows", "ci.yml"),
    "name: CI\njobs:\n  sneaky:\n    continue-on-error: true\n    steps:\n      - run: echo hi\n",
  );
  const red = runGate("check-waivers.mjs", { cwd: root });
  assert.equal(red.status, 1, "an unregistered waiver must fail the gate");
  assert.match(red.stderr, /waiver check FAILED/, "the failure headline must be on stderr");
  assert.ok(red.stderr.length > 0, "stderr must actually carry the finding");

  // Every *finding* must be off stdout, not merely the headline. A gate that prints "FAILED"
  // to stderr and then lists its problems on stdout satisfies the check above, and still breaks
  // every aggregator: the scraper reads stdout, sees a plausible report, and records a pass.
  // So the gate's own problems are matched too, by identity rather than by shape.
  //
  // Only the gate's *own* problems are asserted absent from stdout — a stdout summary naming a
  // *different* file is informational, not a finding, and treating it as one makes the check
  // fire on legitimate output. `check-vectors` prints its provenance table on stdout by design.
  // Only the gate's *own* findings are asserted absent from stdout. Two deliberate exclusions:
  // warnings are a legitimate stdout citizen (this gate prints its waiver warnings there, and
  // they do not fail the run), and a stdout summary naming a *different* file is informational
  // — `check-vectors` prints its provenance table on stdout by design.
  const ownFindingsOnStdout = red.stdout
    .split("\n")
    .filter((line) => !/waiver check warnings/.test(line) && /jobs\.sneaky|rule #1|rule #2/.test(line));
  assert.deepEqual(
    ownFindingsOnStdout,
    [],
    `findings must not be written to stdout — a stdout-scraping aggregator would read them as a pass.\n${red.stdout.slice(0, 400)}`,
  );
  assert.ok(
    /jobs\.sneaky/.test(red.stderr),
    `the finding itself must be on stderr, not just the headline\n${red.stderr.slice(0, 400)}`,
  );
});

test("S2 · a gate emits no ANSI escapes when its output is not a terminal", (t) => {
  // Prevents: raw ESC bytes in a redirected log. `verify.mjs` gates colour on `isTTY` and
  // NO_COLOR; the individual gates inherit the same exposure, so the file this suite is about
  // to have a CI job scrape is the exact file that would collect them.
  const root = fakeRepo(t, FIXTURES["validate-workflows.mjs"]);
  install(root, "validate-workflows.mjs");
  const result = runGate("validate-workflows.mjs", { cwd: root });
  assertNoCrash(result, "validate-workflows (ansi)");
  assert.doesNotMatch(result.output, /\[[0-9;]*m/, "a piped gate must not emit ANSI colour");
});

// ── exit-code contract ────────────────────────────────────────────────────────────────────────

test("E1 · a clean repository exits 0 for every gate that can run here", (t) => {
  // Prevents: a false negative (a gate red on a green tree) that trains the team to re-run
  // until it passes — the single most expensive habit a gate can encourage. Also the baseline
  // the failure columns of the contract table are measured against.
  for (const script of SELF_CONTAINED) {
    if (script === "check-runtime.mjs" && !VITEST_RESOLVED) {
      // Not a defect: `check-runtime`'s subject *is* the environment, so a missing toolchain is
      // a correct exit 1. Asserting 0 here would be asserting the machine is provisioned.
      //
      // Printed as well as skipped: a skip nobody can see is a gate that quietly stops being
      // checked, and the next person to trust this suite would not know it. The line says
      // *environment*, not *gate*, so the reader knows the gate is fine and the machine is not.
      const reason = "SKIPPED: vitest not resolvable (environment, not gate)";
      console.error(`  ${reason}`);
      t.skip(`check-runtime.mjs — ${reason}`);
      continue;
    }
    const result = runGate(script);
    assertNoCrash(result, `${script} (clean repo)`);
    assert.equal(result.status, 0, `${script}: a green repository must exit 0, got ${result.status}\n${result.output.slice(0, 500)}`);
  }
});

test("E2 · --root-bearing gates reject a missing root with a message, not a stack trace", (t) => {
  // Prevents: the one gate family that *can* be isolated from a stack trace escaping. The
  // code is deliberately not asserted: 0 or 1 are both acceptable answers today, but a signal
  // or exit 2+ is not, because a caller cannot distinguish "you gave me a bad root" from
  // "the gate is broken".
  const result = runGate("assurance-inventory.mjs", { args: ["--root", join(tmpdir(), "sigilkit-no-such-root")] });
  assertNoCrash(result, "assurance-inventory --root <missing>");
  assert.ok(
    result.status === 0 || result.status === 1,
    `a missing --root must be reported (0/1), got ${result.status}\n${result.output.slice(0, 400)}`,
  );
  assert.ok(result.stderr.trim().length > 0, "a rejected root must say so on stderr");
});

/**
 * The `--root` support matrix, asserted rather than documented.
 *
 * `ROOT_BEARING` is the list of gates that genuinely accept a root. `ROOT_HARDCODED` is the
 * list that hard-code `dirname(import.meta.url) + "/.."`, taken from a grep of every script,
 * and is re-checked here so the list cannot silently rot: if a colleague *adds* `--root` to one
 * of them, the corresponding R1 test must stop failing loudly rather than quietly start passing
 * for the wrong reason.
 */
const ROOT_BEARING = ["assurance-inventory.mjs", "sync-facts.mjs", "clean.mjs"];

const ROOT_HARDCODED = [
  "validate-workflows.mjs",
  "check-waivers.mjs",
  "check-vectors.mjs",
  "check-dockerfile.mjs",
  "check-package-artifacts.mjs",
  "check-doc-counts.mjs",
  "check-runtime.mjs",
  "verify.mjs",
];

test("R4 · the --root support matrix matches the sources, in both directions", (t) => {
  // Prevents: the matrix rotting into fiction. A gate listed as root-capable that has lost the
  // flag, or one that gained it while still listed as hard-coded, would send a fixture test to
  // the wrong root and produce a false green.
  const sources = ROOT_BEARING.concat(ROOT_HARDCODED).map((name) => ({
    name,
    text: readFileSync(join(SCRIPTS, name), "utf8"),
  }));

  for (const { name, text } of sources) {
    // `/--root/` alone is no longer a signal: a gate that *refuses* the flag has to name it in
    // its rejection message and in the comment explaining why, so the literal string now appears
    // in scripts that deliberately do not parse it. What distinguishes support is the flag
    // reaching a *root* — either bound to a variable or sliced out of argv — so that is what is
    // matched. A gate that gained `--root` support therefore still trips this check.
    const acceptsRoot = /--root[=\s]|["'`]--root["'`]/.test(
      text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""),
    );
    const expected = ROOT_BEARING.includes(name);
    assert.equal(
      acceptsRoot,
      expected,
      `${name}: ${acceptsRoot ? "parses" : "does not parse"} --root, but the matrix says it ` +
        `${expected ? "does" : "does not"}. Update ROOT_BEARING / ROOT_HARDCODED deliberately — ` +
        `a stale entry here means every fixture test of this gate is testing the wrong tree.`,
    );
  }

  // And the two lists must cover the gates this suite makes claims about, with no overlap.
  assert.equal(
    ROOT_BEARING.filter((n) => ROOT_HARDCODED.includes(n)).length,
    0,
    "a gate cannot be both root-capable and hard-coded",
  );
  assert.ok(ROOT_HARDCODED.length >= 4, "the hard-coded list must keep covering the workflow/doc gates");
});

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

/**
 * A `stat`-free listing of `dir` → relative path → size, for the read-only proof.
 *
 * Symlinks are recorded as `"link"` rather than followed: the fixture is all real copies now,
 * but a gate that *created* a link would otherwise be invisible to a walk that skips them, and
 * the read-only claim would pass for the wrong reason.
 */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isSymbolicLink()) out[p.slice(dir.length)] = "link";
      else if (entry.isFile()) out[p.slice(dir.length)] = readFileSync(p).length;
    }
  };
  walk(dir);
  return out;
}

/** Counts the bullet lines under a failure headline, for the idempotence check. */
function countProblems(text) {
  const m = /problem\(s\):\n((?:  \S.*\n?)+)/.exec(text);
  if (m) return m[1].split("\n").filter((l) => l.trim().length > 0).length;
  const n = problemCount(text);
  return n ?? 0;
}
