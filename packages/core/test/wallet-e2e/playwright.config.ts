/**
 * NOT USED BY THE HARNESS - kept only as the settings record for the wallet-conformance run.
 *
 * The review found this file declared a `testMatch` glob against a `testDir` containing no
 * matching spec files, so a reader would reasonably conclude that Playwright's test runner
 * drives the conformance suite and that it matches nothing. It does not drive anything:
 * nothing imports this config.
 *
 * The harness (`run-all.ts` -> `run.ts` -> `real-metamask.ts` / `coinbase.ts`) drives
 * Playwright directly via `chromium.launchPersistentContext`, and CI invokes it with
 * `npx tsx test/wallet-e2e/run-all.ts`. The test-dir/test-match pair was never consulted.
 *
 * The settings that DO matter are reproduced in `run.ts` at the persistent-context launch
 * (extension mount flags, `--no-sandbox`) and in the extension-presence guard below, which
 * `run.ts` mirrors. Both copies are live; this one is not.
 *
 * NOTE ON WRITING THIS FILE: do not quote the glob literally in a comment. The previous
 * header did, and the asterisks in that pattern contain a forward slash in the third
 * position - a sequence that CLOSES a block comment. TypeScript then parsed the remainder
 * as code and reported 97 errors that read as a syntax fault somewhere unrelated. Spell the
 * pattern without the literal run of asterisks, or the comment ends early and takes the
 * file with it.
 *
 * If the harness is ever migrated to `@playwright/test`'s runner, this file becomes the
 * config and the test-match pattern has to be corrected to the real spec filenames at the
 * same time - as written it would silently select nothing, which is precisely the failure
 * this header exists to prevent.
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
  // Placeholder only - see the header. `run.ts` owns the launch options.
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