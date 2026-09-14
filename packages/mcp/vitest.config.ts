import { defineConfig } from "vitest/config";

export default defineConfig({
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
