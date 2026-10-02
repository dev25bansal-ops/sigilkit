# Changelog

All notable changes to SigilKit are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows semver.

## [Unreleased]

### 2026-09-15 — production readiness (developer experience, configuration, validation, docs)

Everything a new user or operator needs to install, configure, run and troubleshoot the
project without reading the source.

**Added — one-command setup and verification**
- `npm run setup` (`scripts/bootstrap.mjs`): checks Node ≥ 24 and Foundry, installs from
  the lockfile, builds every workspace, and prints what it found plus next steps. A missing
  Foundry is a warning with install instructions, not a failure — the TS packages build
  without it.
- `npm run verify` (`scripts/verify.mjs`): workflow lint → doc counts → workspace typecheck
  → build → Foundry unit+fuzz → TS tests. Steps run independently so one failure does not
  hide the rest; each is timed and summarised. `--quick` skips the Foundry suites.

**Added — configuration**
- `.env.example` documenting every supported variable, and `docs/CONFIGURATION.md` as the
  reference (precedence, defaults, exit codes, per-command flags).
- **`.env` is now actually loaded.** The docs told users to `cp .env.example .env`, but nothing
  read the file — every variable set there was silently ignored. Every CLI now loads `.env`
  then `.env.local` from the working directory at startup (Node's built-in loader, no
  dependency). A real environment variable always wins, so CI and containers still override it.
  Precedence is now: flag → real env var → `.env` → default.
- `packages/core/src/config.ts`: validated environment readers — `readEnvInt`, `readEnvUrl`,
  `readEnvBool`, `readEnvAddress`, `readEnvPrivateKey`, `readEnvBigInt`, `readEnvChoice`,
  `requireEnv`, `loadServiceConfig`. A variable that is **set but invalid** is an error, not a
  silent fallback — including `SIGILKIT_LOG_LEVEL` / `SIGILKIT_LOG_FORMAT`, which previously
  fell back to the default and made a typo invisible.
- New variables: `SIGILKIT_LOG_LEVEL`, `SIGILKIT_LOG_FORMAT` (`text`|`json`),
  `SIGILKIT_DB_PATH`, `SIGILKIT_MANAGER`, `SIGILKIT_INDEXER_CHAIN_ID`,
  `SIGILKIT_CONFIRMATIONS`, `SIGILKIT_MAX_BLOCK_RANGE`.
- `.nvmrc` (Node 24) and `.editorconfig` (LF everywhere, so the ABI byte-diff gate and
  golden vectors stay stable across editors).

**Added — input validation, logging and CLI ergonomics**
- `packages/core/src/validation.ts`: `assert*`/`is*` helpers whose errors name the field
  (`managerAddress: expected a 20-byte hex address…`) plus a `ValidationCollector` for
  reporting every problem at once.
- `packages/core/src/logger.ts`: leveled logger with `text`/`json` output, scoped children,
  and a sink that never throws. The SDK and indexer now log through it instead of
  `console`.
- `packages/core/src/cli.ts`: one CLI contract for every binary — `--help`/`-h`,
  `--version`/`-V`, `--flag=value` and `--flag value`, unknown-flag suggestions
  ("did you mean --db?"), `choices`, required flags, typed validating getters, and exit
  codes `0` success / `1` runtime / `2` usage. `UserError` prints a single actionable line
  with an optional hint instead of a stack trace.
- All three CLIs retrofitted. `sigilkit-indexer` gained `--json` output and `--log-level`, and
  now validates `--agent`/`--key` **before** opening the database; `sigilkit-mcp` gained
  `--help`/`--version`/`--log-level` and shuts down cleanly when the client closes the pipe;
  `sigilkit-demo` gained `--ticks`, `--tick-delay`, `--chain-id` and `--json`, and checks
  the RPC is reachable before attempting a deploy.
- MCP tools validate their arguments (addresses, hashes, hex lengths, ranges, enum values)
  and report the offending field; `initialize` reports the real package version.
