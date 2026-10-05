/**
 * Policy-clock injection: the local pre-flight is a pure function of its arguments.
 *
 * WHY THIS FILE EXISTS (the architectural point, not just coverage).
 *
 * `validateAgainstScope` mirrors two on-chain expiry reverts
 * (`block.timestamp > scope.expiresAt` and `block.timestamp > request.expiry`), and those
 * comparisons are off-by-one sensitive. BUG-3 was precisely such a boundary defect: the
 * local check used `>=` where the contract uses `>`, so the SDK refused a request in the
 * key's final valid second — a transaction the chain would have accepted.
 *
 * Until the clock was injectable, the only way to pin that edge was to reach for
 * `vi.useFakeTimers()` / `vi.setSystemTime()` and freeze time for the WHOLE file. That is
 * a compensation, not a solution, and it has three costs:
 *
 *  1. The assertion no longer states its own preconditions. A reader cannot see what "now"
 *     is without scanning the enclosing `beforeEach`, and the test's correctness depends on
 *     a line 50 lines away from the `expect`.
 *  2. The freeze is process-global, so it silently governs every OTHER assertion in the
 *     file — including ones added later by someone who has no idea time is being hijacked.
 *     `vitest.config.ts` runs this suite with `isolate: false`, precisely so a global timer
 *     left armed by one file can leak into the next.
 *  3. It cannot express "this verdict must be identical for ALL instants inside a window".
 *     A frozen clock proves one point; the property the contract actually states is a
 *     quantifier over every second, which needs a range.
 *
 * With an injected clock each case below is an ordinary pure function call: the instant is
 * a local `const`, the assertion is self-contained, and nothing global is mutated. That
 * also makes the range property (check 6) expressible at all.
 */
import { describe, expect, it } from "vitest";
import { validateAgainstScope, type ActionRequest, type Scope } from "../src/index.js";
import type { Hash, Hex } from "viem";

/** A clock frozen at an exact unix second. */
const at = (sec: number) => (): number => sec;

const SCOPE: Scope = {
  expiresAt: 1_900_000_000,
  windowSeconds: 600,
  perActionCap: 2n * 10n ** 18n,
  perWindowCap: 5n * 10n ** 18n,
  merkleRoot: `0x${"0".repeat(64)}` as Hash,
  countersignAbove: 0n,
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

/**
 * A scope that is still valid well past `1_900_000_000`.
 *
 * Needed because the checks run in a FIXED order (the conformance table on
 * `validateAgainstScope`): scope expiry is #1 and request expiry is #4, so a case that
 * wants to observe #4 must keep #1 passing. Reusing `SCOPE` for both made a request-expiry
 * case report `scope hard-expired` instead — the check order, not a defect.
 */
const LONGER_SCOPE: Scope = { ...SCOPE, expiresAt: 1_900_010_000 };

const TARGET = "0x0000000000000000000000000000000000000001" as `0x${string}`;

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    agentId: `0x${"11".repeat(32)}` as Hash,
    target: TARGET,
    selector: "0x32145f90" as Hex,
    value: 0n,
    nonce: 0n,
    // Default to an instant well inside every window; each case overrides the fields it
    // is actually about, so a case never depends on the wall clock.
    expiry: 1_900_000_000,
    rationaleHash: `0x${"22".repeat(32)}` as Hash,
    data: "0x",
    ...overrides,
  };
}

