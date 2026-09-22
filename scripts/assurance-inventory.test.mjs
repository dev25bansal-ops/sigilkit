import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  KIND,
  SCHEMA,
  buildInventory,
  countPropertiesInSource,
  parseWorkflowJobs,
  returnsBool,
  scanFunctionDeclarations,
} from "./assurance-inventory.mjs";

const SCRIPT = fileURLToPath(new URL("./assurance-inventory.mjs", import.meta.url));

/** Runs the CLI against a fixture root and returns parsed stdout plus raw text. */
function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  assert.ifError(result.error);
  return { status: result.status, raw: result.stdout, stderr: result.stderr };
}

/** Creates an isolated repository layout under the OS temp dir. */
function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-assurance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** Every file below `dir`, root-relative, so a read-only claim can be checked. */
function tree(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tree(full, base));
    else out.push(full.slice(base.length));
  }
  return out.sort();
}

test("scanFunctionDeclarations finds declarations and ignores comments", () => {
  const source = `
    // function check_notReal() public {}
    /* function check_alsoNotReal() public {} */
    string constant NOTE = "function check_stringLiteral() public {}";
    function check_real(uint256 x) public pure returns (bool) { return x > 0; }
    function helper() internal {}
  `;
  const names = scanFunctionDeclarations(source).map((d) => d.name);
  assert.deepEqual(names, ["check_real", "helper"]);
});

test("scanFunctionDeclarations spans multi-line signatures", () => {
  const source = `
    function check_spread(
        uint256 a,
        uint256 b
    ) public pure returns (bool) {
        return a == b;
    }
  `;
  const [declaration] = scanFunctionDeclarations(source);
  assert.equal(declaration.name, "check_spread");
  assert.equal(returnsBool(declaration.signature), true);
  assert.match(declaration.signature, /uint256 b/);
});

test("returnsBool distinguishes bool properties from assertion-style specs", () => {
  assert.equal(returnsBool("function check_x() public pure returns (bool)"), true);
  assert.equal(returnsBool("function check_x() public pure returns (bool ok)"), true);
  assert.equal(returnsBool("function check_x() public"), false);
  assert.equal(returnsBool("function echidna_sink() external payable"), false);
});

test("countPropertiesInSource counts check_ and echidna_ separately", () => {
  const source = `
    function check_void() public {}
    function check_bool() public pure returns (bool) { return true; }
    function check_secondBool() public view returns (bool ok) { return true; }
    function echidna_prop() public view returns (bool) { return true; }
    function echidna_sink() external payable {}
    function unrelated_check() public {}
  `;
  const counts = countPropertiesInSource(source);
  assert.deepEqual(counts["check_"], { functions: 3, boolFunctions: 2 });
  assert.deepEqual(counts["echidna_"], { functions: 2, boolFunctions: 1 });
});

test("parseWorkflowJobs reads job ids and display names in file order", () => {
  const workflow = `
name: SigilKit CI
on:
  pull_request:
jobs:
  # a leading comment must not become a job
  workflow-lint:
    name: Workflow lint (actionlint)
    runs-on: ubuntu-latest
    steps:
      - name: Validate workflow YAML
        run: node scripts/validate-workflows.mjs
  slither:
    name: "Slither static analysis"
    runs-on: ubuntu-latest
  unnamed-job:
    runs-on: ubuntu-latest
  echidna-nightly:
    name: Echidna property fuzzing (nightly)
    if: github.event_name == 'workflow_dispatch'
`;
  assert.deepEqual(parseWorkflowJobs(workflow), [
    { id: "workflow-lint", name: "Workflow lint (actionlint)" },
    { id: "slither", name: "Slither static analysis" },
    { id: "unnamed-job", name: null },
    { id: "echidna-nightly", name: "Echidna property fuzzing (nightly)" },
  ]);
});

test("parseWorkflowJobs returns nothing without a top-level jobs block", () => {
  assert.deepEqual(parseWorkflowJobs("name: Publish\non:\n  release:\n    types: [published]\n"), []);
});

