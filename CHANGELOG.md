# Changelog

All notable changes to SigilKit are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows semver.

## [Unreleased] — 2026-09-11

Remediation of the 2026-09-11 issues catalog (`docs/Issues-Catalog-2026-09-11.md`): 23 of 24
catalog issues closed in code; the remaining item (A1: creating the public GitHub repository
and first CI run) is a single publish action.

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
- 55 Foundry tests: 54 unit/fuzz + 4 invariant suites (now fuzzing admin transitions) + 1
  Base fork smoke.
- 11 Halmos symbolic specs: 6 spend-cap/Merkle core + 5 auth-path (replay, nonce accounting,
  request expiry, denylist gating, window cap) over a recover-seam harness.
- 43 TS tests (incl. account-execute 7579 E2E on the contract side, pinned-leaf and nonce-gate
  suites); coverage floors: 88% lines / 74% branches.

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
