# SigilKit — 30-Day Plan Status Audit (as of 2026-09-26, Day 4)

> **Layer:** L3 (Plan/status record). **Auditor:** dc-plan. **Date:** 2026-09-26 (pass 2, same day).
> **Scope:** read-only audit of `docs/PLAN-30-DAYS-2026-09-23-to-2026-10-22.md` progress
> claims against the actual working tree. **No source file was modified.**
> **Pass 2** incorporated cr-sec's correction to my row-6 verdict (§1.4, §8) and recorded that the
> repo's own count gate went **red** mid-audit (§9). One of my original findings was **wrong** and
> is corrected in place rather than quietly dropped.
> **Adjudication rule (per `docs/STATUS.md`):** code beats prose. Where this file and the
> plan disagree, the code is right and the plan is the bug.

---

## 0. Executive summary — seven findings that change the plan

| # | Finding | Severity | One-line verdict |
|---|---|---|---|
| **F-1** | **All 30 days' weekday labels are wrong.** Plan says D1 = "Tue 09-23"; 2026-09-23 is a **Wednesday**. Every label is shifted by exactly one day. | **High** | The Monday/Saturday/Sunday weekly-cadence anchors (W-1/W-2/W-3/R-4) are therefore attached to the **wrong days**, so "Monday wallet canary" and "Sunday standards-watch" cannot fire as written. |
| **F-2** | **The plan is one catalog behind.** It was written 2026-09-23 and cites the 09-21 catalog. A **100-item catalog** (`docs/ISSUES-CATALOG-2026-09-25.md`, **80–140 person-days**) landed 2026-09-25 — mid-flight, never incorporated. | **Critical** | 30 days × ~1 engineer cannot absorb 80–140 person-days of new work. The plan has **no line item** for it. |
| **F-3** | **~180 changed files are uncommitted and still climbing (127 → 161 → 181 across this audit); the last commit is 2026-09-23.** Zero commits on 09-24, 09-25, 09-26. | **Critical** | Three days of work (incl. 3 of the 4 P0 security fixes) exist only in the working tree. A crash loses them; the plan's own "tree green every day" + "commit-week proposal" cadence is already broken. |
| **F-4** | **All 5 claimed evidence artifacts are absent** from `outputs/`. | **High** | The plan's core discipline is "nothing counts as done without proof" (`:3`). The proof for W1-4.1, W1-4.2, W1-6.3, W1-2.2 and AC-32/33 does not exist on disk. |
| **F-5** | **All 4 P0 items from the 09-25 catalog are now fixed in the tree — but the catalog still lists all 4 as open.** | **High (positive)** | P0 #1 (Halmos arity meta-test), #2 (Echidna funding + real probes), #3 (MCP db allowlist) were already done when I started; **#4 (invariant ghost) was completed during this audit** (sc-test landed F2/F5, ck-test fixed the last site and proved it by mutation). The *record* is now 4/4 stale. Cheapest possible class of fix — and nobody should redo this work. |
| **F-6** | **Threat-map rows 6 and 10 are stale in the opposite direction: row 6 is fixed, row 10 is not, and W3-4.1 is scoped against the stale copy.** | **High** | Re-scoped 2026-09-26 after cr-sec's report; see §1.4. Half of W3-4.1 is already delivered, so executing it as written would burn 14 days re-doing finished work. |
| **F-7** | **The count gate is RED (exit 1) on 9 real drifts** — docs say 158 tests / 14 suites / 49 forge-lint annotations; the toolchain says **211 / 17 / 54**. | **High** | The compile-break that masked this (my pass-3 **B-0**) is **fixed and B-0 is withdrawn** — ck-test verified, I re-verified. The gate now runs and reports honestly. Owner: ck-doc / dc-law, **one** commit, **after** B-2. See §9.1b. |

**Bottom line:** the plan is **not behind on engineering** — it is behind on **bookkeeping and
on scope**. Real code work is genuinely strong (see §2). But the plan's own control mechanisms
(proof artifacts, commit cadence, weekday anchors, catalog currency) have all failed, and a
100-item catalog arrived uninvited. **Fix the record first (≈1 day), then re-baseline scope.**

---

## 1. Progress deviation table (doc claim vs. verified reality)

Legend — **VERIFIED**: code exists at cited anchor. **PARTIAL**: some part done. **ABSENT**:
not started. **BLOCKED**: gated on external/approval. **STALE-CLAIM**: plan understates what
was actually built.

### 1.1 Week 1 (D1–D7) — claimed window 2026-09-23 → 09-29; actual elapsed D1–D4

| ID | Plan says | Verified reality | Anchor | Verdict |
|---|---|---|---|---|
| **W1-1.1** | `[ ]` Rotate 6 apiKeys + AC-05 token | **NOT DONE.** `.codebuddy/models.json` still contains **6 live `apiKey` fields**, none redacted. Untracked-but-present. | `.codebuddy/models.json` (6 matches, `REDACTED` = false) | **BLOCKED** — needs [D] + provider consoles. **This is the Day-0 item; see §3.** |
| **W1-1.2** | `[ ]` Catalog AC-32/33 | **DONE.** Both cataloged with root cause + fix. | `docs/Issues-Catalog-2026-09-21-Agent-Review.md:410-422` | VERIFIED |
| **W1-1.3** | `[ ]` AC-32/33 TDD red→green | **DONE.** Fail-loud guard in `indexer.ts`; natural-drain exit in `cli.ts` (watchdog `unref`). | `packages/indexer/src/indexer.ts:952-971`; `packages/indexer/src/cli.ts:243-255` | VERIFIED |
| **W1-1.4** | `[ ]` Start 7702 threat map | **DONE, and better than "started".** 10 vectors, all 6 required sources (CertiK / arXiv:2512.12174 / sweeper / chain-id=0 / ToB), every row carries exposure + severity + task ID. | `docs/SECURITY-7702-THREAT-MAP.md:9-20` | VERIFIED (exceeds claim) |
| **W1-2.1** | `[ ]` Ship W1-1.3 + live backfill proof | **DONE in code**; **proof log absent.** | code as above; `outputs/ac32-live-default.log` **ABSENT** | PARTIAL — claim-rigor gap (F-4) |
| **W1-2.2** | `[x]` AC-09 hybrid closeout | **DONE.** `testAutoOrManual` present, 3 env-brittle legs → MANUAL never FAIL, exit code = automated legs only; `serve-manual.mjs` serves `/report` and writes `outputs/wallet-e2e-manual.log`. | `packages/core/test/wallet-e2e/run.ts:91-99`, `:1194-1203`; `serve-manual.mjs:21` | VERIFIED |
| **W1-2.3** | `[x]` Allowlist entries | **DONE** (catalog-recorded). | catalog `:430-431` | VERIFIED (code anchor n/a) |
| **W1-3.1** | `[ ]` [D] decide repo home | **DONE.** Remote exists: `https://github.com/dev25bansal-ops/sigilkit.git`. | `git remote -v` | **STALE-CLAIM** — plan says undecided; it's decided. |
| **W1-3.2** | `[ ]` `git push -u origin review-integration-…` | **NOT DONE.** Remote has **only `origin/master`**; the working branch `review-integration-20260917` was **never pushed** (`unknown revision` on `origin/…`). | `git branch -r` → `origin/master` only | **BLOCKED** — correctly gated on [D] push approval. |
| **W1-3.3** | `[ ]` Read first CI run | **NOT DONE — impossible.** CI has never executed (AC-28). | catalog `AC-28 :269` | **BLOCKED** by W1-3.2 |
| **W1-3.4** | `[ ]` Map CI gaps | **PARTIAL.** `scripts/install-actionlint.sh` exists (SEC-07 fix); but **1 unpinned `uses:` remains** — `publish.yml:58 actions/setup-python@v5` (vs 38 SHA-pinned). | `scripts/install-actionlint.sh:21-22`; `.github/workflows/publish.yml:58` | PARTIAL |
| **W1-4.1** | `[x]` Weekly wallet canary 6 PASS/3 MANUAL | **DONE per catalog; log ABSENT.** | `outputs/wallet-e2e-20260923-hybrid.log` **ABSENT** | PARTIAL (F-4) |
| **W1-4.2** | `[x]` Slither 0.11.6, 0 High/Med on src | **DONE per CI-WAIVERS; all 3 evidence files ABSENT.** 2,315 findings / 53 unique on src / 0 High-Med. | `docs/CI-WAIVERS.md:48-50`; `outputs/slither-20260923.*` **ABSENT** | PARTIAL (F-4) |
| **W1-4.3** | `[ ]` [D] Brave manual pass | **NOT DONE.** No `wallet-e2e-manual.log`. | ABSENT | **BLOCKED** on [D] |
| **W1-5.1** | `[x]` SECURITY.md + security.txt | **DONE, verified.** 0 stale `sigilkit/sigilkit` refs in both; `check-doc-counts` reports "security.txt OK — disclosure channel present and unexpired". | `SECURITY.md` (0 matches); `.well-known/security.txt` (0 matches) | VERIFIED |
| **W1-5.2** | `[x]` Threat-map deep dive rows | **DONE.** Status block resolves rows 1,2,3,5,7,9; defers 6,10 → W3-4.1; 8 → W3-3.2/W4-1.1. | `SECURITY-7702-THREAT-MAP.md:22-26` | VERIFIED |
| **W1-5.3** | `[ ]` [D] finish rotation leftovers | **NOT DONE** — same blocker as W1-1.1. | `.codebuddy/models.json` | **BLOCKED** |
| **W1-6.1** | `[x]` Standards-watch 2026-09-23 | **DONE.** 7579 Draft, 7702 Final, registry unchanged. | catalog `:435-438` | VERIFIED |
| **W1-6.2** | `[ ]` Week-1 DoD self-audit | **NOT DONE.** No such record exists. | — | **ABSENT** (this file is the first) |
| **W1-6.3** | `[x]` Marathon `verify` 9/9 + forge 119/1 skip | **Gate count VERIFIED (9). Forge count WRONG — and drifting.** `verify.mjs --list` → exactly **9 steps**; but PR scope is **~198 tests / 16 suites**, not 119 (it read 158/14 on my first pass ~1h earlier — see §9). Also `forge (excluded) 5 tests / 2 suites`. Claimed log **ABSENT**. | `scripts/verify.mjs --list`; `check-doc-counts.mjs` | PARTIAL — **numeric claim is stale** |
| **W1-7.1** | `[x]` Week-2 prep | **DONE per catalog.** | catalog `:444-449` | VERIFIED |
| **W1-7.2** | `[x]` `RESEARCH-NUMBERS.md` | **DONE.** File exists (untracked). | `docs/RESEARCH-NUMBERS.md` | VERIFIED |
| **W1-7.3** | `[ ]` Commit-week proposal | **NOT DONE** — and ~180 files uncommitted make this now urgent. | `git status --porcelain` = 181 and rising | **OVERDUE** |

### 1.2 Week 2 (D8–D14) — claimed window 09-30 → 10-06; **entirely in the future**

The plan schedules these for **D8 = 09-30**, i.e. **4 days from now**. But three of them
were **already executed on 2026-09-23** and the catalog records them as such
(`docs/Issues-Catalog-2026-09-21-Agent-Review.md:444-449` — "**W2-1.1/1.2/1.3 (2026-09-23)**").

