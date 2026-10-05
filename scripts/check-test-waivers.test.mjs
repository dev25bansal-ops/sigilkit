/**
 * Tests for `scripts/check-test-waivers.mjs`.
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────────────
 * This gate had NO test file at all while being wired into `verify.mjs` and `ci.yml` as a
 * step. A guard with no test is a guard whose behaviour has never been observed — including,
 * critically, whether it can go red at all. Every case below is therefore a NEGATIVE CONTROL:
 * a deliberately broken input with an asserted non-zero exit. The one positive case (still
 * red) exists only to prove the gate is not trivially always-red, and it is paired with
 * injection notes recording what the pre-refactor code did.
 *
 * `forge` is never required. `runGate` takes `spawn`/`exists`/`read` as injected parameters, so
 * the whole decision table is exercised on a machine with no foundry installed — which is the
 * only way these controls can run in the `workflow-lint` job at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateRow, parseRows, runGate } from "./check-test-waivers.mjs";

const ROW = { test: "test_Waived", file: "contracts/test/Waived.t.sol", expiry: "2026-12-01", line: 63 };

/** A register with one parseable intentional-failure row, in the real register's shape. */
const REGISTER_TEXT = [
  "# CI waivers",
  "",
  "## Item (not a CI job)",
  "",
  "| Item | Criterion to remove | Expiry |",
  "| --- | --- | --- |",
  "| `test_Waived` (`contracts/test/Waived.t.sol`) | rewrite under Option B | 2026-12-01 |",
  "",
].join("\n");

/** Forge's own per-suite line. Absent of a real failure count, this is what the gate reads. */
const suite = (passed, failed) => `Suite result: ok. ${passed} passed; ${failed} failed\nRan 1 test suite`;

function stubForge(responses) {
  return (bin, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "forge 1.9.1", stderr: "" };
    const test = args[args.indexOf("--match-test") + 1];
    const reply = responses[test];
    if (reply instanceof Error) return { error: reply };
    if (typeof reply === "string") return { status: 0, stdout: reply, stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
}

const world = (over = {}) => ({
  register: "register.md",
  root: "/repo",
  forge: "forge",
  spawn: stubForge({ test_Waived: suite(0, 1) }),
  exists: (p) => p === "register.md" || String(p).endsWith("Waived.t.sol"),
  read: () => REGISTER_TEXT,
  ...over,
});

// ── parseRows ────────────────────────────────────────────────────────────────────────────

test("parseRows: the register's own row shape is read, with the file path taken from inside the parens", () => {
  // Injection note: a plain `\(([^)]+)\)` captures the backticks too, so the path becomes
  // "`contracts/test/X.t.sol`" — which never exists on disk, and the row is then reported
  // unverifiable instead of being checked. This asserts the backticked inner form is preferred.
  const rows = parseRows(REGISTER_TEXT);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    test: "test_Waived",
    file: "contracts/test/Waived.t.sol",
    expiry: "2026-12-01",
    line: 7,
  });
});

test("parseRows: the CI-job table above is ignored, which is what keeps the two readers independent", () => {
  const both = [
    "| Job | Waiver | Expiry |",
    "| --- | --- | --- |",
    "| workflow-lint | continue-on-error: true | 2026-10-01 |",
    "",
    "| Item | Criterion to remove | Expiry |",
    "| --- | --- | --- |",
    "| `test_Real` (`contracts/test/Real.t.sol`) | fix the defect | 2026-11-01 |",
  ].join("\n");
  const rows = parseRows(both);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].test, "test_Real");
});

// ── evaluateRow: the decision table, stated directly ──────────────────────────────────────

test("evaluateRow: only `red` passes; green, unverifiable and a missing file are all findings", () => {
  // The single most important property in this file. A row is a promise that a specific test
  // is red on purpose; every state other than "still red" voids or voids-verification of that
  // promise, and none of them may be reported as satisfied.
  assert.equal(evaluateRow(ROW, { state: "red", detail: "0 passed, 1 failed" }, true).ok, true);
  for (const state of ["green", "unverifiable"]) {
    assert.equal(evaluateRow(ROW, { state, detail: "d" }, true).ok, false, `${state} must be a finding`);
  }
  assert.equal(evaluateRow(ROW, { state: "red", detail: "d" }, false).ok, false, "a missing file must be a finding");
});

