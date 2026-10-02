#!/usr/bin/env node
/**
 * Workspace package-artifact guard (read-only, local).
 *
 * A published workspace entry point can rot without any test noticing: someone renames
 * `dist/server.js`, points `exports` at a path that no longer builds, or lets `files[]` drift
 * so the referenced artifact would never ship. `npm pack` is the only way to see the real
 * tarball, but it is slow, network-adjacent and mutating. This script statically verifies the
 * parts that *are* checkable from the working tree:
 *
 *   1. every non-private workspace package's `main` / `types` / `exports` / `bin` target is a
 *      relative path (no absolute paths, no drive letters, no `..` escapes),
 *   2. every target resolves inside the package's `files[]` allow-list (in practice `dist`),
 *   3. every target is a regular file on disk (symlink targets are rejected).
 *
 * Supported grammar: main/types/bin paths; exports strings, nested mappings and null
 * exclusions (not fallback arrays or patterns); literal files[] paths with optional /**;
 * workspace arrays or { packages: [...] } using literal paths or one-level directory/*.
 * Unsupported forms fail explicitly. Missing files[] defaults to dist as a local policy;
 * an empty array stays empty. package.json is exempt from the allowlist. Other npm
 * automatic inclusions and ignore rules are not modeled by this conservative check.
 *
 * It also reports an *unexpected stale duplicated tree* — a `dist/src/` mirror whose entries
 * also exist at `dist/` — as a warning, never a hard failure: a legitimate build can emit a
 * nested layout, and treating that as fatal would be a false positive.
 *
 *   node scripts/check-package-artifacts.mjs
 *   node scripts/check-package-artifacts.mjs --json
 *
 * LIMITATION — artifact validation is NOT a clean-install smoke test. This reads the local
 * working tree only. It never runs `npm pack`, never installs, never touches the network, and
 * therefore cannot prove the tarball contents, the install graph, or that a consumer can
 * `import` the package. It catches broken entry-point wiring, not packaging regressions.
 *
 * Exit code: 1 when a target is missing / non-relative / outside `files[]`; 0 when only
 * warnings are present.
 */
import { readFileSync, readdirSync, existsSync, statSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories a shipped entry point may live in when a manifest declares no `files[]`. */
export const DEFAULT_ALLOWED_DIRS = ["dist"];

/** Fields whose string values are paths inside the published package. */
export const ENTRY_FIELDS = ["main", "types", "exports", "bin"];

/** Strips `./`, backslashes and empty/`.` segments into a root-relative posix path. */
export function normalizeTarget(target) {
  return String(target)
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/**
 * A package-relative target is safe when it is not absolute, carries no drive letter and
 * cannot escape the package root via `..`.
 */
export function isRelativeTarget(target) {
  if (typeof target !== "string" || target.trim() === "") return false;
  const value = target.trim().replace(/\\/g, "/");
  if (value.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.split("/").some((segment) => segment === "..")) return false;
  return true;
}

/** Narrow static grammar: literal paths, with an optional trailing / or /**. Not npm glob matching. */
export function allowedFilesFor(manifest) {
  if (manifest?.files === undefined) return [...DEFAULT_ALLOWED_DIRS];
  if (!Array.isArray(manifest.files)) throw new Error("unsupported files[]: expected an array");
  return manifest.files.map((entry) => {
    const literal = typeof entry === "string" ? entry.replace(/\/\*\*$/, "") : entry;
    if (!isRelativeTarget(literal) || /[*!?\[\]{}()]/.test(literal) || !normalizeTarget(literal)) {
      throw new Error(`unsupported files[] entry: ${JSON.stringify(entry)}; use literal paths or directory/**`);
    }
    return normalizeTarget(literal);
  });
}

/** True when `target` sits at or under one of the allowed `files[]` entries. */
export function isInAllowedFiles(target, allowed) {
  const normalized = normalizeTarget(target);
  if (normalized === "") return false;
  return allowed.some(
    (entry) => normalized === entry || normalized.startsWith(`${entry}/`),
  );
}

/** Walks an `exports` value, collecting every string leaf as a target. */
function walkExports(node, keyPath, out) {
  if (typeof node === "string") {
    out.push({ field: "exports", key: keyPath, target: node });
    return;
  }
  if (node === null || node === undefined) return;
  if (typeof node !== "object" || Array.isArray(node)) {
    throw new Error(`unsupported ${keyPath}: export fallback arrays and non-string leaves are not supported`);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.includes("*")) throw new Error(`unsupported export pattern: ${key}`);
    walkExports(value, `${keyPath}.${key}`, out);
  }
}

/** Collects every shipped entry-point target declared by a manifest. */
export function extractEntryTargets(manifest) {
  const out = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("unsupported manifest: expected an object");
  }
  for (const field of ["main", "types"]) {
    if (manifest[field] === undefined) continue;
    if (typeof manifest[field] !== "string") throw new Error(`unsupported ${field}: expected a string`);
    out.push({ field, key: field, target: manifest[field] });
  }
  if (typeof manifest.bin === "string") {
    out.push({ field: "bin", key: "bin", target: manifest.bin });
  } else if (manifest.bin !== undefined) {
    if (!manifest.bin || typeof manifest.bin !== "object" || Array.isArray(manifest.bin)) {
      throw new Error("unsupported bin: expected a string or mapping");
    }
    for (const [key, value] of Object.entries(manifest.bin)) {
      if (typeof value !== "string") throw new Error(`unsupported bin.${key}: expected a string`);
      out.push({ field: "bin", key, target: value });
    }
  }
  walkExports(manifest.exports, "exports", out);
  return out;
}

