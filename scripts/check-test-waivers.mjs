#!/usr/bin/env node
/**
 * Intentionally-failing-test waiver guard.
 *
 * `docs/CI-WAIVERS.md` carries two registers. The first is machine-checked by
 * `check-waivers.mjs`: every job-level `continue-on-error: true` needs a dated row. The
 * second — the "Item (not a CI job)" table — is the one this script owns, and until now
 * nothing read it. `check-waivers.mjs` deliberately skips it: a failing Solidity test is
 * not a `continue-on-error` job, so a row for it in the machine-checked table would be
 * reported as a stale row and turn the `workflow-lint` job red for no reason. That
 * exclusion is correct (see CI-WAIVERS.md, "Why this row is not in the machine-checked
 * table"), but it left the second table a human convention with no teeth.
 *
 * The failure this prevents: a row is a recorded promise that "this test is red on
 * purpose". Once the test goes green that promise is void — but nothing recomputes it, so
 * the row survives, the expiry passes, and a reader concludes the defect is still live.
 * Measured instance: SEC-10's row (CI-WAIVERS.md:63) outlived its own removal criterion —
 * the test was rewritten under Option B and went green, while the row kept claiming an
 * "intentionally failing assertion".
 *
 * A row is therefore only valid while its test is still RED. This script re-runs each
 * registered test and fails when a row's test has gone green. It does not decide whether
 * the underlying defect is fixed — that is the row's stated criterion, and a human removes
 * the row in the same change that satisfies it.
 *
 * SCOPE — it covers only rows it can parse a Foundry test name from, and only tests that
 * exist on disk. A row naming a file that is gone, or a test that no longer exists, is
 * reported as unverifiable rather than silently passed: an unresolvable row is not the
 * same as a satisfied one. Tests run from the working tree, so a dirty tree is what gets
 * measured — stated in the output, because a green row in a dirty tree is exactly the
 * ambiguity worth naming.
 *
 *   node scripts/check-test-waivers.mjs
 *
 * Exit 0 = every registered intentional failure is still failing. Exit 1 = at least one
 * row's test has gone green, or a row cannot be resolved. Exit 2 = forge unavailable, so
 * nothing could be verified at all (never a silent pass).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = join(ROOT, "docs", "CI-WAIVERS.md");

// FORGE_BIN wins over PATH, for the same reason check-doc-counts.mjs prefers it: on
// Windows a Foundry install is routinely absent from PATH, and a silent fallback would let
// this gate test nothing while reporting success.
const FORGE = process.env.FORGE_BIN || "forge";

/**
 * Parses the "Item (not a CI job)" table. A row must supply a backticked `test_Name` and a
 * parenthesised source file, both of which the register's own convention uses. Anything
 * else on a `|` line — the job table above, the prose sections — yields no test name and is
 * skipped, which is what keeps this reader independent of `check-waivers.mjs`'s table
 * identification.
 *
 * The file cell is matched as a backticked path *inside* the parens, because that is the
 * shape the register actually uses: "`test_Foo` (`contracts/test/Foo.t.sol`)". A plain
 * `\(([^)]+)\)` captures the backticks too and the resulting path never exists on disk, so
 * the row is reported as unverifiable instead of being checked. The fallback keeps the
 * un-backticked form working rather than assuming this register never changes shape.
 */