describe("validateAgainstScope with an injected clock", () => {
  // The two edges the contract pins. `>` on-chain means equality is STILL valid, so the
  // valid set is closed at the boundary and open above it.
  it("accepts at the exact scope-expiry second (contract: only `>` reverts)", () => {
    expect(
      validateAgainstScope({ request: request(), scope: SCOPE, clock: at(1_900_000_000) }),
    ).toEqual({ ok: true });
  });

  it("rejects one second past the scope expiry (BUG-3 regression pin)", () => {
    expect(
      validateAgainstScope({ request: request(), scope: SCOPE, clock: at(1_900_000_001) }),
    ).toEqual({ ok: false, reason: "scope hard-expired" });
  });

  it("accepts at the exact request-expiry second (Q5 off-by-one pin)", () => {
    expect(
      validateAgainstScope({ request: request({ expiry: 1_900_000_000 }), scope: LONGER_SCOPE, clock: at(1_900_000_000) }),
    ).toEqual({ ok: true });
  });

  it("rejects one second past the request expiry", () => {
    expect(
      validateAgainstScope({ request: request({ expiry: 1_900_000_000 }), scope: LONGER_SCOPE, clock: at(1_900_000_001) }),
    ).toEqual({ ok: false, reason: "request already expired" });
  });

  it("reads the clock exactly ONCE, so a mid-call tick cannot split the verdict", () => {
    // The injected clock is called once and its value reused for every check. A clock that
    // returned 1_900_000_000 on the first call and 1_900_000_002 on the second would let a
    // request that is valid at grant-time be reported as "request already expired" — a
    // verdict that no single instant supports. Counting calls pins that invariant.
    let calls = 0;
    const ticking = (): number => {
      calls += 1;
      return 1_900_000_000 + calls;
    };
    validateAgainstScope({ request: request({ expiry: 1_900_000_000 }), scope: LONGER_SCOPE, clock: ticking });
    expect(calls).toBe(1);
  });

  it("holds for EVERY instant in the valid range, not just one frozen point", () => {
    // The property the contract actually states is a quantifier over time; a frozen clock
    // can only ever witness a single sample of it.
    for (let t = 1_900_000_000 - 5; t <= 1_900_000_000; t++) {
      expect(
        validateAgainstScope({ request: request({ expiry: 1_900_000_000 }), scope: LONGER_SCOPE, clock: at(t) }),
      ).toEqual({ ok: true });
    }
    for (let t = 1_900_000_001; t <= 1_900_000_005; t++) {
      expect(
        validateAgainstScope({ request: request({ expiry: 1_900_000_000 }), scope: LONGER_SCOPE, clock: at(t) }),
      ).toEqual({ ok: false, reason: "request already expired" });
    }
  });

  it("ignores window state from a window that has already closed", () => {
    const now = 1_900_000_000;
    expect(
      validateAgainstScope({
        request: request({ value: 10n ** 18n }),
        scope: SCOPE,
        windowState: { windowStart: now - SCOPE.windowSeconds - 1, spentThisWindow: 4500n * 10n ** 15n },
        clock: at(now),
      }),
    ).toEqual({ ok: true });
  });

  it("charges an in-window balance against the per-window cap", () => {
    const now = 1_900_000_000;
    expect(
      validateAgainstScope({
        request: request({ value: 10n ** 18n }),
        scope: SCOPE,
        windowState: { windowStart: now - 10, spentThisWindow: 4500n * 10n ** 15n },
        clock: at(now),
      }),
    ).toEqual({ ok: false, reason: "per-window cap exceeded (5500000000000000000 > 5000000000000000000)" });
  });

  it("falls back to the system clock when none is supplied (back-compat)", () => {
    // Omitting `clock` must behave exactly as before this option existed — otherwise
    // making the clock injectable would have been a breaking change.
    const future = Math.floor(Date.now() / 1000) + 600;
    expect(
      validateAgainstScope({ request: request({ expiry: future }), scope: { ...SCOPE, expiresAt: future + 600 } }),
    ).toEqual({ ok: true });
  });

  it("treats a fractional clock reading as the containing second", () => {
    // A millisecond timestamp must not be compared against a seconds-valued expiry, and a
    // sub-second reading must floor rather than round: 0.9s into a second is still that
    // second, so a request valid through it stays valid.
    expect(
      validateAgainstScope({ request: request({ expiry: 1_900_000_000 }), scope: LONGER_SCOPE, clock: at(1_900_000_000.999) }),
    ).toEqual({ ok: true });
  });
});
