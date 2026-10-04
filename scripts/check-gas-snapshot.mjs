#!/usr/bin/env node
/**
 * `.gas-snapshot` COMPLETENESS gate.
 *
 * WHY THIS EXISTS. The snapshot is deliberately NOT diff-gated: gas varies by solc patch and
 * machine, so `forge snapshot && git diff --exit-code` would redden unrelated PRs over a few
 * hundred gas. That is why it is report-only in CI. But report-only has a failure mode the
 * review found: the file had drifted to 162 entries against 228 current tests — 65 tests
 * unsnapshotted, plus entries naming tests that no longer exist. Nothing failed, because
 * "report-only" cannot distinguish "gas moved" from "this test is not being tracked at all".
 *
 * So this checks the part that IS deterministic — the SET of test names — and leaves the
 * numbers alone. It fails when:
 *   - a current unit/fuzz test has no snapshot entry (its gas is untracked), or
 *   - an entry names a test that no longer exists (stale, and reads as evidence).
 *
 * Invariant and fork suites are excluded on both sides, matching the snapshot command:
 * invariant lines carry a seed-dependent `reverts:` count and are not deterministic.
 *
 *   node scripts/check-gas-snapshot.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT = join(ROOT, ".gas-snapshot");
const EXCLUDE = ".*Invariant|.*Fork";

function forge(...args) {
  return execFileSync("forge", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Current unit/fuzz test names, as `Contract:test_Name()` — the same shape the snapshot
 * file uses, so the two are comparable directly.
 *
 * The `--list --json` shape is `{ "<file.sol>": { "<ContractName>": ["test_a", ...] } }`,
 * so the CONTRACT name is the inner key. Reading the outer key (the file) would produce
 * names the snapshot can never match.
 */
function currentTests() {
  const out = forge("test", `--no-match-contract=${EXCLUDE}`, "--list", "--json");
  const parsed = JSON.parse(out);
  const names = new Set();
  for (const suites of Object.values(parsed)) {
    for (const [contract, tests] of Object.entries(suites)) {
      for (const t of tests) names.add(`${contract}:${t}()`);
    }
  }
  return names;
}

/** Test names recorded in the snapshot file, normalized to `Contract:test_Name()`. */
function snapshotTests() {
  const names = new Set();
  for (const line of readFileSync(SNAPSHOT, "utf8").split(/\r?\n/)) {
    const m = /^(\S+):(\S+?)\(/.exec(line.trim());
    if (m) names.add(`${m[1]}:${m[2]}()`);
  }
  return names;
}

if (!existsSync(SNAPSHOT)) {
  console.error("fail  .gas-snapshot is missing. Run: forge snapshot --no-match-contract '.*Invariant|.*Fork'");
  process.exit(1);
}

const current = currentTests();
const snapshotted = snapshotTests();

const missing = [...current].filter((t) => !snapshotted.has(t)).sort();
const stale = [...snapshotted].filter((t) => !current.has(t)).sort();

if (missing.length === 0 && stale.length === 0) {
  console.log(`gas snapshot OK — ${current.size} test(s) tracked, no stale entries.`);
  process.exit(0);
}

if (missing.length > 0) {
  console.error(`fail  ${missing.length} test(s) have no .gas-snapshot entry, so their gas is untracked:`);
  for (const t of missing) console.error(`        ${t}`);
  console.error("      Regenerate with: forge snapshot --no-match-contract '.*Invariant|.*Fork'");
}
if (stale.length > 0) {
  console.error(`fail  ${stale.length} snapshot entr(ies) name tests that no longer exist:`);
  for (const t of stale) console.error(`        ${t}`);
  console.error("      Regenerate with: forge snapshot --no-match-contract '.*Invariant|.*Fork'");
}
process.exit(1);