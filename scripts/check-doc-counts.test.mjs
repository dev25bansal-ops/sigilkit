import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  countInvariantStats,
  checkChangelogCounts,
  checkInvariantConfig,
  checkReadmeCounts,
  checkSecurityDocCounts,
  checkStatusCounts,
  checkTroubleshootingCounts,
  checkWhitepaperCounts,
  latestChangelogSection,
  metamaskPinFromCi,
  parseCoverageFloors,
  parseVitestReport,
  summarizeTsRun,
  collectTsReport,
  rewriteReadme,
  rewriteStatus,
  rewriteTroubleshooting,
  rerunArgs,
  exitStatusFromError,
} from "./check-doc-counts.mjs";

/**
 * Bounded unit tests for the documentation count guard. Every test feeds a fixture string or
 * in-memory file list to an exported pure helper — no test reads or writes the real README,
 * whitepaper or contracts, and none invokes forge or vitest.
 */

// --- fixtures ---------------------------------------------------------------------------

const COUNTS = { total: 115, suites: 11 };
const CI = { jobs: 13, perFile: { "ci.yml": 12, "publish.yml": 1 } };
const HALMOS = { total: 11 };
const ECHIDNA = 4;
const INVARIANT = { invariants: 4, suites: 1 };

const README = [
  "| Foundry unit + fuzz | ✅ 115 tests across 11 suites (a 25 · b 20 · c 15 · d 12 · e 10 · f 9 · g 8 · h 6 · i 5 · j 3 · k 2) |",
  "| Echidna property fuzzing | ✅ 4 properties |",
  "| Foundry invariant | ✅ 4 invariants in 1 suite × 256 runs × 500 calls |",
  "| Halmos symbolic | ✅ 11 specs |",
  "| CI | ✅ 13 jobs across 2 workflows — `ci.yml` (12): x. `publish.yml` (1): y |",
  "npm test                             # 115 unit + fuzz tests",
  "forge test --match-contract '.*Invariant'   # invariant suite (4 invariants × 256 runs)",
].join("\n");

/** Whitespace-normalised, as the guard compares the whitepaper. */
const WHITEPAPER = [
  "Audit status: 115 Foundry unit/fuzz tests, a handler-only invariant suite (INV-1..4),",
  "11 Halmos symbolic specs over the spend-cap core. Implementation:",
  "**115 Foundry unit/fuzz tests across 11 suites** (a 25 · b 20 · c 15 · d 12 · e 10 · f 9 ·",
  "g 8 · h 6 · i 5 · j 3 · k 2) (plus an invariant suite of 4 invariants and a Base fork",
  "smoke test), 11 Halmos specs, Slither triage, **13-job CI across 2 workflows** (12 in",
  "`ci.yml`, 1 tag-gated publish).",
].join(" ");

const whitepaperActuals = (overrides = {}) => ({
  counts: COUNTS,
  ci: CI,
  ts: null,
  halmos: HALMOS,
  invariant: INVARIANT,
  ...overrides,
});

const readmeActuals = (overrides = {}) => ({
  counts: COUNTS,
  ci: CI,
  halmos: HALMOS,
  echidna: ECHIDNA,
  invariant: INVARIANT,
  ...overrides,
});

// --- resolved invariant configuration ----------------------------------------------------

const CONFIG = { invariant: { runs: 256, depth: 500 } };

test("checkInvariantConfig: matching resolved profiles pass", () => {
  assert.deepEqual(checkInvariantConfig(README, CONFIG, CONFIG), []);
});

test("checkInvariantConfig: CI runs and depth drift are both rejected", () => {
  const problems = checkInvariantConfig(README, { invariant: { runs: 1000, depth: 100 } }, CONFIG);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /CI invariant runs: README says 256, actual is 1000/);
  assert.match(problems[1], /CI invariant depth: README says 500, actual is 100/);
});

