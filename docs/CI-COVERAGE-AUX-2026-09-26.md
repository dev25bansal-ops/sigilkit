# CI coverage — auxiliary packages (`indexer` / `mcp` / `demo-agent`)

**Date:** 2026-09-26
**Scope:** `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, and the CI wiring of
`packages/indexer`, `packages/mcp`, `packages/demo-agent`.
**Method:** read-only. No workflow, package, script or other `docs/` file was modified.
**Repo state:** commit `ce8eea2`, worktree dirty (other tracks in flight).

---

## 1. Job inventory

### 1.1 `ci.yml` — 12 jobs

| # | job id | display name | trigger | key commands | timeout | `needs` |
|---|---|---|---|---|---|---|
| 0 | `workflow-lint` | Workflow lint (actionlint) | push main/master, PR, all 3 crons, dispatch | `validate-workflows.mjs`; `check-waivers.test.mjs`; `check-waivers.mjs`; `check-dockerfile.{test.,}mjs`; `check-doc-counts.{test.,}mjs`; `verify.test.mjs`; `check-package-artifacts.test.mjs`; `check-runtime.test.mjs`; `assurance-inventory.test.mjs`; `benchmark-indexer.test.mjs`; `install-actionlint.sh`; `actionlint -color` | **none** (360 min default) | — |
| 1 | `forge-unit` | Forge unit + fuzz | push, PR, schedule, dispatch | `forge build --sizes`; `forge test --no-match-contract '.*Invariant\|.*Fork'` | **none** | — |
| 2 | `forge-invariant` | Forge invariant (INV-1..4) | push, PR, schedule, dispatch | `forge test --match-contract '.*Invariant'` | **none** | — |
| 3 | `slither` | Slither static analysis | push, PR, schedule, dispatch | `pip install slither-analyzer==0.11.6`; `slither contracts/src --fail-high` | **none** | — |
| 3b | `secret-scan` | Secret scanning (gitleaks) | push, PR, schedule, dispatch | `install-gitleaks.sh`; `gitleaks detect` (full history) | **none** | — |
| 4 | `ts-sdk` | TS SDK conformance (Anvil) | push, PR, schedule, dispatch | `npm ci`; `npm run build --workspaces`; `vectors:generate` + `git diff`; `check-vectors.mjs`; `check-package-artifacts.mjs`; `npm run lint --workspaces`; `npm test --workspaces --if-present`; 4x `npm run test:coverage --workspace ...`; `npm pack --dry-run` x3; `forge inspect` ABI regen; `git diff packages/core/abis` | **none** | — |
| 5 | `forge-deep-fuzz` | Forge deep fuzz + coverage (nightly) | cron `17 3 * * *`, dispatch | `forge test --match-contract '.*Invariant'`; `forge coverage`; `forge snapshot` drift report | **none** | — |
| 6 | `forge-fork-base` | Base fork tests (nightly) | cron `17 3 * * *`, dispatch | `forge test --fork-url $RPC_BASE --match-contract '.*Fork'` | **none** | — |
| 7 | `halmos` | Halmos symbolic verification | push main/master, dispatch | `pip install halmos==0.3.3`; `halmos --match-contract Halmos` | **none** | — |
| 8 | `wallet-e2e-weekly` | Wallet conformance (weekly) | cron `23 4 * * 1`, dispatch | `npx tsx test/wallet-e2e/run-all.ts` (wd `packages/core`) | **none** | — |
| 9b | `echidna-nightly` | Echidna property fuzzing (nightly) | cron `17 3 * * *`, dispatch | `crytic/echidna-action` | **none** | — |
| 9 | `foundry-canary` | Foundry nightly canary (monthly) | cron `43 4 1 * *`, dispatch | `forge build`; invariant + unit suites on `nightly` | **none** | — |

**No job in `ci.yml` declares `needs`.** All 12 are mutually independent — including
`ts-sdk`, which is the only job that exercises the three auxiliary packages.

**Waived jobs** (`continue-on-error: true`, all registered in `docs/CI-WAIVERS.md` and
verified unexpired as of 2026-09-26 by `node scripts/check-waivers.mjs` -> *"3 waiver(s) in
2 workflow file(s) ... all registered"*): `wallet-e2e-weekly` (expiry 2026-10-12),
`echidna-nightly` (2026-10-31), `foundry-canary` (2026-11-30).

### 1.2 `publish.yml` — 2 jobs

| # | job id | display name | trigger | key commands | timeout | `needs` |
|---|---|---|---|---|---|---|
| 1 | `assurance` | Required assurance for publishing commit | `push` tags `v*` | release-identity check; `npm ci`; **`npm run verify`**; `forge test` (deep profile); Slither; Halmos; gitleaks; **`npm run test:coverage --workspaces`**; ABI drift; `check-doc-counts.mjs --with-ts`; `npm pack --dry-run` x3; emit `sha` output | **none** | — |
| 2 | `publish` | Publish assured commit | `push` tags `v*` | sha re-verification; `npm ci`; `npm run build --workspaces --if-present`; npm scope-ownership preflight; **`npm publish --provenance --access public`** x3 | **none** | `assurance` (gated on `result == 'success'` **and** `outputs.sha == github.sha`) |

`publish` additionally carries `environment: npm` and job-scoped
`permissions: {contents: read, id-token: write}`.

---

## 2. CI coverage matrix

Legend: OK = covered · PARTIAL = weakened · **GAP** · n/a by design

| check | indexer | mcp | demo-agent |
|---|---|---|---|
| Unit tests | OK `npm test --workspaces --if-present` (`ci.yml:198`) + `test:coverage --workspace @sigilkit/indexer` (`ci.yml:204`) | OK `ci.yml:198` + `ci.yml:205` | OK `ci.yml:198` + `ci.yml:206` |
| TypeScript typecheck | OK `npm run lint --workspaces` (`ci.yml:197`) -> `tsc --noEmit` (`indexer/package.json:27`) | OK `ci.yml:197` -> `tsc --noEmit` (`mcp/package.json:25`) | OK `ci.yml:197` -> `tsc --noEmit` over `src` **+ `test`** (`demo-agent/package.json:27`, `tsconfig.json:19-22`) |
| Build | OK `npm run build --workspaces` (`ci.yml:165`) -> `tsc -p tsconfig.json` | OK `ci.yml:165` -> `tsc -p tsconfig.json` | OK `ci.yml:165` -> `tsc -p tsconfig.build.json` |
| **Artifact loadability** | PARTIAL static entry-point check + `npm pack --dry-run` only | OK static + `npm pack --dry-run` + **real `spawn()` of `dist/cli.js`** (`mcp/test/mcp.test.ts:108-112`) | **GAP — never checked** |
| Lint | PARTIAL `tsc --noEmit` only — **no ESLint/Stylelint exists anywhere in the repo** | PARTIAL same | PARTIAL same |
| End-to-end | PARTIAL `test/cli.e2e.test.ts` spawns `node --import tsx src/cli.ts` against an in-process stub RPC (`cli.e2e.test.ts:93`) | OK `test/mcp.test.ts:107-128` — spawned stdio process over the real built `dist/cli.js` | PARTIAL **silently self-skips** (`smoke.e2e.test.ts:55-65, 72-76`) |
| Coverage collection | OK thresholds 70/70/70/65 (`indexer/vitest.config.ts:10-17`); artifact uploaded (`ci.yml:207-213`) | OK 70/65/70/50 (`mcp/vitest.config.ts:10-17`) | OK 90/90/95/60 (`demo-agent/vitest.config.ts:14-21`) |
| Publish to npm | OK `publish.yml:177` loop | OK `publish.yml:177` loop | n/a — `"private": true` (`demo-agent/package.json:48`) |

> **Unverified as of 2026-10-01 (documentation-truthfulness pass):** every percentage in the
> "Coverage collection" row — indexer **70/70/70/65**, mcp **70/65/70/50**, demo-agent
> **90/90/95/60** — is **not re-measured** in this pass. Each is a Vitest coverage threshold, and
> the four numbers per cell map to statements / branches / functions / lines. Reproducing them
> requires reading and re-running coverage; this audit slice can edit only `docs/`, so the cited
> sources (`packages/indexer/vitest.config.ts:10-17`, `packages/mcp/vitest.config.ts:10-17`,
> `packages/demo-agent/vitest.config.ts:14-21`) could not be treated as certified evidence here.
> The cells are **left in place but no longer established fact**. **Do not cite any of these
> twelve numbers without re-reading the three `vitest.config.ts` files and re-running
> `npm run test:coverage --workspaces`.**
> Note also that a passing coverage *threshold* says nothing about whether a workspace's suite
> is non-vacuous; that question is tracked separately in
> `docs/VERIFICATION-STRATEGY-2-CI-UAT.md`.

### 2.1 Gap 1 — `demo-agent` artifact loadability is never verified (highest-value aux gap)

`scripts/check-package-artifacts.mjs` short-circuits on private packages:

```165:167:scripts/check-package-artifacts.mjs
  if (manifest?.private === true) {
    return { name, private: true, errors: [], warnings: [], checked: [], allowed: [] };
  }
