# SigilKit

Open-source (MIT) toolkit for **agent-native wallets** — EIP-7702 hardened delegation,
session-key management with on-chain spend caps, and a mandatory audit trail per action.

> This is the implementation repo. The research + strategy behind it lives in
> [`vault/`](vault/) (an Obsidian knowledge base built from an Aug-2026 worldwide
> research sweep of the original whitepaper). The whitepaper's framing is corrected there:
> several specific claims were fabricated/stale and shared infra already exists — SigilKit's
> differentiator is the **cross-wallet conformance + on-chain audit-per-call + formal verification**
> bundle, not "the standard library nobody built."

## Components

| # | Component | Status | What it does |
|---|-----------|--------|--------------|
| 1 | **EIP-7702 Wallet Library** | **Core implemented** | `signAuthorization` / `signRevocation` / `validateAuthorization` with cast-verified RLP digests + viem↔ethers byte-identical signing parity (first cell of the conformance matrix). MetaMask/Coinbase Playwright legs pending. |
| 2 | **ERC-7579 module** (replaces the bespoke Diamond) | **Implemented** | `SessionKey7579Module.sol` — a VALIDATION module for Kernel/Safe{Core} accounts: scoped session-key userOp authorization with per-action + batch-aware window caps, Merkle whitelists (proofs ride in the signature blob), selector denylists, account-bound EIP-712 domains. |
| 3 | **Multi-RPC Provider** | Deferred | viem already covers WS reconnect + retry; use viem directly. |
| 4 | **Agent Session-Key Manager** | **Implemented + formally verified** | `SessionKeyManager.sol` + `SpendPolicy.sol` + `ActionLogger.sol` + `MerkleWhitelist.sol` with on-chain spend caps, per-window rate limits, Merkle target whitelists, and a mandatory `ActionLogged` event per call. |

**Component 4 is the moat and is built first** — see [`vault/Risk & De-risk Plan.md`](vault/Risk%20%26%20De-risk%20Plan.md).

## Verification status

| Layer | Status |
|---|---|
| Foundry unit + fuzz | ✅ 34 tests (17 manager + 17 ERC-7579 module) |
| Foundry invariant (INV-1/2/4, handler-only fuzzing) | ✅ 4 suites × 256 runs × 500 calls |
| Halmos symbolic (spend-cap core + Merkle boundaries) | ✅ 6 specs (`halmos --match-contract HalmosTest`) |
| Slither static analysis | ✅ run; all findings triaged in [`SECURITY.md`](SECURITY.md) |
| TS SDK vs on-chain E2E (Anvil) | ✅ sign → relay → enforce → `ActionLogged` verified in receipt |
| Cross-wallet signing parity | ✅ viem ↔ ethers byte-identical digests + signatures |

## Repository layout

```
sigilkit/
├─ contracts/                 # Foundry lib (forge-installable): src/ + test/ + script/
│  ├─ src/
│  │  ├─ ActionLogger.sol     # mandatory audit event (INV-3)
│  │  ├─ SpendPolicy.sol      # per-action + rolling-window caps (INV-1)
│  │  └─ SessionKeyManager.sol# session keys, scope, rotation, denylist (INV-2, INV-4)
│  ├─ test/                   # unit + invariant (INV-1..4) suites
│  └─ script/Deploy.s.sol     # deterministic deploy
├─ packages/core/             # @sigilkit/core — TS SDK (EIP-712 signing, Merkle, client)
├─ vault/                     # Obsidian research + build-plan knowledge base
└─ .github/workflows/ci.yml   # 8-layer CI (unit, invariant, Slither, TS, fork, Halmos)
```

## Quick start

### Demo agent (the whole stack in one command)

```bash
anvil &                                # local chain
cd packages/demo-agent && npm run demo # deploy → grant scoped key → 5 strategy ticks
```

Deploys SessionKeyManager + a Counter target, funds the wallet, grants a 1-hour session key
(0.01 ETH/action, 0.05 ETH/window), and fires two on-chain rebalance actions — each signed by
the agent's session key, enforced on-chain, and audited via `ActionLogged`.

### Contracts (Foundry)

```bash
forge install foundry-rs/forge-std   # or: git clone —depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
forge build
forge test                           # 34 unit + 4 invariant suites, 38 total
```

Deploy locally (Anvil):

```bash
anvil &
forge script contracts/script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

### SDK (TypeScript)

```bash
npm install
npm test --workspace @sigilkit/core    # cross-language conformance vs. Anvil
```

## Security model

The agent (session key) is treated as **untrusted**. A compromised agent or SDK cannot exceed
the granted scope — caps and the deny list are enforced in the contract, not off-chain.

| Invariant | Guarantee |
|-----------|-----------|
| **INV-1** | Sum of values out within any rolling window ≤ `perWindowCap`. |
| **INV-2** | After `expiry`, a session key cannot modify any state. |
| **INV-3** | `ActionLogged` is emitted **iff** the inner call succeeded — no silent success. |
| **INV-4** | Owner-only selectors are unreachable through `executeWithSessionKey` on any target. |

Enforcement is Checks-Effects-Interactions + `nonReentrant` + ERC-7201 namespaced storage
(collision-safe). The internal-transfer blind spot (calldata can't see nested ERC-20 pulls)
is mitigated by a trusted-target allowlist, post-hoc `ActionLogger` reconciliation, and an
optional ERC-20 allowance pre-check — documented in [`vault/Component 4 — Agent Session-Key Manager.md`](vault/Component%204%20%E2%80%94%20Agent%20Session-Key%20Manager.md).

## Audit & verification status

- ✅ 21 Foundry tests (unit + stateful invariant, 128k fuzz calls each, zero INV violations).
- ⬜ Slither clean (CI job wired; run `slither contracts/src --fail-high`).
- ⬜ Halmos symbolic proofs (`prove_*`) for INV-1..4 before mainnet.
- ⬜ External audit (book Cantina/Sherlock; offset with Arbitrum Audit Program).

## License

MIT.
