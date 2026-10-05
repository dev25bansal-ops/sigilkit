import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The first tests for validate-workflows.mjs.
 *
 * This script is a gate in two places — `npm run verify`'s `lint` step and CI's
 * `workflow-lint` job — and until now nothing tested it. `assurance-inventory.test.mjs` and
 * `verify.test.mjs` both mention the filename, but only as a string inside a fixture or an
 * expected log line; neither ever executed it. So the whole defect class it exists to catch
 * (a workflow that GitHub silently refuses to load) was unguarded by tests.
 *
 * The script is not importable — it reads `.github/workflows` relative to its own location and
 * calls `process.exit` at module scope — so every test runs the real CLI in a throwaway
 * repository containing a real copy of it. It needs the `yaml` package to parse, so the
 * fixture's `node_modules` is resolved from the real repository (a symlink would be
 * cross-platform-hostile, so a directory junction is used on Windows and a symlink elsewhere).
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_SRC = join(REPO_ROOT, "scripts", "validate-workflows.mjs");

/** A minimal, valid workflow — the baseline every mutation starts from. */
const VALID = `name: ok
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - run: npm ci
`;

/**
 * A repository with the script and a `.github/workflows/` holding `files`.
 *
 * `yaml` is resolved by the script from its own location, so the fixture needs a
 * `node_modules` that leads to the real one. The fixture therefore lives *inside the
 * repository tree* rather than under `os.tmpdir()`: `os.tmpdir()` is frequently on a different
 * Windows volume (`C:` vs `D:`), and a directory junction cannot span volumes, so a tmpdir
 * fixture silently fails to resolve `yaml` and every assertion then fails for the wrong reason.
 * A per-run unique directory under the repo keeps resolution working and is still hermetic —
 * nothing here reads or writes a tracked file.
 */
function fixture(t, files = { "ok.yml": VALID }) {
  const root = mkdtempSync(join(REPO_ROOT, "outputs", "tmp-workflows-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "scripts", "validate-workflows.mjs"), readFileSync(SCRIPT_SRC));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, ".github", "workflows", name), content);
  }
  return root;
}

function run(root) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "validate-workflows.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

// ── the happy path ────────────────────────────────────────────────────────────

test("validate-workflows: a well-formed workflow passes and names the files", (t) => {
  const r = run(fixture(t));
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /workflow validation OK — 1 file\(s\): ok\.yml/);
});

