import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Anvil-based suites share port 8545 — files must not run concurrently.
    fileParallelism: false,
    // The wallet-e2e harness is invoked via its own runner (run-all.ts / run.ts /
    // coinbase.ts) because it needs Playwright + a real browser. Skip it from
    // `npm test` to keep the default suite hermetic.
    exclude: ["node_modules/**", "test/wallet-e2e/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Thresholds ratchet up as gaps close. Floors sit just under measured
      // coverage at introduction (2026-09: 90% stmts / 77% branches / 96% funcs).
      thresholds: {
        lines: 88,
        functions: 90,
        branches: 74,
        statements: 88,
      },
    },
  },
});
