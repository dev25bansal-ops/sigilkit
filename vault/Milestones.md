# Milestones

12-week roadmap from the whitepaper, **corrected** by the planning streams (Aug 2026). The research verdict: 12 weeks for all four components + audit, one engineer, is **not real** — ship the MVP cut instead.

## Recommended MVP (≈6–8 weeks, one engineer)
[[Component 1 — EIP-7702 Wallet Library]] + [[Component 4 — Agent Session-Key Manager]] (as ERC-7579 module) + [[Agent Architecture|conformance harness]] + one public audit. Defer [[Component 2 — EIP-2535 Diamonds Module]] (as 7579) and [[Component 3 — Multi-RPC Provider]].

## Build milestones (if full scope)
| Milestone | Week | Exit criteria |
|---|---|---|
| **M0** | 1 | CI backbone green; 8 testing jobs scaffolded ([[Build Plan]]) |
| **M1** | 3 | Multi-RPC shipped + consumed by all TS tests (health scoring demo passes) |
| **M2** | 5 | Diamonds/7579 compile + unit/fuzz/invariant green; Slither clean |
| **M3** | 8 | Session-key **Halmos gate passes**; Cantina/Sherlock scope locked |
| **M4** | 10 | 7702 API pinned; conformance harness green across 4 wallets |
| **M5** | 12 | Full e2e on Base Sepolia → mainnet deploy + Basescan verify |

## Critical path (per [[Risk & De-risk Plan]])
1. **Audit booking — week 1** (2–3mo lead; use Arbitrum Audit Program, [[Funding Audit Bounty]]).
2. Conformance harness (forked Base, cross-wallet matrix).
3. Mainnet gate (fork tests + Halmos proofs) before any deploy.

## Horizon structure (whitepaper's 3 horizons, retained)
- **Horizon 1 — Foundations (w1–4):** four components at production-grade + Foundry suites + Slither clean.
- **Horizon 2 — Reference dApp + demo agent (w5–8):** `@sigilkit/sdk` v1.0-rc + demo agent (USDC treasury manager, UniswapX).
- **Horizon 3 — Audit, bounty, mainnet (w9–12):** external audit + Immunefi + Base mainnet under 2-of-3 Gnosis Safe.

## Funding triggers
- EF Mission Request → submitted at Horizon 1.
- Base grant → at SDK+demo (Horizon 2).
- Base + Arbitrum + RetroPGF → at mainnet (Horizon 3).

---
Tags: #sigilkit #milestones #roadmap
