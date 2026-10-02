/**
 * Unit tests for parseActionRequest: the untrusted-input normalizer that coerces
 * JSON-deserialized ActionRequests (string numbers, mixed-case addresses) into
 * validated typed values, failing loudly on malformed input instead of throwing a
 * cryptic TypeError mid-ABI-encode or silently hashing garbage.
 */
import { describe, expect, it } from "vitest";
import { actionRequestDigest, parseActionRequest } from "../src/index.js";
import type { ActionRequest } from "../src/index.js";

const VALID: ActionRequest = {
  agentId: ("0x" + "33".repeat(32)) as `0x${string}`,
  target: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  selector: "0x32145f90",
  value: 10n ** 16n,
  nonce: 0n,
  expiry: 1787654400,
  rationaleHash: ("0x" + "44".repeat(32)) as `0x${string}`,
  data: "0x0000000000000000000000000000000000000000000000000000000000000007",
};

describe("parseActionRequest", () => {
  it("valid request round-trips unchanged and keeps its digest identical", () => {
    const parsed = parseActionRequest(VALID);
    // Only documented transformation for already-typed input: target → lowercase.
    expect(parsed).toEqual({ ...VALID, target: VALID.target.toLowerCase() });
    // Normalization must not alter the canonical digest for already-typed input.
    expect(
      actionRequestDigest({
        request: parsed,
        chainId: 31337,
        verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      }),
    ).toBe(
      actionRequestDigest({
        request: VALID,
        chainId: 31337,
        verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      }),
    );
  });

  it("coerces JSON-deserialized string/number value+nonce into bigint", () => {
    // JSON.stringify(10n ** 16n) is impossible; real-world payloads carry strings or numbers.
    const json = {
      ...VALID,
      target: VALID.target.toLowerCase(), // checksum lost in transport
      value: "10000000000000000",
      nonce: 0,
      expiry: 1787654400,
    };
    const parsed = parseActionRequest(JSON.parse(JSON.stringify(json)));
    expect(parsed.value).toBe(10n ** 16n);
    expect(parsed.value).toBeTypeOf("bigint");
    expect(parsed.nonce).toBe(0n);
    expect(parsed.target).toBe(VALID.target.toLowerCase());
    expect(parsed.expiry).toBe(1787654400);
    expect(typeof parsed.expiry).toBe("number");
  });

  it("rejects a selector with wrong byte length", () => {
    expect(() =>
      parseActionRequest({ ...VALID, selector: "0x123456" }), // 3 bytes
    ).toThrow(/selector/);
    expect(() =>
      parseActionRequest({ ...VALID, selector: "0x123456789a" }), // 5 bytes
    ).toThrow(/selector/);
  });

  it("rejects odd-length data hex", () => {
    expect(() => parseActionRequest({ ...VALID, data: "0x123" })).toThrow(/data/);
    expect(() => parseActionRequest({ ...VALID, data: "0xabc" })).toThrow(/data/);
  });

  it("rejects missing required fields", () => {
    for (const field of [
      "agentId",
      "target",
      "selector",
      "value",
      "nonce",
      "expiry",
      "rationaleHash",
      "data",
    ] as const) {
      const partial: Record<string, unknown> = { ...VALID };
      delete partial[field];
      expect(() => parseActionRequest(partial)).toThrow(new RegExp(field));
    }
  });

  it("rejects non-hex and wrong-length bytes32 fields and non-address targets", () => {
    expect(() =>
      parseActionRequest({ ...VALID, agentId: ("0x" + "33".repeat(31)) as `0x${string}` }),
    ).toThrow(/agentId/);
    expect(() =>
      parseActionRequest({ ...VALID, rationaleHash: "0xnothex" }),
    ).toThrow(/rationaleHash/);
    expect(() => parseActionRequest({ ...VALID, target: "0x1234" })).toThrow(/target/);
    expect(() => parseActionRequest({ ...VALID, value: "wei" })).toThrow(/value/);
    expect(() => parseActionRequest(null)).toThrow(/expected an ActionRequest object/);
    expect(() => parseActionRequest([VALID])).toThrow(/expected an ActionRequest object/);
  });
});

/**
 * BUG-01: parseActionRequest used a bare `BigInt(v as ...)` / `Number(v)` coercion,
 * which accepted every value JS considers coercible — `true`→1, `[]`→0,
 * `"0x10"`→16, `" 1"`→1 — and, for `expiry`, any finite number including floats
 * (`1.5`). Each of those silently produced a *different signed amount* than the
 * caller wrote, so a schema typo in a JSON payload became a real authorization.
 * These tests pin the type whitelist that replaced the coercion.
 */
