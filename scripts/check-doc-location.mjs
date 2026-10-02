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
 * LIMITATION — this sees git-TRACKED files only. An untracked stray in the
 * working tree is invisible to it. A clean run means "no committed file is
 * misplaced", NOT "there are no strays". Do not use it as the gate; the gate is
 * "does every audit/research document have a row in one of the five tables in
 * docs/STATUS.md".
 *
 *   node scripts/check-doc-location.mjs
 *
 * Exit 0 = clean. Exit 1 = at least one tracked .md is in a location that is not
 * allowed to hold one; each is printed.
 */
import { execSync } from "node:child_process";

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

if (strays.length === 0) {
  console.log(
    `doc location OK — ${docsCount} tracked .md in docs/, ${tracked.length - docsCount} outside it, all in approved locations.`,
  );
  console.log("  (tracked files only — a clean run does not mean an untracked stray does not exist)");
  process.exit(0);
}

console.error(`doc location: ${strays.length} tracked .md outside docs/ in a location that may not hold one:`);
for (const p of strays) console.error(`  ${p}`);
console.error("\n  An audit/review/research document belongs in docs/ (see docs/STATUS.md, 'Where a document may live').");
console.error("  If one of these is legitimately not an audit (e.g. a package README), add it to the allowlist above.");
process.exit(1);
