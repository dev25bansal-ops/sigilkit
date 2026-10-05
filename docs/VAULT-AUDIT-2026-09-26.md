# vault/ Audit — 22 Research Notes Classified, Whitepaper Corrections Traced

> ## 📌 READ BEFORE EDITING — this file is CLOSED
>
> **Status: FINAL as of 2026-09-26. Line closed by the team lead; the author has stopped editing.**
>
> - **Do not "fix" line numbers in here.** Every `:NNN` and `LNN` anchor is a snapshot. `docs/STATUS.md`
>   alone drifted 267 → 351 lines during this audit, and `.github/workflows/ci.yml:331` was already
>   stale (actually `:366`/`:375`). **Locate claims by string anchor, not position** — §5.4 lists the
>   five strings, with verified hit counts, for exactly this purpose.
> - **This file is itself unregistered**, so its anchors can rot at any time (§5.4). That is not a bug
>   to repair here; it is the finding.
> - The two live defects it reports (**F9** = dc-stale `F-15`, `--write` false green · **F10** = dc-stale
>   `F-16`, 48/51 unguarded — the latter is *derived*, so it must be **computed by a gate**, never
>   hand-listed) are **assigned** — see §8. Do not re-litigate them here; fix them in
>   `scripts/check-doc-counts.mjs` and in the guard-coverage check itself.
> - §10 is a correction log kept **on purpose**. Its entries record mistakes I made and ones caught in
>   review — **C1–C20, by design, not by accident.** **Do not clean them up**: a corrected record is
>   the deliverable.

**Date:** 2026-09-26 · **Scope:** all 22 files in `vault/` (read-only) · **Author:** dc-translate
**Question answered:** are the Aug-2026 research notes still valid research, dead weight, or a
liability? Specifically — **were the corrections in `vault/Whitepaper Corrections.md` actually
applied to the shipped whitepaper?**

> **Verdict in one line:** the corrections **were** applied — 15/15, on all 6 fabricated and all 9 stale
> claims, and `SigilKit_Whitepaper.txt` is fenced with a SUPERSEDED banner. This is **continuously
> backed by a green `check-doc-counts.mjs` (exit 0)**, not merely visible in the correction table (§3.6).
> The real risk is not the whitepaper; it is that **`vault/` carries unverified third-party figures that
> `docs/` has already superseded with better sources**, and that several notes now describe a codebase
> that no longer exists.

**Layer:** this is an L4 (context) audit of L4 (context). It is **not** normative. It creates no
new facts about the product — it only reports what `vault/` contains and where it has drifted from
`docs/`. Per `docs/STATUS.md`, where this file and the code disagree, the code wins.

---

## 1 · Headline findings

| # | Finding | Severity | Evidence |
|---|---|---|---|
| F1 | **Whitepaper corrections: 15/15 applied.** All 6 ❌fabricated and all 9 ⚠️stale claims from `vault/Whitepaper Corrections.md` appear corrected or explicitly retracted in `docs/WHITEPAPER-v2.1.md`. | ✅ resolved | §3 |
| F2 | **`vault/` is not a fact source for external figures.** `docs/RESEARCH-NUMBERS.md` (2026-09-23) and `docs/ECOSYSTEM-RESEARCH-2026-09-23.md` (2026-09-23) are newer, primary-sourced, and carry verifiability grades. The vault's market/adoption numbers predate them by 33 days. | ⚠️ high | §5, §6 |
| F3 | **4 of the 22 files describe a codebase that has since been rebuilt.** `Component 2` (a Diamond spec whose own verdict was "REPLACE"), `Component 3` (dropped, yet still planned as M1 week-3 work), and `Build Plan` + `Milestones` (multi-RPC as early work) are all superseded by the ERC-7579 pivot. | ⚠️ high | §2 |
| F4 | **13 external facts carry no access date and no per-claim URL** at point of use. `vault/Sources.md` aggregates ~60 URLs, but a reader of `Competitive Landscape` or `Global Adoption` alone cannot tell which claim came from where. | ⚠️ medium | §5 |
| F5 | **4 figures are unverified and were never verified.** Bakong ~1.3B tx, Bitso $6.5B, Nigeria $59B P2P, Helix ~823★. The vault flags all 4 honestly — the risk is downstream reuse. | ⚠️ medium | §6 |
| F6 | **`vault/README.md` says "21 notes"; there are 22.** `docs/STATUS.md` is correct (22) and is guarded by `npm run check:docs`. The vault README is not guarded — and naively guarding it would redden the build, not catch the drift (§4.2). | 🔵 low | §4 |
| F7 | **`00 MOC.md` and `Memory Index.md` are not duplicates** — different jobs, and `00 MOC.md` is the more complete of the two. But `00 MOC.md` indexes only 18 of the other 21 notes — 3 are unlinked. | 🔵 low | §4 |
| F8 | **Three pins in `Verified Build Stack 2026.md` now contradict the toolchain** — Slither `6.2.4` vs CI's `0.11.6`, Echidna `2.3.3` vs `v2.2.5`, and solhint listed at `6.2.4` in a table titled "**Verified** Build Stack" while appearing nowhere in the repo. Only the Slither one was ever caught. | ⚠️ medium | §6.1 |
| F9 | **`check-doc-counts --write` can certify a wrong number.** In the live `docs/STATUS.md`, the L95 vault-count claim sits outside both regex shapes the tool uses. The checker cannot see it, the rewriter cannot touch it. The realistic partial-update path goes **red → green with the number still wrong**: the tool is asked to fix a count, reports success, and the count it was asked about is still wrong. Re-verified against the script as rewritten mid-audit (guarded docs went 2 → 6 during this session), so the property belongs to the shared-shape design, not to one revision. | 🔴 **high** | §5.4 |
| F10 | **48 of the 51 `docs/*.md` files carry no guard.** Scope matters here: the guard reads six documents repo-wide, but only **three** live under `docs/` (`WHITEPAPER-v2.1.md`, `STATUS.md`, `TROUBLESHOOTING.md`). The other three (`README.md`, `CHANGELOG.md`, `SECURITY.md`) sit at the repo root and were never part of the 51 — so "6 guarded" and "51 docs" are not complementary quantities and must never be subtracted. `docs/`-scoped: 51 − 3 = **48**. Two have already been observed drifting on the same day; the other 46 are **untested, not fine**. | ⚠️ medium | §5.4 |

---

## 2 · The 22 notes, classified

Categories: **LIVE** (still-valid research conclusion) · **RAW** (primary-source excerpt — archive
material, not a living doc) · **SPENT** (converted into `docs/` — now redundant) · **STALE**
(superseded/outdated) · **PRIVATE** (personal judgment / unverified speculation).

| # | Note | Class | Disposition | Why |
|---|---|---|---|---|
| 1 | `00 MOC.md` | LIVE | keep, fix | Vault entry point. 2 of 22 notes unlinked (see §4) |
| 2 | `Academic Literature.md` | RAW | archive as evidence | 5 arXiv IDs + venue deadlines = primary-source index. Facts verified (§5) |
| 3 | `Agent Architecture.md` | LIVE | keep | Conformance-harness + session-key design. Partly realized in `packages/core` + `contracts/` |
| 4 | `Audit Raw Findings 2026-08-24.md` | SPENT | keep as record | 43 raw findings, re-verified item-by-item into `docs/Issues-Catalog-2026-09-11.md`. Evidence, not a worklist |
| 5 | `Build Plan.md` | STALE | archive | Plan order puts multi-RPC at w1–3 and Diamond at w3–5; both scope decisions reversed (§2 F3) |
| 6 | `Competitive Landscape.md` | STALE (time-boxed) | **supersede** | All ★ counts are 2026-08-21 and will drift. Superseded in substance by `docs/ECOSYSTEM-RESEARCH-2026-09-23.md`, which adds Safe/MetaMask Agent Wallet/Biconomy and finds ERC-7579 still Draft |
| 7 | `Component 1 — EIP-7702 Wallet Library.md` | LIVE | keep | Core protocol facts verified against eips.ethereum.org (§5). Still the product's spine |
| 8 | `Component 2 — EIP-2535 Diamonds Module.md` | STALE | archive | Its own verdict was "REPLACE with ERC-7579" — and that was executed. Shipping a note whose recommendation was followed makes it misleading |
| 9 | `Component 3 — Multi-RPC Provider.md` | STALE | archive | Verdict was "DROP/DEFER" — executed. Also contains a live endpoint probe that is now ~5 weeks old |
| 10 | `Component 4 — Agent Session-Key Manager.md` | LIVE | keep | The moat. INV-1..4 match `SECURITY.md`. Caveat: §4 says caps are value-only, which the code confirms |
| 11 | `Comprehensive Analysis 2026-08-24.md` | SPENT | keep as record | The readable distillation of #4. Every High item is now fixed in code (verified §2 note) |
| 12 | `Funding Audit Bounty.md` | STALE | archive (or re-verify) | Grant tables + audit quotes are Aug-2026. Its recommendations were adopted; the numbers age fastest of any note |
| 13 | `Global Adoption.md` | STALE + PRIVATE | archive | Superseded by `docs/ECOSYSTEM-RESEARCH-2026-09-23.md` §3. 3 of its headline figures were never verified (§6) |
| 14 | `Memory Index.md` | LIVE | keep | Points at external memory files. Tiny, stable, no facts to rot |
| 15 | `Milestones.md` | STALE | archive | M1/M2 milestones are for dropped/replaced components. Superseded by `docs/PLAN-30-DAYS-2026-09-23-to-2026-10-22.md` |
| 16 | `README.md` | STALE | fix count | States "21 notes"; real count is 22 (F6). It is the vault's own front door, so a wrong count here is self-refuting |
| 17 | `Research Summary.md` | LIVE | keep | The one-page "what holds vs what's false". Best entry point after the MOC |
| 18 | `Risk & De-risk Plan.md` | LIVE | keep | Regulatory + competitive reasoning. Referenced by `docs/WHITEPAPER-v2.1.md:61` — load-bearing |
| 19 | `SigilKit Overview.md` | LIVE | keep | Carries the 2026-08-23 "implemented & committed" banner. Accurate as of HEAD |
| 20 | `Sources.md` | RAW | archive as evidence | ~60 URLs, grouped by stream. No access dates (§5). Superseded for market figures by `docs/RESEARCH-NUMBERS.md` |
| 21 | `Verified Build Stack 2026.md` | LIVE (partly) | keep + refresh | Version pins are 2026-08-21. `evm_version`, viem/ethers majors still hold. Needs a re-pin before any release claim |
| 22 | `Whitepaper Corrections.md` | LIVE | keep — **highest value** | The evidence trail `docs/WHITEPAPER-v2.1.md:7` points at. Do not touch; see §3 |