test("checkInvariantConfig: local command uses default rather than CI profile", () => {
  const problems = checkInvariantConfig(README, CONFIG, { invariant: { runs: 128 } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /default invariant runs: README says 256, actual is 128/);
});

test("checkInvariantConfig: absent claims fail closed", () => {
  const problems = checkInvariantConfig("", CONFIG, CONFIG);
  assert.equal(problems.length, 3);
  assert.ok(problems.every((p) => p.includes("pattern not found")));
});

test("checkInvariantConfig: missing and invalid configuration fail closed", () => {
  for (const config of [null, {}, { invariant: {} }, { invariant: { runs: "256", depth: 0 } }]) {
    const problems = checkInvariantConfig(README, config, config);
    assert.equal(problems.length, 3);
    assert.ok(problems.every((p) => p.includes("missing or invalid")));
  }
});

// --- countInvariantStats -----------------------------------------------------------------

test("countInvariantStats: counts invariants and suites from fixtures", () => {
  const files = [
    {
      name: "SessionKeyManager.invariant.t.sol",
      text: [
        "contract Counter { function poke() external {} }",
        "contract SessionKeyManagerInvariant is Test {",
        "  function invariant_a() public {}",
        "  function invariant_b() public {}",
        "  function invariant_c() public {}",
        "  function invariant_d() public {}",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(countInvariantStats(files), { invariants: 4, suites: 1 });
});

test("countInvariantStats: counts each invariant-bearing contract in a file", () => {
  const files = [
    {
      name: "Two.invariant.t.sol",
      text: [
        "contract A is Test {",
        "  function invariant_one() public {}",
        "}",
        "abstract contract B is Test {",
        "  function invariant_two() public {}",
        "}",
        "contract Helper {",
        "  function poke() external {}",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(countInvariantStats(files), { invariants: 2, suites: 2 });
});

test("countInvariantStats: ignores non-invariant files and empty input", () => {
  assert.deepEqual(countInvariantStats([]), { invariants: 0, suites: 0 });
  assert.deepEqual(
    countInvariantStats([{ name: "Unit.t.sol", text: "function invariant_x() public {}" }]),
    { invariants: 0, suites: 0 },
  );
});

// --- checkReadmeCounts -------------------------------------------------------------------

test("checkReadmeCounts: a matching README has no problems", () => {
  assert.deepEqual(checkReadmeCounts(README, readmeActuals()), []);
});

test("checkReadmeCounts: flags a drifted invariant table count", () => {
  const drifted = README.replace("✅ 4 invariants in 1 suite", "✅ 5 invariants in 1 suite");
  const problems = checkReadmeCounts(drifted, readmeActuals());
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /README invariant count: README says 5, actual is 4/);
});

test("checkReadmeCounts: flags a drifted invariant suite count", () => {
  const drifted = README.replace("✅ 4 invariants in 1 suite", "✅ 4 invariants in 4 suites");
  const problems = checkReadmeCounts(drifted, readmeActuals());
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /README invariant suite count: README says 4, actual is 1/);
});

test("checkReadmeCounts: flags a drifted inline invariant count", () => {
  const drifted = README.replace("# invariant suite (4 invariants", "# invariant suite (9 invariants");
  const problems = checkReadmeCounts(drifted, readmeActuals());
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /README inline invariant count: README says 9, actual is 4/);
});

test("checkReadmeCounts: flags a missing inline invariant claim", () => {
  const stripped = README.replace(/.*# invariant suite.*\n?/, "");
  const problems = checkReadmeCounts(stripped, readmeActuals());
  assert.ok(problems.some((p) => /README inline invariant count: pattern not found/.test(p)), problems.join("\n"));
});

// --- checkWhitepaperCounts ---------------------------------------------------------------

test("checkWhitepaperCounts: a matching whitepaper has no problems", () => {
  assert.deepEqual(checkWhitepaperCounts(WHITEPAPER, whitepaperActuals()), []);
});

test("checkWhitepaperCounts: checks the second Foundry count phrase when present", () => {
  const drifted = WHITEPAPER.replace("115 Foundry unit/fuzz tests, a handler-only", "116 Foundry unit/fuzz tests, a handler-only");
  const problems = checkWhitepaperCounts(drifted, whitepaperActuals());
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /occurrence 1\): whitepaper says 116, actual is 115/);
});

test("checkWhitepaperCounts: accepts a whitepaper with only one Foundry phrase", () => {
  const single = WHITEPAPER.replace("115 Foundry unit/fuzz tests, a handler-only invariant suite (INV-1..4), ", "");
  assert.deepEqual(checkWhitepaperCounts(single, whitepaperActuals()), []);
});

test("checkWhitepaperCounts: flags a missing Foundry claim entirely", () => {
  const stripped = WHITEPAPER.replace(/115 Foundry unit\/fuzz tests/g, "the suite");
  const problems = checkWhitepaperCounts(stripped, whitepaperActuals());
  assert.ok(problems.some((p) => /could not find the claim in the whitepaper/.test(p)), problems.join("\n"));
});

test("checkWhitepaperCounts: flags a drifted invariant-suite count", () => {
  const drifted = WHITEPAPER.replace("invariant suite of 4 invariants", "invariant suite of 5 invariants");
  const problems = checkWhitepaperCounts(drifted, whitepaperActuals());
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /Invariant suite: whitepaper says 5, actual is 4/);
});

test("checkWhitepaperCounts: compares the TypeScript skipped count", () => {
  const tsText = `${WHITEPAPER} TypeScript: \`@sigilkit/core\` 180 (+1 skipped), \`@sigilkit/indexer\` 12, \`@sigilkit/mcp\` 40, \`@sigilkit/demo-agent\` 12.`;
  const ts = {
    core: { passed: 180, skipped: 1 },
    indexer: { passed: 12, skipped: 0 },
    mcp: { passed: 40, skipped: 0 },
    "demo-agent": { passed: 12, skipped: 0 },
  };
  assert.deepEqual(checkWhitepaperCounts(tsText, whitepaperActuals({ ts })), []);

  const drifted = tsText.replace("(+1 skipped)", "(+3 skipped)");
  const problems = checkWhitepaperCounts(drifted, whitepaperActuals({ ts }));
  assert.ok(problems.some((p) => /says @sigilkit\/core has 3 skipped, actual is 1/.test(p)), problems.join("\n"));
});

test("checkWhitepaperCounts: flags an unstated skipped count when tests were skipped", () => {
  const tsText = `${WHITEPAPER} TypeScript: \`@sigilkit/core\` 180, \`@sigilkit/indexer\` 12, \`@sigilkit/mcp\` 40, \`@sigilkit/demo-agent\` 12.`;
  const ts = {
    core: { passed: 180, skipped: 2 },
    indexer: { passed: 12, skipped: 0 },
    mcp: { passed: 40, skipped: 0 },
    "demo-agent": { passed: 12, skipped: 0 },
  };
  const problems = checkWhitepaperCounts(tsText, whitepaperActuals({ ts }));
  assert.ok(problems.some((p) => /skipped count is unstated, actual is 2/.test(p)), problems.join("\n"));
});

// --- vitest report handling --------------------------------------------------------------

function reportFixture(overrides = {}) {
  return {
    remove() {},
    run() {},
    exists: () => true,
    read: () => JSON.stringify({ numPassedTests: 3, numPendingTests: 0 }),
    ...overrides,
  };
}

test("collectTsReport: preparation failure never runs tests or trusts stale counts", () => {
  let ran = false;
  const result = collectTsReport("fixture", reportFixture({
    remove() { throw new Error("permission denied"); },
    run() { ran = true; },
  }));
  assert.equal(ran, false);
  assert.equal(result.blocked, true);
  assert.equal(result.count, null);
  assert.match(result.problems[0], /report preparation blocked or failed/);
});

test("collectTsReport: read failure is incomplete verification", () => {
  const result = collectTsReport("fixture", reportFixture({
    read() { throw new Error("unreadable"); },
  }));
  assert.equal(result.blocked, true);
  assert.equal(result.count, null);
  assert.match(result.problems[0], /report read blocked or failed/);
});

test("collectTsReport: cleanup failure does not certify collected counts", () => {
  let calls = 0;
  const result = collectTsReport("fixture", reportFixture({
    remove() { if (++calls === 2) throw new Error("cleanup denied"); },
  }));
  assert.equal(calls, 2);
  assert.equal(result.blocked, true);
  assert.equal(result.count, null);
  assert.match(result.problems[0], /report cleanup blocked or failed/);
});

test("collectTsReport: successful collection returns current counts", () => {
  const result = collectTsReport("fixture", reportFixture());
  assert.equal(result.blocked, false);
  assert.deepEqual(result.count, { passed: 3, skipped: 0 });
  assert.deepEqual(result.problems, []);
});

test("parseVitestReport: reads passed and pending totals", () => {
  assert.deepEqual(parseVitestReport(JSON.stringify({ numPassedTests: 7, numPendingTests: 2 })), { passed: 7, skipped: 2 });
  assert.deepEqual(parseVitestReport("{}"), { passed: 0, skipped: 0 });
  assert.throws(() => parseVitestReport("not json"));
});

test("summarizeTsRun: a missing report is a recorded problem, not a silent null", () => {
  const { count, problems } = summarizeTsRun("core", { reportExists: false, reportText: null, runError: null });
  assert.equal(count, null);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /ts \(core\): vitest wrote no report/);
});

test("summarizeTsRun: a crashed run is reported even when a report exists", () => {
  const text = JSON.stringify({ numPassedTests: 3, numPendingTests: 0 });
  const { count, problems } = summarizeTsRun("indexer", { reportExists: true, reportText: text, runError: "exit 1" });
  assert.deepEqual(count, { passed: 3, skipped: 0 });
  assert.ok(problems.some((p) => /ts \(indexer\): vitest run failed — exit 1/.test(p)), problems.join("\n"));
});

test("summarizeTsRun: an unreadable report is reported", () => {
  const { count, problems } = summarizeTsRun("mcp", { reportExists: true, reportText: "{", runError: null });
  assert.equal(count, null);
  assert.ok(problems.some((p) => /ts \(mcp\): vitest report was unreadable/.test(p)), problems.join("\n"));
});

test("summarizeTsRun: a missing report also carries the run error", () => {
  const { problems } = summarizeTsRun("demo-agent", { reportExists: false, reportText: null, runError: "ENOENT" });
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.ok(problems.some((p) => /no report — ENOENT/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /vitest run failed — ENOENT/.test(p)), problems.join("\n"));
});

// --- --write rewrite and fail-closed re-verification -------------------------------------

test("rewriteReadme: repairs the auto-fixable README claims", () => {
  const drifted = README
    .replace("✅ 115 tests across 11 suites", "✅ 54 tests across 9 suites")
    .replace("# 115 unit + fuzz tests", "# 55 unit + fuzz tests")
    .replace("✅ 13 jobs", "✅ 6 jobs")
    .replace("✅ 4 invariants in 1 suite", "✅ 4 invariants in 4 suites")
    .replace("# invariant suite (4 invariants", "# invariant suite (7 invariants");
  const rewritten = rewriteReadme(drifted, { counts: COUNTS, ci: CI, invariant: INVARIANT });
  assert.deepEqual(checkReadmeCounts(rewritten, readmeActuals()), []);
  // Only the claimed numbers change — the surrounding prose is preserved.
  assert.match(rewritten, /✅ 4 invariants in 1 suite × 256 runs × 500 calls/);
  assert.match(rewritten, /# invariant suite \(4 invariants × 256 runs\)/);
});

test("rewriteReadme: uses the singular suite word for a one-suite invariant file", () => {
  const rewritten = rewriteReadme(README, { counts: COUNTS, ci: CI, invariant: { invariants: 4, suites: 1 } });
  assert.match(rewritten, /✅ 4 invariants in 1 suite ×/);
});

test("rerunArgs: re-verification never carries --write", () => {
  const plain = rerunArgs("C:/repo/scripts/check-doc-counts.mjs", { withTs: false });
  assert.deepEqual(plain, ["C:/repo/scripts/check-doc-counts.mjs"]);
  assert.ok(!plain.includes("--write"));
  const withTs = rerunArgs("C:/repo/scripts/check-doc-counts.mjs", { withTs: true });
  assert.deepEqual(withTs, ["C:/repo/scripts/check-doc-counts.mjs", "--with-ts"]);
  assert.ok(!withTs.includes("--write"));
});

test("exitStatusFromError: propagates the child status and defaults to failure", () => {
  assert.equal(exitStatusFromError({ status: 1 }), 1);
  assert.equal(exitStatusFromError({ status: 2 }), 2);
  assert.equal(exitStatusFromError(new Error("spawn failed")), 1);
  assert.equal(exitStatusFromError(undefined), 1);
});

// --- DEBT-07: checkChangelogCounts --------------------------------------------------------

/**
 * A changelog carrying the current entry in `CHANGELOG_ORDER` (newest first) and two older
 * entries holding the historically-true numbers that must never be guarded.
 */
const CHANGELOG_ENTRIES = {
  current: [
    "## [Unreleased]",
    "",
    "### 2026-09-15 — production readiness",
    "",
    "**Tests**",
    "- Suites: core 255 (+1 skipped) · indexer 34 · mcp 40 · demo-agent 12.",
    "- **115 Foundry unit/fuzz tests across 11 suites**, plus 4 invariants in 1 suite.",
    "- Coverage: core 92.5% stmts / 87.9% branches · indexer 72.8/70.9 · mcp 90.7/73.9 ·",
    "  demo-agent 95.8/78.9 — all above their configured floors.",
    "- TD-5: weekly wallet-e2e job caches the pinned MetaMask 13.49.0 bundle.",
  ].join("\n"),
  older: [
    "## [Unreleased]",
    "",
    "### 2026-09-15 — production readiness",
    "",
    "- Suites: core 255 (+1 skipped) · indexer 34 · mcp 40 · demo-agent 12.",
    "",
    "### 2026-09-12 — issues-catalog remediation",
    "",
    "- **91 Foundry unit/fuzz tests across 10 suites**, plus **4 invariant suites**.",
    "- TD-5: the pinned MetaMask 12.5.0 bundle.",
  ].join("\n"),
};

const COVERAGE = {
  core: { lines: 88, functions: 90, branches: 74, statements: 88 },
  indexer: { lines: 70, statements: 70, functions: 70, branches: 65 },
  mcp: { lines: 70, statements: 65, functions: 70, branches: 50 },
  "demo-agent": { lines: 90, statements: 90, functions: 95, branches: 60 },
};

const METAMASK = "13.49.0";
/**
 * The real shape `tsTestCounts` produces: `{ passed, skipped }` per package, from
 * `parseVitestReport`. Fixtures that pass bare numbers here would let a caller comparing
 * `ts[p]` to a Number stay green in the suite while failing 4× in the real CLI, because a
 * number never equals the object the real function hands it.
 */
const CHANGELOG_TS = {
  core: { passed: 255, skipped: 1 },
  indexer: { passed: 34, skipped: 0 },
  mcp: { passed: 40, skipped: 0 },
  "demo-agent": { passed: 12, skipped: 0 },
};

const changelogActuals = (overrides = {}) => ({
  counts: COUNTS,
  invariant: INVARIANT,
  ts: CHANGELOG_TS,
  metamask: METAMASK,
  coverage: COVERAGE,
  ...overrides,
});

test("checkChangelogCounts: a matching current entry has no problems", () => {
  assert.deepEqual(checkChangelogCounts(CHANGELOG_ENTRIES.current, changelogActuals()), []);
});

test("checkChangelogCounts: only the newest dated entry is guarded", () => {
  // The 09-12 entry's 91/10, "4 invariant suites" and MetaMask 12.5.0 are true history;
  // a guard that read them would force a lie onto the release record.
  assert.deepEqual(checkChangelogCounts(CHANGELOG_ENTRIES.older, changelogActuals()), []);
});

test("checkChangelogCounts: a drifted per-package count is caught in the current entry", () => {
  for (const [pkg, drifted] of [["core", 180], ["indexer", 12]]) {
    const text = CHANGELOG_ENTRIES.current.replace(
      /Suites: core (\d+)[^\n]*indexer (\d+)/,
      (_m, c, i) => `Suites: core ${c} · indexer ${i}`,
    ).replace(pkg === "core" ? /core 255/ : /indexer 34/, `${pkg} ${drifted}`);
    const problems = checkChangelogCounts(text, changelogActuals());
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], new RegExp(`says ${pkg} has ${drifted} tests, actual is ${CHANGELOG_TS[pkg].passed}`));
  }
});

