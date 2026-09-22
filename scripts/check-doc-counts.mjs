#!/usr/bin/env node
/**
 * Documentation count guard (BUG-8 / TD-4) + RFC 9116 security.txt guard (TD-7).
 *
 * The README, CHANGELOG and whitepaper each restated the project's test and job counts
 * by hand, and all three drifted (54 / 55 / 38 Foundry tests against a real 86, and a
 * "6-job CI" against a real 10). A reviewer's first credibility check is whether the
 * claimed numbers exist — so the numbers are now checked against the tooling itself.
 *
 * Additionally validates `.well-known/security.txt`: required fields present, at least
 * one Contact URI, and an unexpired Expires date. An expired security.txt fails this
 * job, so the disclosure channel cannot silently rot (TD-7).
 *
 *   node scripts/check-doc-counts.mjs           # verify (exit 1 on drift)
 *   node scripts/check-doc-counts.mjs --write   # rewrite the README numbers, then re-verify
 *
 * Sources of truth: `forge test --list` (no execution) and `.github/workflows/*.yml`.
 *
 * The pure helpers below (counts, claim comparison, report summarising) are exported so
 * `scripts/check-doc-counts.test.mjs` can exercise them against isolated fixtures without
 * touching the real README/whitepaper. The script only runs when invoked directly.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORGE = process.env.FORGE_BIN ?? "forge";

/** Contracts excluded from the PR-gated `npm test` scope (see root package.json). */
export const EXCLUDED = /Invariant|Fork/;

/** README claim shapes, shared by the verifier and the `--write` rewriter. */
export const README_PATTERNS = {
  total: /✅\s+(\d+)\s+tests across\s+(\d+)\s+suites/,
  npm: /npm test\s+#\s+(\d+)\s+unit \+ fuzz tests/,
  jobs: /✅\s+(\d+)\s+jobs/,
  invariantTable: /✅\s+(\d+)\s+invariants?\s+in\s+(\d+)\s+suites?/,
  invariantInline: /#\s*invariant suite \((\d+)\s+invariants?/,
};

/**
 * Runs each workspace's suite and returns its test totals.
 *
 * `vitest list` cannot be used here: it collapses parameterized cases (it reports 171 for
 * core where a real run reports 181), so only an actual run gives a number worth pinning.
 */
