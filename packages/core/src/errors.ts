/**
 * Structured revert decoding (enhancement E4): map SigilKit custom-error revert data
 * to named errors with decoded arguments. With the contract-side bubbling (E2),
 * known reasons survive to the integrator; this is the readable half of that loop.
 *
 * This module is also the home of the SDK's error taxonomy: {@link SigilKitError}
 * and its subclasses are the stable, documented error surface, and every one of
 * them carries the `code` a caller can branch on. Every code in
 * {@link SigilKitErrorCode} is wired to a real throw site and pinned by a test, so
 * the documented surface and the thrown surface cannot drift apart silently.
 */
import { decodeErrorResult, type Address, type Hex } from "viem";
import { SIGILKIT_ERRORS_ABI } from "./abis.js";

/**
 * Machine-readable discriminant carried by every {@link SigilKitError}.
 *
 * These are part of the public API contract: branch on `err.code`, never on the
 * message text. Message wording is free to change between releases; codes are not.
 *
 * The union is exhaustive over the classes declared below, and `test/error-taxonomy.test.ts`
 * asserts that every one of them is actually reachable from a throw site — a code
 * that cannot be thrown would otherwise invite a branch that can never be taken.
 */
export type SigilKitErrorCode =
  /** A caller-supplied value failed validation. Carries `field`. */
  | "VALIDATION"
  /** The local policy pre-flight rejected the request before signing. */
  | "POLICY_REJECTED"
  /** `eth_call` reverted, so the transaction would fail on chain. */
  | "SIMULATION_REVERTED"
  /** The submitted transaction reverted; nothing was executed or audited. */
  | "EXECUTION_REVERTED"
  /** No receipt within the bounded wait; the outcome needs offline reconciliation. */
  | "RECEIPT_TIMEOUT"
  /** The mandatory `ActionLogged` audit event was missing from a successful tx. */
  | "AUDIT_MISSING"
  /** More than one matching `ActionLogged` record; evidence is ambiguous. */
  | "AUDIT_AMBIGUOUS"
  /** A cross-worker lease was lost or superseded; side effects were refused. */
  | "LEASE_LOST"
  /** The lease store is misconfigured or returned an unusable token. */
  | "LEASE_INVALID"
  /** A cross-process lease could not be taken; the key is busy elsewhere. */
  | "LEASE_BUSY"
  /** A lease-backed run crossed a sign/send boundary without a valid guard. */
  | "GUARD_MISSING";

/**
 * Base class for every error this SDK throws on purpose.
 *
 * Catching `SigilKitError` catches all of them at once, and `err.code` narrows to
 * a specific failure without string matching.
 *
 * **Every code in {@link SigilKitErrorCode} is wired to a real throw site** (API-ERR-1
 * completed 2026-09-26). `test/error-taxonomy.test.ts` drives each one and asserts both
 * `instanceof` and `.code`, and additionally scrapes the union literal out of this file
 * and compares it against the set of codes it can actually reach — so a class that is
 * declared but never thrown now fails the suite instead of quietly becoming an
 * unreachable branch. (Before that test existed, an earlier revision of this comment
 * claimed the migration was complete when six codes were still unwired, and nothing
 * caught it. That is the whole reason the check is mechanical rather than a note.)
 *
 * **`err.code` is a LAYERED signal, not an exhaustive enumeration.** Two independent
 * reasons mean a `catch` block can never be proven total from `code` alone:
 *
 *  1. **`parseActionRequest`'s shape errors stay plain `Error`.** A malformed `target` /
 *     `agentId` / `data` is a bare `Error`, not a `ValidationError`, so `case "VALIDATION"`
 *     does **not** cover it. Wiring the numeric-field sites without these leaves the most
 *     common untrusted-input failure unclassifiable.
 *  2. **viem, the RPC transport and the wallet client throw outside the taxonomy.** A
 *     `CallExecutionError`, `ProviderRpcError`, `NonceTooLowError` or
 *     `UserRejectedRequestError` all propagate with their own classes. `SigilKitError` is
 *     a taxonomy of *deliberate SDK failures*, not a wrapper around every error a process
 *     can throw.
 *
 * So keep a message-matching or `instanceof` fallback **alongside** the `code` switch, and
 * never read "the `switch` handled it" as "the error was classified". This is a property
 * of the design, not a migration bug.
 *
 * The classes that are *not* in this taxonomy at all are deliberate: `parseActionRequest`'s
 * per-field shape errors and the `merkleRoot` / `merkleProof` arity errors are
 * programming/argument errors that predate it and keep throwing plain `Error`. They are
 * argument-validation failures, not protocol outcomes, and folding them in would make
 * `code` too coarse to be a useful discriminant.
 *
 * ```ts
 * try {
 *   await client.execute(args, wallet);
 * } catch (e) {
 *   if (!(e instanceof SigilKitError)) throw e;   // not ours (or a bug in the caller)
 *   switch (e.code) {
 *     case "POLICY_REJECTED":       return retryWithSmallerValue(e);  // no gas spent
 *     case "SIMULATION_REVERTED":  return fixCalldata(e);
 *     case "RECEIPT_TIMEOUT":      return reconcileOnChain(e.txHash); // NOT a retry
 *     case "AUDIT_MISSING":        return pageSecurity(e.txHash);     // INV-3 breach
 *     // …every remaining code
 *   }
 * }
 * ```
 */