test("checkChangelogCounts: drifted Foundry totals and suites are caught", () => {
  const drifted = CHANGELOG_ENTRIES.current
    .replace("**115 Foundry unit/fuzz tests across 11 suites**", "**91 Foundry unit/fuzz tests across 10 suites**");
  const problems = checkChangelogCounts(drifted, changelogActuals());
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.ok(problems.some((p) => /says 91 Foundry tests, actual is 115/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /says 10 Foundry suites, actual is 11/.test(p)), problems.join("\n"));
});

test("checkChangelogCounts: '4 invariant suites' is drift, not a stale number", () => {
  // The recurring error: one invariant file holding four invariants, described as four
  // suites. No run can reconcile it, so it is called out with the correct shape.
  const drifted = CHANGELOG_ENTRIES.current.replace("4 invariants in 1 suite", "4 invariant suites");
  const problems = checkChangelogCounts(drifted, changelogActuals());
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /says "4 invariant suites", but the contracts hold 4 invariants in 1 suite/);
});

test("checkChangelogCounts: a stale MetaMask pin is caught against ci.yml", () => {
  const drifted = CHANGELOG_ENTRIES.current.replace("MetaMask 13.49.0", "MetaMask 12.5.0");
  const problems = checkChangelogCounts(drifted, changelogActuals());
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /says MetaMask 12\.5\.0, ci\.yml pins 13\.49\.0/);
});