| ID | Plan says | Verified reality | Verdict |
|---|---|---|---|
| **W2-1.1** | `[x]` AC-01 scrub PLAN written | **DONE.** `docs/AC-01-SCRUB-PLAN.md` exists, unexecuted, correctly gated. | VERIFIED — **but dated 09-23, not 09-30** |
| **W2-1.2** | `[x]` AC-06 preflight | **DONE.** `real-metamask-preflight.ts` + `wallet-e2e-preflight.test.ts` exist, untracked. | VERIFIED — **dated 09-23** |
| **W2-1.3** | `[x]` AC-08 gitleaks dedupe | **DONE.** Single pin `v8.30.1` + SHA256 in `install-gitleaks.sh:17-18`. | VERIFIED — **dated 09-23** |
| **W2-2.1** | `[ ]` `check-hygiene.mjs` gate #10 | **NOT STARTED — confirmed.** No such file; `verify.mjs` has 9 steps, no hygiene gate. | ABSENT (accurate) |
| **W2-2.2** | `[ ]` `clean.mjs --audit-sizes` | **NOT STARTED — confirmed.** 0 matches for `audit-sizes` in `scripts/clean.mjs`. | ABSENT (accurate) |
| **W2-2.3** | `[ ]` AC-23 MCP pin decision | **NOT STARTED.** | ABSENT (accurate) |
| **W2-3.1** | `[ ]` AC-16 watchlist bound | **NOT STARTED — confirmed.** `MAX_WATCHED_TOKENS = 8` still an unnamed literal at `SessionKeyManager.sol:114`; no `watchlist_bound_hit` metric. | ABSENT (accurate) |
| **W2-3.2** | `[ ]` AC-19 lockfile test | **NOT STARTED.** | ABSENT |
| **W2-3.3** | `[ ]` `SyntheticSeeder.s.sol` | **NOT STARTED — confirmed.** No seeder file anywhere in `contracts/`. | ABSENT (accurate) |
| **W2-4.1** | `[ ]` AC-15 benchmark doc | **NOT STARTED — confirmed.** `docs/BENCH-INDEXER-2026-10.md` absent. (`scripts/benchmark-indexer.mjs` exists but the doc does not.) | ABSENT (accurate) |
| **W2-4.2** | `[ ]` Lease puncture loop | **NOT STARTED.** | ABSENT |
| **W2-5.1** | `[ ]` [D] manual wallet pass | **NOT DONE.** | **BLOCKED** on [D] |
| **W2-5.2** | `[ ]` AC-18 doc contradictions | **NOT STARTED.** | ABSENT |
| **W2-5.3** | `[ ]` AC-21/22 artifacts | **NOT STARTED.** | ABSENT |
| **W2-6.1/2/3, W2-7.1/2** | `[ ]` | **NOT STARTED.** | ABSENT |

> **Net Week-2 verdict:** 3 of 15 tasks are **already done (6 days early)**; the remaining 12
> are genuinely unstarted. The plan's *ordering* is wrong, not its *content*. Roughly **1.5
> working days of real work remain** in Week 2 — the plan budgeted 7.

### 1.3 Weeks 3 & 4 (D15–D28) — all future; spot-checked, all genuinely ABSENT

| ID | Deliverable | Verified |
|---|---|---|
| W3-3.1 SoK nonce+salt+deadline in hash | grep `nonce.*salt|salt.*nonce|deadline` in `SessionKeyManager.t.sol` | **0 matches** — ABSENT. Note: the production `ActionRequest` has `nonce`+`expiry` but **no salt/deadline** (`SessionKeyManager.sol:60-64`, typehash `:104`), so W3-3.1 implies a **contract change**, not just tests. |
| W3-3.2 ERC-1271 chainId binding | no `*1271*` test file | **ABSENT** |
| W3-5.2 MCP grant tools | grep `list_grants\|grant_status\|revoke_grant` in `packages/mcp/src` | **0 matches** — ABSENT |
| W3-7.2 Audit dashboard | `tools/dashboard` | **ABSENT** (dir does not exist) |
| W4-3.3 / W4-1.1 / W2-4.1 / W3-2.1 / W3-6.2 / W4-7.3 | `BOUNDED-AUTONOMY` / `AUDIT-PREP` / `BENCH-INDEXER` / `POSITIONING` / `DEMO-FLEET` / `RETRO` `.md` | **all 6 ABSENT** |
| W4-5.3 Docs site index | `docs/README.md` | **ABSENT** |

### 1.4 W3-4.1 RE-SCOPE — half of it is already delivered (2026-09-26 correction)

**Origin:** cr-sec reported that my §5.1 row R-c verdict ("`chainId: 0` … STILL OPEN") contradicted
the code. I re-verified independently rather than accepting the report, and **cr-sec is right —
my original verdict was wrong.** Correcting it here rather than silently, because the plan's own
method is "code beats prose" and I applied prose to code.

**What the plan says (W3-4.1, D18 = 10-10):** "7702 threat-map mitigations: chain-id-bound
authorization tuples + sweep-guard test + docs note for `extcodesize` misclassification".

| Sub-task | Plan's premise | **Verified reality** | Verdict |
|---|---|---|---|
| SDK asserts non-zero `chainId` | not started ("Partial — SDK layer exposed", threat-map `:16`) | **DONE.** `assertDelegationScope` (`eip7702.ts:375-446`) throws on `chainId === 0n` without explicit `allowAllChains` (`:407-413`); also fail-closed on chain mismatch (`:416`), revoke/delegate inversion (`:426-436`), delegate-target mismatch (`:438-443`). Tests pin both directions incl. the opt-in path (`signing-conformance.test.ts:371-402`). | **ALREADY DELIVERED** |
| Sweep-guard test | not started | **ABSENT.** No test exercises a sweeper-shaped delegation. | genuinely open |
| `extcodesize` docs note | not started | **DONE.** `SECURITY.md:166-168` warns `extcodesize` no longer distinguishes EOAs; threat-map row 3 records the accepted-by-design reading at `SessionKeyManager.sol:524`. | **ALREADY DELIVERED** |
| *(not in plan)* SDK nonce-uniqueness | threat-map row 10 → W3-4.1 | **STILL OPEN** — and now the highest-value item in this task. **The correct fix is narrower than "add a nonce assertion"; see the constraint below.** | genuinely open |

**Why the doc went stale:** `docs/SECURITY-7702-THREAT-MAP.md` and `packages/core/src/eip7702.ts`
are **both modified in the same uncommitted batch** (`git status` → ` M` on each). The threat map's
self-assessment was written at the *start* of that batch; the guard was finished later **in the same
batch, without updating those lines**. This is the mirror image of F-5: there, code beat the record;
here, the record was correct when written and lost to code that landed beside it. **Neither is
visible without a `git status` + grep cross-check** — which is precisely the check the plan's
"L3 expires by design" rule assumes someone performs.

#### The real residual gap is worse than "the guard is missing"

It is that **the guard is not on the mandatory path**:

- `signAuthorization` (`eip7702.ts:178-206`) computes `authorizationDigest(args)` at `:186` and
  signs it — **no scope parameter, no `assertDelegationScope` call**. A bare
  `signAuthorization({ chainId: 0, … })` still yields an all-chain credential.
- `DelegationScope.allowAllChains` is therefore a **purely opt-in, never-mandatory** control: the
  safe path exists but nothing forces a caller onto it.
- **Mitigating fact:** `packages/demo-agent/src` and `packages/mcp/src` contain **zero** 7702
  authorization references (verified — the only `authoriz*` hits in `mcp/src` are `server.ts:242,387`
  describing the *database* allowlist). **So no production caller is exposed today.** That is also
  why this sat unnoticed: there is nothing to trip it yet.
- **The risk is prospective, not active:** "SDK is safe by default *if remembered* — the next
  integration that signs a 7702 authorization silently inherits a cross-chain-replayable credential."

**Recommended re-scope of W3-4.1** (from "add a chainId assertion" to the change that actually
closes the vector):

1. **Make the existing guard mandatory** — fail-closed inside `signAuthorization` on
   `chainId === 0n`, or take a required `scope` argument. *This, not the guard's existence, is
   what closes row 6.*
   **This needs no new design — the pattern already exists in the codebase.** `SigilKitClient`
   accepts an optional `expectedChainId` (`client.ts:176`) and **throws in the constructor** on a
   mismatch (`:557-565`), converting a silently mis-signed domain into a startup failure. That is
   structurally the same move as "make the guard mandatory": validate a dangerous default at
   construction, fail closed, and do it *before* any signature is produced. Port the precedent to
   the 7702 layer rather than inventing an approach (found by cr-sec; I verified both anchors).
2. **Close row 10 by writing down who owns nonce uniqueness — and do NOT make the SDK track used
   nonces.** This constraint is not a preference; it is forced by the repo's existing architecture,
   and I verified all three legs of it:
   - `SigilKitClient` is **"Stateless by design: holds no keys, caches no state — safe across a
     fleet of agents"** (`client.ts:531`). Putting a used-nonce set in the SDK contradicts a
     documented, deliberate invariant.
   - A process-local set **silently loses protection** across restart / multi-instance / multi-host
     — strictly worse than no check, because it reports a closure that is not there. This is the
     same failure mode as the fleet's own documented reasoning, which states **"the on-chain nonce
     monotonicity remains an independent defense"** in **two** places — `client.ts:362-369`
     (`LeaseLostError`) and `client.ts:250-254` (`NonceGate` docs). The codebase already treats
     the chain as the authority and local state as best-effort.
   - Per EIP-7702 the authorization nonce is **account-level, consumed by the execution layer**.
     A second ledger inside the SDK would put two books on one nonce space; the double-spend
     window degrades from "wallet-guaranteed" to "whichever book is slower."
   - `eip7702.ts` is a **pure, stateless module** whose value is that it can be pinned
     byte-for-byte against canonical viem fixtures — 8 hard-coded digests, cross-checked against
     live viem (`eip7702.test.ts:44-74`). Adding mutable state destroys that property.

   **So the deliverable is:** (a) a **pure, static** freshness assertion — **`nonce` must be
   explicitly supplied and must not be the default `0`** (see the correction below for why it
   cannot be a chain read) — plus (b) an explicit written statement that **nonce uniqueness is the
   execution layer's responsibility and the SDK's job is freshness, not bookkeeping**.
   `SECURITY.md:202-205` already warns that a signed tuple is persistent control and that
   `chain_id=0` replays across chains, but it says **nothing about nonce ownership** — that is
   the gap to close.

   > 🔴 **Correction (pass 5, after cr-sec).** My first draft of (a) said the check could "align
   > with `client.ts:193-197`, where an omitted `nonce` triggers an on-chain `getNonce` fetch."
   > **That is wrong, and following it would produce a broken implementation.** There are **two
   > unrelated nonce spaces**, and conflating them is the exact failure mode this item is meant
   > to prevent:
   > - `PrepareExecutionArgs.request.nonce` (`client.ts:193-197`) is the **application-layer**
   >   `ActionRequest` nonce — per-**session-key**, monotonic on-chain via
   >   `SessionKeyManager.getNonce`, with a real `PublicClient` available to fetch it.
   > - `signAuthorization`'s `nonce` (`eip7702.ts:178-206`) is the **EIP-7702 authorization**
   >   nonce — per-**EOA account**, consumed by whoever executes the type-4 transaction, and
   >   deliberately **not** tracked by SigilKit's contracts.
   >
   > And the capability gap is hard: **`signAuthorization` is synchronous and takes only a
   > `SignerLike`** — it has no `PublicClient` and no chain access whatsoever (`eip7702.ts`
   > imports no chain client). Making it read a pending nonce would mean **injecting a
   > `PublicClient` into a pure module** — precisely the API-shape change this re-scope was
   > meant to avoid, and one that would also break the golden-vector property at
   > `eip7702.test.ts:44-74`.
   >
   > **Correct scope for (a):** a pure static assertion in the spirit of "reject an omitted or
   > zero `nonce`" — `0` being the value an LLM or a config default is most likely to produce.
   > No chain read, no storage, still vector-testable.
