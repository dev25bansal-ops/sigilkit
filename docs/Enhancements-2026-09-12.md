# SigilKit — Enhancements & Modifications Analysis

**Date:** 2026-09-12 · **Baseline:** `master` @ `38fe1cd` (post-remediation; all 23 closed issues from `docs/Issues-Catalog-2026-09-11.md` reflected)

Method: component-by-component review of the current implementation against the product thesis ("scoped, capped, audited agent execution"), the vault's recorded opportunities, and the gaps left deliberately open by the remediation. Every item states the concrete change, the benefit, and the honest trade-off. Cross-references to the catalog use its IDs (S1, A3, …).

---

## Priority matrix

| # | ID | Enhancement | Area | Effort | Priority |
|---|----|-------------|------|--------|----------|
| 1 | E1 | `WindowCharged` spend event | Contracts | 2–3 h | **P1** |
| 2 | E2 | Inner-call revert bubbling | Contracts | 3–4 h | **P1** |
| 3 | E3 | Typed audit parsing + one-call `execute` | SDK | 6–8 h | **P1** |
| 4 | E4 | Structured revert decoding (SDK) | SDK | 4 h | **P1** |
| 5 | E5 | Generated-ABI drift gate | Toolchain | 3–4 h | **P1** |
| 6 | E6 | Tag-gated npm publish workflow | Toolchain | 4–6 h | **P1** |
| 7 | E7 | Golden-vector corpus | Testing | 6–8 h | **P1** |
| 8 | E8 | Allowance/balance pre-check (v2-aware) | SDK | 6–8 h | **P2** |
| 9 | E9 | `@sigilkit/indexer` (ActionLog consumer) | New pkg | 3–5 d | **P2** |
| 10 | E10 | Graduated authority (owner countersign) | Contracts | 8–12 h | **P2** |
| 11 | E11 | Balance-delta enforcement | Contracts | 12–16 h | **P2** |
| 12 | E12 | Simulation mode (`simulateExecution`) | SDK | 3–4 h | **P2** |
| 13 | E13 | `SigilKitDelegator` — EIP-7702 native wallet | Contracts | 3–5 d | **P2** |
| 14 | E14 | `@sigilkit/mcp` — agent-framework server | New pkg | 3–5 d | **P2** |
| 15 | E15 | Sliding-window damping (opt-in) | Contracts | 12–16 h | **P3** |
| 16 | E16 | Per-tuple proofs for whitelisted batches | Contracts | 16–24 h | **P3** |
| 17 | E17 | ERC-7739/ERC-1271 session keys | Contracts | 3–5 d | **P3** |
| 18 | E18 | Multi-process nonce coordination adapter | SDK | 6–10 h | **P3** |
| 19 | E19 | Echidna/medusa property port | Testing | 6–10 h | **P3** |
| 20 | E20 | Fleet demo + run manifests | Demo | 4–6 h | **P3** |

Dependency highlights: E3/E4 need E2 (bubbled errors give the decoder something to decode). E8 needs S1's v2 pinned leaves (already shipped). E13 benefits from E1–E4 being in place. E9 pairs with E1. E6 should land before any npm publish (which follows catalog A1).

---

## A. Enforcement layer (`SpendPolicy.sol`, `SessionKeyManager.sol`)

### E1 — `WindowCharged` spend event (P1, 2–3 h)

**Current state.** The only per-action signal is `ActionLogged`. It records the *request's* declared value, but nothing records the *window accounting* — and `ActionLogged` is not emitted at all on the 7579 validator path (by design). Integrators cannot reconstruct an agent's window position from events alone.

**Enhancement.** Declare and emit `event WindowCharged(address indexed account, address indexed key, uint256 value, uint48 windowStart, uint256 spentThisWindow)` from `SpendPolicy.enforce` (Solidity libraries may declare and emit events), after the effects write.

