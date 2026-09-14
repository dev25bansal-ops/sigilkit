# CI waivers — tracked, dated, removable

TD-6 (Issues-Catalog-2026-09-12): `continue-on-error: true` existed on three jobs with
no tracking issue and no removal criterion, so "temporarily non-blocking" risked becoming
permanently ignored. This register is the single source of truth for every active waiver.
Each entry names its removal criterion — a dated, checkable condition — and each entry is
deleted from this file the day the waiver is removed in `.github/workflows/ci.yml`.
The repo currently has no git remote, so GitHub issues are not yet available as a tracker;
this file is the equivalent and must be reviewed in every release checklist run.

| Job (ci.yml) | Waiver | Criterion to remove (must be met, in order) | Expiry hard stop |
|---|---|---|---|
| `wallet-e2e-weekly` | `continue-on-error: true` | The four scheduled runs of 2026-09-15, 2026-09-22, 2026-09-29 and 2026-10-06 were all green. Any red run is triaged and fixed **before the next run** — the waiver is not extended past a red run without a written postmortem here. | 2026-10-12 |
| `echidna-nightly` | `continue-on-error: true` | 14 consecutive green nightly runs (on or after 2026-09-26 if every run since 2026-09-12 passed). A red nightly is a real finding: triage, don't extend. | 2026-10-31 |
| `foundry-canary` | `continue-on-error: true` | Two consecutive green monthly runs (2026-10-01 and 2026-11-01). A red canary is upstream Foundry drift: pin or adapt in a follow-up PR, then clear the waiver. | 2026-11-30 |

## Rules

1. **No new waivers without a row here.** Adding `continue-on-error` to any job requires
   a new row with a dated criterion and a hard expiry, committed in the same change.
2. **Expiry is a deadline, not a suggestion.** On the expiry date the waiver is either
   removed or a written justification (with a new dated criterion) replaces the row.
3. **Red runs don't reset silently.** A failing run under waiver is recorded in the row's
   *history* column (append a dated note) and the criterion clock restarts from zero.
