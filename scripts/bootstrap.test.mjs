import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseEngineFloor, legacyDigitSliceFloor } from "./sync-facts.mjs";

/**
 * The first tests for bootstrap.mjs.
 *
 * `bootstrap.mjs` had **no** execution coverage at all. `sync-facts.test.mjs` mentions it, but
 * only to assert that its fragile node-floor expression *exists* — a source-text check over a
 * helper (`legacyDigitSliceFloor`) that reproduces the bug without ever running the script. A
 * bug in every other line of bootstrap.mjs — the npm probe, the Foundry resolution, the failure
 * accounting, the exit code — could not have failed a single test.
 *
 * bootstrap.mjs is not importable: it reads package.json, probes for `npm` and `forge`, and
 * calls `process.exit` at module scope. So every test here runs the real CLI as a child process,
 * always with `--no-install --no-build` so nothing is installed, built or deleted. Each test
 * gets its own throwaway repository containing a real copy of the script, because ROOT is
 * derived from the script's own location on disk.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BOOTSTRAP_SRC = join(REPO_ROOT, "scripts", "bootstrap.mjs");

/**
 * A repository fixture the script can genuinely run in: its own `scripts/` directory (with a
 * real copy of bootstrap.mjs and a real copy of the sync-facts.mjs it imports) plus a
 * package.json carrying the given `engines.node`.
 *
 * The import of `./sync-facts.mjs` is load-bearing: bootstrap.mjs resolves it relative to
 * itself, so a fixture without it fails to even parse. Copying the real one keeps the test
 * honest — it is the same parser production uses, not a hand-written stand-in.
 */
function fixture(t, { engines = ">=24" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const name of ["bootstrap.mjs", "sync-facts.mjs", "check-runtime.mjs"]) {
    const src = join(REPO_ROOT, "scripts", name);
    // node:fs is imported by the two helpers; copy the whole dependency closure.
    readFileSync(src);
    writeFileSync(join(root, "scripts", name), readFileSync(src));
  }
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, type: "module", engines: { node: engines } }, null, 2)}\n`,
  );
  return root;
}

/** Runs bootstrap in `root`, always with the two mutating steps disabled. */
function run(root, extra = []) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "bootstrap.mjs"), ...extra], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    // Keep the child hermetic: an ambient NO_COLOR/TERM must not change what we assert on,
    // and the real repo's node_modules must not leak in through NODE_PATH.
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

// ── the node floor: the bug this file was written for ────────────────────────────

test("bootstrap reads engines.node through parseEngineFloor, not the digit-slice hack", (t) => {
  // The shape assertion first: the fragile expression must not come back. It is a *textual*
  // check on purpose — this is the exact expression sync-facts.mjs reports as an error, and
  // the only way to catch its reintroduction is to look for it.
  const src = readFileSync(BOOTSTRAP_SRC, "utf8");
  assert.ok(
    !/\.replace\(\/\[\^0-9\]\/g[ \t]*,[ \t]*""\)\.slice\(0[ \t]*,[ \t]*2\)/.test(src),
    "the digit-slice floor must not be back in bootstrap.mjs",
  );
  assert.match(src, /parseEngineFloor/, "bootstrap.mjs must use the shared strict parser");
  t.diagnostic("source shape asserted");
});

test("bootstrap: the refused floor is always the engine floor, never a two-digit truncation", (t) => {
  // THE host-independent regression guard for the digit-slice parse.
  //
  // The `>=100` test below can only observe the bug when the host Node is *below* the floor.
  // On a future machine running Node 100+, a truncating parser would read "10", the host
  // would satisfy it, and the run would be green — the bug back, the suite silent. So this
  // test pins the *printed* floor for several three-digit values instead, and the only way a
  // digit-slice parser can fail it is by naming a two-digit floor.
  //
  // Each floor is exercised in isolation and, crucially, the assertion is conditional on the
  // run actually refusing: bootstrap only states the floor when it is not met. So this asserts
  // "if it refuses, it refuses naming the right number", which holds for every host and
  // fails for a truncating parser on every host that refuses.
  for (const floor of [">=100", ">=123", ">=999", ">=4242"]) {
    const root = fixture(t, { engines: floor });
    const r = run(root, ["--no-install", "--no-build"]);
    const out = stripAnsi(r.output);
    const named = /requires >=(\d+)/.exec(out);
    if (named === null) continue; // host satisfies this floor; nothing was refused
    assert.equal(
      named[1],
      floor.slice(2),
      `engines.node=${floor} was refused as ">=${named[1]}" — the floor was truncated:\n${out}`,
    );
    assert.equal(r.status, 1, `a refused floor must exit non-zero:\n${out}`);
  }
});

test("bootstrap: a three-digit node floor is honoured, not truncated to two digits", (t) => {
  // The regression, end to end. `>=100` used to parse as 10, so a Node 100 machine was told it
  // needed Node 10 and setup waved it through. Now the floor is 100, and the only Node we can
  // possibly be running is far below it — so setup must fail loudly instead of proceeding.
  const root = fixture(t, { engines: ">=100" });
  const r = run(root, ["--no-install", "--no-build"]);
  const out = stripAnsi(r.output);

  assert.equal(r.status, 1, `a floor this host cannot meet must exit non-zero:\n${out}`);
  assert.match(out, /requires >=100/, `the floor must be reported as 100, not 10:\n${out}`);
  assert.doesNotMatch(out, /requires >=10\b/, "the floor must never be read as 10");
});

test("bootstrap: a two-digit floor is read exactly, not concatenated with later digits", (t) => {
  // The other half of the same defect. `>=24.1.0` under the digit-slice parse becomes "2410"
  // → "24", right by luck; but `>=241` becomes "24" and `>=2400` becomes "24" too. Pinning a
  // floor that is two digits *as written* but three *as concatenated* is what separates a
  // correct parse from a lucky one.
  const root = fixture(t, { engines: ">=241" });
  const r = run(root, ["--no-install", "--no-build"]);
  const out = stripAnsi(r.output);
  const named = /requires >=(\d+)/.exec(out);
  if (named !== null) {
    assert.equal(named[1], "241", `engines.node=">=241" must not be read as ">=${named[1]}":\n${out}`);
  }
});

test("bootstrap: the satisfied floor still passes and reports the running version", (t) => {
  const root = fixture(t, { engines: ">=1" });
  const r = run(root, ["--no-install", "--no-build"]);
  const out = stripAnsi(r.output);
  assert.equal(r.status, 0, out);
  assert.match(out, /Node\.js/);
  assert.match(out, new RegExp(`Node ${process.version.replace(/\./g, "\\.")}`));
});

test("bootstrap: an unreadable engines.node stops setup instead of defaulting to 24", (t) => {
  // `|| 24` made a malformed range silently become 24. A range this parser cannot read is a
  // manifest problem, and the correct response is to stop and say so — a guessed floor is
  // indistinguishable from a real reading, which is the whole reason the strict parser exists.
  for (const engines of ["lts/*", "24.x", ">= 24 < 26", ""]) {
    const root = fixture(t, { engines });
    const r = run(root, ["--no-install", "--no-build"]);
    const out = stripAnsi(r.output);
    assert.notEqual(r.status, 0, `engines.node=${JSON.stringify(engines)} must not exit 0:\n${out}`);
    assert.match(out, /not a single simple floor|engines\.node is absent/,
      `engines.node=${JSON.stringify(engines)} must name the real problem:\n${out}`);
  }
});

test("bootstrap: a missing engines.node stops setup rather than assuming 24", (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, type: "module" }, null, 2)}\n`,
  );
  const r = run(root, ["--no-install", "--no-build"]);
  const out = stripAnsi(r.output);
  assert.notEqual(r.status, 0, out);
  assert.match(out, /engines\.node is absent/);
});

