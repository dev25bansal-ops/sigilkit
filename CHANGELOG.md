# Changelog

All notable changes to SigilKit are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows semver.

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