3. Sweep-guard test (unchanged).
4. `extcodesize` note — **drop from this task; already shipped in `SECURITY.md:166-168`.**

**Net effect: W3-4.1 shrinks from 3 items to 2, and its highest-value item changes from
"write a guard" to "make an existing guard unavoidable."** Scheduling it as written on D18 would
spend 14 days of lead time re-delivering shipped work while the genuinely open, genuinely unowned
residual gap sits in it unnoticed.

> ⚠️ **Do not implement item 2 as "the SDK refuses a repeated nonce."** That option looks like the
> safe one and is a **fake fix**: a process-local used-nonce set silently empties on restart and
> diverges across a fleet, so it would report a closure that does not exist — while breaking the
> documented stateless invariant at `client.ts:531` and the golden-vector property at
> `eip7702.test.ts:44-74`. The correct closure is a **static freshness assertion plus a written
> statement of who owns nonce uniqueness** (the execution layer). This constraint came from cr-sec
> and I verified all three of its anchors.
>
> ⚠️ **And do not let item 2 borrow `prepareExecution`'s `getNonce` default** — they are different
> nonce spaces and `signAuthorization` has no chain access. See the pass-5 correction above.

---

## 2. What is genuinely strong (do not let the audit bury this)

- **The 7702 threat map is real and excellent** — 10 vectors, 6 mandated sources, every row
  anchored to code and terminating in a task ID or an accept-with-reason. This is the
  highest-quality artifact in the repo and it is **complete**, not "started".
- **AC-32/AC-33 are genuinely fixed** with correct root-cause reasoning (the
  `toBlock === undefined` conditioning bug at `indexer.ts:956-961` is a real second-order
  finding — the guard no longer has a `--to` bypass).
- **AC-09's hybrid resolution is sound**: automated legs stay fail-closed, environment-fragile
  legs become MANUAL, exit code depends on automated legs only.
- **SEC-07 is fixed**: `install-actionlint.sh` pins version **and** SHA256 and verifies
  *before* extracting — the textbook fix, matching the in-repo `install-gitleaks.sh` pattern.
- **SEC-04 is fixed** to a higher standard than asked: `SIGILKIT_AUDIT_DB_ROOT` allowlist,
  `realpathSync.native` canonicalization, uniform refusal codes, and **fail-closed when unset**.
- **Halmos auth specs are no longer vacuous**: `_execute` encodes the exact 4-arg production
  arity, and `test_HalmosAuth_ArityIsFour` (`:216`) is a **meta-test that pins the harness
  itself** — 5 `check_` specs now exercise replay/nonce/stale/denylist/window.
- **Echidna is no longer vacuous**: BUG-18 replaced the tautological properties with
  `refill()` + `_ensureFunded` funding and real non-owner admin probes
  (`EchidnaProperties.t.sol:118-139`, `:325-347`).
- **P0 #4 (invariant ghost) is now closed — and closed properly.** My §1 pass recorded three
  sub-defects; ck-test reports F2/F5 were already landed by sc-test, and he fixed the last one.
  I verified: `ghostMaxPerWindowCap` is **no longer** raised in `_syncScopeGhost` (`:233` now
  carries an explicit comment saying it is *deliberately* not raised there) and is instead
  updated on the **charge** path (`:280-281`), which is the correct semantics — a cap the owner
  granted but never spent must not back-authorise later spend. `ghostTotalSpent` +
  `invariant_valueIsConserved` are present (`:52`, `:274`, `:410-413`).
  **He also proved it non-tautological by mutation** (`&& false` → `[FAIL: INV-1 violated]` with a
  counterexample; restored → 4/4 PASS). That is the standard the 09-25 catalog's vacuity findings
  demanded, and it is the right way to close a "this assertion cannot fail" finding.
- **`check-doc-counts` is the tie-breaker the repo trusts**, and it was **green when this audit
  began** (it is not any more — see §9.1): 158 PR-scope tests,
  14 CI jobs, 11 Halmos specs, 4 Echidna properties, 22 vault notes — all matching prose.

---

## 3. Timeline realism — **the plan is not realistic as written**

### 3.1 Day 4 verdict: engineering pace is *ahead*, process pace is *behind*

| Measure | Plan expectation by end of D4 | Actual | Delta |
|---|---|---|---|
| Week-1 tasks closed | ~16 of 21 | **11 verified + 4 partial + 6 blocked/unstarted** | ≈ on pace |
| Code artifacts | — | ~180 files changed, **0 committed** | **−∞ on process** |
| Commits | daily rhythm R-1/R-2 | **0 commits since 09-23** (3 days) | **3 days behind** |
| Evidence artifacts | required per task | **5 of 5 claimed artifacts absent** | **proof chain broken** |
| New unplanned work | 0 | **100-item catalog, 80–140 person-days** | **plan has no line for it** |

### 3.2 The load-bearing problem: 80–140 person-days landed on Day 3

`docs/ISSUES-CATALOG-2026-09-25.md:19` totals **100 items / 80–140 person-days** across
A/B/C/D/E categories. The 30-day plan allocates **30 working days**. Even at a perfect
1.5× velocity multiplier, absorbing 80 person-days needs ~53 days. **The plan cannot both
close this catalog and ship its own Week-3/4 deliverables (positioning, Safe matrix, erc7579
listing, fleet demo, dashboard, audit-prep, publish, semver).** These are not additive — they
compete for the same days.

Its own wave table (`ISSUES-CATALOG-2026-09-25.md:566-571`) spends **Wave 1 (~6 d) + Wave 2
(7–8 d) + Wave 3 (~7 d) = ~20 d** on catalog items alone — i.e. **two-thirds of the 30 days
before Week-3 positioning work even starts.**

### 3.3 The weekday bug makes the cadence unrunnable (F-1)

The plan's weekly cadence is *defined* by weekday names:

> `W-1 (Mondays) — weekly wallet canary` · `W-2 (Saturdays) — dev25 manual pass` ·
> `R-4/W-3 (Sundays) — standards-watch + DoD self-audit`

But the day headers are shifted +1: the plan's **"D1 (Tue 09-23)"** is really **Wed**;
**D4 (Fri 09-26)"** is really **Sat**; **"D6 (Sun 09-28)"** is really **Mon 09-28**; and
**D30 (Wed 10-22)"** is really **Thu**. Consequences:

- "Sunday standards-watch (R-4)" is scheduled on **Monday 09-28** → collides with W-1 canary.
- "Saturday [D] manual wallet pass (W-2)" lands on **Sunday** → [D] is unavailable on Sundays
  under a 7-day pace, which is exactly the assumption the plan itself calls "burnout" risk.
- **Today, 2026-09-26, is the plan's "D4 (Fri)" but a real Saturday.** Every weekday-anchored
  task is therefore off-cycle for the rest of the plan.

**Recommendation:** re-anchor the cadence to **dates, not weekday names**, or shift every
header by one day. Do not re-derive them by hand — they are mechanical.

### 3.4 Day 0 — **it has NOT happened, and it gates the plan's first security item**

`docs/AC-01-SCRUB-PLAN.md:3-5` states execution is gated on rotation; the 09-25 catalog escalates
it to **"Wave 0 (Day 0–1) — 1.5 d"** and **"立即 Day 0–1"** (`ISSUES-CATALOG-2026-09-25.md:62`,
`:568`). Verified state:

- `.codebuddy/models.json` **still holds 6 plaintext `apiKey` values** (not redacted).
- `.gitleaks.toml` has **no generic `apiKey` rule** — it allowlists only the two public Anvil
  dev keys, so today's scanner would **not** flag these fields by name.
- W1-1.1 / W1-5.3 are `[ ]` and unverifiable from the tree (rotation is an external console action).
- The plan's own prerequisite (AC-01-SCRUB-PLAN:13-15) is explicit: *rotation must precede or
  coincide with the scrub*; rewriting history **cannot un-leak** an already-harvested key.

**Day 0 verdict: NOT DONE.** It is also the **highest-severity open item in the entire plan**
(2 Critical CVSS 7.5 in the 09-25 catalog: SEC-01 ERC-20 drain, SEC-02 plaintext keys), and it is
**externally blocked** on [D]. It is the single item most likely to be quietly dropped.

### 3.5 What the plan gets right about its own risk

Credit where due: the risk register's "7-day pace burnout → carry, don't skip; DoD re-scope on
Sundays" (`PLAN:213`) is the correct policy, and it is **already needed**. The failure is that
no Sunday re-scope has occurred (today is Saturday; the plan's "Sunday" is 09-27 real / 09-28
planned).

---

## 4. Milestone consistency — `docs/STATUS.md` vs `vault/Milestones.md`

**These two documents do not describe the same thing, and the apparent conflict is a naming
collision, not a factual disagreement.**

| | `docs/STATUS.md` | `vault/Milestones.md` |
|---|---|---|
| Actual subject | **Document authority model** (TD-4): L1 code / L2 record / L3 plan / L4 context, and which wins on conflict | **12-week engineering roadmap**: M0–M5, weeks 1–12, exit criteria |
| Mentions milestones? | **No.** Zero mention of M0–M5 or week-based exit criteria. | Yes — the whole file. |
| Layer per its own rule | L3 (listed as itself) | L4 (context; "not normative") |

**Verdict: no contradiction on facts — but a serious discoverability defect.**

1. **`STATUS.md` is misnamed.** Its own line 4 says it is "the **index and conflict-resolution
   rule**". A reader opening `docs/STATUS.md` expecting project status gets a governance
   document. Per `STATUS.md`'s **rule 5** ("This file wins for one thing only: which document
   to read"), a reader following it is **sent to the wrong document** — which is precisely the
   failure mode its own §"When this file must be updated" declares to be a bug in this file.
2. **[RETRACTED — I was wrong, ck-doc caught it.]** I previously wrote that the L3 table "omits
   `docs/ISSUES-CATALOG-2026-09-25.md`". **It does not** — the row exists at **`STATUS.md:47`**,
   immediately above the 09-21 catalog, and the "100 items" citation and the row are *the same
   line*. I read an intermediate state of the file and reported a defect that was not there. The
   L3 table is **complete for every catalog**; only the non-catalog documents below are unlisted.
   09-23 C-Performance catalog as ACTIVE, but **not** `docs/ISSUES-CATALOG-2026-09-25.md` — the
   **100-item, 80–140 person-day** catalog, which `STATUS.md:47` itself calls "the latest
   catalog (100 items, 2026-09-25)". So the file cites the item count while omitting the row.
3. **Unclassified documents.** Per its own exhaustiveness rule (`:110-112`), a document in none
   of the four layer tables "is a bug in this file". At least these are unclassified:
   `ENHANCEMENTS-2026-09-25.md`, `NEW-ADDITIONS-2026-09-25.md`, `ADVANCED-FEATURES-1/2/3-*.md`,
   `VERIFICATION-STRATEGY-2026-09-25.md`, `VERIFICATION-STRATEGY-2-CI-UAT.md`,
   `DOC-AUDIT-CONTRACTS-2026-09-26.md`, `PROJECT-MAP.md`, `FILE-MANIFEST.md`.