/**
 * Classifies a `dist/` listing for a stale `dist/src/` mirror. A mirror is stale only when it
 * duplicates top-level `dist/` entries (or is empty) — a nested-only layout is not a failure.
 */
export function detectStaleDistDuplication({ distEntries = [], nestedEntries = [] } = {}) {
  if (!distEntries.includes("src")) {
    return { stale: false, duplicated: 0, nested: 0, reason: "no dist/src directory" };
  }
  if (nestedEntries.length === 0) {
    return { stale: true, duplicated: 0, nested: 0, reason: "dist/src is empty" };
  }
  const topLevel = new Set(distEntries.filter((entry) => entry !== "src"));
  const duplicated = nestedEntries.filter((entry) => topLevel.has(entry));
  if (duplicated.length === 0) {
    return { stale: false, duplicated: 0, nested: nestedEntries.length, reason: "dist/src is nested-only" };
  }
  return {
    stale: true,
    duplicated: duplicated.length,
    nested: nestedEntries.length,
    reason: `${duplicated.length}/${nestedEntries.length} dist/src entries duplicate dist/`,
  };
}

/**
 * Validates one manifest against an injected `exists(rootRelativePath)` predicate.
 * The predicate must return true only for a regular file, not a directory or symlink.
 * Pure: no filesystem access, so fixture tests can drive it directly.
 */
export function checkPackageArtifacts({ name, manifest, exists }) {
  if (manifest?.private === true) {
    return { name, private: true, errors: [], warnings: [], checked: [], allowed: [] };
  }
  let allowed = [];
  const errors = [];
  const warnings = [];
  const checked = [];
  let targets;
  try {
    allowed = allowedFilesFor(manifest);
    targets = extractEntryTargets(manifest);
  } catch (error) {
    errors.push(`${name}: ${error.message}`);
    return { name, private: false, errors, warnings, checked, allowed };
  }

  for (const { field, key, target } of targets) {
    const record = { field, key, target, normalized: normalizeTarget(target) };
    if (!isRelativeTarget(target)) {
      record.status = "not-relative";
      errors.push(`${name}: ${field} "${key}" target is not relative: ${target}`);
    } else if (/[*!?\[\]{}()]/.test(target)) {
      record.status = "unsupported";
      errors.push(`${name}: unsupported target pattern: ${target}`);
    } else if (record.normalized !== "package.json" && !isInAllowedFiles(target, allowed)) {
      record.status = "outside-files";
      errors.push(`${name}: ${field} "${key}" target is outside files[] (${allowed.join(", ")}): ${target}`);
    } else if (!exists(record.normalized)) {
      record.status = "missing";
      errors.push(`${name}: ${field} "${key}" target is missing: ${target} (or is not a regular file)`);
    } else {
      record.status = "ok";
    }
    checked.push(record);
  }
  return { name, private: false, errors, warnings, checked, allowed };
}

/**
 * Checks every package. `exists`, `listDist` and `listNested` take a package directory
 * (root-relative posix) and are injected so the whole pass is testable without a repo.
 */
export function checkWorkspace({ packages, exists, listDist, listNested }) {
  const results = [];
  for (const pkg of packages) {
    const result = checkPackageArtifacts({
      name: pkg.name,
      manifest: pkg.manifest,
      exists: (rel) => exists(`${pkg.dir}/${rel}`),
    });
    if (!result.private && typeof listDist === "function") {
      const distEntries = listDist(pkg.dir) ?? [];
      const nestedEntries = distEntries.includes("src") ? (listNested(pkg.dir) ?? []) : [];
      const stale = detectStaleDistDuplication({ distEntries, nestedEntries });
      if (stale.stale) {
        result.warnings.push(
          `${pkg.name}: stale duplicated tree ${pkg.dir}/dist/src (${stale.reason}) — warning, not a failure`,
        );
      }
    }
    results.push(result);
  }
  return results;
}

