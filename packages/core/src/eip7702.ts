/**
 * EIP-7702 authorization primitives.
 *
 * An EIP-7702 authorization tuple is signed over
 *   keccak256(MAGIC || rlp([chain_id, address, nonce]))   with MAGIC = 0x05
 * — plain RLP pre-image hashing, NOT EIP-712 typed data.
 * Revocation = re-authorizing with address = 0x0.
 */
import {
  concat,
  getAddress,
  hexToBytes,
  keccak256,
  numberToHex,
  pad,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { ValidationError, toUnsignedBigInt, MAX_UINT256 } from "./validation.js";
import type { HashSigner } from "./types.js";

/** EIP-7702 magic byte prefixing the RLP pre-image. */
export const AUTHORIZATION_MAGIC = "0x05" as const;
/** Zero address — signing an authorization to it clears delegation ("revoke"). */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/**
 * A signed EIP-7702 authorization tuple ([chain_id, address, nonce, y_parity, r, s]).
 *
 * `chainId`/`nonce` are declared `bigint | number` for caller ergonomics, but the RLP
 * pre-image is only ever built from a **lossless** interpretation of them
 * ({@link toUnsignedBigInt}): a `number` above `Number.MAX_SAFE_INTEGER` no longer denotes the
 * value it was written as, and `BigInt(2**53 + 1)` is 9007199254740992 — a *different* chain,
 * silently, inside a signature. Every entry point therefore rejects such input rather than
 * signing the wrong domain. Pass a bigint (or a decimal string) near that range.
 */
export interface Authorization {
  contractAddress: Address; // delegate target; 0x0 = revocation
  chainId: bigint | number;
  nonce: bigint | number;
  yParity: 0 | 1;
  r: Hex;
  s: Hex;
}

/**
 * Lossless `chainId`/`nonce` coercion shared by the digest and the tuple serializer.
 *
 * A *type whitelist*, not a coercion: `bigint` (any non-negative value), an `integer`
 * `number` — which must additionally be `Number.isSafeInteger`, see
 * {@link toUnsignedBigInt} — or a bare decimal string. Everything else throws a
 * {@link ValidationError} naming the field. In particular a negative or fractional value is
 * rejected here rather than surfacing as viem's uninformative `Invalid byte sequence ("-1" in
 * "-1")` from the RLP string path.
 */
function authorizationUint(field: string, v: unknown): bigint {
  const out = toUnsignedBigInt(v);
  if (out === null) {
    const shown = typeof v === "string" ? `"${v.length > 24 ? `${v.slice(0, 12)}…` : v}"` : String(v);
    throw new ValidationError(
      field,
      `expected a non-negative integer as bigint, safe integer number, or decimal string — an EIP-7702 ` +
        `chainId/nonce is part of the signed pre-image and must be represented exactly, got ${shown}`,
    );
  }
  return out;
}

// The signing surface is the same one the EIP-712 action path uses, so both share
// the single exported `HashSigner` from types.ts. It used to be re-declared here as
// a private `SignerLike` — structurally identical, which meant the two signing paths
// could drift with nothing to catch it, and a consumer could not name one type that
// satisfied both.
type SignerLike = HashSigner;

// ---------------------------------------------------------------------------
// Minimal RLP encoding (scalars only — sufficient for the 3-field pre-image)
// ---------------------------------------------------------------------------

/**
 * Encodes one scalar as an RLP string item with minimal big-endian bytes.
 *
 * RLP has no representation for a negative number, and the pre-image is a *signed* value, so
 * one must be rejected rather than encoded. It previously reached `hexToBytes` as the string
 * `"-1"` and failed with viem's `Invalid byte sequence ("-1" in "-1")` — technically safe, but
 * unreadable at the call site. This is a public export (pinned by the golden vectors), so the
 * contract is enforced here.
 */
export function rlpEncodeScalar(value: bigint): Hex {
  if (typeof value !== "bigint") {
    throw new ValidationError("value", `expected a bigint scalar to RLP-encode, got ${typeof value}`);
  }
  if (value < 0n) {
    throw new ValidationError("value", `RLP cannot encode a negative scalar (${value})`);
  }
  if (value === 0n) return "0x80";
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  const bytes = hexToBytes(("0x" + hex) as Hex);
  if (bytes.length === 1 && value < 0x80n) return ("0x" + hex) as Hex;
  // string item longer than 1 byte (<0x80 payload): prefix = 0x80 + len
  if (bytes.length > 55) {
    throw new ValidationError("value", `RLP scalar of ${bytes.length} bytes exceeds the single-byte length prefix (max 55)`);
  }
  return toHex(new Uint8Array([0x80 + bytes.length, ...bytes]));
}

/**
 * Encodes a 20-byte address as a fixed-length RLP string item.
 *
 * Canonical EIP-7702 signers (go-ethereum, viem's hashAuthorization) encode
 * the address field as EXACTLY 20 bytes: leading zeros are never stripped,
 * and an all-zero payload stays a 20-byte string item (`0x94 ‖ 20 × 0x00`),
 * NOT the empty-string encoding `0x80`. Using {@link rlpEncodeScalar} here
 * would produce digests diverging from canonical whenever the target has a
 * leading zero byte (~1/256 of addresses) and for every revocation (0x0).
 */
export function rlpEncodeAddress(address: Address): Hex {
  const bytes = pad(hexToBytes(getAddress(address)), { size: 20 });
  return toHex(new Uint8Array([0x80 + bytes.length, ...bytes])); // len 20 < 56 → single-byte prefix 0x94
}

/** Encodes a list of already-encoded items with a length prefix. */
export function rlpEncodeList(items: Hex[]): Hex {
  const payloads = items.map((i) => hexToBytes(i));
  const totalLen = payloads.reduce((n, p) => n + p.length, 0);
  const out: number[] = [];
  if (totalLen < 56) {
    out.push(0xc0 + totalLen);
  } else {
    const lenHex = totalLen.toString(16);
    const lenBytes = hexToBytes(
      ("0x" + (lenHex.length % 2 ? "0" + lenHex : lenHex)) as Hex,
    );
    out.push(0xf7 + lenBytes.length, ...lenBytes);
  }
  for (const p of payloads) out.push(...p);
  return toHex(new Uint8Array(out));
}

/**
 * Computes the EIP-7702 authorization digest:
 * `keccak256(0x05 || rlp([chainId, address, nonce]))`.
 *
 * ## Domain separation (EIP-7702's answer to cross-purpose replay)
 *
 * The pre-image is prefixed with the **magic byte `0x05`**, not with EIP-712's `0x1901`, and
 * is a plain RLP list rather than a typed-data struct hash. That is the whole point: an
 * authorization signature is a distinct signature type over a distinct pre-image, so it can
 * never be replayed as an EIP-712 ActionRequest signature (or vice versa) — the two pre-image
 * families are disjoint by construction, not by convention. The one thing that IS shared
 * across chains is `chainId` inside the tuple, which is the intended, spec-defined
 * cross-purpose lever: `chainId == 0` encodes a *valid* "all chains" authorization, and
 * {@link assertDelegationScope} exists to make that an explicit decision rather than an accident.
 *
 * The three tuple fields are order-fixed by the spec as `[chain_id, address, nonce]`, and are
 * encoded here in exactly that order.
 *
 * @param args.chainId the chain id; `0` is the valid "all chains" grant. A `bigint` or a
 *   safe-integer `number`.
 * @param args.contractAddress the delegate target, checksummed internally before encoding.
 * @param args.nonce the account nonce, in `[0, 2^256-1]`.
 * @returns the 32-byte digest to sign.
 * @throws {@link ValidationError} when `chainId`/`nonce` are negative, non-integral, or
 *   above `2^256-1`, or when `contractAddress` is not a valid address.
 * @example
 * ```ts
 * const digest = authorizationDigest({ chainId: 1, contractAddress: impl, nonce: 0n });
 * ```
 * @remarks Cost: three RLP encodes plus one keccak256 over ~30 bytes. Pure CPU, no I/O.
 */
export function authorizationDigest(args: {
  chainId: bigint | number;
  contractAddress: Address;
  nonce: bigint | number;
}): Hash {
  const chainId = authorizationUint("chainId", args.chainId);
  const nonce = authorizationUint("nonce", args.nonce);
  const address = getAddress(args.contractAddress);
  const preimage = rlpEncodeList([
    rlpEncodeScalar(chainId),
    rlpEncodeAddress(address), // fixed 20-byte string, canonical per go-ethereum/viem
    rlpEncodeScalar(nonce),
  ]);
  return keccak256(concat([AUTHORIZATION_MAGIC, preimage]));
}

/**
 * Signs an EIP-7702 authorization with `account`.
 * Set `contractAddress` to ZERO_ADDRESS (or use {@link signRevocation}) to revoke.
 *
 * @param account the signing identity. Only `sign` is required, so a hardware wallet or
 *   remote signer works as well as a local private-key account.
 * @param args.contractAddress the delegate target; {@link ZERO_ADDRESS} revokes.
 * @param args.chainId the chain the authorization is valid on. **`0` is meaningful** — it
 *   encodes an "all chains" authorization, a far broader grant than a specific chain.
 *   See {@link assertDelegationScope} before using it.
 * @param args.nonce the account's current nonce; must match the nonce the EOA will submit.
 * @returns the signed tuple with a normalized checksummed `contractAddress` and a
 *   `yParity` in {0, 1}.
 * @throws `Error` if the signature is not 65 bytes or its parity byte is not 0/1 (after
 *   ecrecover-style normalization).
 * @example
 * ```ts
 * const auth = await signAuthorization(account, {
 *   contractAddress: delegatorAddress,
 *   chainId: foundry.id,
 *   nonce: await getNonce(client, account.address),
 * });
 * await sendTransaction({ authorizationList: [toAuthorizationTuple(auth)] });
 * ```
 * @remarks Cost: one `account.sign` round-trip plus three RLP encodes. Signs only the
 *   authorization — it does not broadcast anything.
 */
export async function signAuthorization(
  account: SignerLike,
  args: {
    contractAddress: Address;
    chainId: bigint | number;
    nonce: bigint | number;
  },
): Promise<Authorization> {
  const digest = authorizationDigest(args);
  const sig = await account.sign({ hash: digest });
  const raw = hexToBytes(sig);
  if (raw.length !== 65) throw new Error(`expected 65-byte signature, got ${raw.length}`);
  const r = toHex(raw.slice(0, 32));
  const s = toHex(raw.slice(32, 64));
  const parityByte = raw[64] ?? 0;
  let v = parityByte;
  if (v >= 27) v -= 27; // normalize ecrecover-style v to yParity
  if (v !== 0 && v !== 1) throw new Error(`invalid signature parity byte: ${raw[64]}`);
  return {
    contractAddress: getAddress(args.contractAddress),
    // Reuse the digest's own coercion so the returned tuple can never describe a
    // different (chainId, nonce) than the one that was actually signed.
    chainId: authorizationUint("chainId", args.chainId),
    nonce: authorizationUint("nonce", args.nonce),
    yParity: v as 0 | 1,
    r,
    s,
  };
}

/** Signs a revocation authorization (delegate target = 0x0). */
export function signRevocation(
  account: SignerLike,
  args: { chainId: bigint | number; nonce: bigint | number },
): Promise<Authorization> {
  return signAuthorization(account, { ...args, contractAddress: ZERO_ADDRESS });
}

/** One over-half-order secp256k1 group order; `s` above it is non-canonical (EIP-2). */
const SECP256K1_N_DIV_2 = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Lossless minimal-hex form of a `uintN` for a type-4 `authorizationList` entry.
 *
 * `numberToHex` is documented for *numbers*; the tuple's fields are uint256, so this goes
 * through the bigint path explicitly. `viem`'s own client serializes a bigint chainId via
 * `numberToHex` too, and a bigint is one of its accepted forms, so the output is identical —
 * what changes is that an out-of-range value is now rejected here instead of being handed to
 * an RLP encoder.
 */
function uintToHex(value: bigint, field: string): Hex {
  if (value < 0n) throw new ValidationError(field, `must be a non-negative uint, got ${value}`);
  if (value > MAX_UINT256) {
    throw new ValidationError(field, `${value} exceeds the maximum ${MAX_UINT256} for a uint256 authorization field`);
  }
  return numberToHex(value);
}

/**
 * Serializes signed authorizations into a type-4 transaction `authorizationList` entry.
 *
 * Field order is the wire order defined by EIP-7702 and must match
 * `viem`'s `SerializedAuthorization` tuple **exactly**:
 * `[chainId, address, nonce, yParity, r, s]`. `signAuthorization` emits the struct in that
 * order, and this is the encoder for that same struct, so the two cannot drift.
 *
 * This is the last gate before a signature leaves the process, so it validates rather than
 * trusts: an `Authorization` is frequently assembled by hand (decoded from JSON, persisted to
 * a database, or assembled by a relayer), and a malformed one previously produced a
 * `SerializedAuthorization` the RPC layer could not encode meaningfully — or, worse, a
 * *well-formed but wrong* one: a 33-byte `chainId` (uint256 overflow), a `yParity` of 7, an
 * address that is not 20 bytes, or a high-`s` signature the chain rejects at authorization
 * recovery. Each of those is now a named error before the tuple exists.
 */
export function toAuthorizationTuple(auth: Authorization): [
  chainId: Hex,
  address: Address,
  nonce: Hex,
  yParity: Hex,
  r: Hex,
  s: Hex,
] {
  if (auth === null || typeof auth !== "object") {
    throw new ValidationError("authorization", `expected an Authorization object, got ${typeof auth}`);
  }
  const chainId = authorizationUint("chainId", auth.chainId);
  const nonce = authorizationUint("nonce", auth.nonce);
  if (chainId > MAX_UINT256) {
    throw new ValidationError("chainId", `${chainId} exceeds the maximum ${MAX_UINT256} for a uint256 authorization field`);
  }
  if (nonce > MAX_UINT256) {
    throw new ValidationError("nonce", `${nonce} exceeds the maximum ${MAX_UINT256} for a uint256 authorization field`);
  }
  if (auth.yParity !== 0 && auth.yParity !== 1) {
    throw new ValidationError("yParity", `expected 0 or 1, got ${String(auth.yParity)}`);
  }
  // getAddress enforces 20 bytes AND EIP-55 checksum, so a lowercase or mixed-case address
  // is normalized here and a wrong-length / non-hex one is rejected before it is serialized.
  const address = getAddress(auth.contractAddress);
  for (const [field, value] of [["r", auth.r], ["s", auth.s]] as const) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new ValidationError(field, `expected a 32-byte hex scalar, got ${String(value)}`);
    }
  }
  // EIP-2 malleability: a high-s signature cannot recover a signer and is rejected by the
  // chain at authorization recovery, so it must not leave the process either.
  if (BigInt(auth.s) > SECP256K1_N_DIV_2) {
    throw new ValidationError("s", `signature s is above the secp256k1 half-order and would be rejected on chain`);
  }
  return [
    uintToHex(chainId, "chainId"),
    address,
    uintToHex(nonce, "nonce"),
    uintToHex(BigInt(auth.yParity), "yParity"),
    `0x${auth.r.slice(2).toLowerCase()}`,
    `0x${auth.s.slice(2).toLowerCase()}`,
  ];
}

