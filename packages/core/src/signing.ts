import type {
  ActionRequest,
  ActionRequestDigestArgs,
  PolicyClock,
  SigilKitCheck,
  SignActionRequestArgs,
  ValidateAgainstScopeArgs,
} from "./types.js";
// Value import (not `import type`): the EIP-712 domain separator must be built from the
// SAME constants the rest of the SDK publishes, never from a second copy of the literals.
// These two were duplicated as raw strings here while `types.ts` exported them unused, so a
// domain-version bump that only touched `types.ts` would have left every signature hashing
// the OLD domain — silently producing digests the chain rejects, with no type or test error.
import { SIGILKIT_DOMAIN_NAME, SIGILKIT_DOMAIN_VERSION } from "./types.js";
import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  isAddress,
  isHex,
  keccak256,
  recoverAddress,
  zeroHash,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { ValidationError, toUnsignedBigInt } from "./validation.js";

/** Inclusive upper bound of the ABI `uint48` backing `ActionRequest.expiry` (unix seconds). */
const MAX_UINT48 = 2n ** 48n - 1n;
/** Inclusive upper bound of the ABI `uint48` backing `Scope.expiresAt` / `windowSeconds`. */
const MAX_UINT48_NUMBER = 2 ** 48 - 1;

export type { HashSigner } from "./types.js";

/**
 * Builds the EIP-712 digest for an ActionRequest exactly as SessionKeyManager does on-chain.
 *
 * Every field is validated up front via parseActionRequest, so deserialized
 * (JSON-round-tripped) requests fail loudly here instead of producing a wrong
 * digest or a TypeError mid-encode.
 *
 * @param args.request the request to hash. `value`/`nonce` may arrive as `bigint`, a
 *   safe-integer `number`, or a decimal string (JSON has no bigint) and are normalized.
 * @param args.chainId EIP-712 domain chain id; must be a non-negative safe integer.
 * @param args.verifyingContract the `SessionKeyManager` address (domain separator).
 * @throws {@link ValidationError} naming the offending field, for any input that fails
 *   the strict whitelist or the domain checks.
 * @example
 * ```ts
 * const digest = actionRequestDigest({
 *   request,
 *   chainId: foundry.id,          // 31337
 *   verifyingContract: manager,    // 0x5FbDB2315678afecb367f032d93F642f64180aa3
 * });
 * ```
 * @remarks Cost: pure CPU — one EIP-712 encode plus keccak256 rounds. Microseconds, no I/O.
 */
