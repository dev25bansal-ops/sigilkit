import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Run the real CLI from an isolated repository layout so no gate step can touch this repo.
// `verify.mjs` derives ROOT from its own location, so a copy under <tmp>/scripts/ is enough.
function runVerify(t, extraArgs = [], files = {}) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./verify.mjs", import.meta.url), join(root, "scripts/verify.mjs"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const result = spawnSync(process.execPath, [join(root, "scripts/verify.mjs"), ...extraArgs], {
    cwd: root, encoding: "utf8",
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
}

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
  assert.match(r.stderr, /workflow lint/);
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

test("skips respect the selector", (t) => {
  const r = runVerify(t, ["--only=workflow lint", "--quick"], STUB_LINT);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /▶ workflow lint/);
  assert.doesNotMatch(r.stdout, /contract tests/);
  assert.match(r.stdout, /All 1 check\(s\) passed\./);
});
