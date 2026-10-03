# CI waivers — tracked, dated, removable

TD-6 (Issues-Catalog-2026-09-12): `continue-on-error: true` existed on three jobs with
no tracking issue and no removal criterion, so "temporarily non-blocking" risked becoming
permanently ignored. This register is the single source of truth for every active waiver.
Each entry names its removal criterion — a dated, checkable condition — and each entry is
deleted from this file the day the waiver is removed in `.github/workflows/ci.yml`.
A git remote **is** configured. `.git/config` declares `[remote "origin"]` with
`url = https://github.com/dev25bansal-ops/sigilkit.git` (read directly on 2026-10-01).
The previous wording here — "The repo currently has no git remote" — was false and has been
corrected against that file. Whether GitHub issues are actually enabled as a tracker was
not re-checked, so treat tracker availability as open:
this file is the register of record either way and must be reviewed in every release
checklist run.

| Job (ci.yml) | Waiver | Criterion to remove (must be met, in order) | Expiry hard stop |
|---|---|---|---|
| `wallet-e2e-weekly` | `continue-on-error: true` | The four scheduled runs of 2026-09-14, 2026-09-21, 2026-09-28 and 2026-10-05 were all green. Any red run is triaged and fixed **before the next run** — the waiver is not extended past a red run without a written postmortem here. | 2026-10-12 |
| `foundry-canary` | `continue-on-error: true` | Two consecutive green monthly runs (2026-10-01 and 2026-11-01). A red canary is upstream Foundry drift: pin or adapt in a follow-up PR, then clear the waiver. | 2026-11-30 |

## Rules

1. **No new waivers without a row here.** Adding `continue-on-error` to any job requires
   a new row with a dated criterion and a hard expiry, committed in the same change.
2. **Expiry is a deadline, not a suggestion.** On the expiry date the waiver is either
   removed or a written justification (with a new dated criterion) replaces the row.
3. **Red runs don't reset silently.** A failing run under waiver is recorded in the row's
   *history* column (append a dated note) and the criterion clock restarts from zero.

## How this register is enforced

`scripts/check-waivers.mjs` runs in the `workflow-lint` job of `ci.yml`, so a violation
fails the PR. It cross-checks every job-level `continue-on-error: true` in
`.github/workflows/*.y(a)ml` against the table above, in both directions:

