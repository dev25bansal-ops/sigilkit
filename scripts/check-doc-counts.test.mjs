import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  countInvariantStats,
  checkInvariantConfig,
  checkReadmeCounts,
  checkWhitepaperCounts,
  parseVitestReport,
  summarizeTsRun,
  collectTsReport,
  rewriteReadme,
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