**Implementation approach.**
```solidity
// SpendPolicy.sol — after `window.spentThisWindow = projected;`
emit WindowCharged(address(0) /*placeholder*/, uint48(0), value, start, projected);
```
Libraries have no access to the caller's storage mappings, so the account/key identity must be passed in as two extra parameters to `enforce` (both call sites have them: `SessionKeyManager.sol` passes `signer`, the module passes `(account, signer)` — change the signature to `enforce(window, account, key, value, caps…)` and emit `WindowCharged(account, key, value, start, projected)`). Update the two call sites, the invariant harness ghost bookkeeping, and `ACTION_LOGGED_TOPIC`-style SDK constants.

**Benefits.** Off-chain reconciliation of native spend per key per window from raw logs; the future indexer (E9) gets its primary fact table for free; the "validated-but-dropped op still burns window" behavior on the 7579 path becomes *observable* rather than just documented.

**Trade-offs.** +1 log (~1.9k gas) per execution — material relative to the ~123k execute path but small; twice as many events for indexers. The `enforce` signature change touches every consumer (both contracts + tests) — acceptable pre-mainnet.

### E2 — Inner-call revert bubbling (P1, 3–4 h)

**Current state.** `SessionKeyManager.sol:291-292` discards the inner call's revert data:
```solidity
(bool ok,) = request.target.call{value: request.value}(...);
if (!ok) revert InnerCallFailed();
```
An agent whose target call fails (bad ERC-20 `transfer` return, router slippage, missing allowance) gets an opaque `InnerCallFailed` with zero diagnostic content. The SDK then surfaces a generic revert. This is the single biggest debugging pain integrators will hit.

**Enhancement.** Bubble the inner revert reason when it decodes to a *known* SigilKit/custom error or a standard error, and only fall back to `InnerCallFailed` otherwise.

**Implementation approach.** Capture returndata, then:
```solidity
if (!ok) {
    bytes memory reason = ret; // from (ok, ret) = call(...)
    // 4-byte selector of a known error, or empty (plain require) → bubble raw
    if (reason.length == 0 || _isKnownSelector(bytes4(reason))) assembly { revert(add(reason,32), mload(reason)) }
    revert InnerCallFailed();
}
```
`_isKnownSelector` whitelists `SpendPolicy.PerActionCapExceeded/PerWindowCapExceeded`, `ERC20TransferFailed`-class errors, `Error(string)`, and `Panic(uint256)` — the invariant guarantee "all manager failures are recognizable" is preserved because unknown selectors still collapse to `InnerCallFailed`. Add a candidate-list unit test and an SDK-side counterpart (E4).

**Benefits.** Integrators and the demo get actionable failures ("token transfer returned false", "slippage") instead of a dead end; support burden drops; the E4 decoder becomes genuinely useful.

**Trade-offs.** Tooling that matches specifically on `InnerCallFailed` must widen (documented + semver-minor). Bubbling raw inner data means third-party error text can appear in revert reasons — mitigated by the known-selector allowlist. Effort: ~3 h contract + tests.

### E3 — One-call `execute` + typed audit parsing (P1, 6–8 h)

**Current state.** The SDK's terminal API is `prepareExecution` → calldata; the integrator hand-rolls send, receipt wait, status check, and log scanning (the demo does this in ~20 lines). `assertAuditEmitted` returns a boolean — it never surfaces *what* was audited.

**Enhancement.** Two additions to `SigilKitClient`:
```ts
async execute(args: PrepareArgs, walletClient: WalletClient): Promise<{ receipt; audit?: ActionLogRecord }>
export function parseActionLogged(logs: Log[]): ActionLogRecord | null
// ActionLogRecord = { agentId, target, selector, value: bigint, rationaleHash, timestamp: number, blockNumber, txHash }
```
`execute` = prepare → sendTransaction → waitForTransactionReceipt → status check → `parseActionLogged` (null ⇒ throw, preserving INV-3 semantics of `assertAuditEmitted`, which stays as the primitive).