test("checkChangelogCounts: coverage below a configured floor is caught", () => {
  // mcp's statements floor is 65 and branches 50; claiming 60/40 falsifies the entry's
  // "all above their configured floors" sentence.
  const drifted = CHANGELOG_ENTRIES.current.replace("mcp 90.7/73.9", "mcp 60.0/40.0");
  const problems = checkChangelogCounts(drifted, changelogActuals());
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.ok(problems.some((p) => /claims mcp 60\.0% stmts, below its configured floor of 65%/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /claims mcp 40\.0% branches, below its configured floor of 50%/.test(p)), problems.join("\n"));
});

test("checkChangelogCounts: a quoted past figure is an anecdote, not a claim", () => {
  // The real entry documents the guard by saying the numbers "had once" read 38 against
  // a real 86. Verifying that quotation would flag the sentence explaining the guard.
  const anecdote = [
    "## [Unreleased]",
    "",
    "### 2026-09-15 — production readiness",
    "",
    '- so the numbers cannot drift silently (they already had once: "38 Foundry tests"',
    "  against a real 86).",
  ].join("\n");
  assert.deepEqual(checkChangelogCounts(anecdote, changelogActuals()), []);
});

test("checkChangelogCounts: an entry making no count claims passes", () => {
  // A docs-only release states no counts; demanding them would block it on an edit it
  // never made. A *wrong* claim is still always caught (covered above).
  const docsOnly = ["## [Unreleased]", "", "### 2026-09-20 — documentation", "", "- Clarified the CLI examples."].join("\n");
  assert.deepEqual(checkChangelogCounts(docsOnly, changelogActuals()), []);
});

test("checkChangelogCounts: TypeScript totals are only checked with --with-ts", () => {
  const drifted = CHANGELOG_ENTRIES.current.replace("core 255", "core 180");
  assert.deepEqual(checkChangelogCounts(drifted, changelogActuals({ ts: null })), []);
  const problems = checkChangelogCounts(drifted, changelogActuals());
  assert.ok(problems.some((p) => /says core has 180 tests, actual is 255/.test(p)), problems.join("\n"));
});

/**
 * Regression (the `actual is [object Object]` bug): `tsTestCounts` hands the checker
 * `{ passed, skipped }` objects, so comparing the claimed number against `ts[p]` compares a
 * Number to an object and is *never* equal. The changelog was fully correct and still
 * reported four drifts. This asserts the correct claim passes, and that a real number
 * mismatch is still caught — the fix must not have become a no-op or a blanket skip.
 */
test("checkChangelogCounts: correct per-package counts pass against tsTestCounts' { passed, skipped } shape", () => {
  const problems = checkChangelogCounts(CHANGELOG_ENTRIES.current, changelogActuals());
  assert.deepEqual(problems, []);
  // No problem may stringify the raw object — that is the fingerprint of the old bug.
  assert.ok(problems.every((p) => !p.includes("[object Object]")));
});

test("checkChangelogCounts: the { passed, skipped } shape still catches every real mismatch", () => {
  for (const [pkg, claimed, actualPassed] of [
    ["core", 180, 255],
    ["indexer", 12, 34],
    ["mcp", 5, 40],
    ["demo-agent", 3, 12],
  ]) {
    const text = CHANGELOG_ENTRIES.current
      .replace(/Suites: core (\d+)(?:\s*\(\+\d+ skipped\))?[^0-9]+indexer (\d+)[^0-9]+mcp (\d+)[^0-9]+demo-agent (\d+)/,
        `Suites: core ${claimed === 180 ? claimed : 255} · indexer ${claimed === 12 ? claimed : 34} · mcp ${claimed === 5 ? claimed : 40} · demo-agent ${claimed === 3 ? claimed : 12}`);
    const ts = { ...CHANGELOG_TS, [pkg]: { passed: actualPassed, skipped: 0 } };
    const problems = checkChangelogCounts(text, changelogActuals({ ts }));
    assert.equal(problems.length, 1, `${pkg}: ${problems.join("\n")}`);
    // The reported "actual" must be the number, never the object.
    assert.match(problems[0], new RegExp(`says ${pkg} has ${claimed} tests, actual is ${actualPassed}`));
  }
});

test("checkChangelogCounts: a package missing from the run is skipped, not reported as 0", () => {
  const ts = { ...CHANGELOG_TS };
  delete ts.mcp;
  assert.deepEqual(checkChangelogCounts(CHANGELOG_ENTRIES.current, changelogActuals({ ts })), []);
});

test("latestChangelogSection: a changelog with no dated entry under [Unreleased] fails closed", () => {
  assert.equal(latestChangelogSection("# Changelog\n\n## [0.1.0] — 2026-08-23\n\n### Added\n"), null);
  const problems = checkChangelogCounts("## [0.1.0] — 2026-08-23\n", changelogActuals());
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /no dated entry under `## \[Unreleased\]`/);
});

test("latestChangelogSection: a non-dated heading is not mistaken for a release entry", () => {
  const text = [
    "## [Unreleased]",
    "",
    "### 2026-09-11 — first remediation wave",
    "",
    "### Added — Contracts (enhancements wave)",
    "",
    "- 38 Foundry tests.",
  ].join("\n");
  // The dated entry is the newest release; the `### Added` category below it is not one.
  assert.match(latestChangelogSection(text), /^### 2026-09-11/);
  assert.ok(!latestChangelogSection(text).includes("38 Foundry tests"));
});

test("metamaskPinFromCi: reads the release asset, ignoring a superseded version in a comment", () => {
  const ci = [
    "# -v1 suffix: the 12.5.0 artefact must not be able to satisfy this key.",
    "run: curl -o metamask.zip \\",
    '  "https://github.com/MetaMask/metamask-extension/releases/download/v13.49.0/metamask-chrome-13.49.0.zip"',
  ].join("\n");
  assert.equal(metamaskPinFromCi(ci), "13.49.0");
  assert.equal(metamaskPinFromCi("no pin here"), null);
});

test("parseCoverageFloors: reads the v8 thresholds and fails closed without them", () => {
  const config = "test: { coverage: { thresholds: { lines: 88, branches: 74 } } }";
  assert.deepEqual(parseCoverageFloors(config), { lines: 88, branches: 74 });
  assert.equal(parseCoverageFloors("export default {}"), null);
});

// --- DEBT-07: checkStatusCounts and checkTroubleshootingCounts --------------------------

const STATUS = [
  "| **L4** | Context | *Why* | Rarely; never normative | `vault/` (22 notes) |",
  "| `vault/` (22 notes) | CONTEXT — private research | L4 | Not normative. |",
  "- It held 22 notes as of 2026-09-25.",
  "| The `vault/` note count changes | Update both `22` occurrences |",
].join("\n");

const TROUBLESHOOTING = [
  "annotate it in place:",
  "",
  "```solidity",
  "// forge-lint: disable-next-line(block-timestamp)",
  "```",
  "",
  "with a comment explaining why. There are 28 such annotations in the repo to copy from.",
].join("\n");

test("checkStatusCounts: the real vault count of 22 passes", () => {
  assert.deepEqual(checkStatusCounts(STATUS, { vault: 22 }), []);
});

test("checkStatusCounts: the stale count of 21 is caught on every occurrence", () => {
  const drifted = STATUS.replaceAll("22", "21");
  const problems = checkStatusCounts(drifted, { vault: 22 });
  // Three `21 notes` claims plus the "`21` occurrences" rule row.
  assert.equal(problems.length, 4, problems.join("\n"));
  assert.ok(problems.every((p) => /says 21 vault notes, actual is 22/.test(p)), problems.join("\n"));
});

test("checkStatusCounts: a partial fix still fails", () => {
  // Updating one table and leaving the trap note stale is the failure mode the file
  // itself warns about, so every occurrence is checked rather than just the first.
  const partial = STATUS.replace("(22 notes) | CONTEXT", "(22 notes) | CONTEXT").replace("It held 22 notes", "It held 21 notes");
  const problems = checkStatusCounts(partial, { vault: 22 });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /says 21 vault notes, actual is 22/);
});

