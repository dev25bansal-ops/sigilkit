# Whitepaper Corrections

Every specific claim in the July 2026 whitepaper, checked against live Aug-2026 sources by the research agents. Status: ✅ CONFIRMED · ❌ FABRICATED/FALSE · ⚠️ STALE · ❓ UNVERIFIED.

## ❌ Fabricated or false
| Whitepaper claim | Reality | Source |
|---|---|---|
| "0xcc… SecurityControl" EIP-7702 delegation/designation address | No such address exists anywhere. Real canonical refs (CREATE2, all chains): `EIP7702Proxy 0x7702cb554e6bFb442cb743A7dF23154544a7176C`; `CoinbaseSmartWallet 0x000100abaad02f1cfC8Bbe32bD5a564817339E72` | [[Sources]] (base/eip-7702-proxy) |
| viem discussion #3285 "≈25 upvotes" | **0 reactions** (state open, "ANSWERED") | api.github.com/repos/wevm/viem/discussions/3285 |
| IC3 survey: "most AI agent platforms show no evidence of real on-chain autonomy" | Not found in the paper. arXiv:2606.13892 (June 2026, not 2025) only says AI×crypto integration is "very early stages" | arXiv:2606.13892 |
| "Zero peer-reviewed papers on EIP-7702" | False — arXiv:2512.12174 "EIP-7702 Phishing Attack" (submitted 13 Dec 2025) exists | arXiv:2512.12174 |
| ERC-7790 is a 7702-recommit standard | False — EIP-7790 is "Stagnant [Informational]", gas-limit scaling via EIP-7783. Revoke is still a self-signed zero-address auth tuple; no 2026 erratum | eips.ethereum.org/EIPS/eip-7790 |
| Whitepaper Diamond file layout (`DiamondStorage.sol`, `FacetCutLib.sol`) | Non-canonical. Real mudgen layout: `Diamond.sol` + `LibDiamond.sol` + facets | [[Sources]] (mudgen/diamond-1-hardhat) |

## ⚠️ Stale (true when written, wrong now)
| Claim | Reality (Aug 2026) |
|---|---|
| "EF posted open Mission Request" (Optimism #274) | Issue still open, but **submission window CLOSED** — 3 teams (@jxom, @Sednaoui, @azf20) selected Apr 25 2025. Not an open call to apply to. |
| "Code4rena competitive audit" in funding plan | **Code4rena is CLOSING.** Route contests through **Cantina** (Spearbit merged into Cantina). |
| "Spearbit" audit firm | Merged into **Cantina**. |
| Gitcoin quarterly QF rounds | Gitcoin is now **campaign-based** (GG24), not quarterly rounds. |
| Solidity 0.8.24 | Current is **0.8.36** (whitepaper §4.1/§5.1 outdated). |
| Certora-only formal-verification gate | **Halmos** (a16z v0.3.3) is a viable, lighter alternative. |
| Base TVL "$4.6B mid-2026" | Recovered to **~$5.3B** by Aug 2026 (peaked ~$5.58B Oct 2025) — whitepaper *understates*. |
| a16z crypto "~$2B" | Actually **$2.2B** (May 5, 2026). |
| Free RPC endpoints `base.llamarpc.com`, `blastapi.io` | Both **dead** (LlamaRPC 521; Blast "no longer available, use Alchemy"). |

## ❓ Unverified (could not confirm this session)
| Claim | Note |
|---|---|
| Helix (~823★, Mar 2026) | No matching repo found in any slug searched. Plausible but unsubstantiated. |
| Cambodia Project Bakong ~1.3B tx FY2025 | Source fetches blocked; narrative plausible. |
| Bitso $6.5B crypto remittances 2024 | Same. |
| Nigeria $59B P2P / eNaira inactive | Same. |

## ✅ Confirmed (safe to keep)
| Claim | Evidence |
|---|---|
| MetaMask #35520 open, ~14 upvotes (revoke rejected) | API: state open, **14** THUMBS_UP reactions, 12 comments. Raw zero-address revoke via `eth_sendTransaction` still rejected; in-UI revoke shipped PR #30969. |
| OZ #2793 "most-upvoted open issue" | API: open since 2021-07-27, **+1:50 / 64 reactions**, top open OZ issue; most-upvoted across OZ/ethers/hardhat/foundry set. (Nuance: opened by Nick Mudge, the EIP author.) |
| ethers #1053 / #4469 / #2030 open | Confirmed open, 79 / 26 / 12 comments respectively, no fix in v6. |
| Coinbase "Agentic Wallets" Feb 2026 | `coinbase/agentic-wallet-skills` created 2026-02-09 (126★). |
| Sphere SDK ~5,400★ | **5,409★** today, created 2026-01-27 — matches. |
| Sandboxed.sh ~474★ | **488★**, created 2025-12-15 — matches. |
| Stablecoin ~$300B | ~$293B (DefiLlama). Holds. |
| Paradigm $1.2B July 2026 | Holds (raised Jul 8, 2026). |

## Action before any public launch
Correct the ❌ and ⚠️ claims in the whitepaper/README. Retire the "no KYC / globally relevant" phrasing (see [[Risk & De-risk Plan]]). Drop the "standard library nobody built" narrative (see [[Competitive Landscape]]).

---
Tags: #sigilkit #corrections #fact-check