// ---------------------------------------------------------------------------
// On-chain validation
// ---------------------------------------------------------------------------

export interface DelegationStatus {
  delegated: boolean;
  /** The implementation the EOA currently delegates to (null when not delegated). */
  implementation: Address | null;
  revoked: boolean; // delegated specifically to 0x0 (explicitly revoked)
}

const DELEGATION_PREFIX = "0xef0100";
/** Full designator length: "0x" + 3 bytes prefix + 20 bytes address = 48 hex chars. */
const DELEGATION_CODE_LENGTH = 48;

/**
 * Reads an EOA's delegation designator: code must equal 0xef0100 || address.
 */
export async function validateAuthorization(
  publicClient: PublicClient,
  args: { address: Address },
): Promise<DelegationStatus> {
    const code = await publicClient.getCode({ address: args.address });
    if (!code || code === "0x") {
      return { delegated: false, implementation: null, revoked: false };
    }
    if (!code.startsWith(DELEGATION_PREFIX) || code.length !== DELEGATION_CODE_LENGTH) {
      throw new Error(`address has non-7702 code (${code.slice(0, 12)}…) — refusing to interpret`);
    }
    const implementation = getAddress(("0x" + code.slice(8)) as Hex) as Address;
    return {
      delegated: true,
      implementation,
      // The zero designator clears delegation entirely per EIP-7702, so on any
      // real network a revoked EOA surfaces as code 0x → delegated:false above.
      // This branch only fires when something explicitly sets 0xef0100||0x00*20
      // (e.g. anvil_setCode in tests).
      revoked: implementation === ZERO_ADDRESS,
    };
}

