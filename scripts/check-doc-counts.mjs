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
 *   node scripts/check-doc-counts.mjs --write   # rewrite the README numbers in place
 *
 * Sources of truth: `forge test --list` (no execution) and `.github/workflows/*.yml`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");
/**
 * Also verify the TypeScript test counts in the whitepaper. Off by default because it means
 * running every suite (~1 min); worth turning on before a release, since these are the
 * numbers an auditor or grant reviewer is most likely to check.
 */
const WITH_TS = process.argv.includes("--with-ts");
const FORGE = process.env.FORGE_BIN ?? "forge";

/**
 * Runs each workspace's suite and returns its test totals.
 *
 * `vitest list` cannot be used here: it collapses parameterized cases (it reports 171 for
 * core where a real run reports 181), so only an actual run gives a number worth pinning.
 */
function tsTestCounts() {
  const packages = ["core", "indexer", "mcp", "demo-agent"];
  const out = {};
  for (const p of packages) {
    const pkgDir = join(ROOT, "packages", p);
    const reportPath = join(pkgDir, ".vitest-report.json");
    try {
      execFileSync(
        process.execPath,
        [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--reporter=json", "--outputFile", reportPath],
        { cwd: pkgDir, stdio: ["ignore", "ignore", "ignore"] },
      );
    } catch {
      // A failing suite still writes a report; the failure surfaces via `npm run verify`.
    }
    if (!existsSync(reportPath)) {
      out[p] = null;
      continue;
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    out[p] = { passed: report.numPassedTests ?? 0, skipped: report.numPendingTests ?? 0 };
    rmSync(reportPath, { force: true });
  }
  return out;
}

/**
 * Validates the whitepaper's restated counts (TD-4/TD-10). The README is checked above; the
 * whitepaper repeats the same numbers in prose, where they had already drifted once
 * ("38 Foundry tests" against a real 86).
 */
function checkWhitepaper(counts, ci, ts, halmos) {
  const path = join(ROOT, "docs", "WHITEPAPER-v2.1.md");
  if (!existsSync(path)) return ["whitepaper: docs/WHITEPAPER-v2.1.md is missing"];
  // The numbers wrap across lines in the source; compare against a whitespace-normalised copy.
  const text = readFileSync(path, "utf8").replace(/\s+/g, " ");
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

  expect("Foundry unit/fuzz tests", /(\d+) Foundry unit\/fuzz tests across \d+ suites/, counts.total);
  expect("Foundry suites", /(\d+) Foundry unit\/fuzz tests across (\d+) suites/, counts.suites, 2);
  expect("CI jobs", /(\d+)-job CI across 2 workflows/, ci.jobs);
  expect("ci.yml job count", /(\d+)-job CI across 2 workflows\*{0,2} \((\d+) in `ci\.yml`/, ci.perFile["ci.yml"], 2);
  expect("Halmos specs", /(\d+) Halmos symbolic specs/, halmos.total);
  expect("Halmos specs (status line)", /(\d+) Halmos specs, Slither triage/, halmos.total);

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
    const tsRe = /TypeScript: `@sigilkit\/core` (\d+) \(\+\d+ skipped\), `@sigilkit\/indexer` (\d+), `@sigilkit\/mcp` (\d+), `@sigilkit\/demo-agent` (\d+)/;
    const m = tsRe.exec(text);
    if (!m) {
      problems.push("whitepaper: could not find the TypeScript per-package counts");
    } else {
      const actual = { core: ts.core?.passed, indexer: ts.indexer?.passed, mcp: ts.mcp?.passed, "demo-agent": ts["demo-agent"]?.passed };
      const claimed = { core: Number(m[1]), indexer: Number(m[2]), mcp: Number(m[3]), "demo-agent": Number(m[4]) };
      for (const p of Object.keys(actual)) {
        if (actual[p] === undefined) continue;
        if (claimed[p] !== actual[p]) problems.push(`whitepaper: says ${p} has ${claimed[p]} tests, actual is ${actual[p]}`);
      }
    }
  }

  if (problems.length === 0) {
    console.log(`whitepaper counts OK${ts ? " (including TypeScript totals)" : " (Foundry + CI only; use --with-ts for the TS totals)"}.`);
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

/** Contracts excluded from the PR-gated `npm test` scope (see root package.json). */
const EXCLUDED = /Invariant|Fork/;

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
 * also holds `echidna_sink`, a payable sink that lets the contract receive ETH — it returns
 * nothing and is not a property, so matching on the return type is what keeps the count honest.
 */
function echidnaPropertyCount() {
  const file = join(ROOT, "contracts", "test", "EchidnaProperties.t.sol");
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, "utf8");
  return (text.match(/^\s*function echidna_\w+\([^)]*\)[^{;]*\breturns\s*\(\s*bool\s*\)/gm) ?? []).length;
}

/**
 * Counts the invariant suite: how many `invariant_*` functions, and how many contracts declare
 * them. The docs used to say "4 suites" when there is a single suite holding 4 invariants —
 * the same class of error as the stale "54 unit + 4 invariant = 38 total" arithmetic.
 */
function invariantStats() {
  const dir = join(ROOT, "contracts", "test");
  if (!existsSync(dir)) return { invariants: 0, suites: 0 };
  let invariants = 0;
  let suites = 0;
  for (const f of readdirSync(dir)) {
    if (!/\.invariant\.t\.sol$/.test(f)) continue;
    const text = readFileSync(join(dir, f), "utf8");
    invariants += (text.match(/^\s*function invariant_\w+\(/gm) ?? []).length;
    // Split on contract declarations so a second contract in the same file is counted too.
    for (const block of text.split(/^(?:abstract\s+)?contract\s+/m).slice(1)) {
      if (/^\s*function invariant_\w+\(/m.test(block)) suites++;
    }
  }
  return { invariants, suites };
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
function check(label, pattern, actual) {
  const m = pattern.exec(readme);
  if (!m) {
    problems.push(`${label}: pattern not found in README (docs drifted structurally)`);
    return;
  }
  if (Number(m[1]) !== actual) {
    problems.push(`${label}: README says ${m[1]}, actual is ${actual}`);
  }
}

const TOTAL_RE = /✅\s+(\d+)\s+tests across\s+(\d+)\s+suites/;
const NPM_RE = /npm test\s+#\s+(\d+)\s+unit \+ fuzz tests/;
const JOBS_RE = /✅\s+(\d+)\s+jobs/;

check("README suite total", TOTAL_RE, counts.total);
check("README npm-test count", NPM_RE, counts.total);
check("README CI job count", JOBS_RE, ci.jobs);
check("README Halmos spec count", /✅\s+(\d+)\s+specs/, halmos.total);
check("README Echidna property count", /✅\s+(\d+)\s+properties/, echidna);

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

// The whitepaper restates the same counts in prose. --with-ts runs every suite to also
// verify the per-package TypeScript totals.
problems.push(...checkWhitepaper(counts, ci, WITH_TS ? tsTestCounts() : null, halmos));

if (problems.length === 0) {
  console.log("\ndoc counts OK — README and whitepaper match the toolchain.");
  process.exit(0);
}

if (WRITE) {
  readme = readme
    .replace(TOTAL_RE, `✅ ${counts.total} tests across ${counts.suites} suites`)
    .replace(NPM_RE, `npm test                             # ${counts.total} unit + fuzz tests`)
    .replace(JOBS_RE, `✅ ${ci.jobs} jobs`);
  writeFileSync(readmePath, readme);
  console.log("\ndoc counts rewritten in README.md — re-run to verify.");
  console.log("The whitepaper's prose counts are not auto-rewritten; update them by hand if it drifted.");
  process.exit(0);
}

console.error(`\ndoc count drift (${problems.length}):`);
for (const p of problems) console.error(`  ${p}`);
console.error("\nRun with --write to update README.md, then update the suite breakdown by hand.");
console.error("Whitepaper counts are prose — fix them manually (--with-ts also checks the TS totals).");
process.exit(1);