- a waiver in YAML with no row here fails the build (rule #1);
- an expired `Expiry hard stop` while the waiver is still in YAML fails the build (rule
  #2) — either remove the waiver or replace the row with a written justification, a new
  dated criterion and a new Expiry;
- a row whose waiver has been removed warns (and fails under `--strict`), because the
  register is supposed to be deleted the day the waiver is;
- a row with no readable `YYYY-MM-DD` expiry, or with an empty criterion, fails — an
  undated waiver is the permanent one TD-6 was about.

Run it locally with `node scripts/check-waivers.mjs`, or `node scripts/check-waivers.mjs
--today=2026-10-12` to rehearse an expiry date before it lands. The table's shape is part
of the contract: a header row with a **Job**, a **Waiver** and an **Expiry** column, one
row per waiver, job name in backticks, and a `YYYY-MM-DD` date in the Expiry cell. The
static-analysis triage table further down has a different shape and is deliberately not
read by this check.

## Non-CI-job waivers — deliberate standing test failures

The table above is the *machine-checked* register, and `check-waivers.mjs` only reads a table
whose header has a **Job**, a **Waiver** and an **Expiry** column. The table below therefore
has a different shape and is **deliberately not read by that script** — it is the human
register, and it exists so that a red test which is *intentional* is never mistaken for an
unknown regression by the next person who reads a CI log.

Rule for this table: **a row here is a promise that a specific test is red on purpose.** The
redness is the evidence. Do not "fix" the test, and do not delete the row while the test is
still red — the row and the redness are the same artifact, and removing either one alone
destroys the signal.

This table is enforced by `scripts/check-test-waivers.mjs` (run in the `workflow-lint` job):
a row whose test has gone green fails the build, and a row still red **after its Expiry hard
stop** fails the build too — rule #2 applies to this table exactly as it does to the job
table, with the same remedy (a written justification plus a new dated criterion, or closure).

> **⚠️ The table below is currently EMPTY — there are no deliberate standing test failures.**
> It has held exactly one row in its history, closed on 2026-09-28; that row is preserved
> immediately below as a record. An empty table is the healthy state, not a gap to fill.

| Item (not a CI job) | Waiver | Criterion to remove (must be met, in order) | Expiry hard stop |
|---|---|---|---|
| _(empty — see the note above)_ | — | — | — |

### Closed entry — `test_Sec10_LineageWindowCap` (SEC-10, closed 2026-09-28)

The row this table now lacks is preserved here as a record, per the L2 append-only convention.

**What the row used to say.** It registered `test_Sec10_LineageWindowCap`
(`contracts/test/Sec10WindowRotation.t.sol`) as an *intentionally failing* assertion, with the
removal criterion: adopt **Option A** (carry `windows[oldKey]` into `windows[newKey]` in
`_grant`) and re-point the five `test_Characterization_*` tests at the carry-over behaviour —
or, under **Option B**, "delete this test *and* delete the five characterization tests,
because under Option B there is no invariant to fail."

**Why the row was closed instead of actioned.** The Option B branch of that criterion named an
action that would have destroyed the evidence the closure depends on. Deleting those six tests
would have made Option B's semantics permanently unverifiable — the tests *are* the proof that
SEC-10 is resolved, not scaffolding to be cleared away. So the row was removed and the tests
were kept. Recorded here so the next reader does not re-run that reasoning and "tidy up" the
file.

**Resolution: Option B, implemented and verified.** `SessionKeyManager._grant`
(`contracts/src/SessionKeyManager.sol:412-453`) never writes `windows`, so a rotation opens a
fresh window on the new key while a re-grant over the *same* key preserves its charged window.
That is the owner-ruled Option B semantics, documented in `SpendPolicy`'s NatSpec ("INV-1
scope" clause). The test asserts exactly this shape — `spentThisWindow == 0` after a rotation,
`== 2 ether` after a re-grant — plus the security boundary that makes it safe (both
`grantSessionKey` and `rotateSessionKey` are `onlyOwner`, so an agent cannot rotate itself into
a fresh budget). **Code and test agree.**

**Measured 2026-09-28** (ck-arch, `forge 1.7.1`, run from the **repo root** — `foundry.toml`
lives there, not in `contracts/`):

```
$ forge test --match-path "contracts/test/Sec10WindowRotation.t.sol" -vv
Ran 6 tests for contracts/test/Sec10WindowRotation.t.sol:Sec10WindowRotationTest
[PASS] test_Characterization_ReGrantSameKeyPreservesTheWindow() (gas: 343205)
[PASS] test_Characterization_RotateCycleRepeatsUnboundedly() (gas: 1321423)
[PASS] test_Characterization_RotateDoesNotCarryTheWindowOver() (gas: 396450)
[PASS] test_Characterization_RotateHandsNewKeyAFullWindow() (gas: 562924)
[PASS] test_Characterization_RotateVersusReGrantAreAsymmetric() (gas: 489990)
[PASS] test_Sec10_LineageWindowCap() (gas: 598306)
Suite result: ok. 6 passed; 0 failed; 0 skipped
```

The prior "intentionally failing" claim was never re-executed before it was written down; it was
inherited from an intermediate revision in which Option A had been implemented and then
reverted. A full-suite run on the same day passed 224/225 (1 skipped, 0 failed).

**Residual, deliberately not waived.** Option B re-classifies SEC-10 from an agent-reachable
bypass to an **owner-side configuration** property: `perWindowCap` bounds a *single key's* rate,
not the owner's rotation cadence. An owner rotating faster than `windowSeconds` authorises a
higher aggregate rate than the cap suggests. This is a documented operating constraint, not a
code defect, and it is stated in `SpendPolicy`'s NatSpec rather than tracked here.

### Why intentional test failures are not in the machine-checked table

`check-waivers.mjs` joins register rows to job-level `continue-on-error: true` in
`.github/workflows/*.y(a)ml`. A failing Solidity test is not a `continue-on-error` job, so a
row for it in the machine-checked table would be reported as a **stale** row (rule #2's
inverse) and would turn the `workflow-lint` job red for no reason. Keeping the two registers
in separate tables preserves both properties: the machine check stays strict about CI jobs,
and the intentional test failure stays visible to humans.

`SEC-10` itself (Medium, CVSS 4.9) is tracked in `docs/ISSUES-CATALOG-2026-09-25.md`. This
row exists only to govern **this repository's handling of it**, not to track the defect.

## Static-analysis triage — slither 0.11.6, run 2026-09-23

Scope: `contracts/` (73 contracts, 30 detectors, 2,315 findings; 1,082 are assembly-in-test noise). **Zero High/Medium findings on `contracts/src/`.** 53 unique source findings across 9 detectors, triaged below. Evidence: `outputs/slither-20260923.json` + `outputs/slither-20260923.log` + `outputs/slither-triage-summary.json`.

> **Audit note (2026-10-01, documentation-truthfulness pass):** the three evidence files cited
> in the line above — `outputs/slither-20260923.json`, `outputs/slither-20260923.log` and
> `outputs/slither-triage-summary.json` — are **not present in the current tree** (a path stat
> returned ENOENT for all three on 2026-10-01). They are no longer citable as-is: either re-run
> Slither and commit the outputs, or regenerate this section from a fresh run.
> **Unverified as of 2026-10-01:** the "73 contracts / 30 detectors / 2,315 findings / 1,082
> assembly-in-test noise" figures, the "Zero High/Medium findings on `contracts/src/`" claim, and
> the "9 detectors" count were **not** re-measured in this pass and must not be cited without
> re-running the scan. The `Src uniq` column of the table below does sum to 53
> (2+7+13+10+10+7+4), so "53 unique source findings" is internally consistent with the table;
> note that the table names 8 detectors across 7 rows, which does not match "9 detectors" — that
> mismatch is flagged here rather than silently corrected, because the true value cannot be
> re-measured without a Slither run.
| Detector | Impact | Src uniq | Disposition | Reason | Criterion to remove | Expiry |
|---|---|---|---|---|---|---|
| `calls-loop` | Low | 2 | Accept + waiver | `_erc20BalanceOf` (SessionKeyManager.sol:575) is a view-only staticcall inside the opt-in watchlist loop; list is owner-curated and bounded (bound work scheduled as W2-3.1). | Re-verify at audit-prep (W4-1.1); upgrade to fix if the watchlist becomes unbounded or permissionless. | 2026-10-22 |
| `reentrancy-events` | Low | 7 | Accept + waiver | `withdraw` (onlyOwner, no pre-call state writes) and `ActionLog7579Executor.execute` (CEI with revert-gated lock; audit emitter is trusted fixed code). Flag for auditor: `_logAction` runs after the lock is released — no attacker-controlled path exists between, but the auditor should confirm the ordering argument. | Auditor sign-off in W4-1.1. | 2026-10-22 |
| `timestamp` | Low | 13 | Accept + waiver | Grant/expiry comparisons use strict `>` semantics pinned by tests (off-by-one alignment deliberately aligned to the contract); bounded miner-skew is acceptable for session windows. | Re-verify at W4-1.1 against the final session-window spec. | 2026-10-22 |
| `assembly` | Informational | 10 | Accept | ERC-7201 namespaced storage getters (`_m`/`_s`/`_manager`) and the `ecrecover` path — standard, deliberate patterns. | W4-1.1 spot-check. | 2026-10-22 |
| `low-level-calls` | Informational | 10 | Accept | ERC-20 `balanceOf`, ERC-1271 `isValidSignature`, and guarded execute/withdraw calls — every result `ok`-checked; zero-target guards already present (AC-dde82058). | W4-1.1 spot-check. | 2026-10-22 |
| `pragma` | Informational | 7 | Accept | Solidity pinned to 0.8.36 for reproducible builds. | None (style). | — |
| `naming-convention` / `cyclomatic-complexity` | Informational | 4 | Accept | `TYPEHASH`/`DOMAIN_SEPARATOR` naming and one complex function — style only. | None (style). | — |

High/Medium detections (`incorrect-exp/shift`, `shadowing-state`, `locked-ether`, `incorrect-equality`, `reentrancy-no-eth`, `unused-return` High/Med buckets) all land in `contracts/test/` or `lib/forge-std` — test-harness code, out of scope for this register.
