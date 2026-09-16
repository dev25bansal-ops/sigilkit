import { describe, expect, it } from "vitest";
import {
  assertAddress,
  assertBigInt,
  assertHash32,
  assertHex,
  assertNonEmptyString,
  assertOneOf,
  assertPrivateKey,
  assertUrl,
  assertUint,
  isAddress,
  isHex,
  isUintLike,
  ValidationCollector,
  ValidationError,
} from "../src/validation.js";

const ALICE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const ZERO_HASH = ("0x" + "0".repeat(64)) as `0x${string}`;

describe("addresses", () => {
  it("accepts a lowercase 20-byte address", () => {
    expect(isAddress(ALICE)).toBe(true);
    expect(assertAddress(ALICE)).toBe(ALICE);
  });

  it("rejects malformed addresses with the field name in the message", () => {
    for (const bad of ["0x1234", "70997970c51812dc3a010c7d01b50e0d17dc79c8", "0x" + "zz".repeat(20), 42, null]) {
      expect(isAddress(bad)).toBe(false);
      expect(() => assertAddress(bad, "managerAddress")).toThrow(ValidationError);
      expect(() => assertAddress(bad, "managerAddress")).toThrow(/managerAddress/);
    }
  });

  it("names the field so a multi-argument call is diagnosable", () => {
    expect(() => assertAddress("nope", "scope.tokenWatchlist[2]")).toThrow(/scope\.tokenWatchlist\[2\]/);
  });
});

describe("hex and hashes", () => {
  it("checks even-length hex with and without a byte pin", () => {
    expect(isHex("0x")).toBe(true);
    expect(isHex("0xabc")).toBe(false); // odd length
    expect(isHex("0xzz")).toBe(false);
    expect(isHex("abcd")).toBe(false); // no 0x
    expect(isHex("0xdeadbeef", 4)).toBe(true);
    expect(isHex("0xdead", 4)).toBe(false);
  });

  it("pins hash length at 32 bytes", () => {
    expect(assertHash32(ZERO_HASH, "merkleRoot")).toBe(ZERO_HASH);
    expect(() => assertHash32("0xdeadbeef", "merkleRoot")).toThrow(/32 bytes/);
  });

  it("rejects the all-zero private key", () => {
    expect(() => assertPrivateKey(ZERO_HASH, "ownerKey")).toThrow(/all-zero/);
    const key = ("0x" + "11".repeat(32)) as `0x${string}`;
    expect(assertPrivateKey(key, "ownerKey")).toBe(key);
  });

  it("assertHex reports the expected shape", () => {
    expect(() => assertHex("0xabc", "data")).toThrow(/even-length/);
  });
});

describe("integers", () => {
  it("coerces bigint, number and decimal string", () => {
    expect(assertBigInt(5n, "v")).toBe(5n);
    expect(assertBigInt(5, "v")).toBe(5n);
    expect(assertBigInt("5", "v")).toBe(5n);
  });

  it("rejects floats, NaN and junk", () => {
    for (const bad of [1.5, Number.NaN, "1.5", "abc", null, undefined, {}]) {
      expect(() => assertBigInt(bad, "value")).toThrow(ValidationError);
    }
  });

  it("enforces bounds", () => {
    expect(() => assertBigInt(11n, "v", { max: 10n })).toThrow(/exceeds the maximum/);
    expect(() => assertBigInt(1n, "v", { min: 2n })).toThrow(/below the minimum/);
  });

  it("assertUint rejects NaN, floats and out-of-range", () => {
    expect(assertUint("12", "n", { min: 1, max: 20 })).toBe(12);
    expect(() => assertUint("abc", "n")).toThrow(/expected an integer/);
    expect(() => assertUint(Number.NaN, "n")).toThrow(/expected an integer/);
    expect(() => assertUint(1.5, "n")).toThrow(/expected an integer/);
    expect(() => assertUint(0, "n", { min: 1 })).toThrow(/below the minimum/);
    expect(() => assertUint(99, "n", { max: 10 })).toThrow(/exceeds the maximum/);
    expect(() => assertUint("", "n")).toThrow(ValidationError);
  });

  it("isUintLike mirrors the coercion rules", () => {
    expect(isUintLike(0n)).toBe(true);
    expect(isUintLike("42")).toBe(true);
    expect(isUintLike(-1n)).toBe(false);
    expect(isUintLike(1.5)).toBe(false);
    expect(isUintLike("x")).toBe(false);
  });
});

describe("strings, urls and enums", () => {
  it("rejects blank strings", () => {
    expect(() => assertNonEmptyString("   ", "db")).toThrow(/non-empty/);
    expect(assertNonEmptyString("audit.db", "db")).toBe("audit.db");
  });

  it("accepts http(s) and ws(s), rejects everything else", () => {
    expect(assertUrl("http://127.0.0.1:8545", "rpc")).toBe("http://127.0.0.1:8545");
    expect(assertUrl("wss://node.example/ws", "rpc")).toBe("wss://node.example/ws");
    expect(() => assertUrl("127.0.0.1:8545", "rpc")).toThrow(/absolute URL/);
    expect(() => assertUrl("ftp://example.com", "rpc")).toThrow(/protocol/);
  });

  it("lists the allowed values when an enum fails", () => {
    expect(assertOneOf("info", "level", ["debug", "info"] as const)).toBe("info");
    expect(() => assertOneOf("loud", "level", ["debug", "info"] as const)).toThrow(/debug \| info/);
  });
});

describe("ValidationCollector", () => {
  it("accumulates failures instead of stopping at the first", () => {
    const c = new ValidationCollector();
    const a = c.check(() => assertAddress("bad", "a"));
    const b = c.check(() => assertUint("bad", "b"));
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(c.ok).toBe(false);
    expect(c.messages).toHaveLength(2);
    expect(() => c.throwIfAny("scope")).toThrow(/2 problem\(s\)/);
  });

  it("passes values through and reports ok when nothing fails", () => {
    const c = new ValidationCollector();
    expect(c.check(() => assertUint(3, "n"))).toBe(3);
    expect(c.ok).toBe(true);
    expect(() => c.throwIfAny("scope")).not.toThrow();
  });

  it("rethrows non-validation errors untouched", () => {
    const c = new ValidationCollector();
    expect(() =>
      c.check(() => {
        throw new TypeError("programmer error");
      }),
    ).toThrow(TypeError);
  });
});
