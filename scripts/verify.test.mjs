import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Run the real CLI from an isolated repository layout so no gate step can touch this repo.
// `verify.mjs` derives ROOT from its own location, so a copy under <tmp>/scripts/ is enough.
function makeLayout(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./verify.mjs", import.meta.url), join(root, "scripts/verify.mjs"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/**
 * The step keys `verify.mjs` declares, read from its source rather than restated here.
 *
 * Every "the gate has N steps" assertion in this file used to hardcode N, and each hardcoded
 * N was a separate place to forget. The count moved 10 → 13 → 14 during one working session,
 * and every bump left a stale number behind in a test name, a message string, a `--list`
 * heading assertion and a JSON length check simultaneously. Four edits, four chances to miss
 * one — and the missed one is a silently weakened gate, not a loud failure.
 *
 * `LABELS` is already the single source of truth inside `verify.mjs` (`--list`, `--only` and
 * the report all read it), so restating its contents in the test adds no coverage: it can only
 * disagree. What the test SHOULD pin is the *identity and order* of the steps — that each
 * declared key is listable, selectable and reported — which the assertions below do, driven
 * from this one list. Adding a step is then a one-line change here, and forgetting is a
 * `deepEqual` failure naming the missing key instead of an off-by-one.
 */
const VERIFY_SOURCE = readFileSync(new URL("./verify.mjs", import.meta.url), "utf8");
const LABELS_BLOCK = VERIFY_SOURCE.match(/const LABELS = \{([\s\S]*?)\n\};/);
if (!LABELS_BLOCK) {
  // A guard that cannot locate its subject is worse than no guard: it reads as a passing
  // check while measuring nothing. Naming the invariant is the point — a bare `[1]` here
  // throws `TypeError: Cannot read properties of null`, which reports "the code is broken"
  // when the truth is "the structure this suite reads has changed". Those need different
  // fixes: one is a logic change, the other a declaration change. Same fail-closed rule
  // check-helper-suites.mjs:20-24 already applies to the list it polices, so both readers of
  // the `LABELS` table now fail the same way when it moves.
  throw new Error(
    "verify.test.mjs: no `const LABELS = {…}` declaration found in verify.mjs — the step list " +
      "this suite derives every expectation from is gone or renamed. Update the matcher above " +
      "in lockstep with verify.mjs, or this suite is asserting nothing.",
  );
}
const STEP_KEYS = Object.keys(
  Object.fromEntries(
    [...LABELS_BLOCK[1].matchAll(/^  ([a-zA-Z]+):/gm)].map((m) => [m[1], true]),
  ),
);

/**
 * Builds a child environment: the ambient one, overlaid with `env`.
 *
 * An `undefined` value *removes* a variable instead of setting it to a string. That
 * distinction is load-bearing, not a nicety: the colour tests must be hermetic. They
 * inherit `process.env` like every other spawn, so on a machine — or in a CI job — that
 * already has `CI=true` set, a spread-only override could never *unset* it, and the
 * FORCE_COLOR cases would fail against ambient state they do not control. CI is exactly
 * where this suite runs as part of the `helper suites` gate step, so the leak is not
 * hypothetical: it turns the colour suite red in GitHub Actions while green everywhere
 * else. `NO_COLOR` and `TERM` leak the same way.
 */
function childEnvFor(env) {
  const childEnv = { ...process.env };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[name];
    else childEnv[name] = value;
  }
  delete childEnv.NODE_TEST_CONTEXT;
  return childEnv;
}

/**
 * The gate under test must never outlive the test. A hung gate would otherwise hang the
 * suite just as surely as it hangs a developer's shell — the exact failure mode this
 * suite exists to prevent, reproduced inside the suite. `timeout` is the test-side
 * mirror of the gate-side budget; the caller must still assert the resulting exit status
 * so a killed run cannot masquerade as a verdict.
 */
function runVerify(t, extraArgs = [], files = {}, env = {}, watchdogMs = 60_000) {
  const root = makeLayout(t, files);
  const result = spawnSync(process.execPath, [join(root, "scripts/verify.mjs"), ...extraArgs], {
    cwd: root, encoding: "utf8", env: childEnvFor(env), timeout: watchdogMs,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, null,
    `the gate exceeded the test's ${watchdogMs}ms watchdog and was killed — that is a hang, not a result`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr, root };
}

/** The single step log a run wrote, under the DEBT-04 `outputs/verify/` rule. */
function stepLogs(root) {
  const dir = join(root, "outputs", "verify");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".log")).sort() : [];
}

/** Colour codes are part of the gate's output, not of what it is asserting on. */
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

const PIDS = ".verify-timeout-pids.json";

/**
 * A step that hangs forever, recording its own pid and a grandchild's. The grandchild is
 * what makes this a *tree*: for `npm run build` the interesting casualties are the tsc
 * workers, not the npm parent.
 */
