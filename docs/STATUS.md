# SigilKit — document authority model (TD-4)

SigilKit's documentation answers three different questions, and conflating them is how
trust anchors break. This file is the **index and conflict-resolution rule** for the repo:
it says which file to read for which question, and which one wins when two files disagree.
It does not itself restate technical claims — if a number or status appears here and in a
spec, the spec wins.

**A document is only useful if you can tell what kind of claim it is making.** That is what the
layers are for: L1 is what the code *is*, L2 is what *changed*, L3 is what to *do*, L4 is *why*,
and L5 is *how to use it*. A plan quoted as a fact, or a reference quoted as a specification, is
how a stale sentence survives a release.

Documents are sorted into five layers. The layer, not the filename, decides authority.

| Layer | Kind | Answers | Changes | Example |
|---|---|---|---|---|
| **L1** | Normative | *What is true* | Only by changing the code | `contracts/src/`, `packages/*/src/` |
| **L2** | Record | *What changed, and who waived it* | Append-only, per release | `CHANGELOG.md`, `docs/CI-WAIVERS.md` |
| **L3** | Plan | *What to do next* | Frequently; goes stale by design | `docs/PLAN-30-DAYS-*.md`, latest `docs/Issues-Catalog-*.md` |
| **L4** | Context | *Why* | Rarely; never normative | `docs/WHITEPAPER-v2.1.md`, `SigilKit_Whitepaper.txt` (superseded), `vault/` (22 notes) |
| **L5** | Reference | *How do I use it* | With the behaviour it describes | `docs/CONFIGURATION.md`, `docs/TROUBLESHOOTING.md`, `docs/DEPLOYMENT.md`, `docs/GETTING-STARTED.md` |

---

## L1 · Normative — the code is the specification

| File | Status | Layer | Who wins |
|---|---|---|---|
| `contracts/src/*.sol` | **CURRENT** | L1 | Final authority on every on-chain behaviour, cap, event and invariant |
| `packages/*/src/**/*.ts` | **CURRENT** | L1 | Final authority on SDK/CLI/MCP/indexer behaviour, digests, defaults |

If a document contradicts the code, **the code is right** and the document is a bug. A
`docs/` claim about behaviour is only ever a convenience; it is never the spec. Test and CI
counts are *not* L1 facts — they are verified against the toolchain by
`node scripts/check-doc-counts.mjs` (`npm run check:docs`), and that script wins over prose.

## L2 · Record — traceable history of change and waiver

| File | Status | Layer | Who wins |
|---|---|---|---|
| `CHANGELOG.md` | **CURRENT** release log | L2 | Authoritative for *what a given release contains*; `[Unreleased]` is the in-flight record |
| `docs/CI-WAIVERS.md` | **CURRENT** waiver register (TD-6) | L2 | Authoritative for every `continue-on-error` waiver and its dated removal criteria |

L2 is append-only by convention. It answers "when and why did this change / who accepted
this risk", never "how does the system behave now" — that is L1.

### Closed records

Individual finding-level closures tracked here, so that a closure is not lost when the finding's
home document is an L3 plan that goes stale. Each entry is a *record of a decision* (L2), never a
restatement of current behaviour (L1) — for behaviour, read the code.

| Finding | Decision | Closed | Evidence | Where the detail lives |
|---|---|---|---|---|
| **SEC-10** — rotation resets the new key's window, so `perWindowCap` can be refreshed across rotations (`Medium`, CVSS 4.9) | **Option B, owner-ruled**: window state is deliberately per-key, and a rotation intentionally starts the successor on a fresh window. Re-classified from an agent-reachable bypass to an **owner-side configuration** property — `grantSessionKey` and `rotateSessionKey` are both `onlyOwner`, so no agent can rotate itself into a fresh budget. | 2026-09-28 | 6/6 green in `Sec10WindowRotation.t.sol`; full suite 224 passed / 0 failed / 1 skipped. `forge 1.7.1`, run from the **repo root** (`foundry.toml` is there, not in `contracts/`) | `docs/CI-WAIVERS.md` → "Closed entry — `test_Sec10_LineageWindowCap`"; semantics in `SpendPolicy` NatSpec ("INV-1 scope") |

**Pre-closure history, retained deliberately.** SEC-10 was, until 2026-09-28, recorded as
*undecided* in several documents at once: `docs/DOC-AUDIT-CONTRACTS-2026-09-26.md:108`
("`contracts/` is frozen and SEC-10 is undecided"), `:342` and `:1153-1159` (which describe the
test as *intentionally red* and instruct a future `verify:` gate to tolerate it), and
`docs/SECURITY-AUDIT-2026-09-26.md:333` ("unfixed"). Those statements were accurate when
written — the code genuinely had no carry-over, and the Option A implementation they discuss
was reverted. They are **history, not current status**, and are left in place as the L2 record.
The claim that was never re-executed and did not survive contact with the toolchain was the
*intentional redness* itself: all six tests are green.