test("evaluateRow: an unresolvable row is reported as unverifiable, never as satisfied", () => {
  // "Cannot check" and "checked and fine" must not share an outcome — that conflation is the
  // entire reason this gate reports unverifiable rows instead of skipping them.
  const outcome = evaluateRow(ROW, { state: "unverifiable", detail: "no test matched" }, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.finding, /could not be verified/);
});

// ── runGate: the negative controls ────────────────────────────────────────────────────────

test("NEGATIVE CONTROL: an empty register exits 1 — a gate that cannot read its table guards nothing", () => {
  // Injection proof against the pre-test code path: `rows.length === 0` was the fail-closed
  // branch and no test ever drove it, so "the table was deleted" had no observed behaviour.
  const r = runGate(world({ read: () => "# CI waivers\n\nno tables here\n" }));
  assert.equal(r.code, 1);
  assert.match(r.failures[0], /no intentional-test-failure rows/);
});

test("POSITIVE CONTROL: a present-but-empty register passes — closed intentional reds are the healthy state", () => {
  // The register's own note declares "An empty table is the healthy state, not a gap to
  // fill." The gate must agree with the register it polices: presence of the real "Item
  // (not a CI job)" header with zero parseable rows is a PASS (nothing is red on purpose,
  // so there is no promise to verify), while a register WITHOUT that table still exits 1
  // above. Both directions are pinned so neither state can silently become the other.
  const r = runGate(world({
    read: () => [
      "# CI waivers",
      "",
      "## Non-CI-job waivers — deliberate standing test failures",
      "",
      "| Item (not a CI job) | Waiver | Criterion to remove (must be met, in order) | Expiry hard stop |",
      "| --- | --- | --- | --- |",
      "| _(empty — see the note above)_ | — | — | — |",
      "",
    ].join("\n"),
  }));
  assert.equal(r.code, 0);
  assert.deepEqual(r.stillRed, []);
});

test("NEGATIVE CONTROL: a register whose test has gone GREEN exits 1 and names the row", () => {
  // Injection proof: this is the failure the gate exists for (SEC-10's row outliving its own
  // removal criterion). Green is the state that must never be tolerated.
  const r = runGate(world({ spawn: stubForge({ test_Waived: suite(1, 0) }) }));
  assert.equal(r.code, 1);
  assert.match(r.failures[0], /is GREEN/);
  assert.match(r.failures[0], /test_Waived/);
});

test("NEGATIVE CONTROL: forge matching no test exits 1, not 0 — exit code 0 is not a verdict", () => {
  // Injection proof: forge exits 0 both for "the waiver is still honoured" and for "no test
  // matched anything", so a deleted test would read as satisfied. The gate must read the
  // suite summary, and must fail when it is absent.
  const r = runGate(world({ spawn: stubForge({ test_Waived: "No tests found\nRan 0 test suites" }) }));
  assert.equal(r.code, 1);
  assert.match(r.failures[0], /could not be verified/);
});

test("NEGATIVE CONTROL: a 0-passed/0-failed suite summary exits 1", () => {
  // The summary exists but says nothing ran. `passed === 0 && failed === 0` is the case a
  // naive "did it fail?" check reads as success.
  const r = runGate(world({ spawn: stubForge({ test_Waived: suite(0, 0) }) }));
  assert.equal(r.code, 1);
  assert.match(r.failures[0], /could not be verified/);
});

test("NEGATIVE CONTROL: a summary-less forge reply exits 1 rather than passing an unread run", () => {
  const r = runGate(world({ spawn: stubForge({ test_Waived: "some unrelated output" }) }));
  assert.equal(r.code, 1);
  assert.match(r.failures[0], /forge produced no suite summary/);
});

test("NEGATIVE CONTROL: a spawn error (forge vanishing mid-run) exits 1 as unverifiable", () => {
  const r = runGate(world({ spawn: stubForge({ test_Waived: new Error("spawn ENOENT") }) }));
  assert.equal(r.code, 1);
  assert.match(r.failures[0], /could not be verified/);
});

