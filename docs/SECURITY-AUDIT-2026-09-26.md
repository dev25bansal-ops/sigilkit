# Security Documentation Audit — 2026-09-26

**Scope:** accuracy of `docs/SECURITY-7702-THREAT-MAP.md`, `SECURITY.md`, `docs/AC-01-SCRUB-PLAN.md`, `.well-known/security.txt`.
**Method:** every claim re-derived from source with `文件:行号` anchors; git history inspected read-only (`git log -S`, `rev-list --objects` + per-blob scan, `fsck --lost-found`).
**Author:** dc-sec. **Read-only audit** — no existing document, contract, package, or script was modified.

**Status:** findings **adopted by team-lead 2026-09-26**. P0-1 upgraded to a **release blocker**; P0-3 reclassified (B-1 downgraded to a low-risk local operation, `filter-repo` explicitly cancelled); P0-5 **deferred to sc-gate** pending 收口 (recorded, not actioned). This document is now the reference for the ck-doc / dc-law / sc-gate remediation work — see the owner column in §7.

> ### ⚠ Snapshot warning — read the anchors with a timestamp
> `contracts/src/*.sol` and `packages/core/src/*.ts` were being **actively edited by other teams while this audit ran** (contracts team, packages team). `SessionKeyManager.sol` alone went from **812 → 849 → ~915 lines** during the audit, and `_recover` was **refactored mid-audit** into a `_recoverSigner` helper (`:759`) called by `_recover` (`:787`). So:
>
> - **a number of the threat map's own line anchors are already stale** — see §2/§3;
> - **the anchors in this document are point-in-time and some are already stale too.** Use **Appendix C (symbol index)** to re-locate every cited item — that table is drift-resistant in a way line numbers are not.
>
> The *findings* are what matter, not the line numbers. Every claim below was re-verified against source, not inferred from the documents.

---

## 1. Executive summary

The threat map is **honest about what it does not know** — rows 6, 8, 10 correctly say "exposed" or "pending" rather than claiming protection. That is rare and valuable.

But the audit found **six places where a document asserts a protection that does not exist in code**, and **one entire attack surface with no row at all**. Three of the six would cause a reader to make a materially wrong security decision.

| Verdict | Count | Notes |
|---|---|---|
| Rows accurate in substance (anchor aside) | 5 / 10 | rows **1, 2, 5, 6, 10** — all five verified against code |
| Rows with a **false or overstated protection claim** | 2 | row **7** (P0-1, false), row **4** (P0-6, category error) |
| Rows with a **stale line anchor** | 5 | rows 3, 5, 6, 8, 10 — the code is right, the citation moved |
| Rows honest about being open | 2 | row 6 ("SDK layer exposed"), row 8 ("pending checklist") — credit where due |
| **Real 7702 attack surfaces with no row at all** | 5 | incl. implementation re-pointing (P0-2) |
| Document claims contradicted by code | 6 | P0-1 … P0-6 |
| Keys found in git history | **0** | AC-01's core premise is false — P0-3 |

**The single most important line in this report:** row 7 — the copy-pasted-sweeper row, the one carrying real-world loss figures and the most frightening numbers in the entire document — is marked **"Mitigated-by-design"** when the mitigation **does not exist in code**. That is the pattern this audit was looking for, and it appears exactly once, at the highest-severity row.

> ### 📌 A named failure pattern (team-lead asked to generalise this)
> **"Documented control presented as a design control."** When the actual control is *"a doc warning plus operator discipline"*, writing it as **"Mitigated-by-design"** makes a reader believe a code-level protection exists.
>
> Why the substitution is so easy to make, and why it matters:
> - The warning **is** real, **is** in the docs, and **is** load-bearing — so it feels like a mitigation and reads like one.
> - "By-design" implies the design **prevents** the bad outcome. Here the design only **describes** it.
> - The consequence is a reader who stops reading, because the row already says "mitigated" — which is exactly the reader who then signs a delegation to a sweeper.
>
> The tell is grammatical: a genuine design control can be stated as *"the code cannot do X"*; a documented control can only be stated as *"we tell users not to do X."* Row 7 says the latter while being filed under the former.
>
> **Instances in this repo: 1 confirmed** (row 7 / P0-1) and **1 category error of the same family** (row 4 / P0-6, where a third party's API rejection is cited as SigilKit's mitigation). Both are in the same table, which is where a reader building a mental model would look.

---

## 2. P0 — 「文档声称但代码没有」清单 (highest priority)

### P0-1 · Row 7 claims a "fixed, canonical designator" the SDK never enforces — **FALSE**

**What the documents claim:**

- `SECURITY-7702-THREAT-MAP.md:17` — *"Mitigated-by-design: fixed SigilKitDelegator designator"* (exposure: **High**, action: sweep-guard test in W3-4.1).
- `SECURITY.md:158-161` — *"**Never sign a delegation to an address you don't own the code of.** … SigilKit's canonical `SigilKitDelegator` address is the only target the SDK ever names."*

**What the code actually does:**

```178:186:packages/core/src/eip7702.ts
export async function signAuthorization(
  account: SignerLike,
  args: {
    contractAddress: Address;
    chainId: bigint | number;
    nonce: bigint | number;
  },
): Promise<Authorization> {
  const digest = authorizationDigest(args);
```

`contractAddress` is a **free caller-supplied parameter**. There is:
- no canonical `SigilKitDelegator` address constant anywhere in `packages/core/src/` (grep for `delegator|canonical|allowlist|denylist|0xef0100` in `packages/core/src` returns only `DELEGATION_PREFIX` in the *reader* at `eip7702.ts:308`, plus unrelated `canonical` hits in `client.ts:297` / `cli.ts:153`);
- no default, no allowlist, no comparison against a deployed implementation;
- `DelegationScope.implementation` is likewise caller-supplied (`eip7702.ts:347`).

**Consequence.** The single most damaging real-world 7702 attack — copy-pasted sweepers, >97% of early mainnet delegations, $1.54M+ documented single losses — has **zero code-level mitigation**. A caller that passes a wrong or attacker-influenced `contractAddress` produces a perfectly valid, correctly-signed authorization for a sweeper. The SDK will not notice.

**Verdict:** "Mitigated-by-design" and "the only target the SDK ever names" are both **false**. The actual control is a *user-facing warning* plus operator discipline — that is a documentation control, not a design control, and the documents currently describe it as the latter. This is the most consequential finding in the audit.

**One point in the codebase's favour, and a caution for the fix.** `SigilKitDelegator`'s docstring (`:8-9`) does correctly state that delegation gives the EOA "the full SigilKit enforcement core", and `SECURITY.md:94-95` does correctly say delegation must target the canonical implementation directly (`0xef0100 || implementation`). So the *destination* is prescribed in prose. The gap is that **nothing in code enforces it** — and a prescriptive sentence in a doc comment is exactly the kind of control that erodes silently, which is why the map escalating it to "Mitigated-by-design" is the specific error worth correcting.

**Suggested wording:** exposure → *Not-mitigated (documented risk)*; add a task to pin a canonical designator constant and default `signAuthorization` to it, with an explicit opt-out for the deliberate multi-impl case.

---

### P0-2 · The map has **no row** for implementation re-pointing, and SECURITY.md's immutability claim does not cover the delegator

