/**
 * Structured revert decoding (enhancement E4): map SigilKit custom-error revert data
 * to named errors with decoded arguments. With the contract-side bubbling (E2),
 * known reasons survive to the integrator; this is the readable half of that loop.
 */
import { decodeErrorResult, type Hex } from "viem";
import { SIGILKIT_ERRORS_ABI } from "./abis.js";

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
    return { name: "UnknownError", raw: data, message: `UnknownError(${data.slice(0, 42)}…)` };
  }
}

/**
 * Walks a thrown error for revert `data` (viem wraps it in CallExecutionError and
 * friends) and appends the decoded SigilKit reason to the message when found.
 */
export function decorateWithDecodedRevert(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  let cursor: unknown = err;
  for (let depth = 0; depth < 5 && cursor; depth++) {
    const data = (cursor as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      const decoded = decodeSigilKitError(data as Hex);
      if (decoded.name !== "UnknownError") {
        const decorated = new Error(`${err.message} — ${decoded.message}`, { cause: err });
        decorated.name = decoded.name;
        return decorated;
      }
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return err;
}
