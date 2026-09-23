# Issues Catalog — Agent Review 2026-09-21

Independent catalog produced from an exhaustive full-repo read (187 tracked files + all
untracked source/doc files + 2,543 artifact files enumerated) on branch
`review-integration-20260917`. Cross-references existing streams: SK-01..SK-22,
V-01..V-08 (Issues-Catalog-2026-09-17.md) and earlier catalogs.

## Traceability summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 1 | AC-01 |
| High | 7 | AC-02..AC-08 |
| Medium | 12 | AC-09..AC-18, AC-32..AC-33 |
| Low | 13 | AC-19..AC-31 |

Priority ranking: **P0** = AC-01, AC-02, AC-03, AC-09 · **P1** = AC-04..AC-08, AC-10..AC-12 ·
**P2** = AC-13..AC-18, AC-19..AC-23, AC-32..AC-33 · **P3** = AC-24..AC-31.

---

## 1. Security

### AC-01 — Plaintext API keys in working tree (Critical, P0)
**Problem:** `.codebuddy/models.json` contains **six `apiKey` values in plaintext**
(localhost proxy + `api.cline.bot`). Currently gitignored (`.gitignore:19`), so not in
git history — but it sits in a tree destined to go public, one `git add -f` / archive
away from disclosure. Recorded as SK-01 in the 2026-09-17 catalog (still open).
**Expected vs actual:** key material should live in env vars / OS secret store; actual =
raw JSON on disk used by a dev tool.
**Severity:** Critical (credential disclosure). **Effort:** 1–2 h (migrate to env +
rotate both keys). **Dependencies:** none. **Timeline:** immediately.

### AC-02 — Unignored secrets-adjacent artifacts: full Chrome profile (High, P0)
**Problem:** `outputs/` is **not in .gitignore** (`?? outputs/` in git status) and
contains `chrome-mm-profile/` — a complete Chrome profile (~305 MB, 1,717 files) with
`Login Data`, `History`, `Extension Cookies`, `Local State` — plus `mm-recon2.mts` with a
hardcoded test mnemonic/password (test fixtures). A routine `git add -A` would stage
730 MB including local credential stores.
**Severity:** High. **Effort:** 0.5 h (.gitignore `outputs/`, `actionlint.exe`) + 1 h
profile removal policy. **Dependencies:** none. **Timeline:** immediately.

### AC-03 — Unignored 6.4 MB binary at repo root (High, P0)
**Problem:** `actionlint.exe` (PE32+ Windows binary) is untracked AND not gitignored;
will surface as `??` forever and could be committed accidentally.
**Severity:** High (repo hygiene / supply-chain surface). **Effort:** 0.5 h.
**Dependencies:** none. **Timeline:** immediately.

### AC-04 — CI download integrity gaps (High, P1)
**Problem:** `.github/workflows/ci.yml` bootstraps **actionlint from an unpinned
`raw.githubusercontent.com/.../main` script with no checksum**, and the wallet-e2e job
downloads **MetaMask 12.5.0 zip without checksum verification**. Gitleaks is
sha256-pinned, showing the project knows the pattern — these two were missed.
**Severity:** High (supply-chain). **Effort:** 0.5 d. **Dependencies:** none.
**Timeline:** before first real CI run.

### AC-05 — Exposed RPC token (High, P1)
**Problem:** `outputs/verification-followup.txt` states a **RPC API token was exposed and
should be rotated** (`RPC_BASE` unset). Rotation status unknown.
**Severity:** High. **Effort:** 0.5 h (rotate + set secret). **Dependencies:** external
account access. **Timeline:** immediately.

### AC-06 — CDP automation of the user's real browser (Medium, P2)
**Problem:** `packages/core/test/wallet-e2e/real-metamask.ts` (untracked, 2026-09-19)
drives the user's real Chrome via CDP (127.0.0.1:9222) with a human-approval contract
limited to `personal_sign`. Risk of accidental signed transactions; all 5 recorded
attempts failed anyway. **Estimated impact:** low today, high if relaxed later.
**Severity:** Medium. **Effort:** 0.5 d (dedicated Chromium profile + keep sign-only
contract + assert never broadened in CI). **Dependencies:** AC-02 cleanup.
**Timeline:** with wallet-e2e repair.