Note the trap this closure sets, now that the "delete these tests" instruction is gone: the six
SEC-10 tests **are the evidence** that Option B holds. Any future tidy-up that removes them
makes the resolution unverifiable. See the closure note in `docs/CI-WAIVERS.md`.

## L3 · Plan — what to do next (expires; do not cite as fact)

| File | Status | Layer | Who wins |
|---|---|---|---|
| `docs/PLAN-30-DAYS-2026-09-23-to-2026-10-22.md` | **ACTIVE** — the plan currently being executed | L3 | Authoritative for the current work order and each task's proof obligation; expires 2026-10-22 |
| `docs/ISSUES-CATALOG-2026-09-25.md` | **ACTIVE** — latest catalog (100 items, 2026-09-25) | L3 | Authoritative for the newest triaged findings and the dependency order to fix them |
| `docs/Issues-Catalog-2026-09-21-Agent-Review.md` | ACTIVE companion — AC-series tracker | L3 | Authoritative for AC-01..AC-33 status; AC-32/33 (indexer fixes) closed 2026-09-23 |
| `docs/Issues-Catalog-2026-09-23-C-Performance.md` | ACTIVE companion | L3 | Performance stream (C-series) |
| `docs/Issues-Catalog-2026-09-17.md` | SUPERSEDED by the 09-21 / 09-25 catalogs | L3 | Historical; SK-01..SK-22 / V-01..V-08. Cross-referenced, not authoritative |
| `docs/Issues-Catalog-2026-09-12.md` | SUPERSEDED (42 items) | L3 | Historical. A1 (public repo + first CI run) is tracked in later catalogs |
| `docs/Issues-Catalog-2026-09-11.md` | SUPERSEDED (23/24) | L3 | Historical |
| `docs/Enhancements-2026-09-12.md` | SUPERSEDED (19/20) | L3 | Historical. E15 (sliding-window damping) deliberately not built |
| `docs/ENHANCEMENTS-2026-09-25.md` | ACTIVE companion | L3 | Enhancement stream (E-series), post-09-12 |
| `docs/NEW-ADDITIONS-2026-09-25.md` | ACTIVE companion | L3 | New-finding stream (A/E-series additions) |
| `docs/ARCH-CONTRACTS-2026-09-26.md` | ACTIVE | L3 | `contracts/src` architecture, upgradeability and spec-conformance audit (ck-arch). Read-only findings; L1 code still wins on behaviour |
| `docs/ARCH-CORE-2026-09-26.md` | ACTIVE | L3 | `packages/core/src` architecture review (cr-arch) — module dependency graph, cycles, barrel leakage, non-injectable and non-deterministic dependencies. Read-only analysis; L1 code still wins on behaviour. **Snapshot warning: its `file:line` anchors and per-module line counts are pinned to the 2026-09-26 tree and were overtaken by same-day parallel edits — cite by symbol name, not line number.** The drift is ongoing, so no current count is quoted here on purpose: a figure recorded to prove the document goes stale is itself the first thing to go stale |
| `docs/DOC-AUDIT-CONTRACTS-2026-09-26.md` | ACTIVE | L3 | Docs ↔ contracts consistency audit (ck-doc) — every user-facing claim checked against source. **Owns the doc-count reconciliation of 2026-09-26** (Foundry 158→220, suites 14→17, forge-lint 49→56). Supersedes prose, not code |
| `docs/SUPPLYCHAIN-2026-09-26.md` | ACTIVE | L3 | `scripts/` supply-chain audit (sc-chain) — injection surfaces, CI gates, provenance |
| `docs/DATA-FORMATS-2026-09-26.md` | ACTIVE | L3 | Structured-data schema + consistency audit (sc-data) — shapes, readers, drift |
| `docs/SCRIPTS-2026-09-26.md` | ACTIVE | L3 | `scripts/` index and per-script contract (sc-dx). A snapshot dated 2026-09-26; a changed script outranks it |
| `docs/NUMBERS-2026-09-26.md` | ACTIVE | L3 | Documented numbers vs measured reality (dc-num). `npm run check:docs` and the toolchain win over it |
| `docs/PROPERTY-TEST-PITFALLS-2026-09-26.md` | ACTIVE | L3 | Property/fuzz-test failure modes and self-checks (ck-test) — how a green property suite can still be vacuous |
| `docs/ONBOARDING-2026-09-26.md` | ACTIVE | L3 | Fresh-clone → first-green-gate walkthrough (dc-tutor). A walkthrough, not a spec; L1 + L5 (`docs/GETTING-STARTED.md`) win on behaviour |
| `docs/PLAN-STATUS-2026-09-26.md` | ACTIVE | L3 | 30-day plan progress audit, Day 4 (dc-plan). Snapshot; the plan it audits wins on intent |
| `docs/AC-01-SCRUB-PLAN.md` | **ACTIVE — UNEXECUTED, destructive** | L3 | Plaintext-key history scrub plan. **Nothing in it has been run**, and it needs explicit maintainer approval plus the pre-push gate. Prerequisite: rotate the exposed keys first — rewriting history cannot un-leak them |
| `docs/ADVANCED-FEATURES-1-CONTRACTS-DATA.md` | ACTIVE proposal | L3 | Advanced-features proposal 1/3 — contracts + index/query layer, with effort estimates |
| `docs/ADVANCED-FEATURES-2-SDK-OBS-ECO.md` | ACTIVE proposal | L3 | Advanced-features proposal 2/3 — SDK ecosystem + observability/governance |
| `docs/ADVANCED-FEATURES-3-ECOSYSTEM.md` | ACTIVE proposal | L3 | Advanced-features proposal 3/3 — ecosystem integration + market positioning |
| `docs/VERIFICATION-STRATEGY-2026-09-25.md` | ACTIVE | L3 | Verification strategy 1/2 — framework, contracts, TS services (VTS-A/B/C) |
| `docs/VERIFICATION-STRATEGY-2-CI-UAT.md` | ACTIVE | L3 | Verification strategy 2/2 — CI/CD + UAT + release verification (VTS-D/E) |
| `docs/CI-COVERAGE-AUX-2026-09-26.md` | ACTIVE | L3 | CI coverage audit for the auxiliary packages (`indexer`/`mcp`/`demo-agent`) |
| `docs/STALENESS-2026-09-26.md` | ACTIVE | L3 | Staleness & technical-consistency sweep over `docs/` + `vault/` (49 files). Time-sensitive by nature — re-run rather than cite after it ages |
| `docs/SECURITY-AUDIT-2026-09-26.md` | ACTIVE | L3 | Security-documentation audit (dc-sec) — `SECURITY-7702-THREAT-MAP`, `SECURITY.md`, `AC-01-SCRUB-PLAN`, `security.txt`; every claim re-derived from source with `file:line` anchors. **Carries a snapshot warning: its anchors are pinned to a 2026-09-26 working tree and must be read with that timestamp** |