function tsTestCounts() {
  const packages = ["core", "indexer", "mcp", "demo-agent"];
  const out = {};
  const problems = [];
  for (const p of packages) {
    const pkgDir = join(ROOT, "packages", p);
    const reportPath = join(pkgDir, ".vitest-report.json");
    const result = collectTsReport(p, {
      remove: () => rmSync(reportPath, { force: true }),
      exists: () => existsSync(reportPath),
      read: () => readFileSync(reportPath, "utf8"),
      run: () => execFileSync(
        process.execPath,
        [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--reporter=json", "--outputFile", reportPath],
        { cwd: pkgDir, stdio: ["ignore", "ignore", "ignore"] },
      ),
    });
    out[p] = result.count;
    problems.push(...result.problems);
    // A filesystem failure is not permission to retry elsewhere. Preserve the report,
    // stop further workspace execution, and let main return a non-zero result.
    if (result.blocked) break;
  }
  return { counts: out, problems };
}

/** Collect one report with injectable I/O; blocked operations never certify stale counts. */
export function collectTsReport(pkg, io) {
  const message = (err) => err instanceof Error ? err.message : String(err);
  const blocked = (stage, err) => ({
    count: null,
    blocked: true,
    problems: [`ts (${pkg}): ${stage} blocked or failed; verification incomplete — ${message(err)}`],
  });
  try {
    io.remove();
  } catch (err) {
    return blocked("report preparation", err);
  }
  let runError = null;
  try {
    io.run();
  } catch (err) {
    runError = message(err);
  }
  let reportExists;
  let reportText;
  try {
    reportExists = io.exists();
    reportText = reportExists ? io.read() : null;
  } catch (err) {
    return blocked("report read", err);
  }
  const result = summarizeTsRun(pkg, { reportExists, reportText, runError });
  if (reportExists) {
    try {
      io.remove();
    } catch (err) {
      const failure = blocked("report cleanup", err);
      return { ...failure, problems: [...result.problems, ...failure.problems] };
    }
  }
  return { ...result, blocked: false };
}

/**
 * Pure summariser for one workspace's vitest run. A missing/unreadable report or a failing
 * suite is reported as a problem rather than silently recorded as `null` — the previous
 * behaviour let `--with-ts` pass while a suite had actually crashed.
 */
export function summarizeTsRun(pkg, { reportExists, reportText, runError }) {
  const problems = [];
  let count = null;
  if (!reportExists) {
    problems.push(`ts (${pkg}): vitest wrote no report${runError ? ` — ${runError}` : ""}`);
  } else {
    try {
      count = parseVitestReport(reportText);
    } catch (err) {
      problems.push(`ts (${pkg}): vitest report was unreadable — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (runError) problems.push(`ts (${pkg}): vitest run failed — ${runError}`);
  return { count, problems };
}

/** Extracts the pinned totals from a vitest JSON report. */
export function parseVitestReport(jsonText) {
  const report = JSON.parse(jsonText);
  return {
    passed: report.numPassedTests ?? 0,
    skipped: report.numPendingTests ?? 0,
  };
}

/**
 * Rewrites the auto-fixable README claims (pure, so tests can assert the rewrite without
 * touching the real README). The whitepaper prose and the suite breakdown are deliberately
 * left alone — they are verified, not rewritten, and remaining drift must still fail.
 */
export function rewriteReadme(readme, { counts, ci, invariant }) {
  const suiteWord = invariant.suites === 1 ? "suite" : "suites";
  return readme
    .replace(README_PATTERNS.total, `✅ ${counts.total} tests across ${counts.suites} suites`)
    .replace(README_PATTERNS.npm, `npm test                             # ${counts.total} unit + fuzz tests`)
    .replace(README_PATTERNS.jobs, `✅ ${ci.jobs} jobs`)
    .replace(README_PATTERNS.invariantTable, `✅ ${invariant.invariants} invariants in ${invariant.suites} ${suiteWord}`)
    .replace(README_PATTERNS.invariantInline, `# invariant suite (${invariant.invariants} invariants`);
}

/**
 * Arguments for the post-rewrite re-verification. `--write` is deliberately never included:
 * the re-run must observe drift, not rewrite it away, or `--write` could exit 0 with drift
 * still present.
 */
export function rerunArgs(scriptPath, { withTs }) {
  return withTs ? [scriptPath, "--with-ts"] : [scriptPath];
}

/** Maps a child-process failure to an exit status, defaulting to 1 (fail closed). */
export function exitStatusFromError(err) {
  return typeof err?.status === "number" ? err.status : 1;
}

/**
 * Compares the whitepaper's restated counts (TD-4/TD-10). The README is checked by
 * `checkReadmeCounts`; the whitepaper repeats the same numbers in prose, where they had
 * already drifted once ("38 Foundry tests" against a real 86). `text` must be the
 * whitespace-normalised file contents (the numbers wrap across lines in the source).
 */
export function checkWhitepaperCounts(text, { counts, ci, ts, halmos, invariant }) {
  const problems = [];

  const expect = (label, re, actual, group = 1) => {
    const m = re.exec(text);
    if (!m) {
      problems.push(`${label}: could not find the claim in the whitepaper (prose changed shape?)`);
      return;
    }
    if (Number(m[group]) !== actual) {
      problems.push(`${label}: whitepaper says ${m[group]}, actual is ${actual}`);
    }
  };

  // Every "N Foundry unit/fuzz tests" phrase must match — the audit-status banner and the
  // implementation-status paragraph both restate the total, and the banner is the phrase a
  // reviewer reads first. A single hard-coded regex only pinned one of them.
  const foundryPhrases = [...text.matchAll(/(\d+) Foundry unit\/fuzz tests/g)];
  if (foundryPhrases.length === 0) {
    problems.push("Foundry unit/fuzz tests: could not find the claim in the whitepaper (prose changed shape?)");
  } else {
    foundryPhrases.forEach((m, i) => {
      if (Number(m[1]) !== counts.total) {
        problems.push(`Foundry unit/fuzz tests (occurrence ${i + 1}): whitepaper says ${m[1]}, actual is ${counts.total}`);
      }
    });
  }
  expect("Foundry suites", /(\d+) Foundry unit\/fuzz tests across (\d+) suites/, counts.suites, 2);
  expect("CI jobs", /(\d+)-job CI across 2 workflows/, ci.jobs);
  expect("ci.yml job count", /(\d+)-job CI across 2 workflows\*{0,2} \((\d+) in `ci\.yml`/, ci.perFile["ci.yml"], 2);
  expect("Halmos specs", /(\d+) Halmos symbolic specs/, halmos.total);
  expect("Halmos specs (status line)", /(\d+) Halmos specs, Slither triage/, halmos.total);
  // The whitepaper used to call the invariant suite "4 suites" when it is one suite holding
  // four invariants; pin the invariant count against the contracts themselves.
  expect("Invariant suite", /invariant suite of (\d+) invariants/, invariant.invariants);

  // The suite breakdown must sum to the headline, same rule as the README.
  const breakdown = /(\d+) Foundry unit\/fuzz tests across \d+ suites \(([^)]*)\)/.exec(text);
  if (breakdown) {
    const nums = breakdown[2]
      .split("·")
      .map((s) => /(\d+)\s*$/.exec(s.trim()))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    const sum = nums.reduce((a, b) => a + b, 0);
    if (sum !== counts.total) problems.push(`whitepaper: suite breakdown sums to ${sum}, headline is ${counts.total}`);
  }

  if (ts) {
    const tsRe = /TypeScript: `@sigilkit\/core` (\d+)(?: \(\+(\d+) skipped\))?, `@sigilkit\/indexer` (\d+), `@sigilkit\/mcp` (\d+), `@sigilkit\/demo-agent` (\d+)/;
    const m = tsRe.exec(text);
    if (!m) {
      problems.push("whitepaper: could not find the TypeScript per-package counts");
    } else {
      const actual = { core: ts.core?.passed, indexer: ts.indexer?.passed, mcp: ts.mcp?.passed, "demo-agent": ts["demo-agent"]?.passed };
      const claimed = { core: Number(m[1]), indexer: Number(m[3]), mcp: Number(m[4]), "demo-agent": Number(m[5]) };
      for (const p of Object.keys(actual)) {
        if (actual[p] === undefined) continue;
        if (claimed[p] !== actual[p]) problems.push(`whitepaper: says ${p} has ${claimed[p]} tests, actual is ${actual[p]}`);
      }
      // The skipped count is part of the claim, not decoration: a run that skips more than
      // the docs admit is a smaller suite than advertised.
      const claimedSkipped = m[2] === undefined ? null : Number(m[2]);
      const actualSkipped = ts.core?.skipped;
      if (claimedSkipped !== null && actualSkipped !== undefined && claimedSkipped !== actualSkipped) {
        problems.push(`whitepaper: says @sigilkit/core has ${claimedSkipped} skipped, actual is ${actualSkipped}`);
      } else if (claimedSkipped === null && actualSkipped) {
        problems.push(`whitepaper: @sigilkit/core skipped count is unstated, actual is ${actualSkipped}`);
      }
    }
  }

  return problems;
}

/**
 * Pure README claim comparison. Returns a list of problems (empty = OK).
 */
export function checkReadmeCounts(readme, { counts, ci, halmos, echidna, invariant }) {
  const problems = [];
  const check = (label, pattern, actual, group = 1) => {
    const m = pattern.exec(readme);
    if (!m) {
      problems.push(`${label}: pattern not found in README (docs drifted structurally)`);
      return;
    }
    if (Number(m[group]) !== actual) {
      problems.push(`${label}: README says ${m[group]}, actual is ${actual}`);
    }
  };

  check("README suite total", README_PATTERNS.total, counts.total);
  check("README npm-test count", README_PATTERNS.npm, counts.total);
  check("README CI job count", README_PATTERNS.jobs, ci.jobs);
  check("README Halmos spec count", /✅\s+(\d+)\s+specs/, halmos.total);
  check("README Echidna property count", /✅\s+(\d+)\s+properties/, echidna);
  // The invariant row states both numbers ("4 invariants in 1 suite"); they drifted apart
  // once already, so each is pinned separately against the contracts.
  check("README invariant count", README_PATTERNS.invariantTable, invariant.invariants, 1);
  check("README invariant suite count", README_PATTERNS.invariantTable, invariant.suites, 2);
  // The copy-pasteable command repeats the invariant count in its trailing comment.
  check("README inline invariant count", README_PATTERNS.invariantInline, invariant.invariants);

  // Per-workflow breakdown, e.g. "`ci.yml` (12): … `publish.yml` (1): …" — must match the
  // real job count in each file, otherwise the prose drifts from the pipeline it describes.
  for (const [file, n] of Object.entries(ci.perFile)) {
    const re = new RegExp("`" + file.replace(".", "\\.") + "`\\s*\\((\\d+)\\)");
    const m = re.exec(readme);
    if (!m) {
      problems.push(`README does not state a job count for ${file}`);
    } else if (Number(m[1]) !== n) {
      problems.push(`README says ${file} has ${m[1]} jobs, actual is ${n}`);
    }
  }

  const suitesMatch = /✅\s+\d+\s+tests across\s+(\d+)\s+suites/.exec(readme);
  if (suitesMatch && Number(suitesMatch[1]) !== counts.suites) {
    problems.push(`README suite count: says ${suitesMatch[1]}, actual is ${counts.suites}`);
  }

  // The parenthetical breakdown ("manager 23 · 7579 module 25 · …") must contain one entry
  // per suite and sum to the headline total — otherwise a suite can be silently dropped
  // from the list while the headline number stays right.
  const breakdownMatch = /✅\s+\d+\s+tests across\s+\d+\s+suites\s*\(([^)]*)\)/.exec(readme);
  if (breakdownMatch) {
    const entries = breakdownMatch[1]
      .split("·")
      .map((s) => s.trim())
      .filter(Boolean);
    const nums = entries.map((e) => {
      const m = /(\d+)\s*$/.exec(e);
      return m ? Number(m[1]) : NaN;
    });
    if (nums.some(Number.isNaN)) {
      problems.push(`README breakdown: could not parse a count from ${JSON.stringify(entries)}`);
    } else {
      const sum = nums.reduce((a, b) => a + b, 0);
      if (sum !== counts.total) {
        problems.push(`README breakdown sums to ${sum}, headline total is ${counts.total}`);
      }
      if (entries.length !== counts.suites) {
        problems.push(`README breakdown lists ${entries.length} suites, actual is ${counts.suites}`);
      }
    }
  }

  return problems;
}

/**
 * Validates the whitepaper's restated counts. Thin I/O wrapper: reads and normalises the
 * file, delegates to `checkWhitepaperCounts`, and logs the outcome.
 */
function checkWhitepaper(actuals) {
  const path = join(ROOT, "docs", "WHITEPAPER-v2.1.md");
  if (!existsSync(path)) return ["whitepaper: docs/WHITEPAPER-v2.1.md is missing"];
  // The numbers wrap across lines in the source; compare against a whitespace-normalised copy.
  const text = readFileSync(path, "utf8").replace(/\s+/g, " ");
  const problems = checkWhitepaperCounts(text, actuals);

  if (problems.length === 0) {
    console.log(`whitepaper counts OK${actuals.ts ? " (including TypeScript totals)" : " (Foundry + CI only; use --with-ts for the TS totals)"}.`);
  } else {
    for (const p of problems) console.error(`  ${p}`);
  }
  return problems;
}

/**
 * RFC 9116 security.txt guard (TD-7). Checks the staged disclosure channel:
 * required fields, a usable Contact, and an Expires date in the future. Returns a
 * list of problems (empty = OK). Runs before any forge invocation so it also guards
 * environments without the Foundry toolchain.
 */
function checkSecurityTxt() {
  const path = join(ROOT, ".well-known", "security.txt");
  if (!existsSync(path)) {
    return ["security.txt: missing at .well-known/security.txt (TD-7)"];
  }
  const problems = [];
  const fields = new Map();
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    fields.set(key, [...(fields.get(key) ?? []), value]);
  }
  if (!fields.has("Contact")) problems.push("security.txt: no Contact field (RFC 9116 §2.5.2 requires exactly this)");
  const contacts = fields.get("Contact") ?? [];
  if (contacts.length === 0 || contacts.every((c) => !/^(mailto:|https?:\/\/)/.test(c))) {
    problems.push("security.txt: every Contact must be a mailto: or http(s):// URI");
  }
  if (!fields.has("Expires")) {
    problems.push("security.txt: no Expires field (RFC 9116 §2.5.4 requires one)");
  } else {
    const expires = new Date(fields.get("Expires")[0]);
    if (Number.isNaN(expires.getTime())) {
      problems.push("security.txt: Expires is not a valid ISO 8601 datetime");
    } else if (expires.getTime() < Date.now()) {
      problems.push(
        `security.txt: Expires ${fields.get("Expires")[0]} is in the past — refresh it (RFC 9116 recommends ≤ 12 months)`,
      );
    }
  }
  if (problems.length === 0) {
    console.log("security.txt OK — disclosure channel present and unexpired.");
  } else {
    for (const p of problems) console.error(`  ${p}`);
  }
  return problems;
}

function forgeCounts() {
  let out;
  try {
    out = execFileSync(FORGE, ["test", "--list"], { cwd: ROOT, encoding: "utf8" });
  } catch (err) {
    console.error(
      `could not run \`${FORGE} test --list\`. Set FORGE_BIN to the forge executable path.\n` +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(2);
  }

  const contracts = new Map(); // contract name -> test count
  let current = null;
  for (const line of out.split("\n")) {
    if (/^\S/.test(line) && line.includes(".sol")) {
      current = null;
      continue;
    }
    const m = /^ {2}(\S.*)$/.exec(line);
    if (m && !/^\s{4}/.test(line)) {
      current = m[1].trim();
      if (!contracts.has(current)) contracts.set(current, 0);
      continue;
    }
    if (/^ {4}\S/.test(line) && current) {
      contracts.set(current, (contracts.get(current) ?? 0) + 1);
    }
  }

  const included = [...contracts.entries()].filter(([name]) => !EXCLUDED.test(name));
  const excluded = [...contracts.entries()].filter(([name]) => EXCLUDED.test(name));
  return {
    total: included.reduce((n, [, c]) => n + c, 0),
    suites: included.length,
    breakdown: included.sort((a, b) => b[1] - a[1]),
    excludedTotal: excluded.reduce((n, [, c]) => n + c, 0),
    excludedSuites: excluded.length,
  };
}

/**
 * Counts Halmos specs across the symbolic-verification contracts.
 *
 * Halmos collects functions named `check_*`; helpers deliberately avoid that prefix (e.g.
 * `checkRolled`), so this mirrors what the tool would actually run. Statically countable, which
 * matters because Halmos is not installed everywhere the docs are read.
 */
function halmosSpecCount() {
  const dir = join(ROOT, "contracts", "test");
  if (!existsSync(dir)) return { total: 0, perFile: {} };
  const perFile = {};
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!/^Halmos.*\.t\.sol$/.test(f)) continue;
    const n = (readFileSync(join(dir, f), "utf8").match(/^\s*function check_/gm) ?? []).length;
    perFile[f] = n;
    total += n;
  }
  return { total, perFile };
}

/**
 * Counts the Echidna properties.
 *
 * A property is an `echidna_*` function returning `bool` under `testMode: property`. The file
 * also holds `sink`, a payable sink that lets the contract receive ETH — it returns
 * nothing and is not a property, so matching on the return type is what keeps the count honest.
 */
function echidnaPropertyCount() {
  const file = join(ROOT, "contracts", "test", "EchidnaProperties.t.sol");
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, "utf8");
  return (text.match(/^\s*function echidna_\w+\([^)]*\)[^{;]*\breturns\s*\(\s*bool\s*\)/gm) ?? []).length;
}

