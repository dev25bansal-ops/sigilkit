#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ KNOWN FALSE POSITIVE (2026-09-28) — being fixed in this change.          ║
 * ║                                                                          ║
 * ║ This gate currently reports ALL 24 discovered suites as drift.            ║
 * ║ **NONE OF THE 24 IS REAL.** Every one of them is registered.             ║
 * ║                                                                          ║
 * ║ Cause: `registeredSuites()` finds its end anchor with a literal         ║
 * ║ `indexOf("]),")`. A doc comment in `verify.mjs` — written by another     ║
 * ║ author to warn that exactly this hazard existed — contains the characters ║
 * ║ `]),` inside it, so `indexOf` matched the PROSE. The slice covered 278   ║
 * ║ characters of comment and zero suite paths, so `registeredSuites()`      ║
 * ║ returned `[]` (empty, NOT null).                                         ║
 * ║                                                                          ║
 * ║ Why that produced a confident wrong answer instead of a loud failure:    ║
 * ║ `unregisteredSuites()` only returns `null` — the fail-closed signal —    ║
 * ║ when `registered === null`. `[]` is a *valid* value, so the guard went   ║
 * ║ down the normal path and compared 24 real suites against an empty list.  ║
 * ║ The fail-closed branch could not fire.                                    ║
 * ║                                                                          ║
 * ║ ⚠ DO NOT "fix" this by making the guard green without fixing the anchor. ║
 * ║ Changing the report, widening the slice, or special-casing the comment  ║
 * ║ would make the gate pass while it still cannot see its subject — and     ║
 * ║ would bury 24 genuine drift reports if the list ever really did drift.    ║
 * ║ The fix is to stop depending on a literal anchor at all.                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */
/**
 * P1: the `helpers` step's suite list had drifted from the suites that exist.
 *
 * The gate's helper step named 15 test files by hand. Seven more existed on disk — five under
 * `scripts/lib/` plus two top-level guards — and ran nowhere: not in `npm run verify`, not in
 * CI. 129 passing tests, invisible. The list was maintained by memory, and memory does not
 * notice a file that was added later.
 *
 * This guard makes that question answerable by a *running* test rather than by a reviewer's
 * diligence: if a `*.test.mjs` exists anywhere under `scripts/` and is not in the list the
 * gate actually runs, this fails.
 *
 * Three decisions worth stating, because each one is a way this could have been built wrong:
 *
 * 1. **Discovery covers `scripts/` and `scripts/lib/`.** A top-level-only scan misses all five
 *    lib suites — which is, almost certainly, how the hand-written list lost them in the first
 *    place. `readdirSync(..., { recursive: true })` covers both roots at once.
 *
 * 2. **The check parses `verify.mjs` for the literal argv list, and fails if it cannot find
 *    it.** A guard that cannot locate its subject degrades into "0 problems" — i.e. it would
 *    pass precisely when the list it is meant to police has been refactored out of existence.
 *    That is the same failure shape as the `--with-ts` one this report documents elsewhere: an
 *    absent subject must fail loudly, not silently succeed.
 *
 * 3. **It does not run the suites.** It compares two file lists. A suite that cannot even
 *    import is still a `.test.mjs` on disk, so it is still discovered here and still counted as
 *    unregistered until someone registers it — at which point `node --test` will report the
 *    import error as a normal failure. (Registering a glob instead of an argv list would break
 *    that: a glob hands the file set to Node, and an import-time throw can be reported
 *    differently from an assertion failure. Keeping an explicit argv list preserves
 *    "a suite that will not load is a suite that fails".)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");
const VERIFY = join(SCRIPTS, "verify.mjs");

/**
 * The anchors that delimit the gate's helper-step suite list inside `verify.mjs`.
 *
 * The list is read as "everything between the `--test` flag and the array's closing `]);`".
 * Pinning a *last* entry instead would make this guard silently stop covering every suite
 * added after it — the same drift it exists to prevent, one level up.
 *
 * ── 2026-09-28: the end anchor is no longer a literal ──────────────────────────────────
 * It used to be `indexOf("]),")`, and that was a real defect, not a hypothetical one: a doc
 * comment in `verify.mjs` — written by another author to warn that exactly this hazard
 * existed — contains `]),` in its prose, so the literal matched the COMMENT. The slice covered
 * 278 characters of comment and zero suite paths, so `registeredSuites()` returned `[]`
 * (empty, NOT null) and all 24 real suites were reported as drift.
 *
 * The lesson is not "pick a different literal". It is that **a parser and the documentation
 * describing it share one text, so every literal in that documentation is a candidate match.**
 * A guard whose correctness depends on "that literal will never appear in a comment" rests on
 * a premise nothing verifies — and this repository has now falsified it once.
 *
 * So the block is found by its *content* instead: start at the `--test` flag, then extend
 * through the last line that actually names a suite. Prose cannot fake that, because prose does
 * not contain a real `scripts/<dir>/<name>.test.mjs` path. The list may end with any bracket
 * style; only its contents are load-bearing.
 */