**Missing row.** Nothing in `SECURITY-7702-THREAT-MAP.md` addresses the fact that **an EIP-7702 delegation is a pointer, not a binding**. Any holder of the EOA key can, at any moment, sign a *new* authorization re-pointing the account to an arbitrary implementation. Grep confirms: no row, no task ID, and no mention of *re-delegation / re-pointing / implementation upgrade* anywhere in `docs/*.md` (0 matches for `re-delegat|redelegat|repoint|implementation upgrade`).

**Why this matters more than it looks:** a post-hoc re-delegation to a sweeper leaves **no on-chain trace in any SigilKit contract**. `SigilKitDelegator` records scopes, windows, nonces and denylists — it records *nothing about which implementation the account was delegated to, or when*. There is no on-chain attestation an auditor, indexer, or user could consult afterwards.

**A second, sharper problem — SECURITY.md's governance posture is scoped to the wrong contract.**

```46:52:SECURITY.md
The manager is **immutable-by-design pre-mainnet**: no proxy/UUPS upgrade path exists before the
external audit; key migration happens via `rotateSessionKey` and denylist policy, not code
upgrades.
```

That is true of `SessionKeyManager` **as a standalone deployed contract**. It is **not** true of the 7702 delegator, and the document's own §"EIP-7702 delegator" section sits 30 lines below without flagging the difference:

- `SigilKitDelegator` is an ordinary, non-immutable contract. It has **no** `immutable` self-pointer and no code-hash check anywhere (`contracts/src/SigilKitDelegator.sol`, 61 lines, no assembly, no immutables).
- In a delegated EOA, `initializeSelfOwned()` sets `s.owner = address(this)` = the EOA (`SigilKitDelegator.sol:38`). So `onlyOwner` passes for the EOA, and `transferOwnership` (`SessionKeyManager.sol:293`) and every other admin path **are** reachable by that EOA.
- The "self-owned / inert implementation" argument in `SECURITY.md:84-97` applies only to the *canonical implementation contract's own* storage. It says nothing about the *designator pointer* in the EOA, which is what an attacker re-points.

**Verdict:** the immutability guarantee readers will take away from `SECURITY.md:46-52` **does not extend to the 7702 surface**, and no document says so. An auditor reading SECURITY.md top-to-bottom would form a materially wrong model of the 7702 delegator's mutability.

> ### Related observation — a real bug was fixed mid-audit, and it shows *why* P0-2 matters
> While this audit ran, the contracts team refactored `SessionKeyManager._recover` into a shared `_recoverSigner` (`:759`, called from `_recover` `:787` **and** from the E10 owner-approval path `:479`). The NatSpec at `:744-750` records what that fixes: the owner-countersignature path previously used an **ECDSA-only** recovery, so a **contract owner (the documented 2-of-3 Gnosis Safe production setup) could never produce a valid approval** — `ecrecover` cannot return a Safe — and every countersigned action reverted `InvalidOwnerApproval`, silently, on first use.
>
> Two things follow for the security record:
> 1. **This was a live availability bug in the documented production configuration**, and neither `SECURITY.md` nor the threat map mentions it. SECURITY.md:143-144 and `:48-52` both *mandate* `SIGILKIT_OWNER_ADDRESS` = a governance Safe, and `:49-52` states treasury recovery is the owner-only `withdraw` — the E10 countersign path was broken for exactly that owner.
> 2. **It illustrates the structural point of P0-2.** The fix was needed because ERC-1271 (smart-account owners) and ECDSA (EOA owners) are *different key kinds*, and the 7702 delegator makes the "owner is a contract" case the norm rather than the exception. A pointer-based design whose owner set includes contract accounts deserves the explicit trust-boundary documentation P0-2 recommends.
>
> Positive note: the fix routes **both** call sites through one helper, so they cannot drift again — the same single-source-of-truth discipline the repo already applied to the admin denylist (C-04) and the `executor` audit selector (SEC-3). Worth crediting in the catalog.

---

### P0-3 · `AC-01-SCRUB-PLAN.md` is premised on a false fact: the keys were **never in git history**

`AC-01-SCRUB-PLAN.md:9-10` states:

> AC-01/SK-01: `.codebuddy/models.json` was committed carrying 6 plaintext `apiKey` fields, and the AC-05 RPC token appears in history. Gitignoring the file stops future commits; it does nothing about the past.

**This is false for this repository.** Six independent read-only checks:

| # | Check | Result |
|---|---|---|
| 1 | `git log --all -S "sk-9129954527dd8a12" --oneline` | **empty** |
| 2 | `git log --all -S "sk_<REDACTED-see-AC-01>"` | **empty** |
| 3 | `git rev-list --objects --all` → every blob `cat-file`-scanned for both values | **NO MATCH** |
| 4 | `git fsck --lost-found` → all 28 dangling blobs scanned | **NO MATCH** |
| 5 | `git log --all -- .codebuddy` and `--diff-filter=A -- "*models.json"` | **empty** (path never existed) |
| 6 | `git stash list` (empty), reflog, `git ls-files --error-unmatch .codebuddy/models.json` | not tracked |

Current state of the file: **gitignored** (`.gitignore:19`) and **untracked**.

> ### 🟢 DECISION (2026-09-26, adopted by team-lead): B-1 is downgraded — **do not run `filter-repo`**
>
> The team-lead independently re-verified checks 1, 5 and 6 above and **adopted the conclusion**, which changes the *nature* of the work item rather than just its status:
>
> | | Before this audit | After (adopted) |
> |---|---|---|
> | Class of operation | **High-risk, irreversible, whole-repo** (rewrite 40 commit SHAs + force-push to `master` and `review-integration-20260917`) | **Low-risk, local** (rotate + delete one file) |
> | Git history rewrite | Required | **Not required — do not do it** |
> | `AC-01` history rewrite | Required | **Not required** — it records a leak that never happened |
> | Remaining real actions | 4 plan steps | **2: rotate the 6 keys, delete `.codebuddy/models.json`** |
>
> dc-plan had been carrying B-1 as "the only item where delay increases harm, ~1h, [D] executes" — which, given Step 2 was a `filter-repo` + force-push, was **correctly** treated as high-risk. That risk was an artifact of a false premise, not of the exposure. The exposure is a file on disk.
>
> **Two independent verifications now agree** (dc-sec six-point scan; team-lead three-command recheck), so this should be treated as settled fact rather than a single analyst's claim.

**Consequence — the plan's Step 2 is a no-op with a heavy price:**

```
git filter-repo --invert-paths --path .codebuddy/models.json
git filter-repo --replace-text <(printf 'RPC-TOKEN-OLD-VALUE==>REDACTED\n')
```

Neither path nor token exists in any commit. Executing Step 2 would **rewrite all 40 commit SHAs** and then require the Step 4 force-push (`AC-01-SCRUB-PLAN.md:57`) — breaking every clone, in exchange for **zero** security benefit. The plan's own Step 1 correctly warns this is destructive and whole-repository; it just does not know there is nothing to remove.

**This resolves the documented 事实分歧 in the opposite direction from `ISSUES-CATALOG-2026-09-25.md:60`.** That item's修复顺序 step ③ says *"修正 09-21 目录的错误结论"* ("correct the 09-21 catalog's wrong conclusion"). But `Issues-Catalog-2026-09-21-Agent-Review.md:26-27` — *"Currently gitignored (`.gitignore:19`), so not in git history"* — is the **correct** one. **AC-01 and SEC-02 are the documents that are wrong.**

