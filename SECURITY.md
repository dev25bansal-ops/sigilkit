# Security Notes — Slither Triage (2026-08-24)

`slither contracts/src` reports **12 findings across 5 contracts, zero high-severity bugs**
(re-run after the Aug-24 remediation pass added the module caller gate, uninstall gate,
EIP-2 low-s rejection, batch bounds, and derived ERC-7201 slot; the earlier
`uninitialized-local` info finding is fixed). Every remaining finding is a known, deliberate
design pattern of an agent-action executor. This file is the reference the CI Slither gate and
future auditors should check against.

| # | Detector | Location | Triage |
|---|----------|----------|--------|
| 1 | `arbitrary-send-eth` | `SessionKeyManager.executeWithSessionKey` | **ACCEPTED (by design).** The contract's purpose is executing scoped calls on behalf of agents. Value transfer is bounded by: per-action cap + fixed-window (tumbling) cap (`SpendPolicy.enforce`, effects-before-interaction), Merkle target/selector whitelist, hard key expiry, per-key nonces, and the owner-only selector denylist. A compromised SDK cannot exceed scope (enforcement is on-chain). The 7579 module does NOT send ETH itself — it validates; the account executes. |
| 2–8 | `timestamp` (×7) | expiry/window comparisons in both SessionKeyManager and SessionKey7579Module | **ACCEPTED.** Session-key expiry, request expiry, and fixed (tumbling) spend windows are inherently timestamp-based (same as ERC-4337 session keys). Miner skew (~12 s) is immaterial vs minute-scale windows; no oracle exists for cheaper on-chain time. Module note: `validateUserOp` binds authorization to `validUntil = scope.expiresAt`, so the entrypoint enforces the same bound independently. |
| 9–10 | `assembly` | `_manager()` / `_m()` storage slots | **ACCEPTED.** Single inline-asm accesses to ERC-7201 namespaced slots — the standard collision-safety pattern. |
| 11 | `low-level-calls` | inner `.call{value:}` | **ACCEPTED.** Arbitrary-target execution IS the product. Success asserted; mandatory `ActionLogged`; reentrancy-guarded; CEI ordering enforced. |
| 12–13 | `naming-convention` | `DOMAIN_SEPARATOR()`, `ACTION_REQUEST_TYPEHASH()` | **ACCEPTED.** Uppercase view accessors for EIP-712 constants follow ecosystem convention and are consumed by SDKs reading them on-chain. |

## Module-specific design notes (SessionKey7579Module)

- Validation-time window mutation is conservative: a validated-but-dropped op still counts against
  the fixed (tumbling) window. Prefer tight windows.
- Batch ops under a non-zero Merkle root REVERT (fail closed) — per-tuple proof framing is out of
  scope for v1; single-call ops carry proofs appended to the signature blob.
- No `ActionLogged` at validation time: validation passing ≠ execution landing (bundler may drop).
  Pair with an executor/hook for per-execution audit trails.

## Invariants under formal verification

- **INV-1**: window spend ≤ per-window cap **within any single fixed (tumbling) window** — covered by
  stateful invariant fuzz suite **and 4 Halmos symbolic specs** over the `SpendPolicy.enforce` core
  (exact-spend recording, over-cap reversion, rollover isolation, per-action cap) **plus 1
  auth-path spec** (`check_execute_WindowSpendNeverExceedsCap`). Window
  semantics: the window RESETS to zero when fully elapsed (tumbling, not sliding), so up to ~2×
  `perWindowCap` can legitimately cross a window boundary; a boundary-burst unit test pins this.
  Run: `halmos --match-contract Halmos` (11 specs: 6 spend-cap/Merkle core + 5 auth-path over a
  recover-seam harness).
- **INV-2**: expired or revoked keys cannot execute (covered by invariant fuzz suite).
- **INV-3**: `ActionLogged` emitted iff inner call succeeded (asserted in unit + TS E2E tests; on
  the 7579 path, `ActionLog7579Executor` emits it at execution time with the same negative
  guarantee — no audit on failed execution).
- **INV-4**: owner-only selectors unreachable via `executeWithSessionKey` (denylist, covered by
  unit + invariant suites).

## Governance posture (decided 2026-09 — issues catalog A2)

The manager is **immutable-by-design pre-mainnet**: no proxy/UUPS upgrade path exists before the
external audit; key migration happens via `rotateSessionKey` and denylist policy, not code
upgrades. Production deployments MUST set `SIGILKIT_OWNER_ADDRESS` to a governance contract
(2-of-3 Gnosis Safe per the build plan) — the deploy script then treats the broadcaster key as a
deployer with NO authority over the deployed manager. Plain-EOA ownership via
`SIGILKIT_OWNER_KEY` is supported for local/test only. Treasury recovery is the owner-only
`withdraw` (denylisted from session keys by default).

## Known limitation (documented, mitigated)

Calldata cannot observe nested/internal token transfers inside the target call, so
`request.value` may undercount actual outflow for targets that pull tokens mid-call.
Mitigations: trusted-target allowlists (e.g. routers that settle via permit2 without arbitrary
pulls), post-hoc reconciliation off-chain against cumulative `ActionLogged` records, and
argument-bound whitelist leaves. An SDK-side ERC-20 allowance pre-check is **planned but not
implemented** — do not rely on it.

## Whitelist leaf format v2 (argument binding)

Leaves commit the calldata: `leaf = keccak256(abi.encode(target, selector, argsHash))` with
`argsHash = keccak256(calldata)`. A **pinned** leaf authorizes exactly one calldata payload for
that target+selector (e.g. a single `transfer(recipient, amount)` — the compromised-agent drain
scenario is closed); the **wildcard** leaf (`argsHash = bytes32(0)`) authorizes any calldata for
the selector, matching the pre-v2 behavior. `keccak256` of real data is never zero, so the two
never collide. `SessionKeyManager._targetAllowed` / `SessionKey7579Module._whitelisted` accept a
proof against either form. Leaf format v2 supersedes the v0.1.0 preimage
(`abi.encode(target, selector)`); pre-mainnet this is a breaking root-format change by design.

---
*Generated from `slither .` runs of 2026-08-22/23 (slither-analyzer on solc 0.8.36 output).*