const LIST_START = '"--test",';
/** One suite path as written in the argv list. Anchored to the path shape, not to punctuation. */
const SUITE_PATH = /scripts\/[\w./-]+\.test\.mjs/g;

/**
 * Every `*.test.mjs` under `scripts/`, recursively, as repo-relative forward-slash paths.
 *
 * Exported and pure-ish so a test can feed it a fixture instead of reading the repository.
 * `recursive: true` is what makes `scripts/lib/` visible; without it the five lib suites are
 * exactly the ones that go missing.
 */
export function discoverSuites(scriptsDir, readDir = readdirSync) {
  return readDir(scriptsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => {
      // Node renamed Dirent.path → Dirent.parentPath (v22.12+/v24: `path` is gone). With
      // `recursive: true` the value is the entry's directory *as given*, i.e. relative to the
      // cwd the caller passed — for a top-level file that is the dir itself, not "". Both
      // spellings are normalised through `relative()` so neither shape is load-bearing.
      const dir = entry.parentPath ?? entry.path ?? "";
      const rel = relative(scriptsDir, join(dir, entry.name));
      // `relative()` can only fail (returning a non-relative path) when `scriptsDir` and the
      // entry are on different roots; fall back to the name so the entry still appears rather
      // than silently vanishing from the comparison.
      return `scripts/${(rel.includes("..") || rel === "" ? entry.name : rel).split(sep).join("/")}`;
    })
    .sort();
}

/**
 * The suite paths `verify.mjs` actually hands to `node --test`, read out of the source.
 *
 * Parsed rather than imported on purpose: `verify.mjs` runs the entire gate on import, so
 * there is no way to ask it what it would run without running it. A regex over the literal argv
 * list is the only non-executing read available.
 *
 * Returns `null` when the list cannot be located — a shape change in `verify.mjs`, or a start
 * anchor with no suite path anywhere after it — so the caller can fail loudly instead of
 * comparing against an empty list and declaring victory.
 *
 * There are exactly three outcomes, and collapsing any two of them is what made the 2026-08
 * incident possible:
 *   • `null`         — the subject cannot be seen. The caller MUST fail closed (exit 2).
 *   • a non-empty array — the real list. The only value that may be compared against.
 *   • an empty array  — only reachable if the block contains a suite path that matches nothing,
 *                      which the guard below treats as a parse failure rather than "no suites".
 * There is deliberately NO "`[]` because the list is empty" outcome: an empty argv list and an
 * invisible argv list are different facts, and only one of them means the repository is fine.
 */