> ### ⚠ ACTION REQUIRED for ck-doc — do **not** let the erroneous "correction" harden
> The catalog's step ③ is **itself the error**. If ck-doc "corrects the 09-21 catalog" as instructed, the catalog will **newly record a falsehood** — and it will do so by overwriting the one document that got this right. Three concrete edits, in this order:
>
> 1. **Invert the attribution.** The line *"修正 09-21 目录的错误结论"* must be changed to record that **09-21 was correct and AC-01/SEC-02 were wrong**. Leaving it as-is propagates the error into the permanent record.
> 2. **Do not touch `Issues-Catalog-2026-09-21-Agent-Review.md:26-27`.** It is the correct statement and is now the *evidence* for step ①. Mark it as confirmed, not as superseded.
> 3. **Attach the evidence, not just the conclusion.** The six checks in the table below are the artifact that makes this defensible to an auditor. A bare "re-verified, not in history" claim invites the same dispute a third time.
>
> Net effect on the catalog: **SEC-02's remediation shrinks from "rotate + rewrite history + force-push + notify collaborators" to "rotate + delete one file"** — and its CVSS 7.5 / "Critical" framing should be re-examined, since the credential-exposure half (remote third-party key in a publishable tree) is a real but far smaller problem than "in every historical commit of a public repo".

**The real, unaddressed exposure.** The 6 keys are live on disk in a tree destined to go public (exactly the risk the 09-21 catalog identified). Critically:

> **gitleaks cannot see them.** The file is gitignored, and `gitleaks detect` operates on git history/working tree per its own path rules — a `.gitignore`d file is invisible to both the CI gitleaks job (`ci.yml:73-74`, `publish.yml:68-74`) and any pre-push security gate.

So the plan's framing ("rewrite history") targets a risk that does not exist, while the risk that *does* exist — a `git add -f`, a `zip`, or a cloud-sync of the tree — has no control at all beyond "don't do that."

**Actual priority order should be:**
1. **Rotate all 6 apiKeys + the AC-05 RPC token** (unchanged, and still the only step that matters — rotation, not scrubbing, is what un-leaks a harvested key). Rotation status is **still unverified**: `PLAN-30-DAYS:62` W1-5.3 "[D]: finish rotation leftovers" is `[ ]` open.
2. Move the keys to env vars / OS secret store, or delete the file — the exposure is *disk*, not history.
3. **Do not run `filter-repo`.** Retire `AC-01-SCRUB-PLAN.md` Steps 1–4, or re-scope them to a *forward-looking* pre-push gate.

**Answering the question as asked — where are the 6 apiKeys now?** All six are in `d:/SigilKit/.codebuddy/models.json`, in plaintext, on disk, gitignored. They are **2 distinct secrets across 6 fields**:

| Secret | File:line | Count | Endpoint |
|---|---|---|---|
| `sk_9129954527dd8a12-…` | `.codebuddy/models.json:8, 27, 46, 65, 100` | 5 | `http://localhost:20128/v1` (local proxy) |
| `sk_37642f8d…434be4` | `.codebuddy/models.json:81` | 1 | `https://api.cline.bot/api/v1` (**remote, third-party**) |

**Rotation priority (adopted by team-lead) — rotate `:81` FIRST, regardless of field count:**

| Rank | Secret | Why it ranks here |
|---|---|---|
| **1** | `sk_37642f8d…` (`:81`) | Authenticates against a **remote third-party service**. A leaked value is exploitable from anywhere on the internet, bills the account, and the operator is a third party who cannot be asked what "local" means. **This is the only one of the six that is a real credential.** |
| 2 | `sk-9129954527dd8a12-…` (5 fields) | Authenticates only to `http://localhost:20128/v1` — a **loopback** proxy. Not remotely reachable, so a leak is not directly exploitable; the residual risk is that the local proxy relays it upstream (unverified — treat as unknown, rotate anyway). |

Note the inversion worth stating explicitly: **field count is a bad proxy for risk here.** The 5× repeated key is the *lower*-risk one; the single-occurrence key is the higher-risk one. Anyone triaging "6 keys" as six equal items will naturally rotate the loopback value first and the remote one last.

**The AC-05 RPC token:** evidence file `outputs/verification-followup.txt` is **gitignored** (`.gitignore:53`) and **untracked** (`git ls-files outputs` → empty). Not in history either. The plan's `--replace-text RPC-TOKEN-OLD-VALUE` step is likewise a no-op.

---

### P0-4 · SECURITY.md claims a working machine-readable disclosure channel whose own file admits every URI is dead

```113:122:SECURITY.md
SigilKit follows a 90-day coordinated-disclosure window. Report vulnerabilities through the
machine-readable channel defined in [`.well-known/security.txt`](.well-known/security.txt)
(RFC 9116): the GitHub Security Advisories page of the `dev25bansal-ops/sigilkit` repository is the
primary Contact, and this file is the Policy document. Reports received via that channel are
triaged within 7 days; …
```

But `.well-known/security.txt:3-10` says the opposite:

> *…it is NOT publicly reachable — an anonymous request for both the repo and the owner returns HTTP 404… **Consequence: the Contact and Policy URIs below are dead links until the repository is public.** … **Until then, SECURITY.md in this repository is the authoritative channel.***

**Both Contact URIs and the Policy URI are on the 404 repository** (`security.txt:15, 16, 20`). So at present there is **no working disclosure channel at all** — and the "authoritative channel" fallback that `security.txt:10` nominates (**SECURITY.md itself**) is exactly the document that never mentions the 90-day window, the 7-day triage SLA, or the credit policy in a way a reporter could act on without first trusting a file whose links 404.

**Verdict:** SECURITY.md asserts a functioning RFC 9116 channel and a 7-day triage SLA. Neither is currently reachable. This is false disclosure confidence — a reporter who follows the documented primary Contact hits a 404 and has no stated fallback.

**Fix:** SECURITY.md's TD-7 section must state the channel's current status and carry a real `mailto:` fallback (a `mailto:` works whether or not the repo is public), or the SLA language must be conditioned on the repo being public.

---

### P0-5 · The `security.txt` guard runs **after** the Foundry call it claims to precede — so it never runs without Foundry

**The claim, in two places:**

- `SECURITY.md:120-122` — *"re-validated by `scripts/check-doc-counts.mjs` on every CI run — an expired or malformed `security.txt` fails the workflow-lint job, so the disclosure channel cannot silently rot."*
- `scripts/check-doc-counts.mjs:669-670` (the function's own docstring) — *"**Runs before any forge invocation so it also guards environments without the Foundry toolchain.**"*

**The code:**

```866:897:scripts/check-doc-counts.mjs
function main() {
  …
  const counts = forgeCounts();      // ← :875  runs FIRST
  const ci = ciJobCount();
  …
  const problems = [...checkSecurityTxt()];   // ← :897  runs LAST
```

and `forgeCounts()` hard-exits on failure:

```716:723:scripts/check-doc-counts.mjs
    out = execFileSync(FORGE, ["test", "--list"], { cwd: ROOT, encoding: "utf8" });
  } catch (err) {
    console.error(
      `could not run \`${FORGE} test --list\`. Set FORGE_BIN to the forge executable path.\n` + …,
    );
    process.exit(2);
  }