export function actionRequestDigest(args: ActionRequestDigestArgs): Hash {
  // The domain is the ONLY thing separating this signature from one for a different chain or
  // a different contract, so both fields are pinned before the digest is computed. `chainId`
  // arrives as a JS `number`; above 2^53 a number no longer denotes the chain it was written
  // as (BigInt(2**53 + 1) is 9007199254740992), so a value that is an integer but not
  // safe-integer is refused rather than signed against a subtly wrong domain. `verifyingContract`
  // is checked with `isAddress` (20 bytes, EIP-55 checksum) — `hashTypedData` itself throws on a
  // malformed one, but an explicit check names the field instead of surfacing viem's message.
  if (typeof args.chainId !== "number" || !Number.isSafeInteger(args.chainId) || args.chainId < 0) {
    throw new ValidationError(
      "chainId",
      `expected a non-negative safe integer chain id (EIP-712 domain field, must be represented exactly), got ${gotClause(args.chainId)}`,
    );
  }
  if (!isAddress(args.verifyingContract)) {
    throw new ValidationError(
      "verifyingContract",
      `expected a 20-byte hex address (EIP-712 domain field), got ${describeRejected(args.verifyingContract)}`,
    );
  }
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
      // Single source of truth: SIGILKIT_DOMAIN_* from types.ts. Do NOT inline literals here
      // — the digest is what the chain's DOMAIN_SEPARATOR is compared against, so a second
      // copy of "SigilKit"/"1" is a silent-failure source (see the import comment above).
      name: SIGILKIT_DOMAIN_NAME,
      version: SIGILKIT_DOMAIN_VERSION,
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
 * Short, safe rendering of a rejected value for an error message. Mirrors the
 * renderer in validation.ts but is kept local so a bad value is never echoed
 * verbatim in full (no accidental secret/calldata leak into logs).
 */
function describeRejected(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 66 ? `"${value.slice(0, 20)}…" (${value.length} chars)` : `"${value}"`;
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  return String(value);
}

/**
 * Human-readable type label. `typeof` reports `"object"` for both `null` and arrays,
 * which made the error read `got null (object)`; this names the actual shape so a
 * caller can tell "the field is an array" from "the field is null" at a glance.
 */
function typeLabelOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** `got <rendering> (type: <label>)` — the standard "what did you actually pass" suffix. */
function gotClause(value: unknown): string {
  return `got ${describeRejected(value)} (type: ${typeLabelOf(value)})`;
}

/**
 * Strict uint coercion for untrusted input (BUG-01). This is a **type whitelist**,
 * not a coercion: only three input shapes are accepted, everything else throws.
 *
 * | input                              | result                                     |
 * |------------------------------------|--------------------------------------------|
 * | `bigint` in [0, max]               | itself                                     |
 * | `number`, `Number.isSafeInteger` ≥0| `BigInt(v)` (exact — safe-integer guaranteed) |
 * | string matching `/^\d+$/`          | `BigInt(v)` (arbitrary precision)          |
 * | anything else                      | throws `ValidationError`                   |
 *
 * Explicitly REJECTED (all of which `BigInt()` / `Number()` used to silently accept):
 * `boolean` (`true`→1), `null`/`undefined`, arrays (`[]`→0), objects, floats
 * (`1.5`→1n), negative numbers, hex strings (`"0x10"`→16), signed strings
 * (`"-1"`), and whitespace-padded strings (`" 1"`→1). The last three are rejected
 * rather than trimmed because a signed value must have one unambiguous textual form.
 *
 * @param max upper bound (inclusive) for the ABI type backing the field.
 * @param typeName human-readable ABI type, used in the error message.
 */
function uintField(field: string, v: unknown, max: bigint, typeName: string): bigint {
  let out: bigint;
  if (typeof v === "bigint") {
    out = v;
  } else if (typeof v === "number") {
    // Not Number.isInteger alone: 1e21 IS an integer but is not exactly
    // representable, so BigInt() would return a different wei amount than the
    // caller passed. Safe-integer is the real losslessness precondition.
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new ValidationError(
        field,
        `expected a non-negative safe integer for ${typeName}, ${gotClause(v)}`,
      );
    }
    out = BigInt(v);
  } else if (typeof v === "string" && /^\d+$/.test(v)) {
    out = BigInt(v);
  } else {
    throw new ValidationError(
      field,
      `expected ${typeName} as bigint, non-negative safe integer, or decimal string, ${gotClause(v)}`,
    );
  }
  if (out > max) {
    throw new ValidationError(field, `${out} exceeds the maximum ${max} for ${typeName}`);
  }
  return out;
}

/**
 * Strict `expiry` coercion: the ABI type is uint48, but the value stays a JS number
 * downstream (`ActionRequest.expiry: number`), so the value must be exactly representable
 * as a number (`Number.isSafeInteger`) AND within `uint48` — the two conditions are
 * independent and the second one is the one that was missing.
 *
 * BUG (found by the signing-conformance audit): the number path checked only
 * `Number.isSafeInteger`, so `expiry: 2 ** 48` (281474976710656, one past the max) was
 * accepted and ABI-encoded as `keccak256(...)` of a uint48 word holding 0x0100…00 — a
 * different value than the caller wrote. viem's `encodeAbiParameters` does *not* range-check
 * a plain number, so nothing downstream caught it. A request whose expiry silently becomes
 * small is an *expired* request (safe-ish), but a caller relying on `2**48` as a sentinel
 * ("never expires") gets a signature over a value the chain reads as a different instant.
 * Both `Number.isSafeInteger` and the uint48 bound are now required.
 *
 * Same type whitelist as {@link uintField} for the bigint/string paths; a bigint or decimal
 * string beyond uint48 is rejected rather than silently rounded or wrapped.
 */
