/**
 * Cross-wallet conformance legs: MetaMask + Coinbase Smart Wallet.
 *
 * SKIPPED unless RUN_WALLET_E2E=1. When enabled, this file no longer asserts
 * allowlist JSON strings — it runs the REAL Playwright harnesses
 * (test/wallet-e2e/run.ts + coinbase.ts via run-all.ts) and fails if either
 * suite fails, so a silent wallet regression (e.g. MetaMask flipping its
 * raw-revoke rejection) surfaces before users hit it. See
 * vault/Agent Architecture.md and test/wallet-e2e/README.md.
 *
 * Run locally (requires the MetaMask 13.49.0 extension unpacked at
 * test/wallet-e2e/metamask/ — see wallet-e2e/README.md):
 *   RUN_WALLET_E2E=1 npx vitest run test/wallet-e2e.manual.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { assertDelegationScope } from "../src/eip7702.js";

const ENABLED = process.env.RUN_WALLET_E2E === "1";

const allowlist = JSON.parse(
  readFileSync(join(__dirname, "WALLET_BEHAVIOR_ALLOWLIST.json"), "utf8"),
) as {
  behaviors: Array<{
    id: string;
    wallet: string;
    behavior: string;
    assert: string;
    expected: string;
    verifiedOn?: string;
    harness?: string;
  }>;
};

describe.skipIf(!ENABLED)("manual wallet E2E (RUN_WALLET_E2E=1)", () => {
  it(
    "live harnesses pass (MetaMask + Coinbase Smart Wallet via run-all.ts)",
    () => {
      const runAll = join(__dirname, "wallet-e2e", "run-all.ts");
      const res = spawnSync(process.execPath, ["--import", "tsx", runAll], {
        stdio: "inherit",
        env: { ...process.env },
      });
      if (res.status !== 0) {
        throw new Error(`wallet-e2e run-all.ts failed (exit ${res.status})`);
      }
    },
    600_000,
  );
});