4. **It is stale on the vault count in a self-declared way.** It instructs: "if this line and
   the directory ever disagree, the directory wins and this line is wrong." `check-doc-counts`
   currently reports **22 vault notes** and `vault/` **does** contain 22 — so this one is
   *currently correct*, but it is a self-acknowledged tripwire on every note add/remove.

**Adjudication (code-facts win):** where a milestone claim is contested, **`check-doc-counts.mjs`
is authoritative**. At first pass it **agreed with the prose** (158 PR tests, 14 CI jobs, 11 Halmos
specs, 4 Echidna properties, 22 vault notes, MetaMask pin 13.49.0) — and that agreement was
**real**: ck-doc independently re-verified the vault-count logic against
`check-doc-counts.mjs:509-522` and `:591-596` and confirmed it matches `STATUS.md:66,75-76`.
**The gate has since become runnable again and now reports honestly: it exits 1 on 9 real drifts**
(§9.1b — docs say 158 / 14 / 49; the toolchain says 211 / 17 / 54). So the *mechanism* ck-doc
verified is sound — what is red is the data, not the checker. The structural defects below are
unaffected either way.

### 4.1 The real milestone contradiction: `vault/` vs the 30-day plan

`vault/Milestones.md` and `vault/Build Plan.md` are **Aug 2026** artifacts and are **materially
obsolete** as a statement of intent, in ways the 30-day plan silently contradicts:

| vault says | Reality (code) | Which wins |
|---|---|---|
| **M1 (w3): "Multi-RPC shipped + consumed by all TS tests (health scoring demo passes)"** | **No Multi-RPC exists.** 0 matches for `MultiRpc\|healthScore` across `packages/`. Only `core`, `demo-agent`, `indexer`, `mcp` exist. | **`vault/` is wrong** (L4 loses to L1). Note `vault/Risk & De-risk Plan.md:14` itself says **"C3 KILL/DEFER"** and `Build Plan:8` says **"Drop/defer"** — so `vault/Milestones.md`'s M1 **contradicts its own sibling vault docs**. |
| **M2 (w5): "Diamonds/7579 compile + … Slither clean"** | 7579 module **is** shipped (`SessionKey7579Module.sol`, `ActionLog7579Executor.sol`); no Diamond (correctly). Slither: 0 High/Med on src. | Partly met, under a different name. |
| **M3 (w8): "Session-key Halmos gate passes"** | Halmos has **11 specs** and the auth-path harness is now non-vacuous — but **`halmos` is not a PR gate**: `ci.yml:309` restricts it to `main`/`master`/`workflow_dispatch`. `vault/Build Plan:33` calls it **"nightly, release gate"** and `:35` "**required mainnet gates**". | **Live contradiction.** Vault says release gate; CI says mainnet-branch-only. `ci.yml:322` also still says **"6 specs"** while the toolchain reports **11** — a stale CI comment. |
| **Audit booking: "week 1, 2–3mo lead"** (`Milestones:19`, `Build Plan:45`, `Risk:21`) | Plan defers to **D22 (10-14)** — **week 4**. With 2–3 month lead, booking at week 4 makes a pre-30-day audit **arithmetically impossible**. | **Unresolved, high risk.** The plan quietly moved the critical path's #1 item from week 1 to week 4. |
| **Deployment: "Base Sepolia → Base mainnet"** | No mainnet in the 30-day plan at all; `vectors/` empty; no deploy scripts in the plan. | `vault/` describes a horizon the 30-day plan does not attempt. |

**Recommendation:** `vault/Milestones.md` and `vault/Build Plan.md` should each carry a one-line
superseded banner pointing at the 30-day plan, or `STATUS.md` should mark them SUPERSEDED.
Today they are L4 "context" but read as a live roadmap — a reader will reasonably think M1–M5
are upcoming.

---

## 5. Risk register — real status of every risk

### 5.1 `vault/Risk & De-risk Plan.md`

| # | Risk | Plan's implicit state | **Verified reality** | Status |
|---|---|---|---|---|
| R-a | **Diamond reentrancy / storage collision** | *Mitigated by shipping as ERC-7579 instead* | **Confirmed mitigated** — no Diamond; 7579 module + executor ship as separate audited-surface contracts. The stated mitigation is the one implemented. | **CLOSED — genuinely** |
| R-b | **7702 revoke: replay on nonce change** | auth tuple bound to nonce | **App layer: mitigated.** `ActionRequest` carries `nonce` in the EIP-712 typehash (`SessionKeyManager.sol:104`), monotonic via `getNonce` (threat-map row 10, line 361). **Authorization-tuple layer: NOT mitigated** — see §1.4. The SDK can encode any `nonce` (repeat included) and holds no used-nonce state; **and per `client.ts:531` it must not**, so the fix is a stateless freshness check + a written ownership statement, **not** SDK-side bookkeeping. | **PARTIAL — app layer closed, SDK layer open (ownership undefined)** |
| R-c | **7702 revoke: `chainId: 0` replayable** | enforce non-zero | **MITIGATED IN THE SDK, BUT NOT ENFORCED — see F-6 / §1.4.** `assertDelegationScope` (`packages/core/src/eip7702.ts:375-446`) rejects `chainId === 0n` unless `allowAllChains: true` is passed explicitly (`:407-413`), and rejects chain/delegate/revoke-direction mismatches (`:416-443`); pinned both ways by `test/signing-conformance.test.ts:371-402`. **However `signAuthorization` (`:178-206`) signs `authorizationDigest(args)` directly with no scope guard**, so a bare `chainId: 0` call still produces an all-chain credential. | **PARTIAL — guard exists, not on the mandatory path** |
| R-d | **7702 revoke: delegated-code replacement** | forked-mainnet harness set→revoke→re-set | **Not started.** No `SyntheticSeeder.s.sol` (W2-3.3), no fork harness in the 30-day plan. `foundry-fork-base` exists as a CI job. | **OPEN — unplanned** |
| R-e | **RPC flakiness in CI** | pin Foundry SHA; Anvil fork of Base, never live public RPC | **Verified good:** 38 `uses:` pinned to 40-char SHAs; `foundry-fork-base` job exists. **1 gap:** `publish.yml:58 actions/setup-python@v5` unpinned. | **MOSTLY CLOSED** (1 gap) |
| R-f | **Bundler/paymaster edges** | "deferrable, not launch-critical" | Not in the 30-day plan; 7579 `validateUserOp` exists (`SessionKey7579Module.sol:193`) but is unexercised. | **DEFERRED (consistent)** |
| R-g | **C1: 7702 primitives commoditized** | hedge = cross-wallet conformance matrix | Harness + allowlist + canary exist; **matrix is 1 wallet deep** (MetaMask 13.49.0); Coinbase/Biconomy are allowlist-documented-parity, not tested. Safe matrix = W3-1.2 (D15). | **OPEN** |
| R-h | **C2 Diamond** | DEPRIORITIZE/REPLACE with 7579 | Done as decided. | **CLOSED** |
| R-i | **C3 Multi-RPC** | **KILL/DEFER** | **Correctly absent** — but `vault/Milestones.md` M1 still lists it as a w3 milestone. | **CLOSED — vault doc is the bug** |
| R-j | **C4 audit+verification = the moat** | KEEP; be standards-native | **Strong and improving:** 7579 + 7702 + 4337 all present; Halmos non-vacuous; **but the external audit itself is unbooked** (see R-s). | **PARTIAL** |
| R-k | **"Nobody built it" narrative is FALSE** | correct before launch | **Corrected.** `WHITEPAPER-v2.1.md:61` reframes to "permissionless, non-custodial developer tooling; integrators own compliance". | **CLOSED** |
| R-l | **Agent wallets "very early"** | target integrators, not end users | Positioning doc is W3-2.1 (D16) — **not written**. | **OPEN — scheduled** |
| R-m | **Grant dependence** (Code4rena closed, etc.) | use Base Batches 004 / Arbitrum Audit Program | Not addressed in the 30-day plan; `docs/ECOSYSTEM-RESEARCH-2026-09-23.md` is the research base. | **UNADDRESSED** |
| R-n | **Audit cost $40k–$120k, 2–3mo lead, book week 1** | book week 1 | **NOT BOOKED.** Plan schedules firm shortlist at **D22 (10-14)**. | **OPEN — CRITICAL PATH, see §6** |
| R-o | **US GENIUS/CLARITY: "no KYC / globally relevant" is a liability** | reposition as non-custodial dev tooling | **Closed in the whitepaper** (`:61`). | **CLOSED** |
| R-p | **EU MiCA CASP** | clarify SigilKit is not a CASP | Reframed in whitepaper; **no explicit "not a CASP" statement** found. | **PARTIAL** |
| R-q | **India 30% TDS / 1% TCS** | provide tax-reporting data hooks, don't evade | No tax hooks in the 30-day plan. | **OPEN — unplanned** |
| R-r | **12 weeks for all four + audit is not real** | MVP cut: C1+C4+harness+audit, defer C2/C3 | **The 30-day plan is a THIRD scope cut** (audit → D22 only, mainnet deferred). The de-risking logic is being applied consistently. | **CONSISTENT** |
| R-s | **12-week timeline realism** | 6–8 wks MVP | **Now testable against Day-4 data:** see §3.2 — 80–140 person-days vs 30 days. **The original verdict ("not real") has now been re-proven at a smaller scale.** | **TRIGGERED** |

### 5.2 The 30-day plan's own risk register (`PLAN:205-213`)

| Risk | Signal | **Verified status** |
|---|---|---|
| 7702 exploitation reaches module users | new sweeper/phishing writeups | **No new writeups found in-repo.** Row 6's SDK guard **is shipped but not mandatory** (§1.4); row 10's nonce-uniqueness is **still absent entirely**; the sweep-guard test (row 7) is unstarted. All three sit in W3-4.1, **D18 — 14 days out**. **Latent, not materialised — and the residual gap is now precisely characterised.** |
| ERC-7579/7715 churn while Draft | EIP status changes | **Watched 09-23: no deltas.** Correct per `eips.ethereum.org` at that date. **Not re-watched since 09-23 — 3 days stale.** |
| Incumbents GA (MetaMask Agent Wallet) | GA announcements | Allowlist has `metamask:agent-wallet-guard-rails` (documented-parity). **No GA signal recorded.** |
| **node:sqlite experimental breakage** | indexer exit codes | **OCCURRED and FIXED** — AC-33 root-caused to Node 24 Windows teardown (`cli.ts:243-255`), watchdog in place. `outputs/ac33-debug/` exists (2026-09-23). **Closed — the one risk that actually fired and was handled correctly.** |
| **CI secrets misconfig** | workflow logs | **CANNOT HAVE OCCURRED** — CI has never run (AC-28; only `origin/master` exists). The risk is **latent**, and W1-3.3/3.4 are blocked behind an unapproved push. **High priority** — first CI run is where this becomes real. |
| npm scope squat persists | registry checks | Untested; decision task is W3-2.2 (D16). | 
| **7-day pace burnout** | slipped tasks 2 days running | **TRIGGERED.** 6 Week-1 tasks blocked/unstarted, ~180 uncommitted files, 0 commits in 3 days, 5 missing artifacts. The register's own remedy — *re-scope DoD on Sundays* — has not been invoked. |

**Two risks in the plan's own register are now realised or imminent** (CI secrets latent→material
the moment a push is approved; burnout already triggered), and the register's Sunday remedy has
not been used.

---

## 6. Critical-path blockers

