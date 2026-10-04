#!/usr/bin/env node
/**
 * Builds every workspace in DEPENDENCY order, not alphabetical order.
 *
 * WHY THIS EXISTS. `npm run build --workspaces` walks workspaces alphabetically:
 * agent, core, demo-agent, indexer, mcp. `@sigilkit/agent` depends on `@sigilkit/core`, so it
 * is compiled before core's `dist/` exists and every one of its imports fails with TS2307
 * ("Cannot find module '@sigilkit/core'"). That is not hypothetical: `npm run build
 * --workspaces` from a clean tree fails, and it is what `ci.yml:218` runs.
 *
 * The same latent hazard applies to indexer and mcp (both depend on core) and to
 * demo-agent (depends on core and indexer) — they only survive because their names happen to
 * sort after `core`. Renaming a package, or npm changing its traversal order, would break the
 * build for no visible reason.
 *
 * The fix is to stop relying on name ordering. This script reads each workspace's
 * `dependencies` / `devDependencies`, builds the intra-repo subgraph from that, and emits a
 * `npm run build --workspace=<name>` sequence in topological order. It fails loudly on a
 * dependency cycle rather than emitting a sequence that happens to work.
 *
 * Usage:  node scripts/build-workspaces.mjs [--dry-run] [--if-present]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const IF_PRESENT = args.has("--if-present");

/** Every workspace package, keyed by its `name` field. */
function discoverWorkspaces() {
  const rootManifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages ?? [];
  const byName = new Map();
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) continue;
    const parent = join(ROOT, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(parent, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      byName.set(manifest.name, { name: manifest.name, dir: join(parent, entry.name) });
    }
  }
  return byName;
}

/** The intra-repo dependencies of `pkg`, from both dependency fields. */
function localDeps(pkg, byName) {
  const manifest = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8"));
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  return Object.keys(declared)
    .filter((name) => name.startsWith("@sigilkit/") && byName.has(name))
    .sort();
}

/** Kahn's algorithm. Throws on a cycle rather than emitting an order that lies. */
function topoSort(byName) {
  const deps = new Map();
  for (const [name, pkg] of byName) deps.set(name, localDeps(pkg, byName));

  const ordered = [];
  const done = new Set();
  const remaining = new Set(byName.keys());

  while (remaining.size > 0) {
    // Sorted so the output is stable across runs — a build order that reshuffles between
    // runs makes a caching layer unreliable and diffs harder to read.
    const ready = [...remaining]
      .filter((name) => deps.get(name).every((d) => done.has(d)))
      .sort();
    if (ready.length === 0) {
      const stuck = [...remaining].sort();
      throw new Error(
        `dependency cycle among workspaces: ${stuck.join(", ")}. ` +
          "Refusing to emit a build order that would only appear to work.",
      );
    }
    for (const name of ready) {
      ordered.push(name);
      done.add(name);
      remaining.delete(name);
    }
  }
  return ordered;
}

const byName = discoverWorkspaces();
if (byName.size === 0) throw new Error("no workspace packages discovered under packages/*");

const order = topoSort(byName);

if (DRY_RUN) {
  for (const name of order) console.log(name);
  process.exit(0);
}

for (const name of order) {
  // The flags must be SEPARATE argv entries. Building the string
  // `--workspace=<name> --if-present` and passing it as one element makes npm look for a
  // workspace literally named "@sigilkit/core --if-present" and fail with
  // "No workspaces found" — which is exactly what CI reported.
  const argv = ["run", "build", `--workspace=${name}`];
  // `--if-present` mirrors the historical `npm run build --workspaces --if-present`: a
  // workspace with no build script is skipped rather than failing the whole build.
  if (IF_PRESENT) argv.push("--if-present");
  console.log(`\n> build ${name}`);
  // `shell: true` only on Windows, where `npm` is a `.cmd` shim Node cannot spawn directly
  // (Node >= 20 rejects `.cmd` without a shell, and `npm.cmd` as a bare path gives EINVAL).
  // The argv above is fixed and script-owned — no caller input reaches it — so the
  // DEP0190 "args are not escaped" caveat does not apply. It must NOT be enabled on POSIX:
  // there the argv passes through directly, which is what keeps the flags separate.
  execFileSync("npm", argv, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}
