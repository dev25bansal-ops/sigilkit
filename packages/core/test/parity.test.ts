/**
 * Cross-wallet conformance seed: ethers v6 vs viem must produce byte-identical
 * EIP-712 digests and signatures for the same ActionRequest. This is the first
 * cell of the SigilKit cross-wallet matrix (the harness that fails CI when any
 * signer library diverges from the canonical digest).
 */
import { describe, expect, it } from "vitest";
import { Wallet, TypedDataEncoder } from "ethers";
import type { Address } from "viem";
import {
  actionRequestDigest,
  signActionRequest,
  type ActionRequest,
} from "../src/index.js";

const CHAIN_ID = 31337;
const MANAGER = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const REQUEST: ActionRequest = {
  agentId: ("0x" + "33".repeat(32)) as `0x${string}`,
  target: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  selector: "0x32145f90",
  value: 10n ** 16n,
  nonce: 0n,
  expiry: 1787654400,
  rationaleHash: ("0x" + "44".repeat(32)) as `0x${string}`,
  data: "0x0000000000000000000000000000000000000000000000000000000000000007",
};

// ethers-side message + types (same fields, ethers' own API shape)
const ETHERS_MESSAGE = {
  agentId: REQUEST.agentId,
  target: REQUEST.target,
  selector: REQUEST.selector,
  value: REQUEST.value,
  nonce: REQUEST.nonce,
  expiry: REQUEST.expiry,
  rationaleHash: REQUEST.rationaleHash,
  data: REQUEST.data,
};

const ETHERS_TYPES = {
  ActionRequest: [
    { name: "agentId", type: "bytes32" },
    { name: "target", type: "address" },
    { name: "selector", type: "bytes4" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint48" },
    { name: "rationaleHash", type: "bytes32" },
    { name: "data", type: "bytes" },
  ],
};

const ETHERS_DOMAIN = {
  name: "SigilKit",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: MANAGER,
};

describe("cross-wallet conformance: viem ↔ ethers", () => {
  const viemDigest = actionRequestDigest({
    request: REQUEST,
    chainId: CHAIN_ID,
    verifyingContract: MANAGER,
  });

  it("digests are byte-identical", () => {
    const ethersDigest = TypedDataEncoder.hash(ETHERS_DOMAIN, ETHERS_TYPES, ETHERS_MESSAGE);
    expect(viemDigest.toLowerCase()).toBe(ethersDigest.toLowerCase());
  });

  it("signatures are byte-identical across libraries", async () => {
    // Path A: viem computes the digest, ethers signs it.
    const wallet = new Wallet(PRIVATE_KEY);
    const sigFromViemDigest = wallet.signingKey.sign(viemDigest).serialized;

    // Path B: ethers computes AND signs its own digest end-to-end.
    const sigFromEthersEndToEnd = await wallet.signTypedData(
      ETHERS_DOMAIN,
      ETHERS_TYPES,
      ETHERS_MESSAGE,
    );

    expect(sigFromViemDigest.toLowerCase()).toBe(sigFromEthersEndToEnd.toLowerCase());

    // Path C: the SDK's signActionRequest (viem account abstraction) agrees too.
    const sdkSig = await signActionRequest({
      account: {
        sign: async ({ hash }: { hash: `0x${string}` }) =>
          wallet.signingKey.sign(hash).serialized as `0x${string}`,
      },
      request: REQUEST,
      chainId: CHAIN_ID,
      verifyingContract: MANAGER,
    });
    expect(sdkSig.toLowerCase()).toBe(sigFromEthersEndToEnd.toLowerCase());
  });

  it("SDK signature recovers to the signer via ethers", async () => {
    const wallet = new Wallet(PRIVATE_KEY);
    const sdkSig = await signActionRequest({
      account: {
        sign: async ({ hash }: { hash: `0x${string}` }) =>
          wallet.signingKey.sign(hash).serialized as `0x${string}`,
      },
      request: REQUEST,
      chainId: CHAIN_ID,
      verifyingContract: MANAGER,
    });
    // Recover via viem (cross-library check: ethers-signed → viem-recovered).
    const { recoverAddress } = await import("viem");
    const recovered = await recoverAddress({ hash: viemDigest, signature: sdkSig });
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});
