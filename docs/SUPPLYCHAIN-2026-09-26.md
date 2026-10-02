# Supply-Chain Audit — scripts layer

**Date:** 2026-09-26
**Scope:** root `package.json` devDependencies, `scripts/install-*.sh` external binaries,
`.github/workflows/{ci,publish}.yml` action pins & permissions, toolchain version pins.
**Author:** sc-chain (scripts team)
**Nature:** read-only audit. No file outside this document was modified.

Severity uses OWASP-style practical impact for a **wallet toolkit** (EIP-7702 + session keys
with on-chain spend caps): what an attacker gains, and what it costs to notice.

---

## 0. Executive summary

| # | Finding | Severity | Status |
|---|---|---|---|
| **S-1** | `actions/setup-python@v5` in `publish.yml:58` is pinned by **tag, not SHA** — the only unpinned action in the repo, and it sits inside the `assurance` release gate, immediately upstream of the Slither/Halmos/coverage gates | **HIGH** | Open |
| **S-2** | Two phantom dependencies: `scripts/generate-vectors.mjs` imports `viem`; `scripts/check-runtime.mjs` resolves `vitest`. Neither is a root devDependency — both resolve only by npm-workspace hoisting accident | **MEDIUM** | Open |
| **S-3** | All 3 root devDependencies float on `^`. With a committed lockfile this is *defensible*, but the repo's "single source of truth" doctrine is not machine-enforced for the manifest | **LOW** | Open |
| **S-4** | `solc` is pinned only in `foundry.toml`; `HALMOS_ALLOW_DOWNLOAD=1` lets halmos fetch a solc at runtime, unverified | **LOW** | Accepted |
| **S-5** | No `pull_request_target` anywhere; `permissions: contents: read` already tightened at top level of both workflows | — | **Clean** |
| **S-6** | No `docker://` image references, so no unpinned image digests | — | **Clean** |
| **S-7** | gitleaks / actionlint installs already pin version **and** SHA256, verified **before** extraction | — | **Clean** |
| **S-8** | slither / halmos / FOUNDRY_VERSION declarations are **byte-identical** across `ci.yml` and `publish.yml` | — | **Clean** |

**The headline is S-1.** The repo has clearly already done the hard part of this work — SEC-07
(curl-piped-into-bash) was fixed, checksums were added, `permissions` was tightened, and 38 of 39
action references are SHA-pinned. One tag reference survived, and it sits in the release gate.

**Correction (2026-09-26, after review by ck-err).** An earlier revision of this document argued
S-1's impact as *credential theft* — "a moved tag executes attacker code in this repository's
release job, with npm publish credentials." **That was wrong, and the error was mine.**
`publish.yml:58` is in the **`assurance`** job (`:21-107`), not the `publish` job (`:109-197`).
`secrets.NPM_TOKEN` (`:141`, `:174`) and `id-token: write` (`:118-120`) are attached only to
`publish`. The `assurance` job has zero `secrets.` references and inherits the top-level
`contents: read`. So a malicious `v5` yields RCE **with no secrets and no id-token** — credential
theft does not follow. §3.1 states the correct impact: **release-gate integrity**, which is still
HIGH, on different and better-supported grounds.

---

## 1. Root `package.json` devDependencies audit

### 1.1 What is declared

The root manifest declares exactly three devDependencies:

| Package | Declared | Resolved in lockfile | Integrity |
|---|---|---|---|
| `@playwright/test` | `^1.62.1` | `1.62.1` | `sha512-DTcUc8qii+cpHvt…` |
| `@vitest/coverage-v8` | `^5.0.0` | `5.0.0` | present |
| `yaml` | `^2.9.1` | `2.9.1` | present |

Production dependencies are **not** declared at the root at all — they live in the workspace
manifests (`packages/*/package.json`), which is correct for a workspace monorepo.

### 1.2 Usage — which script needs which

Every non-builtin import in `scripts/` was enumerated. Only **one** third-party package is
imported by `scripts/` at all:

| Package | Imported by | Kind |
|---|---|---|
| `yaml` | `scripts/validate-workflows.mjs:21` (`parseDocument`)<br>`scripts/check-waivers.mjs:48` (`parseDocument`, `isCollection`, `isPair`, `isScalar`)<br>`scripts/check-doc-counts.mjs:39` (`parse`)<br>`scripts/assurance-inventory.mjs:33` (`parse`)<br>`scripts/assurance-inventory.test.mjs:8` (`parse`) | **direct, declared** |
| `@vitest/coverage-v8` | not imported by `scripts/` — consumed by the per-workspace `vitest run --coverage` invoked from `package.json` scripts | **indirect, declared at root + each workspace** |
| `@playwright/test` | not imported by `scripts/` — imported by `packages/core/test/wallet-e2e/{run,real-metamask}.ts` and `playwright.config.ts`, and driven from CI by `npx playwright install chromium` | **workspace consumer, declared at root** |

Everything else in `scripts/` imports only Node builtins (`node:fs`, `node:path`, `node:url`,
`node:child_process`, `node:os`, `node:crypto`, `node:test`, `node:assert/strict`,
`node:worker_threads`, `node:readline/promises`, `node:perf_hooks`, `node:sqlite`).

**This is a genuinely good result for a scripts layer** — a self-contained toolchain that leans on
`node:` builtins instead of a dependency tree. Worth stating plainly, because the usual failure
mode (a "helper script" quietly pulling in 40 transitive packages) is absent here.

### 1.3 Phantom dependencies — S-2

Two `scripts/` files consume packages that are **not declared in the root manifest**:

| Consumer | Package | How it is reached | Why it is a phantom |
|---|---|---|---|
| `scripts/generate-vectors.mjs:15-18` | `viem` | `import { hashTypedData, keccak256 } from "viem"` | `viem` is declared only in the four `packages/*/package.json` manifests, never at the root |
| `scripts/generate-vectors.mjs:25-27` | `viem` (**deep internal path**) | `await import(pathToFileURL(join(ROOT, "node_modules/viem/_esm/utils/authorization/hashAuthorization.js")))` | reaches into viem's **private `_esm` layout** by filesystem path |
| `scripts/check-runtime.mjs:159` | `vitest` | `require.resolve("vitest/package.json")` | `vitest` is a devDependency of each workspace, never of the root |

**Why this matters, concretely.** These resolve today purely because npm hoists workspace
dependencies into the root `node_modules/`. That is an implementation detail of npm's hoisting
algorithm, not a contract. Any of the following breaks them, and the breakage surfaces as a
*runtime* failure in a script rather than as an install error:

- a workspace dropping `viem` (e.g. the indexer bundle-size work) silently breaks vector
  generation, and the T-05 no-op gate in `ci.yml:182-188` **degrades to a warning** rather than
  failing — so a real vector drift would ship unnoticed;
- `pnpm`, `yarn`, or `npm install --install-strategy=nested` (used by some Docker base images)
  changes hoisting and the scripts break at the point of use.

**The `_esm` path is the sharper edge.** `viem/_esm/utils/authorization/hashAuthorization.js`
is not an export in viem's `package.json` `exports` map. It is a private path. Any viem
minor/patch that relocates that file breaks `npm run vectors:generate` — and because the
`_esm` tree is not covered by viem's semver promises, a `^2.55.19` bump can change it without a
major version. The script's own comment acknowledges the constraint
(`generate-vectors.mjs:23-24`) and works around the missing re-export, but the workaround itself
is the fragility.

**Fix.** Declare the real dependencies at the root rather than relying on hoisting:

