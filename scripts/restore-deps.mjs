#!/usr/bin/env node
/**
 * Lockfile-driven dependency restore WITHOUT npm's installer and WITHOUT links.
 *
 *   node scripts/restore-deps.mjs --plan          # what would be fetched, nothing written
 *   node scripts/restore-deps.mjs --apply         # fetch + extract into node_modules
 *   node scripts/restore-deps.mjs --verify        # penetrating probe, no network
 *   node scripts/restore-deps.mjs --apply --only=typescript
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 *
 * Two independent faults, neither of which fixes the other (both measured, 2026-09-27):
 *
 *   (i)  the dependency tree is nearly empty — `node_modules` held 2 entries;
 *   (ii) this host cannot create a traversable reparse point, so npm's workspace links
 *        are unusable no matter how many times they are recreated. See
 *        `scripts/check-reparse-points.mjs`, which is the authority on (ii).
 *
 * `npm ci` would fix (i) and cannot fix (ii); it also deletes `node_modules` wholesale first,
 * which is why it was ruled out while the tree was still the only copy of anything. This
 * script fixes (i) by a route that never creates a link: it reads the lockfile, downloads
 * each tarball with `npm pack`, and extracts it into place.
 *
 * ── WHY THE LOCKFILE IS THE ONLY INPUT ─────────────────────────────────────────────
 *
 * `package.json` carries ranges (`^24.13.3`); the lockfile carries the exact resolved
 * version of every package in the graph. Restoring from ranges would silently install
 * different code than the one the repository was verified against, which is the same
 * "one fact, one owner" rule the rest of the toolchain follows. Nothing here resolves a
 * range, and nothing here consults the registry for a version list.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────
 *
 * It does not create `node_modules/@sigilkit/*`. Those are workspace links, not registry
 * packages; `npm pack` cannot produce them and this host cannot link them. They are a
 * SEPARATE decision and are reported separately, because "dependencies restored" must never
 * be read as "the workspace is wired up".
 *
 * Exit codes follow `scripts/lib/exit.mjs`: 0 ok · 1 something was wrong · 2 could not run.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EXIT, messageOf } from "./lib/exit.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NM = join(ROOT, "node_modules");
const LOCK = join(ROOT, "package-lock.json");
const CACHE = join(tmpdir(), "sigilkit-tarballs");
const TOOL = "restore-deps";

/**
 * Packages the lockfile lists that must never be materialised by this script.
 *
 * `link: true` marks a workspace edge: npm records the target, not a tarball. Copying one
 * would be worse than leaving it absent, because the result would be a real directory that
 * silently goes stale instead of a visible gap.
 */
function isWorkspaceLink(entry) {
  return Boolean(entry?.link) || (typeof entry?.resolved === "string" && entry.resolved.startsWith("file:"));
}

/** @returns {{ok: true, packages: Array} | {ok: false, reason: string}} */
function readLock() {
  if (!existsSync(LOCK)) return { ok: false, reason: `no lockfile at ${LOCK}` };
  let lock;
  try {
    lock = JSON.parse(readFileSync(LOCK, "utf8"));
  } catch (err) {
    return { ok: false, reason: `lockfile is not valid JSON: ${messageOf(err)}` };
  }
  if (typeof lock.packages !== "object" || lock.packages === null) {
    return { ok: false, reason: "lockfile has no `packages` map (lockfileVersion 1?)" };
  }

  const packages = [];
  const skipped = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") continue;                       // the root project
    if (!key.startsWith("node_modules/")) continue;  // not part of the installed tree
    if (isWorkspaceLink(entry)) { skipped.push(key); continue; }
    if (!entry.resolved || !entry.resolved.startsWith("https://registry.npmjs.org/")) {
      skipped.push(key);
      continue;
    }
    // The path under node_modules/ is authoritative for placement; nesting is preserved.
    packages.push({
      key,
      name: key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length),
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      optional: Boolean(entry.optional),
      dev: Boolean(entry.dev),
    });
  }
  packages.sort((a, b) => a.key.localeCompare(b.key));
  return { ok: true, packages, skipped };
}

/** True when `dir` (or a `package.json` inside it) is actually readable — never Test-Path. */
function traversable(dir) {
  try {
    return existsSync(join(dir, "package.json"));
  } catch {
    return false;
  }
}

/** @returns {{present: number, missing: string[]}} */
function survey() {
  if (!existsSync(NM)) return { present: 0, missing: [] };
  const present = readdirSync(NM).length;
  return { present, missing: [] };
}

/**
 * `[command, prefixArgs]` for a real npm, resolved the way `verify.mjs:450-459` does it.
 *
 * Adopted verbatim rather than reinvented. `npm` on Windows is a `.cmd` shim, which
 * `spawnSync` cannot exec (ENOENT) and which `shell: true` mangles by concatenating argv
 * unescaped (DEP0190) — both were measured here, not assumed. Running npm's own JS entry
 * with the current `node` keeps a real argv array end to end: no shell, no re-parsing, no
 * reliance on PATHEXT.
 *
 * @returns {[string, string[]]}
 */
