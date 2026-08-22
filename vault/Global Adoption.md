# Global Adoption

Regional reality check on the whitepaper's "globally relevant" thesis (Aug 2026). Worldwide emphasis; several exact figures UNVERIFIED this session (source fetches blocked) — flagged.

## Region-by-region
- **South & SE Asia (adoption leaders):** India #1 on Chainalysis 2025 Global Crypto Adoption Index (top five: India, US, Pakistan, Vietnam, Brazil). APAC fastest regional growth (+69% YoY). Vietnam (#4) + Pakistan (#3) major P2P stablecoin hubs. Cambodia Project Bakong (retail CBDC) — clearest non-stablecoin national success; ~1.3B-tx FY2025 figure **UNVERIFIED**. Singapore/Indonesia/Thailand = institutional/regulatory centers; retail leans on cost-sensitive public RPCs.
- **Latin America:** Brazil (#5) + Mexico drive stablecoin remittances. Bitso ("where LATAM invests") reports exponential institutional stablecoin growth; exact $6.5B 2024 **UNVERIFIED**. Argentina = de-facto USD-stablecoin economy. Brazil's Pix+Drex coexists with rising stablecoin use.
- **Africa:** Sub-Saharan Africa +52% YoY. Nigeria standout — eNaira underused, P2P stablecoin (USDT) fills gap; "$59B P2P / inactive eNaira" **UNVERIFIED** but directionally sound. Kenya + Gulf (UAE VARA, Saudi) growing corridors.
- **MENA/GCC:** UAE (VARA-regulated) regional on-ramp hub; Saudi + broader Gulf stablecoin corridors expanding.
- **East Asia:** Japan/Korea/HK/Taiwan still exchange/institutional, not agent-wallet-native.

## Whitepaper figures: hold vs stale
- ✅ Stablecoin ~$300B → **~$293B** (USDT $183B, USDC $73B). EURC surged ~76% MoM (MiCA tailwind).
- ⚠️ Base TVL $4.6B → recovered to **~$5.3B** by Aug 2026 (peaked ~$5.58B Oct 2025) — whitepaper *understates*.
- ✅ Paradigm $1.2B (Jul 2026); a16z ~$2B → actually **$2.2B** (May 2026).
- ✅ India #1 / 30% TDS / e-Rupee — holds directionally (30% TDS persisted into 2026, not repealed).
- ❓ Bakong / Bitso / Nigeria exact figures — **UNVERIFIED** this session.

## Implications for toolkit design
- **RPC defaults:** hardcode multiple regional public endpoints (Ankr/Llama RPC/1RPC) with latency-based failover — not a single default. Mobile/sub-150ms reality in India/Nigeria/SEA is the gating constraint. (Note: `base.llamarpc.com` is now **down** — see [[Component 3 — Multi-RPC Provider]].)
- **Stablecoin assumption:** default USDT+USDC (dominant outside US); include EURC/USDG for EU (MiCA). Not USDC-only.
- **Doc languages & regulation:** India/Pakistan/Vietnam/Nigeria/Brazil are the actual user base — reflect 30% TDS-style tax UX, P2P-first flows, non-US legal framing. Retire "US-centric" assumptions (see [[Risk & De-risk Plan]]).
- **Chain focus:** Base healthy (~$5.3B); L2/cheap-fee chains dominate emerging markets — keep fee/latency assumptions mobile-first.

---
Tags: #sigilkit #market #global #adoption
