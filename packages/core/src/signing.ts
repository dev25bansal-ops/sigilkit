import type { ActionRequest, ExecuteArgs, Scope } from "./types.js";
import { ACTION_REQUEST_TYPEHASH } from "./types.js";
import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  isHex,
  keccak256,
  toHex,
  type Address,
  type Chain,
  type Hash,
  type Hex,
} from "viem";

/** Minimal signer surface needed for signing — any viem account satisfies it. */
export interface HashSigner {
  sign: (args: { hash: Hash }) => Promise<Hex>;
}

/**
 * Builds the EIP-712 digest for an ActionRequest exactly as SessionKeyManager does on-chain.
 */
export function actionRequestDigest(args: {
  request: ActionRequest;
  chainId: number;
  verifyingContract: Address;
}): Hash {
  const { request, chainId, verifyingContract } = args;

  // Guard against non-0x-prefixed calldata sneaking into the typed-data hash
  // (e.g. from naive selector-stripping), which silently changes the digest.
  const data = isHex(request.data, { strict: false }) && request.data.startsWith("0x")
    ? request.data
    : ("0x" + request.data.replace(/^0x/, "")) as Hex;
  if (!isHex(data)) {
    throw new Error(`actionRequestDigest: request.data is not valid hex: ${request.data}`);
  }

  return hashTypedData({
    domain: {
      name: "SigilKit",
      version: "1",
      chainId,
      verifyingContract,
    },
    types: {
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
    },
    primaryType: "ActionRequest",
    message: {
      agentId: request.agentId,
      target: request.target,
      selector: request.selector,
      value: request.value,
      nonce: request.nonce,
      expiry: request.expiry,
      rationaleHash: request.rationaleHash,
      data,
    },
  });
}

/**
 * Signs an ActionRequest with a viem account (the session key).
 */
export async function signActionRequest(args: {
  account: HashSigner
  request: ActionRequest;
  chainId: number;
  verifyingContract: Address;
}): Promise<Hex> {
  const digest = actionRequestDigest({
    request: args.request,
    chainId: args.chainId,
    verifyingContract: args.verifyingContract,
  });
  return args.account.sign({ hash: digest });
}

/**
 * Computes the Merkle leaf for a (target, selector) pair:
 * keccak256(abi.encode(target, selector)) — matches on-chain leaf construction.
 */
export function targetLeaf(target: Address, selector: Hex): Hash {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes4" }],
      [target, selector],
    ),
  );
}

/**
 * Builds a sorted-pair Merkle root over the given leaves (matches on-chain verification).
 */
export function merkleRoot(leaves: Hash[]): Hash {
  if (leaves.length === 0) {
    throw new Error("merkleRoot: at least one leaf required");
  }
  let level = [...leaves].sort();
  while (level.length > 1) {
    const next: Hash[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]!);
      } else {
        next.push(sortedPairHash(level[i]!, level[i + 1]!));
      }
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Produces the Merkle proof for `leaf` against `leaves` (sorted-pair scheme).
 */
export function merkleProof(leaves: Hash[], leaf: Hash): Hex[] {
  let level = [...leaves].sort();
  const proof: Hex[] = [];
  let current = leaf;

  let idx = level.findIndex((l) => l === current);
  if (idx === -1) throw new Error("merkleProof: leaf not in set");

  while (level.length > 1) {
    if (idx % 2 === 0) {
      if (idx + 1 < level.length) proof.push(level[idx + 1]!);
    } else {
      proof.push(level[idx - 1]!);
    }
    const next: Hash[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]!);
      } else {
        next.push(sortedPairHash(level[i]!, level[i + 1]!));
      }
    }
    level = next;
    idx = Math.floor(idx / 2);
    // Recompute position of current node's hash in the parent level.
    const parentHash =
      idx >= 0 && idx < next.length ? next[idx]! : undefined;
    if (parentHash !== undefined) current = parentHash;
  }
  return proof;
}

function sortedPairHash(a: Hash, b: Hash): Hash {
  return a.toLowerCase() < b.toLowerCase()
    ? keccak256(concat([a, b]))
    : keccak256(concat([b, a]));
}

/**
 * Local pre-flight check mirroring SpendPolicy.enforce — rejects policy violations
 * BEFORE any signature is created (zero gas, ~5ms), per the whitepaper data flow.
 */
export function validateAgainstScope(args: {
  request: Pick<ActionRequest, "value" | "expiry">;
  scope: Scope;
  windowState?: { windowStart: number; spentThisWindow: bigint };
}): { ok: true } | { ok: false; reason: string } {
  const { request, scope, windowState } = args;
  const now = Math.floor(Date.now() / 1000);

  if (request.value > scope.perActionCap) {
    return { ok: false, reason: `per-action cap exceeded (${request.value} > ${scope.perActionCap})` };
  }

  let base = 0n;
  if (
    windowState &&
    windowState.windowStart !== 0 &&
    now < windowState.windowStart + scope.windowSeconds
  ) {
    base = windowState.spentThisWindow;
  }
  if (base + request.value > scope.perWindowCap) {
    return { ok: false, reason: `per-window cap exceeded (${base + request.value} > ${scope.perWindowCap})` };
  }
  if (request.expiry <= now) {
    return { ok: false, reason: "request already expired" };
  }
  return { ok: true };
}