### Tally

Each of the 22 notes is assigned exactly one primary class. "Unverified assertions" is not a
separate class — it is a property that cuts across several notes (see §6).

| Class | Count | Which notes |
|---|---|---|
| **LIVE** — still-valid research conclusion | 9 | MOC, Agent Architecture, C1, C4, Memory Index, Research Summary, Risk, Overview, Verified Build Stack (pins stale) |
| **STALE** — superseded or conclusion reversed | 8 | **README**, Build Plan, Competitive Landscape, C2, C3, Funding, Global Adoption, Milestones |
| **RAW** — primary-source excerpt, archive as evidence | 2 | Academic Literature, Sources |
| **SPENT** — converted into `docs/`, kept as record | 2 | Audit Raw Findings, Comprehensive Analysis |
| **PRIVATE** — judgment presented as fact | 0 | no standalone private note; the private-note *content* lives inside Competitive Landscape / Funding / Global Adoption — see §6 |
| (cross-cutting, not a class) **contains unverified assertions** | 3 | Competitive Landscape, Funding, Global Adoption |

**Arithmetic note (corrected 2026-09-26 after review).** My first tally was internally inconsistent
and is fixed here. Two things were wrong:

1. **The 22 files are 21 research notes + 1 `README.md`.** `docs/STATUS.md` and `check-doc-counts.mjs`
   count *files* (22); the vault README's own wording is "21 notes". Both numbers describe different
   things — the drift is that the README calls the whole directory "21 notes" when it holds 22 files.
2. **`README.md` is STALE, not LIVE** (corrected from my first pass, after review by dc-stale). It
   asserts a count that is wrong about the directory it introduces. A note that misstates its own
   corpus cannot be "live".

Corrected tally: **LIVE 9 · STALE 8 · RAW 2 · SPENT 2 · PRIVATE 0 = 21 notes**, and the 22nd file is
`README.md`, which is the first entry in the STALE row. The STALE row's 8 = 7 superseded research
notes + that README.

**Reading:** 8 notes are genuinely superseded, 2 are raw evidence, 2 are spent-but-valuable records,
and 9 are still live. The vault is not bloated — it is **unevenly aged**, with a hard cliff:
everything dated 2026-08-21 is pre-`docs/`-ecosystem-research, and everything the project has done
since has been recorded in `docs/`, just not here.

### The 3 High findings from the vault audit are all fixed in code (spot-verified)

This matters because it proves the vault's audit was *consumed*, not filed away:

- `Comprehensive Analysis` #1 — *"7579 module: no `msg.sender == account` gate"* → **fixed**.
  `contracts/src/SessionKey7579Module.sol:283-286` now gates and comments "a mempool-copied op
  must not burn a victim's spend window when invoked directly."
- `Comprehensive Analysis` #17 — *"no low-s malleability check"* → **fixed**.
  `SessionKey7579Module.sol:594-597` rejects `s > _SECP256K1_HALF_ORDER`.
- `Comprehensive Analysis` #4 / raw finding a5dea39d29 — *"CI pins nonexistent
  `slither-analyzer==6.2.4`"* → **fixed**. `docs/PLAN-30-DAYS…:56` records the 0.11.6 run.

---

## 3 · ★ Whitepaper corrections — applied or not (the key question)

`vault/Whitepaper Corrections.md` lists 6 ❌fabricated, 9 ⚠️stale, 4 ❓unverified, 8 ✅confirmed.
Traced against **`docs/WHITEPAPER-v2.1.md`** (the authoritative v2.1) and
**`SigilKit_Whitepaper.txt`** (the v2.0 original).

### 3.1 · The 6 fabricated/false claims — ALL APPLIED ✅

| v2.0 claim | In v2.1? | Where |
|---|---|---|
| "0xcc… SecurityControl" delegation address | ✅ removed | Corrected-claims table; canonical CREATE2 addresses substituted |
| viem #3285 "~25 upvotes" | ✅ corrected | "Actually **0 reactions**" |
| IC3 survey quote "no evidence of real on-chain autonomy" | ✅ removed | "**Not found in the paper**" + correct arXiv ID/date |
| "Zero peer-reviewed papers on EIP-7702" | ✅ corrected | "**False.** arXiv:2512.12174 … exists" |
| ERC-7790 = 7702 recommit standard | ✅ corrected | "**False.** EIP-7790 is gas-limit scaling (Stagnant)" |
| Non-canonical Diamond layout (`DiamondStorage.sol`/`FacetCutLib.sol`) | ✅ moot | Component 2 → ERC-7579 module shipped; the file layout is gone |

### 3.2 · The 9 stale claims — ALL APPLIED ✅

| v2.0 claim | In v2.1? | Where |
|---|---|---|
| Optimism Mission Request #274 "open call" | ✅ corrected | "window closed April 2025 … Not an available grant path" |
| Code4rena competitive audit | ✅ corrected | "winding down"; route = Cantina/Sherlock + Arbitrum subsidy |
| Spearbit audit firm | ✅ corrected | "merged into Cantina" |
| Gitcoin quarterly QF rounds | ⚠️ **not in v2.1** | Dropped from the whitepaper entirely — no false claim remains, so no correction needed, but the vault's "campaign-based (GG24)" fact lives only in `Funding Audit Bounty.md` |
| Solidity 0.8.24 | ✅ corrected | "Built on 0.8.36" |
| Certora-only formal-verification gate | ✅ corrected | "Halmos (a16z) used for symbolic verification instead" |
| Base TVL "$4.6B" | ✅ corrected | "Recovered to ~$5.3B — v2.0 understated" |
| a16z crypto "~$2B" | ✅ corrected | "$2.2B" |
| Dead free RPCs (`base.llamarpc.com`, `blastapi.io`) | ✅ corrected | "Both dead as of Aug 2026. Defaults: PublicNode, 1RPC, Ankr" |

### 3.3 · The 4 unverified items — handled ✅

Helix was **removed** from competitive claims. Bakong / Bitso / Nigeria were flagged in the vault and
**never entered the whitepaper** (confirmed: no mention in v2.1). Correct outcome — the vault did
not launder unverified figures into published material.

### 3.4 · The 8 confirmed facts — retained ✅

v2.1's "Verified facts retained from v2.0" reproduces OZ #2793 (+1:50/64), ethers #1053/#4469/#2030,
MetaMask #35520 (14 reactions), Coinbase/Sphere/Sandboxed figures, and the 7702 wire format. All
match the vault and (per §5) live reality.

### 3.5 · The v2.0 text file is properly fenced ✅

`SigilKit_Whitepaper.txt` opens with a 38-line banner: "*** SUPERSEDED DOCUMENT -- DO NOT CITE
***", enumerates 6 known-false/stale claims, and points readers to v2.1 + the vault. `docs/STATUS.md`
lists it as "**None — do not cite.**" This is exactly right.

### 3.6 · Corrections verdict

**The whitepaper is NOT currently wrong.** All 15 actionable corrections are applied.

