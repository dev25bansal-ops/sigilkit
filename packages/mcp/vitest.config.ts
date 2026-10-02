import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Workspace dependency resolution, with a local fallback.
 *
 * `@sigilkit/mcp` depends on `@sigilkit/core` and `@sigilkit/indexer`. npm normally exposes
 * them through `node_modules/@sigilkit/*` junctions; on a healthy checkout those are used
 * and this map is not applied at all. Where a junction is present but *unreadable* (a
 * stale reparse point left by an interrupted install), the dependency's BUILT `dist/`
 * entry points are mapped instead — the same files the junction serves through each
 * package's `exports` map — so the suite runs the shipped code, not the sibling sources.
 *
 * That makes the fallback require a prior build of the workspace: CI (`.github/workflows/
 * ci.yml`, ts-sdk job) runs `npm run build --workspaces` before any test, so dist/ exists
 * there, and locally the dependencies must be built once (`npm run build` at the repo
 * root), which is already documented in the package READMEs. Pointing the fallback at
 * `src/` instead would silently hand the suite a DIFFERENT program than the one the
 * junctions (and every published consumer) load.
 *
 * `node_modules` is not source, and this file is the only thing in the package that reads
 * it, so nothing here is shared with another package.
 */
const WORKSPACE_ENTRYPOINTS: Record<string, string> = {
  "@sigilkit/core/logger": join(HERE, "..", "core", "dist", "logger.js"),
  "@sigilkit/core/config": join(HERE, "..", "core", "dist", "config.js"),
  "@sigilkit/core/cli": join(HERE, "..", "core", "dist", "cli.js"),
  "@sigilkit/core": join(HERE, "..", "core", "dist", "index.js"),
  "@sigilkit/indexer": join(HERE, "..", "indexer", "dist", "index.js"),
};

/** True when `node_modules/@sigilkit/<name>` resolves to a readable package. */
function junctionUsable(name: string): boolean {
  try {
    return statSync(join(HERE, "..", "..", "node_modules", "@sigilkit", name, "package.json")).isFile();
  } catch {
    return false;
  }
}

/**
 * Which workspace package each aliased specifier belongs to.
 *
 * Stated explicitly rather than parsed out of the specifier. The obvious one-liner —
 * `spec.replace("@sigilkit/", "")` — silently yields `mcp/logger` for a specifier like
 * `@sigilkit/mcp/logger`, and a path built from that points at a directory that does not
 * exist, so the alias resolves to nothing and the failure resurfaces as the very
 * `ERR_MODULE_NOT_FOUND` this config exists to work around. A subpath is not a package
 * name, so the package has to be named rather than guessed.
 */
const SPEC_OWNER: Record<string, string> = {
  "@sigilkit/core": "core",
  "@sigilkit/core/logger": "core",
  "@sigilkit/core/config": "core",
  "@sigilkit/core/cli": "core",
  "@sigilkit/indexer": "indexer",
};

/** Aliases for the workspace deps whose junction is unusable; empty on a healthy checkout. */
const fallbackAlias: Record<string, string> = Object.fromEntries(
  Object.entries(WORKSPACE_ENTRYPOINTS)
    .filter(([spec]) => {
      const owner = SPEC_OWNER[spec];
      // An unlisted specifier keeps its alias unconditionally: a wrong guess about which
      // package owns it would silently drop a dependency, which is worse than aliasing a
      // healthy one.
      return owner === undefined || !junctionUsable(owner);
    })
    .map(([spec, file]) => [spec, file]),
);

export default defineConfig({
  resolve: { alias: fallbackAlias },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The stdio entry point is covered end-to-end by the spawned-process test.
      exclude: ["src/cli.ts"],
      thresholds: {
        // Floors sit just under measured coverage at introduction (2026-09-12:
        // server.ts 73.3% lines / 53.8% branches / 73.3% funcs).
        lines: 70,
        statements: 65,
        functions: 70,
        branches: 50,
      },
    },
  },
});
