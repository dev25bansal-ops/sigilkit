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
| 1 | **EIP-7702 Wallet Library** | **Core implemented** | `signAuthorization` / `signRevocation` / `validateAuthorization` with cast-verified RLP digests + viem↔ethers byte-identical signing parity (first cell of the conformance matrix). Live MetaMask 12.5.0 + Coinbase Smart Wallet Playwright harnesses in [`packages/core/test/wallet-e2e/`](packages/core/test/wallet-e2e/README.md) — runnable locally, and wired into CI as the weekly (non-blocking) wallet-conformance job. |
| 2 | **ERC-7579 module** (replaces the bespoke Diamond) | **Implemented** | `SessionKey7579Module.sol` — a VALIDATION module for Kernel/Safe{Core} accounts: scoped session-key userOp authorization with per-action + batch-aware window caps, Merkle whitelists (proofs ride in the signature blob), selector denylists, account-bound EIP-712 domains. |
| 3 | **Multi-RPC Provider** | Deferred | viem already covers WS reconnect + retry; use viem directly. |
| 4 | **Agent Session-Key Manager** | **Implemented + formally verified** | `SessionKeyManager.sol` + `SpendPolicy.sol` + `ActionLogger.sol` + `MerkleWhitelist.sol` with on-chain spend caps, per-window rate limits, Merkle target whitelists, and a mandatory `ActionLogged` event per call. |

**Component 4 is the moat and is built first** — see [`vault/Risk & De-risk Plan.md`](vault/Risk%20%26%20De-risk%20Plan.md).

## Verification status

