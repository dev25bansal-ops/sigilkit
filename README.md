# SigilKit

Open-source (MIT) toolkit for **agent-native wallets** — EIP-7702 hardened delegation,
session-key management with on-chain spend caps, and a mandatory audit trail per action
(unconditional on the manager path; on the ERC-7579 path the trail is conditional — it
requires `ActionLog7579Executor` installed with an `agentId` bound, else `execute` reverts).

> **Current status (2026-10-03):** ✅ **test-ready** — all functional tests pass on the CI toolchain; ❌ **not publicly reachable yet**; ❌ **npm scope unavailable** (`@sigilkit/core` collides with another project); ❌ **pre-audit** (no external security review has completed). See [`docs/VERIFIED-E2E-2026-10-03.md`](docs/VERIFIED-E2E-2026-10-03.md) for the machine-verified snapshot and [`docs/STATUS.md`](docs/STATUS.md) for the document authority model.

> This is the implementation repo. The research + strategy behind it lives in
> [`vault/`](vault/) (an Obsidian knowledge base built from an Aug-2026 worldwide
> research sweep of the original whitepaper). That sweep found several v2.0 claims to be
> fabricated or stale, and shared infra already exists — SigilKit's differentiator is the
> **cross-wallet conformance + on-chain audit-per-call + formal verification of the
> spend-policy core** bundle, not "the standard library nobody built."
>
> Read [`docs/WHITEPAPER-v2.1.md`](docs/WHITEPAPER-v2.1.md) for the corrected whitepaper.
> The original `SigilKit_Whitepaper.txt` is **superseded and must not be cited** — see
> [`docs/STATUS.md`](docs/STATUS.md) for the document authority model.

## Components

| # | Component | Status | What it does |
|---|-----------|--------|--------------|
| 1 | **EIP-7702 Wallet Library** | **Core implemented** | `signAuthorization` / `signRevocation` / `validateAuthorization` with cast-verified RLP digests + viem↔ethers byte-identical signing parity (first cell of the conformance matrix). Live MetaMask 13.49.0 + Coinbase Smart Wallet Playwright harnesses in [`packages/core/test/wallet-e2e/`](packages/core/test/wallet-e2e/README.md) — runnable locally, and wired into CI as the weekly (non-blocking) wallet-conformance job. |
| 2 | **ERC-7579 module** (replaces the bespoke Diamond) | **Implemented** | `SessionKey7579Module.sol` — a VALIDATION module for Kernel/Safe{Core} accounts: scoped session-key userOp authorization with per-action + batch-aware window caps, Merkle whitelists (proofs ride in the signature blob), selector denylists, account-bound EIP-712 domains. It emits NO `ActionLogged` itself: an audit trail on this path requires the paired `ActionLog7579Executor` installed with an `agentId` bound (else `execute` reverts). |
| 3 | **Multi-RPC Provider** | Deferred | viem already covers WS reconnect + retry; use viem directly. |
| 4 | **Agent Session-Key Manager** | Implemented · formally verified for the spend-policy core and parts of the auth paths | `SessionKeyManager.sol` + `SpendPolicy.sol` + `ActionLogger.sol` + `MerkleWhitelist.sol` with on-chain spend caps, per-window rate limits, Merkle target whitelists, and a mandatory `ActionLogged` event per call. |