test("buildInventory reports source counts, CI job names and static evidence", (t) => {
  const root = fixture(t, {
    "contracts/src/SpendPolicy.sol": "contract SpendPolicy { function enforce() internal {} }",
    "contracts/test/Halmos.t.sol": `
      function check_enforce_Reverts_WhenOverCap() public {}
      function check_merkle_IsIdentity(bytes32 leaf) public pure {}
    `,
    "contracts/test/EchidnaProperties.t.sol": `
      function echidna_windowSpendUnderCap() public view returns (bool) { return true; }
      function echidna_sink() external payable {}
    `,
    ".github/workflows/ci.yml": "name: CI\njobs:\n  forge-unit:\n    name: Forge unit + fuzz\n  halmos:\n    name: Halmos symbolic verification\n",
  });
  const inventory = buildInventory(root);

  assert.equal(inventory.kind, KIND);
  assert.equal(inventory.schema, SCHEMA);
  assert.equal(inventory.source.filesScanned, 3);
  assert.equal(inventory.source.halmos.functions, 2);
  assert.equal(inventory.source.halmos.boolFunctions, 0);
  assert.equal(inventory.source.halmos.files["contracts/test/Halmos.t.sol"].functions, 2);
  assert.equal(inventory.source.echidna.functions, 2);
  assert.equal(inventory.source.echidna.boolFunctions, 1);

  assert.deepEqual(inventory.ci.jobNames, ["Forge unit + fuzz", "Halmos symbolic verification"]);
  assert.equal(inventory.ci.jobCount, 2);

  assert.equal(inventory.evidence.kind, "STATIC_INVENTORY");
  assert.equal(inventory.evidence.executed.halmos, false);
  assert.equal(inventory.evidence.executed.slither, false);
  assert.equal(inventory.evidence.ciStatusInferred, false);
  assert.equal(inventory.tool.readOnly, true);
  // No git repository in the fixture: the absence is reported, not fabricated.
  assert.equal(inventory.git.available, false);
});

test("CLI prints parseable JSON to stdout and leaves the tree untouched", (t) => {
  const root = fixture(t, {
    "contracts/test/Halmos.t.sol": "function check_a() public {}\n",
    ".github/workflows/ci.yml": "name: CI\njobs:\n  forge-unit:\n    name: Forge unit + fuzz\n",
  });
  const before = tree(root);
  const result = runCli(["--root", root]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.raw);
  assert.equal(parsed.kind, "STATIC_INVENTORY");
  assert.equal(parsed.source.halmos.functions, 1);
  assert.deepEqual(parsed.ci.jobNames, ["Forge unit + fuzz"]);
  assert.deepEqual(tree(root), before, "inventory must not write to the inspected tree");
});

test("CLI --compact emits a single JSON line", (t) => {
  const root = fixture(t, { "contracts/test/Halmos.t.sol": "function check_a() public {}\n" });
  const result = runCli(["--root", root, "--compact"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.raw.trimEnd().split("\n").length, 1);
  assert.equal(JSON.parse(result.raw).kind, "STATIC_INVENTORY");
});

test("CLI --help documents the STATIC_INVENTORY mode", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.raw, /Mode: STATIC_INVENTORY/);
  assert.match(result.raw, /Halmos and Slither are not run/);
});

test("CLI rejects unknown arguments", () => {
  const result = runCli(["--nope"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument: --nope/);
});

test("CLI defaults to this repository and reports a dirty-aware git block", () => {
  const result = runCli([]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.raw);
  assert.equal(parsed.kind, "STATIC_INVENTORY");
  assert.ok(parsed.source.filesScanned > 0);
  assert.ok(parsed.ci.jobCount > 0);
  assert.equal(parsed.evidence.executed.halmos, false);
  assert.equal(parsed.evidence.executed.slither, false);
  assert.equal(parsed.evidence.ciStatusInferred, false);
});