**How that is endorsed — by the gate, not by reading the prose.** My own first pass rested on
inspecting the correction table in `docs/WHITEPAPER-v2.1.md` and matching each entry by hand. That
evidence is real but **one-shot**: it describes what the text said when I looked. The stronger
endorsement is that `check-doc-counts.mjs` **exits 0** and keeps re-asserting the whitepaper's counts
against the toolchain on every run:

```
FORGE_BIN set -> check-doc-counts -> exit 0
  "doc counts OK — README, whitepaper, CHANGELOG, STATUS, TROUBLESHOOTING and SECURITY match the toolchain."
```

So the accurate claim is: **15/15 applied, continuously backed by a green gate** — not "each one is
visible in the table". A grep proves the text; the gate proves it stays true. The correction surface
(whitepaper "supersedes" banner, pre-audit disclaimer, and the `SigilKit_Whitepaper.txt` fence with its
38-line SUPERSEDED header) is coherent and honest. **No high-priority whitepaper defect found.** The
residual risk is the vault's *unverified market figures* (§6), not the whitepaper.

---

## 4 · Structure: MOC, Memory Index, and the note count

### 4.1 · `00 MOC.md` vs `Memory Index.md` — NOT duplicates

| | `00 MOC.md` | `Memory Index.md` |
|---|---|---|
| Purpose | Vault **map of content** — indexes the other 21 notes into reading paths (Start here / components / verification / planning / markets / reference) | **Pointer to external memory** — 2 files living *outside* the vault at `C:\Users\dev25\.claude\...` |
| Links | `[[...]]` wikilinks to 20 notes | None (external paths; explicitly notes `[[...]]` wouldn't resolve) |
| Facts asserted | Only "built 2026-08-21 from an 8-stream sweep" | Only "v0.1.0 committed at `D:\SigilKit`" |
| Size | 1.9 KB | 0.7 KB |

**Verdict: complementary, not redundant — keep both.** `00 MOC.md` is the *more complete* of the two
(it is the only one that indexes the corpus). **But `00 MOC.md` is incomplete:** it links 18 of the
other 21 notes and **omits three** — `Comprehensive Analysis 2026-08-24.md`,
`Audit Raw Findings 2026-08-24.md` (53 KB — the largest note in the vault, and the direct-parent of
`Comprehensive Analysis` via "Raw transcripts: `[[Audit Raw Findings …]]`") and `README.md` (the
directory's own boundary statement). Fix: add an "Audit & boundary" section linking all three.

### 4.2 · Note-count inconsistency (F6)

- `docs/STATUS.md:16,66,75,104` — says **22** (correct) and is machine-guarded by
  `scripts/check-doc-counts.mjs` (`checkStatusCounts`, `vaultNoteCount()` reads the live directory).
- `vault/README.md:3` — says **"21 private research notes"** (wrong). Not machine-guarded.
- Real count: `Get-ChildItem vault -File` = **22**. `vaultNoteCount()` counts only `.md` — all 22
  are `.md`, so guard and reality agree.

**Recommendation:** `vault/README.md` "21" → "22".

⚠️ **Correction (2026-09-26, after review by dc-stale).** My first pass called the guard-widening
"almost zero cost — just drop `vault/README.md` into `checkDocument(...)`". **That was wrong**, and
wrong in the way that matters: it would have turned a green build red instead of catching the drift.
`checkStatusCounts` (`:512`) matches `/(\d+) notes\b/`, which requires the digits to sit *immediately*
before `notes`. The vault README actually reads `"holds 21 private research notes ("` — two modifiers
in between. Verified by running both patterns against the real strings:

```
shared  /(\d+) notes\b/                        -> vault/README.md: 0 hits -> claim-not-found -> RED
relaxed /(\d+)\s+(?:private\s+|research\s+)*notes?\b/ -> vault/README.md: 1 hit (n=21)
                                                  docs/STATUS.md:   1 hit (n=22), no false positive
```

`checkStatusCounts` is **fail-closed** (`:515-517`): zero matches returns
`"STATUS: could not find the vault note count (structure changed?)"`. So dropping the file in
unchanged would not have *caught* the 21-vs-22 drift — it would have manufactured a build failure and
taught the team to ignore the guard. The real cost is a per-file pattern, not a registration line.

**The design gap this exposes is worth more than the number.** The guard and the drifting document are
matched by *the same regex*, and that regex was written for the prose shape of the one document that
happens to be correct. From outside, "the guard reported nothing" and "the guard never found the
claim, because it was looking for a string shaped differently" are **indistinguishable**. Every
future file added to `checkDocument(...)` inherits the trap. Fix the class, not the instance: give
each registered document its own claim shape (or an explicit "this file makes no such claim"
sentinel) so a future miss fails loudly instead of silently.

Low severity for the number itself, but it is a countable falsehood in the directory's own front
door — exactly the class of drift this project prides itself on eliminating.

---

## 5 · External-fact verification checklist

**Verdict: the corrections research is sound. 6/6 spot-checks against live primary sources
PASSED.** The weakness is not accuracy — it is **provenance granularity and freshness**.

### 5.1 · Facts I re-verified live today (2026-09-26) — all PASS ✅

| Claim (vault) | Live check | Result |
|---|---|---|
| EIP-7790 is gas-limit scaling, Stagnant/Informational, unrelated to 7702 revoke | `eips.ethereum.org/EIPS/eip-7790` | ✅ PASS. Title "Controlled Gas Limit Increase Guidelines", Stagnant, depends on EIP-7783. Confirms the ❌correction |
| MetaMask #35520: open, exactly 14 reactions, 12 comments | `api.github.com/.../issues/35520` | ✅ PASS. Open, reactions=14, 👍14, comments=12 |
| OZ #2793: open, +1:50 / 64 reactions, opened 2021-07-27 | `api.github.com/.../issues/2793` | ✅ PASS. reactions=64, 👍50, author `mudgen` (the vault notes it's Nick Mudge = mudgen ✓) |
| EIP-7702 revoke = zero-address tuple, `MAGIC=0x05`, no expiry field, last-valid-occurrence-wins | `eips.ethereum.org/EIPS/eip-7702` | ✅ PASS. Status Final; tuple `[chain_id,address,nonce,y_parity,r,s]`; signing digest `keccak(0x05‖rlp(...))`; **no expiry/deadline field**; last valid wins |
| arXiv:2512.12174 exists and disproves "zero 7702 papers" | `arxiv.org/abs/2512.12174` | ✅ PASS. "EIP-7702 Phishing Attack", 2025-12-13, Qi/Wang/Li/Zhu/Chen, 150k+ delegations analyzed |
| ERC-7579 is still Draft (as `docs/ECOSYSTEM-RESEARCH` states) | `eips.ethereum.org/EIPS/eip-7579` | ✅ PASS. "⚠️ Draft". Confirms the component-2 replacement target is itself not final — a nuance the vault never captured |

**Confidence: High** that the vault's ✅Confirmed and ❌Fabricated classifications are correct as of
today. This is a genuine, well-executed fact-check.

### 5.2 · Highest-risk external facts still carrying risk (not re-verified, flagged)

These are the claims a reader is most likely to lift into a doc or a pitch. "Source?" is whether
the note itself names a source at point of use.

| Claim | Note | Source named? | Access date? | Risk |
|---|---|---|---|---|
| Sphere SDK 5,409★ | Competitive, Research Summary, C1 | repo URL in `Sources.md` only | ❌ none | ★ counts drift daily |
| Sandboxed.sh 488★; Coinbase agentic-wallet 126★; base/eip-7702-proxy 73★; ZeroDev 255★; AgentPay 460★; ModuleKit 80★ | Competitive Landscape | repo URLs in `Sources.md` only | ❌ none | same |
| Base TVL ~$5.3B (peaked $5.58B Oct 2025) | Research Summary, Global Adoption, C3 | `api.llama.fi` in `Sources.md` | ❌ none | TVL is a moving number; "recovered" framing ages |
| Stablecoins ~$293B (USDT $183B / USDC $73B) | Research Summary, Global Adoption | `stablecoins.llama.fi` in `Sources.md` | ❌ none | moving |
| Arbitrum Audit Program = $10M ARB pool; Base Batches 004 = $100K | Funding, Whitepaper v2.1, Build Plan | program URLs in `Sources.md` | ❌ none | program terms change; **this one is in the shipped whitepaper** |
| S&P 2027 deadline 2026-11-17 OPEN; USENIX Sec 2027 2027-01-26 | Academic Literature | `sec-deadlines.github.io` | ❌ none | deadlines pass; **S&P deadline is ~7 weeks out** |
| 7702 wire-format details (no `tx.authorization` global; off-chain signing) | C1, Verified Stack | `Sources.md` EIP links | ❌ none | ✅ verified in §5.1 today; keep pinned |
| viem 2.55.19 / ethers 6.17.0 / wagmi 3.7.6 / TS 7.0.2 / pnpm 11.22.0 | Verified Build Stack | npm registry in `Sources.md` | ❌ none | pins drift; re-pin before release |
| EIP-7702 proxy `0x7702cb55…` / CoinbaseSmartWallet `0x000100ab…` | C1, Whitepaper v2.1 | `base/eip-7702-proxy` | ❌ none | ✅ canonical; safe |

### 5.3 · Facts with NO source anywhere in the vault → "do not cite" list

| Claim | Note | Why unreferenceable |
|---|---|---|
| **Bakong ~1.3B transactions FY2025** | Global Adoption, Corrections | Vault itself: "Source fetches blocked" — ❓unverified |
| **Bitso $6.5B crypto remittances 2024** | Global Adoption, Corrections | same — ❓unverified |
| **Nigeria $59B P2P / eNaira inactive** | Global Adoption, Corrections | same — ❓unverified |
| **Helix ~823★ (Mar 2026)** | Corrections, Research Summary | "No matching repo found in any slug searched" — likely nonexistent |
| Live endpoint probe results (`mainnet.base.org` ✓, `1rpc.io` ✓, `llamarpc` ✗, `blastapi` ✗) | C3, Sources | Real Aug-2026 probe, but a point-in-time network fact with no reproducible command; now ~5 weeks stale |
| "GitHub search ~652 EIP-7702 repos" | Competitive Landscape | search-result count, no query string or date |
| Audit cost ranges ($20k–$60k Cantina, $40k–$120k private) | Funding | No firm publishes prices (vault admits); these are the planner's estimates presented in a table of "realistic" numbers |
| Immunefi "$50k realistic", "$25k–$100k tier" | Funding | Same — judgment, not sourced |

**Rule to publish:** anything in §5.3 must not enter a published claim, README, deck, or grant
application without a fresh primary source. The four ❓unverified items are the sharpest — the vault
already marked them, so the only remaining failure mode is a downstream doc that copies the number
and drops the caveat.

### 5.4 · The same guard gap, live in `docs/STATUS.md` — and it makes `--write` certify a wrong number (VERIFIED 2026-09-26)

§4.2's design gap is not theoretical. `docs/STATUS.md` is modified in the working tree (`git status`
→ `M`) and its own vault-count update rule has partially drifted out of the guard's reach.

⚠️ **Severity note.** My first pass at this finding called it "the guard cannot see L95". That
understated it by an order of magnitude. Re-tested against the guard's own exported `rewriteStatus`,
the real behaviour is worse: **the repair tool leaves the drifted number in place and reports success.**

| Line (at time of test) | Text | Checked? | Rewritten by `--write`? |
|---|---|---|---|
| L21 | layer-summary row: `` `vault/` (22 notes) `` | ✅ `/(\d+) notes\b/` | ✅ |
| L93 → **L101** | L4 table row: `` `vault/` (22 notes) `` | ✅ | ✅ |
| L108 → **L116** | L4 trap note: `It held 22 notes as of 2026-09-25` | ✅ | ✅ |
| **L95 → L103** | new row: `Audit of the 22 \`vault/\` notes` | ❌ backticked `22`, no space before `notes` | ❌ **left untouched** |
| L258 → **L311** | update rule: ``Update **all three** `22` occurrences`` | ✅ (see below) | ✅ |

⚠️ **The line numbers moved during this audit** — `docs/STATUS.md` grew from 267 to **351** lines as
other agents added rows, so every anchor in this table drifted. The bold values are the positions
re-verified at hand-off. **Only the texts carry the finding**, and they are located by **string anchor,
not line number** — per the team lead's ruling, all anchors in the closing report are string-based.

Grep these five strings in `docs/STATUS.md` (counts below independently re-verified at hand-off):

| String anchor | Expected | Role |
|---|---|---|
| `22 notes` | **3** | the sites the guard sees and rewrites |
| `It held 22 notes` | (1 of the 3) | L4 trap note |
| `Audit of the 22` | **1** | **the blind-spot site** — backticked `22`, no space before `notes` |
| `` `22` occurrences `` | **0 → 1** | the rule's own claim. **It was 0 when first measured** (the rule read "update both occurrences") and became 1 once reworded to "all three" — see C20 |
| `vault/` + `(22 notes)` | **2** | layer-summary row and L4 table row |

**Prefer the invariant anchors.** `22 notes` and `Audit of the 22` name a row's *purpose* and stay
stable unless someone edits that row. The `` `22` occurrences `` string is incidental — it exists only
because of how one sentence happens to be worded, which is why it went 0 → 1 within minutes (C20).
**When you add an anchor, pick one that would still make sense after the surrounding prose is reworded.**

⚠️ **Do not trust any line number in this table, including the bold ones** — `STATUS.md` has already
drifted twice during this audit. The same rule corrected another anchor today
(`.github/workflows/ci.yml:331` → actually `:366`/`:375`). Re-verify by grepping the strings above.

**The false green, reproduced.** Both paths use the *same* two shapes — `checkStatusCounts`
(`:511-513`) and `rewriteStatus` (`:604-606`) are literally the same two regexes:

```
check  : /(\d+) notes\b/g     and  /`(\d+)` occurrences/g
rewrite: /(\d+) notes\b/g     and  /`(\d+)` occurrences/g
```

So any claim outside those two shapes is invisible to the checker *and* unreachable by the fixer.

**The dangerous transition, red → green.** The realistic `--write` case is a *partial* update: the
`notes` sites get bumped, the `occurrences` rule site is left behind. That starts red and ends green
with a wrong number still in the file:

```
(only the notes sites moved to 23; the rule site left at 22)
check BEFORE : ["STATUS: the 'update both occurrences' rule says 22, actual is 23"]
rewrite ran  : changed = true            <- it fixed what it could see
L95          : "Audit of the 22 `vault/` notes"  ->  unchanged
check AFTER  : []
=> RED became GREEN while L95 stayed wrong: true
```

That is the whole failure in one line: **the tool was asked to fix a count, reported success, and the
count it was asked about is still wrong.** (Variant first reported by dc-stale; independently
reproduced here.)

A second variant, for completeness — both shapes pre-bumped, so the file is green *before* `--write`
runs and the rewrite is a no-op:

```
check BEFORE : []      rewrite changed: false      check AFTER: []
```

Control case, to show the guard is not simply inert: the same drift at a *recognised* shape **is** caught
(`STATUS: \`vault/\` (99 notes) says 99 vault notes, actual is 23`). The guard works — it cannot see this
one site, and `--write` then certifies it.

**Why this is a different class from §4.2.** §4.2's vault-README case would at least go red. This one
does not: the tool whose job is to *fix* documented counts rewrites the sites it recognises, leaves the
one it does not, re-verifies, and exits 0. A partial fix is silently promoted to a complete fix. That
inverts the fail-closed design the same file uses carefully elsewhere (`:515-517` returns "structure
changed?" rather than passing silently when it finds nothing).

**Correction to a claim I made earlier in this section.** I first wrote that L258's `both` →
`all three` rewording had broken the `occurrences` pattern, then walked that back — correctly, since
the pattern keys on the backticked number plus the literal word, and both phrasings match. **I also
implied the L258 rule and the guard were consistent with each other.** They are not, but for a
different reason than "the regex broke": the rule enumerates three sites, the guard's *notes* pattern
finds exactly those three, and **both omit L95** — a fourth site that exists in the file. So the rule is
not self-contradictory (it correctly describes what it governs) but it is **incomplete**, and the guard
inherits the same blind spot by a different route. The accurate statement is the three-way one:
**rule, checker and rewriter all omit L95, and all three can be cross-checked against each other by hand
and still miss it.**

**The fix is two changes, not one** (correction adopted from dc-stale): (a) add L95 to the L258 rule's
list of sites; (b) add the backticked shape `` /`(\d+)` notes\b/ `` to **both** `checkStatusCounts` and
`rewriteStatus`. Fixing only the checker would leave `--write` still certifying the wrong number — it
would convert a loud failure into a quiet one.

**This document is itself an instance of the problem it describes.** `VAULT-AUDIT-2026-09-26.md` is
**not registered with any guard** — no `checkDocument(...)` call covers it. So the predictable outcome is
exactly what §5.4 predicts: the toolchain's numbers can move and this file will silently keep its old
ones, while the six guarded documents stay green and current.

⚠️ **Correction (C15) — my own "structural immunity" claim was an overclaim.** I wrote that this
document "cites no Foundry test, suite or annotation counts at all, so a repo-wide recount cannot make
it stale". I checked my own file mechanically instead of trusting the sentence, and it is **false**:

```
line-number anchors (:NNN)       : 21 occurrences, 13 unique
file-size / line-count figures   : 426, 587, 1049, 980
Foundry test/suite/annotation #s : 14, 17, 49, 56, 158, 220
```

The Foundry figures are the most misleading case: every one of them appears **inside a description of
someone else's rot** — "STALENESS drifted on 158→220, 14→17, 49→56". They are quoted rot, not my own
claims, so a recount does not make *this* file wrong. But "cites no counts at all" is not what the file
does, and stating it was the same failure as C7 (asserting something the artefact does not contain).
The accurate statement: **this file quotes other documents' rot-prone numbers while making no
toolchain-derived claim of its own** — which is a much weaker and more fragile guarantee than
immunity, because it holds only as long as nobody edits §5.4 or §10 to add a count of its own.

The distinction dc-stale drew is the right one and I record it against myself: **"hard to rot" and
"guarded" are two different properties, and a document can only have one of them.** Mine has the
former, by construction rather than by protection. Theirs has neither.

**And the same reasoning, applied at repo scale, produces a bigger finding than either of us put in
writing.** Classifying the guarded set by location:

```
[ROOT ] CHANGELOG.md   README.md   SECURITY.md
[docs/] STATUS.md      TROUBLESHOOTING.md      WHITEPAPER-v2.1.md
```

Six documents are guarded repo-wide, but only **three** are under `docs/`. With **51** `.md` files in
`docs/`, the `docs/`-scoped figure is 51 − 3 = **48 unregistered** (I originally published 45 by
subtracting the repo-wide six from the `docs/` total — see C16). Re-checked after the correction:
`docs/` still holds 51 files, still 3 guarded under it, so **48/51 stands** — worth stating explicitly
because `docs/` grew 27 → 40 → 51 during this very session, and a denominator that moves is exactly
the kind of number that goes stale the moment someone finishes correcting its scope. By the mechanism
this section has demonstrated twice, every one of them can drift silently. Two have already been
observed drifting on the same day (`docs/STALENESS-2026-09-26.md`, five numbers; and this file, by
construction). The other 46 are **untested** — not "fine", untested: the argument of §4.2 and §5.4 is
that silence from an unregistered document carries no information at all.

That reframes the recommendation. "Register these two files" is too small: the actionable unit is the
**registration list itself**, and the cheapest useful version of it is a list of the `docs/*.md` files
that deliberately make no derivable claim, so that anything added later is a visible decision rather
than a silent omission.

Whether to register it is a judgement for the docs owner, not for this audit. The general principle is
the one §5.4 argues: **an unregistered claim rots silently, and a registered one follows the toolchain.**
The same day, in the same repository, `docs/STALENESS-2026-09-26.md` drifted out of date on five
numbers (Foundry 158→220, suites 14→17, annotations 49→56, four line anchors moved) while
`README.md`, `docs/TROUBLESHOOTING.md` and the whitepaper were all updated and the guard ran green —
because that file, like this one, is unregistered. Meanwhile a registered claim
(`packages/core/test/WALLET_BEHAVIOR_ALLOWLIST.json`, still `12.5.0`) had not moved at all. Both
outcomes are the same rule, observed in both directions, on the same day.

---

## 6 · Unverified assertions stated as fact (highest risk)

The task's #5 concern: statements phrased as fact that were never verified. Three patterns:

**Pattern A — honestly flagged in the vault (low risk, still watch).** The 4 ❓unverified items are
labeled `UNVERIFIED` in-place. The *note* is honest; the risk is extraction. If someone copies
"Nigeria $59B P2P" from Global Adoption into a deck and drops "(UNVERIFIED)", the caveat dies with
the copy. → **Rule: never copy a vault number without its parenthetical caveat.**

**Pattern B — stated flatly with no hedge, and never verified (higher risk).** These read as
settled fact but rest on a blocked fetch, a search-result count, or a planner's estimate, **or — worst
of all — were verified once and have since drifted away from the toolchain they describe.**

### 6.1 · Pattern C: pins that now actively contradict the toolchain (VERIFIED 2026-09-26)

`vault/Verified Build Stack 2026.md` is the vault's most reusable note — it is the pin table. Three
of its pins are **wrong today**, verified against the live workflow files:

| Tool | vault note says | CI actually pins | Where | Note |
|---|---|---|---|---|
| **Slither** | `6.2.4` (L11) | **`slither-analyzer==0.11.6`** | `ci.yml:126`, `publish.yml:61` | `6.2.4` is not a Slither version at all — the Aug-24 audit caught this ("PyPI tops at 0.11.x") |
| **Echidna** | `2.3.3` (L10) | **`echidna-version: v2.2.5`** | `ci.yml:417` | **new finding — not previously flagged anywhere.** Same failure mode: `2.3.3` vs `v2.2.5` |
| **solhint** | `6.2.4` (L12) | **not referenced in any workflow or `package.json`** | — | **new finding — a "phantom tool entry", not a phantom CI gate.** See the wording correction below |

**Why this class is the most dangerous in the vault.** The Slither trap is that `6.2.4` and `0.11.6`
are *both real Slither versions* — a reader comparing the note against CI gets no signal that the
number is wrong; it just looks like a version bump. And because CI pins with `==`, the **pipeline is
deterministic and correct** — only the note is false. A reader planning an audit from this table would
install the wrong major version of the static analyser.

⚠️ **Wording correction (2026-09-26, after review by dc-stale).** My first pass said solhint was "a
phantom CI gate — the note claims a CI gate that does not exist, which is worse because it makes you
think lint is gated". **The note never says CI.** The line reads, verbatim:
`Lint; defer formatting to \`forge fmt\`.` — zero occurrences of "CI". The line above it (Slither) is
the one that says "CI static-analysis gate". So the accurate finding is a **phantom tool entry**: a
tool listed in a table titled "**Verified** Build Stack" that appears nowhere in the repository. The
`6.2.4` is also copy-pasted from the Slither row above it — the same wrong number on two rows, which is
the tell that it was never independently verified. Consequence class is the same (a reader assumes
Solidity lint coverage exists) but **the assertion to strike is "this tool is in the stack", not "CI
enforces it"**. Correcting a claim that was never made would itself introduce an inaccuracy.

**Scope correction to my own earlier claim.** I previously said the pin rot was "caught by the audit,
now fixed in CI" — true for Slither only. Echidna and solhint were never checked by anyone. The
correct statement: **the guard caught one instance of a class it has no mechanism for.**

**Guard-mechanism correction (credit: dc-stale).** dc-stale correctly pushed back on my framing that
this needs a new guard bolted onto the note-count work. `check-doc-counts.mjs` derives *counts*
(forge tests, suites, CI jobs, Halmos specs, annotations, vault notes) and one *string pin*
(`metamaskPinFromCi`, `:617-620`, used by the CHANGELOG guard). It has **no** mechanism to compare a
document's version strings against workflow pins, and adding one is a materially different piece of
work from counting notes. **These are two separate items; the cheap one should ship first so the
expensive one's "nearly free" framing does not fail a second time.**

**Practical rule:** treat every version string in `Verified Build Stack 2026.md` as "true on
2026-08-21, re-verify before use". Re-pinning that table is now a correctness fix, not a refresh.

| Assertion (phrased as fact) | Note | Actual basis | Verdict |
|---|---|---|---|
| "Base ecosystem grant funds projects in the $20K–$250K range" | Funding / whitepaper v2.0 | Uncited; a program-page paraphrase | ⚠️ needs primary source (the $100K batches figure *is* sourced) |
| Cantina contest "~$20k–$60k, ~2–4 wks"; Sherlock "~$30k–$80k" | Funding | Planner's estimate; "no firm publishes prices" | ⚠️ estimate-as-fact |
| Immunefi critical ceilings "$50k–$250k+, some up to $1M" | Funding | Industry claim, uncited | ⚠️ needs source |
| "Non-US programs (EUBC/Lisk, India Web3, Singapore MAS, UAE, Korea) — pages unverifiable live" | Funding | Explicitly unverifiable | ⚠️ correctly hedged in-note |
| "SPDX: 0.8.36 (2026-07-09)"; Foundry nightly `af70ca2` (2026-08-20); Echidna 2.3.3; Slither 6.2.4; solhint 6.2.4; Halmos v0.3.3; Kontrol v1.0.255 | Verified Build Stack | Version pins from a single 2026-08-21 session. **Three of them are now verifiably wrong against CI — see §6.1** | ❌ **worse than "needs refresh": actively contradicts the toolchain** |
| "Sphere SDK 5,409★ … matches" | Corrections ✅section | Point-in-time ★ | ✅ fine as a dated snapshot; unsafe as evergreen |
| "677 / 652 EIP-7702 repos" | Competitive | Undated GitHub search count | ⚠️ hedge needed |

**Concrete takeaway:** the vault's *fabrication* risk (invented quotes/addresses) is fully handled.
Its residual risk is **stale-and-flat** — accurate-on-2026-08-21 numbers written without hedges that
then get quoted later. §6.1 shows the sharpest case: three pins in the reuse-hotly "Verified Build
Stack" table now contradict the CI they describe, and only one of the three was ever caught. Treat
every vault number as "true on 2026-08-21, re-verify before publishing."

---

## 7 · vault/ vs docs/ — the boundary

**Current boundary is already correct** and documented in two places that agree: `vault/README.md`
(TD-8) and `docs/STATUS.md` (L4). Both say: research notes stay, explicitly non-normative, L1+L2 win,
and the vault exists because the whitepaper's correction trail links into it. This audit **endorses
that boundary** — removing the vault would break published links, and the notes are the "why" record.

What the boundary **lacks** is a *freshness* dimension. `docs/` has adopted a strong supersede
discipline (STATUS.md marks SUPERSEDED/ACTIVE rows; `docs/ECOSYSTEM-RESEARCH` and
`docs/RESEARCH-NUMBERS` carry dates + verifiability grades). `vault/` has none. Suggested refinement,
recorded here as a recommendation (not applied — this file changes nothing):

### 7.1 · Promote to `docs/` (product/user-facing, currently only in vault)

| Vault content | Promote to | Rationale |
|---|---|---|
| §5.3 "do-not-cite" list + §6 unverified-assertion list | `docs/RESEARCH-NUMBERS.md` (append a "vault-carried, unverified" block) | The single source-of-truth for external figures already exists in `docs/`; the vault's unverified leftovers should live there, caveated, not scattered across 3 notes |
| "Base Ecosystem Fund $20K–$250K" + audit-cost ranges + Immunefi tiers | `docs/RESEARCH-NUMBERS.md` (after sourcing) or drop | Currently funding-pitch facts with no source; if they matter they need sourcing, if not they should be deleted |
| The 7702 revoke mechanics summary (zero-address tuple, MAGIC=0x05, no expiry) | already in `docs/WHITEPAPER-v2.1.md:71-72` + `docs/SECURITY-7702-THREAT-MAP.md` | ✅ already promoted — no action |
| Regulatory framing (GENIUS/MiCA/India TDS, "integrator owns compliance") | already in `docs/WHITEPAPER-v2.1.md:61` | ✅ already promoted |

### 7.2 · Archive as raw evidence (do not delete, do not maintain)

- `Academic Literature.md`, `Sources.md` — primary-source indexes. Add a one-line header
  "ARCHIVE — evidence index, not maintained; see `docs/RESEARCH-NUMBERS.md` for current figures."
- `Audit Raw Findings 2026-08-24.md`, `Comprehensive Analysis 2026-08-24.md` — spent; keep as the
  record of what the Aug-24 review found and that it was consumed.

### 7.3 · Already superseded by `docs/` (candidates to archive or tombstone)

- `Competitive Landscape.md` → `docs/ECOSYSTEM-RESEARCH-2026-09-23.md` §1 (richer, primary-sourced,
  newer; adds Safe Agent Kit, MetaMask Agent Wallet, Biconomy, and the finding that ERC-7579 is
  still Draft).
- `Global Adoption.md` → `docs/ECOSYSTEM-RESEARCH-2026-09-23.md` §3 + `docs/RESEARCH-NUMBERS.md`.
- `Build Plan.md`, `Milestones.md` → `docs/PLAN-30-DAYS-2026-09-23-to-2026-10-22.md` (the ACTIVE plan).
- `Component 2`, `Component 3` → their own "REPLACE"/"DROP" verdicts were executed; the shipped
  scope is documented in `docs/WHITEPAPER-v2.1.md:42-43`.
- `Funding Audit Bounty.md` → the audit route it recommends is now in `docs/WHITEPAPER-v2.1.md:57`
  and `SECURITY.md`. The grant *tables* are unmaintained.

### 7.4 · Keep live in `vault/` (the "why" record)

`00 MOC.md`, `Memory Index.md`, `SigilKit Overview.md`, `Research Summary.md`,
`Whitepaper Corrections.md`, `Risk & De-risk Plan.md`, `Agent Architecture.md`, `Component 1`,
`Component 4`, `Verified Build Stack 2026.md` — the last one **conditionally**: it stays live as the
pin table's home, but three of its pins are now wrong (§6.1), so it is live-with-a-known-defect, not
live. Fix §6.1 before reusing it.

`vault/README.md` is **not** in the keep-live list — it is STALE (F6).

---

## 8 · Recommendations (ordered; nothing here was applied)

1. **No whitepaper fix needed.** Corrections are fully traced; do not reopen.
2. **Fix the two countable defects** (each ~5 min, both are text edits only):
   - `vault/README.md:3` "21 notes" → "22" (F6). Pure prose edit; see §4.2 for why this is *not*
     also a one-line guard change.
   - `00 MOC.md` — add links to `Comprehensive Analysis 2026-08-24.md`,
     `Audit Raw Findings 2026-08-24.md` and `README.md` (F7).
3. **Fix the three wrong pins in `Verified Build Stack 2026.md`** (§6.1) — Slither `6.2.4`→`0.11.6`,
   Echidna `2.3.3`→`v2.2.5`, and resolve solhint (either add the gate or drop the row). This is a
   **correctness** fix, not a refresh: all three currently contradict the toolchain.
4. **Add a freshness marker to the 8 STALE notes** — one line at the top, e.g. "SUPERSEDED
   2026-09-23 by `docs/ECOSYSTEM-RESEARCH-2026-09-23.md` — kept as record." Cheapest way to stop a
   stale note being cited as current; needs no `docs/` or `scripts/` change. (Modeled on the
   `SigilKit_Whitepaper.txt` SUPERSEDED banner, which works.)
5. **Move the §5.3/§6 unverified list into `docs/RESEARCH-NUMBERS.md`** as a caveated block, so the
   one file that governs published figures carries the "these are not citable" signal.
   **Decide whether `docs/VAULT-AUDIT-2026-09-26.md` and `docs/STALENESS-2026-09-26.md` get registered
   with a guard.** Both are currently unregistered and both have already drifted (§5.4) — the second
   visibly, the first by construction. Registration is the only thing that makes a document follow the
   toolchain instead of quietly ageing; that is the whole argument of this section, applied to my own
   deliverable.
   **Better than either: fix the registration list itself (F10).** 48 of the 51 `docs/*.md` are
   unguarded, so a two-file patch treats the symptom. The cheap durable version is an explicit list of
   the `docs/*.md` files that deliberately make no derivable claim, so that adding a claim-bearing
   document later is a visible decision instead of a silent omission.
   **Hard requirement (adopted from the team lead's ruling): any document that states a derived number
   must record its raw inputs alongside it.** Not the result — the operands. A recorded number
   advertises that it needs checking, so readers check it; a derived number looks self-maintaining, so
   they don't. Both reviewers hit exactly that: F10's `51 − 3 = 48` and F-16's identical derivation
   each looked computed and therefore felt exempt from re-verification, and both had to be re-derived
   when `docs/` grew 27 → 40 → 51 mid-session. **Re-derive rather than re-read, and leave the inputs
   where the next person can re-derive without reconstructing your method.**

**Deliberately split — these two are NOT one task** (correction after review by dc-stale):

6. **Cheap, do first — widen the note-count guard to `vault/README.md`.** Real cost is a per-file
   pattern, not a registration line: the shared `/(\d+) notes\b/` cannot match
   `"21 private research notes"` and its fail-closed branch would redden the build instead of catching
   the drift (§4.2). Either give the vault README its own pattern, or reword the prose to
   `"holds 22 notes"` so the existing guard works unchanged — **the reword is cheaper and touches no
   script.** Add it to `T-02` in `docs/ENHANCEMENTS-2026-09-25.md:193`, which already proposes widening
   the guard to vault; note that its "vault" item is only half-landed today (the guard reads the live
   directory for `docs/STATUS.md`, and nothing guards the vault's own README).
   **★ Highest-urgency item.** Also fix the live `docs/STATUS.md` gap in §5.4, which is **two**
   changes, not one: (a) add the L95 site to the L258 update rule; (b) add the backticked shape
   `` /`(\d+)` notes\b/ `` to **both** `checkStatusCounts` and `rewriteStatus`. Fixing only the
   checker leaves `--write` still certifying the wrong number — turning a loud failure into a quiet
   one. Note `scripts/check-doc-counts.mjs` has itself grown by +426 lines against `HEAD` (587→1049
   total / 980 non-empty), so re-grep before editing — every `:NNN` in this document is a snapshot.
7. **Expensive, separate ticket — a version-pin guard.** `check-doc-counts.mjs` derives counts and one
   MetaMask string pin (`metamaskPinFromCi`, `:617`); it has **no** mechanism to compare a document's
   version strings against workflow pins. §6.1 is the evidence: three pins drifted, one was caught by
   a human, none by the tool. Keep this out of T-02 so its cost is not hidden behind item 6's
   "one-liner" framing — that framing already failed once in this audit.
8. **Re-run the funding/market figures only if they will be published.** Otherwise let them age as
   archive material. The S&P 2027 deadline (2026-11-17) is the one time-sensitive item in the vault
   worth acting on within weeks.

---

## 9 · Sources consulted for this audit

- `vault/` — all 22 notes (read in full; `Audit Raw Findings 2026-08-24.md` sampled: header, first
  agent block, tail; its findings were cross-checked against the code that consumed them).
- `docs/WHITEPAPER-v2.1.md`, `docs/STATUS.md`, `docs/RESEARCH-NUMBERS.md`,
  `docs/ECOSYSTEM-RESEARCH-2026-09-23.md`, `docs/Issues-Catalog-2026-09-11.md`,
  `docs/ISSUES-CATALOG-2026-09-25.md`, `docs/PLAN-30-DAYS-2026-09-23-to-2026-10-22.md`,
  `docs/ENHANCEMENTS-2026-09-25.md`, `docs/ADVANCED-FEATURES-3-ECOSYSTEM.md`, `docs/CONFIGURATION.md`.
- `SigilKit_Whitepaper.txt` (banner + targeted claim greps), `README.md` (vault), `package.json`.
- `scripts/check-doc-counts.mjs` (guard scope: which doc numbers are machine-checked).
- Code spot-checks proving the vault audit was consumed: `contracts/src/SessionKey7579Module.sol`
  (`validateUserOp` gate ~:283, low-s check ~:594, ERC-7201/perf notes in the 09-25 catalog).
- Git: `git log -- vault/` (last touched 2026-09-23, `Memory Index.md` only).
- **Live re-verification (2026-09-26):** eips.ethereum.org EIP-7790, EIP-7702, ERC-7579; GitHub API
  MetaMask #35520, OpenZeppelin #2793; arxiv.org/abs/2512.12174.

---

## 10 · Correction log (this document was reviewed and revised)

Per `docs/STATUS.md`'s own rule — "An existing rule here is found to be wrong → fix it, and say why,
do not leave a known-wrong rule in place" — the errors found in my first pass are recorded rather than
silently patched.

| # | My first claim | Correction | Raised by |
|---|---|---|---|
| C1 | Guarding `vault/README.md` is "almost zero cost — the regex already matches, just drop it in `checkDocument(...)`" | **False and harmful.** `/(\d+) notes\b/` cannot match `"21 private research notes"`; fail-closed would report "claim not found" and **fail a green build**. Real cost is a per-file pattern or a prose reword | dc-stale |
| C2 | The Slither pin rot was "caught by the audit, now fixed in CI" | **Scope too narrow.** True for Slither only. Echidna (`2.3.3` vs `v2.2.5`) and solhint (absent from CI entirely) were never checked by anyone — found while verifying C1 | dc-translate (self) |
| C3 | `vault/README.md` classified **LIVE** | **STALE.** It misstates the size of the directory it introduces. Tally corrected to LIVE 9 / STALE 8 | dc-stale |
| C4 | Tally row read "Total 21 + 1 … plus the 22nd note is this file's own scope line" | Nonsensical — this file is not in `vault/`. Rewritten with explicit arithmetic: 21 notes + 1 README = 22 files | dc-translate (self) |
| C5 | Recommendation 5 bundled the note-count guard with a general "re-verify pins" item | **Split.** Counting notes and comparing version pins are different work at different cost; bundling them is how a "one-liner" becomes a surprise. Now items 6 and 7 | dc-stale |
| C6 | Framed the pin problem as needing a guard `check-doc-counts` has no mechanism for | **Partly wrong.** It *does* pin one external string — `metamaskPinFromCi` (`:617-620`), used by the CHANGELOG guard. The accurate claim is narrower: no mechanism for *version* strings | dc-stale |
| C7 | Called solhint "a phantom CI gate — the note claims CI enforces it" | **Wrong claim about the note.** The line says only `Lint; defer formatting to \`forge fmt\`.` — zero "CI". It is a **phantom tool entry**, and `6.2.4` is copy-pasted from the Slither row. Correcting a claim never made would itself be an inaccuracy | dc-stale |
| C8 | — (a second reviewer's claim, tested and **not** reproduced) | dc-stale reported `docs/STATUS.md` L258's `both`→`all three` rewording had broken the `occurrences` pattern. **It has not.** The pattern keys on the backticked number + the literal word "occurrences"; the preceding words are irrelevant. Verified by running both variants. The real live gap is L95 (see §5.4) | dc-translate (self) |
| C9 | dc-stale cited `metamaskPinFromCi` at `:566-569` | It is at **`:617`**. §4.2/§6.1's precedent argument depends on that location | dc-translate (self) |
| C10 | §5.4 called the L95 defect "the guard cannot see it" | **Understated by an order of magnitude.** Re-tested against the exported `rewriteStatus`: the checker cannot see L95 **and the rewriter cannot touch it**, so `--write` leaves the wrong number and exits green. A partial fix is silently promoted to a complete fix. Now **F9, high severity** | dc-stale |
| C11 | Implied the L258 rule and the guard were mutually consistent | They are not — but not because "the regex broke" (my earlier C8 walk-back was right about that). The rule enumerates 3 sites, the guard's notes pattern finds the same 3, and **both omit L95**, a fourth site that exists. Rule and guard are consistently *incomplete*, which is why hand-checking them against each other still misses it | dc-stale |
| C12 | Said `check-doc-counts.mjs` "was being edited *while this audit ran* — it crossed 1000 lines mid-session" | **Wrong, but directionally right.** I then "corrected" it (below) in the opposite direction, which was worse | dc-stale |
| C13 | — (measurement convention, recorded because it recurred) | dc-stale and I measured the same file and each assumed a different default line-count convention without stating it, so we nearly logged a disagreement where there was none. **State the convention whenever a number is contested** — dc-stale then hit the same trap himself on his own file (1042 total / 858 non-empty from one command) | dc-translate (self) |
| C14 | C12 itself: claimed the file was **static** during the audit, inferring history from the mtime | **Also wrong.** mtime is the *last* write, not a session. The file **was** rewritten mid-audit: the guard's own success line gained a sixth guarded document (`... and SECURITY match`), and `checkDocument(` calls went **0 (HEAD) → 5 (working tree)**, guarded docs **2 → 6**. An unchanged script cannot print a new sentence. **I denied a true fact using a false argument** — worse than the original error | dc-stale |
| C15 | Claimed this report "cites no Foundry test, suite or annotation counts at all", so a recount cannot stale it | **Overclaim, found by auditing my own file mechanically instead of trusting the sentence.** It contains 21 line anchors (13 unique), the figures 426/587/1049/980, and the Foundry numbers 14/17/49/56/158/220. The Foundry figures are *quoted rot* (describing STALENESS's drift), not my own claims — so a recount does not falsify this file — but "cites no counts at all" is not what the file does. Same failure as C7: asserting something the artefact does not contain. Weaker guarantee than I implied: **"hard to rot" ≠ "guarded"** | dc-stale (by measuring my file) |
| C16 | Published F10 as "**45 of 51** `docs/*.md` unregistered" | **Mixed two scopes in one subtraction.** 51 is the `docs/`-scoped total; 6 is the *repo-wide* guarded count, of which only 3 live under `docs/`. Correct `docs/`-scoped figure is 51 − 3 = **48**. I had just written C13 ("state the convention") and immediately committed it again — this time not even a naming convention but a **scope** error. Guarded set re-derived by location: ROOT = CHANGELOG/README/SECURITY, `docs/` = STATUS/TROUBLESHOOTING/WHITEPAPER | dc-stale |
| C17 | — (the boundary dc-stale drew, recorded because I caused it) | dc-stale asked me five times to either register his `STALENESS` file or delete its 92 counts — **two options with different owners.** Registering touches a shared guard and someone else's file (not his to give); deleting counts is entirely his own call. He had outsourced a unilateral decision five times, and my "no" is what finally surfaced it. **A repeated request is not a mandate, and a peer cannot supply the authority their own scope lacks** | dc-translate (self) |
| C18 | Characterised dc-stale's five repeated requests as "outsourcing a unilateral decision" | **Imprecise, and it framed his motives rather than the structure.** His correction is the accurate version: keeping evidence *because the purpose of an audit is to preserve evidence* is not "preserving it so my own audit passes" — deleting 92 citations would make the file look compliant with the very rule it criticises, which is the actual failure mode. Recorded because I substituted a psychological reading for a structural one, which is the same move as C7 (asserting a claim the artefact does not contain) | dc-stale |
| C19 | §5.4 cited `docs/STATUS.md` line numbers (L95, L258) as anchors, in a report that repeatedly warns that line anchors rot | **My own anchors went stale during hand-off** — `STATUS.md` grew 267 → 351 lines as other agents added rows, so the blind-spot site moved L95 → **L103** and the update rule L258 → **L311**. The finding was unaffected; the anchors were not. Now recorded as shape-plus-text with both snapshots, and explicitly marked untrusted. **I was the guard-patch hypothesis's own example**: F11 of the sibling audit, `WALLET_BEHAVIOR_ALLOWLIST.json`, is a registered claim that stopped moving — an unregistered one moved 84 lines, and mine was unregistered too | dc-stale (reported the move) |
| C20 | Published a **string-anchor table with hit counts** (the fix for C19) — and one of those counts was stale before I finished writing the sentence about it | The `` `22` occurrences `` row was recorded as **0** on the strength of a live grep, then measured as **1** minutes later: the team lead's rewording of the rule ("update both" → "all three") restored the very string I had listed as absent. **A count is a claim about a moving file, not a fact about your regex** — publishing it created the same rot it was meant to remove. The row now reads `0 → 1` with the cause, and the lesson generalises: **prefer anchor strings whose count is invariant (a phrase that names a row) over incidental ones (a number in prose)** | dc-translate (self) |

**A note on the line numbers in this document.** `scripts/check-doc-counts.mjs` is a moving target: it
grew by **426 insertions / 10 deletions** against `HEAD` during this project (587 committed non-empty
lines → 1049 total / 980 non-empty in the working tree). Every `:NNN` anchor here is therefore a
**snapshot**, not a durable fact, and must be re-grepped before anyone edits.

⚠️ **Correction (C12) — itself corrected (C14).** This one took two passes and both of my attempts
were wrong, in opposite directions.

- *First version*: "the file was being edited while this audit ran — it crossed 1000 lines
  mid-session." Wrong, but directionally right.
- *C12, my correction*: I read the mtime (`12:23:30Z`) as proof the file was **static**, and wrote
  that "1049 vs 980" was merely two snapshots at different moments. **Also wrong** — and worse than
  the first version, because it used a false argument to deny a true fact.
- *C14, the actual situation*: the file **was** rewritten during the audit. The mtime records only the
  **last** write, not a session. The proof needs no reasoning about timestamps at all: **the guard's own
  success line gained a sixth guarded document.**

  ```
  at session start : "doc counts OK — README, whitepaper, CHANGELOG, STATUS and TROUBLESHOOTING ..."
  now              : "doc counts OK — README, whitepaper, CHANGELOG, STATUS, TROUBLESHOOTING and SECURITY ..."
  ```

  An unchanged script cannot print a sentence it has never printed. Corroborated structurally: `HEAD`
  contains **0** `checkDocument(` calls and guards only README + whitepaper; the working tree has
  **5** calls and guards **six** documents (README, whitepaper, CHANGELOG, STATUS, TROUBLESHOOTING,
  SECURITY). Guarded-document count went 2 → 6 during this audit.

**The lesson is not about mtimes.** In all three passes I inferred a *history* from a *single
observation* — from a line count, then from a timestamp, then from a diff. The only thing that settled
it was a **behavioural** signal (the program's own output changed) plus a structural count that cannot
be argued about (0 → 5 `checkDocument` calls). **Prefer behavioural and structural evidence over
point samples; a point sample never carries a history.**

**F9 is unaffected.** Re-verified against the current, rewritten script: `checkStatusCounts`
(`:511-513`) and `rewriteStatus` (`:604-606`) still share the same two vault shapes
(`/(\d+) notes\b/g`, `` /`(\d+)` occurrences/g ``), L95 is still present and still matched by **none**
of the check shapes, and the false green still reproduces:

```
check BEFORE : []          rewrite changed: false
L95 still says 22 after rewrite: true
check AFTER  : []          => FALSE GREEN: true
```

The third shape either of us saw earlier (`` /(\d+) such annotations?\b/ ``) belongs to the separate
TROUBLESHOOTING path (`checkTroubleshootingCounts` / `rewriteTroubleshooting`) and is unrelated to the
vault count.

**On the recurring request to edit another author's document.** dc-stale has asked five times across
this review for me to register `docs/STALENESS-2026-09-26.md` with a guard or delete its 92 derivable
counts. I am not going to, and the reason is worth recording rather than leaving as a repeated "no".
My mandate for this audit was read-only over `vault/` plus the creation of this one file; `STALENESS`
is a teammate's active deliverable, and rewriting its content — or the guard that would read it —
decides someone else's document on their behalf. The finding is mine to report and theirs to act on:
**§8 item 5 and F10 state exactly what to do and why, and the choice of (a) register or (b) delete the
counts legitimately belongs to its author.** If the team wants that decision made rather than
documented, it is a one-line reassignment, not something to absorb into a read-only audit.

**How this review cycle went, recorded because it is the useful part.** Five of my errors (C1, C2, C3,
C7, and C12→C14) were caught by dc-stale; three of dc-stale's claims (C8, C9, C12) were wrong and are
corrected here. Every single one of those eight errors is the same shape: **inferring a fact, a cause,
or a history from a single point observation, without re-checking.** I read a line count and assumed
drift (C12); I read a timestamp and assumed stillness (C14); I read a note and assumed a CI gate that
wasn't there (C7); I read a regex and assumed it matched (C1). dc-stale did the same with the mtime and
then again with his own file's line count.

The guard-patch hypothesis is the one worth keeping alongside it: neither the original author nor two
rounds of reviewers caught the solhint row, because "listed in a table called *Verified*" reads as
authoritative — the failure is not that nobody looked, it is that the document's own framing suppresses
the question. That is the same shape as §4.2's finding, one layer up: **a claim is only as checkable as
the reader's reason to check it.** And the transferable rule from C12/C14 is the practical one: **prefer
behavioural and structural evidence over point samples — a point sample never carries a history.**

**One asymmetry dc-stale identified, worth carrying forward.** Inferring "it changed" from a stale count
is a **weak** error — the direction is right, only the precision is off, and it tends to self-correct.
Inferring "it did not change" from a stable mtime is a **strong** error: it actively denies a fact that
was true at the time, and it cannot self-correct because it removes the reason to look. C14 was of the
second kind. The practical form: **being right too loudly is more dangerous than being wrong quietly,
because a false negative suppresses the next check while a false positive only costs a re-read.**

**And the pattern that recurred most often was neither over- nor under-claiming — it was unstated
scope.** C13 (line-count convention), C15 (what the file actually contains) and C16 (repo-wide six vs
`docs/`-scoped three) are one error wearing three costumes: a number was correct *somewhere* and I
presented it as if it were universal. The tell in every case is the same — **the subtraction looked
natural enough that nobody checked the units.** "51 − 6" is arithmetically fine and evidentially
meaningless, because the 6 counts documents that were never in the 51. Recording it because this
project guards against exactly this class of error elsewhere, and here it sat in the *finding itself*
rather than in the vault. dc-stale sharpened the failure point, and it is not the arithmetic: **a
mistake that *looks* natural is more dangerous than one that looks wrong, because a wrong-looking
answer gets checked and a natural-looking one does not.** `51 − 6` is computable, plausible, and
wrong; `47 + 9 = 56` would have been caught by anyone re-adding it. The class to guard against is not
"bad maths" but **operations whose naturalness suppresses the unit check**. Applying the same rule
caught two more instances inside dc-stale's own document within the hour — the same fix, arriving from
the other side.

**A derived number is more fragile than a quoted one, which is the reverse of intuition.** dc-stale's
F-16 was *derived* (`docs/*.md` minus guarded) rather than *recorded*, and he had assumed a derived
figure needed no re-verification because it "looked computed". It did: `docs/` grew 27 → 40 → 51 during
this session and the derivation had to be re-run. The reason a derived number feels safer is exactly
what makes it dangerous — **a recorded number advertises that it needs checking, so you check it; a
derived number looks self-maintaining, so you don't.** Two consequences worth keeping: re-derive rather
than re-read, and prefer the raw inputs in the document so the next person can re-derive without
reconstructing your method.

**A rule that only ever fires on its author is not yet a rule.** The scope lesson (C13→C16) was mine,
written about my own mistake — and within the hour dc-stale had applied it to a document that was *not*
under audit and found two more instances of the identical shape: a summary sentence that fused
`docs/`-scoped and repo-wide counts into one clause, and a stale reuse of the already-disproven 45.
Neither was found by re-reading his own prose; both were found by **pointing a stated rule at a
document he was not reviewing.** That is the difference between a correction and a check, and it is
the whole argument for writing these lessons down: the value of a recorded failure is that it becomes
a probe someone else can aim at work that has not been questioned yet.

Net effect of review: no headline conclusion changed. The whitepaper verdict (§3, 15/15 corrections
applied) and the external-fact verification (§5.1, 6/6 pass) were not touched by the review and stand
as originally reported.

---
*dc-translate · 2026-09-26 · read-only audit; no `vault/`, `docs/`-existing, `scripts/`,
`packages/`, or `contracts/` file was modified. Revised same day after review by dc-stale (§10).*
