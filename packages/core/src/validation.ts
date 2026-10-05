/**
 * Input validation for the public surface (SDK, CLIs, MCP tools).
 *
 * Every `assert*` function either returns a narrowed value or throws a
 * {@link ValidationError} whose message names the offending field and shows a short,
 * safe rendering of what was actually passed. The goal is that a user wiring SigilKit
 * into an agent gets a sentence they can act on, not `undefined is not a function`
 * three frames deep.
 *
 * `is*` predicates are provided for the cases where throwing is wrong (optional
 * fields, feature detection).
 */
import { isAddress as viemIsAddress, type Address, type Hex } from "viem";
import { SigilKitError } from "./errors.js";

/**
 * Thrown when a caller-supplied value fails validation. Carries the field name.
 *
 * A {@link SigilKitError} (`code: "VALIDATION"`), so the whole validation family is
 * catchable with a single `catch (e) { if (e instanceof SigilKitError) … }` alongside
 * every other deliberate SDK failure. Existing `err instanceof ValidationError` and
 * `err.field` checks are unaffected — this is a widening of the prototype chain, not
 * a replacement.
 */
export class ValidationError extends SigilKitError {
  /** Name of the field that failed, e.g. "managerAddress" or "--rpc". */
  readonly field: string;

  constructor(field: string, detail: string) {
    super("VALIDATION", `${field}: ${detail}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

/** Short, safe rendering of a rejected value for error messages. */
function describe(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 66 ? `"${value.slice(0, 20)}…" (${value.length} chars)` : `"${value}"`;
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `${value}`;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  return String(value);
}

/** Describes only the type; never coerces or inspects sensitive input. */
function describeRedacted(value: unknown): string {
  return `${typeof value} (value withheld)`;
}

/**
 * True for a syntactically valid 20-byte hex address.
 *
 * "Valid" is stricter than it looks: besides 0x + 40 hex chars, viem's check also enforces
 * the **EIP-55 checksum**, so an all-uppercase or wrongly-mixed-case address is rejected even
 * though it has the right length. Lowercase (and correctly checksummed) input is accepted.
 */
export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && viemIsAddress(value);
}

/** Returns the address, or throws a {@link ValidationError}. */
export function assertAddress(value: unknown, field = "address"): Address {
  if (!isAddress(value)) {
    // The two failure modes need different fixes, so name both: a wrong LENGTH is a
    // truncation/padding bug, while correct length with a bad checksum is a case-folding
    // bug. "20-byte hex address" is kept as the leading phrase because callers and tests
    // match on it; the parenthetical after it is additive guidance.
    const wrongShape = typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
    const hint = wrongShape
      ? " (lowercase, or EIP-55 checksummed, is accepted — all-uppercase hex is not)"
      : "";
    throw new ValidationError(
      field,
      `expected a 20-byte hex address (0x + 40 hex chars), got ${describe(value)}${hint}`,
    );
  }
  return value;
}

/** True for `0x`-prefixed hex of the given byte length (any length when omitted). */
export function isHex(value: unknown, bytes?: number): value is Hex {
  if (typeof value !== "string" || !value.startsWith("0x")) return false;
  const body = value.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0) return false;
  return bytes === undefined || body.length === bytes * 2;
}

/** Returns the hex string, or throws. Pass `{ bytes }` to pin the length, `{ redacted: true }` to withhold the value (SK-02). */
export function assertHex(value: unknown, field = "hex", opts: { bytes?: number; redacted?: boolean } = {}): Hex {
  const want = opts.bytes === undefined ? "an even-length 0x-prefixed hex string" : `${opts.bytes} bytes of hex (0x + ${opts.bytes * 2} hex chars)`;
  if (!isHex(value, opts.bytes)) {
    const got = opts.redacted === true ? describeRedacted(value) : describe(value);
    throw new ValidationError(field, `expected ${want}, got ${got}`);
  }
  return value;
}

/** Returns a 32-byte hex value (hash, agent id, Merkle root), or throws. */
export function assertHash32(value: unknown, field = "hash"): Hex {
  return assertHex(value, field, { bytes: 32 });
}

/** Returns a 32-byte private key (non-zero), or throws. The rejected value is never echoed. */
export function assertPrivateKey(value: unknown, field = "privateKey"): Hex {
  const key = assertHex(value, field, { bytes: 32, redacted: true });
  if (/^0x0+$/.test(key)) {
    throw new ValidationError(field, "must not be the all-zero key");
  }
  return key;
}

/** Exclusive upper bound for any ABI-typed uint / EIP-7702 tuple field (2^256). */
export const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * Losslessly converts `bigint | number | decimal string` to a **non-negative** bigint, or
 * returns `null` when the value cannot be interpreted that way.
 *
 * The canonical form of a *signed* uint field is the non-negative bigint, and a signed field
 * must have exactly one unambiguous textual/numeric form. So — unlike
 * {@link assertBigInt}, which also serves *offset* / signed CLI arguments — this rejects
 * negatives, floats, booleans, `null`/`undefined`, arrays, objects, and hex strings
 * (`"0x10"`, which `BigInt()` would silently read as 16). A value already out of `uint256`
 * range is *not* rejected here: callers whose ABI type is narrower (or who RLP-encode their
 * own scalars, like the EIP-7702 pre-image) pass their own `max`.
 *
 * ## Why `number` needs a range check, not just an integer check
 *
 * Every `number` above 2^53 is already an "integer" to IEEE-754, so `Number.isInteger`
 * accepts 2^53+1 — a value it cannot actually represent. `BigInt(Number(2n ** 53n + 1n))`
 * is 9007199254740992,
 * i.e. a **different chain id / nonce / amount** than the caller wrote. JSON has no bigint, so
 * an LLM- or JSON-supplied id above 2^53 arrives exactly this way, and the result is a
 * signature over a *wrong* domain with no error anywhere. Hence:
 *
 *  - `chainId` / `nonce` (EIP-7702): `Number.isSafeInteger` is required, so the largest
 *    accepted chain id is 9007199254740991.
 *  - `expiry` / `windowStart` (unix seconds, ABI `uint48`): the *ABI type width* is the real
 *    constraint, and it is ~2^48 — an order of magnitude below 2^53. Because EVERY uint48
 *    value is already exactly representable as a `number`, the `Number.isSafeInteger` check
 *    rejects no legitimate timestamp while still refusing an unrepresentable one. The
 *    narrower `uint48` bound is then applied by the caller (see `assertUintField`'s `max`).
 *
 * The error message names the `max` when one is supplied, so a caller that hits the
 * uint256/uint48 boundary is told which limit it crossed instead of guessing.
 */
export function toUnsignedBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  // `Number.isInteger` alone is NOT losslessness: every float >= 2^53 is already an integer
  // to IEEE-754, so `2**53 + 1` passes and `BigInt()` then returns 9007199254740992n — a
  // DIFFERENT chain id / nonce than the caller wrote, with no error anywhere. Because a
  // uint48 unix timestamp (~2^48) is far below 2^53, requiring `Number.isSafeInteger`
  // rejects no legitimate value here while still refusing an unrepresentable one.
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/**
 * Lossless non-negative bigint conversion for a *signed* uint field, or throws.
 *
 * @param max inclusive upper bound for the field's backing ABI type (default `uint256`).
 */
export function assertUintField(value: unknown, field: string, max: bigint = MAX_UINT256): bigint {
  const out = toUnsignedBigInt(value);
  if (out === null) {
    const bound = max === MAX_UINT256 ? "" : ` in [0, ${max}]`;
    throw new ValidationError(
      field,
      `expected a non-negative integer${bound} as bigint, integer number or decimal string, got ${describe(value)}`,
    );
  }
  if (out > max) {
    throw new ValidationError(field, `${out} exceeds the maximum ${max} for this field`);
  }
  return out;
}

/**
 * True for a value that can be losslessly interpreted as a non-negative integer.
 *
 * "Losslessly" is the binding word: a `number` above 2^53 is already an integer to
 * IEEE-754 but cannot represent the value it was written as, so it is not uint-like.
 * Mirrors {@link assertBigInt}'s acceptance rules — use it where throwing is wrong.
 */
export function isUintLike(value: unknown): boolean {
  if (typeof value === "bigint") return value >= 0n;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
  // `.trim()` is deliberate and matches {@link assertUint}: a whitespace-padded
  // integer is one unambiguous value, and the trimming is applied consistently by
  // every gate. `toUnsignedBigInt` is the stricter sibling (it requires the raw
  // string to already be digits, because it feeds a SIGNED pre-image) — see the
  // note there. The two differ only on padded input, never on the VALUE.
  if (typeof value === "string") return /^[0-9]+$/.test(value.trim());
  return false;
}

/** Coerces bigint | number | decimal string to bigint, or throws. */
export function assertBigInt(value: unknown, field = "value", opts: { min?: bigint; max?: bigint } = {}): bigint {
  let out: bigint;
  if (typeof value === "bigint") {
    out = value;
  } else if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new ValidationError(field, `expected an integer, got ${describe(value)}`);
    }
    // `Number.isInteger` alone is NOT enough: every float ≥ 2^53 is already an integer in
    // IEEE-754 terms, so 2^53+1 and 2^53+2 are indistinguishable and both round. JSON has no
    // bigint, so an LLM- or JSON-supplied cap above 2^53 arrives exactly this way — and it
    // would be silently rounded, breaking the "exact amount" promise with a one-directional
    // error of up to hundreds of wei. Refuse rather than launder it.
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError(field, "number exceeds safe integer range; pass a decimal string");
    }
    out = BigInt(value);
  } else if (typeof value === "string" && /^-?[0-9]+$/.test(value.trim())) {
    out = BigInt(value.trim());
  } else {
    throw new ValidationError(field, `expected an integer (bigint, number or decimal string), got ${describe(value)}`);
  }
  if (opts.min !== undefined && out < opts.min) {
    throw new ValidationError(field, `${out} is below the minimum ${opts.min}`);
  }
  if (opts.max !== undefined && out > opts.max) {
    throw new ValidationError(field, `${out} exceeds the maximum ${opts.max}`);
  }
  return out;
}

/**
 * Coerces to a bounded integer, or throws. Rejects NaN, floats and out-of-range.
 *
 * ## Why a string must match `/^-?\d+$/` before `Number()` sees it
 *
 * `Number()` is far more permissive than "an integer": it also accepts `"0x10"`
 * (→ 16), `"1e3"` (→ 1000), `"+1"` (→ 1), `"1.0"` (→ 1) and whitespace-padded
 * forms. Each of those denotes a *different* value than the plain-decimal reading
 * a human — or a model emitting a CLI flag — would give it, and all of them are
 * reachable without any chain interaction:
 *
 *  - `assertUint` backs `SIGILKIT_CHAIN_ID` / `SIGILKIT_CONFIRMATIONS` /
 *    `SIGILKIT_MAX_BLOCK_RANGE` (`config.ts`), the `--chain-id` / `--limit` /
 *    `--confirmations` / `--max-range` flags (`cli.ts`), and the MCP tool
 *    arguments `expiresAt` / `windowSeconds` / `chainId` / `limit` (`mcp/server.ts`).
 *
 * A wrong chain id is not a cosmetic error: it is a different EIP-712 domain
 * (see `signing.ts` `actionRequestDigest`) and a different signing domain, and it
 * is silently accepted today. The whitelist below makes the textual form
 * unambiguous — exactly the same rule `toUnsignedBigInt` already applies to the
 * bigint-returning siblings — so a value has ONE representation across the SDK.
 *
 * `Number.isSafeInteger` (not `isInteger`) is the losslessness precondition: every
 * float >= 2^53 is already an integer to IEEE-754, so `2**53` used to pass and be
 * silently rounded to a different value. Every real value for these callers
 * (chain ids, block heights, counts, unix seconds) is orders of magnitude below 2^53.
 */
export function assertUint(value: unknown, field = "value", opts: { min?: number; max?: number } = {}): number {
  if (typeof value === "string") {
    if (!/^-?[0-9]+$/.test(value.trim())) {
      throw new ValidationError(field, `expected an integer, got ${describe(value)}`);
    }
    const parsed = Number(value.trim());
    if (!Number.isSafeInteger(parsed)) {
      throw new ValidationError(
        field,
        `expected an integer within the safe range (<= ${Number.MAX_SAFE_INTEGER}), got ${describe(value)}`,
      );
    }
    if (opts.min !== undefined && parsed < opts.min) {
      throw new ValidationError(field, `${parsed} is below the minimum ${opts.min}`);
    }
    if (opts.max !== undefined && parsed > opts.max) {
      throw new ValidationError(field, `${parsed} exceeds the maximum ${opts.max}`);
    }
    return parsed;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    // Message keeps the "expected an integer" prefix the existing callers/tests match on,
    // and names the safe-range cause so the failure is actionable.
    throw new ValidationError(
      field,
      typeof value === "number" && Number.isInteger(value)
        ? `expected an integer within the safe range (<= ${Number.MAX_SAFE_INTEGER}), got ${describe(value)}`
        : `expected an integer, got ${describe(value)}`,
    );
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new ValidationError(field, `${value} is below the minimum ${opts.min}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new ValidationError(field, `${value} exceeds the maximum ${opts.max}`);
  }
  return value;
}

/** Returns a non-empty, non-blank string, or throws. */
export function assertNonEmptyString(value: unknown, field = "value"): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(field, `expected a non-empty string, got ${describe(value)}`);
  }
  return value;
}

