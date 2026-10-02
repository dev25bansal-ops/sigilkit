/**
 * EIP-7702 signature- and delegation-VALIDATION failure paths.
 *
 * The existing eip7702.test.ts pins the happy digest vectors thoroughly (and against
 * live viem), but every rejection branch below was untested. These are the paths that
 * decide whether a malformed authorization is *refused* or silently coerced into a
 * tuple a relayer would happily broadcast:
 *
 *  - a signature that is not exactly 65 bytes,
 *  - a parity byte that is neither 0/1 nor the ecrecover-style 27/28,
 *  - an EOA carrying code that is not a 7702 designator (must fail CLOSED, never be
 *    reinterpreted as a delegation).
 *
 * Uses a stub PublicClient rather than a live Anvil node: `getCode` is the only
 * transport touch point, so a stub exercises the real decode logic deterministically
 * and without the shared 8545 port the suite otherwise serializes on.
 */
import { describe, expect, it } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import {
  isDelegatedTo,
  signAuthorization,
  signRevocation,
  validateAuthorization,
  ZERO_ADDRESS,
} from "../src/index.js";

const IMPL = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
const EOA = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

/** Minimal signer stub returning an exact byte string, so malformed sigs are expressible. */
function signerReturning(sig: Hex): { sign: (a: { hash: Hex }) => Promise<Hex> } {
  return { sign: async () => sig };
}

/** 65-byte signature with a caller-chosen trailing parity byte. */
function sigWithParity(parity: number, body = "11".repeat(64)): Hex {
  return (`0x${body}${parity.toString(16).padStart(2, "0")}`) as Hex;
}

function clientWithCode(code: Hex): PublicClient {
  return { getCode: async () => code } as unknown as PublicClient;
}

describe("signAuthorization rejects malformed signatures", () => {
  const args = { contractAddress: IMPL, chainId: 31337, nonce: 0 };

  it.each([0, 1, 32, 64, 66, 128])(
    "refuses a %i-byte signature instead of padding or truncating it",
    async (len) => {
      const sig = (`0x${"ab".repeat(len)}`) as Hex;
      await expect(signAuthorization(signerReturning(sig), args)).rejects.toThrow(
        new RegExp(`expected 65-byte signature, got ${len}`),
      );
    },
  );

  it("refuses an empty signature rather than treating it as a valid zero signature", async () => {
    await expect(signAuthorization(signerReturning("0x"), args)).rejects.toThrow(
      "expected 65-byte signature, got 0",
    );
  });

  it.each([2, 3, 26, 29, 30, 127, 255])(
    "refuses parity byte %i — only 0/1 (and ecrecover 27/28) are legal",
    async (parity) => {
      await expect(signAuthorization(signerReturning(sigWithParity(parity)), args)).rejects.toThrow(
        new RegExp(`invalid signature parity byte: ${parity}`),
      );
    },
  );

  it.each([
    [0, 0],
    [1, 1],
    [27, 0], // ecrecover v=27 encodes yParity 0
    [28, 1], // ecrecover v=28 encodes yParity 1
  ] as const)("normalizes parity byte %i to yParity %i", async (parity, expected) => {
    const auth = await signAuthorization(signerReturning(sigWithParity(parity)), args);
    expect(auth.yParity).toBe(expected);
    expect(auth.r).toBe(`0x${"11".repeat(32)}`);
    expect(auth.s).toBe(`0x${"11".repeat(32)}`);
  });

  it("refuses a malformed signature on the revocation path too", async () => {
    // signRevocation delegates to signAuthorization, so a bad signature must not be
    // laundered into a "valid" revocation tuple.
    await expect(
      signRevocation(signerReturning(sigWithParity(9)), { chainId: 31337, nonce: 0 }),
    ).rejects.toThrow("invalid signature parity byte: 9");
  });
});

describe("validateAuthorization fails closed on unexpected code", () => {
  it("reports a non-delegated EOA when the code is empty", async () => {
    expect(await validateAuthorization(clientWithCode("0x"), { address: EOA })).toEqual({
      delegated: false,
      implementation: null,
      revoked: false,
    });
  });

  it.each([
    ["a real contract", "0x608060405234801561001057600080fd5b50"],
    ["the 7702 prefix with a truncated address", `0xef0100${"00".repeat(10)}`],
    ["the 7702 prefix with an over-long address", `0xef0100${"11".repeat(21)}`],
    ["a prefix that merely looks like 7702", `0xef01ff${"11".repeat(20)}`],
  ])("refuses to interpret %s as a delegation", async (_label, code) => {
    await expect(
      validateAuthorization(clientWithCode(code as Hex), { address: EOA }),
    ).rejects.toThrow(/non-7702 code/);
  });

  it("never reports a non-delegated EOA as delegated, even for hostile code", async () => {
    // The fail-closed guarantee: a refusal must be a THROW, not a silent
    // { delegated: false } that a caller could read as "safe to proceed".
    const result = await validateAuthorization(clientWithCode("0xdeadbeef"), { address: EOA }).then(
      (status) => ({ threw: false, status }),
      (error: unknown) => ({ threw: true, message: (error as Error).message }),
    );
    expect(result.threw).toBe(true);
  });

  it("parses an exact 23-byte designator and reports the delegate", async () => {
    const code = `0xef0100${IMPL.slice(2).toLowerCase()}` as Hex;
    expect(await validateAuthorization(clientWithCode(code), { address: EOA })).toEqual({
      delegated: true,
      implementation: IMPL,
      revoked: false,
    });
  });

  it("distinguishes an explicit revoke designator from a real delegation", async () => {
    // 0xef0100 || 0x0*20 means "delegated to nothing". It must NOT be confused with
    // the zero address being a legitimate delegate target.
    const revoked = await validateAuthorization(
      clientWithCode(`0xef0100${"00".repeat(20)}` as Hex),
      { address: EOA },
    );
    expect(revoked).toEqual({ delegated: true, implementation: ZERO_ADDRESS, revoked: true });
  });

  it("does not accept a designator naming a different implementation", async () => {
    const code = `0xef0100${"00".repeat(19)}01` as Hex;
    expect(await isDelegatedTo(clientWithCode(code), { address: EOA, expectedImplementation: IMPL })).toBe(
      false,
    );
  });
});