/** Reads the root manifest's `workspaces` globs and returns `{ name, dir, manifest }`. */
export function discoverWorkspacePackages({ readFileSync: read, readdirSync: readdir, existsSync: exists }, root) {
  const rootManifest = JSON.parse(read(join(root, "package.json"), "utf8"));
  const declared = rootManifest.workspaces;
  const patterns = Array.isArray(declared) ? declared : declared?.packages;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error("unsupported workspaces: expected a non-empty array or packages array");
  }
  const packages = [];
  const seen = new Set();
  const add = (dir, required) => {
    const manifestPath = join(root, dir, "package.json");
    if (!exists(manifestPath)) {
      if (required) throw new Error(`workspace manifest missing: ${dir}`);
      return;
    }
    if (seen.has(dir)) return;
    const manifest = JSON.parse(read(manifestPath, "utf8"));
    packages.push({ name: manifest.name ?? dir, dir, manifest });
    seen.add(dir);
  };
  for (const pattern of patterns) {
    const wildcard = typeof pattern === "string" && pattern.endsWith("/*");
    const literal = wildcard ? pattern.slice(0, -2) : pattern;
    if (!isRelativeTarget(literal) || /[*!?\[\]{}()]/.test(literal) || !normalizeTarget(literal)) {
      throw new Error(`unsupported workspace pattern: ${JSON.stringify(pattern)}; use literal paths or directory/*`);
    }
    const base = normalizeTarget(literal);
    if (!wildcard) {
      add(base, true);
      continue;
    }
    const baseDir = join(root, base);
    if (!exists(baseDir)) throw new Error(`workspace directory missing: ${base}`);
    for (const entry of readdir(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory()) add(`${base}/${entry.name}`, false);
    }
  }
  if (packages.length === 0) throw new Error("no workspace packages discovered");
  return packages;
}

function safeList(dir) {
  try {
    return statSync(dir).isDirectory() ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // Only `--json` is a real flag here; anything else is a typo, and a typo that is silently
  // dropped is a check running with less coverage than its author believed. `--root` in
  // particular must not be swallowed: it reads as "check that other tree", and this gate
  // always inspects the repository it is installed in, so honouring the impression would mean
  // reporting on a checkout it never opened. Exit 2 = "could not run as asked".
  const strayArgs = process.argv.slice(2).filter((a) => a !== "--json");
  if (strayArgs.length > 0) {
    console.error(`check-package-artifacts: unrecognized argument(s): ${strayArgs.join(", ")}`);
    console.error(`it checks the packages in the repository this script lives in (${root}).`);
    process.exit(2);
  }
  let results;
  try {
    const packages = discoverWorkspacePackages({ readFileSync, readdirSync, existsSync }, root);
    results = checkWorkspace({
      packages,
      exists: (rel) => {
        try {
          return lstatSync(join(root, rel)).isFile();
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
          throw error;
        }
      },
      listDist: (dir) => safeList(join(root, dir, "dist")),
      listNested: (dir) => safeList(join(root, dir, "dist", "src")),
    });
  } catch (error) {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ root, results: [], errors: [error.message], warnings: [] }, null, 2));
    } else {
      console.error(`package artifacts failed: ${error.message}`);
    }
    process.exit(1);
  }

  const errors = results.flatMap((result) => result.errors);
  const warnings = results.flatMap((result) => result.warnings);
  const checked = results.filter((result) => !result.private);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ root, results, errors, warnings }, null, 2));
    process.exit(errors.length > 0 ? 1 : 0);
  }

  for (const result of results) {
    if (result.private) {
      console.log(`skip  ${result.name} (private)`);
      continue;
    }
    const targets = result.checked.length;
    const ok = result.checked.filter((entry) => entry.status === "ok").length;
    console.log(`check ${result.name} — ${ok}/${targets} entry target(s) OK`);
  }
  for (const warning of warnings) console.warn(`warn  ${warning}`);
  for (const error of errors) console.error(`fail  ${error}`);

  if (errors.length > 0) {
    console.error(`\npackage artifacts: ${errors.length} problem(s) in ${checked.length} public package(s).`);
    console.error("  (static working-tree checks only — this is NOT a clean-install smoke test)");
    process.exit(1);
  }
  const targetCount = checked.reduce((sum, result) => sum + result.checked.length, 0);
  console.log(
    `\npackage artifacts OK — ${checked.length} public package(s), ${targetCount} entry target(s), ` +
      `${warnings.length} warning(s).`,
  );
  console.log("  (static working-tree checks only — this is NOT a clean-install smoke test)");
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