```

**Empirically confirmed.** `node scripts/check-doc-counts.mjs` on this machine (no Foundry on PATH) printed only:

```
could not run `forge test --list`. Set FORGE_BIN to the forge executable path.
spawnSync forge ENOENT
```

…exited, and **never printed `security.txt OK`**. The guard did not run.

**Verdict, split by context:**
- **In CI: the claim holds.** `ci.yml:44-45` installs Foundry and `ci.yml:69-70` runs the script in `workflow-lint`; `problems` → `process.exit(1)` (`:976-980`). An expired `security.txt` does fail that job. ✅
- **The code's docstring is false**, and any local/pre-push invocation on a machine without Foundry silently checks nothing while *appearing* to have run. That is the same "exits 0 having checked nothing" failure mode the repo already documents for itself in `scripts/lib/paths.mjs:40-44`. ❌

**Secondary gap — the guard enforces 2 of the 5 fields.** `checkSecurityTxt()` (`:672-711`) validates only **Contact** (presence + `mailto:`/`http(s)://` scheme) and **Expires** (parseable + future). It does **not** check `Preferred-Languages`, `Canonical`, or `Policy`. Deleting all three would still print `security.txt OK`. So "cannot silently rot" overstates the coverage even where the guard does run.

**On the task's instruction to run `scripts/check-runtime.mjs`:** that script is a **Node/vitest runtime diagnostic** and has nothing to say about `security.txt`. It ran clean (`node v24.12.0`, required `>=24`, all four workspaces on vitest 5.0.0). The script SECURITY.md actually names is `check-doc-counts.mjs` — which is the one that cannot complete locally without `FORGE_BIN`.

---

### P0-6 · Rows 4 and 9 claim a canary "PASS on 13.49.0" that the evidence artifact records as 12.5.0

Both rows rest on the same canary, and both overstate its verification level:

| Document claim | Evidence artifact |
|---|---|
| `SECURITY-7702-THREAT-MAP.md:14` — *"canary PASS **13.49.0**"* | `packages/core/test/WALLET_BEHAVIOR_ALLOWLIST.json:38` — `"verifiedOn": "extension **12.5.0** (2026-08 live harness via Playwright + persistent Chromium)"` |
| `SECURITY.md:155-156` — *"canary-verified on **13.49.0**"* | as above |
| `SECURITY-7702-THREAT-MAP.md:19` — *"canary PASS on **13.49.0**"* | as above |
| `packages/core/test/wallet-e2e/run.ts:508` (comment) — *"extension 13.49.0"* | contradicts `:38` in the file it reads |

The harness at `run.ts:512-521` *does* read the allowlist entry and *does* fail on a silent flip — the canary mechanism is real. But the record it enforces against says the behavior was last verified on **12.5.0**, while three documents and one code comment assert **13.49.0**. `ci.yml:368` does pin the 13.49.0 download, so the 13.x pin is real; the *behavior verification* on 13.x is not recorded.

**Second issue — row 4's exposure label is a category error.** Row 4 is *"One signed authorization tuple = persistent control."* Its mitigation is listed as *"Mitigated-by-test: harness asserts raw zero-address revoke is REJECTED by MetaMask."* A MetaMask API rejection is not a SigilKit mitigation — it is a third-party wallet's input-validation policy, and it is cited as evidence that persistent control is mitigated. What actually mitigates row 4 is that revocation *works at all*; the canary proves only that one particular revocation *path* is unavailable. Row 4's residual risk is the **whole account** being persistently controlled, which is **not** mitigated by anything in the repo — and is exactly what `SECURITY.md:162-165` tells users in prose.

**Fix:** restate both rows as "verified on 12.5.0; 13.49.0 behavior unrecorded", and re-label row 4 as *Not-mitigated (inherent to 7702; documented user warning)*.

---

## 3. Threat map — row-by-row verification

Line anchors are as of the working tree during this audit; `contracts/src` and `packages/core/src` were under concurrent edit.

| # | Vector | Doc's exposure | **Verified** | Finding |
|---|---|---|---|---|
| 1 | `tx.origin` broken by delegation | Mitigated-by-construction | ✅ **True** | `grep -c "tx\.origin" contracts/` → **0**. Construction claim holds. ⚠️ But "SECURITY.md warns operators" is **not** in SECURITY.md — the 7702 warnings section (`:151-168`) covers persistence, sweeper targets, chain-binding and `extcodesize`, never `tx.origin`. Doc omission. |
| 2 | Flash-loan sandwiching of EOA-code checks | Not-applicable | ✅ **True** | The only code-existence check is the ERC-1271 branch at `SessionKeyManager.sol:750` (`extcodesize`), correctly scoped to row 3. |
| 3 | `extcodesize` misclassification | Accepted-by-design | ⚠️ **Anchor wrong** | Cited `SessionKeyManager.sol:524`; actual `extcodesize` is at **`:750`**, inside `_recover` at **`:733`**. Semantics claim ("a delegated session key IS a smart key") is correct. |
| 4 | One tuple = persistent control | Mitigated-by-test | ❌ **Overstated** | See **P0-6**. Category error + version mismatch. |
| 5 | ERC-4337 remote activation | Mitigated-by-design | ⚠️ **Anchor wrong + reasoning imprecise** | Cited `validateUserOp` at line **193**; actual **`:280`**. Also: a plain `SigilKitDelegator` EOA has **no** ERC-7579 interface at all (no `isModuleType`/`onInstall`/`execute` — `SigilKitDelegator.sol` is 61 lines, none of them those), so the module is **unreachable** from a delegated EOA. The mitigation is *stronger* than documented, but the stated two-line argument is about the wrong thing. |
| 6 | Cross-chain replay via `chain_id=0` | Partial — SDK layer exposed | ✅ **Honest** | Anchor wrong (cited `_domainSeparator` at **499**; actual **`:683`**, `block.chainid` at **`:685`**). The *honesty* is the finding: at committed HEAD the SDK has **no** `chainId != 0` guard. See §4.1. |
| 7 | Copy-pasted sweeper contracts | Mitigated-by-design | ❌ **FALSE** | See **P0-1**. The single highest-impact row in the map, and the one whose mitigation does not exist. |
| 8 | `validateUserOp`/`postOp` mistakes | Pending checklist | ✅ **Honest** | Correctly open. But see §4.2 — four of the six "mistakes" are *already mitigated in code* and the map does not record it, so the auditor's starting picture is worse than reality. |
| 9 | MetaMask #35520 | Mitigated (canary) | ⚠️ **Version mismatch** | See **P0-6**. The SDK half is fine: `signRevocation` (`eip7702.ts:209`) emits a type-4 tuple; there is no `eth_sendTransaction` revoke path in the SDK, so the stated requirement is satisfied by construction. |
| 10 | Authorization nonce reuse | Partial — SDK layer | ⚠️ **Anchor wrong** | Cited `getNonce` at **361**; actual **`:530`**; enforcement at **`:478-479`**. Substance correct. But the SDK provides **no** way to *obtain* the correct 7702 nonce — see §4.3. |

---

## 4. EIP-7702 attack-surface coverage matrix

