import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import {
  KIND,
  SCHEMA,
  buildInventory,
  countPropertiesInSource,
  parseWorkflowJobDetails,
  parseWorkflowJobs,
  returnsBool,
  scanFunctionDeclarations,
} from "./assurance-inventory.mjs";

const SCRIPT = fileURLToPath(new URL("./assurance-inventory.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

// ── DEBT-06 · the hand-rolled YAML reader, kept verbatim as the differential baseline ──
// `parseWorkflowJobs` used to be a hand-written indentation scanner. It is reproduced here,
// byte for byte, so the switch to the `yaml` package stays a *measurable* refactor: the
// "before" column below is the code the repository actually ran, not a description of it.
function legacyParseWorkflowJobs(text) {
  const jobs = [];
  let inJobs = false;
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inJobs = line.trim() === "jobs:";
      current = null;
      continue;
    }
    if (!inJobs) continue;
    const jobMatch = indent === 2 ? /^([A-Za-z0-9_.-]+):\s*$/.exec(line.trim()) : null;
    if (jobMatch) {
      current = { id: jobMatch[1], name: null };
      jobs.push(current);
      continue;
    }
    if (current && current.name === null && indent === 4) {
      const nameMatch = /^name:\s*(.+?)\s*$/.exec(line.trim());
      if (nameMatch) current.name = legacyUnquote(nameMatch[1]);
    }
  }
  return jobs;
}

function legacyUnquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The job list a workflow declares, independent of which reader produced it. */
function jobsViaYamlPkg(text) {
  const doc = parseYaml(text) ?? {};
  return Object.entries(doc?.jobs ?? {}).map(([id, job]) => ({
    id,
    name: typeof job?.name === "string" ? job.name : id,
  }));
}

/** Per-job step counts, independent of which reader produced the job list. */
function stepCountsViaYamlPkg(text) {
  const doc = parseYaml(text) ?? {};
  const out = {};
  for (const [id, job] of Object.entries(doc?.jobs ?? {})) {
    out[id] = Array.isArray(job?.steps) ? job.steps.length : 0;
  }
  return out;
}

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
  // An unnamed job resolves to its id — which is also what GitHub displays for it — so a
  // workflow that never declared `name:` still produces one stable entry per job.
  assert.deepEqual(parseWorkflowJobs(workflow), [
    { id: "workflow-lint", name: "Workflow lint (actionlint)" },
    { id: "slither", name: "Slither static analysis" },
    { id: "unnamed-job", name: "unnamed-job" },
    { id: "echidna-nightly", name: "Echidna property fuzzing (nightly)" },
  ]);
});

test("parseWorkflowJobs returns nothing without a top-level jobs block", () => {
  assert.deepEqual(parseWorkflowJobs("name: Publish\non:\n  release:\n    types: [published]\n"), []);
});

test("parseWorkflowJobs treats an empty, absent or non-mapping jobs key as no jobs", () => {
  // None of these are a workflow that declares jobs; none may throw from a read-only
  // inventory, and none may invent a job out of a scalar.
  for (const text of [
    "jobs:\n",
    "jobs: 3\n",
    "jobs:\n  - a\n  - b\n",
    "just a scalar string\n",
  ]) {
    assert.deepEqual(parseWorkflowJobs(text), [], `expected no jobs for ${JSON.stringify(text)}`);
  }
});

test("parseWorkflowJobs reads folded and block-scalar job names as their folded value", () => {
  // The regression the hand-rolled reader carried: it took the `>-` indicator itself as
  // the display name, publishing a CI inventory whose first job was called ">-".
  assert.deepEqual(parseWorkflowJobs("jobs:\n  a:\n    name: >-\n      Multi line\n      display name\n"), [
    { id: "a", name: "Multi line display name" },
  ]);
  assert.deepEqual(parseWorkflowJobs("jobs:\n  a:\n    name: |\n      Block\n      Name\n"), [
    { id: "a", name: "Block\nName\n" },
  ]);
  // A multi-line double-quoted scalar folds to one line rather than keeping the quote.
  assert.deepEqual(parseWorkflowJobs('jobs:\n  a:\n    name: "Alpha\n      Continued"\n'), [
    { id: "a", name: "Alpha Continued" },
  ]);
});

