#!/usr/bin/env node
/**
 * Negative tests for the document-location guard (dc-law, 2026-09-26).
 *
 * Why this file exists: `check-doc-location.mjs` printed OK on its first run
 * while counting two real strays, because it allow-listed `packages/` and
 * `contracts/` wholesale. A guard that has only ever been seen to pass is not a
 * guard. These cases lock the behaviour down so the same class of bug cannot
 * return silently, and so the "it went red" claim is reproducible instead of
 * something a reader has to take on trust.
 *
 * The stray cases drive a TEMPORARY GIT INDEX (GIT_INDEX_FILE), not the real one
 * and not the working tree: a path is staged into a throwaway index kept in the OS
 * temp dir, the guard runs against it, and the index is deleted. Nothing in the
 * repository is created, modified or removed — not `.git/`, not the working tree — and
 * the real index is never touched, so these tests are safe to run at any time, including
 * mid-task with uncommitted work.
 *
 * The one exception is deliberate and restored in a `finally`: the index half of the guard
 * reads docs/STATUS.md from the working tree, so the two index cases perturb that file and
 * put it back exactly as they found it.
 *
 *   node scripts/check-doc-location.test.mjs
 *
 * Exit 0 = all cases behaved as specified. Exit 1 = the guard regressed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
// Outside the repository on purpose. A throwaway index does not belong in `.git/`: a run
// killed between create and cleanup would leave a stray index there, and the whole point of
// this file is that it touches nothing the repository owns.
const TMP_INDEX = path.join(tmpdir(), `sigilkit-doc-location-test-index-${process.pid}`);

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function git(args, env) {
  return execFileSync("git", args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Hashes `content` WITHOUT writing an object.
 *
 * This used to be `hash-object -w`, which left an unreferenced blob in `.git/objects` on
 * every run — a leak nothing ever collects. The blob is never read: `check-doc-location.mjs`
 * asks git for the index's *paths* (`ls-files -- *.md`) and reads the documents from the
 * working tree, so the cacheinfo entry needs a well-formed id and nothing more.
 */
function blobFor(content) {
  return git(["hash-object", "--stdin"], { ...process.env })
    .toString()
    .trim();
}

