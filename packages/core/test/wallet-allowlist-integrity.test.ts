/**
 * Wallet-behaviour allowlist integrity — runs on EVERY `npm test` and in CI.
 *
 * WHY THIS IS A SEPARATE FILE. These four guards used to live at the bottom of
 * `wallet-e2e.manual.test.ts`, whose whole path is in `packages/core/vitest.config.ts`'s
 * `exclude` (it drives real browsers, so it must not run by default). An `exclude` on a
 * FILE suppresses everything in it, so the describe block titled "always runs" never ran —
 * in any local run or any CI run. Proven by collection rather than by reading:
 * `npx vitest list | grep <any of the four test names>` returned 0 matches.
 *
 * That left the strongest claim in the allowlist unguarded: an entry with
 * `expected: "rejected"` asserts that a real wallet refuses something SigilKit relies on.
 * With no harness name to back it, that assertion is one nobody can re-check — and the live
 * suites that would check it are skipped by default. So the guards move here, where nothing
 * excludes them.
 *
 * None of this needs a wallet, a browser, or `RUN_WALLET_E2E=1`: it is JSON shape plus the
 * SDK's own ERC-7702 scope guard. The manual browser harness stays where it was.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { assertDelegationScope } from "../src/eip7702.js";

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

describe("wallet allowlist: integrity + SDK-checkable expectations (always runs)", () => {
  it("every behavior entry has the fields CI asserts on", () => {
    for (const b of allowlist.behaviors) {
      expect(b.id, "allowlist entry needs an id").toBeTruthy();
      expect(b.wallet, `${b.id} needs a wallet`).toBeTruthy();
      expect(b.behavior, `${b.id} needs a behaviour`).toBeTruthy();
      expect(b.assert, `${b.id} needs an assertion`).toBeTruthy();
      expect(
        ["rejected", "accepted-or-documented-absent", "unsupported", "absent"].includes(
          b.expected,
        ) || b.expected.startsWith("0x"),
        `${b.id} has an unrecognised "expected": ${b.expected}`,
      ).toBe(true);
      // Live-verified entries must point at the harness that verifies them.
      if (b.verifiedOn?.includes("live harness")) {
        expect(b.harness, `${b.id} claims live verification but names no harness`).toBeTruthy();
      }
    }
  });

  it("allowlist entries with harness paths reference existing files", () => {
    for (const b of allowlist.behaviors) {
      if (b.harness) {
        expect(
          existsSync(join(__dirname, b.harness.replace(/^packages\/core\/test\//, ""))),
          `${b.id} names a harness that does not exist: ${b.harness}`,
        ).toBe(true);
      }
    }
  });

  // The two above only prove the allowlist is well-FORMED. These pin something about what
  // it SAYS, and they are the only wallet assertions that can run without a wallet.
  it('an entry claiming a wallet "rejected" something names the harness that proves it', () => {
    // `expected: "rejected"` is the strongest claim in the allowlist: it asserts a wallet
    // refuses an action SigilKit depends on. Without a harness to re-check it, it is an
    // assertion nobody can verify — and the live suites that would verify it are opt-in.
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