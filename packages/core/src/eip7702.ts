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
  hexToBigInt,
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

/** EIP-7702 magic byte prefixing the RLP pre-image. */
export const AUTHORIZATION_MAGIC = "0x05" as const;
/** Zero address — signing an authorization to it clears delegation ("revoke"). */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** A signed EIP-7702 authorization tuple ([chain_id, address, nonce, y_parity, r, s]). */
export interface Authorization {
  contractAddress: Address; // delegate target; 0x0 = revocation
  chainId: bigint | number;
  nonce: bigint | number;
  yParity: 0 | 1;
  r: Hex;
  s: Hex;
}

interface SignerLike {
  sign: (args: { hash: Hash }) => Promise<Hex>;
}

// ---------------------------------------------------------------------------
// Minimal RLP encoding (scalars only — sufficient for the 3-field pre-image)
// ---------------------------------------------------------------------------

/** Encodes one scalar as an RLP string item with minimal big-endian bytes. */
export function rlpEncodeScalar(value: bigint): Hex {
  if (value === 0n) return "0x80";
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  const bytes = hexToBytes(("0x" + hex) as Hex);
  if (bytes.length === 1 && value < 0x80) return ("0x" + hex) as Hex;
  // string item longer than 1 byte (<0x80 payload): prefix = 0x80 + len
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
 * keccak256(0x05 || rlp([chainId, address, nonce])).
 */
export function authorizationDigest(args: {
  chainId: bigint | number;
  contractAddress: Address;
  nonce: bigint | number;
}): Hash {
  const { chainId, contractAddress, nonce } = args;
  const address = getAddress(contractAddress);
  const preimage = rlpEncodeList([
    rlpEncodeScalar(BigInt(chainId)),
    rlpEncodeAddress(address), // fixed 20-byte string, canonical per go-ethereum/viem
    rlpEncodeScalar(BigInt(nonce)),
  ]);
  return keccak256(concat([AUTHORIZATION_MAGIC, preimage]));
}

/**
 * Signs an EIP-7702 authorization with `account`.
 * Set `contractAddress` to ZERO_ADDRESS (or use {@link signRevocation}) to revoke.
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
    chainId: BigInt(args.chainId),
    nonce: BigInt(args.nonce),
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

/** Serializes signed authorizations into a type-4 transaction `authorizationList` entry. */
export function toAuthorizationTuple(auth: Authorization): [
  chainId: Hex,
  address: Address,
  nonce: Hex,
  yParity: Hex,
  r: Hex,
  s: Hex,
] {
  return [
    numberToHex(auth.chainId),
    auth.contractAddress,
    numberToHex(auth.nonce),
    numberToHex(auth.yParity),
    auth.r,
    auth.s,
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
