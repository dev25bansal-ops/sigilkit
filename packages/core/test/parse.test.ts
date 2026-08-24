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
