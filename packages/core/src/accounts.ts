/**
 * ERC-7579 smart-account install helpers for `SessionKey7579Module` (the SigilKit
 * VALIDATION module for Kernel/Safe{Core}-style accounts).
 *
 * The on-chain module decodes its install payload as `abi.decode(data, (address, Scope))`
 * against ITS OWN five-field `Scope` struct — not the eight-field `Scope` this SDK shares
 * with the manager path. This module exists so an integrator never hand-encodes that
 * payload (and never passes an SDK `Scope` shape the module cannot decode or honor);
 * the encoder rejects the manager-only fields outright instead of silently dropping them.
 */
import {
  encodeAbiParameters,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import type { Scope } from "./types.js";
import { isHex, ValidationError } from "./validation.js";

/** Inclusive upper bound of the ABI `uint48` backing `Scope.expiresAt` / `windowSeconds`. */
const MAX_UINT48_NUMBER = 2 ** 48 - 1;
/** Inclusive upper bound of an ABI `uint256` (wei-denominated caps). */
const MAX_UINT256 = 2n ** 256n - 1n;

/** Arguments for {@link encode7579InstallData}. */
export interface Encode7579InstallDataArgs {
  /**
   * Chain id of the account the module will be installed on.
   *
   * Deliberately NOT part of the encoded payload: `SessionKey7579Module.onInstall`
   * decodes exactly `(address, Scope)` and the struct carries no chain id, so appending
   * one here would produce trailing bytes the module ignores (dead weight that stops
   * decoding the moment any future revision tightens). It is accepted and validated
   * because every install-data builder in the SDK carries the chain id for routing
   * discipline — a caller that signs/mixes install blobs across chains gets a loud
   * `chainId` validation failure here instead of a wrong-chain install.
   */
  chainId: number;
  /** The session key the module grants the scope to on install (`address` in the tuple). */
  key: Address;
  /** The scope to grant. Manager-only fields are rejected — see the function docs. */
  scope: Scope;
}

/**
 * ABI-encodes the ERC-7579 install payload for `SessionKey7579Module.onInstall`:
 * `abi.encode(address key, Scope scope)` with the module's OWN five-field struct,
 * in declaration order and with the exact on-chain types:
 *
 * `(address, uint48 expiresAt, uint48 windowSeconds, uint256 perActionCap,
 *   uint256 perWindowCap, bytes32 merkleRoot)`
 *
 * (Read from `contracts/src/SessionKey7579Module.sol` — do not trust this prose to stay in
 * sync; the struct is the contract the encoder mirrors.)
 *
 * The SDK's {@link Scope} carries three manager-only extensions the 7579 module has NO
 * storage or code for: `countersignAbove` (E10), `enforceNativeDelta` and
 * `tokenWatchlist` (E11). Encoding them would silently drop capability the caller believes
 * is enforced, so scopes that set any of them are REJECTED here with a reason naming the
 * field, rather than producing a payload the module half-honors.
 *
 * @param args.chainId chain the install is for (validated, not encoded — see the field docs).
 * @param args.key the 20-byte session-key address to grant at install time.
 * @param args.scope the scope to grant; structural fields are range-checked against the
 *   ABI types (`uint48`/`uint256`) and the module's grant-time rules. Whether
 *   `expiresAt` is in the FUTURE is deliberately NOT checked here (this function is pure
 *   and takes no clock): the module's `_grant` reverts `KeyExpired` if it is past at
 *   install time, and an integrator should treat that revert as the on-chain clock's word.
 * @returns the `onInstall` payload: 6 ABI words (192 bytes) of hex.
 * @throws {@link ValidationError} for a malformed `chainId`/`key`, an out-of-range
 *   `uint48`/`uint256` field, a scope the module's `_grant` would refuse
 *   (`perActionCap == 0`, `perWindowCap < perActionCap`, `windowSeconds == 0`), or any
 *   manager-only field set to a value the module cannot honor.
 * @remarks Cost: one ABI encode, pure CPU, no I/O.
 */
export function encode7579InstallData(args: Encode7579InstallDataArgs): Hex {
  if (
    typeof args.chainId !== "number" ||
    !Number.isSafeInteger(args.chainId) ||
    args.chainId < 0
  ) {
    throw new ValidationError(
      "chainId",
      `expected a non-negative safe integer chain id (routing discipline for the install payload), got ${String(args.chainId)}`,
    );
  }
  if (!isAddress(args.key)) {
    throw new ValidationError(
      "key",
      `expected a 20-byte hex address for the session key being granted, got ${String(args.key)}`,
    );
  }
  const { scope } = args;

  // Manager-only fields (E10/E11): the 7579 module cannot honor them — reject, don't drop.
  if (scope.countersignAbove !== 0n) {
    throw new ValidationError(
      "scope.countersignAbove",
      `the ERC-7579 module has no owner-counter signature mechanism (E10 is manager-only) — countersignAbove must be 0n, got ${scope.countersignAbove}n. Use the manager path if graduated authority is required.`,
    );
  }
  if (scope.enforceNativeDelta) {
    throw new ValidationError(
      "scope.enforceNativeDelta",
      "the ERC-7579 module performs no balance-delta verification (E11 is manager-only) — enforceNativeDelta must be false; setting it true here would silently grant a scope whose E11 guarantee never runs",
    );
  }
  if (scope.tokenWatchlist.length > 0) {
    throw new ValidationError(
      "scope.tokenWatchlist",
      `the ERC-7579 module stores no token watchlist (E11 is manager-only) — tokenWatchlist must be empty, got ${scope.tokenWatchlist.length} entries; the module would neither snapshot nor verify them`,
    );
  }

  if (
    !Number.isSafeInteger(scope.expiresAt) ||
    scope.expiresAt <= 0 ||
    scope.expiresAt > MAX_UINT48_NUMBER
  ) {
    throw new ValidationError(
      "scope.expiresAt",
      `expected a uint48 unix-seconds expiry (1..${MAX_UINT48_NUMBER}), got ${String(scope.expiresAt)}`,
    );
  }
  if (
    !Number.isSafeInteger(scope.windowSeconds) ||
    scope.windowSeconds <= 0 ||
    scope.windowSeconds > MAX_UINT48_NUMBER
  ) {
    throw new ValidationError(
      "scope.windowSeconds",
      `expected a uint48 window length in [1, ${MAX_UINT48_NUMBER}] (the module's grant reverts on 0), got ${String(scope.windowSeconds)}`,
    );
  }
  const perActionCap = uint256Field("scope.perActionCap", scope.perActionCap);
  const perWindowCap = uint256Field("scope.perWindowCap", scope.perWindowCap);
  if (perActionCap === 0n) {
    throw new ValidationError(
      "scope.perActionCap",
      "expected a positive uint256 per-action cap (the module's grant reverts MalformedExecutionData on 0)",
    );
  }
  if (perWindowCap < perActionCap) {
    throw new ValidationError(
      "scope.perWindowCap",
      `expected perWindowCap >= perActionCap (${perActionCap}n), got ${perWindowCap}n — the module's grant reverts this combination`,
    );
  }
  if (!isHex(scope.merkleRoot, 32)) {
    throw new ValidationError(
      "scope.merkleRoot",
      `expected a 32-byte Merkle root (zeroHash means "allow all targets"), got ${String(scope.merkleRoot)}`,
    );
  }

  // Mirrors the contract's `abi.decode(data, (address, Scope))`, flat-encoded so the tuple
  // decode reads the exact six words: address, uint48, uint48, uint256, uint256, bytes32.
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint48" },
      { type: "uint48" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
    ],
    [
      args.key,
      scope.expiresAt,
      scope.windowSeconds,
      perActionCap,
      perWindowCap,
      scope.merkleRoot,
    ],
  );
}

/** Strict `uint256` whitelist for the two wei-denominated caps (bigint only — the typed
 *  `Scope` fields are declared `bigint`, so a number/string here is a caller bug to name,
 *  not a JSON convenience to coerce). */
function uint256Field(field: string, v: unknown): bigint {
  if (typeof v !== "bigint") {
    throw new ValidationError(
      field,
      `expected a bigint (wei-denominated uint256 cap), got ${String(v)}`,
    );
  }
  if (v < 0n || v > MAX_UINT256) {
    throw new ValidationError(field, `${v} is outside [0, 2^256-1] for uint256`);
  }
  return v;
}