const HANGING_STEP = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(PIDS)}, JSON.stringify({ self: process.pid, grandchild: grandchild.pid }));
console.log("hanging step started, pid " + process.pid);
setInterval(() => {}, 1000);
`;

/** true / false, or null when the platform cannot answer (caller skips and explains). */
function isAlive(pid) {
  if (process.platform === "win32") {
    // tasklist is the only unambiguous existence probe on Windows; `process.kill(pid, 0)`
    // can still report success for a pid that is terminating but not yet reaped.
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8" });
    if (r.error) return null;
    return new RegExp(`"${pid}"`).test(r.stdout ?? "");
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    return null; // EPERM: the pid exists but is not ours to signal
  }
}

/** Reaping is asynchronous after a kill; poll briefly instead of asserting a race. */
async function waitForDead(pid, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  let state = isAlive(pid);
  while (state === true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    state = isAlive(pid);
  }
  return state;
}

test("fresh workspace builds declarations before typechecking", (t) => {
  const r = runVerify(t, ["--only=workspace"], {
    "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    "packages/fixture/package.json": JSON.stringify({
      name: "verify-order-fixture", private: true,
      scripts: { build: "node build.cjs", lint: "node lint.cjs" },
    }),
    "packages/fixture/build.cjs": "require('node:fs').writeFileSync('built.d.ts', 'export {};');\n",
    "packages/fixture/lint.cjs": "if (!require('node:fs').existsSync('built.d.ts')) { console.error('missing declarations'); process.exit(1); }\n",
  });
  assert.equal(r.status, 0, r.output);
  assert.ok(r.stdout.indexOf("▶ workspace build") < r.stdout.indexOf("▶ workspace typecheck"), r.output);
  assert.match(r.stdout, /All 2 check\(s\) passed\./);
});

// A stub step so `--only="workflow lint"` has something real (and instant) to run.
const STUB_LINT = { "scripts/validate-workflows.mjs": "process.exit(0);\n" };

test("rejects an unrecognized flag before running any step", (t) => {
  const r = runVerify(t, ["--bogus"]);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /unrecognized argument\(s\): --bogus/);
  assert.doesNotMatch(r.stdout, /▶/);
});

test("rejects --only with no value", (t) => {
  const r = runVerify(t, ["--only"]);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /unrecognized argument\(s\): --only/);
  assert.doesNotMatch(r.stdout, /▶/);
});

test("rejects --only with an empty selector", (t) => {
  const r = runVerify(t, ["--only="]);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /--only needs a non-empty selector/);
  assert.doesNotMatch(r.stdout, /▶/);
});

test("rejects --only with a whitespace-only selector", (t) => {
  const r = runVerify(t, ["--only=   "]);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /--only needs a non-empty selector/);
});

test("rejects an unmatched selector before running any step", (t) => {
  const r = runVerify(t, ["--only=typo"], STUB_LINT);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /--only=typo matches no step/);
  // UX-09: a rejected selector must point at the way to find the right one, not just
  // enumerate the labels inline (which is unreadable at nine steps).
  assert.match(r.stderr, /--list/);
  assert.doesNotMatch(r.stdout, /▶/);
  assert.doesNotMatch(r.stdout, /Results/);
});

test("rejects --only given more than once", (t) => {
  const r = runVerify(t, ["--only=workflow lint", "--only=doc counts"], STUB_LINT);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /--only may be given at most once/);
  assert.doesNotMatch(r.stdout, /▶/);
});

test("documented doc-count selector runs only that step", (t) => {
  const r = runVerify(t, ["--only=doc counts"], {
    "scripts/check-doc-counts.mjs": "process.exit(0);\n",
  });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /▶ doc counts/);
  assert.match(r.stdout, /All 1 check\(s\) passed\./);
  assert.doesNotMatch(r.stdout, /TypeScript tests|workspace typecheck|▶ workflow lint/);
});

test("a valid selector runs only the matching step", (t) => {
  const r = runVerify(t, ["--only=workflow lint"], STUB_LINT);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /▶ workflow lint/);
  assert.match(r.stdout, /All 1 check\(s\) passed\./);
  assert.doesNotMatch(r.stdout, /TypeScript tests/);
  assert.doesNotMatch(r.stdout, /workspace typecheck/);
});

test("a selector matching a skipped step is reported as skipped and does not fail", (t) => {
  const r = runVerify(t, ["--only=contract tests", "--quick"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /contract tests \(unit \+ fuzz\)/);
  assert.match(r.stdout, /skip/);
  assert.match(r.stdout, /--quick/);
});

test("a missing required tool fails the gate instead of reporting a successful skip", (t) => {
  const r = runVerify(t, ["--only=contract tests"], {}, { VERIFY_FORCE_NO_FORGE: "1" });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /gate is incomplete/);
  assert.doesNotMatch(r.output, /All .* check\(s\) passed/);
});

test("the helper-suite step runs the guard regressions and fails when one breaks", (t) => {
  const r = runVerify(t, ["--only=helper suites"], {
    "scripts/check-dockerfile.test.mjs": "process.exit(0);\n",
    "scripts/check-doc-counts.test.mjs": "process.exit(0);\n",
    "scripts/verify.test.mjs": "process.exit(0);\n",
    "scripts/check-package-artifacts.test.mjs": "process.exit(7);\n",
    "scripts/check-runtime.test.mjs": "process.exit(0);\n",
    "scripts/assurance-inventory.test.mjs": "process.exit(0);\n",
    "scripts/benchmark-indexer.test.mjs": "process.exit(0);\n",
  });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /helper suites/);
  assert.doesNotMatch(r.stdout, /All .* check\(s\) passed/);
});

test("artifact-check failures propagate to the verifier exit status", (t) => {
  const r = runVerify(t, ["--only=package artifacts"], {
    "scripts/check-package-artifacts.mjs": "console.error('fixture artifact failure'); process.exit(7);\n",
  });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /fixture artifact failure/);
  assert.doesNotMatch(r.output, /All .* check\(s\) passed/);
});

test("reduced gate builds before artifact validation and labels its scope", (t) => {
  const files = {
    ...STUB_LINT,
    "scripts/check-dockerfile.mjs": "process.exit(0);\n",
    "scripts/check-doc-counts.mjs": "process.exit(0);\n",
    "scripts/check-doc-location.mjs": "process.exit(0);\n",
    // The `runtime` step (check-runtime.mjs) is a real gate wired into the full run, so a
    // reduced-gate fixture must stub it for the same reason as its neighbours: the real
    // script resolves vitest against the fixture root, where it does not exist.
    "scripts/check-runtime.mjs": "process.exit(0);\n",
    // P0-WIRE: the three guards wired in as steps are executed by the full gate, so a fixture
    // that runs the full gate must stub them. Without these the real scripts are spawned in
    // the fixture root, where their inputs do not exist, and the step fails for a reason that
    // has nothing to do with what this test is about (build-before-artifacts ordering).
    "scripts/check-helper-suites.mjs": "process.exit(0);\n",
    "scripts/check-tracked-refs.mjs": "process.exit(0);\n",
    "scripts/check-reparse-points.mjs": "process.exit(0);\n",
    // Same reason, for the `testwaivers` step added alongside the other guards: a full-gate
    // fixture must stub every step, or the real script is spawned in a fixture root where its
    // inputs (docs/CI-WAIVERS.md, forge) do not exist and the step fails for an unrelated reason.
    "scripts/check-test-waivers.mjs": "process.exit(0);\n",
    "scripts/check-package-artifacts.mjs": "import { existsSync } from 'node:fs'; if (!existsSync('packages/fixture/built.d.ts')) process.exit(1);\n",
    "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    "packages/fixture/package.json": JSON.stringify({
      name: "verify-artifact-order", private: true,
      scripts: { build: "node build.cjs", lint: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" },
    }),
    "packages/fixture/build.cjs": "require('node:fs').writeFileSync('built.d.ts', 'export {};');\n",
  };
  for (const name of ["check-dockerfile", "check-doc-counts", "verify", "check-package-artifacts", "check-runtime", "assurance-inventory", "benchmark-indexer"]) {
    files[`scripts/${name}.test.mjs`] = "process.exit(0);\n";
  }
  const r = runVerify(t, ["--no-forge"], files, { VERIFY_FORCE_NO_FORGE: "1" });
  assert.equal(r.status, 0, r.output);
  const build = r.stdout.indexOf("▶ workspace build");
  const artifacts = r.stdout.indexOf("▶ package artifacts");
  assert.ok(build >= 0 && artifacts > build, r.output);
  assert.match(r.output, /Partial verification.*--no-forge/);
  assert.match(r.output, /not a full gate/);
});

test("explicit skip with no executed checks does not claim passing checks", (t) => {
  const r = runVerify(t, ["--only=contract tests", "--quick"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /No checks executed/);
  assert.match(r.output, /Partial verification/);
  assert.doesNotMatch(r.output, /All .* check\(s\) passed/);
});

test("skips respect the selector", (t) => {
  const r = runVerify(t, ["--only=workflow lint", "--quick"], STUB_LINT);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /▶ workflow lint/);
  assert.doesNotMatch(r.stdout, /contract tests/);
  assert.match(r.stdout, /All 1 check\(s\) passed\./);
});

// ── DEBT-04: a hung step must fail the gate, not stall it ─────────────────────

test("a step that hangs is killed at its budget and fails the gate (fail-closed)", (t) => {
  const r = runVerify(t, ["--only=workflow lint"], {
    "scripts/validate-workflows.mjs": HANGING_STEP,
  }, { VERIFY_STEP_TIMEOUT: "lint=1200" });

  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /TIMEOUT/);
  assert.match(r.output, /workflow lint exceeded 1s/);
  assert.match(r.stdout, /▶ workflow lint/);
  // Fail-closed: a timeout is a failure, never a silent skip or a pass.
  assert.match(r.stdout, /1 of 1 check\(s\) failed/);
  assert.doesNotMatch(r.output, /All .* check\(s\) passed/);
  assert.doesNotMatch(r.output, /skip/);
});

test("a hung step's report marks TIMEOUT in the results table", (t) => {
  const r = runVerify(t, ["--only=workflow lint"], {
    "scripts/validate-workflows.mjs": HANGING_STEP,
  }, { VERIFY_STEP_TIMEOUT: "lint=1200" });
  assert.equal(r.status, 1, r.output);
  // The results-table row marker, not just the prose line.
  //
  // UX-02: the row marker is now the full word TIMEOUT, not the old four-letter `TIME`.
  // A truncated word is exactly the failure mode this change exists to remove — `TIME` reads
  // as a timer display, and with colour off it was the only thing distinguishing a timeout
  // from a failure. Fixed-width so the table stays column-aligned with colour on or off.
  const row = stripAnsi(r.stdout);
  assert.match(row, /TIMEOUT\s+workflow lint/);
  assert.doesNotMatch(row, /FAIL\s+workflow lint/);
  // The full word, and nothing abbreviated: no output may be colour-only *or* truncated-only.
  assert.doesNotMatch(row, /\bTIME\s+workflow lint/);
});

test("a step that finishes inside its budget is unaffected and still passes", (t) => {
  const r = runVerify(t, ["--only=workflow lint"], STUB_LINT, { VERIFY_STEP_TIMEOUT: "lint=1200" });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /All 1 check\(s\) passed\./);
  assert.doesNotMatch(r.output, /TIMEOUT/);
});

test("VERIFY_STEP_TIMEOUT accepts a display label as well as a step key", (t) => {
  const r = runVerify(t, ["--only=workflow lint"], {
    "scripts/validate-workflows.mjs": HANGING_STEP,
  }, { VERIFY_STEP_TIMEOUT: "workflow lint=1200" });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /TIMEOUT/);
});

test("a malformed VERIFY_STEP_TIMEOUT aborts instead of silently using the default", (t) => {
  const unknown = runVerify(t, ["--only=workflow lint"], STUB_LINT, { VERIFY_STEP_TIMEOUT: "linter=1200" });
  assert.equal(unknown.status, 2, unknown.output);
  assert.match(unknown.stderr, /VERIFY_STEP_TIMEOUT names unknown step "linter"/);

  const badValue = runVerify(t, ["--only=workflow lint"], STUB_LINT, { VERIFY_STEP_TIMEOUT: "lint=not-a-number" });
  assert.equal(badValue.status, 2, badValue.output);
  assert.match(badValue.stderr, /must be a positive number of milliseconds/);
});

test("a hung step's output is written to a replayable log under outputs/verify", (t) => {
  const r = runVerify(t, ["--only=workflow lint"], {
    "scripts/validate-workflows.mjs": HANGING_STEP,
  }, { VERIFY_STEP_TIMEOUT: "lint=1200" });
  assert.equal(r.status, 1, r.output);

  const logs = stepLogs(r.root);
  assert.equal(logs.length, 1, `expected exactly one step log, found ${JSON.stringify(logs)}`);
  // <timestamp>-<key>-<slug>.log, with the ':' and '.' of an ISO stamp replaced by '-' so the
  // name is filesystem-safe and step-start times stay distinct. The step *key* is in the name
  // (PERF-1) because under concurrency two steps can start in the same millisecond, and two
  // steps sharing one log file would interleave their output into an unreplayable mess.
  assert.match(logs[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-lint-workflow-lint\.log$/);

  const body = readFileSync(join(r.root, "outputs", "verify", logs[0]), "utf8");
  assert.match(body, /hanging step started/, "the step's own output must reach the log");
  assert.match(body, /=== budget: 1200ms/);
  assert.match(body, /timedOut=true/);
});

test("a failing step's log is created and its tail is replayed in the report", (t) => {
  const r = runVerify(t, ["--only=package artifacts"], {
    "scripts/check-package-artifacts.mjs":
      "console.error('fixture-artifact-failure-marker'); process.exit(7);\n",
  });
  assert.equal(r.status, 1, r.output);

  const logs = stepLogs(r.root);
  assert.equal(logs.length, 1, `expected exactly one step log, found ${JSON.stringify(logs)}`);
  assert.match(logs[0], /-package-artifacts\.log$/);
  const body = readFileSync(join(r.root, "outputs", "verify", logs[0]), "utf8");
  assert.match(body, /fixture-artifact-failure-marker/);
  // stderr must be teed too — that is where a real failure usually lives.
  assert.match(body, /code=7/);

  // The report names the log path and replays it, so a failed run is diagnosable
  // from the terminal alone.
  assert.match(r.stdout, /outputs[\\/]verify[\\/].*-package-artifacts\.log/);
  assert.match(r.stdout, /last 30 lines/);
  assert.match(r.stdout, /fixture-artifact-failure-marker/);
});

test("a timed-out step is killed, leaving no surviving process tree", async (t) => {
  const root = makeLayout(t, { "scripts/validate-workflows.mjs": HANGING_STEP });
  // Async rather than spawnSync: the pid file is only written once the step is running,
  // and the fixture must still be reachable after the gate reaps it.
  const child = spawn(process.execPath, [join(root, "scripts/verify.mjs"), "--only=workflow lint"], {
    cwd: root, env: childEnvFor({ VERIFY_STEP_TIMEOUT: "lint=2500" }), stdio: "ignore",
  });
  t.after(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  });
  const exited = new Promise((resolve) => child.on("close", resolve));
  // A gate that never exits must fail this test, not stall the suite — the same hang
  // this budget prevents in production. Bounded well above the 2500ms step budget so a
  // legitimately slow reap is not mistaken for a stall.
  const watchdog = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, 30_000);
  t.after(() => clearTimeout(watchdog));
  const pidFile = join(root, PIDS);

  // Wait for the fixture to publish its pids.
  const deadline = Date.now() + 10_000;
  while (!existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(existsSync(pidFile), "the hanging fixture never reported its pids");
  const pids = JSON.parse(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isInteger(pids.self) && Number.isInteger(pids.grandchild), JSON.stringify(pids));

  const status = await exited;
  assert.equal(status, 1, `a hung step must exit 1, got ${status}`);

  // 10s, not 3s: the gate signals the tree, but a killed process stays visible to
  // `process.kill(pid, 0)` until the OS reaps it, and that lag is scheduler-dependent on a
  // loaded CI runner. A 3s budget made this test intermittently red for a tree that WAS killed
  // correctly — it measured reaping latency, not gate behaviour. 10s is still far below the
  // 30s watchdog above, so a genuinely surviving process is not masked.
  const selfState = await waitForDead(pids.self);
  const childState = await waitForDead(pids.grandchild);
  if (selfState === null || childState === null) {
    // A probe that cannot answer (e.g. EPERM on a non-owned pid) is not a pass, but it
    // is not a failure of the gate either — say so rather than asserting on noise.
    t.diagnostic(`skipped liveness assertion: platform probe could not determine state (self=${selfState}, grandchild=${childState})`);
    return;
  }
  assert.equal(selfState, false, `step pid ${pids.self} survived the timeout`);
  assert.equal(childState, false, `grandchild pid ${pids.grandchild} survived the timeout`);
});

test("the gate does not crash when its stdout is closed early (EPIPE)", (t) => {
  const root = makeLayout(t, STUB_LINT);
  // Reproduce a closed downstream pipe: read a few bytes, then destroy the stream while
  // the gate keeps writing. An unhandled EPIPE would take the gate down mid-run instead
  // of letting it finish and report.
  //
  // The gate's exit status is deliberately not asserted — what matters is that no EPIPE
  // crash escaped, and that the run still completed its step.
  const child = spawn(process.execPath, [join(root, "scripts/verify.mjs"), "--only=workflow lint"], {
    cwd: root, env: childEnvFor({}), stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve) => {
    let stderr = "";
    let closedDownstream = false;
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", () => {
      if (closedDownstream) return;
      closedDownstream = true;
      child.stdout.destroy(); // the reader is gone
    });
    child.on("close", () => {
      t.diagnostic(`stdout closed after first chunk; gate stderr: ${JSON.stringify(stderr)}`);
      assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error'|write after end/i);
      resolve();
    });
    child.on("error", (err) => {
      // A non-EPIPE spawn failure is a broken test environment, not a gate bug.
      assert.doesNotMatch(err.message, /EPIPE/);
      resolve();
    });
  });
});

// ── UX-02: colour is a layer, never the message ──────────────────────────────────
//
// These tests spawn the gate with *piped* stdio, so `isTTY` is false and the default is
// already "no colour" — which is exactly the property worth pinning. `FORCE_COLOR=1` is the
// escape hatch that turns colour on despite the pipe, so the same harness can assert both
// directions without faking a TTY.

/**
 * Colour-decision env for a run: NO_COLOR, CI, FORCE_COLOR and TERM must be *absent*,
 * not merely falsy. Absence is expressed as `undefined` because {@link childEnvFor} now
 * treats that as "unset" — `delete`-ing from the override object only removed it from the
 * override, and the ambient value was spread in afterwards regardless.
 */
function colorEnv(extra = {}) {
  return { NO_COLOR: undefined, CI: undefined, FORCE_COLOR: undefined, TERM: undefined, ...extra };
}

test("NO_COLOR output carries no escape sequences but keeps the status words", (t) => {
  const r = runVerify(t, ["--only=workflow lint"], STUB_LINT, { ...colorEnv(), NO_COLOR: "1", FORCE_COLOR: "1" });
  assert.equal(r.status, 0, r.output);
  // NO_COLOR wins over FORCE_COLOR: no-color.org says a user-set NO_COLOR disables colour
  // unconditionally, and a test that let FORCE_COLOR through would document the wrong rule.
  assert.doesNotMatch(r.stdout, /\u001b\[/, "NO_COLOR must suppress every escape sequence");
  // The hard requirement: with colour gone, the verdict must still be readable.
  assert.match(r.stdout, /PASS/);
  assert.match(r.stdout, /workflow lint/);
});

test("a failing step still spells FAIL and TIMEOUT when colour is disabled", (t) => {
  const failed = runVerify(t, ["--only=package artifacts"], {
    "scripts/check-package-artifacts.mjs": "console.error('nocolour-failure-marker'); process.exit(7);\n",
  }, { ...colorEnv(), NO_COLOR: "1" });
  assert.equal(failed.status, 1, failed.output);
  assert.doesNotMatch(failed.stdout, /\u001b\[/);
  assert.match(failed.stdout, /FAIL/);
  assert.match(failed.stdout, /package artifacts/);

  const timedOut = runVerify(t, ["--only=workflow lint"], {
    "scripts/validate-workflows.mjs": HANGING_STEP,
  }, { ...colorEnv(), NO_COLOR: "1", VERIFY_STEP_TIMEOUT: "lint=1200" });
  assert.equal(timedOut.status, 1, timedOut.output);
  assert.doesNotMatch(timedOut.stdout, /\u001b\[/);
  assert.match(timedOut.stdout, /TIMEOUT/);
});

test("NO_COLOR is honoured at any value, per no-color.org", (t) => {
  // "present at any value" is the spec: NO_COLOR= (empty) and NO_COLOR=0 still disable.
  for (const value of ["", "0", "false", "1", "anything"]) {
    const r = runVerify(t, ["--only=workflow lint"], STUB_LINT, { ...colorEnv(), NO_COLOR: value, FORCE_COLOR: "1" });
    assert.equal(r.status, 0, r.output);
    assert.doesNotMatch(r.stdout, /\u001b\[/, `NO_COLOR=${JSON.stringify(value)} must disable colour`);
  }
});

test("FORCE_COLOR enables escapes even on a pipe, and the words are still there", (t) => {
  const r = runVerify(t, ["--only=workflow lint"], STUB_LINT, { ...colorEnv(), FORCE_COLOR: "1" });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /\u001b\[/, "FORCE_COLOR must produce escapes despite non-TTY stdio");
  // Colour reinforces, it does not replace: the word survives inside the coloured span.
  const plain = stripAnsi(r.stdout);
  assert.match(plain, /PASS/);
  assert.match(plain, /workflow lint/);
});

test("a CI environment suppresses colour even when a TTY is simulated", (t) => {
  // GitHub Actions allocates a pseudo-terminal for some steps, so isTTY alone is not enough.
  // CI is the member that catches this, and it is checked before the isTTY fallback.
  const r = runVerify(t, ["--only=workflow lint"], STUB_LINT, { ...colorEnv(), CI: "true", FORCE_COLOR: "0" });
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.stdout, /\u001b\[/, "CI must suppress colour");
  assert.match(stripAnsi(r.stdout), /PASS/);
});

test("TERM=dumb suppresses colour", (t) => {
  const r = runVerify(t, ["--only=workflow lint"], STUB_LINT, { ...colorEnv(), TERM: "dumb" });
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.stdout, /\u001b\[/, "TERM=dumb must suppress colour");
  assert.match(stripAnsi(r.stdout), /PASS/);
});

test("every status word appears in full, never colour-only", (t) => {
  // The hard requirement stated as an invariant over one run: a row must never be a bare
  // coloured glyph. Each verdict word must be present as plain text.
  const pass = runVerify(t, ["--only=workflow lint"], STUB_LINT, { ...colorEnv(), FORCE_COLOR: "1" });
  assert.match(stripAnsi(pass.stdout), /PASS\s+workflow lint/);

  const fail = runVerify(t, ["--only=package artifacts"], {
    "scripts/check-package-artifacts.mjs": "process.exit(3);\n",
  }, { ...colorEnv(), FORCE_COLOR: "1" });
  assert.equal(fail.status, 1, fail.output);
  assert.match(stripAnsi(fail.stdout), /FAIL\s+package artifacts/);

  const skip = runVerify(t, ["--only=contract tests", "--quick"], {}, { ...colorEnv(), FORCE_COLOR: "1" });
  assert.equal(skip.status, 0, skip.output);
  assert.match(stripAnsi(skip.stdout), /SKIP/);
});

// ── UX-09: a failure has to be actionable ───────────────────────────────────────

test("a failed step prints a copy-pasteable --only command for that step", (t) => {
  const r = runVerify(t, ["--only=package artifacts"], {
    "scripts/check-package-artifacts.mjs": "process.exit(7);\n",
  });
  assert.equal(r.status, 1, r.output);
  // The exact string a developer pastes. Asserted in full, not as a regex over a substring,
  // because the whole point is that it needs no editing before it runs.
  assert.match(r.stdout, /npm run verify -- --only=artifacts/);
});

test("the re-run command uses the short key, so it needs no shell quoting", (t) => {
  // A display label like "contract tests (unit + fuzz)" would have to be quoted in every
  // shell, and a command that must be edited before it runs is not copy-pasteable. The short
  // key is what makes the hint safe to paste verbatim.
  const r = runVerify(t, ["--only=contract tests"], {}, { VERIFY_FORCE_NO_FORGE: "1" });
  assert.equal(r.status, 1, r.output);
  assert.match(r.stdout, /npm run verify -- --only=contracts/);
  assert.doesNotMatch(r.stdout, /--only="?contract tests/);
});

test("every failing step gets its own re-run command", (t) => {
  // Two failures, two commands — the hint must be per-step, not one global suggestion.
  const r = runVerify(t, ["--no-forge", "--quick"], {
    "scripts/check-dockerfile.mjs": "process.exit(2);\n",
    "scripts/check-package-artifacts.mjs": "process.exit(9);\n",
  }, { VERIFY_FORCE_NO_FORGE: "1" });
  assert.equal(r.status, 1, r.output);
  assert.match(r.stdout, /npm run verify -- --only=packaging/);
  assert.match(r.stdout, /npm run verify -- --only=artifacts/);
});

test("the short step key is accepted as a selector", (t) => {
  // UX-09: the key is what the failure hint tells you to type, so it must itself work.
  // Before this change the key was not a substring of the label, so `--only=contracts`
  // matched nothing and aborted — the hint would have pointed at a dead end.
  const r = runVerify(t, ["--only=contracts", "--quick"], STUB_LINT);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /contract tests \(unit \+ fuzz\)/);
  assert.match(r.stdout, /SKIP/);
});

test("--list enumerates every declared step with its key, purpose and budget", (t) => {
  const r = runVerify(t, ["--list"], STUB_LINT);
  assert.equal(r.status, 0, r.output);
  const out = stripAnsi(r.stdout);
  for (const key of STEP_KEYS) {
    assert.match(out, new RegExp(`\\b${key}\\b`), `--list must name the "${key}" step`);
  }
  // A list that only names steps is a table of contents; the purpose column is what makes it
  // answer "which step do I want?".
  assert.match(out, /actionlint over \.github\/workflows/);
  assert.match(out, /forge test/);
  // It is a query, not a run: nothing executed, and the usage hint is present.
  assert.doesNotMatch(out, /▶/);
  assert.doesNotMatch(out, /^Results$/m);
  assert.match(out, /--only=<key>/);
});

test("--list prints exactly one row per declared step and does not run the gate", (t) => {
  const r = runVerify(t, ["--list"], STUB_LINT);
  assert.equal(r.status, 0, r.output);
  const keys = stripAnsi(r.stdout).split(/\r?\n/).filter((l) => /^\s{2}[a-z]+\s{2,}\S/.test(l));
  // The count is asserted THROUGH the heading rather than as its own literal, so the number
  // has exactly one home. Two literals ("14 rows" and "(14)") could disagree after an edit
  // and the failure would read as a mystery; one derived value cannot.
  assert.equal(
    keys.length,
    STEP_KEYS.length,
    `expected ${STEP_KEYS.length} listed steps, got ${keys.length}:\n${keys.join("\n")}`,
  );
  // A step must be listed, not run — --list answers a question.
  assert.deepEqual(stepLogs(r.root), []);
});

test("--list is answerable even when paired with a selector that would be rejected", (t) => {
  // Someone who mistypes a selector needs the list more than they need an error, and a
  // "what are the valid values?" question should not require a correct guess to answer.
  const r = runVerify(t, ["--list", "--only=typo"], STUB_LINT);
  assert.equal(r.status, 0, r.output);
  assert.match(stripAnsi(r.stdout), new RegExp(`SigilKit verification steps \\(${STEP_KEYS.length}\\)`));
  assert.doesNotMatch(r.stdout, /▶/);
});

test("--json output parses and reports ok=false for a failing run", (t) => {
  const r = runVerify(t, ["--only=package artifacts", "--json"], {
    "scripts/check-package-artifacts.mjs": "process.exit(7);\n",
  });
  assert.equal(r.status, 1, r.output);
  // stdout must be *only* the document: a --json flag whose stdout cannot be parsed is not a
  // machine-readable flag. The human report is routed to stderr for exactly this reason.
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ok, false);
  assert.equal(doc.results.length, 1);
  const [only] = doc.results;
  assert.equal(only.label, "package artifacts");
  assert.equal(only.key, "artifacts");
  assert.equal(only.passed, false);
  assert.equal(only.timedOut, false);
  assert.equal(typeof only.durationMs, "number");
  assert.ok(only.logPath, "a run step must report its log path");
});

test("--json reports ok=true and the skipped shape for a passing run", (t) => {
  const r = runVerify(t, ["--only=workflow lint", "--json"], STUB_LINT);
  assert.equal(r.status, 0, r.output);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ok, true);
  const [only] = doc.results;
  assert.equal(only.passed, true);
  assert.equal(only.key, "lint");
  // A skip has no log, so logPath must be absent rather than null — optional-by-omission
  // keeps `results` uniform for a consumer that just checks for the key.
  const skippedRun = runVerify(t, ["--only=contract tests", "--quick", "--json"], STUB_LINT);
  const skipDoc = JSON.parse(skippedRun.stdout);
  assert.equal(skipDoc.ok, true);
  assert.equal(skipDoc.results[0].skipped, true);
  assert.ok(!("logPath" in skipDoc.results[0]), "a skipped step must not claim a log path");
});

test("--json marks a timed-out step as timedOut and not merely failed", (t) => {
  const r = runVerify(t, ["--only=workflow lint", "--json"], {
    "scripts/validate-workflows.mjs": HANGING_STEP,
  }, { VERIFY_STEP_TIMEOUT: "lint=1200" });
  assert.equal(r.status, 1, r.output);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ok, false);
  assert.equal(doc.results[0].timedOut, true, "a timeout must be distinguishable from a failure");
  assert.equal(doc.results[0].passed, false);
});

test("--json still emits its document on a failing run, not a truncated one", (t) => {
  // The exit code is decided after the document is written; an early process.exit would have
  // cut the JSON off mid-object exactly when a caller most needs to read it.
  const r = runVerify(t, ["--only=package artifacts", "--json"], {
    "scripts/check-package-artifacts.mjs": "process.exit(7);\n",
  });
  assert.equal(r.status, 1, r.output);
  assert.doesNotThrow(() => JSON.parse(r.stdout), "a failing --json run must still parse");
});

// Regression guard for the harness bug this fix addresses: the colour tests used to be
// sensitive to the ambient environment, so they passed on a developer machine and went red
// in CI — the exact place the `helper suites` gate step runs this file. A test that only
// passes when nothing is set in the environment is not a hermetic test.
test("colour tests are hermetic: an ambient CI/NO_COLOR does not flip the verdict", (t) => {
  const poisoned = { CI: "true", NO_COLOR: "1", TERM: "dumb" };
  // Baseline: a scrubbed env lets FORCE_COLOR win, so escapes appear.
  const clean = runVerify(t, ["--only=workflow lint"], STUB_LINT, { ...colorEnv(), FORCE_COLOR: "1" });
  assert.match(clean.stdout, /\u001b\[/, "precondition: colour is on with a scrubbed env");

  // Reproduce GitHub Actions for real: put the colour-killing variables into *this*
  // process's environment — which is exactly what `childEnvFor` spreads into every child —
  // and confirm a scrubbed override can still remove them. Before the fix the override
  // could only add a key, never delete one, so an ambient `CI` won and FORCE_COLOR died,
  // turning this suite red in CI while green on a developer machine.
  const saved = {};
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  for (const [name, value] of Object.entries(poisoned)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  t.after(restore);
  try {
    // One run is enough to prove the scrub: FORCE_COLOR is asserted on, and all three
    // ambient variables are set at once, so any single leak fails here.
    const r = runVerify(t, ["--only=workflow lint"], STUB_LINT, { ...colorEnv(), FORCE_COLOR: "1" });
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /\u001b\[/,
      `ambient ${JSON.stringify(poisoned)} leaked into the child and suppressed colour`);
  } finally {
    restore();
  }
  // Sanity: those variables really do disable colour in the gate itself when *kept*.
  const real = runVerify(t, ["--only=workflow lint"], STUB_LINT, { ...colorEnv(), CI: "true" });
  assert.doesNotMatch(real.stdout, /\u001b\[/, "CI must still disable colour in the gate");
});

test("--list --json keeps stdout parseable and lists the steps as data", (t) => {
  // Regression: `--list` used to print its table straight to stdout and exit, so combining
  // it with `--json` handed the caller prose instead of a document — the one outcome
  // `--json` exists to prevent, and it happened for the exact combination a wrapper is most
  // likely to reach for ("what are the valid selectors?" as a script).
  const r = runVerify(t, ["--list", "--json"], STUB_LINT);
  assert.equal(r.status, 0, r.output);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ok, true);
  assert.equal(doc.list, true);
  // ORDER is the assertion, not membership: the document must list steps in declaration order,
  // because `--only`'s reverse index and the report both depend on it. Asserted against
  // STEP_KEYS (read from verify.mjs) rather than a restated literal, so the expectation cannot
  // drift from the declaration it is checking.
  assert.deepEqual(doc.steps.map((s) => s.key), STEP_KEYS);
  const [lint] = doc.steps;
  assert.equal(lint.label, "workflow lint");
  assert.ok(lint.why.length > 0, "a step's purpose must be data, not only prose");
  assert.equal(typeof lint.budgetMs, "number");
  // The table belongs on stderr under --json, so stdout stays a document. The count is
  // asserted against the same list as the document's keys, so adding a step cannot leave a
  // stale literal here disagreeing with the list above.
  assert.match(r.stderr, new RegExp(`SigilKit verification steps \\(${doc.steps.length}\\)`));
});

test("--list --json is a query: it runs no step and writes no log", (t) => {
  const r = runVerify(t, ["--list", "--json"], STUB_LINT);
  assert.deepEqual(stepLogs(r.root), [], "--list must not execute the gate");
});

test("the report names the CI gates this local gate does not run", (t) => {
  // The cheapest possible fix for "local green ≠ CI green": say so on every run. Asserted on
  // a *passing* run, because that is the run where the assumption is most tempting.
  const pass = runVerify(t, ["--only=workflow lint"], STUB_LINT);
  assert.equal(pass.status, 0, pass.output);
  const out = stripAnsi(pass.stdout);
  for (const gate of ["slither", "gitleaks", "halmos", "fork", "deep-fuzz"]) {
    assert.match(out, new RegExp(gate), `the report must name the uncovered "${gate}" gate`);
  }
  assert.match(out, /not a green CI run/);

  // And on a failing run, where the tail is what gets read.
  const fail = runVerify(t, ["--only=package artifacts"], {
    "scripts/check-package-artifacts.mjs": "process.exit(7);\n",
  });
  assert.match(stripAnsi(fail.stdout), /deep-fuzz/);
});

test("the uncovered-gates line survives NO_COLOR as readable text", (t) => {
  const r = runVerify(t, ["--only=workflow lint"], STUB_LINT, { ...colorEnv(), NO_COLOR: "1" });
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.stdout, /\u001b\[/);
  assert.match(r.stdout, /slither, gitleaks, halmos, fork, deep-fuzz/);
});

test("abuse-resistant flags: --json and --list are recognized, not treated as stray args", (t) => {
  // Flag validation runs before any step, so an unrecognized flag exits 2. These must not
  // fall into that path.
  const list = runVerify(t, ["--list"], STUB_LINT);
  assert.equal(list.status, 0, list.output);
  assert.doesNotMatch(list.stderr, /unrecognized argument/);

  const json = runVerify(t, ["--only=workflow lint", "--json"], STUB_LINT);
  assert.equal(json.status, 0, json.output);
  assert.doesNotMatch(json.stderr, /unrecognized argument/);
});

test("usage text lists every supported flag", (t) => {
  const r = runVerify(t, ["--nope"], STUB_LINT);
  assert.equal(r.status, 2, r.output);
  for (const flag of ["--quick", "--no-forge", "--only", "--list", "--json"]) {
    assert.match(r.stderr, new RegExp(flag.replace(/[-]/g, "\\-")), `usage must document ${flag}`);
  }
});

// ── PERF-1: concurrency, ordering and log retention ─────────────────────────────

test("the TypeScript test suite runs after build, never beside it", (t) => {
  // The `tests` step reads build output: packages/mcp/test/mcp.test.ts spawns `dist/cli.js`
  // and packages/core/test/lease-fs.test.ts imports `../dist/lease-fs.js`. `runWave` hands work
  // out by declaration order, so the only thing that keeps those two reads safe is `tests`
  // being in a LATER wave than `build` — it was in the same wave, which made a cold-checkout
  // failure intermittent (2 of 52 suites) and therefore indistinguishable from a real
  // regression. This pins the wave membership, not the code that implements it.
  //
  // No `--only` can select both steps ("workspace build" and "TypeScript tests" share no
  // substring, and the key form matches one step exactly), so this drives a reduced full gate
  // and stubs every other step — the same shape as the build-before-artifacts test above.
  const files = {
    ...STUB_LINT,
    "scripts/check-dockerfile.mjs": "process.exit(0);\n",
    "scripts/check-doc-counts.mjs": "process.exit(0);\n",
    "scripts/check-doc-location.mjs": "process.exit(0);\n",
    // Same reason as the fixture above — `runtime` is a real step in the full gate.
    "scripts/check-runtime.mjs": "process.exit(0);\n",
    "scripts/check-helper-suites.mjs": "process.exit(0);\n",
    "scripts/check-tracked-refs.mjs": "process.exit(0);\n",
    "scripts/check-reparse-points.mjs": "process.exit(0);\n",
    "scripts/check-test-waivers.mjs": "process.exit(0);\n",
    "scripts/check-package-artifacts.mjs": "process.exit(0);\n",
    "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    "packages/fixture/package.json": JSON.stringify({
      name: "verify-build-before-tests", private: true,
      scripts: {
        build: "node build.cjs",
        lint: "node lint.cjs",
        // Fails loudly if the suite starts before build has produced the declaration file —
        // the exact race this test exists to keep from coming back.
        test: "node test.cjs",
      },
    }),
    "packages/fixture/build.cjs": "require('node:fs').writeFileSync('built.d.ts', 'export {};');\n",
    "packages/fixture/lint.cjs": "if (!require('node:fs').existsSync('built.d.ts')) { console.error('missing declarations'); process.exit(1); }\n",
    "packages/fixture/test.cjs": "if (!require('node:fs').existsSync('built.d.ts')) { console.error('test ran before build'); process.exit(1); }\n",
  };
  for (const name of ["check-dockerfile", "check-doc-counts", "verify", "check-package-artifacts", "check-runtime", "assurance-inventory", "benchmark-indexer"]) {
    files[`scripts/${name}.test.mjs`] = "process.exit(0);\n";
  }
  const r = runVerify(t, ["--no-forge"], files, { VERIFY_FORCE_NO_FORGE: "1" });
  assert.equal(r.status, 0, r.output);
  const build = r.stdout.indexOf("▶ workspace build");
  const tests = r.stdout.indexOf("▶ TypeScript tests");
  assert.ok(build >= 0, `build step must run; got:\n${r.output}`);
  assert.ok(tests > build, `tests must start after build (build@${build}, tests@${tests}); got:\n${r.output}`);
  assert.doesNotMatch(r.output, /test ran before build/);
});

test("a malformed VERIFY_CONCURRENCY aborts instead of silently using the default", (t) => {
  // Same policy as VERIFY_STEP_TIMEOUT: a tuning knob that quietly ignores a typo is a knob
  // that appears to be honoured while it is not. `VERIFY_CONCURRENCY=0` used to yield 4-way
  // fan-out with no diagnostic at all.
  for (const bad of ["abc", "0", "-1", "2.5.1", "Infinity"]) {
    const r = runVerify(t, ["--only=workflow lint"], STUB_LINT, { VERIFY_CONCURRENCY: bad });
    assert.equal(r.status, 2, `VERIFY_CONCURRENCY=${bad} must abort, got ${r.status}:\n${r.output}`);
    assert.match(r.stderr, /VERIFY_CONCURRENCY must be a positive integer/);
  }
  // A fractional value is a number, not a typo: it truncates rather than aborting.
  const ok = runVerify(t, ["--only=workflow lint"], STUB_LINT, { VERIFY_CONCURRENCY: "1" });
  assert.equal(ok.status, 0, ok.output);
});

test("VERIFY_CONCURRENCY=1 runs every step serially, in declaration order", (t) => {
  const r = runVerify(t, ["--only=workflow lint", "--quick"], STUB_LINT, { VERIFY_CONCURRENCY: "1" });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /▶ workflow lint/);
  assert.match(r.stdout, /All 1 check\(s\) passed\./);
});

test("step logs are capped at a retention window instead of accumulating forever", (t) => {
  // Nothing in the repo ever removed outputs/verify/*.log. `clean.mjs` deliberately refuses
  // that path (it is in DANGEROUS_PATHS), so delegating retention to it would be a no-op. The
  // policy has to live in verify.mjs, and it has to be testable without running fourteen steps:
  // this seeds synthetic logs for many distinct runs and asserts one run prunes them.
  const seeded = [];
  // 40 runs' worth, older first. Names match logPathFor's shape: <stamp>-<key>-<slug>.log
  for (let i = 0; i < 40; i++) {
    const stamp = `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00-00-0${i % 10}-000Z`;
    seeded.push(`${stamp}-lint-workflow-lint.log`);
  }
  const files = { ...STUB_LINT };
  for (const name of seeded) files[`outputs/verify/${name}`] = "old run\n";

  const r = runVerify(t, ["--only=workflow lint"], files, { VERIFY_CONCURRENCY: "1" });
  assert.equal(r.status, 0, r.output);

  const after = readdirSync(join(r.root, "outputs", "verify")).filter((f) => f.endsWith(".log"));
  // The seeded stamps collapse into at most 28 distinct run-stamps (i%28 for the day), and the
  // window keeps 20 of them; the run's own fresh log is one more. The assertion is deliberately
  // loose on the exact count and tight on the property that matters: growth is bounded.
  assert.ok(after.length <= 22, `retention must bound the log count, got ${after.length}`);
  assert.ok(after.length < seeded.length, `expected pruning, ${seeded.length} seeded -> ${after.length}`);
  // The newest seeded run must survive; the oldest must not.
  assert.ok(after.some((f) => f.startsWith("2026-01-28T")), "the newest run's log must be kept");
  assert.ok(!after.some((f) => f.startsWith("2026-01-01T")), "the oldest run's log must be pruned");
  // The current run's own log must still exist and be readable — pruning must not eat it.
  assert.ok(after.some((f) => /-lint-workflow-lint\.log$/.test(f) && f.includes("T") && !f.startsWith("2026-01")),
    `the current run's log must survive its own retention pass: ${JSON.stringify(after)}`);
});

