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
        // Measured 2026-10-04 after the window-state and LocalModelBrain-liveness suites:
        // 88.14 stmts / 72.0 branches / 93.75 funcs / 88.37 lines. Floors sit just under, so
        // any regression fails rather than silently reducing the reported number.
        lines: 88,
        statements: 87,
        functions: 93,
        branches: 71,
      },
    },
  },
});