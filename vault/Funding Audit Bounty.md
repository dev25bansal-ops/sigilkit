# Funding Audit Bounty

Reality check on the whitepaper's funding/audit plan (Aug 2026). Several assumptions already outdated — see [[Whitepaper Corrections]].

## ⚠️ Stale plan items
- **Code4rena is CLOSING** — not a viable Q4-2026 venue.
- **Spearbit merged into Cantina** — route competitive audits through **Cantina**.
- **Gitcoin** no longer runs quarterly QF — now campaign-based (**Gitcoin Grants 24**).
- EF "Mission Requests" board **404s** — no longer branded that way.

## Grant / funding programs (Aug 2026)
| Program | Status | Amount | Fit |
|---|---|---|---|
| **EF / ESP (Wishlist + RFPs)** | Open, rolling. FOSS builder tooling. | Case-by-case; ~$30k–$200k+ | **Good** — MIT 4-contract Foundry toolkit is squarely "builder tooling." |
| **EF Academic Grants Round** | Annual | Research-focused | Weak unless academic angle (see [[Academic Literature]]). |
| **Base Ecosystem Fund / Batches 004** | Investment arm (equity) + **$100K non-dilutive batches** | $100K (batches) | Medium — batches for teams, not solo FOSS. |
| **Arbitrum Grants / Audit Program** | **Active: $10M ARB/12mo subsidizing 3rd-party audits** | Up to full audit cost | **Strong** — covers the audit SigilKit needs. |
| **Optimism RetroPGF** | Rounds continue (client-rendered app) | Citizen-voted, variable | Medium — rewards *past* impact; needs traction first. |
| **Gitcoin GG24** | Campaign model | Campaign-dependent | Low/medium. |
| **Non-US** (EUBC/Lisk, India Web3, Singapore MAS, UAE, Korea) | Pages unverifiable live | — | Low effort/return now; research per-jurisdiction. |

## Audit — realistic firm, cost, lead time
No firm publishes prices (request a quote). For a 4-contract Foundry suite:
- **Cantina** (Spearbit successor): competitive contest ~$20k–$60k, ~2–4 wks; book in weeks.
- **Sherlock**: "Audit Contests" + private expert audits; contest ~$30k–$80k.
- **Zellic / Trail of Bits / Quantstamp / Certora**: private, realistic **$40k–$120k**, **2–3mo lead** (backlogs common).
- **Recommendation:** contest via **Cantina or Sherlock** (fast, cheap, credibility) + **Zellic/Trail of Bits** private review for session-key auth paths. Offset cost via **Arbitrum's $10M program**. Start booking **week 1** (critical path — see [[Risk & De-risk Plan]]).
- Use **Halmos** (not Certora) for symbolic verification to cut cost ([[Verified Build Stack 2026]]).

## Immunefi bounty — realistic scope
- A **$50k max critical reward is realistic but on the low end.** Mature wallet programs routinely set **$50k–$250k+** critical ceilings, some up to $1M for fund-loss exploits.
- Solo FOSS toolkit: set **$25k–$100k** critical tier; $50k defensible.
- Bounty ceilings scale with TVL/usage — keep modest early; stand up once contracts are mainnet-ready.

## Bottom line
Best near-term path = **EF ESP RFP/Wishlist** + **Arbitrum Audit Program subsidy**; audit as **Cantina/Sherlock contest + one private review**; **Immunefi at $50k critical** once mainnet-ready. RetroPGF/Gitcoin = upside after traction. Drop Code4rena/Spearbit assumptions.

---
Tags: #sigilkit #funding #audit #bounty