**Implementation approach.** Use viem `decodeEventLog` with the `ActionLogged` ABI (exported from a new `abis.ts`, which E5 later generates). `execute` accepts `{ relayer?: HashSigner & { address } }` defaulting to a provided wallet client; document the NonceGate composition (`client.nonceGate.run(key, () => client.execute(…))`).

**Benefits.** The demo and integration guides collapse to a single call; typed audit records make downstream compliance features (per-agent spend reports) trivial; it is the API the MCP server (E14) will call.

**Trade-offs.** Second, higher-level API to maintain alongside the primitive (kept, not replaced — power users still need calldata-only mode for bundlers/relayers). Wallet-client typing across viem versions is mildly annoying — pin the surface to the minimal `sendTransaction` shape.

### E4 — Structured revert decoding (P1, 4 h)

**Current state.** Every custom error is defined only in Solidity; a caught revert in TS is an opaque `0x…` string. After E2, known errors bubble — but nobody can read them.

**Enhancement.** `export function decodeSigilKitError(data: Hex): DecodedError` — a hand-written registry mapping the ~15 custom-error selectors (manager, module, executor, SpendPolicy) to `{ name, args }` via viem `decodeErrorResult`, with a fallback `UnknownError`. Wire it into `execute`/`assertAuditEmitted` catch paths so rejections read like `PerActionCapExceeded(value=1.2 ETH, cap=1 ETH)`.

**Benefits.** Closes the on-chain→off-chain diagnostics loop begun by E2; demo logs become self-explanatory; agent frameworks can branch on error *types* (e.g. back off on window-cap, fail fast on whitelist).

**Trade-offs.** Selector registry must track contract changes — pair it with E5's drift gate (generate the table from `forge inspect` output). Runtime cost negligible.

### E5 — Generated-ABI drift gate (P1, 3–4 h)

**Current state.** `SESSION_KEY_MANAGER_ABI` in `client.ts:23-88` is hand-maintained. The ABI's custom-error surface is *already* incomplete (errors are not in it, which E4 exposes). Any contract change can silently desynchronize SDK encoding from on-chain reality — the conformance tests would catch functional breaks, but only at test time, late.

**Enhancement.** Make the compiler the source of truth:
1. CI step: `forge inspect SessionKeyManager abi > packages/core/abis/sessionKeyManager.json` (same for module + executor) and commit results in the same PR.
2. A vitest guard test: recompute `keccak256(JSON.stringify(abis))` vs the file and assert the hand-maintained `SESSION_KEY_MANAGER_ABI` matches the generated function/ABI set for the functions it declares.
3. Long term, migrate `SESSION_KEY_MANAGER_ABI` to import the generated JSON (typed via `as const`).

**Benefits.** Eliminates the ABI-drift failure class permanently; E4's error registry can be generated from the same artifacts; publish packaging (`files`) already includes dist, so nothing else changes.

**Trade-offs.** Generated JSON adds noise to SDK diffs; requires forge in the TS-build environment (already required — the test suite spawns Anvil).

### E6 — Tag-gated publish workflow (P1, 4–6 h)

**Current state.** Publishing is fully manual; catalog A1's repo creation is pending; nothing enforces "dist is fresh, tests green, pack sane" at release time. `@sigilkit/core` is publishable (not `private`) but has never shipped.

**Enhancement.** `.github/workflows/publish.yml`: on tag `v*` → `npm ci`, forge + TS suites, `npm run build --workspaces`, `npm publish --provenance --access public -w @sigilkit/core` (tag-gated environment with npm token secret), plus `npm pack --dry-run` artifact. Semver checklist lives in CHANGELOG (already in Keep-a-Changelog form).

**Benefits.** Turns "publish" into a one-command, evidenced act; provenance builds supply-chain trust (relevant to the security brand); unblocks the npm half of catalog A1 immediately after repo creation.

**Trade-offs.** Requires configuring the npm token secret (one-time). Provenance requires public repo + npm ≥ 9.5 — both satisfied post-A1.

### E7 — Golden-vector corpus (P1, 6–8 h)

