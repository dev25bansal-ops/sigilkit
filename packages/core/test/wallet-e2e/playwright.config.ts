/**
 * NOT USED BY THE HARNESS — kept only as the settings record for the wallet-conformance run.
 *
 * The review found this file declared `testMatch: "**/*.test.ts"` against a `testDir`
 * containing no `.test.ts` files, so a reader would reasonably conclude that Playwright's
 * test runner drives the conformance suite and that it matches nothing. It does not drive
 * anything: nothing imports this config.
 *
 * The harness (`run-all.ts` -> `run.ts` -> `real-metamask.ts` / `coinbase.ts`) drives
 * Playwright directly via `chromium.launchPersistentContext`, and CI invokes it with
 * `npx tsx test/wallet-e2e/run-all.ts`. The `testMatch`/`testDir` pair was never consulted.
 *
 * The settings that DO matter are reproduced in `run.ts:231-240` (persistent context, the
 * extension mount flags, `--no-sandbox`) and the extension-presence guard below, which
 * `run.ts:39-41` mirrors. Both copies are live; this one is not.
 *
 * If the harness is ever migrated to `@playwright/test`'s runner, this file becomes the
 * config and `testMatch` has to be corrected to the real spec filenames at the same time —
 * `**/*.test.ts` would silently select nothing, which is precisely the failure this comment
 * exists to prevent.
 */
import { defineConfig } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "metamask");
if (!existsSync(EXT_DIR) || !existsSync(`${EXT_DIR}/manifest.json`)) {
  throw new Error(`MetaMask extension missing at ${EXT_DIR}`);
}

export default defineConfig({
  // Placeholder only — see the header. `run.ts` owns the launch options.
  testDir: __dirname,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8545",
    launchOptions: {
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        "--no-sandbox",
      ],
    },
  },
});