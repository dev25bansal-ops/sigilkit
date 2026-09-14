import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Anvil-based suites share port 8545 — files must not run concurrently.
    fileParallelism: false,
    // PERF-2: reuse one worker across all files instead of spawning one per file.
    // Measured 13 files × ~198ms = ~2.4s of pure spawn/environment overhead per run
    // (~8.5% of the suite). Safe here because the suite has no cross-file module state:
    // the only shared resource is the Anvil node, which is already serialized by
    // fileParallelism: false.
    isolate: false,
    // Threads start faster than forked processes for this pure-JS suite (measured
    // 24.9s vs 25.4s end-to-end); the Anvil child processes are spawned by the tests
    // themselves, so the pool choice does not affect them.
    pool: "threads",
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
