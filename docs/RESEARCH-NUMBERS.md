# Research Numbers — agentic wallet market evidence (as of 2026-09-23)

Single source-of-truth file for the externally sourced figures used in whitepaper,
positioning, and release materials. Every row cites its primary source from
`docs/ECOSYSTEM-RESEARCH-2026-09-23.md`; anything whose primary source is
paywalled/rate-limited is marked as such and must stay out of published claims
until re-verified.

## Live-rail transaction data

| Figure | Value | Source | Verifiability |
|---|---|---|---|
| Agent transactions settled (Keyrock/Coinbase "Who Pays the Agent?", 2026-05-21) | 176M | [keyrock.com](https://keyrock.com/who-pays-the-agent/) | Primary (confirmed) |
| Total value settled | >$73M | same | Primary (confirmed) |
| Share below $0.30 card-fee floor | 76% | same | Primary (confirmed) |
| Share settled in USDC | 98.6% | same | Primary (confirmed) |
| Coinbase x402 transactions (May 2026) | 165M+ | via [Tangem citing CDP](https://tangem.com/en/blog/post/can-ai-agents-pay-for-things/) | Secondary (Coinbase pages 403 to fetchers) |
| x402 active agents | ~69k | same | Secondary |
| x402 annualized volume | ~$600M | same | Secondary |

## Market sizing (projections, not current revenue)

| Figure | Value | Horizon | Source |
|---|---|---|---|
| McKinsey agentic commerce (B2C) | $3–5T | by 2030 | [mckinsey.com](https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-agentic-commerce-opportunity-how-ai-agents-are-ushering-in-a-new-era-for-consumers-and-merchants) |
| Juniper Research agentic commerce | $1.5T | by 2030 | [juniperresearch.com](https://www.juniperresearch.com/research/iot-emerging-technology/ai/agentic-commerce/) |
| Gartner machine-customer economy | $30T | by 2030 | cited in [a16z State of Crypto 2025](https://a16zcrypto.com/posts/article/state-of-crypto-report-2025/) |

## EIP-7702 adoption & security

| Figure | Value | Source |
|---|---|---|
| Type-4 tx share, mainnet blocks (RPC sampling 2026-09-14) | ~0.76–1.2% | [iamuvin.com](https://www.iamuvin.com/blog/web3-account-abstraction-measured-2026) |
| Type-4 tx share, Base | ~0.26% | same |
| Early delegations pointing at copy-pasted sweepers (weeks 1-4 post-Pectra) | >97% | [zealynx.io research](https://www.zealynx.io/research/smart-contracts/eip-7702-wallet-security) |
| Documented 7702 losses: Inferno Drainer (2025-05-24) | $146,551 | same |
| Documented 7702 losses (2025-08-24) | $1.54M | same |

## Funding comparators (agents + payments)

| Company | Round | Amount | Date | Source |
|---|---|---|---|---|
| Crossmint | Ribbit-led | $23.6M | 2025-03-18 | [crossmint.com](https://www.crossmint.com/announcement/crossmint-raises-23-6m-led-by-ribbit-capital) |
| Skyfire | Seed | $8.5M | 2024-08-21 | [Business Wire](https://www.businesswire.com/news/home/20240821247203/en/Introducing-Skyfire-Payment-Rails-for-AI) |
| Talus | Seed (Polychain) | $3M | 2024-02 | [Yahoo Finance](https://finance.yahoo.com/news/talus-network-raises-3-million-160000823.html) |
| Talus | Strategic | $6M | 2024-11 | [Binance Square](https://www.binance.com/en/square/post/16763692728841) |

## Regulatory anchors

| Jurisdiction | Instrument | Date | Relevance |
|---|---|---|---|
| Singapore | MAS SAFR — Safeguards for Agentic Finance at Runtime | 2026-07-03 | Closest existing "autonomous financial agent" regulation; runtime safeguards + audit |
| Korea | FSC human-accountability rule for financial-sector AI | 2026-06 | Human remains accountable for AI decisions |
| US | GENIUS Act (S.1582), stablecoin framework | 2025-07-18 | No agent-spend provisions; digital-payments architecture analysis only |
| EU | MiCA × AI Act joint-obligation analysis (EJRR paper) | — | Agents face obligations from both frameworks |

## Re-verify rules

- Use this file's URLs, not the ecosystem doc's, as the citation target for rewrites.
- Any figure marked Secondary or that a fetch returns 403/429 on must NOT enter the whitepaper unchanged — mark "as cited by" or drop it.
- Refresh this file whenever the whitepaper or POSITIONING doc changes numbers.