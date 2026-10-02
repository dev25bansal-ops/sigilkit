/**
 * Numeric-precision regressions for `packages/core/src/signing.ts`.
 *
 * Every assertion here pins a LOSSlessness property at a wei boundary. The
 * theme is one sentence: a signed uint256 must denote exactly the value the
 * caller wrote, because the digest it feeds is an authorization.
 *
 *  - `uintField`  (value / nonce, uint256) — refuses `number`s past 2^53 rather
 *    than letting `BigInt()` round them, and never launders `true`/`[]`/`"0x10"`.
 *  - `expiryNumber` (uint48 unix seconds) — requires BOTH `isSafeInteger` (so
 *    the number->number hop is lossless) AND the uint48 bound (so the value
 *    survives the ABI encode). Either alone is insufficient; this pins the
 *    uint48 half, which is the one that lets a value silently become a
 *    *different, already-past* instant.
 *  - The cap comparisons in `validateAgainstScope` stay exact in bigint
 *    arithmetic, and stay in the same direction/inclusivity as the contract.
 */
import { describe, expect, it } from "vitest";
import { ValidationError, parseActionRequest, validateAgainstScope, type ActionRequest, type Scope } from "../src/index.js";
import { MAX_LEAVES } from "../src/index.js";
import { zeroHash, type Hash, type Hex } from "viem";

/** Inclusive upper bound of the ABI `uint48` backing `ActionRequest.expiry`. */
const MAX_UINT48 = 2n ** 48n - 1n;

const BASE = {
  agentId: `0x${"11".repeat(32)}` as Hex,
  target: "0x0000000000000000000000000000000000000900" as `0x${string}`,
  selector: "0x32145f90" as Hex,
  value: 0n,
  nonce: 0n,
  expiry: Math.floor(Date.now() / 1000) + 600,
  rationaleHash: `0x${"22".repeat(32)}` as Hex,
  data: "0x" as Hex,
} as const;