test("NEGATIVE CONTROL: a missing register file exits 1", () => {
  const r = runGate(world({ exists: (p) => !String(p).endsWith("register.md") }));
  assert.equal(r.code, 1);
  assert.match(r.failures[0], /register is gone/);
});

test("NEGATIVE CONTROL: a registered file that does not exist on disk exits 1", () => {
  // The row is a registration, and a registration whose subject was deleted cannot be
  // verified. `existsSync(join(ROOT, row.file))` false must not be read as "nothing to do".
  const r = runGate(world({ exists: (p) => p === "register.md" }));
  assert.equal(r.code, 1);
  assert.match(r.failures[0], /does not exist/);
});

test("forge unavailable exits 2, not 0 and not 1 — a gate that verified nothing is not a passing gate", () => {
  // `forgeAvailable` used to gate on `probe.status === 0`. Both 0 and 1 are wrong here: 0
  // would claim every registered failure was confirmed red, having run nothing at all.
  const spawn = () => ({ error: new Error("spawn ENOENT"), status: null });
  const r = runGate(world({ spawn }));
  assert.equal(r.code, 2);
  assert.match(r.failures[0], /could not run/);
});

test("forge present but refusing (non-zero --version) also exits 2", () => {
  const spawn = (bin, args) => (args[0] === "--version" ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: suite(0, 1), stderr: "" });
  assert.equal(runGate(world({ spawn })).code, 2);
});

// ── the one positive case, so the negatives above are meaningful ──────────────────────────

test("a still-red row exits 0 — proving the negatives are not vacuous", () => {
  const r = runGate(world());
  assert.equal(r.code, 0);
  assert.equal(r.failures.length, 0);
  assert.equal(r.stillRed.length, 1);
  assert.match(r.stillRed[0], /test_Waived.*still red/);
});

test("a mixed register reports every bad row and does not stop at the first", () => {
  // One green row must not mask a second unverifiable row: a gate that returns on the first
  // finding understates the register and invites a fix for one row followed by a re-run that
  // fails again on the next.
  const two = REGISTER_TEXT.replace(
    "| `test_Waived` (`contracts/test/Waived.t.sol`) | rewrite under Option B | 2026-12-01 |",
    [
      "| `test_Waived` (`contracts/test/Waived.t.sol`) | rewrite under Option B | 2026-12-01 |",
      "| `test_Second` (`contracts/test/Second.t.sol`) | fix the defect | 2026-12-02 |",
    ].join("\n"),
  );
  const r = runGate(world({
    read: () => two,
    spawn: stubForge({ test_Waived: suite(1, 0), test_Second: "No tests found" }),
    exists: (p) => p === "register.md" || String(p).endsWith(".sol"),
  }));
  assert.equal(r.code, 1);
  assert.equal(r.failures.length, 2);
  assert.ok(r.failures.some((f) => /test_Waived/.test(f) && /GREEN/.test(f)));
  assert.ok(r.failures.some((f) => /test_Second/.test(f) && /could not be verified/.test(f)));
});

// ── rule #2 for the Item table: the Expiry column has teeth ───────────────────────────────

test("a still-red row past its Expiry hard stop exits 1 — expiry is a deadline, not a suggestion", () => {
  // `check-waivers.mjs` deliberately skips the Item table, so this is the only place the
  // table's Expiry column is enforced. A red waiver whose deadline has passed is not a
  // waiver being honoured but a removal criterion being missed — the row must gain a
  // written justification and a new date, or close with the fixing change.
  const r = runGate(world({ today: "2026-12-02" }));
  assert.equal(r.code, 1);
  assert.match(r.failures[0], /hard stop 2026-12-01 has passed/);
  assert.match(r.failures[0], /test_Waived/);
});

test("a still-red row before its hard stop still passes — the deadline comparison is dated, not alarmist", () => {
  const r = runGate(world({ today: "2026-11-30" }));
  assert.equal(r.code, 0);
  assert.equal(r.failures.length, 0);
  assert.equal(r.stillRed.length, 1);
});