Ordered by what actually stops the 30-day plan. "Owner" = who must act.

**B-0 is listed first because it disables the means of verification itself** — while it stands, no
other item on this list can be confirmed closed.

### B-0 · ~~Test suite does not compile~~ — **WITHDRAWN 2026-09-26 (ck-test)**
- **Status: resolved.** `forge test --list` compiles; all three errors I reported are gone and I
  re-verified each: `EchidnaProperties.t.sol:233` now uses `EchidnaHarness(payable(a))`, the `m`
  at `GasUncoveredPaths.t.sol:399` is in scope, and **`SecProbe.t.sol` is deleted**. Full forge run
  per ck-test: **19 suites · 200 tests · 0 failed · 1 skipped** (`ForkSmoke`, by design).
  **No action required.** The gate consequence is now tracked as **F-7 / §9.1b** (real count drift,
  exit 1), and the process lesson is in §9.3.

### B-1 · Key rotation (Day 0 / SEC-02) — **CRITICAL, external, still open**
- **Blocks:** AC-01 scrub execution (W2-1.1 → the whole credential-hygiene story), and the
  plan's *own stated prerequisite* for Day 0.
- **Evidence:** `.codebuddy/models.json` — 6 plaintext `apiKey`, unredacted. `.gitleaks.toml`
  has no generic `apiKey` rule, so the scanner would not flag them by field name.
- **Owner:** [D] (provider consoles). **Effort:** ~1 h external + 1.5 d total per catalog.
- **Why it is second, not last:** it is the only item where *delay actively increases harm* — every
  day the keys are live is a day an attacker can still use them, and `AC-01-SCRUB-PLAN:13-15` is
  explicit that history rewriting cannot un-leak. B-0 needs a keystroke; this needs [D].

### B-2 · ~180 uncommitted files, 0 commits since 09-23 — **CRITICAL, process**
- **Blocks:** W1-7.3 / W2-7.2 / W3-7.3 / W4-7.3 (all four commit-week proposals), AC-13, and
  the Week-1 DoD (W1-6.2) which cannot honestly be self-audited against an uncommitted tree.
- **Evidence:** `git status --porcelain` = **181** at last check (127 at first pass ~1h earlier, 161
  mid-pass — still climbing as teammates land work; it includes 3 backup `.bak-*.json` scratch
  files at repo root). Last commit `ce8eea2`, dated **2026-09-23**.
- **Owner:** [M] to prepare, **[D] to approve** (standing constraint: no commits without explicit approval).
- **Note:** 3 of the 4 P0 security fixes live **only** in this uncommitted tree — as does cr-sec's
  2^53 `isSafeInteger` fix in `packages/core/src/validation.ts` (8 suites / 205 tests passing,
  uncommitted). **Any `git checkout` / `git stash` / branch switch destroys all of it.**

### B-3 · First CI run has never happened (AC-28) — **HIGH, approval-gated**
- **Blocks:** W1-3.3 (triage first CI output), W1-3.4 (map CI gaps), W2-6.2 (green except wallet
  harness), Week-4 DoD, and it is the **precondition for the "CI secrets misconfig" risk** ever
  being observable.
- **Evidence:** `git branch -r` → `origin/master` only; `origin/review-integration-20260917` does
  not exist (`fatal: ambiguous argument 'origin/review-integration-20260917..HEAD'`).
- **Owner:** **[D] push approval.** The gate is correctly respected — but it has now cost 3 days
  and blocks 4 downstream tasks.

### B-4 · The 09-25 catalog (100 items / 80–140 person-days) is unabsorbed — **CRITICAL, scope**
- **Blocks:** everything. See §3.2 — its own wave table spends ~20 of 30 days on catalog work.
- **Evidence:** `ISSUES-CATALOG-2026-09-25.md:19`, wave table `:566-571`.
- **Owner:** [B] — requires an explicit **scope decision**, not more effort.

### B-5 · Audit booking slipped from week 1 to week 4 — **HIGH, external lead time**
- **Blocks:** `vault/Milestones.md:19` ("week 1, 2–3mo lead"), `Build Plan:45`, `Risk:21`
  ("book week 1") vs the 30-day plan's **D22 (10-14)** shortlist.
- **Consequence:** with a 2–3 month lead time, shortlisting on 10-14 makes any audit *inside or
  near* the 30-day window **arithmetically impossible**. The plan quietly relocated the
  critical path's #1 item.
- **Owner:** [D]. **Cheap to fix now, expensive later** — booking is a lead-time item.

### B-6 · Week-1 DoD self-audit never happened (W1-6.2) — **MEDIUM**
- The plan's own Week-1 DoD (`:35`) requires "credentials rotated · AC-32/33 fixed · 7702 threat
  map · AC-09 closeout · **git remote + first CI run triaged** · SECURITY.md".
- **4 of 6 met**; "credentials rotated" fails (B-1); "first CI run triaged" fails (B-3).
- **Owner:** [B]. This document is the first honest DoD audit; it should be ratified, not replaced.

---

## 7. Recommendations (ordered; ~1 day of work, no code changes)