export function parseRows(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const item = cells[1] ?? "";
    const test = /`(test_[A-Za-z0-9_]+)`/.exec(item)?.[1];
    const file =
      /\(`([^`]+\.sol)`\)/.exec(item)?.[1] ??
      /\(([^)]+\.sol)\)/.exec(item)?.[1];
    if (!test || !file) continue;
    const tail = cells.slice(2).join("|");
    const expiry = /\b(\d{4}-\d{2}-\d{2})\b/.exec(tail)?.[1] ?? null;
    rows.push({ test, file, expiry, line: i + 1 });
  }
  return rows;
}

/**
 * The pure half of the gate: turns one row plus its verdict into a finding or a note.
 *
 * Split out of the top-level loop so the decision table can be tested without forge, without
 * the register, and without a working tree. It is deliberately total: every state
 * `isStillRed` can return maps to exactly one outcome, and the only non-failing state is
 * `red`. Everything else — green, unverifiable, or a file that is not there — is a finding,
 * because a row is a promise that a specific test is red on purpose, and an unverifiable
 * promise is not a kept one.
 *
 * @param {{test: string, file: string, line: number}} row
 * @param {{state: string, detail: string}} verdict
 * @param {boolean} fileExists
 * @returns {{ok: true, note: string} | {ok: false, finding: string}}
 */
export function evaluateRow(row, verdict, fileExists) {
  const where = `docs/CI-WAIVERS.md:${row.line}  ${row.test}`;
  if (!fileExists) {
    return {
      ok: false,
      finding:
        `${where}: the registered file ${row.file} does not exist — ` +
        "the row cannot be verified, and an unresolvable row is not a satisfied one",
    };
  }
  if (verdict.state === "green") {
    return {
      ok: false,
      finding:
        `${where} (${row.file}): is GREEN (${verdict.detail}) but is still ` +
        "registered as an intentionally failing test — remove the row in the same change that satisfies its " +
        "criterion, or the register will keep claiming a defect that no longer exists",
    };
  }
  if (verdict.state === "unverifiable") {
    return { ok: false, finding: `${where} (${row.file}): could not be verified — ${verdict.detail}` };
  }
  return { ok: true, note: `  ${row.test} (${row.file}) — still red (${verdict.detail})` };
}

/**
 * Runs the whole gate and returns a verdict instead of exiting, so a test can drive every
 * branch with a stubbed forge. `spawn` and `exists` are injected rather than mocked at module
 * scope, which is what lets the negative controls run on a machine with no foundry at all.
 *
 * Each row is run in isolation with `--match-test <name>`, Foundry's own filter, so a waiver for
 * `test_Foo` is decided by `test_Foo` alone and cannot be flipped by an unrelated failure
 * elsewhere. The verdict is read from Foundry's own summary rather than from the exit code,
 * because the exit code is also 0 for "no tests matched" — which would make a deleted test look
 * satisfied. Foundry prints "Suite result: ok. 1 passed; 0 failed" per suite and then a
 * "Ran N test suite(s)" total whose wording differs by version ("1 test suite" vs
 * "2 test suites"), so the per-suite line is the anchor: if it is absent, forge matched nothing
 * and the row cannot be judged.
 */
export function runGate({
  register = REGISTER,
  root = ROOT,
  forge = FORGE,
  spawn = spawnSync,
  exists = existsSync,
  read = readFileSync,
} = {}) {
  if (!exists(register)) {
    return { code: 1, failures: ["docs/CI-WAIVERS.md is missing — the waiver register is gone."], stillRed: [] };
  }
  const text = read(register, "utf8");
  const rows = parseRows(text);
  if (rows.length === 0) {
    // The register's own documentation declares an EMPTY table the healthy terminal state
    // ("there are no deliberate standing test failures … An empty table is the healthy
    // state") — every intentional red has been closed. That state must PASS, but only when
    // the table itself is recognisably present. A register whose table was renamed, mangled
    // or deleted still fails closed here: with no recognisable table the script cannot tell
    // "nothing registered" from "could not read the register", and reporting that as "all
    // good" is the exact failure mode this branch exists to prevent. The header cell is the
    // register's own convention, reading only the "Item (not a CI job)" table and never the
    // job table above it.
    const tablePresent = /^\s*\|[^|]*Item \(not a CI job\)/m.test(text);
    if (tablePresent) {
      return { code: 0, failures: [], stillRed: [] };
    }
    // Fail closed. An unreadable register must never read as "no waivers, all good".
    return {
      code: 1,
      failures: [
        "no intentional-test-failure rows found in docs/CI-WAIVERS.md. If that table was removed, " +
        "this script is guarding nothing — restore it or delete this script.",
      ],
      stillRed: [],
    };
  }
  const probe = spawn(forge, ["--version"], { cwd: root, encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return {
      code: 2,
      failures: [`could not run \`${forge} --version\`. Set FORGE_BIN to the forge executable path.`],
      stillRed: [],
    };
  }

  const failures = [];
  const stillRed = [];
  for (const row of rows) {
    const fileExists = exists(resolve(root, row.file));
    const result = spawn(
      forge,
      ["test", "--match-path", row.file, "--match-test", row.test, "--no-match-contract", ".*Invariant|.*Fork"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    let verdict;
    if (result.error) {
      verdict = { state: "unverifiable", detail: result.error.message };
    } else {
      const summary = /Suite result: (\w+)\.\s+(\d+) passed;\s+(\d+) failed/.exec(out);
      if (!summary) {
        const ranNothing = /No tests found|No test matches|Ran 0 test/.test(out);
        verdict = {
          state: "unverifiable",
          detail: ranNothing ? "forge matched no test for this name" : "forge produced no suite summary",
        };
      } else {
        const passed = Number(summary[2]);
        const failed = Number(summary[3]);
        verdict = passed === 0 && failed === 0
          ? { state: "unverifiable", detail: `no test matched ${row.test}` }
          : { state: failed > 0 ? "red" : "green", detail: `${passed} passed, ${failed} failed` };
      }
    }
    const outcome = evaluateRow(row, verdict, fileExists);
    if (outcome.ok) stillRed.push(outcome.note);
    else failures.push(outcome.finding);
  }
  return { code: failures.length > 0 ? 1 : 0, failures, stillRed };
}

function main() {
  const result = runGate();
  const failures = result.failures;
  const stillRed = result.stillRed;

  if (result.code === 0) {
    console.log(`check-test-waivers OK — ${stillRed.length} registered intentional failure(s)${stillRed.length > 0 ? ", all still red:" : " (register present, table empty — every deliberate red is closed)."}`);
    for (const note of stillRed) console.log(note);
    console.log("  scope: rows naming a Foundry test in docs/CI-WAIVERS.md; tests run from the working tree");
    return 0;
  }
  if (result.code === 2) {
    console.error(`check-test-waivers: ${failures[0]}`);
    return 2;
  }
  console.error(`check-test-waivers: ${failures.length} problem(s) in the intentional-failure register:\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\n  A row is a promise that a specific test is red on purpose. Once the test is green that promise\n" +
      "  is void, and the row must go in the same change that satisfies its criterion.",
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
