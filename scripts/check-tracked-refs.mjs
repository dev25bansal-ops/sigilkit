#!/usr/bin/env node
/**
 * Tracked-reference gate: every `scripts/…` path a committed workflow invokes must itself be
 * committed.
 *
 * ## Why this exists
 *
 * On 2026-09-26 six files under `scripts/` were referenced by tracked workflows but were not in
 * version control. On a clean clone the jobs that call them failed on a missing file — and
 * because the first job in `ci.yml` (`workflow-lint`) is the one that installs actionlint and
 * runs the waiver and vector guards, the pipeline failed at its earliest step and every later
 * signal was hidden behind it. Among the casualties: the full-history gitleaks secret scan, the
 * machine half of the `docs/CI-WAIVERS.md` governance register, and the vector-corpus
 * provenance check.
 *
 * The defect class is not subtle in review and is invisible to every other guard here. The
 * workflow *linters* parse and shape-check YAML; they do not ask whether the files they invoke
 * exist in the commit. Reading the code cannot find it either — the scripts were all present and
 * correct on the working tree. Only version control can answer it, which is why this is a
 * separate script rather than another rule inside `validate-workflows.mjs`: it needs `git`, and
 * that dependency has to be optional.
 *
 * ## Why it must fail open without git
 *
 * A published tarball, a `npm pack` consumer and a vendored checkout have no `.git`. This gate
 * cannot answer its question there, and a gate that cannot answer must not cry wolf: it reports
 * SKIP and exits 0. The failure mode of the alternative is worse than the bug it watches — a
 * permanently red gate gets ignored, and then it protects nothing.
 *
 * ## What counts as a reference
 *
 * Only a reference in a *value* position counts — a `run:` body, a `working-directory`, an
 * `env:` value. Text inside a YAML comment is skipped, because the most likely hit is a comment
 * quoting the *previous* state of a fix ("this used to pipe `bash <(curl … download-actionlint.bash)`"),
 * which names a file that must NOT exist. Treating that as a reference would demand committing a
 * file whose absence is the point.
 *
 *   node scripts/check-tracked-refs.mjs          # human report
 *   node scripts/check-tracked-refs.mjs --json   # machine-readable
 *
 * Exit codes: 0 = every reference is tracked (or the check was skipped), 1 = at least one
 * referenced path is untracked, 2 = the repository could not be read.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, ".github", "workflows");
const JSON_OUT = process.argv.slice(2).includes("--json");

/** Paths this gate is meant to protect, not to demand. */
const IGNORED = new Set(["node_modules", "packages", "contracts", "docs", "vault", "vectors"]);

/**
 * Every `scripts/…` token in `text`, with comments removed.
 *
 * A line whose first non-space character is `#` is dropped before extraction, which is what
 * keeps the "this used to …" comments out. `run:` bodies are additionally scanned with the same
 * rule applied per line, so a trailing comment on a command line is dropped too.
 */
export function scriptReferences(text) {
  const found = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (line.trim().startsWith("#")) continue;
    for (const match of line.matchAll(/scripts\/[A-Za-z0-9._*/-]+/g)) {
      const token = match[0].replace(/[.,;:)]+$/, "");
      // A glob (`scripts/*.test.mjs`) is a legitimate reference. Resolving it is not this
      // gate's job — it asks "is what CI invokes committed", and a glob answers that only by
      // expansion. So the glob is recorded and simply never matches a single tracked path,
      // rather than being dropped here and silently narrowing what the gate inspects.
      if (token.includes("*")) { found.add(token); continue; }
      if (token.split("/").every((part) => part !== "" && part !== "." && part !== "..")) {
        found.add(token);
      }
    }
  }
  return [...found].sort();
}

/**
 * The `run:` bodies of one workflow, as text.
 *
 * Deliberately a text scan, not a YAML parse. `validate-workflows.mjs` already owns "is this
 * workflow well-formed", and duplicating the parse would make this gate fail for the wrong
 * reason — a syntax error would be reported as a tracking problem. This gate answers one
 * question and needs no parser to answer it. It also means the gate has **no dependencies**,
 * which matters more than it looks: it runs in `workflow-lint`, the first job in the pipeline,
 * where a missing or unresolvable dependency would turn the whole job red for a non-reason.
 * (`yaml` is currently unresolvable from `scripts/` on some machines, so a parser import here
 * would have made the gate permanently red for exactly the reason it exists.)
 *
 * `run:` bodies are located by indentation — the key at the start of a line, and every
 * following line indented deeper. That also covers folded/literal scalars and `- run:` list
 * items, so a step written as a list entry is scanned too.
 */
export function runBlocks(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let inBlock = false;
  let childIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inBlock) {
      // Stay in the block while lines stay indented at least as deep as the first body line.
      // `childIndent` is fixed once, at the first body line, rather than recomputed per line:
      // a later line indented deeper (a nested heredoc, an indented shell block) must not end
      // the block early, and one shallower ends it exactly once.
      //
      // Advancing `i` by the number of collected lines — the obvious way to write this — is
      // wrong: `out` accumulates across *all* blocks, so the skip overshoots and silently
      // truncates every later `run:` in the file. That bug hid `check-vectors` completely: two
      // of the six known-untracked references this gate exists to catch were invisible to it.
      // No other guard could have found it, because a mis-shaped workflow and an uncommitted
      // file are different questions.
      if (line.trim() === "") { out.push(""); continue; }
      const lineIndent = line.length - line.trimStart().length;
      // Ending the block must NOT consume the line. A `- run:` step is exactly as indented as
      // the `run:` key that opened the block, so `continue`-ing past it dropped every step
      // after the first multi-line one. Re-test the line instead of discarding it.
      if (lineIndent < childIndent) inBlock = false;
      else { out.push(line); continue; }
    }
    const m = /^(\s*)(?:-\s*)?run\s*:(?:\s*>-?\s*|\s*\|[-+]?\s*)?(.*)$/.exec(line);
    if (!m) continue;
    const inline = m[2];
    if (inline.trim() !== "" && !inline.trim().startsWith("#")) { out.push(inline); continue; }
    inBlock = true;
    childIndent = m[1].length + 2;
  }
  return out.join("\n");
}