function resolveNpm() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((c) => typeof c === "string" && c !== "");
  for (const candidate of candidates) {
    if (existsSync(candidate)) return [process.execPath, [candidate]];
  }
  return [process.platform === "win32" ? "npm.cmd" : "npm", []];
}

const NPM = resolveNpm();

/**
 * Hashes a tarball and compares it with the lockfile's `integrity` field.
 *
 * A cached tarball used to be taken on sight: `fetch()` returned it as `cached: true` and
 * it went straight into `tar`, so the lockfile's integrity — the one field that says *which*
 * bytes the repository was verified against — was never read anywhere in this file. A
 * truncated download or a tarball another tool left in the cache became `node_modules`
 * content, and the run reported the package as restored.
 *
 * Absent or non-sha512 integrity is a failure, not a licence: this script restores from the
 * lockfile or not at all.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function verifyIntegrity(tarball, integrity, label) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    return { ok: false, reason: `${label}: lockfile carries no sha512 integrity (got ${JSON.stringify(integrity)}), so the artefact cannot be verified` };
  }
  const actual = createHash("sha512").update(readFileSync(tarball)).digest("base64");
  if (actual !== integrity.slice("sha512-".length)) {
    return { ok: false, reason: `${label}: tarball sha512 does not match the lockfile integrity` };
  }
  return { ok: true };
}

/**
 * Download one tarball into the cache. npm pack is the fetcher; it never touches the repo.
 *
 * The output filename is READ BACK from npm's own stdout rather than predicted. npm names a
 * tarball `<basename>-<version>.tgz`, where the basename is the part after the scope: a
 * scoped package `@babel/parser` becomes `parser-7.29.8.tgz`, and the scope is dropped, not
 * mangled. Predicting that is exactly the kind of assumption this round keeps being bitten
 * by, and a wrong guess here is a silent "tarball not produced" rather than an error.
 *
 * Every tarball that leaves this function — cached or freshly packed — has matched the
 * lockfile's integrity. A cached file that does not match is discarded and re-fetched.
 */
