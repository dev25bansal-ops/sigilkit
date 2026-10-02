import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Anvil-based suites share port 8545 — files must not run concurrently.
    fileParallelism: false,
    // PERF-2: reuse one worker across all files instead of spawning one per file.
    // Measured 13 files × ~198ms = ~2.4s of pure spawn/environment overhead per run
    // (~8.5% of the suite).
    //
    // ACCURATE SCOPE — this is a deliberate, measured trade-off, not a safety proof.
    // `isolate: false` means every file shares ONE module registry, so ANY module-level
    // mutable state in one test file is visible to every later file in the same run. The
    // suite's convention is that it has none (the test-only `resetDotEnvForTests` hook is
    // called from an `afterEach`/`beforeEach`, not left armed), but that convention is
    // enforced by review, not by the runner — a file that leaves a global timer, an
    // `vi.mock` or a module cache dirty will silently affect the files after it.
    // `isolate: true` is the strictly-safe setting and costs the measured overhead above;
    // flip it if a cross-file leak is ever observed rather than hunting the leaking file.
    isolate: false,
    // Threads start faster than forked processes for this pure-JS suite (measured
    // 24.9s vs 25.4s end-to-end); the Anvil child processes are spawned by the tests
    // themselves, so the pool choice does not affect them.
    pool: "threads",
    // The wallet-e2e harness is invoked via its own runner (run-all.ts / run.ts /
    // coinbase.ts) because it needs Playwright + a real browser. Skip it from
    // `npm test` to keep the default suite hermetic. `test/wallet-e2e/**` alone does not
    // cover `test/wallet-e2e.manual.test.ts` (a top-level FILE named wallet-e2e…, not a
    // path under the directory), so the vitest wrapper around the manual harness — which
    // under RUN_WALLET_E2E=1 would launch the real MetaMask/Coinbase browsers — is excluded
    // by name too (verified with `npx vitest list`). NOTE: in this Vitest major, `exclude`
    // also wins over an explicit CLI file path, so the wrapper is no longer the way to run
    // the manual gates — invoke the underlying runner directly instead:
    // `cd packages/core/test/wallet-e2e && npx tsx run-all.ts` (the same command the
    // weekly wallet-conformance CI job runs).
    exclude: ["node_modules/**", "test/wallet-e2e/**", "test/wallet-e2e.manual.test.ts"],
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