test("checkStatusCounts: a missing claim fails closed", () => {
  const problems = checkStatusCounts("no numbers here", { vault: 22 });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /could not find the vault note count/);
});

test("rewriteStatus: repairs every derivable occurrence and nothing else", () => {
  const rewritten = rewriteStatus(STATUS.replaceAll("22", "21"), { vault: 22 });
  assert.deepEqual(checkStatusCounts(rewritten, { vault: 22 }), []);
  assert.match(rewritten, /`vault\/` \(22 notes\)/);
  assert.match(rewritten, /Update both `22` occurrences/);
});

test("checkStatusCounts: the backticked '22 `vault/` notes' shape is guarded, not just '22 notes'", () => {
  // F-15. The VAULT-AUDIT row reads "Audit of the 22 `vault/` notes" — the digits are
  // separated from "notes" by an inline-code path, so /(\d+) notes\b/ never saw it. The
  // count changed; the guard stayed green; --write reported "changed" while leaving the
  // wrong number in place. This is the false-green in a fixture, so it cannot come back.
  const BT = String.fromCharCode(96);
  const withBackticked = `${STATUS}\n| \`docs/VAULT-AUDIT.md\` | Audit of the 22 ${BT}vault/${BT} notes |`;
  assert.deepEqual(checkStatusCounts(withBackticked, { vault: 22 }), []);

  // Drift ONLY that site. The three plain "22 notes" sites are untouched, so a guard that
  // only knows the plain shape reports nothing at all — which is exactly the bug.
  const drifted = withBackticked.replace(`Audit of the 22 ${BT}vault/${BT} notes`, `Audit of the 21 ${BT}vault/${BT} notes`);
  const problems = checkStatusCounts(drifted, { vault: 22 });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /VAULT-AUDIT row \(21 `vault\/` notes\) says 21 vault notes, actual is 22/);

  // And --write must repair that site too, not just the three it already knew about.
  const repaired = rewriteStatus(drifted, { vault: 22 });
  assert.match(repaired, new RegExp(`Audit of the 22 ${BT}vault/${BT} notes`));
  assert.deepEqual(checkStatusCounts(repaired, { vault: 22 }), []);
});

/**
 * The three real claim shapes, and the site each one lives on. `checkStatusCounts` extracts
 * claims from all three; `rewriteStatus` repairs all three. Both halves are pinned here so
 * that deleting a shape is a RED test rather than a silently narrower gate.
 *
 * This is the executable form of the convention written at check-doc-counts.mjs:523-529
 * ("CONFIRM THE NEW SHAPE MATCHES AT LEAST ONE REAL SITE"). A comment convention is a
 * promise; this is the receipt. Without it, dropping `/(\d+) `vault\/` notes\b/` from the
 * claim extraction would leave the F-15 test at :655 passing — that test builds its own
 * backticked fixture, so it would keep guarding a shape the production extractor no longer
 * reads, and the real `docs/STATUS.md` site would go unwatched.
 */
const STATUS_SHAPES = [
  {
    name: "plain 'N notes'",
    pattern: /(\d+) notes\b/,
    site: "- It held 22 notes as of 2026-09-25.",
    broken: "- It held 21 notes as of 2026-09-25.",
  },
  {
    name: "backticked 'N `vault/` notes'",
    pattern: /(\d+) `vault\/` notes\b/,
    // The backticked shape needs its own site: "| `vault/` (22 notes) |" is matched by the
    // PLAIN pattern too (the "(22 notes)" part), so on that line the two shapes overlap and
    // the plain one wins. The unambiguous site is the F-15 VAULT-AUDIT row, which spells the
    // path between the digits and the word.
    site: "| `docs/VAULT-AUDIT.md` | Audit of the 22 `vault/` notes |",
    broken: "| `docs/VAULT-AUDIT.md` | Audit of the 21 `vault/` notes |",
  },
  {
    name: "the 'update `N` occurrences' rule row",
    pattern: /`(\d+)` occurrences/,
    site: "| The `vault/` note count changes | Update both `22` occurrences |",
    broken: "| The `vault/` note count changes | Update both `21` occurrences |",
  },
];

test("every real STATUS claim shape is still extracted (coverage floor)", () => {
  // Each shape must be recognised on its OWN, with the other two absent from the text.
  // The survivor is the full document minus the other two sites, so losing one shape cannot
  // be masked by the other two still matching.
  for (const shape of STATUS_SHAPES) {
    const only = withoutOtherShapes(shape);
    assert.ok(only.includes(shape.site), `${shape.name}: fixture lost its own site`);
    assert.ok(shape.pattern.test(only), `${shape.name}: the pattern does not match its own site`);
    assert.deepEqual(
      checkStatusCounts(only, { vault: 22 }),
      [],
      `${shape.name}: a single-shape document must be understood, not reported as structure change`,
    );
  }
});

test("losing any one shape is caught, and the other two keep working", () => {
  // The negative control the comment at :523-529 asks for. If a shape were dropped from the
  // extraction, the document carrying ONLY that shape would drift unreported — the gate would
  // keep saying OK while covering less. Each shape is therefore drifted on its own.
  for (const shape of STATUS_SHAPES) {
    const single = withoutOtherShapes(shape);
    const drifted = single.replace(shape.site, shape.broken);
    assert.notEqual(drifted, single, `${shape.name}: the mutation did not apply (test would be vacuous)`);
    const problems = checkStatusCounts(drifted, { vault: 22 });
    assert.equal(problems.length, 1, `${shape.name}: expected one finding, got:\n${problems.join("\n")}`);
    assert.match(problems[0], /says 21 vault notes, actual is 22/, `${shape.name}: ${problems[0]}`);
  }
});