### AC-07 — Slither informational findings need triage (Medium, P2)
**Problem:** latest run has 7 findings (log `full-test-slither-20260918.log`):
- `reentrancy-events`: emit-after-call in `ActionLog7579Executor.execute`
  (ActionLog7579Executor.sol#104–127) and `withdraw` (SessionKeyManager.sol#186–191).
  ActionLogger order is by-design (INV-3: audit iff success) — keep, document why.
  `withdraw` should be verified for state-before-call (CEI).
- `calls-loop`: `_erc20BalanceOf` staticcalls inside watchlist loop
  (SessionKeyManager.sol#575–580) — bounded ≤8, acceptable; add a comment pinning the
  bound's security relevance (any future raise reopens this).
- `timestamp`: expiry comparisons in `SessionKey7579Module._grant`
  (#166–180) — inherent to session semantics, miners can't exploit with uint48 windows.
- `assembly`, `low-level-calls`, `naming-convention`, `cyclomatic-complexity` — review
  each, either fix or record a dated waiver like existing `forge-lint` suppressions.
**Severity:** Medium (aggregate). **Effort:** 1 d. **Dependencies:** none.
**Timeline:** pre-publication.

### AC-08 — Duplicated gitleaks checksum in two workflows (Low, P3)
**Problem:** gitleaks v8.30.1 sha256 hardcoded in both ci.yml and publish.yml — version
bumps must be made twice (drift risk). **Severity:** Low. **Effort:** 1 h (single source
or Renovate-managed). **Timeline:** with AC-04.

## 2. Software bugs

### AC-09 — MetaMask wallet-e2e suite broken (High, P0)
**Problem:** the flagship C1 validation flow (real MetaMask signing an ActionRequest)
has **never succeeded**. Evidence:
- `outputs/wallet-auth.log` (09-19): 2 FAILs — import button never enabled,
  `eth_requestAccounts` failed.
- `outputs/real-metamask.log`: 5 FAILs against real Chrome via CDP.
- Earlier run observed the auto-approve clicking "Create a new wallet"; `run.ts` patched
  to restrict auto-approve to request-route popups — regression unverified.
**Repro:** `RUN_WALLET_E2E=1 npx vitest run test/wallet-e2e.manual.test.ts -w @sigilkit/core`
against pinned MetaMask 12.5.0; **expected** import→req accounts→personal_sign→
`eth_signTypedData_v4` pass; **actual** import button disabled / RPC rejections.
**Likely causes to investigate:** MM 12.5.0 MV3 onboarding flow changes (consent modal
DOM), Anvil health-check timing, allowlist canary (`WALLET_BEHAVIOR_ALLOWLIST.json`)
interfering after the 7702 revoke rejection.
**Severity:** High. **Effort:** 1–3 d. **Dependencies:** AC-06 (profile isolation).
**Timeline:** this week — it blocks every "wallet integrations verified" claim.

### AC-10 — Doc-count drift fails the full gate (Medium, P1)
**Problem:** latest full local gate (09-18) is **8/9 — red on doc counts only**:
README/whitepaper claim 13 CI jobs / 1 publish job / 180 core tests / 12 indexer tests;
actual = 14 / 2 / 255 / 34.
**Repro:** `npm run check:docs -- --with-ts` → mismatch output.
**Expected vs actual:** counts must equal `forge test --list` + workflow YAML + vitest
runs; success by re-running with `--write` then fail-closed re-verify.
**Severity:** Medium (gate only). **Effort:** 2 h. **Dependencies:** none.
**Timeline:** this week.

### AC-11 — Echidna non-deterministic failure + shrinker crash (Medium, P1)
**Problem:** 09-18 03:14 run **failed**: `echidna_sink` falsified and the shrinker
crashed (`Prelude.init: empty list`); rerun 09-19 01:10 passed 4/4. A property-harness
or worker bug makes the nightly job flaky — in CI `continue-on-error` would mask it.
**Expected vs actual:** deterministic property outcome given fixed corpus/seed.
**Severity:** Medium. **Effort:** 0.5–2 d (repro under `echidna.yaml` settings: testLimit
50000, seqLen 100, shrinkLimit 5000; consider disabling shrinker for `echidna_sink`).
**Dependencies:** none. **Timeline:** pre-publication.

### AC-12 — Weak expiry-rejection assertion in SessionKeyManager tests (Low, P2)
**Problem:** `test_RejectsExpiredKey` (contracts/test/SessionKeyManager.t.sol) accepts
any revert whose data is `== selector || length >= 4` — a different revert reason would
pass. **Expected:** exact error selector for expiry. **Severity:** Low (test-quality).
**Effort:** 1 h. **Dependencies:** none. **Timeline:** with next test touch.

### AC-13 — Working-tree state contradicts verification claims (Medium, P2)
**Problem:** ~40 modified + ~30 untracked files on `review-integration-20260917`
(including core src: client.ts, lease-fs.ts, validation.ts; ci.yml changes; new
check-* scripts). Docs (PROJECT-REVIEW-2026-09-17) record "115 contracts + 262 TS
pass" against commit `fd7bd3e`; the current tree adds NativeTransferAuthorization.t.sol,
real-metamask.ts, and gate changes — **no verification run certifies this exact tree**.
(Owned by the docs; flagged as operational risk.) **Severity:** Medium.
**Effort:** 0.5 d (commit or explicitly defer + re-run `npm run verify` once).
**Dependencies:** AC-10. **Timeline:** this week.

### AC-14 — Snapshot hygiene: 2.77M-gas test-bundle entry (Low, P3)
**Problem:** `.gas-snapshot` records `test_Gas_WhitelistDelta_IsBounded` at 2,770,799 —
a two-execution bundle, not a unit cost; distorts drift detection. **Effort:** 1 h
(annotate or split the test). **Timeline:** with next snapshot regeneration.

### AC-32 — Indexer default `confirmations: 12` silently skips fresh chains (Medium, P2)
**Problem:** `packages/indexer/src/indexer.ts` defaults `confirmations: 12`; on any
chain with head < 13 the backfill window (head − confirmations) is below genesis, so
a run stores 0 events and still persists an advanced cursor (poisoning later runs).
Reproduced 2026-09-22 in the end-to-end check: the demo manager emitted 4 events
(verified on-chain via `eth_getLogs`) yet backfill stored 0 until `--confirmations 0`
was passed. **Expected:** on a young chain, backfill either clamps effective
confirmations to `max(0, head-1)` or fails loudly — never silently stores nothing.
**Severity:** Medium (dev-chain onboarding footgun; CONFIGURATION.md documents the
flag but not this default-side effect). **Effort:** 0.5 d TDD (tests + clamp + docs
note). **Dependencies:** none. **Timeline:** Day 1 of the 30-day plan.
**Evidence:** `outputs/e2e-05b-backfill.log` (stored 0 with defaults) vs
`outputs/e2e-05c-backfill.log` (stored 4 with `--confirmations 0`).

### AC-33 — node:sqlite teardown abort exits 127 after a successful backfill (Medium, P2)
**Problem:** after printing `backfill stored N event(s)` the CLI process aborts with
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`
→ non-zero exit (127) on a successful run. Breaks fail-closed semantics: a green run
reports red. Windows + Node 24 experimental sqlite; reproduced twice 2026-09-22.
**Expected:** a successful backfill exits 0 (statements finalized, db closed, clean
exit before uv teardown). **Severity:** Medium. **Effort:** 0.5 d TDD.
**Dependencies:** AC-32 (same test neighborhood). **Timeline:** Day 1 of the 30-day
plan. **Evidence:** `outputs/e2e-05b/05c-backfill.log` (`BACKFILL_EXIT=127`).

## 3. Performance

### AC-15 — No production-scale indexer benchmark (Medium, P2)
**Problem:** `scripts/benchmark-indexer.mjs` is bounded (≤1,000 rows / 3 reps) and
correctly reports `authoritative:false`, but no evidence exists for throughput beyond
demo scale; indexer writes synchronously via `node:sqlite` on a single thread.
**Measurable goal:** define a 100k-event load target (rows/s, DB size, query latency)
before "production-ready" claims. **Severity:** Medium (readiness evidence, not a bug).
**Effort:** 1 d benchmark + target in docs. **Dependencies:** none. **Timeline:**
pre-publication.

### AC-16 — Token watchlist loop bound is implicit (Low, P2)
**Problem:** `_snapshotBalances` staticcalls per watched token (≤8, slither calls-loop).
The cap is a constant; raising it (e.g., 32) would multiply per-execute RPC gas cost.
**Effort:** 0.5 h comment + test pinning cost at cap. **Timeline:** with AC-07.

### AC-17 — 730 MB scratch dir growth (Low, P3)
**Problem:** `outputs/` (730 MB) grows unbounded (chrome profile, tool binaries,
corpus dirs). `npm run clean` doesn't cover it. **Effort:** 1 h cleanup script rule.
**Dependencies:** AC-02. **Timeline:** this week.

## 4. Code quality

### AC-18 — Contradictory doc claims rattle the "claim-rigor" brand (Medium, P2)
**Problem:** root `SigilKit_Whitepaper.txt` (v2.0) still asserts "audited", "Immunefi
bounty live", Certora gate, UUPS+Safe upgradeability — all discredited by
v2.1/SECURITY.md and the vault's own corrections file. STATUS.md names the 09-12 catalog
"current and only active" while the 09-17 catalog (SK-21) supersedes it. README test
counts (180/12) vs actual (255/34) — same root cause as AC-10.
**Severity:** Medium (reputation + contributor confusion). **Effort:** 0.5–1 d (banner
or delete v2.0 txt; update STATUS; SK-21 closure). **Dependencies:** AC-10.
**Timeline:** pre-publication.

### AC-19 — Lockfile platform-reproducibility risk (Medium, P2)
**Problem:** lockfile pins TS **7.0.2 via platform-native `@typescript/*` packages**;
Sep-15 session notes record per-platform lockfile breakage. **Effort:** 1–2 h evaluate
(pin mainstream TS or document platform requirements). **Timeline:** pre-publication.

### AC-20 — Misleading `view` on a state-asserting test (Low, P3)
**Problem:** `test_Implementation_IsSelfOwnedAndUninitializable` is marked `view` but
asserts live instance state. **Effort:** trivial. **Timeline:** next test pass.

### AC-21 — Stale/deleted artifacts loose in tree (Low, P2)
**Problem:** `packages/indexer/cli-dbg.db` (40 KB debug SQLite), `debug.log`,
`fleet-manifest.json` (demo run output), old `benchmark-node24.json` with the false
`authoritative:true` claim; the combined-ABI JSON deletion (`D` in git status) is
intentional but uncommitted. **Effort:** 1 h (delete + commit with rationale).
**Timeline:** with AC-13 commit.

### AC-22 — Indentation/stray-comment artifacts in tests (Low, P3)
**Problem:** misaligned Scope literals in SessionKeyManager(.invariant).t.sol; stray
inline comment inside a function brace in `test_UninitializedEoa_IsInert`. **Effort:**
0.5 h (forge fmt). **Timeline:** next contracts touch.

### AC-23 — MCP protocol pinned without upgrade plan (Low, P3)
**Problem:** MCP server hand-rolls JSON-RPC against protocolVersion `2024-11-05`;
fine today, but spec churn will hit. **Effort:** 1 h — document pin rationale + add a
protocol-version compat test. **Timeline:** post-publication.

## 5. Architecture

### AC-24 — ERC-7579 spend enforcement lives only in the validation module (High, P1)
**Problem (extends SK-03/SK-04):** `SessionKey7579Module.validateUserOp` charges caps at
validation; `ActionLog7579Executor.execute` re-checks nothing except its own lock and
audit emit. An account installing both is safe only if every execution path routes
through validation. A misconfigured account (executor without validation module, or
management-mode framing per SK-03) silently executes uncapped.
**Expected vs actual:** cap enforcement should fail closed wherever actions execute, or
the trust boundary must be machine-checked (test matrix for module combination).
**Severity:** High. **Effort:** 2–5 d (design closure + tests or explicit documented
trust contract). **Dependencies:** SK-03/SK-04 closure. **Timeline:** pre-mainnet.

### AC-25 — Indexer reorg recovery is manual-only (Medium, P2)
**Problem:** fail-closed cursor-hash validation aborts before writes (good), but
recovery = operator rebuilds a fresh DB; `rollbackTo` clears the cursor hash only.
For demo-scale operators this is a service-interruption trap.
**Effort:** 2–3 d helper (`reorg-recover` subcommand) or documented runbook with tests.
**Timeline:** post-publication.

### AC-26 — Cooperative lease fencing is a documented non-goal (Medium, P2)
**Problem:** after broadcast, a second process can double-send (SK-09 provenance binding
partially mitigates pre-broadcast). Fine while #writers=1 is documented; the MCP/demo
READMEs should state the single-writer invariant in the same place users configure DBs.
**Effort:** 0.5 d doc alignment. **Timeline:** pre-publication.

### AC-27 — No upgrade path by design — docs still describe one (Medium, P2)
**Problem:** contracts are immutable/self-owned; SECURITY.md endorses this. Root
whitepaper v2.0 still advertises UUPS+timelock upgradeability, and DEPLOYMENT.md must
state migration = redeploy + `rotateSessionKey` + denylist. **Effort:** covered by
AC-18. **Timeline:** with AC-18.

## 6. Technical debt / business blockers

### AC-28 — No git remote; CI has never executed once (High, P1)
**Problem:** zero remote means all claims of "13 jobs / 2 workflows / gates green" are
unexerced by construction; the 04-12 catalog documented this, still true. Two workflows
were restructured in the working tree but nothing has validated them in CI.
**Effort:** 0.5 d once repo exists. **Timeline:** blocked on repo creation (external).

### AC-29 — npm scope squat blocks publishing (High, P1)
**Problem:** `@sigilkit/*` is owned by an unrelated project; publish.yml fails fast by
design. Unblocking = rename scope or acquire scope. **Timeline:** external decision —
needed before "9/9 + publish" end state.

### AC-30 — Wallet e2e in CI is continue-on-error with no success ever recorded (High, P1)
**Problem:** the weekly `wallet-e2e-weekly` job could silently pass (green exit) while
its body has never once completed a signing flow. A waiver is acceptable only with a
dated success criterion — currently the criterion ("real signed ActionRequest") has
zero evidence. **Effort:** tie job status to AC-09 closure. **Timeline:** with AC-09.

### AC-31 — Gate coverage blind spots (Medium, P2)
**Problem:** `scripts/assurance-inventory.mjs` snapshots declarations but "asserts
nothing executed" (by design). Combined with AC-13 (uncommitted tree), a green report
can describe a tree that never ran. **Effort:** 1 d — record tree SHA + dirty flag into
verify output, fail on dirty unless `--allow-dirty`. **Timeline:** pre-publication.

---

## Suggested sequence

1. **Now (P0, ~1 d):** AC-01 key migration+rotation · AC-02/AC-03 gitignore ·
   AC-05 token rotation · AC-09 start (wallet e2e) · AC-13 commit decision ·
   AC-10 + AC-18 doc counts/claims.
2. **Pre-publication (1–2 wks):** AC-04/AC-08 CI pinning · AC-24 7579 boundary ·
   AC-11 echidna stability · AC-07 slither triage · AC-19 lockfile · AC-15 bench ·
   AC-31 verify provenance.
3. **Post-publication:** AC-25 reorg tooling · AC-23 MCP versioning · AC-26 doc
   invariants.
4. **Blocked external:** AC-28 (repo), AC-29 (npm scope) — both precede any
   publish milestone.

---

## Execution log (2026-09-21)

- **AC-10 DONE**: `check-doc-counts --write` + manual whitepaper/README prose fixes
  (14 CI jobs, publish.yml 2, core 255, indexer 34); `--with-ts` re-verify green.
- **AC-12 DONE**: `test_RejectsExpiredKey` now asserts the exact `KeyExpired`
  selector; forge test passes.
- **AC-14 DONE**: whitelist-delta test restructured — second manager deployed in
  `setUp`, measurement isolation preserved (delta 2,757 gas, budget 5,000);
  snapshot entry 2,770,799 → 434,731; GasBudgetTest 4/4. `.gas-snapshot`
  regenerated (includes entries for uncommitted tree changes — review before commit).
- **AC-11 ROOT-CAUSED, fix already in working tree**: `echidna_sink` was
  auto-detected as a property (testMode: property), falsified on an empty
  sequence, and the shrinker crashed with `Prelude.init: empty list` (upstream
  crytic/echidna #1397). The existing rename `echidna_sink` → `sink`
  (EchidnaProperties.t.sol:93 + echidna.yaml) is the fix; 09-19 rerun passed 4/4
  on this tree. **CI stays red on the committed tree until committed.**
  Optional belt-and-braces: `shrinkLimit: 0` (skipped — would forfeit
  minimization for future real findings).
- **AC-09 FIXES APPLIED (pending live run)**: run.ts locator rebinding (stale
  `importBtn` was the import-button root cause), consent-gate property check +
  per-iteration evidence logs, autoApprove click logging, stringified rejection
  diagnostics on all three request legs; real-metamask.ts preflight
  (fail-fast when MetaMask is absent from the CDP profile); allowlist coherence
  (coinbase harness field added, type4-acceptance claim marked not-live-harness).
  Remaining: confirm an 8-leg green run; AC-04 (checksum pinning of MM zip /
  actionlint) not yet done.
- **AC-09 GATE ROOT CAUSE (2026-09-22)**: the welcome CTAs are gated by
  `onboarding-terms-checkbox`, not only by the data-collection modal. The real
  `<input>` is visually hidden behind a styled `<label>`, so Playwright's
  `locator.check()` never clears actionability and the button stayed disabled.
  Fix: click the labelled element by testid, with a bounded forced check on the
  bare input as fallback.
- **AC-09 VERSION NOTE**: metamask.io is not an authoritative source for this —
  the marketing site publishes no version string and no EIP-7702 / session-key
  copy (its only developer surface is the Smart Accounts Kit delegation
  toolkit). The pinned version is provenance from the vendored
  `manifest.json` (`12.5.0`) plus the upstream GitHub release tag; the harness
  deliberately pins rather than tracks the store's rolling release, so a newer
  store version is not a harness bug.
  Locator constraint discovered the hard way: LavaMoat scuttling inside the
  extension page forbids `locator.evaluate()` (throws `Int8Array of globalThis
  is inaccessible`), so gate state must be read via `count()` /
  `getAttribute()` / `isDisabled()` only.
- **AC-09 GATE CLEARED, NEW BLOCKER (run 2026-09-22, `outputs/wallet-e2e-20260922a.log`)**:
  terms-click fix confirmed — `welcome terms box clicked via label` then
  `onboarding poll: ... ENABLED (disabledAttr=null isDisabled=false)` then
  `metametrics declined`. 5/9 legs green, including the EIP-7702 raw-revoke
  canary. Now stuck one screen later: `#onboarding/import-with-recovery-phrase`
  exposes only `app-header-logo` + `import-srp-confirm` and **12 checkboxes**,
  with none of the three probed SRP input selectors matching — the confirm
  click does not advance. The three downstream legs then failed with
  `page.evaluate: Target crashed`, i.e. a dapp renderer crash that is a
  *separate* robustness defect from the locator problem (a locator miss must
  not cascade into a crashed target for the signing legs).
- **AC-09 / AC-04 SUPERSEDED-BY-VERSION FINDING (2026-09-22)**: upstream is
  **13.49.0** (tag `v13.49.0`, published 2026-09-17); this repo pins **12.5.0**
  — a full major line behind. Two consequences:
  1. *AC-09 is monitoring a version no user runs.* The weekly canary asserts
     behavior against a dead build, so it structurally cannot catch a
     regression already shipped in the 13.x line. Its 12.5.0 onboarding
     locators are archaeology, not test maintenance.
  2. *Direct evidence the 7702 surface moved.* 13.49.0's Security section:
     "Improved advanced-permission handling by requiring eligible accounts to
     complete EIP-7702 upgrades before permissions are granted (#46082)."
     MetaMask now gates its own advanced permissions behind 7702 delegation —
     so `metamask:type4-tx-accepts-authorization-list` (which has **no**
     live-harness coverage and was verified only against a 2025-08 changelog)
     is the entry most likely to be wrong today.
  **AC-04 is now unblocked with real data**: the release ships a `SHA256SUMS`
  asset, and its digests match GitHub's per-asset digests exactly —
  `metamask-chrome-13.49.0.zip` =
  `sha256:7ba00bfe4fe8b0ffb27be1e8fc06506248f1b888cb4f2e5e5e8b1c37f461f262`.
  Recommendation: re-pin `.github/workflows/ci.yml:292-303` and the vendored
  build to 13.49.0 with that checksum *rather than* finishing the 12.5.0 SRP
  locators, then re-derive onboarding selectors once against the current
  version and record the 13.x 7702-permission behavior in the allowlist.
  Ask first — re-pinning changes a CI job's verified baseline.
- **AC-09 REPINNED TO 13.49.0 + PARTIAL GREEN (2026-09-22/23)**: ci.yml,
  run.ts, manual.test.ts, READMEs pinned to 13.49.0 with the GitHub asset
  checksum `7ba00bfe…`; local `metamask/` is the 13.49.0 build (12.5.0 retained
  as gitignored `metamask-12.5.0/`). Harness state: **6/10 legs green**,
  including the flagship canary `rejects-raw-zero-address-revoke` (PASS on
  13.49.0 — raw zero-address revoke stays rejected), SW registration, provider
  injection, chainId, funding, and the full import flow (re-derived 13.x SRP
  grid selectors + 3-gate dismissal + single-known-state unlock window). The
  three request legs (connect/personal_sign/EIP-712) fail only in the automated
  browser: MetaMask 13.x restarts its service worker mid-request
  (`[pageerror] Extension context invalidated`, `Target.createTarget` failures)
  — browser-infrastructure brittleness, not wallet refusal.
- **AC-09 MANUAL CONFORMANCE EVIDENCE (2026-09-22)**: user-driven check in
  Brave + MetaMask **13.48.0** (same 13.x family as the pin) against the local
  dapp fixture (anvil 8545 + dapp 8765, `/report` echo →
  `outputs/wallet-e2e-manual.log`): `eth_requestAccounts` →
  `0x9715…ba60` and `personal_sign` both approved on real clicks. Recorded as
  allowlist entry `metamask:13x-gesture-request-ui` (verifiedOn 13.48.0,
  human-driven, not harness-automated). Conclusion: sign/connect failures in
  automation are Playwright-context (stale tabs, lock state, SW restarts).
- **AC-09 DECISION (2026-09-22)**: abandoned neither — user chose to **PAUSE**
  AC-09 and defer the close-out path (hybrid canary-CI vs continuing Playwright
  hardening) while the evidence is fresh. All findings recorded here + in
  project memory; task #6 remains open.
- **AC-32/33 FIXED (2026-09-23, 30-day plan Day 1 — TDD)**: failing tests first
  (`packages/indexer/test/indexer.test.ts` fresh-chain describe + new
  `packages/indexer/test/cli.e2e.test.ts` spawning the real CLI against an in-process
  stub RPC). AC-32: `backfill` now fails loudly when the chain head is ≤ confirmations
  (message names `--confirmations 0`); the genesis edge (explicit `--confirmations 0`)
  is exempt and regression-tested. AC-33 root cause: Node 24's experimental
  node:sqlite aborts (`UV_HANDLE_CLOSING`, child exit 0xC0000409) whenever
  `process.exit` interrupts the loop with sqlite finalizations pending — even one
  macrotask deferred. Fix: the indexer CLI sets `process.exitCode` and lets the loop
  drain (5s unref'd watchdog). Suite 38/38; live anvil proof: default flags → exit 1 +
  guidance (`outputs/ac32-live-default.log`); `--confirmations 0` → exit 0
  (`outputs/ac33-live-conf0b.log`). Full verify 9/9
  (`outputs/verify-20260923-D1-final.log`).