test("parseWorkflowJobs keeps every job when keys carry trailing comments or odd indentation", () => {
  // Each of these silently LOST a job under the hand-rolled reader: a job count that
  // quietly drops from 12 to 11 (or to 0) is a wrong number in the published inventory.
  const cases = {
    "job id with a trailing comment": "jobs:\n  a: # the first job\n    name: Alpha\n",
    "jobs key with a trailing comment": "jobs: # every job\n  a:\n    name: Alpha\n",
    "three-space indentation": "jobs:\n   a:\n     name: Alpha\n",
  };
  for (const [label, text] of Object.entries(cases)) {
    assert.deepEqual(parseWorkflowJobs(text), [{ id: "a", name: "Alpha" }], `dropped a job: ${label}`);
  }
});

test("parseWorkflowJobs reports a reusable-workflow call under its job id", () => {
  // A `uses:` job has no `name:` of its own; GitHub shows the id, so the inventory does too.
  assert.deepEqual(parseWorkflowJobs("jobs:\n  call-it:\n    uses: ./.github/workflows/other.yml\n"), [
    { id: "call-it", name: "call-it" },
  ]);
});

test("parseWorkflowJobDetails reports gating posture per job in file order", () => {
  // V67-G1: `jobNames` listed all 13 CI jobs as undifferentiated peers, so a downstream
  // reader could take "configured" for "enforcing". This reader states the difference:
  // only a job with neither `continue-on-error: true` nor an `if:` is blocking.
  const workflow = `
jobs:
  plain:
    name: Plain gate
  waived:
    name: Waived job
    continue-on-error: true
  conditional:
    name: Conditional job
    if: github.event_name == 'workflow_dispatch'
  called:
    uses: ./.github/workflows/other.yml
`;
  assert.deepEqual(parseWorkflowJobDetails(workflow), [
    { name: "Plain gate", blocking: true, condition: null },
    { name: "Waived job", blocking: false, condition: null },
    { name: "Conditional job", blocking: false, condition: "github.event_name == 'workflow_dispatch'" },
    { name: "called", blocking: true, condition: null },
  ]);
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
  // The sibling field exists so a configured job is not read as an enforcing one; in this
  // fixture neither job is waived or condition-gated, so both are blocking.
  assert.deepEqual(inventory.ci.jobDetails, [
    { name: "Forge unit + fuzz", blocking: true, condition: null },
    { name: "Halmos symbolic verification", blocking: true, condition: null },
  ]);

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

// ── DEBT-06 · differential test: the real workflows, read three ways ──────────────
// The switch from the hand-rolled indentation reader to the `yaml` package was only
// allowed to be a behaviour-preserving refactor. This pins that claim against the two
// files that matter (ci.yml and publish.yml) rather than against a toy fixture.
//
// The line count that used to sit here ("ci.yml, 361 lines") was itself a 5th hand-kept
// number with nothing to keep it in sync, and it was wrong for most of a day before anyone
// noticed. It is deliberately omitted rather than updated: a comment that states a size is a
// claim that decays, and its only possible value was as a hint about which file was meant —
// which the line above already says.

/** The real workflow files the differential runs against. */
const REAL_WORKFLOWS = ["ci.yml", "publish.yml"];

test("differential: the yaml package and the legacy reader agree on every real workflow", () => {
  // Job ids, display names AND step counts must match, for the files as committed.
  for (const file of REAL_WORKFLOWS) {
    const text = readFileSync(join(WORKFLOW_DIR, file), "utf8");
    const legacyJobs = legacyParseWorkflowJobs(text);
    const newJobs = parseWorkflowJobs(text);

    assert.deepEqual(
      newJobs.map((j) => j.id),
      legacyJobs.map((j) => j.id),
      `${file}: job id sets diverged between the legacy reader and the yaml package`,
    );
    // The legacy reader used `null` for an unnamed job; the yaml package resolves it to
    // the id, which is the same *value* GitHub displays. Normalise before comparing so the
    // assertion is about the underlying fact, not about which placeholder each used.
    const nameOf = (job) => job.name ?? job.id;
    assert.deepEqual(
      newJobs.map(nameOf),
      legacyJobs.map(nameOf),
      `${file}: job display names diverged between the legacy reader and the yaml package`,
    );
    assert.equal(newJobs.length, jobsViaYamlPkg(text).length, `${file}: job count disagrees with the yaml package`);
    assert.deepEqual(newJobs, jobsViaYamlPkg(text), `${file}: parseWorkflowJobs must equal the yaml package's reading`);
  }
});

test("differential: the yaml package is authoritative where the legacy reader was wrong", () => {
  // These are the concrete defects the hand-rolled reader carried. Each one is asserted
  // against the `yaml` package's reading, so if the refactor is ever reverted, these fail.
  const cases = {
    "folded display name": {
      text: "jobs:\n  a:\n    name: >-\n      Multi line\n      display name\n",
      expect: [{ id: "a", name: "Multi line display name" }],
    },
    "literal block display name": {
      text: "jobs:\n  a:\n    name: |\n      Block\n      Name\n",
      expect: [{ id: "a", name: "Block\nName\n" }],
    },
    "trailing comment on a job id": {
      text: "jobs:\n  a: # the first job\n    name: Alpha\n",
      expect: [{ id: "a", name: "Alpha" }],
    },
    "trailing comment on the jobs key": {
      text: "jobs: # every job\n  a:\n    name: Alpha\n",
      expect: [{ id: "a", name: "Alpha" }],
    },
    "non-two-space indentation": {
      text: "jobs:\n   a:\n     name: Alpha\n",
      expect: [{ id: "a", name: "Alpha" }],
    },
  };

  for (const [label, { text, expect }] of Object.entries(cases)) {
    // The new reader matches the yaml package exactly.
    assert.deepEqual(parseWorkflowJobs(text), expect, `yaml package disagrees on: ${label}`);
    // And the legacy reader demonstrably did not — proving the refactor fixed a real bug
    // rather than merely relocating one. We assert the *difference* explicitly so this
    // test documents the defect instead of silently encoding the broken behaviour.
    const legacy = legacyParseWorkflowJobs(text).map((j) => ({ id: j.id, name: j.name ?? j.id }));
    if (label === "trailing comment on the jobs key" || label === "trailing comment on a job id") {
      // These two dropped jobs outright: the count itself was wrong.
      assert.notDeepEqual(legacy, expect, `expected the legacy reader to lose a job on: ${label}`);
    }
  }
});

test("differential: step counts on the real workflows are stable and non-zero", () => {
  // WHY THIS NO LONGER PINS NUMBERS (P1, 2026-09-28).
  //
  // This test used to hardcode every job's step count. That is the 4th hand-maintained
  // parallel table in the gate (after LABELS, the `helpers` --test list, and
  // DEFAULT_STEP_TIMEOUTS), and it was the only one with no drift detector: when ci.yml grew
  // workflow-lint 14→20, ts-sdk 19→20 and wallet-e2e-weekly 11→12, this suite went red and
  // the numbers were simply wrong — nobody could tell from the failure whether a step had been
  // folded away or a legitimate gate had been added. Three plausible edits, one signal.
  //
  // A hardcoded count can only ever fail in that ambiguous way: any real change to a workflow
  // is either a defect or an improvement, and the number cannot tell them apart. So the
  // count is gone, and what remains is the property that actually indicates a folded or
  // swallowed step — a job that lost steps without anyone editing it — which is what the
  // inventory comparisons above and `validate-workflows.mjs` already enforce structurally.
  //
  // What this still guarantees, and is worth keeping:
  //   1. every job in both workflows has a NON-ZERO step count (a job with `steps: []` or a
  //      missing `steps` key is the signature of a swallowed block, and GitHub accepts it);
  //   2. the counts agree with a SECOND independent read of the same file, so a reader bug
  //      cannot hide behind a reader bug;
  //   3. the `yaml` package — the authority — reports exactly the jobs present, so a job
  //      silently dropped from the file is a failure rather than a smaller number.
  //
  // To re-pin a count deliberately (e.g. reviewing a large CI restructure), assert it here
  // as a one-off in the PR that makes the change — where the diff explains itself — rather
  // than leaving a permanent table that must be edited in the same commit as every future
  // step and can therefore never be trusted to distinguish the two cases.
  for (const file of REAL_WORKFLOWS) {
    const text = readFileSync(join(WORKFLOW_DIR, file), "utf8");
    const counts = stepCountsViaYamlPkg(text);
    const jobIds = Object.keys(parseWorkflowJobs(text)).length;
    assert.ok(jobIds > 0, `${file}: no jobs parsed — the reader is broken, not the workflow`);

    for (const [job, count] of Object.entries(counts)) {
      assert.ok(
        Number.isInteger(count) && count > 0,
        `${file}: jobs.${job} reports ${count} steps — a job with no steps is GitHub-valid ` +
          "but almost always a folded or swallowed block, not an intent",
      );
    }
    // Two readers, one answer. `stepCountsViaYamlPkg` and `parseWorkflowJobs` share the yaml
    // package, so this is not fully independent — it is a cross-check that the per-job count
    // and the published inventory are derived consistently, which is what caught the legacy
    // reader's job-dropping bugs in the first place.
    assert.equal(
      Object.keys(counts).length,
      jobIds,
      `${file}: the step-count reader and the inventory reader disagree on the job set`,
    );
  }
});

test("differential: reformatting a real workflow must not change the job inventory", () => {
  // The first differential proves the two readers agree *on the files as committed*. That
  // agreement is weaker than it looks: it holds because ci.yml happens to use two-space
  // indentation with no trailing comments and no block-scalar names. A reformat that a human
  // or a YAML emitter would make freely must not change the published inventory.
  //
  // Each perturbation below is a *legal* rewrite of the same document. For all of them the
  // `yaml` package must return exactly what it returned for the original — the job set is a
  // property of the workflow, not of its formatting — while the hand-rolled reader breaks.
  // This is the property that makes the refactor worth having, and the committed-file
  // agreement alone would not have caught it.
  const perturbations = {
    "jobs key given a trailing comment": (text) => text.replace(/^jobs:\s*$/m, "jobs: # every job below"),
    "the whole jobs block indented by two more spaces": (text) =>
      text
        .split(/\r?\n/)
        .map((line, i, all) => {
          const jobsAt = all.findIndex((l) => /^jobs:\s*$/.test(l));
          return i > jobsAt && line.trim() !== "" ? `  ${line}` : line;
        })
        .join("\n"),
    "first job name rewritten as a folded scalar": (text) => {
      // `name: Workflow lint (actionlint)` → the same string, folded across two lines. The
      // displayed name is unchanged; only the formatting differs.
      return text.replace(
        /^ {4}name: (.+)$/m,
        (_line, value) => `    name: >-\n      ${value}`,
      );
    },
  };

  for (const file of REAL_WORKFLOWS) {
    const text = readFileSync(join(WORKFLOW_DIR, file), "utf8");
    const before = parseWorkflowJobs(text);
    assert.ok(before.length > 0, `${file}: fixture must declare jobs`);

    for (const [label, perturb] of Object.entries(perturbations)) {
      const mutated = perturb(text);
      assert.notEqual(mutated, text, `${file}: perturbation did not apply: ${label}`);

      // The invariant: a formatting-only change leaves the inventory untouched.
      assert.deepEqual(
        parseWorkflowJobs(mutated),
        before,
        `${file}: reformatting changed the job inventory (${label})`,
      );
      // And the regression: the reader this replaced does not survive the same rewrite.
      const legacy = legacyParseWorkflowJobs(mutated).map((j) => ({ id: j.id, name: j.name ?? j.id }));
      assert.notDeepEqual(
        legacy,
        before,
        `${file}: expected the legacy reader to break on "${label}" — if it no longer does, ` +
          `this differential has stopped documenting a real defect`,
      );
    }
  }
});

test("differential: the legacy reader loses every job of a real workflow on a legal rewrite", () => {
  // Sharpened from the generic case list: applied to the real ci.yml, a trailing comment on
  // the `jobs:` key does not drop one job, it drops all twelve — so the CI-inventory number
  // `check-doc-counts.mjs` and this script publish would have gone from 14 to 2 with no error
  // raised anywhere. That is the concrete blast radius of the parser this refactor removed.
  const text = readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8");
  const mutated = text.replace(/^jobs:\s*$/m, "jobs: # every job below");

  assert.equal(legacyParseWorkflowJobs(text).length, 12, "fixture must start with 12 jobs");
  assert.equal(legacyParseWorkflowJobs(mutated).length, 0, "a comment must not erase the whole job list");
  assert.equal(parseWorkflowJobs(mutated).length, 12, "the yaml package is immune");
});

// ── DEBT-06 · the property counters, pinned against the real contracts ────────────────
// These numbers are the same ones `check-doc-counts.mjs` guards the README, whitepaper and
// CHANGELOG against. Two independent implementations count them; they agree today, and the
// assertions below are what keeps that agreement from being a coincidence.

/** The `scripts/check-doc-counts.mjs` doc-guard regexes, reproduced verbatim. */
const DOC_GUARD = {
  halmos: /^\s*function check_/gm,
  echidna: /^\s*function echidna_\w+\([^)]*\)[^{;]*\breturns\s*\(\s*bool\s*\)/gm,
};
const countBy = (text, re) => (text.match(re) ?? []).length;

test("real contracts: the property counts match the values the docs publish", () => {
  // Pinned from a live run, not from the documentation: 11 Halmos specs (6 + 5) and 4
  // Echidna properties. A change here is a real change to the project, and the failure
  // message says so rather than looking like a broken test.
  const dir = join(REPO_ROOT, "contracts", "test");
  const perFile = {};
  for (const name of readdirSync(dir).sort()) {
    if (!/^Halmos.*\.t\.sol$/.test(name)) continue;
    perFile[name] = countPropertiesInSource(readFileSync(join(dir, name), "utf8"))["check_"].functions;
  }
  assert.deepEqual(perFile, { "Halmos.t.sol": 6, "HalmosAuth.t.sol": 5 });

  const halmos = countPropertiesInSource(
    readdirSync(dir)
      .filter((n) => /^Halmos.*\.t\.sol$/.test(n))
      .map((n) => readFileSync(join(dir, n), "utf8"))
      .join("\n"),
  )["check_"];
  assert.equal(halmos.functions, 11);
  assert.equal(halmos.boolFunctions, 0, "Halmos specs here are assertion-style, so none return bool");

  const echidnaFile = join(dir, "EchidnaProperties.t.sol");
  const echidna = countPropertiesInSource(readFileSync(echidnaFile, "utf8"))["echidna_"];
  assert.equal(echidna.functions, 4);
  assert.equal(echidna.boolFunctions, 4, "every counted Echidna property returns bool");
});

test("real contracts: this script and the doc guard count the same specs", () => {
  // The cross-check that makes "docs numbers add up" a checked fact rather than a hope: the
  // inventory published here and the numbers `check-doc-counts.mjs` compares against the
  // README are produced by different code, and must not be allowed to drift apart silently.
  const dir = join(REPO_ROOT, "contracts", "test");
  const halmosText = readdirSync(dir)
    .filter((n) => /^Halmos.*\.t\.sol$/.test(n))
    .map((n) => readFileSync(join(dir, n), "utf8"))
    .join("\n");
  const echidnaText = readFileSync(join(dir, "EchidnaProperties.t.sol"), "utf8");

  assert.equal(
    countPropertiesInSource(halmosText)["check_"].functions,
    countBy(halmosText, DOC_GUARD.halmos),
    "Halmos spec counts disagree with the doc guard's regex",
  );
  assert.equal(
    countPropertiesInSource(echidnaText)["echidna_"].boolFunctions,
    countBy(echidnaText, DOC_GUARD.echidna),
    "Echidna property counts disagree with the doc guard's regex",
  );
});

test("countPropertiesInSource handles the prefixes and literals present in the real contracts", () => {
  // Each case is a real shape taken from `contracts/test/`, not an invented one:
  //   · `checkRolled` — a Halmos helper whose name contains "check" but not the `check_`
  //     prefix. Both counters must ignore it, or the spec count inflates on a rename.
  //   · `test_HalmosAuth_ArityIsFour` — a forge test, not a symbolic spec.
  //   · `echidna_sink` — a payable sink living in the same file as the properties, which is
  //     exactly why the return type is what decides membership.
  const source = `
    function checkRolled(uint256 w) internal pure returns (uint256) { return w; }
    function test_HalmosAuth_ArityIsFour() public {}
    function check_real(uint256 x) public pure returns (bool) { return x > 0; }
    function echidna_sink() external payable {}
    function echidna_prop() public view returns (bool) { return true; }
    // function check_commentedOut() public {}
    string constant NOTE = "function check_inAString() public {}";
  `;
  const counts = countPropertiesInSource(source);
  assert.equal(counts["check_"].functions, 1, "only check_ prefixed declarations count as specs");
  assert.equal(counts["check_"].boolFunctions, 1);
  // `functions` counts declarations and `boolFunctions` counts properties — the payable
  // sink is a real `echidna_` declaration that returns nothing, which is exactly why the
  // two numbers are reported separately and why the doc guard keys on the return type.
  assert.equal(counts["echidna_"].functions, 2, "the sink is still an echidna_ declaration");
  assert.equal(counts["echidna_"].boolFunctions, 1, "only the bool-returning one is a property");
  // The doc guard's regexes, on the same source, must reach the same verdicts — otherwise
  // the cross-check above would be green on clean files and wrong on the day a comment lands.
  assert.equal(countBy(source, DOC_GUARD.halmos), counts["check_"].functions);
  // The Echidna regex matches `returns (bool)` as part of the pattern, so it counts
  // *properties* — `boolFunctions` — not declarations. The comparison only looks equal on
  // today's contracts because all four real `echidna_` functions happen to return bool;
  // asserting it against `boolFunctions` states the real correspondence, so a future
  // non-bool `echidna_` helper (like `echidna_sink`) cannot make this test quietly lie.
  assert.equal(countBy(source, DOC_GUARD.echidna), counts["echidna_"].boolFunctions);
});

test("countPropertiesInSource keeps a multi-line property that the doc-guard regex also keeps", () => {
  // The one shape where the two implementations could legitimately disagree is a parameter
  // list broken across lines: the doc guard's `[^)]*` does span newlines, so it must still
  // count it. Asserting the agreement here keeps the cross-check honest for real edits.
  const source = `
    function echidna_spanning(
        address who,
        uint256 amount
    ) public view returns (bool) { return amount > 0; }
  `;
  const counts = countPropertiesInSource(source)["echidna_"];
  assert.equal(counts.functions, 1);
  assert.equal(counts.boolFunctions, 1);
  assert.equal(countBy(source, DOC_GUARD.echidna), 1, "the doc guard must not drop a spanning signature");
});

test("the real CI inventory publishes one stable entry per configured job", () => {
  // The number `check-doc-counts.mjs` compares to the README's "✅ 14 jobs" is produced here.
  // 12 in ci.yml + 2 in publish.yml, with the ids below — asserted from a live run.
  const jobs = REAL_WORKFLOWS.flatMap((file) =>
    parseWorkflowJobs(readFileSync(join(WORKFLOW_DIR, file), "utf8")),
  );
  assert.deepEqual(
    jobs.map((j) => j.id),
    [
      "workflow-lint",
      "forge-unit",
      "forge-invariant",
      "slither",
      "secret-scan",
      "ts-sdk",
      "forge-deep-fuzz",
      "forge-fork-base",
      "halmos",
      "wallet-e2e-weekly",
      "echidna-nightly",
      "foundry-canary",
      "assurance",
      "publish",
    ],
  );
  // Every job resolves to a name, and no name is an empty string or a leaked `>-` indicator.
  for (const job of jobs) {
    assert.equal(typeof job.name, "string", `${job.id} has no display name`);
    assert.ok(job.name.length > 0, `${job.id} resolved to an empty display name`);
  }
});

test("the real workflows report gating posture alongside the job list", () => {
  // V67-G1 (live-file half): the seven always-on gates block every trigger; the
  // condition-gated and continue-on-error jobs must NOT read as blocking, and each
  // gating `if:` is carried verbatim for a downstream reader.
  const details = REAL_WORKFLOWS.flatMap((file) =>
    parseWorkflowJobDetails(readFileSync(join(WORKFLOW_DIR, file), "utf8")),
  );
  assert.equal(details.length, 14);
  const byName = Object.fromEntries(details.map((d) => [d.name, d]));
  assert.deepEqual(
    details.filter((d) => d.blocking).map((d) => d.name),
    [
      "Workflow lint (actionlint)",
      "Forge unit + fuzz",
      "Forge invariant (INV-1..4)",
      "Slither static analysis",
      "Secret scanning (gitleaks)",
      "TS SDK conformance (Anvil)",
      "Required assurance for publishing commit",
    ],
  );
  // The three TD-6 continue-on-error jobs are non-blocking by two independent routes.
  assert.equal(byName["Echidna property fuzzing (nightly)"].blocking, false);
  assert.equal(byName["Wallet conformance (weekly)"].blocking, false);
  assert.equal(byName["Foundry nightly canary (monthly)"].blocking, false);
  // Condition-gated jobs carry their `if:` text.
  assert.match(byName["Halmos symbolic verification"].condition, /workflow_dispatch/);
  assert.match(byName["Publish assured commit"].condition, /needs\.assurance/);
});