test("log retention never deletes a file it cannot attribute to a run", (t) => {
  // Pruning must be conservative: a foreign file in outputs/verify (a developer's note, a
  // stray editor backup) has no run stamp, so it is not a candidate. A retention policy that
  // deletes "everything but the newest N" would silently eat it.
  const files = {
    ...STUB_LINT,
    "outputs/verify/not-a-log.txt": "keep me\n",
    "outputs/verify/README": "keep me too\n",
  };
  for (let i = 0; i < 30; i++) {
    files[`outputs/verify/2020-01-01T00-00-0${i % 10}-000Z-lint-workflow-lint.log`] = "ancient\n";
  }
  const r = runVerify(t, ["--only=workflow lint"], files, { VERIFY_CONCURRENCY: "1" });
  assert.equal(r.status, 0, r.output);
  const dir = join(r.root, "outputs", "verify");
  assert.ok(existsSync(join(dir, "not-a-log.txt")), "a foreign file must not be pruned");
  assert.ok(existsSync(join(dir, "README")), "a foreign file with no extension must not be pruned");
});

test("the gate and the core logger make the same colour decision", async (t) => {
  // UX-02's cross-file requirement: `verify.mjs` and `packages/core/src/logger.ts` must agree
  // for the same environment, or a report colours its PASS rows while a logger line beside it
  // does not — and the two then disagree about the terminal in a way nobody can debug from
  // either file alone.
  //
  // The gate is probed through its own `--list` output, and the logger through a child that
  // emits one line from the *built* dist. A child per side is required: the gate reads its
  // environment at module load, so evaluating it in this process would compare two different
  // environments rather than two implementations. Skipped when dist is absent (a fresh
  // checkout, or a run before `npm run build`) — a missing build is not a parity failure, and
  // the check-doc-counts/build steps cover its presence.
  const dist = new URL("../packages/core/dist/logger.js", import.meta.url);
  if (!existsSync(dist)) {
    t.diagnostic("skipped: packages/core/dist/logger.js not built");
    return;
  }
  // The built logger reaches `viem`, and a partially-installed `viem` (a dependency tree that
  // was interrupted mid-install) throws ERR_MODULE_NOT_FOUND for its own transitive deps —
  // an environment fault, not a parity fault. Skipped for the same reason a missing build is:
  // the check is about the two implementations agreeing, and neither can be evaluated at all.
  // Without this the suite reports a red that looks like a colour-parity break and sends the
  // next reader hunting through logger.ts for a bug that is not there.
  try {
    await import(new URL("../packages/core/dist/logger.js", import.meta.url).href);
  } catch (err) {
    t.diagnostic(`skipped: packages/core/dist/logger.js is not loadable (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  const probe = `
    import { createLogger } from ${JSON.stringify(dist.href)};
    const lines = [];
    createLogger({ level: "warn", out: (l) => lines.push(l) }).warn("probe");
    process.stdout.write(lines[0]);
  `;
  const escaped = (s) => /\u001b\[/.test(s);
  // `--list` is a pure query: no step runs, so probing the real script is safe and fast.
  const gateScript = new URL("./verify.mjs", import.meta.url);

  // Each case starts from a scrubbed baseline ({@link colorEnv}) so the expected verdict
  // depends only on the variable under test. Without the scrub, the case that expects
  // colour *on* inherits an ambient `CI` or `NO_COLOR` from whatever shell or CI job runs
  // this suite — and this suite runs as a gate step in CI, where `CI` is always set.
  const cases = [
    ["NO_COLOR wins over FORCE_COLOR", { ...colorEnv(), NO_COLOR: "1", FORCE_COLOR: "1" }, false],
    ["NO_COLOR is honoured when empty", { ...colorEnv(), NO_COLOR: "" }, false],
    ["TERM=dumb disables", { ...colorEnv(), TERM: "dumb" }, false],
    ["CI disables even with a TTY", { ...colorEnv(), CI: "true", FORCE_COLOR: "0" }, false],
    ["CI=false is still a flag-free local run", { ...colorEnv(), CI: "false" }, false],
    ["FORCE_COLOR enables despite a pipe", { ...colorEnv(), FORCE_COLOR: "1" }, true],
    ["FORCE_COLOR=0 is off", { ...colorEnv(), FORCE_COLOR: "0" }, false],
  ];

  for (const [name, env, expected] of cases) {
    const childEnv = childEnvFor(env);
    const gate = spawnSync(process.execPath, [fileURLToPath(gateScript), "--list"], {
      encoding: "utf8", env: childEnv,
    });
    assert.equal(gate.status, 0, gate.stdout + gate.stderr);
    const logger = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8", env: childEnv,
    });
    assert.equal(logger.status, 0, logger.stderr);

    assert.equal(escaped(gate.stdout), expected, `gate: ${name}`);
    assert.equal(escaped(logger.stdout), expected, `logger: ${name}`);
  }
});


// ── the false-green class itself: a gate that reports fewer checks than it declares ────────

test("NEGATIVE CONTROL: a malformed wave entry is refused, not silently dropped", (t) => {
  // The defect this pins: runWave filtered its queue on `typeof task.thunk === "function"`,
  // and every wave entry is a `[key, thunk]` ARRAY, which has no `.thunk`. All 12 wave steps
  // were discarded and the gate still printed "All 2 check(s) passed" and exited 0. The
  // normalising fix handles arrays; this case proves the OTHER half — that an entry in a
  // shape nobody anticipated now throws instead of quietly reducing the check count.
  const root = mkdtempSync(join(tmpdir(), "verify-malformed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  const gate = VERIFY_SOURCE;

  // Inject one malformed entry into the real wave list, leaving everything else intact.
  const corrupted = gate.replace(
    /await runWave\(\[\n/,
    'await runWave([\n  ["broken", { task: () => Promise.resolve({ label: "broken", passed: true, ms: 0, skipped: false, timedOut: false, log: null }) }],\n',
  );
  assert.notEqual(corrupted, gate, "the fixture must actually inject a malformed wave entry");
  writeFileSync(join(root, "scripts", "verify.mjs"), corrupted);

  // Run it for real: `--list` answers a query and returns before any wave is dispatched, so
  // only an actual run can reach the validation. A malformed entry must abort with the
  // message, and the run must not print a pass on the way out.
  const child = spawnSync(process.execPath, [join(root, "scripts", "verify.mjs"), "--only=workflow lint"], {
    cwd: root, encoding: "utf8",
  });
  assert.match(child.stderr + child.stdout, /runWave: every entry must be/, "a malformed entry must be refused");
  assert.doesNotMatch(child.stdout, /All \d+ check\(s\) passed/, "a refused run must not report a pass");
});

test("NEGATIVE CONTROL: an unqualified run must produce a result for every declared step", (t) => {
  // The summary count is derived from `results`, which only steps that ran can populate — so
  // it can never detect a step that was dropped, and "All N check(s) passed" would state what
  // survived rather than what was promised. This deletes one declared step's dispatch and
  // requires exit 2 naming it. The stubbed layout cannot run any step for real, so every
  // step is reported missing; what this pins is that the run REFUSES rather than passing
  // with a smaller number, and that the removed step appears by name in the verdict.
  const root = mkdtempSync(join(tmpdir(), "verify-incomplete-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "foundry-scope.json"), JSON.stringify({ unitExclude: ".*Invariant|.*Fork" }));

  // Remove the `typecheck` entry from wave 2, leaving every other line intact.
  const entry = '  ["typecheck", () => run(labelOf("typecheck"), NPM[0], [...NPM[1], "run", "lint", "--workspaces", "--if-present"])],';
  const corrupted = VERIFY_SOURCE.replace(`${entry}\n`, "");
  assert.notEqual(corrupted, VERIFY_SOURCE, "the fixture must actually remove a declared step");
  writeFileSync(join(root, "scripts", "verify.mjs"), corrupted);

  // No --no-forge / --quick / --only here: the completeness guard applies to the
  // UNQUALIFIED run, which is what CI's assurance job executes. Adding any of those flags
  // would legitimately narrow the scope and bypass the very check under test.
  const child = spawnSync(process.execPath, [join(root, "scripts", "verify.mjs")], {
    cwd: root, encoding: "utf8", timeout: 90_000,
  });
  assert.equal(child.status, 2, `an incomplete run must exit 2\n${child.output.slice(0, 600)}`);
  const verdict = JSON.parse((child.stdout.match(/^\{"gate":"verify".*$/m) ?? ["{}"])[0]);
  assert.equal(verdict.verdict, "incomplete", "the verdict must say the run was incomplete");
  assert.ok(
    Array.isArray(verdict.missing) && verdict.missing.includes("typecheck"),
    `the removed step must be named in the verdict: ${JSON.stringify(verdict.missing)}`,
  );
  assert.doesNotMatch(child.stdout, /All \d+ check\(s\) passed/, "an incomplete run must not report a pass");
});
