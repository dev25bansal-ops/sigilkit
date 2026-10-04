import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Explicit include: without it the v8 provider instruments only the modules a test
      // happens to import, which reported a reassuring 92.9% for this package while
      // agent-runner.ts and stub-brain.ts sat at 0%.
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        // Measured 2026-10-04 after adding agent-runner/stub-brain suites: 85.77 stmts /
        // 68.18 branches / 93.54 funcs / 85.64 lines. Floors sit just under, so any
        // regression fails rather than silently reducing the reported number.
        lines: 85,
        statements: 85,
        functions: 92,
        branches: 67,
      },
    },
  },
});