| Layer | Status |
|---|---|
| Foundry unit + fuzz | ✅ 101 tests across 10 suites (manager 25 · 7579 module 25 · executor 11 · delegator 10 · graduated authority 9 · governance 5 · ERC-1271 keys 4 · account-execute E2E 4 · golden vectors 4 · gas budget 4) |
| Echidna property fuzzing | ✅ 4 properties (independent second fuzzer, nightly) |
| Foundry invariant (INV-1/2/4, handler-only fuzzing incl. admin transitions) | ✅ 4 invariants in 1 suite × 256 runs × 500 calls |
| Fork smoke (Base) | ✅ 1 test — runs nightly against a live Base fork (chainid + chain-bound domain separator + live state) |
| Halmos symbolic (spend-cap core + Merkle boundaries + auth paths) | ✅ 11 specs (`halmos --match-contract Halmos`) — replay, nonce accounting, request expiry, denylist gating, window-cap |
| Account-execute E2E (7579 convention) | ✅ validate → execute → value lands, window charged once |
| Slither static analysis | ✅ run; all findings triaged in [`SECURITY.md`](SECURITY.md) |
| TS SDK vs on-chain E2E (Anvil) | ✅ sign → relay → enforce → `ActionLogged` verified in receipt |
| Cross-wallet signing parity | ✅ viem ↔ ethers ↔ hand-rolled reference encoder, byte-identical digests + signatures |
| CI | ✅ 13 jobs across 2 workflows — `ci.yml` (12): a workflow-lint gate, secret scanning, and 4 PR-gated jobs (unit, invariant, Slither, TS+coverage); nightly (deep fuzz, Base fork, Echidna); weekly (live wallet harnesses); monthly (Foundry canary); release (Halmos). `publish.yml` (1): tag-gated npm publish with provenance. Counts are verified against CI output by `npm run check:docs` (which also guards the whitepaper's prose counts) |

## Repository layout

```
sigilkit/
├─ contracts/                 # Foundry lib (forge-installable): src/ + test/ + script/
│  ├─ src/
│  │  ├─ ActionLogger.sol     # mandatory audit event (INV-3) + WindowCharged
│  │  ├─ SpendPolicy.sol      # per-action + fixed-window (tumbling) caps (INV-1)
│  │  ├─ MerkleWhitelist.sol  # sorted-pair whitelist verification (v2 argument-bound leaves)
│  │  ├─ SessionKeyManager.sol# session keys, scope, rotation, denylist, countersign, balance-delta (INV-2, INV-4)
│  │  ├─ SessionKey7579Module.sol # ERC-7579 VALIDATION module for Kernel/Safe
│  │  ├─ ActionLog7579Executor.sol # ERC-7579 EXECUTOR: audit at execution time
│  │  └─ SigilKitDelegator.sol # EIP-7702-native agent wallet (the EOA delegates to it)
│  ├─ test/                   # unit + invariant + Halmos specs + fork smoke
│  └─ script/Deploy.s.sol     # deploy (SIGILKIT_OWNER_KEY required; no default key)
├─ packages/core/             # @sigilkit/core — TS SDK (EIP-712 signing, EIP-7702, Merkle, client)
│  └─ src/{validation,config,logger,cli}.ts  # boundary validation, env config, logging, CLI plumbing
├─ packages/demo-agent/       # @sigilkit/demo-agent — autonomous treasury bot demo (+ fleet mode)
├─ packages/indexer/          # @sigilkit/indexer — ActionLog → SQLite spend reports
├─ packages/mcp/              # @sigilkit/mcp — MCP server: propose/validate/audit tools
├─ scripts/                   # bootstrap.mjs · verify.mjs · check-doc-counts.mjs · abi-targets.txt
├─ docs/                      # user + operator docs (see Documentation table above)
├─ vault/                     # Obsidian research + build-plan knowledge base
├─ .env.example               # every supported environment variable, documented
├─ Dockerfile / docker-compose.yml  # container packaging for the indexer
└─ .github/workflows/ci.yml   # CI (workflow-lint, unit, invariant, Slither, TS, nightly Base-fork, Halmos gate)
```

## Quick start

```bash
git clone https://github.com/sigilkit/sigilkit.git && cd sigilkit
npm run setup      # Node/Foundry check → install from lockfile → build all packages
npm run verify     # full gate: lint, doc counts, contract tests, TS tests
```

Needs Node 24+ (`.nvmrc` is committed). Foundry 1.7.x is required only for contracts and
the demo. Full walkthrough: [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

### Demo agent (the whole stack in one command)

```bash
anvil &                # local chain
npm run demo           # deploy → grant scoped key → 5 strategy ticks
```

Deploys SessionKeyManager + a Counter target, funds the wallet, grants a 1-hour session key
(0.01 ETH/action, 0.05 ETH/window), and fires two on-chain rebalance actions — each signed by
the agent's session key, enforced on-chain, and audited via `ActionLogged`.

### Contracts (Foundry)

```bash
forge install foundry-rs/forge-std   # or: git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
forge build
npm test                             # 101 unit + fuzz tests + full TS suite (excludes invariants + fork smoke)
forge test --match-contract '.*Invariant'   # invariant suite (4 invariants × 256 runs)
forge test --match-contract '.*Fork' --fork-url $RPC_BASE   # fork smoke (Base)
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

### Services

> **Not yet published to npm.** The `@sigilkit` scope on npm belongs to an unrelated project
> (a different "sigilkit"), so `npm install @sigilkit/core` today would fetch *someone else's*
> package. Until the scope is resolved, consume these from a clone:
>
> ```bash
> git clone https://github.com/sigilkit/sigilkit.git && cd sigilkit && npm run setup
> ```

```bash
# Audit trail: events → SQLite, then query it (read-only)
node packages/indexer/dist/cli.js backfill --manager 0xYourManager --confirmations 0
node packages/indexer/dist/cli.js spend --agent 0x<32-byte-agent-id> --json

# MCP server for agent frameworks (stdio) — or `npm run mcp`
node packages/mcp/dist/cli.js --help
```

## Documentation

| Document | Contents |
|---|---|
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Prerequisites, install, first run, SDK/indexer/MCP usage |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable and CLI flag, with defaults |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Contracts, npm publishing, running the indexer/MCP services, rollback |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom → cause → fix for common failures |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, conventions, change recipes, PR process |
| [SECURITY.md](SECURITY.md) | Threat model, Slither triage, disclosure policy |
| [docs/STATUS.md](docs/STATUS.md) | Which planning document is authoritative |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

One-command entry points:

```bash
npm run setup     # check toolchain, install from lockfile, build every package
npm run verify    # workflow lint + doc counts + typecheck + contract tests + TS tests
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