- `@sigilkit/core` exposes `/validation`, `/logger`, `/config` and `/cli` subpaths.

**Added — documentation and packaging**
- `docs/GETTING-STARTED.md`, `docs/CONFIGURATION.md`, `docs/DEPLOYMENT.md`,
  `docs/TROUBLESHOOTING.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`.
- README: one-command quick start and a documentation index.
- Per-package READMEs for `core`, `indexer`, `mcp` and `demo-agent` (previously only two
  packages had one, and `files[]` advertised a README that did not exist).
- GitHub issue templates (bug report, feature request), issue-template config, and a pull
  request template with the project's checklists.
- `Dockerfile`, `docker-compose.yml` and `.dockerignore` for the indexer/MCP services:
  multi-stage build, production dependencies only, non-root user, `/data` volume, and a
  health check.
- `scripts/check-doc-counts.mjs` now guards the **whitepaper** as well as the README: Foundry
  totals, suite count, CI job counts and the per-suite breakdown sum are compared against the
  toolchain, so the numbers an auditor reads cannot drift silently (they already had once:
  "38 Foundry tests" against a real 86). It also counts the **Halmos specs** statically
  (`check_` functions across `contracts/test/Halmos*.t.sol` — 6 + 5 = 11, matching the docs),
  which is verifiable without Halmos installed. `npm run check:docs:full` additionally runs
  every suite to verify the per-package TypeScript totals; that form runs in the release
  workflow.
- `CONTRIBUTING.md` documents the optional verification tools (Halmos 0.3.3, Slither 0.11.6,
  Echidna v2.2.5) with their exact commands, and notes that their counts are checked statically
  so a new spec is validated even where the tool is not installed.
- `scripts/check-dockerfile.mjs` (`npm run lint:docker`, run in the workflow-lint CI job):
  statically verifies the container packaging — every `COPY` source exists in the build
  context, no `COPY` source is excluded by `.dockerignore`, and every `ENTRYPOINT`/`CMD` /
  compose `entrypoint` script resolves. The image is the one deliverable CI cannot build
  cheaply, so these invariants were previously unchecked and would only fail on a machine
  with a Docker daemon.

**Fixed**
- **The documented npm install would have fetched a stranger's package.** `@sigilkit/core`
  already exists on npm (v0.11.1, an unrelated project that owns the scope), so
  `npm install @sigilkit/core` resolves to theirs and `npm publish` fails with `E403`.
  `@sigilkit/indexer` and `@sigilkit/mcp` do not exist at all. The README, GETTING-STARTED,
  all three package READMEs, the whitepaper and DEPLOYMENT now say so explicitly and give the
  from-clone commands that work today. `publish.yml` gains a **scope-ownership preflight** that
  fails with the maintainer list instead of an opaque 403 after the whole gate. Resolving the
  namespace (rename, or publish under a scope this project controls) is a decision for the
  maintainers — it is not something a doc change can fix.
- **The declared repository URL is not publicly reachable.** `github.com/sigilkit/sigilkit`
  and `github.com/sigilkit` both return HTTP 404 anonymously, so the `git clone` in the README
  and GETTING-STARTED fails, every `package.json` `repository.url` resolves to nothing, and the
  `.well-known/security.txt` Contact/Policy URIs (added earlier in this release) are dead links.
  `docs/DEPLOYMENT.md` gains a "Before public launch" section listing this and the npm-scope
  conflict as the two blocking prerequisites, with what to do about each. `security.txt` now
  records the verified state so nobody assumes the channel works.
- Indexer query commands reported a raw `unable to open database file` for a missing store.
  They now say `audit database not found: <path>` with the command that would create it, and
  validate their own arguments first so a typo is reported as a typo.
- The `getWindowState` degradation warning in the SDK went through `console.warn`; it now
  goes through the configurable logger.
