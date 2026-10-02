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

describe("wallet allowlist: integrity + SDK-checkable expectations (always runs)", () => {
  it("every behavior entry has the fields CI asserts on", () => {
    for (const b of allowlist.behaviors) {
      expect(b.id).toBeTruthy();
      expect(b.wallet).toBeTruthy();
      expect(b.behavior).toBeTruthy();
      expect(b.assert).toBeTruthy();
      expect(
        ["rejected", "accepted-or-documented-absent", "unsupported", "absent"].includes(
          b.expected,
        ) || b.expected.startsWith("0x"),
      ).toBe(true);
      // Live-verified entries must point at the harness that verifies them.
      if (b.verifiedOn?.includes("live harness")) {
        expect(b.harness).toBeTruthy();
      }
    }
  });

  it("allowlist entries with harness paths reference existing files", () => {
    for (const b of allowlist.behaviors) {
      if (b.harness) {
        expect(
          existsSync(join(__dirname, b.harness.replace(/^packages\/core\/test\//, ""))),
        ).toBe(true);
      }
    }
  });

  // The block above only proves the allowlist is well-FORMED. These two pin something about
  // what it SAYS, and they are the only wallet assertions that can run without a wallet, a
  // browser or `RUN_WALLET_E2E=1` — which is why they live in the always-running describe.
  it('an entry claiming a wallet "rejected" something names the harness that proves it', () => {
    // `expected: "rejected"` is the strongest claim in this file: it asserts a wallet refuses
    // an action SigilKit relies on. Without a harness it is an assertion nobody can re-check,
    // and the live suites above are skipped by default — so require the evidence to exist.
    for (const b of allowlist.behaviors) {
      if (b.expected === "rejected") {
        expect(b.harness, `${b.id} claims "rejected" but names no harness`).toBeTruthy();
      }
    }
  });

  it("pinned delegate targets are real, delegatable addresses the SDK accepts", () => {
    // The `expected: "0x…"` form pins a concrete wallet contract address. Run each through
    // the SDK's own ERC-7702 scope guard so a truncated address, a bad EIP-55 checksum or a
    // zero delegate fails HERE rather than only inside a live browser harness.
    const pinned = allowlist.behaviors.filter((b) => b.expected.startsWith("0x"));
    expect(pinned.length, "no allowlist entry pins a concrete 0x… expectation").toBeGreaterThan(0);
    for (const b of pinned) {
      const implementation = b.expected as Address;
      const zero = `0x${"00".repeat(32)}` as Hex;
      expect(
        () =>
          assertDelegationScope(
            { contractAddress: implementation, chainId: 1n, nonce: 0n, yParity: 0, r: zero, s: zero },
            { chainId: 1n, implementation, revoke: false },
          ),
        b.id,
      ).not.toThrow();
    }
  });
});