export class SigilKitError extends Error {
  /** Stable discriminant for `switch`/comparison. See {@link SigilKitErrorCode}. */
  readonly code: SigilKitErrorCode;

  constructor(code: SigilKitErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SigilKitError";
    this.code = code;
  }
}

/**
 * The local policy pre-flight rejected the request before a signature was produced.
 *
 * Thrown by `prepareExecution` (and therefore by `execute` / `executeSimulated`) when
 * `validateAgainstScope` returns `{ ok: false }`. To inspect the failure without a
 * try/catch, call `validateAgainstScope` yourself and branch on its result.
 *
 * **Nothing was signed and no gas was spent** when this fires — that is the whole point of
 * the pre-flight, so it is the cheap failure path.
 *
 * @example
 * ```ts
 * try {
 *   await client.execute(args, wallet);
 * } catch (e) {
 *   if (e instanceof PolicyRejectedError) {
 *     console.error("out of scope:", e.reason); // e.code === "POLICY_REJECTED"
 *   }
 * }
 * ```
 */
export class PolicyRejectedError extends SigilKitError {
  /** The `reason` string `validateAgainstScope` produced. */
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super("POLICY_REJECTED", `SigilKit policy rejection (pre-signature): ${reason}`, options);
    this.name = "PolicyRejectedError";
    this.reason = reason;
  }
}

/**
 * `eth_call` reverted, so sending the payload would have burned gas for nothing.
 *
 * Thrown by `SigilKitClient.executeSimulated` when `simulateExecution` reports a
 * revert. **Nothing was broadcast** — no nonce was consumed, no gas was spent.
 *
 * `simulateExecution` itself does NOT throw for a revert: it reports the condition as
 * `{ ok: false, reason }`. Use it when you want a typed, non-throwing result.
 */
export class SimulationRevertedError extends SigilKitError {
  /** The decoded revert reason (a SigilKit custom error when one was recognised). */
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super("SIMULATION_REVERTED", `SigilKit simulation rejection (no gas spent): ${reason}`, options);
    this.name = "SimulationRevertedError";
    this.reason = reason;
  }
}

/**
 * A cross-process lease could not be taken: the key is already held by another worker.
 *
 * Thrown by `NonceGate.run` when the configured `LeaseStore.acquire` declines a key
 * that is currently held elsewhere. This is a **normal, expected outcome** of running
 * a multi-process fleet, not a fault — back off and retry, or use a different session
 * key.
 *
 * Distinct from {@link LeaseLostError}: `LEASE_BUSY` means the run never started (no
 * side effects at all), whereas `LEASE_LOST` means a run *had* started and lost its
 * lease partway through.
 */
export class LeaseBusyError extends SigilKitError {
  /** The key that could not be acquired. */
  readonly key: Address;