- **`npm ci` was broken for every platform except the one the lockfile was generated on.**
  `package-lock.json` was missing the optional per-platform binaries (`@rollup/rollup-linux-x64-gnu`,
  `@esbuild/linux-x64`, `@rollup/rollup-darwin-*`, …), so a clean install — including the CI
  runners — failed with `EUSAGE ... Missing: … from lock file`. Regenerated with npm 11;
  the diff is additive (the platform packages plus dropped stale `"peer": true` markers) and
  moves no dependency version. `npm ci --dry-run` now succeeds.
- `eip7702.test.ts` assumed a pristine chain for a hard-coded EOA. Because `spawnAnvil()`
  reuses a node already listening on :8545, a previous run's revocation designator made the
  suite fail depending on what had run before it. The test now clears the account's code
  first and restores it afterwards, and `spawnAnvil()` announces reuse instead of silently
  attaching to a dirty chain.
- `scripts/verify.mjs` and `scripts/bootstrap.mjs` passed an args array together with
  `shell: true`, which Node 24 deprecates (`DEP0190`) — and, more seriously, re-parsed every
  argument as shell *syntax* rather than data. Part of each script's argv is derived from
  repository files (workspace names come from `package.json`, which a pull request can edit),
  so `;`, a backtick, `$(…)` or `|` in any of those elements executed. An intermediate fix
  built a single command string; **the fix that ships removes the shell entirely.** npm is now
  run through its resolved JavaScript entry point (`npm-cli.js`) with the current `node`, so a
  real argv array works end to end and the Windows `.cmd` shim is never involved — it has to be
  *bypassed* rather than accommodated, because Node refuses to spawn a `.cmd` without a shell
  (the CVE-2024-27980 mitigation). **No step in either script now uses a shell.** (SEC-11)
- `scripts/bootstrap.mjs` gains `--install`, for environments where `npm ci` cannot replace
  `node_modules` (Windows file locks, restricted sandboxes). `npm ci` remains the default,
  and its failure message points at the flag.
- `packages/demo-agent/src/devkeys.ts` names `forge.exe` explicitly on Windows rather than
  relying on `CreateProcess` extension resolution.
- **`npm run demo -- --ticks 10` silently ignored its flags.** The root `demo` / `fleet` /
  `mcp` scripts chained into `npm run … --workspace …`, so everything after `--` was appended
  to the *inner* npm invocation and consumed there — the demo ran with its defaults and no
  error. Each script now ends with `--`, forwarding arguments to the CLI as documented.
- `SIGILKIT_LOG_LEVEL` / `SIGILKIT_LOG_FORMAT` were the only variables that fell back
  silently on an unrecognized value, contradicting the documented "set but invalid is an
  error" contract. They are now validated like every other setting (values still matched
  case-insensitively), and `readEnvChoice` is exported for the same job elsewhere.
- `scripts/clean.mjs` listed `packages/core/coverage` but not the other three packages'
  coverage directories, so `npm run clean` left them behind once coverage was enabled for
  every workspace. The per-package artifact lists are now derived from one package list, so
  they cannot drift apart again.

**Tests**
- `@sigilkit/core` +83 (validation 18, CLI 30, config 16, logger 19) → 358 passed (+1 skipped).
- `@sigilkit/mcp` +33 (25 tool-argument + 8 stdio-transport) → 40 passed.
- **Correction (re-measured 2026-10-02, supersedes the 2026-09-15 per-package totals below).**
  The four TypeScript totals recorded in this entry were a snapshot taken on 2026-09-15 and
  were never refreshed. A real `vitest run` per workspace against the current tree reports
  Suites: core 573 · indexer 145 · mcp 131 · demo-agent 82. `npm run
  check:docs:full` now guards these figures, so the numbers in the next bullet are kept
  verbatim as that release's record rather than rewritten.
- Suites: core 569 (+1 skipped) · indexer 87 · mcp 65 · demo-agent 36. _(as measured on 2026-09-15; retained as the record of that release)_
- Coverage: core 92.5% stmts / 87.9% branches · indexer 72.8/70.9 · mcp 90.7/73.9 ·
  demo-agent 95.8/78.9 — all above their configured floors.

