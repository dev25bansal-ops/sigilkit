# Build Plan

Converged technical plan from the 3 planning streams (technical build + risk + agent-architecture), Aug 2026. Assumes the component-scope corrections in [[Risk & De-risk Plan]].

## Scope decision (applies first)
- **Keep:** [[Component 1 — EIP-7702 Wallet Library]] (7702 revoke + cross-wallet conformance) + [[Component 4 — Agent Session-Key Manager]] (on-chain audit + verification).
- **Replace:** [[Component 2 — EIP-2535 Diamonds Module]] → ship as an **ERC-7579 module**.
- **Drop/defer:** [[Component 3 — Multi-RPC Provider]] (commoditized — use viem directly).

## MVP that still earns "SigilKit" (≈6–8 weeks, one engineer)
Component 1 + Component 4 + conformance harness + one public audit. Defer Diamond-as-7579 and multi-RPC.

## Monorepo (see [[Verified Build Stack 2026]])
pnpm workspace + Foundry lib as sibling package. `forge install sigilkit/contracts` for the Solidity; npm SDK for the TS.

## Implementation order (de-risk by independence)
1. **CI backbone (week 0–1)** — 8 testing-layer jobs scaffolded; fast gates on PR, slow gates nightly.
2. **Multi-RPC (w1–3)** — ship first *only if kept*; consume everywhere else. Thin viem layer.
3. **Diamond/7579 (w3–5)** — canonical mudgen layout if bespoke; or ModuleKit wrapper.
4. **Session-key manager (w5–8)** — **Halmos-gated before any mainnet touch.**
5. **7702 lib (w8–10)** — TS only; **conformance harness LAST** once API frozen (must assert parity across 4 wallets; MetaMask raw-zero revoke still blocked by #35520 → harness uses in-UI revoke path).

## Eight testing layers → CI jobs
| # | Layer | Job | Cadence |
|---|---|---|---|
| 1 | Foundry unit | `forge-test-unit` | PR |
| 2 | Foundry fuzz (256 runs) | `forge-test-fuzz` | PR |
| 3 | Foundry invariant | `forge-test-invariant` | PR |
| 4 | Slither 6.2.4 | `slither` | PR (fail high) |
| 5 | Echidna nightly | `echidna-nightly` | nightly |
| 6 | Base fork | `foundry-fork-base` | nightly |
| 7 | 7702 conformance | `conformance-harness` | PR (post API-pin) |
| 8 | Halmos v0.3.3 | `halmos` | nightly, **release gate** |

**Cheapest-correctness-first:** PR gates fast/local (1–4); expensive (5–8) nightly; Halmos + conformance are **required mainnet gates**.

## Deployment
- Path: **Base Sepolia → Base mainnet**. CREATE2-deterministic addresses.
- Deploy order (post-Halmos): `ActionLogger` → `SpendPolicy` → `SessionKeyManager` → Diamond/7579 host. **No Diamond until SessionKeyManager Halmos passes.**
- Upgrade authority: UUPS under **2-of-3 Gnosis Safe + 24h TimelockController**. Verify on Basescan immediately post-deploy.

## External blockers (need signup)
- Paid RPC key (Alchemy/QuickNode) for production fork tests + mainnet deploy. Blast/llamaRPC dead — exclude.
- Bundler + Paymaster (EntryPoint v0.8) — **optional**; 7702 path needs no bundler.
- Audit contest booking (Cantina/Sherlock) — start week 1 (lead time).
- 2-of-3 Safe + Timelock deploy before mainnet.

## See also
[[Agent Architecture]] (harness + session-key design) · [[Risk & De-risk Plan]] · [[Milestones]] · [[Funding Audit Bounty]]

---
Tags: #sigilkit #build #plan
