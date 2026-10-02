import type { Address, Hash, Hex } from "viem";
import { keccak256, toHex } from "viem";

/**
 * Minimal signer surface needed for signing an action request or an EIP-7702
 * authorization — any viem account satisfies it.
 *
 * Declared here (rather than next to one of its two consumers) because
 * `signing.ts` and `eip7702.ts` both need it; they previously declared two
 * structurally identical interfaces, one exported and one private, so the two
 * signing paths could drift apart with nothing to catch it.
 */
export interface HashSigner {
  sign: (args: { hash: Hash }) => Promise<Hex>;
}

/**
 * The result shape shared by every non-throwing check in the SDK: `{ ok: true }`
 * on success, `{ ok: false; reason }` on a failure with a human-readable reason.
 *
 * Returned by `validateAgainstScope` (local policy pre-flight) and
 * `simulateExecution` (on-chain `eth_call`). Both previously spelled this union
 * out inline, so no consumer could name the type; they now share this alias.
 * The `ok` discriminant is the only narrowing signal — `reason` exists solely
 * on the `false` branch and is not present on `{ ok: true }`.
 */
export type SigilKitCheck = { ok: true } | { ok: false; reason: string };

/**
 * Rolling spend-window state for the per-window cap pre-check, as read from
 * `SessionKeyManager.getWindowState(key)`.
 *
 * `windowStart === 0` means "no window has been opened yet", which callers
 * represent by passing the whole `windowState` as `undefined` so the pre-check
 * falls back to the per-action cap alone.
 */
export interface WindowState {
  /** Unix seconds at which the current tumbling window opened. */
  windowStart: number;
  /** Native value (wei) already charged to this window. */
  spentThisWindow: bigint;
}

/** Arguments for `actionRequestDigest`. */
export interface ActionRequestDigestArgs {
  /** The request to hash. Normalized/validated internally, so a JSON-round-tripped object is accepted. */
  request: ActionRequest;
  /** EIP-712 domain chain id. Must match the chain the manager is deployed on. */
  chainId: number;
  /** `SessionKeyManager` address; part of the EIP-712 domain. */
  verifyingContract: Address;
}

/** Arguments for `signActionRequest`. */
export interface SignActionRequestArgs extends ActionRequestDigestArgs {
  /** The session key. Only `sign` is required — the SDK never needs the private key. */
  account: HashSigner;
}

/** Arguments for `validateAgainstScope`. */
export interface ValidateAgainstScopeArgs {
  /** The request to check against the scope. Must already carry its final `nonce`. */
  request: ActionRequest;
  /** The granted scope. Treated as read-only; the function never mutates it. */
  scope: Scope;
  /**
   * Current window spend, used only for the per-window cap. Omit it to skip
   * that check (a failed `getWindowState` read degrades to per-action-only,
   * and on-chain enforcement still applies).
   */
  windowState?: WindowState;
  /** Sorted-pair Merkle proof; required when `scope.merkleRoot` is non-zero. */
  merkleProof?: Hex[];
  /**
   * Clock used for the two expiry checks, in unix SECONDS. Defaults to the system clock.
   *
   * Why this is injectable rather than read from `Date.now()` inline: the expiry comparisons
   * are off-by-one-sensitive mirrors of the on-chain `block.timestamp > expiry` reverts
   * (see the CONFORMANCE CONTRACT table on `validateAgainstScope`), and BUG-3 was exactly
   * such a boundary defect. Pinning a boundary with an injected clock keeps such a test a
   * pure function of its inputs — no global timer state, no `vi.useFakeTimers()`, and no
   * dependence on which file happens to run first (`vitest.config.ts` runs this suite with
   * `isolate: false`). Reaching for `Date.now()` here also made every unrelated assertion in
   * a test file time-dependent, so a boundary could only be pinned by globally hijacking the
   * clock for the whole file.
   *
   * MUST be whole seconds: the function floors it, and a caller passing milliseconds would
   * silently evaluate the policy in 1970+ (every request looks long expired).
   */
  clock?: PolicyClock;
}

/**
 * Unix-seconds clock used by the local policy pre-flight.
 *
 * Deliberately a function returning a number, NOT a `Date`: the checks compare against
 * `uint48` unix seconds, and a `Date` invites `.getTime()/1000` boilerplate at every call
 * site plus an accidental ms/seconds mix-up.
 */
export type PolicyClock = () => number;

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

/**
 * The signed, relayer-ready fields produced by `SigilKitClient.prepareExecution`,
 * without the call envelope.
 *
 * @deprecated Renamed to {@link PreparedExecutionFields} in v0.2.0. `ExecuteArgs` reads
 * like "arguments you pass TO execute()", but it is the *output* of `prepareExecution`
 * and the *input* of `sendPrepared` — the inverse of what a caller expects from the
 * name. `ExecuteArgs` is kept as a re-export alias so existing code keeps compiling;
 * it will be removed in v0.3.0. Migrate by switching the import, not the value:
 *
 * ```ts
 * // before
 * import type { ExecuteArgs } from "@sigilkit/core";
 * // after
 * import type { PreparedExecutionFields } from "@sigilkit/core";
 * ```
 */
export type ExecuteArgs = PreparedExecutionFields;

/**
 * The signed, relayer-ready fields of a prepared execution, without the
 * `to`/`data` call envelope that {@link PreparedExecution} adds.
 *
 * Split out from `PreparedExecution` so a consumer can name the "signed fields"
 * half on its own (e.g. a type guard or a helper that only cares about the
 * signature), which the single flat type made impossible.
 */
export interface PreparedExecutionFields {
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
