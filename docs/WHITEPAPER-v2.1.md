# SigilKit — Technical Whitepaper v2.1 (CORRECTED)

> **This revision supersedes the July 2026 v2.0 whitepaper.** An August-2026 worldwide research
> sweep (8 verification streams against live sources: GitHub API, npm registry, arXiv, DefiLlama,
> official program pages) found several v2.0 claims to be fabricated, false, or stale. All such
> claims are corrected or removed below. Corrections are marked ⚠; the full evidence trail lives in
> [`vault/Whitepaper Corrections.md`](../vault/Whitepaper%20Corrections.md) and `SECURITY.md`.

## Abstract

SigilKit is an open-source (MIT), audited toolkit for **agent-native wallets**: scoped session-key
management with on-chain spend caps, rolling-window rate limits, Merkle target whitelists, a
mandatory per-action audit event, an EIP-7702 authorization library with three-way signing
conformance, and an ERC-7579 validation module bringing the same scope enforcement to Kernel /
Safe{Core} accounts.

**⚠ Revised thesis (replaces "the standard library nobody built").** Shared infrastructure already
exists — `base/eip-7702-proxy`, RhinoStone ModuleKit (ERC-7579), ZeroDev Kernel, session-key
managers from Biconomy/ZeroDev, and revoke tooling (`eip7702-clean-delegation`, `calibur`). The
genuine unmet gap SigilKit fills is the **bundle no one ships**: cross-wallet signing conformance +
on-chain audit-per-call + formal verification of the spend-policy core, under MIT with everything
installable via `forge install` / npm.

## Components (v2.1 scope)

| # | Component | Status vs v2.0 |
|---|-----------|----------------|
| 1 | EIP-7702 wallet library + cross-wallet conformance | **Kept** — core implemented; MetaMask/Coinbase UI legs pending |
| 2 | ~~EIP-2535 Diamonds module~~ → **ERC-7579 module** | **Replaced** — EIP-2535 now serves fixed-function upgradeable protocols; ERC-7579 owns agent-wallet extensibility. Shipped as `SessionKey7579Module` |
| 3 | Multi-RPC provider | **Dropped/deferred** — viem already provides WS reconnect + retry/fallback; commoditized |
| 4 | Agent session-key manager | **Kept — the moat.** Implemented; spend-cap core formally verified (auth-path specs in progress). |

## Corrected claims

| v2.0 claim | Correction |
|---|---|
| "0xcc… SecurityControl" delegation address | **Fabricated — removed.** Canonical references are CREATE2-stable on all chains: EIP7702Proxy `0x7702cb554e6bFb442cb743A7dF23154544a7176C`; CoinbaseSmartWallet impl `0x000100abaad02f1cfC8Bbe32bD5a564817339E72`. |
| viem discussion #3285 "~25 upvotes" | Actually **0 reactions**. Cited only as evidence that JSON-RPC-account `signAuthorization` remains unsupported. |
| IC3 survey quote: "most AI agent platforms show no evidence of real on-chain autonomy" | **Not found in the paper.** The survey is arXiv:2606.13892 (June 2026, not 2025) and concludes AI×crypto integration is at "very early stages". Quote removed. |
| "Zero peer-reviewed papers on EIP-7702" | **False.** arXiv:2512.12174 ("EIP-7702 Phishing Attack", Dec 2025) exists. The publishable gap is narrower: formal analysis of 7702 revocation + scoped spend policies for agents. |
| ERC-7790 = 7702 recommit standard | **False.** EIP-7790 is gas-limit scaling (Stagnant). Revocation remains a self-signed zero-address authorization tuple; there is no 2026 erratum. |
| Optimism Mission Request #274 open for applications | Submission window closed April 2025 (3 teams selected). Not an available grant path. |
| Helix (~823★, Mar 2026) | Could not be verified to exist; removed from competitive analysis. |
| Code4rena / Spearbit audit plan | Code4rena is winding down; Spearbit merged into Cantina. Audit route: Cantina/Sherlock contest + private review, subsidized by the Arbitrum Audit Program ($10M ARB pool). |
| Solidity 0.8.24 stack | Built on 0.8.36; Foundry nightly pinned by SHA; Halmos (a16z) used for symbolic verification instead of Certora-only gating. |
| Base TVL $4.6B mid-2026 | Recovered to ~$5.3B (peaked ~$5.58B Oct 2025) — v2.0 understated. Stablecoins ~$293B ✓. Paradigm $1.2B ✓; a16z crypto $2.2B (not ~$2B). |
| Free RPC endpoints incl. `base.llamarpc.com`, `blastapi.io` | Both dead as of Aug 2026. Defaults: PublicNode, 1RPC, Ankr (+ paid tiers for production). |
| "No KYC / globally relevant" positioning | Reframed: **permissionless, non-custodial developer tooling; integrators own compliance** (US GENIUS/CLARITY, EU MiCA, India TDS regimes all bear on stablecoin flows; see vault/Risk & De-risk Plan). |

## Verified facts retained from v2.0

- OpenZeppelin #2793 open since Jul 2021 at exactly +1:50 / 64 reactions — most-upvoted open issue
  in its set (opened by the EIP author).
- ethers.js #1053 / #4469 / #2030 remain open and unfixed.
- MetaMask #35520 open (14 reactions): raw zero-address revocations via `eth_sendTransaction`
  rejected even after the native in-UI revoke shipped (PR #30969).
- Coinbase agentic wallets (Feb 2026); Sphere SDK 5,409★; Sandboxed.sh 488★.
- EIP-7702 wire format unchanged: `authorization_list = [[chain_id, address, nonce, y_parity, r, s]]`;
  delegation code `0xef0100 ‖ address`; last-valid-occurrence-wins nonce semantics.

## Implementation status

All locally-buildable scope is complete and committed (see `CHANGELOG.md`): contracts + ERC-7579
module, TS SDK with three-way digest conformance, live demo agent, 38 Foundry tests, invariant
suites, 6 Halmos specs, Slither triage, 6-job CI, publish-ready packages.

Remaining before public launch: external audit (Cantina/Sherlock + private review), Base Sepolia →
mainnet deployment under 2-of-3 Safe + TimelockController, Immunefi bounty ($50k critical ceiling,
realistic low-end for wallet-class contracts), real-wallet conformance legs, npm publication.

---
*SigilKit contributors · August 2026 · MIT*