| `docs/DOC-AUDIT-CORE-2026-09-26.md` | ACTIVE | L3 | `packages/core` docs/examples/error-message audit (cr-doc) — README, JSDoc and thrown-error text. **Moved here from `packages/core/DOC-AUDIT-2026-09-26.md`; distinct from `docs/DOC-AUDIT-CONTRACTS-`, which audits `docs/`** |
| `docs/RELEASE-READINESS-CORE-2026-09-26.md` | ACTIVE | L3 | `packages/core` release-readiness review (cr-ship) — publish blockers, npm scope ownership, packaging. Moved here from `packages/core/RELEASE-READINESS-2026-09-26.md` |
| `docs/ARCH-SCRIPTS-2026-09-26.md` | ACTIVE | L3 | `scripts/` architecture review (sc-arch) — duplication, dependency direction, process contracts. Reconciled 2026-10-03: the divergent untracked copy at `scripts/ARCH-2026-09-26.md` was merged into this file (post-errata §1.2/§1.10/§6.0/6.1/6.5 base + the fully-measured §3.4/§3.5) and the old-path copy deleted — see "Reconciled duplicate" below |
| `docs/PERF-SCRIPTS-2026-09-26.md` | ACTIVE | L3 | `scripts/` performance and resource report (sc-perf) — measured runtime/memory of the executable `.mjs`; read-only measurement, no script was modified. Moved here from `scripts/PERF-2026-09-26.md` |
| `docs/INDEX-2026-09-26.md` | CURRENT | L3 | **The full document index** (every file, one line each). Navigation aid, not authority: `STATUS.md` decides authority, and where the two disagree about *what a document is*, `STATUS.md` wins. If this file and the tables here ever list different sets, this file is the stale one |
| `docs/VERIFIED-E2E-2026-10-03.md` | ACTIVE | L2 | **Machine-verified end-to-end snapshot** (Ralph-loop iteration 1). Reports 225/225 Foundry tests on pinned 1.7.1 + 951/951 TS tests across all packages + all 14 gate scripts green. Does not re-run Halmos/Echidna/slither/wallet-e2e/invariants/fork smoke; counts reconciled via `check-doc-counts.mjs`. Includes the "toolchain version sensitivity" finding (12 gas-budget failures on 1.8.4 vs 0 on 1.7.1). |
| `docs/README.md` | CURRENT | L5 | `docs/` entry point — "I want to…" shortest-path routing. **Explicitly not an authority**: it defers to `STATUS.md` for the layer model and to `INDEX-` for the full list. Safe to read first; never cite it for what is true |
| `docs/QUALITY-2026-09-26.md` | ACTIVE | L3 | Documentation quality & readability assessment (dc-voice). Findings about prose, not behaviour; L1 unaffected |
| `docs/STYLE-2026-09-26.md` | CURRENT | L4 | Writing-style guide for contributors (audience: contributor). Context, not normative — it governs how to write, never what is true |
| `docs/VERIFY-FIELD-DESIGN-2026-09-26.md` | **PROPOSED — not verified** | L3 | Design proposal for a `verify:` field (ck-test), companion to `PROPERTY-TEST-PITFALLS-`. **Self-declared "CRITERION PROPOSED, NOT YET MECHANICALLY VERIFIED"** — a proposal to be argued with, not a gate that exists |
| `docs/DEPLOY-OPS-2026-09-26.md` | ACTIVE | L3 | Deploy & ops assessment of `contracts/script/`, `foundry.toml`, 7702 upgrade paths. **Self-declares that no claim in it is backed by a `forge` run** — every item marked **[verify]** still needs one command |

