/**
 * Numeric-precision regressions for `packages/core/src/validation.ts`.
 *
 * `validation.ts` is the first numeric gate every untrusted amount passes through
 * (CLI flags, env vars, and the MCP tool surface), so a laundering bug here is
 * reachable without any chain interaction at all. These tests pin two things:
 *
 *  1. **Losslessness.** A value converted to `number` must denote exactly what the
 *     caller wrote. Past 2^53 (9_007_199_254_740_991) it does not, and the SDK
 *     must refuse rather than round — silently, in one direction.
 *  2. **A single unambiguous textual form.** `"0x10"`, `" 1"`, `"1e3"` are all
 *     things `Number()`/`BigInt()` will happily coerce. A *signed* field must
 *     reject them, because each one denotes a different value than the decimal
 *     reading a human (or a model) would give it.
 *
 * Regression ids from the catalog: DEBT/SEC-18e (assertBigInt accepted numbers
 * past 2^53); the same class of defect in `assertUint` is pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  assertBigInt,
  assertUint,
  assertUintField,
  isUintLike,
  MAX_UINT256,
  toUnsignedBigInt,
  ValidationError,
} from "../src/index.js";
// `readEnvBigInt` lives in `config.ts`, which is deliberately NOT re-exported by the barrel:
// `config.ts` has a top-level `node:fs` import, and an `export *` barrel would make it
// reachable for every consumer, which a bundler cannot tree-shake away (it is the reason
// `config` exists as its own subpath export). Import it the way a consumer must.
import { readEnvBigInt } from "../src/config.js";

describe("validation · toUnsignedBigInt: the shared lossless non-negative conversion", () => {
  it("passes bigint, safe integers and plain decimal strings through unchanged", () => {
    expect(toUnsignedBigInt(0n)).toBe(0n);
    expect(toUnsignedBigInt(42n)).toBe(42n);
    expect(toUnsignedBigInt(0)).toBe(0n);
    expect(toUnsignedBigInt(42)).toBe(42n);
    expect(toUnsignedBigInt("0")).toBe(0n);
    expect(toUnsignedBigInt("42")).toBe(42n);
    // Arbitrary precision via the string path — the only way to express > 2^53.
    expect(toUnsignedBigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935")).toBe(
      2n ** 256n - 1n,
    );
  });

  it("returns null for a number past the safe-integer range (never a rounded value)", () => {
    for (const bad of [2 ** 53, 2 ** 53 + 1, 1e21, Number.MAX_SAFE_INTEGER + 2]) {
      expect(toUnsignedBigInt(bad), `number=${bad}`).toBeNull();
    }
  });

  it("returns null for negatives, floats and every coercible non-integer shape", () => {
    for (const bad of [-1, -1n, 1.5, 0.1, -0.5, true, null, undefined, [], {}, "0x10", "-1", " 1", "1e3", "1.0", ""]) {
      expect(toUnsignedBigInt(bad), `input=${String(bad)}`).toBeNull();
    }
  });
});

describe("validation · assertUintField: lossless and bounded by the ABI type", () => {
  it("defaults to the uint256 ceiling", () => {
    expect(assertUintField(MAX_UINT256, "v")).toBe(MAX_UINT256);
    expect(() => assertUintField(MAX_UINT256 + 1n, "v")).toThrow(/exceeds the maximum/);
  });

  it("enforces a narrower caller-supplied bound (uint48-shaped)", () => {
    const max = 2n ** 48n - 1n;
    expect(assertUintField(max, "v", max)).toBe(max);
    expect(() => assertUintField(max + 1n, "v", max)).toThrow(/exceeds the maximum/);
  });

  it("throws a ValidationError naming the field, not a raw TypeError", () => {
    let caught: unknown;
    try {
      assertUintField("nope", "perActionCap");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).field).toBe("perActionCap");
  });
});

describe("validation · assertBigInt: refuses to launder an amount past 2^53", () => {
  it("accepts the exact safe-integer boundary", () => {
    expect(assertBigInt(Number.MAX_SAFE_INTEGER, "v")).toBe(9007199254740991n);
  });

  it("refuses a number past the safe-integer range and names the fix", () => {
    for (const bad of [2 ** 53, 2 ** 53 + 1, 1e21]) {
      expect(() => assertBigInt(bad, "perActionCap"), `number=${bad}`).toThrow(ValidationError);
      expect(() => assertBigInt(bad, "perActionCap"), `number=${bad}`).toThrow(
        /number exceeds safe integer range; pass a decimal string/,
      );
    }
  });

  it("accepts the identical value as a decimal string, exactly", () => {
    expect(assertBigInt("9007199254740993", "perActionCap")).toBe(9007199254740993n);
    expect(assertBigInt((2n ** 256n - 1n).toString(), "perActionCap")).toBe(2n ** 256n - 1n);
  });

  it("still rejects floats and junk (it serves signed CLI offsets too)", () => {
    for (const bad of [1.5, Number.NaN, "1.5", "abc", true, null, {}, []]) {
      expect(() => assertBigInt(bad, "v"), `input=${String(bad)}`).toThrow(ValidationError);
    }
  });

  it("enforces min/max bounds in bigint arithmetic", () => {
    expect(assertBigInt(5n, "v", { min: 1n, max: 10n })).toBe(5n);
    expect(() => assertBigInt(0n, "v", { min: 1n })).toThrow(/below the minimum/);
    expect(() => assertBigInt(11n, "v", { max: 10n })).toThrow(/exceeds the maximum/);
  });
});

describe("validation · assertUint: the number-typed sibling must not round either", () => {
  it("still accepts ordinary bounded integers and decimal strings", () => {
    expect(assertUint("12", "n", { min: 1, max: 20 })).toBe(12);
    expect(assertUint(12, "n", { min: 1, max: 20 })).toBe(12);
    expect(assertUint(0, "n")).toBe(0);
  });

  it("refuses a value past the safe-integer range instead of rounding it", () => {
    // The DEBT/SEC-18e defect in its `number`-returning sibling: `Number.isInteger`
    // accepts every float >= 2^53, so `2**53` was silently rounded and a chain id
    // / block height / count came out as a DIFFERENT value with no error.
    for (const bad of [2 ** 53, 2 ** 53 + 1, "9007199254740993", 1e21]) {
      expect(() => assertUint(bad, "n"), `input=${bad}`).toThrow(ValidationError);
    }
  });

  it("refuses floats, NaN, and the ambiguous textual forms Number() accepts", () => {
    // `Number()` also coerces "0x10"->16, "1e3"->1000, "+1"->1 and "1.0"->1.
    // Each denotes a different value than the plain-decimal reading, and all are
    // reachable from env vars, CLI flags and MCP tool args with no chain involved.
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, "1.5", "abc", "0x10", "1e3", "+1", "1.0", true, null, []]) {
      expect(() => assertUint(bad, "n"), `input=${String(bad)}`).toThrow(ValidationError);
    }
  });

  it("still accepts a whitespace-padded integer, matching isUintLike", () => {
    // Padding is normalized by every gate consistently, so it is not an ambiguity
    // of the same kind as "0x10"/"1e3"; `toUnsignedBigInt` is stricter still
    // because it feeds a signed pre-image (pinned in its own describe block).
    expect(assertUint(" 12 ", "n")).toBe(12);
    expect(isUintLike(" 1 ")).toBe(true);
  });

  it("enforces bounds after the conversion", () => {
    expect(() => assertUint(0, "n", { min: 1 })).toThrow(/below the minimum/);
    expect(() => assertUint(99, "n", { max: 10 })).toThrow(/exceeds the maximum/);
  });
});

describe("validation · isUintLike mirrors assertUint's acceptance set (non-bigint inputs)", () => {
  it("agrees with assertUint on every non-bigint representative input", () => {
    // `bigint` and BOTH forms of a negative (`-1` and `"-1"`) are deliberately
    // excluded, each for a documented reason asserted in the tests below:
    // `assertUint` returns a `number` (so it never took a bigint) and carries no
    // implicit non-negative bound (so it takes a negative unless a `min` is given).
    // Neither is drift — both are the contract.
    const samples: readonly unknown[] = [
      0, 1, 1.5, 2 ** 53 - 1, 2 ** 53, "0", "42", "0x10", "1e3", " 1 ", true, null, undefined, [], {},
    ];
    for (const sample of samples) {
      let accepted: boolean;
      try {
        assertUint(sample, "n");
        accepted = true;
      } catch {
        accepted = false;
      }
      expect(isUintLike(sample), `sample=${String(sample)}`).toBe(accepted);
    }
  });

  it("accepts a bigint that assertUint cannot represent, by design", () => {
    expect(isUintLike(0n)).toBe(true);
    expect(isUintLike(-1n)).toBe(false);
    // A bigint past 2^53 is still perfectly lossless, which is the whole reason
    // the bigint path exists; `assertUint` cannot take it because it returns a number.
    expect(isUintLike(2n ** 200n)).toBe(true);
    expect(() => assertUint(2n ** 200n, "n")).toThrow(ValidationError);
  });

  it("is non-negative-only where assertUint needs an explicit min", () => {
    // `assertUint` has no implicit non-negative bound, so it accepts -1 when no
    // `min` is given (bounds are opt-in); `isUintLike` is uint-LIKE, so it is
    // non-negative by definition. Both are correct — the mirror only holds once a
    // bound is supplied, and every amount-bearing caller supplies one.
    expect(assertUint(-1, "n")).toBe(-1);
    expect(() => assertUint(-1, "n", { min: 0 })).toThrow(/below the minimum/);
    expect(isUintLike(-1)).toBe(false);
  });

  it("is stricter than toUnsignedBigInt only on padded strings, never on the value", () => {
    // `assertUint`/`isUintLike` normalize padding; `toUnsignedBigInt` requires the
    // raw string to already be digits because it feeds a SIGNED pre-image. The
    // difference is the FORM, not the value: both accept "9007199254740993" exactly
    // by the string path, and both refuse a number past 2^53.
    expect(isUintLike(" 1 ")).toBe(true);
    expect(toUnsignedBigInt(" 1 ")).toBeNull();
    for (const bad of [2 ** 53, 2 ** 53 + 1]) {
      expect(isUintLike(bad), `number=${bad}`).toBe(false);
    }
  });
});

describe("validation · readEnvBigInt: an env-supplied wei amount is never rounded", () => {
  it("reads a plain decimal amount exactly", () => {
    expect(readEnvBigInt({ W: "1000" }, "W", 0n)).toBe(1000n);
    expect(readEnvBigInt({ W: "1000000000000000000" }, "W", 0n)).toBe(10n ** 18n);
  });

  it("accepts an amount far past 2^53 (the reason it is a bigint, not a number)", () => {
    expect(readEnvBigInt({ W: "9007199254740993" }, "W", 0n)).toBe(9007199254740993n);
    expect(readEnvBigInt({ W: "123456789012345678901234567890" }, "W", 0n)).toBe(123456789012345678901234567890n);
  });

  it("rejects a negative or malformed amount rather than falling back silently", () => {
    expect(() => readEnvBigInt({ W: "-1" }, "W", 0n)).toThrow(ValidationError);
    expect(() => readEnvBigInt({ W: "1.5" }, "W", 0n)).toThrow(ValidationError);
    expect(() => readEnvBigInt({ W: "0x10" }, "W", 0n)).toThrow(ValidationError);
    expect(() => readEnvBigInt({ W: "abc" }, "W", 0n)).toThrow(ValidationError);
  });

  it("uses the fallback only when the variable is absent or blank", () => {
    expect(readEnvBigInt({}, "W", 7n)).toBe(7n);
    expect(readEnvBigInt({ W: "  " }, "W", 7n)).toBe(7n);
  });
});