/** Returns an http(s)/ws(s) URL without echoing rejected input. */
export function assertUrl(value: unknown, field = "url"): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(field, "expected a non-empty URL (value withheld)");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(field, "expected an absolute URL (e.g. http://127.0.0.1:8545); value withheld");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new ValidationError(field, "expected an http(s)/ws(s) URL protocol; value withheld");
  }
  return value;
}

/** Returns the value when it is one of `allowed`, or throws listing the options. */
export function assertOneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(field, `expected one of ${allowed.join(" | ")}, got ${describe(value)}`);
  }
  return value as T;
}

/** Collects validation failures instead of throwing on the first one. */
export class ValidationCollector {
  private readonly errors: ValidationError[] = [];

  /** Runs `fn`, recording any {@link ValidationError} it throws. Returns the value or undefined. */
  check<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ValidationError) {
        this.errors.push(err);
        return undefined;
      }
      throw err;
    }
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }

  get messages(): string[] {
    return this.errors.map((e) => e.message);
  }

  /** Throws a single aggregated error when anything failed. */
  throwIfAny(context: string): void {
    if (this.errors.length === 0) return;
    const err = new ValidationError(context, `${this.errors.length} problem(s):\n  - ${this.messages.join("\n  - ")}`);
    throw err;
  }
}
