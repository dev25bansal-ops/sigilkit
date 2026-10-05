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
 * DEBT-07: the header claimed a CHANGELOG guard that the code never implemented — only
 * the README and whitepaper were read. The CHANGELOG had six drifted restatements
 * (`core` 180 against a real 255, `indexer` 12 against 34, a MetaMask 12.5.0 pin against
 * ci.yml's 13.49.0, "4 invariant suites" against 4 invariants in 1 suite, coverage
 * percentages and a 91/10 Foundry total) none of which could fail the build. The same
 * class of drift hides in `docs/STATUS.md` (the vault note count) and
 * `docs/TROUBLESHOOTING.md` (the forge-lint annotation count), so all three are checked
 * now. Only the CHANGELOG's *latest* dated entry is guarded: an older entry's numbers
 * were true when written, and rewriting a historical record would be a lie.
 *
 *   node scripts/check-doc-counts.mjs           # verify (exit 1 on drift)
 *   node scripts/check-doc-counts.mjs --write   # rewrite the derivable numbers, then re-verify
 *   node scripts/check-doc-counts.mjs --with-ts # also verify the TypeScript test totals (~1 min)
 *
 * An unrecognised argument exits 2: the check could not run as asked, which is not a pass.
 *
 * Sources of truth: `forge test --list` (no execution), `.github/workflows/*.yml`, the
 * per-package `vitest.config.ts` coverage thresholds, the Solidity sources, and the
 * vault directory listing.
 *
 * The pure helpers below (counts, claim comparison, report summarising) are exported so
 * `scripts/check-doc-counts.test.mjs` can exercise them against isolated fixtures without
 * touching the real documents. The script only runs when invoked directly.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { announce, messageOf, reportUsage, VERDICT } from "./lib/exit.mjs";
import { parseArgs, usage } from "./lib/cli.mjs";

/** This gate's name as it appears in the machine-readable verdict line. */
const GATE = "check-doc-counts";

/** The flags this gate accepts. Anything else is a usage error, not a silently dropped token. */
const FLAGS = Object.freeze({
  write: { type: "boolean", describe: "rewrite the derivable counts, then re-verify" },
  "with-ts": { type: "boolean", describe: "also verify the TypeScript test totals (~1 min)" },
});

const USAGE = usage([`usage: ${GATE} [--write] [--with-ts]`], FLAGS);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";

/**
 * Where forge lives, discovered exactly as `resolveForge()` in scripts/verify.mjs does:
 * `FORGE_BIN`, then the well-known `~/.foundry/bin/forge[.exe]`, then plain `forge` on PATH.
 *
 * Without the filesystem probe this gate exited 2 with `{"verdict":"tool-missing"}` on a
 * default Windows install even though forge was installed — foundryup puts its binaries in
 * `~/.foundry/bin` without putting that directory on PATH, so `FORGE_BIN` was the only way in
 * and nothing set it. That is the same class of defect as the drift this gate exists to catch:
 * two entry points disagreeing about the world. They must not drift apart again.
 *
 * `FORGE_BIN` stays authoritative when it is set but does not resolve: an explicit override
 * naming a binary that is not there is a hard error, not a reason to silently run some other
 * forge. The tool-missing verdict reports the candidate it tried, which is what that override
 * is for. So this returns the bare string `forge` rather than null as verify.mjs's copy does,
 * leaving the exec-time `tool-missing` + exit 2 in forgeCounts() unchanged.
 *
 * @returns {string} the forge executable to invoke.
 */
function resolveForge() {
  if (process.env.FORGE_BIN) return process.env.FORGE_BIN;
  const local = join(homedir(), ".foundry", "bin", IS_WIN ? "forge.exe" : "forge");
  return existsSync(local) ? local : "forge";
}

const FORGE = resolveForge();

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
/**
 * Every TypeScript workspace package name, derived from the filesystem rather than a
 * hardcoded list. `package.json` declares `workspaces: ["packages/*"]`, so this resolves
 * the glob and returns each package's directory name (core, indexer, mcp, demo-agent,
 * agent). Anything that needs to know "all the TS packages" must call this instead of
 * repeating a list that silently rots when a workspace is added.
 */
function tsWorkspaces() {
  const rootManifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages ?? [];
  const names = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) continue;
    const parent = join(ROOT, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!existsSync(join(parent, entry.name, "package.json"))) continue;
      names.push(entry.name);
    }
  }
  return names.sort();
}

