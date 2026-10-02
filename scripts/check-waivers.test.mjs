import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { crossCheck, isoToDay, parseRegister, parseWorkflow, runChecks } from "./check-waivers.mjs";

/**
 * Bounded unit tests for the CI waiver guard. Every test feeds fixture strings to the
 * exported pure helpers and cross-checks the verdict — no test reads the real
 * `.github/workflows/` or `docs/CI-WAIVERS.md`, and none shells out to Node. The
 * end-to-end cases build a throwaway tree in the OS temp directory.
 *
 * The five scenarios below are the full lifecycle of a waiver, in the order they occur:
 *   1. registered, live, unexpired       → clean
 *   2. waived in YAML, no row            → FAIL  (rule #1)
 *   3. row, waiver already removed       → WARN  (stale register; --strict → FAIL)
 *   4. row, expired, waiver still live   → FAIL  (rule #2)
 *   5. row, expired, waiver removed      → clean (the waiver is no longer needed)
 */

const TODAY = "2026-09-25"; // the date this repo's three live waivers were checked at

// --- fixtures ----------------------------------------------------------------------------

/**
 * A minimal workflow. `waived` lists the jobs that carry `continue-on-error: true`; jobs
 * not listed still exist, which is the register's "the waiver is gone" state (distinct
 * from a name that matches no workflow at all).
 */
const workflow = (jobNames, { waived = null, stepLevel = null } = {}) => {
  const waivedSet = new Set(waived ?? jobNames);
  return [
    "name: Fixture",
    "on: [push]",
    "jobs:",
    ...jobNames.flatMap((name) => [
      `  ${name}:`,
      "    runs-on: ubuntu-latest",
      ...(waivedSet.has(name) ? ["    continue-on-error: true"] : []),
      "    steps:",
      ...(stepLevel === name
        ? ["      - name: flaky step", "        continue-on-error: true", "        run: echo hi"]
        : ["      - run: echo hi"]),
    ]),
  ].join("\n");
};

const register = (rows) =>
  [
    "# CI waivers",
    "",
    "| Job (ci.yml) | Waiver | Criterion to remove (must be met, in order) | Expiry hard stop |",
    "|---|---|---|---|",
    ...rows.map(
      ([job, expiry, criterion = "Four green scheduled runs."]) =>
        `| \`${job}\` | \`continue-on-error: true\` | ${criterion} | ${expiry} |`,
    ),
  ].join("\n");

/** Runs the whole pipeline for one (workflow, register) pair and returns the verdict. */
function check(wfText, regText, { strict = false, today = TODAY } = {}) {
  const findings = parseWorkflow(wfText, "ci.yml");
  const knownJobs = new Set(findings.jobLevel.map((w) => w.job));
  for (const name of ["alpha", "beta", "gamma"]) {
    if (new RegExp(`^  ${name}:`, "m").test(wfText)) knownJobs.add(name);
  }
  const reg = parseRegister(regText);
  const verdict = crossCheck({ ...findings, knownJobs }, reg, { today, strict });
  return {
    ...verdict,
    // Register-level problems are part of the verdict, as they are in runChecks().
    failures: [...findings.errors, ...reg.errors, ...verdict.failures],
    warnings: [...reg.warnings, ...verdict.warnings],
    register: reg,
  };
}

// --- 1. the healthy path -----------------------------------------------------------------

test("scenario 1: a live, registered, unexpired waiver passes cleanly", () => {
  const { failures, warnings, register: reg } = check(
    workflow(["alpha", "beta"]),
    register([["alpha", "2026-10-12"], ["beta", "2026-11-30"]]),
  );
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.deepEqual(warnings, [], warnings.join("\n"));
  assert.deepEqual(reg.rows.map((r) => r.job), ["alpha", "beta"]);
  assert.deepEqual(reg.rows.map((r) => r.expiryIso), ["2026-10-12", "2026-11-30"]);
});