**L3 expires by design.** A plan line is a statement of intent on a past date, not a fact
about the present. Never cite an L3 file as evidence of current behaviour — cite L1, or L2
for what the change was. Where L3 disagrees with L1, L1 wins; where L3 disagrees with L2,
the newer L2 entry wins.

## L4 · Context — why, not what (non-normative)

| File | Status | Layer | Who wins |
|---|---|---|---|
| `docs/WHITEPAPER-v2.1.md` | **CURRENT** technical whitepaper (Sept 2026) | L4 | Authoritative for *product framing and the correction record*; its pre-audit banner is binding on all security wording. Counts checked by `npm run check:docs` |
| `SigilKit_Whitepaper.txt` | **SUPERSEDED** v2.0 (July 2026) | L4 | **None — do not cite.** Retained as history only; it carries fabricated/stale claims and now opens with a SUPERSEDED banner. Corrections live in `docs/WHITEPAPER-v2.1.md` and `vault/Whitepaper Corrections.md` |
| `vault/` (22 notes) | CONTEXT — private research, kept deliberately (TD-8) | L4 | Background and evidence trail. **Not normative.** When in doubt, L1 + L2 win |
| `docs/COMPLIANCE-2026-09-26.md` | CURRENT | L4 | Licensing, dependency-compatibility and legal-risk constraints (dc-law). **Non-normative for behaviour**, but its audit-status constraints bind any security wording (see below) |
| `docs/VAULT-AUDIT-2026-09-26.md` | CURRENT | L4 | Audit of the 22 `vault/` notes and the whitepaper corrections trail (dc-translate). Evidence for the L4 traps above; **not normative** |
| `docs/ECOSYSTEM-RESEARCH-2026-09-23.md` | CURRENT | L4 | Ecosystem sweep — competitive landscape, standards, adoption, regulation. **The citable primary source** for third-party landscape claims; unverifiable claims are listed under its Gaps, not asserted |
| `docs/RESEARCH-NUMBERS.md` | CURRENT | L4 | Single source of truth for externally sourced figures (as of 2026-09-23). Every row cites its primary source; **paywalled/rate-limited figures are marked and must stay out of published claims.** Re-verify before any release — external facts decay |
| `docs/PROJECT-REVIEW-2026-09-17.md` | SUPERSEDED in part | L4 | Consolidated review with a Sept-17 addendum. Historical; its execution-status numbers predate the current suite and are **not** current counts |
| `docs/GLOSSARY-2026-09-26.md` | CURRENT | L4 | Glossary + cross-document naming-consistency audit (dc-gloss) — 118 terms, 31 inconsistencies, 9 misusages. Terminology reference; it resolves naming disputes **against L1 identifiers**, so it never outranks the code. Its own header cites the four-layer model as it stood on 2026-09-26; L5 was added later the same day, which does not change any of its verdicts |

L4 explains motivation and history. It never overrides behaviour. Three specific traps:

- **The v2.0 whitepaper is not a citable source.** It states a fabricated delegation
  address, a nonexistent IC3 quotation, wrong engagement counts on viem #3285, a closed
  Optimism grant as open, dead RPC endpoints, and audit/Immunefi/Certora/UUPS claims that
  never happened. Use v2.1.
- **`vault/` is research, not spec.** It is kept because the corrections trail lives there.
  It held 22 notes as of 2026-09-25; if this line and the directory ever disagree, the
  directory wins and this line is wrong — see "When this file must be updated" below.
- **"Audited" is a word this project does not get to use yet.** SigilKit has had no external
  audit. `docs/WHITEPAPER-v2.1.md`'s pre-audit banner and `docs/COMPLIANCE-2026-09-26.md` §7
  together make that binding on every document: a security claim is only accurate if it says
  *not externally audited* and names its verification tooling. A bare "audited" — in a
  threat map, a vault note, a README, or a table cell — is a false statement of fact, not a
  style problem, and it is the single easiest way for this repository to misstate its own
  posture. If a real audit lands, update the banner, `SECURITY.md`, and the compliance audit
  **in the same change** — not one of the three.

