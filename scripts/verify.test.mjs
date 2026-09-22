import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Run the real CLI from an isolated repository layout so no gate step can touch this repo.
// `verify.mjs` derives ROOT from its own location, so a copy under <tmp>/scripts/ is enough.
function runVerify(t, extraArgs = [], files = {}, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./verify.mjs", import.meta.url), join(root, "scripts/verify.mjs"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [join(root, "scripts/verify.mjs"), ...extraArgs], {
    cwd: root, encoding: "utf8", env: childEnv,
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
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