/** Scope decision for an authorization: which chains, which delegate, whether revoking. */
export interface DelegationScope {
  /**
   * The chain this authorization is meant for. Must equal the authorization's own `chainId`.
   * Use `0` to deliberately sign an "all chains" authorization — see
   * {@link assertDelegationScope} for why that must be explicit.
   */
  chainId: bigint | number;
  /** The delegate the EOA should end up pointing at. */
  implementation: Address;
  /** True to revoke (delegate target must be {@link ZERO_ADDRESS}). */
  revoke?: boolean;
  /**
   * Opt in to a `chainId == 0` ("valid on every chain") authorization. Off by default: a
   * wildcard authorization is a credential that works on chains the user has never seen, on
   * every future fork and every L2, and it is the exact shape an attacker asks for.
   */
  allowAllChains?: boolean;
}

/**
 * Checks an authorization's scope against the caller's intent, failing closed.
 *
 * EIP-7702 gives `chainId` two meanings: a concrete chain id, and the reserved value `0`, which
 * per spec means "this authorization is valid on any chain". A config-driven or LLM-driven
 * caller that ends up with `chainId: 0` — a missing chain id, an undefined variable, a defaulted
 * field — therefore produces a **chain-agnostic delegation credential** without ever intending
 * one. The failure is silent, produces a perfectly valid signature, and is only visible once a
 * delegation has already been installed on some other network.
 *
 * This is the one SDK-level guard that can catch it, so it is a *required, opt-in* step: call it
 * with the intent you meant, and it throws on a mismatch between intent and authorization, and
 * on an un-intended wildcard. For the E10 countersignature class of signature (where a session
 * key signs under a different domain or a different signer) the same accident is analogous but
 * out of scope for the 7702 surface — for a 7702 authorization, `chainId: 0` is by far the
 * largest single cross-purpose/cross-chain replay risk in the SDK.
 */