/** Stages `paths` into a throwaway index, runs `fn`, then always cleans up. */
function withFakeIndex(paths, fn) {
  if (existsSync(TMP_INDEX)) rmSync(TMP_INDEX);
  const env = { ...process.env, GIT_INDEX_FILE: TMP_INDEX };
  git(["read-tree", "HEAD"], env);
  const blob = blobFor("decoy\n");
  for (const p of paths) {
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${p}`], env);
  }
  try {
    return fn(env);
  } finally {
    if (existsSync(TMP_INDEX)) rmSync(TMP_INDEX);
  }
}

/** Runs the guard, returning its exit code and combined output. */
function runGuard(env) {
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, "check-doc-location.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

console.log("check-doc-location: an allowed tree passes");

withFakeIndex([], (env) => {
  const r = runGuard(env);
  check("exits 0", r.code === 0, `got ${r.code}: ${r.out.trim()}`);
  check("reports OK", /OK/.test(r.out), r.out.trim());
});

console.log("\ncheck-doc-location: a misplaced audit fails (each was a real stray)");

for (const stray of [
  "packages/core/ARCH-2026-09-26.md",
  "packages/core/DOC-AUDIT-2026-09-26.md",
  "scripts/ARCH-2026-09-26.md",
  "contracts/ARCH-2026-09-26.md",
  "packages/indexer/AUDIT.md",
]) {
  withFakeIndex([stray], (env) => {
    const r = runGuard(env);
    check(`${stray} -> exit 1`, r.code === 1, `got ${r.code}: ${r.out.trim()}`);
    check(`${stray} -> named in output`, r.out.includes(stray), r.out.trim());
  });
}

console.log("\ncheck-doc-location: an audit inside docs/ is fine");

for (const ok of [
  "docs/ARCH-CORE-2026-09-26.md",
  "docs/ARCH-SCRIPTS-2026-09-26.md",
  "docs/DOC-AUDIT-CORE-2026-09-26.md",
]) {
  withFakeIndex([ok], (env) => {
    const r = runGuard(env);
    check(`${ok} -> exit 0`, r.code === 0, `got ${r.code}: ${r.out.trim()}`);
  });
}

console.log("\ncheck-doc-location: a legitimate non-docs .md still passes");

for (const allowed of [
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "packages/core/README.md",
  "contracts/test/README.md",
  "vault/Sources.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
]) {
  withFakeIndex([allowed], (env) => {
    const r = runGuard(env);
    check(`${allowed} -> exit 0`, r.code === 0, `got ${r.code}: ${r.out.trim()}`);
  });
}

// ---------------------------------------------------------------------------
// The index half. These cases exist because on 2026-09-26 the "every row resolves
// to a real file" check existed only inside a throwaway script that was then
// deleted, while being reported as a resident gate. It is now part of the guard,
// and these cases are what make that claim testable rather than asserted.
//
// The index half reads the working tree, not the git index, so these cases
// perturb docs/STATUS.md itself and restore it afterwards.
// ---------------------------------------------------------------------------

console.log("\ncheck-doc-location: the STATUS.md index half goes red");

const STATUS = path.join(ROOT, "docs", "STATUS.md");
const statusBefore = readFileSync(STATUS, "utf8");

function withStatus(transform, fn) {
  const original = readFileSync(STATUS, "utf8");
  try {
    writeFileSync(STATUS, transform(original));
    return fn();
  } finally {
    writeFileSync(STATUS, original);
  }
}

withStatus(
  (s) => s + "\n| `docs/DOES-NOT-EXIST-2026-09-26.md` | ACTIVE | L3 | a row pointing at nothing |\n",
  () => {
    const r = runGuard({ ...process.env });
    check("row -> missing file exits 1", r.code === 1, `got ${r.code}: ${r.out.trim()}`);
    check("names the dangling row", /DOES-NOT-EXIST-2026-09-26\.md/.test(r.out), r.out.trim());
  },
);

withStatus(
  // Remove the row for a file that really exists -> unindexed document.
  (s) => s.replace(/^\| `docs\/ARCH-CORE-2026-09-26\.md`.*$/m, ""),
  () => {
    const r = runGuard({ ...process.env });
    check("unindexed docs/ file exits 1", r.code === 1, `got ${r.code}: ${r.out.trim()}`);
    check("names the unindexed file", /ARCH-CORE-2026-09-26\.md/.test(r.out), r.out.trim());
  },
);

check("STATUS.md restored after the index cases", readFileSync(STATUS, "utf8") === statusBefore);

// ---------------------------------------------------------------------------
// Scope declaration. The guard reads git-TRACKED .md only, and that boundary is
// intentional (ignored directories are sandboxes, not deliverables). A gate that does not
// say so reads as if it covers every markdown file in the tree — "the door is there, but
// not connected to the end it claims to check". Measured case (2026-09-26): the ignored
// sandbox copy of docs/WHITEPAPER-v2.1.md still read "Foundry total above (158)" while the
// tracked original read 220.
//
// These cases pin the DECLARATION, not a behaviour change: the input stays git-tracked
// (switching to a directory walk would change the denominator and is out of scope).
// ---------------------------------------------------------------------------

console.log("\ncheck-doc-location: the git-tracked scope is declared where a reader sees it");

{
  const source = readFileSync(path.join(HERE, "check-doc-location.mjs"), "utf8");
  check(
    "header says the scope is intentional, not an oversight",
    /SCOPE[\s\S]{0,400}INTENTIONAL/.test(source),
    "the header must frame git-tracked-only as a decision",
  );
  check(
    "header states the consequence (a clean run says nothing about ignored files)",
    /clean run[\s\S]{0,200}(ignored|untracked)/i.test(source),
    "the header must state what a pass does NOT cover",
  );
}

// The passing output is exercised in isolation: a live STATUS.md defect (an unindexed
// docs/ file) makes the real tree exit 1, and then the success line never prints. Asserting
// the scope line through the real tree would therefore be asserting on a GREEN run that
// only happens when nothing else is wrong — i.e. a test that silently stops testing.
// So the success path is driven directly, with STATUS.md made self-consistent.
// The passing output is exercised in isolation: a live STATUS.md defect (an unindexed
// docs/ file) makes the real tree exit 1, and then the success line never prints. Asserting
// the scope line through the real tree would therefore assert on a GREEN run that only
// happens when nothing else is wrong — a test that silently stops testing once the tree
// picks up an unrelated defect. So the success path is driven directly, with STATUS.md
// given the row it is missing.
function withCleanStatus(fn) {
  const original = readFileSync(STATUS, "utf8");
  try {
    // Add a row for every docs/ file that has none. The guard reports them as
    // "no STATUS.md row for <path>"; indexing each one makes the index half clean without
    // touching any row that already exists.
    const unindexed = [...original.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]);
    const onDisk = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "--", "docs/*.md"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).split("\n").filter((p) => p.endsWith(".md"));
    const added = onDisk.filter((p) => !unindexed.includes(p));
    let s = original;
    for (const p of added) s += `\n| \`${p}\` | ACTIVE | L3 | test fixture row |\n`;
    writeFileSync(STATUS, s, "utf8");
    return fn();
  } finally {
    writeFileSync(STATUS, original);
  }
}

withFakeIndex([], (env) => {
  withCleanStatus(() => {
    const r = runGuard(env);
    // The header is invisible to anyone reading a CI log, so the RESULT has to carry the
    // boundary too. This is the line that stops a green run being read as full coverage.
    check(
      "the passing output states the scope (clean tree)",
      /scope: git-TRACKED/i.test(r.out),
      r.out.trim(),
    );
    check(
      "the passing output says a clean run does not cover ignored/untracked files",
      /clean run says nothing about ignored or untracked/i.test(r.out),
      r.out.trim(),
    );
  });
});

console.log("");
if (failures === 0) {
  console.log("check-doc-location: all cases behaved as specified.");
  process.exit(0);
}
console.error(`check-doc-location: ${failures} case(s) failed — the guard regressed.`);
process.exit(1);