test("validate-workflows: the real repository's workflows are valid", () => {
  // The gate is only worth anything if it is actually green on the tree it guards. This also
  // fails loudly if someone adds a workflow the validator rejects, which is the point.
  const result = spawnSync(process.execPath, [SCRIPT_SRC], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// ── layer 1: YAML parse errors ────────────────────────────────────────────────

test("validate-workflows: an unparseable workflow fails with a file:line pointer", (t) => {
  // The regression the script was written for: a mis-indented step made ci.yml unparseable,
  // and GitHub rejects the WHOLE file rather than skipping the step.
  //
  // A tab indent is the reliable way to produce a genuine *parse* error (a merely uneven
  // indent still parses, and then gets caught by layer 2 instead — which is fine, but is a
  // different assertion).
  const r = run(fixture(t, { "bad.yml": "name: bad\non: push\njobs:\n\tbuild:\n\t\truns-on: x\n" }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /workflow validation FAILED/);
  assert.match(r.output, /YAML parse error/);
  assert.match(r.output, /bad\.yml:\d+:\d+/, "a parse failure must carry a file:line:col pointer");
});

test("validate-workflows: a mis-indented job is caught even though the YAML still parses", (t) => {
  // The same defect, caught one layer later. Pinned separately because "the YAML happened to
  // parse" is exactly the case where a naive reviewer assumes the file is fine.
  const r = run(fixture(t, { "bad.yml": "name: bad\non: push\njobs:\n  a:\n   runs-on: x\n  b:\n" }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /job has no `steps` list|job is not a mapping/);
});

// ── layer 2: structural shape ─────────────────────────────────────────────────

test("validate-workflows: a step folded into a working-directory scalar is caught", (t) => {
  // The subtle variant where the YAML *does* parse but a step has been swallowed into a
  // scalar. GitHub would run the job with that step silently missing.
  //
  // The scalar has to be quoted, otherwise `yaml` rejects it at layer 1 with "Nested mappings
  // are not allowed in compact mappings" and the run never reaches the layer-2 check this test
  // exists to cover. Quoting produces exactly the shape layer 2 looks for.
  const folded = `name: bad
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
        working-directory: "packages/core - uses: actions/upload-artifact@v4"
`;
  const r = run(fixture(t, { "folded.yml": folded }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /swallowed a following step/);
});

test("validate-workflows: a folded step is caught by the parser when it is not quoted", (t) => {
  // The same real-world mis-indent, unquoted. It is rejected at layer 1 rather than layer 2 —
  // either way it fails, which is the property that matters. Asserted so that a future change
  // to the layer-2 heuristic cannot be mistaken for the only line of defence.
  const folded = `name: bad
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
        working-directory: packages/core - uses: actions/upload-artifact@v4
`;
  const r = run(fixture(t, { "folded.yml": folded }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /YAML parse error|swallowed a following step/);
});

test("validate-workflows: a step with neither `uses` nor `run` is caught", (t) => {
  const r = run(fixture(t, {
    "norun.yml": "name: bad\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: does nothing\n",
  }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /neither `uses` nor `run`/);
});

test("validate-workflows: a step declaring both `uses` and `run` is caught", (t) => {
  const r = run(fixture(t, {
    "both.yml": "name: bad\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        run: npm ci\n",
  }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /both `uses` and `run`/);
});

test("validate-workflows: a job with no steps is caught", (t) => {
  const r = run(fixture(t, { "nosteps.yml": "name: bad\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n" }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /job has no `steps` list/);
});

test("validate-workflows: a workflow with no jobs mapping is caught", (t) => {
  const r = run(fixture(t, { "nojobs.yml": "name: bad\non: push\n" }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /no `jobs` mapping/);
});

// ── the two fail-closed environmental cases ──────────────────────────────────

test("validate-workflows: a missing workflow directory fails instead of passing vacuously", (t) => {
  // "No workflows found" must not read as "validation OK". A guard that passes when there is
  // nothing to check is worse than no guard, because it is green.
  const root = mkdtempSync(join(REPO_ROOT, "outputs", "tmp-workflows-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "validate-workflows.mjs"), readFileSync(SCRIPT_SRC));

  const result = spawnSync(process.execPath, [join(root, "scripts", "validate-workflows.mjs")], {
    cwd: root, encoding: "utf8", timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /no workflow directory/);
});

test("validate-workflows: a directory with no .yml files also fails, not vacuously", (t) => {
  const root = mkdtempSync(join(REPO_ROOT, "outputs", "tmp-workflows-noyml-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "scripts", "validate-workflows.mjs"), readFileSync(SCRIPT_SRC));
  writeFileSync(join(root, ".github", "workflows", "README.md"), "# not a workflow\n");

  const result = spawnSync(process.execPath, [join(root, "scripts", "validate-workflows.mjs")], {
    cwd: root, encoding: "utf8", timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /no workflow files found/);
});

// ── reporting quality ─────────────────────────────────────────────────────────

test("validate-workflows: every problem is reported, not just the first", (t) => {
  // "Exit on first failure" is a reasonable design for a compiler and a bad one for a gate:
  // fixing a workflow one error per run is the frustrating loop this script exists to end.
  const r = run(fixture(t, {
    "a.yml": "name: a\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: nothing\n",
    "b.yml": "name: b\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        run: npm ci\n",
  }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /2 problem\(s\)/, `both problems must be reported:\n${r.output}`);
  assert.match(r.output, /a\.yml/);
  assert.match(r.output, /b\.yml/);
});

test("validate-workflows: .yaml is accepted as well as .yml", (t) => {
  // A silent extension filter would make a `.yaml` workflow completely unchecked — the exact
  // "guard that is not running" failure the script documents.
  const r = run(fixture(t, { "ok.yaml": VALID }));
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /1 file\(s\): ok\.yaml/);
});

test("validate-workflows: files are visited in sorted order, so the report is stable", (t) => {
  const r = run(fixture(t, { "b.yml": VALID, "a.yml": VALID, "c.yml": VALID }));
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /a\.yml, b\.yml, c\.yml/, `report order must be deterministic:\n${r.output}`);
});
