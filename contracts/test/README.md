# `contracts/test/` — Foundry test tree

Solidity tests for `contracts/src/`. Run them with `forge test`. `npm test` is
`forge test --no-match-contract ".*Invariant|.*Fork"` followed by the workspace suites — it is
the FULL forge suite minus contracts whose NAME matches that pattern, not a "PR-scoped subset".

**"Excluded" means "not in the default step", not "never runs".** CI runs both excluded groups
in dedicated steps (`.github/workflows/ci.yml`: `forge test --match-contract '.*Invariant'`,
and `forge test --fork-url "$RPC_BASE" --match-contract '.*Fork'`), so a green `npm test` is
not evidence that the invariant and fork suites passed — check those steps too.

Two more files in this tree are compiled by forge but contribute no `test_` function, so
`forge test` executes nothing from them: `Halmos.t.sol` / `HalmosAuth.t.sol` (the `check_`
specs run under the `halmos` CI job) and `EchidnaProperties.t.sol` (the `echidna_*` properties
run under the advisory, waived `echidna-nightly` job). For those files the COMPILER is the only
thing standing between a drifted harness and a silently weakened check.

## Declaring ownership

**If you add a file here, name yourself and what it covers in a comment at the top of the file,
in the same change that adds it.** That is the entire mechanism — there is no `OWNERS.json`,
and adding one would just be another hand-maintained registry to drift out of date.

If you are running the suite and hit a compile error in a file you did not write:

- **It is probably still being written.** A half-written test file legitimately does not
  compile, and a missing helper contract in it is the expected state of work in progress.
- **Ask before you edit.** Supplying the missing definition yourself will usually conflict with
  what the author is about to write, and completing a stub freezes their intermediate state
  into the implementation. One message is cheaper than the conflict.
- **Do not read a green `forge build` as "the tests are fine."** The build does not always
  compile the test tree the way the test runner does — that gap has produced more than one
  false "everything is fine" signal in this repo's history.

## Layout

| Group | What lives there |
|---|---|
| `SessionKeyManager*.t.sol` | core session-key scoping, windows, revocation, governance |
| `*7579*.t.sol`, `ActionLog7579Executor.t.sol` | the ERC-7579 validation module and its executor |
| `Halmos*.t.sol` | symbolic-verification specs (`check_` functions) — see below |
| `EchidnaProperties.t.sol` | Echidna properties + handlers |
| `GoldenVectors.t.sol` | byte-for-byte encoder parity against canonical fixtures |
| `Gas*.t.sol` | gas ceilings and uncovered-path accounting |
| `ForkSmoke.t.sol` | Base fork smoke test; skips itself when no fork RPC is configured |
| `*Coverage.t.sol`, `*Read.t.sol` | targeted coverage for a single SEC/E11 finding |

## Two things that will bite you

**Halmos specs (`check_`) must be pinned to the production call arity.** A spec that encodes an
`executeWithSessionKey` call with the wrong number of arguments produces calldata whose decoder
reverts on a bounds check — which makes every downstream assertion pass on the trivial false
branch. `HalmosAuth.t.sol` has a meta-test (`test_HalmosAuth_ArityIsFour`) whose only job is to
fail if that arity ever drifts. Run it whenever you touch the harness.

**An assertion that cannot fail is worse than no assertion.** When you close a finding of the
shape "this property is vacuous", prove the fix: break the logic on purpose (e.g. add `&& false`)
and confirm the suite goes **red with a counterexample**, then restore it and confirm green. A
property that has only ever been green has not been tested.

The full rules live in [`CONTRIBUTING.md`](../../CONTRIBUTING.md) under **Tests**.