Legend — **Doc**: covered by the threat map? · **Code**: defended in code?

| # | Real attack surface | Doc | Code | Assessment |
|---|---|---|---|---|
| 1 | **Cross-purpose replay** (sign authorization A, use it for tx B) | ❌ not a row | ✅ **defended** | Pre-image is `keccak256(0x05 ‖ rlp(...))` — magic `0x05`, plain RLP, not EIP-712 `0x1901` (`eip7702.ts:25, 140-172`). The two pre-image families are **disjoint by construction**. *Note:* this reasoning exists only in the **uncommitted working tree**; at HEAD it is undocumented. Worth a row regardless — it is the answer to a question every auditor asks. |
| 2 | **Cross-chain replay (`chain_id=0`)** | ✅ row 6 | ⚠️ **opt-in only** | At HEAD: **no guard at all**. In the working tree, `assertDelegationScope` (`eip7702.ts:375-446`) throws on `chainId === 0` unless `allowAllChains: true` (`:407-413`) — but it is **opt-in**: a caller using `signAuthorization` directly gets nothing. **Zero tests** reference it (`grep assertDelegationScope packages/core/test` → 0). Row 6 is honest that this is open. |
| 3 | **Signature replay (same tuple submitted twice)** | ⚠️ row 10, partial | ✅ protocol + ✅ app-layer | 7702 nonces make a tuple single-use at the protocol level. App-layer: `request.nonce != s.nonces[signer]` → revert (`SessionKeyManager.sol:478-479`). The 7579 path binds the 4337 nonce inside `userOpHash` (`SessionKey7579Module.sol:577-591`). Sound. |
| 4 | **Implementation re-pointing / post-hoc backdoor** | ❌ **NO ROW** | ❌ **undefended & undetectable** | **P0-2.** The designator is a mutable pointer. Re-delegation leaves no SigilKit on-chain record. Highest-severity omission. |
| 5 | **7702 × ERC-4337/7579 interaction** | ⚠️ row 5, imprecise | ✅ **stronger than documented** | A delegated `SigilKitDelegator` EOA exposes no 7579 module surface; `ActionLog7579Executor.execute` requires `msg.sender == account` (`:164`) and `onInstall`/`setAgentId` are `msg.sender`-scoped (`:77-109`). Module adds `NotAuthorizedCaller` (`SessionKey7579Module.sol:295`), gas bounds (`:144/146/154`) and the `_selectorOf` sub-4-byte rejection (`:436`) — **none of it recorded in the map**. |
| 6 | **`delegatecall` storage conflicts** | ❌ **NO ROW** | ✅ **defended** | All three contracts use ERC-7201 namespaced slots with assembly getters: `SessionKeyManager.sol:74-75`+`:844`, `SessionKey7579Module.sol:87-88`+`:161`, `ActionLog7579Executor.sol:51-52`+`:59`. `SigilKitDelegator.sol:18-19` even claims ERC-7201 "coexists with other 7702-safe facets". **The strongest unrecorded mitigation in the codebase.** |
| 7 | **Signature malleability (EIP-2 low-s)** | ❌ not a row | ✅ **defended** | `SessionKeyManager._ecrecover` (`:829`, half-order check), `SessionKey7579Module._recover` (`:577`), and SDK `toAuthorizationTuple` rejects high-`s` before the tuple leaves the process. |
| 8 | **ERC-1271 magic-value forgery (SEC-11)** | ❌ not a row | ✅ **defended** | `SessionKeyManager._isERC1271SuccessMagic` requires the **entire** 32-byte word to equal the magic, or `ret.length == 4`. The NatSpec documents the exact bypass this closes. |
| 9 | **`PUSH0` / EVM-version signature-domain drift** | ❌ not a row | ✅ **N/A — correctly omitted** | Verified `foundry.toml:8 evm_version = "prague"`. EIP-712 and 7702 digests are computed as **off-chain keccak pre-images** and verified via the `ecrecover` **precompile**; neither is affected by which opcodes the compiler emits. There is no signature-domain inconsistency to guard against. *The reasoning should still be written down* — otherwise this gets re-raised at audit prep. (Real EVM-version sensitivity lives elsewhere: CREATE2 deploy-address derivation for the canonical delegator, and the `anvil_setCode` designator fixtures.) |
| 10 | **7702 authorization nonce sourcing** | ⚠️ row 10 defers to "SDK/wallet layer" | ❌ **no helper exists** | The SDK requires the caller to pass `nonce` as a bare parameter (`eip7702.ts:182`) and offers **no** `getAuthorizationNonce()` / `pending`-vs-`latest` guidance. `grep get_transaction_count packages/core/src` → 0. A caller guessing wrong produces a silently-rejected tuple. Row 10's framing ("SDK layer") implies the SDK handles it; it does not. |
| 11 | **Cross-agent signature substitution** | ⚠️ deferred to W3-3.1 `[ ]` | ✅ bound | `agentId` is in `_ACTION_REQUEST_TYPEHASH` (`SessionKeyManager.sol:102-105`). |
| 12 | **Window-budget reset via `rotateSessionKey`** | ❌ not in map | ❌ **unfixed** | `ISSUES-CATALOG-2026-09-25.md:158-165` (SEC-10, Medium): `_grant` writes the new scope without touching `windows[newKey]`, so a fresh key starts at zero and the per-window cap can be refreshed indefinitely. A budget-integrity issue rather than a 7702 one, but it belongs in the map's scope. |

> **Unverified as of 2026-10-01 — row 12’s "❌ not in map" and "❌ unfixed" were not re-measured in this pass, and the cell is
> narrower than it reads.** The pass had no access to `contracts/src/SessionKeyManager.sol` or `contracts/test/*` and
> could not run `forge`, so neither half of the cell was re-checked. What *is* on record in documents in this
> same audit set is cross-referenced here rather than asserted:
>
> - `docs/PROPERTY-TEST-PITFALLS-2026-09-26.md` §4: for SEC-10 the two code-level prescriptions (carry `windows`
>   over in `_grant`; document "rotation resets" in NatSpec) are **not landed**, while a third prescription — a
>   characterisation test — **has landed** in `Sec10WindowRotation.t.sol` and is **red**, because its assertion
>   contradicts current behaviour.
> - `docs/DOC-AUDIT-CONTRACTS-2026-09-26.md` records the same SEC-10 as "**has an exploitable defect**" /
>   "**zero coverage**" / "none landed", and separately registers the test as intentionally red under waiver
>   (expiry 2026-10-31).
>
> Those records are **not reconciled with each other by this pass**. So: **"unfixed" describes the defect, not
> the test inventory** — do not read this row as "no SEC-10 test file exists", and do not read it as "one exists
> and is green". Re-run `forge test --match-contract Sec10*` and re-grep `_grant` in
> `contracts/src/SessionKeyManager.sol` before citing row 12 as current.

### 4.1 Note on the concurrent SDK work (W3-4.1)

`assertDelegationScope` is **new, uncommitted, and untested** at the time of this audit (`git diff --stat` shows `packages/core/src/eip7702.ts | 279 +++++`; `git log -- packages/core/src/eip7702.ts` last touched it at `ee53f09`). Its logic is sound and the four failure modes it covers (wildcard chain, chain mismatch, delegate/revoke inversion, wrong implementation) are the right four. Two gaps worth raising with the packages team rather than here:

1. **It is opt-in, not default-on.** `signAuthorization` does not call it. A caller who never heard of it gets no protection — which is the same gap P0-1 describes.
2. **Zero tests.** Row 6's action item explicitly requires "negative cross-chain replay tests"; none exist yet, so W3-4.1 is not yet demonstrably complete even for the part that is written.

---

## 5. `SECURITY.md` / `security.txt` normative check

### 5.1 RFC 9116 field coverage

| Field | Present | Value | Enforced by CI guard? |
|---|---|---|---|
| `Expires` | ✅ `:17` | `2027-09-12T23:59:00Z` | ✅ **yes** — unexpired (today 2026-09-26; ~11.6 months, within the ≤12-month recommendation) |
| `Contact` | ✅ `:15, :16` ×2 | 2 × GitHub advisories/blob URLs on the **404** repo | ✅ scheme only — both are dead links (**P0-4**) |
| `Preferred-Languages` | ✅ `:18` | `en` | ❌ not checked |
| `Canonical` | ✅ `:19` | `.../blob/master/.well-known/security.txt` | ❌ not checked |
| `Policy` | ✅ `:20` | `.../blob/master/SECURITY.md` | ❌ not checked |
| `Encryption` | ❌ | — | optional per RFC 9116; the file's own header (`:13`) defers it to pre-launch ✅ |
| `Language` / `Hiring` / `Acknowledgments` / `CSAF` | ❌ | — | all optional; absence is fine |

**Normative notes:**
- All five required fields are **present**. Structurally the file is RFC 9116-shaped.
- **`Canonical` is a UI URL, not the file URL.** RFC 9116 §2.5.5 wants the URL where `security.txt` is *served*. `github.com/…/blob/master/…` is an HTML page. Should be the raw/served path once the repo is public.
- **Both `Contact` lines are the same dead host.** The file's pre-launch note (`:13`) already says to replace one with a `mailto:` — a `mailto:` works today and would make the channel functional *immediately*, before the repo is ever public. Highest-leverage one-line fix in this document.
- **The two-comment block at the top is honest and should be preserved** — it is the only place in the repo that accurately records the channel's non-functional status.

### 5.2 `SECURITY.md` internal consistency

| Claim | Verdict |
|---|---|
| `:113-122` TD-7 disclosure policy | ❌ **Overstated** — **P0-4** (channel is 404) and **P0-5** (the "cannot silently rot" guard has a documented no-Foundry hole and checks 2 of 5 fields) |
| `:124-130` Bounty status | ✅ **Good** — explicitly says no paid bounty exists, pre-audit and unpublished. Rare honesty; keep. |
| `:132-139` Supported versions | ⚠️ **Two problems.** (a) *"the tagged commit deployed on each chain is the only supported surface"* — `git tag -l` is **empty**; no tags exist, and `publish.yml:4` triggers on `v*`. Pre-mainnet-consistent, but the sentence describes a state that does not yet exist. (b) *"@sigilkit/core … latest published version only"* is a **support-and-supply-chain hazard**: the repo's own preflight (`publish.yml:129-161`, and `CI-WAIVERS.md:256` SEC-18d) records that **`@sigilkit/core` is already published by an unrelated project**. A reader who follows this support statement installs a **third party's code** and attributes it to SigilKit. Needs an explicit warning. |
| `:138-139` Foundry pinned `v1.7.1` | ✅ **True** — `ci.yml:32 FOUNDRY_VERSION: "v1.7.1"`, consumed at `ci.yml:45/96/111/122/154/247/302/317/340`. |
| `:141-149` Key-handling statement | ✅ Accurate. "the only keys committed anywhere are the public Anvil dev keys and the Anvil dev mnemonic" — independently confirmed: `git grep -E "sk-[a-zA-Z0-9]{8,}"` over tracked files returns only MetaMask/GitHub URLs. The claim holds. |
| `:151-168` 7702 user warnings | ✅ Good content. ⚠️ **Missing the `tx.origin` warning** that row 1 says is there, and **missing any re-delegation/immutable-pointer warning** (**P0-2**). |
| `:84-101` Delegator inertness | ✅ Correct **for the canonical implementation's own storage**. ❌ **Does not state the limit of the guarantee** — the EOA's *pointer* is mutable and the EOA owns itself. Needs one sentence. |
| `:3` Slither "24 findings across 7 contracts" | ❌ **Stale and contradicted** — see below. |
| `:12-16` Slither triage rows 9-10 | ⚠️ Undercounts. Claims 2 `assembly` findings ("`_manager()` / `_m()` storage slots"); there are **three** storage getters (`_manager` `:844`, `_m` `SessionKey7579Module.sol:161`, `_s` `ActionLog7579Executor.sol:59`) plus two further `assembly` blocks in `SessionKeyManager.sol:650` (`_revertInnerCall`) and `:750` (`extcodesize`). |

### 5.3 Slither count contradiction between two live documents

| Source | Run date | Scope | Findings |
|---|---|---|---|
| `SECURITY.md:3-8` | 2026-08-22/23, "re-run 2026-09-14" | `contracts/src`, 7 contracts | **24 findings, zero high** |
| `docs/CI-WAIVERS.md:48-50` | **2026-09-23** (newer) | `contracts/`, 73 contracts | 2,315 total; **53 unique src findings, 9 detectors, Zero High/Medium on `contracts/src/`** |

The per-detector counts disagree too, not just the totals: `timestamp` **7** (SECURITY.md:13) vs **13** (CI-WAIVERS:56); `assembly` **2** (`:14`) vs **10** (`:57`); `low-level-calls` **1** (`:15`) vs **10** (`:58`).

SECURITY.md is the document auditors are pointed at (`SECURITY.md:7` — *"This file is the reference the CI Slither gate and future auditors should check against"*). It is carrying a triage table that is **three weeks staler than the register**, with counts that disagree by up to 5×. Note that `CI-WAIVERS.md:50` cites concrete evidence artifacts (`outputs/slither-20260923.json` + `.log` + `slither-triage-summary.json`); SECURITY.md cites none.

---

## 6. `AC-01-SCRUB-PLAN.md` — status

| Plan claim | Verified state |
|---|---|
| `:9` "`.codebuddy/models.json` **was committed** carrying 6 plaintext apiKey fields" | ❌ **FALSE** — never in any commit. 6 independent checks, §P0-3. |
| `:10` "the AC-05 RPC token appears in history" | ❌ **FALSE** — `outputs/` is gitignored (`.gitignore:53`), untracked, absent from all history. |
| `:11-12` "Any remote clone of the repo … retains those keys in every historical commit" | ❌ **FALSE** — nothing to retain. |
| `:13-15` Prerequisite: rotate before scrubbing | ✅ **Correct and still the only step that matters.** Rotation status **unverified** — `PLAN-30-DAYS:62` W1-5.3 is `[ ]` open. |
| Step 0 — gitleaks inventory | ⚠️ Will return **zero** for the inventoried set. Useful as confirmation, not as discovery. |
| Step 2 — `filter-repo --invert-paths --path .codebuddy/models.json` | ⚠️ **No-op** — path never existed. Would rewrite all **40** commit SHAs for zero benefit. |
| Step 2 — `--replace-text RPC-TOKEN-OLD-VALUE` | ⚠️ **No-op** — token never in history. |
| Step 4 — force-push to `master` + `review-integration-20260917` | Branch names are correct (both exist locally; `remotes/origin/master` present), but the whole step is moot. |
| `:57` Hardcodes a personal GitHub account | Already logged as SEC-18(f) (`ISSUES-CATALOG-2026-09-25.md:258`). |
| `:71-76` Open questions | ✅ Legitimately open — and now decidable: the answer to "scrub only `models.json` or every inventoried secret" is **neither; there is nothing to scrub**. |