/** The STATUS document carrying `shape`'s claim site and no other. */
function withoutOtherShapes(shape) {
  let text = STATUS;
  // The backticked shape lives on a synthetic VAULT-AUDIT row rather than inside STATUS,
  // so graft that row on when the backticked shape is the survivor.
  if (shape.name.includes("backticked")) {
    const BT = String.fromCharCode(96);
    text = `${STATUS}\n| ${BT}docs/VAULT-AUDIT.md${BT} | ${shape.site}`;
  }
  for (const other of STATUS_SHAPES) {
    if (other !== shape) text = text.replace(other.site, "");
  }
  return text;
}


test("rewriteStatus repairs all three shapes, not only the ones --write already handled", () => {
  // "The check can see it but the repair cannot fix it" is the other half of the rot, and a
  // check-side-only test would miss it. Each shape is drifted on its own and must come back.
  for (const shape of STATUS_SHAPES) {
    const single = withoutOtherShapes(shape);
    const drifted = single.replace(shape.site, shape.broken);
    assert.notEqual(drifted, single, `${shape.name}: the mutation did not apply (test would be vacuous)`);
    const repaired = rewriteStatus(drifted, { vault: 22 });
    assert.ok(
      repaired.includes(shape.site),
      `${shape.name}: --write did not restore this site:\n${repaired}`,
    );
    assert.deepEqual(
      checkStatusCounts(repaired, { vault: 22 }),
      [],
      `${shape.name}: the repaired document must verify clean`,
    );
  }
});

test("rewriteStatus repairs a document in which all three shapes drifted at once", () => {
  // The realistic case: the count changed, so every site is stale simultaneously. This is
  // the one --write actually faces, and it is what the F-15 test at :655 does not cover.
  const BT = String.fromCharCode(96);
  const withAll = `${STATUS}\n| ${BT}docs/VAULT-AUDIT.md${BT} | Audit of the 22 ${BT}vault/${BT} notes |`;
  const drifted = withAll.replaceAll("22", "21");
  assert.notEqual(drifted, withAll, "the mutation did not apply (test would be vacuous)");
  const repaired = rewriteStatus(drifted, { vault: 22 });
  for (const shape of STATUS_SHAPES) {
    assert.ok(repaired.includes(shape.site), `${shape.name}: not restored:\n${repaired}`);
  }
  assert.deepEqual(checkStatusCounts(repaired, { vault: 22 }), []);
});

test("checkStatusCounts: a prose mention of the notes table is not a count claim", () => {
  // "Private research notes" carries no number, so it must not be read as a claim —
  // otherwise a shape-loosening fix would start inventing findings in ordinary prose.
  const BT = String.fromCharCode(96);
  const prose = `${STATUS}\n| \`vault/\` | Private research notes, deliberately non-normative |`;
  assert.deepEqual(checkStatusCounts(prose, { vault: 22 }), []);
});

test("checkStatusCounts: the rule line stays guarded, and is not a target of its own --write", () => {
  // The rule line and the two regexes are a mutually-triggering pair: editing a regex can
  // stop the rule line matching (silent rot of the rule), and editing the rule line's wording
  // can do the same. Both happened during F-15 — a rewrite of this very line made
  // /`(\d+)` occurrences/ stop matching it, and quoting the guarded shape in prose made
  // --write rewrite the rule's own wording. This asserts both properties at once.
  const status = read("docs/STATUS.md");
  const ruleLine = status.split(/\r?\n/).find((l) => l.includes("occurrences") && l.includes("vault"));
  assert.ok(ruleLine, "the update rule line must exist");

  // (a) guarded: the occurrences shape still finds it
  const BT = String.fromCharCode(96);
  assert.ok(
    new RegExp(BT + "(\\d+)" + BT + " occurrences").test(ruleLine),
    "the rule line must still match the occurrences pattern, or the rule is unguarded",
  );

  // (b) not a rewrite target: the guarded backticked shape appears exactly once in the whole
  // file — the VAULT-AUDIT row — and NOT in the rule line that describes it.
  const backticked = [...status.matchAll(new RegExp("(\\d+) " + BT + "vault\\/" + BT + " notes\\b", "g"))];
  assert.equal(backticked.length, 1, `the backticked shape should match only the VAULT-AUDIT row, matched ${backticked.length}`);
  assert.ok(
    !new RegExp("(\\d+) " + BT + "vault\\/" + BT + " notes\\b").test(ruleLine),
    "the rule line must not quote the shape it describes, or --write will rewrite the rule itself",
  );
});

test("checkStatusCounts: a new shape that matches nothing fails closed instead of passing quietly", () => {
  // The property that makes the previous error loud rather than silent: a pattern that
  // matches no site yields zero claims, and zero claims is a FAILURE, not a pass. If this
  // ever returns [] instead, a wrong regex could be merged and rot a document unnoticed.
  const BT = String.fromCharCode(96);
  const onlyUnmatchedShape = `some text with 21 ${BT}notes${BT} and 21 ${BT}vault/${BT} note`;
  const problems = checkStatusCounts(onlyUnmatchedShape, { vault: 22 });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /could not find the vault note count/);
});

test("checkStatusCounts: loosening a shape is caught even when it still matches >= 1 site", () => {
  // Existence and correctness are different properties, guarded by different gates.
  //
  // GATE 2 — uniqueness (over-matching). fail-closed catches a shape matching NOTHING; it
  // cannot catch one that matches the right sites plus prose. Measured on the real
  // STATUS.md: `(\d+)[^|]*notes\b` and `\d+.*notes\b` match 5 sites instead of 3, because
  // they run past the table pipe and swallow the neighbouring paragraph.
  //
  // GATE 3 — a declared count is the ONLY thing that may change. This is the one that
  // catches the quieter failure. Measured on the real rule line (686 chars):
  //
  //   /(\d+)[^|]*notes\b/ and /\d+.*notes\b/  ->  347 chars, rule line truncated
  //   a bare /(\d+)/g (replace every digit run) ->  686 chars, `occurrences` intact, but
  //                                            L4 -> L23 and 2026-09-26 -> 23-23-23
  //
  // The second is the dangerous one: the rule still *reads* intact while now pointing at a
  // layer that does not exist and a document that does not exist, and the guard stays green.
  // Truncation is loud; corrosion is not. Both are covered below, because asserting only one
  // mechanism lets the other through — a shape that changes harm would keep the test green.
  const status = read("docs/STATUS.md");
  const ruleLine = status.split(/\r?\n/).find((l) => l.includes("occurrences") && l.includes("vault"));
  assert.ok(ruleLine, "the update rule line must exist");

  // Tokens that are structure, not counts. A count rewrite must never touch these.
  const structureTokens = (line) => line.match(/\bL\d\b|\d{4}-\d{2}-\d{2}|VAULT-AUDIT-[\w-]+/g) ?? [];
  const before = structureTokens(ruleLine);
  assert.ok(before.length > 0, "the rule line should contain structural tokens worth protecting");

  for (const loose of [/(\d+)[^|]*notes\b/g, /\d+.*notes\b/g, /(\d+)/g]) {
    const corrupted = ruleLine.replace(loose, "23");
    assert.notDeepEqual(
      structureTokens(corrupted),
      before,
      `loosening to ${loose} rewrote structural tokens (L4 / dates / doc names) in the rule line`,
    );
  }

  // And the shipped patterns must change the declared count and nothing else, byte for byte.
  const shipped = rewriteStatus(ruleLine, { vault: 23 });
  assert.deepEqual(structureTokens(shipped), before);
  assert.equal(
    shipped.replace(/23/g, "22"),
    ruleLine,
    "the shipped rewrite must alter only the declared count, leaving every other character identical",
  );
  assert.match(shipped, /`23` occurrences/);
});