function fetch(name, version, integrity) {
  const flat = name.replace(/^@/, "").replace(/[\\/]/g, "-");
  const guess = join(CACHE, `${flat}-${version}.tgz`);
  const label = `${name}@${version}`;

  if (existsSync(guess)) {
    const cached = verifyIntegrity(guess, integrity, label);
    if (cached.ok) return { ok: true, cached: true, dest: guess };
    rmSync(guess, { force: true });
  }

  mkdirSync(CACHE, { recursive: true });
  const r = spawnSync(NPM[0], [...NPM[1], "pack", `${name}@${version}`, "--pack-destination", CACHE], {
    cwd: tmpdir(), encoding: "utf8", timeout: 180_000, windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    const last = r.stderr ? r.stderr.trim().split("\n").slice(-1)[0] : "";
    return { ok: false, reason: `${messageOf(r.error) || `npm pack exited ${r.status}`}${last ? ` — ${last}` : ""}` };
  }

  // Prefer what npm said it wrote; fall back to the predicted name.
  const reported = r.stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop();
  let produced = null;
  if (reported && reported.endsWith(".tgz")) {
    const named = join(CACHE, reported);
    if (existsSync(named)) produced = named;
  }
  if (produced === null && existsSync(guess)) produced = guess;
  if (produced === null) return { ok: false, reason: `tarball not produced (looked for ${flat}-${version}.tgz)` };

  const fresh = verifyIntegrity(produced, integrity, label);
  if (!fresh.ok) return { ok: false, reason: fresh.reason };
  return { ok: true, cached: false, dest: produced };
}

/** Extract `<tarball>` to `node_modules/<name>`, replacing whatever is there. */
function place(tarball, destDir) {
  rmSync(destDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  mkdirSync(destDir, { recursive: true });
  const staging = join(tmpdir(), `sigilkit-unpack-${process.pid}-${Math.abs(hashCode(destDir))}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const r = spawnSync("tar", ["-xzf", tarball, "-C", staging], { encoding: "utf8", windowsHide: true });
  if (r.error || r.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, reason: `tar failed: ${messageOf(r.error) || r.status}` };
  }
  const inner = join(staging, "package");
  if (!existsSync(inner)) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, reason: "tarball did not contain a `package/` root" };
  }
  // Move contents, not the wrapper: npm's layout is node_modules/<name>/<files>.
  // `cpSync(..., {recursive:true})` then `rmSync` is used rather than a `cmd move` per entry:
  // a per-entry `move` silently fails on a non-empty destination directory, which loses
  // whole subtrees (observed: yaml lost `dist/` and `browser/`, and still "succeeded").
  try {
    for (const entry of readdirSync(inner)) {
      cpSync(join(inner, entry), join(destDir, entry), { recursive: true, force: true });
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, reason: `could not place files: ${messageOf(err)}` };
  }
  rmSync(staging, { recursive: true, force: true });
  // The wrapper is gone; only `destDir`'s contents matter from here.
  return { ok: true };
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function main(argv) {
  const apply = argv.includes("--apply");
  const plan = argv.includes("--plan");
  const verify = argv.includes("--verify");
  const onlyArg = argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length) : null;
  const json = argv.includes("--json");
  if (argv.some((a) => a.startsWith("--") && !["--apply", "--plan", "--verify", "--json"].includes(a) && !a.startsWith("--only="))) {
    process.stderr.write(`${TOOL}: unknown argument\nusage: ${TOOL} [--plan|--apply|--verify] [--only=<name>] [--json]\n`);
    return EXIT.USAGE;
  }

  const lock = readLock();
  if (!lock.ok) {
    process.stderr.write(`${TOOL}: ${lock.reason}\n`);
    return EXIT.USAGE;
  }

  // Workspace links are reported, never restored. See the header.
  const workspaceLinks = lock.skipped.filter((k) => k.startsWith("node_modules/@sigilkit/"));
  const before = survey();

  if (plan) {
    const cached = lock.packages.filter((p) => existsSync(join(CACHE, `${p.name.replace(/^@/, "").replace(/[\\/]/g, "-")}-${p.version}.tgz`))).length;
    process.stdout.write(
      `restore-deps PLAN (no writes)\n` +
      `  registry packages in lockfile : ${lock.packages.length}\n` +
      `  already cached                : ${cached}\n` +
      `  workspace links (NOT restorable) : ${workspaceLinks.length}\n` +
      `  top-level entries in node_modules now : ${before.present}\n` +
      (only ? `  filtered to --only=${only} : ${lock.packages.filter((p) => p.name === only || p.name.endsWith(`/${only}`)).length}\n` : ""),
    );
    return EXIT.OK;
  }

  if (verify || !apply) {    const installed = lock.packages.filter((p) => traversable(join(NM, p.name)));
    const missing = lock.packages.filter((p) => !traversable(join(NM, p.name)));
    const report = {
      deps_resolved: missing.length === 0,
      topLevelEntries: before.present,
      installed: installed.length,
      missing: missing.length,
      missingSample: missing.slice(0, 12).map((p) => `${p.name}@${p.version}`),
      workspaceLinksPresent: workspaceLinks.map((k) => k.replace("node_modules/", "")),
      workspaceLinksTraversable: workspaceLinks.filter((k) => traversable(join(NM, k.replace("node_modules/", "")))),
      note: "Registry packages only. @sigilkit/* are workspace links and are NOT restored by this script.",
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `deps_resolved: ${report.deps_resolved}\n` +
        `  top-level entries now : ${report.topLevelEntries}\n` +
        `  lockfile packages     : ${lock.packages.length}\n` +
        `  installed & readable  : ${report.installed}\n` +
        `  still missing         : ${report.missing}\n` +
        (report.missingSample.length ? `    e.g. ${report.missingSample.join(", ")}\n` : "") +
        `  workspace links       : ${report.workspaceLinksPresent.length} expected, ` +
        `${report.workspaceLinksTraversable.length} traversable  (NOT restored by this tool)\n`,
      );
    }
    return report.deps_resolved ? EXIT.OK : EXIT.FAIL;
  }

  const targets = only ? lock.packages.filter((p) => p.name === only || p.name.endsWith(`/${only}`)) : lock.packages;
  if (targets.length === 0) {
    process.stderr.write(`${TOOL}: no lockfile package matches --only=${only}\n`);
    return EXIT.USAGE;
  }

  const results = [];
  for (const p of targets) {
    const f = fetch(p.name, p.version, p.integrity);
    if (!f.ok) { results.push({ ...p, ok: false, stage: "fetch", reason: f.reason }); continue; }
    const dest = join(NM, p.name);
    const placed = place(f.dest, dest);
    if (!placed.ok) { results.push({ ...p, ok: false, stage: "place", reason: placed.reason }); continue; }
    // Verify by CONTENT, through the installed path — the same rule the whole round settled on.
    const readable = traversable(dest);
    results.push({ ...p, ok: readable, stage: readable ? "ok" : "verify", reason: readable ? null : "no readable package.json after extraction" });
  }

  const failed = results.filter((r) => !r.ok);
  const after = survey();
  if (json) {
    process.stdout.write(`${JSON.stringify({
      deps_resolved: failed.length === 0,
      attempted: results.length,
      failed: failed.length,
      failures: failed.map((f) => ({ name: f.name, version: f.version, stage: f.stage, reason: f.reason })),
      topLevelEntries: after.present,
      workspaceLinksRestored: 0,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`restore-deps: ${results.length - failed.length}/${results.length} placed\n`);
    for (const f of failed) process.stdout.write(`  FAILED ${f.name}@${f.version}  [${f.stage}] ${f.reason}\n`);
    process.stdout.write(`top-level entries now: ${after.present}\n`);
    process.stdout.write(`workspace links restored: 0  (npm pack cannot make links; separate decision)\n`);
  }
  return failed.length === 0 ? EXIT.OK : EXIT.FAIL;
}

const invokedDirectly =
  process.argv[1] &&
  (process.platform === "win32"
    ? pathToFileURL(process.argv[1]).href.toLowerCase() === import.meta.url.toLowerCase()
    : pathToFileURL(process.argv[1]).href === import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