**One more blind spot worth recording:** `.gitleaks.toml:28-40` was already narrowed (SEC-07) to exempt only the downloaded MetaMask bundles rather than the whole `wallet-e2e/` directory — good. But because `models.json` is *gitignored*, gitleaks structurally cannot flag it in **any** mode. The `ISSUES-CATALOG-2026-09-25.md:60` step ④ ("add a generic `apiKey` field rule to `.gitleaks.toml`") would **not** catch these six keys either, for the same reason. That remediation step needs a different mechanism (a pre-commit hook that reads the working tree, or simply removing the file).

---

## 7. Recommendations, ranked

**Ownership key:** ⬜ *ready now* · 🔒 *blocked — do not action yet* · owner in *(parentheses)*

**P0 — fix before any external audit contact**

| # | Action | Owner | Status |
|---|---|---|---|
| 1 | **P0-1** — Stop describing the delegate target as pinned. Either pin a canonical `SigilKitDelegator` constant and default to it in `signAuthorization`, or restate row 7 / `SECURITY.md:158-161` as *unmitigated, user-warning only*. *(packages + docs)* | packages + ck-doc | ⬜ **Upgraded by team-lead to a P0 release blocker.** Independently corroborated by cr-ship (npm scope collision) — two independent paths agree. |
| 2 | **P0-2** — Add a threat-map row for **implementation re-pointing**; add one sentence to `SECURITY.md:46-52` stating the immutability guarantee covers the manager contract and **not** the 7702 designator pointer. *(docs)* | ck-doc | ⬜ |
| 3 | **P0-3** — Mark `AC-01-SCRUB-PLAN.md` **not-required**, attach the evidence, **invert** the catalog's step ③ attribution (see the ck-doc action box in §P0-3), re-scope to **rotate `:81` first, then `:8/27/46/65/100`, then delete the file**. **Do not run `filter-repo`.** *(docs + [D])* | ck-doc + dc-plan + [D] | ⬜ **Adopted by team-lead; B-1 downgraded to a low-risk local operation.** |
| 4 | **P0-4a** — **Add a `mailto:` Contact to `security.txt`.** A `mailto:` works whether or not the repo is public, so this makes the channel functional *today* with no dependency on the repo going public. *(docs)* | **dc-law** | ⬜ **Explicitly unblocked — dc-law has standing permission and can do this at any time.** Start here. |
| 4b | **P0-4b** — Make SECURITY.md's TD-7 section state the channel's real status (all URIs currently 404). *(docs)* | ck-doc | ⬜ Should land *after* 4a, so the section can point at a channel that works. |
| 5 | **P0-5** — Fix the false docstring at `check-doc-counts.mjs:669-670` (move `checkSecurityTxt()` above `forgeCounts()`, or make the forge failure non-fatal for the doc guard); extend it to check `Preferred-Languages` / `Canonical` / `Policy`. *(sc-gate)* | **sc-gate** | 🔒 **BLOCKED — team-lead direction: do NOT action now.** `check-doc-counts.mjs` is owned by sc-gate and may be under active change; a concurrent edit would collide. Record only; assign at 收口. |
| 6 | **P0-6** — Restate rows 4 and 9 as verified on **12.5.0**; re-label row 4 as inherent-and-documented rather than mitigated. *(docs)* | ck-doc | ⬜ |

> **P0-5 is recorded, not dropped.** The finding is real and reproduced; only its *timing* is deferred. Split it when it is assigned: the **docstring** line (a comment, zero blast radius, safe to fix in passing) and the **ordering change** (behavioural, needs its own regression test) are separable, and only the first should be taken opportunistically.

**P1 — accuracy debt**

| # | Action | Owner | Status |
|---|---|---|---|
| 7 | Refresh the five stale line anchors in rows 3, 5, 6, 8, 10; add a "verified on `<date>` @ `<sha>`" column so a future audit can tell *drift* from *error*. | ck-doc | ⬜ |
| 8 | Reconcile the Slither triage table in `SECURITY.md` with `CI-WAIVERS.md:48-60` (cite the `outputs/slither-20260923.*` artifacts); correct the `assembly` undercount (2 vs 10). | ck-doc | ⬜ |
| 9 | Warn in `SECURITY.md:132-139` that `npm i @sigilkit/core` resolves to an **unrelated third-party package** today. | ck-doc + cr-ship | ⬜ Pairs with P0-1; the two corroborate. |
| 10 | Add the four **undocumented-but-defended** surfaces as *closed with anchors*: ERC-7201 namespacing, EIP-2 low-s, the SEC-11 ERC-1271 magic check, and cross-purpose replay via the `0x05` magic. | ck-doc | ⬜ **Adopted by team-lead — see "missed positive evidence" below.** |
| 11 | Add the `PUSH0`/EVM-version row as explicitly **N/A**, with the reason. | ck-doc | ⬜ **Adopted by team-lead — exact wording supplied below.** |

> **On "missed positive evidence" (item 10) — a category team-lead asked to generalise.** An audit that reports only *absent* controls systematically **overstates** risk, because it presents the reader with an uncompensated list of everything that is missing and nothing about what is already holding. The strongest mitigation in this codebase — **ERC-7201 namespaced storage across all three contracts** — appears in **no** threat-map row and would be invisible to a reader of the document. It was independently confirmed by ck-arch (zero raw storage, 3/3 slot constants recomputed offline, zero `delegatecall`, zero Diamond). Two independent paths agreeing on a *positive* finding is as reportable as two agreeing on a gap.

> **On item 11 (`PUSH0`/EVM-version) — ready-to-paste wording, team-lead requested this be written into the map:**
>
> Suggested new row, to sit alongside the existing N/A rows:
> - **Vector:** Pre-verify / EVM-version-dependent signature-domain drift (`PUSH0`, opcode availability across EVM versions).
> - **Where SigilKit touches it:** Nowhere, by construction. `foundry.toml:8` pins `evm_version = "prague"`, but the value is not load-bearing for signatures: both the EIP-712 `ActionRequest` digest and the EIP-7702 authorization digest are computed as **off-chain keccak pre-images** and verified on-chain through the **`ecrecover` precompile**. Neither involves the compiler emitting — or a node interpreting — any version-dependent opcode.
> - **Exposure:** **Not-applicable** (verified 2026-09-26).
> - **Note:** EVM-version sensitivity does exist elsewhere in this system — CREATE2 deploy-address derivation for the canonical delegator, and the `anvil_setCode` designator fixtures in the wallet-e2e harness. Those are *address-derivation* concerns, not *signature-domain* concerns, and should not be conflated with this row.

**P2**