test("checkTroubleshootingCounts: the real annotation count passes", () => {
  assert.deepEqual(checkTroubleshootingCounts(TROUBLESHOOTING, { annotations: 28 }), []);
});

test("checkTroubleshootingCounts: the stale count of 31 is caught", () => {
  const drifted = TROUBLESHOOTING.replace("28 such annotations", "31 such annotations");
  const problems = checkTroubleshootingCounts(drifted, { annotations: 28 });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /says 31 forge-lint annotations, actual is 28/);
});

test("checkTroubleshootingCounts: a missing claim fails closed", () => {
  const problems = checkTroubleshootingCounts("no count here", { annotations: 28 });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /could not find the forge-lint annotation count/);
});

test("rewriteTroubleshooting: repairs the count without touching the example", () => {
  const rewritten = rewriteTroubleshooting(drifted(), { annotations: 28 });
  assert.deepEqual(checkTroubleshootingCounts(rewritten, { annotations: 28 }), []);
  // The code block is the thing a reader copies; it must survive verbatim.
  assert.match(rewritten, /\/\/ forge-lint: disable-next-line\(block-timestamp\)/);
  function drifted() {
    return TROUBLESHOOTING.replace("28 such annotations", "31 such annotations");
  }
});

// --- SECURITY.md: the disclosure policy's verification claim ----------------------------

const SECURITY = [
  "## Symbolic verification",
  "",
  "  Run: `halmos --match-contract Halmos` (11 specs: 6 spend-cap/Merkle core + 5 auth-path over a",
  "  rotating window) to reproduce the suite this policy relies on.",
].join("\n");

const halmosActuals = (total) => ({ halmos: { total } });

test("checkSecurityDocCounts: the real SECURITY.md spec count passes", () => {
  assert.deepEqual(checkSecurityDocCounts(SECURITY, halmosActuals(11)), []);
});

test("checkSecurityDocCounts: a wrong total is caught", () => {
  // Injection proof: rewriting "(11 specs:" to "(99 specs:" left all five gates at exit 0
  // before this guard existed. A security document that misstates the verification
  // surface is the last place a reader will take on faith.
  const drifted = SECURITY.replace("(11 specs:", "(99 specs:");
  const problems = checkSecurityDocCounts(drifted, halmosActuals(11));
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /SECURITY: says 99 Halmos specs, actual is 11/);
});

test("checkSecurityDocCounts: a per-area split that does not sum to the total is caught", () => {
  // The headline can stay right while the breakdown is wrong; that is the same
  // partial-fix hole the README breakdown check closes.
  const drifted = SECURITY.replace("6 spend-cap/Merkle core + 5 auth-path", "6 spend-cap/Merkle core + 9 auth-path");
  const problems = checkSecurityDocCounts(drifted, halmosActuals(11));
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /per-area spec split sums to 15, the real total is 11/);
});

test("checkSecurityDocCounts: every occurrence is checked, not just the first", () => {
  const drifted = `${SECURITY}\nA second mention: (7 specs) elsewhere.`;
  const problems = checkSecurityDocCounts(drifted, halmosActuals(11));
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /says 7 Halmos specs, actual is 11/);
});

test("checkSecurityDocCounts: a missing claim fails closed", () => {
  const problems = checkSecurityDocCounts("no count here", halmosActuals(11));
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /could not find the Halmos spec count/);
});

// --- the real documents ------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(REPO_ROOT, ...rel.split("/")), "utf8");

test("real CHANGELOG.md: the current entry's verdicts match what the guard reports", () => {
  // Read-only against the real file. The baseline below is the *live* one — the same numbers
  // `--with-ts` measures (TS 573/162/131/82 with 0 skipped; re-measured 2026-10-02) — so the
  // verdict asserted here is the one the CLI prints, and the two cannot silently disagree.
  // `ts` uses tsTestCounts' real `{ passed, skipped }` shape: a flat number here would
  // reproduce the `[object Object]` bug's blind spot inside the test suite itself.
  const problems = checkChangelogCounts(read("CHANGELOG.md"), {
    counts: { total: 225, suites: 18 },
    invariant: { invariants: 4, suites: 1 },
    ts: {
      core: { passed: 573, skipped: 0 },
      indexer: { passed: 162, skipped: 0 },
      mcp: { passed: 131, skipped: 0 },
      "demo-agent": { passed: 82, skipped: 0 },
    },
    metamask: metamaskPinFromCi(read(".github/workflows/ci.yml")),
    coverage: COVERAGE,
  });
  // The guard is live, so this is the regression the bug produced: with `ts[p]` compared
  // instead of `ts[p]?.passed`, every package drifts with an `[object Object]` "actual".
  assert.ok(
    problems.every((p) => !p.includes("[object Object]")),
    problems.join("\n"),
  );
  // The current entry's totals match a real run, and the entry makes no Foundry, invariant
  // or MetaMask claim, so a correct changelog must produce no drift at all.
  assert.deepEqual(problems, []);
});

test("real SECURITY.md: the disclosed Halmos spec count is the real one", () => {
  // The guard only earns its place if it is green on the real document, so this asserts
  // agreement with the measured count rather than a pinned literal.
  const halmos = { total: 11 };
  assert.deepEqual(checkSecurityDocCounts(read("SECURITY.md"), { halmos }), []);
});

test("real docs/STATUS.md: the vault count agrees with the directory", () => {
  const vault = readdirSync(join(REPO_ROOT, "vault")).filter((f) => f.endsWith(".md")).length;
  assert.equal(vault, 22);
  assert.deepEqual(checkStatusCounts(read("docs/STATUS.md"), { vault }), []);
});

test("real docs/TROUBLESHOOTING.md: the documented annotation count is the real one", () => {
  // The figure grows as contracts add reasoned exemptions, so this measures the real count
  // with the guard's own rule instead of pinning a literal. The previous version passed 49
  // while the repository held 54 and then 56, so it asserted agreement with a number that
  // had stopped being true — a test that could only ever fail for an unrelated reason, and
  // that went red on a teammate's legitimate contract edit rather than on a real defect.
  const annotations = countRealAnnotations();
  assert.deepEqual(checkTroubleshootingCounts(read("docs/TROUBLESHOOTING.md"), { annotations }), []);
});

/** Counts `forge-lint: disable-next-line` lines the way the guard's own counter does. */
function countRealAnnotations() {
  let n = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".sol")) {
        n += (readFileSync(path, "utf8").match(/^.*forge-lint: disable-next-line.*$/gm) ?? []).length;
      }
    }
  };
  walk(join(REPO_ROOT, "contracts"));
  return n;
}

// --- missing-document guard (regression: ENOENT crash) --------------------------------