1. **Today — commit, in this order.** (a) **security fixes as their own commit** (the 3 P0 fixes;
   cr-sec's 2^53 `isSafeInteger` fix in `validation.ts`); (b) **the untracked test files as their
   own commit, with owner attribution in each header** — `DenylistCoverage.t.sol`,
   `E11WatchlistRead.t.sol`, `Gas7579Scaling.t.sol`, `GasUncoveredPaths.t.sol`,
   `Sec10WindowRotation.t.sol`, D-13 in `GraduatedAuthority.t.sol` (§9.4b); (c) the remainder
   (AC-32/33, threat map, preflight, gitleaks/actionlint pins). Delete the `.bak-*.json` scratch
   files first. This needs only [D] approval.
   **Why (b) is separate and not cosmetic:** the recurring cost on this tree is not merge conflicts
   but repeated *attribution* round-trips — five or more this session — and that cost exists because
   ownership metadata is **not in version control**. Committing it makes the answer to "who owns
   this?" a `git log` lookup instead of a message round-trip.
2. **Today — re-run and persist the 5 missing evidence artifacts** into a non-`outputs/` path
   (or accept that `outputs/` is gitignored and re-point the plan's Proof links at CI run URLs).
   Reconcile the stale counts: plan's **119 → current** (a moving target — see §9),
   `ci.yml:322`'s **"6 specs" → 11**, and the **live doc-count drifts** in §9
   (README / whitepaper / TROUBLESHOOTING).
3. **Today — fix the weekday headers** (mechanical +1 shift) or re-anchor W-1/W-2/W-3/R-4 to dates.
4. **Re-baseline scope (the real decision).** Either (a) formally adopt the 09-25 catalog and
   cut Week-3/4 positioning/ecosystem work to a named backlog, or (b) formally defer the catalog
   and say so in `STATUS.md`. **Doing neither is the current failure mode.**
5. **Name a status document.** `docs/STATUS.md` is an authority model, not a status. Either rename
   it (e.g. `docs/DOC-AUTHORITY.md`) and add a real `STATUS.md`, or add a pointer line at the top.
   While there: add the missing `ISSUES-CATALOG-2026-09-25.md` L3 row and classify the 8
   unclassified documents (§4, item 3).
6. **B-1 today: rotate the keys.** It is ~1 h of [D] time and it is the only item where waiting
   increases harm.
7. **Ratify the Sunday DoD re-scope** (the plan's own burnout remedy) at the next real Sunday
   (2026-09-27), and re-anchor audit booking off the critical path now rather than at D22.

---

## 8. Verification method (so this audit is reproducible)

Read-only. No file outside this one was created or modified.

| Claim class | How verified |
|---|---|
| Code exists | `search_content` / `read_file` on exact paths, cited as `file:line` |
| File absent | `Test-Path` / `search_file` recursive; `outputs/` searched **recursively** for all 10 claimed artifacts |
| Test/CI/spec counts | `node scripts/check-doc-counts.mjs` with `FORGE_BIN` set — **runs to completion, exits 1 on 9 real drifts (§9.1b)**. Counts in this file are from the **first pass** and are labelled as such; the totals moved 158 → 200 → 203 → 211 within the day. Halmos = 11 is the one count never dependent on the gate — re-confirmed by grepping `function check_` (6 + 5). |
| Gate count | `node scripts/verify.mjs --list` → 9 steps |
| Git state | `git status --porcelain`, `git log --format=%ad --date=short`, `git branch -r`, `git remote -v` |
| Weekday labels | `node` recomputation of 2026-09-23 → 2026-10-22 against `Date.getUTCDay()` |
| Vacuity of properties | Direct read of `HalmosAuth.t.sol`, `EchidnaProperties.t.sol`, `SessionKeyManager.invariant.t.sol` |
| 7702 guard status (§1.4) | Direct read of `packages/core/src/eip7702.ts:178-206` (`signAuthorization`) and `:375-446` (`assertDelegationScope`); tests at `test/signing-conformance.test.ts:371-402`; caller sweep across `packages/*/src` |

**Correction log (2026-09-26, second pass).** §1.4 and findings R-b/R-c were **corrected after
cr-sec's report**. I re-verified every claim against the source before editing rather than
accepting the report, and **confirmed cr-sec's central claim while finding one over-reach**:

- **Accepted (my error):** I had written that the `chainId: 0` guard was "STILL OPEN — no SDK-side
  non-zero assertion exists yet". `assertDelegationScope` exists, is fail-closed, and is tested in
  both directions. My original §5.1 R-c row was **wrong** and is now fixed.
- **Not accepted (their over-reach):** cr-sec's message implies threat-map **row 10** (nonce
  reuse) is delivered alongside row 6. **It is not.** `authorizationDigest` /
  `signAuthorization` / `toAuthorizationTuple` accept any `nonce` and the SDK keeps **no
  used-nonce state**; `toUnsignedBigInt` enforces *safe representation*, which is a different
  property from *uniqueness across calls*. Row 10 stays **OPEN**, and §1.4 records that the threat
  map asserts a closure that does not exist.
- **Also corrected arithmetically:** the uncommitted-file count moved 127 → 161 → **181** between
  passes (teammates are landing work into the same uncommitted tree), which strengthens B-2 rather
  than weakening it. §9 records the same churn.

**Correction log (pass 3, same day) — two retractions, both after ck-doc's challenge.** ck-doc
asked me to re-read `STATUS.md:42-54` before acting. I did, and found I was wrong twice:

1. **RETRACTED — `STATUS.md:47` does contain the `ISSUES-CATALOG-2026-09-25.md` row.** I reported
   it missing. The citation and the row are the same line; I had read an intermediate state. This
   was a fabricated defect, and ck-doc's instruction to re-read before acting is the correct
   process I skipped.
2. **RETRACTED — the "9 doc-count drifts" and every count I reported after the first pass
   (199 → 198 tests, 17 → 16 suites, 54 annotations).**    `check-doc-counts.mjs` was not reporting
   drift; it was **dying at `forge test --list` with exit 2** because ck-test's in-flight test
   files do not compile (§9.1). I read stderr from a dead command as measurements, then "corrected"
   them twice. **The uncommitted-file count (127 → 181) is real** — that comes from `git status`,
   which is unaffected.

> **Unverified as of 2026-10-01:** 上行括号里的 "199 → 198 tests, 17 → 16 suites, 54 annotations" 是**被撤回的读数**
> （pass-3 自述来自一个 `forge test --list` exit 2 的死命令的 stderr），不是当前值，也**未被本轮复测**。同一份文件 §9.1b
> （即“runs to completion and exits 1”的输出块）另给出一组“已完整跑通并退出 1”的读数（211 / 17 / 54）。两组数字均未在本轮判定对错；在重跑
> `check-doc-counts.mjs` 前，**“54 annotations” 这一项尤其不要单独引用**——它同时出现在一个已撤回的读数和一个存活的读数里。

**Correction log (pass 5, same day) — one error in my own pass-4 rewrite, caught by cr-sec.** In
rewriting W3-4.1 item 2 I wrote that the freshness check "could align with `client.ts:193-197`,
where an omitted `nonce` triggers an on-chain `getNonce` fetch." **That does not hold on the 7702
path**, and an implementer following it would have produced a broken change. Full detail in the
pass-5 correction block in §1.4; the short form:

- The two `nonce`s are **different nonce spaces** (application-layer per-session-key vs EIP-7702
  per-EOA-account), so there is nothing to "align" with.
- `signAuthorization` is **synchronous and has no `PublicClient`** (`eip7702.ts:178-206`), so a
  chain read is not available without an API-shape change — the very thing being avoided.

**Pattern worth recording:** twice now, a correct-sounding fix I proposed was wrong because I
anchored it to a *similar-looking* piece of code instead of checking whether it was the *same*
thing (`STATUS.md:47`; then `client.ts:193-197` vs the 7702 path). Similar is not the same
domain — verify the mechanism, not the shape.

**Limitations, stated honestly:** (a) `outputs/` is gitignored, so absent logs are *weak* evidence
of absent runs — the underlying claims are corroborated by the catalogs, so I scored them
PARTIAL, not false; (b) key rotation (W1-1.1/W1-5.3) and the [D] manual passes are **external
actions with no in-tree evidence** and can only be reported as unverifiable-from-here; (c) EIP
status (7579/7702/7715) was not re-checked against eips.ethereum.org — I report the 09-23 watch
as-is; (d) I did not run `npm run verify` or the full forge suite. `check-doc-counts.mjs` **does**
run to completion now and exits 1 on 9 real drifts (§9.1b), so the tie-breaker is available but
**not green**; "9/9 green" rests on the gate's self-description plus ck-test's full forge run
(19 suites / 200 tests / 0 failed / 1 skipped), not on my own independent full-gate proof. **Counts
in §1.1/§2/§4/§5 are "as of the first pass" and should be re-validated after the tree is committed
(B-2) — they moved 158 → 200 → 203 → 211 within this single day.**

---

## 9. Live tree state — the count gate is RED on real drift (B-0 resolved)

> **Pass-3 correction.** This section previously claimed the gate was "FAILING with 9 doc-count
> drifts" (README ×5, whitepaper ×3, TROUBLESHOOTING ×1) and that I had read
> "199 → 198" tests. **All of that was wrong, and I retract it.** ck-doc challenged the
> `STATUS.md:47` claim; in re-verifying I found the real problem was that
> **the gate never reaches its comparison stage at all.** The numbers I reported were
> artefacts of a broken run, not observations.

### 9.1 [RESOLVED — ck-test, 2026-09-26] The compile break is fixed; B-0 is withdrawn

> **B-0 is withdrawn.** ck-test re-ran it and the suite compiles. My §9.1 observation was a
> **stale snapshot of a moving tree**, not a standing defect. All three errors I reported are gone:
> `EchidnaProperties.t.sol:233` is now `EchidnaHarness(payable(a)).grantSessionKey(...)`;
> the `m` in `GasUncoveredPaths.t.sol:399` is in scope (`:396`); and **`SecProbe.t.sol` is
> deleted** (`Test-Path` → `False`). I verified all three myself.
>
> **What survives is the *pattern*, not the incident** — and it is now the most useful thing in
> this section. Three of my "findings" in this file were snapshots of a tree that 8 agents were
> actively writing to. The lesson is recorded in §9.3: **on a tree under concurrent write, a
> finding without a re-check immediately before reporting is a liability, not an asset.**

<details>
<summary>Original §9.1 text — the compile break as observed (superseded, kept for the record)</summary>

The test suite did not compile, and `check-doc-counts.mjs:713-723` gates on `forge test --list`,
calling `process.exit(2)` when it fails. Observed sequence, moving as teammates edited:

| Time | `forge test --list` result |
|---|---|
| earlier | `Error (7398)`: explicit conversion `address` → `EchidnaHarness` (payable fallback) — `EchidnaProperties.t.sol:232` / `:219` |
| then | `Error (7576)`: undeclared identifier `m` — `GasUncoveredPaths.t.sol:399` |
| now | `Error (7920)`: identifier not found or not unique — **`SecProbe.t.sol:40`** |

`forge build` succeeded throughout (32 files, Solc 0.8.36) — **so this was a test-only break, and
it was invisible to `npm run build`.** Ten test files were dirty, five brand new and untracked:
`SecProbe.t.sol`, `GasUncoveredPaths.t.sol`, `Gas7579Scaling.t.sol`, `E11WatchlistRead.t.sol`,
`DenylistCoverage.t.sol`, plus modifications to `EchidnaProperties.t.sol`, `HalmosAuth.t.sol`,
`ERC1271Keys.t.sol`, `GasBudget.t.sol`, `SessionKey7579Module.t.sol`,
`SessionKeyManager.invariant.t.sol`.

`SecProbe.t.sol:4` was self-labelled **"TEMPORARY F3 non-tautology probe. Deleted after use."** —
a scratch file left in the tree, and at that moment the one breaking the build.

</details>

### 9.1b The gate is no longer blocked — it is now RED for a different, real reason

`check-doc-counts.mjs` now **runs to completion and exits 1** (not 2). Verified by me directly:

```
forge (PR scope): 211 tests across 17 suites
forge (excluded: invariant + fork): 5 tests across 2 suites
Halmos specs: 11 (Halmos.t.sol 6, HalmosAuth.t.sol 5)
Echidna properties: 4 · Invariant suite: 4 invariants across 1 suite · Vault notes: 22
forge-lint annotations: 54 · MetaMask pin: 13.49.0 · security.txt OK

doc count drift (9):
  whitepaper says 158 → actual 211   (×2 occurrences)
  whitepaper suites says 14 → 17
  README says 158 → 211              (×4: suite total, npm-test, breakdown sum, breakdown list)
  README suites says 14 → 17
  TROUBLESHOOTING says 49 forge-lint annotations → 54
```

> **Unverified as of 2026-10-01 — 上块中的每一个数字（211 tests / 17 suites、5 tests / 2 suites、54 annotations，以及 9 条
> drift）均未在本轮重测，保持原文未改。** 本轮无法执行 `forge test --list` 或 `check-doc-counts.mjs`
> （`scripts/` 不在本文件集内，且本轮不运行 forge）。三点必须与数字一起被引用：
>
> 1. 本文件自己在紧随本注释的“Read the totals as a smear”一段记录这些数字“在同一天内 158 → 200 → 203 → 211”，因此 **211 不是稳定值**。
> 2. §9.1b 下方的“the toolchain says 203”一句，与本块的 211 冲突。**两者均未在本轮被判定为错**，本轮不改任何一个。
> 3. “54 annotations” 与 `docs/NUMBERS-2026-09-26.md` §1 基线表与 §7（49）、`docs/VERIFICATION-STRATEGY-2026-09-25.md` §1.2 L0 行（33）互相矛盾；
>    `docs/STALENESS-2026-09-26.md` §1.1 分类表则判定 TROUBLESHOOTING 的 49 “matches the guard exactly”。在重跑 `node scripts/check-doc-counts.mjs`
>    并记录日期前，四处都不应被引用。
>
> 另注：:585 的“54 annotations” 属于 pass-3 已撤回的读数（§9 开头的“Pass-3 correction”引述块明确说那些数字来自一个 exit 2 的死命令），与本块的
> 54 未必同源；本轮未核实。

**Read the totals as a smear, not a snapshot.** Across this single day the same command reported
158 → 200 → 203 → **211** tests and 14 → 16 → **17** suites. That is not a measurement error; it is
the tree changing under a measuring instrument (see §9.6).

**This is the same class of problem I retracted in pass 3, but this time it is a real, live
measurement rather than stderr from a dead command** — so unlike my retracted claim, it is
reportable. Two honest observations:

- **The drift is genuine, not my error.** The docs say 158; the toolchain says 203. The repo's own
  designated tie-breaker says so.
- **The numbers are still moving** (158 → 200 → 203 across three readings in ~30 minutes), which
  is why ck-test correctly declined to write them: a value committed now is wrong within the hour.
  `docs/` counts are **not** in ck-test's scope, and he was right not to let a test change decide
  documentation policy. **Owner: ck-doc / dc-law** (dc-law already holds the `STATUS.md` L3
  merge). Do it in **one** commit, and **after** the tree is committed (B-2) — otherwise it goes
  stale immediately.

### 9.2 Why the pattern matters more than the incident

- **The tie-breaker is unavailable.** `STATUS.md:90-92` names `check-doc-counts.mjs` as the
  authority over every number in every document. While `forge test --list` fails, **that authority
  cannot be exercised** — so *no* count claim in *any* document can currently be validated, and my
  own §1.1/§4 numbers are unverifiable in the strict sense.
- **This is worse than the doc-count drift I originally reported.** Doc drift is cosmetic (prose
  vs numbers). A non-compiling test suite means `forge test` cannot run at all, so the forge half
  of `npm test` — and therefore gate 1 of the 9 — is dark.
- **It is the purest possible demonstration of B-2.** Five brand-new untracked test files, none
  committed, one of them scratch, and the shared gate is down. Nobody broke the gate on purpose;
  the uncommitted tree did.
- **R-1 is violated** — the plan's own first rule is "all 9 gates green before new work; red = stop
  and fix first". The next teammate to run `npm run verify` will hit a red gate inherited from
  work in flight, not from their own change.
- **Important qualifier, courtesy of cr-sec: this is "in progress", not "damaged".** A second
  example: `packages/core/test/domain-constants.test.ts` (untracked, 166 lines) was a
  *syntax-level* break — it referenced undefined `wordLeft`/`wordRight`, so vitest counted it as a
  **collection error**, not a test failure. Same class, different gate. The correct reading is
  **"red lights from concurrent work", not "the tree is broken"** — which is precisely why the
  remedy is *commit what is finished*, not *stop and repair*. Red lights converge on their own as
  teammates finish; **uncommitted finished work does not survive a `checkout`.**

### 9.3 What I got wrong, and the generalisable lesson

ck-doc asked me to re-read `STATUS.md:42-54` before acting, because the row I claimed was missing
**was there** at `:47` — the citation and the row are the same line. I had read an intermediate
state and reported a defect that did not exist. **Conceded in full** (§4 item 2, rewritten).

**The lesson is about my own method, and it is the most transferable thing in this file:** when a
gate that is *supposed* to produce numbers instead fails, the tempting inference is "the numbers
must have drifted". I took that inference, then spent two more passes refining figures
(158 → 199 → 198) that were never measurements — they were stderr lines from a command that had
already died. **Fabricating a number and then correcting it twice is worse than reporting the
blocker once.** A non-zero exit from a counting tool is a *result*, not a gap in the data.

**Method correction I applied to my own earlier sections:** every count in §1.1, §2, §4 and §5 is
now explicitly scoped as "as of the first pass, while the gate still ran" and is corroborated by
an independent method where one exists (e.g. Halmos = **11** specs, confirmed by grepping
`function check_` → 6 in `Halmos.t.sol` + 5 in `HalmosAuth.t.sol`; that count never depended on
the failing gate).

### 9.4 Recommended owner split

| Item | Owner | Note |
|---|---|---|
| ~~Delete/finish `SecProbe.t.sol` and restore `forge test --list`~~ | ~~ck-test~~ | **DONE — verified.** `SecProbe.t.sol` deleted; `forge test --list` compiles; 19 suites / 200 tests / 0 failed / 1 skipped |
| `EchidnaProperties.t.sol` payable-cast fix | ck-test | **DONE — verified** at `:233` (`EchidnaHarness(payable(a))`) |
| **9 doc-count drifts** (whitepaper ×3, README ×4, TROUBLESHOOTING ×1 — 158→211, 14→17, 49→54) | **ck-doc / dc-law** | **Now the live blocker for a green gate** (§9.1b). `check-doc-counts --write` covers README/STATUS/TROUBLESHOOTING; whitepaper's 3 by hand. **One commit, after B-2.** ck-test correctly declined — `docs/` is not his scope |
| `FILE-MANIFEST.md` partition counts | **do NOT write a gate for it — see §9.5** | ck-doc + sc-chain independently concluded "don't recompute"; I found a stronger reason plus a spec defect |
| L3 table completion in `STATUS.md` | **one owner, designated by team-lead** | `STATUS.md:96-98` demands same-change edits; two authors will collide |
| `.github/workflows/publish.yml:58` SHA pin | **ck-ops** | last unpinned `uses:`; SEC-07 |
| P0 #4 invariant ghost (dead `expectedWindowSpend`) | ck-test | `SessionKeyManager.invariant.t.sol:40,259` |
| 2^53 `Number.isInteger` → `isSafeInteger` in `packages/core/src/validation.ts` | **already landed, still uncommitted** | Verified at `validation.ts:159,193,217` (`toUnsignedBigInt` / `assertUint`); 8 suites / 205 tests passing per cr-sec. **Commit it before anything can `checkout`** |
| `packages/core/test/domain-constants.test.ts` (untracked, 166 lines, references `wordLeft`/`wordRight`) | ck-test | Was a **syntax-level** break (vitest collection error) — "in progress", not "damaged"; a *symptom* of the same uncommitted-tree pattern |
| **P0 #4 residual** — `ghostMaxPerWindowCap` raised at *grant* time | **ck-test** | **Scope correction:** F2/F5 were already landed by sc-test (`ghostTotalSpent` + `invariant_valueIsConserved` at `:398-404`). Only this **one** site remains; ck-test fixed it and proved non-tautology by mutation (`&& false` → `[FAIL: INV-1 violated]` with a counterexample, restored → 4/4 PASS) |
| **New test files must declare ownership when they appear** | ~~team-lead~~ → **DELIVERED by dc-plan** | Written into `CONTRIBUTING.md` § Tests (new subsection "Declaring ownership of a new test file") and `contracts/test/README.md` (new file). Form: **file-header comment**, no `OWNERS.json` per team-lead — the repo already has three hand-maintained registries (`abi-targets.txt`, `foundry-scope.json`, `CI-WAIVERS.md`) and a fourth would drift the same way. Evidence base: `GasUncoveredPaths.t.sol` (ck-perf), `E11WatchlistRead.t.sol` (ck-err), `SecProbe.t.sol` (unknown), `GraduatedAuthority.t.sol` D-13 — **2–3 message rounds each** to attribute |
| **Never inherit someone else's half-written test file** | **team-lead** | ck-test's rule, which I endorse and is now the more important half of the row above: **while a test file is mid-author, expect compilation to fail, confirm the owner, and do not "fix" it by supplying the missing definition.** Two distinct failure modes: (i) `forge build` passing does **not** imply `forge test --list` passes — that gap is exactly how B-0 happened; (ii) completing someone else's stub risks conflicting with their design or freezing their intermediate state as the implementation. Attribution is a 1-round question; a merge conflict is not |

### 9.4b The rule, tested on me within minutes — and a correction to my own entry

I wrote the "do not inherit a half-written test file" rule into `CONTRIBUTING.md` (§ Tests) and
`contracts/test/README.md` **in the same pass** — and it caught something minutes later:

```
forge test --list → Error (9182): Function, variable, struct or modifier declaration expected.
  --> contracts/test/SessionKeyManager.t.sol:285:5
```

A `contract Rejector { … }` declared **inside** another contract, which Solidity does not allow.
The file was ` M` and in flight. **I did not touch it** — the rule says confirm the owner, do not
"fix" it, and guessing a line's intent is how you freeze someone's intermediate state.

**Correction, same day, minutes later.** I re-checked, and **that line is now an ordinary
statement** — `SessionKeyManager.t.sol:285` reads
`emit SessionKeyManager.TreasuryWithdrawal(recipient, 1.5 ether);` — and **`forge test --list`
exits 0** (verified 2026-09-26 17:15:46). So the break recorded above was *itself* a snapshot; the
author had already moved on. I am leaving the entry rather than deleting it, because **a recorded
break evaporating within minutes is itself the finding**, and deleting it would destroy the
evidence.

#### The rule this forces, and the reporting format it implies

ck-test's contribution, adopted here as normative: **"no blockers" is itself a claim about a
concurrent tree, and the receiver must re-verify it.** He nearly took my "no blockers, nobody needs
to act" at face value — and it was already false on arrival, because two *new* breaks had appeared
since the last list he and I had reconciled. **Three builds in one session returned red → red →
green, each differently.**

> **Therefore, on this tree, a status claim must carry the command, its exit code, and the time it
> was run. "No blockers" without a timestamp is not a finding — it is a snapshot that will be stale
> before it is read, and it is worse than silence because it invites the receiver to stop checking.**

This binds my own reports too. Every "no blockers" I have sent in this audit was, at the moment of
sending, a claim about a tree that was still moving.

#### Current state, with the timestamp this rule requires

```
2026-09-26 17:15:46
  forge test --list        → exit 0        (compiles; no blockers)
  forge build              → exit 1        (lint only: 2 × unsafe-typecast in SessionKeyManager.t.sol)
  check-doc-counts.mjs     → exit 1        (9 real doc-count drifts, §9.1b)
  git status --porcelain   → 195 entries; last commit still ce8eea2 (2026-09-23)
```

**Note the distinction that matters:** `forge build`'s failure here is **lint, not compilation** —
`foundry.toml:14` makes a lint finding a build failure (CQ-1), and the two findings are
`unsafe-typecast` in a test file. **Compilation is fine.** Anyone reporting "build is red" should say
*which* red, because "red build" sent me looking for a compile error that did not exist.

**team-lead's framing of the A-zone mechanism, confirmed and sharpened.** He observed that zone A is
*worded* as "根配置 / CI / 安全 / 元文件" — which reads as if it includes `.github/` — yet **no
path prefix enumerates it**. That is exactly the defect: the zone is defined by prose, not by a
prefix, so it cannot be mechanically verified. Any zone whose scope is prose rather than a path
expression is unauditable; that is the general form of the problem, and it is worth writing into
the spec ("every zone's scope must be a path expression").

**My remaining offer, unchanged:** review the rewritten spec; supply a `git ls-files` recount on
request as a labelled one-time snapshot; review (not author) a gate that folds into
`check-doc-counts`. **Execution of the manifest rewrite is dc-law's**, per team-lead.

#### Two independent kinds of evidence — and a P-1 that follows from the distinction

> **P-1 status: OPEN.** I closed it prematurely one pass ago; team-lead caught it and I re-derived
> the arithmetic myself to confirm. **SEC-08b is not closed.** Details below.

ck-test's framing, which I adopt and which sharpens §9.6: **"it is green" and "it can fail" are
different claims, and only one of them is evidence.**

| Method | What it actually proves | Does not prove |
|---|---|---|
| **grep / count the properties** | coverage — how many assertions exist | that any of them can fail |
| **run the suite, see green** | that nothing is red *right now* | that the assertions have teeth |
| **mutation — break it (`&& false`), confirm RED with a counterexample, restore, confirm green** | **discriminating power** — the assertion can actually fail | — |

The 09-25 catalog's vacuity findings (P0 #1 Halmos arity, P0 #2 Echidna, F1/F2/F3) were **all green
before they were fixed** — which is exactly why "green" had to be rejected as evidence. **All three
methods are needed: count → coverage, mutate → teeth, run → not-currently-broken.** Mutation costs
one build+test and is the only one of the three that catches a tautology.

**P-1 — REOPENED. My closure was wrong, and it was wrong in a way worth more than the finding.**

I closed P-1 one pass ago, reporting sc-test's two-step construction as the closing evidence. **It is
not.** team-lead caught it; I re-derived the arithmetic myself before accepting, and **he is right:**

```
perActionCap = 1 ether   (HalmosAuth.t.sol:50)
perWindowCap = 2 ether   (:51)
action 1 = 1 ether       (:207)
action 2 = bound(value, 0, 3 ether)   (:208)

window check fires  ⇔  1 + value > 2  ⇔  value > 1 ether
per-action check fires first ⇔  value > 1 ether        (SpendPolicy.sol:63, checked before :80)
⇒ the two regions are disjoint. The window check is UNREACHABLE.
```

`SpendPolicy.sol` orders the checks **per-action first (`:63`), window second (`:80`)** — so for
every symbolic `value` above 1 ether the per-action check reverts first, `spentThisWindow` stays at
1 ether, and `assertTrue(spentThisWindow <= 2 ether)` holds trivially. **The assertion cannot fail.**

**The cruel detail, and the reason this is worth recording:** the spec's own comment at `:204`
states the fact — *"anything above is rejected by the per-action check, which is a **different
property**"* — **and does not notice that this makes the window check unreachable.** The evidence
was in the file; the conclusion was not read out of it. **A comment that documents a limit is not a
comment that establishes the limit holds.**

#### The actual error class — this one is *not* a snapshot

My first four errors were **staleness**: the tree moved, the report did not. **This one is
different in kind, and more dangerous for exactly that reason:**

> **「拒绝来自正确的检查」≠「该拒绝会发生」。**
> *Tracing a revert to the right check* (data provenance) **is not** *proving the branch is
> reachable* (control reachability).

I verified `SpendPolicy.sol:24` declares the error, `SpendPolicy.sol:80` raises it, and
`SessionKeyManager.sol:658` whitelists its selector — **all correct, and all irrelevant to whether
the spec can fail.** I substituted *provenance* for *reachability* and stopped one step early. The
tracing skill is real and team-lead asked me to keep it; the failure was in mistaking it for
sufficiency.

**Why this class is worse than staleness:** "I verified it" manufactures confidence. A stale
snapshot is self-evidently suspect; a well-traced, freshly-read, arithmetically-unexamined claim
looks authoritative. **Being right about provenance made me stop checking reachability** — the
verification effort itself became the reason to stop.

**The habit that would have caught it** — cheap, and I should have run it unprompted: after
confirming a spec's *construction*, **restate the spec's own numbers as arithmetic and check the
intervals overlap.** Not "is the refusal wired up correctly" but "**can the model reach the
branch at all**". One subtraction. It took a teammate to do the subtraction I skipped.

#### Correct shapes for this spec (ck-test's, two rounds ago)

The two-action shape is **mathematically impossible**, so it is not a matter of tuning:

1. **Constrain the symbolic domain** — `vm.assume(w.spentThisWindow + value > perWindowCap)`,
   which is the technique `Halmos.t.sol:85-108` already uses correctly (`:93` `value <= perActionCap`,
   `:97` the violating regime). The existing `Halmos.t.sol` over-cap spec is therefore **not**
   vacuous — it is the *authenticated* one; `HalmosAuth.t.sol` is the EIP-712-flavoured one and
   lacks the constraint.
2. **Three actions** — 1 + 1 + 1, where the third reverts on the window check with
   `spentThisWindow` parked at 2 ether. (The selector team-lead quoted, `0x9cbe80f7`, is **not
   present anywhere** in `contracts/` at my check — `17:27:13` — so that shape is a proposal, not
   a delivered one.)

**SEC-08b therefore remains open**, and F1 is **not** closed under the mutation standard. Owner:
sc-test, with ck-test's shape. **Action: add the `vm.assume` constraint (or the three-action
shape), then prove it by mutation — break `SpendPolicy.enforce`'s window branch and show the spec
goes red.**

#### B-2, sharpened: the value of committing is **metadata**, not tidiness

ck-test's ordering recommendation, which I adopt and add to §7: **commit the untracked test files as
their own commit, with owner attribution in the file header** —
`DenylistCoverage.t.sol`, `E11WatchlistRead.t.sol`, `Gas7579Scaling.t.sol`,
`GasUncoveredPaths.t.sol`, `Sec10WindowRotation.t.sol`, plus D-13 in `GraduatedAuthority.t.sol`.

team-lead sharpened the reason past "tidy", and this is the correct framing:

> **The main value of committing is not tidiness — it turns metadata from "something a human has to
> ask" into "one `git log`".**

This session logged at least **five** attribution round-trips (`SecProbe`, `GasUncoveredPaths`,
`E11WatchlistRead`, `MockSafeOwner`, the `SessionKeyManager.t.sol` lint) — **all one root cause:
the metadata is not in version control.** And critically, **only segment (b) fixes it**; the
security-fix segment does not, and neither does tidying in general. This is the argument that makes
(b) worth doing on its own merits rather than as filler.

#### A related, cheap class of invisibility: deliverables in the wrong directory

team-lead confirmed a real defect I had not reported: **`packages/core/ARCH-2026-09-26.md` and
`DOC-AUDIT-CONTRACTS-2026-09-26.md` are filed under `packages/core/` instead of `docs/`.** Already
sent to ck-doc / cr-arch to relocate.

Worth generalising, because the rule is simple and the failure is total: **a deliverable in a package
directory is doubly invisible** — it is not in the `docs/` index, **and** it ships inside the npm
tarball, where a reader installs it as source noise. Both failures are silent; neither shows up as an
error. The test is simple: *would a reader looking for this document find it in `docs/`?*

### 9.5 `FILE-MANIFEST.md` — do **not** gate it; the spec is defective first

Asked to decide whether a `check-manifest-counts.mjs` should be written. **My answer: no** — and
the reason is stronger than "the number goes stale".

**(a) It measures the work tree, not the repository.** `FILE-MANIFEST.md:3` defines its own scope:
> 范围：git 跟踪文件 + **未跟踪未忽略文件**，共 **204 文件**（生成时间 2026-09-25）

Untracked-not-ignored files are, by definition, **what teammates are currently writing**. Measured
now: `docs/` 25, `scripts/` 20, `packages/core/test/` 12, `contracts/test/` 4. That is not a
property of the repo — it is a `git status` snapshot. **A gate must not assert a moving target**,
and the target here moves *because the team is working*, which is the opposite of a defect.

**(b) The 8 zones are not a partition of the tree** — a spec defect, independent of staleness.
Recomputed with `git ls-files` (206 tracked):

| Zone | Manifest | `git ls-files` | Δ |
|---|---|---|---|
| A root/CI/security | 25 | 23 | −2 |
| B `contracts/src`+`script` | 9 | 9 | 0 |
| C `contracts/test` | 18 | 17 | −1 |
| D `core/src` | 11 + 4 abi | 12 | ≈ |
| E `core/test` | 28 | 30 | +2 |
| F `indexer`+`mcp`+`demo-agent` | 24 | 32 | **+8** |
| G `scripts/` | 20 | 19 | −1 |
| H `docs`+`vault`+`vectors`+whitepaper | 62 | **37** | **−25** |

**H is off by 25 because the 8 zone path-prefixes cannot reach root-level files or `.github/`.**
I enumerated them: **37 tracked files fall outside all 8 zones** — `README.md`, `SECURITY.md`,
`CHANGELOG.md`, `package.json`, `foundry.toml`, `Dockerfile`, `LICENSE`, `.gitleaks.toml`,
`echidna.yaml`, `remappings.txt`, `docker-compose.yml`, `.env.example`, `.nvmrc`, `.gitignore`,
`.gitattributes`, `.dockerignore`, `.editorconfig`, `.gitmodules`, `.gas-snapshot`, the two
workflows, three ISSUE_TEMPLATEs, PULL_REQUEST_TEMPLATE, `dependabot.yml`,
`.well-known/security.txt`, `.workbuddy-ai/memory/…`, `lib/forge-std`, `SigilKit_Whitepaper.txt`…

**So a script written today would fail immediately** — not because the numbers drifted, but because
**the zones do not cover the repository.** A gate written on that spec would be red on day one and
would train everyone to ignore it.

**Recommended instead — a one-time spec fix, no new script:**
1. Assign root-level + `.github/` files explicitly (extend A, or add a zone I) so the zones
   **partition** the tree.
2. State the counting basis explicitly. **Recommend `git ls-files` (tracked only)** — that is a
   stable repo property and is the only basis that could ever be gated. The current
   tracked + untracked basis must stay a manual snapshot.
3. Then, optionally, let `check-doc-counts` adopt the manifest the way it already adopts the
   README/whitepaper counts — one gate, one tie-breaker (`STATUS.md:90-92`).

**Open question for the owner** (ck-doc / sc-chain, team-lead to confirm): **was your candidate
count list computed on the tracked or the tracked+untracked basis?** On the current tree those two
differ by 40+ files, and it decides the spec before anyone writes code.

**My answer to team-lead's question ("who writes `check-manifest-counts.mjs`?"): nobody — do not
write it.** team-lead offered me execution or review; **I am declining execution and offering
review instead**, for the two structural reasons in (a) and (b) above. Concretely, what I can do
without owning a script:

1. **Review the spec** once someone fixes the partition (step 1 above) — that is a judgement call,
   and it is the part worth a second pair of eyes.
2. **Supply the `git ls-files` recount** as a **one-time snapshot** on request, clearly labelled with
   the time it was taken. It is *not* a gate and must never be cited as one.
3. **If the team still wants a gate**, the only defensible form is a `git ls-files`-based check
   added as a mode of the **existing** `check-doc-counts.mjs` (one tie-breaker, per
   `STATUS.md:90-92`) — and only *after* the zones partition the tree. I will review that PR; I will
   not author it.

**Team-lead's other open item, B-1 (key rotation):** correctly assigned to [D] and correctly
outside automation. I agree with the framing — it is the only item where delay *increases* harm,
and I can only re-state the evidence (`.codebuddy/models.json` = 6 plaintext keys; `.gitleaks.toml`
has no `apiKey` rule, so the scanner cannot flag them by field name). **I will not touch it.**

#### Resolved: the `lib/forge-std` ambiguity (team-lead's execution item ④)

team-lead asked whether `lib/forge-std` belongs in the "已排除" table or in a zone, noting it is a
tracked submodule of 97 files whose presence would make `:3`'s total disagree with the zone sum.
**Measured, and the answer is unambiguous — it explains the whole discrepancy:**

```
git ls-files lib/forge-std   →  1
git ls-files | wc -l         →  206
```

**A submodule is tracked as exactly one gitlink entry, not as its contents.** So
`git ls-files` counts `lib/forge-std` as **1**, while the manifest's excluded table counts it as
**97** (its checked-out files). **Both numbers are internally consistent; they are counting
different things.** Consequences for the spec rewrite:

- Under the chosen `git ls-files` basis, `lib/forge-std` **is** a tracked entry and must be
  assigned to a zone (or explicitly to "excluded", stated as *1 gitlink entry* rather than 97
  files). This is the honest reconciliation: **excluded ≠ uncounted**.
- The 97-file figure belongs in the excluded table as a **size/context** note only, and must not
  be summed with the zone counts.
- So `:3`'s "204" cannot be reconciled with any zone sum until this basis mismatch is written
  down. **This was the missing piece, and it is a documentation bug, not a counting bug.**

One more basis caveat for whoever writes it: `git ls-files` also emits **quoted, escaped paths**
for the four `vault/Component N — ….md` notes (em-dashes), as `git ls-files` output showed
`"vault/Component 1 \342\200\224 …"`. Any script that pattern-matches those paths must handle
the quoting or it will silently under-count the `vault` notes by four.

### 9.6 The lesson from six passes, in its general form

Six passes, and my errors fall into **two distinct classes that need different defences.**

| # | Error | Class |
|---|---|---|
| 1 | `STATUS.md:47` — "row missing" (it existed) | **staleness** |
| 2 | "9 doc-count drifts" (stderr from a dead command) | **staleness** |
| 3 | B-0 (already fixed) | **staleness** |
| 4 | P-1 — I reported it **closed**, having only checked provenance | **staleness *and* reachability** (§9.4b) |
| 5 | `getNonce` "alignment" for the 7702 nonce | **shape ≠ mechanism** |
| 6 | cr-sec's "row 10 同理" (mirror of mine) | **shape ≠ mechanism** |
| 7 | **P-1 closed on provenance alone** (the deeper half of #4) | **provenance ≠ reachability** |

**Class A — staleness** (1–4). The tree moved; the report did not. Contributed by cr-sec, and it
covers 5–6 too, which is why it is the better generalisation:

> **相似性只能用来生成假设，不能用来下结论。**
> *Similarity can generate a hypothesis; it cannot conclude one.*

**Class B — the new one (7), and it is the dangerous one**, because **"I verified it" manufactures
confidence**. A stale snapshot is self-evidently suspect; a freshly-read, correctly-traced,
arithmetically-unexamined claim looks authoritative. **My tracing effort is precisely what stopped
me from doing the one step that mattered.** Defence, for property/spec work:

> **Trace the branch, then check the branch is reachable.**
> *Provenance* (which check raises this error) and *reachability* (can the model get there at all)
> are different claims, and passing the first says nothing about the second.

Concretely, the habit I should have run unprompted: **restate a spec's own constants as arithmetic
and check the intervals overlap.** One subtraction caught what three traces did not.

**The two findings that survived** were the two verified by reading the *mechanism* — W3-4.1's
re-scope (§1.4) and the manifest spec defect (§9.5). Both are claims about **how something works**,
and both would still hold after every line number in the file moved.

**Operational norms for this repo, now team standard:**
- **Status claims carry command + exit code + timestamp** (§9.4b). "No blockers" without a
  timestamp is worse than silence.
- **Say *which* red.** A non-zero build from lint and a non-zero build from a compile error are
  indistinguishable by exit code.
- **Anchor on symbol names, not `file:line`** (`contracts/src/` refactored twice;
  `packages/core/src/` carries ~1,670 uncommitted inserted lines; 64–136 lines of drift is routine).
- **Prefer verdicts containing no timestamped count** — write the part that is still true tomorrow.
- **For an assertion to count as evidence it must be shown able to fail** (mutation, §9.4b) — and
  **show it can fail by breaking the branch it claims to test, not by re-reading the branch.**
