# Component 3 — Multi-RPC Provider

**Role (whitepaper):** hardened, auto-reconnecting multi-RPC provider with health checks, failover, WS reconnection. Exports `createResilientHttp()`, `createResilientWs()`, `withFailover()`, `healthCheck()`. Drop-in for viem/ethers transports. Closes ethers #1053.

## Verified facts (Aug 2026)
- ethers #1053 (WS no auto-reconnect) **CONFIRMED open**, 79 comments / 36 reactions, **no v6 fix**. ethers #4469 ("Could not detect network" in Next.js) and #2030 (FallbackProvider hangs under failover) also **open, unfixed**. "Class of bugs" framing valid.
- **viem already has it.** viem `webSocket` transport exposes a `reconnect` option + `retryCount`/`retryDelay` on http/webSocket/fallback. viem is materially more resilient out-of-the-box than the whitepaper implies.
- ethers v6 `WebSocketProvider` accepts a `WebSocketCreator` to rebuild a dropped socket, but **no native auto-reconnect loop** — devs must wire it themselves.
- **Live endpoint reality (Aug 21, 2026):** `mainnet.base.org` ✓, `1rpc.io/base` ✓, `base-rpc.publicnode.com` ✓; **`base.llamarpc.com` DOWN (521)**; **`blastapi.io` DEAD** ("use Alchemy"). Whitepaper's example code uses a *dead* Blast endpoint.
- Managed providers (Alchemy, QuickNode, DRPC, Ankr, Chainstack, 1RPC) already offer health-based routing/multi-region.

## ⚠️ Research recommendation: DROP / DEFER
**Near-zero differentiation.** viem covers WS reconnect + retry + fallback natively; managed SDKs cover the rest. A standalone library only beats "just use QuickNode/Alchemy" for **cost-sensitive / emerging-market** users pooling free endpoints (PublicNode, 1RPC, Ankr, Chainstack).

**Default:** use viem directly; if shipped at all, build a **thin health-scoring layer on viem** (latency p95, error rate, block-height lag `MAX_BLOCK_AGE`, 429/Retry-After, exponential backoff + jitter, Base L2 reorg awareness) — not from-scratch transports. Defer behind Components 1 + 4. See [[Risk & De-risk Plan]].

## Design notes if built (from research)
- WS self-healing: exponential backoff + jitter, `readyState` heartbeat ping, re-subscribe on reconnect.
- Multi-endpoint failover with **health scoring** (latency, error rate, block-height lag).
- 429 handling: honor `Retry-After`, cap+backoff, jitter, circuit-break consistently-failing endpoints.
- Base/L2: blocks ~2s; only treat state finalized after L1 rollup-batch confirmation (~minutes); don't surface reorged blocks as confirmed.

---
Tags: #sigilkit #component #rpc