function tsTestCounts() {
  // Every workspace, deliberately derived from the root manifest rather than hardcoded.
  // The list used to be `["core", "indexer", "mcp", "demo-agent"]`, which silently omitted
  // @sigilkit/agent after it was added — so the doc gate could not see that package's
  // counts at all, and the 951-vs-actual drift went unreported. `workspaces` in package.json
  // is the single source of truth; a new workspace is picked up here automatically.
  const packages = tsWorkspaces();
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
    // P0-ZERO: `actual === null` means the measurement was unavailable, not that it was zero.
    // Reporting "whitepaper says 4, actual is null" would be noise dressed as a finding, and the
    // comparison is meaningless either way — so it is named as unavailable and not compared.
    if (actual === null) {
      problems.push(`${label}: could not be measured (input unavailable), so the whitepaper's claim of ${m[group]} was NOT checked`);
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
    // P0-ZERO: same contract as `expect()` in checkWhitepaperCounts — a `null` actual is an
    // unavailable measurement, not a zero, and comparing against it would either manufacture
    // false drift or (if the doc happened to claim 0) silently pass. Named, never compared.
    if (actual === null) {
      problems.push(`${label}: could not be measured (input unavailable), so the README's claim of ${m[group]} was NOT checked`);
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
 * The guarded window: the newest dated entry under `## [Unreleased]` (DEBT-07).
 *
 * Entries are newest-first, so the guarded entry is the *first* dated `###` heading after
 * `[Unreleased]` — the release in flight. Everything below it is history: the 2026-09-11
 * entry's "38 Foundry tests", a MetaMask 12.5.0 pin, "4 invariant suites" and 91 tests
 * across 10 suites were each true when written, and re-litigating them on every commit
 * would make the changelog unusable as a historical record. Only the current entry can
 * have drifted away from today's toolchain.
 *
 * A `###` heading not led by an ISO date (`### Added — Contracts`) is a category, not a
 * release; the file uses them inside older entries, so "the newest dated entry" must never
 * resolve to one. Returns `null` when no dated entry exists under `[Unreleased]`, which
 * callers must treat as a problem rather than "nothing to check" — a changelog with no
 * current entry has stopped recording releases.
 */
export function latestChangelogSection(text) {
  const unreleased = /^##[^\S\n]*\[Unreleased\][^\S\n]*$/m.exec(text);
  if (!unreleased) return null;
  const rest = text.slice(unreleased.index + unreleased[0].length);
  // The next level-2 heading starts the previous released version, which ends the block.
  const nextRelease = /^##(?!#)[^\S\n]*\S/m.exec(rest);
  const block = nextRelease ? rest.slice(0, nextRelease.index) : rest;
  for (const heading of block.matchAll(/^(###[^\S\n]+[^\n]*)$/gm)) {
    if (!/^###[^\S\n]+\d{4}-\d{2}-\d{2}\b/.test(heading[1])) continue;
    // Cut at the next `###` so a later entry's counts cannot leak into this one.
    const after = block.slice(heading.index + heading[1].length);
    const next = after.match(/^###/m);
    return (heading[1] + after.slice(0, next ? next.index : after.length)).trim();
  }
  return null;
}

/**
 * Pure CHANGELOG comparison (DEBT-07). Guards the current entry only.
 *
 * Unlike the README, a changelog entry makes whichever claims it happens to make — a
 * docs-only release states no counts at all, and demanding a "Suites:" line from it
 * would block the release on an unrelated edit. So each claim type is verified when
 * present and ignored when absent; a *wrong* claim is never ignored.
 *
 * `actuals`: `{ counts, invariant, ts, metamask, coverage }` — `ts` is the per-package
 * map from `tsTestCounts` (null without `--with-ts`), `metamask` the version pinned in
 * ci.yml, `coverage` the v8 thresholds read from the per-package vitest configs.
 */
export function checkChangelogCounts(text, { counts, invariant, ts, metamask, coverage }) {
  const problems = [];
  const section = latestChangelogSection(text);
  if (section === null) {
    return ["CHANGELOG: no dated entry under `## [Unreleased]` (structure changed?)"];
  }
  // The claims wrap across lines in the source; match against a whitespace-normalised copy.
  const flat = section.replace(/\s+/g, " ");

  // --- per-package TypeScript counts ("Suites: core 255 (+1 skipped) · indexer 34 · …") ---
  // Pinned against a real run, because `core 180` and `indexer 12` were both written
  // for an earlier revision while the suites now hold 255 and 34. Optional like every
  // other claim: a release that reports no TS totals is not asserting wrong ones.
  if (ts) {
    const suites = /Suites: core (\d+)(?:\s*\(\+\d+ skipped\))?[^0-9]+indexer (\d+)[^0-9]+mcp (\d+)[^0-9]+demo-agent (\d+)/.exec(flat);
    if (suites) {
      const claimed = { core: Number(suites[1]), indexer: Number(suites[2]), mcp: Number(suites[3]), "demo-agent": Number(suites[4]) };
      // `tsTestCounts` returns `{ passed, skipped }` per package, so the claim must be compared
      // against `.passed`. Comparing the whole object to a number is never equal, which made
      // this branch report four `[object Object]` drifts for a fully correct changelog.
      for (const p of Object.keys(claimed)) {
        const actual = ts[p]?.passed;
        if (actual === undefined) continue;
        if (claimed[p] !== actual) {
          problems.push(`CHANGELOG: says ${p} has ${claimed[p]} tests, actual is ${actual}`);
        }
      }
    }
  }

  // --- Foundry totals ("115 Foundry unit/fuzz tests across 11 suites") ---
  // A quoted past figure is an anecdote, not a claim: the current entry documents the
  // guard by saying the numbers "had once" read "38 Foundry tests" against a real 86.
  // Verifying that quotation against today's 115 would flag the sentence that explains
  // why the guard exists, so quotations are stripped before any Foundry number is read.
  const live = flat.replace(/"[^"]*"/g, " ");
  const total = /(\d+) Foundry (?:unit\/fuzz )?tests across (\d+) suites/.exec(live);
  if (total) {
    if (Number(total[1]) !== counts.total) {
      problems.push(`CHANGELOG: says ${total[1]} Foundry tests, actual is ${counts.total}`);
    }
    if (Number(total[2]) !== counts.suites) {
      problems.push(`CHANGELOG: says ${total[2]} Foundry suites, actual is ${counts.suites}`);
    }
  }
  // The short form ("38 Foundry tests") restates the same total in a form the parenthesised
  // pattern misses, and it is what the 0.1.0 entry uses, so it is pinned too.
  for (const m of live.matchAll(/(\d+) Foundry tests\b/g)) {
    if (Number(m[1]) !== counts.total) {
      problems.push(`CHANGELOG: says ${m[1]} Foundry tests, actual is ${counts.total}`);
    }
  }

  // --- invariant phrasing ---
  // "4 invariant suites" is the recurring error: there is one invariant *file* holding
  // four invariants, so a per-invariant suite count is a category mistake, not a
  // stale number, and no run can reconcile it.
  const miscountedSuites = /(\d+) invariant suites?\b/.exec(live);
  // P0-ZERO: an unavailable invariant measurement is reported as unavailable and the two
  // arithmetic checks below are skipped — comparing against `null` would flag every shape as
  // drift, which is how a "could not measure" gets filed as a documentation defect.
  if (invariant.invariants === null || invariant.suites === null) {
    problems.push(
      "CHANGELOG: the invariant counts are UNAVAILABLE (contracts/test/ is missing) — this entry's claim was not checked",
    );
  } else if (miscountedSuites) {
    problems.push(
      `CHANGELOG: says "${miscountedSuites[0]}", but the contracts hold ${invariant.invariants} invariants in ${invariant.suites} suite — one suite, not one per invariant`,
    );
  } else {
    const shaped = /(\d+) invariants in (\d+) suites?\b/.exec(live);
    if (shaped) {
      if (Number(shaped[1]) !== invariant.invariants) {
        problems.push(`CHANGELOG: says ${shaped[1]} invariants, actual is ${invariant.invariants}`);
      }
      if (Number(shaped[2]) !== invariant.suites) {
        problems.push(`CHANGELOG: says ${shaped[2]} invariant suites, actual is ${invariant.suites}`);
      }
    }
  }

  // --- pinned MetaMask build ---
  // The entry documents a version that CI fetches by URL and verifies by SHA256; a
  // stale pin in the changelog tells a reader which build was validated when it is not.
  for (const m of live.matchAll(/MetaMask (\d+\.\d+\.\d+)/g)) {
    if (metamask && m[1] !== metamask) {
      problems.push(`CHANGELOG: says MetaMask ${m[1]}, ci.yml pins ${metamask}`);
    }
  }

  // --- coverage percentages ---
  // Measured coverage cannot be reproduced without a coverage run, but the entry claims
  // "all above their configured floors", and the floors are static config. A claimed
  // number below its floor falsifies that sentence; a number above it is unverifiable
  // here and is left alone rather than guessed at.
  const cov = /Coverage: core ([\d.]+)% stmts \/ ([\d.]+)% branches[^0-9]+indexer ([\d.]+)\/([\d.]+)[^0-9]+mcp ([\d.]+)\/([\d.]+)[^0-9]+demo-agent ([\d.]+)\/([\d.]+)/.exec(live);
  if (cov) {
    const pairs = [
      ["core", cov[1], cov[2]],
      ["indexer", cov[3], cov[4]],
      ["mcp", cov[5], cov[6]],
      ["demo-agent", cov[7], cov[8]],
    ];
    for (const [pkg, stmts, branches] of pairs) {
      const floor = coverage?.[pkg];
      if (!floor) {
        problems.push(`CHANGELOG: claims ${pkg} coverage but its vitest thresholds are missing`);
        continue;
      }
      // `stmts` in the changelog is the first of the v8 line/statement figures; the
      // packages that differ between the two floors must clear the stricter one.
      const stmtsFloor = Math.min(floor.lines ?? Infinity, floor.statements ?? Infinity);
      if (Number(stmts) < stmtsFloor) {
        problems.push(`CHANGELOG: claims ${pkg} ${stmts}% stmts, below its configured floor of ${stmtsFloor}%`);
      }
      if (Number(branches) < (floor.branches ?? 0)) {
        problems.push(`CHANGELOG: claims ${pkg} ${branches}% branches, below its configured floor of ${floor.branches}%`);
      }
    }
  }

  return problems;
}

/**
 * Pure `docs/STATUS.md` comparison. The file indexes the repo's documents, so its one
 * derivable number is the vault note count — it was 21 against a real 22, and the file
 * itself says the directory wins when the two disagree. Every occurrence is checked, so
 * a partial fix (one table updated, the other left stale) still fails.
 *
 * TWO shapes carry the count, and a guard that knows only one of them guards a subset
 * while looking complete:
 *
 *   1. "22 notes"                     — `(vault/) (22 notes)` in the L4 table
 *   2. "22 `vault/` notes"            — "Audit of the 22 `vault/` notes" in the VAULT-AUDIT
 *                                       row, where the digits are separated from "notes" by
 *                                       an inline-code path and a space
 *
 * Shape 2 is the one that rotted. `(\d+) notes\b` cannot see it (the text is
 * "22 `vault/` notes", not "22 notes"), so when the count changed, the check stayed green
 * and --write reported "changed" while leaving the wrong number in place. Both shapes are
 * now matched, and the pairs below are shared with `rewriteStatus` — a check and a repair
 * that use different patterns is a check whose repair silently does nothing.
 *
 * WHEN CHANGING EITHER REGEX, CONFIRM THE NEW SHAPE MATCHES AT LEAST ONE REAL SITE.
 * The obvious guard against a wrong pattern is "run it and look", but the better one is
 * earlier: this function is fail-closed, so a pattern that matches nothing is not a silent
 * no-op — `claims.length === 0` returns "could not find the vault note count". A contributor
 * who adds a shape that does not match gets a RED build, not a quietly unfixed document.
 * That property is worth protecting: verify match count >= 1 against the real file, and
 * never weaken the claim extraction to make a new shape "work" without that check.
 *
 * BUT MATCH COUNT >= 1 IS NECESSARY, NOT SUFFICIENT — there are three gates, not one.
 * They cover three different failures, and none of them subsumes another:
 *
 *   1 EXISTENCE. fail-closed: a shape matching nothing yields claims.length === 0 and a
 *     reported problem, so a wrong pattern is a red build rather than a quiet no-op.
 *   2 UNIQUENESS. A shape loose enough to also swallow prose still matches >= 1 site and
 *     still goes green. Measured on the real STATUS.md: `(\d+)[^|]*notes\b` and `\d+.*notes\b`
 *     match 5 sites instead of 3, running past the table pipe into the next column.
 *   3 NON-COLLATERAL REWRITE. The quietest failure, and the reason gate 2 is not enough. Under
 *     rewriteStatus a loose shape changes digits that were never a declared count. Measured on
 *     the real rule line (686 chars):
 *       - `(\d+)[^|]*notes\b` / `\d+.*notes\b` -> 347 chars: the rule line is truncated, so the
 *         damage is loud.
 *       - a bare `(\d+)/g` (every digit run)     -> 686 chars, `occurrences` intact, but
 *         `L4` -> `L23` and `2026-09-26` -> `23-23-23`. The rule still reads intact while
 *         pointing at a layer and a document that do not exist, and the guard stays green.
 *     Truncation announces itself; corrosion does not. Gate 3 is "the declared count is the only
 *     thing that may change", asserted structurally (L-labels, ISO dates and document names are
 *     captured before and after) rather than by asserting one failure mechanism — a mechanism-shaped
 *     assertion would go stale the moment the harm changed shape, which is exactly what happened
 *     here during F-15.
 *
 * Gates 2 and 3 live in check-doc-counts.test.mjs ("loosening a shape is caught even when it
 * still matches >= 1 site"). A change to either regex needs all three.
 */
export function checkStatusCounts(text, { vault }) {
  const problems = [];
  const claims = [
    ...[...text.matchAll(/(\d+) notes\b/g)].map((m) => ({ source: `\`vault/\` (${m[0]})`, n: Number(m[1]) })),
    ...[...text.matchAll(/(\d+) `vault\/` notes\b/g)].map((m) => ({ source: `the VAULT-AUDIT row (${m[0]})`, n: Number(m[1]) })),
    ...[...text.matchAll(/`(\d+)` occurrences/g)].map((m) => ({ source: "the 'update all occurrences' rule", n: Number(m[1]) })),
  ];
  if (claims.length === 0) {
    return ["STATUS: could not find the vault note count (structure changed?)"];
  }
  for (const { source, n } of claims) {
    if (n !== vault) {
      problems.push(`STATUS: ${source} says ${n} vault notes, actual is ${vault}`);
    }
  }
  return problems;
}

/**
 * Pure `SECURITY.md` comparison.
 *
 * The disclosure policy tells a reporter how to reproduce symbolic verification:
 * "`halmos --match-contract Halmos` (11 specs: 6 spend-cap/Merkle core + 5 auth-path
 * over a …)". Both the total and the per-file split are derivable from the Halmos
 * contracts, and a security document that under- or over-states the verification
 * surface is exactly the claim a reader cannot check for themselves.
 *
 * This claim was unguarded until an injection run rewrote it to "99 specs" and all five
 * gates exited 0. It is checked here rather than in a new script because the count is
 * already computed — `halmosSpecCount()` returns `{ total, perFile }` — and because a
 * sixth gate reading one more document is a worse trade than one more claim in the gate
 * that already owns the number.
 *
 * Every occurrence is checked, so a partial fix still fails. The per-file split is
 * verified as a *sum*, not against fixed per-file numbers: a new `Halmos*.t.sol` must be
 * addable without editing this function, which is the same rule the vault and annotation
 * guards follow.
 */
export function checkSecurityDocCounts(text, { halmos }) {
  const problems = [];
  // P0-ZERO: an unavailable measurement must never be compared. `halmos.total` is `null` when
  // `contracts/test/` could not be read, and `n !== null` is true for every n — so without this
  // guard a missing directory would report every spec claim as drift AND, worse, would still
  // have passed had the doc said 0. "Could not measure" is reported as itself, once, and the
  // arithmetic below is skipped because there is nothing to check it against.
  if (halmos.total === null) {
    return ["SECURITY: the Halmos spec count is UNAVAILABLE (contracts/test/ is missing) — the document's claim was not checked, and an unmeasured count is not a passing one"];
  }
  const totals = [...text.matchAll(/\((\d+)\s+specs?\b/g)].map((m) => Number(m[1]));
  if (totals.length === 0) {
    return ["SECURITY: could not find the Halmos spec count (structure changed?)"];
  }
  for (const n of totals) {
    if (n !== halmos.total) {
      problems.push(`SECURITY: says ${n} Halmos specs, actual is ${halmos.total}`);
    }
  }

  // The parenthetical breakdown ("6 spend-cap/Merkle core + 5 auth-path") must account
  // for every spec. Only the *total* is derivable, so the individual parts are checked
  // for arithmetic completeness rather than against a per-file table: a breakdown that
  // does not sum to the headline is a claim no run can reconcile.
  const breakdown = /\(\s*\d+\s+specs?:\s*([^)]*)\)/.exec(text);
  if (breakdown) {
    const parts = [...breakdown[1].matchAll(/(\d+)\s+[a-zA-Z]/g)].map((m) => Number(m[1]));
    if (parts.length === 0) {
      problems.push(`SECURITY: could not parse the per-area spec split from ${JSON.stringify(breakdown[1].trim())}`);
    } else {
      const sum = parts.reduce((a, b) => a + b, 0);
      if (sum !== halmos.total) {
        problems.push(`SECURITY: the per-area spec split sums to ${sum}, the real total is ${halmos.total}`);
      }
    }
  }
  return problems;
}

/**
 * Pure `docs/TROUBLESHOOTING.md` comparison. The file tells a reader how many
 * forge-lint annotations exist to copy from ("There are 31 such annotations"); the
 * real count is greppable from the Solidity sources, and was 31 against a real 28
 * when this guard was written. The count moves as the contracts change, which is the
 * point — a reader copying an annotation needs that many to exist.
 */
export function checkTroubleshootingCounts(text, { annotations }) {
  const problems = [];
  const claims = [...text.matchAll(/(\d+) such annotations?\b/g)];
  if (claims.length === 0) {
    return ["TROUBLESHOOTING: could not find the forge-lint annotation count (structure changed?)"];
  }
  for (const m of claims) {
    if (Number(m[1]) !== annotations) {
      problems.push(`TROUBLESHOOTING: says ${m[1]} forge-lint annotations, actual is ${annotations}`);
    }
  }
  return problems;
}

/**
 * Rewrites the derivable STATUS/TROUBLESHOOTING numbers (pure). The CHANGELOG is
 * deliberately absent: its numbers belong to a past entry, and an automatic rewrite
 * would silently falsify the release record.
 */
export function rewriteStatus(status, { vault }) {
  return (
    status
      // Order matters: the backticked shape first, so "22 `vault/` notes" is not first
      // mangled by a looser pattern. Mirrors the claim extraction in checkStatusCounts —
      // see the note there on why the two must stay in step.
      .replace(/(\d+) `vault\/` notes\b/g, `${vault} \`vault/\` notes`)
      .replace(/(\d+) notes\b/g, `${vault} notes`)
      .replace(/`(\d+)` occurrences/g, `\`${vault}\` occurrences`)
  );
}

export function rewriteTroubleshooting(troubleshooting, { annotations }) {
  return troubleshooting.replace(/(\d+) such annotations?\b/g, `${annotations} such annotations`);
}

/**
 * Extracts the MetaMask build CI actually fetches (pure). Anchored on the release
 * asset filename because ci.yml also names a superseded 12.5.0 in a cache-key comment.
 */
export function metamaskPinFromCi(ciText) {
  const m = /metamask-chrome-(\d+\.\d+\.\d+)\.zip/.exec(ciText);
  return m ? m[1] : null;
}

/** Reads the v8 coverage thresholds out of one `vitest.config.ts` (pure). */
export function parseCoverageFloors(configText) {
  const block = /thresholds:\s*\{([^}]*)\}/.exec(configText);
  if (!block) return null;
  const floors = {};
  for (const m of block[1].matchAll(/(\w+):\s*(\d+)/g)) floors[m[1]] = Number(m[2]);
  return floors;
}

/** Reads the per-package vitest coverage floors; statically derivable, so it needs no run. */
function coverageFloors() {
  const floors = {};
  for (const p of tsWorkspaces()) {
    const file = join(ROOT, "packages", p, "vitest.config.ts");
    if (!existsSync(file)) continue;
    floors[p] = parseCoverageFloors(readFileSync(file, "utf8"));
  }
  return floors;
}

/** Counts the markdown notes in the research vault. */
function vaultNoteCount() {
  const dir = join(ROOT, "vault");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith(".md")).length;
}

/** Recursively lists the Solidity sources under a directory. */
function soliditySources(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".sol")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Counts `forge-lint: disable-next-line` annotations, matching `grep -r … | wc -l`
 * (lines, not occurrences) so the documented figure and the shell one agree.
 */
function forgeLintAnnotationCount() {
  return soliditySources(join(ROOT, "contracts")).reduce(
    (n, f) => n + (readFileSync(f, "utf8").match(/^.*forge-lint: disable-next-line.*$/gm) ?? []).length,
    0,
  );
}

/** Reads the MetaMask build pinned by the CI workflow. */
function ciMetamaskPin() {
  const file = join(ROOT, ".github", "workflows", "ci.yml");
  if (!existsSync(file)) return null;
  return metamaskPinFromCi(readFileSync(file, "utf8"));
}

/**
 * Shared I/O wrapper for the three derived-document guards: read, delegate, report.
 * `checker` returns a list of problems (empty = OK); `log` names the OK line.
 */
function checkDocument(relativePath, checker, log) {
  const path = join(ROOT, ...relativePath.split("/"));
  if (!existsSync(path)) return [`${relativePath}: is missing`];
  const problems = checker(readFileSync(path, "utf8"));
  if (problems.length === 0) {
    console.log(log);
  } else {
    for (const p of problems) console.error(`  ${p}`);
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
    process.exit(announce(GATE, VERDICT.TOOL_MISSING, { tool: FORGE }));
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
  // P0-ZERO: an absent `contracts/test/` used to return `{ total: 0 }`, and `checkSecurityDocCounts`
  // compares the document's `(N specs)` claim against that 0. So deleting the whole directory made
  // the document's claim vacuously true — a doc saying "(0 specs)" would have passed, and the
  // per-area breakdown check is skipped entirely when no breakdown text is present. This function
  // exists to catch "an injection run rewrote the claim to 99 specs and all five gates exited 0";
  // a zero that means "could not look" must not be able to satisfy it. `null` is not a count.
  if (!existsSync(dir)) return { total: null, perFile: {}, unavailable: true };
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
  // P0-ZERO: same shape as `halmosSpecCount` and `invariantStats`, and for the same reason.
  // A missing file used to return 0, which made "the properties are gone" and "the file
  // declares zero properties" the same observation — so `checkReadmeCounts`'s
  // `actual === null` guard never fired for Echidna and the README's claim went unchecked.
  // `null` is not a count.
  if (!existsSync(file)) return null;
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
  // P0-ZERO: same shape as `halmosSpecCount` and for the same reason. `{ invariants: 0, suites: 0 }`
  // is a *legitimate* reading of a directory that exists and contains no invariant file — so
  // returning it for a directory that does not exist made "the invariant suite is gone" and
  // "the invariant suite is empty" the same observation, and a whitepaper claiming "0 invariants"
  // satisfied the guard. `unavailable` is what a caller must check, not the zero.
  if (!existsSync(dir)) return { invariants: null, suites: null, unavailable: true };
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

function main(argv = process.argv.slice(2)) {
  // A misspelled flag used to be dropped silently: `--writ` and `--with-tss` both ran the
  // plain verification and exited 0, so a caller who believed `--write` was on got a gate
  // that checked less than they thought. An unrecognised argument is exit 2 — the check
  // could not run as asked, which is never a pass.
  let flags;
  try {
    flags = parseArgs(argv, FLAGS);
  } catch (err) {
    process.exit(reportUsage(GATE, messageOf(err), USAGE));
  }
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(announce(GATE, VERDICT.PASS));
  }

  const WRITE = flags.write;
  /**
   * Also verify the TypeScript test counts in the whitepaper. Off by default because it means
   * running every suite (~1 min); worth turning on before a release, since these are the
   * numbers an auditor or grant reviewer is most likely to check.
   */
  const WITH_TS = flags["with-ts"];

  // The README is the one document the gate cannot report without, so its presence is
  // settled before any measurement runs. Same shape as checkDocument() (:688) and
  // checkWhitepaper() (:704); without it a checkout with no README died with an ENOENT stack
  // trace, and a crash is not a verdict — the caller cannot tell "this repository is broken"
  // from "this gate is broken". Deliberately not a try/catch: that would collapse "absent"
  // and "unreadable" into one indistinguishable error code. It also goes first so a missing
  // file is reported in milliseconds rather than after `forge test --list` has run, which
  // matters because that call exits 2 first and would otherwise mask the real finding.
  const readmePath = join(ROOT, "README.md");
  if (!existsSync(readmePath)) {
    console.error("README: is missing (the document every other count is restated in)");
    process.exit(announce(GATE, VERDICT.UNREADABLE_INPUT, { missing: "README.md" }));
  }
  let readme = readFileSync(readmePath, "utf8");

  const counts = forgeCounts();
  const ci = ciJobCount();
  const halmos = halmosSpecCount();
  const echidna = echidnaPropertyCount();
  const invariant = invariantStats();
  const vault = vaultNoteCount();
  const annotations = forgeLintAnnotationCount();
  const metamask = ciMetamaskPin();
  const coverage = coverageFloors();

  console.log(`forge (PR scope): ${counts.total} tests across ${counts.suites} suites`);
  console.log(`forge (excluded: invariant + fork): ${counts.excludedTotal} tests across ${counts.excludedSuites} suites`);
  console.log(`CI jobs: ${ci.jobs} (${ci.names.join(", ")})`);
  console.log(`Halmos specs: ${halmos.total} (${Object.entries(halmos.perFile).map(([f, n]) => `${f} ${n}`).join(", ")})`);
  console.log(`Echidna properties: ${echidna}`);
  console.log(`Invariant suite: ${invariant.invariants} invariants across ${invariant.suites} suite(s)`);
  console.log(`Vault notes: ${vault}`);
  console.log(`forge-lint annotations: ${annotations}`);
  console.log(`MetaMask pin (ci.yml): ${metamask ?? "not found"}`);

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

  // DEBT-07: the CHANGELOG's current entry, plus the two other documents that restate a
  // derivable number. The changelog's own entry is history and is never auto-rewritten.
  problems.push(...checkDocument(
    "CHANGELOG.md",
    (text) => checkChangelogCounts(text, { counts, invariant, ts: ts?.counts ?? null, metamask, coverage }),
    `CHANGELOG counts OK (current entry${ts ? ", including TypeScript totals" : "; use --with-ts for the TS totals"}).`,
  ));
  problems.push(...checkDocument(
    "docs/STATUS.md",
    (text) => checkStatusCounts(text, { vault }),
    `STATUS counts OK (${vault} vault notes).`,
  ));
  problems.push(...checkDocument(
    "docs/TROUBLESHOOTING.md",
    (text) => checkTroubleshootingCounts(text, { annotations }),
    `TROUBLESHOOTING counts OK (${annotations} forge-lint annotations).`,
  ));
  problems.push(...checkDocument(
    "SECURITY.md",
    (text) => checkSecurityDocCounts(text, { halmos }),
    `SECURITY counts OK (${halmos.total} Halmos specs).`,
  ));

  if (problems.length === 0) {
    console.log("\ndoc counts OK — README, whitepaper, CHANGELOG, STATUS, TROUBLESHOOTING and SECURITY match the toolchain.");
    process.exit(announce(GATE, VERDICT.PASS));
  }

  if (WRITE) {
    readme = rewriteReadme(readme, { counts, ci, invariant });
    writeFileSync(readmePath, readme);
    // Only the numbers the toolchain derives are rewritten. The CHANGELOG is excluded by
    // design: an older entry's counts are a true record of that release, and a `--write`
    // that "corrected" them would falsify it.
    const derived = [
      ["docs/STATUS.md", rewriteStatus],
      ["docs/TROUBLESHOOTING.md", rewriteTroubleshooting],
    ];
    for (const [rel, rewrite] of derived) {
      const path = join(ROOT, ...rel.split("/"));
      if (!existsSync(path)) continue;
      const before = readFileSync(path, "utf8");
      const after = rel === "docs/STATUS.md" ? rewrite(before, { vault }) : rewrite(before, { annotations });
      if (after !== before) {
        writeFileSync(path, after);
        console.log(`rewrote the derivable counts in ${rel}`);
      }
    }
    console.log("\ndoc counts rewritten in README.md — re-verifying without --write...");

    // Fail closed: a rewrite is only a success if the re-verification passes. The whitepaper,
    // the README suite breakdown and the CHANGELOG are not auto-rewritten, so any drift they
    // still carry must propagate as a non-zero exit rather than being reported as a clean rewrite.
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
      console.error("Documents were rewritten but drift remains — fix the remaining claims by hand.");
    }
    // The child already announced its own verdict on stdout; this line reports the
    // `--write` run's outcome so a caller sees a verdict for THIS invocation too.
    process.exit(announce(GATE, status === 0 ? VERDICT.PASS : VERDICT.DRIFT, { wrote: true, reverifyExit: status }));
  }

  console.error(`\ndoc count drift (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nRun with --write to update README.md, docs/STATUS.md and docs/TROUBLESHOOTING.md, then update the suite breakdown by hand.");
  console.error("Whitepaper and CHANGELOG counts are prose/history — fix them manually (--with-ts also checks the TS totals).");
  process.exit(announce(GATE, VERDICT.DRIFT, { problems: problems.length }));
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