const SCOPE: Scope = {
  expiresAt: 4_102_444_800,
  windowSeconds: 600,
  perActionCap: 10n ** 18n,
  perWindowCap: 10n ** 18n,
  merkleRoot: zeroHash as Hash,
  countersignAbove: 0n,
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

const req = (over: Partial<Record<string, unknown>> = {}): ActionRequest =>
  parseActionRequest({ ...BASE, ...over }) as ActionRequest;

describe("signing · uintField: a signed uint256 must denote exactly what the caller wrote", () => {
  it("accepts a number at the exact safe-integer boundary and converts it losslessly", () => {
    // Off-by-one pin: 2^53-1 IS representable, so it must keep working.
    expect(req({ value: Number.MAX_SAFE_INTEGER }).value).toBe(9007199254740991n);
    expect(req({ nonce: Number.MAX_SAFE_INTEGER }).nonce).toBe(9007199254740991n);
  });

  it("refuses a number past the safe-integer range instead of rounding it", () => {
    // `BigInt(2**53)` is 9007199254740992n — a DIFFERENT amount. Rounding here
    // is silent, one-directional, and lands inside a signature.
    for (const bad of [2 ** 53, 2 ** 53 + 1, 1e21, 1e18 * 10]) {
      expect(() => req({ value: bad }), `value=${bad}`).toThrow(ValidationError);
      expect(() => req({ value: bad }), `value=${bad}`).toThrow(/safe integer/);
      expect(() => req({ nonce: bad }), `nonce=${bad}`).toThrow(/safe integer/);
    }
  });

  it("accepts the same value as a decimal string — the documented lossless escape hatch", () => {
    expect(req({ value: "9007199254740993" }).value).toBe(9007199254740993n);
    expect(req({ nonce: "9007199254740993" }).nonce).toBe(9007199254740993n);
  });

  it("rejects a JSON-round-tripped amount that JSON.parse already rounded", () => {
    // The realistic path: an LLM emits 9007199254740993 as a JSON number, and
    // JSON.parse hands back 9007199254740992 before the SDK ever sees it. The
    // SDK must refuse that rather than sign a 1-wei-different amount.
    const requested = 9007199254740993n;
    const roundTripped = JSON.parse(JSON.stringify({ v: Number("9007199254740993") })).v as number;
    expect(BigInt(roundTripped)).not.toBe(requested);
    expect(() => req({ value: roundTripped })).toThrow(ValidationError);
  });

  it("never launders a non-numeric shape into a real signed amount (BUG-01 type whitelist)", () => {
    const rejected: ReadonlyArray<readonly [string, unknown]> = [
      ["boolean", true],
      ["null", null],
      ["empty array", []],
      ["object", {}],
      ["float", 1.5],
      ["negative number", -1],
      ["negative string", "-1"],
      ["hex string", "0x10"],
      ["whitespace-padded", " 1"],
    ];
    for (const [label, bad] of rejected) {
      expect(() => req({ value: bad }), `value as ${label}`).toThrow(ValidationError);
      expect(() => req({ nonce: bad }), `nonce as ${label}`).toThrow(ValidationError);
    }
  });

  it("treats an omitted field as missing, never as 0", () => {
    // `undefined` is a *missing* field (a structural error), distinct from a shape
    // that would coerce to a real amount. Either way it must throw — what matters
    // is that `value: undefined` can never become a signed 0-wei transfer.
    for (const field of ["value", "nonce", "expiry"] as const) {
      expect(() => parseActionRequest({ ...BASE, [field]: undefined }), field).toThrow();
    }
  });

  it("rejects an amount above uint256 rather than wrapping it", () => {
    const tooBig = (2n ** 256n).toString();
    expect(() => req({ value: tooBig })).toThrow(/exceeds the maximum/);
  });
});

describe("signing · expiryNumber: uint48 needs BOTH losslessness and the ABI bound", () => {
  it("accepts the uint48 maximum exactly", () => {
    expect(req({ expiry: "281474976710655" }).expiry).toBe(281474976710655);
    expect(req({ expiry: 281474976710655n }).expiry).toBe(281474976710655);
  });

  it("refuses 2^48 — one past uint48, and exactly representable as a number", () => {
    // 2^48 = 281474976710656 is a SAFE integer, so `isSafeInteger` alone lets it
    // through; only the uint48 bound catches it. Encoded as a uint48 it wraps to
    // 0, i.e. a request that is expired from birth.
    expect(Number.isSafeInteger(2 ** 48)).toBe(true);
    expect(() => req({ expiry: 2 ** 48 })).toThrow(/uint48/);
    expect(() => req({ expiry: 2 ** 48 })).toThrow(ValidationError);
  });

  it("refuses a bigint/string beyond uint48 rather than rounding or wrapping", () => {
    expect(() => req({ expiry: MAX_UINT48 + 1n })).toThrow(/uint48/);
    expect(() => req({ expiry: "281474976710656" }).value).toThrow(/uint48/);
    expect(() => parseActionRequest({ ...BASE, expiry: "281474976710656" })).toThrow(/uint48/);
  });

  it("refuses a float, a boolean and a hex string", () => {
    for (const bad of [1.5, true, "0x10", -1, ""]) {
      expect(() => req({ expiry: bad }), `expiry=${String(bad)}`).toThrow(ValidationError);
    }
  });
});

describe("signing · validateAgainstScope: cap comparisons stay exact and keep contract direction", () => {
  const now = Math.floor(Date.now() / 1000);

  it("per-action cap: equality is allowed, one wei over is rejected", () => {
    const cap = 10n ** 18n;
    const scope: Scope = { ...SCOPE, perActionCap: cap, perWindowCap: 2n * cap };
    expect(validateAgainstScope({ request: req({ value: cap }), scope }).ok).toBe(true);
    expect(validateAgainstScope({ request: req({ value: cap + 1n }), scope }).ok).toBe(false);
  });

  it("per-window cap: a 1-wei gap is caught even when the cap is far above 2^53", () => {
    // 20 ETH in wei is ~2e19, well past 2^53 (~9.007e15). A `number` round-trip
    // of this cap would already be lossy, so this is the exact-arithmetic case.
    const cap = 20n * 10n ** 18n;
    expect(cap > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    const scope: Scope = { ...SCOPE, perActionCap: cap, perWindowCap: cap };
    expect(validateAgainstScope({ request: req({ value: cap }), scope }).ok).toBe(true);
    expect(validateAgainstScope({ request: req({ value: cap + 1n }), scope }).ok).toBe(false);
  });

  it("per-window projection adds in bigint, never in floating point", () => {
    const cap = 20n * 10n ** 18n;
    const scope: Scope = { ...SCOPE, perActionCap: cap, perWindowCap: cap };
    // 16 ETH already spent + 5 ETH requested = 21 ETH, one whole ETH over the cap.
    // The whole point is that `16n*10n**18n + 5n*10n**18n` is exact — a float would
    // not be — and that the projected total is reported exactly in the reason.
    const res = validateAgainstScope({
      request: req({ value: 5n * 10n ** 18n }),
      scope,
      windowState: { windowStart: now - 10, spentThisWindow: 16n * 10n ** 18n },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("per-window cap exceeded (21000000000000000000 > 20000000000000000000)");
    }
  });

  it("a projection landing exactly on the cap is allowed (contract uses strict >)", () => {
    // SpendPolicy.sol: `if (projected > perWindowCap) revert` — so equality passes.
    // An off-by-one here would make the local pre-flight STRICTER than the chain,
    // refusing transactions the chain would have executed.
    const cap = 20n * 10n ** 18n;
    const scope: Scope = { ...SCOPE, perActionCap: cap, perWindowCap: cap };
    const res = validateAgainstScope({
      request: req({ value: 5n * 10n ** 18n }),
      scope,
      windowState: { windowStart: now - 10, spentThisWindow: 15n * 10n ** 18n },
    });
    expect(res.ok).toBe(true);
  });

  it("a stale window is ignored rather than double-charged", () => {
    const cap = 20n * 10n ** 18n;
    const scope: Scope = { ...SCOPE, perActionCap: cap, perWindowCap: cap };
    const res = validateAgainstScope({
      request: req({ value: 5n * 10n ** 18n }),
      scope,
      windowState: { windowStart: now - (SCOPE.windowSeconds + 1), spentThisWindow: 19n * 10n ** 18n },
    });
    expect(res.ok).toBe(true);
  });
});

describe("signing · merkle proof bound is numeric-safe and cannot drift", () => {
  it("MAX_LEAVES stays at the documented 65,536", () => {
    expect(MAX_LEAVES).toBe(65_536);
  });
});