test("scenario 1b: the expiry date itself is the hard stop, per rule #2", () => {
  // Rule #2 is "on the expiry date the waiver is either removed or…", and ci.yml's own
  // wording is "remove on or after <expiry>" — so today == expiry is already too late.
  const reg = register([["alpha", TODAY]]);
  assert.deepEqual(check(workflow(["alpha"]), reg, { today: "2026-09-24" }).failures, []);

  const onExpiry = check(workflow(["alpha"]), reg);
  assert.equal(onExpiry.failures.length, 1, onExpiry.failures.join("\n"));
  assert.match(onExpiry.failures[0], /waiver expired 2026-09-25 \(today is 2026-09-25\)/);
  assert.match(onExpiry.failures[0], /rule #2/);
});

// --- 2. an unregistered waiver (rule #1) ---------------------------------------------------

test("scenario 2: a waiver in YAML with no register row fails and names the rule #1 remedy", () => {
  const { failures, warnings } = check(workflow(["alpha", "beta"]), register([["alpha", "2026-10-12"]]));
  assert.equal(failures.length, 1, failures.join("\n"));
  assert.match(failures[0], /ci\.yml:\d+ {2}jobs\.beta: has `continue-on-error: true` but no row in docs\/CI-WAIVERS\.md/);
  assert.match(failures[0], /rule #1/);
  // The already-registered waiver is not implicated.
  assert.ok(!failures.some((f) => f.includes("jobs.alpha")), failures.join("\n"));
  assert.deepEqual(warnings, [], warnings.join("\n"));
});

test("scenario 2b: the reported line number points at the flag, not the job header", () => {
  const text = workflow(["alpha"]);
  const { failures } = check(text, register([]));
  assert.equal(failures.length, 1, failures.join("\n"));
  const line = Number(failures[0].match(/ci\.yml:(\d+)/)[1]);
  assert.match(text.split("\n")[line - 1], /continue-on-error: true/);
});

test("scenario 2c: jobs in every workflow file are checked, not just ci.yml", () => {
  const a = parseWorkflow(workflow(["alpha"]), "ci.yml");
  const b = parseWorkflow(workflow(["beta"]), "release.yml");
  const merged = {
    jobLevel: [...a.jobLevel, ...b.jobLevel],
    stepLevel: [],
    nonLiteral: [],
    knownJobs: new Set(["alpha", "beta"]),
  };
  const { failures } = crossCheck(merged, parseRegister(register([["alpha", "2026-10-12"]])), { today: TODAY });
  assert.equal(failures.length, 1, failures.join("\n"));
  assert.match(failures[0], /release\.yml/);
  assert.match(failures[0], /jobs\.beta/);
});

// --- 3. a stale register row ---------------------------------------------------------------

test("scenario 3: a row whose waiver is gone warns by default and fails under --strict", () => {
  // `beta` still exists as a job but is no longer waived: its register row is stale.
  const text = workflow(["alpha", "beta"], { waived: ["alpha"] });
  const reg = register([["alpha", "2026-10-12"], ["beta", "2026-10-12"]]);

  const lenient = check(text, reg);
  assert.deepEqual(lenient.failures, [], lenient.failures.join("\n"));
  assert.equal(lenient.warnings.length, 1, lenient.warnings.join("\n"));
  assert.match(lenient.warnings[0], /jobs\.beta: registered but no `continue-on-error` in any workflow/);
  assert.match(lenient.warnings[0], /delete this row/);
  // The row names a job that really exists, so no typo hint is added.
  assert.ok(!lenient.warnings[0].includes("matches no workflow"));

  const strict = check(text, reg, { strict: true });
  assert.deepEqual(strict.warnings, []);
  assert.equal(strict.failures.length, 1, strict.failures.join("\n"));
  assert.match(strict.failures[0], /jobs\.beta/);
  assert.match(strict.failures[0], /delete this row/);
});

// --- 4. an expired waiver still in place (rule #2) -----------------------------------------

test("scenario 4: an expired row whose waiver is still live fails and names both options", () => {
  const { failures, warnings } = check(workflow(["alpha"]), register([["alpha", "2026-09-01"]]));
  assert.equal(failures.length, 1, failures.join("\n"));
  assert.match(failures[0], /jobs\.alpha: waiver expired 2026-09-01 \(today is 2026-09-25\)/);
  assert.match(failures[0], /still `continue-on-error: true` in ci\.yml:\d+/);
  assert.match(failures[0], /remove the waiver, or replace this row with a written justification, a new dated criterion and a new Expiry/);
  assert.match(failures[0], /rule #2/);
  assert.deepEqual(warnings, []);
});

test("scenario 4b: the expiry is caught on any evaluation date after it", () => {
  const reg = register([["alpha", "2026-10-12"]]);
  assert.deepEqual(check(workflow(["alpha"]), reg, { today: "2026-10-11" }).failures, []);
  const due = check(workflow(["alpha"]), reg, { today: "2026-10-13" });
  assert.equal(due.failures.length, 1, due.failures.join("\n"));
  assert.match(due.failures[0], /rule #2/);
});

// --- 5. an expired row whose waiver is already gone ----------------------------------------

test("scenario 5: an expired row with no waiver left passes — nothing is being waived", () => {
  // The job still exists (so the row is a valid registration) but the waiver was removed.
  const text = workflow(["alpha"], { waived: [] });
  const reg = register([["alpha", "2026-09-01"]]);

  const { failures, warnings } = check(text, reg);
  assert.deepEqual(failures, [], failures.join("\n"));
  // Still surfaced as a stale row (with the expiry noted), but it never blocks the build.
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /registered but no `continue-on-error`/);
  assert.match(warnings[0], /and it expired 2026-09-01/);

  assert.deepEqual(check(text, reg, { strict: true }).warnings, []);
});

test("scenario 5b: a register with no live waivers at all passes", () => {
  const { failures, warnings } = check(workflow(["alpha", "beta"], { waived: [] }), register([]));
  assert.deepEqual(failures, []);
  assert.deepEqual(warnings, []);
});

// --- expiry cannot be quietly extended -------------------------------------------------------

test("a duplicated job row uses the earliest expiry, so a waiver cannot be extended by appending", () => {
  const { failures, warnings } = check(
    workflow(["alpha"]),
    register([["alpha", "2026-09-01"], ["alpha", "2026-12-01"]]),
  );
  assert.equal(failures.length, 1, failures.join("\n"));
  assert.match(failures[0], /waiver expired 2026-09-01/);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /registered more than once/);
  assert.match(warnings[0], /the earliest Expiry \(2026-09-01\) is used/);
});

// --- step-level and dynamic waivers --------------------------------------------------------

test("a step-level continue-on-error warns as an ungoverned way to bypass a gate", () => {
  // No job-level flag, so nothing in the register can cover this step.
  const text = workflow(["alpha"], { waived: [], stepLevel: "alpha" });
  const reg = register([]);

  const { failures, warnings } = check(text, reg);
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /jobs\.alpha\.steps\[0\] "flaky step": step-level `continue-on-error: true`/);
  assert.match(warnings[0], /move it to the job level and register it/);

  const strict = check(text, reg, { strict: true });
  assert.equal(strict.failures.length, 1, strict.failures.join("\n"));
});

test("a step-level flag in an already-waived job is called out as redundant", () => {
  const { warnings } = check(
    workflow(["alpha"], { stepLevel: "alpha" }),
    register([["alpha", "2026-10-12"]]),
  );
  assert.match(warnings[0], /the job is already waived, so this flag is redundant/);
});

test("a non-literal continue-on-error is flagged: a computed waiver cannot be checked", () => {
  const text = [
    "on: [push]",
    "jobs:",
    "  alpha:",
    "    runs-on: ubuntu-latest",
    "    continue-on-error: ${{ matrix.waive }}",
    "    steps:",
    "      - run: echo hi",
  ].join("\n");
  const findings = parseWorkflow(text, "ci.yml");
  assert.deepEqual(findings.jobLevel, []);
  assert.equal(findings.nonLiteral.length, 1);
  assert.match(findings.nonLiteral[0].value, /matrix\.waive/);

  const { warnings } = crossCheck(
    { ...findings, knownJobs: new Set(["alpha"]) },
    parseRegister(register([])),
    { today: TODAY },
  );
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /is not a literal boolean/);
});