function expiryNumber(v: unknown): number {
  const max = Number(MAX_UINT48);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new ValidationError(
        "expiry",
        `expected a non-negative safe integer for uint48, ${gotClause(v)}`,
      );
    }
    if (v > max) {
      throw new ValidationError(
        "expiry",
        `expected a uint48 (<= ${max}), ${gotClause(v)}`,
      );
    }
    return v;
  }
  if (typeof v === "bigint") {
    if (v < 0n || v > MAX_UINT48) {
      throw new ValidationError(
        "expiry",
        `expected a uint48 (<= ${max}) that is exactly representable as a number, ${gotClause(v)}`,
      );
    }
    return Number(v);
  }
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) {
      throw new ValidationError(
        "expiry",
        `expected a uint48 that is exactly representable as a number, ${gotClause(v)}`,
      );
    }
    if (n > max) {
      throw new ValidationError(
        "expiry",
        `expected a uint48 (<= ${max}), ${gotClause(v)}`,
      );
    }
    return n;
  }
  throw new ValidationError(
    "expiry",
    `expected uint48 as a non-negative safe integer, bigint or decimal string, ${gotClause(v)}`,
  );
}

/**
 * Normalizes an untrusted (e.g. JSON-deserialized) value into a validated
 * ActionRequest. JSON has no bigint, so `value`/`nonce`/`expiry` may arrive as
 * numbers or strings; they are accepted through a strict *type whitelist* (see
 * {@link uintField}) and every field's shape is validated, so a malformed request
 * fails loudly here instead of producing a wrong digest or a TypeError
 * mid-ABI-encode.
 *
 * Throws {@link ValidationError} with a field-prefixed message on any invalid input.
 *
 * @param raw the untrusted value. Must be a plain object (not an array, not `null`);
 *   every one of the 8 `ActionRequest` fields must be present.
 * @returns a normalized {@link ActionRequest}: `target` lowercased, `value`/`nonce` as
 *   `bigint`, `expiry` as a safe-integer `number`, hex fields validated for length.
 * @throws {@link ValidationError} for a field that fails the strict type whitelist, or a
 *   plain `Error` for a missing/duplicate-shaped field. Booleans, arrays, `null`, floats,
 *   hex strings (`"0x10"`) and whitespace-padded strings are **rejected** for uint fields
 *   rather than coerced — see {@link uintField} for the accepted shapes.
 * @example
 * ```ts
 * // From an LLM tool call or a JSON file — bigint fields arrive as strings/numbers.
 * const request = parseActionRequest(JSON.parse(payload));
 * ```
 * @remarks Cost: pure CPU, no I/O. This is the trust boundary for every untrusted
 *   request in the SDK; run it before hashing or encoding anything.
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

  // uint256 fields may arrive as bigint (in-process), number, or decimal string (JSON).
  //
  // BUG-01: this used to be a bare `BigInt(v as ...)`, which silently accepted any
  // value JS considers coercible — `true`->1, `[]`->0, `"0x10"`->16, `" 1"`->1,
  // `1.5`->1n. Those coercions are semantically wrong for a *signed* uint256: a
  // caller who sends `value: []` (a schema typo) got a real 0-wei transfer signed,
  // and a hex string got a value 16x larger than the decimal-looking intent. The
  // whitelist below is deliberately a type gate, not a coercion.
  const bigintValue = (field: string, v: unknown): bigint => uintField(field, v, 2n ** 256n - 1n, "uint256");
  const value = bigintValue("value", req("value"));
  const nonce = bigintValue("nonce", req("nonce"));

  // expiry is ABI-typed uint48, but stays a JS number (unix seconds) downstream, so
  // the integer check is stricter than for bigint fields: it must be exactly
  // representable, i.e. Number.isSafeInteger. BUG-01 regression: `Number(expiryRaw)`
  // alone accepted 1.5, `true`->1 and `null`/`[]`->0 because Number() only guards
  // isFinite — 1.5 was then ABI-encoded as a truncated uint48, so the signed digest
  // did not match what the caller believed they authorized.
  const expiryRaw = req("expiry");
  const expiry = expiryNumber(expiryRaw);
  if (expiry > 2 ** 48 - 1) {
    throw new ValidationError("expiry", `expected a uint48 (<= ${2 ** 48 - 1}), got ${String(expiryRaw)}`);
  }

  // bytes data: valid, even-length hex ('0x' allowed for empty calldata).
  const dataRaw = req("data");
  if (typeof dataRaw !== "string" || !isHex(dataRaw) || dataRaw.length % 2 !== 0) {
    throw new Error(`parseActionRequest: data is not valid even-length hex: ${String(dataRaw)}`);
  }
  // Size bound, at the trust boundary (SEC-13). Every other field here is fixed-width, but
  // `data` was length-checked only for hex validity, so a caller could hand the SDK a
  // megabyte of calldata. The cost is not hypothetical: `actionRequestDigest` keccaks the
  // WHOLE payload, and keccak is roughly linear in input length — measured at ~30 ms for
  // 512 KB and ~60 ms for 1 MB on this toolchain, so one request could burn a minute of the
  // caller's CPU and block the event loop, before any policy check or signature.
  //
  // 64 KiB is far above any realistic agent action (a router swap or an ERC-20 approve is
  // hundreds of bytes) and far below anything that could stall a caller. MCP already caps
  // whitelist leaf data at 4 KiB; this is the SDK-level backstop for callers that bypass MCP.
  if (dataRaw.length > 2 + MAX_CALLDATA_BYTES * 2) {
    throw new Error(
      `parseActionRequest: data exceeds the ${MAX_CALLDATA_BYTES}-byte calldata bound ` +
        `(got ${(dataRaw.length - 2) / 2} bytes)`,
    );
  }
  const data = dataRaw as Hex;

  return { agentId, target, selector, value, nonce, expiry, rationaleHash, data } as ActionRequest;
}

/**
 * Signs an ActionRequest with a viem account (the session key).
 *
 * @param args.account the session key. Only `sign` is required — the SDK never needs
 *   the private key, so an HSM or a remote signer satisfies this just as well as a
 *   `privateKeyToAccount` key.
 * @returns the 65-byte EIP-712 signature as hex.
 * @throws {@link ValidationError} if the request or the EIP-712 domain is invalid
 *   (propagated from {@link actionRequestDigest}), or when the signer carries an `address`
 *   and the produced 65-byte signature does not recover to it (R43 misconfigured-signer
 *   guard); nothing is sent in either case.
 * @example
 * ```ts
 * const signature = await signActionRequest({
 *   account,                                  // any { sign: ({ hash }) => Promise<Hex> }
 *   request,
 *   chainId: foundry.id,
 *   verifyingContract: manager,
 * });
 * ```
 * @remarks Cost: one `account.sign` round-trip (a hardware/remote signer makes this a
 * network or IPC call) plus the digest computation. Signs the request as given — it
 * does NOT run {@link validateAgainstScope}; call that first if you want the zero-gas
 * pre-flight.
 */
