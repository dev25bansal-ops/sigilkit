# Competitive Landscape

What already exists (Aug 2026) — proving the whitepaper's "standard library nobody built" framing is **false**. Research recommends competing on the *bundle* (conformance + audit + verification), not on primitives.

## EIP-7702 tooling
- `base/eip-7702-proxy` (73★) — Base's own ERC-1967 delegation to CoinbaseSmartWallet. Canonical reference.
- `fireblocks-labs/awesome-eip-7702` (105★) — curated list/registry.
- `codeesura/eip7702-clean-delegation` (13★) — dedicated **revoke CLI** (standard + sponsored modes). Direct SigilKit competitor.
- `ethanzhrepo/eip7702cleaner` (Go, 23★), `Uniswap/calibur` (65★), `okx/wallet-core` (68★), `openfort-xyz/openfort-7702-account` (7★).
- `Arvolear/awesome-eip-7702-delegations` (72★).

## Agent wallets / session keys / modular accounts
- **Coinbase AgentKit / agentic-wallet-skills** (Feb 2026, 126★) — agentic wallet layer.
- **Sphere SDK** (5,409★) — "autonomous economic agents."
- **Sandboxed.sh** (488★) — safe runtime for on-chain AI agents.
- **ZeroDev Kernel** (255★) — modular smart account.
- **RhinoStone / `rhinestonewtf/modulekit`** (ERC-7579 modules, 80★) — the modular-account standard library SigilKit should build *on*, not against.
- **`noders-team/monad-agent-kit`** — already ships "session-key smart account (spend caps, allowlist, expiry, freeze)."
- **AgentPay** (`worldliberty/agentpay-sdk`, 460★) — agent payments.
- **Safe{Core}** `5afe/safe-eip7702` (52★) — experimental 7702 POC.

## Standards that own each slot
- **Agent-wallet extensibility:** ERC-7579 + ERC-6900 (modular/plugin accounts). → Use for [[Component 2 — EIP-2535 Diamonds Module]] instead of a bespoke Diamond.
- **Agent identity:** ERC-8004 (AgentIndex/AER) — live but no mature shared primitive lib on top yet.
- **Delegation:** ERC-7710.
- **7702 + session-key + audit** with formal verification: **nobody bundles this** → SigilKit's gap.

## Non-US usage evidence
GitHub search (~652 EIP-7702 repos) shows real Asia/EU adoption: OKX wallet-core (China, 68★), Bitget wallet-skill (233★), ethanzhrepo/eip7702cleaner (China, 23★), Ambire (EU, 68★), 5afe/safe-eip7702 (EU, 52★), CasualHackathon/EIP-7702 cohort (14★, LXDAO/ETHPanda China). No clearly India/Korea/Japan/LatAm/Africa-flagged repos surfaced in top results.

---
Tags: #sigilkit #competitive #market