test("continue-on-error: false is not a waiver and needs no row", () => {
  const text = [
    "on: [push]",
    "jobs:",
    "  alpha:",
    "    runs-on: ubuntu-latest",
    "    continue-on-error: false",
    "    steps:",
    "      - run: echo hi",
  ].join("\n");
  const { failures, warnings } = check(text, register([]));
  assert.deepEqual(failures, []);
  assert.deepEqual(warnings, []);
});

// --- register parsing edge cases -------------------------------------------------------------

test("the static-analysis triage table is never mistaken for the waiver register", () => {
  // The real doc's second table has "Criterion to remove" and "Expiry" columns but no
  // Job/Waiver columns — its rows must not surface as stale waivers.
  const doc = [
    ...register([["alpha", "2026-10-12"]]).split("\n"),
    "",
    "## Static-analysis triage",
    "",
    "| Detector | Impact | Criterion to remove | Expiry |",
    "|---|---|---|---|",
    "| `calls-loop` | Low | Re-verify at audit-prep. | 2026-10-22 |",
    "| `reentrancy-events` | Low | Auditor sign-off. | 2026-10-22 |",
    "| `pragma` | Informational | None (style). | — |",
    "",
  ].join("\n");
  const { failures, warnings } = check(workflow(["alpha"]), doc);
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.deepEqual(warnings, [], warnings.join("\n"));
});

