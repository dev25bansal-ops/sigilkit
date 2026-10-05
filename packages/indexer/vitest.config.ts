import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scope discovery to the package's own tests. Without an `include`, vitest's default
    // glob sweeps the repo-root `outputs/` scratch area (gitignored, where review agents and
    // one-off probes land) and collection fails on files that are not part of this package.
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Entry points are exercised end-to-end (spawned process / stdio), not unit-covered.
      exclude: ["src/cli.ts", "src/index.ts"],
      thresholds: {
        // Floors sit just under measured coverage at introduction (2026-09-12:
        // indexer.ts 72.7% lines / 68.7% branches / 75.8% funcs).
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 65,
      },
    },
  },
});