### 2026-09-12 — issues-catalog remediation (`docs/Issues-Catalog-2026-09-12.md`)

All 42 items in the 2026-09-12 catalog addressed.

**Fixed — CI (the critical one)**
- `ci.yml` was **invalid YAML**: a mis-indented step (line 185) made the whole file
  unparseable, so GitHub rejected it and **all jobs were silently dead**. Re-indented.
- New `workflow-lint` job: parses every workflow with a real YAML parser and asserts the
  structural shape GitHub requires, so this class of defect cannot recur (`scripts/validate-workflows.mjs`).
- ABI drift gate now regenerates **all four** contracts from a shared list
  (`scripts/abi-targets.txt`) — `SigilKitDelegator` was consumed by the gate but omitted from
  the regeneration loop, so its committed ABI could drift undetected.
- CI now runs the indexer and mcp test suites and lints mcp (previously ungated).
- Added `.gitattributes` so the ABI byte-diff gate is platform-stable.

**Fixed — contracts**
- `test_RejectsWrongSigner` now pins the expected custom error instead of asserting a bare revert.
- `SigilKitDelegator` implementation-inertness documented in `SECURITY.md` with a regression test.
- Empty-calldata audit selector documented as the explicit `0x00000000` sentinel.

**Fixed — SDK (`@sigilkit/core`)**
- `validateAgainstScope` scope-expiry boundary aligned to the contract (`>` not `>=`) — the
  client no longer refuses a request in the key's final valid second (BUG-3).
- `checkTokenPath` queried `allowance(from, token)` instead of `allowance(from, manager)` and
  only in the case where no allowance is needed at all; it also issued a discarded `decimals()`
  probe. Rewritten with correct spender semantics, no `as never` cast, and concurrent reads (BUG-4).
- `ActionLogRecord` now carries `logIndex` — the natural key for a lossless audit store.
- `SigilKitClientConfig` accepts an optional pre-built `publicClient` (custom/fallback transport
  or test stub).

**Fixed — indexer (`@sigilkit/indexer`)**
- Lossless: rows keyed by `(chain_id, tx_hash, log_index)`; N actions in one transaction now
  produce N rows (was collapsing same-shape siblings).
- Idempotent: every write is an upsert on that key — re-indexing never duplicates rows.
- Resumable: the sync cursor persists in `sync_state`; a restart resumes instead of jumping to
  the head and silently skipping blocks.
- Reorg-aware: `block_hash` stored, `removed` logs deleted, `rollbackTo()`, and polling stops
  `confirmations` blocks behind the head.
- Resilient: `getLogs` chunked to `maxBlockRange` with exponential backoff.
- Multi-chain: `chain_id` is a per-query filter; one store can hold several chains.
- Read-only mode (`{ readOnly: true }`) performs no mkdir, DDL or writes; `close()` added.
- Legacy databases migrate in place on open (no audit data lost).

**Fixed — MCP (`@sigilkit/mcp`)**
- `audit_query` is now genuinely read-only (it previously ran `CREATE TABLE`/`mkdir` while
  advertising "Read-only"), and always releases its database handle.

**Fixed — packaging & docs**
- Per-package `engines`, `files`, `publishConfig`; internal deps pinned to `^0.1.0`
  (were `"*"`, which resolves to whatever core version is newest at install time).
- `publish.yml` now publishes `@sigilkit/indexer` and `@sigilkit/mcp`, not just core.
- Whitepaper: "audited" removed (no external audit has occurred); stale counts corrected.
- README/CHANGELOG counts now verified against the toolchain by `npm run check:docs`
  (`scripts/check-doc-counts.mjs`: README totals, CI job counts, per-suite breakdown sum).
- `docs/STATUS.md` is the single source of truth for which planning doc is active (TD-4);
  `vault/README.md` records the deliberate keep-with-boundary decision for research notes (TD-8).
