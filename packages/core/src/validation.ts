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

/** Thrown when a caller-supplied value fails validation. Carries the field name. */
export class ValidationError extends Error {
  /** Name of the field that failed, e.g. "managerAddress" or "--rpc". */
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`${field}: ${detail}`);
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

/** True for a syntactically valid 20-byte hex address. */
export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && viemIsAddress(value);
}

/** Returns the address, or throws a {@link ValidationError}. */
export function assertAddress(value: unknown, field = "address"): Address {
  if (!isAddress(value)) {
    throw new ValidationError(field, `expected a 20-byte hex address (0x + 40 hex chars), got ${describe(value)}`);
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

/** Returns the hex string, or throws. Pass `{ bytes }` to pin the length. */
export function assertHex(value: unknown, field = "hex", opts: { bytes?: number } = {}): Hex {
  const want = opts.bytes === undefined ? "an even-length 0x-prefixed hex string" : `${opts.bytes} bytes of hex (0x + ${opts.bytes * 2} hex chars)`;
  if (!isHex(value, opts.bytes)) {
    throw new ValidationError(field, `expected ${want}, got ${describe(value)}`);
  }
  return value;
}

/** Returns a 32-byte hex value (hash, agent id, Merkle root), or throws. */
export function assertHash32(value: unknown, field = "hash"): Hex {
  return assertHex(value, field, { bytes: 32 });
}

/** Returns a 32-byte private key (non-zero), or throws. */
export function assertPrivateKey(value: unknown, field = "privateKey"): Hex {
  const key = assertHex(value, field, { bytes: 32 });
  if (/^0x0+$/.test(key)) {
    throw new ValidationError(field, "must not be the all-zero key");
  }
  return key;
}

/** True for a value that can be losslessly interpreted as a non-negative integer. */
export function isUintLike(value: unknown): boolean {
  if (typeof value === "bigint") return value >= 0n;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0;
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

/** Coerces to a bounded integer, or throws. Rejects NaN, floats and out-of-range. */
export function assertUint(value: unknown, field = "value", opts: { min?: number; max?: number } = {}): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new ValidationError(field, `expected an integer, got ${describe(value)}`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new ValidationError(field, `${n} is below the minimum ${opts.min}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new ValidationError(field, `${n} exceeds the maximum ${opts.max}`);
  }
  return n;
}

/** Returns a non-empty, non-blank string, or throws. */
export function assertNonEmptyString(value: unknown, field = "value"): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(field, `expected a non-empty string, got ${describe(value)}`);
  }
  return value;
}

/** Returns an http(s) URL, or throws. */
export function assertUrl(value: unknown, field = "url"): string {
  const raw = assertNonEmptyString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(field, `expected an absolute URL (e.g. http://127.0.0.1:8545), got ${describe(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new ValidationError(field, `expected an http(s)/ws(s) URL, got protocol ${parsed.protocol}`);
  }
  return raw;
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