describe("parseActionRequest: uint type whitelist (BUG-01)", () => {
  // Every shape the old BigInt()/Number() coercion accepted but must not now.
  const REJECTED: ReadonlyArray<readonly [string, unknown]> = [
    ["true", true],
    ["false", false],
    ["null", null],
    ["undefined", undefined],
    ["[]", []],
    ["{}", {}],
    ['"0x10"', "0x10"],
    ['"abc"', "abc"],
    ["1.5", 1.5],
    ["-1", -1],
    ['" 1" (leading space)', " 1"],
    ['"1 " (trailing space)', "1 "],
    ['"1_0" (separators)', "1_0"],
    ['"0b1" (binary string)', "0b1"],
    ['"0o7" (octal string)', "0o7"],
    ['"" (empty string)', ""],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];

  it.each(REJECTED)("rejects %s for value", (_label, v) => {
    expect(() => parseActionRequest({ ...VALID, value: v })).toThrow(/value/);
  });

  it.each(REJECTED)("rejects %s for nonce", (_label, v) => {
    expect(() => parseActionRequest({ ...VALID, nonce: v })).toThrow(/nonce/);
  });

  it("rejects the reported repro exactly: value: true is not 1 wei", () => {
    // BUG-01 headline case: `true` used to become 1 and get signed.
    expect(() => parseActionRequest({ ...VALID, value: true })).toThrow(/value/);
    expect(() => parseActionRequest({ ...VALID, value: [] })).toThrow(/value/);
    // "0x10" used to become 16 — a hex-looking amount is NOT a decimal uint.
    expect(() => parseActionRequest({ ...VALID, value: "0x10" })).toThrow(/value/);
  });

  it("rejects expiry: 1.5 — the key regression (was accepted as a truncated uint48)", () => {
    expect(() => parseActionRequest({ ...VALID, expiry: 1.5 })).toThrow(/expiry/);
    // The rest of the Number() coercion's surprises, same root cause.
    for (const v of [true, false, null, [], {}, "0x10", "1e3", -1, Number.NaN]) {
      expect(() => parseActionRequest({ ...VALID, expiry: v })).toThrow(/expiry/);
    }
  });

  it("accepts the documented whitelist: bigint, safe integer, decimal string", () => {
    const accepted: ReadonlyArray<readonly [unknown, bigint]> = [
      [0n, 0n],
      [1n, 1n],
      [42n, 42n],
      [0, 0n],
      [42, 42n],
      ["0", 0n],
      ["42", 42n],
      ["10000000000000000", 10n ** 16n],
    ];
    for (const [input, expected] of accepted) {
      const parsed = parseActionRequest({ ...VALID, value: input, nonce: input });
      expect(parsed.value, `value=${String(input)}`).toBe(expected);
      expect(parsed.nonce, `nonce=${String(input)}`).toBe(expected);
      expect(typeof parsed.value).toBe("bigint");
    }
  });

  it("accepts expiry as a safe integer / decimal string and keeps it a number", () => {
    expect(parseActionRequest({ ...VALID, expiry: 0 }).expiry).toBe(0);
    expect(parseActionRequest({ ...VALID, expiry: 1787654400 }).expiry).toBe(1787654400);
    expect(parseActionRequest({ ...VALID, expiry: "1787654400" }).expiry).toBe(1787654400);
    expect(typeof parseActionRequest({ ...VALID, expiry: 1 }).expiry).toBe("number");
  });

  it("keeps large values lossless at the number/decimal-string boundary", () => {
    // MAX_SAFE_INTEGER as a number is exactly representable, so it is accepted
    // and converts without drift.
    const asNumber = parseActionRequest({ ...VALID, value: Number.MAX_SAFE_INTEGER });
    expect(asNumber.value).toBe(BigInt(Number.MAX_SAFE_INTEGER));

    // One past it is NOT exactly representable as a number (it is 2^53), so the
    // number form is rejected rather than silently rounded to a wrong wei amount.
    expect(Number.MAX_SAFE_INTEGER + 1).not.toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseActionRequest({ ...VALID, value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      /value/,
    );

    // The decimal string is arbitrary precision, so the same value passes there.
    const asString = parseActionRequest({
      ...VALID,
      value: String(Number.MAX_SAFE_INTEGER + 1),
    });
    expect(asString.value).toBe(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  });

  it("enforces the uint256 upper bound on bigint and string inputs", () => {
    const tooBig = 2n ** 256n;
    expect(() => parseActionRequest({ ...VALID, value: tooBig })).toThrow(/value/);
    expect(() => parseActionRequest({ ...VALID, value: tooBig.toString() })).toThrow(/value/);
    // The boundary itself is still valid.
    expect(
      parseActionRequest({ ...VALID, value: 2n ** 256n - 1n }).value,
    ).toBe(2n ** 256n - 1n);
  });

  it("enforces the uint48 upper bound on expiry", () => {
    expect(() => parseActionRequest({ ...VALID, expiry: 2 ** 48 })).toThrow(/expiry/);
    // 2^48 - 1 is the largest legal uint48 and remains accepted.
    expect(parseActionRequest({ ...VALID, expiry: 2 ** 48 - 1 }).expiry).toBe(2 ** 48 - 1);
  });

  it("reports the field name and the actual type in the error message", () => {
    // The message is the only thing an integrating agent sees, so it must name the
    // field and the offending shape rather than just "invalid value".
    expect(() => parseActionRequest({ ...VALID, value: true })).toThrow(/value.*boolean/s);
    expect(() => parseActionRequest({ ...VALID, value: [] })).toThrow(/value.*array/s);
    expect(() => parseActionRequest({ ...VALID, nonce: null })).toThrow(/nonce.*null/s);
    expect(() => parseActionRequest({ ...VALID, expiry: {} })).toThrow(/expiry.*object/s);
  });
});
