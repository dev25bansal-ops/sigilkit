# SigilKit — Issues & Required Fixes Catalog

**Date:** 2026-09-11 · **Codebase state:** `master` @ `f3e3fce` · **Source evidence:** direct code inspection, live test runs, `vault/Audit Raw Findings 2026-08-24.md` (re-verified item-by-item against HEAD)

> ## ✅ RESOLUTION STATUS (2026-09-11, end of remediation day)
>
> **23 of 24 catalog items are closed in code.** Commits: `ee53f09` (P0), `892d790` (P1),
> `eb3eef0` (P2), plus the P3/final commit.
>
> | Item | Status | Where |
> |------|--------|-------|
> | B1 core typecheck | ✅ fixed | `tsconfig.wallet-e2e.json` split, harness typed; both tsconfigs exit 0 |
> | B2 placeholder wallet legs | ✅ replaced | `wallet-e2e.manual.test.ts` spawns the real `run-all.ts` |
> | B3 README drift | ✅ reconciled | counts/commands/claims regenerated from measured truth |
> | B4 vacuous fork test | ✅ real | Base chainid, chain-bound DOMAIN_SEPARATOR, live Multicall3 assertion |
> | B5 invariant admin paths | ✅ added | grant/rotate/ownership/denylist/warp handlers + ghost mirror; 4/4 @ 256 runs |
> | Q6 multi-level Merkle | ✅ tested | TS property tests 1..32 + Foundry 4-leaf/2-element proof tests |
> | A6 coverage | ✅ gated | vitest v8 thresholds (88/74/90/88) + forge lcov nightly artifact |
> | P3 CI fuzz cost | ✅ split | PR gate 2k runs, nightly deep profile 10k/1k |
> | A10 nightly Foundry | ✅ pinned | v1.7.1 + monthly canary (the removed `--invariant-runs` flag proved the risk) |
> | A1 repo/CI never run | ⏳ **one manual step left** | everything prepared; see "A1 — remaining step" below |
> | S1 token caps | ✅ implemented | whitelist leaf format v2 (argument-bound + wildcard) across contracts + SDK + docs |
> | A3 7579 audit trail | ✅ shipped | `ActionLog7579Executor.sol` (type 6) + 7 tests incl. negative INV-3 |
> | P1 sequential nonces | ✅ mitigated | `NonceGate` + `SigilKitClient.nonceGate` + 4 tests |
> | A5 handleOps gap | ✅ closed | `Module7579AccountE2E.t.sol`: validated ops actually execute; caps hold |
> | A2 governance | ✅ decided+supported | `SIGILKIT_OWNER_ADDRESS` (Safe) deploy path; SECURITY.md posture; T5 CREATE2 script |
> | A4 Halmos scope | ✅ extended | 11 specs total: 5 new auth-path specs over a `_recover` virtual seam, all passing |
> | A7 wallet harness | ✅ CI'd | weekly job with pinned MetaMask 12.5.0 download (continue-on-error until green history) |
> | P4/P5 perf polish | ✅ done | collection overhead dropped ~90% via vitest 5; `prepareExecution` now fetches nonce + window state in one parallel round-trip (P5), with Q1 warn-on-degradation |
> | Q1–Q9 quality batch | ✅ done | warn-on-swallow, dead code, error naming, off-by-one, TYPEHASH JSDoc, root test script |
> | S2 low-s | ✅ added | manager `_ecrecover` now EIP-2 + malleability test |
> | S3 tumbling window | ✅ restated+tested | docs across the repo + boundary-burst test pinning semantics |
> | S5 resurrection | ✅ observable | `SessionKeyReinstated` event + tests |
> | S6 withdrawal | ✅ added | owner-only `withdraw`, denylisted, 3 tests |
> | S7 dev vulns | ✅ resolved | vitest 5.x — `npm audit` clean (0 vulnerabilities) |
> | T1–T5 hygiene | ✅ done | zip/state untracked; root TS dep removed; duplicate harness deleted; CREATE2 deploy script |
>
> **Final measured state:** Foundry 62/63 (the 1 is the fork smoke failing off-fork by design —
> it asserts `chainid == 8453`); invariants 4/4 @ 256 runs; Halmos 11/11; TS 43 passed / 1
> skipped; `npm audit` 0 vulnerabilities; both packages build and lint clean.
>
> **A1 — remaining step (one command, deliberately left to the maintainer):** the repo is
> still unpublished. Create the public repository and push, then watch the first CI run:
>
> ```
> gh repo create sigilkit/sigilkit --public --source . --remote origin --push
> ```
>
> (or `gh repo create dev25bansal-ops/sigilkit --public --source . --remote origin --push` for
> a personal-account repo — the npm `repository.url` fields currently point at the org form,
> so update `packages/*/package.json` if you choose the personal path). Everything else —
> lint, CI triggers, workflow jobs, docs — is already prepared for that first push to be green.

