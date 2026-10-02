/**
 * Repository-root and repo-relative path resolution — extracted, not yet migrated.
 *
 * ── WHERE THIS CAME FROM ────────────────────────────────────────────────────────
 * Every script in `scripts/` opened with its own copy of the same one-liner. Verbatim
 * `join(dirname(fileURLToPath(import.meta.url)), "..")` at 13 sites:
 *
 *   scripts/check-doc-counts.mjs:41        scripts/check-runtime.mjs:25
 *   scripts/verify.mjs:55                  scripts/validate-workflows.mjs:23
 *   scripts/check-dockerfile.mjs:20        scripts/sync-facts.mjs:73
 *   scripts/check-waivers.mjs:50           scripts/check-vectors.mjs:40
 *   scripts/generate-vectors.mjs:21        scripts/clean.mjs:82
 *   scripts/assurance-inventory.mjs:322    scripts/check-vectors.test.mjs:36
 *
 * `resolve(dirname(fileURLToPath(import.meta.url)), "..")` — same result, different
 * spelling, so a grep for the pattern missed it twice:
 *
 *   scripts/benchmark-indexer.mjs:62
 *
 * And the "is this module the process entry point?" predicate, in five hand-written
 * variants across three different comparison strategies:
 *
 *   scripts/check-doc-counts.mjs:984-991   win32-lowercased href compare  (function)
 *   scripts/check-waivers.mjs:485-492      win32-lowercased href compare  (function)
 *   scripts/check-vectors.mjs:721-728      win32-lowercased href compare  (function)
 *   scripts/check-runtime.mjs:235-236      bare href compare
 *   scripts/assurance-inventory.mjs:361    bare href compare
 *   scripts/sync-facts.mjs:1520-1524       win32-lowercased href compare  (inline const)
 *   scripts/clean.mjs:367                  fileURLToPath === resolve(argv[1])
 *   scripts/check-package-artifacts.mjs:342 fileURLToPath === argv[1]  (no resolve at all)
 *   scripts/benchmark-indexer.mjs:747      isMainThread && bare href compare
 *
 * ── WHO SHOULD ADOPT IT ──────────────────────────────────────────────────────────
 * Every gate script and every `*.test.mjs` under `scripts/`. Replace
 * `const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")` with an import of
 * `REPO_ROOT`, and every local `isDirectInvocation()` with this one.
 *
 * ── THE DIVERGENCE THIS FIXES, AND THE ONE THAT MUST STAY ────────────────────────
 * `check-package-artifacts.mjs:342` compares `fileURLToPath(import.meta.url)` to
 * `process.argv[1]` *without* `resolve()`. Node 20+ is documented to pass a relative
 * `argv[1]` when the entry was given as a relative path, so on a case-insensitive
 * filesystem with a differently-cased drive letter that comparison is simply false —
 * the guard then never runs its own `main()` and exits 0 having checked nothing. The
 * three win32-lowercasing variants got this right; the two bare-href ones and
 * `clean.mjs` did not. {@link isDirectInvocation} is the win32-tolerant form, so
 * adopting it changes behaviour for exactly those three scripts, in the direction of
 * "the guard now actually runs".
 *
 * One behaviour is deliberately NOT unified: `benchmark-indexer.mjs:747` also requires
 * `isMainThread`, because the file is simultaneously a CLI entry point and a worker
 * bootstrap. It must keep its own predicate and AND this one; do not "simplify" it.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Absolute path of the `scripts/lib/` directory holding this module. */
export const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the `scripts/` directory (this module's parent's parent). */
export const SCRIPTS_DIR = resolve(LIB_DIR, "..");

/** Absolute repository root. This file lives at `<root>/scripts/lib/paths.mjs`. */
export const REPO_ROOT = resolve(SCRIPTS_DIR, "..");

/**
 * The repository root as seen from a module inside `<root>/scripts/`.
 *
 * A gate script under `scripts/` calls `repoRootFrom(import.meta.url)` and gets the same
 * answer {@link REPO_ROOT} does, without each script re-deriving the `..` hop. Note the
 * hop count is fixed at one: for a module in `scripts/lib/` this returns `scripts/`, not
 * the repository root — which is exactly the trap the open-coded one-liner walked into, and
 * why a lib module must import {@link REPO_ROOT} instead of calling this.
 *
 * @param {string} importMetaUrl usually `import.meta.url`; a plain path is also accepted
 * @returns {string} absolute, already-`resolve`d
 */
export function repoRootFrom(importMetaUrl) {
  // Accepts a `file://` URL or a plain path. The plain-path form matters because a test
  // fixture, a `--root` default and a `new URL(..., import.meta.url).pathname` all produce
  // one, and `fileURLToPath` throws on a bare Windows path like `D:\repo\scripts\x.mjs`.
  const path = importMetaUrl.startsWith("file:") ? fileURLToPath(importMetaUrl) : importMetaUrl;
  return resolve(dirname(path), "..");
}

/**
 * Joins a repo-relative, forward-slash path onto a root.
 *
 * The scripts that address files by their documented repo-relative spelling
 * (`"docs/STATUS.md"`, `"packages/core/package.json"`) each open-coded the split, and each
 * got the Windows separator question differently:
 *
 *   scripts/check-doc-counts.mjs:636   join(ROOT, ...relativePath.split("/"))
 *   scripts/check-doc-counts.mjs:945   join(ROOT, ...rel.split("/"))
 *   scripts/sync-facts.mjs:1397        join(root, ...String(rel).split("/"))
 *
 * `join` normalises separators on its own, so one spelling serves both platforms. Returns
 * an absolute path; the input is never interpreted as anything but a relative path, and a
 * leading `/` or a `..` segment is the caller's problem (the whitelists in
 * `sync-facts.mjs` and `check-package-artifacts.mjs` are what police that, and this helper
 * deliberately does not second-guess them).
 *
 * @param {string} root absolute root
 * @param {string} rel repo-relative posix path
 * @returns {string}
 */
export function repoPath(root, rel) {
  return join(root, ...String(rel).split("/"));
}

/**
 * True when `moduleUrl` is the process entry point, i.e. the script was *run* rather than
 * imported.
 *
 * The comparison is case-insensitive on Windows and exact elsewhere, matching the three
 * `win32`-lowercasing copies this replaces. `resolve()` is applied to `argv[1]` first so a
 * relative entry path still matches an absolute `import.meta.url`.
 *
 * @param {string} moduleUrl the *caller's* `import.meta.url` — pass your own, not this
 *   file's, or every caller looks "imported"
 * @param {string|null} [entry] the entry path; **omitted or `undefined` means
 *   `process.argv[1]`**, so a caller that wants to test "no entry at all" must pass `null`
 *   or `""` explicitly — there is no way to spell "no default" other than a sentinel
 * @returns {boolean}
 */
export function isDirectInvocation(moduleUrl, entry = process.argv[1]) {
  // Both falsy `entry` readings are refused, not just `undefined`. `""` is what a caller
  // passes when it resolved an option to "unset", and `pathToFileURL(resolve(""))`
  // resolves to the cwd — so without this the empty string would compare as a *match* for
  // any module that happens to live at the cwd root.
  if (!entry) return false;
  const target = pathToFileURL(resolve(entry)).href;
  return process.platform === "win32"
    ? target.toLowerCase() === moduleUrl.toLowerCase()
    : target === moduleUrl;
}
