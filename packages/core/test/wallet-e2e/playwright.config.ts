import { defineConfig } from "@playwright/test";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "metamask");
const USER_DATA = resolve(__dirname, ".playwright-profile");
if (!existsSync(EXT_DIR) || !existsSync(`${EXT_DIR}/manifest.json`)) {
  throw new Error(`MetaMask extension missing at ${EXT_DIR}`);
}
if (!existsSync(USER_DATA)) mkdirSync(USER_DATA);

export default defineConfig({
  testDir: __dirname,
  testMatch: "**/*.test.ts",
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