export async function signActionRequest(args: SignActionRequestArgs): Promise<Hex> {
  const digest = actionRequestDigest({
    request: args.request,
    chainId: args.chainId,
    verifyingContract: args.verifyingContract,
  });
  const signature = await args.account.sign({ hash: digest });

  // R43: verify the produced signature recovers to the signer the caller believes it is.
  // A misconfigured signer (a key that does not match `account.address`) otherwise yields a
  // well-formed signature blob that fails only ON-CHAIN — `_recover` recovers a different
  // key, the scope lookup misses, and the relayer's gas is spent on `KeyUnknown`.
  //
  // The `HashSigner` contract only promises `sign`, so an HSM/remote signer may legitimately
  // carry no address — the check is skipped then (the on-chain recovery remains the sole
  // authority). When `address` IS present it must be a real address and the recovered signer
  // must equal it, else this throws BEFORE any bytes leave the process.
  //
  // Two guardrails keep the check from firing on legitimate paths (GoldenVectors /
  // `npm run check:vectors` pin only digests, but the E2E suites sign the same way):
  //   - Only 65-byte ECDSA signatures are recoverable locally. A smart-account session key
  //     (E17: `address ‖ 1271signature`, wire format on the MANAGER path) signs a non-65-byte
  //     blob, which the on-chain ERC-1271 branch verifies; skipping it here preserves that
  //     path instead of crashing recovery with a length error.
  //   - A malformed `address` property fails fast with a field-naming error rather than
  //     comparing against garbage.
  const claimedRaw = (args.account as { address?: unknown }).address;
  if (claimedRaw !== undefined) {
    if (typeof claimedRaw !== "string" || !isAddress(claimedRaw)) {
      throw new ValidationError(
        "account.address",
        `expected the signer's own 20-byte hex address when present (used to cross-check the recovered signer), ${gotClause(claimedRaw)}`,
      );
    }
    const claimedAddress = claimedRaw.toLowerCase() as Address;
    // 65 bytes = 132 hex chars; anything else is an ERC-1271-shaped blob (skip — see above).
    if (signature.length === 132) {
      let recovered: Address;
      try {
        recovered = await recoverAddress({ hash: digest, signature });
      } catch (cause) {
        throw new ValidationError(
          "account",
          `the signature produced by the configured signer cannot be recovered over the request digest (${cause instanceof Error ? cause.message : String(cause)}) — it is not a valid 65-byte ECDSA signature for signer ${claimedAddress}`,
        );
      }
      if (recovered.toLowerCase() !== claimedAddress) {
        throw new ValidationError(
          "account",
          `signature recovers to ${recovered}, not the claimed signer address ${claimedAddress} — the configured signer key does not match the account; on-chain this would revert InvalidSignature/KeyUnknown after gas is spent. Fix the signer configuration.`,
        );
      }
    }
  }
  return signature;
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
 *
 * @param target the contract the action calls.
 * @param selector the 4-byte function selector (`0x` + 8 hex chars).
 * @param data the ABI-encoded calldata suffix, **without** the selector. Omit it for
 *   the wildcard leaf; pass it to pin the entry to that exact calldata.
 * @returns the 32-byte Merkle leaf.
 * @throws never for well-formed input; a malformed address/selector surfaces from
 *   `encodeAbiParameters`.
 * @example
 * ```ts
 * const anyCalldata = targetLeaf(token, "0xa9059cbb");                 // wildcard
 * const oneTransfer = targetLeaf(token, "0xa9059cbb", transferCalldata); // pinned
 * ```
 * @remarks Cost: two keccak256 rounds over 96 bytes. Pure CPU, no I/O.
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
 * Hard ceiling on the leaf count of a Merkle tree built in-process (PERF-11).
 *
 * `merkleRoot`/`merkleProof` are strictly O(n) in leaves and synchronous, so an unbounded
 * caller-supplied array is a CPU-and-allocation amplifier: there is no await point to yield
 * in, so the event loop is blocked for the whole build. Once these builders sit behind an
 * MCP tool or any agent-facing surface, that is a denial-of-service vector, not a slow path.
 *
 * **Measured on Node 24 / V8 (see DOC-AUDIT-2026-09-26.md for the raw numbers).** Cost is
 * ~13–17 us per leaf for *both* builders, and it is not linear at the top end because
 * `merkleProof` also sorts:
 *
 * | leaves  | `merkleRoot` | `merkleProof` |
 * |---------|--------------|---------------|
 * | 1,024   | ~15 ms       | ~14 ms        |
 * | 16,384  | ~228 ms      | ~223 ms       |
 * | 65,536  | ~1,078 ms    | ~866 ms       |
 *
 * So 65,536 leaves costs roughly **one second** of blocked event loop, not the ~0.55 s an
 * earlier estimate claimed; treat that ceiling as "about a second", and prefer a few thousand
 * leaves. A tree of depth 16 (65,536 leaves) is far deeper than any practical whitelist —
 * callers needing more should batch on-chain instead of building one enormous tree locally.
 */
export const MAX_LEAVES = 65_536;

/**
 * Hard ceiling on `ActionRequest.data`, in bytes (SEC-13).
 *
 * The digest path keccaks the entire payload, so cost grows with calldata length. Measured
 * on this toolchain: 512 KB hashed in ~29.93 ms, ~60 ms at 1 MB — near-linear. An unbounded
 * field therefore lets one request stall the caller's event loop for a minute, and it does so
 * BEFORE any scope check, because hashing is what the digest is for.
 *
 * 64 KiB is deliberately generous: an ERC-20 approval, a router swap, or a permit batch are
 * all hundreds of bytes. It is a denial-of-service backstop, not a protocol limit — nothing
 * legitimate comes near it, and anything that does is not an agent action.
 */
export const MAX_CALLDATA_BYTES = 65_536;

/**
 * Hard ceiling on Merkle proof elements (PERF-11), aligned with the on-chain
 * `MAX_SINGLE_PROOF_ELEMENTS` in `SessionKey7579Module.sol` (8).
 *
 * Without this bound a caller could hand `validateAgainstScope` a proof of any length: the
 * local pre-flight would happily verify it, spend a signature, and burn gas — only for the
 * chain to revert on a proof count the module refuses. The local check exists precisely to
 * reject violations before a signature is created, so it must not be looser than the chain.
 *
 * WHY 8 AND NOT 32. The module has two ceilings: `MAX_SINGLE_PROOF_ELEMENTS = 8` per proof,
 * and `MAX_TOTAL_PROOF_ELEMENTS = 32` across a whole batch. This value was previously 32,
 * matching only the batch aggregate — so a *single*-call proof of 9..32 elements passed the
 * local pre-flight, consumed a signature, and reverted on-chain. A single execution carries
 * one proof, so the binding constraint is 8. (The batch path enforces its per-tuple ceiling on
 * chain; this constant governs the single-call pre-flight.)
 */
export const MAX_MERKLE_PROOF_ELEMENTS = 8;

/**
 * Rejects any leaf that is not a 32-byte hex hash, BEFORE a tree is built from it.
 *
 * Both builders bounded the leaf COUNT but never the leaf VALUES, and `sortedPairHash`
 * calls `a.toLowerCase()` on whatever it is handed. A non-string leaf therefore surfaced as
 * a `TypeError` from inside the hashing loop — after the level array had already been sorted
 * and copied — and a wrong-length or non-hex leaf produced a root that could never match on
 * chain, with no local error at all. Validating here names the builder and the offending
 * element instead.
 */
function assertMerkleLeaves(who: string, leaves: readonly Hash[]): void {
  for (const leaf of leaves) {
    if (typeof leaf !== "string" || !isHex(leaf) || leaf.length !== 2 + 64) {
      throw new Error(
        `${who}: every leaf must be a 32-byte hex hash, got ${describeRejected(leaf)}`,
      );
    }
  }
}

/**
 * Builds a sorted-pair Merkle root over the given leaves (matches on-chain verification).
 *
 * The input array is **not** mutated — it is copied before sorting. Duplicates are
 * kept (the tree is built over exactly what you pass), and an odd level promotes its
 * last node unchanged, which is what the contract does.
 *
 * @param leaves the Merkle leaves, typically from {@link targetLeaf}.
 * @returns the 32-byte root to put in `Scope.merkleRoot`.
 * @throws `Error` when `leaves` is empty (a root over nothing is meaningless — use
 *   `zeroHash` to mean "allow all targets") or longer than {@link MAX_LEAVES}.
 * @example
 * ```ts
 * const scope = { ...base, merkleRoot: merkleRoot([leafA, leafB, leafC]) };
 * ```
 * @remarks Cost: O(n log n) with a synchronous sort and no await point. Budget **~1 s
 *   of blocked event loop at the 65,536-leaf ceiling** (measured); a few thousand
 *   leaves is ~15 ms. Prefer on-chain batching over one enormous local tree.
 */
export function merkleRoot(leaves: Hash[]): Hash {
  if (leaves.length === 0) {
    throw new Error("merkleRoot: at least one leaf required");
  }
  if (leaves.length > MAX_LEAVES) {
    throw new Error(`merkleRoot: at most ${MAX_LEAVES} leaves allowed, got ${leaves.length}`);
  }
  assertMerkleLeaves("merkleRoot", leaves);
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
 *
 * Bounded by {@link MAX_LEAVES} (PERF-11): this is O(n log n) with a synchronous sort, the
 * most allocation-hungry of the two builders.
 *
 * The input array is **not** mutated. The returned proof is sorted-pair order and can
 * be passed straight to `validateAgainstScope` / `prepareExecution` as `merkleProof`.
 *
 * @param leaves the full leaf set the root was (or will be) built from.
 * @param leaf the leaf to prove membership for. Matched by **exact string equality**,
 *   so pass the identical value used to build the tree — a checksummed/differently-cased
 *   copy of the same hash will not be found.
 * @returns the sibling hashes from leaf to root, bottom-up.
 * @throws `Error` when `leaves` exceeds {@link MAX_LEAVES} or `leaf` is not in the set.
 * @example
 * ```ts
 * const leaves = [targetLeaf(token, "0xa9059cbb"), targetLeaf(router, "0x38ed1739")];
 * const proof = merkleProof(leaves, leaves[0]!);
 * await client.prepareExecution({ account, request, scope, merkleProof: proof });
 * ```
 * @remarks Cost: O(n log n), synchronous, allocation-heavy — ~14 ms at 1,024 leaves and
 *   ~866 ms at the 65,536 ceiling. The on-chain module additionally caps the proof at
 *   {@link MAX_MERKLE_PROOF_ELEMENTS} (32) elements, so a longer proof is rejected on
 *   chain; {@link validateAgainstScope} refuses it locally first.
 */
export function merkleProof(leaves: Hash[], leaf: Hash): Hex[] {
  if (leaves.length > MAX_LEAVES) {
    throw new Error(`merkleProof: at most ${MAX_LEAVES} leaves allowed, got ${leaves.length}`);
  }
  assertMerkleLeaves("merkleProof", leaves);
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
 * The system clock, in unix seconds — the default for {@link ValidateAgainstScopeArgs.clock}.
 *
 * Isolated in one named function (rather than an inline `Date.now()` at the use site) so
 * there is exactly ONE place in the policy path that reads ambient time. A grep for
 * `Date.now()` in this module should return this line and nothing else; that is the
 * invariant that keeps the policy engine reproducible.
 */
const defaultPolicyClock: PolicyClock = () => Math.floor(Date.now() / 1000);

/**
 * Runs {@link parseActionRequest} and turns a structural rejection into the
 * `{ ok: false, reason }` shape this module's check functions return, instead of a throw.
 *
 * The reason carries the parser's own message, so nothing about the failure is discarded —
 * this converts a malformed-request THROW into an explicit rejection verdict, it does not
 * swallow it and does not fall back to "looks fine".
 */
function parseRequestOrReject(
  raw: unknown,
): { ok: true; request: ActionRequest } | { ok: false; reason: string } {
  try {
    return { ok: true, request: parseActionRequest(raw) };
  } catch (err) {
    return {
      ok: false,
      reason: `request is not a valid ActionRequest — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
 *
 * Never throws: every rejection comes back as `{ ok: false, reason }`, so a caller can
 * branch without a try/catch. `reason` is a human-readable sentence, not a stable code —
 * match on the substrings documented above ("scope hard-expired", "request already
 * expired", "per-action cap exceeded", "per-window cap exceeded", "target not whitelisted",
 * "merkle proof too long", "request is not a valid ActionRequest") or use
 * {@link PolicyRejectedError} if you want a typed code.
 *
 * @returns {@link SigilKitCheck} — `{ ok: true }`, or `{ ok: false, reason }` naming the
 *   first violated check in the order listed in the conformance table above.
 * @example
 * ```ts
 * const check = validateAgainstScope({ request, scope, windowState });
 * if (!check.ok) throw new PolicyRejectedError(check.reason); // zero gas spent
 * ```
 * @remarks Cost: pure CPU, no RPC. Measured at ~0.9 us per call for the common path (no
 *   Merkle proof) on Node 24 — see DOC-AUDIT-2026-09-26.md. That is three orders of
 *   magnitude below the "~5 ms" an earlier revision of this comment claimed; do not budget
 *   milliseconds for this call. The Merkle branch is O(proof.length) and is hard-bounded by
 *   {@link MAX_MERKLE_PROOF_ELEMENTS}.
 *
 * @remarks Determinism: the only ambient input is the clock, and it is injectable via
 *   `args.clock` (unix seconds). With a supplied clock this function is a pure function of
 *   its arguments — no network, no filesystem, no global timer state — which is what lets
 *   the off-by-one-sensitive expiry boundaries above be pinned by ordinary unit tests
 *   instead of by globally hijacking `Date.now()` for a whole test file. See
 *   {@link ValidateAgainstScopeArgs.clock}.
 */
export function validateAgainstScope(args: ValidateAgainstScopeArgs): SigilKitCheck {
  // The untrusted request goes through the SAME parser the digest path uses
  // (`actionRequestDigest` -> `parseActionRequest`). It used to be destructured raw and its
  // fields compared as they arrived, so this function validated nothing: a JSON-deserialized
  // `value` arrives as a number or a decimal string, which turned
  // `request.value > scope.perActionCap` into a string comparison instead of a wei
  // comparison, and a malformed address/selector/hex field was never rejected here at all.
  // A structural defect is not a policy violation, so it is reported through this
  // function's documented check contract rather than being treated as a passing request.
  const parsed = parseRequestOrReject(args.request);
  if (!parsed.ok) return parsed;
  const request = parsed.request;
  const { scope, windowState } = args;
  // Injected clock, defaulting to the system clock. Read exactly once per call so every
  // check in this function sees ONE consistent "now" — reading it per-check would let a
  // request straddle a second boundary mid-validation and produce a verdict that no single
  // point in time supports.
  const nowSec = Math.floor((args.clock ?? defaultPolicyClock)());

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

  // Local mirror of E10 graduated authority (SessionKeyManager.sol:598). The contract
  // reverts `OwnerCountersignRequired` when `countersignAbove != 0 && value > countersignAbove`
  // and no owner approval accompanies the request. Without this check a caller could sign and
  // broadcast a request that the chain is guaranteed to reject — spending a signature and gas
  // on a doomed transaction. `countersignAbove == 0` means "never", matching the contract.
  //
  // The presence of an approval is checked, NOT its validity: verifying the owner signature
  // needs the owner's key, and on-chain remains the only authority for that. This check only
  // refuses the case where the chain would refuse unconditionally.
  if (scope.countersignAbove !== 0n && request.value > scope.countersignAbove) {
    const approval = args.ownerApproval;
    const hasApproval = typeof approval === "string" && approval.length > 2;
    if (!hasApproval) {
      return {
        ok: false,
        reason: `owner countersign required (value ${request.value} > countersignAbove ${scope.countersignAbove})`,
      };
    }
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
    // Bound the proof before it is walked (PERF-11). The verification loop below is
    // O(proof.length) synchronous work, and — more importantly — the on-chain
    // `MAX_SINGLE_PROOF_ELEMENTS = 8` rejects longer single-call proofs outright. Accepting
    // one locally would spend a signature and gas on a payload the chain reverts, which is
    // exactly the local-rejects-first property this pre-flight exists for.
    if (args.merkleProof.length > MAX_MERKLE_PROOF_ELEMENTS) {
      return {
        ok: false,
        reason: `merkle proof too long (${args.merkleProof.length} > ${MAX_MERKLE_PROOF_ELEMENTS} elements, on-chain MAX_SINGLE_PROOF_ELEMENTS)`,
      };
    }
    // Element-shape check, BEFORE the walk below. `sortedPairHash` calls `.toLowerCase()`
    // on both operands, so a non-string element (a number or null arriving from JSON) threw
    // a TypeError straight out of this function — which its own docblock promises never to
    // do: "Never throws: every rejection comes back as `{ ok: false, reason }`, so a caller
    // can branch without a try/catch." A caller following that contract got an exception
    // instead of a policy decision.
    //
    // Odd-length and non-hex strings do NOT throw — `keccak256` accepts them and the
    // resulting root simply fails to match — so only the type check is load-bearing here.
    // It is a check and not a coercion: silently stringifying a number would be inventing a
    // proof element the caller never supplied.
    for (let i = 0; i < args.merkleProof.length; i++) {
      if (typeof args.merkleProof[i] !== "string") {
        return {
          ok: false,
          reason: `merkle proof element ${i} is not a hex string (got ${typeof args.merkleProof[i]})`,
        };
      }
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
