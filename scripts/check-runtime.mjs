#!/usr/bin/env node
/**
 * Runtime resolution diagnostic (offline, read-only).
 *
 * Records the Node runtime actually executing this script, the declared engine floor,
 * and the vitest entry/version each workspace resolves, so a reviewer can tell whether
 * an environment difference — not application code — explains a failing run.
 *
 *   node scripts/check-runtime.mjs
 *   node scripts/check-runtime.mjs --json
 *
 * It never installs, writes to the repository, or reads environment secrets: the report
 * contains only execPath/version strings and resolved module paths.
 *
 * Exit 1 when the runtime is below the declared floor or when workspaces disagree with
 * the root vitest version. Exit 2 for an unrecognized argument. Exit 0 otherwise,
 * explicitly reporting that no diagnosis of any historic failure can be made from these
 * facts alone.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FLOOR = 24;

/** The only flag this diagnostic takes; anything else is a caller mistake, not a request. */
const USAGE = "usage: check-runtime [--json]";
const KNOWN_FLAGS = new Set(["--json"]);

/** Parses ">=24", "^24.1", "~24.1.2", "24" and bare numbers into [major, minor, patch]. */
export function parseVersion(input) {
  const match = String(input ?? "").trim().match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** Extracts the numeric floor from an `engines.node` range; falls back to DEFAULT_FLOOR. */
export function parseNodeFloor(engines) {
  const raw = engines && typeof engines === "object" ? engines.node : engines;
  const parsed = parseVersion(raw);
  if (!parsed) return { raw: String(raw ?? ""), floor: [DEFAULT_FLOOR, 0, 0], specified: false };
  return { raw: String(raw), floor: parsed, specified: true };
}

/** True when `version` is at or above `floor` ([major, minor, patch]). */
export function meetsFloor(version, floor) {
  const current = parseVersion(version);
  const target = Array.isArray(floor) ? floor : parseVersion(floor);
  if (!current || !target) return false;
  for (let i = 0; i < 3; i += 1) {
    if (current[i] > target[i]) return true;
    if (current[i] < target[i]) return false;
  }
  return true;
}

/** Compares workspace vitest resolutions against the root one. Pure. */
export function evaluateVitest(rootEntry, workspaceEntries) {
  // A root that failed to resolve is still an object (`{version: null, entry: null}`), so
  // its truthiness says nothing about whether vitest was found. Resolvability has to be
  // read off the version, or an unresolved root compares "equal" to itself and every
  // workspace looks fine — a check that cannot fail.
  const rootResolves = Boolean(rootEntry?.version);
  const workspaces = (workspaceEntries ?? []).map((entry) => ({
    name: entry.name,
    version: entry.version ?? null,
    entry: entry.entry ?? null,
    matchesRoot: rootResolves && Boolean(entry.version) && entry.version === rootEntry.version,
    resolvable: Boolean(entry.version),
  }));
  const mismatched = workspaces.filter((entry) => !entry.matchesRoot).map((entry) => entry.name);
  const unresolved = workspaces.filter((entry) => !entry.resolvable).map((entry) => entry.name);
  return {
    root: rootEntry ?? null,
    workspaces,
    consistent: rootResolves && mismatched.length === 0 && unresolved.length === 0,
    mismatched,
    unresolved,
  };
}

/** Turns collected facts into the final verdict. Pure. */
export function evaluateReport({ runtime, vitest }) {
  const reasons = [];
  if (!runtime.compatible) {
    reasons.push(`node ${runtime.version} is below the required floor ${runtime.required}`);
  }
  // An unresolved root is a truthy `{version: null}` object, so "did we find vitest" has
  // to be read off the version. Testing the object's truthiness instead let an unresolved
  // root fall through both branches below and produce no reason at all — the check then
  // reported "no diagnosis" and exited 0 while having inspected nothing.
  if (!vitest.root?.version) {
    reasons.push("vitest is not resolvable from the repository root");
  } else if (!vitest.consistent) {
    if (vitest.mismatched.length > 0) {
      reasons.push(`workspace vitest version differs from root: ${vitest.mismatched.join(", ")}`);
    }
    if (vitest.unresolved.length > 0) {
      reasons.push(`vitest not resolvable in: ${vitest.unresolved.join(", ")}`);
    }
  }
  if (reasons.length > 0) {
    return { ok: false, exitCode: 1, reasons, conclusion: reasons.join("; ") };
  }
  return {
    ok: true,
    exitCode: 0,
    reasons: [],
    conclusion:
      "no diagnosis: the executing runtime meets the declared floor and every workspace resolves " +
      "the same vitest version as the root, so this check cannot attribute any historic failure " +
      "to runtime or vitest resolution",
  };
}

/** Replaces the user home prefix so absolute paths stay readable but non-identifying. */
export function sanitizePath(value) {
  if (typeof value !== "string") return value;
  const home = homedir();
  return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Expands the root `workspaces` globs ("packages/*") into concrete directories. */
function workspaceDirs(root) {
  const manifest = readJson(join(root, "package.json")) ?? {};
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : [];
  const dirs = [];
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      const dir = join(root, pattern);
      if (existsSync(dir)) dirs.push({ name: pattern, dir });
      continue;
    }
    const base = pattern.slice(0, pattern.indexOf("*")).replace(/[/\\]$/, "");
    const baseDir = join(root, base);
    if (!existsSync(baseDir)) continue;
    for (const name of readdirSync(baseDir).sort()) {
      const dir = join(baseDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = readJson(manifestPath) ?? {};
      dirs.push({ name: manifest.name ?? `${base}/${name}`, dir });
    }
  }
  return dirs;
}

/** Resolves vitest's package manifest from a directory without executing anything. */
function resolveVitest(dir) {
  try {
    const require = createRequire(join(dir, "noop.js"));
    const manifestPath = require.resolve("vitest/package.json");
    const manifest = readJson(manifestPath) ?? {};
    return { version: manifest.version ?? null, entry: sanitizePath(manifestPath) };
  } catch {
    return { version: null, entry: null };
  }
}

/** Locates npm beside the running interpreter; never spawns a shell. */
function detectNpm(execPath) {
  const dir = dirname(execPath);
  for (const candidate of ["npm.cmd", "npm", "npm.exe", "npm.ps1"]) {
    const full = join(dir, candidate);
    if (existsSync(full)) return { path: sanitizePath(full), source: "adjacent-to-execPath" };
  }
  return { path: null, source: "not-found" };
}

/** Collects every fact the report needs. Read-only; touches no environment variables. */
export function collect({ root = ROOT } = {}) {
  const manifest = readJson(join(root, "package.json")) ?? {};
  const declared = parseNodeFloor(manifest.engines);
  const version = process.version.replace(/^v/, "");
  const runtime = {
    execPath: sanitizePath(process.execPath),
    version: process.version,
    required: declared.raw,
    floor: declared.floor.join("."),
    compatible: meetsFloor(version, declared.floor),
  };
  const rootVitest = resolveVitest(root);
  const workspaces = workspaceDirs(root).map(({ name, dir }) => ({ name, ...resolveVitest(dir) }));
  const vitest = evaluateVitest(rootVitest, workspaces);
  return {
    tool: "check-runtime",
    generatedAt: new Date().toISOString(),
    root: sanitizePath(root),
    platform: process.platform,
    arch: process.arch,
    runtime,
    npm: detectNpm(process.execPath),
    vitest,
  };
}

function render(report, verdict) {
  const lines = [
    `check-runtime: node ${report.runtime.version} (${report.runtime.execPath})`,
    `  required: ${report.runtime.required || `>=${report.runtime.floor}`} — ${
      report.runtime.compatible ? "compatible" : "INCOMPATIBLE"
    }`,
    `  npm: ${report.npm.path ?? "not found"} (${report.npm.source})`,
    `  vitest root: ${report.vitest.root?.version ?? "unresolved"}${
      report.vitest.root?.entry ? ` @ ${report.vitest.root.entry}` : ""
    }`,
  ];
  for (const workspace of report.vitest.workspaces) {
    lines.push(
      `  vitest ${workspace.name}: ${workspace.version ?? "unresolved"} — ${
        workspace.matchesRoot ? "matches root" : "MISMATCH"
      }`,
    );
  }
  lines.push(verdict.ok ? `OK: ${verdict.conclusion}` : `FAIL: ${verdict.conclusion}`);
  return lines.join("\n");
}

function main(argv) {
  // Every other argument used to be ignored outright, so `--jsonn` produced the human report
  // while the caller — who asked for JSON — parsed prose as a document. Rejected, not
  // ignored: a diagnostic that silently drops what it was asked for is worse than one that
  // says it cannot do it. Exit 2, matching the rest of scripts/: 2 is a usage error, 1 is a
  // runtime that does not meet the declared floor.
  const unknown = argv.filter((arg) => !KNOWN_FLAGS.has(arg));
  if (unknown.length > 0) {
    process.stderr.write(`check-runtime: unrecognized argument(s): ${unknown.join(", ")}\n${USAGE}\n`);
    return 2;
  }
  const asJson = argv.includes("--json");
  const report = collect();
  const verdict = evaluateReport(report);
  const payload = { ...report, verdict };
  process.stdout.write(asJson ? `${JSON.stringify(payload, null, 2)}\n` : `${render(report, verdict)}\n`);
  return verdict.exitCode;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