## L5 · Reference — how to use it (normative for humans, verified against L1)

| File | Status | Layer | Who wins |
|---|---|---|---|
| `docs/GETTING-STARTED.md` | **CURRENT** | L5 | The onboarding path a new user follows. Prerequisites, first run, SDK/indexer/MCP usage. L1 wins on any behavioural claim |
| `docs/DEPLOYMENT.md` | **CURRENT** | L5 | Deployment, npm publishing, services, rollback. Carries the pre-audit banner. L1 wins on behaviour; `docs/DEPLOY-OPS-2026-09-26.md` (L3) is the deeper assessment |
| `docs/CONFIGURATION.md` | **CURRENT** | L5 | Every environment variable and CLI flag with defaults. **No gate reads this file** (corrected 2026-10-04 — it previously claimed `check-doc-counts.mjs` verified parts of it, but that script never references CONFIGURATION.md). Treat every default below as unverified; `packages/*/src/**` wins on any default or accepted value |
| `docs/TROUBLESHOOTING.md` | **CURRENT** | L5 | Symptom → cause → fix. L1 wins; where a documented cause is wrong, the cause is a bug in the code, not in this file |
| `docs/SECURITY-7702-THREAT-MAP.md` | **CURRENT** | L5 | EIP-7702 threat map. **Subject to the L4 "audited" trap above** — as of 2026-09-26 its row 7 read "a fixed, audited contract", which was false and has been corrected. **Extended 2026-09-28 (dc-sec2): rows 11–13 added — 7579-has-no-E10 (structural: the `countersignAbove` field is absent from `SessionKey7579Module.Scope`, so the mitigation *cannot* exist there, by decision not oversight), MEV/sandwich (no code-level control), and governance capture (one-step ownership transfer, no timelock/accept; the mandated 2-of-3 Safe is an OPERATIONAL control, not a design one). All three are recorded as UNMITIGATED — do not read this map as all-clear.** L1 + `SECURITY.md` win |

**L5 is verified by L1, and loses to it.** This is the whole reason L5 exists as its own layer
rather than being filed under L1. `CONFIGURATION.md` is a *description* of what the code reads — it
is checked against the code, but it does not define the code. Filing a reference under L1 would be
an authority inversion: the next time it went stale, "code beats prose" would let a stale
**description** override the live **implementation**. So:

- **L1 and L5 conflict → L1 wins.** Always. No exceptions, no "the doc is more explicit".
- **L5 is not exempt from the gates.** Parts of `CONFIGURATION.md` are already validated by
  `npm run check:docs`; that is a *floor*, not a claim that the whole file is machine-verified.
- **L5 carries the user-facing obligations.** Anything in L5 is user-facing, so the pre-audit
  banner, the as-is / no-warranty wording, and the "not a custodian, not a financial adviser, you
  can lose the funds in the account" risk statements belong here — see
  `docs/COMPLIANCE-2026-09-26.md` §8. Today those exist only in `LICENSE`, `SECURITY.md` and
  `DEPLOYMENT.md`; `GETTING-STARTED.md` and `TROUBLESHOOTING.md` still need them.
- **L5 does not outrank L2, L3 or L4 either.** It sits below all of them; the conflict-resolution
  list below is unchanged by its existence.

---

## Where a document may live

**Rule: every audit, review, research or strategy document lives in `docs/`, named
`<SUBJECT>-<YYYY-MM-DD>.md`. Nothing else is a valid home for one.**

This is a separate rule from the layer tables because it is about *discoverability*, not
authority — a document in the wrong place is not merely mis-classified, it is **invisible twice
over**: it is in no layer table, and if it landed in a workspace package it is also in no npm
tarball (`files: ["dist", "README.md"]`). A finished audit that nobody can find has the same
effect as no audit at all.

**The three legal homes, and what each is for:**

| Location | For | Indexed? | Shipped? |
|---|---|---|---|
| `docs/` | Audits, reviews, research, strategy, user references — anything with findings or evidence | ✅ yes, this file | n/a |
| `packages/*/README.md` | The published face of one package: install, usage, API | ❌ no (per-package by design) | ✅ yes, it's in `files[]` |
| `contracts/test/README.md` | Test-suite guidance | ❌ no | n/a |
| `vault/` | Private research notes, deliberately non-normative | ✅ as one L4 row for the whole directory | ❌ no |
| `.workbuddy-ai/`, `agents/` | Assistant scratch — **gitignored, not a deliverable** (corrected 2026-10-04: `.workbuddy-ai/` is on the directory allowlist in `check-doc-location.mjs`, and markdown there is counted as tracked, so the directory is governed rather than invisible) | ❌ no | ❌ no |