```jsonc
// package.json — root
"devDependencies": {
  "@playwright/test": "1.62.1",   // pinned; see §1.4
  "@vitest/coverage-v8": "5.0.0",  // pinned; see §1.4
  "viem": "2.55.19",               // ADD: scripts/generate-vectors.mjs imports it
  "vitest": "5.0.0",               // ADD: scripts/check-runtime.mjs resolves it
  "yaml": "2.9.1"                  // pinned; see §1.4
}
```

For the deep `_esm` import, prefer viem's public surface. If `hashAuthorization` genuinely has no
public re-export in 2.x, gate the fallback so a viem refactor fails **loudly and early** rather
than producing different vectors:

```js
// scripts/generate-vectors.mjs — replace the private-path import
let hashAuthorization;
try {
  ({ hashAuthorization } = await import("viem/experimental"));
} catch {
  // Pin the fallback to a checked existence so a viem refactor fails here, with a
  // clear message, instead of silently emitting vectors from a different code path.
  const p = join(ROOT, "node_modules/viem/_esm/utils/authorization/hashAuthorization.js");
  if (!existsSync(p)) {
    throw new Error(
      `viem no longer exposes hashAuthorization at ${p}. ` +
      `Bump the pinned viem and update this reference deliberately.`
    );
  }
  ({ hashAuthorization } = await import(pathToFileURL(p).href));
}
```

### 1.4 Version strategy — S-3

All three root devDependencies use `^`. **No dependency is pinned to an exact version anywhere in
the repository** — the four workspace manifests also use `^` throughout (`viem ^2.55.19`,
`typescript ^7.0.2`, `vitest ^5.0.0`, `@types/node ^24.13.3`, `ethers ^6.17.0`, `tsx ^4.19.0`).

**The mitigating fact, stated first because it changes the severity:** `package-lock.json` is
committed (2,400+ lines, with `integrity` SHA-512 hashes on every entry), and every CI job uses
`npm ci`, not `npm install`. Under `npm ci` the lockfile is authoritative and `^` never re-resolves.
So today, `^` does **not** mean "drifts over time" in CI — it means "drifts when someone runs
`npm install` and commits the result".

That is a real but *reviewable* risk, not an unattended one. The residual exposure:

- A maintainer running `npm install` locally for an unrelated reason silently absorbs new
  minor/patch versions of `viem`, `typescript` and `vitest` into the lockfile. The PR diff shows
  lockfile churn, which reviewers routinely skim. `viem` in particular drives **every typed call in
  `@sigilkit/core`** — it is the highest-consequence package in the tree.
- `dependabot.yml:5-7` states the intent explicitly ("a silent supply-chain risk for a wallet
  toolkit") and covers this with weekly grouped PRs. The *mechanism* is sound; the residual gap is
  that Dependabot proposes and a human merges.

**Recommendation — pin exactly, and let Dependabot move the pins.** This is the standard
reconciliation of "reproducible" with "maintainable": exact versions make the manifest match the
lockfile, and the weekly Dependabot PR becomes the *only* mechanism that changes a version, which
is precisely the reviewable-PR property the repo wants.

| Package | Now | Proposed | Rationale |
|---|---|---|---|
| `viem` (all 4 manifests) | `^2.55.19` | `2.55.19` | **highest priority** — drives every typed call in core; a silent minor bump changes hashing/encoding behaviour the golden vectors pin |
| `vitest` (root + 4 manifests) | `^5.0.0` | `5.0.0` | test-only, but a silent bump moves coverage floors; note `check-runtime.mjs:56-78` exists *because* vitest resolution was once inconsistent across workspaces |
| `typescript` (4 manifests) | `^7.0.2` | `7.0.2` | drives every `lint`/typecheck gate |
| `@vitest/coverage-v8` (root + core) | `^5.0.0` | `5.0.0` | must stay in lockstep with `vitest` |
| `@types/node` (4 manifests) | `^24.13.3` | `24.13.3` | must track the `engines.node: >=24` floor |
| `yaml` (root) | `^2.9.1` | `2.9.1` | **pin this one first** — it parses `.github/workflows/*.yml` in the validator and waiver guard. A `parseDocument` behaviour change silently weakens a *security* gate (§6.4) |
| `ethers` (core, dev) | `^6.17.0` | `6.17.0` | test-only cross-check against viem |
| `tsx` (demo-agent, dev) | `^4.19.0` | `4.19.0` | demo/fleet only, not a release gate |
| `@playwright/test` (root) | `^1.62.1` | `1.62.1` | pins the browser bundle; keep in lockstep with the CI cache key |

A mechanical guard so the policy cannot rot, in the same spirit as `scripts/check-waivers.mjs` —
walk every manifest, fail on any `^`/`~`/`*`/bare range:

```js
// scripts/check-manifest-pins.mjs  (new; wire into ci.yml workflow-lint job)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const manifests = [
  "package.json",
  ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/package.json`),
];

const problems = [];
for (const rel of manifests) {
  const pkg = JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      // Internal workspace deps are excluded: @sigilkit/* floats within 0.1.x on purpose
      // (SEC-2) and is never installed from the registry.
      if (name.startsWith("@sigilkit/")) continue;
      if (/^[\^~*]|^\d+\.\d+$|^[><]/.test(range)) {
        problems.push(`${rel}: ${field}.${name} = "${range}" is a range, not an exact pin`);
      }
    }
  }
}

