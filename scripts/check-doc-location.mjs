#!/usr/bin/env node
/**
 * Document-location guard (dc-law, 2026-09-26).
 *
 * STATUS.md's five layer tables index `docs/`. A finished audit that is written
 * somewhere else is invisible twice over: it is in no layer table, and — if it
 * landed in a workspace package — in no npm tarball either, since every
 * workspace `files[]` is `["dist", "README.md"]`. That is a real failure mode,
 * not a hypothetical one: three such deliverables existed on 2026-09-26
 * (`packages/core/ARCH-2026-09-26.md`, `packages/core/DOC-AUDIT-2026-09-26.md`,
 * `scripts/ARCH-2026-09-26.md`).
 *
 * This check answers one question: is every markdown file OUTSIDE `docs/` in a
 * location that is allowed to hold one? It does not check the converse — that
 * every audit document has a row in STATUS.md — because that requires reading
 * each document to know whether it is an audit or a package README.
 *
 * ALLOWED outside docs/:
 *   - the repo-root meta files (README, CHANGELOG, SECURITY, CONTRIBUTING, CoC,
 *     PROJECT-MAP, FILE-MANIFEST) — each is a legal, expected root document and
 *     several already have rows or are named by the layer tables;
 *   - a package README (packages/<pkg>/README.md) — the published face of a
 *     package, shipped via its files[] allowlist;
 *   - a test-suite README (contracts/test/README.md) — test guidance;
 *   - anything under vault/ — private research, indexed as one L4 row for the
 *     whole directory;
 *   - anything under .github/ — PR and issue templates;
 *   - anything under .workbuddy-ai/ or agents/ — assistant scratch, gitignored,
 *     not deliverables.
 *
 * Note that packages/ and contracts/ are allowed by NAME, not wholesale: a
 * package directory may hold its README and nothing else. That distinction is
 * the whole point — a whole-directory allowlist silently permits the exact
 * failure this script exists to catch, which is what a negative test caught
 * during development (2026-09-26).
 *
 * SCOPE — this sees git-TRACKED files only, and that boundary is INTENTIONAL, not
 * an oversight. Its denominator is "deliverables this repository ships": a markdown
 * file that is gitignored (an agent sandbox such as `.sc-gate-sandbox/`, a scratch
 * directory) is by definition not a deliverable, so counting it would make the metric
 * meaningless. The consequence must still be stated plainly, because a gate that does
 * not declare its boundary reads as if it covers more than it does: a clean run means
 * "no committed .md is misplaced and every docs/ file is indexed", NOT "there are no
 * strays" and NOT "every markdown file in the working tree is covered". A working-tree
 * stray, or a document hidden in an ignored directory, is invisible here by design.
 * Measured example (2026-09-26): the sandbox copy of docs/WHITEPAPER-v2.1.md still read
 * "Foundry total above (158)" while the tracked original read 220 — real drift, in a
 * file this gate cannot see, which is why it is a sandbox and not a deliverable.
 *
 * Do not use it as the gate; the gate is "does every audit/research document have a
 * row in one of the five tables in docs/STATUS.md", and that is the second direction
 * below.
 *
 *   node scripts/check-doc-location.mjs
 *
 * Exit 0 = clean. Exit 1 = at least one tracked .md is in a location that is not
 * allowed to hold one; each is printed.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROOT_FILE_PATTERNS =
  /^(README|CHANGELOG|SECURITY|CONTRIBUTING|CODE_OF_CONDUCT|PROJECT-MAP|FILE-MANIFEST)\.md$/;
/** Directories where any markdown is acceptable (research notes, templates, scratch). */
const DIR_ALLOWLIST = /^(\.workbuddy-ai|agents|vault|\.github)\//;
/** Directories where only a specifically-named file is acceptable. */
const EXACT_ALLOWLIST = new Set([
  "packages/core/README.md",
  "packages/indexer/README.md",
  "packages/mcp/README.md",
  "packages/demo-agent/README.md",
  "packages/core/test/wallet-e2e/README.md",
  "contracts/test/README.md",
]);

/** True when this path is a location permitted to hold a markdown file. */
function isAllowed(p) {
  if (ROOT_FILE_PATTERNS.test(p)) return true;
  if (DIR_ALLOWLIST.test(p)) return true;
  if (EXACT_ALLOWLIST.has(p)) return true;
  return false;
}

