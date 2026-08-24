import type { ActionRequest, ExecuteArgs, Scope } from "./types.js";
import { ACTION_REQUEST_TYPEHASH } from "./types.js";
import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  isAddress,
  isHex,
  keccak256,
  toHex,
  zeroHash,
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
 *
 * Every field is validated up front via parseActionRequest, so deserialized
 * (JSON-round-tripped) requests fail loudly here instead of producing a wrong
 * digest or a TypeError mid-encode.
 */
export function actionRequestDigest(args: {
  request: ActionRequest;
  chainId: number;
  verifyingContract: Address;
}): Hash {
  const { chainId, verifyingContract } = args;

  // Normalize a missing 0x prefix on data first (naive selector-stripping drops it),
  // which would otherwise be rejected as non-hex; then validate everything strictly.
  const rawData: unknown = args.request.data;
  const dataIn =
    typeof rawData === "string" && rawData !== "" && !rawData.startsWith("0x")
      ? "0x" + rawData
      : rawData;
  const request = parseActionRequest({ ...args.request, data: dataIn });

  // isHex alone does NOT reject odd-length hex ('0x123' matches /^0x[0-9a-fA-F]*$/);
  // parseActionRequest enforces even length, so bytes data is always ABI-encodable here.
  const data = request.data;

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
 * Normalizes an untrusted (e.g. JSON-deserialized) value into a validated
 * ActionRequest. JSON has no bigint, so `value`/`nonce` may arrive as strings or
 * numbers — this coerces them via BigInt() and validates every field's shape so a
 * malformed request fails loudly here instead of producing a wrong digest or a
 * TypeError mid-ABI-encode.
 *
 * Throws Error with a field-prefixed message on any invalid input.
 */
export function parseActionRequest(raw: unknown): ActionRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("parseActionRequest: expected an ActionRequest object");
  }
  const r = raw as Record<string, unknown>;

  const req = (field: string): unknown => {
    if (!(field in r) || r[field] === undefined) {
      throw new Error(`parseActionRequest: missing required field '${field}'`);
    }
    return r[field];
  };
  const hexStr = (field: string, v: unknown): string => {
    if (typeof v !== "string" || !isHex(v)) {
      throw new Error(`parseActionRequest: ${field} is not valid hex: ${String(v)}`);
    }
    return v;
  };

  // bytes32 fields: exactly 32 bytes.
  const agentId = hexStr("agentId", req("agentId"));
  if (agentId.length !== 2 + 64) {
    throw new Error(
      `parseActionRequest: agentId must be 32-byte hex, got ${agentId.length / 2 - 1} bytes`,
    );
  }
  const rationaleHash = hexStr("rationaleHash", req("rationaleHash"));
  if (rationaleHash.length !== 2 + 64) {
    throw new Error(
      `parseActionRequest: rationaleHash must be 32-byte hex, got ${rationaleHash.length / 2 - 1} bytes`,
    );
  }

  // address: accept checksummed or lowercase, normalize to lowercase.
  const targetRaw = req("target");
  if (typeof targetRaw !== "string" || !isAddress(targetRaw)) {
    throw new Error(`parseActionRequest: target is not a valid address: ${String(targetRaw)}`);
  }
  const target = targetRaw.toLowerCase() as Address;

  // bytes4 selector: exactly 4 bytes.
  const selector = hexStr("selector", req("selector"));
  if (selector.length !== 2 + 8) {
    throw new Error(
      `parseActionRequest: selector must be 4-byte hex, got ${(selector.length - 2) / 2} bytes`,
    );
  }

  // uint256 fields may arrive as bigint (in-process), number, or numeric string (JSON).
  const bigintValue = (field: string, v: unknown): bigint => {
    try {
      const b = BigInt(v as string | number | bigint);
      if (b < 0n) throw new Error("negative");
      return b;
    } catch {
      throw new Error(`parseActionRequest: ${field} is not a valid uint256: ${String(v)}`);
    }
  };
  const value = bigintValue("value", req("value"));
  const nonce = bigintValue("nonce", req("nonce"));

  const expiryRaw = req("expiry");
  let expiry: number;
  try {
    expiry = Number(expiryRaw as number | bigint);
  } catch {
    throw new Error(`parseActionRequest: expiry is not a valid uint48: ${String(expiryRaw)}`);
  }
  if (!Number.isFinite(expiry) || expiry < 0 || expiry > 2 ** 48 - 1) {
    throw new Error(`parseActionRequest: expiry is not a valid uint48: ${String(expiryRaw)}`);
  }

  // bytes data: valid, even-length hex ('0x' allowed for empty calldata).
  const dataRaw = req("data");
  if (typeof dataRaw !== "string" || !isHex(dataRaw) || dataRaw.length % 2 !== 0) {
    throw new Error(`parseActionRequest: data is not valid even-length hex: ${String(dataRaw)}`);
  }
  const data = dataRaw as Hex;

  return { agentId, target, selector, value, nonce, expiry, rationaleHash, data } as ActionRequest;
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
 *
 * Checks, in order:
 *  1. scope hard expiry (`scope.expiresAt`) — independent of the request's own expiry
 *  2. per-action spend cap
 *  3. per-window spend cap (against the current window state when available)
 *  4. request expiry
 *  5. Merkle target whitelist membership when the scope has a non-zero merkleRoot
 *     and a proof was supplied locally (on-chain verification still applies)
 */
export function validateAgainstScope(args: {
  request: ActionRequest;
  scope: Scope;
  windowState?: { windowStart: number; spentThisWindow: bigint };
  merkleProof?: Hex[];
}): { ok: true } | { ok: false; reason: string } {
  const { request, scope, windowState } = args;
  const nowSec = Math.floor(Date.now() / 1000);

  if (nowSec >= scope.expiresAt) {
    return { ok: false, reason: "scope hard-expired" };
  }

  if (request.value > scope.perActionCap) {
    return { ok: false, reason: `per-action cap exceeded (${request.value} > ${scope.perActionCap})` };
  }

  let base = 0n;
  if (
    windowState &&
    windowState.windowStart !== 0 &&
    nowSec < windowState.windowStart + scope.windowSeconds
  ) {
    base = windowState.spentThisWindow;
  }
  if (base + request.value > scope.perWindowCap) {
    return { ok: false, reason: `per-window cap exceeded (${base + request.value} > ${scope.perWindowCap})` };
  }
  if (request.expiry <= nowSec) {
    return { ok: false, reason: "request already expired" };
  }

  // Local mirror of the on-chain whitelist: when the scope pins a merkleRoot and a
  // proof is available, verify membership before burning a signature.
  if (scope.merkleRoot && scope.merkleRoot !== zeroHash) {
    if (!args.merkleProof) {
      return { ok: false, reason: "target not whitelisted" };
    }
    const leaf = targetLeaf(request.target, request.selector);
    let node = leaf;
    for (let i = 0; i < args.merkleProof.length; i++) {
      node = sortedPairHash(node, args.merkleProof[i]!);
    }
    if (node.toLowerCase() !== scope.merkleRoot.toLowerCase()) {
      return { ok: false, reason: "target not whitelisted" };
    }
  }

  return { ok: true };
}
