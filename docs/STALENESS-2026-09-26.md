# Staleness & Technical-Consistency Audit — 2026-09-26

> ## 📌 SNAPSHOT DECLARATION — read before citing anything below
>
> **This file is a dated audit snapshot, not a live document.**
>
> 0. **Status at hand-off (re-verified after the ruling).** Of the findings, **F-04 has since
>    been fixed** — `packages/indexer/package.json` now declares
>    `bin: {"sigilkit-indexer": "./dist/cli.js"}`, so the `sigilkit-indexer` command exists and
>    §3.1's "the binary does not exist" is **no longer true**. **F-03, F-11 and F-15 all still
>    hold**; F-15's unrecognised claim site moved `:95` → `:103` and the recognised ones to
>    `L21/L101/L116` as `docs/STATUS.md` grew 267 → 351 lines, and its update rule (now `:311`)
>    still names only three sites. Denominators re-checked:
>    `docs/*.md` = 51, `vault/*.md` = 22, so F-16's 48 is still correct. Treat anything not
>    listed here as un-re-verified.
> 1. **Every count and every `:NNN` line anchor here is a 2026-09-26 measurement.** They were
>    true when measured and are **not** maintained. Re-run `npm run check:docs` and re-grep
>    before acting on any of them. This single declaration covers all of them; none is
>    individually maintained.
> 2. **The structural findings depend on no count and remain valid**: which claims are
>    unguarded, which binaries do not exist, which environment variable is undocumented, which
>    mitigation is absent, and the F-15 false-green mechanism.
> 3. **This file is deliberately not registered with `check-doc-counts.mjs`, and that is
>    correct** — see §10 item 14. The guard's own stated position is that it protects *live*
>    documents, not historical records: a snapshot that quoted a past number and "maintained"
>    it would be falsifying the record of what was true on the day.
> 4. **Its own numbers did drift, and that is on the record** — see the evidence below. Assume
>    any figure here may have moved; do not assume the documents it critiques are wrong.
>
> ## ⚠ Evidence that this file's own numbers drifted (kept, not deleted)
>
> This file was written to find documents whose numbers had gone stale. **Its own did.**
> While the audit was being written, `contracts/` and `scripts/` were being edited by other
> teams.
>
> | Figure | Quoted in body (session start) | Re-run (session end) |
> |---|---|---|
> | Foundry tests / suites | 158 / 14 | **220 / 17** |
> | forge-lint annotations | 49 | **56** |
> | guard's own success line | "…STATUS and TROUBLESHOOTING match…" | "…STATUS, TROUBLESHOOTING **and SECURITY** match…" |
> | 4 threat-map line anchors | 702 / 287 / 646 / 504 | **833 / 308 / 739 / 576** |
>
> The third row is the load-bearing one, because it is **self-evident**: the script's own
> success message gained a sixth guarded file. A script that does not change cannot change its
> own output. So the file really was rewritten mid-session — the `12:23:30Z` mtime is merely
> its *latest* write, not its only one.
>
> `README.md:45`, `TROUBLESHOOTING.md:166` and the whitepaper were updated in step and the
> guard is **green** on the new numbers — those documents are *fresher than this file*, not
> wrong. **The `158`, `14` and `49` figures below are a snapshot, not a current fact.**
>
> This is not a defect in those documents; it is this file failing the exact test it set for
> others (§5.4's lesson). Re-run `npm run check:docs` before acting on any number here. The
> *structural* findings — which claims are unguarded, which binaries do not exist, which env
> var is undocumented, which mitigation is absent — do not depend on counts and should survive.
>
> Where §3.4 says "real is 49" or "real is 158", read it as "real **at the time of
> measurement**; the doc under test was stale then, and the direction of the finding is
> unaffected."

**Scope:** `docs/` (27 files) + `vault/` (22 files) = 49 documents, as inventoried at session
start. `docs/` grew past 40 files during the session; the extra files are not classified here.
**Method:** every document read; 8 high-value documents deep-verified line-by-line against
`contracts/`, `packages/`, `scripts/`, `.github/workflows/`, `.env.example`.
**Authoritative counts** obtained by actually running the toolchain:
`FORGE_BIN=C:/Users/dev25/.foundry/bin/forge.exe node scripts/check-doc-counts.mjs` → exit 0.

> **This file is a diagnosis, not a fix.** It is read-only output. The doc-count guard already
> passes, so every finding below is a class of drift the guard does **not** cover — which is
> the point of the document.

---

## 0. TL;DR — the five things that matter

| # | Finding | Severity |
|---|---|---|
| 1 | `metamask:revoke-raw-rejected` canary is pinned to **12.5.0** in the allowlist, but CI fetches **13.49.0**. The threat map calls this canary the mitigation for a High-severity threat. | **Critical** |
| 2 | `docs/DEPLOYMENT.md` and `docs/CONFIGURATION.md` document the **same** env var with **contradictory** defaults (`SIGILKIT_OWNER_KEY` = Anvil #0 vs. "fails loudly if unset"). | **High** |
| 3 | `sigilkit-indexer` is used as a shell command in 3 documents. The package has **no `bin` field** — the command does not exist. | **High** |
| 4 | `SIGILKIT_AUDIT_DB_ROOT` — a **fail-closed security gate** — is documented in **zero** documents. Without it `audit_query` refuses every path. | **High** |
| 5 | `docs/STATUS.md` claims its layer tables are "exhaustive over `docs/`". **18 of 27** documents appear in no table. | **High** |
| 6 | `vault/README.md:3` says "21 notes" (real: 22) and — unlike STATUS's copy — **is unguarded**. Widening the guard to it is *not* one line: the existing regex cannot match the sentence, so the naive change turns a green build red. | **Medium** |

> **Update 2026-09-26 (post-publication).** Items 6 above and F-13/F-14 were contributed by
> **dc-translate** after the first draft; F-13 corrects an error in my own §1.2 grading.
> See §5.3 for the guard-design lesson, which is worth more than the number itself.
>
> **Second update.** Acting on §5.3 immediately found the same drift **one layer up, live**:
> a vault-count claim in `docs/STATUS.md` that the guard cannot see (the
> `Audit of the 22 \`vault/\` notes` row added for `docs/VAULT-AUDIT-2026-09-26.md`; `:95` when
> first measured, **`:103` after that file grew 267 → 351 lines**), missing from the file's own
> update rule, with `check-doc-counts.mjs --write` **leaving it wrong and reporting green**.
> That is **F-15** (§5.4) — a stronger argument for the `claimShape` fix than the original
> example, because the tool meant to repair drift ratifies it instead.
> F-14 also grew a third row (`solhint`, a tool absent from the entire repo).
>
> **Anchor warning, following dc-translate's C19.** `docs/STATUS.md` grew **84 lines** during
> hand-off, so *every* line number for it is now stale — including the ones in this file. The
> finding rests on **shape and text**, not position: grep
> `Audit of the` for the unrecognised claim, `notes` for the three recognised ones, and
> `` `22` occurrences `` for the rule. **Do not trust any line number for that file, including
> a freshly-added one.** The same applies to `check-doc-counts.mjs` and `ci.yml`.
>
> **Correction log for this file's own second draft.** Two claims in the first version of §5.4
> were **tested and withdrawn**: that the `all three` rule line was unguarded, and that the
> "both"→"all three" rewording had outrun its regex. Both were falsified by running the real
> patterns; dc-translate raised both. Five of my `check-doc-counts.mjs` line citations were also
> stale (the file was itself edited today) and are corrected in place — the same drift class
> this audit exists to catch, caught in my own document.
>
> **Third correction — and the sharpest one.** I then wrote that the script "was edited *before*
> the audit, and the 980-vs-1049 difference was only a same-day snapshot gap, not mid-session
> drift", reasoning from its `12:23:30Z` mtime. **That inference was wrong, and the file's own
> output disproves it:** the guard's success message gained a sixth guarded file
> ("…TROUBLESHOOTING **and SECURITY** match the toolchain"). A script that did not change cannot
> print a new sentence. The mtime is the *latest* write, not the only one — I read a timestamp as
> a history. dc-translate's mtime observation prompted the check that refuted me.
>
> **A reusable trap, recorded because it cost both of us a round.** "How many lines does this
> file have" has three defensible answers, and each of us silently picked a different one:
> `split('\n').length` = 1050 (includes the trailing empty string), total content lines = 1049,
> non-empty lines = 980 — and PowerShell's `Measure-Object -Line` returns the **non-empty**
> count, not the total. Both of us reported our number as "the line count" and then disagreed.
> **Always state the convention alongside the number**, or the disagreement is not a
> disagreement about facts.

> ### The rule underneath all of it
>
> Across five review rounds, **every** error either of us made — eleven in total — was the same
> move: **extrapolating a history or a cause from a single point observation.**
>
> | # | Observed | Assumed | Reality |
> |---|---|---|---|
> | 1 | a regex | it matched | 0 matches |
> | 2 | a note row | it claimed CI | it never said CI |
> | 3 | a line count | the file had drifted | direction right, conclusion crude |
> | 4 | an `mtime` | the file was static | **it was being rewritten — a real fact denied** |
> | 5 | a status line | it was contradictory | it was correctly guarded |
> | 6 | "unregistered ⇒ will rot" | — | **true, and it happened to this file** |
>
> **A point sample never carries history.** Prefer **behavioural evidence** (the program's own
> output changed) and **unarguable structural counts** (`checkDocument(` call sites: 0 in HEAD,
> 5 in the working tree) over any reasoning about timestamps or magnitudes. dc-translate's
> formulation: settle it with behaviour and structure, never with inference from a sample.
>
> Note the asymmetry in row 4: inferring a change from a stale count is a *weak* error, but
> inferring **no** change from a stable `mtime` is a *strong* one — it actively denies a fact
> that was true. Operationally: **a wrong loud claim is safer than a right quiet one** — a false
> positive costs a re-read, a false negative suppresses the next check.
>
> ### The most dangerous shape: asserting that something is *absent*
>
> Three of the eleven errors (C1 "the regex matches", C7 "the note claims CI", C15 "the file
> cites no counts") are one move: **claiming a product does not contain something.** All three
> were wrong, and C15 was caught by *testing the claim* rather than accepting it — dc-translate's
> file does contain 33 line anchors and 54 figures.
>
> This is the project's own specialty: its reputation is catching fabricated claims. So the
> finding is not "reviewers were careless" but the sharper form —
>
> > **The people most likely to be caught by this project's core capability are the people
> > using it.** An audit that verifies every number in the tree but never checks whether its own
> > output contains a claim is auditing the wrong artifact.
>
> Concrete form, worth stealing: **an absence claim must be measured, never inferred.** C15 was
> settled by one command (`Select-String` for anchors and figures) after four rounds of
> reasoning about it.
>
> **This is not only a documentation-team failure mode — it reproduces across every team that
> uses this repo's tooling**, so the rule belongs at the repo level, not in one audit:
>
> | Who | Asserted | Measured reality |
> |---|---|---|
> | ck-evt | "the artifact format is unconstrained" | `.gitattributes` already constrained it |
> | sc-clean | "tracked + ignored = a violation" | that is git's normal state, not a defect |
> | dc-translate | "cites no counts at all" | 33 line anchors + 54 rot-prone figures |
> | dc-translate | "45 of 51 docs are unregistered" | `51 − 6` mixed a repo-level count into a `docs/` total; **48** |
> | me | "the rule line is self-contradictory" | it is correctly guarded; I had not read the regex |
> | me | "unregistered ⇒ this file is the weakest document" | unregistered is **correct** for a dated snapshot |
>
> Six instances, three teams, one shape. The unifying observation: **nobody on this project
> publishes a fabricated market number, yet the serious errors are all fabricated claims** —
> about regex behaviour, line counts, file contents, CI gates and arithmetic scope. The blind
> spot is not credibility, it is verifying one's own output.
>
> **A sub-shape worth naming separately, because it recurred within one team.** dc-translate's
> C13 ("state the convention alongside the number") was followed immediately by C16 — the same
> mistake wearing different clothes. C13 was about *line-count convention*; C16 was about
> *scope*: `51 − 6` is valid arithmetic and meaningless evidence, because three of the six were
> never in the 51. **A number correct inside one scope, presented as if it were universal.** The
> common failure is not doing the arithmetic wrong — it is that **the operation looked so
> natural that nobody checked its units.**
>
> dc-translate's closing observation, which I endorse and adopt as this audit's own lesson:
> *the people most likely to be caught by this capability are the people using it.* Nobody
> involved would have shipped a fabricated number, and yet every serious error here was a
> fabricated claim — about regex behaviour, line counts, file contents and CI claims rather
> than about market figures. **The blind spot is not credibility, it is verifying one's own
> output.**

> ### What this file got right by accident, and wrong on purpose
>
> The structural findings do not depend on counts, and that was luck rather than design — I
> cited 39 guarded figures before noticing. This file is **not registered with any guard**
> (`check-doc-counts.mjs` contains no reference to it), so by its own §5.4 rule it is a
> document that can rot silently. It has already rotted once, as the banner records.
>
> The comparison that clarifies it, measured on both files with the same command:
>
> | | `VAULT-AUDIT` (dc-translate) | this file |
> |---|---|---|
> | registered with a guard | ❌ | ❌ |
> | line anchors (`:NNN`) | 33 (21 unique) | 204 (122 unique) |
> | rot-prone figures quoted | 54 | 92 |
> | has it rotted? | not yet | **yes, once** |
>
> dc-translate's file is *hard to rot* because those figures are **quoted from someone else's
> rot**, not asserted on its own authority — a repo-wide recount will not falsify them. That is a
> weaker property than being guarded, and the distinction matters: *hard to rot* is a property
> of the claims; *guarded* is a property of the registration. **This file has neither** — and
> after the team-lead ruling (§10 item 14) that is now **correct rather than a defect**: the
> guard's stated position is that it protects live documents, not dated snapshots, so a dated
> audit *should* be unregistered. The genuine defect was never the absence of a guard; it was
> the absence of a **declaration** that these figures are a snapshot. That is now fixed.
>
> **And a boundary I got wrong for five rounds.** I asked dc-translate five times to register
> this file or strip its counts. They declined, and the reasoning is correct: *the finding is
> mine; the disposition belongs to the document's owner.* Registering it means editing a shared
> guard and someone else's file, which a read-only audit has no business doing. Repeating the
> request five times was me trying to make my own rot-risk someone else's problem. Item 14 now
> records which half of that decision **is** mine (strip the counts — it touches only this file)
> and which half is not (register it), instead of outsourcing both.
>
> dc-translate named the failure more precisely than I did, and I am borrowing their wording:
> **"a repeated request is not authorisation, and a peer cannot supply authority you are
> missing from your own scope."** Five identical asks were not persistence; they were an attempt
> to obtain permission I could have simply taken, on one of the two options, myself.
>
> They also credited the choice I made on (b) — keeping the evidence rather than deleting it to
> make my own audit pass — as "a rarer instinct than choosing the option that suits you". That is
> generous, and the underlying rule is the right one: **an audit must not delete the evidence it
> exists to preserve.** Stripping the counts would have made this document look compliant with a
> rule it is written to criticise.

---

## 1. Classification table (49 documents)

Legend: **live** = accurate · **stale** = partly wrong · **obsolete** = superseded/false as written ·
**duplicate** = restates another document.

### 1.1 `docs/` (27)

| # | File | Verdict | Reason (with evidence) |
|---|---|---|---|
| 1 | `WHITEPAPER-v2.1.md` | **live** | `check-doc-counts` passes: 158 tests / 14 suites / 14 jobs / 11 Halmos specs all match. Its own "Working tree (2026-09-17)" note is honest about uncommitted state. |
| 2 | `STATUS.md` | **stale** | Says layer tables are "exhaustive over `docs/`" (L112) — 18/27 files are unclassified. See §5.1. |
| 3 | `GETTING-STARTED.md` | **stale** | Line 128 "Once installed, the same commands are available as `sigilkit-indexer …`" — no such bin. §3.3. |
| 4 | `CONFIGURATION.md` | **stale** | Omits `SIGILKIT_AUDIT_DB_ROOT` (a hard security gate) and `SIGILKIT_CREATE2_SALT`; contradicts DEPLOYMENT on `SIGILKIT_OWNER_KEY`. §3.1, §3.2. |
| 5 | `DEPLOYMENT.md` | **stale** | `sigilkit-indexer` commands; MCP example cannot work; recommends `sqlite3` absent from the image; claims "no git remote". §3.1–3.4. |
| 6 | `SECURITY-7702-THREAT-MAP.md` | **stale** | 4 of 10 rows carry line anchors that no longer resolve; row 4's canary pin is wrong. §4. |
| 7 | `PLAN-30-DAYS-2026-09-23-to-2026-10-22.md` | **live** (as plan) | Checkboxes match reality — verified 12/12 completed items. §6. |
| 8 | `RESEARCH-NUMBERS.md` | **live** (attribution) | Every row cites a source; honest Primary/Secondary split. Numbers themselves unverifiable offline. §7. |
| 9 | `TROUBLESHOOTING.md` | **live** | "49 such annotations" matches the guard exactly. All commands valid. |
| 10 | `CI-WAIVERS.md` | **stale** | "The repo currently has no git remote" (L8) — a remote now exists. Slither section is dated 2026-09-23. |
| 11 | `AC-01-SCRUB-PLAN.md` | **live** (as plan) | Explicitly "PLAN, unexecuted". Claims verified: `.gitleaks.toml`, `install-gitleaks.sh` exist. |
| 12 | `ECOSYSTEM-RESEARCH-2026-09-23.md` | **live** (as snapshot) | Primary-source URLs throughout; §6 "Gaps" is exemplary. Point-in-time by construction. |
| 13 | `VERIFICATION-STRATEGY-2026-09-25.md` | **stale** | Describes pre-fix state; several findings since fixed. §8. |
| 14 | `VERIFICATION-STRATEGY-2-CI-UAT.md` | **stale** | "12 job 分析" — now 14. §8. |
| 15 | `ISSUES-CATALOG-2026-09-25.md` | **live** (as plan) | Latest catalog; its A-section P0-1/P0-2 are reflected in README. |
| 16 | `NEW-ADDITIONS-2026-09-25.md` | **live** | Its E-3 finding (`indexer` has no `bin`) is **still true today** — independently confirmed. |
| 17 | `ENHANCEMENTS-2026-09-25.md` | **live** (as plan) | Suggestions, not claims about current state. C-04 is partially landed (`onlyOwner` self-seeds at L192). |
| 18 | `ADVANCED-FEATURES-1-CONTRACTS-DATA.md` | **live** (as plan) | Proposals. |
| 19 | `ADVANCED-FEATURES-2-SDK-OBS-ECO.md` | **live** (as plan) | Proposals. |
| 20 | `ADVANCED-FEATURES-3-ECOSYSTEM.md` | **live** (as plan) | Proposals. |
| 21 | `PROJECT-REVIEW-2026-09-17.md` | **stale** | Header pins "115 contract tests; 262 TypeScript" — real is 158 / 337+. §8. |
| 22 | `Enhancements-2026-09-12.md` | **obsolete** | Superseded by `ENHANCEMENTS-2026-09-25.md`; baseline `master @ 38fe1cd`. |
| 23 | `Issues-Catalog-2026-09-11.md` | **obsolete** | Baseline `master @ f3e3fce`; all 23 items closed. |
| 24 | `Issues-Catalog-2026-09-12.md` | **obsolete** | Superseded; STATUS marks SUPERSEDED. |
| 25 | `Issues-Catalog-2026-09-17.md` | **obsolete** | STATUS marks SUPERSEDED by 09-21/09-25. |
| 26 | `Issues-Catalog-2026-09-21-Agent-Review.md` | **stale** | Still labelled ACTIVE; AC-32/33 closed 2026-09-23 *within this file*, and its own §Traceability still counts them as open Medium. |
| 27 | `Issues-Catalog-2026-09-23-C-Performance.md` | **live** (as plan) | Performance stream, no completed-task claims. |

**Tally (`docs/`)**: live **17** · stale **7** · obsolete **3** · duplicate **0**.

> **Unverified as of 2026-10-01 — 上表第 9 行（`TROUBLESHOOTING.md`）判为 "live" 所依据的
> "'49 such annotations' matches the guard exactly. All commands valid." 未在本轮复核，保持原文未改。** 同组审计文件对
> forge-lint 注解数给出互斥的值：`docs/PLAN-STATUS-2026-09-26.md` §9.1b 记门禁报 **54**
> （"TROUBLESHOOTING says 49 → 54"）、`docs/NUMBERS-2026-09-26.md` §1 基线表与 §7 记 **49**、`docs/VERIFICATION-STRATEGY-2026-09-25.md` §1.2 L0 行记 **33**。本轮无法执行
> `node scripts/check-doc-counts.mjs`（不在本文件集内），**故本表不把 "matches the guard exactly" 改写为任何其他数字**；在重跑门禁并记录日期前，
> 该单元格不得被引用为"门禁已验证通过"。同一行的 "All commands valid" 同样未经本轮复核。
>
> 相邻观察（同一注释，非本轮指定项）：上表第 1 行称 `check-doc-counts` "passes: 158 tests / 14 suites / 14 jobs /
> 11 Halmos specs all match"，而 `docs/PLAN-STATUS-2026-09-26.md` §9.1b 记录同一天该门禁以 **exit 1** 结束并报 9 条
> drift（158 → 211、14 → 17、49 → 54）。两处均为原文保留，本轮未判定对错。

### 1.2 `vault/` (22)

STATUS classifies all of `vault/` as one L4 line ("22 notes"). Individually:

| File | Verdict | Reason |
|---|---|---|
| `00 MOC.md` | **live** | Index; still resolves. |
| `README.md` | **stale** | `:3` says "21 private research notes"; the directory holds **22** (`.obsidian/` is the only non-`.md` entry and is not counted by `vaultNoteCount()`). The number sits in the directory's own front door, and — unlike `docs/STATUS.md`'s — it is **unguarded**: `checkStatusCounts`'s regex `/(\d+) notes\b/` cannot match `"21 private research notes"`, so the guard would fail-closed rather than catch it. Correction first reported by dc-translate, 2026-09-26; my initial pass wrongly graded this **live**. See §5.3. |
| `Memory Index.md` | **live** | 7-line index. |
| `SigilKit Overview.md` | **stale** | Says v2.0 whitepaper is at `SigilKit_Whitepaper.pdf` — both `.pdf` and `.txt` exist; STATUS calls the `.txt` SUPERSEDED. Also still describes the project as "audited" (pre-audit banner now mandatory). |
| `Sources.md` | **live** (as snapshot) | Aug-2026 URL list. |
| `Whitepaper Corrections.md` | **live** | The correction trail STATUS points to. |
| `Academic Literature.md` | **live** (as snapshot) | arXiv IDs + nuance. |
| `Competitive Landscape.md` | **live** (as snapshot) | Flags its own UNVERIFIED items. |
| `Global Adoption.md` | **live** (as snapshot) | |
| `Agent Architecture.md` | **live** | Pins 0.8.36 — matches `foundry.toml`. |
| `Verified Build Stack 2026.md` | **stale** | Aug-2026 pins. `typescript: ^7.0.2` in packages is far past anything an Aug-2026 sweep would list. |
| `Comprehensive Analysis 2026-08-24.md` | **stale** | Aug-2026; predates the 7579 module landing. |
| `Audit Raw Findings 2026-08-24.md` | **stale** | Aug-2026 raw agent output. Its flagship finding (wallet legs are stubs) is **still substantially true** — `metamask:type4-*` still self-documents "no live-harness coverage". |
| `Milestones.md` | **stale** | Aug-2026 milestones; no 7702/Pectra-era entries. |
| `Research Summary.md` | **stale** | Cites the Aug-2026 thesis (4 components incl. Diamonds + Multi-RPC), both since dropped. |
| `Build Plan.md` | **obsolete** | L40 "UUPS under 2-of-3 Gnosis Safe + 24h TimelockController" — **contradicts** `SECURITY.md`'s immutable-by-design. `NEW-ADDITIONS` D-scope flags this exact conflict, unfixed. |
| `Risk & De-risk Plan.md` | **stale** | Reasons about a Diamonds component that was replaced. |
| `Funding Audit Bounty.md` | **live** (as snapshot) | |
| `Component 1 — EIP-7702 Wallet Library.md` | **stale** | Component framing predates the delegator shipping. |
| `Component 2 — EIP-2535 Diamonds Module.md` | **obsolete** | The component was **replaced** by ERC-7579 (whitepaper v2.1 §Components). |
| `Component 3 — Multi-RPC Provider.md` | **obsolete** | **Dropped** by whitepaper v2.1. |
| `Component 4 — Agent Session-Key Manager.md` | **stale** | The surviving component, but pre-implementation framing. |

**Tally (`vault/`)**: live **9** · stale **10** · obsolete **3** · duplicate **0**.
(Corrected 2026-09-26: an earlier draft of this file graded `vault/README.md` **live**;
it is **stale**. See §5.3.)

### 1.3 Duplicates

No true duplicates. Three **near-duplicate pairs** worth noting:

- `vault/Component 2` vs `vault/Component 3` are both dead but neither says so — a reader
  landing on them has no signal. Recommend a one-line SUPERSEDED banner on each (as
  `SigilKit_Whitepaper.txt` already has).
- `docs/Issues-Catalog-2026-09-21` §Traceability vs its own §"AC-32/33 FIXED" block —
  internally inconsistent (see §6.2).
- `docs/CONFIGURATION.md` vs `docs/DEPLOYMENT.md` on `SIGILKIT_OWNER_KEY` — not a duplicate,
  a **contradiction** (§3.1).

---

## 2. What the `check-doc-counts` guard actually covers

Knowing the boundary explains why the drift exists. From `scripts/check-doc-counts.mjs`:

| Guarded | How |
|---|---|
| `README.md` test/suite/job/Halmos/Echidna/invariant counts, per-workflow breakdown | `checkReadmeCounts` |
| `docs/WHITEPAPER-v2.1.md` same counts (prose) | `checkWhitepaperCounts` |
| `CHANGELOG.md` **current `[Unreleased]` entry only** | `checkChangelogCounts` |
| `docs/STATUS.md` vault note count (both occurrences) | `checkStatusCounts` |
| `docs/TROUBLESHOOTING.md` forge-lint annotation count | `checkTroubleshootingCounts` |
| `.well-known/security.txt` presence + unexpired `Expires` | `checkSecurityTxt` |

**Not guarded → this is where all findings below live:**

- No env-var inventory gate. Nothing checks `.env.example` against `readEnv*` call sites.
  (`NEW-ADDITIONS` C-8 proposes exactly this; still open.)
- No "every CLI has a `bin`" gate.
- No cross-document contradiction gate.
- No claim-to-line-anchor check. The threat map's `SessionKeyManager.sol:524` style anchors
  are unverifiable by machine and all four checked ones are wrong.
- `check-doc-counts` exits 0 today — **this audit is entirely about the unguarded surface.**

---

## 3. Technical-assertion mismatches (core deliverable)

Severity: **Critical** = security claim untrue · **High** = user-facing instruction does not
work / security control undocumented · **Medium** = wrong number or anchor · **Low** = cosmetic drift.

### 3.1 CRITICAL / HIGH — environment & commands

---

**F-01 · `CONFIGURATION.md:36` — owner-key default contradicts `DEPLOYMENT.md:39`**
· Severity **High**

- **Doc says** (`CONFIGURATION.md:36`): `SIGILKIT_OWNER_KEY` default = "Anvil account #0".
- **Also says** (`DEPLOYMENT.md:39-40`): "The script **fails loudly** if `SIGILKIT_OWNER_KEY` is
  unset — it never falls back to a well-known key."
- **Actual** (`contracts/script/Deploy.s.sol:25`): `uint256 broadcasterKey = vm.envUint("SIGILKIT_OWNER_KEY");`
  — `vm.envUint` **reverts** when unset. There is no Anvil default in the deploy path.
- **Who is right**: DEPLOYMENT. The Anvil-#0 default *does* exist, but only in the demo/test
  path — `packages/demo-agent/src/devkeys.ts:44`. CONFIGURATION's table conflates the two.
- **Impact**: an operator following CONFIGURATION believes a deploy works with no env; it reverts.
  Following DEPLOYMENT they believe the SDK falls back to Anvil #0; it does not.

**F-02 · `DEPLOYMENT.md:34` vs `CONFIGURATION.md:39-41` — Anvil #0 key handling**
· Severity **High**

- **Doc says** (`DEPLOYMENT.md:34`): paste
  `SIGILKIT_OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` inline.
- **Actual**: that exact key is hardcoded in **6 source files** as a default
  (`packages/demo-agent/src/devkeys.ts:44`, `test/agent.test.ts:26`, `test/smoke.e2e.test.ts:27`,
  `test/conformance.test.ts:28`, …). CONFIGURATION correctly notes these are allowlisted in
  `.gitleaks.toml` as public fixtures — but DEPLOYMENT presents it as a copy-paste
  *deployment* credential with no such caveat. A reader may reuse it on a real network.
- **Note**: `.gitleaks.toml` **does** exist and does allowlist it — the mitigation works, but
  only DEPLOYMENT lacks the warning.

**F-03 · `SIGILKIT_AUDIT_DB_ROOT` — a fail-closed security gate documented nowhere**
· Severity **High** (security control invisible)

- **Docs say**: `CONFIGURATION.md:75-83` lists the complete MCP/indexer env surface
  (`SIGILKIT_DB_PATH`, `SIGILKIT_MANAGER`, `SIGILKIT_INDEXER_CHAIN_ID`,
  `SIGILKIT_CONFIRMATIONS`, `SIGILKIT_MAX_BLOCK_RANGE`, `SIGILKIT_LOG_LEVEL`,
  `SIGILKIT_LOG_FORMAT`). `.env.example` lists the same 17 vars — **neither includes this one.**
- **Actual** (`packages/mcp/src/server.ts:244`):
  `audit_query is disabled because SIGILKIT_AUDIT_DB_ROOT is not set.`
  At `server.ts:104-106`: "When it is unset the tool refuses EVERY path. Fail-closed."
- **Impact**: `DEPLOYMENT.md:207-217` shows an MCP config that sets only
  `SIGILKIT_LOG_LEVEL`. Copied verbatim, **`audit_query` is inert** — one of the four advertised
  tools silently does nothing, and the operator has no documented way to enable it.
  The control itself is excellent (SEC-04, no filesystem-existence oracle); it is simply
  undocumented, which makes it look broken.

**F-04 · `sigilkit-indexer` binary does not exist** — ✅ **RESOLVED since this audit**
· Severity **High** *(at time of finding)*

- **Docs say**: `GETTING-STARTED.md:128` "Once installed, the same commands are available as
  `sigilkit-indexer …`"; `CONFIGURATION.md:116,165` use it as a runnable command;
  `TROUBLESHOOTING.md` uses it 6×; `DEPLOYMENT.md:183-184` uses it as the primary run command.
- **Was** (`packages/indexer/package.json`): **no `bin` field.** Only
  `exports["./cli"]` → `./dist/cli.js`. By contrast `packages/mcp/package.json` had
  `"bin": {"sigilkit-mcp": "./dist/cli.js"}`.
- **Confirmed independently**: `NEW-ADDITIONS-2026-09-25.md:230` (E-3) reached the identical
  conclusion and rated it P0/30 min. Unfixed for one day after the catalog entry.
- **Now** (re-verified at hand-off): the package declares
  `bin: {"sigilkit-indexer": "./dist/cli.js"}`. **The command exists and every one of those
  document references is now correct.** The finding is closed.
- **Note on who fixed it**: this is the one finding in this audit that a teammate closed while
  it was being written. It is recorded here rather than deleted, because "the audit found it
  and it got fixed" is the useful part — not that the file is currently wrong.

**F-05 · `DEPLOYMENT.md:219-221` — MCP `audit_query` description omits its precondition**
· Severity **High**

- **Doc says**: "`audit_query` takes the database path per call and opens it read-only. It never
  creates directories, tables or rows — pointing it at a missing file returns a 'database not
  found' result instead of writing anything."
- **Actual** (`server.ts:628`): the tool description states the path "must resolve inside a
  directory whitelisted by the operator in SIGILKIT_AUDIT_DB_ROOT; when that variable is unset
  the tool refuses every path, so this tool is inert until it is configured."
- **Impact**: the doc's safety claim is *correct but incomplete* — it describes only the
  read-only half of the control and omits the allowlist half. An auditor reading DEPLOYMENT
  would not learn the filesystem-existence-oracle defence exists at all.

**F-06 · `DEPLOYMENT.md:192,270` — recommends `sqlite3`, absent from the shipped image**
· Severity **Medium**

- **Doc says**: `sqlite3 audit.db ".backup backup.db"` for backups; repeated in the reorg
  recovery row.
- **Actual** (`Dockerfile:35`): `FROM node:24-bookworm-slim AS runtime` — no `apt-get install
  sqlite3` anywhere in the file. The documented backup command cannot run in the container the
  same document tells you to deploy.
- **Corroborated**: `NEW-ADDITIONS-2026-09-25.md:128` reached the same conclusion
  ("文档推荐的恢复命令在交付镜像里跑不了") and proposed C-2 (`VACUUM INTO`) as the fix. Open.

**F-07 · `DEPLOYMENT.md:246` — "The README/GETTING-STARTED `git clone` fails"**
· Severity **Medium**

- **Doc says**: prerequisite #1 is unresolved; "The README/GETTING-STARTED `git clone` fails".
- **Actual** (`git remote -v`): `origin https://github.com/dev25bansal-ops/sigilkit.git` —
  **a remote now exists**. The real remote is `dev25bansal-ops/sigilkit`, not the
  `sigilkit/sigilkit` that `GETTING-STARTED.md:23` tells users to clone and that every
  `packages/*/package.json` declares as `repository.url`.
- **Impact**: the blocker is still real (the declared URL ≠ the actual URL), but the
  description is now wrong in a second way, and the fix is a one-line `repository.url` fix
  that DEPLOYMENT itself describes at L251-252.

**F-08 · `CI-WAIVERS.md:8` — "The repo currently has no git remote"**
· Severity **Medium**

- **Doc says**: "The repo currently has no git remote, so GitHub issues are not yet available
  as a tracker."
- **Actual**: a remote exists (above). Rationale for the file's existence is now wrong, though
  the file is still validly an L2 register (STATUS L37).
- **Also**: the file carries no "verified on" date for that claim, so nothing catches it.

**F-09 · `CONFIGURATION.md` — `SIGILKIT_CREATE2_SALT` missing**
· Severity **Medium**

- **Doc claims** (L3): "Every setting SigilKit reads from the environment."
- **Actual**: `contracts/script/DeployDeterministic.s.sol:29` reads `SIGILKIT_CREATE2_SALT` via
  `vm.envBytes32` and reverts when zero (L30). `DEPLOYMENT.md:69` documents it. `CONFIGURATION.md`
  and `.env.example` omit it. The "every setting" claim is false.

**F-10 · `DEPLOYMENT.md:136` — "The workflow publishes in dependency order"**
· Severity **Low** (verified correct, noted for completeness)

- Claimed order `core → indexer → mcp` is consistent with the actual dependency graph
  (`mcp` depends on both `core` and `indexer`). No action.

**F-13 · `vault/README.md:3` — "21 private research notes"**
· Severity **Medium** (corrected finding — see §5.3)

- **Doc says**: "This directory holds **21** private research notes".
- **Actual**: 22 `.md` files. (`vault/.obsidian/` is the only non-`.md` entry, and
  `vaultNoteCount()` at `check-doc-counts.mjs:643-647` filters on `.endsWith(".md")`, so it is
  correctly excluded — the guard's own number, 22, is right.)
- **The gap**: `docs/STATUS.md`'s "22" *is* guarded; this one is not, and cannot be with the
  current regex. See §5.3 for why the obvious fix is not as cheap as it looks.
- Credit: first reported by **dc-translate**, 2026-09-26. My initial pass graded this file
  **live** and was wrong.

**F-14 · `vault/Verified Build Stack 2026.md:10-12` — three toolchain rows contradict the repo**
· Severity **Medium** (found while verifying dc-translate's pin-rot claim; extends it twice)

| Tool | `vault/Verified Build Stack 2026.md` | Actual | Where |
|---|---|---|---|
| **Slither** | `6.2.4` (L11) | **`0.11.6`** | `ci.yml:126`, `publish.yml:61` |
| **Echidna** | `2.3.3` (L10) | **`v2.2.5`** | `ci.yml:417` (`echidna-version:`) |
| **solhint** | `6.2.4` (L12) | **does not exist anywhere** | zero hits across `.github/workflows/*.yml`, `package.json`, `packages/*/package.json`, `scripts/*.mjs` |

- dc-translate cited the Slither half as "pin 腐坏的实证" — confirmed, and it is worse than one
  stale number: **the note carries three rows and all three disagree with the repo.**
- Note the trap: `6.2.4` and `0.11.6` are both real Slither releases, so a reader gets no signal
  that the number is wrong. `ci.yml:126` pins by `==`, so the pipeline is deterministic and
  correct — **only the note is false.**
- **The solhint row is a different *kind* of error, and I corrected dc-translate's framing here.**
  They described it as "the note claims a CI gate that does not exist". The row actually reads
  `| **solhint** | 6.2.4 | Lint; defer formatting to forge fmt. |` — it makes **no CI claim
  whatsoever**. The real defect is quieter: the note lists `6.2.4` for **two different tools**
  (Slither L11, solhint L12), which is copy-paste, and solhint is listed as part of a
  "Verified Build Stack" when nothing in the repo uses it. So it is a **phantom tool entry**,
  not a phantom CI gate. The consequence is the same class — a reader concludes Solidity lint
  is covered — but the claim to strike is "this tool is in the stack", not "CI enforces it".
- **Scope correction, now agreed between us**: T-02's instinct to extend the guard is right, but
  a *version pin* is not a derivable count, and `check-doc-counts` has no version-comparison
  mechanism. **Refinement to my own earlier wording**: I said the guard "has no mechanism to
  compare a documented version string against a workflow pin" — that was *overstated*.
  `metamaskPinFromCi()` (`check-doc-counts.mjs:617-620`) does exactly that for MetaMask, and
  `checkChangelogCounts` uses it (`:463-467`). So a precedent already exists; the accurate
  statement is "no *general* version guard, but one single-string precedent to follow."
  dc-translate caught this overstatement. It makes the extension cheaper to scope, not dearer.
- **Split the two proposals** so the cheap one ships now and the expensive one is not hidden
  behind a "one line" promise that has already failed once in this audit (§5.3).

---

### 3.2 CRITICAL — security: the threat-map canary pin

**F-11 · `SECURITY-7702-THREAT-MAP.md:14` — High-severity mitigation rests on a canary pinned to a superseded wallet build**
· Severity **Critical**

- **Doc says** (row 4, "One signed authorization tuple = persistent control", Severity **High**):
  > Mitigation: "Mitigated-by-test: harness asserts raw zero-address revoke is REJECTED by
  > MetaMask (**canary PASS 13.49.0**)"
  and row 9 repeats "Mitigated: canary PASS on **13.49.0**".
- **Actual** (`packages/core/test/WALLET_BEHAVIOR_ALLOWLIST.json:38`):
  ```json
  "id": "metamask:revoke-raw-rejected",
  "expected": "rejected",
  "verifiedOn": "extension 12.5.0 (2026-08 live harness via Playwright + persistent Chromium)"
  ```
  The allowlist — the file `run.ts:515-516` loads and asserts against — says **12.5.0**.
  **Re-verified on the end-of-session tree: still `12.5.0`, still at L38.** This finding did
  not decay while the rest of the corpus moved, which makes it the most durable item here.
  CI fetches **13.49.0** (`ci.yml`, confirmed by `check-doc-counts` output:
  `MetaMask pin (ci.yml): 13.49.0`).
- **The third value**: `metamask:13x-gesture-request-ui` is `verifiedOn: extension 13.48.0`
  — a *third* build. So three documents/tools reference three different MetaMask builds.
- **Why this is Critical, not Medium**: `check-waivers.mjs` fails the build when a
  `continue-on-error` waiver expires, and the threat map's row 4/9 action is "keep the canary
  in every wallet leg run (W-1)". The canary's *pass* is asserted against a 12.5.0 record
  while running against a 13.49.0 build. The assertion still functions (it checks
  `entry.expected === "rejected"`), but the **evidence backing a High-severity security claim
  is 11 months stale and names a different build than the one CI exercises.** A reviewer
  auditing row 4 would conclude the mitigation is verified on 13.49.0; the repo says 12.5.0.
- **Compounding**: `CHANGELOG.md`'s MetaMask pin *is* guarded (`checkChangelogCounts` compares
  against `ci.yml`). The allowlist's `verifiedOn` is **not** guarded by anything.
- **Suggested owner action**: update `verifiedOn` to the build actually exercised, and add
  an `allowlist-integrity` check asserting `verifiedOn` matches the `ci.yml` pin.
  (`VERIFICATION-STRATEGY-2026-09-25.md:106` already proposed this test as mandatory. Not written.)

**F-12 · `NEW-ADDITIONS-2026-09-25.md:172` — E10 countersign is incompatible with a Safe owner; DEPLOYMENT recommends a Safe**
· Severity **Critical** (correct finding, but it contradicts another doc and is unfixed)

- **`NEW-ADDITIONS` correctly states**: `SessionKeyManager.sol:469` validates the owner approval
  with `_ecrecover(approvalDigest, ownerApproval) != s.owner`, and `_ecrecover`
  (`SessionKeyManager.sol:829-830`) accepts only 65-byte ECDSA. A Safe is a contract and can
  never be an `ecrecover` result. ⇒ **if the owner is a Safe, every action above
  `countersignAbove` is permanently unusable.**
- **Verified**: correct. `SessionKeyManager.sol:457-471` is exactly as described.
- **The contradiction**: `DEPLOYMENT.md:51-53` instructs "On any persistent network, set it to a
  Safe (or a TimelockController behind one)". Combined with a scope using
  `countersignAbove != 0`, the documented production posture is broken.
- **Status**: this is a *known, documented* defect, not a discovery. It is listed here because
  it is the single most consequential live inconsistency between two "current" documents, and
  `DEPLOYMENT.md` does not carry the caveat.
- **Related, lower severity — `vault/Build Plan.md:40`**: "UUPS under 2-of-3 Gnosis Safe + 24h
  TimelockController" directly contradicts `SECURITY.md`'s immutable-by-design posture.
  `NEW-ADDITIONS:199` explicitly calls this out and proposes a doc-layer reconciliation.
  Unfixed.

---

### 3.3 MEDIUM — line anchors in the threat map

Every code anchor in `SECURITY-7702-THREAT-MAP.md` that names a line number was checked.
**All four are wrong** — and they got wronger: `SessionKeyManager.sol` was 748 lines when the
map was written and the contracts grew *again* during this audit, so the true position moved a
second time. Two snapshots are given; both are wrong, which is the point.

| Doc ref | Doc claim | Actual (session start) | Actual (re-run) | Severity |
|---|---|---|---|---|
| row 3, `SECURITY-7702-THREAT-MAP.md:13` | `_recover` at `SessionKeyManager.sol:524` | `:702` | **`:833`** | Medium |
| row 5, `:15` | `SessionKey7579Module.validateUserOp` at "line 193" | `SessionKey7579Module.sol:287` | **`:308`** | Medium |
| row 6, `:16` | `_domainSeparator()` at `SessionKeyManager.sol:499` | `:646` | **`:739`** | Medium |
| row 10, `:20` | `getNonce` at "line 361" | `:504` | **`:576`** | Medium |

**No machine check can catch this class**, which is why it is worth reporting at all: the
anchors are prose, they rot silently, and a security document that says "line 524" sends a
reviewer to the wrong place to verify a High-severity claim. A relative anchor
("the only `extcodesize` use in `SessionKeyManager`") would survive every one of these edits —
and there is exactly one of them, which is verifiable today.

The *substance* of every row is correct — I re-verified each:

All re-verified on the **end-of-session** tree; every one still holds in substance, and every
line number moved again:

- **Row 1** (zero `tx.origin`): confirmed — 0 matches, re-checked after the contracts grew.
- **Row 3** (`extcodesize`): confirmed — exactly one code use, `SessionKeyManager.sol:815`,
  inside `_recover`. (L817 is a comment about it, not a second use.)
- **Row 5** (`msg.sender == userOp.sender`): confirmed at `SessionKey7579Module.sol:316`.
- **Row 5** (no unsigned path to the executor): confirmed —
  `ActionLog7579Executor.sol:173` `if (msg.sender != account) revert NotAccount();`
- **Row 6** (domain separator binds `block.chainid`): confirmed at `SessionKeyManager.sol:739`.
- **Row 7** (fixed designator): confirmed, `DELEGATION_PREFIX = "0xef0100"` at
  `packages/core/src/eip7702.ts:348`.
- **Row 6 / W3-4.1 status**: the SDK guard it defers to **already exists** —
  `assertDelegationScope` (`eip7702.ts`) rejects `chainId == 0` unless
  `allowAllChains === true`. The threat map still lists it as pending work.
  **This is a stale "open" item, not a missing mitigation** — good news, mislabelled.
- **Row 10 / W3-4.1 nonce non-reuse**: already rejects an out-of-range `chainId` and the tuple
  serializer is strict. Partially landed.

---

### 3.4 MEDIUM — the verification-strategy documents describe a fixed past

`docs/VERIFICATION-STRATEGY-2026-09-25.md` is a **pre-remediation snapshot**. Since 2026-09-25
several of its headline findings were fixed. It never says so.

| Doc line | Claim | Actual today |
|---|---|---|
| `:11` F-A1 | "**Foundry fuzz 层实际为空**：`fuzz.runs` 被 0 个测试消费 … `vm.assume`/`vm.bound` **0 处**" | **STILL TRUE.** `grep "function testFuzz_"` → **0 matches** across `contracts/`, re-verified on the end-of-session tree (which grew to 220 tests / 17 suites — the added tests are still not fuzz-parameterised). `fuzz.runs = 2000/10000` in `foundry.toml:28-36` still has no consumer. **This is a live, unfixed finding, and 62 new tests did not fix it.** |
| `:12` F-A2 | "**HalmosAuth 5 个规格可被平凡满足**" | **FIXED.** `HalmosAuth.t.sol:91` has `modifier atLiveClock()`; all 5 checks carry it (L129,139,153,162,173). |
| `:12` F-A2 | "…`_recover` 被 `SeamManager` 覆写" | **FIXED.** `SessionKeyManager.sol:698-706`: `_recover` is now `internal view virtual` explicitly "so symbolic-verification harnesses can pin the recovered signer". |
| `:48` | "🔴 **5/11 空转**" | **FIXED.** README L49 and `check-doc-counts` (`Halmos specs: 11`) confirm 11 executing specs, guarded by meta-test `test_HalmosAuth_ArityIsFour` (`HalmosAuth.t.sol:216`). |
| `:49` | "Echidna **2 个恒真属性**" | **FIXED.** `echidna_ownerImmutableByFuzzer` is gone; replaced by `echidna_attackerNeverSucceedsAtAdmin` (`EchidnaProperties.t.sol:342`). README L46 documents the replacement. |
| `:11` | "116 个 `test_*`" | **STALE.** `grep "function test_"` across `contracts/` → **158** at session start; **220** on the end-of-session re-run. Either way the doc's 116 was wrong. |
| `:44` | "`deny="warnings"` + **33 处 lint**" | **STALE.** Real count was **49** at session start (`check-doc-counts`: `forge-lint annotations: 49`) and is **56** on re-run. Appears twice (`:44`, `:195`). |
| `:45` | "116 合约 + **337** vitest" | **STALE.** 158 contract tests at session start (220 on re-run). (The 337 TS figure is also superseded — whitepaper claims 358+87+65+36 = 546.) |
| `:46` | "4 invariant × 256 runs × 500 calls, **10 个 handler**" | **STALE.** Actual is **8** external handlers + `poke` (targeted, param'd): `poke`, `executeRandom`, `revokeRandom`, `grantRandom`, `rotateRandom`, `transferOwnershipRandom`, `toggleDenylistRandom`, `warpRandom` → 8 total targeted. The doc's own G-critique (缺 `withdraw`) is **confirmed** — `withdraw` has no handler. |
| `:176` | "PR CI ✅ **12 job**" | **STALE.** Real: **14** (12 in `ci.yml` + 2 in `publish.yml`). |
| `:221`/`:244` | G1–G4 ghost defects, `PALETTE` | **STILL TRUE / UNFIXED.** `ghostMaxPerWindowCap` still monotonic-raises (`:225-226`); `expectedWindowSpend` written at `:259` and **never read**; `vm.warp(block.timestamp + 1 + (seed % 400 days))` still present at `:198`; no `PALETTE` constant. **A named, diagnosed, unfixed defect.** |
| `:229` | `OverlapBeyondOldExpiry` "数学上不可达" | **STILL TRUE.** Unfixed. |
| `:278` | `SpendPolicy.sol:74` overflow-on-project | **STILL TRUE.** Unfixed. |
| `:122` | "`benchmark-indexer.mjs` 🔴 **无任何 CI job 引用**" | **STILL TRUE.** Unfixed. |
| `:174` | "pre-commit ❌ **完全缺失**" | **STILL TRUE.** No `.git/hooks`, no `husky`/`lint-staged` in `package.json`. |

`VERIFICATION-STRATEGY-2-CI-UAT.md:10` "12 job 分析要点" — same 12→14 drift;
`:24` "PR 事件下 6 个 job 恒 skip … 却展示 12 个" — the numbers are now 14.

**Root cause worth naming**: these two documents have **no status banner**. STATUS classifies
them nowhere, so nothing tells a reader they are frozen snapshots. A reader arriving at
`:48` "🔴 5/11 空转" would reasonably believe Halmos is currently vacuous — it is not.

---

### 3.5 MEDIUM — GETTING-STARTED / DEPLOYMENT cross-checks

| Doc ref | Claim | Actual |
|---|---|---|
| `GETTING-STARTED.md:11` | "Foundry **1.7.x**" | `foundry.toml` pins `solc = 0.8.36`; no Foundry version pin in `foundry.toml`. The `1.7.x` claim is unverifiable from the repo. **Medium** (unpinned claim). |
| `GETTING-STARTED.md:30` | `npm run setup` flags: `--no-install`, `--no-build` | Correct but incomplete — `bootstrap.mjs:31` also supports `--install`, which `TROUBLESHOOTING.md:65` correctly tells users to run. **Low.** |
| `GETTING-STARTED.md:146` | "Four tools: `validate_request`, `build_scope`, `decode_error`, `audit_query`" | **Correct** — `packages/mcp/src/server.ts:461` `TOOLS`, exactly 4 at L463/497/620/626. |
| `GETTING-STARTED.md:120-125` | indexer CLI subcommands `backfill/watch/summary/spend` | **Correct** — `packages/indexer/src/cli.ts:44-49` defines all 6. |
| `GETTING-STARTED.md:87` | `targetLeaf("0xToken", "0xa9059cbb")` | **Correct** — `signing.ts:329`; `data?` is genuinely optional. |
| `GETTING-STARTED.md:176-183` | `loadServiceConfig, readEnvInt, requireEnv, createLogger` from `@sigilkit/core` | **Correct** — all four exported (`config.ts:158/66/111`, `logger.ts:520`). |
| `GETTING-STARTED.md:18` | "`npm run setup` checks this before doing anything else" | **Correct** — `bootstrap.mjs:154` `checkNode()` is step 1 of 4. |
| `DEPLOYMENT.md:19-24` | deployable contract table (6 rows) | **Correct** — all 6 exist in `contracts/src/`. |
| `DEPLOYMENT.md:75-77` | deterministic script "rejects a zero salt and rejects a missing `SIGILKIT_OWNER_ADDRESS`" | **Correct** — `DeployDeterministic.s.sol:26-30`. |
| `DEPLOYMENT.md:81-87` | "`SigilKitDelegator` … is its own owner" | **Correct** — `SigilKitDelegator.sol:32` `SessionKeyManager(address(this))`. |
| `DEPLOYMENT.md:112` | "`@sigilkit/core` already exists on npm (v0.11.1)" | Unverifiable offline; flagged by RESEARCH-NUMBERS rules as needing re-verification. **Low** (correctly hedged as external). |
| `DEPLOYMENT.md:149` | `files[]` is `["dist", "README.md"]` | **Correct** for all 4 packages (verified). |
| `DEPLOYMENT.md:270` reorg row | `validateCursor` / `fetchRangeWithStableEnd` in `packages/indexer/src/indexer.ts` | **Correct** — `indexer.ts:783` and `:875`; the fail-closed semantics described are implemented exactly (`cursor.hash` re-validated at `:924`/`:948`, "stops before any write"). **This row is exemplary.** |

---

## 4. Security documents vs implementation

Method: each threat-map row re-checked against `contracts/src/` and `packages/core/src/`.

| Row | Threat | Doc's exposure claim | Verified? |
|---|---|---|---|
| 1 | `tx.origin` reentrancy | Mitigated-by-construction | ✅ **True.** 0 occurrences of `tx.origin` in `contracts/`. |
| 2 | Flash-loan sandwiching of EOA-code checks | Not-applicable | ✅ **True** (only EOA-code use is the deliberate ERC-1271 path, row 3). |
| 3 | `extcodesize` misclassification | Accepted-by-design | ✅ **True.** Exactly **one** code use, `SessionKeyManager.sol:815` (the file also carries one *comment* mentioning it, at L817 — not a second use). Re-verified on the end-of-session tree. Line anchor wrong (see §3.3). |
| 4 | Persistent control from one tuple | Mitigated-by-test, canary 13.49.0 | ❌ **Evidence pin contradicts the repo (12.5.0). See F-11 — Critical.** |
| 5 | 4337 remote activation | Mitigated-by-design | ✅ **True.** `SessionKey7579Module.sol:295` + `ActionLog7579Executor.sol:141`. Line anchor wrong. |
| 6 | `chain_id=0` replay | "Partial — SDK layer exposed" | ⚠️ **Understated.** The SDK guard **already exists** (`eip7702.ts:375,407-415`). The row lists W3-4.1 as pending work that is in fact shipped. Not a missing mitigation — a stale "open" label. |
| 7 | Sweeper contracts | Mitigated-by-design | ✅ **True.** `eip7702.ts:308`. |
| 8 | `validateUserOp`/`postOp` mistakes | "Pending checklist" | ✅ **Honest** — no `AUDIT-PREP-2026-10.md` exists (W4-1.1, due 10-14). |
| 9 | Raw zero-address revoke | Mitigated, canary 13.49.0 | ❌ **Same pin contradiction as row 4.** |
| 10 | Nonce reuse | "Partial — SDK layer" | ⚠️ **Partially landed** — see §3.3. |

**Net security finding**: of 10 threats, **7 fully verified**, **1 understated** (row 6 — the
mitigation exists but the doc says it doesn't), **2 rest on an evidence record that
contradicts the toolchain** (rows 4, 9 — F-11).

**The structural gap is not the threat model, it is the evidence chain.** The threat map
cites a canary result ("PASS 13.49.0") that no machine-checked file corroborates, while the
file that *is* machine-read (`WALLET_BEHAVIOR_ALLOWLIST.json`) says 12.5.0. Nothing in
`verify.mjs` (9 gates) or `check-doc-counts.mjs` cross-checks a `verifiedOn` field against the
`ci.yml` pin. `CHANGELOG.md` gets exactly this check; the allowlist does not.

`SECURITY.md` itself is outside my scope (root, not `docs/`) but is referenced by 6 `docs/`
files as normative.

---

## 5. `docs/STATUS.md` — the index is not an index

### 5.1 The exhaustiveness claim is false

`STATUS.md:111-112`:
> "The four layer tables should be exhaustive over `docs/` — a document that appears in none
> of them is unclassified, and that is a bug in this file."

**18 of 27 `docs/` files appear in no layer table.** Unclassified:

`AC-01-SCRUB-PLAN.md` · `ADVANCED-FEATURES-1-CONTRACTS-DATA.md` ·
`ADVANCED-FEATURES-2-SDK-OBS-ECO.md` · `ADVANCED-FEATURES-3-ECOSYSTEM.md` ·
`CONFIGURATION.md` · `DEPLOYMENT.md` · `ECOSYSTEM-RESEARCH-2026-09-23.md` ·
`ENHANCEMENTS-2026-09-25.md` · `GETTING-STARTED.md` · `NEW-ADDITIONS-2026-09-25.md` ·
`PROJECT-REVIEW-2026-09-17.md` · `RESEARCH-NUMBERS.md` · `SECURITY-7702-THREAT-MAP.md` ·
`TROUBLESHOOTING.md` · `VERIFICATION-STRATEGY-2026-09-25.md` ·
`VERIFICATION-STRATEGY-2-CI-UAT.md` · `Issues-Catalog-2026-09-23-C-Performance.md`

(Six more — `CI-WAIVERS.md`, `Enhancements-2026-09-12.md`, the four `Issues-Catalog-*` —
*are* named in prose but not in a table row.)

This file is itself unclassified — it needs a row too (L3, plan/context), making **19 of 28**.
I did not add it: `STATUS.md` is the doc team's file, and per my brief I am read-only outside
this one document. Flagging it so it is not lost.

**This is the highest-leverage fix in the whole audit.** `STATUS.md` is the file every reader
is routed to first; 66% of the corpus is invisible from it. `check-doc-counts` guards only the
vault count inside STATUS, so the gap is unguarded.

The layer model itself is sound and the conflict-resolution rules (L82-88) are correct. It
just needs 18 rows.

### 5.2 STATUS is otherwise accurate

- "22 notes" (L16, L66) → guard confirms `Vault notes: 22`. ✅
- `SigilKit_Whitepaper.txt` = SUPERSEDED v2.0 → file present, banner present. ✅
- Superseded/ACTIVE labels for the `Issues-Catalog-*` chain → match reality. ✅
- AC-32/33 "closed 2026-09-23" (L48) → correct; `a3f547f fix(indexer): AC-32/33` is in git log
  and the guard is in `indexer.ts:962-971`. ✅

### 5.3 The vault README's "21" — and why the obvious fix is not free

First reported by **dc-translate** (2026-09-26); I had graded this file `live` and was wrong.
Correction folded into §1.2 and the tally.

**The fact.** `vault/README.md:3` says "21 private research notes". The directory holds **22**
`.md` files. `docs/STATUS.md` says 22 and is guarded (`checkStatusCounts` at
`check-doc-counts.mjs:509` + `vaultNoteCount()` at `:643-647`, which `readdirSync`s the real
directory). So the toolchain is right and the vault's own front door is wrong — a
one-word drift in precisely the class of drift this project exists to eliminate.

**The correction to the fix.** The proposal was to add `vault/README.md` to the
`checkDocument(...)` set, on the grounds that `checkStatusCounts`'s existing regex
`/(\d+) notes\b/` "already matches it, so it's nearly zero-cost". **It does not match.**
I ran it:

```
claims matched by checkStatusCounts' own regex: 0
real vault .md count: 22
would return: [claim not found]  <-- the fail-closed branch
```

`/(\d+) notes\b/` requires the digits immediately adjacent to `notes`. The actual text is
`"holds 21 private research notes ("` — two modifiers sit between. Dropping the file in
as-is would **turn a green build red** with `STATUS: could not find the vault note count
(structure changed?)`, which is the correct fail-closed behaviour and the wrong outcome.

A loose regex does work, and I verified it does not over-match:

```
candidate /(\d+)\s+(?:private\s+|research\s+)*notes?\b/
  vault/README.md: 1 hit  -> "21 private research notes" (n=21)
  docs/STATUS.md:   3 hits -> "22 notes" (n=22)  x3
```

But loosening a shared regex to cover a second file is the kind of change that needs the
existing test (`check-doc-counts.test.mjs`) re-run, because the same pattern is what currently
protects STATUS. Cheaper and safer: pass a per-file pattern, or normalise the prose
("holds 21 notes") and keep the guard untouched.

**The transferable lesson** — and the reason this is worth more than one wrong number:

> The guard and the drifted document are protected by the *same* regex, and the regex is
> written for the shape of the document that happens to be correct. Extending a guard to a
> new document is **not** a one-line change even when the number looks identical, because
> "the guard returns no problems" and "the guard found nothing because it looked for the
> wrong string" are indistinguishable from the outside.

That is a real gap in the guard's design, not just in this document: `check-doc-counts`
reports a claim-not-found error, but it cannot distinguish *"this file makes no such claim"*
from *"this file makes the claim in a shape I don't recognise"*. Every future file added to
`checkDocument(...)` inherits the same trap. Suggest a `claimShape` per registered file so a
future miss is loud by construction.

### 5.4 The same drift, one layer up: `docs/STATUS.md` grew a claim site the guard cannot see

Found while reconciling the regex above. **This one is live right now, not hypothetical.**

`checkStatusCounts` pins two shapes in `docs/STATUS.md`:

```509:524:scripts/check-doc-counts.mjs
export function checkStatusCounts(text, { vault }) {
  const problems = [];
  const claims = [
    ...[...text.matchAll(/(\d+) notes\b/g)].map((m) => ({ source: `\`vault/\` (${m[0]})`, n: Number(m[1]) })),
    ...[...text.matchAll(/`(\d+)` occurrences/g)].map((m) => ({ source: "the 'update both occurrences' rule", n: Number(m[1]) })),
  ];
```

`docs/STATUS.md` was updated today (it is `M` in `git status`) and now carries **three**
`N notes` claims and **one** `` `N` occurrences `` claim:

| Line | Text | Guarded? |
|---|---|---|
| L21 | layer-summary table — `vault/` (22 notes) | ✅ |
| L93 | L4 table row — `vault/` (22 notes) | ✅ |
| **L95** | **`docs/VAULT-AUDIT-2026-09-26.md` … "Audit of the 22 `vault/` notes"** | ❌ **unrecognised shape** — backticked `22`, no space before `notes` |
| L108 | L4 trap note — "It held 22 notes as of 2026-09-25" | ✅ |
| L258 | the update rule — "Update **all three** `22` occurrences" | ✅ (see below) |

**One unguarded site, and it matters: L95.** Verified by running the real patterns against the
live file:

```
notes-pattern claims      : [ '22 notes', '22 notes', '22 notes' ]   -> L21, L93, L108
occurrences-pattern claims: [ '`22` occurrences' ]                    -> L258
L95 matched by notes pattern? false
```

**Correction to my own first draft (C8/C9).** I initially wrote that L258 was *also* unguarded
and *self-contradictory* — that the rewording from "both" to "all three" had outrun the regex.
**That was wrong, and dc-translate's counter-test is decisive:**

```
"Update both `22` occurrences"          -> ["`22` occurrences"]  MATCH
"Update **all three** `22` occurrences" -> ["`22` occurrences"]  MATCH
```

The pattern is `` /`(\d+)` occurrences/ ``. It anchors only on the backticked number plus the
literal word `occurrences`; the words before it are irrelevant. So L258 **is** guarded, it is
**not** self-contradictory, and L108 is held by the *notes* pattern independently — the
"mechanism silently died" claim does not hold. Withdrawing it.

**But the surviving finding is sharper than the one I replaced.** The rule at L258 enumerates
exactly three sites (L21, L93, L108) and all three are guarded. L95 is a **fourth** site,
added today, that the rule does not list and neither pattern can see.

**And the `--write` path does not merely miss it — it ratifies it.** Primary evidence is the
**real operational path**: an operator updates the `notes` sites and forgets the rule line.
That is red *before* the tool runs, and the tool is *asked to fix a count*:

```
partial update: notes sites -> 23, rule line left at 22
check BEFORE : ["STATUS: the 'update both occurrences' rule says 22 vault notes, actual is 23"]
rewrite ran  : true
check AFTER  : []
L95 claims   : 22   (correct value is 23)
=> red became green, and L95 is still wrong: true
```

In one sentence: **the tool was asked to fix a count, reported success, and the count it was
asked to fix is still wrong.** That is strictly worse than a missed check, because a missed
check is at least red.

*(A weaker variant: if the operator updates both shapes by hand first, the file is green before
and after — green→green. It shows the same property but hides the trigger. The red→green path
above is the one an operator actually takes, so it is the primary evidence.)*

The mechanism is structural: `checkStatusCounts` (`:511-513`) and `rewriteStatus` (`:604-606`)
use **literally the same two patterns**, so anything outside those shapes is invisible to the
check *and* untouched by the fix. Verified as unchanged after the guard gained three more
`checkDocument` call sites mid-session — this is a property of the two functions, not of one
revision, which also makes it unlikely to be fixed by an incidental refactor.

Recommended: extend both functions with the backticked shape (`` /`(\d+)` notes\b/ ``) and add
L95 to the L258 enumeration. Extending only the check would convert a loud failure into a
silent one. As in §5.3, changing a shared pattern requires re-running
`check-doc-counts.test.mjs` — that pattern is what protects STATUS today.

---

## 6. `PLAN-30-DAYS` — real progress

### 6.1 Checkbox accuracy: **12/12 correct**

Every `[x]` item was verified to have real evidence. No over-claiming found.

| Item | Claim | Verified evidence |
|---|---|---|
| W1-2.2 | AC-09 hybrid `testAutoOrManual` | `run.ts` allowlist-driven; `serve-manual.mjs` referenced |
| W1-2.3 | 2 allowlist entries added | ✅ `WALLET_BEHAVIOR_ALLOWLIST.json:6` (`metamask:agent-wallet-guard-rails`) and `:15` (`biconomy:smart-session-policies`), both `assert: documented-parity` |
| W1-4.2 | Slither 0.11.6, 0 High/Med on src | ✅ `CI-WAIVERS.md:50` triage table present and detailed |
| W1-5.1 | SECURITY.md + stale `sigilkit/sigilkit` refs fixed | ⚠️ **Partially false** — see §6.3 |
| W1-5.2 | Threat map rows resolved | ⚠️ **Row 6/10 over-claimed as "pending"** — see §3.3 |
| W1-6.3 | `npm run verify` 9/9 | ✅ `verify.mjs` has exactly 9 `LABELS` (L76-86) |
| W2-1.1 | Scrub plan written | ✅ `AC-01-SCRUB-PLAN.md` exists, marked unexecuted |
| W2-1.2 | `real-metamask-preflight` module | ✅ file exists; `preflight.ts:56` allowlist logic present |
| W2-1.3 | gitleaks pin in `install-gitleaks.sh` | ✅ single source, `lint:workflows` green |
| W1-7.2 | `RESEARCH-NUMBERS.md` created | ✅ exists — audited in §7 |
| W1-4.1 / W1-7.1 | canary run, week-2 prep | ✅ (evidence in gitignored `outputs/`, as designed) |

The plan is **honest**. Checkboxes reflect reality — that is rarer than it should be, and
worth saying plainly.

### 6.2 Week-1 DoD — 4 of 6 met

DoD (L35): credentials rotated ❓ · AC-32/33 fixed ✅ · threat map written ✅ ·
AC-09 closeout ✅ · git remote + first CI run ❌ · SECURITY.md exists ✅.

- **git remote**: exists (`dev25bansal-ops/sigilkit`) but W1-3.1/3.2 remain `[ ]` — the remote
  was added outside the plan. **Plan under-reports progress here.**
- **credential rotation** (W1-1.1, W1-5.3): both `[ ]`, and rotation is `[D]`-only so
  unverifiable from the repo. `AC-01-SCRUB-PLAN.md:14` correctly records it as a prerequisite.

### 6.3 W1-5.1 is the one over-claim

W1-5.1 `[x]`: "stale `sigilkit/sigilkit` refs fixed in SECURITY.md + `.well-known/security.txt`".

Verified — the fix was applied to **those two files only**:
- `.well-known/security.txt` → uses `dev25bansal-ops/sigilkit` ✅
- **But all four `packages/*/package.json` still declare `repository.url:
  git+https://github.com/sigilkit/sigilkit.git`** ❌
- And `GETTING-STARTED.md:23` still tells users `git clone https://github.com/sigilkit/sigilkit.git` ❌

So the stale refs W1-5.1 set out to fix are still present in the two places that actually
affect `npm install` provenance and a user's first command. The checkbox is defensible
(literal scope was SECURITY.md + security.txt) but the *goal* was not met.

### 6.4 Forward-looking items: correctly not started

All confirmed absent (they are scheduled for 10-01 … 10-22, so this is correct, not drift):
`scripts/check-hygiene.mjs` · `contracts/script/SyntheticSeeder.s.sol` · `tools/dashboard/` ·
`docs/{BENCH-INDEXER,AUDIT-PREP,BOUNDED-AUTONOMY,COMPAT-SAFE,DEMO-FLEET,POSITIONING}-2026-10*.md` ·
`docs/README.md` · `docs/PLAN-30-DAYS-RETRO-2026-10.md`.

W2-4.1 references `docs/BENCH-INDEXER-2026-10.md`; W3-2.1 references `docs/POSITIONING-2026-10.md`
whose filename is not enumerated anywhere in the plan but is implied. Minor.

**Progress rate**: Week 1 = 12 done / 3 blocked-on-`[D]`. Week 2 D8 = 3 done. D9-D30 unstarted.
As of 2026-09-26 the plan is **on pace** (D4 of 30 elapsed, 15 items closed).

---

## 7. `RESEARCH-NUMBERS.md` — verifiability audit

**Overall: the best-attributed document in the corpus.** 24 figures, every row carries a
source, and the Primary/Secondary distinction is honest. But the verifiability *categories*
are mixed and only partly labelled.

### 7.1 By category

| Category | Count | Reproducible? | Assessment |
|---|---|---|---|
| **External-cited, primary** | 4 (Keyrock block) | No — external URL | Correctly marked "Primary (confirmed)". Carries access date in the row title (2026-05-21). ✅ |
| **External-cited, secondary** | 3 (x402 block) | No — "Coinbase pages 403" | Correctly marked "Secondary". ✅ Best practice. |
| **Market projections** | 3 (McKinsey/Juniper/Gartner) | No | **No access dates, no "as of" per row.** The section header says "projections, not current revenue" — good. ⚠️ Gartner's is cited *via a16z*, i.e. second-hand but listed without a Secondary marker (inconsistent with §7.1's own convention). |
| **RPC-sampled measurements** | 2 (type-4 share) | **No — not reproducible** | ⚠️ Labelled "RPC sampling 2026-09-14" but no sample size, no node, no script. **This is the weakest attribution in the file**: it presents a measurement with no method. |
| **Third-party research** | 3 (zealynx: >97%, $146,551, $1.54M) | No | Single source, no corroboration. ⚠️ The threat map and whitepaper both rest security claims on these. |
| **Funding rounds** | 4 | No | Best-attributed section — each has a distinct primary URL + date. ✅ |
| **Regulatory** | 4 | No | Dated, jurisdiction-specific. ✅ (EU row has `—` for date; acceptable, it cites a paper not an instrument.) |

### 7.2 Specific findings

**R-01 · "Single source-of-truth" overclaim** · `RESEARCH-NUMBERS.md:3`
The file calls itself the single source of truth for "figures used in whitepaper, positioning,
and release materials." But the whitepaper states figures **not present here**:
`WHITEPAPER-v2.1.md:59` gives Base TVL ~$5.3B, stablecoins ~$293B, Paradigm $1.2B,
a16z crypto $2.2B — **none are in RESEARCH-NUMBERS.md**. The stated scope is false, which
means those four whitepaper numbers have no verifiability record at all. **Medium.**

**R-02 · The two files that must agree, don't reference each other cleanly** · Medium
`RESEARCH-NUMBERS.md:59`: "Use this file's URLs, not the ecosystem doc's, as the citation
target." But `ECOSYSTEM-RESEARCH-2026-09-23.md` is the *primary* research artifact (it has the
surrounding context and the "Gaps" section). The instruction inverts the natural authority
order without saying why. Minor.

**R-03 · Unverifiable-by-construction rows are not separated from verifiable ones** · Medium
A reader cannot tell, from the table alone, which numbers could be re-checked today. There is
no "last verified" column. The `Re-verify rules` section (L57-61) is the right place for it and
isn't.

**R-04 · Dead-source risk is real and already realised** · Low/Medium
`WHITEPAPER-v2.1.md:60` already records that `base.llamarpc.com` and `blastapi.io` — cited in
v2.0 — are "both dead as of Aug 2026". The same fate applies to any URL in this file without
an archive. **Recommendation: add a `web.archive.org` link or an accessed-date column.**
No row currently has one.

**R-05 · The re-verify rules are excellent and should be promoted** · (positive)
`:60` — "Any figure marked Secondary or that a fetch returns 403/429 on must NOT enter the
whitepaper unchanged — mark 'as cited by' or drop it." This is the right rule and it is
currently buried in a 3-line footer of a 48-line file. It should be a `CONTRIBUTING.md` rule.

### 7.3 Verdict

No fabricated numbers found. Attribution is materially better than the corpus average.
The gap is **process, not content**: no access dates, no archive links, no reproducible
scripts for the two measured rows, and a scope claim the file does not meet.

---

## 8. Consolidated mismatch list (by severity)

### Critical (2)

| ID | Doc:line | Says | Actual | Severity |
|---|---|---|---|---|
| F-11 | `SECURITY-7702-THREAT-MAP.md:14,19` | canary "PASS 13.49.0" underpins High-severity rows 4 & 9 | `WALLET_BEHAVIOR_ALLOWLIST.json:38` says `verifiedOn: extension 12.5.0`; CI fetches 13.49.0 | **Critical** |
| F-12 | `NEW-ADDITIONS:172` vs `DEPLOYMENT.md:51-53` | DEPLOYMENT tells you to use a Safe owner | `_ecrecover` (ECDSA-only, `:829`) makes E10 countersign permanently unusable with a Safe owner | **Critical** (known, unreconciled) |

### High (6)

| ID | Doc:line | Says | Actual |
|---|---|---|---|
| F-01 | `CONFIGURATION.md:36` | `SIGILKIT_OWNER_KEY` defaults to Anvil #0 | `Deploy.s.sol:25` `vm.envUint` reverts when unset; `DEPLOYMENT.md:39` says the opposite |
| F-02 | `DEPLOYMENT.md:34` | paste Anvil #0 as a deploy key | key is hardcoded in 6 source files; no public-fixture warning here |
| F-03 | `CONFIGURATION.md:75-83`, `.env.example` | complete env surface | omits `SIGILKIT_AUDIT_DB_ROOT`, a fail-closed gate (`mcp/src/server.ts:244`) |
| F-04 | `GETTING-STARTED.md:128` + 3 more | `sigilkit-indexer` is a command | `packages/indexer/package.json` has no `bin` field |
| F-05 | `DEPLOYMENT.md:219-221` | `audit_query` "opens read-only, never writes" | true but omits the allowlist gate that makes it inert when unconfigured |
| §5.1 | `STATUS.md:111-112` | layer tables are "exhaustive over `docs/`" | 18 of 27 files unclassified |

### Medium (19)

F-06 `DEPLOYMENT.md:192,270` sqlite3 not in image · F-07 `DEPLOYMENT.md:246` "git clone fails"/no
remote · F-08 `CI-WAIVERS.md:8` "no git remote" · F-09 `CONFIGURATION.md:3` "every setting" omits
`SIGILKIT_CREATE2_SALT` · 4× wrong line anchors in the threat map (`:13,15,16,20`) ·
`VERIFICATION-STRATEGY-2026-09-25.md:11,12,48,49` (Halmos 5/11 vacuous, Echidna tautological,
`_recover` overridden) — **all FIXED, doc not updated** · same file `:44,45,46,176` (33 lint → 49;
116 tests → 158; 10 handlers → 8; 12 jobs → 14) · `VERIFICATION-STRATEGY-2-CI-UAT.md:10,24` 12 jobs
→ 14 · `PROJECT-REVIEW-2026-09-17.md:3` "115 contract tests / 262 TS" → 158 / 546 ·
`GETTING-STARTED.md:11` "Foundry 1.7.x" unpinned · R-01 whitepaper figures outside
RESEARCH-NUMBERS scope · **F-13 `vault/README.md:3` "21 notes" → 22, unguarded** (from
dc-translate) · **F-14 `vault/Verified Build Stack 2026.md:10-12` Slither `6.2.4`→`0.11.6`,
Echidna `2.3.3`→`v2.2.5`, solhint `6.2.4`→does-not-exist** (three rows, not one) ·
**F-15 a live vault-count claim site in `docs/STATUS.md` that the guard cannot see, and `--write` ratifies it** (§5.4; anchor by text `Audit of the 22 \`vault/\` notes`, not by line — see the anchor warning in the header).
**F-16 48 of the 51 `docs/*.md` carry no guard** — 3 of the 51 are guarded; the other 3 guarded
files sit at repo root and were never among the 51 (§10 item 15 carries the scope table).

### Verified-correct (worth recording)

`GETTING-STARTED.md` SDK example (all 4 imports, all 8 scope fields, `targetLeaf` arity) ·
`DEPLOYMENT.md` reorg row (`validateCursor`/`fetchRangeWithStableEnd` semantics) ·
`DEPLOYMENT.md` deterministic-address rules · `TROUBLESHOOTING.md` 49 annotations ·
`WHITEPAPER-v2.1.md` all guarded counts · the whole `PLAN-30-DAYS` checkbox set ·
`CI-WAIVERS.md` slither triage table.

---

## 9. Findings that are **still open defects**, not doc drift

These are diagnosed in the corpus, never fixed, and the corpus is the only place they are
recorded. Flagging so they are not lost when the catalogs are archived.

| Defect | Recorded at | Status |
|---|---|---|
| **Foundry `fuzz.runs` has zero consumers** — `[profile.ci.fuzz] runs=2000` and `deep 10000` (`foundry.toml:28-36`) change nothing | `VERIFICATION-STRATEGY-2026-09-25.md:11` (F-A1) | **Open.** `grep "function testFuzz_"` → 0. The deepest config in the repo is decorative. |
| Invariant ghosts G1–G4: `ghostMaxPerWindowCap` monotonic, `expectedWindowSpend` write-only, 400-day `vm.warp` | `:81-84` | **Open.** Verified still present at `SessionKeyManager.invariant.t.sol:225,259,198`. **INV-1/2/4 are weaker than their names suggest.** |
| `withdraw` has no invariant handler | `:86` | **Open** |
| `SpendPolicy.sol` overflow-on-project → `Panic` instead of `PerWindowCapExceeded` | `:278` | **Open.** Latent: safe today, becomes a spend bypass if anyone adds `unchecked{}`. |
| `OverlapBeyondOldExpiry` unreachable in current invariants | `:229` | **Open** |
| `benchmark-indexer.mjs` has no CI caller (its `assertValidReport` is implemented but unused) | `:122` | **Open** |
| No pre-commit hook | `:174` | **Open** |
| `SIGILKIT_AUDIT_DB_ROOT` undocumented | — | **Open** (F-03) |
| `@sigilkit/indexer` missing `bin` | `NEW-ADDITIONS:230` (E-3) | **Open** (F-04) |
| `vault/Build Plan.md:40` UUPS contradicts immutable-by-design | `NEW-ADDITIONS:199` | **Open** (F-12) |
| Zero-value invariants in Echidna/Halmos | `:49,244` | **Fixed 2026-09-25** — see §3.4 |

---

## 10. Recommended sequence (read-only findings, actionable by owners)

Ordered by *unblocks-readers* ÷ *effort*, not by severity alone.

1. **Add 18 rows to `STATUS.md`** (§5.1). Pure table work, no code risk, and every reader is
   routed through this file first. Highest ratio of value to effort in the audit.
2. **Reconcile the `SIGILKIT_OWNER_KEY` contradiction** (F-01) — one sentence in
   `CONFIGURATION.md`, or split the table into "deploy path" vs "demo/test path".
3. **Document `SIGILKIT_AUDIT_DB_ROOT`** (F-03) in `CONFIGURATION.md` + `.env.example` +
   the `DEPLOYMENT.md` MCP example. A security control that operators cannot discover is
   indistinguishable from a broken feature.
4. **Fix the canary `verifiedOn` pin** (F-11) and add the missing `check:allowlist` gate
   (already specified in `VERIFICATION-STRATEGY-2026-09-25.md:106`).
5. **Add `bin` to `packages/indexer/package.json`** (F-04) — 30 minutes, unblocks 4 documents.
6. **Banner the two verification-strategy documents** as frozen 2026-09-25 snapshots, and
   split their fixed findings from open ones. Cheapest way to stop actively misleading readers.
7. **Refresh the 4 threat-map line anchors** (F-11 table in §3.3) and re-label rows 6/10 as
   landed.
8. **Reconcile `DEPLOYMENT.md:51-53` with the E10/Safe incompatibility** (F-12) — add the
   caveat now; the fix is a separate design decision.
9. **Add the three missing doc guards** that would have caught most of this:
   - env-var inventory gate (`.env.example` ↔ `readEnv*` call sites) — proposed as C-8,
     never built;
   - a `cli`-has-`bin` check — 3 lines, mirrors `check-package-artifacts.mjs`;
   - a **per-file `claimShape`** in `check-doc-counts` so "this file asserts nothing" is
     distinguishable from "this file asserts it in a shape I don't recognise" (§5.3). Without
     it, every file added to `checkDocument(...)` inherits the same false-green trap.
10. **Add an `accessed` column to `RESEARCH-NUMBERS.md`** and archive-link the URLs (R-04).
11. **Fix `vault/README.md:3` → 22** (F-13), and either widen the guard with a per-file pattern
    or normalise the sentence — do **not** loosen the shared regex blind (§5.3).
    Cheapest correct fix: change the prose to "holds 22 notes" and leave the script untouched.
12. **Re-pin or re-date `vault/Verified Build Stack 2026.md:10-12`** (F-14): Slither `6.2.4`→`0.11.6`,
    Echidna `2.3.3`→`v2.2.5`, and **delete or source the solhint row** — it names a tool absent
    from the entire repo and reuses Slither's `6.2.4` verbatim, so it is copy-paste, not a pin.
    A *version* is not a derivable count; follow the `metamaskPinFromCi()` precedent
    (`check-doc-counts.mjs:617`) rather than inventing a mechanism.
13. **Add L95 to `docs/STATUS.md`'s own update rule and extend the guard to match** (F-15, §5.4)
    — the most time-sensitive item, because the file is being edited *right now* and the
    failure is silent in the worst direction. Verified: `check-doc-counts.mjs --write` leaves
    L95's `22` untouched and reports **green**. Two edits: (a) list L95 in the L258 rule, and
    (b) add the backticked shape (`` /`(\d+)` notes\b/ ``) to `checkStatusCounts` **and** to
    `rewriteStatus`, so the fix path and the check path cover the same shapes. Re-run
    `check-doc-counts.test.mjs` — that pattern is what protects STATUS today.
14. **RESOLVED — ruling (c): keep the evidence chains, declare the snapshot.** *(Team-lead
    ruling, 2026-09-26. I had offered (a) register / (b) strip; both were rejected, correctly.)*
    - **(a) register — rejected.** `check-doc-counts.mjs` states its own position: `:21-22`
      "an older entry's numbers were true when written, and rewriting a historical record would
      be a lie", and `:342-348` guards only the CHANGELOG's newest entry so it cannot "make the
      changelog unusable as a historical record". The established principle is **guard live
      documents, not dated snapshots** — consistent with `INDEX-2026-09-26.md` guarding only its
      latest entry and with the `Issues-Catalog-*` chain being marked SUPERSEDED. Registering a
      dated audit would force a rewrite of a historical record, which is the one thing this guard
      exists to prevent. **The correct reading of "unregistered" here is "correctly unregistered".**
    - **(b) strip the counts — rejected.** Measured: this file carries 92 rot-prone figures and
      122 unique line anchors, and they are the **evidence chains for the Critical findings**
      (F-11's `WALLET_BEHAVIOR_ALLOWLIST.json` = `12.5.0`, F-15's false green, F-16's
      registration counts). Deleting them would leave conclusions with no provenance, which is
      worse than drifting. The "cite no counts" discipline that makes
      `docs/VAULT-AUDIT-2026-09-26.md` durable is available only because that file makes no
      independent claims; this file makes many.
    - **(c) declare — adopted.** A snapshot declaration at the top covers all counts and anchors
      in one statement, so they need not be maintained individually and the historical record
      stays intact.
    - **Residual risk, stated rather than hidden.** Between a snapshot drifting and the next
      re-measurement, a reader of this file alone could be misled. The declaration is the
      mitigation; the alternative (a "remind on edit" guard) was considered and declined
      because it produces noise on every change to a file nobody edits after publication.
      **This is a real, accepted limitation, not a solved problem.**

15. **The registration surface is itself the finding (F-16).** Three counts, kept in **separate
    scopes and never mixed in one subtraction**:

    | Scope | Count | Which |
    |---|---|---|
    | `docs/*.md` total | **51** | the denominator |
    | guarded **within `docs/`** | **3** | `WHITEPAPER-v2.1.md`, `STATUS.md`, `TROUBLESHOOTING.md` |
    | guarded at **repo root** | **3** | `CHANGELOG.md`, `README.md`, `SECURITY.md` |
    | **⇒ unregistered within `docs/`** | **48** | `51 − 3`, the `docs/`-scoped figure |

    Origin of the correction: dc-translate first reported **45**, computed as `51 − 6` — mixing
    the *repo-level* guarded count into a *`docs/`-scoped* total. The arithmetic was valid and the
    evidence was not: three of those six (`README`, `CHANGELOG`, `SECURITY`) were never among the
    51. **The same class of error I had already logged as C13** — a number that is correct inside
    one scope, presented as if universal. Both figures now appear in the reports with their
    scopes attached, and 48 is the figure to use.

    Per §5.4, an unregistered document's silence carries no information, so the other 48 are
    **"unchecked", not "fine"** — and two of them have been *observed* drifting on this very day
    (this file; `docs/VAULT-AUDIT-2026-09-26.md`, rot-prone by construction). The cheapest useful
    fix is not per-file guards but a **register**: an explicit list of which `docs/*.md`
    deliberately make no derivable claim, so that adding a counted document later becomes a
    visible decision rather than a silent omission. That reframes item 14 and F-15 as two
    symptoms of one missing artifact.

---

## 11. Method & limits — what I did *not* verify

Stated plainly, because a staleness audit that overstates its coverage is itself a defect.

**Verified by execution:**
- All doc counts. The authoritative run (`check-doc-counts.mjs` → exit 0) was taken at the
  start of this audit: `158 tests / 14 suites`, `14 CI jobs`, `11 Halmos specs`,
  `4 Echidna properties`, `4 invariants / 1 suite`, `22 vault notes`, `49 forge-lint
  annotations`, `MetaMask 13.49.0`. Every number quoted in §3.4 is from that run or from `grep`.
- The §5.3 regex behaviour, by executing `checkStatusCounts`'s own pattern against
  `vault/README.md` (0 matches) and against a candidate loose pattern (1 match in
  `vault/README.md`, 3 matches in `docs/STATUS.md`, no over-match). Both probe scripts were
  deleted afterwards.
- **F-15 claim sites**, by enumerating every `N notes` and `` `N` occurrences `` match in the
  live `docs/STATUS.md` (3 + 1) and checking each against the two guard patterns — this is a
  `Select-String` fact about the current file, not an inference from the earlier snapshot.
- **The `--write` result in §5.4**, by importing the guard's own `checkStatusCounts` and
  `rewriteStatus` and running them on a copy of `docs/STATUS.md` with the three rule-named
  sites advanced to 23 and L95 left at 22: `checkStatusCounts` returns `[]` (green) and
  `rewriteStatus` leaves L95 byte-identical. This is the load-bearing evidence for F-15.
  **Re-run after the guard was rewritten mid-session** (it gained three more `checkDocument`
  call sites) — the false green reproduces unchanged: claim sites still L21/L93/L108 + L258,
  L95 still unmatched, `rewriteStatus` still leaves it, `checkStatusCounts` still returns `[]`.
  So F-15 is a property of the two functions' shared shapes, not of one revision.
- **Six of my own errors across five rounds, all one shape** (banner table): extrapolating a
  history or cause from a point observation. Four were mine to withdraw (regex match, solhint's
  CI claim, L258's contradiction, the "static snapshot" inference); two were dc-translate's,
  caught by the same method. Recorded because the *shape* is transferable, not the instances.
- **Two of my own claims were tested and withdrawn** (§5.4, C8/C9): that L258 was unguarded, and
  that the "both"→"all three" rewording had outrun the regex. Both were falsified by running the
  real patterns; dc-translate raised both. Recorded per `docs/STATUS.md`'s own rule — "if an
  existing rule here is found to be wrong, fix it, and say why".
- **Five of my own line citations were stale** and are corrected in place: `vaultNoteCount`
  `:592`/`:595` → `:643-647`, and `metamaskPinFromCi` `:566-569`/`:566` → `:617-620`/`:617`.
  `scripts/check-doc-counts.mjs` was rewritten during the session (426 insertions against HEAD,
  980 non-empty lines now) — the same drift class this audit exists to catch, caught in my own
  document. **Proof it was rewritten mid-session rather than merely before it:** the guard's
  own success line gained a sixth guarded file ("…and SECURITY match the toolchain"), which a
  script that had not changed could not have printed.
- The solhint absence, by `Select-String` across `.github/workflows/*.yml`, both `package.json`
  levels and `scripts/*.mjs` → zero hits.
- Handler/test/annotation counts by direct `grep`.
- File existence for every path named in `PLAN-30-DAYS`.
- `git remote`, `git log`, working-tree status.

**Verified by reading source:** every F-01…F-15 claim. Each names the exact file:line I read.
F-15 quotes `checkStatusCounts` verbatim (`:509-514`) and the claim is read off the live file.

**NOT verified — stated as unverified rather than assumed:**
- **That my line citations are current at the moment you read this.** I re-verified all
  `check-doc-counts.mjs` anchors against the file as it stands at session end (980 non-empty
  lines; `vaultNoteCount` at `:643`, `metamaskPinFromCi` at `:617`). But that file, `ci.yml`,
  `contracts/src/SessionKeyManager.sol` and `docs/STATUS.md` were all being edited today — the
  script gained a sixth guarded file *while I was measuring it*. **Treat every line anchor here
  as a snapshot, and re-grep before acting.** The structural findings (which claims are
  unguarded, which binaries do not exist, which env var is undocumented) do not depend on line
  numbers and should survive.
- Any **external** claim (npm scope ownership `@sigilkit/core` v0.11.1, GitHub 404s, the
  24 research figures, MetaMask #35520 reaction counts, arXiv IDs). No network access.
  `RESEARCH-NUMBERS.md:60` forbids publishing unverified Secondary figures; I apply the same
  standard here.
- **Gas numbers** — the task asked about these. `GasBudget.t.sol` (737 lines) and
  `Gas7579Scaling.t.sol` (476) exist and `.gas-snapshot` is modified in the working tree, but
  no document in `docs/` states a specific gas figure that I found to contradict code, and
  running `forge test --gas-report` was out of scope for a read-only audit. **Unverified, not
  clean.**
- **Whether the 6 `vault/Component *` notes are still linked from `00 MOC.md`** — I classified
  them on content, not on graph reachability.
- **Working-tree drift**: `git status` showed 25+ modified files at session start and more by
  the end. Findings reflect the tree **as of 2026-09-26**, re-verified at session end; re-verify
  before acting on anything in `contracts/`.

**The honest coda, and the reason the banner at the top exists.** This audit was written to
find documents whose numbers had gone stale. In the process, **its own numbers went stale** —
Foundry went 158 → 220 tests, annotations 49 → 56, and four security line-anchors moved a
second time, all while it was being written, because other teams were editing the tree it was
measuring. `README.md`, `TROUBLESHOOTING.md` and the whitepaper were updated in step and the
guard is green on the new figures; this file is now the stale one.

That is not a failure of method — the same guard that certifies those three documents passed
while this one drifted, because **this file is not registered with any guard**. It is the
expected outcome for an unregistered document in a repo whose entire thesis is "unregistered
claims rot". The finding is therefore self-referential rather than disqualifying: the audit's
own remediation list should include *this file*.

**Not in scope, by instruction:** root-level `README.md`, `SECURITY.md`, `CHANGELOG.md`,
`PROJECT-MAP.md`, `FILE-MANIFEST.md`, `CONTRIBUTING.md`, `SigilKit_Whitepaper.txt`.
Several are referenced normatively by `docs/` (STATUS names the first three), so findings
above reference them as evidence but do not assess them.

---

*Compiled 2026-09-26 · read-only audit · 49 documents · 0 files modified outside this one.*
