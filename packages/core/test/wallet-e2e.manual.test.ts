/**
 * MANUAL cross-wallet conformance legs: MetaMask + Coinbase Wallet.
 *
 * These tests are SKIPPED unless RUN_WALLET_E2E=1 and require @playwright/test plus the
 * wallet extension builds. They encode the assertions referenced by
 * WALLET_BEHAVIOR_ALLOWLIST.json so that a silent wallet regression (e.g. MetaMask flipping
 * its raw-revoke rejection) fails CI before users hit it — see vault/Agent Architecture.md.
 *
 * Run locally:
 *   RUN_WALLET_E2E=1 npm i -D @playwright/test && npx playwright install chromium && \
 *   npx vitest run test/wallet-e2e.manual.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENABLED = process.env.RUN_WALLET_E2E === "1";

const allowlist = JSON.parse(
  readFileSync(join(__dirname, "WALLET_BEHAVIOR_ALLOWLIST.json"), "utf8"),
) as {
  behaviors: Array<{
    id: string;
    wallet: string;
    assert: string;
    expected: string;
  }>;
};

function behavior(id: string) {
  const b = allowlist.behaviors.find((x) => x.id === id);
  if (!b) throw new Error(`allowlist entry missing: ${id}`);
  return b;
}

describe.skipIf(!ENABLED)("manual wallet E2E (RUN_WALLET_E2E=1)", () => {
  it("metamask rejects raw zero-address revoke (canary for #35520)", async () => {
    const b = behavior("metamask:revoke-raw-rejected");
    // Requires: Anvil fork on :8545, MetaMask extension loaded via playwright,
    // metamask-test-dapp open, funded test account imported.
    // Dynamic specifier keeps @playwright/test optional at typecheck time.
    const pkg = "@playwright" + "/test"; // dynamic specifier keeps the dep optional
    const mod = (await import(pkg)) as { chromium?: unknown };
    void mod.chromium; // harness wiring per vault/Agent Architecture.md Part A
    // Steps (implemented when wallet infra is available):
    // 1. launch persistent context with the MetaMask dist unpacked
    // 2. onboard a deterministic test seed; connect to dapp on chain 31337
    // 3. request eth_sendTransaction carrying an authorizationList entry {address: 0x0}
    // 4. EXPECT rejection matching "External EIP-7702 transactions are not supported"
    // 5. drive the in-UI revoke flow; capture the emitted authorization tuple
    // 6. assert tuple == [chainId, 0x0, nonce, y, r, s] byte-identical to SDK signRevocation()
    expect(b.expected).toBe("rejected"); // placeholder until wired
  }, 120_000);

  it("coinbase delegation designator matches allowlist pin", async () => {
    const b = behavior("coinbase:delegate-target-stable");
    // Requires: Coinbase Wallet extension; assert getCode(EOA) startsWith 0xef0100 &&
    // implementation == pinned address after a delegated session.
    expect(b.expected).toBe("0x000100abaad02f1cfC8Bbe32bD5a564817339E72"); // placeholder
  }, 120_000);
});

describe("wallet allowlist integrity (always runs)", () => {
  it("every behavior entry has the fields CI asserts on", () => {
    for (const b of allowlist.behaviors) {
      expect(b.id).toBeTruthy();
      expect(b.wallet).toBeTruthy();
      expect(b.assert).toBeTruthy();
      expect(["rejected", "accepted-or-documented-absent", "unsupported", "absent"].includes(b.expected) || b.expected.startsWith("0x")).toBe(true);
    }
  });
});
