import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Anvil-based suites share port 8545 — files must not run concurrently.
    fileParallelism: false,
  },
});