test("a missing or mangled register table fails closed instead of passing vacuously", () => {
  // A table whose delimiter row is broken is no longer a table, so the guard must refuse to
  // pass rather than concluding "no waivers are registered".
  const mangled = register([["alpha", "2026-10-12"]]).replace("|---|---|---|---|", "|---|---|---|---broken");
  for (const doc of ["# CI waivers\n\nNo table here.\n", mangled]) {
    const { failures } = check(workflow(["alpha"]), doc);
    assert.ok(failures.length > 0, `expected a failure for:\n${doc}`);
    assert.match(failures.join("\n"), /no CI waiver table found/);
  }
});

test("a row without a hard ISO expiry is an error — an undated waiver is a permanent one", () => {
  for (const expiry of ["TBD", "next quarter", "", "someday"]) {
    const { failures } = check(workflow(["alpha"]), register([["alpha", expiry]]));
    assert.equal(failures.length, 1, `expiry ${JSON.stringify(expiry)}: ${failures.join("\n")}`);
    assert.match(failures[0], /no ISO date \(YYYY-MM-DD\) in the Expiry column/);
  }
});

test("a row with an impossible date is rejected rather than silently ignored", () => {
  const { failures } = check(workflow(["alpha"]), register([["alpha", "2026-02-30"]]));
  assert.equal(failures.length, 1, failures.join("\n"));
  assert.match(failures[0], /Expiry 2026-02-30 is not a real calendar date/);
});

test("a row with no removal criterion is an error; a phrase plus a date still parses", () => {
  const empty = check(workflow(["alpha"]), register([["alpha", "2026-10-12", "  —  "]]));
  assert.match(empty.failures[0], /empty 'Criterion to remove'/);

  const phrased = register([["alpha", "2026-10-12"]]).replace("| 2026-10-12 |", "| hard stop on or after 2026-10-12 |");
  const ok = check(workflow(["alpha"]), phrased);
  assert.deepEqual(ok.failures, [], ok.failures.join("\n"));
  assert.equal(ok.register.rows[0].expiryIso, "2026-10-12");
});

test("a waiver cell not naming continue-on-error warns that the row is unverified", () => {
  const reg = register([["alpha", "2026-10-12"]]).replace("| `continue-on-error: true` |", "| `allow-failure: yes` |");
  const { failures, warnings } = check(workflow(["alpha"]), reg);
  assert.deepEqual(failures, []);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /Waiver column does not mention continue-on-error/);
});

test("escaped pipes inside a cell do not shift the columns", () => {
  const reg = register([["alpha", "2026-10-12"]]).replace("| Four green scheduled runs. |", "| a \\| b green runs. |");
  const { register: parsed } = check(workflow(["alpha"]), reg);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows[0].expiryIso, "2026-10-12");
  assert.equal(parsed.rows[0].criterion, "a | b green runs.");
});

// --- workflow parsing failure modes ---------------------------------------------------------

test("an unparseable workflow is reported by this guard too", () => {
  const findings = parseWorkflow("jobs:\n  alpha:\n   - broken: [1,\n", "ci.yml");
  assert.ok(findings.errors.length > 0);
  assert.match(findings.errors[0], /YAML parse error/);
  // Nothing is enumerated from a file that failed to load, so no verdict can be drawn.
  assert.deepEqual(findings.jobLevel, []);
  assert.deepEqual(findings.stepLevel, []);
});

test("a parse error never also reports a waiver verdict derived from the partial view", () => {
  // The repo is edited concurrently, and ci.yml briefly contained unparseable YAML. If the
  // guard had gone on to cross-check, all three live rows would have been reported as
  // "the waiver is gone" — sending someone to delete waivers that are still in effect.
  const broken = ["on: [push]", "jobs:", "  alpha:", "    run: \"${{ x }}\" -color", ""].join("\n");
  const findings = parseWorkflow(broken, "ci.yml");
  assert.ok(findings.errors.length > 0, "fixture must be unparseable");
  assert.deepEqual(findings.jobLevel, []);
  assert.deepEqual(findings.stepLevel, []);
});

test("a workflow with no jobs mapping is reported", () => {
  assert.match(parseWorkflow("name: x\non: [push]\n", "ci.yml").errors[0], /no `jobs` mapping/);
});