**Previously misplaced — migrated 2026-09-26.** Three finished deliverables were written next to the
code they audit, which put them in no layer table *and*, for the two in a package, in no npm
tarball. All three are now in `docs/` under subject-qualified names, with rows in the L3 table:

| Was | Now | Subject |
|---|---|---|
| `packages/core/ARCH-2026-09-26.md` | `docs/ARCH-CORE-2026-09-26.md` | `packages/core/src` (12 files, 3,301 lines) |
| `packages/core/DOC-AUDIT-2026-09-26.md` | `docs/DOC-AUDIT-CORE-2026-09-26.md` | `packages/core` README + JSDoc + error strings |
| `scripts/ARCH-2026-09-26.md` | `docs/ARCH-SCRIPTS-2026-09-26.md` | `scripts/` (26 `.mjs` + 2 `.sh`) |

**None of them was a misplaced copy.** The pre-existing `docs/ARCH-CONTRACTS-` (70,301 B,
`contracts/src`, ck-arch) and `docs/DOC-AUDIT-CONTRACTS-` (60,777 B, `docs/`, ck-doc) are
*different documents about different subjects* — the packages/ files were 47,104 B and 23,111 B
with different authors. They were given subject-qualified names (`ARCH-CORE-`,
`DOC-AUDIT-CORE-`, `ARCH-SCRIPTS-`) because two of them would otherwise have collided on
`ARCH-2026-09-26.md` inside `docs/`, and a basename collision is what made this look like a
copying mistake in the first place.

### Reconciled duplicate — `ARCH-SCRIPTS-2026-09-26.md` (closed 2026-10-03)

The duplicate once recorded here as "unresolved" was reconciled on 2026-10-03. Original record,
preserved verbatim below for traceability (L2 append-only), then the resolution.