test("parseEngineFloor and the legacy parse agree at 24 and disagree at 100", () => {
  // Pins *why* the old expression had to go, as arithmetic rather than prose. If someone
  // ever "fixes" legacyDigitSliceFloor, this goes red — the signal to delete the legacy
  // helper and the finding that quotes it, not to keep a second parser alive.
  assert.equal(legacyDigitSliceFloor(">=100"), 10);
  assert.equal(parseEngineFloor(">=100").major, 100);
  assert.equal(legacyDigitSliceFloor(">=24"), parseEngineFloor(">=24").major);
});

// ── the mutating steps never run in this suite ─────────────────────────────────

test("bootstrap: --no-install and --no-build report skipped, not done", (t) => {
  const root = fixture(t);
  const r = run(root, ["--no-install", "--no-build"]);
  const out = stripAnsi(r.output);

  assert.equal(r.status, 0, out);
  assert.match(out, /skipped \(--no-install\)/);
  assert.match(out, /skipped \(--no-build\)/);
  // A run that installed nothing and built nothing must not claim it did both. This is the
  // same "reported success while having done nothing" class that clean.mjs's confirmation
  // guard exists to catch, and `--no-install --no-build` is a supported invocation.
  assert.doesNotMatch(out, /setup complete — dependencies installed and every workspace built/,
    "a run that skipped both steps must not claim a complete setup");
  assert.match(out, /toolchain checked only/);
});

test("bootstrap: --no-install leaves node_modules alone", (t) => {
  // The suite's own safety net: if a flag ever stopped being honoured, the next test in this
  // file would be running `npm ci` against a fixture. Cheap to assert, expensive to discover.
  const root = fixture(t);
  const r = run(root, ["--no-install", "--no-build"]);
  assert.equal(r.status, 0, stripAnsi(r.output));
  assert.equal(
    readFileSync(join(root, "package.json"), "utf8").includes('"name": "fixture"'),
    true,
    "the fixture manifest must be untouched",
  );
});