test("real-world job names with dashes and digits join correctly", () => {
  const text = workflow(["wallet-e2e-weekly", "echidna-nightly"]);
  const { failures } = check(
    text,
    register([["wallet-e2e-weekly", "2026-10-12"], ["echidna-nightly", "2026-10-31"]]),
  );
  assert.deepEqual(failures, [], failures.join("\n"));

  const missing = check(text, register([["wallet-e2e-weekly", "2026-10-12"]]));
  assert.equal(missing.failures.length, 1, missing.failures.join("\n"));
  assert.match(missing.failures[0], /jobs\.echidna-nightly/);
});

// --- date helpers --------------------------------------------------------------------------

test("isoToDay: strict ISO parsing, real calendar days, UTC-stable", () => {
  assert.equal(isoToDay("2026-10-12"), Date.UTC(2026, 9, 12) / 86_400_000);
  assert.equal(isoToDay(" 2026-10-12 "), Date.UTC(2026, 9, 12) / 86_400_000);
  assert.equal(isoToDay("2024-02-29") - isoToDay("2024-02-28"), 1);
  assert.equal(isoToDay("2026-12-31") - isoToDay("2026-01-01"), 364);
  for (const bad of ["2026-13-01", "2026-00-10", "2026-02-30", "26-01-01", "2026-1-1", "Oct 12", "", "2026-10-12T00:00:00Z", null]) {
    assert.equal(isoToDay(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

// --- end-to-end against a throwaway tree ----------------------------------------------------

/** Writes a workflow + register into a temp dir and runs the real disk-reading path. */
function withTree(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "waivers-"));
  const workflowDir = join(dir, "workflows");
  mkdirSync(workflowDir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(workflowDir, name), text);
  const register = join(dir, "CI-WAIVERS.md");
  if (files.register) writeFileSync(register, files.register);
  try {
    return fn({ workflowDir, register });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runChecks: a clean tree reports every waiver as registered", () => {
  withTree(
    {
      "ci.yml": workflow(["alpha", "beta"]),
      register: register([["alpha", "2026-10-12"], ["beta", "2026-11-30"]]),
    },
    ({ workflowDir, register: reg }) => {
      const result = runChecks({ today: TODAY, workflowDir, register: reg });
      assert.deepEqual(result.failures, [], result.failures.join("\n"));
      assert.deepEqual(result.warnings, [], result.warnings.join("\n"));
      assert.equal(result.waived, 2);
      assert.equal(result.rows, 2);
    },
  );
});

test("runChecks: a waiver in a second workflow file is still caught", () => {
  withTree(
    {
      "ci.yml": workflow(["alpha"]),
      "release.yml": workflow(["beta"]),
      register: register([["alpha", "2026-10-12"]]),
    },
    ({ workflowDir, register: reg }) => {
      const result = runChecks({ today: TODAY, workflowDir, register: reg });
      assert.equal(result.failures.length, 1, result.failures.join("\n"));
      assert.match(result.failures[0], /release\.yml/);
      assert.match(result.failures[0], /jobs\.beta/);
    },
  );
});

test("runChecks: an unparseable workflow reports the parse error and no waiver verdicts", () => {
  // The regression this guards: while the repo was being edited, ci.yml briefly held
  // invalid YAML. Cross-checking that partial view reported all three live rows as
  // "the waiver is gone", which would have told someone to delete live waivers.
  const broken = [
    "on: [push]",
    "jobs:",
    "  alpha:",
    "    runs-on: ubuntu-latest",
    "    continue-on-error: true",
    "    steps:",
    "      - run: \"${{ steps.x.outputs.bin }}\" -color",
    "",
  ].join("\n");
  withTree({ "ci.yml": broken, register: register([["alpha", "2026-10-12"], ["beta", "2026-10-12"]]) }, ({ workflowDir, register: reg }) => {
    const result = runChecks({ today: TODAY, workflowDir, register: reg });
    assert.equal(result.failures.length, 1, result.failures.join("\n"));
    assert.match(result.failures[0], /YAML parse error/);
    assert.ok(
      !result.failures.concat(result.warnings).some((m) => /the waiver is gone/.test(m)),
      "a parse error must not also produce stale-row verdicts",
    );
  });
});

test("runChecks: a missing register file fails closed", () => {
  withTree({ "ci.yml": workflow(["alpha"]) }, ({ workflowDir, register: reg }) => {
    const result = runChecks({ today: TODAY, workflowDir, register: reg });
    assert.equal(result.failures.length, 1, result.failures.join("\n"));
    assert.match(result.failures[0], /no waiver register at/);
  });
});