/**
 * How git answered, split by what the answer means for this gate — see the header's "Why it
 * must fail open without git".
 *
 * The old test was a single boolean over `error || status || stdout`, so three unrelated
 * situations produced one verdict: no git on PATH, git present but unusable (EACCES, or a probe
 * that had to be killed), and a tree that genuinely is not a work tree. The first and third
 * are the documented SKIP. The second is this gate failing to ask its question, and answering
 * "nothing to verify" for it is a green run produced by a broken environment.
 *
 *   "available"    — git ran and this is a work tree; proceed.
 *   "unavailable" — no git executable. Documented SKIP (tarball, vendored copy).
 *   "not-a-repo"   — git ran and says this is not a work tree. Documented SKIP.
 *   "unknown"      — git ran but the answer could not be read. Exit 2, never a pass.
 */
function gitProbe() {
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  if (probe.error) {
    // ENOENT is the documented "no git on PATH". Anything else — EACCES, a spawn that could
    // not start — is not git's absence; it is git being unusable here.
    return probe.error.code === "ENOENT" ? "unavailable" : "unknown";
  }
  if (probe.status === 0) {
    return String(probe.stdout ?? "").trim() === "true" ? "available" : "not-a-repo";
  }
  // git ran and refused. Outside a work tree its message is "not a git repository", which is
  // the documented tarball/vendored case; a killed probe leaves no status and no such message.
  return /not a git repository/i.test(String(probe.stderr ?? "")) ? "not-a-repo" : "unknown";
}

/**
 * Paths under `scripts/` that exist in HEAD, or null when git cannot be queried.
 *
 * `HEAD`, not the index, is the answer to "what does a clean clone get": `git ls-files`
 * includes staged files, so a script that was `git add`-ed but never committed masked the
 * exact failure this gate exists to catch — the gate went green over a tree a clean clone
 * could not run, and went red again the moment the index changed. `ls-tree -r HEAD` answers
 * the question the gate actually asks: is the invoked path in the commit.
 */
function trackedFiles() {
  const res = spawnSync("git", ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "scripts"], {
    cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  if (res.error || res.status !== 0) return null;
  return new Set(String(res.stdout ?? "").split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/")));
}

function main() {
  if (!existsSync(DIR)) {
    process.stderr.write(`no workflow directory at ${DIR}\n`);
    return 2;
  }
  const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort();
  if (files.length === 0) {
    process.stderr.write(`no workflow files found in ${DIR}\n`);
    return 2;
  }
  const git = gitProbe();
  if (git !== "available") {
    if (git === "unknown") {
      // Fail-closed, and only here: the two documented SKIP cases still skip, but a git that
      // could not answer is a gate that could not ask its question. Exit 2 is what this file's
      // own header already promises for "the repository could not be read".
      process.stderr.write("git is present but could not be queried; the tracked-refs question cannot be answered here\n");
      return 2;
    }
    const payload = { ok: true, skipped: true, reason: "git is unavailable or this is not a git checkout; nothing to verify" };
    if (JSON_OUT) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write("tracked-refs SKIP — not a git checkout; the question cannot be asked here.\n");
    return 0;
  }

  const tracked = trackedFiles();
  if (tracked === null) {
    process.stderr.write("could not read the tracked file list from git\n");
    return 2;
  }

  const missing = [];
  for (const name of files) {
    const text = readFileSync(join(DIR, name), "utf8");
    for (const ref of scriptReferences(runBlocks(text))) {
      if (ref.includes("*")) continue; // a glob is a pattern, not a path; see scriptReferences
      if (IGNORED.has(ref.split("/")[0])) continue;
      // A reference that is not on disk is not "not our business": on a clean clone it is
      // missing there too, so the job that invokes it fails there for exactly the reason an
      // untracked file does — which is the failure this gate exists to catch. Skipping it let
      // the gate report OK over a workflow that names a script nobody ever committed. Both
      // cases now land in the same list and reach the same verdict.
      if (!existsSync(join(ROOT, ...ref.split("/"))) || !tracked.has(ref)) {
        missing.push({ workflow: name, ref });
      }
    }
  }

  if (missing.length === 0) {
    if (JSON_OUT) process.stdout.write(`${JSON.stringify({ ok: true, skipped: false, missing: [] }, null, 2)}\n`);
    else process.stdout.write(`tracked-refs OK — every scripts/… path the workflows invoke is committed (${files.length} workflow(s)).\n`);
    return 0;
  }

  const seen = new Set();
  const rows = missing.filter((m) => (seen.has(m.ref) ? false : (seen.add(m.ref), true)));
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ ok: false, skipped: false, missing: rows }, null, 2)}\n`);
  } else {
    process.stdout.write(`tracked-refs FAILED — ${rows.length} workflow-invoked path(s) are not committed:\n`);
    for (const m of rows) process.stdout.write(`  ${m.ref}  (${m.workflow})\n`);
    process.stdout.write("\n  A clean clone fails on these. For a path that exists but is untracked, `git add` it:\n  committing is a fix to a broken committed state, not a new feature. A path that is not on\n  disk at all has to be written, or the workflow reference removed.\n");
  }
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  process.exit(main());
}