/**
 * Pure invariant counter: how many `invariant_*` functions, and how many contracts declare
 * them. Takes `{ name, text }` entries so tests can feed fixtures instead of reading disk.
 * The docs used to say "4 suites" when there is a single suite holding 4 invariants — the
 * same class of error as the stale "54 unit + 4 invariant = 38 total" arithmetic.
 */
export function countInvariantStats(files) {
  let invariants = 0;
  let suites = 0;
  for (const { name, text } of files) {
    if (!/\.invariant\.t\.sol$/.test(name)) continue;
    invariants += (text.match(/^\s*function invariant_\w+\(/gm) ?? []).length;
    // Split on contract declarations so a second contract in the same file is counted too.
    for (const block of text.split(/^(?:abstract\s+)?contract\s+/m).slice(1)) {
      if (/^\s*function invariant_\w+\(/m.test(block)) suites++;
    }
  }
  return { invariants, suites };
}

/** Reads the invariant test files and delegates to `countInvariantStats`. */
function invariantStats() {
  const dir = join(ROOT, "contracts", "test");
  if (!existsSync(dir)) return { invariants: 0, suites: 0 };
  const files = readdirSync(dir)
    .filter((f) => /\.invariant\.t\.sol$/.test(f))
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }));
  return countInvariantStats(files);
}

