# Research Summary

Consolidated from an **8-stream worldwide research sweep** (EIP-7702, Diamonds, agent-wallets, session-key academia, RPC, build-stack, funding/audit, global markets) + **3 planning streams** (technical build, risk, agent-architecture), run 2026-08-21. Each research agent verified 2026 facts against live sources (GitHub API, npm registry, arXiv, DefiLlama, official docs) and fetched non-US sources for a global view.

> ⚠️ **Tooling caveat:** WebSearch returned empty in this environment for several agents, so they fell back to GitHub REST API + WebFetch of primary sources. A few regional figures (Bakong, Bitso, Nigeria P2P exact counts) could not be re-pulled and are flagged UNVERIFIED. See [[Sources]].

## The one-sentence finding
The whitepaper is a **grant/marketing document** — most of its *framing* is defensible but several *specific claims* are fabricated, stale, or unverifiable, and the competitive landscape has moved faster than it admits.

## What HOLDS (use these)
- MetaMask #35520 **open, exactly 14 reactions**; raw zero-address revoke via `eth_sendTransaction` still rejected (in-UI revoke shipped via PR #30969).
- OZ #2793 **open, exactly +1:50 / 64 reactions** — most-upvoted open issue in its set.
- ethers #1053 / #4469 / #2030 all **still open, unfixed**.
- Coinbase agentic-wallet-skills (Feb 2026); Sphere SDK **5,409★**; Sandboxed.sh **488★**.
- Stablecoin market ~**$293B** (USDT $183B, USDC $73B).
- Base TVL recovered to **~$5.3B** (whitepaper's $4.6B *understates* — actually peaked ~$5.58B Oct 2025).
- Paradigm raised **$1.2B** (Jul 2026, AI+crypto); a16z crypto **$2.2B** (May 2026).
- India #1 on Chainalysis adoption index; 30% TDS regime persisted into 2026.

## What's FABRICATED / FALSE (see [[Whitepaper Corrections]])
- "0xcc… SecurityControl" EIP-7702 address — **does not exist**.
- viem #3285 "~25 upvotes" — actually **0** reactions.
- IC3 survey quote "most AI agent platforms show no evidence of real on-chain autonomy" — **not in the paper** (arXiv:2606.13892, June 2026, says only "very early").
- "Zero peer-reviewed 7702 papers" — **false** (arXiv:2512.12174 exists).
- ERC-7790 = 7702-recommit standard — **false** (it's gas-limit scaling, Stagnant).
- Optimism Mission Request #274 "open call" — **submission window closed** (3 teams selected Apr 2025).
- Helix (~823★, Mar 2026) — **unverified**, no matching repo.
- Diamond file layout (DiamondStorage.sol/FacetCutLib.sol) — **non-canonical**.

## What's STALE in the PLAN
- Code4rena is **closing**; Spearbit → **Cantina**; Gitcoin campaign-based now.
- Arbitrum Audit Program = **$10M ARB** subsidizes audits; Base Batches 004 = **$100K**.
- Halmos (a16z) is a viable **lighter Certora alternative** for symbolic verification.

## The competitive reality (the part that changes the project)
Shared infra **already exists**: `base/eip-7702-proxy`, `rhinestonewtf/modulekit` (ERC-7579), RhinoStone SessionKeyManager, `noders-team/monad-agent-kit`, ZeroDev Kernel (255★), AgentPay (460★). EIP-2535 is now mainly for fixed-function upgradeable protocols; **ERC-7579/6900 own the agent-wallet extensibility slot**.

→ The real gap is the **cross-wallet 7702 revocation conformance harness + on-chain audit-per-call + formal verification** bundle. See [[Build Plan]].

---
Tags: #sigilkit #research #summary