**What happened (2026-09-26):** the move of `scripts/ARCH-2026-09-26.md` →
`docs/ARCH-SCRIPTS-2026-09-26.md` landed at 18:44:57 while sc-arch was still writing; a divergent
copy reappeared at the old path at 18:48:00. The two diverged materially in opposite directions:
the `scripts/` copy carried the §1.2 **errata** (retracting a false "no `resolve()` ⇒ permanent
silent failure" assertion, refuted empirically on Node 24) plus new §1.10/§6.0/§6.1/§6.5, while
the `docs/` copy held the fully-**measured** §3.4 (11-gate exit-code table + mutation-test
evidence) and §3.5 (`--root` silent-swallow) that the `scripts/` copy only had as a "待并入"
placeholder.

**Resolution (2026-10-03):** the post-errata `scripts/` copy was taken as the base; its §3.4
placeholder was replaced with the measured §3.4 + §3.5 from the `docs/` copy; the merged result
was written to `docs/ARCH-SCRIPTS-2026-09-26.md`; the untracked `scripts/ARCH-2026-09-26.md` was
deleted. Nothing was dropped — the errata superseded the old §1.2 claim, and the only content
unique to the `docs/` copy (§3.4/§3.5) is now part of the canonical file. Verified with
`node scripts/check-doc-location.mjs` (exit 0).

**Enforcement — this must be checkable, not a convention.** A convention that only lives in this
file decays, and a check that does not reliably measure what it claims is worse than no check. So
this one is a real gate, wired into the verify pipeline:

```bash
node scripts/check-doc-location.mjs     # or: npm run verify -- --only=docslocation
```

It runs in `npm run verify` as its own step (**`doc location`**, 60s budget — `scripts/verify.mjs`
`BUDGETS.docslocation`; corrected 2026-10-04, this line previously said 600s, which is the
fallback budget `FALLBACK_TIMEOUT_MS`, not this step's) immediately after
`doc counts`, and it needs no `forge`, so it runs on any machine. It checks **both directions**:
the *location* half (no tracked `.md` outside `docs/` in a place that may not hold one) and the
*index* half (every `docs/` file has a row; every row resolves to a real file). It is **tested in
both directions** by `scripts/check-doc-location.test.mjs` (run in the `helpers` step, or
`npm run test:doc-location`): **25 cases, all passing** — a clean tree exits 0; a misplaced audit
exits 1 *and names the file*; the three real stray paths from 2026-09-26 are all cases in the
suite; the three migrated documents pass from `docs/`; seven legitimate non-`docs/` documents still
pass; and — for the index half — **a row pointing at a non-existent file exits 1 and names it, and
removing a real file's row exits 1 and names the unindexed file**. **A guard that has only ever
been seen to pass is not a guard** — that is why the suite exists rather than a one-off manual
check.

> **Reconciled 2026-10-03:** this file previously stated two figures for the same suite
> (`"expect 20/20"` in an old reconciliation step, and `"25 cases, all passing"` here). They refer
> to the same suite at two points in time: it was **20 cases** before the five index cases were
> added on 2026-09-26 (documented in `docs/COMPLIANCE-2026-09-26.md` as "grew from 20 to 25
> cases"), and is **25 cases** today. The stale `"expect 20/20"` wording was corrected to 25.

The index cases perturb `docs/STATUS.md` and restore it in a `finally`, and the suite asserts the
restore. The location cases use a throwaway `GIT_INDEX_FILE`, so together the suite touches no
tracked state and no working-tree file other than `STATUS.md`, which it puts back.

The suite drives a **throwaway `GIT_INDEX_FILE`**, not the real index and not the working tree, so
it can prove the guard goes red without creating a file in the repository. It is safe to run
mid-task with uncommitted work in flight.

**That negative testing earned its keep immediately.** The first version of the guard allowed
`packages/` and `contracts/` *wholesale*, and it **did not flag either stray** — it printed `OK`
while counting them. A guard that only ever gets run on a clean tree will pass forever while
being wrong; the bug was invisible from the happy path, and only a deliberately constructed
failure exposed it. The allowlist is now per-file.

**Known failure modes of this check, stated so nobody trusts it blindly:**

1. **It only sees git-tracked files.** An untracked stray in the working tree is invisible to it,
   and that is exactly the state the three documents above were in when this rule was written — so
   a clean run does **not** mean there are no strays. `git status --porcelain` is the companion
   check for uncommitted work.
2. **The index half reads the working tree, not the git index.** That is deliberate — a row in
   `STATUS.md` is only meaningful against what is actually on disk — but it means the index half
   sees untracked files while the location half does not. The two halves therefore have different
   blind spots, which is why both are needed and why neither alone is sufficient.
3. **`vault/` is allowed wholesale.** Intentional — the directory is one L4 row — but it means a
   stray note inside `vault/` is not caught here.

---

## Open decisions (tracked here because they are index-level, not code-level)

| # | Item | Status | Evidence required before it can be closed |
|---|---|---|---|
| **OD-1** | MetaMask revoke-rejection canary: allowlist records verification on extension **12.5.0**, but prose in `docs/SECURITY-7702-THREAT-MAP.md` and `SECURITY.md` claimed **13.49.0** as a *verification*. | **CLOSED 2026-10-03 — prose corrected downward, JSON untouched.** The error was always in prose, never the record: the canary was never exercised against 13.x (last harness verification is 12.5.0; 13.49.0 is only the version CI pins/downloads). Threat-map rows 4/9 were corrected 2026-09-28; `SECURITY.md`'s "canary-verified on 13.49.0" was corrected to 12.5.0 on 2026-10-03. `wallet-e2e/README.md`'s "13.49.0" is the pin, not a verification claim — no change needed. | Closed via the evidence cell's own fallback branch: "the prose is wrong and must be corrected downward, not the JSON upward." |
| **OD-2** | Naming collision: `github.com/sigilkit` and the `@sigilkit` npm scope belong to an unrelated MIT project (`JonathanSantos/sigilkit`, `@sigilkit/core@0.11.1`), so `npm install @sigilkit/core` resolves to someone else's code and the README's clone URL 404s. URLs were repointed to `dev25bansal-ops/sigilkit` on 2026-09-26; the **package name and npm scope are still undecided.** | **OPEN — blocks first publish** (also tracked in `docs/DEPLOYMENT.md` §4 and `docs/COMPLIANCE-2026-09-26.md` §9) | A decision on the publish namespace (rename the packages vs acquire the scope vs publish under a scope already owned) — a [D] decision, not a doc change. |
| **OD-3** | `.well-known/security.txt` has no `Encryption:` field. Deliberate: an `Encryption:` value must resolve to a real OpenPGP key, and a fingerprint that resolves to nothing makes a reporter who encrypts to it **silently lose the report.** The file carries a copy-pasteable procedure. | **OPEN — ~5 min, owner = maintainer** | Generate a dedicated key, publish to a keyserver, **verify it resolves**, then add the field and re-run `npm run check:docs`. Until then the `mailto:` is primary and covered by the `SECURITY.md` safe harbour. |
| **OD-4** | No CLA, no DCO, no express patent grant, no contributor warranty disclaimer. `CONTRIBUTING.md`'s licence section is one sentence. MIT carries no patent clause, so contributor patents are not licensed to the project or its users. | **OPEN — needs counsel** (see `docs/COMPLIANCE-2026-09-26.md` §5) | A [D] decision on DCO vs CLA, and a counsel review of the patent grant. |


---

## Conflict resolution

1. **Code beats prose** (L1 > everything) for *what is true*.
2. **The newest L2 record beats older L2 and all L3** for *what changed*.
3. **The newest L3 plan/catalog beats older ones** for *what to do next*.
4. **L4 never wins** against L1–L3. It is context, and v2.0 is not even usable context.
5. **L5 never wins against L1.** It is a verified description of L1, not a competing source of
   truth. A stale L5 file is a documentation bug to fix in the same change, never a reason to
   prefer the document over the code.
6. **This file wins for one thing only: which document to read.** It is an index, not a
   spec. If this file's description of another file is wrong, that file wins and this file
   must be fixed.

Counts in prose (tests, suites, CI jobs, Halmos specs, coverage) are verified by
`node scripts/check-doc-counts.mjs`; the toolchain wins over every document, including this
one and including the whitepaper.

## When this file must be updated

This file is the index, so a stale index is worse than no index. Update it **in the same
change** — never in a follow-up — when any of the following happens:

| Trigger | Required edit |
|---|---|
| A document is created, renamed or deleted under `docs/`, `vault/`, or the repo root | Add/move/remove its row in the correct layer table |
| A new plan or catalog supersedes the current L3 entry | Mark the old one SUPERSEDED, promote the new one to **ACTIVE** |
| A document's status changes (draft → current, current → superseded) | Update its `Status` cell in the same commit |
| The `vault/` note count changes (adding or deleting a note) | Update **all four** `22` occurrences — the layer-summary table at the top, the L4 table row, the L4 trap note, and the `VAULT-AUDIT-2026-09-26` row. `npm run check:docs -- --write` rewrites all four. The guard matches **two** text shapes, because three of the sites are worded plainly and the fourth has an inline-code path between the number and the word "notes" — a looser pattern cannot see the fourth, which is how it rotted. (Deliberately described rather than quoted here: a rule that spelled the fourth shape out in full would be a target of its own `--write`, and the rule would begin rewriting its own wording.) |
| A new L2 record (waiver register, release log section) is added | Add it to the L2 table |
| An existing rule here is found to be wrong | Fix it, and say why in the commit — do not leave a known-wrong rule in place |
| A number in this file stops matching the toolchain | Fix this file *and* run `npm run check:docs`; the toolchain is the tie-breaker |
| An **external audit** is commissioned, started, or completed | Update `docs/WHITEPAPER-v2.1.md`'s banner, `SECURITY.md`, and `docs/COMPLIANCE-2026-09-26.md` §7 **in the same change** — see the L4 trap above |
| An **Open decision** above (OD-1..OD-4) is closed | Move it out of the Open-decisions table into the layer whose document it changed, and say which evidence closed it |
| A new **user-facing** document is added (`GETTING-STARTED`, `DEPLOYMENT`, `CONFIGURATION`, `TROUBLESHOOTING`, a package `README`) | Add it to the **L5** table — user-facing reference is exactly what L5 is for — and apply the pre-audit banner and the "as-is / not a custodian / funds-loss" wording to it. See `docs/COMPLIANCE-2026-09-26.md` §8 |
| A **behaviour change** lands that an L5 document describes | Update the L5 document **in the same change**. An L5 file that describes yesterday's behaviour is a bug in that file, not a new truth |
| An L5 document and the code disagree | Fix the L5 document. Record it if the code was wrong instead — but never leave the disagreement standing, and never resolve it in the document's favour |
| An audit, review or research document is produced | It goes in **`docs/`**, named `<SUBJECT>-<YYYY-MM-DD>.md`. Never in a workspace package directory, never in `scripts/`, never in `vault/`. Add its row in the same change, and run `node scripts/check-doc-location.mjs` — see "Where a document may live" below. A misplaced deliverable is invisible to this index **and** to the npm tarball at the same time |

Rule of thumb: if a reader following this file would be sent to the wrong document, this
file is out of date and the change that caused it was incomplete. The five layer tables
should be exhaustive over `docs/` — a document that appears in none of them is unclassified,
and that is a bug in this file. `docs/STATUS.md` itself is deliberately the one exception: an
index does not list itself, and every rule here applies to it by reading, not by row.

**How "classified" is measured.** A document counts as classified only when it has **its own
row** in one of the five tables. Being *named* inside another row's "who wins" cell does not
count — that was the flaw in the first pass of this consolidation, which over-counted by
treating prose mentions as rows. Verify with a row-level check, not a substring match:

```bash
# counts rows, not mentions
grep -c '^| `' docs/STATUS.md
```

**And the second half of the check — that every document is *findable*.** A row in this table
means the document is indexed; a `docs/` row for a file that is not in `docs/` means it is indexed
as though it were somewhere it is not. **Both directions are wrong, and a wrong row is the more
dangerous of the two, because a reader trusts it.** Both are therefore checked by the same gate:

- every row in the five tables whose subject is a `docs/…` path must **resolve to a file that
  exists**; and
- every `docs/*.md` must **have a row** (`STATUS.md` excepted — an index does not list itself).

That second half was, until 2026-09-26, a check that existed only inside a throwaway script and was
then deleted — while being reported as a resident gate. It is now part of
`scripts/check-doc-location.mjs`, and its two failure modes (a row pointing at nothing; a file with
no row) are test cases rather than claims. **A check that lives only in a scratch file is not a
check.**