  constructor(key: Address, options?: ErrorOptions) {
    super("LEASE_BUSY", `SigilKit NonceGate: key ${key} is busy in another worker`, options);
    this.name = "LeaseBusyError";
    this.key = key;
  }
}

/**
 * The configured `LeaseStore` returned a token the gate cannot treat as an ownership
 * proof (the v2 token API requires `key` + `id` + `epoch`).
 *
 * Also thrown for a lease store that only implements the key-only v1 API at all.
 * Both are **misconfiguration, not contention** — a v1 store cannot prove ownership,
 * so accepting it would silently weaken the cross-worker guarantee the gate exists to
 * provide. Retrying will not help; fix the store.
 */
export class LeaseInvalidError extends SigilKitError {
  /** The offending token, or the raw value the store returned, for diagnostics. */
  readonly detail: unknown;

  constructor(message: string, detail?: unknown, options?: ErrorOptions) {
    super("LEASE_INVALID", message, options);
    this.name = "LeaseInvalidError";
    this.detail = detail;
  }
}

/**
 * A lease-backed run crossed a sign/send boundary without presenting the guard its
 * `NonceGate.run` issued.
 *
 * Thrown by `SigilKitClient.assertGuard`, which every lease-backed execution path calls
 * before signing and before broadcasting. It covers three distinct mistakes: forgetting
 * the guard entirely, passing a guard that belongs to a *different* client or a
 * finished run, and passing a guard whose key is not the signing session key.
 *
 * This is the check that makes a cross-worker lease mean anything — without it, two
 * workers could each believe they hold the key and both broadcast.
 */
export class GuardMissingError extends SigilKitError {
  constructor(message: string, options?: ErrorOptions) {
    super("GUARD_MISSING", message, options);
    this.name = "GuardMissingError";
  }
}

/**
 * A submitted transaction reverted: nothing was executed and nothing was audited.
 * Safe to treat as "no state change" — unlike {@link ReceiptTimeoutError}, which
 * is emphatically not.
 *
 * Thrown by `assertAuditEmitted` and `sendPrepared` when a mined receipt has
 * `status: "reverted"`. The `nonce` WAS consumed, so a retry needs a fresh nonce
 * (which `prepareExecution` fetches for you) rather than a resubmit of the same one.
 */
export class ExecutionRevertedError extends SigilKitError {
  /** The transaction hash, always present for offline reconciliation. */
  readonly txHash: Hex;

  constructor(txHash: Hex, options?: ErrorOptions) {
    super("EXECUTION_REVERTED", `SigilKit: transaction ${txHash} reverted; nothing was executed or audited`, options);
    this.name = "ExecutionRevertedError";
    this.txHash = txHash;
  }
}

/**
 * No receipt arrived within the bounded wait.
 *
 * Thrown by `SigilKitClient.waitForReceipt`, the bounded wait shared by
 * `assertAuditEmitted` and `sendPrepared`.
 *
 * **This is not a "safe to retry" signal.** The nonce may already be consumed on
 * chain, so a blind resend reverts with `NonceUsed` and burns a second relayer slot.
 * Reconcile `txHash` against the chain before retrying.
 */
export class ReceiptTimeoutError extends SigilKitError {
  /** The transaction hash — mandatory for offline reconciliation. */
  readonly txHash: Hex;
  /** The bounded wait that elapsed, in ms. */
  readonly timeoutMs: number;

