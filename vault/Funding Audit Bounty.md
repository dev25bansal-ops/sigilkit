# Funding Audit Bounty

> [!CAUTION] COMMERCIAL FIGURES REDACTED (2026-10-16) — non-normative research note
>
> `vault/README.md` states the project’s own boundary rule: *"if any single note is too
> sensitive to publish (funding terms, named individuals), move that note — not the
> directory — to a private repo and leave a tombstone link here."* This note is exactly
> that class, so on 2026-10-16 its **concrete prices, programme amounts and bounty ceilings
> were replaced with qualitative bands**. The strategy, the venue names and the
> stale-plan corrections below are unchanged and still useful.
>
> **TOMBSTONE:** the unredacted figures live only in the maintainers’ private copy of this
> note. If you need a number to make a decision, ask a maintainer — do not re-add it here.
> Funding terms change; verify before acting.

Reality check on the whitepaper’s funding/audit plan (Aug 2026). Several assumptions already outdated — see [[Whitepaper Corrections]].

## ⚠️ Stale plan items
- **Code4rena is CLOSING** — not a viable Q4-2026 venue.
- **Spearbit merged into Cantina** — route competitive audits through **Cantina**.
- **Gitcoin** no longer runs quarterly QF — now campaign-based (**Gitcoin Grants 24**).
- EF "Mission Requests" board **404s** — no longer branded that way.

## Grant / funding programs (Aug 2026)
| Program | Status | Amount | Fit |
|---|---|---|---|
| **EF / ESP (Wishlist + RFPs)** | Open, rolling. FOSS builder tooling. | Case-by-case; small-to-mid six figures | **Good** — MIT 4-contract Foundry toolkit is squarely "builder tooling." |
| **EF Academic Grants Round** | Annual | Research-focused | Weak unless academic angle (see [[Academic Literature]]). |
| **Base Ecosystem Fund / Batches 004** | Investment arm (equity) + non-dilutive per-team batches | Per-batch, five figures | Medium — batches for teams, not solo FOSS. |
| **Arbitrum Grants / Audit Program** | **Active: subsidizes third-party audits** | Covers most of a routine audit | **Strong** — covers the audit SigilKit needs. |
| **Optimism RetroPGF** | Rounds continue (client-rendered app) | Citizen-voted, variable | Medium — rewards *past* impact; needs traction first. |
| **Gitcoin GG24** | Campaign model | Campaign-dependent | Low/medium. |
| **Non-US** (EUBC/Lisk, India Web3, Singapore MAS, UAE, Korea) | Pages unverifiable live | — | Low effort/return now; research per-jurisdiction. |

## Audit — realistic firm, cost, lead time
No firm publishes prices (request a quote). For a 4-contract Foundry suite:
- **Cantina** (Spearbit successor): competitive contest, low-to-mid five figures, ~2–4 wks; book in weeks.
- **Sherlock**: "Audit Contests" + private expert audits; contest priced somewhat above Cantina.
- **Zellic / Trail of Bits / Quantstamp / Certora**: private, **mid five figures to low six**, **2–3mo lead** (backlogs common).
- **Recommendation:** contest via **Cantina or Sherlock** (fast, cheap, credibility) + **Zellic/Trail of Bits** private review for session-key auth paths. Offset cost via **the Arbitrum audit programme**. Start booking **week 1** (critical path — see [[Risk & De-risk Plan]]).
- Use **Halmos** (not Certora) for symbolic verification to cut cost ([[Verified Build Stack 2026]]).

## Immunefi bounty — realistic scope
- **A low-five-figure max critical reward is realistic but on the low end.** Mature wallet programs routinely set **low-to-high five figures** critical ceilings, occasionally higher for fund-loss exploits.
- Solo FOSS toolkit: set a **modest five-figure** critical tier rather than a headline number.
- Bounty ceilings scale with TVL/usage — keep modest early; stand up once contracts are mainnet-ready.

## Bottom line
Best near-term path = **EF ESP RFP/Wishlist** + **the Arbitrum audit programme subsidy**; audit as **Cantina/Sherlock contest + one private review**; **a modest Immunefi critical tier** once mainnet-ready. RetroPGF/Gitcoin = upside after traction. Drop Code4rena/Spearbit assumptions.

---
Tags: #sigilkit #funding #audit #bounty

<!-- AUDIT 2026-10-16 ci-security-3: concrete prices, programme amounts and bounty ceilings
     replaced with qualitative bands per the vault/README.md boundary rule. Strategy, venue
     names and stale-plan corrections preserved. Unredacted copy is maintainer-private. -->
