import type { Address, Hash, Hex } from "viem";
import { keccak256, toHex } from "viem";

/**
 * Scope granted to a session key. Mirrors SessionKeyManager.Scope on-chain.
 * All fields immutable once granted.
 */
export interface Scope {
  /** Hard expiry (unix seconds). Must be in the future at grant time. */
  expiresAt: number;
  /** Rolling-window length for the spend cap (seconds). */
  windowSeconds: number;
  /** Max native value per single action (wei). */
  perActionCap: bigint;
  /** Max cumulative native value per rolling window (wei). */
  perWindowCap: bigint;
  /**
   * Root over keccak256(abi.encode(target, selector)) leaves.
   * Zero value = allow ALL targets (dangerous; avoid in production).
   */
  merkleRoot: Hash;
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
}

/** EIP-712 domain used by SigilKit contracts. */
export const SIGILKIT_DOMAIN_NAME = "SigilKit";
export const SIGILKIT_DOMAIN_VERSION = "1";

/** keccak256 of the ActionRequest EIP-712 type string (matches on-chain typehash). */
export const ACTION_REQUEST_TYPEHASH: Hash = keccak256(
  toHex(
    "ActionRequest(bytes32 agentId,address target,bytes4 selector,uint256 value,uint256 nonce,uint48 expiry,bytes32 rationaleHash,bytes data)",
  ),
);
