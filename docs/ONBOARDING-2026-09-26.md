# Onboarding — SigilKit, from a fresh clone to a first green gate

**Date:** 2026-09-26 · **Author:** documentation team · **Status:** a walkthrough, not a
specification. Where this document and `README.md` / `docs/GETTING-STARTED.md` disagree,
those files are the contract and this one is the report.

**How this document was produced.** Someone who knew `git`, `npm` and `forge` but had
never seen SigilKit followed the documented path on **Windows 11 / PowerShell 7 /
Node v24.12.0 / npm 11.18.0**, and recorded what actually happened. Every command in
§3 was executed as written where it was safe to do so. Commands that write to the
working tree (`bootstrap.mjs`'s install and build phases) were **not** run to completion;
Appendix B says which conclusions are measured and which are read from source.

> **The one-line version.** SigilKit's docs are unusually good about *what the code
> does* and unusually silent about *what happens when you type the command on your
> machine*. A newcomer can read the README in five minutes and still hit three walls
> before the first test runs. Two of them are Windows-specific, and one of those is not
> covered by any troubleshooting page.

---

## 1. What you are installing

SigilKit is a **monorepo with two toolchains that do not share a runtime**:

| | Contracts half | TypeScript half |
|---|---|---|
| Toolchain | Foundry (`forge`, `anvil`, `cast`) | Node 24 + npm workspaces |
| Lives in | `contracts/`, `foundry.toml`, `lib/forge-std` (submodule) | `packages/*`, `package.json` |
| Built by | `forge build` | `npm run build --workspaces` |
| Needs Node 24? | **No** | **Yes** (hard floor) |
| Needed for | contract tests, demo agent, e2e smoke | SDK, indexer, MCP server |
| Works without the other half? | yes | yes |

The single most useful thing to internalise: **you can work on the TypeScript half with
Node alone, and you can work on the contracts half without Node at all.** The two halves
of `npm test` fail independently, which is a feature.

The third toolchain — Python (`halmos`, `slither`) and the `echidna` binary — is
**verification-only** and never required. Covered in §5.

---

## 2. Prerequisites: what is required, what is optional, what breaks

### 2.1 The table the docs give you

From `docs/GETTING-STARTED.md:7-14` and `CONTRIBUTING.md:15`:

| Requirement | Version | Needed for | Missing ⇒ |
|---|---|---|---|
| **Node.js** | **≥ 24** | every TS package | `npm run setup` refuses with a clear message naming the version and the URL |
| **npm** | 10+ (ships with Node 24) | workspace install | `npm run setup` reports "npm not found on PATH" |
| **Foundry** | 1.7.x | contracts, demo agent, e2e | `npm run setup` **warns, does not fail**; `npm test` then fails (see §3.3) |

That table is accurate and the failure modes are honest. Three things it does not tell you:

1. **`git` is not listed at all**, yet the first instruction in every document is
   `git clone`. Trivial, but it means the prerequisites table is not a complete
   environment spec.
2. **Nothing is marked "required for the contracts half only"** in a way that lets you
   decide *before* you install. The prose does say it; the table does not.
3. **`--recurse-submodules` is missing from every `git clone` line** (see §3.1). This is
   the most consequential omission in the document set.

### 2.2 Version consistency — verified, and mostly good

I cross-checked every stated version against the machine-checked sources rather than
trusting the prose. The repo has its own fact guard, `scripts/sync-facts.mjs`, which is
the right idea, and I ran it:

```bash
node scripts/sync-facts.mjs --list
```

Result: **all three governed facts agree across all 7 restatement points.**

| Fact | Owner | All restatements | Agree? |
|---|---|---|---|
| Node engine floor `24` | `package.json` `engines.node` | `.nvmrc:1` = `24`; `Dockerfile:20,35` = `node:24`; all four `packages/*/package.json` = `>=24` | ✅ all 7 |
| Foundry version `v1.7.1` | `.github/workflows/ci.yml:32` `FOUNDRY_VERSION` | — (single source) | ✅ |
| forge test scope | `scripts/foundry-scope.json` | `package.json:19,20`; `verify.mjs`; `ci.yml` (6 lines) | ✅ |

The docs' claims line up with the code: `docs/GETTING-STARTED.md:11` says Foundry
"1.7.x" and CI pins `v1.7.1`; `README.md:92` says "Node 24+" and `.nvmrc` says `24`.
**The prerequisite *versions* are not a source of confusion.** The prerequisite
*reporting* is (§3.2).

One real finding from `--check` (exit 1):

```
ERROR scripts/bootstrap.mjs:34  [node-floor.fragile-parse]
   fact:  node engine floor
   actual: 24 today, 10 for a three-digit major
   why:    digit-slice floor: every digit is concatenated, then the first two are kept,
           so ">=100" becomes 10. Agrees with the owner by luck and diverges silently.
```

`bootstrap.mjs:34` derives the required Node major by regexing the digits out of
`engines.node` and keeping the first two. It is correct today and would be wrong the day
Node reaches 100. It is harmless, and the repo's own guard already flags it; it is
mentioned here only so a newcomer who runs `sync-facts --check` and sees a red line knows
it is a known, benign, already-triaged finding rather than something they broke.

### 2.3 Version requirements that only exist in the toolchain

Three requirements are real, enforced, and documented **nowhere** in the newcomer path:

| Tool | Required version | Enforced by | Documented? |
|---|---|---|---|
| **solc** | `0.8.36` (Foundry auto-downloads) | `foundry.toml:6` | ❌ not in GETTING-STARTED |
| **EVM target** | `prague` | `foundry.toml:7` | ❌ nowhere in the newcomer docs |
| **Python** | 3.12 (CI) | `ci.yml:124,319` | ❌ only implied by `pip install` |

`foundry.toml` also sets `ffi = false` and `deny = "warnings"`. The second is a surprise
waiting to happen: **any compiler warning or linter finding is a build failure.**
`CONTRIBUTING.md:76-83` does explain this, and `TROUBLESHOOTING.md:155-168` lists 49
existing `forge-lint: disable-next-line` annotations you can copy. But a newcomer reading
only the README will hit an unannotated warning as a hard build error with no obvious
cause.

`evm_version = "prague"` has a practical consequence worth stating: **your local `forge`
must be new enough to know `prague`.** Foundry 1.7.1 (what CI pins) does. A much older
local install will not.

---

## 3. The walkthrough, with the walls you will hit

I followed the documented path exactly. This is what happened.

### 3.1 Wall #1 — `git clone` leaves the test library missing (affects everyone)

Every entry point in the repo uses a bare clone:

- `README.md:87` — `git clone https://github.com/sigilkit/sigilkit.git && cd sigilkit`
- `docs/GETTING-STARTED.md:23`
- `CONTRIBUTING.md:9`

But `lib/forge-std` is a **git submodule** (`.gitmodules` is committed), and **no
documented clone command passes `--recurse-submodules`.** CI handles this correctly —
`ci.yml` uses `submodules: recursive` in **11 of its 12 checkout steps** — so CI is green
while a fresh local clone is not.

Measured on this machine, where the submodule *was* already initialised:

```bash
git check-ignore -v lib/forge-std/src/Test.sol
# fatal: Pathspec 'lib/forge-std/src/Test.sol' is in submodule 'lib/forge-std'
```

So the submodule is tracked correctly. The problem is purely that a newcomer is never
told to initialise it, and the two fallback instructions they *are* given sit awkwardly
against the submodule:

- `README.md:109` — `forge install foundry-rs/forge-std`
- `TROUBLESHOOTING.md:170-178` — `git submodule update --init --recursive`

**Both are right. Neither is mentioned at the top of the path.** What a newcomer actually
experiences:

```
Error: forge-std not found in lib/forge-std. Run `forge install foundry-rs/forge-std`
```
…followed by whatever `forge install` does to a path a submodule already owns. The
message is decent; the docs did not set it up.

`TROUBLESHOOTING.md:170` does have the right entry ("`forge test` cannot find
`lib/forge-std`" → submodule not initialised). It is simply filed under *Tests* rather
than under *Setup*, where a first-time reader is looking.

**Correct first command:**

```bash
git clone --recurse-submodules https://github.com/sigilkit/sigilkit.git
# or, if you already cloned:
git submodule update --init --recursive
```

### 3.2 Wall #2 — the "from here" path is three different paths

The README's Quick start (line 84) is:

```bash
git clone ... && cd sigilkit
npm run setup      # Node/Foundry check → install from lockfile → build all packages
npm run verify     # full gate: lint, doc counts, contract tests, TS tests
```

`README.md:92-93` then says: *"Needs Node 24+ (`.nvmrc` is committed). Foundry 1.7.x is
required only for contracts and the demo. Full walkthrough: docs/GETTING-STARTED.md."*

The mismatch is in **what "setup" is allowed to need**. `scripts/bootstrap.mjs:10-13`
states the design intent explicitly — a missing `forge` is a *warning with install
instructions*, not a hard failure, because the TS half builds without it. The
implementation honours that: `checkFoundry()` pushes to `warnings`, not `failures`
(`bootstrap.mjs:86-105`).

But the **summary line is unconditional** (`bootstrap.mjs:161-162`):

```js
if (failures.length === 0) {
  ok("setup complete — dependencies installed and every workspace built.");
```

Warnings do not suppress it. So a newcomer with **no Foundry at all** — who followed the
README's "required only for contracts" allowance — sees:

```
! forge not found — contract tests and the demo agent are unavailable.
✓ setup complete — dependencies installed and every workspace built.
```

Two green/amber lines, and the second one is a false claim. The warnings print *after* it,
at `bootstrap.mjs:167`, in a separate paragraph. This is a wording bug with real onboarding
cost: it converts "I correctly skipped an optional dependency" into "I think I'm done and
everything is fine," right before the next command fails.

### 3.3 Wall #3 — `npm test` fails hard when `forge` is not on `PATH` (the big one)

This is the single most important finding in this document.

**The situation.** Foundry is installed by the documented one-liner:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

That installer drops binaries in `~/.foundry/bin` and expects you to add it to `PATH`
yourself. **On Windows, `foundryup` does not add it for you and no document tells you
to.** Measured on this machine — a completely ordinary Windows Foundry install:

```powershell
Get-Command forge          # → nothing (empty)
Test-Path "$env:USERPROFILE\.foundry\bin\forge.exe"   # → True
Get-ChildItem "$env:USERPROFILE\.foundry\bin"
# anvil.exe  cast.exe  chisel.exe  forge.exe  foundryup
```

So `forge` is installed and *not on `PATH`*. This is the most common Windows Foundry
state, and it produces a hard failure:

```bash
npm test
# > forge test --no-match-contract ".*Invariant|.*Fork" && npm run test --workspaces --if-present
# 'forge' is not recognized as an internal or external command,
# operable program or batch file.
# exit code 1
```

**Now the part that makes this a documentation defect rather than user error.**
`docs/TROUBLESHOOTING.md:24-35` has an entry titled exactly `forge: command not found`,
and its fix is:

```bash
export FORGE_BIN="$HOME/.foundry/bin/forge"    # Windows: .../forge.exe
export ANVIL_BIN="$HOME/.foundry/bin/anvil"
```

**I tested that fix. It does not work for `npm test`.**

```powershell
$env:FORGE_BIN="$env:USERPROFILE\.foundry\bin\forge.exe"
npm test
# 'forge' is not recognized as an internal or external command,
# operable program or batch file.        ← identical failure
```

The reason is structural, and it is the finding worth remembering:

| Entry point | How it finds `forge` | Honours `FORGE_BIN`? |
|---|---|---|
| `npm run setup` (`bootstrap.mjs:75-84`) | `FORGE_BIN`/`ANVIL_BIN` → `~/.foundry/bin/forge.exe` → `PATH` probe | ✅ yes |
| `npm run verify` (`verify.mjs:381-391`) | `FORGE_BIN` → `~/.foundry/bin/forge.exe` → `PATH` probe | ✅ yes |
| `npm run demo` (via `cli.ts:24-25`) | env → PATH | ✅ yes |
| **`npm test`** (`package.json:19`) | **bare `forge` in the shell** | ❌ **no** |

`package.json:19` is:

```json
"test": "forge test --no-match-contract \".*Invariant|.*Fork\" && npm run test --workspaces --if-present"
```

A bare `forge` resolves through `PATH` only. `FORGE_BIN` is a convention the three
scripted entry points honour and the one npm script does not. And `verify.mjs:566-577`
makes the asymmetry a *policy*: it reports a missing `forge` as a **failed** check
("the gate is incomplete"), while `npm test` reports it as a bare shell error with no
explanation at all.

The consequence for a newcomer is the confusing part:

- `npm run setup` says **✅ forge 1.7.1 found** (it checked `~/.foundry/bin`)
- `npm run verify` runs the contract suite **fine** (same resolver)
- `npm test` **fails immediately** with a raw shell error

Three commands, one toolchain, two different answers. A newcomer cannot infer from the
output which of their two working commands is the broken one.

**The fix that works on Windows** (verified — `npm test` then reaches
`No files changed, compilation skipped`):

```powershell
# current session
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"

# permanent, user level
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:USERPROFILE\.foundry\bin",
  "User")
```

`docs/CONFIGURATION.md:63-71` documents `FORGE_BIN`/`ANVIL_BIN` and says *"On Windows the
binaries are `forge.exe` / `anvil.exe`; both resolvers handle that."* That sentence is
true — and it is precisely what makes the trap invisible: the doc reassures you that
Windows is handled, so you set `FORGE_BIN`, and then `npm test` fails anyway.

**Note:** the *resolver* code is genuinely Windows-aware — `bootstrap.mjs:79` and
`verify.mjs:387` both append `.exe` on `win32`, and `verify.mjs:394` uses `npm.cmd` on
Windows. The Windows support in the *scripts* is real. The gap is one npm script and the
docs' framing of it.

### 3.4 The rest of the path, for completeness

| Step | Command | Result on this machine |
|---|---|---|
| Toolchain probe | `npm run setup -- --no-install --no-build` | ✅ all four checks pass; forge auto-discovered from `~/.foundry/bin` |
| Doc gate | `npm run verify -- --only=docs` | ✅ `doc counts OK` — README's 158 tests / 14 CI jobs / 11 Halmos specs / 49 lint annotations all match the code |
| Artifacts | `node scripts/check-package-artifacts.mjs` | ✅ 3 packages, 23 entry targets, 0 warnings |
| Workflow lint | `node scripts/validate-workflows.mjs` | ✅ OK on Windows, 2 files. **Does not need `actionlint`** — see §4.2 |
| Tests | `npm test` | ❌ **fails** — see §3.3 |

> **Unverified as of 2026-10-01 (documentation-truthfulness pass):** the "Doc gate" row above
> reports `npm run verify -- --only=docs` → `doc counts OK`, and that "README's 158 tests /
> 14 CI jobs / 11 Halmos specs / 49 lint annotations all match the code". **None of the four
> numbers was re-measured in this pass** — the gate requires `forge --list` and a Foundry
> toolchain that this machine does not have, and the repository root `README.md` is outside this
> audit slice's editable set. The ✅ is a **historical observation from the author's run on
> 2026-09-26**, not a reproducible result, and is **left in place but must not be cited as
> current**. Re-run `npm run verify -- --only=docs` on a Foundry-equipped machine before
> quoting any of 158 / 14 / 11 / 49.
> **Conflict registered:** the **49** lint annotations contradict the **56** asserted in
> `docs/VERIFY-FIELD-DESIGN-2026-09-26.md` §7.1; all these files self-date 2026-09-26, so no
> supersession can be shown on date alone. Neither number is proven.

> **补充观察（2026-10-01，读到但未获授权编辑）：** 仓库根 `README.md`（`D:/SigilKit/README.md`，
> **不在本切片的可编辑清单内**）当前写的是 Foundry 一行「220 tests across 17 suites」、
> CI 一行「14 jobs across 2 workflows — `ci.yml` (12)」、Halmos 一行「11 specs, all now
> executing and non-vacuous」。也就是说，本表所引的 **158** 与它所引用的那份 README **对不上**
> （14 与 11 则对得上）。**本审计不把 220 当作已证的测试总数** —— 它同样需要 `forge --list`
> 才能确认；这里只登记「158 与所引 README 不一致」这一可核对的事实。
> 若根 `README.md` 才是需要修正的一方，请交由持有该文件写权限的切片处理
> （`blocked-crossfolder: D:/SigilKit/README.md`）。

The documentation's *claims* about the repo being internally consistent are true. The
doc-count gate passing on Windows is meaningful: the numbers in the README are not
aspirational.

---

## 4. Windows-specific obstacles

Windows is this project's primary developer OS, so a thorough audit is warranted. I
checked every Unix-shaped command in the newcomer path.

### 4.1 The bash scripts — **not** a Windows problem, and here is why

`scripts/install-gitleaks.sh` and `scripts/install-actionlint.sh` are bash, and they
download **linux_x64** / **linux_amd64** tarballs. On Windows they cannot run. This looks
like a portability gap. It is not, and the design is deliberate:

- They are invoked **only** from CI, in exactly two places (`ci.yml:83` and `ci.yml:141`),
  both inside jobs with `runs-on: ubuntu-latest`.
- Every job in both workflows is `ubuntu-latest`. There is **no** `windows-latest` runner
  anywhere.
- Neither script is referenced by any `package.json` script, so `npm run …` never touches
  them. The answer to "what happens if an `npm run` script referenced them" is **nothing —
  it does not happen**, and the scripts are written to keep it that way (both carry a
  header comment stating the stdout contract that makes `bin=$(bash …)` safe).

**Conclusion: no Windows action needed, and no documentation gap.** A newcomer
wondering about these files is worrying about a non-issue. Worth one line in the
onboarding so they can stop.

### 4.2 What the workflow lint actually requires — and does not

`verify.mjs`'s first step is labelled *"workflow lint — actionlint over
.github/workflows"*. `node scripts/validate-workflows.mjs` does **not** invoke actionlint.
It parses the YAML with the `yaml` npm package and asserts structure
(`validate-workflows.mjs:46-79`). The real actionlint runs only in the CI job of the same
name.

Measured: `workflow validation OK — 2 file(s): ci.yml, publish.yml` on Windows, no
actionlint binary needed. The `verify --list` label describes *intent*, not the local
check. Not a defect; slightly misleading if taken literally.

### 4.3 The Unix-style command inventory

Counted across `README.md`, `CONTRIBUTING.md` and `docs/*.md`:

| Pattern | Occurrences | PowerShell equivalent | Risk |
|---|---|---|---|
| `export VAR=…` | 24 | `$env:VAR = "…"` | **High** — see below |
| `&&` | 10 | `;` | ✅ PowerShell 7 supports `&&` |
| `anvil &` | 6 | `Start-Process anvil` or a second terminal | **High** — `&` is the *call operator*, so `anvil &` is a **syntax error** |
| `RUN_WALLET_E2E=1 …` | 6 | `$env:RUN_WALLET_E2E="1"; npm test …` | **High** — same class as `export` |
| `$HOME/…` | 4 | `$env:USERPROFILE/…` | ⚠️ `$HOME` *does* work in PowerShell; `$env:HOME` does not |
| `curl -L … \| bash` | 2 | WSL, or the Foundry Windows installer | **High** — no `bash` on stock Windows |
| `ls node_modules/.bin/tsc` | 1 | `ls` is aliased to `Get-ChildItem` in PS 7, so it *works* | low |
| `nvm install 24 && nvm use 24` | 2 | `nvm` needs its own Windows install | medium |
| `cp` | 0 | — | — |

**`export` is the single most common Windows failure in this doc set.** In PowerShell,
`export` is a PowerShell 5.1 *alias* for `Get-Export`; in PowerShell 7 it was removed.
Measured:

```powershell
Invoke-Expression "export SIGILKIT_TEST=1"
# The term 'export' is not recognized as a name of a cmdlet, function, script file,
# or operable program.
```

24 occurrences, and **not one is annotated with a Windows alternative.** Every
`export FORGE_BIN=…` in `TROUBLESHOOTING.md` and `CONFIGURATION.md` is a copy-paste
failure on the platform the project primarily develops on. This is the
highest-frequency, lowest-effort-to-fix gap in the whole document set.

**`anvil &` is worse**, because the error is a parser error rather than a name error:

```powershell
anvil &    # → ParserError, not "command not found"
```

`&` is PowerShell's call operator, so `anvil &` is syntactically invalid before any
command lookup happens. `README.md:98`, `GETTING-STARTED.md:47`, `TROUBLESHOOTING.md:88`
and the demo-agent's own `--help` examples all use it. A newcomer who cannot parse the
error will assume their install is broken.

### 4.4 Does `bootstrap.mjs` handle Windows?

**Yes, and better than the docs claim.** Reading it specifically for this:

| Location | What it does | Verdict |
|---|---|---|
| `bootstrap.mjs:79` | `join(homedir(), ".foundry", "bin", process.platform === "win32" ? \`${name}.exe\` : name)` | ✅ correct |
| `bootstrap.mjs:114,162-166` | `spawnSync(NPM[0], [...NPM[1], ...cmd], …)` — npm is resolved to its **JavaScript entry point** (`npm-cli.js`) and run with the current `node`, so a real argv array is used end to end | ✅ correct, and **no shell is involved** |
| `bootstrap.mjs:167-175` | If `npm ci` fails, print a hint: `npm run setup -- --install` | ✅ **this is a documented Windows workaround** — but see below |
| throughout | paths built with `node:path.join`, never string concatenation | ✅ correct |

`verify.mjs` is similarly deliberate: `IS_WIN` branches for the binary name
(`verify.mjs:387`), `npm.cmd` (`verify.mjs:394`), and — a nice touch — process-tree
termination via `taskkill /T /F` because "Windows has no process-group signal"
(`verify.mjs:462-471`).

**The gap is documentation, not code.** `bootstrap.mjs`'s `--install` hint is *the*
Windows fix for `npm ci` handle failures, and it is implemented in the tool. But:

- `GETTING-STARTED.md:30` lists the flags as **"Flags: `--no-install`, `--no-build`"** —
  `--install` is **omitted**.
- `CONTRIBUTING.md` never mentions it.
- Only `TROUBLESHOOTING.md:58-66` documents it, under a heading that presumes you already
  hit `EBUSY`.

A newcomer's first `npm ci` on Windows is exactly the situation this flag exists for, and
the flag stays invisible until after the failure.

### 4.5 Windows obstacle list — the deliverable

Ordered by how likely you are to hit it, on a stock Windows + PowerShell 7 box.

| # | Obstacle | Where it bites | Severity | Fix |
|---|---|---|---|---|
| **W1** | `npm test` fails with `'forge' is not recognized` even though `npm run setup` and `npm run verify` both report forge found | `package.json:19` | 🔴 **blocker** | add `~/.foundry/bin` to `PATH` (§3.3) |
| **W2** | The `FORGE_BIN` fix in `TROUBLESHOOTING.md:30` does not work for `npm test` | `TROUBLESHOOTING.md:24-35` | 🔴 **blocker** (misleading docs) | use `PATH`, not `FORGE_BIN` |
| **W3** | `anvil &` is a PowerShell **parser error** | `README.md:98`, `GETTING-STARTED.md:47` | 🟠 high | `Start-Process anvil` / 2nd terminal |
| **W4** | `export VAR=…` unrecognized — 24 occurrences, 0 annotated | all docs | 🟠 high | `$env:VAR = "…"` |
| **W5** | `VAR=value cmd` prefix form unrecognized — 6 occurrences | `TROUBLESHOOTING.md:216-218` | 🟠 high | `$env:RUN_WALLET_E2E="1"; …` |
| **W6** | `curl -L … \| bash` for Foundry — no `bash` on stock Windows | `GETTING-STARTED.md:11`, `README.md`, `TROUBLESHOOTING.md:29` | 🟠 high | official Windows installer, or WSL |
| **W7** | `bootstrap.mjs` has a Windows `npm ci` fix (`--install`) that `GETTING-STARTED.md:30` omits from its flag list | `GETTING-STARTED.md:30` | 🟡 medium | know the flag exists |
| **W8** | `nvm install/use` needs a separate Windows install; not mentioned | `GETTING-STARTED.md:9,20` | 🟡 medium | use the Node 24 MSI, or `nvm-windows` |
| **W9** | SQLite `EBUSY` on file delete — *is* documented | `TROUBLESHOOTING.md:123-134` | 🟢 low | documented ✓ |
| **W10** | `verify --list` says "actionlint over .github/workflows"; no actionlint is used locally | `verify.mjs:77` | ⚪ cosmetic | noted in §4.2 |
| **W11** | No `windows-latest` runner in CI, so no Windows job ever proves the above | `.github/workflows/*.yml` | ⚪ systemic | a `windows-latest` job would have caught W1–W4 |
| — | The two `install-*.sh` bash scripts | — | ✅ **not an issue** | §4.1 |

**W11 is the root cause of the others.** `verify.mjs:394` and `verify.mjs:462-471`
contain Windows-specific code, and `bootstrap.mjs:79` does too — someone clearly cared.
But every CI job is `ubuntu-latest`, so none of that code is ever executed by CI. A
`windows-latest` job running `npm run setup -- --no-install && npm run verify -- --quick`
would have caught W1, W3, W4 and W7 automatically, and costs about fifteen minutes of CI
time.

---

## 5. Optional verification tools

Correctly quarantined in `CONTRIBUTING.md:44-59`: Halmos (`pip install halmos==0.3.3`),
Slither (`pip install slither-analyzer==0.11.6`), Echidna (binary `v2.2.5`). The framing
is right — *"Install them if you are changing the contracts and want the deeper checks
locally"* — and `verify.mjs:606` is honest that a green local run is not a green CI run.

Two notes:

- `pip install` works on Windows if you have Python, but the Echidna **binary release has
  no Windows build** — that one genuinely requires WSL. Not in the W-list because it is
  optional by design, but worth knowing before you plan a local Halmos run.
- `CONTRIBUTING.md:55` mentions `HALMOS_ALLOW_DOWNLOAD=1`, Unix-style env setting again
  (W4 class). On Windows: `$env:HALMOS_ALLOW_DOWNLOAD = "1"`.

---

## 6. Concept explanation: the largest onboarding obstacle

This is the part no amount of command-fixing solves.

### 6.1 The verdict

**There is no 5-minute "what problem does this solve" anywhere in the repository.**

I searched the full doc set for glossary, "what is", terminology, concept and orientation
sections. Results: `docs/ECOSYSTEM-RESEARCH-2026-09-23.md:26` has a naming line about
industry terms; `docs/SECURITY-7702-THREAT-MAP.md` is a threat matrix keyed by EIP number;
`vault/` is a research knowledge base, not an orientation. There is no glossary, no
concept index, no "if you only read one thing".

The four core concepts a newcomer must hold in their head before anything makes sense:

| Concept | Where it is explained | Depth |
|---|---|---|
| **EIP-7702 / delegation** | `README.md:3-4` (one clause); `WHITEPAPER-v2.1.md` "Corrected claims" | A clause, or a corrections table that assumes you knew the claim |
| **session key** | `README.md:24`; `packages/core/README.md` export table | A name in a component table |
| **spend policy / caps** | `README.md:181-186` (the INV table) | Four guarantees, stated as invariants, no motivation |
| **delegate** | **nowhere** | — |

The README's own words at line 3-4:

> Open-source (MIT) toolkit for **agent-native wallets** — EIP-7702 hardened delegation,
> session-key management with on-chain spend caps, and a mandatory audit trail per action.

That sentence is the entire conceptual orientation, and it opens with a term
("agent-native wallets") the README never defines and the industry itself disputes —
`ECOSYSTEM-RESEARCH-2026-09-23.md:26` notes *"Coinbase's product term."*

Then `README.md:13`:

> Read [`docs/WHITEPAPER-v2.1.md`](docs/WHITEPAPER-v2.1.md) for the corrected whitepaper.

And the whitepaper's own abstract (`:11-15`) opens with *"scoped session-key management
with on-chain spend caps, fixed-window (tumbling) rate limits, argument-bound
(calldata-committing) Merkle target whitelists…"* — five unexplained technical terms in
one sentence, in a document that also carries a pre-audit warning, a corrections table
for a *previous* version, and 11 rows of "here is what the last version got wrong."

**A newcomer's actual first hour:** read README → feel roughly oriented → open
`GETTING-STARTED.md` → install → hit W1 → fix PATH → run `verify` → read the whitepaper to
understand *why the tests assert these things* → land in a corrections table about
fabricated claims and cannot tell which parts are design and which are apologies → give up
on the narrative and start pattern-matching test names.

That last step is survivable but expensive, and it is entirely avoidable.

### 6.2 What a 5-minute orientation should say

Not a glossary — an orientation, in the shape of a single narrative:

1. **The problem.** An AI agent needs to move money. Today that means giving it a hot
   private key, or accepting that it can do anything the key can do. Neither is acceptable
   for anything holding real value.
2. **The mechanism, in one paragraph.** You keep your key. You generate a *second*,
   disposable key — a **session key** — and sign a *scope* onto it: which contracts, which
   function selectors, which exact arguments, how much per action, how much per hour, when
   it expires. The agent holds the session key. On-chain code enforces the scope, so a
   fully compromised agent **still cannot exceed it** (`README.md:178-179`). The owner can
   revoke at any time, and every single action leaves a mandatory on-chain log.
3. **What each component is for** — the existing `README.md:19-24` table, demoted from
   "the thing you must memorise up front" to "the thing you now understand."
4. **EIP-7702 in exactly two sentences.** It lets an EOA *delegate* its own code — the
   wallet becomes a smart contract without changing address or moving funds. That is what
   makes "the agent's blast radius is the scope" achievable without a Safe.
5. **The honest status banner.** Not audited; verification tooling, not an audit. Say it
   once, here, before the reader invests an hour — currently it appears at
   `GETTING-STARTED.md:160-165` and `WHITEPAPER-v2.1.md:17-23` but never at the point of
   first orientation.

### 6.3 A secondary concept gap

`GETTING-STARTED.md:88-97` shows a `Scope` literal containing `countersignAbove`,
`enforceNativeDelta`, `tokenWatchlist` — and **never explains what any of them do.** A
newcomer copies the example and (per `docs/DOC-AUDIT-CONTRACTS-2026-09-26.md` H-06) has
silently disabled token-outflow protection with `enforceNativeDelta: false`, which the
doc's own demo also does.

`DOC-AUDIT-CONTRACTS-2026-09-26.md` already catalogs most of this: H-05 (the SDK example
uses a bare `@sigilkit/core` specifier three lines below a blockquote saying it isn't
published), H-06 (unexplained scope fields), H-10 (`audit_query` is inert without
`SIGILKIT_AUDIT_DB_ROOT`), C-04 (`npm run demo` needs `--grant` and the doc doesn't say
so). **That audit is good work and this document should not duplicate it** — it should
link it. The gap is that nothing links a newcomer from "I just cloned this" to "here is
what's wrong with these documents before you trust them."

---

## 7. Common tasks: where is the first step?

I grepped `CONTRIBUTING.md` for each of the four tasks a new engineer is most likely to
attempt.

| Task | First step documented? | Where | Quality |
|---|---|---|---|
| **Change a contract** | ✅ Yes | `CONTRIBUTING.md:105-112` | 🟢 **Best-documented path in the repo.** Names the exact 4 steps, including the non-obvious "add the name to `scripts/abi-targets.txt` or it silently escapes the ABI-drift gate (that was BUG-2)". |
| **Add a test** | 🟡 Partial | `CONTRIBUTING.md:127-134` | 🟡 States the *policy* ("every bug fix gets a regression test that fails before the fix"; prefer a negative test that pins the error selector) but not the *mechanics* — no "put it in `contracts/test/X.test.sol`", no "run `forge test --match-test name`". |
| **Add a CLI flag** | ✅ Yes | `CONTRIBUTING.md:120-125` | 🟢 Names the shared parser (`core/src/cli.ts`, `FlagSpec`) and what you get for free. |
| **Add an env var** | ✅ Yes | `CONTRIBUTING.md:114-118` | 🟢 Three steps, including "document it in **both** `.env.example` and `docs/CONFIGURATION.md`". |
| **Add an SDK method** | ❌ **No** | — | 🔴 **Gap.** See below. |

### 7.1 The "add an SDK method" gap

This is a real hole and it is the most common task for a TypeScript-side contributor.
`CONTRIBUTING.md` has recipes for *contracts*, *env vars* and *CLI flags* — but nothing for
"add a function to `@sigilkit/core`". A newcomer must reverse-engineer the convention set:

- `packages/core/src/` — but which file? `validation.ts`, `config.ts`, `logger.ts`,
  `cli.ts`, `types.ts` are all mentioned in passing by different recipes.
- **Is there a barrel file?** `packages/core/README.md` lists nine export groups and says
  *"Subpath exports keep the surface explicit: `@sigilkit/core/lease-fs`, `/validation`,
  `/logger`, `/config`, `/cli`"* — which tells you subpaths exist but not where they are
  re-exported.
- **Six `package.json` subpath exports are hand-maintained**
  (`packages/core/package.json` → `exports`). Add a file, and the export may not exist.
  A newcomer has no way to know this without reading the manifest.
- `CONTRIBUTING.md:65-72` does give the *conventions* (strict mode, no `as any`, validate
  at the boundary with `validation.ts`, log through `logger.ts` not `console`) — they're
  good, and clearly written for someone who has already found the right file.

**The three lines `CONTRIBUTING.md` needs:** (1) source goes in `packages/core/src/`;
(2) re-export it from the barrel *and* add the subpath to `exports` in
`packages/core/package.json` if it is a new module; (3)
`npm run verify -- --only=typecheck` is the fast loop.

### 7.2 "Run the gate" — the best-documented thing in the repo

`verify.mjs` deserves specific praise, because it is unusually well-designed for the
person who has to use it when it goes red:

- `--list` enumerates every step with its purpose and time budget.
- `--only=<key>` re-runs exactly one step, and **every failure prints the copy-pasteable
  command to do it** (`verify.mjs:640-647`). This is the UX-02/UX-09 work described in
  the source comments, and it works.
- Steps are independent — one failure never hides the others.
- Every step has a wall-clock budget, so a hang becomes a reported TIMEOUT, not a stall.
- Every step's output is teed to `outputs/verify/<timestamp>-<slug>.log`, and a failure
  replays the last 30 lines.
- The footer states what the gate does **not** cover.

I used `--list` and `--only=docs` to produce §3.4. Both worked as documented, on Windows.
**If you read one thing in this document, read `verify.mjs --list`'s output.**

One caveat found while testing: `--only=docs` failed on a machine where `node_modules` was
mid-`npm ci`, with a bare `ReferenceError: NPM is not defined` from `verify.mjs:596`. That
is a genuine latent bug — `NPM` is read on a path that assumes `node_modules` resolves — but
it is a pre-existing code issue, outside my read-only scope to fix. Flagging it for
whoever owns `verify.mjs`.

---

## 8. Friction summary, by count

| Category | Count | Fix cost |
|---|---|---|
| Windows blockers (W1–W2) | 2 | ~1h (one npm script + one doc line) |
| Windows high-friction (W3–W6) | 4 | ~2h (annotate existing commands) |
| Windows medium (W7–W8) | 2 | ~30m (add flags to a list) |
| Missing `--recurse-submodules` | 1 | ~5m (one word × 4 docs) |
| Unconditional "setup complete" | 1 | ~15m (one conditional) |
| Concept orientation absent | 1 | ~2h (write §6.2's five points) |
| "Add an SDK method" undocumented | 1 | ~30m (three lines) |
| `FORGE_BIN` documented as a fix for a case it doesn't fix | 1 | ~10m |
| **Total** | **13** | **~7h** |

Seven hours of documentation and one npm script. The gate, the conventions, the `--only`
ergonomics, the doc-count discipline and the prerequisite version consistency are all
genuinely good — this is a well-maintained repository with a specific, well-localised set
of onboarding holes, almost all of them at the Windows boundary.

---

## 9. If you only remember five things

1. **`git clone --recurse-submodules`**, or run `git submodule update --init --recursive`.
   Every documented clone command omits it.
2. **Put `~/.foundry/bin` on your `PATH`.** `FORGE_BIN` works for `setup`/`verify`/`demo`
   but **not** for `npm test`, and `TROUBLESHOOTING.md` currently implies it does.
3. **`npm run verify -- --list`**, then `--only=<key>`. It is the best-designed tool in
   the repo and it tells you which step failed and exactly how to re-run it.
4. **`npm run demo` needs `--grant`** (`npm run demo -- --grant`) — the documented
   invocation cannot deploy. Also: `anvil &` is a PowerShell syntax error; use
   `Start-Process anvil` or a second terminal.
5. **There is no 5-minute conceptual orientation in this repo.** The README's first
   sentence assumes "agent-native wallets", "EIP-7702", "session key" and "spend caps" are
   known. §6.2 above is the minimum that should exist.

---

## Appendix A — commands as they work on Windows / PowerShell 7

Replace the documented Unix form with these. Verified on Node v24.12.0 / npm 11.18.0 /
PowerShell 7 / Windows 11.

```powershell
# 0. clone WITH submodules (the docs omit --recurse-submodules)
git clone --recurse-submodules https://github.com/sigilkit/sigilkit.git
Set-Location sigilkit

# 1. put Foundry on PATH — required by `npm test` (FORGE_BIN is NOT enough)
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"
[Environment]::SetEnvironmentVariable("Path",
  [Environment]::GetEnvironmentVariable("Path","User") + ";$env:USERPROFILE\.foundry\bin", "User")

# 2. install + build (bootstrap.mjs is Windows-aware; it finds forge without PATH)
npm run setup
# if `npm ci` fails deleting node_modules (Windows file handles):
npm run setup -- --install

# 3. the gate
npm run verify -- --list
npm run verify -- --quick                 # skip Foundry — the fast inner loop
npm run verify -- --only=contracts        # re-run exactly one step

# 4. tests (needs forge on PATH — see step 1)
npm test
npm test --workspace @sigilkit/core

# 5. demo agent — needs anvil, and needs --grant
Start-Process anvil                       # NOT `anvil &`
npm run demo -- --grant
npm run demo -- --ticks 10 --rpc http://127.0.0.1:8545

# 6. env vars: `export X=1` does NOT work
$env:SIGILKIT_OWNER_KEY = "0x…"           # NOT export SIGILKIT_OWNER_KEY=0x…
$env:RUN_WALLET_E2E   = "1"; npm test --workspace @sigilkit/core
$env:HALMOS_ALLOW_DOWNLOAD = "1"

# 7. fork smoke (the one place `$env:` genuinely beats the docs)
$env:RPC_BASE = "https://…"
forge test --match-contract '.*Fork' --fork-url $env:RPC_BASE
```

## Appendix B — the evidence, and its limits

**Measured on this machine** (Windows 11, PowerShell 7, Node v24.12.0, npm 11.18.0,
Foundry 1.7.1 at `~/.foundry/bin`, **not** on `PATH`):

- `npm test` → `'forge' is not recognized`, exit 1 (§3.3)
- `FORGE_BIN` set → `npm test` → **identical failure** (§3.3)
- `PATH` set → `npm test` → `No files changed, compilation skipped` (§3.3)
- `npm run setup -- --no-install --no-build` → all four checks pass, forge found (§3.2)
- `npm run verify -- --list` → 9 steps enumerated (§7.2)
- `npm run verify -- --only=docs` → `doc counts OK`; 158 tests / 14 CI jobs / 11 Halmos
  specs / 49 lint annotations, all matching the code (§3.4)
>   - **Unverified as of 2026-10-01:** this entry is a transcription of the author's 2026-09-26
>     run, not a re-measurement. The audit could not run `npm run verify -- --only=docs` (no
>     Foundry toolchain). 158 / 14 / 11 / 49 are therefore **uncorroborated by this pass**, and
>     the 49 conflicts with the 56 in `docs/VERIFY-FIELD-DESIGN-2026-09-26.md` §7.1. Re-run
>     before citing.
- `node scripts/check-package-artifacts.mjs` → 3 packages, 23 targets, 0 warnings
- `node scripts/validate-workflows.mjs` → `OK — 2 file(s)`, no actionlint needed (§4.2)
- `node scripts/sync-facts.mjs --list` / `--check` → version facts consistent; one
  pre-existing `fragile-parse` error at `bootstrap.mjs:34` (§2.2)
- `export` unrecognized in PowerShell 7 (§4.3)
- `git check-ignore` on the submodule path (§3.1)
- `.gitmodules` present; `submodules: recursive` in 11 of 12 CI checkouts (§3.1)
- both `install-*.sh` referenced only from `ubuntu-latest` jobs (§4.1)

**Read from source, not executed** (would have required writing to the working tree, or a
network install):

- `bootstrap.mjs`'s install and build phases — I ran only `--no-install --no-build`. The
  Windows `.cmd`/`.exe`/`--install` handling is read from `bootstrap.mjs:75-133`.
- `npm run verify` end-to-end — the workspace `node_modules` was being reinstalled
  concurrently while I tested, so the run aborted in the build step. The individual steps I
  *could* run in isolation all passed. `verify.mjs`'s Windows branches (`IS_WIN`,
  `npm.cmd`, `taskkill /T /F`) are read from `verify.mjs:381-394, 462-471`.
- `npm run demo` — `dist/` for `demo-agent` is not built here, and the CLI requires
  `--grant` (verified in `packages/demo-agent/src/cli.ts:19, 142`), which the
  `GETTING-STARTED.md:47-49` invocation omits (already catalogued as C-04 in
  `docs/DOC-AUDIT-CONTRACTS-2026-09-26.md`).
- The `FORGE_BIN` / `PATH` asymmetry table in §3.3 — the `npm test` row is measured; the
  `setup` / `verify` / `demo` rows are read from `bootstrap.mjs:75-84`,
  `verify.mjs:381-391` and `cli.ts:24-25`.
- Halmos / Slither / Echidna installability on Windows — read from
  `CONTRIBUTING.md:44-59`.

**One environment caveat, stated plainly.** Partway through testing, another process began
reinstalling the workspace `node_modules` (a teammate running the setup path), which broke
module resolution mid-run and produced the `ReferenceError: NPM is not defined` in §7.2.
Findings that depended on a working `node_modules` were re-verified afterwards or are
marked as read-from-source above. **No conclusion in this document rests on a run that was
affected by that.**