```

And the pack-preview loop is hardcoded to the three publishable packages:

```216:221:.github/workflows/ci.yml
      - name: Pack preview (all publishable packages)
        run: |
          for p in core indexer mcp; do
            npm pack --dry-run --workspace "@sigilkit/$p" > /dev/null
            echo "ok: @sigilkit/$p packs"
          done
```

(identical hardcoding at `publish.yml:97`)

Consequence: `demo-agent`'s four declared entry targets — `main: ./dist/agent.js`,
`types: ./dist/agent.d.ts`, `exports["."].default`, `exports["./cli"].default`
(`demo-agent/package.json:10-20`) — are **never resolved, never packed, never loaded**. If
`tsconfig.build.json`'s `rootDir: "src"` were widened to `"."`, or `outDir` changed, the build
would still exit 0 and no gate would notice; the breakage would surface only when a human
imports the workspace. This is the same defect class `check-package-artifacts.mjs` was
written to prevent, and the one package it cannot see.

Note the asymmetry that makes this a coverage hole rather than a design choice: `mcp` gets
*both* static checks *and* a real `spawn()` of its built entry
(`mcp/test/mcp.test.ts:110`); `demo-agent` gets neither.

### 2.2 Gap 2 — `demo-agent`'s only e2e reports PASS when it did not run

```71:76:packages/demo-agent/test/smoke.e2e.test.ts
describe("demo agent end-to-end (CQ-4)", () => {
  it("runs the documented flow: grant → tick → on-chain enforce → ActionLogged", async () => {
    if (!available) {
      console.warn("skipping demo e2e: forge/anvil not available");
      return;
    }
```

`available` is set false on **any** throw while spawning `anvil --port 8545`
(`smoke.e2e.test.ts:55-65`). The early `return` means vitest records the test as **passed**,
not skipped — so a port collision, a slow cold start, or a broken anvil yields a green
`ts-sdk` job. This is the README's headline flow (`npm run demo`), i.e. the one path with
the least automated protection and the loudest documentation.

The repo has already solved this twice elsewhere and does not apply it here:
- `ci.yml:293-299` (`forge-fork-base`) emits an explicit `::notice` plus `skip`/`reason` job
  outputs so a skip is *distinguishable* from a pass;
- `verify.mjs:568-574` treats a missing `forge` as a **failed** check, not a successful skip.

`demo-agent` follows neither convention.

### 2.3 Gap 3 — `indexer` has no performance gate

`scripts/benchmark-indexer.mjs` exists, is substantial (owns its own Node-24 assertion, build
fingerprint and cleanup assertions), and has **zero callers in either workflow** — confirmed
by grep across `.github/workflows/*.yml` and independently recorded in
`docs/VERIFICATION-STRATEGY-2026-09-25.md:122` (W2-3.1: "benchmark = no gate") and
`docs/PLAN-30-DAYS-2026-09-23-to-2026-10-22.md:96` (W2-4.1, still unchecked). Only its unit
test (`benchmark-indexer.test.mjs`) runs, at `ci.yml:74`. A throughput or query-latency
regression in the indexer ships unmeasured.

### 2.4 Gap 4 — `indexer`'s e2e depends on an undeclared dependency

`packages/indexer/package.json` declares only `typescript`, `vitest`, `@types/node` as
devDependencies. But its e2e runs:

```93:93:packages/indexer/test/cli.e2e.test.ts
    const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, ...args], {
```

`tsx` is declared **only** in `packages/demo-agent/package.json:36`. It currently resolves
because npm hoists it to the root `node_modules` (verified present: `node_modules/tsx` and
`node_modules/.bin/tsx` both exist). That is an implicit contract with the workspace layout,
not a declared one — a `--install-strategy=nested` or `node-linker=isolated` switch breaks
`indexer`'s e2e with `Cannot find module 'tsx'`. The `mcp` suite avoids this entirely by
spawning `dist/cli.js` with plain `node`.

### 2.5 Non-gap, stated explicitly

**`demo-agent` is not published, by design.** `packages/demo-agent/package.json:48` is
`"private": true`. It is correctly absent from the publish loop (`publish.yml:177`), the
release-identity check (`publish.yml:37`), the scope-ownership preflight
(`publish.yml:147`), the published-versions summary (`publish.yml:193`) and the pack-preview
loops (`ci.yml:218`, `publish.yml:97`). **This is correct behaviour, not a gap.** The gap is
that the exclusion is expressed six times as hardcoded lists (see Risk P1) rather than derived
from the `private` flag that already exists.

---

## 3. CI vs local inconsistencies

### 3.1 Node version — consistent today, five unguarded restatement sites

| source | value | asserted by |
|---|---|---|
| `package.json:12` `engines.node` | `>=24` | **owner** (`sync-facts.mjs:15`) |
| `.nvmrc:1` | `24` | `sync-facts.mjs --check` |
| `packages/{core,indexer,mcp,demo-agent}/package.json` `engines.node` | `>=24` | `sync-facts.mjs --check` |
| `ci.yml:47`, `ci.yml:156`, `ci.yml:342` | `node-version: "24"` | assert-only |
| `publish.yml:49`, `publish.yml:131` | `node-version: "24"` | **not covered** |

All Node jobs use `24`; the floor is `>=24`; `.nvmrc` is `24`. **No divergence exists right
now.** The problem is that `scripts/sync-facts.mjs` — the script whose entire purpose is to
prevent this exact drift — **is not invoked by any workflow** (grep for `sync-facts` across
`.github/workflows/*.yml`: 0 matches), and **its own test `sync-facts.test.mjs` is not in the
helper suite** at `ci.yml:74`. The fact-source guard is itself ungated.

`sync-facts.mjs:51-54` documents that workflows are *assert-only* by platform limitation, so
CI coverage of these five sites is the intended design — the defect is that the assertion
half never runs.

### 3.2 `FOUNDRY_VERSION` — duplicated, only one copy asserted

`ci.yml:32` and `publish.yml:15` both hardcode `FOUNDRY_VERSION: "v1.7.1"`. `ci.yml:30-31`
declares it as the single bump point (*"Bump in one place (this env var)"*).
`sync-facts.mjs:17` names **ci.yml's** `env.FOUNDRY_VERSION` as the owner.

So bumping the pin in `ci.yml` — the documented, intended action — leaves `publish.yml`
running the **previous** Foundry version for the entire release gate, with no error anywhere.
The release gate and PR CI can silently test different toolchains.

### 3.3 npm install method — correct

All five install sites use `npm ci`, never `npm install`: `ci.yml:48`, `ci.yml:157`,
`ci.yml:343`, `publish.yml:50`, `publish.yml:132`. OK

### 3.4 Working directory — consistent

Every aux-package command runs from the repo root via `--workspace` flags. The only
`working-directory:` in either workflow is `ci.yml:383` (`packages/core`, for the wallet
harness). `verify.mjs` runs every step with `cwd: ROOT` (`verify.mjs:451-452`). OK

### 3.5 Command parity — three divergences

| step | `ci.yml` | `verify.mjs` (local gate) | `publish.yml` | verdict |
|---|---|---|---|---|
| build | `npm run build --workspaces` (`:165`, **no** `--if-present`) | `... --if-present` (`:559`) | `... --if-present` (`:133`) | PARTIAL ci.yml and publish.yml disagree **with each other** |
| lint/typecheck | `npm run lint --workspaces` (`:197`, **no** `--if-present`) | `... --if-present` (`:560`) | not run | PARTIAL divergence |
| tests | `npm test --workspaces --if-present` (`:198`) | same (`:579`) | via `verify` + `test:coverage --workspaces` (`:76`) | OK |
| coverage | 4 separate `--workspace X` steps (`:203-206`) | not run by `verify` | one `--workspaces` (`:76`) | PARTIAL different failure modes |

The missing `--if-present` in `ci.yml:165`/`:197` is benign today (all four workspaces define
both scripts) but inverts the safety direction: **dropping a `lint` or `build` script from a
workspace would turn CI red while the local gate stays green.** The comment at
`ci.yml:158-161` explicitly states the two workflows were reconciled to agree — they have
drifted apart again on the `--if-present` flag.

**Redundant execution (cost, not correctness):** `ci.yml:198` runs every TS suite, then
`:203-206` runs all four again under coverage. `publish.yml:53` (`verify`) runs them, then
`:76` runs them again. The `ts-sdk` job therefore executes the three aux suites **twice**,
and the `assurance` job does the same on top of deep fuzz, Slither, Halmos and gitleaks.

### 3.6 Fresh-clone test semantics — `core` has `pretest`, the aux packages do not

```42:47:packages/core/package.json
    "build": "tsc -p tsconfig.build.json",
    "pretest": "npm run build",
    "test": "vitest run",
    "pretest:coverage": "npm run build",
```

`indexer`, `mcp` and `demo-agent` have **no `pretest`**. Consequences:

- `npm test --workspace @sigilkit/mcp` on a fresh clone runs `mcp.test.ts:108-112`, which
  spawns `dist/cli.js` — absent before a build — **local red, CI green** (CI builds at
  `ci.yml:165` first).
- `npm run test:coverage --workspace @sigilkit/indexer` likewise runs before any build.
- `verify.mjs` masks this by building at step 5 (`:559`) before testing at step 9 (`:579`).
  A developer running the documented per-workspace command from `README.md:132`
  (`npm test --workspace @sigilkit/core`) gets a rebuild for `core` but **not** for the others.

This is the exact "local red / CI green" shape, and it is the inverse of the usual
direction — worth fixing because the workaround (run `verify`) is slower.

### 3.7 Timeouts — absent in CI, present locally

`timeout-minutes` appears **nowhere** in either workflow (grep: 0 matches). Every job
inherits GitHub's 360-minute default.

`verify.mjs:228-238` budgets every local step (`lint` 60 s ... `contracts` 3600 s,
`tests` 1800 s) and kills the process tree on overrun, recording a `TIMEOUT` failure
(`verify.mjs:490-496`). CI has no equivalent. A hung `vitest` in `ts-sdk` burns 6 hours of
runner time instead of failing in 30 minutes. Highest-risk jobs: `ts-sdk` (5 full TS suite
runs + 2 forge suites) and `assurance` (the entire release gate in one job).

### 3.8 Environment variables

| variable | where read | CI provision | verdict |
|---|---|---|---|
| `FOUNDRY_PROFILE` | `foundry.toml` profiles | `ci.yml:28` = `ci`; `publish.yml:16`, overridden to `deep` at `:56` | OK |
| `FORGE_BIN` / `ANVIL_BIN` | `demo-agent/test/smoke.e2e.test.ts:30-31` | unset -> `~/.foundry/bin/{forge,anvil}`, where `foundry-toolchain` symlinks on ubuntu | OK (implicit) |
| `SIGILKIT_RPC_URL` | indexer CLI e2e (set in-test, `cli.e2e.test.ts:95`) | in-test | OK |
| `SIGILKIT_AUDIT_DB_ROOT` | `mcp/test/mcp.test.ts:243` (fail-closed when unset) | unset -> fail-closed branch exercised | OK |
| `SIGILKIT_OWNER_KEY` | `smoke.e2e.test.ts:82` | set in-test to anvil key #0 | OK |
| `RPC_BASE` | `forge-fork-base` | `secrets.RPC_BASE`; unset -> documented skip (`ci.yml:293-299`) | OK |
| `NODE_AUTH_TOKEN` | npm auth | set on exactly 2 steps (`publish.yml:141, 174`) | OK least privilege |
| `CI` | `verify.mjs:139` colour suppression | set by Actions | OK |

**Gap:** `scripts/check-runtime.mjs` — the one script whose stated purpose (*"so a reviewer
can tell whether an environment difference — not application code — explains a failing run"*,
`check-runtime.mjs:4-7`) is to diagnose *exactly* the class of failure the aux suites are
prone to — is **never executed in CI**. Only its unit test runs (`ci.yml:74`). It would report
the runner's Node version, npm location, and whether every workspace resolves the same vitest
as the root, in the environment where a failure actually happened.

### 3.9 Action pinning — one unpinned action, in the publish workflow

Every action in both workflows is SHA-pinned except:

```58:59:.github/workflows/publish.yml
      - uses: actions/setup-python@v5
        with:
```

`ci.yml:123` and `ci.yml:318` pin the same action as
`actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5.6.0`. `ci.yml:75-80`
documents the repo's own SEC-07 remediation (*"this used to pipe an unpinned script ... RCE in
every CI run"*) — the same defect class, un-remediated one file over, in the workflow whose
sibling job holds `id-token: write`. Mitigating factor: the step lives in `assurance`, which
holds `contents: read` only (`publish.yml:12`) and no npm token, so the blast radius is a CI
runner rather than the registry.

---

## 4. Publish-path risk register

### 4.1 Verified good (the questions asked, answered explicitly)

| question | answer | evidence |
|---|---|---|
| Tests run before `npm publish`? | **YES** | `publish.yml:53` `npm run verify` (build -> typecheck -> artifacts -> contract tests -> TS tests, `verify.mjs:542-579`) **plus** `publish.yml:76` `npm run test:coverage --workspaces`. Not catastrophic. |
| Coverage thresholds enforced pre-publish? | **YES**, all four workspaces | `publish.yml:76`; floors in each `vitest.config.ts` |
| `publishConfig.access` correct (scoped -> 402)? | **YES**, on all three publishables **and** as a CLI flag | `publish.yml:184` `--access public`; `core:10-12`, `indexer:10-12`, `mcp:10-12` all `"access": "public"` |
| `--dry-run` rehearsal? | **YES**, `npm pack --dry-run` in **both** workflows | `ci.yml:216-221`, `publish.yml:95-101` |
| provenance / OIDC? | **YES** | `publish.yml:184` `--provenance`; `publish.yml:118-120` job-scoped `id-token: write` (top-level stays `contents: read`) |
| Version source? | **Hand-written** `packages/*/package.json`, validated against the tag | `publish.yml:29-43` requires `v${manifest.version}` === tag for all three, rejects `private`, semver regex pinned |
| Can it misfire on a PR? | **NO** | `publish.yml:3-5` — only `push` tags `v*`. No `pull_request`, no `workflow_dispatch`, no `workflow_call`. |
| Do all three publish? | **YES** — and correctly so | `publish.yml:177` `for p in core indexer mcp`; `demo-agent` is `private: true` by design (section 2.5) |
| Wrong-package-name preflight? | **YES** | `publish.yml:139-167` catches `@sigilkit/core` being maintained by another project before burning the gate |
| Idempotent re-run? | **YES** | `publish.yml:179-182` skips versions already on the registry |
| sha binding? | **YES**, triple-checked | `publish.yml:45`, `:106`, and `:124-129` re-verify `git rev-parse HEAD` == `GITHUB_SHA` == `needs.assurance.outputs.sha` |

### 4.2 Risks, by severity

**P1 · Medium-High · The publishable set is hardcoded six times.**
`publish.yml:37` (identity), `:97` (pack preview), `:147` (scope preflight), `:177` (publish
loop), `:193` (summary), `ci.yml:218` (pack preview). All six spell `core indexer mcp`
literally, while the fact that actually defines the set — `"private": true` — lives in
`packages/demo-agent/package.json:48` and is read by *neither*. Consequences: a new workspace
is built, tested and coverage-gated (via `--workspaces`) but **silently never published**; a
package flipped to publishable is **silently never packed, never scope-checked, never
identity-checked**; and `check-package-artifacts.mjs` — the one script that *does* know about
`private` — skips exactly the packages the other lists also skip, so nothing cross-checks the
two sources. Derive the loop from
`readdirSync('packages').filter(p => !manifest.private)` and the class of bug disappears.

**P2 · High · A partial publish is observable on the registry.**
`publish.yml:132-133` re-runs `npm ci` + build inside the publish job, then publishes in a
loop. If the publish-job build produced an unpackable tree (or the token lost scope midway),
`core` publishes and `indexer` fails, leaving npm in a **half-released state** for as long as
it takes a human to notice and re-run. npm offers no transactional publish, and the workflow
has no pre-publish `npm publish --dry-run` rehearsal in the job that actually publishes. The
idempotent skip (`publish.yml:179-182`) makes recovery a re-run, but it does not prevent the
intermediate state. Mitigation: add a `--dry-run` loop immediately before the real one in the
`publish` job.

**P3 · Medium · Unpinned action in the release workflow.** `publish.yml:58`
`actions/setup-python@v5` (see 3.9). SHA-pin it. Blast radius is bounded by
`assurance`'s `contents: read` permission, but the remediation already exists in `ci.yml` and
the inconsistency is the defect.

**P4 · Medium · `FOUNDRY_VERSION` duplicated, one copy asserted** (see 3.2). The release
gate and PR CI can test different compilers.

**P5 · Medium · No `timeout-minutes` in `publish.yml` either** (see 3.7). `assurance`
serialises the whole gate — a hang costs 6 hours of a release window.

**P6 · Low-Medium · `environment: npm` is present but its approval policy is undeclared.**
`publish.yml:114` is the right control, and nothing in the repo states whether required
reviewers are configured. If the environment auto-approves, the entire assurance chain is
bypassable by anyone who can push a `v*` tag. This is a repository-settings fact, not a
workflow fact — document it.

**P7 · Low · Manual, non-atomic version bump.** Releasing requires editing three
`package.json` `version` fields *and* creating a matching tag. The identity check
(`publish.yml:29-43`) fails loudly on any mismatch, so this is safe-but-manual; no
`npm version` / changesets automation exists.

**P8 · Informational · No `--dry-run` on `npm publish` itself and no `--otp`.** Correct
as-is: automation tokens are OTP-incompatible. Noted so it is not "fixed" later.

**P9 · Informational · `npm ci` + `cache: npm` in the publish job** (`publish.yml:131-132`) is
safe: `npm ci` verifies integrity hashes from `package-lock.json`, so a poisoned cache entry
fails the integrity check rather than shipping. No action.

---

## 5. `assurance-inventory.mjs` vs `ci.yml` consistency

```
$ node scripts/assurance-inventory.mjs
ci.jobCount: 14
  ci.yml       -> 12 jobs
  publish.yml  ->  2 jobs
```

**Verdict: CONSISTENT.** All 14 job ids and all 14 display names were compared against the two
workflow files; every one matches, in file order, with no extras and none missing.
`README.md:54` (*"14 jobs across 2 workflows — `ci.yml` (12) ... `publish.yml` (2)"*) agrees,
and that claim is machine-enforced by `check-doc-counts.mjs` via `ciJobCount()`
(`check-doc-counts.mjs:848-864`), which independently re-counts the YAML.

The script's own integrity is well defended: it parses with the `yaml` package — the same
parser `validate-workflows.mjs` uses — and `assurance-inventory.test.mjs` pins the two
historical parser defects (a hand-rolled reader that read `name: >-` as the literal display
name `">-"`, and one that dropped a job whose id or `jobs:` key carried a trailing comment)
(`assurance-inventory.mjs:153-163`).

### 5.1 Three caveats worth recording

1. **The inventory cannot see waivers.** It parses job ids and names only — no `if:`,
   no `schedule`, no `continue-on-error`. So `wallet-e2e-weekly`, `echidna-nightly` and
   `foundry-canary` are listed identically to hard-gated jobs. A reader consulting only
   `assurance-inventory.mjs` sees "14 jobs" and infers 14 gates; **11 are gates, 3 are
   waived.** `check-waivers.mjs` holds the other half and is correct (it reports 3 waivers,
   3 register rows, all unexpired at 2026-09-26), but the two outputs are never combined
   into one artifact. A single `assurance-inventory --include-waivers` that also embeds the
   register would close the gap; today the most likely misreading of the published number is
   exactly this one.

2. **The inventory is declared-state only, by design and clearly labelled.** `evidence`
   carries `executed: {halmos: false, slither: false, echidna: false, forge: false}` and
   `ciStatusInferred: false`, with four explicit notes. This is the correct posture for a
   read-only tool and it is well documented. No drift risk.

3. **The run reflects a dirty worktree** (`git.dirty: true`, commit `ce8eea2`). The 14-job
   count is unaffected — it is derived from workflow YAML, and neither workflow is modified —
   but the commit hash in any archived snapshot should not be read as a release revision.

### 5.2 Scripts with no CI caller (gate rot inventory)

| script | unit test in CI? | script itself run in CI? | note |
|---|---|---|---|
| `sync-facts.mjs` | **not in `ci.yml:74`** | **no workflow calls it** | the node-floor / `FOUNDRY_VERSION` drift guard is entirely ungated (3.1, 3.2) |
| `check-runtime.mjs` | OK `ci.yml:74` | no | 3.8 |
| `assurance-inventory.mjs` | OK `ci.yml:74` | no | reporting tool; low priority |
| `benchmark-indexer.mjs` | OK `ci.yml:74` | no | **the indexer perf gate runs nowhere** (2.3) |
| `clean.mjs` | `clean.test.mjs` absent from `ci.yml:74` | no | local dev utility; acceptable |
| `check-vectors.mjs` | OK `ci.yml:192` | OK `ci.yml:190` | OK |
| `check-waivers.mjs` | OK `ci.yml:57` | OK `ci.yml:59` | OK |
| `validate-workflows.mjs` | — | OK `ci.yml:50` | OK |
| `check-dockerfile.mjs` | OK `ci.yml:64` | OK `ci.yml:66` | OK |
| `check-package-artifacts.mjs` | OK `ci.yml:74` | OK `ci.yml:196` | OK (but blind to `private`) |

---

## 6. Recommended additions

Ordered by value per unit of change. All are **proposals** — the workflows are owned by another
track and were not modified.

| # | addition | closes | where |
|---|---|---|---|
| 1 | Derive the pack-preview, scope-preflight, identity-check and publish loops from `private` instead of hardcoding `core indexer mcp` | P1 | `publish.yml:37, 97, 147, 177, 193`; `ci.yml:218` |
| 2 | Add `demo-agent` to the artifact story: either drop `private` from `check-package-artifacts.mjs`'s skip when a `--include-private` flag is passed, or add a dedicated step asserting `dist/agent.js` / `dist/agent.d.ts` / `dist/cli.js` exist and `import()` cleanly | 2.1 | `ci.yml` after `:165` |
| 3 | Make `demo-agent`'s e2e honest: use `it.skipIf(!available)` so an unavailable toolchain is recorded as skipped, and add a CI step asserting the e2e actually executed (e.g. the test writes a marker the job checks) | 2.2 | `demo-agent/test/smoke.e2e.test.ts:71-76` |
| 4 | `timeout-minutes` on every job in both workflows, mirroring `verify.mjs:228-238` | 3.7 | both files |
| 5 | Re-add `--if-present` to `ci.yml:165` and `ci.yml:197` so build/lint agree with `verify.mjs` and `publish.yml` | 3.5 | `ci.yml:165, 197` |
| 6 | Add `pretest` / `pretest:coverage` (`npm run build`) to `indexer`, `mcp`, `demo-agent` to match `core` | 3.6 | three `package.json` files |
| 7 | Add `node scripts/sync-facts.mjs --check` + `node --test scripts/sync-facts.test.mjs` to the `workflow-lint` job | 3.1 | `ci.yml:74` |
| 8 | Have `sync-facts.mjs` also assert `publish.yml`'s `FOUNDRY_VERSION` against the ci.yml owner | P4 | `scripts/sync-facts.mjs` |
| 9 | SHA-pin `actions/setup-python` in `publish.yml` | P3 | `publish.yml:58` |
| 10 | New nightly `bench-indexer` job running `scripts/benchmark-indexer.mjs` with its `assertValidReport` guard | 2.3 | `ci.yml` |
| 11 | Run `node scripts/check-runtime.mjs` in `workflow-lint` and publish its report to `$GITHUB_STEP_SUMMARY` | 3.8 | `ci.yml:74` area |
| 12 | Pre-publish `npm publish --dry-run` loop inside the `publish` job | P2 | `publish.yml`, before `:172` |
| 13 | Document the `environment: npm` required-reviewers policy in the release checklist | P6 | `docs/DEPLOYMENT.md` |
| 14 | Declare `tsx` in `packages/indexer/package.json` devDependencies (or switch the e2e to the built `dist/cli.js` like `mcp` does) | 2.4 | `packages/indexer/package.json` |
| 15 | Add an `aux-artifact-load` job: after build, `node -e "await import('<each built entry>')"` for all three packages | 2.1 | new job |

---

## 7. Summary

- **`indexer`** — well covered (unit, typecheck, build, static artifacts, pack, coverage,
  publish). Two gaps: **no performance gate at all** (2.3) and an **e2e leaning on an
  undeclared `tsx` dependency** (2.4).
- **`mcp`** — the **best-covered** of the three, and the only one whose e2e spawns the real
  built `dist/cli.js`. No package-specific gap found.
- **`demo-agent`** — the weakest. Unit, typecheck, build and coverage are all gated, but it
  is **invisible to the artifact guard** (2.1, because `check-package-artifacts.mjs` skips
  private packages) and its **only e2e reports green when it never ran** (2.2). Both are
  silent-failure modes, which is why they outrank the louder gaps elsewhere.
- **Publish path is in good shape**: the full gate (tests, coverage, pack rehearsal,
  provenance + scoped OIDC, sha triple-binding, tag/version identity, scope preflight,
  idempotent re-run, PR-immune trigger) all verified present. The real risks are
  **P1** (six hardcoded package lists), **P2** (observable partial publish) and **P3**
  (one unpinned action in the release workflow).
- **`assurance-inventory.mjs` is consistent with `ci.yml`** — 14 jobs, exact match. Its one
  blind spot is that it cannot see `continue-on-error`, so its published "14 jobs" reads as
  14 gates when 3 are waived.
- The most structural finding: **four guard scripts have no CI caller**
  (`sync-facts.mjs` entirely, including its own test; `check-runtime.mjs`;
  `benchmark-indexer.mjs`; `clean.test.mjs`). Guard coverage is strongest where a script was
  most recently built and thinnest where one was written but never wired in.