let tracked;
try {
  // `git ls-files` (not a shell pipeline) so this runs identically on PowerShell,
  // bash and CI. core.quotepath=false keeps non-ASCII filenames readable, which
  // matters for vault/Component 1 — ….md style names.
  tracked = execSync("git -c core.quotepath=false ls-files -- *.md", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .filter((p) => p.endsWith(".md"));
} catch (error) {
  console.error(`check-doc-location: git ls-files failed: ${error.message}`);
  process.exit(1);
}

const strays = tracked.filter((p) => !p.startsWith("docs/") && !isAllowed(p));

const docsCount = tracked.filter((p) => p.startsWith("docs/")).length;

// ---------------------------------------------------------------------------
// Second direction: does every layer-table row in STATUS.md point at a file
// that exists, and does every docs/ file have a row?
//
// The two checks are independent and both are needed. A misplaced deliverable is
// invisible to the layer tables; a row pointing at a path that does not exist is
// worse than no row, because a reader trusts it. That failure mode is not
// hypothetical: on 2026-09-26 an instruction was issued that would have repointed
// DOC-AUDIT-CONTRACTS's row at a same-named file about a different subject.
//
// This half used to live only in a throwaway script, which made it a claim
// rather than a check. It is here now, and it also runs without forge.
// ---------------------------------------------------------------------------
const problems = [];

const STATUS_PATH = path.join(ROOT, "docs", "STATUS.md");
if (!existsSync(STATUS_PATH)) {
  problems.push("docs/STATUS.md is missing — the document index itself is gone");
} else {
  const status = readFileSync(STATUS_PATH, "utf8");
  const firstCell = (line) => (line.split("|")[1] ?? "").trim();
  const rowSubjects = new Set();
  for (const line of status.split(/\r?\n/)) {
    if (!line.startsWith("| `")) continue;
    rowSubjects.add(firstCell(line).replace(/`/g, ""));
  }

  // (a) every row pointing into docs/ must resolve to a file that exists
  for (const subject of rowSubjects) {
    if (!subject.startsWith("docs/") || subject.includes("*")) continue;
    if (!existsSync(path.join(ROOT, subject))) {
      problems.push(`STATUS.md row points at a file that does not exist: ${subject}`);
    }
  }

  // (b) every markdown in docs/ must have a row (docs/STATUS.md excepted: an
  //     index does not list itself)
  const onDisk = readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md"));
  for (const f of onDisk) {
    if (f === "STATUS.md") continue;
    if (!rowSubjects.has(`docs/${f}`) && !rowSubjects.has(f)) {
      problems.push(`no STATUS.md row for docs/${f} — it is unindexed`);
    }
  }
}

if (strays.length === 0 && problems.length === 0) {
  console.log(
    `doc location OK — ${docsCount} tracked .md in docs/, ${tracked.length - docsCount} outside it, all in approved locations.`,
  );
  console.log("  index OK — every docs/ file has a STATUS.md row, and every row resolves to a real file.");
  // The boundary belongs in the RESULT, not only in the header: someone reading a CI log
  // never sees the header. "tracked" is load-bearing — it is the difference between
  // "every markdown file is covered" and "every committed markdown file is", and the
  // whole point of declaring the scope is that the reader can see which one they got.
  console.log("  scope: git-TRACKED .md only (a clean run says nothing about ignored or untracked files)");
  process.exit(0);
}

if (strays.length > 0) {
  console.error(`doc location: ${strays.length} tracked .md outside docs/ in a location that may not hold one:`);
  for (const p of strays) console.error(`  ${p}`);
  console.error("\n  An audit/review/research document belongs in docs/ (see docs/STATUS.md, 'Where a document may live').");
  console.error("  If one of these is legitimately not an audit (e.g. a package README), add it to the allowlist above.");
}
if (problems.length > 0) {
  console.error(`doc index: ${problems.length} problem(s) in the STATUS.md layer tables:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("\n  Add the row in the same change that creates the file, and never point a row at a");
  console.error("  path that does not exist — a wrong row is trusted, a missing row is noticed.");
}
process.exit(1);
