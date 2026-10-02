# @sigilkit/core — Release Readiness Review

**Date:** 2026-09-26 · **Reviewer:** cr-ship (release readiness) · **Scope:** `packages/core` only
**Verdict:** ❌ **NOT READY TO PUBLISH** — hard-blocked on an npm scope the project does not own.

---

## 1. Release readiness score

| Dimension | Score | Basis |
|---|---|---|
| Build integrity & reproducibility | **A** | Two clean builds byte-identical (36/36 files) |
| Packaging correctness (`files`/`exports`) | **A−** | All 14 entry targets resolve; clean tarball; but `CHANGELOG.md`/`abis/` not shipped |
| Consumer installability | **F** | Name is taken on npm by an unrelated project → `E403` |
| Test & lint gate health | **C** | `npm run lint` fails; full vitest run aborts on a Foundry compile error |
| Security posture | **B−** | No known-unfixed contract bug; 2 SDK-layer guards still open in the threat map |
| Documentation / release hygiene | **C** | No per-package CHANGELOG; README contradicts actual browser support |
| **Overall** | **D+ / 4.5 of 10** | Not publishable today; the code is in better shape than the *release mechanics* |

**The headline:** `@sigilkit/core` is not blocked by bad code. It is blocked by the **release
identity** — the `@sigilkit` npm scope belongs to somebody else. Everything in §5 is fixable in
days; nothing in §5 makes the code un-shipping-quality once the name question is settled.

---

## 2. P0 — blocks the release

### P0-1 · The package name is already owned by an unrelated project (E403 on publish)

- **Evidence:** `.github/workflows/publish.yml:135-138` states in the repo's own words that
  "`@sigilkit/core` is exactly that case — it is published by a different project, so
  `npm publish` fails with an opaque E403". `publish.yml:139-167` is a *preflight that
  deliberately fails the job* on exactly this condition.
- **Corroboration:** `packages/core/README.md:10-12` — "**Not yet published.** The `@sigilkit`
  scope on npm is owned by an unrelated project, so this command installs *their* package
  today."
- **Third source:** `docs/DEPLOY-OPS-2026-09-26.md:472-475` records
  `registry.npmjs.org/@sigilkit/core` → **exists, v0.11.1, MIT, maintainer `jorsjs`**, repo
  `github.com/JonathanSantos/sigilkit` (an unrelated pt-BR VSCode-extension framework).
- **Why it blocks:** not "the publish might fail" — the workflow *intentionally* aborts before
  publishing. Worse, `npm install @sigilkit/core` (the first line of the package README,
  `README.md:7`) currently installs **a different product**. A user who follows the docs gets
  silent, wrong code.
- **Resolution required (a product decision, not a code fix):** rename the scope
  (`@sigilkitlabs/*`, `@sigil-kit/*`, an org-scoped alternative) **or** obtain transfer of the
  existing scope. Nothing else in this report matters until this is decided.

### P0-2 · The root export statically imports Node builtins — the package cannot be bundled for a browser, and the README says it is meant to be

> **STATUS: FIXED (P0-3).** Both remedies below were applied: `config`, `logger` and `cli` are
> no longer re-exported from `src/index.ts` (see the explanatory comment at `index.ts:8-48`),
> and `defaultIo` in `src/cli.ts` now resolves its streams through `hostStdout()` /
> `hostStderr()` with a `typeof process === "undefined"` guard, matching `logger.ts`.
> The evidence below is kept as the original record of the defect and is NOT a statement of
> the current tree — the `index.ts` line numbers it cites (`:8`, `:9`, `:10`) no longer exist.

- **Evidence (empirical, not inferred):** building the published entry with esbuild targeting
  the browser fails outright:

  ```
  BROWSER BUNDLE FAILED:
    Could not resolve "node:fs"   @ node_modules/@sigilkit/core/dist/config.js:11
    Could not resolve "node:path" @ node_modules/@sigilkit/core/dist/config.js:12
  ```

