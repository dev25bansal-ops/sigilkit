# AC-01 Scrub Plan — plaintext keys in git history (PLAN, unexecuted)

**Status:** plan only. **Nothing here has been run.** Execution requires dev25's
explicit approval AND the pre-push security gate — history rewriting is a
destructive, whole-repository operation.

> ## 🔴 STATUS CORRECTION (2026-09-28, dc-sec2) — THE PLAN'S PREMISE IS FALSIFIED
>
> **Do not execute the history-rewrite steps below. They address a problem that
> does not exist.** The plan is retained verbatim below as the historical record.
>
> **What the plan assumed:** `.codebuddy/models.json` was committed carrying 6
> plaintext `apiKey` fields and the AC-05 RPC token "appears in history" —
> so a `git-filter-repo` rewrite was needed to purge them.
>
> **What was actually established** (`docs/SECURITY-AUDIT-2026-09-26.md:33`,
> verified by `git log -S`, `rev-list --objects` + per-blob scan, and
> `fsck --lost-found`, per that document's §"Method" line 4): the git history
> contains **ZERO** keys — *"Keys found in git history | **0** | AC-01's core
> premise is false — P0-3"*.
>
> **The real, unaddressed exposure** (same source, `:176`): the 6 keys are
> **live on disk** in a tree destined to go public. That is a working-tree /
> secret-management problem, and it is fixed by **rotation + removing the file
> from the tree**, not by rewriting commits that contain nothing.
>
> **Consequence if left uncorrected:** a reader executes Step 0–1, runs
> `gitleaks` over history, finds nothing, and either concludes the keys are
> safe (they are not — they are on disk) or spends the remaining effort on a
> destructive whole-repository rewrite with nothing to remove. Both outcomes
> leave the actual exposure untouched.
>
> **What should happen instead** (out of scope for this plan; needs an owner
> decision): confirm the 6 `.codebuddy` keys and the AC-05 RPC token are
> **ROTATED at their providers**, and confirm `.codebuddy/models.json` is
> gitignored and untracked. `docs/ISSUES-CATALOG-2026-09-25.md` SEC-02 tracks
> the on-disk exposure.
>
> **Steps 0, 1 and the `git-filter-repo`/`bfg` rewrite in Steps 2+ are hereby
> marked NOT APPLICABLE.** The rotation prerequisite recorded in the original
> text is retained and remains the correct advice for the real exposure — it
> simply applies to keys on disk, not keys in history.

## Why  *(original text, retained verbatim — premise since falsified, see correction above)*

AC-01/SK-01: `.codebuddy/models.json` was committed carrying 6 plaintext `apiKey`
fields, and the AC-05 RPC token appears in history. Gitignoring the file stops
future commits; it does nothing about the past. Any remote clone of the repo
(including the existing `dev25bansal-ops/sigilkit` on GitHub) retains those keys
in every historical commit. **Agreed prerequisite:** W1-1.1/W1-5.3 — the
exposed keys must be ROTATED at their providers before or on the same day as the
scrub; rewriting history cannot un-leak a key an attacker already harvested.

## Step 0 — inventory (read-only, can be done any time)

1. Run the repo's own scanner over full history and capture the finding list:
   `gitleaks detect --config .gitleaks.toml --redact --no-banner --report-path outputs/gitleaks-history.json`
   (path may differ by gitleaks version; use `--report-format json --report-path`).
2. Cross-check against the known set: the 6 `.codebuddy` keys + AC-05 token.
   Any finding NOT in the known set is triaged separately first (it was never
   reviewed).
3. Confirm every inventoried key has been rotated (the old values 401 in the
   provider consoles) before proceeding.

## Step 1 — tool + branch safety

- Tool: `git-filter-repo` (preferred) or `bfg`. Both rewrite commit SHAs for
  everyone who has ever cloned; **no unrewritten clone may ever push again**.
- Local: tag the pre-scrub tip (`git tag pre-scrub-<date> <sha>`) and record the
  full ref list (`git show-ref`) so nothing is lost.
- Any clone/backup other than the one machine (GitHub remote included) must be
  deleted and re-cloned after the push, or it will resurrect the old history on
  its next push.

## Step 2 — rewrite

```
git filter-repo --invert-paths --path .codebuddy/models.json
git filter-repo --replace-text <(printf 'RPC-TOKEN-OLD-VALUE==>REDACTED\n')
```
(exact replacement list = the Step 0 inventory; no other paths are touched).
Never run both commands back-to-back without re-verifying the tree between them.

## Step 3 — verify the rewrite (claim-rigor: nothing counts as done without this)

1. `gitleaks detect --config .gitleaks.toml --redact --no-banner` over the NEW
   history → zero findings in the inventoried set.
2. `npm run verify` on the rewritten tree → 9/9 (only commit metadata changes;
   content must be identical).
3. `git log --oneline` sanity + `git fsck` cleanliness.

## Step 4 — republish (external shared state, requires explicit approval per push)

1. `git push origin --force --all` + `--tags` against `dev25bansal-ops/sigilkit`
   (includes `master` and `review-integration-20260917`) — never default-branch
   force-push without telling anyone else who may have clones; this is a solo
   repo today, but say it anyway.
2. GitHub-side: old commits remain reachable via dangling PRs/issues until GC;
   open a support ticket or wait the automatic GC window, then re-check the
   known SHA is gone from the web UI.

## Rollback

The `pre-scrub-<date>` tag + `git reflog` are the rollback path until the forced
push; after the push, rollback requires the same force-push. Back up
`.git/` wholesale before Step 2 (a plain copy, excluded from the repo itself).

## Open questions for [D] at execution time

- Scrub only `models.json` or every inventoried secret in one pass?
- Re-run repo creation as a fresh public history (lose all stars/PRs — none
  exist) vs force-push over the existing remote history?