- Whitepaper footer re-dated to September 2026 (was "August 2026" though authored
  2026-09-11); this CHANGELOG's `Unreleased` section carries the `2026-09-12` remediation
  date, superseding the stale `2026-09-11` header (TD-10).

**Tech-debt gates closed (TD-1/2/5/6/7/9)**
- TD-1 (≡ PERF-4): `contracts/test/GasBudget.t.sol` bounds the enforcement hot path;
  `.gas-snapshot` committed, nightly drift reported — see Verification below.
- TD-2: v8 coverage thresholds in every package (`core` 88/74, `indexer` 70/65,
  `mcp` 70/50, `demo-agent` 90/60 lines/branches); `npm run test:coverage` in all four
  package.json scripts; CI runs coverage for every workspace, not just core.
- TD-5: weekly wallet-e2e job caches Playwright Chromium + the pinned MetaMask 12.5.0
  bundle — no more 21.7 MB re-download per run.
- TD-6: all three `continue-on-error` waivers get dated removal criteria in `ci.yml`
  comments + `docs/CI-WAIVERS.md` (the tracked register; expires 2026-10-12 / 2026-10-31 /
  2026-11-30 — no waiver outlives Q3 2026 without a written justification).
- TD-7: gitleaks secret-scan CI job (pinned v8.30.1, SHA256-verified, `.gitleaks.toml`
  tuned for Anvil dev keys) + `SECURITY.md` disclosure policy + staged RFC 9116
  `.well-known/security.txt` (Contact/Expires/Policy), freshness-guarded by
  `check-doc-counts.mjs` on every run. No mailto: yet — the repo has no domain; the
  GitHub Security Advisories channel is primary until publication.
- TD-9: `workflow-lint` job (YAML parse + structural shape) + actionlint — the BUG-1
  class (invalid workflow YAML disabling all CI) fails fast instead of failing silent.
- TD-3: `.github/dependabot.yml` — weekly grouped npm updates (whole monorepo shares one
  lockfile; `@sigilkit/*` internal pins ignored by design) + monthly GitHub-Actions
  updates. Internal deps stay `^0.1.0` pinned (SEC-2); the committed `package-lock.json`
  is the drift record `npm ci` enforces.

### 2026-09-11 — first remediation wave (`docs/Issues-Catalog-2026-09-11.md`)

23 of 24 catalog issues closed in code; the remaining item (A1: creating the public GitHub
repository and first CI run) is a single publish action.

### Added — Contracts (enhancements wave)
- `SigilKitDelegator.sol` — EIP-7702-native agent wallet: an EOA delegates to it and
  gains the full enforcement core with value flowing from its own balance (E13).
- `WindowCharged` event — observable window accounting for reconciliation/indexing (E1).
- Graduated authority — `Scope.countersignAbove` + owner `RequestApproval` countersign
  for large actions; owner's own key exempt (E10).
- Balance-delta enforcement — optional `Scope.enforceNativeDelta` + 8-token watchlist;
  inner calls cannot siphon beyond declared amounts (E11).
- ERC-1271 smart-account session keys — signature = `address(keyContract) || sig` (E17).
- Per-tuple Merkle proofs unlock batching under whitelists in the 7579 module (E16).

### Added — TypeScript & packages
- `SigilKitClient.execute` — one-call prepare/sign/send/confirm returning the typed
  `ActionLogRecord`; `parseActionLogged` (E3).
- `decodeSigilKitError` / `decorateWithDecodedRevert` — named revert decoding (E4).
- `checkTokenPath` — balance/allowance pre-checks for standard token calls (E8).
- `simulateExecution` — eth_call simulation before sending (E12).
- `NonceGate` + `LeaseStore`/`InMemoryLeaseStore` — per-key serialization with a
  cross-worker coordination seam (E18).
- Inner-call revert bubbling: recognizable reasons pass through; unknown stay
  `InnerCallFailed` (E2).
