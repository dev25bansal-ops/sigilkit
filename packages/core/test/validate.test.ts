/**
 * validateAgainstScope unit tests — including the Q5 off-by-one alignment with the
 * contract: the on-chain check reverts when `block.timestamp > request.expiry`, so a
 * request is valid THROUGH its expiry second; the local pre-check now matches exactly.
 */
import { describe, expect, it } from "vitest";
import { validateAgainstScope, type ActionRequest, type Scope } from "../src/index.js";
import type { Hash, Hex } from "viem";

const SCOPE: Scope = {
  expiresAt: 1_900_000_000,
  windowSeconds: 600,
  perActionCap: 2n * 10n ** 18n,
  perWindowCap: 5n * 10n ** 18n,
  merkleRoot: `0x${"0".repeat(64)}` as Hash,
};

function request(overrides: Partial<ActionRequest>): ActionRequest {
  return {
    agentId: `0x${"11".repeat(32)}` as Hash,
    target: "0x0000000000000000000000000000000000000001",
    selector: "0x32145f90" as Hex,
    value: 0n,
    nonce: 0n,
    expiry: Math.floor(Date.now() / 1000) + 600,
    rationaleHash: `0x${"22".repeat(32)}` as Hash,
    data: "0x",
    ...overrides,
  };
}

describe("validateAgainstScope (zero-gas pre-check)", () => {
  it("accepts a request valid through its expiry second (Q5: matches the contract)", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Contract semantics: block.timestamp == expiry does NOT revert.
    const r = request({ expiry: nowSec });
    expect(validateAgainstScope({ request: r, scope: SCOPE })).toEqual({ ok: true });
  });

  it("rejects a request one second past expiry", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const r = request({ expiry: nowSec - 1 });
    const res = validateAgainstScope({ request: r, scope: SCOPE });
    expect(res).toEqual({ ok: false, reason: "request already expired" });
  });

  it("rejects when the scope is hard-expired (independent of request expiry)", () => {
    const r = request({ expiry: Math.floor(Date.now() / 1000) + 600 });
    const res = validateAgainstScope({
      request: r,
      scope: { ...SCOPE, expiresAt: Math.floor(Date.now() / 1000) - 1 },
    });
    expect(res).toEqual({ ok: false, reason: "scope hard-expired" });
  });

  it("rejects per-action cap violations with an actionable message", () => {
    const r = request({ value: 21n * 10n ** 17n }); // 2.1 ETH > 2 ETH per-action cap
    const res = validateAgainstScope({ request: r, scope: SCOPE });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("per-action cap exceeded");
  });

  it("charges the window state when inside the window and caps the projection", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // 1 ETH action (within the 2 ETH per-action cap) on top of 4.5 ETH already spent
    // in the window projects to 5.5 ETH > 5 ETH per-window cap.
    const r = request({ value: 10n ** 18n });
    const res = validateAgainstScope({
      request: r,
      scope: SCOPE,
      windowState: { windowStart: nowSec - 10, spentThisWindow: 4500n * 10n ** 15n },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("per-window cap exceeded");
  });

  it("ignores stale window state past the window length", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const r = request({ value: 10n ** 18n });
    const res = validateAgainstScope({
      request: r,
      scope: SCOPE,
      windowState: { windowStart: nowSec - SCOPE.windowSeconds - 10, spentThisWindow: 4500n * 10n ** 15n },
    });
    expect(res).toEqual({ ok: true });
  });
});