/** Compare documented budgets with resolved Foundry profiles; never assume defaults. */
export function checkInvariantConfig(readme, ciConfig, defaultConfig) {
  const problems = [];
  const table = /invariants?\s+in\s+\d+\s+suites?\s*×\s*(\d+)\s+runs\s*×\s*(\d+)\s+calls/.exec(readme);
  const inline = /#\s*invariant suite \(\d+\s+invariants?\s*×\s*(\d+)\s+runs/.exec(readme);
  for (const [label, match, group, actual] of [
    ["README CI invariant runs", table, 1, ciConfig?.invariant?.runs],
    ["README CI invariant depth", table, 2, ciConfig?.invariant?.depth],
    ["README default invariant runs", inline, 1, defaultConfig?.invariant?.runs],
  ]) {
    if (!Number.isSafeInteger(actual) || actual <= 0) {
      problems.push(`${label}: resolved Foundry configuration is missing or invalid`);
    } else if (!match) {
      problems.push(`${label}: pattern not found in README (docs drifted structurally)`);
    } else if (Number(match[group]) !== actual) {
      problems.push(`${label}: README says ${match[group]}, actual is ${actual}`);
    }
  }
  return problems;
}

function resolvedFoundryConfig(profile) {
  return JSON.parse(execFileSync(FORGE, ["config", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, FOUNDRY_PROFILE: profile },
  }));
}