- `@sigilkit/indexer` — ActionLog/WindowCharged → SQLite spend reports + CLI (E9).
- `@sigilkit/mcp` — MCP server: validate_request / build_scope / decode_error /
  audit_query tools for agent frameworks (E14).

### Added — Toolchain
- Golden-vector corpus (`vectors/`) consumed by BOTH the TS and Foundry suites (E7).
- Compiler-generated ABI JSONs with a vitest + CI drift gate (E5).
- Tag-gated npm publish workflow with provenance (E6).
- Echidna properties contract + nightly job — a second independent fuzzer (E19).
- Fleet demo (`npm run fleet`): two agents sharing one key through the NonceGate (E20).

### Breaking — Contracts
- **Whitelist leaf format v2 (S1):** leaves now commit the calldata —
  `keccak256(abi.encode(target, selector, argsHash))` with `argsHash = keccak256(calldata)`;
  `argsHash == 0` is the wildcard (selector-wide) leaf. A pinned leaf authorizes exactly one
  calldata payload, closing the "whitelisted token selectors are uncapped" drain. Pre-mainnet
  root-format change by design; re-issue any granted roots.

### Added — Contracts
- `ActionLog7579Executor.sol` — ERC-7579 EXECUTOR (type 6) emitting `ActionLogged` at execution
  time, restoring the audit-trail guarantee on the Kernel/Safe{Core} path (A3); account-gated,
  value-forwarding, reentrancy-guarded, agentId attribution, derived ERC-7201 slot.
- `SessionKeyManager.withdraw` — owner-only treasury recovery, denylisted from session keys (S6).
- `SessionKeyReinstated` event — revocation reversal via re-grant is now observable (S5).
- Argument-bound whitelist enforcement in `_targetAllowed` / `_whitelisted` (S1).
- Batch per-action violations now revert `PerActionCapExceeded` instead of the misleading
  `MalformedExecutionData` (Q4); manager `_ecrecover` rejects malleable high-s signatures (S2).

### Changed — SDK (`@sigilkit/core`)
- `targetLeaf(target, selector, data?)` builds v2 leaves; `validateAgainstScope` mirrors the
  on-chain dual (pinned/wildcard) leaf check (S1).
- `NonceGate` + `SigilKitClient.nonceGate` — per-key execution serialization for fleets sharing
  a session key (P1).
- `prepareExecution` logs (instead of silently swallowing) `getWindowState` failures (Q1);
  local request-expiry check aligned to the contract's boundary semantics (Q5); redundant
  dynamic import and dead Merkle proof bookkeeping removed (Q2/Q3).

### Fixed — Toolchain & CI
- `@sigilkit/core` typecheck restored (wallet-e2e harness typechecks via its own tsconfig; the
  duplicate `metamask.test.ts` harness removed; `anvil_setCode` sent through a typed raw-RPC
  helper) (B1/T3).
- Foundry pinned to v1.7.1; `--invariant-runs` CLI flag (removed in forge 1.x) replaced by
  `[profile.ci.invariant]`; PR-gate fuzz split (2k) from nightly deep fuzz (10k) (A10/P3).
- Fork smoke now asserts Base-specific facts (chainid 8453, chain-bound domain separator, live
  Multicall3 state) and is excluded from non-fork runs (B4).
- CI: coverage gates (vitest v8 thresholds; forge lcov artifact), nightly deep-fuzz job, weekly
  live wallet-conformance job with pinned MetaMask download, monthly Foundry canary (A6/A7).
- vitest upgraded to 5.x — `npm audit` now reports 0 vulnerabilities (S7).

### Docs
- README verification counts reconciled; rolling-window claims corrected to the implemented
  tumbling window with a boundary-burst test pinning the semantics (S3/B3); SECURITY.md
  governance posture recorded (immutable-by-design pre-mainnet, Safe owner requirement, A2)
  and the nonexistent SDK allowance pre-check no longer implied (Q9).
