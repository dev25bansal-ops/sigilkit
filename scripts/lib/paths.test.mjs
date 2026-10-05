/**
 * Tests for `scripts/lib/paths.mjs`.
 *
 * The interesting cases are the ones the three hand-written `isDirectInvocation` copies
 * disagreed on: a relative entry path, a Windows case difference, and a missing
 * `argv[1]`. Each is pinned here so a migrating script inherits the *correct* behaviour
 * rather than whichever variant it happened to have.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LIB_DIR,
  REPO_ROOT,
  SCRIPTS_DIR,
  isDirectInvocation,
  repoPath,
  repoRootFrom,
} from "./paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const SCRIPTS = dirname(dirname(SELF)); // <root>/scripts
/** The module *under* test, as a distinct module from this test file. */
const pathsModuleUrl = pathToFileURL(join(SCRIPTS, "lib", "paths.mjs")).href;
const pathsModulePath = join(SCRIPTS, "lib", "paths.mjs");

test("REPO_ROOT is the directory that contains scripts/, package.json and contracts/", () => {
  for (const child of ["scripts", "package.json", "contracts", ".github", "vectors"]) {
    assert.ok(existsSync(join(REPO_ROOT, child)), `${child} must exist under REPO_ROOT`);
  }
});

test("the three exported directories are consistently nested", () => {
  assert.equal(dirname(LIB_DIR), SCRIPTS_DIR);
  assert.equal(dirname(SCRIPTS_DIR), REPO_ROOT);
  assert.equal(SCRIPTS_DIR, resolve(LIB_DIR, ".."));
  assert.equal(REPO_ROOT, resolve(SCRIPTS_DIR, ".."));
});

test("repoRootFrom agrees with REPO_ROOT for a module one level under scripts/", () => {
  // This is the call every migrating gate makes: `repoRootFrom(import.meta.url)`.
  const synthetic = pathToFileURL(join(SCRIPTS_DIR, "check-doc-counts.mjs")).href;
  assert.equal(repoRootFrom(synthetic), REPO_ROOT);
});

test("repoRootFrom differs by one hop for a module inside scripts/lib/ — the trap this removes", () => {
  // `scripts/lib/x.mjs` needs two `..` hops, `scripts/x.mjs` needs one. Every script wrote
  // the same one-liner, which is correct for one of them and wrong for the other, so
  // `repoRootFrom` is fixed at ONE hop and a lib module must import REPO_ROOT instead.
  assert.equal(repoRootFrom(import.meta.url), SCRIPTS_DIR);
  assert.notEqual(repoRootFrom(import.meta.url), REPO_ROOT);
  assert.equal(repoRootFrom(join(SCRIPTS_DIR, "verify.mjs")), REPO_ROOT);
});

test("repoRootFrom accepts a plain path as well as a file URL", () => {
  const asPath = join(SCRIPTS_DIR, "verify.mjs");
  assert.equal(repoRootFrom(pathToFileURL(asPath).href), REPO_ROOT);
  assert.equal(repoRootFrom(asPath), REPO_ROOT, "a bare path must be accepted, not just a URL");
});

test("repoPath joins a repo-relative posix path, whatever the platform separator is", () => {
  assert.equal(repoPath(REPO_ROOT, "package.json"), join(REPO_ROOT, "package.json"));
  assert.equal(repoPath(REPO_ROOT, "docs/STATUS.md"), join(REPO_ROOT, "docs", "STATUS.md"));
  assert.equal(
    repoPath(REPO_ROOT, "packages/core/package.json"),
    join(REPO_ROOT, "packages", "core", "package.json"),
  );
  // The three open-coded copies differed only in how they split; all must agree.
  assert.equal(repoPath(REPO_ROOT, "a/b/c"), join(REPO_ROOT, "a", "b", "c"));
});

test("repoPath resolves back to the file it names", () => {
  assert.equal(repoPath(REPO_ROOT, "scripts/lib/paths.mjs"), join(SCRIPTS_DIR, "lib", "paths.mjs"));
  assert.ok(existsSync(repoPath(REPO_ROOT, "scripts/lib/paths.mjs")));
});

test("isDirectInvocation is false when there is no entry at all", () => {
  // `undefined` is NOT how you spell "no entry" — it selects the `process.argv[1]`
  // default. `null` and `""` are, and both must be refused: `pathToFileURL(resolve(""))`
  // resolves to the cwd, so without the guard an unset option would compare as a match.
  assert.equal(isDirectInvocation(import.meta.url, null), false);
  assert.equal(isDirectInvocation(import.meta.url, ""), false);
  assert.equal(isDirectInvocation(import.meta.url, "."), false, "the cwd is not this module");
});

test("isDirectInvocation falls back to process.argv[1] when the entry is omitted", () => {
  // This file *is* argv[1] under `node --test`, so the default resolves to a match.
  assert.equal(isDirectInvocation(import.meta.url), true);
  assert.equal(isDirectInvocation(import.meta.url, undefined), true);
});

test("isDirectInvocation is false for a module that is merely imported", () => {
  // This test file imports paths.mjs, so the entry is the test file, not paths.mjs.
  // `node --test` runs the file directly, so the guard under test sees a real argv[1] —
  // which is exactly the shape that must NOT match.
  assert.notEqual(fileURLToPath(import.meta.url), pathsModulePath, "fixture precondition");
  assert.equal(isDirectInvocation(pathsModuleUrl, process.argv[1]), false);
});

test("isDirectInvocation is true for this file given as the entry, absolute or relative", () => {
  assert.equal(isDirectInvocation(import.meta.url, SELF), true);
  assert.equal(isDirectInvocation(import.meta.url, resolve(SELF)), true);
  // This is the fix for `check-package-artifacts.mjs:342`, which compared
  // `fileURLToPath(import.meta.url)` to `process.argv[1]` with no `resolve()`.
  const rel = relative(process.cwd(), SELF);
  if (!rel.startsWith("..")) assert.equal(isDirectInvocation(import.meta.url, rel), true);
});

test("isDirectInvocation is true for this file spelled with a ./ prefix", () => {
  const rel = relative(process.cwd(), SELF);
  if (rel.startsWith("..")) return;
  assert.equal(isDirectInvocation(import.meta.url, `./${rel.split(/[\\/]/).join("/")}`), true);
});

test("isDirectInvocation resolves a relative entry against the process cwd", () => {
  const rel = relative(process.cwd(), SELF);
  assert.ok(!rel.startsWith(".."), "fixture must be reachable from cwd for this test to mean anything");
  assert.equal(isDirectInvocation(import.meta.url, rel), true);
  assert.equal(isDirectInvocation(import.meta.url, `./${rel.split(/[\\/]/).join("/")}`), true);
});

test("isDirectInvocation matches a differently-cased path on win32 and not elsewhere", () => {
  const shouted = SELF.toUpperCase();
  assert.equal(
    isDirectInvocation(import.meta.url, shouted),
    process.platform === "win32" ? true : shouted === SELF,
  );
});

test("isDirectInvocation rejects a different file in the same directory", () => {
  const sibling = join(dirname(SELF), "reporter.mjs");
  assert.equal(isDirectInvocation(import.meta.url, sibling), false);
});

test("a cwd-relative entry with a different drive-letter case still matches on win32", () => {
  if (process.platform !== "win32") return;
  const rel = relative(process.cwd(), SELF).split(/[\\/]/).join("/");
  assert.equal(isDirectInvocation(import.meta.url, rel.toUpperCase()), true);
});
