# Academic Literature

Session keys / AI agents on-chain — what's actually published (Aug 2026). The whitepaper's "zero peer-reviewed papers" claim is **false**.

## Verified papers & surveys
- **Account Abstraction, Analysed** — arXiv:2309.00448 (Qin Wang & Shiping Chen, 1 Sep 2023). Earliest dedicated EIP-4337 security review. *Nuance:* abstract describes a "preliminary security evaluation" — qualitative, not machine-checked. So "first analysis" = true; "rigorous/formal" = overstated.
- **GasLiteAA** — arXiv:2604.10160 (Hongxu Su et al., 11 Apr 2026). ERC-4337 gas-sponsorship optimization via TEE offloaded paymaster.
- **Crypto x AI, AI x Crypto: A Survey** — arXiv:2606.13892 (11 Jun 2026, IC3/Cornell-led: Ari Juels, Fan Zhang, Andrew Miller, Ittay Eyal, Giulia Fanti, et al.). Broad bidirectional survey; concludes AI×crypto is in "very early stages." **NOT** the 2025 survey the whitepaper cites, and does **NOT** contain the "most AI agent platforms show no evidence of real on-chain autonomy" quote (see [[Whitepaper Corrections]]).
- **Real AI Agents with Fake Memories** — arXiv:2503.16248 (Patlan et al., Mar 2025). Memory-injection attacks on ElizaOS Web3 agents; shows memory injection can trigger "unauthorized asset transfers."
- **EIP-7702 Phishing Attack** — arXiv:2512.12174 (Qi, Wang, Li, Zhu, Chen; submitted 13 Dec 2025). **The paper that disproves "zero 7702 papers."**
- (Misattributed by a research agent, corrected on re-run): arXiv:2605.01210 is **"Write-Domain Separation and Non-Custodial Enforcement"** (Hauser, 2 May 2026) — a structural-ledger-theory preprint, **NOT** a 7702 paper.

## Genuine gap (SigilKit's defensible contribution)
No one has **formally analyzed ERC-7702 delegation revocation or scoped spend-policy permission graphs for agents**. Combine the formal-methods tradition of "Account Abstraction, Analysed" with the agent-threat model from "Real AI Agents with Fake Memories." A **spend-policy/permission-graph formalism + conformance/revocation framework**, empirically tested against 7702/4337, is publishable.

## 2027 venue deadlines (from sec-deadlines.github.io)
- **NDSS 2027:** 2026-05-06 and 2026-08-19 — **both PASSED** (as of 2026-08-21).
- **IEEE S&P 2027:** 2026-06-11 and **2026-11-17** — **OPEN**; best fit for a July-2026 writeup.
- **USENIX Security 2027:** **2027-01-26** (2nd round) — **OPEN**.
- **ACM CCS 2027:** not yet posted (only CCS 2026 listed).

→ A July-2026 draft is **feasible** for **S&P 2027 (Nov 2026)** or **USENIX Sec 2027 (Jan 2027)**. Pair with EF Academic Grants (see [[Funding Audit Bounty]]).

## Caveat
IEEE Xplore, ACM DL, SSRN were not directly reachable this session (WebSearch returned empty); "no peer-reviewed" nuance + non-US-lab coverage under-explored pending those sources.

---
Tags: #sigilkit #academic #literature #research
