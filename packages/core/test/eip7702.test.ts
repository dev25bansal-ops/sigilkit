/**
 * EIP-7702 library tests.
 *
 * The digest fixture below is EXTERNALLY derived (cast keccak on the hand-built
 * RLP pre-image), so the test does not merely re-run our own encoder against itself.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { hashAuthorization } from "viem/utils";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  authorizationDigest,
  isDelegatedTo,
  rlpEncodeAddress,
  signAuthorization,
  signRevocation,
  toAuthorizationTuple,
  validateAuthorization,
  ZERO_ADDRESS,
} from "../src/index.js";
import { spawnAnvil, stopAnvil, ANVIL_URL } from "./anvil.js";

// Reference: chainId=31337 (0x7a69), address=0x9858EfFD232B4033E47d90003D41EC34EcaEda94,
// nonce=0 → rlp = d9 827a69 94<addr> 80; digest = keccak(0x05 || rlp), computed
// externally via `cast keccak 0x05d9827a6994…80` (hex input!).
const FIXTURE = {
  chainId: 31337,
  contractAddress: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" as const,
  nonce: 0,
  expectedDigest: "0x171214f8fde84fdd43a5a188993c4ac766b003aee09cd0c5af13f3b12b2c9206" as const,
};

describe("eip7702", () => {
  it("digest matches externally-computed reference (cast)", () => {
    const digest = authorizationDigest(FIXTURE);
    expect(digest).toBe(FIXTURE.expectedDigest);
  });

  // Canonical digests below were generated ONCE by running viem's
  // hashAuthorization (viem 2.55.19, `viem/utils`) against these inputs via a
  // scratch script, then hardcoded — the assertions do not merely re-run our
  // encoder; they pin byte-for-byte parity with the canonical implementation.
  const CANONICAL_VECTORS = [
    // revocation target: all-zero address must stay a 20-byte RLP string (0x94 ‖ 00×20), never 0x80
    { chainId: 1, contractAddress: "0x0000000000000000000000000000000000000000", nonce: 0,
      expected: "0x20aed0d1fcfcae79908c669252609bf10de3cc521c36d631c62eea3e826c79ad" },
    // leading-zero address (first byte 0x00) — scalar encoding stripped these bytes pre-fix
    { chainId: 31337, contractAddress: "0x00000000000000000000000000000000deadbeef", nonce: 7,
      expected: "0xad56f3cc0a77af21df174078629624b498a3e89225e7d85c2315b0ba6ea30423" },
    { chainId: 11155111, contractAddress: "0x0033A15088465B7190795AB95b38323aF2c2fB93", nonce: 42,
      expected: "0xe6b8ac4638ae97bc9a6f6dc472aadfd4bd29310a6cbdb68a3a18d4921d3a8ba4" },
    { chainId: 10, contractAddress: "0x0000000000000000000000000000000000000001", nonce: 123456789,
      expected: "0xdcda88664002d724b0a3ec1e6e50a7799dc7f208b5927ae95dae167f05378697" },
    // no leading zero: old scalar path happened to agree with canonical here
    { chainId: 1, contractAddress: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", nonce: 5,
      expected: "0x9a272759d7ec82633dfe236be5070426c4abf085b2b5eaf172a9f74b39440b31" },
    { chainId: 84532, contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7", nonce: 1,
      expected: "0x1989a4475e41d94911366c545f699464096e203beb5e536d6c6c91d215670ed7" },
    { chainId: 137, contractAddress: "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e", nonce: 999999,
      expected: "0xb7a42be5ec888980df3daf9641b3701c478e090fd96bdbbaeb3609a683bdbb65" },
    { chainId: 31337, contractAddress: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", nonce: 0,
      expected: "0x171214f8fde84fdd43a5a188993c4ac766b003aee09cd0c5af13f3b12b2c9206" },
  ] as const;

  it("digest matches canonical viem hashAuthorization fixtures", () => {
    for (const v of CANONICAL_VECTORS) {
      expect(authorizationDigest(v)).toBe(v.expected);
      // cross-check against live viem too (viem is a direct dependency)
      expect(authorizationDigest(v)).toBe(
        hashAuthorization({ contractAddress: v.contractAddress, chainId: v.chainId, nonce: v.nonce }),
      );
    }
  });

  it("rlpEncodeAddress always emits a fixed 20-byte string item", () => {
    // all-zero payload stays a string item (0x94 prefix + 20 zero bytes), NOT 0x80
    expect(rlpEncodeAddress(ZERO_ADDRESS)).toBe(
      ("0x94" + "00".repeat(20)) as ReturnType<typeof rlpEncodeAddress>,
    );
    expect(rlpEncodeAddress("0x00000000000000000000000000000000deadbeef")).toBe(
      ("0x94" + "00".repeat(16) + "deadbeef") as ReturnType<typeof rlpEncodeAddress>,
    );
    expect(rlpEncodeAddress(FIXTURE.contractAddress)).toBe(
      ("0x94" + FIXTURE.contractAddress.slice(2).toLowerCase()) as ReturnType<typeof rlpEncodeAddress>,
    );
  });

  it("digest is deterministic and field-sensitive", () => {
    const base = authorizationDigest({ chainId: 1, contractAddress: FIXTURE.contractAddress, nonce: 5 });
    expect(base).toBe(authorizationDigest({ chainId: 1, contractAddress: FIXTURE.contractAddress, nonce: 5 }));
    // every field changes the digest
    expect(base).not.toBe(authorizationDigest({ chainId: 2, contractAddress: FIXTURE.contractAddress, nonce: 5 }));
    expect(base).not.toBe(authorizationDigest({ chainId: 1, contractAddress: ZERO_ADDRESS, nonce: 5 }));
    expect(base).not.toBe(authorizationDigest({ chainId: 1, contractAddress: FIXTURE.contractAddress, nonce: 6 }));
  });

  it("large values encode correctly (multi-byte RLP lengths)", () => {
    // chainId near uint64 max exercises multi-length-prefix RLP paths without throwing
    const bigChain = 18446744073709551615n;
    const d = authorizationDigest({ chainId: bigChain, contractAddress: ZERO_ADDRESS, nonce: 2n ** 64n });
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
    // determinism across bigint/number forms
    expect(
      authorizationDigest({ chainId: 70000, contractAddress: ZERO_ADDRESS, nonce: 300 }),
    ).toBe(authorizationDigest({ chainId: 70000n, contractAddress: ZERO_ADDRESS, nonce: 300n }));
  });

  it("signAuthorization produces a valid tuple; revocation targets 0x0", async () => {
    const account = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const auth = await signAuthorization(account, {
      contractAddress: FIXTURE.contractAddress,
      chainId: 31337,
      nonce: 0,
    });
    expect(auth.r).toHaveLength(66);
    expect(auth.s).toHaveLength(66);
    expect([0, 1]).toContain(auth.yParity);

    const tuple = toAuthorizationTuple(auth);
    expect(tuple[0]).toBe("0x7a69"); // 31337 minimal hex
    expect(tuple[1]).toBe(FIXTURE.contractAddress);
    expect(tuple[3]).toMatch(/^0x[01]$/);

    const revocation = await signRevocation(account, { chainId: 31337, nonce: 1 });
    expect(revocation.contractAddress).toBe(ZERO_ADDRESS);
    // different nonce → different signature
    expect(revocation.r + revocation.s).not.toBe(auth.r + auth.s);
  });

  describe("validateAuthorization against anvil", () => {
    let cleanup: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      cleanup = await spawnAnvil();
    }, 60000);

    afterAll(async () => {
      await cleanup?.();
    });

    it("reads delegation designator set via anvil_setCode", async () => {
      const client = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
      const eoa = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
      const impl = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

      // not delegated initially
      expect(await validateAuthorization(client, { address: eoa })).toEqual({
        delegated: false,
        implementation: null,
        revoked: false,
      });

      // set 0xef0100 || impl
      await (client.request as (args: { method: string; params: unknown[] }) => Promise<void>)({
        method: "anvil_setCode",
        params: [eoa, ("0xef0100" + impl.slice(2)) as `0x${string}`],
      });
      const status = await validateAuthorization(client, { address: eoa });
      expect(status.delegated).toBe(true);
      expect(status.revoked).toBe(false);
      expect(await isDelegatedTo(client, { address: eoa, expectedImplementation: impl })).toBe(true);
      expect(
        await isDelegatedTo(client, {
          address: eoa,
          expectedImplementation: "0x0000000000000000000000000000000000000001",
        }),
      ).toBe(false);

      // explicit revocation designator (0xef0100 || 0x0)
      await (client.request as (args: { method: string; params: unknown[] }) => Promise<void>)({
        method: "anvil_setCode",
        params: [eoa, ("0xef0100" + "00".repeat(20)) as `0x${string}`],
      });
      const revokedStatus = await validateAuthorization(client, { address: eoa });
      expect(revokedStatus.delegated).toBe(true);
      expect(revokedStatus.revoked).toBe(true);

      void stopAnvil;
    });
  });
});