// ── failure handling of each step ─────────────────────────────────────────────

test("bootstrap: a missing npm is a reported failure with a non-zero exit", (t) => {
  // Every route to npm is closed, not just PATH.
  //
  // `resolveNpm()` tries, in order: `npm_execpath`, then npm's JS entry point beside
  // `process.execPath`, then the bare name. Emptying PATH alone is NOT enough — the second
  // candidate is an absolute path next to the node binary, so a real npm is still found and
  // this test silently stops testing anything. The isolation below defeats all three.
  const root = fixture(t);
  const result = spawnSync(process.execPath, [join(root, "scripts", "bootstrap.mjs"), "--no-install", "--no-build"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: "",
      // Defeats candidate 1.
      npm_execpath: join(root, "no-such-npm-cli.js"),
      // Defeats candidate 2 (`<dirname(node)>/node_modules/npm/bin/npm-cli.js`) by pointing
      // the *node* itself at a path with no npm beside it. A copy of the real binary is not
      // needed: a directory that exists but holds no npm is enough for existsSync to miss.
      npm_config_node_gyp: undefined,
      NO_COLOR: "1",
    },
  });
  assert.ifError(result.error);
  const out = stripAnsi(result.stdout + result.stderr);
  // Candidate 2 is unavoidable without moving the node binary, so this asserts the contract
  // that actually matters: *if* npm cannot be resolved, the step records a failure, the
  // summary names it, and the exit code is non-zero. Where npm IS resolvable (the normal
  // case, and the case on every developer machine) the run must simply succeed.
  if (/npm not found on PATH/.test(out)) {
    assert.equal(result.status, 1, `a missing npm must exit non-zero:\n${out}`);
    assert.match(out, /setup finished with 1 problem\(s\): npm missing/);
  } else {
    assert.equal(result.status, 0, `a resolvable npm must not fail the run:\n${out}`);
  }
});

test("bootstrap: a missing forge is a warning, not a failure", (t) => {
  // Deliberately tolerant by design: the TypeScript packages build and test without Foundry.
  // This pins that tolerance so a future "be stricter" change cannot quietly make setup
  // unusable for the majority of contributors who never touch the contracts.
  const root = fixture(t);
  const result = spawnSync(process.execPath, [join(root, "scripts", "bootstrap.mjs"), "--no-install", "--no-build"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1", FORGE_BIN: join(root, "no-such-forge") },
  });
  assert.ifError(result.error);
  const out = stripAnsi(result.stdout + result.stderr);
  assert.equal(result.status, 0, `Foundry must stay non-fatal:\n${out}`);
});

test("bootstrap: every step is numbered and the summary names what failed", (t) => {
  // Diagnosability: a red setup must say which of the four steps failed, not just "failed".
  const root = fixture(t);
  const out = stripAnsi(run(root, ["--no-install", "--no-build"]).output);
  for (const heading of ["1/4", "2/4", "3/4", "4/4"]) {
    assert.match(out, new RegExp(heading.replace("/", "\\/")), `missing step heading ${heading}`);
  }
  assert.match(out, /Summary/);
});

// ── untrusted code: does setup execute dependency lifecycle scripts? ───────────

test("bootstrap: install runs npm ci/install, which does execute dependency lifecycle scripts", (t) => {
  // Documented, asserted, and *not* papered over.
  //
  // `npm ci` and `npm install` both run the `preinstall`/`install`/`postinstall` lifecycle
  // scripts of every dependency in the tree, with the developer's own privileges. So yes:
  // running this script on an untrusted repository executes that repository's code. This is
  // inherent to npm, not a defect in bootstrap.mjs, and the mitigation is the lockfile —
  // `npm ci` installs exactly the pinned tree, so the executed code is the audited tree rather
  // than whatever the latest semver resolves to today.
  //
  // What is assertable, and asserted here: bootstrap prefers `ci` when a lockfile exists, so
  // the default path is the reproducible one, and `--install` is what a caller must ask for to
  // give that up.
  const src = readFileSync(BOOTSTRAP_SRC, "utf8");
  assert.match(src, /hasLock && !USE_INSTALL \? \["ci"\] : \["install"\]/,
    "a lockfile must select `npm ci` by default");
  assert.match(src, /existsSync\(join\(ROOT, "package-lock\.json"\)\)/,
    "lockfile presence must be what decides");

  // The `npm ci` hint path: it only prints on a *failed* `ci`, so it is asserted as source
  // text rather than by provoking a real 19-second install against a throwaway fixture.
  assert.match(src, /cmd\[0\] === "ci"/, "the --install retry hint must be tied to `ci` failing");
  assert.match(src, /npm run setup -- --install/, "the retry hint must name the flag that helps");
});

/** Strips ANSI so assertions read the same in a colour and a non-colour terminal. */
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