| # | Action | Owner | Status |
|---|---|---|---|
| 12 | Add an SDK helper to source the EOA's current 7702 nonce (row 10 / matrix §10); no `get_transaction_count` usage exists in `packages/core/src` today. | packages | ⬜ |
| 13 | Make `assertDelegationScope` default-on inside `signAuthorization`, and add the negative cross-chain replay tests row 6 already requires (currently **zero** tests reference it). | packages | ⬜ |

---

## Appendix A · Commands run (read-only)

```
node scripts/check-runtime.mjs                          # clean; Node v24.12.0 — unrelated to security.txt
node scripts/check-doc-counts.mjs                       # forge ENOENT → exited before the security.txt guard (P0-5)
git log --all -S "<key1>" / -S "<key2>" --oneline        # both empty
git rev-list --objects --all | per-blob cat-file scan     # NO MATCH
git fsck --lost-found  →  28 dangling blobs scanned        # NO MATCH
git log --all -- .codebuddy ; --diff-filter=A -- *models.json   # empty
git ls-files --error-unmatch .codebuddy/models.json       # not tracked
git check-ignore -v .codebuddy/models.json                # .gitignore:19
git tag -l ; git branch -a ; git stash list ; git reflog   # no tags, no stash
grep -c "tx\.origin" contracts/                           # 0
grep -E "sk-|sk_" over git-tracked files                   # MetaMask/GitHub URLs only
```

## Appendix B · Files read

`docs/SECURITY-7702-THREAT-MAP.md` · `SECURITY.md` · `docs/AC-01-SCRUB-PLAN.md` · `.well-known/security.txt` ·
`contracts/src/{SigilKitDelegator,SessionKeyManager,SessionKey7579Module,ActionLog7579Executor}.sol` ·
`packages/core/src/{eip7702,signing,index}.ts` · `packages/core/test/{WALLET_BEHAVIOR_ALLOWLIST.json,wallet-e2e/run.ts}` ·
`scripts/check-doc-counts.mjs` · `.gitleaks.toml` · `foundry.toml` · `.github/workflows/{ci,publish}.yml` ·
`docs/{CI-WAIVERS,ISSUES-CATALOG-2026-09-25,Issues-Catalog-2026-09-21-Agent-Review,PLAN-30-DAYS-2026-09-23-to-2026-10-22,VERIFICATION-STRATEGY-2026-09-25}.md`

## Appendix C · Symbol index (drift-resistant)

Line numbers moved during this audit. These symbols were stable. Use this table to re-locate every claim above.

### `contracts/src/SessionKeyManager.sol`
| Cited as | Symbol / literal | Finding |
|---|---|---|
| `:488-489` | `if (request.nonce != s.nonces[signer]) revert NonceUsed();` | row 10, matrix §3 |
| `:540` | `function getNonce(address key)` | row 10 (**threat map says 361**) |
| `:693` (+`block.chainid` a few lines in) | `_domainSeparator()` | row 6 (**map says 499**) |
| `:759` | `_recoverSigner(bytes32,bytes)` — holds the ERC-1271 branch | row 3 (**map says 524**) |
| `:769` | `codeSize := extcodesize(keyContract)` (inline asm) | row 3 |
| `:787` | `function _recover(ActionRequest,bytes)` | row 3 |
| `:901` | `_ecrecover(...)` + `_SECP256K1_HALF_ORDER` | matrix §7 |
| `_isERC1271SuccessMagic` | whole-32-byte-word magic check | matrix §8 (SEC-11) |
| `_targetAllowed` | v2 pinned/wildcard leaf check | SECURITY.md:102-111 |
| `_STORAGE_LOCATION` + `_manager()` | ERC-7201 slot getter | matrix §6 |
| `_ACTION_REQUEST_TYPEHASH` | includes `agentId` | matrix §11 |
| `transferOwnership` | owner-only, reachable by a delegated EOA | **P0-2** |

### `contracts/src/SessionKey7579Module.sol`
| Cited as | Symbol / literal | Finding |
|---|---|---|
| `:280` | `function validateUserOp(...)` | row 5, row 8 (**map says 193**) |
| `:295` | `if (msg.sender != userOp.sender) revert NotAuthorizedCaller();` | matrix §5 |
| `:144 / :146 / :154` | `MAX_BATCH_SIZE` / `MAX_TOTAL_PROOF_ELEMENTS` / `MAX_SINGLE_PROOF_ELEMENTS` | matrix §5 |
| `:436` | `_selectorOf` (rejects sub-4-byte calldata) | matrix §5 (BUG-19) |
| `:571-573` | `_domainSeparator(address account)` — binds `account`, not `address(this)` | row 5 |
| `:577` | `function _recover(address,bytes32,bytes)` | row 8, matrix §7 |

### `contracts/src/ActionLog7579Executor.sol`
| Cited as | Symbol / literal | Finding |
|---|---|---|
| `:164` | `if (msg.sender != account) revert NotAccount();` | row 5, matrix §5 |
| `:189` | `if (auditId == bytes32(0)) revert EmptyAgentId();` | matrix §5 |
| `_s()` + `_STORAGE_LOCATION` | ERC-7201 slot getter | matrix §6 |

### `contracts/src/SigilKitDelegator.sol` (61 lines, stable throughout)
`s.owner = address(this)` in `initializeSelfOwned()` · `constructor() SessionKeyManager(address(this))` · `adminSelectorDigest()` override · **absence** of `isModuleType`/`onInstall`/`execute` (→ matrix §5) · **absence** of any immutability/code-hash check (→ **P0-2**)

### `packages/core/src/eip7702.ts`
| Cited as | Symbol | Finding |
|---|---|---|
| `AUTHORIZATION_MAGIC = "0x05"` | magic byte, not `0x1901` | matrix §1 |
| `authorizationDigest` | RLP pre-image, `[chain_id, address, nonce]` | matrix §1 |
| `signAuthorization` | `contractAddress` is **free caller input** | **P0-1** |
| `signRevocation` | type-4 zero-address tuple | row 9 |
| `assertDelegationScope` | `chainId===0` guard, `allowAllChains` opt-in | row 6, §4.1 |
| `toAuthorizationTuple` | high-`s` (EIP-2) rejection | matrix §7 |
| `validateAuthorization` / `isDelegatedTo` | designator reader — **reader only, never a gate** | **P0-1** |
| **absence** of | any canonical `SigilKitDelegator` address constant | **P0-1** |
| **absence** of | `get_transaction_count` / nonce-source helper | matrix §10 |

### `scripts/check-doc-counts.mjs`
`checkSecurityTxt()` (validates **Contact** + **Expires** only) · `forgeCounts()` (`process.exit(2)` on missing Foundry) · `main()` ordering — `forgeCounts()` called **before** `checkSecurityTxt()` (**P0-5**)

### `.gitleaks.toml` / `.gitignore` / `foundry.toml` / `ci.yml`
`.gitignore:19` `.codebuddy/models.json` · `.gitignore:53` `outputs/` · `.gitleaks.toml:28-40` narrowed MetaMask allowlist · `foundry.toml:8` `evm_version = "prague"` (→ matrix §9 N/A) · `ci.yml:32` `FOUNDRY_VERSION: "v1.7.1"` · `ci.yml:69-70` doc-counts in `workflow-lint` · `ci.yml:368` MetaMask 13.49.0 download · `publish.yml:68-74` required gitleaks · `publish.yml:129-161` npm-scope preflight