if (problems.length) {
  console.error(`manifest pin policy FAILED — ${problems.length} range(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`manifest pin policy OK — ${manifests.length} manifest(s)`);
```

### 1.5 Duplicate dependencies

**No duplicates. This is clean.** Verified against the lockfile: `viem`, `vitest`,
`@vitest/coverage-v8`, `typescript` and `tsx` each resolve to **exactly one** `node_modules/…`
entry — no `node_modules/<pkg>/node_modules/<pkg>` shadowing anywhere. The five `viem` manifests
all declare the same `^2.55.19` and npm correctly deduped to a single `2.55.19` tree.

Two entries worth naming so nobody mistakes them for duplicates:

- **`fsevents` appears twice** — `fsevents@2.3.3` (hoisted, via `tsx`) and
  `playwright/node_modules/fsevents@2.3.2`. Both are `dev: true`, `optional: true`, `os: darwin`.
  A version skew inside a single tree, but it is macOS-only file-watching and cannot affect a
  Linux CI runner. **Not a finding.**
- **`typescript` pulls 22 platform-specific optionalDependencies** (`@typescript/typescript-*`
  for aix/darwin/freebsd/linux/openbsd/sunos/win32 …), each pinned to `7.0.2`. Expected for the
  TypeScript 7 native-port line; one resolves per platform. **Not a finding.**

### 1.6 Install scripts

`package-lock.json` marks exactly three packages `hasInstallScript: true`:

| Package | Version | Why | Risk |
|---|---|---|---|
| `esbuild` | `0.28.2` | downloads/validates its platform binary at install | transitive via `tsx` → `demo-agent` |
| `fsevents` | `2.3.3` | builds the macOS FSEvents binding | optional, darwin-only |
| `playwright`'s `fsevents` | `2.3.2` | as above | optional, darwin-only |

All three are `dev: true`. The `Dockerfile` runtime stage runs `npm ci --omit=dev`, so **none of
them execute in the shipped image** — the correct posture. Worth noting that `esbuild`'s install
script is a well-known historical target (it fetches a platform binary over the network at install
time), and it is currently reachable in CI via `npm ci` with dev deps installed. Accepted, with the
mitigation being that the version is locked in the lockfile and integrity-checked.

---

## 2. External binary dependencies

### 2.1 `scripts/install-gitleaks.sh` — CLEAN

| Property | Value | Verdict |
|---|---|---|
| Version pin | `GITLEAKS_VERSION="v8.30.1"` (`:17`) | pinned |
| Download URL | `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz` (`:27`) | immutable release asset |
| SHA256 | `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` (`:18`) | **present** |
| Hash verification | `echo "${GITLEAKS_SHA256}  ${TARBALL}" \| sha256sum -c - >&2` (`:38`) | before extraction |
| GPG signature | not verified | see §2.3 |
| Install location | `${RUNNER_TEMP:-outputs}` (`:22`) | not the worktree |
| Smoke test | `./gitleaks version >&2` (`:47`) | present |

Three details are genuinely right and worth crediting, because each is a mistake the obvious
implementation makes:

1. **Verify before extract, not after** (`:34-38`). `tar` is an executable data format — a tarball
   can carry a `postinstall`-style hook or a path-traversal entry, so extracting first runs
   attacker-controlled content before the integrity check ever fires. The ordering is correct.
2. **The stdout contract** (`:12-14`, `:36-37`). `sha256sum -c` prints `OK` to stdout, which would
   corrupt the "absolute path is the only thing on stdout" contract that
   `ci.yml:83` (`echo "bin=$(bash scripts/install-actionlint.sh)" >> "$GITHUB_OUTPUT"`) depends on.
   Redirecting to stderr is a deliberate, necessary fix.
3. **Not the working tree** (`:8-10`, `:20-24`). A 40 MB untracked blob in the repo root is one
   `git add -A` away from being committed. Writing to `$RUNNER_TEMP` removes that failure mode
   entirely.

### 2.2 `scripts/install-actionlint.sh` — CLEAN

| Property | Value | Verdict |
|---|---|---|
| Version pin | `ACTIONLINT_VERSION="v1.7.9"` (`:21`) | pinned |
| Download URL | `https://github.com/rhysd/actionlint/releases/download/v1.7.9/actionlint_1.7.9_linux_amd64.tar.gz` (`:32`) | immutable release asset |
| SHA256 | `233b280d05e100837f4af1433c7b40a5dcb306e3aa68fb4f17f8a7f45a7df7b4` (`:22`) | **present** |
| Hash verification | `echo "${ACTIONLINT_SHA256}  ${TARBALL}" \| sha256sum -c - >&2` (`:43`) | before extraction |
| GPG signature | not verified | see §2.3 |
| Install location | `${RUNNER_TEMP:-outputs}` (`:27`) | not the worktree |
| Smoke test | `./actionlint -version >&2` (`:52`) | present |

This file is the documented remediation for **SEC-07**. Its own header (`:5-10`) records the prior
state: `bash <(curl -sSf .../main/scripts/download-actionlint.bash)` piped an unpinned script from
the upstream *default branch* into bash, so anyone able to push to `rhysd/actionlint:main` got RCE
in every CI run of this repository, with its token and secrets. That class of bug is fully closed.

### 2.3 On TOCTOU and GPG — both correctly assessed as non-issues here

The brief asked specifically about TOCTOU (download to a temp file, then `mv`). **That race does
not apply to these two scripts, and it is worth saying why rather than adding ceremony:**

The hash is computed over the file *as it exists on disk after the download completes*, and the
same path is then extracted. There is no separate "trusted copy" and "untrusted copy" to race
between. A classic TOCTOU needs an attacker who can write to the path *between* verification and
use. On a GitHub-hosted runner the only principals with write access to `$RUNNER_TEMP` are the
job's own steps — so exploiting it requires already having code execution in the job, at which
point the checksum is not the control that was holding.

Also note the scripts do **not** use the download-to-temp-then-`mv` pattern at all: they `curl -o`
directly into the final name and verify in place. The residual exposure is the ~50 ms between
`curl` returning and `sha256sum` running, where a *local* attacker with write access to
`$RUNNER_TEMP` could swap the file. That is a strictly weaker threat than the SEC-07 bug it
replaced, and closing it further would mean `mktemp` + `chmod 500` on the directory — ceremony that
buys little. **Recommendation: leave as-is, document the reasoning** (done here).

**GPG signature verification: the honest cost/benefit.** Neither script verifies upstream's GPG
signature over the release. What a SHA256 constant buys is *tamper-evidence against transport and
storage* — a MITM, a compromised mirror, or a swapped asset is caught, because the hash in the
repo does not match. What it does **not** buy is provenance: if an upstream maintainer's account
or release pipeline is compromised *before* the maintainer of this repo computes the hash, the
malicious hash simply gets committed. GPG verification closes that second gap.

For a wallet toolkit, that gap is worth naming but does not justify adding a keyring dependency to
two shell scripts today. The pragmatic, high-value alternative is to fetch the *upstream-published*
checksum file and diff it against the committed constant, which catches an upstream release being
tampered with after the fact:

```bash
# scripts/install-gitleaks.sh — add after the existing sha256sum -c check
# Cross-check the committed constant against upstream's published checksums file, so a
# retroactively-tampered release is detected rather than silently trusted.
UPSTREAM_SUMS="$(mktemp)"
trap 'rm -f "$UPSTREAM_SUMS"' EXIT
curl -sSfL -o "$UPSTREAM_SUMS" \
  "https://github.com/gitleaks/gitleaks/releases/download/${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION#v}_checksums.txt"
grep -F "${TARBALL}" "$UPSTREAM_SUMS" | grep -qF "${GITLEAKS_SHA256}" >&2 || {
  echo "::error::committed gitleaks SHA256 does not match upstream ${GITLEAKS_VERSION} checksums" >&2
  exit 1
}
```

(This is *defence in depth against upstream compromise*, not a replacement for the constant — the
constant is what makes the check fail-closed when upstream is unavailable. Keep both.)

### 2.4 Other downloads in CI

| Download | Location | Version pin | Hash check | Verdict |
|---|---|---|---|---|
| MetaMask extension `13.49.0` | `ci.yml:367-371` | yes — URL + `7ba00bfe…` constant | **yes** (`sha256sum --check`) | CLEAN |
| Playwright Chromium | `ci.yml:352` | by npm version (`@playwright/test 1.62.1` → browser build) | indirect, via npm integrity | ACCEPTABLE |
| `solc` (halmos) | `ci.yml:312` (`HALMOS_ALLOW_DOWNLOAD: "1"`) | **no** | **no** | S-4 |

The MetaMask fetch is the best-executed download in the repository, and it goes beyond the other
two in a way worth naming: after the checksum it runs a **build-identity check** (`:374-381`) that
asserts `manifest.json` reports `version === "13.49.0.0"` and `manifest_version === 3`, and that
check runs on the **cache-hit path too** (`:372-373`) — because a poisoned cache entry would
otherwise bypass the checksum entirely. Also note the cache key carries a `-v1` suffix (`:358-359`)
specifically so a 12.5.0 artefact cannot satisfy the 13.49.0 key.

**S-4 detail — `HALMOS_ALLOW_DOWNLOAD`.** `ci.yml:312` and `publish.yml:66` both set
`HALMOS_ALLOW_DOWNLOAD: "1"`, which permits halmos to fetch a `solc` binary at runtime. The repo
pins `solc = "0.8.36"` in `foundry.toml:7`, and `ci.yml:409` passes `solc-version: 0.8.36` to
Echidna — so *which* compiler is wanted is unambiguous. What is not enforced is that the fetched
binary is the official 0.8.36 build. This is a deliberate, documented trade-off (the comment at
`:312` says so) and the exposure is bounded: solc is a compiler, and a malicious one would have to
be served by the upstream release channel. **Low severity, worth a comment, not worth blocking a
release over.**

### 2.5 Summary — downloads without hash verification

**Empty.** Every binary fetched over the network in this repository is hash-verified before use:

| Download | Hash-verified | Location |
|---|---|---|
| gitleaks 8.30.1 | yes | `scripts/install-gitleaks.sh:38` |
| actionlint 1.7.9 | yes | `scripts/install-actionlint.sh:43` |
| MetaMask 13.49.0 | yes | `ci.yml:369` |
| Chromium (via npm) | yes (npm `integrity`) | `package-lock.json` |
| solc (halmos) | **no** | `ci.yml:312`, `publish.yml:66` — accepted, S-4 |

---

## 3. Action SHA pins

### 3.1 The one unpinned action — S-1, HIGH

Every `uses:` in both workflows was enumerated (39 references across 7 distinct actions).
**38 of 39 are pinned to a full 40-character commit SHA with the version in a trailing comment.
Exactly one is not.**

```yaml
# .github/workflows/publish.yml:58
      - uses: actions/setup-python@v5      # <-- TAG, NOT SHA
        with: { python-version: "3.12" }
```

**Severity: HIGH — on the integrity of the release gate, not on credential theft.**

*(Corrected after review by ck-err. An earlier revision argued this as "RCE with npm publish
credentials." That was factually wrong: `:58` is in the `assurance` job, not `publish`.)*

The impact is that a moved `v5` tag lets an attacker make the **entire assurance gate report
success without having verified anything**. Step ordering is what makes this severe — `:58` sits
*immediately upstream* of every substantive security gate in the release path:

```
:53  npm run verify                    ← full local gate
:57  forge test --no-match-contract    ← deep fuzz + invariants
:58  setup-python@v5                   ← THE UNPINNED STEP
:61  pip install slither-analyzer==0.11.6 halmos==0.3.3
:63  slither contracts/src --fail-high ← contract static analysis
:67  halmos --match-contract Halmos    ← symbolic verification
:73  gitleaks detect                   ← secret scan
:76  npm run test:coverage --workspaces
:84  git diff --exit-code packages/core/abis
```

A malicious action can no-op the whole `:53-84` block, or simply force the job green. And
`publish` is gated on exactly that result:

```yaml
# publish.yml:112
    if: ${{ needs.assurance.result == 'success' && needs.assurance.outputs.sha == github.sha }}
```

So a commit that **passed assurance while never actually being verified** proceeds to
`npm publish`. The failure mode is a supply-chain compromise of the *published artifacts*, reached
through a falsified security gate — the worst outcome available to an attacker who can only reach
CI, and the one this repository's own release comments say it is built to prevent (`publish.yml:19-20`:
"Required evidence is produced in this tag run, never borrowed from branch CI").

**What is explicitly *not* the impact**, so nobody over-corrects and dismisses the finding:

- **No credential theft.** `secrets.NPM_TOKEN` (`:141`, `:174`) and `id-token: write` (`:118-120`)
  are attached only to the `publish` job (`:109-197`). The `assurance` job has **zero** `secrets.`
  references and inherits the top-level `contents: read` (`publish.yml:11-12`). A malicious `v5`
  gets RCE with no secrets and no id-token.
- **No tag or release forgery.** The tag must still match the three `package.json` versions
  (`:37-41`) and the checkout must still bind to `$GITHUB_SHA` (`:45`).

**Threat model — unchanged from what the repo already accepted 38 times.** The attack requires
push access to `actions/setup-python` (or compromise of that repo's release pipeline). That is
precisely the threat the other 38 SHA pins exist to defend against, so accepting it here is
inconsistent rather than a different risk calculation.

**The strongest argument is internal consistency.** `ci.yml:123` and `ci.yml:318` already pin this
exact action to `a26af69b…`. There is no comment at `publish.yml:58` explaining why the release
gate gets the weaker form. A reviewer scanning the release workflow would reasonably assume the
weaker form was deliberate — which is exactly the failure mode that lets a real omission survive
review. It is an oversight, not a decision.

**Concrete downstream stake.** ck-err's contracts-layer review independently surfaced
`SessionKeyManager._erc20BalanceOf` as fail-open: a `staticcall` returning `0` on failure, so a
non-standard or hostile token reads as a zero balance and the E11 watchlist delta check
(`:627-632`) goes blind while the owner still believes it is enforced. **The fix has already
landed in the working tree, and it is properly shipped** — `:835` now reads
`if (!ok || ret.length < 32) revert UnreadableWatchToken(token);` (error declared at `:42`, with
a fail-closed rationale at `:794-831`), and `contracts/test/E11WatchlistRead.t.sol` carries **9
regression tests**: four hostile-read paths that must each revert with
`UnreadableWatchToken` (reverting `balanceOf`, short return, no-code address, and a *lone* hostile
token — the case where the drain previously landed because the token read 0 on both sides), plus
five non-regression tests proving conforming watchlists still execute, undeclared outflow is still
refused, `EnforceNativeDelta=false` is unaffected, and both empty-watchlist paths still behave.
Note `:829-831` — the revert sits in the shared helper deliberately, so **both** `_snapshotBalances`
(pre-call) and `_verifyBalances` (post-call) are covered and no future call site can reintroduce
fail-open. So the E11 hole itself is closed. The residual stake is narrower but real: that revert is
a **contract change sitting behind the very Slither gate at `publish.yml:63` that a malicious `v5`
could neutralise** — so until S-1 is fixed, the gate that would catch a regression in it has no
trusted root. The two findings are causally adjacent, not unrelated.

**Fix — a one-line change:**

```yaml
# .github/workflows/publish.yml:58
      - uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5.6.0
        with: { python-version: "3.12" }
```

That reuses the SHA already trusted twice in `ci.yml`. To obtain a SHA for any future action:

```bash
git ls-remote https://github.com/actions/setup-python refs/tags/v5
# a26af69be951a213d495a4c3e4e4022e16d87065  refs/tags/v5
# or, for an annotated tag, dereference: add ^{} to refs/tags/v5
```

### 3.1a Scan surface — completeness of this count

The "39 references / 38 pinned" figure is only as good as the file set it was computed over.
Confirmed: `.github/actions/` **does not exist**, so there are no local composite actions that
could carry an unpinned `uses:` of their own. The scan surface is exactly the two files under
`.github/workflows/`. Anything under `.github/ISSUE_TEMPLATE/` is inert. So the count has no
hidden remainder.

### 3.2 Full action pin inventory

| Action | SHA | Version | Occurrences |
|---|---|---|---|
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` | v4.4.0 | 14 (12 in `ci.yml`, 2 in `publish.yml`) |
| `foundry-rs/foundry-toolchain` | `908c540300062bd5a7e473851cdb4282204cee09` | v1.9.1 | 11 (10 + 1) |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 | 5 (3 + 2) |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4.6.2 | 3 (all in `ci.yml`) |
| `actions/setup-python` | `a26af69be951a213d495a4c3e4e4022e16d87065` | v5.6.0 | 2 (`ci.yml:123,318`) |
| `actions/cache` | `0057852bfaa89a56745cba8c7296529d2fc39830` | v4.3.0 | 2 (both in `ci.yml`) |
| `crytic/echidna-action` | `f7e374e42bf7131f7307a92f5549ed6b2fd17c9d` | v2.0.2 | 1 (`ci.yml:404`) |
| **`actions/setup-python`** | **`@v5` (tag)** | **v5** | **1 (`publish.yml:58`) — S-1** |

Sum: 14 + 11 + 5 + 3 + 2 + 2 + 1 = 38 SHA-pinned, + 1 tag = **39 total references**.

**Verification technique:** a script walked both workflow files line by line, extracted every
`uses:` value, split it on `@`, and tested the ref against `^[0-9a-f]{40}$`. Exactly one ref
failed. No `@v*`, `@main`, `@master`, or branch reference survives anywhere in
`.github/workflows/`.

### 3.3 `crytic/echidna-action` — pinned, with one caveat

`ci.yml:404` pins `f7e374e42bf7131f7307a92f5549ed6b2fd17c9d` with the comment
`# v2.0.2 (refs/heads/v2, also tag v2.0.2)`. The SHA is correct form. The comment is honest that
the commit is reachable from a **branch** (`refs/heads/v2`) as well as the tag — which is
information a reader wants, since a SHA on a branch head is still immutable *as a commit*; the
branch can move, but this workflow will not follow it. The upstream `echidna-version: v2.2.5`
input is a version string the action resolves at runtime, so the *Echidna binary itself* is
fetched by the action rather than by this repo's hash-verified installer path. Accepted: the trust
boundary is the action, which is SHA-pinned.

### 3.4 `docker://` image references — none (S-6)

`grep` for `docker://` across `.github/workflows/` returns **zero matches**. No job pulls a
container image, so there are no unpinned image digests to fix. (`Dockerfile:20,35` uses
`FROM node:24-bookworm-slim`, a tag rather than a digest — out of scope for the action-pin audit,
and reasonable for a base image that is rebuilt on every release rather than consumed in CI.)

---

## 4. CI permissions and secret exposure

### 4.1 `permissions:` — already tightened (S-5, clean)

Both workflows declare a top-level block:

```yaml
# ci.yml:24-25 and publish.yml:11-12
permissions:
  contents: read
```

This is the correct posture and it is *explicit*, which matters: without the block, a workflow
inherits the repository/org default token permissions, which on many orgs include write on
`contents`, `packages` and `pull-requests`. `ci.yml:20-23` documents exactly this reasoning.
Neither workflow needs write anywhere — `ci.yml` only reads the repo, and `publish.yml`'s
`assurance` job only reads.

`publish.yml:118-120` overrides at the `publish` job level to add the one permission genuinely
required:

```yaml
    permissions:
      contents: read
      id-token: write
```

`id-token: write` is needed for `npm publish --provenance` (`:184`) to mint an OIDC attestation.
The scoping is right: it is on the job that publishes, not on the job that runs the assurance
gate. `environment: npm` (`:114`) adds a second layer — the token is gated behind environment
protection rules (required reviewers / wait timer) that a plain tag push cannot satisfy unattended.

**Verdict: no permissions finding.** This is better than the default posture most repositories
ship with.

### 4.2 `pull_request_target` — not present (S-5, clean)

`grep` for `pull_request_target` across both workflows: **zero matches**. The `pull_request`
trigger (`ci.yml:6`) is the safe variant — it runs in a context scoped to the fork, with a
read-only token and **no access to repository secrets**. The high-risk combination the brief asked
about specifically:

> `pull_request_target` + `actions/checkout` of the PR head + any subsequent `run:` step

would hand an attacker a **write-scoped token and all repository secrets** simply by opening a
pull request, because `pull_request_target` runs in the *base* repository context. That pattern is
absent. Note the converse also holds: `ci.yml:42-43` checks out with `submodules: recursive`, so
if a submodule were attacker-controlled the checkout itself is worth watching — but with
`contents: read` and no secrets in that job, the blast radius is bounded.

### 4.3 Secret exposure surface

| Secret | Where | Reach | Assessment |
|---|---|---|---|
| `secrets.NPM_TOKEN` | `publish.yml:141, 174` | `publish` job only (tag push, `environment: npm`) | correctly scoped; step-level `env`, not job-level, so only the two steps that need it see it |
| `secrets.RPC_BASE` | `ci.yml:284` | `forge-fork-base` job (nightly + dispatch only) | step/job `env`; the job degrades to a skip when unset (`:293-299`) |
| `GITHUB_TOKEN` | implicit, all jobs | `contents: read` | minimal |
| `id-token` | `publish.yml:120` | `publish` job | needed for provenance |

Two observations worth recording:

- **The `NPM_TOKEN` is a long-lived publish token, not OIDC.** `npm publish --provenance` attaches
  an attestation, but the *authorisation* is still a static token. Migrating to npm's trusted
  publishing (OIDC-only, no stored token) would remove the credential entirely. Out of scope for
  this audit; recorded as a hardening option.
- **`RPC_BASE` is job-level `env`** (`ci.yml:284`), so it is visible to every step in that job —
  including `actions/checkout` and the foundry toolchain action. Moving it to the single step that
  consumes it (`:303`) would narrow it. The job only runs on a schedule, and the token is a
  read-only RPC endpoint, so the practical risk is low.

### 4.4 `continue-on-error` — governed, and that is the point

Four jobs carry `continue-on-error: true` (`ci.yml:335, 400, 418`). These are *not* a permissions
issue but they are a gate-integrity issue, and this repository has done something unusually good
about it: `docs/CI-WAIVERS.md` is a real register with dated criteria and hard expiry dates, and
`scripts/check-waivers.mjs` **enforces it in CI** (`ci.yml:56-59`) — adding a waiver without a
register row fails the PR, and an expired row turns the job red. `ci.yml:327-330` and `:392-395`
carry explicit removal criteria in the comments themselves.

**This is the pattern to copy into the rest of the audit's recommendations:** the waiver register
plus its machine check is exactly what §3.1 (SHA pins) and §1.4 (manifest pins) are missing.

---

## 5. Toolchain version pins

### 5.1 Pin status

| Tool | Pin | Location | Verified by | Verdict |
|---|---|---|---|---|
| Foundry | `v1.7.1` | `ci.yml:32`, `publish.yml:15` (env var) | `sync-facts.mjs:1116-1168` parses the env var and reports the owner | **pinned, single source** |
| Slither | `0.11.6` | `ci.yml:126`, `publish.yml:61` | `slither --version` (`ci.yml:127`) | **pinned** |
| Halmos | `0.3.3` | `ci.yml:320`, `publish.yml:61` | `halmos --version` (`ci.yml:321`) | **pinned** |
| Echidna | `v2.2.5` | `ci.yml:410` | resolved by the SHA-pinned action | **pinned** |
| gitleaks | `v8.30.1` + SHA256 | `scripts/install-gitleaks.sh:17-18` | `sha256sum -c` + `gitleaks version` | **pinned + hashed** |
| actionlint | `v1.7.9` + SHA256 | `scripts/install-actionlint.sh:21-22` | `sha256sum -c` + `actionlint -version` | **pinned + hashed** |
| MetaMask | `13.49.0` + SHA256 | `ci.yml:359, 367-369` | `sha256sum --check` + `manifest.json` identity | **pinned + hashed** |
| Node | `24` | `ci.yml:47` etc., `engines.node: ">=24"` | — | major-pinned |
| Python | `3.12` | `ci.yml:124` etc. | — | minor-pinned |
| solc | `0.8.36` | `foundry.toml:7`, `ci.yml:409` | — | pinned in config |

**No `pip install` lacks a version pin.** Every `pip install` in both workflows is fully
specified: `slither-analyzer==0.11.6` (`ci.yml:126`), `halmos==0.3.3` (`ci.yml:320`),
`pip install slither-analyzer==0.11.6 halmos==0.3.3` (`publish.yml:61`). This directly answers
the brief's concern — there is no unpinned `pip install`, and therefore no path by which a
newly-poisoned PyPI release enters CI unannounced.

The one deliberate exception is `foundry-canary` (`ci.yml:423`), which passes `version: nightly` to
test upstream Foundry drift. `sync-facts.mjs:1168` explicitly recognises and exempts it: the
canary's `nightly` is *"a deliberate exception"*, and the job is `continue-on-error: true` under
a waiver with a 2026-11-30 expiry. **This is the right design** — a pinned toolchain with a
deliberately unpinned canary catches upstream drift before it reaches the gates, instead of
discovering it as a red PR.

### 5.2 Fact-split check: slither / halmos across both workflows — CONSISTENT

The brief flagged this as a possible high-severity fact split. **Grep-verified: the two
declarations are byte-identical and there is no split.**

| Tool | `ci.yml` | `publish.yml` | Identical? |
|---|---|---|---|
| Slither | `slither-analyzer==0.11.6` (`:126`) | `slither-analyzer==0.11.6` (`:61`) | **yes** |
| Halmos | `halmos==0.3.3` (`:320`) | `halmos==0.3.3` (`:61`) | **yes** |
| Foundry | `FOUNDRY_VERSION: "v1.7.1"` (`:32`) | `FOUNDRY_VERSION: "v1.7.1"` (`:15`) | **yes** |
| Python | `3.12` (`:124`, `:319`) | `3.12` (`:59`) | **yes** |
| checkout SHA | `11d5960a…` (12 sites) | `11d5960a…` (2 sites) | **yes** |
| foundry-toolchain SHA | `908c5403…` (10 sites) | `908c5403…` (1 site) | **yes** |
| setup-node SHA | `49933ea5…` (3 sites) | `49933ea5…` (2 sites) | **yes** |
| **setup-python SHA** | `a26af69b…` (2 sites) | **`@v5` — tag (`:58`)** | **NO — this is S-1** |

The only cross-workflow divergence in the entire toolchain is precisely the one unpinned action
from §3.1. Every other shared tool agrees.

**One structural observation, not a finding.** `FOUNDRY_VERSION`, slither and halmos are each
declared **twice** (once per workflow) rather than once in a shared location. They happen to agree
today, but nothing *enforces* that they continue to. `sync-facts.mjs` already owns the Foundry
env var as a single source of truth (`:1116-1168`) and `.github/dependabot.yml:5-7` documents all
five toolchain pins in one comment — so the pattern for centralising exists, it just has not been
applied to the Python tools. A future bump that updates `ci.yml` and forgets `publish.yml` would
produce a **release gate running a different Slither than the PR gate**, which is exactly the
"release validated something the branch never tested" failure mode `publish.yml:19-20` is written
to prevent ("Required evidence is produced in this tag run, never borrowed from branch CI").

The fix that matches existing repo idiom — add the cross-workflow agreement check to the guard
that already exists, rather than introducing a new file:

```js
// scripts/sync-facts.mjs — add alongside the FOUNDRY_VERSION check (~:1116-1168).
// Python tool pins are declared once per workflow, so nothing enforces that ci.yml and
// publish.yml keep agreeing. A bump applied to only one file would mean the release gate
// runs a different Slither/Halmos than the PR gate.
const PINNED_TOOLS = [
  { name: "slither-analyzer", re: /slither-analyzer==([0-9][^\s]*)/g },
  { name: "halmos", re: /\bhalmos==([0-9][^\s]*)/g },
];

export function crossWorkflowToolPins(workflows) {
  const problems = [];
  for (const { name, re } of PINNED_TOOLS) {
    const seen = new Map();
    for (const [file, text] of Object.entries(workflows)) {
      const versions = new Set([...text.matchAll(re)].map((m) => m[1]));
      if (versions.size > 1) {
        problems.push(`${file}: declares ${name} at ${[...versions].join(" and ")} — pick one`);
      } else if (versions.size === 1) {
        seen.set(file, [...versions][0]);
      }
    }
    const distinct = new Set(seen.values());
    if (distinct.size > 1) {
      problems.push(
        `${name} pin differs across workflows: ` +
        [...seen].map(([f, v]) => `${f}=${v}`).join(", ")
      );
    }
  }
  return problems;
}
```

---

## 6. Recommendations, in priority order

### P0 — do before the next tag

| # | Action | Effort |
|---|---|---|
| **1** | Pin `actions/setup-python` by SHA in `publish.yml:58` → `a26af69be951a213d495a4c3e4e4022e16d87065 # v5.6.0` | 1 line |

This is the only HIGH finding. A one-line change, reusing a SHA the repository already trusts
twice, removes the last mutable ref in the release gate — so that a compromised upstream tag can no
longer falsify the Slither / Halmos / gitleaks / coverage evidence that `publish.yml:112` gates
`npm publish` on. It adds zero new trust surface.

### P1 — next sprint

| # | Action | Effort |
|---|---|---|
| 2 | Add a SHA-pin guard to `scripts/validate-workflows.mjs`, modelled on `check-waivers.mjs`: fail on any `uses:` whose ref is not 40 hex characters. This is the machine half of the waiver-register pattern the repo already trusts for `continue-on-error`. **Must read the file as raw text, not via `parseYaml`** — see §6.1. | ~25 lines |
| 3 | Add `viem` and `vitest` to root `devDependencies` (S-2); guard the `viem/_esm` deep import so a refactor fails loudly. | ~15 lines |
| 4 | Pin all manifest versions exactly; add the `check-manifest-pins.mjs` guard from §1.4 so the policy cannot rot. | ~40 lines |
| 5 | Add the cross-workflow tool-pin check from §5.2 to `sync-facts.mjs`. | ~30 lines |

### 6.1 A structural constraint on every guard proposed above

Discovered with ck-doc while scoping P1-2, and it changes the shape of two of the proposals.
**A YAML parser discards comments by construction, so no YAML-aware guard can ever validate a
number that lives in a workflow comment.** Verified directly against this repo's parser:

```
$ node -e "…YAML.parseDocument(ci.yml).get('jobs').get('halmos').comment…"
comment survives in AST? undefined          ← the comment is not in the parsed tree at all
$ node -e "…/6 specs/.exec(rawCiText)…"
RAW-REGEX finds: 6 specs                    ← a raw-text scan finds it immediately
```

Consequences for the proposals in this document:

| Proposal | Mechanism required | Why |
|---|---|---|
| P1-2 — SHA-pin guard | **raw text**, not `parseYaml` | `validate-workflows.mjs` is built on `parseDocument` (`:21`, `:49`). Its structural checks work on the parsed doc, but a `uses:` ref lives in `step.uses` and *is* reachable — so the SHA check itself is fine either way. What is **not** fine is any *comment*-derived claim. |
| `ci.yml:306` "6 specs" | **raw text regex** | `:306` is a pure comment line. `ciJobCount()` (`:848-864`) sees only `Object.keys(doc.jobs)` = 12. The count is structurally unreachable from the AST. |
| P2-11 — manifest counts | filesystem walk, **no YAML** | plain `readdirSync`; unaffected. |

**So: one script may host both checks, but it must not be YAML-aware for the comment-derived
one.** A combined `parseYaml`-based guard would silently never fire on `ci.yml:306` — which is
precisely the defect it was written to fix. This is the same failure shape as
`check-runtime.mjs:61-67`, where a truthy-but-unresolved root compared equal to itself and the
check "could not fail" (`evaluateVitest`'s own comment says so).

**And a trap in the template you would naturally reach for.** `metamaskPinFromCi`
(`check-doc-counts.mjs:562-568`) is the wrong thing to copy. Its own comment records why: ci.yml
names **two** MetaMask versions — the live pin `13.49.0` in the release-asset filename, and a
**superseded `12.5.0` inside a cache-key comment** (`:358-359`). It is therefore anchored on
`metamask-chrome-(\d+\.\d+\.\d+)\.zip` rather than "the first version-shaped token", so the dead
12.5.0 cannot win. A naive "first version-shaped string in the comments" guard would match
**12.5.0** and **invert the conclusion**.

That trap is not hypothetical, and it is already live in the repository — see §6.2.

### 6.2 An inverted conclusion that is already live in the repository

The trap described above is not hypothetical. ck-doc's **H-12** is this exact failure, already
committed, and independently confirmed here:

| Source | Claim |
|---|---|
| `SECURITY.md:196` | `(allowlist metamask:revoke-raw-rejected, **canary-verified on 13.49.0**)` |
| `SECURITY-7702-THREAT-MAP.md:19` (row 9), `:14` (row 4) | "canary PASS on **13.49.0**" / "canary PASS **13.49.0**" |
| `WALLET_BEHAVIOR_ALLOWLIST.json:38` | `"verifiedOn": "**extension 12.5.0** (2026-08 live harness via Playwright + persistent Chromium)"` |

The allowlist — the file whose stated purpose (`:3`) is to record *"the extension/version they
were verified on"* — records **12.5.0**. The prose asserts **13.49.0**. **The same 13.49.0 figure
is asserted in three places, and in none of them is there any substantiating record in the tree**;
the only instrumented harness result is 12.5.0.

This is a supply-chain-relevant finding, not merely a doc typo, for a reason specific to this
repository's own design: **CI pins the extension to 13.49.0 with a SHA256 constant and a
`manifest.json` identity assertion** (`ci.yml:359`, `:367-369`, `:374-381`). So CI faithfully
tests 13.49.0, and `ci.yml:358-359` keeps a `-v1` cache-key suffix so a 12.5.0 artefact cannot
satisfy the 13.49.0 key. **The allowlist, by contrast, describes behaviour last *verified* on
12.5.0.** A regression introduced in 13.49.0 would be caught by the version-specific locators in
the harness — but the record of *what was verified* would be wrong, and the allowlist is the
artefact a future auditor reads to decide whether a wallet-behaviour claim still holds.

**Why this belongs in a supply-chain audit rather than a docs audit:** it is the same defect class
as the two items above it — a hand-maintained fact that no guard reads, where the pipeline's
*actual* behaviour and the *documented* claim have diverged. The fix is the guard proposed in
P2-11, and a correct guard surfaces this **automatically**: reading the active pin from
`metamask-chrome-….zip` (13.49.0) and comparing it against the allowlist's `verifiedOn` (12.5.0)
fails without anyone having to notice the prose by eye. **ck-doc's H-12 and this audit's P2-11 are
beneficiaries of one guard, not two separate items** — which is the argument for merging the
proposals rather than filing them separately.

Note the ordering dependency this creates: a naive guard that reads the *first* version-shaped
token in the comments would read the dead **12.5.0** and report the opposite conclusion, i.e. it
would "confirm" `SECURITY.md`'s claim while actually confirming the allowlist's. Anchoring on the
release-asset filename, as `metamaskPinFromCi` already does, is what makes the guard safe.

| # | Action | Rationale |
|---|---|---|
| 6 | Cross-check gitleaks/actionlint SHA constants against upstream's published `checksums.txt` (§2.3 snippet). | Defence-in-depth against upstream compromise; the constant stays authoritative. |
| 7 | Consider full GPG verification of gitleaks/actionlint releases. | Closes the provenance gap SHA256 alone does not. Weigh against keyring complexity. |
| 8 | Narrow `secrets.RPC_BASE` from job-level to step-level `env` (`ci.yml:284` → `:303`). | Defence in depth; low practical impact. |
| 9 | Migrate npm publishing from `NPM_TOKEN` to OIDC trusted publishing. | Removes a long-lived credential entirely. |
| 10 | Document the `solc` download trade-off next to `HALMOS_ALLOW_DOWNLOAD` (`ci.yml:312`). | The comment explains *why* the flag is set; add what is and is not verified. |
| 11 | Deliver **`check-manifest-counts.mjs`**, not a recomputed number (Appendix C). Recompute zones C, G, H and `:3` as its first output. | Three of four measurable zones are wrong, and the counts move while parallel edits land. A one-time recompute produces a number that is wrong again within minutes; a guard in CI is true at every instant. Also surfaces the `SECURITY.md` 13.49.0 vs allowlist 12.5.0 inversion automatically (§6.2). |
| 12 | Re-run `check-doc-counts.mjs` on a Foundry-equipped machine. | Its greenness is currently unverified — this machine has no `forge` (Appendix C). |

### Coordination hazard — two sources are editing `docs/STATUS.md`

Flagged by ck-doc and **not** acted on here: `dc-plan` (document-index audit) and `ck-doc` (L1/L2/L3
index work) are both independently proposing additions to the same `STATUS.md` tables in this
round. Concurrent edits to one hand-maintained table will collide, and the loser of the race will
either clobber the other or have their rows reverted.

**Recommendation: team-lead names a single owner for `STATUS.md` this round**, and the other
contributor supplies rows as text rather than editing. The substantive rows are already known:

- this supply-chain report — ck-doc's read is right that it belongs at **L3 (audit artefact)**,
  the same layer as `ISSUES-CATALOG`, **not L4** (L4 is the "why, not what" tier holding
  `WHITEPAPER` / `vault/`);
- the two dc-plan drift items ck-doc independently confirmed — the 30-day plan `:67` "forge 119
  pass" against a real **158 tests / 14 suites**, and the `ci.yml:306` Halmos "6 specs" against a
  real **11 `check_` functions**.

Separately, ck-doc reports one of dc-plan's findings as already stale: the claimed missing
`STATUS.md:47` catalog row is in fact present on that same line. Worth collapsing so it is not
"fixed" twice.

---

## Appendix A — verification commands

Every claim in this document is reproducible from the repository root.

```bash
# S-1: the only unpinned action. Expect exactly one match: publish.yml:58.
# NOTE: this needs grep -E. A plain `grep -vE '@[0-9a-f]{40}'` silently matches nothing
# on some builds (brace quantifier unsupported), which makes the audit look clean.
grep -rEn 'uses:' .github/workflows/ | grep -vE '@[0-9a-f]{40}( |$)'

# S-5: no pull_request_target, no docker:// anywhere
grep -rn 'pull_request_target\|docker://' .github/workflows/ || echo "none"

# S-6/§4.1: permissions blocks
grep -n -A2 '^permissions:' .github/workflows/*.yml

# §1.3: phantom dependencies — viem and vitest are not in the root manifest
node -p "JSON.stringify(require('./package.json').devDependencies)"
grep -n 'from "viem"\|viem/_esm' scripts/generate-vectors.mjs
grep -n 'require.resolve("vitest' scripts/check-runtime.mjs

# §1.5: no duplicate versions (each package must resolve to exactly one entry)
node -e "const l=require('./package-lock.json');
for(const p of ['viem','vitest','typescript','yaml'])
  console.log(p, Object.keys(l.packages).filter(k=>k.endsWith('node_modules/'+p)).length);"

# §5.2: fact-split check — the two declarations must match
grep -rn 'slither-analyzer==\|halmos==\|FOUNDRY_VERSION:' .github/workflows/

# §2: hash verification present in both installers
grep -n 'SHA256\|sha256sum -c' scripts/install-*.sh

# §1.6: install scripts
grep -n 'hasInstallScript' package-lock.json
```

## Appendix B — what was checked and found clean

Recording the negative results explicitly, because "we looked and it was fine" is otherwise
indistinguishable from "we never looked".

- **No unpinned actions** other than `publish.yml:58` — 38/39 SHA-pinned.
- **No `pull_request_target`**, and therefore no `pull_request_target` + checkout-PR-head
  secret-exposure combination.
- **No `docker://` references**, so no unpinned image digests.
- **No unpinned `pip install`** — all three are `==`-pinned.
- **No duplicate package versions** in the lockfile (two `fsevents` entries are darwin-only
  optional deps, not a real duplicate).
- **No hash-unverified binary downloads** except `solc` via halmos, which is a documented
  trade-off.
- **No `git add`-able large blobs** from the installers — both write to `$RUNNER_TEMP`.
- **Permissions already minimal** in both workflows, with a correctly scoped `id-token: write`
  override on the publish job only.
- **The `continue-on-error` waivers are machine-enforced** via `scripts/check-waivers.mjs` against
  a dated register — the strongest gate-integrity property observed in this audit, and the model
  recommended for the SHA-pin and manifest-pin guards above.

## Appendix C — effect of this document on existing gates

Recorded so a reviewer does not have to re-derive it: **adding this file breaks nothing.**

`scripts/check-doc-counts.mjs` is the gate most likely to be sensitive to a new `docs/` file, so
its count sources were checked directly:

| Count source | Derived from | Affected by a new `docs/*.md`? |
|---|---|---|
| `docs/STATUS.md` "vault notes" | `readdirSync("vault").filter(.md).length` (`:591-596`) | **no** — `vault/` is untouched |
| `docs/TROUBLESHOOTING.md` "forge-lint annotations" | Solidity sources under `contracts/` (`:617-622`) | **no** — no `.sol` file was added |
| README / whitepaper test & job counts | `forge --list`, `.github/workflows/*.yml` | **no** — no workflow or test was changed |
| Whitepaper coverage percentages | per-workspace `vitest.config.ts` | **no** |

`STATUS.md` currently claims `22 notes` in three places and the real count is 22;
`TROUBLESHOOTING.md` claims `49 such annotations` and the real count is 49. Both claims match the
current tree.

> **Unverified as of 2026-10-01 (documentation-truthfulness pass):** the two "real count"
> figures above — `22 notes` (STATUS.md) and `49 such annotations` (TROUBLESHOOTING.md) — were
> **not re-measured** in this pass. Neither `STATUS.md` nor `TROUBLESHOOTING.md` is editable by
> this audit slice, and this machine has no Foundry, so neither declared count source
> (`readdirSync("vault")` / Solidity sources under `contracts/`) could be executed. Both
> sentences are **left in place but no longer treated as established fact**; re-run the counts
> before citing them. The "in three places" occurrence count is likewise unverified.
> **Conflict registered:** `docs/VERIFY-FIELD-DESIGN-2026-09-26.md` §7.1 states the repository
> actually holds **56** `forge-lint:` annotations, which directly contradicts the **49** here.
> Both files self-date 2026-09-26 (mtime: SUPPLYCHAIN 11:11Z, VERIFY-FIELD-DESIGN 17:37Z), both
> predate this audit, so **date alone cannot decide which supersedes which**; neither number is
> treated as proven until the count is re-run.

**However — the gate's greenness is NOT verified, and my earlier "both gates are green" was an
overclaim.** This machine has no Foundry: `node scripts/check-doc-counts.mjs` exits **2** with
`could not run forge test --list` / `spawnSync forge ENOENT`. The script never executed its checks.
So what I actually established is only that the *static* inputs I sampled by hand (vault count,
forge-lint annotation count) agree with the claims. Other checks in the same script — the
`forge --list` suite/test counts, the whitepaper and CHANGELOG restatements, the README coverage
percentages — were **never run** and may carry their own drift. **Re-run this gate on a
Foundry-equipped machine before treating any document-count claim in this file as settled.**
Flagged by ck-doc; the correction is his, the credit for catching it is his.

The gate has no rule of the form "every file in `docs/` must be listed in `STATUS.md`", so no index
update is required — but if the team *wants* this report discoverable from the L1/L2 document
index, that is an editorial decision for `ck-doc`/team-lead rather than something this audit
should decide unilaterally.

**Hand-maintained counts in `FILE-MANIFEST.md` are stale — and the file is not this audit's to fix.**
`FILE-MANIFEST.md:3` claims **204 文件 / 34,163 行** (generated 2026-09-25), and the zone table at
`:21-28` carries eight per-zone counts. Neither is machine-checked: `grep` for `FILE-MANIFEST`
across `scripts/` returns no hits and no CI step validates it, so nothing goes red.

My change makes zone H stale by one. Checking on ck-doc's challenge, **the problem is much wider
than the one file I touched** — of the zones that can be measured without a Foundry toolchain,
**three of four are wrong**, and the worst is off by a lot:

| Zone | Scope | Claimed | Actual | Δ |
|---|---|---|---|---|
| B | `contracts/src` + `contracts/script` | 9 (`:22`) | 9 (7 + 2) | ✅ |
| C | `contracts/test` | 18 (`:23`) | **22** | **+4** |
| G | `scripts/` | 20 (`:27`) | **46** | **+26** |
| H | `docs/` + `vault/` + `vectors/` + 白皮书 | 62 (`:28`) | **66** | **+4** |
| `:3` | repo total | 204 | **206** tracked (`git ls-files`) | +2 |

*(Counts taken 2026-09-26 while eight teammates were editing in parallel, so they are a lower
bound that is still rising — the point stands regardless of the exact figure: four of five
numbers are already wrong.)*

Zone G is the substantive one. A "20" for `scripts/` describes a repository that predates most of
this round's work: the current directory holds 46 files, and the delta is almost entirely the
**gate scripts themselves** — `check-waivers.mjs`, `check-runtime.mjs`, `check-vectors.mjs`,
`sync-facts.mjs`, `assurance-inventory.mjs` and their `.test.mjs` companions. A reading baseline
whose per-zone counts are off by 26 in the zone that holds its own enforcement machinery cannot be
used as the "did I read everything" checklist it presents itself as being.

**Why this is worth a full recompute rather than a one-character patch.** My first instinct was
"62→63 only touches one digit, so it's cheap" — ck-doc correctly rejected that framing. The
reason to fix it is not the cost of the edit; it is that **a list whose own baseline is miscalibrated
will not be trusted on any number in it**, and three of four measurable zones being wrong is
exactly the drift class this repository has spent several passes eliminating elsewhere (see
`check-doc-counts.mjs`'s own header). Recompute C, G, H and `:3` together, after the parallel
edits land, so the result is stable.

**Recommended fix, in the spirit of the guards this repo already trusts:**

```bash
# Recompute the zone table from the tree instead of by hand. Run AFTER parallel edits land.
cd /d/SigilKit
printf 'B  %s\n' "$(find contracts/src contracts/script -type f | wc -l)"
printf 'C  %s\n' "$(find contracts/test    -type f | wc -l)"
printf 'G  %s\n' "$(find scripts           -type f | wc -l)"
printf 'H  %s\n' "$(find docs vault vectors -type f | wc -l)"
printf 'tracked %s\n' "$(git ls-files | wc -l)"
```

Better still, add the check to `scripts/` so the counts cannot rot again — a `check-manifest-counts.mjs`
in the shape of `check-waivers.mjs` (pure counters, `file:line` failure output, wired into the
`workflow-lint` job). A hand-maintained reading baseline is the one artefact in this repository
that no guard covers.

`PROJECT-MAP.md` was checked and needs no update: it references `docs/STATUS.md` and
`docs/AC-01-SCRUB-PLAN.md` individually and carries no `docs/` or per-zone total.
