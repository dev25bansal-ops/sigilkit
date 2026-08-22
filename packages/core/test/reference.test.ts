/**
 * Third conformance leg: a REFERENCE EIP-712 implementation, hand-rolled without viem's
 * or ethers' typed-data encoders (keccak256 used purely as a hash primitive — hashing is
 * uncontested; what we are cross-checking is the ENCODING logic).
 *
 * Combined with parity.test.ts (viem ↔ ethers byte-identical), this establishes
 * three independent encoders agreeing on the canonical ActionRequest digest.
 */
import { describe, expect, it } from "vitest";
import { concat, keccak256, recoverAddress, toHex, type Hash, type Hex } from "viem";
import { Wallet } from "ethers";
import { actionRequestDigest, ACTION_REQUEST_TYPEHASH } from "../src/index.js";
import type { ActionRequest } from "../src/index.js";

// ---------------------------------------------------------------------------
// Minimal hand-rolled ABI/EIP-712 encoding (fixed to the ActionRequest shape)
// ---------------------------------------------------------------------------

/** Left-aligns a value into a 32-byte word: zeros FIRST (ABI rule for address/uintN). */
function padWordLeft(hexNoPrefix: string): Hex {
  return ("0x" + hexNoPrefix.padStart(64, "0")) as Hex;
}

/** Right-aligns a value into a 32-byte word: zeros AFTER (ABI rule for bytesN). */
function padWordRight(hexNoPrefix: string): Hex {
  return ("0x" + hexNoPrefix.padEnd(64, "0")) as Hex;
}

/** Encodes one scalar slot per Solidity ABI rules for our fixed field types. */
function encodeSlot(type: string, value: unknown): Hex {
  switch (type) {
    case "bytes32":
      return value as Hex;
    case "address":
      return padWordLeft((value as Hex).slice(2)); // zeros then address
    case "bytes4":
      return padWordRight((value as Hex).slice(2)); // selector then zeros
    case "uint48":
    case "uint256":
      return padWordLeft(BigInt(value as number | bigint).toString(16));
    default:
      throw new Error(`unsupported reference type ${type}`);
  }
}

const FIELD_TYPES = [
  "bytes32", // agentId
  "address", // target
  "bytes4", // selector
  "uint256", // value
  "uint256", // nonce
  "uint48", // expiry
  "bytes32", // rationaleHash
] as const;

/** hashStruct with dynamic `bytes data` hashed separately (EIP-712 rule). */
function referenceStructHash(req: ActionRequest): Hash {
  const staticSlots = FIELD_TYPES.map((t, i) => {
    const v = [
      req.agentId,
      req.target,
      req.selector,
      req.value,
      req.nonce,
      req.expiry,
      req.rationaleHash,
    ][i];
    return encodeSlot(t, v);
  });
  const dataHash = keccak256(req.data);
  return keccak256(concat([ACTION_REQUEST_TYPEHASH, ...staticSlots, dataHash]));
}

function referenceDomainSeparator(chainId: number, verifyingContract: Hex): Hash {
  const domainTypehash = keccak256(
    toHex(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    ),
  );
  return keccak256(
    concat([
      domainTypehash,
      keccak256(toHex("SigilKit")),
      keccak256(toHex("1")),
      padWordLeft(BigInt(chainId).toString(16)),
      padWordLeft(verifyingContract.slice(2)),
    ]),
  );
}

function referenceDigest(req: ActionRequest, chainId: number, verifyingContract: Hex): Hash {
  return keccak256(
    concat([
      "0x1901",
      referenceDomainSeparator(chainId, verifyingContract),
      referenceStructHash(req),
    ] as Hex[])
  );
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------
const CHAIN_ID = 31337;
const MANAGER = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Hex;
const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const REQUESTS: ActionRequest[] = [
  {
    agentId: ("0x" + "33".repeat(32)) as `0x${string}`,
    target: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    selector: "0x32145f90",
    value: 10n ** 16n,
    nonce: 0n,
    expiry: 1787654400,
    rationaleHash: ("0x" + "44".repeat(32)) as `0x${string}`,
    data: "0x0000000000000000000000000000000000000000000000000000000000000007",
  },
  {
    agentId: ("0x" + "00".repeat(31) + "01") as `0x${string}`,
    target: "0x000000000000000000000000000000000000dEaD",
    selector: "0xa9059cbb",
    value: 0n,
    nonce: 7n,
    expiry: 1,
    rationaleHash: ("0x" + "00".repeat(32)) as `0x${string}`,
    data: "0x",
  },
];

describe("conformance: hand-rolled reference encoder", () => {
  it.each(REQUESTS.map((r, i) => [i, r] as const))(
    "request #%i: reference digest === viem digest",
    (_i, req) => {
      expect(referenceDigest(req, CHAIN_ID, MANAGER)).toBe(
        actionRequestDigest({ request: req, chainId: CHAIN_ID, verifyingContract: MANAGER as `0x${string}` }),
      );
    },
  );

  it("signature over reference digest recovers to the right signer", async () => {
    const req = REQUESTS[0]!;
    const digest = referenceDigest(req, CHAIN_ID, MANAGER);
    const wallet = new Wallet(PRIVATE_KEY);
    const serialized = wallet.signingKey.sign(digest).serialized as `0x${string}`;
    const recovered = await recoverAddress({ hash: digest, signature: serialized });
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("domain binding: different chainId changes the reference digest", () => {
    const req = REQUESTS[0]!;
    const a = referenceDigest(req, 1, MANAGER);
    const b = referenceDigest(req, 2, MANAGER);
    expect(a).not.toBe(b);
  });
});
