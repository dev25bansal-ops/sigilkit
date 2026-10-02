/**
 * Unit tests for the ERC-7579 install-data encoder (R41-A1).
 *
 * `SessionKey7579Module.onInstall` decodes `abi.encode(address key, Scope)` against its
 * OWN five-field struct, while the SDK `Scope` carries three manager-only extensions the
 * module cannot honor. `encode7579InstallData` narrows the SDK Scope to that wire shape
 * and rejects the manager-only fields; these tests pin the byte-exact encoding (ethers
 * parity, mirroring parity.test.ts) and every rejection reason.
 */
import { describe, expect, it } from "vitest";
import { AbiCoder } from "ethers";
import { decodeAbiParameters, zeroHash, type Address } from "viem";
import { encode7579InstallData } from "../src/accounts.js";
import type { Scope } from "../src/types.js";

const coder = AbiCoder.defaultAbiCoder();

/** Digit-only addresses (no letters ⇒ EIP-55 checksum trivially satisfied). */
const KEY = "0x1111111111111111111111111111111111111101" as Address;
const WATCHED = "0x1111111111111111111111111111111111111102" as Address;

function baseScope(overrides: Partial<Scope> = {}): Scope {
  return {
    expiresAt: 1_900_000_000,
    windowSeconds: 3600,
    perActionCap: 1_000_000n,
    perWindowCap: 5_000_000n,
    merkleRoot: zeroHash,
    countersignAbove: 0n,
    enforceNativeDelta: false,
    tokenWatchlist: [],
    ...overrides,
  };
}

describe("encode7579InstallData (ERC-7579 onInstall payload)", () => {
  it("encodes the five-field module Scope byte-identically to ethers' ABI coder", () => {
    const scope = baseScope({ merkleRoot: ("0x" + "ab".repeat(32)) as `0x${string}` });
    const encoded = encode7579InstallData({ chainId: 31337, key: KEY, scope });
    const expected = coder.encode(
      ["address", "uint48", "uint48", "uint256", "uint256", "bytes32"],
      [KEY, scope.expiresAt, scope.windowSeconds, scope.perActionCap, scope.perWindowCap, scope.merkleRoot],
    );
    expect(encoded).toBe(expected);
    // Exactly 6 ABI words: address, uint48, uint48, uint256, uint256, bytes32.
    expect(encoded).toHaveLength(2 + 6 * 64);
  });

  it("round-trips through the contract's decode shape: (address, Scope) tuple", () => {
    const scope = baseScope({ merkleRoot: ("0x" + "cd".repeat(32)) as `0x${string}` });
    const encoded = encode7579InstallData({ chainId: 1, key: KEY, scope });
    const [decodedKey, tuple] = decodeAbiParameters(
      [
        { type: "address" },
        {
          type: "tuple",
          components: [
            { name: "expiresAt", type: "uint48" },
            { name: "windowSeconds", type: "uint48" },
            { name: "perActionCap", type: "uint256" },
            { name: "perWindowCap", type: "uint256" },
            { name: "merkleRoot", type: "bytes32" },
          ],
        },
      ],
      encoded,
    );
    expect(decodedKey.toLowerCase()).toBe(KEY);
    expect(tuple).toEqual({
      expiresAt: scope.expiresAt,
      windowSeconds: scope.windowSeconds,
      perActionCap: scope.perActionCap,
      perWindowCap: scope.perWindowCap,
      merkleRoot: scope.merkleRoot,
    });
  });

  it("rejects scopes carrying manager-only fields the 7579 module cannot honor", () => {
    const cases: Array<[string, Partial<Scope>, RegExp]> = [
      ["countersignAbove (E10)", { countersignAbove: 1n }, /scope\.countersignAbove/],
      ["enforceNativeDelta (E11)", { enforceNativeDelta: true }, /scope\.enforceNativeDelta/],
      ["tokenWatchlist (E11)", { tokenWatchlist: [WATCHED] }, /scope\.tokenWatchlist/],
    ];
    for (const [name, overrides, reason] of cases) {
      expect(
        () => encode7579InstallData({ chainId: 31337, key: KEY, scope: baseScope(overrides) }),
        name,
      ).toThrow(reason);
    }
  });

  it("rejects out-of-range uint48 fields with a field-naming error", () => {
    expect(() =>
      encode7579InstallData({ chainId: 31337, key: KEY, scope: baseScope({ expiresAt: 2 ** 48 }) }),
    ).toThrow(/scope\.expiresAt/);
    expect(() =>
      encode7579InstallData({ chainId: 31337, key: KEY, scope: baseScope({ windowSeconds: 0 }) }),
    ).toThrow(/scope\.windowSeconds/);
  });

  it("rejects caps the module's own grant would refuse (MalformedExecutionData on-chain)", () => {
    expect(() =>
      encode7579InstallData({ chainId: 31337, key: KEY, scope: baseScope({ perActionCap: 0n }) }),
    ).toThrow(/scope\.perActionCap/);
    expect(() =>
      encode7579InstallData({ chainId: 31337, key: KEY, scope: baseScope({ perWindowCap: 1_000_000n, perActionCap: 5_000_000n }) }),
    ).toThrow(/scope\.perWindowCap/);
  });

  it("rejects a malformed key and a malformed chainId", () => {
    expect(() =>
      encode7579InstallData({ chainId: 31337, key: "0x1234" as Address, scope: baseScope() }),
    ).toThrow(/key/);
    expect(() =>
      encode7579InstallData({ chainId: 1.5, key: KEY, scope: baseScope() }),
    ).toThrow(/chainId/);
  });
});