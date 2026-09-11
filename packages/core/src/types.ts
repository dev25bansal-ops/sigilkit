import type { Address, Hash, Hex } from "viem";
import { keccak256, toHex } from "viem";

/**
 * Scope granted to a session key. Mirrors SessionKeyManager.Scope on-chain.
 * All fields immutable once granted.
 */
export interface Scope {
  /** Hard expiry (unix seconds). Must be in the future at grant time. */
  expiresAt: number;
  /** Fixed (tumbling) spend-window length in seconds. See SpendPolicy INV-1 note. */
  windowSeconds: number;
  /** Max native value per single action (wei). */
  perActionCap: bigint;
  /** Max cumulative native value per fixed (tumbling) window (wei); up to ~2x may cross a boundary. */
  perWindowCap: bigint;
  /**
   * Root over keccak256(abi.encode(target, selector, argsHash)) leaves (format v2).
   * argsHash binds the calldata: keccak256(data) pins the EXACT arguments (e.g. one
   * specific token transfer); 0 = wildcard (any calldata for that target+selector).
   * Zero root = allow ALL targets (dangerous; avoid in production).
   */
  merkleRoot: Hash;
  /**
   * Graduated authority (E10): actions with value > this require an owner approval
   * signature over RequestApproval(requestDigest). 0 = never require countersign.
   */
  countersignAbove: bigint;
  /**
   * Balance-delta enforcement (E11): when true, the inner call must not siphon native
   * value beyond the request's declared value, and watched tokens must not
   * net-decrease beyond their declared transfer amounts.
   */
  enforceNativeDelta: boolean;
  /** E11: up to 8 standard ERC-20s whose balances are snapshotted around the call. */
  tokenWatchlist: Address[];
}

/**
 * EIP-712 signed action request. Mirrors SessionKeyManager.ActionRequest on-chain.
 */
export interface ActionRequest {
  agentId: Hash;
  target: Address;
  selector: Hex;
  /** Native value in wei. */
  value: bigint;
  nonce: bigint;
  /** Request-level expiry (unix seconds); keep <= key expiry. */
  expiry: number;
  /** keccak256 of the off-chain rationale; plaintext never goes on-chain. */
  rationaleHash: Hash;
  /** Calldata suffix appended after `selector` (ABI-encoded args). */
  data: Hex;
}

export interface ExecuteArgs {
  request: ActionRequest;
  /** EIP-712 signature over the request from the session key. */
  signature: Hex;
  /** Sorted-pair Merkle proof when the key's scope has a non-zero merkleRoot. */
  merkleProof?: Hex[];
  /** E10: owner approval signature when value exceeds scope.countersignAbove. */
  ownerApproval?: Hex;
}

/** EIP-712 domain used by SigilKit contracts. */
export const SIGILKIT_DOMAIN_NAME = "SigilKit";
export const SIGILKIT_DOMAIN_VERSION = "1";

/**
 * keccak256 of the ActionRequest EIP-712 type string (matches the on-chain typehash).
 * Not used internally — hashTypedData derives it from the type definition — but
 * exported as the cross-language reference for consumers building digests by hand
 * (see test/reference.test.ts for the byte-exact usage).
 */
export const ACTION_REQUEST_TYPEHASH: Hash = keccak256(
  toHex(
    "ActionRequest(bytes32 agentId,address target,bytes4 selector,uint256 value,uint256 nonce,uint48 expiry,bytes32 rationaleHash,bytes data)",
  ),
);