> **Scope of the "formally verified" label.** Verification is real but **partial, and
> pre-audit**: the 11 Halmos symbolic specs cover the spend-cap core and *parts* of the
> auth paths. Both vacuity findings that `docs/ISSUES-CATALOG-2026-09-25.md` §A recorded
> have since been **fixed** — P0-1 (5 of the 11 Halmos auth specs were trivially
> satisfiable via a free `block.timestamp`) and P0-2 (2 of the 4 Echidna properties
> passed vacuously with no funding), each now guarded by a regression test or a
> falsifiable rewrite. Coverage is still layered rather than exhaustive, so this remains
> **verification tooling, not an audit** — no third party has reviewed these contracts.
> See the pre-audit banner in
> [`docs/WHITEPAPER-v2.1.md`](docs/WHITEPAPER-v2.1.md#abstract) and
> [`docs/VERIFICATION-STRATEGY-2026-09-25.md`](docs/VERIFICATION-STRATEGY-2026-09-25.md)
> for the layer-by-layer strategy.

**Component 4 is the moat and is built first** — see [`vault/Risk & De-risk Plan.md`](vault/Risk%20%26%20De-risk%20Plan.md).

---

### Verify in one command (local, with CI toolchain)

This reproduces the test run from [`docs/VERIFIED-E2E-2026-10-03.md`](docs/VERIFIED-E2E-2026-10-03.md):

```bash
# Install Foundry 1.7.1 (CI pin per SECURITY.md)
curl -L https://foundry.paradigm.xyz | bash
foundryup --install v1.7.1

# Run on-chain tests with pinned toolchain
export PATH="$PATH:~/.foundry/bin"
forge test --no-match-contract ".*Invariant|.*Fork"
# Expected output: "225 tests passed, 0 failed"

# Run TS tests (requires Node >=24; Windows native recommended due to node:sqlite requirement)
npm run build --workspaces --if-present && npm run test --workspaces --if-present
# Expected output: core 573 tests, demo-agent 85, indexer 162, mcp 131 → all pass
```

---

### What you can do today (with no blockers bypassed)

1. **Read the specs:** `contracts/src/` (Solidity implementation) + [`packages/core/src/`](packages/core/src/) (SDK). The code *is* the spec (L1 layer per [`docs/STATUS.md`](docs/STATUS.md)).
2. **Run local Anvil:** deploy the manager, grant a session key, sign an action request, execute it. Observe the `ActionLogged` event emitted. The [`packages/demo-agent/`](packages/demo-agent/) directory provides examples.
3. **Inspect the conformance harnesses:** MetaMask 13.49.0 / Coinbase Smart Wallet Playwright fixtures live in [`packages/core/test/wallet-e2e/`](packages/core/test/wallet-e2e/README.md). They require a real extension profile and persistent Chromium.
4. **Audit the docs:** `docs/SECURITY.md` (threat map + triage), `docs/WALLET_BEHAVIOR_ALLOWLIST.json` (wallet-conformance record), `docs/WHITEPAPER-v2.1.md` (corrected whitepaper, no fabricated claims).

---

### Known blockers (what prevents launch)

| ID | Blocker | Status | Notes |
|---|---|---|---|
| **OD-2** | `@sigilkit/core` npm scope collides with unrelated MIT project | ❌ blocking | Can't publish under `@sigilkit` scope without acquiring it or renaming packages |
| **OD-3** | `.well-known/security.txt` lacks `Encryption:` field | ❌ minor | Needs OpenPGP key generation and resolution before public launch |
| **TD-6** | `wallet-e2e-weekly` runs `continue-on-error: true`, has no green history | ⚠️ monitored | Expiry 2026-10-12; needs written postmortem if a red run occurs |
| **None** | External security audit completed | ❌ blocking (by design) | Pre-audit banner still active; no third-party review finished yet |
| **N/A** | GitHub repo publicly reachable | ❌ current state | Clone URL 404s; visibility decision pending |

After these are resolved, the next step is commissioning an external audit via the Arbitrum Audit Program bounty pool (per `vault/Funding Audit Bounty.md`). That's the longest lead-time dependency — everything else can be addressed independently.


## Verification status

| Layer | Status |
|---|---|
| Foundry unit + fuzz | ✅ 225 tests across 18 suites (7579 module 39 · manager 34 · gas uncovered paths 33 · native transfer authorization 14 · executor 12 · gas budget 11 · graduated authority 11 · ERC-1271 keys 10 · delegator 10 · denylist coverage 10 · E11 watchlist read 9 · account-execute E2E 7 · SEC-10 window rotation 6 · 7579 gas scaling 5 · governance recovery 5 · golden vectors 4 · scope watchlist multi-token 4 · Halmos auth meta-test 1) |
| Echidna property fuzzing | ✅ 4 properties (independent second fuzzer, nightly) — all four are falsifiable: funding is pulled into the wallet through a public `refill()` + `_ensureFunded`, so the `value > 0` paths are reachable instead of reverting on balance; `echidna_attackerNeverSucceedsAtAdmin` (replaces the tautological `echidna_ownerImmutableByFuzzer`) probes all 6 admin functions as a genuine non-owner and fails if `onlyOwner` is ever bypassed; `echidna_scopesMatchOwnerActions` now requires each on-chain scope to be one of three genuinely distinct granted shapes. Fixed in BUG-18 — see [`docs/ISSUES-CATALOG-2026-09-25.md`](docs/ISSUES-CATALOG-2026-09-25.md) §A P0-2 |
| Foundry invariant (INV-1/2/4, handler-only fuzzing incl. admin transitions) | ✅ 4 invariants in 1 suite × 256 runs × 500 calls |
| Fork smoke (Base) | ✅ 1 test — runs nightly against a live Base fork (chainid + chain-bound domain separator + live state) |
| Halmos symbolic (spend-cap core + Merkle boundaries + auth paths) | ✅ 11 specs, all **now executing and non-vacuous** (`halmos --match-contract Halmos`) — P0-1 is **fixed**: the 5 auth specs (replay, nonce accounting, request expiry, denylist gating, window-cap) no longer pass on the trivial false branch, because the harness (a) encodes the call with the **exact 4-argument production arity** and (b) constrains the modelled clock into the granted window via an `atLiveClock` modifier that solc inlines into every spec body. A meta-test, `test_HalmosAuth_ArityIsFour`, **guards the harness itself** (3-arg encoding must fail to decode; 4-arg in-scope request must succeed through the same `_execute` helper), so the arity defect cannot silently return. Strategy: [`docs/VERIFICATION-STRATEGY-2026-09-25.md`](docs/VERIFICATION-STRATEGY-2026-09-25.md) |
| Account-execute E2E (7579 convention) | ✅ validate → execute → value lands, window charged once |
| Slither static analysis | ✅ run; all findings triaged in [`SECURITY.md`](SECURITY.md) |
| TS SDK vs on-chain E2E (Anvil) | ✅ sign → relay → enforce → `ActionLogged` verified in receipt |
| Cross-wallet signing parity | ✅ viem ↔ ethers ↔ hand-rolled reference encoder, byte-identical digests + signatures |
| CI | ✅ 14 jobs across 2 workflows — `ci.yml` (12): a workflow-lint gate, secret scanning, and 4 PR-gated jobs (unit, invariant, Slither, TS+coverage); nightly (deep fuzz, Base fork, Echidna); weekly (live wallet harnesses); monthly (Foundry canary); release (Halmos). `publish.yml` (2): tag-gated npm publish with provenance. Counts are verified against CI output by `npm run check:docs` (which also guards the whitepaper's prose counts) |

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
git clone https://github.com/dev25bansal-ops/sigilkit.git && cd sigilkit
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
npm test                             # 225 unit + fuzz tests + full TS suite (excludes invariants + fork smoke)
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
> git clone https://github.com/dev25bansal-ops/sigilkit.git && cd sigilkit && npm run setup
> ```

```bash
# Audit trail: events → SQLite, then query it (read-only)
node packages/indexer/dist/cli.js backfill --manager 0xYourManager --confirmations 0
node packages/indexer/dist/cli.js spend --agent 0x<32-byte-agent-id> --json

# MCP server for agent frameworks (stdio) — or `npm run mcp`
node packages/mcp/dist/cli.js --help
```

> **The MCP `audit_query` tool is inert until you allowlist a directory.** It refuses *every*
> database path with `DB_NOT_ALLOWED` until you set `SIGILKIT_AUDIT_DB_ROOT` to the absolute
> directory holding your audit database(s) (`;`-separated for several roots), e.g.
> `SIGILKIT_AUDIT_DB_ROOT=/var/lib/sigilkit`. The variable is read **once at startup**, so
> restart the server after changing it. If you see `DB_NOT_ALLOWED`, see
> [`docs/TROUBLESHOOTING.md` → *`audit_query` returns `DB_NOT_ALLOWED`*](docs/TROUBLESHOOTING.md#audit_query-returns-db_not_allowed),
> which also explains how it differs from a genuinely missing file (`DATABASE_NOT_FOUND`).

## Documentation

| Document | Contents |
|---|---|
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Prerequisites, install, first run, SDK/indexer/MCP usage |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable and CLI flag, with defaults |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Contracts, npm publishing, running the indexer/MCP services, rollback |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom → cause → fix for common failures |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, conventions, change recipes, PR process |
| [SECURITY.md](SECURITY.md) | Threat model, Slither triage, disclosure policy |
| [docs/STATUS.md](docs/STATUS.md) | The four-layer document authority model (L1 code → L2 record → L3 plan → L4 context) and which file wins a conflict |
| [docs/WHITEPAPER-v2.1.md](docs/WHITEPAPER-v2.1.md) | **Current** technical whitepaper (v2.1, corrected) — read this, not the v2.0 file below |
| [SigilKit_Whitepaper.txt](SigilKit_Whitepaper.txt) | v2.0 whitepaper — **SUPERSEDED, do not cite**; kept as history, opens with a correction banner |
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

See the table at the top of this README (kept current from CI output, and machine-checked
by `npm run check:docs`). Read it as **verification tooling, not an audit**: no third party
has reviewed these contracts, and while the previously documented vacuity gaps in the two
property layers (Halmos auth paths, Echidna) have been remediated, coverage remains layered
rather than exhaustive — see
[`docs/ISSUES-CATALOG-2026-09-25.md`](docs/ISSUES-CATALOG-2026-09-25.md) and
[`docs/VERIFICATION-STRATEGY-2026-09-25.md`](docs/VERIFICATION-STRATEGY-2026-09-25.md). The
governing pre-audit warning is in
[`docs/WHITEPAPER-v2.1.md`](docs/WHITEPAPER-v2.1.md#abstract).

External audit pending — route: Cantina/Sherlock contest + private review, offset with the
Arbitrum Audit Program.

## License

MIT.