  constructor(txHash: Hex, timeoutMs: number, detail: string, options?: ErrorOptions) {
    super(
      "RECEIPT_TIMEOUT",
      `SigilKit: no receipt for ${txHash} within ${timeoutMs}ms (transaction not confirmed, ` +
        `possibly replaced on the same nonce) — reconcile ${txHash} against the chain before retrying; ` +
        `do NOT resend, the nonce is likely already consumed: ${detail}`,
      options,
    );
    this.name = "ReceiptTimeoutError";
    this.txHash = txHash;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A successful transaction carried no `ActionLogged` event — **an INV-3 violation.**
 *
 * Thrown by `sendPrepared` (and reachable from `assertAuditEmitted`, which returns
 * `false` rather than throwing when you want to handle the absence yourself). The
 * execution DID happen, but it produced no auditable evidence, so it must not be
 * treated as a clean success.
 *
 * This is the error that matters most in the taxonomy: it is the on-chain guardrail
 * noticing that its own audit trail is missing. A `switch` on `err.code` without an
 * `AUDIT_MISSING` arm is the bug this class exists to make impossible to miss.
 *
 * @example
 * ```ts
 * try {
 *   await client.sendPrepared(prepared, wallet);
 * } catch (e) {
 *   if (e instanceof AuditMissingError) {
 *     alert(`unauthenticated side effect in ${e.txHash}`); // INV-3 breach
 *   }
 *   throw e;
 * }
 * ```
 */
export class AuditMissingError extends SigilKitError {
  /** The transaction that succeeded without producing an audit event. */
  readonly txHash: Hex;

  constructor(txHash: Hex, options?: ErrorOptions) {
    super("AUDIT_MISSING", `SigilKit: ActionLogged missing in successful tx ${txHash} — INV-3 violated`, options);
    this.name = "AuditMissingError";
    this.txHash = txHash;
  }
}

/**
 * More than one `ActionLogged` record matched the audit expectations, so the evidence
 * cannot identify which action the transaction performed.
 *
 * Thrown by `parseActionLogged` (and therefore by `assertAuditEmitted` /
 * `sendPrepared`) when a receipt contains two matching audit events. Refusing to pick
 * the first is deliberate: silently choosing one of two audit records is how a
 * mismatched action gets attributed to the wrong request.
 */
export class AuditAmbiguousError extends SigilKitError {
  constructor(options?: ErrorOptions) {
    super("AUDIT_AMBIGUOUS", "SigilKit: ambiguous ActionLogged audit evidence", options);
    this.name = "AuditAmbiguousError";
  }
}

export interface DecodedSigilKitError {
  /** Custom-error name, or "UnknownError" when the selector is not SigilKit's. */
  name: string;
  /** Decoded arguments (positional), when the error decoded cleanly. */
  args?: readonly unknown[];
  /** The original revert data. */
  raw: Hex;
  /** Human-readable one-liner (e.g. "PerActionCapExceeded(value=1000, cap=500)"). */
  message: string;
}

function formatArgs(args: readonly unknown[]): string {
  if (!args || args.length === 0) return "";
  return "(" + args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ") + ")";
}

/**
 * Decodes revert data against the SigilKit custom-error surface. Unknown selectors
 * (third-party contracts, plain strings) come back as `UnknownError` with the raw
 * data preserved — callers decide how to present them.
 */
export function decodeSigilKitError(data: Hex): DecodedSigilKitError {
  try {
    const decoded = decodeErrorResult({ abi: SIGILKIT_ERRORS_ABI, data });
    return {
      name: decoded.errorName,
      args: decoded.args,
      raw: data,
      message: `${decoded.errorName}${formatArgs(decoded.args)}`,
    };
  } catch {
    return { name: "UnknownError", raw: data, message: `UnknownError(${truncateHex(data)})` };
  }
}

/**
 * Renders undecodable revert data for a log line: the `0x` prefix plus at most
 * {@link UNKNOWN_ERROR_HEX_CHARS} hex characters, with an ellipsis only when something was
 * actually dropped.
 *
 * The obvious `data.slice(0, 42)` is wrong in two ways: it spends 2 of the 42 characters on
 * the `0x` prefix (so only 40 hex chars — 20 bytes — of payload ever reach the log), and it
 * appends `…` unconditionally, so a short third-party selector is rendered as if it were
 * truncated. The 4-byte selector is the part worth keeping when triaging an unknown revert.
 */
const UNKNOWN_ERROR_HEX_CHARS = 8;

/**
 * How many `cause` links {@link walkRevertData} will follow.
 *
 * Bounded on purpose: the walk visits attacker-influenceable structures, and viem's own
 * wrappers are 3–4 deep (`CallExecutionError` → `ContractFunctionExecutionError` →
 * `ExecutionRevertedError` → `BaseError` → `ProviderRpcError`). Five links clears the real
 * stack with one spare, while keeping a self-referential `cause` from hanging the caller.
 */
const MAX_CAUSE_WALK_DEPTH = 5;

function truncateHex(data: string): string {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  const shown = body.slice(0, UNKNOWN_ERROR_HEX_CHARS);
  return `0x${shown}${body.length > shown.length ? "…" : ""}`;
}

/**
 * Walks a thrown error's `cause` chain for ABI-encoded revert data and returns the first
 * SigilKit payload found, or `null`.
 *
 * **Why this exists.** viem never puts revert `data` on the error it throws from
 * `eth_call` / `eth_sendTransaction`. `getRevertErrorData` (`viem/_esm/actions/public/call.js:163`)
 * pulls `data` off the node error, uses it locally for the CCIP-Read and counterfactual
 * checks, and then throws a `CallExecutionError` that carries only `cause`
 * (`viem/_esm/errors/contract.js:44-50` assigns `cause` and defines no `data`). So the
 * obvious `err.data` read is `undefined` on **every** real revert, and any custom-error
 * decoding keyed on it silently degrades to the wrapper's class name.
 *
 * Sharing this single walk between {@link decorateWithDecodedRevert} and the client's
 * `simulateExecution` is the point: two independent implementations of "where is the
 * revert data" is how the two paths end up disagreeing about what a given revert means.
 *
 * Bounded to {@link MAX_CAUSE_WALK_DEPTH} links and does not follow `AggregateError.errors`
 * or viem's `.walk()` convenience, so a self-referential `cause` cannot hang the caller.
 *
 * @param err the caught value; non-`Error` values yield `null`.
 * @returns the revert data hex, or `null` when the chain carries none (e.g. a transport
 *   failure, or a revert whose payload is shorter than a 4-byte selector).
 */
export function walkRevertData(err: unknown): Hex | null {
  let cursor: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_WALK_DEPTH && cursor; depth++) {
    const data = (cursor as { data?: unknown }).data;
    // A nested provider may report the payload as `{ data: { data: "0x…" } }`; viem's own
    // `getRevertErrorData` unwraps that shape, so we must too or we miss the payload.
    const inner = (data as { data?: unknown } | null)?.data;
    for (const candidate of [data, inner]) {
      if (typeof candidate === "string" && candidate.startsWith("0x") && candidate.length >= 10) {
        return candidate as Hex;
      }
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Walks a thrown error for revert `data` (viem wraps it in CallExecutionError and
 * friends) and appends the decoded SigilKit reason to the message when found.
 *
 * A {@link SigilKitError} is returned **unchanged**. This is load-bearing, not a
 * convenience: `sendPrepared` decorates whatever `waitForReceipt` threw, and
 * `ReceiptTimeoutError` carries the original revert-bearing error in `cause`. Without
 * the passthrough, decorating a `ReceiptTimeoutError` whose `cause` still holds SigilKit
 * revert `data` one link down would return a **plain** `Error` in its place — silently
 * dropping `code: "RECEIPT_TIMEOUT"` and `.txHash`, i.e. quietly downgrading a typed
 * "reconcile this on chain, do NOT resend" signal into an untyped string.
 *
 * @param err the caught value.
 * @returns `err` itself when it is already a {@link SigilKitError} (so `.code` survives),
 *   a new `Error` carrying the decoded reason when SigilKit revert data was found, or
 *   the original error untouched when there was nothing to decode.
 */
export function decorateWithDecodedRevert(err: unknown): Error {
  if (err instanceof SigilKitError) return err;
  if (!(err instanceof Error)) return new Error(String(err));
  const data = walkRevertData(err);
  if (data) {
    const decoded = decodeSigilKitError(data);
    if (decoded.name !== "UnknownError") {
      const decorated = new Error(`${err.message} — ${decoded.message}`, { cause: err });
      decorated.name = decoded.name;
      return decorated;
    }
  }
  return err;
}