- Deploy scripts: `SIGILKIT_OWNER_ADDRESS` (Safe) governance path and CREATE2 deterministic
  deployment via the canonical proxy (A2/T5).

### Verification
- **91 Foundry unit/fuzz tests across 10 suites**, plus **4 invariant suites** (handler-only
  fuzzing incl. admin transitions) and **1 Base fork smoke test**.
  `npm run check:docs` verifies this count against `forge test --list`.
- **Gas budgets (PERF-4)**: `contracts/test/GasBudget.t.sol` bounds the enforcement hot path
  (simple execute 112,805 · whitelisted 115,418 · native-value 139,385 gas) and
  `test_Gas_ValidateMaxBatch_WithinVerificationBudget` bounds worst-case ERC-4337 validation
  (8-tuple batch: 58,813 gas, against a 120k ceiling). `.gas-snapshot` is committed and
  drift is reported nightly.
- **11 Halmos symbolic specs**: 6 spend-cap/Merkle core + 5 auth-path (replay, nonce accounting,
  request expiry, denylist gating, window cap) over a recover-seam harness.
- **TypeScript**: `@sigilkit/core` 83 (+1 skipped), `@sigilkit/indexer` 12, `@sigilkit/mcp` 7 —
  incl. account-execute 7579 E2E, pinned-leaf, nonce-gate, token-path spender-semantics and
  simulate-once suites; core coverage floors: 88% lines / 74% branches.
- Echidna property fuzzing (4 properties) as an independent second fuzzer.

## [0.1.0] — 2026-08-23

Initial release of the session-key infrastructure for agent-native wallets.

### Added — Contracts (Solidity 0.8.36, Foundry)
- `SessionKeyManager.sol` — scoped agent session keys: EIP-712 signed `ActionRequest`s,
  per-key nonces, hard expiry, rotation with overlap, owner-only selector denylist,
  ERC-7201 namespaced storage, reentrancy guard.
- `SpendPolicy.sol` — per-action caps + rolling-window caps, checks-then-effects.
- `ActionLogger.sol` — mandatory `ActionLogged` audit event; no silent success path (INV-3).
- `MerkleWhitelist.sol` — sorted-pair target/selector whitelist verification.
- `SessionKey7579Module.sol` — ERC-7579 VALIDATION module for Kernel/Safe{Core} accounts:
  account-bound EIP-712 domains, batch-aware cap enforcement, signature-blob Merkle proofs,
  fail-closed batch+whitelist rule.
- `Deploy.s.sol` — broadcast deploy script.

### Added — TypeScript (`@sigilkit/core`)
- EIP-7022 primitives: `signAuthorization`, `signRevocation`, `validateAuthorization`
  with externally-verified RLP digests.
- EIP-712 signing + Merkle root/proof builders + zero-gas local policy pre-check
  (`validateAgainstScope`).
- `SigilKitClient.prepareExecution` → relayer-ready calldata; `assertAuditEmitted`.
- Conformance proven three ways: hand-rolled reference encoder = viem = ethers.

### Added — TypeScript (`@sigilkit/demo-agent`)
- `TreasuryAgent`: grant → strategy ticks → scoped sign → on-chain enforce → audit verify.
- `npm run demo` CLI running the whole stack live against Anvil.

### Verification
- 38 Foundry tests (unit + fuzz + handler-only invariant suites for INV-1/2/4).
- 6 Halmos symbolic specs over the spend-cap core and Merkle boundaries.
- Slither triaged in `SECURITY.md` (13 findings, all accepted-by-design; zero high).
- 17 TS tests incl. full on-chain E2E vs Anvil; wallet-behavior allowlist recorded.

### Infrastructure
- 6-job GitHub Actions CI (unit, invariant, Slither, TS, nightly Base-fork, Halmos release gate).
- Obsidian research vault (`vault/`) documenting the Aug-2026 worldwide research sweep,
  whitepaper corrections, competitive landscape, and build plan.
