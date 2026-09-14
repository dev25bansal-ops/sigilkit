import type { ActionRequest, ExecuteArgs, Scope } from "./types.js";
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
 * Computes the Merkle leaf for a (target, selector) pair — leaf format v2, matching
 * the on-chain construction in SessionKeyManager/SessionKey7579Module.
 *
 * Without `data` this returns the WILDCARD leaf (argsHash = 0: the selector is
 * whitelisted for ANY calldata). With `data` it returns the PINNED leaf, which
 * commits keccak256(data) so the whitelisted entry only authorizes that exact
 * calldata — e.g. one specific token transfer amount and recipient.
 *
 * leaf = keccak256(abi.encode(target, selector, argsHash)); keccak256 of real data
 * is never zero, so pinned and wildcard leaves never collide.
 */
export function targetLeaf(target: Address, selector: Hex, data?: Hex): Hash {
  const argsHash = data === undefined ? zeroHash : keccak256(data);
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes4" }, { type: "bytes32" }],
      [target, selector, argsHash],
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
 * Position tracking is purely index-arithmetic: the level array is sorted once and
 * parent positions follow floor(idx/2), so no hash lookups are needed after the
 * initial findIndex.
 */
export function merkleProof(leaves: Hash[], leaf: Hash): Hex[] {
  let level = [...leaves].sort();
  const proof: Hex[] = [];

  let idx = level.findIndex((l) => l === leaf);
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
  }
  return proof;
}

function sortedPairHash(a: Hash, b: Hash): Hash {
  return a.toLowerCase() < b.toLowerCase()
    ? keccak256(concat([a, b]))
    : keccak256(concat([b, a]));
}

/**
 * Local pre-flight check mirroring the on-chain enforcement core — rejects policy violations
 * BEFORE any signature is created (zero gas, ~5ms), per the whitepaper data flow.
 *
 * CONFORMANCE CONTRACT (CQ-5). Every check below is a mirror of a specific on-chain check,
 * and each is pinned by a boundary test so the two cannot silently diverge:
 *
 *  | # | check                       | on-chain counterpart                                   | boundary test |
 *  |---|-----------------------------|--------------------------------------------------------|---------------|
 *  | 1 | scope hard expiry           | `SessionKeyManager`: `block.timestamp > scope.expiresAt`| `validate.test.ts` "scope-expiry boundary" |
 *  | 2 | per-action cap              | `SpendPolicy.enforce`: `value > perActionCap`          | `validate.test.ts` |
 *  | 3 | per-window cap              | `SpendPolicy.enforce`: `projected > perWindowCap`      | `validate.test.ts` |
 *  | 4 | request expiry              | `SessionKeyManager`: `block.timestamp > request.expiry`| `validate.test.ts` "Q5" |
 *  | 5 | Merkle target whitelist     | `SessionKeyManager._targetAllowed` (pinned OR wildcard)| `merkle.test.ts` |
 *
 * Comparisons are written in the same direction and with the same inclusivity as the
 * contract (`>` means "strictly past", so equality is still valid). This is advisory only:
 * on-chain enforcement remains the sole authority.
 */
export function validateAgainstScope(args: {
  request: ActionRequest;
  scope: Scope;
  windowState?: { windowStart: number; spentThisWindow: bigint };
  merkleProof?: Hex[];
}): { ok: true } | { ok: false; reason: string } {
  const { request, scope, windowState } = args;
  const nowSec = Math.floor(Date.now() / 1000);

  // Mirrors the contract's `block.timestamp > scope.expiresAt` revert
  // (SessionKeyManager._validate): the key is valid THROUGH its expiry second, so
  // `nowSec == scope.expiresAt` is still accepted on-chain. Using `>=` here rejected a
  // request one second before the chain would, so the client refused transactions the
  // enforcement core would have allowed (BUG-3, fixed 2026-09-12).
  if (nowSec > scope.expiresAt) {
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
  // Mirrors the contract's `block.timestamp > request.expiry` revert: a request is
  // valid through its expiry second (Q5 off-by-one alignment — previously the local
  // check was stricter by one second).
  if (request.expiry < nowSec) {
    return { ok: false, reason: "request already expired" };
  }

  // Local mirror of the on-chain whitelist (leaf format v2): when the scope pins a
  // merkleRoot and a proof is available, verify membership before burning a signature.
  // The proof must verify against the pinned leaf (commits this request's calldata)
  // or the wildcard leaf — exactly like the contract's _targetAllowed.
  if (scope.merkleRoot && scope.merkleRoot !== zeroHash) {
    if (!args.merkleProof) {
      return { ok: false, reason: "target not whitelisted" };
    }
    const leafMatches = (leaf: Hash): boolean => {
      let node = leaf;
      for (let i = 0; i < args.merkleProof!.length; i++) {
        node = sortedPairHash(node, args.merkleProof![i]!);
      }
      return node.toLowerCase() === scope.merkleRoot!.toLowerCase();
    };
    const wildcardLeaf = targetLeaf(request.target, request.selector);
    const pinnedLeaf = targetLeaf(request.target, request.selector, request.data);
    if (!leafMatches(wildcardLeaf) && !leafMatches(pinnedLeaf)) {
      return { ok: false, reason: "target not whitelisted" };
    }
  }

  return { ok: true };
}
