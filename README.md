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
| 1 | **EIP-7702 Wallet Library** | **Core implemented** | `signAuthorization` / `signRevocation` / `validateAuthorization` with cast-verified RLP digests + viem↔ethers byte-identical signing parity (first cell of the conformance matrix). Live MetaMask 12.5.0 + Coinbase Smart Wallet Playwright harnesses in [`packages/core/test/wallet-e2e/`](packages/core/test/wallet-e2e/README.md) (manual; CI wiring pending). |
| 2 | **ERC-7579 module** (replaces the bespoke Diamond) | **Implemented** | `SessionKey7579Module.sol` — a VALIDATION module for Kernel/Safe{Core} accounts: scoped session-key userOp authorization with per-action + batch-aware window caps, Merkle whitelists (proofs ride in the signature blob), selector denylists, account-bound EIP-712 domains. |
| 3 | **Multi-RPC Provider** | Deferred | viem already covers WS reconnect + retry; use viem directly. |
| 4 | **Agent Session-Key Manager** | **Implemented + formally verified** | `SessionKeyManager.sol` + `SpendPolicy.sol` + `ActionLogger.sol` + `MerkleWhitelist.sol` with on-chain spend caps, per-window rate limits, Merkle target whitelists, and a mandatory `ActionLogged` event per call. |

**Component 4 is the moat and is built first** — see [`vault/Risk & De-risk Plan.md`](vault/Risk%20%26%20De-risk%20Plan.md).

## Verification status

| Layer | Status |
|---|---|
| Foundry unit + fuzz | ✅ 40 tests (18 manager + 22 ERC-7579 module) |
| Foundry invariant (INV-1/2/4, handler-only fuzzing) | ✅ 4 suites × 256 runs × 500 calls |
| Fork smoke (Base) | ✅ 1 test — runs nightly against a live Base fork |
| Halmos symbolic (spend-cap core + Merkle boundaries) | ✅ 6 specs (`halmos --match-contract HalmosTest`) — scope: the spend-policy math, not yet the auth paths |
| Slither static analysis | ✅ run; all findings triaged in [`SECURITY.md`](SECURITY.md) |
| TS SDK vs on-chain E2E (Anvil) | ✅ sign → relay → enforce → `ActionLogged` verified in receipt |
| Cross-wallet signing parity | ✅ viem ↔ ethers ↔ hand-rolled reference encoder, byte-identical digests + signatures |
| CI | ✅ 6 jobs defined (5 PR-gated, fork+Halmos gated); runs on GitHub once pushed |

## Repository layout

```
sigilkit/
├─ contracts/                 # Foundry lib (forge-installable): src/ + test/ + script/
│  ├─ src/
│  │  ├─ ActionLogger.sol     # mandatory audit event (INV-3)
│  │  ├─ SpendPolicy.sol      # per-action + fixed-window (tumbling) caps (INV-1)
│  │  ├─ MerkleWhitelist.sol  # sorted-pair whitelist verification
│  │  ├─ SessionKeyManager.sol# session keys, scope, rotation, denylist (INV-2, INV-4)
│  │  └─ SessionKey7579Module.sol # ERC-7579 VALIDATION module for Kernel/Safe
│  ├─ test/                   # unit + invariant + Halmos specs + fork smoke
│  └─ script/Deploy.s.sol     # deploy (SIGILKIT_OWNER_KEY required; no default key)
├─ packages/core/             # @sigilkit/core — TS SDK (EIP-712 signing, EIP-7702, Merkle, client)
├─ packages/demo-agent/       # @sigilkit/demo-agent — autonomous treasury bot demo
├─ vault/                     # Obsidian research + build-plan knowledge base
└─ .github/workflows/ci.yml   # CI (unit, invariant, Slither, TS, nightly Base-fork, Halmos gate)
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
forge test                           # 40 unit + 4 invariant suites + 1 fork smoke (needs --fork-url)
```

Deploy locally (Anvil):

```bash
anvil &
SIGILKIT_OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script contracts/script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

The owner key is required (the script fails loudly if unset — it never falls back to a
well-known key). On any shared/persistent network, use a key you control and consider a
Safe as the owner address.

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
| **INV-1** | Sum of values out within any single fixed (tumbling) window ≤ `perWindowCap`. Up to ~2× `perWindowCap` may cross a window boundary (the window resets fully on rollover — it is not a sliding window). |
| **INV-2** | After `expiry`, a session key cannot modify any state. |
| **INV-3** | `ActionLogged` is emitted **iff** the inner call succeeded — no silent success. |
| **INV-4** | Owner-only selectors are unreachable through `executeWithSessionKey` on any target. |

Enforcement is Checks-Effects-Interactions + `nonReentrant` + ERC-7201 namespaced storage
(collision-safe). **Token-spend capping:** whitelist leaves (format v2) commit the calldata via
`argsHash`, so an owner can bind a whitelisted selector to the EXACT arguments — e.g. one specific
`transfer(recipient, amount)` — and a compromised agent cannot vary them. A wildcard leaf
(`argsHash = 0`) whitelists the selector for any calldata. Native-value caps always apply
independently. **Residual blind spot:** calldata cannot see nested ERC-20 pulls inside a trusted
router call — mitigate with trusted-target allowlists and post-hoc reconciliation against
cumulative `ActionLogged` records. See [`SECURITY.md`](SECURITY.md).

## Verification status

See the table at the top of this README (kept current from CI output). External audit pending —
route: Cantina/Sherlock contest + private review, offset with the Arbitrum Audit Program.

## License

MIT.