Severity scale: **Critical / High / Medium / Low** (business impact + exploitability under the project's own threat model: the agent session key is untrusted, the owner key is trusted). Security ratings include indicative CVSS v3.1-style reasoning — these are analyst estimates, not certified scores.

---

## 0. Verification snapshot (evidence, run 2026-09-11)

| Check | Result | Measured |
|---|---|---|
| `forge test --gas-report` | ✅ **44/44 passed, 0 failed** | 607.9 s wall / 1718 s CPU (local, default 256 fuzz runs) |
| `npm test --workspace @sigilkit/core` | ✅ **25 passed, 2 skipped** | 53.4 s wall (41 s of it module collection) |
| `npm run build --workspaces` | ✅ both packages clean | — |
| `npm run lint --workspace @sigilkit/core` | ❌ **FAILS — 11 type errors** | exit 1 (Issue **B1**) |
| `npm run lint --workspace @sigilkit/demo-agent` | ✅ | exit 0 |
| `npm audit` | ⚠️ 2 moderate (dev-only, vitest) | Issue **S7** |
| `git remote -v` | ❌ **empty — CI has never run anywhere** | Issue **A1** |

The Aug-2026 remediation commit (`7618a53`) is **verified genuine**: module `msg.sender`/initialized gates, derived ERC-7201 slot, module EIP-2 low-s, batch bounds, unknown-key rotation rejection, required deploy key, canonical 7702 address RLP, `parseActionRequest`, hard-expiry + local-Merkle pre-check, throwing `assertAuditEmitted`, CI triggers/cron/slither pin/npm-ci/demo-agent visibility — all present and tested at HEAD. The open catalog below is what remains **after** that pass, plus findings the audit missed.

---

## 1. Priority matrix (sorted by recommended execution order)

| # | ID | Issue | Sev | Effort | Depends on | Timeline |
|---|----|-------|-----|--------|------------|----------|
| 1 | **B1** | `@sigilkit/core` typecheck is broken at HEAD (11 TS errors) | High | 1–3 h | — | **This week** |
| 2 | **A1** | No git remote; CI has never run; `repository.url`/`$schema` point at a repo that doesn't exist | High | 2–4 h | B1 | **This week** |
| 3 | **B3** | README contradicts code again (Playwright "pending", stale test counts, deploy command that cannot work) | Low | 1–2 h | — | This week |
| 4 | **S2** | Manager `_ecrecover` still missing EIP-2 low-s check | Low | 1 h | — | This week |
| 5 | **T1** | Repo hygiene: 21 MB `metamask.zip` in git, committed Playwright state, untracked `.freebuff/` | Low | 0.5–1 h | — | This week |
| 6 | **S3** | Spend window is tumbling, not rolling — INV-1 as documented is false (≈2× boundary burst) | Med | 2 h (doc) / 12–16 h (real rolling) | — | ≤ 2 weeks |
| 7 | **B2** | Placeholder wallet-e2e "conformance" legs still assert JSON strings | Med | 1–2 h | — | ≤ 2 weeks |
| 8 | **B5** | Invariant suite still never fuzzes admin state transitions | Med | 8 h | — | ≤ 2 weeks |
| 9 | **Q6** | Multi-level Merkle proofs never tested against any contract | Med | 3–4 h | — | ≤ 2 weeks |
| 10 | **A6** | No coverage measurement or thresholds on either side | Med | 4–6 h | — | ≤ 2 weeks |
| 11 | **P3** | CI fuzz profile (10 000 runs/test) will make the unit job very slow | Low | 1 h | — | ≤ 2 weeks |
| 12 | **A10** | Foundry pinned to `nightly` in every CI job (non-reproducible) | Low | 0.5 h | — | ≤ 2 weeks |
| 13 | **B4** | Nightly "Base fork" test proves nothing fork-specific | Low | 2–4 h | — | ≤ 2 weeks |
| 14 | **S1** | Spend caps bind native value only — whitelisted token selectors are uncapped | **High** | 16–24 h | — (design first) | ≤ 1 month, **pre-audit** |
| 15 | **A3** | ERC-7579 path has caps but no audit trail (moat absent on standards-native path) | Med | ~30 h | — | ≤ 1 month |
| 16 | **P1** | Strictly sequential per-key nonces break concurrent fleet use | Med | 8–12 h | — | ≤ 1 month |
| 17 | **A2** | Single-EOA owner; no UUPS/Safe+Timelock governance exists (pre-mainnet requirement) | Med | 16–30 h | — | Before mainnet |
| 18 | **A5** | No `handleOps` E2E: the module's ERC-7579 callData convention is unproven vs a real account | Med | 12 h | — | ≤ 1 month |
| 19 | **A4** | Halmos stops at spend-cap math + depth-1 Merkle; auth paths unverified | Med | 16–30 h | — | Pre-audit |
| 20 | **A7** | Live wallet harnesses are manual-only; flagship claim not CI-verified | Med | 8–16 h | A1 | Pre-audit |
| 21 | **P4/P5** | TS suite collection overhead; serial RPC round-trips in `prepareExecution` | Low | 3–6 h | — | Backlog |
| 22 | **Q1–Q8** | Code-quality batch (silent catch, dead code, error naming, off-by-one) | Low | ~3 h | — | Backlog |
| 23 | **S5/S6** | Design gaps: revoked-key resurrection via re-grant; no owner withdrawal path | Low | 2 h | — | Backlog |
| 24 | **S7** | Dev-only vitest advisories (GHSA-82fw-gwwq-j7x9) | Low | 2–4 h | — | Backlog |

**No Critical issues found.** Totals: 3 High, 9 Medium, 12 Low. Estimated remediation: **P0 ≈ 2 dev-days, P1 ≈ 2 dev-weeks, P2 ≈ 4–5 dev-weeks** (S1 + A3 + A2 dominate).

---

## 2. Security vulnerabilities & gaps

### S1 — Spend caps protect native value only; whitelisted token selectors can drain the entire token balance
- **Severity: High** · **Priority: 1 of the security items** · **Effort: 16–24 h** · **Dependencies: none, but it is a breaking leaf-format change → must land before mainnet and before the external audit** · **Timeline: ≤ 1 month**
- **Problem:** `SpendPolicy.enforce` (`contracts/src/SpendPolicy.sol:28-53`) only sees the native `value` of the inner call. The whitelist leaf is `keccak(abi.encode(target, selector))` (`SessionKeyManager.sol:249`) — no commitment to calldata arguments. **Repro:** owner grants a key whitelisted for `USDC.transfer(address,uint256)` with perActionCap = 0.001 ETH; a compromised agent submits `value=0`, `data=abi.encode(attacker, 10^9 e6)` and moves the manager's **entire USDC balance** in one call — every on-chain cap passes, INV-1 holds, `ActionLogged` fires. Same applies to the 7579 module (`SessionKey7579Module.sol:285`). Nested token pulls inside a whitelisted router call are a second, documented blind spot.
- **Status:** documented as a known limitation in `README.md:99-101` and `SECURITY.md` (the false "SDK allowance pre-check exists" claim was corrected), but **the capability gap itself is open**. For a product whose pitch is "caps are real", this is the single largest issue in the repo.
- **Indicative rating:** AV:N/AC:L/PR:L (needs a compromised agent key + owner-whitelisted token selector)/S:U/C:N/I:H/A:N ≈ **6.5–7.1**; business impact High because it caps the core value proposition.
- **Fix:** argument-committing leaf encoders (commit keccak of calldata, or per-target amount ceilings) and/or an executor-side balance-delta check around the inner call (compare `token.balanceOf(manager)` before/after, revert on net outflow beyond declared). Then update SDK `targetLeaf`, both contracts, and the conformance tests in one coordinated change.

### S2 — SessionKeyManager `_ecrecover` lacks the EIP-2 low-s rejection (module has it)
- **Severity: Low** · **Priority: high for effort ratio** · **Effort: 1 h** · **Dependencies: none** · **Timeline: this week**
- **Problem:** `SessionKeyManager.sol:333-342` checks yParity ∈ {27,28} and rejects the zero address but accepts `s > N/2`; the module's `_recover` got the EIP-2 check in the remediation (`SessionKey7579Module.sol:362-365`) — the manager was missed. Practical replay is blocked by the per-key nonce, so impact is limited to malleable-signature tooling confusion and audit inconsistency.
- **Fix:** add the same `if (uint256(vs) > 0x7FFF…20A0) revert InvalidSignature();` + a malleability unit test.

### S3 — The "rolling window" is actually a tumbling window: INV-1 as documented is false
- **Severity: Medium** · **Priority: high** · **Effort: 2 h to fix docs+tests, 12–16 h for a true rolling window** · **Dependencies: none** · **Timeline: ≤ 2 weeks**
- **Problem:** `SpendPolicy.enforce` rolls the window only when **fully elapsed** (`SpendPolicy.sol:37-40`) — a tumbling/fixed-window limiter. But `SpendPolicy.sol:5-7` (INV-1 docstring), `README.md:97` ("within **any** rolling window"), and the whitepaper promise budgeting that is smooth in time. **Repro:** windowSeconds = 600, perWindowCap = 0.05 ETH. Spend 0.05 ETH at t=599, spend 0.05 ETH at t=601 (window rolls, spent reset to 0). Both succeed; **0.1 ETH — 2× perWindowCap — left the wallet within a 2-second span**, and up to 2× cap within any sliding window of length `windowSeconds`. The invariant fuzzer tracks only the contract's own window state, and the Halmos specs encode the tumbling semantics, so no test contradicts the prose.
- **Fix (recommended, cheap):** rename to "tumbling window" in all three docs + restate INV-1 as "sum within any single fixed window ≤ perWindowCap; up to 2× across a boundary", and add a boundary-burst test pinning the semantics. Fix (expensive): true sliding-window accounting (deque of spend events or two-bucket EMA) — more gas, only worth it if integrators need smooth budgeting.

### S5 — A revoked session key is resurrected by re-granting the same address
- **Severity: Low** · **Effort: 0.5–1 h** · **Timeline: backlog**
- **Problem:** `grantSessionKey` upserts and clears `revoked` (`SessionKeyManager.sol:147-153`), so `revokeSessionKey(k)` followed by `grantSessionKey(k, …)` silently revives the key. Owner-only action, so not exploitable — but the revocation event's promise ("this key can never execute again") is quietly undone with no dedicated event distinguishing "fresh grant" from "revocation reversal".
- **Fix:** emit a distinct `SessionKeyReinstated`/document the semantics, or require an explicit un-revoke. Same pattern exists in the module's `_grant` (`SessionKey7579Module.sol:164-175`).

### S6 — No owner withdrawal / treasury recovery path
- **Severity: Low (design gap)** · **Effort: 2–4 h** · **Timeline: backlog / fold into A2**
- **Problem:** funds can only leave `SessionKeyManager` through capped agent execution. The de-facto recovery procedure is the owner self-granting a key with `perActionCap = perWindowCap = 2^256-1` — which works but turns "owner key compromised" into "instant full drain with no rate limit" and makes the caps story confusing in demos. Document the procedure explicitly or add `withdraw(address,uint256)` (owner-only, denylisted by default like the other admin selectors).

### S7 — Dev-dependency advisories: vitest path traversal via @vitest/mocker
- **Severity: Low (dev-only)** · **Effort: 2–4 h** · **Timeline: backlog**
- **Problem:** `npm audit` reports **2 moderate**: vitest 2.1.0–4.1.10 → GHSA-82fw-gwwq-j7x9 (Path Traversal / Arbitrary File Read via mocker redirect mock), fix requires breaking vitest@5. Test-time-only exposure (the mocker is not used by the suite today).
- **Fix:** accept with a triage note, or schedule the vitest 5 upgrade with the next minor.

---

## 3. Software bugs

### B1 — `npm run lint` on `@sigilkit/core` fails at HEAD: 11 type errors (blocks a green CI run)
- **Severity: High** (breaks the ts-sdk PR gate; the repo's whole verification-brand story depends on green CI) · **Effort: 1–3 h** · **Dependencies: none — must land before A1** · **Timeline: this week**
- **Repro:** `npm run lint --workspace @sigilkit/core` → exit 1. **Expected:** clean typecheck (CI gate). **Actual:**
  - `test/wallet-e2e/coinbase.ts(126,147)`: `anvil_setCode` not assignable to viem's typed request-method union (TS2322)
  - `test/wallet-e2e/metamask.test.ts(35,36)`: **`homedir` used without being imported** (TS2304 — would also throw at runtime)
  - `run.ts` / `metamask.test.ts` (7×): `window` referenced with `lib: ["ES2022"]` and no DOM types (TS2304)
  - `metamask.test.ts(141)`: `result.message` possibly undefined (TS18048)
- **Root cause:** commit `f3e3fce` added the wallet harness directory, and `packages/core/tsconfig.json` includes `test/**/*.ts` wholesale; the vitest `exclude` config skips the folder at test time but `tsc` does not. Because CI has never run (A1), the breakage shipped silently on the repo's most recent commit.
- **Fix:** give `test/wallet-e2e/` its own tsconfig (browser/DOM lib, `"types": ["node"]`, looser request typing) and exclude it from the package tsconfig — mirroring the vitest exclude; import `homedir`; narrow the possible-undefined. Verify with the exact CI step: `npm run lint --workspace @sigilkit/core`.

### B2 — Placeholder "cross-wallet conformance" legs still exist and assert JSON, not wallets
- **Severity: Medium** (test integrity — this is the exact "placeholder theater" the Aug audit flagged; the file's header still claims a silent wallet regression "fails CI", which it cannot do) · **Effort: 1–2 h** · **Timeline: ≤ 2 weeks**
- **Repro:** `RUN_WALLET_E2E=1 npx vitest run test/wallet-e2e.manual.test.ts` → 2 "tests" pass that only check `b.expected === "rejected"` and a hardcoded pin string (`wallet-e2e.manual.test.ts:52,66`) — zero wallet interaction. The **real** harnesses now live in `test/wallet-e2e/run.ts` + `coinbase.ts` (verified 5/5 + 4/4 per commit message), making this file redundant and actively misleading. The default suite runs only the allowlist-integrity leg (3 tests, 2 skipped) — visible in the vitest output as green "wallet" coverage.
- **Fix:** delete the two placeholder legs (keep the allowlist-integrity test), or convert them into thin wrappers that spawn `run-all.ts` so `RUN_WALLET_E2E=1` actually exercises the live harness.

### B3 — README contradicts the code again (third documented occurrence)
- **Severity: Low** · **Effort: 1–2 h + process change** · **Timeline: this week** (before A1 publishes the README to the world)
- Specifics at HEAD:
  1. `README.md:17` — "MetaMask/Coinbase Playwright legs **pending**" while `f3e3fce` shipped live harnesses that pass (5/5, 4/4). The differentiator is now real; the README undersells it.
  2. `README.md:73` — "forge test # **34 unit + 4 invariant suites, 38 total**"; actual: **44 tests** (39 unit + 4 invariant + 1 fork smoke); the top table (`README.md:30`) says 39 unit. Three mutually inconsistent counts in one file — the exact drift the Aug audit documented (34 vs 38 vs 21).
  3. `README.md:80` — the deploy quick-start omits `SIGILKIT_OWNER_KEY`, which `Deploy.s.sol:16` now **requires** (`vm.envUint` reverts) → the documented command cannot work as printed.
- **Fix:** reconcile all three; longer-term, generate the verification-status table from CI output (job-summary artifact) instead of hand-editing — this drift class has now recurred three times.

### B4 — The nightly "Base fork" test proves nothing fork-specific
- **Severity: Low** · **Effort: 2–4 h** · **Timeline: ≤ 2 weeks**
- **Problem:** `ForkSmokeTest` (`contracts/test/ForkSmoke.t.sol`) deploys a **fresh** SessionKeyManager on whatever chain it runs on and asserts its own owner and non-zero `DOMAIN_SEPARATOR` — no assertion involves Base's live state, addresses, or behavior; it passes identically on Anvil. The nightly `forge-fork-base` CI job (gated on `secrets.RPC_BASE`) is therefore near-vacuous while its name suggests real fork coverage.
- **Fix:** assert something actually fork-dependent: e.g. `block.chainid == 8453`, DOMAIN_SEPARATOR differs from the local one, deploy at a deterministic address, or interact with a live Base contract. Cheap but makes the nightly meaningful.

### B5 — Invariant suite still never fuzzes admin state transitions
- **Severity: Medium** (test debt on the crown-jewel contract; audit-flagged, not remediated) · **Effort: 8 h** · **Timeline: ≤ 2 weeks**
- **Problem:** `SessionKeyManager.invariant.t.sol` handlers are `executeRandom` + `revokeRandom` only (verified: zero matches for grant/rotate/warp/denylist handlers). Never fuzz-exercised statefully: `grantSessionKey`'s five `InvalidScope` branches, `rotateSessionKey` entirely (shorten-overlap vs revoke branches, `OverlapBeyondOldExpiry`), `transferOwnership`, `setSelectorDenied` un-deny path, and time-based expiry/rollover branches under evolving admin state.
- **Fix:** add owner-pranked handlers (`grantRandom` with valid+invalid scope mixes, `rotateRandom` straddling `block.timestamp`, `transferOwnershipRandom`, `toggleDenylistRandom`, `warpRandom` past `expiresAt`/`windowSeconds`), then extend the ghost-variable invariants to cover post-rotation and post-ownership-transfer states.

### Q6 — Multi-level Merkle proofs are never tested against any contract
- **Severity: Medium** (largest untested correctness surface in the whitelist feature; audit-flagged, not remediated) · **Effort: 3–4 h** · **Timeline: ≤ 2 weeks**
- **Problem:** the deepest proof ever exercised on-chain is **1 element** (`SessionKeyManager.t.sol:304-333`, two-leaf tree; module tests use a single-leaf tree with an empty proof). Meanwhile the SDK implements full multi-level `merkleRoot`/`merkleProof` with odd-node promotion (`signing.ts:207-259`). One subtle divergence in the promotion logic (e.g. promotion without hashing vs sibling-duplication) would pass every existing test and break production grants with ≥3 targets.
- **Fix:** loop sizes 1..32 in a vitest property test asserting SDK proofs verify against a reference implementation of `MerkleWhitelist.verify`; add a Foundry test granting a 4-leaf scope executed with a 2-element proof (accept) and a tampered one (revert).

---

## 4. Performance bottlenecks (with measured metrics)

### P1 — Strictly sequential per-key nonces make concurrent fleet use fail
- **Severity: Medium** (operational blocker for the documented "fleet of agents" story) · **Effort: 8–12 h** · **Timeline: ≤ 1 month**
- **Problem:** `executeWithSessionKey` requires `request.nonce == nonces[signer]` exactly (`SessionKeyManager.sol:241`). **Measured impact:** with 2+ in-flight requests from one key, the loser deterministically reverts (`NonceUsed`) after the relayer has paid gas; the SDK's fetch-at-fire-time (`client.ts:133-140`) narrows but does not close the race (read and send are separate round-trips). Same pattern is unavoidable for the 7579 path.
- **Fix:** SDK-side nonce reservation/queueing per key (documented retry-on-replay wrapper) — 4 h; or on-chain queued nonces (accept nonce ≤ current, auto-skip) — 8–12 h, gas cost. The audit suggested the SDK helper; it remains unbuilt.

### P2 — Gas profile is healthy (no action needed — documented for the record)
- **Measured (forge gas-report, 2026-09-11):** `executeWithSessionKey` ≈ **119.5k avg (max 269k** with proofs + inner call; 257k invariant calls), module `validateUserOp` ≈ **64.7k avg** (36.8k–106k), `grantSessionKey`/`revokeSessionKey` ≈ 49.6k, `rotateSessionKey` ≈ 106.7k. Against ERC-4337 verification-gas budgets (typically 125k–500k), the module's ~65k validation leaves comfortable headroom; the ~123k execute path fits standard relayer limits. **No bottleneck.** Worth publishing these numbers in the README — they compare well against Biconomy/OZ session-key plugins.

### P3 — CI fuzz profile makes the unit job 39× heavier than the default run
- **Severity: Low** · **Effort: 1 h** · **Timeline: ≤ 2 weeks**
- **Problem:** `[profile.ci.fuzz] runs = 10000` (`foundry.toml:25-26`) applies to **every** unit test (34 of them, each spawning 10k fuzz cases) in the `forge-unit` PR-gate job. Local default (256 runs) already takes 608 s; CI plausibly lands in the 20–40 min range per push, hurting iteration speed and burning minutes.
- **Fix:** split profiles — keep 10k for the nightly/invariant job, ~1–2k for the PR gate; or move the deep fuzz to the nightly schedule.

### P4 — TS suite spends 41 s of 46 s in module collection
- **Severity: Low** · **Effort: 2–4 h** · **Timeline: backlog**
- **Measured:** vitest run = 46.5 s total, tests themselves 3.6 s, **collect 41.2 s** — overhead from the transform graph + serial execution forced by `fileParallelism: false` (shared Anvil port). Fix: per-file Anvil port allocation to re-enable parallelism, or a shared session fixture.

### P5 — `prepareExecution` makes two serial RPC round-trips before signing
- **Severity: Low** · **Effort: 1–2 h** · **Timeline: backlog**
- **Problem:** `getNonce` then `getWindowState` are awaited sequentially (`client.ts:133-159`) — 2×RTT added to every action (~200–800 ms each on public RPCs). They are independent → `Promise.all`, or a Multicall3 batch. Related quality issue: the `getWindowState` failure is swallowed silently (Q1), so on a flaky transport the per-window local check silently degrades to per-action-only.

---

## 5. Code quality issues

| ID | Issue | Location | Sev / Effort |
|----|-------|----------|--------------|
| Q1 | `catch {}` silently discards `getWindowState` failures → zero-gas window check silently skipped | `client.ts:157-159` | Low / 0.5 h |
| Q2 | Dead `current` reassignment in `merkleProof` (updated, never re-read) — obscures the index-math correctness argument | `signing.ts:254-257` | Low / 0.5 h |
| Q3 | Redundant `await import("./signing.js")` in `prepareExecution` — module already statically imported two lines up | `client.ts:171` | Low / 5 min |
| Q4 | `_enforceBatch` reuses `MalformedExecutionData` for per-action cap violations — misleading revert reason for relayers/indexers (should be `PerActionCapExceeded`) | `SessionKey7579Module.sol:267` | Low / 0.5 h |
| Q5 | Off-by-one: local pre-check rejects `expiry <= now`, contract accepts `now == expiry` (`block.timestamp > request.expiry` reverts) — conservative direction but inconsistent | `signing.ts:307` vs `SessionKeyManager.sol:238` | Low / 0.5 h |
| Q7 | Exported `ACTION_REQUEST_TYPEHASH` constant is unused by the signing path (hashTypedData derives its own) — silent drift risk if the typehash ever changes | `types.ts:44-50` | Low / 0.25 h |
| Q8 | Root `npm test` runs only `forge test` — TS suite unreachable from the root workflow | `package.json:16` | Low / 0.25 h |
| Q9 | `SECURITY.md` "Known limitation" still lists "optional ERC-20 allowance pre-checks in the SDK layer" as a mitigation — nothing of the sort exists (the exact claimed-but-absent-mitigation pattern the audit flagged) | `SECURITY.md` last section | Low / 15 min |

---

## 6. Architectural problems

### A1 — The repository is unpublished: CI has never executed, and public metadata points at a nonexistent repo
- **Severity: High** · **Effort: 2–4 h (+ first-green iteration)** · **Dependencies: B1 (lint is red — first push would be a red X)** · **Timeline: this week, before any outreach/grant application**
- **Problem:** `git remote -v` is empty; the only branch is `master`. Every artifact that references the public repo is dangling: `repository.url` in both package.json files (`github.com/sigilkit/sigilkit`), the allowlist `$schema` URL, README's "runs on GitHub once pushed" (line 34). The 6-job CI, Slither gate, Halmos release gate, and nightly fork job have processed **zero commits** — so the Aug-2026 remediation and the wallet-harness commit were never validated by the gates designed to catch them (and indeed B1 shipped broken).
- **Fix:** fix B1 → create the org/repo → push `master` → iterate to the first fully green run (including Halmos on the default branch) → add badges → then publish `@sigilkit/core`. Treat "first green CI run" as the real v0.1.0 completion date.

### A2 — Governance is a single EOA; the planned Safe + Timelock upgrade path does not exist
- **Severity: Medium** (hard pre-mainnet requirement per `vault/Build Plan.md`) · **Effort: 16–30 h** · **Timeline: before mainnet; decide before the external audit (changes audit scope)**
- **Problem:** `SessionKeyManager` has a plain constructor-set owner (`SessionKeyManager.sol:119-130`); ERC-7201 storage shows proxy-readiness intent but no UUPS wiring exists; the deploy script takes a raw EOA key. Owner-key compromise = grant/revoke/rotate/denylist + self-uncapped-key drain with no timelock or recovery.
- **Fix:** canonical deployment story with `owner = Safe{Wallet}` (2-of-3) + 24 h TimelockController for `transferOwnership`/denylist changes, or explicitly declare the manager immutable-by-design with rotation-only migration. Document whichever is chosen in SECURITY.md.

### A3 — The standards-native (ERC-7579) path delivers caps without the audit trail — the moat feature is missing where adoption is expected
- **Severity: Medium** · **Effort: ~30 h** · **Timeline: ≤ 1 month**
- **Problem:** `SessionKey7579Module` emits no `ActionLogged` (correctly — validation ≠ execution). SECURITY.md's answer is "pair with an executor/hook", **which does not exist in the repo**. An integrator choosing Kernel/Safe{Core} silently loses the "mandatory audit event" that the README (line 18-19) presents as carrying over.
- **Fix:** ship the companion ERC-7579 EXECUTOR (or hook-type) module that wraps execution and emits `ActionLogged` at execution time; add an `WindowCharged` event so even value=0 flows are reconcilable off-chain.

### A4 — Symbolic verification stops at the cap-math core; auth paths are unverified
- **Severity: Medium** · **Effort: 16–30 h** · **Timeline: pre-audit**
- **Problem:** `Halmos.t.sol` has 6 specs: 4 over `SpendPolicy.enforce`, 2 over depth-1 Merkle. Nothing symbolically exercises signature gating, replay/nonces, expiry ordering, denylist gating, or audit emission in `executeWithSessionKey`, nor `validateUserOp`'s proof-tail parsing. Docs are now honestly scoped ("spend-cap core"), but closing the gap converts the claim and pre-empts the strongest auditor objection.
- **Fix:** recover-seam harness + specs for (1) only valid signature executes, (2) replay impossible, (3) expired/denied cannot execute; then the module's accept/reject boundary.

### A5 — No `entrypoint.handleOps` E2E: the module's ERC-7579 callData convention is unproven against a real account
- **Severity: Medium** · **Effort: 12 h** · **Timeline: ≤ 1 month**
- **Problem:** all 22 module tests call `validateUserOp` directly with hand-built structs; `MockAccount` never decodes/executes the `ExecTuple` payloads, and no EntryPoint v0.7 is deployed. Whether a real account's `execute(mode, calldata)` layout matches the module's `callType byte + payload at [32:]` assumption is untested — the core integration promise for Kernel/Safe{Core} adopters.
- **Fix:** vendored EntryPoint v0.7 + minimal 7579 account whose execute decodes the module's convention + one bundler loop asserting target receives value and the window is charged exactly once.

### A6 — No coverage measurement or thresholds anywhere
- **Severity: Medium** · **Effort: 4–6 h** · **Timeline: ≤ 2 weeks**
- **Problem:** no `forge coverage` step, no `@vitest/coverage-v8` (absent from devDeps), no thresholds in any config (verified by grep). This is the enabling gap behind B5/Q6.
- **Fix:** `forge coverage --report lcov` with a threshold gate (start ~85% lines / 75% branches, ratchet up), vitest coverage with v8 provider, CI artifacts.

### A7 — The live wallet harnesses are manual-only; the flagship differentiator is not CI-verified
- **Severity: Medium** · **Effort: 8–16 h** · **Dependencies: A1** · **Timeline: pre-audit**
- **Problem:** `wallet-e2e/run.ts` + `coinbase.ts` are real (verified live 5/5 + 4/4 per the commit record) but run only via `run-all.ts` on a developer machine — no scheduled CI job, so a MetaMask/Coinbase behavior flip (the exact risk `WALLET_BEHAVIOR_ALLOWLIST.json` exists to catch) is detected only when someone remembers to run it.
- **Fix:** weekly scheduled job on a runner with Chromium (the 21 MB `metamask.zip` already in-repo makes this feasible — though T1 recommends un-committing it in favor of a pinned download), publishing results into the README verification table.

### A10 — Foundry pinned to `nightly` in all CI jobs
- **Severity: Low** · **Effort: 0.5 h** · **Timeline: ≤ 2 weeks**
- **Problem:** every job uses `foundry-rs/foundry-toolchain@v1 with version: nightly`; a nightly regression red-screens the whole gate overnight (local dev is on 1.7.1). Slither (0.11.6) and Halmos (0.3.3) are pinned — Foundry should be too (`version: 1.7.1` + a scheduled canary job to test bumps).

---

## 7. Technical debt items

| ID | Item | Impact | Effort | Timeline |
|----|------|--------|--------|----------|
| T1 | **Repo hygiene:** 21 MB `metamask.zip` committed (also a license/redistribution question for wallet extension binaries); `packages/core/test-results/.last-run.json` (transient Playwright state) committed; `.freebuff/` untracked and not ignored | Clone size, redistribution risk, noise | 0.5–1 h | This week |
| T2 | Hand-maintained verification counts (third drift recurrence — see B3) | Brand damage for a rigor-branded project | 1–2 h + CI-generated table | ≤ 2 weeks |
| T3 | Duplicate harness implementations in `wallet-e2e/` (`metamask.test.ts` vs `run.ts` — different codebases for the same canary, the former carrying 4 of B1's type errors) | Maintenance confusion | 2–4 h | With B1/B2 |
| T4 | Root devDeps (`typescript@^7`, `@playwright/test`) shadowed by per-workspace copies; `npm install --workspaces` footgun resolved by `npm ci` in CI but local docs still say `npm install` | Minor nondeterminism | 0.5 h | Backlog |
| T5 | `Deploy.s.sol` has no CREATE2 deterministic deployment (the old README claim was removed rather than implemented) — a prerequisite for the multi-chain plan | Blocks Base-first roadmap item | 4–8 h | Pre-mainnet |

---

## 8. Recommended schedule

**P0 — this week (≈ 2 dev-days):** B1 → A1 (publish, first green CI) → B3 → S2 → T1. Rationale: everything else is unverifiable and unmarketable until CI actually runs; B1 guarantees a red first push.

**P1 — next 2 weeks (≈ 2 dev-weeks):** S3 (doc-level fix) → B2 → B5 → Q6 → A6 → P3 → A10 → B4. Rationale: closes every adversarial/correctness testing gap on the enforcement surface before the audit scoping conversation; cheap, high-credibility wins.

**P2 — within a month, before the audit (≈ 4–5 dev-weeks):** S1 (token-cap binding — design first, it changes the whitelist leaf format and the SDK) → A3 (7579 executor module) → P1 (nonce reservation) → A5 (handleOps E2E). Rationale: these three are the difference between "caps are real" as marketing and as fact; auditors will attack exactly these.

**P3 — pre-mainnet / pre-audit hardening:** A2 (Safe+Timelock governance — decide now, changes audit scope) → A4 (Halmos auth-path specs) → A7 (wallet harness in CI) → P4/P5, Q1–Q9, S5/S6, S7, T3–T5.

**Dependency chain:** B1 → A1 → (everything CI-verified) → A7; S1 leaf-format change before external audit freezes scope; A2 decision before the audit scoping call; Q6/B5 before raising coverage thresholds (A6), or the gates start red.

---

## Appendix — Resolved since the Aug-2026 audit (verified at HEAD, no action needed)

msg.sender gate + initialized gate on `validateUserOp` (+5 tests); derived module ERC-7201 slot; module EIP-2 low-s; batch size bounds 1..8; unknown-key rotation rejection; required `SIGILKIT_OWNER_KEY`; canonical fixed-20-byte RLP address encoding (+ fixtures); `parseActionRequest` JSON normalizer (+6 tests); scope hard-expiry + local Merkle pre-check; throwing `assertAuditEmitted`; odd-length data rejection; dead `toTuple` removed; vacuous recovery test replaced; CI triggers (master+main), schedule cron, Slither 0.11.6 pin, `npm ci`, demo-agent lint/build in CI, echidna placeholder honestly deleted, gated nightly fork job; README/CHANGELOG/whitepaper claim scoping ("spend-cap core formally verified"); demo nonce wedge fix; demo docstring economics fix; Anvil-key warnings; mojibake fix. Live MetaMask 12.5.0 + Coinbase harnesses built (5/5 + 4/4 recorded) — though not yet CI-scheduled (A7) and leaving the placeholder file behind (B2).