**Current state.** EIP-712 digests are proven by three TS encoders agreeing, and EIP-7702 digests by cast-derived fixtures — but the fixtures live inside test files, and the Solidity side has no shared vector set. Adding a field to `ActionRequest` (likely someday — e.g. E11's declared tokens) requires touching many hand-maintained expectations.

**Enhancement.** `vectors/` directory at repo root: `actionrequest.json` (canonical field sets → digest, signature), `eip7702.json` (chainId/nonce/address edge cases → digest), `merkle-v2.json` (pinned/wildcard leaf preimages → root). Each entry annotated with its generator (`cast keccak`, viem version). Tests in both languages load and assert against the same files; docs embed a sample.

**Benefits.** One-place update for wire-format changes; makes cross-language conformance a visible artifact (screenshot-able for launch/audit); new encoders (E13's Solidity-side EIP-712, E17) get a ready test corpus.

**Trade-offs.** Fixture staleness risk — add a generator script so vectors are reproducible (`npm run vectors:generate`), not hand-frozen. Slight test-runtime cost (JSON loading) is negligible.

---

## B. SDK/DX (continued)

### E8 — Allowance/balance pre-check, v2-aware (P2, 6–8 h)

**Current state.** SECURITY.md says an ERC-20 allowance pre-check is "planned but not implemented". S1's v2 pinned leaves make this concrete: a pinned leaf's calldata *is* the intended token call, so the exact `(token, spender, amount)` triple is known at prepare time.

**Enhancement.** `client.checkTokenPath(request)` — when `request.data` matches a recognized standard signature (`transfer`, `transferFrom`, `approve`, `permit`-class) and the scope's merkleRoot contains a pinned leaf for that target, decode the args and read `balanceOf(owner)` / `allowance(owner, target)`; include the findings in the pre-flight result object (`{ok, warnings: string[]}`) instead of throwing.

**Implementation approach.** Purely additive: a viem `multicall3.aggregate` of the 2–4 balance/allowance reads in one round-trip; extend `validateAgainstScope`'s result type with optional `warnings` (non-fatal, unlike violations).

**Benefits.** Catches the classic production failure — key granted for USDC transfers the agent hasn't approved — before gas and before an E2 revert; upgrades a documented "planned" mitigation into shipped behavior, tightening the security story.

**Trade-offs.** Signature-pattern matching only covers standard ABIs (routers with internal encoding are out of scope — document); +1 RPC round-trip when tokens are involved (batched into the P5 multicall). Keep it advisory (warnings), never blocking, to avoid false positives breaking legit flows.

### E12 — Simulation mode (P2, 3–4 h)

**Enhancement.** `client.simulateExecution(args, {from})` — `eth_call` of the prepared calldata against the live node before signing, returning `{simulated: boolean, revertReason?}` (decoded via E4). Complements the zero-gas local check: the local check validates *policy*, simulation validates *state* (nonces of target contracts, router state).

**Trade-offs.** `eth_call` cost/latency (one extra round-trip, optional flag, default off); node-dependent fidelity (some RPCs simulate against pending state, some against latest — document). Note: the manager's `_recover` runs `ecrecover` inside `eth_call` — simulation must pass a *real signature*, so simulate after signing (pre-send), not before.

---

## C. New packages (the audit's "OPPORTUNITY" list, made concrete)

### E9 — `@sigilkit/indexer` (P2, 3–5 d)

**Current state.** `ActionLogged` is emitted data with no consumer. The "mandatory audit" moat currently terminates at the log — no query path, no report, no UI.

**Enhancement.** A small workspace package: viem `watchContractEvent`/`getLogs` over `ActionLogged` (+ E1's `WindowCharged`), writing into SQLite (drizzle ORM, zero-config) with tables `actions (agentId, target, selector, value, rationaleHash, ts, txHash, chainId)` and `window_charges`; a thin query layer (`spendByAgent(agentId, from, to)`, `windowState(key)`, `actionsForTarget`) exposed as both a CLI (`sigilkit-indexer serve --rpc … --db …`) and importable functions; a one-page read-only dashboard (agent spend vs. granted caps).

**Benefits.** Converts the moat from a claim into a usable product surface; SECURITY.md's "post-hoc reconciliation" mitigation becomes an actual tool; the demo gains a compliance-report finale (`npm run demo` prints the agent's audit trail from the indexer).

**Trade-offs.** New package to maintain (schema stability matters once external users query it); multi-chain adds a `chainId` dimension from day one to avoid a migration later. Keep the first version single-process, no streams.

### E14 — `@sigilkit/mcp` (P2, 3–5 d)

**Enhancement.** An MCP server exposing SigilKit to agent frameworks as tools: `grant_scoped_session` (owner-keyed, returns scope + key handle), `propose_action` (runs `parseActionRequest` + `validateAgainstScope` + E12 simulation, returns the countersigned calldata or the precise rejection reason), `execute_action` (E3's `execute` inside `NonceGate`), `query_audit` (E9). The compromised-agent threat model maps exactly: the model can *ask* for actions, but the wallet path bounds what it can *do*.

**Benefits.** Positions SigilKit at the integration point agent frameworks actually use (the old whitepaper mentioned MCP tools; nothing shipped); each MCP tool call is a natural audit boundary; strong demo/launch narrative ("Claude/GPT agents with hard on-chain spending limits").

**Trade-offs.** MCP spec churn — keep transport stdio + HTTP-Streamable only, no exotic features; key custody question moves into the MCP host (document: session keys are hot keys by design, caps bound them). Depends on E3/E4 for clean tool semantics.

---

## D. Contracts — strategic capability additions

### E10 — Graduated authority: owner countersign for large actions (P2, 8–12 h)

**Current state.** Authority is binary per key: whatever the scope grants is spendable by the key alone until expiry. Institutional treasuries typically want *amount-tiered* authority — small actions autonomous, large ones co-signed.

**Enhancement.** Optional per-scope field `uint256 countersignAbove` (new Scope field → grant-format change, pre-mainnet OK): when `request.value > countersignAbove`, `executeWithSessionKey` additionally requires an EIP-712 owner signature over `keccak256(abi.encode(REQUEST_APPROVAL_TYPEHASH, requestDigest))`. The approval binds the full request digest, so it is single-use by construction (nonce uniqueness) — no extra replay bookkeeping.

**Benefits.** Directly answers the institutional positioning gap catalog A2 noted (plain-EOA owner risk): a compromised *agent* key can no longer drain the max per-action/window caps in one shot; pairs naturally with the Safe-owner posture. The countersign flow is also a clean relayer UX (owner pre-signs expected high-value actions offline).

**Trade-offs.** +1 `ecrecover` (~3k gas) only on large actions; owner availability becomes an operational dependency for large flows (that is the point, but document the failure mode: actions stall, they don't fail silently — the revert is `OwnerCountersignRequired`); Scope struct growth affects calldata costs of grant. Halmos: one new spec (countersignature required iff above threshold) — cheap on the existing seam.

### E11 — Balance-delta enforcement for nested outflows (P2, 12–16 h)

**Current state.** Caps bind `request.value` only. SECURITY.md's residual blind spot: a whitelisted target that pulls ERC-20s internally (routers, vaults) moves tokens invisible to `enforce`.

**Enhancement.** Optional per-scope flag `enforceNativeDelta`: before the inner call, snapshot `address(manager).balance`; after, require `post >= pre - request.value` (inner call cannot siphon native value beyond the declared amount — protects against malicious/buggy targets and reentrant drains). Token-level: `declaredTokenOutflows` are enforced *by the v2 pinned leaves* for standard calls (shipped); general token-delta enforcement requires knowing which tokens to check — offer an optional per-scope `tokenWatchlist` (≤ 8 addresses) whose balances are snapshotted around the call and must not net-decrease beyond declared amounts.

**Implementation approach.** Two storage slots for the watchlist (packed); +2 SLOAD/SSTORE per watched token per execution; revert with `NativeDeltaExceeded(pre, post, declared)`. The checks wrap the existing CEI block — effects already committed before interaction must be *compensated* on failure: since the whole tx reverts on violation, ordering stays correct (check → revert rolls back window charges too).

**Benefits.** Converts the last documented limitation from "mitigated by trust" to "enforced for native, enforced for watched tokens"; the reconciliation burden on E9 drops.

**Trade-offs.** Gas scales with the watchlist (why it is opt-in per scope); cannot catch synthetics (shares, LP tokens) not on the watchlist — the docs must keep saying "trusted targets for unlisted tokens"; ActionRequest stays unchanged (good — no digest-format break).

### E13 — `SigilKitDelegator`: the EIP-7702-native wallet (P2 flagship, 3–5 d)

**Current state.** Component 1 (EIP-7702 library) signs/validates authorizations and revocations, but the end-to-end story — *an EOA delegating to a SigilKit implementation so scoped agent execution runs from the EOA's own balance* — has no implementation contract. Today a demo must deploy `SessionKeyManager` and fund it separately.

**Enhancement.** A minimal implementation contract designed as a 7702 delegate target (`SigilKitDelegator`): inherits the manager's enforcement internals but with `owner = address(this)` (the EOA itself), storage in the EOA's own slots (ERC-7201 keeps it collision-safe), and `receive()` so the EOA holds funds. The agent executes scoped actions *from the EOA balance*; revocation = the SDK's existing `signRevocation`.

**Implementation approach.** Extract the enforcement core of `SessionKeyManager` into an internal-logic base (or use the existing library-first layout: `SpendPolicy` + `MerkleWhitelist` are already libraries; extract scope checks similarly), then `contract SigilKitDelegator is EnforcementCore`. Validate the 7702 specifics: delegation designator checks (`validateAuthorization` already exists in the SDK), nonce handling for authorizations (EIP-7702 `nonce` = account nonce), and self-call gating (`executeWithSessionKey` callable by anyone, value flows from the EOA — the existing `ValueNotAccepted` pattern applies unchanged).

**Benefits.** Completes the founding thesis: "agent-native wallet" — no separate treasury contract; EOAs gain scoped agent delegation with one type-4 transaction; the MetaMask/Coinbase harnesses (A7) then verify the *deployment* path, not just behavior pins; large differentiator vs. Biconomy/OZ session-key plugins.

**Trade-offs.** Largest item here; 7702 delegation lifecycle (per-delegation storage persistence, revocation semantics, wallet support via the allowlist) needs careful spec — this is the natural scope for the *next* audit cycle, not a quick add; new storage in EOA contexts must be ERC-7679/7201-reviewed. Sequence after E1–E5 are stable so the delegator inherits the hardened core.

---

## E. Policy/verification depth

### E15 — Sliding-window damping, opt-in (P3, 12–16 h)

**Current state.** Catalog S3 documented the tumbling-window truth: up to ~2× `perWindowCap` crosses a boundary. Docs are now honest; the capability gap remains for smooth-budget users.

**Enhancement.** Scope-level opt-in `windowMode`: mode 0 = tumbling (default, zero extra gas); mode 1 = two-bucket damping — track previous window's spend and require `spentCurrent + spentPrev ≤ perWindowCap` *in addition to* the single-window check during the first half of a new window (halving boundary bursts to ~1.5×, at fixed gas cost — no fraction math).

**Benefits.** Integrators wanting tighter budgets get a real option without changing INV-1's default semantics.

**Trade-offs.** +2 storage slots per key (always allocated in the mode-1 branch of grant); both Halmos rollover specs and the invariant ghost bookkeeping need mode-aware variants; mental-model complexity — most users should keep tumbling. Honest recommendation: build only if a design partner asks; otherwise E1 + indexer reporting (which makes boundary bursts *visible*) suffices.

### E16 — Per-tuple whitelist proofs for batches (P3, 16–24 h)

**Current state.** Batch ops under a non-zero merkleRoot revert (`BatchWithWhitelistUnsupported`) — fail-closed, but it means whitelisted users cannot batch, which is the main gas win 7579 accounts want.

**Enhancement.** Extend the signature blob framing: `[uint16 count][per-tuple: proofLen + elements]…`. The validator verifies each tuple's leaf against its own proof. Cap total blob length (e.g. 4 kb) for gas bounding.

**Trade-offs.** Parsing complexity in the most security-sensitive code path; gas per tuple grows with proof depth; the fail-closed behavior is *safe* today — this is a capability unlock, not a gap. Gate behind a module version bump.

### E17 — ERC-7739 / ERC-1271 session keys (P3, 3–5 d)

**Enhancement.** Let a session "key" be a smart-account signature: `_recover` falls back to ERC-1271 `isValidSignature` on the key address when it has code (with a gas-bound `extcodesize` guard), enabling passkey-backed or multisig-bounded agents. The virtual `_recover` seam shipped for Halmos (A4) is exactly the seam this needs.

**Trade-offs.** ERC-1271 during validation inside 4337 has reentrancy/state-read implications (context-dependent sigs); the ECDSA fast path must stay gas-identical; audit surface grows. Do after E13 (both touch the recovery/ownership story).

### E18 — Multi-process nonce coordination (P3, 6–10 h)

**Enhancement.** `NonceGate` is in-process; fleets running multiple processes still race. Provide a `LeaseStore` interface (`acquire(key, ttl) → lease | null`) with a Redis SETNX reference implementation and a no-op local adapter; `SigilKitClient.nonceGate` accepts an optional store. Document the alternative of one key per agent process (usually the better design — zero coordination).

**Trade-offs.** Redis dependency in the SDK (keep it an optional peer/adapter, not a dependency); leases add latency and failure modes (TTL expiry mid-flight) — hence "one key per agent" remains the documented default.

### E19 — Echidna/medusa port (P3, 6–10 h)

**Enhancement.** The catalog's B5 admin handlers are exactly what an Echidna properties contract needs — port the ghost bookkeeping (`expectedWindowSpend`, `everRevoked`) into `echidna_*` view properties over the same handler pattern; nightly job (the CI comment block already sketches the invocation).

**Benefits.** Two independent fuzzers on one invariant set — a strong audit-readiness signal.

**Trade-offs.** Toolchain maintenance (Echidna's solc support lags — pin accordingly); overlapping coverage with Foundry's now-thorough suite; run Echidna nightly-only.

### E20 — Fleet demo + run manifests (P3, 4–6 h)

**Enhancement.** Extend `npm run demo`: two agents sharing one key through `NonceGate` (proving P1), a post-run audit summary from E9, and a JSON run manifest (addresses, scope, ticks, receipts) written to disk — reproducible demo artifacts for docs and issues.

**Trade-offs.** Demo runtime doubles (~2× ticks); keep the single-agent path as the default so the first-run experience stays fast.

---

## Recommended sequence

1. **Now (with or right after A1's publish):** E1 → E2 → E3 → E4 → E5 → E6 — all P1, mostly small, and they convert the current "correct but opaque" SDK into a diagnosable, publishable product. E7 alongside.
2. **Next sprint:** E8, E9, E12, E10 — the first wave of user-facing capability (pre-checks, the audit consumer, simulation, countersigned large actions). E9 + E1 together give the launch demo its compliance story.
3. **Pre-audit cycle:** E13 (delegator) as the flagship, preceded by E11 (it hardens the same execution path the delegator will reuse) and followed by E17.
4. **Opportunistic/backlog:** E15 (only on demand), E16, E18, E19, E20.

Everything here is pre-mainnet-safe: the breaking items (E10's Scope field, E11's optional flag, E13's new contract) are additions, and the wire-format-compatible ones (E1–E4) are event/revert-surface additions that older integrations ignore gracefully.