- **Root cause:** `packages/core/src/index.ts:9` re-exports `./config.js`, and
  `packages/core/src/config.ts:11-12` has top-level `import { existsSync } from "node:fs"` /
  `import { join } from "node:path"`. These are **static** imports, so they land in the module
  graph of `import "@sigilkit/core"` unconditionally — a consumer cannot tree-shake them away
  and a bundler cannot stub them.
- **The documented contract is violated:** `packages/core/README.md:32-36` says
  `FileLeaseStore` is kept off the root export *specifically* because it "pulls in `node:sqlite`
  ... which would drag a Node-only builtin into every browser bundler". That exact reasoning was
  applied to `lease-fs` and **not** to `config` — the guard is inconsistent. `README.md:91` then
  shows the intended browser/dapp usage `} from "@sigilkit/core";`.
- **Same defect class, three modules — and two distinct binding mechanisms (verified):**
  - **`config.ts:11-12` — top-level *static* `import "node:fs"` / `"node:path"`.** Fails
    **immediately at build time**: a bundler cannot resolve the specifier at all. Empirically
    measured — esbuild `platform:'browser'` on the published entry errors with
    `Could not resolve "node:fs"` / `"node:path"`.
  - **`logger.ts` and `cli.ts` — the `process` *global*, not an import.** No `node:` specifier,
    so a bundler resolves the module fine; the failure is deferred to first call. Empirically
    measured in a `process`-less realm: **module evaluation succeeds**, then
    `createLogger(...).emit(...)` and `defaultIo.stdout(...)` both throw
    `ReferenceError: process is not defined`. Sites: `logger.ts:423` (`textColorsEnabled`),
    `logger.ts:524-525` (default sinks — note `logger.ts:417` *does* guard
    `typeof process === "undefined"`, so the guard is inconsistent within one file), and
    `cli.ts:344-348` (`defaultIo`).
  - **Consequence for sequencing:** the static-import failure surfaces on the first build, so
    fix `config` first to get a clean signal; `logger`/`cli` are genuinely latent and will not
    show up in a build at all. **They are delayed to the *path*, not to the *time* — evaluation
    of the module succeeds and only the first execution of that line throws.**
    - **Acceptance criteria for the fix (both assertions are required):**
      1. esbuild `platform:'browser'` bundles the root entry with **zero** unresolvable
         specifiers (catches `config`'s static imports), **and**
      2. a test in a `process`-less realm (`delete globalThis.process`) imports the root entry
         **and invokes the default sink**, expecting `ReferenceError` (catches `logger`/`cli`).
      Asserting only (1) is insufficient; asserting only "the import does not throw" yields a
      **false green** — see §7.
- **Correction to an earlier draft of this report:** it originally described `cli.ts` as
  "environment-neutral" because it has no `node:` import. That was **wrong** — `cli.ts:344-348`
  dereferences the `process` global at the same points as `logger.ts`. `cli.ts` is affected.
- **Why it blocks:** the first documented consumption path is broken for the browser, and the
  package cannot fix it post-release without a breaking change to the export map.
- **Fix options:** (a) drop `export * from "./config.js"` (`index.ts:9`) and keep it behind the
  existing `/config` subpath — this alone repairs the build-time failure; (b) additionally drop
  `logger` (`index.ts:8`) and `cli` (`index.ts:10`) from the barrel to remove the latent
  `process` dependency — **recommended**, since leaving them reproduces the same bug at runtime;
  (c) add a browser condition to `exports["."]`; (d) declare Node-only in metadata and correct
  the README. Removing a symbol from a public barrel is a breaking change, so (b) belongs in
  the `0.2.0` breaking release (see §6), not a patch.

### P0-3 · The declared lint gate fails on the current tree

- **Evidence:** `npm run lint --workspace @sigilkit/core` → exit 1:

  ```
  test/lease-ttl-contract.test.ts(189,38): error TS2322: Type 'string' is not assignable to type 'Promise<unknown>'.
  test/lease-ttl-contract.test.ts(209,33): error TS7023: 'acquire' implicitly has return type 'any' ...
  test/signing-conformance.test.ts(308,11): error TS2322: Type 'bigint' is not assignable to type 'number'.
  test/signing-conformance.test.ts(310,11): error TS2322: Type 'bigint' is not assignable to type 'number'.
  ```

- **Scope attribution (important — do not misread this as a regression):** all four failing files
  are **untracked** (`git status` shows them as `??`). They are in-flight work from the
  concurrent `packages/core` reviewers, not committed code. The *committed* tree typechecks.
- **Why it still blocks:** `packages/core/package.json:47` makes `lint` the typecheck gate, and
  `publish.yml` reaches typecheck through `npm run verify` (`publish.yml:52-53`). The tag push
  cannot pass its own gate while these are in the tree. It is a coordination blocker, not a
  design defect.
- **Action:** the owning teammates must land or quarantine the new test files before any tag.

### P0-4 · A committed Foundry test references a contract that does not exist

- **Evidence:** running the core suite triggers a Solidity compile failure before any TS test runs:

  ```
  Error: Compiler run failed:
  Error (7920): Identifier not found or not unique.
     --> contracts/test/GraduatedAuthority.t.sol:288:9:
    288 |         MockSafeOwner safe = new MockSafeOwner(OWNER_KEY);
  ```

  A repo-wide search for `MockSafeOwner` returns **zero definitions** — the type is used twice
  (`GraduatedAuthority.t.sol:288` and `:331`) and declared nowhere.
- **Blast radius:** `publish.yml:57` runs `forge test --no-match-contract '.*Fork'` in the
  `assurance` job that gates publishing, and `publish.yml:76` runs
  `npm run test:coverage --workspaces`. The core suite's `eip7702.test.ts` spawns Anvil
  (`test/anvil.ts:45`), which compiles the contracts, so this failure takes down the *TypeScript*
  gate too.
- **Why it blocks:** the publishing job's mandatory compile step cannot succeed. Note this is
  `contracts/`, outside my write scope, but it hard-blocks the `packages/core` release.
- **Action:** add the `MockSafeOwner` mock (or fix the two call sites) in `contracts/`.

---

## 3. Release checklist — item by item

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Build reproducible (two runs byte-identical) | ✅ | `tsc -p tsconfig.build.json` into two separate outDirs → 36/36 files SHA256-identical |
| 2 | Build succeeds | ✅ | `npm run build --workspace @sigilkit/core` → exit 0 |
| 3 | `exports` match real artifacts | ✅ | `npm pack --dry-run` → all 6 subpaths present in tarball; `scripts/check-package-artifacts.mjs` → "14/14 entry target(s) OK" |
| 4 | Every export resolves for a real consumer | ✅ | Installed the actual `.tgz` into a clean project: root → 94 exports, `/validation` 17, `/logger` 8, `/config` 16, `/cli` 9, `/lease-fs` 1 — **all OK** |
| 5 | `files[]` complete (nothing missing) | ⚠️ | `dist` + `README.md` ship. **Missing:** `CHANGELOG.md` (none exists) and `abis/*.json` (see P1-1) |
| 6 | No `dist/` committed | ✅ | `.gitignore:36` ignores `dist/`; `git ls-files` shows no `dist` entries |
| 7 | No `.env` / `*.log` / `node_modules` committed | ✅ | `.gitignore:2,12,75`; tarball listing contains none |
| 8 | `LICENSE` present | ✅ | Root `LICENSE` is auto-included by npm (1.1kB in tarball). A package-local copy now exists but is **untracked** |
| 9 | `README.md` present | ✅ | `README.md` ships (11.7kB) |
| 10 | `CHANGELOG.md` present | ❌ | **Does not exist** for `core` (or any package). Root `CHANGELOG.md:6` has an `[Unreleased]` section holding all post-0.1.0 work |
| 11 | `engines.node` matches syntax used | ⚠️ | `>=24` is **stricter than the code requires** — see P1-2 |
| 12 | peerDependencies correct | ⚠️ | **None declared.** See P1-3 |
| 13 | No TODO/FIXME/unimplemented in `src/` | ✅ | Grep over `packages/core/src` → 0 hits |
| 14 | No skipped/todo tests | ✅ | Only `wallet-e2e.manual.test.ts:36` `describe.skipIf(!ENABLED)`, correctly env-gated |
| 15 | Threat-map open items closed | ⚠️ | Rows 6 & 10 SDK guards open — see P1-4 |
| 16 | Node version consistent (`.nvmrc`/engines/docs) | ✅ | `.nvmrc` = `24`; root + all packages `engines.node` = `>=24`; `docs/GETTING-STARTED.md:9,16` all say 24 and justify `node:sqlite` |
| 17 | `sync-facts --check` | ✅ | `sync-facts OK — 14 restatement(s) agree with their owner, 1 note(s)`, exit 0 |
| 18 | Tests pass | ❌ | Full `vitest run` aborts on the P0-4 compile error. The 7 pure files that don't need Anvil pass: **210/210** |
| 19 | Lint/typecheck passes | ❌ | See P0-3 |
| 20 | Publish pipeline runs tests | ✅ | `publish.yml:52-53` `npm run verify`; `:57` forge deep fuzz+invariants; `:76` coverage thresholds |
| 21 | Publish pipeline runs build | ✅ | `publish.yml:133` in the publish job; `verify` builds before typechecks |
| 22 | npm auth present | ✅ | `publish.yml:141,174` `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`; `:49` registry-url; `:114` `environment: npm`; `:120` `id-token: write` for provenance |
| 23 | dry-run / publish separated | ✅ | `publish.yml:95-101` pack-preview in `assurance`; publish is a **separate job** gated on `needs.assurance.result == 'success'` (`:112`) |
| 24 | Provenance + identity binding | ✅ | `--provenance` (`:184`), SHA binding (`:44-45,103-107,124-129`), tag↔version match (`:29-43`) |
| 25 | Re-publish safety | ✅ | `publish.yml:179-182` skips versions already on the registry |

### Correctness / compatibility notes (non-blocking)

- **No unfinished functionality** in `src/` — no `TODO`, `FIXME`, `not implemented`, or
  `throw new Error("unsupported")`. Clean.
- **`abis/MerkleWhitelist.json` contains `[]`** — an empty ABI, correct if the contract has no
  external functions/events. Not a defect, but worth a conscious confirmation.
- **Browser availability:** the package is *not* browser-safe as published (P0-2). The intended
  design is browser-capable; the implementation does not deliver it.
- **API drift vs a published `@sigilkit/core`:** not applicable in the useful sense — the npm
  package at that name is a **different product** (P0-1). There is no version history to be
  compatible with.

---

## 4. Dependencies

`dependencies: { viem: ^2.55.19 }` is **correct and complete** — an enumeration of every
non-relative import in the built output yields exactly `viem` plus Node builtins:

```
viem, node:crypto, node:fs, node:path, node:sqlite
```

`viem` is a hard runtime import in six modules, so `dependencies` (not `devDependencies`) is
right. `ethers` is correctly dev-only (test-side comparison).

**Circular-dependency check:** the `dist/*.js` import graph is `index.js` fanning out to ten
siblings; the siblings import only each other in a DAG (`config → validation, logger`;
`client → signing, validation, …`; `abis`, `types`, `errors` are leaves). **No cycles found.**

---

## 5. Blocking items summary

| ID | Severity | Item | Owner |
|---|---|---|---|
| P0-1 | **P0** | `@sigilkit` npm scope owned by an unrelated project → publish `E403`; `npm install @sigilkit/core` installs the wrong package | product/release owner |
| P0-2 | **P0** | Root export statically imports `node:fs`/`node:path` via `config`; browser bundling fails; contradicts `README.md:32-36` | core team |
| P0-3 | **P0** | `npm run lint` fails (4 TS errors in untracked in-flight test files) | core team |
| P0-4 | **P0** | `contracts/test/GraduatedAuthority.t.sol:288,331` reference undefined `MockSafeOwner` → forge compile fails → publishing gate fails | contracts owner |
| P1-1 | P1 | `CHANGELOG.md` missing for every package; `abis/*.json` not in `files[]` | core team |
| P1-2 | P1 | `engines.node: ">=24"` overstates the requirement (code is ES2022) | core team |
| P1-3 | P1 | `viem` exposed in the public type surface without a peerDependency declaration | core team |
| P1-4 | P1 | Threat-map rows 6 & 10 SDK guards (non-zero chainId assertion, nonce non-reuse) still open as W3-4.1 | security/core |
| P1-5 | P1 | `logger.ts:423,524-525` **and** `cli.ts:344-348` dereference `process` unguarded — latent browser failure (see P0-2) | core team |
| P1-6 | P1 | `packages/core/.vitest-perf.json` is untracked and **not** gitignored → `git add -A` would commit a local perf artifact | core team |
| P2-1 | P2 | `packages/core/LICENSE` exists but is untracked (npm auto-includes root LICENSE, so low impact) | core team |
| P2-2 | P2 | No browser-condition entry in `exports["."]` as a forward-looking guard | core team |
| P2-3 | P2 | `abis/MerkleWhitelist.json` = `[]`; confirm intentional | contracts owner |
| P2-3b | P2 | Node 20/22 runtime floor not machine-enforced (only documented) | core team |

---

## 6. Version recommendation

**Recommendation: `0.2.0` — but do not cut it until P0-1 through P0-4 are resolved.**

Rationale:

1. **`0.1.0` is already spoken for.** `CHANGELOG.md:341` records a `[0.1.0] — 2026-08-23`
   release. The current tree is far past that: the `[Unreleased]` section (`CHANGELOG.md:6`)
   spans 2026-09-11, 09-12 and 09-15 waves including explicit **`### Breaking — Contracts`**
   (`CHANGELOG.md:279`) and **`### Changed — SDK (@sigilkit/core)`** (`CHANGELOG.md:296`)
   entries. Sub-`0.x` semver treats `0.1.0 → 0.2.0` as the breaking release — exactly right for
   a package that has never been publicly consumable and whose surface has changed materially
   (`/validation`, `/logger`, `/config`, `/cli` subpaths are all new).
2. **Never `1.0.0`.** The package is unaudited. `docs/SECURITY-7702-THREAT-MAP.md:17` records the
   designator as "a fixed, **NOT-yet-audited** contract (pre-mainnet)", and rows 6, 8 and 10 are
   still open. `1.0.0` signals API stability that has not been earned.
3. **`0.1.1` would be wrong** — it signals patch-level, non-breaking changes, and the delta since
   `0.1.0` includes breaking SDK changes plus a new package name.
4. **The name change forces a new identity anyway.** If P0-1 resolves via a scope rename, this
   ships under a brand-new package name regardless of version number.

**Also required before tagging:** fold the `[Unreleased]` section into a dated `0.2.0` heading and
publish a **per-package** `CHANGELOG.md` (P1-1), since the root changelog's monorepo-level
entries do not tell a `@sigilkit/core` consumer what changed *in this package*.

---

## 7. Method & evidence trail

Read-only throughout. No file in `packages/`, `scripts/`, `docs/`, `contracts/` or `contracts/`
was created, modified or deleted. The only writes were this report and two `tsc` builds into
`%TEMP%` (`sk-build-a`, `sk-build-b`) plus a throwaway consumer project in `%TEMP%` — none
inside the repository.

Commands run, with outcomes:

| Command | Result |
|---|---|
| `npm run build --workspace @sigilkit/core` | exit 0 |
| `tsc -p tsconfig.build.json --outDir <temp>` ×2 | 36/36 files byte-identical |
| `npm pack --dry-run --workspace @sigilkit/core` | 39 files, 92.1 kB; LICENSE + README + dist |
| `npm pack` → install `.tgz` into clean project → import root + 5 subpaths | all 6 resolve |
| esbuild `platform: 'browser'` on `dist/index.js` | **fails** on `node:fs`, `node:path` |
| `npm run lint --workspace @sigilkit/core` | **exit 1**, 4 TS errors |
| `npx vitest run` (full) | **aborts** — `MockSafeOwner` undefined |
| `npx vitest run` (7 pure files) | 210/210 pass |
| `node scripts/sync-facts.mjs --check` | OK, 14 restatements agree, exit 0 |
| `node scripts/check-package-artifacts.mjs` | OK — 3 packages, 24 targets, 0 warnings |
| `git ls-files` / `git status --porcelain` | no `dist` tracked; stray `.vitest-perf.json` |
| `require()` probe of the damaged tree (2026-09-27 01:13) | `viem` entry exists but **fails to load** (missing `abitype`); `yaml` recovered; `typescript`/`vitest`/`esbuild`/`@types/node` absent |

### Verification discipline applied to this report

Three defects were found in my own first draft by re-testing with a stronger method. They are
recorded here because the same three failure modes will recur:

1. **A zero-result probe was trusted without a positive control.** Team-lead's
   `Select-String` for `process\.(stdout|stderr|exit)` returned 0, then 3 on the identical
   command minutes later. A "checked, 0 hits" result is only evidence of absence if it is first
   reconciled against a probe **known to be positive**. This applies to negating a claim, not
   only to reporting one.
2. **A `Test-Path` on a package directory reports health that does not exist.** `viem` resolves,
   its entry file exists, and `require()` still fails on a missing transitive `abitype`. The
   only trustworthy liveness test is `require()` / an actual build.
3. **Module-level and path-level failure were conflated.** A binding inside a closure does not
   fail at import; asserting only "the import does not throw" produces a false green. Any
   regression test for P0-2 must assert **both** "import does not throw" *and* "touching the
   default sink throws" — otherwise it passes while the bug is live.

**Caveats on my own evidence:**

- `forge` and `anvil` are **not on PATH** in this environment, so I could not run the Solidity
  suite. The `MockSafeOwner` finding comes from the compile error surfaced through the
  TypeScript suite's Anvil spawn, plus a repo-wide search that found no definition — the
  conclusion is solid, but the fix should be re-verified with `forge` available.
- The lint failures (P0-3) sit in **untracked** files from concurrent teammates. They are real
  and gate the release, but they are not a regression in committed code. Re-run after that work
  lands.
- **The dependency tree was destroyed mid-review and cannot be restored on this machine.**
  Cause (per team-lead): a failed `npm ci` triggered by an unimportable `bootstrap.mjs`;
  `cr-dep` proved with a controlled experiment that no usable reparse point can be created on
  this host, so reinstall is not possible here.

  **State as measured with `require()` — the authoritative test — at 2026-09-27 01:13:59
  (the tree is still churning; re-measure before relying on any of this):**

  | Package | `require.resolve` | `require()` | Note |
  |---|---|---|---|
  | `viem` 2.55.19 | FILE-OK | **FAILS** | its own entry `_cjs/index.js` exists, but it `require()`s the missing transitive `abitype` |
  | `yaml` 2.9.1 | FILE-OK | **LOADS** | recovered since the earlier `dist/index.js` gap |
  | `@noble/hashes` 1.8.0 | FILE-OK | n/a | ESM-only root; `require()` of the root is expected to fail |
  | `typescript`, `vitest`, `esbuild`, `@types/node`, `abitype` | UNRESOLVABLE | FAILS | absent |

  **⇒ `viem` is the important row, and it is the same false-positive shape as the `yaml` case:
  the package resolves and its entry file exists, yet loading it fails on a missing transitive
  dependency.** A `Test-Path`/`existsSync` check on `viem` alone reports healthy; only
  `require()` (or an actual build) exposes it. This is now the **first directory-level
  `Test-Path` false positive** in this repo's history (the earlier one was a junction), and it
  validates the rule that acceptance must use `require()` or `existsSync(<entry file>)`, never a
  bare directory check.

  **Consequence:** every verification in this report was captured *before* this point and remains
  valid, but **no re-verification is possible here** — P0-3, P0-4 and the P0-2 fix must be
  re-checked in a working environment. Do not treat "needs re-running" as an assignable task on
  this machine. `node scripts/check-doc-counts.mjs` currently exits **2**
  (`spawnSync forge ENOENT`), so even the doc-count guard is not runnable.
- `docs/STALENESS-2026-09-26.md:395` records the npm-scope fact as "unverifiable offline". I
  did not have network access to re-verify the registry directly; I relied on three independent
  in-repo sources (`publish.yml:135-138`, `packages/core/README.md:10-12`,
  `docs/DEPLOY-OPS-2026-09-26.md:472-475`), all of which agree.