export function assertDelegationScope(
  authorization: Authorization,
  scope: DelegationScope,
): { chainId: bigint; implementation: Address; revoke: boolean } {
  if (authorization === null || typeof authorization !== "object") {
    throw new ValidationError("authorization", `expected an Authorization object, got ${typeof authorization}`);
  }
  if (scope === null || typeof scope !== "object") {
    throw new ValidationError("scope", `expected a DelegationScope object, got ${typeof scope}`);
  }
  const authChainId = authorizationUint("chainId", authorization.chainId);
  const wantChainId = authorizationUint("chainId", scope.chainId);
  const implementation = getAddress(scope.implementation);
  const revoke = scope.revoke === true;
  const authRevokes = isZeroAddressValue(authorization.contractAddress);
  const authDelegates = getAddress(authorization.contractAddress) !== ZERO_ADDRESS;

  // 1. Intent must be internally coherent before the authorization is even compared to it.
  if (revoke && !isZeroAddressValue(scope.implementation)) {
    throw new ValidationError(
      "implementation",
      `revocation must target ${ZERO_ADDRESS}, got ${scope.implementation}`,
    );
  }
  if (!revoke && isZeroAddressValue(scope.implementation)) {
    throw new ValidationError(
      "implementation",
      `implementation must not be ${ZERO_ADDRESS} unless revoking — a zero delegate is a revocation, not a delegation`,
    );
  }

  // 2. The wildcard case: a chain-agnostic delegation credential requires an explicit opt-in.
  if (wantChainId === 0n && scope.allowAllChains !== true) {
    throw new ValidationError(
      "chainId",
      `chainId 0 produces an authorization valid on EVERY chain (including future forks and every L2). ` +
        `Pass allowAllChains: true if that is what you want, or pass the concrete chain id.`,
    );
  }

  // 3. The authorization must be for the chain the caller believes it is for.
  if (authChainId !== wantChainId) {
    throw new ValidationError(
      "chainId",
      `authorization is for chainId ${authChainId} but ${wantChainId} was expected — ` +
        `refusing to install a delegation intended for a different chain`,
    );
  }

  // 4. The authorization must do what the caller asked: delegate <-> revoke are opposites,
  //    and installing a signature for the wrong one is the whole failure being prevented here.
  if (revoke && !authRevokes) {
    throw new ValidationError(
      "contractAddress",
      `authorization delegates to ${getAddress(authorization.contractAddress)}, but the intent was to revoke (${ZERO_ADDRESS})`,
    );
  }
  if (!revoke && authRevokes) {
    throw new ValidationError(
      "contractAddress",
      `authorization revokes delegation (${ZERO_ADDRESS}) but the intent was to delegate to ${implementation}`,
    );
  }
  if (!revoke && getAddress(authorization.contractAddress) !== implementation) {
    throw new ValidationError(
      "contractAddress",
      `authorization delegates to ${getAddress(authorization.contractAddress)}, not to ${implementation}`,
    );
  }

  return { chainId: authChainId, implementation, revoke: authRevokes };
}

/** True for the all-zero 20-byte address (the revocation / revoke-everything target). */
function isZeroAddressValue(address: unknown): boolean {
  return typeof address === "string" && /^0x0{40}$/i.test(address);
}

/** Convenience: true iff the EOA delegates to exactly `expected`. */
export async function isDelegatedTo(
  publicClient: PublicClient,
  args: { address: Address; expectedImplementation: Address },
): Promise<boolean> {
  const status = await validateAuthorization(publicClient, args);
  return status.delegated && status.implementation === getAddress(args.expectedImplementation);
}

/** Pads/normalizes helper kept exported for tests. */
export function padAddress(a: Address): Hex {
  return pad(a, { size: 20 });
}
