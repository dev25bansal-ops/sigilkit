import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The e2e smoke test spawns its own Anvil on port 8545, so files must not overlap.
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // `cli.ts` / `fleet.ts` are process entry points driven by argv + a live chain; the
      // smoke e2e covers their path end-to-end, so they are not unit-coverage targets.
      exclude: ["src/cli.ts", "src/fleet.ts", "src/index.ts"],
      thresholds: {
        // Floors sit just under measured coverage at introduction (2026-09-12:
        // agent.ts 96.9% lines, devkeys.ts 100% lines).
        lines: 90,
        statements: 90,
        functions: 95,
        branches: 60,
      },
    },
  },
});
