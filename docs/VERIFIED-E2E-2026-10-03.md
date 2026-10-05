# End-to-end verification — 2026-10-03 (Ralph-loop iteration 1)

Snapshot of a full local E2E test run across the repo's test surface: on-chain Solidity (Foundry), off-chain TypeScript (vitest across all four packages), and the Node gate scripts. All commands run from `/mnt/d/SigilKit` on WSL2 with the **CI-pinned toolchain**; results are version-sensitive as documented below.

## Toolchain

```text
Foundry 1.7.1   (CI pin per SECURITY.md:201; pinned deliberately — see "Toolchain version sensitivity" below)
Node 24.12.0    (Windows native, meets the >=24 requirement; WSL2 default node was 18.19.1, does not meet engines and was not used for TS tests)
```

## On-chain (Solidity) — Foundry 225 tests

**Command:**

```bash
export PATH="/home/dev/.foundry/bin:$PATH"
cd /mnt/d/SigilKit
forge test --no-match-contract ".*Invariant|.*Fork"
```

**Summary:**

```text
Ran 18 test suites in 50.81ms (211.66ms CPU time):
  225 tests passed, 0 failed, 0 skipped (225 total tests)
```

All 225 pass. Excluded by design: the stateful invariant fuzz suite (4 invariants) and the live fork smoke (1 test), both gated separately in CI (`forge-invariant`, `forge-fork-base`).

## Off-chain (TypeScript) — 951 tests

**Commands:**

```bash
# Windows native node (>=24 required for node:sqlite)
npm run build --workspaces --if-present
npm run test --workspaces --if-present
```

**Summary:**

```text
@sigilkit/core          31 files, 573 tests   ✓
@sigilkit/indexer        8 files, 162 tests   ✓  (node:sqlite experimental feature warning logged, expected)
@sigilkit/mcp            5 files, 131 tests   ✓
@sigilkit/demo-agent     8 files,  85 tests   ✓
───────────────────────────────────────────────
                        52 files, 951 tests   ✓
```

## Node gate scripts (the CI's own meta-gates)

All pure-Node scripts from `scripts/`, run against the current tree:

```bash
node scripts/check-doc-location.mjs       # exit 0: 53 tracked docs/, 35 outside, all approved
node scripts/check-waivers.mjs            # exit 0: 2 waivers, both dated, both registered
node scripts/check-doc-counts.mjs         # exit 0: README/whitepaper/STATUS/SECURITY/TROUBLESHOOTING match the toolchain
node scripts/check-doc-location.test.mjs  # exit 0: all 25 internal cases behaved as specified
```

The doc-counts checker independently re-measures the toolchain (forge test list, CI job count, Halmos spec count, vault note count, forge-lint annotations) and reconciles them against the prose in README/whitepaper/STATUS/SECURITY — so the **951 TypeScript + 225 Foundry** and the **22 vault notes** are machine-verified facts, not quoted numbers.

## Build

All four packages compile cleanly under TypeScript 7.0.2 targeting Node 24:

```bash
npm run build --workspaces --if-present  # exit 0
```

## Toolchain version sensitivity (a production finding)

This run also surfaced a useful, **non-obvious** fact: the same `forge test` invocation on Foundry **1.8.4** fails 12 of the 225 tests — all in the `GasBudget.t.sol` / `Gas7579Scaling.t.sol` / `GasUncoveredPaths.t.sol` suites. Every failure is a "gas used ≥ budget" assertion; the **same** tests all pass on the **pinned 1.7.1**.

**What this tells us:**

- **The CI pin is load-bearing, not decorative.** `SECURITY.md:201-202` declares Foundry pinned in the workflow; this measurement confirms why. A naive dependency bump to 1.8.4 would silently turn those 12 green budget-guards red.
- **The failure mode is gas-model drift, not logic.** The opcodes themselves are unchanged (the contract compiles identically); the *cost attribution* shifts between versions, enough to cross the thresholds the tests assert.
- **Correct practice for a bump:** re-baseline the budget constants for the new toolchain (or gate the gas assertions to `vm.snapshot`/`vm.startSnapshot`, not raw `gasleft()`, if that proves robust), and only then relax the pin.

**Implication for this document:** every number above (225 passed / 951 passed / all gates OK) is true **on the pinned toolchain**, which is the one CI uses and the one a fresh contributor with `foundryup --install v1.7.1` will land on. It is *not* claimed to hold on every Foundry version.

## What is deliberately *not* in this snapshot

1. **Halmos (symbolic execution).** 11 specs (6 spend-cap/Merkle core, 5 auth-path) are in the CI's `halmos` job. This E2E snapshot does not re-run them locally (no Halmos binary installed here; they are a separate nightly-style gate). The `check-doc-counts` gate independently reconciles the spec **count** (11) against `contracts/test/Halmos*.t.sol`.
2. **Echidna (property fuzz).** 4 properties in `EchidnaProperties.t.sol`, run nightly (`echidna-nightly`). Same reasoning — counted, not re-executed.
3. **Slither.** The `slither` gate runs the static analyzer; the triage lives in `docs/CI-WAIVERS.md` and is reconciled against `docs/NUMBERS-2026-09-26.md`. Not re-run in this snapshot.
4. **Wallet E2E (browser conformance).** The MetaMask/Coinbase canary requires a persistent Chromium with a real extension profile; CI runs it under `wallet-e2e-weekly` (`continue-on-error: true`, per `docs/CI-WAIVERS.md` — see TD-6). Out of scope for a local headless run.
5. **Invariant fuzz + fork smoke.** 4 invariants, 1 fork test, excluded above by `--no-match-contract` (same as the CI `forge-unit` job).

The items **not** run here are still machine-verified for count/consistency by `check-doc-counts`, so this document is not claiming they are unverified — only that they are not re-executed in *this* snapshot.

## What this snapshot establishes

- Every functional assertion the on-chain suite makes is currently satisfied, on the toolchain the project ships against.
- Every functional assertion the 4-package TS SDK makes is currently satisfied.
- Every meta-gate the CI enforces (doc counts, doc locations, waiver expiry) currently passes.
- The project **builds** end-to-end and **ships** a coherent `dist/` for all four packages.

## Honest limits

- This is a point-in-time read on a working tree that already carries 25+ other docs describing itself; it does not supersede `docs/STATUS.md` for authority, only adds a dated verification record.
- It does not constitute an external security audit. The pre-audit banner (`docs/WHITEPAPER-v2.1.md`, `SECURITY.md`, `docs/COMPLIANCE-2026-09-26.md` §7) still binds. A green test suite is evidence the project is **test-ready**, not **audit-clean**.