/**
 * Builds a throwaway repository that has every input the gate reads EXCEPT the one named in
 * `omit`, then runs the real CLI against it. Used to prove a missing document produces a
 * verdict rather than a stack trace.
 */
function runGateInFixture(t, { omit = [], files = {} } = {}) {
  // The fixture lives INSIDE the repository, not in os.tmpdir(). Two reasons, both measured:
  // a `node_modules` junction into the OS temp dir resolves to nothing on this machine
  // (`scandir` fails with UNKNOWN, so `yaml` stays unresolvable and the gate dies on its
  // import), and Node resolves `node_modules` by walking up from the *script's* directory —
  // a temp dir has no repository ancestor to walk up to. Being inside the repo fixes both.
  const parent = mkdtempSync(join(REPO_ROOT, ".docgate-fixture-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "repo");
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(new URL("./check-doc-counts.mjs", import.meta.url), join(root, "scripts/check-doc-counts.mjs"));
  // The gate imports ./lib/exit.mjs and ./lib/cli.mjs relative to the SCRIPT. A fixture
  // copying only check-doc-counts.mjs dies with ERR_MODULE_NOT_FOUND before reaching any
  // document — the same wrong-reason pass the node_modules note below warns about, but one
  // import layer deeper, and invisible until the helpers step actually ran these tests.
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  for (const lib of ["exit.mjs", "cli.mjs"]) {
    copyFileSync(new URL(`./lib/${lib}`, import.meta.url), join(root, "scripts", "lib", lib));
  }

  const inputs = {
    "README.md": "# fixture\n",
    "CHANGELOG.md": "## [Unreleased]\n",
    "docs/STATUS.md": "22 notes\n",
    "docs/TROUBLESHOOTING.md": "49 such annotations\n",
    "docs/WHITEPAPER-v2.1.md": "prose\n",
    ".well-known/security.txt": "Contact: mailto:a@b.c\nExpires: 2099-01-01T00:00:00.000Z\n",
    "contracts/test/Fixture.t.sol": "contract FixtureTest { function check_a() public {} }\n",
    // The gate imports `yaml` at module scope, so a fixture with no node_modules dies with
    // ERR_MODULE_NOT_FOUND before reaching any document. The first draft of these tests hit
    // exactly that and passed for the wrong reason: the failure they asserted against was the
    // import, not the document. A junction to the real node_modules is what makes the fixture
    // reach the code under test.
    "package.json": JSON.stringify({ name: "fixture", private: true }),
    ...files,
  };
  for (const [rel, content] of Object.entries(inputs)) {
    if (omit.includes(rel)) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  // No forge stub and no node_modules copy are needed. The gate imports `yaml` at module
  // scope, which resolves by walking up from the fixture — and the fixture is inside the
  // repository, so the real node_modules is found. The README guard runs *before*
  // forgeCounts(), which is why it was moved to the top of main(); a bogus FORGE_BIN would
  // otherwise exit 2 and mask the document finding, so it is set to a plainly absent value
  // and the assertions below depend on the document being reported instead.
  const result = spawnSync(process.execPath, [join(root, "scripts/check-doc-counts.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORGE_BIN: "definitely-not-forge" },
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("a missing README is reported by name, not crashed on", (t) => {
  // Regression: main() did `readFileSync(readmePath)` with no existsSync guard, so a
  // checkout without a README died with an ENOENT stack trace. A crash is not a verdict —
  // the caller cannot distinguish "this repository is broken" from "this gate is broken",
  // and the report is never built, so every other finding is masked too.
  //
  // The fixture sets a deliberately absent FORGE_BIN. Because the guard now runs *before*
  // forgeCounts(), the document finding is what surfaces; if the guard is ever moved back
  // below the measurement block, the output becomes "could not run `definitely-not-forge`"
  // and the `names README` assertion below fails. The test is wired to the ordering, not
  // just to the presence of an existsSync.
  const result = runGateInFixture(t, { omit: ["README.md"] });
  const output = result.output;
  assert.ok(!/ENOENT/.test(output), `must not crash with ENOENT:\n${output}`);
  assert.ok(!/\bat\b.*check-doc-counts\.m:\d+/.test(output), `must not emit a stack trace:\n${output}`);
  assert.match(output, /README: is missing/);
  // The rewritten gate classifies a missing required document as `unreadable-input` and
  // exits 2 (mirroring `tool-missing`: a verdict could not be produced for this input).
  // What this test must never regress to is the pre-guard behaviour — an ENOENT crash —
  // and that is what the first two assertions pin; the exit code follows the gate's own
  // documented code table, not a historical number.
  assert.equal(result.status, 2, output);
});

test("a missing whitepaper is reported, matching the pre-existing :704 behaviour", (t) => {
  // The whitepaper already had this guard; the README did not. Both must now agree.
  //
  // The whitepaper is read *after* forgeCounts(), so a missing forge exits 2 first and its
  // guard is never reached here — which is exactly why the README guard was hoisted above the
  // measurement block. forge's own exit prints "spawnSync ... ENOENT" by design, so the
  // assertion is scoped to an *unhandled* read of a document, not to the string ENOENT.
  const result = runGateInFixture(t, { omit: ["docs/WHITEPAPER-v2.1.md"] });
  const unhandled = /Error: ENOENT[\s\S]*readFileSync|at readFileSync/.test(result.output);
  assert.ok(!unhandled, `the document read must not throw:\n${result.output}`);
});

test("the README guard fires even when the toolchain it measures is unavailable", (t) => {
  // The ordering guarantee, stated as its own test. forgeCounts() exits 2 without a binary,
  // so if the README guard were below it, a missing README would be reported as a forge
  // problem — or not reported at all. Here forge is *definitely* absent and the README is
  // definitely absent; the finding must still name the README.
  const result = runGateInFixture(t, { omit: ["README.md"] });
  assert.match(result.output, /README: is missing/);
  assert.ok(
    !/could not run `definitely-not-forge/.test(result.output),
    `the document finding must not be masked by forge's exit 2:\n${result.output}`,
  );
});

test("the README guard is a guard, not a catch, and it names the file", () => {
  // A guard whose message does not identify the document is barely better than a crash for
  // whoever has to act on it, so the wording is asserted rather than just the exit code.
  const source = readFileSync(new URL("./check-doc-counts.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(!existsSync\(readmePath\)\)/);
  assert.match(source, /README: is missing/);
  // A try/catch would collapse "absent" and "unreadable" into one indistinguishable code.
  assert.ok(!/try\s*\{[^}]*readFileSync\(readmePath/.test(source));
  // And it must precede forgeCounts(), or a missing README is masked by forge's exit 2.
  assert.ok(
    source.indexOf("!existsSync(readmePath)") < source.indexOf("const counts = forgeCounts()"),
    "the README guard must run before forgeCounts()",
  );
});

// --- direct-invocation guard -------------------------------------------------------------

test("CLI still runs when invoked directly and fails closed without forge", () => {
  // A bogus FORGE_BIN makes forgeCounts exit 2 before any document is read or written,
  // which proves the main() guard fires for a real invocation (importing the module does not).
  const result = spawnSync(process.execPath, ["scripts/check-doc-counts.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, FORGE_BIN: "definitely-not-forge" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /could not run `definitely-not-forge test --list`/);
});