function ciJobCount() {
  const dir = join(ROOT, ".github", "workflows");
  let jobs = 0;
  const names = [];
  const perFile = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
    const doc = parseYaml(readFileSync(join(dir, f), "utf8"));
    const fileJobs = Object.keys(doc?.jobs ?? {});
    perFile[f] = fileJobs.length;
    for (const j of fileJobs) {
      jobs++;
      names.push(j);
    }
  }
  return { jobs, names, perFile };
}

function main() {
  const WRITE = process.argv.includes("--write");
  /**
   * Also verify the TypeScript test counts in the whitepaper. Off by default because it means
   * running every suite (~1 min); worth turning on before a release, since these are the
   * numbers an auditor or grant reviewer is most likely to check.
   */
  const WITH_TS = process.argv.includes("--with-ts");

  const counts = forgeCounts();
  const ci = ciJobCount();
  const halmos = halmosSpecCount();
  const echidna = echidnaPropertyCount();
  const invariant = invariantStats();
  const readmePath = join(ROOT, "README.md");
  let readme = readFileSync(readmePath, "utf8");

  console.log(`forge (PR scope): ${counts.total} tests across ${counts.suites} suites`);
  console.log(`forge (excluded: invariant + fork): ${counts.excludedTotal} tests across ${counts.excludedSuites} suites`);
  console.log(`CI jobs: ${ci.jobs} (${ci.names.join(", ")})`);
  console.log(`Halmos specs: ${halmos.total} (${Object.entries(halmos.perFile).map(([f, n]) => `${f} ${n}`).join(", ")})`);
  console.log(`Echidna properties: ${echidna}`);
  console.log(`Invariant suite: ${invariant.invariants} invariants across ${invariant.suites} suite(s)`);

  const problems = [...checkSecurityTxt()];
  problems.push(...checkReadmeCounts(readme, { counts, ci, halmos, echidna, invariant }));
  try {
    problems.push(...checkInvariantConfig(readme, resolvedFoundryConfig("ci"), resolvedFoundryConfig("default")));
  } catch (err) {
    problems.push(`Invariant configuration: verification incomplete — ${err instanceof Error ? err.message : String(err)}`);
  }

  // The whitepaper restates the same counts in prose. --with-ts runs every suite to also
  // verify the per-package TypeScript totals (and their skipped counts).
  const ts = WITH_TS ? tsTestCounts() : null;
  if (ts) problems.push(...ts.problems);
  problems.push(...checkWhitepaper({ counts, ci, ts: ts?.counts ?? null, halmos, invariant }));

  if (problems.length === 0) {
    console.log("\ndoc counts OK — README and whitepaper match the toolchain.");
    process.exit(0);
  }

  if (WRITE) {
    readme = rewriteReadme(readme, { counts, ci, invariant });
    writeFileSync(readmePath, readme);
    console.log("\ndoc counts rewritten in README.md — re-verifying without --write...");

    // Fail closed: a rewrite is only a success if the re-verification passes. The whitepaper
    // and the README suite breakdown are not auto-rewritten, so any drift they still carry
    // must propagate as a non-zero exit rather than being reported as a clean rewrite.
    let status = 1;
    try {
      execFileSync(process.execPath, rerunArgs(fileURLToPath(import.meta.url), { withTs: WITH_TS }), {
        cwd: ROOT,
        stdio: "inherit",
        env: process.env,
      });
      status = 0;
    } catch (err) {
      status = exitStatusFromError(err);
    }
    if (status !== 0) {
      console.error("README was rewritten but drift remains — fix the remaining claims by hand.");
    }
    process.exit(status);
  }

  console.error(`\ndoc count drift (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nRun with --write to update README.md, then update the suite breakdown by hand.");
  console.error("Whitepaper counts are prose — fix them manually (--with-ts also checks the TS totals).");
  process.exit(1);
}

/** True when this module is the process entry point (not imported by the test file). */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolved = pathToFileURL(entry).href;
  return process.platform === "win32"
    ? resolved.toLowerCase() === import.meta.url.toLowerCase()
    : resolved === import.meta.url;
}

if (isDirectInvocation()) main();
