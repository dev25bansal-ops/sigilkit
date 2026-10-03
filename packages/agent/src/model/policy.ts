/**
 * The deterministic POLICY — the honest, auditable authority in this package.
 *
 * It serves two roles, and only the neural model borrows from it:
 *
 *  1. TEACHER. `teacherLabel` turns a normalized state vector into a training label,
 *     so the local model is *distilled from a transparent rule* rather than from a
 *     hand-wave. Every decision the model makes is explainable by this rule.
 *
 *  2. SAFETY. `safeAmountWei` computes the amount to propose, and it is hard-capped by
 *     the scope — the model never sets or raises an amount.
 *
 * This is why the model can be advisory: the authority is deterministic and checkable.
 */

export interface PolicyFeatures {
  /** Position within the fire cycle, 0..1. */
  readonly tickPhase: number;
  /** balance / perActionCap, clamped 0..1 — how much room is left. */
  readonly headroom: number;
  /** Remaining window budget / perWindowCap, clamped 0..1. */
  readonly windowRatio: number;
  /** Time-to-expiry normalized 0..1 (a deliberate DISTRACTOR: the rule ignores it). */
  readonly expiryUrgency: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export { clamp01 };

/**
 * The teacher rule: act when we are inside the fire window AND there is real balance
 * headroom AND the window still has budget. `expiryUrgency` is deliberately unused, so a
 * model that learns well must discover to ignore it — a falsifiable property we test.
 */
export function teacherLabel(f: PolicyFeatures): 0 | 1 {
  const inFireWindow = f.tickPhase >= 0.4 && f.tickPhase <= 0.9;
  const hasHeadroom = f.headroom >= 0.3;
  const windowOpen = f.windowRatio >= 0.2;
  return inFireWindow && hasHeadroom && windowOpen ? 1 : 0;
}

export interface SafeAmountInput {
  perActionCap: bigint;
  perWindowCap: bigint;
  windowSpendRemaining: bigint;
  balance: bigint;
  /** Upper fraction of the cap the policy is willing to use in one action, 0..1. */
  usageFraction?: number;
}

/**
 * The only amount a brain may ever propose: the smallest of (cap × usageFraction,
 * window remaining, balance headroom). Never exceeds perActionCap by construction.
 */
export function safeAmountWei(input: SafeAmountInput): bigint {
  const frac = clamp01(input.usageFraction ?? 0.5);
  const capped = (input.perActionCap * BigInt(Math.floor(frac * 10000))) / 10000n;
  let amount = capped;
  if (input.windowSpendRemaining < amount) amount = input.windowSpendRemaining;
  if (input.balance < amount) amount = input.balance;
  if (amount < 0n) amount = 0n;
  return amount;
}