export function registeredSuites(source) {
  const start = source.indexOf(LIST_START);
  if (start === -1) return null;

  // Find where the list's *content* ends, by content rather than by punctuation. The block runs
  // from the `--test` flag through the last line that names a suite, stopping at the first line
  // that is neither a suite nor a comment.
  //
  // Two rules, and getting either wrong is a real defect — both were, in sequence:
  //
  //   • Stop at the first NON-comment, non-suite line. That is the close of the list (`]),`).
  //     Without this, a later comment saying "we should also add scripts/imaginary.test.mjs one
  //     day" would count as a registration — worse than the bug being fixed, because a sentence
  //     could mark a suite as run when it never ran, and the guard would report no drift.
  //
  //   • SKIP comments rather than stopping on them. The real list interleaves explanatory
  //     comments between entries (the DEBT-06 and CI-PARITY notes in `verify.mjs`), so treating
  //     "not a suite line" as "the list ended" truncated a 23-suite list to 7 and invented 16
  //     false drift reports. A comment is not part of the list's content, but it is not the end
  //     of it either.
  const rest = source.slice(start);
  const lines = rest.split("\n");
  let lastSuiteLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    SUITE_PATH.lastIndex = 0;
    if (SUITE_PATH.test(line)) {
      lastSuiteLine = i;
      continue;
    }
    if (lastSuiteLine !== -1) break; // a real, non-comment line with no suite: the list closed
  }
  // A start anchor with no suite path anywhere after it means the list was renamed, emptied or
  // moved. That is NOT an empty list — it is a subject this guard cannot see, and returning
  // `[]` here is what made 24 real suites look like drift. `null` is the honest answer, and
  // `unregisteredSuites` turns it into the exit-2 refusal.
  if (lastSuiteLine === -1) return null;
  // Comments inside the block may quote a suite path as an example. Only real entries count, and
  // an entry is a path on a line that is not a comment — so the block is re-scanned line-wise
  // rather than by raw regex over the whole slice.
  const entries = lines
    .slice(0, lastSuiteLine + 1)
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .flatMap((l) => l.match(SUITE_PATH) ?? []);
  return [...new Set(entries)].sort();
}

/**
 * The suites that exist but are never run. `null` means the registered list could not be read,
 * which is a different failure and must not be reported as "no drift".
 *
 * `[]` is folded into `null` HERE, at the boundary, rather than being left to the caller. An
 * empty register is indistinguishable from an unreadable one — both mean "this guard has no
 * list to compare against" — and the 2026-08 incident is exactly what happens when a caller
 * treats one as the other. The only value that may be compared is a non-empty list.
 */
export function unregisteredSuites(discovered, registered) {
  if (registered === null || registered.length === 0) return null;
  const known = new Set(registered);
  return discovered.filter((suite) => !known.has(suite));
}

function main() {
  const discovered = discoverSuites(SCRIPTS);
  let source;
  try {
    source = readFileSync(VERIFY, "utf8");
  } catch (err) {
    console.error(`could not read scripts/verify.mjs: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }
  const registered = registeredSuites(source);
  const missing = unregisteredSuites(discovered, registered);

  if (missing === null) {
    console.error(
      "helper-suite drift guard: could not locate the --test suite list in scripts/verify.mjs.\n" +
      `The list's shape changed (expected a line containing ${LIST_START}, then suite paths matching ${SUITE_PATH}).\n` +
      'Refusing to report "no drift": a guard that cannot see its subject is not a guard.',
    );
    process.exit(2);
    return;
  }

  if (missing.length === 0) {
    console.log(`helper suites OK — all ${discovered.length} discovered suite(s) are registered in verify.mjs.`);
    return;
  }
  console.error(`helper-suite drift (${missing.length}):`);
  for (const suite of missing) console.error(`  ${suite} exists but is never run by \`npm run verify\`.`);
  console.error("Register it in verify.mjs's `helpers` step, or delete it if it is obsolete.");
  process.exit(1);
}

/** True when this module is the process entry point (not imported by its test). */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolved = pathToFileURL(entry).href;
  return process.platform === "win32"
    ? resolved.toLowerCase() === import.meta.url.toLowerCase()
    : resolved === import.meta.url;
}

if (isDirectInvocation()) main();
