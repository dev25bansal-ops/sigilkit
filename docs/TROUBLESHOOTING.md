# Troubleshooting

Symptom → cause → fix. If something here is wrong or missing, that is a bug in the docs —
please open an issue.

---

## Setup

### `npm run setup` says the Node version is too low

```
✗ Node v22.22.2 found, but this project requires >=24.
```

The indexer uses `node:sqlite`, which is only stable from Node 24. Node 22 may install
cleanly and then fail at runtime, so this is a hard stop.

```bash
nvm install 24 && nvm use 24     # .nvmrc is committed
node --version                   # v24.x
```

### `forge: command not found`

Foundry is not on `PATH`. Either install it, or point at it explicitly:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
export FORGE_BIN="$HOME/.foundry/bin/forge"    # Windows: .../forge.exe
export ANVIL_BIN="$HOME/.foundry/bin/anvil"
```

`npm run setup` reports whether each binary was found, and skips Foundry-dependent steps
rather than failing.

> **Check `~/.foundry/bin` before concluding Foundry is absent.** A `foundryup` install puts all
> four executables (`forge`, `cast`, `anvil`, `chisel`) in `~/.foundry/bin` and does **not** add
> it to `PATH`, so "not on `PATH`" and "not installed" are different states. `npm run setup`
> probes that directory as well as `PATH` and prints the exact `$env:` / `export` lines when the
> tools are found there. It prints them rather than setting them: an environment variable set
> inside the setup process cannot reach your shell, so a silent `process.env.FORGE_BIN = …`
> would make setup report a working `forge` that the very next command still cannot find.

### `npm ci` fails with "lockfile out of sync"

`npm ci` refuses to install when `package.json` and `package-lock.json` disagree — that is
the intended drift gate, not a bug. Fix it by regenerating the lockfile and committing it:

```bash
npm install            # updates package-lock.json
git diff package-lock.json
```

### `npm ci` fails with `Missing: @rollup/rollup-linux-x64-gnu@… from lock file`

The lockfile was generated on one platform and is missing the optional binaries other
platforms need (`@rollup/rollup-*`, `@esbuild/*`). This breaks clean installs on CI even
though it works locally. Regenerate it with a current npm and commit the result:

```bash
npm install --package-lock-only
npm ci --dry-run       # should now succeed
```

### `npm ci` fails on Windows, or in a sandbox, while deleting `node_modules`

`npm ci` replaces `node_modules` wholesale. That fails when a process still holds a handle
inside it (Windows) or when bulk deletion is restricted. Use the in-place install, which is
still lockfile-driven:

```bash
npm run setup -- --install
```

If npm's cleanup step still reports warnings, the install itself succeeded — check with
`ls node_modules/.bin/tsc`.

### `Cannot find package '@vitest/coverage-v8'`

Coverage runs from the workspace root, so the provider must be installed there:

```bash
npm install --save-dev @vitest/coverage-v8@^5.0.0
```

---

## Running things

### `error: no JSON-RPC node reachable at http://127.0.0.1:8545`

Nothing is listening. Start a chain, or point at a real node:

```bash
anvil &
npm run demo -- --rpc http://127.0.0.1:8545
```

### `error: audit database not found: …`

The indexer's query commands open the store **read-only** and will not create it. That is
deliberate: a query must never mutate the artifact it reports on. Index something first:

```bash
sigilkit-indexer backfill --manager 0xYourManager --db sigilkit-audit.db
```

### `WARN indexer backfill window is empty: head is below start + confirmations`

The chain head is lower than `start + confirmations`, so the safe range is empty. Normal on
a fresh local chain.

```bash
sigilkit-indexer backfill --manager 0x… --confirmations 0
```

### `error: unknown option --dbb (did you mean --db?)`

Exit code `2` — a usage error, not a runtime failure. Run the binary with `--help`:

```bash
sigilkit-indexer --help
```

### `error: --agent: expected 32 bytes of hex (0x + 64 hex chars), got "nope"`

`--agent` is a **32-byte agent id**, not an address. Addresses (20 bytes) are used for
`--manager` and `--key`.

### Windows: `EBUSY: resource busy or locked` on the SQLite file

Windows keeps an exclusive handle on an open SQLite file, so tests and scripts must close
the database before deleting it. In your own code:

```ts
const ix = new SigilIndexer(dbPath, chainId);
try { /* … */ } finally { ix.close(); }
```

`SigilIndexer.close()` is idempotent. If a stale process is holding the file, close it or
restart the shell.

### `ValueNotAccepted` from `executeWithSessionKey`

The manager refuses `msg.value` on that entrypoint by design — value flows from the
wallet's own balance, not from the caller. Sign a request with `value` set and send the
transaction with zero attached value.

### `grantSessionKey reverted`

Usual causes: the owner account is unfunded (no gas), `expiresAt` is in the past, or
`perWindowCap < perActionCap`. The demo checks the receipt status and reports the tx hash:

```bash
cast receipt <txHash> --rpc-url http://127.0.0.1:8545
```

---

## Tests

### A path check says a file is fine, but reading or listing it fails

The symptom is a tool that reports a file or directory as present, followed immediately by a
failure that names something else entirely:

```
npm error UNKNOWN: unknown error, lstat 'D:\SigilKit\node_modules\@sigilkit\mcp\dist\cli.js'
```

```
Cannot find path 'D:\SigilKit\node_modules\@sigilkit\mcp\dist' because it does not exist.
```

**Cause.** `Test-Path` (PowerShell) and `existsSync` (Node) answer a narrower question than the
one being asked: *can this name be resolved to something?* Neither answers *can this be used*.
They also **fail in opposite directions**, which is why one habit cannot cover both:

| Scenario | `Test-Path` | `existsSync` | `statSync` / `readdirSync` |
|---|---|---|---|
| plain file or directory | `True` | `true` | ok |
| symlink whose target is gone | `False` | `false` | throws `UNKNOWN` |
| **junction to a real directory** | **`True`** | **`false`** | **throws `UNKNOWN`** |
| junction whose target is gone | `False` | `false` | throws `UNKNOWN` |

> **Measured 2026-09-26 on Windows / Node v24.12.0 (sc-dx).** Every cell was produced by
> creating each artifact and calling each API against it; none is quoted from documentation.
> Note the third row: `Test-Path` reports a healthy junction as present while Node's
> `existsSync` reports the *same* junction as absent. A `Test-Path` result of `True` is
> therefore not evidence a Node check will agree, and `existsSync === false` is not evidence
> the file is missing.

`node_modules/@sigilkit/*` are junctions onto `packages/*` (npm creates them for workspaces), so
this is reachable without anyone creating a link by hand. What makes it expensive is the
combination: `Test-Path` says the link resolves, and the *first* real traversal of a path
*through* it is what fails — naming the file being opened rather than the link that broke.

**Fix — check by doing the operation, not by naming the path:**

```powershell
# PowerShell — enumerate or read; do not trust Test-Path
Get-ChildItem node_modules\@sigilkit\mcp\dist          # ok  -> 4 entries
Get-Content  node_modules\@sigilkit\mcp\dist\cli.js -TotalCount 1
```

```bash
# Node — statSync follows links, so a link with no target throws here, where the
# message can still name the variable that needs fixing
node -e "const{statSync}=require('fs');console.log(statSync(process.argv[1]).isFile())" <path>
```

**Before doing either, check whether this host can host a link at all.** On a host whose
reparse-point implementation is broken, recreating the link reproduces the fault, so the repair
below cannot succeed and costs you a second partially-deleted `node_modules`:

```bash
node scripts/check-reparse-points.mjs --workspace-links
```

```
host reparse-point capability — NOT CAPABLE (win32)
  control: plain directory create + read OK (1 entries)
  fs.symlinkSync(type='junction') BROKEN  isLink=true readlink=ok  throughLink=UNKNOWN errno=-4094
  cmd mklink /J                  BROKEN  isLink=true readlink=ok  throughLink=UNKNOWN errno=-4094
```

Exit `0` means the host can create *and traverse* a link, so the repair below applies. Exit `1`
means every method produced a well-formed link that cannot be read through — a host-level fault
that reproduces in a clean temp directory with no repository involved. **No amount of
`rmdir` + `npm install` fixes that**; use an environment with an intact reparse-point
implementation (WSL2, a Linux container) or install with copying instead of linking. Exit `2`
means the probe could not reach a verdict, and must not be read as "links work".

If the verdict is `0` **and** the target itself is fine but traversal *through* the link is not,
recreate the link rather than the content — `rmdir` on a junction removes the link only and
leaves `packages/` untouched:

```powershell
cmd /c rmdir node_modules\@sigilkit\mcp        # link only; packages/mcp is not touched
npm install                                    # recreates the workspace links
```

**Run `npm install` only after the bad links are gone.** Run against a broken junction it aborts
part-way and leaves `node_modules` *more* damaged than before: one such attempt left
`typescript`, `vitest` and `yaml` all missing, while every file under `packages/` stayed intact.

### A Foundry build fails with a lint or warning error

`foundry.toml` sets `deny = "warnings"`, so every compiler warning and lint finding is a
build failure. That is intentional for a wallet toolkit. If the warning is a deliberate
design choice, annotate it in place:

```solidity
// forge-lint: disable-next-line(block-timestamp)
if (block.timestamp > scope.expiresAt) revert KeyExpired();
```

with a comment explaining why. There are 56 such annotations in the repo to copy from. The
count moves as the contracts change, so re-derive it from the tree rather than trusting this page:

```
grep -rn 'forge-lint: disable-next-line' contracts/ | wc -l   # POSIX
```

`npm run check:docs` fails the build if this number drifts from the sources. The
count grows over time because every new exemption is required to state its reason inline, and
`deny = "warnings"` turns each one into a build failure unless it is documented.

### `forge test` cannot find `lib/forge-std`

Submodules are not initialised:

```bash
git submodule update --init --recursive
# or, without submodules:
forge install foundry-rs/forge-std
```

### Coverage fails the threshold

Thresholds are per-package floors set just under measured coverage. Either add tests, or —
if the new code genuinely cannot be unit-tested — exclude it in the package's
`vitest.config.ts` `coverage.exclude` with a comment saying why.

```bash
npm run test:coverage --workspace @sigilkit/indexer
```

### A core test fails only when I already have `anvil` running

The suites bind to `:8545` and **reuse** a node that is already listening rather than starting
a second one, so the chain carries whatever state earlier runs left on it. The suite says so
when it happens:

```
[test] reusing the Anvil on http://127.0.0.1:8545, which is already at block 42.
[test] These suites assume a fresh chain and may fail spuriously against existing state.
[test] For a hermetic run, stop that node first (the suite starts and stops its own).
```

The conformance suite (deploy → grant → execute) and the token-balance assertions are the
sensitive ones: against a chain with history they can fail with an assertion that looks like a
code bug. Stop your Anvil and re-run:

```bash
# the suite starts and stops its own Anvil when the port is free
npm test --workspace @sigilkit/core
```

### The wallet e2e harness does not run

It is opt-in because it needs a browser and a real extension:

```bash
npx playwright install chromium
RUN_WALLET_E2E=1 npm test --workspace @sigilkit/core
```

Without `RUN_WALLET_E2E=1` the harness reports as skipped, which is not a failure.

### The nightly Base fork job is skipped

`RPC_BASE` is unset. The job is written to skip cleanly rather than fail, so a forkless
environment reports success-with-skip. Set an archive RPC to enable it.

---

## MCP server

### The server does not appear in my agent framework

1. Check it starts at all: `npx sigilkit-mcp --version`.
2. Remember that diagnostics go to **stderr**; stdout is the JSON-RPC channel. If you
   wrap the server in a script that prints to stdout, you will corrupt the protocol.
3. Turn up logging: `npx sigilkit-mcp --log-level debug`.

### `audit_query` returns `DB_NOT_ALLOWED`

**This is a policy refusal, not a missing file.** The two are deliberately distinguishable:

| Code | Meaning |
|---|---|
| `DB_NOT_ALLOWED` | Refused by policy — allowlist unset, forbidden path shape, or outside the configured root |
| `DATABASE_NOT_FOUND` | Absent, a directory, not a regular file, wrong extension, or not a readable SQLite store |

If you see `DB_NOT_ALLOWED: audit_query is disabled because SIGILKIT_AUDIT_DB_ROOT is not set`, no path
will work until you allowlist a directory. Set it to the absolute directory holding your audit
database(s); several roots may be separated by `;`:

```
SIGILKIT_AUDIT_DB_ROOT=/var/lib/sigilkit
```

Requirements, all of which fail quietly rather than loudly:

- **Absolute paths only.** A relative entry is dropped with a warning in the server log, so it grants
  nothing. On Windows use a drive-rooted path (`C:\data`), not a mapped drive.
- **The read is latched at startup.** The variable is read once, when the module loads, so a later
  change to the environment cannot widen it — that is deliberate. Restart the server for it to take
  effect.
- **Symlinks are resolved.** A root that is itself a symlink is accepted, but the *target* must still
  be inside an allowlisted root after resolution.

Once a root is configured, a genuinely missing file reports `DATABASE_NOT_FOUND`. Only then does the
"pass an absolute path" advice apply — the path is resolved against the **server's** working directory,
which the agent framework chooses.

> **Measured 2026-09-26 (dc-law measured, ck-doc carried out):** `SIGILKIT_AUDIT_DB_ROOT` appears
> **39×** in `packages/` and **17×** across `docs/`, but **0×** in every operator-facing document
> (`README.md`, `CONFIGURATION.md`, `GETTING-STARTED.md`, `DEPLOYMENT.md`, `TROUBLESHOOTING.md` before
> this entry). Every prior mention was in an audit or planning document, which an operator does not
> read. Authority: the `audit_query` allowlist refusal branch and `readAuditDbRoots` in
> `packages/mcp/src/server.ts` — located by symbol, since line numbers in that file have moved twice
> today.

### A tool returns `isError: true` with a validation message

That is the designed behaviour: tool arguments are validated and the message names the
offending field, e.g. `targets[0].selector: expected 4 bytes of hex`. Fix the argument;
no need to read a stack trace.

---

## Getting more information

```bash
SIGILKIT_LOG_LEVEL=debug sigilkit-indexer watch --manager 0x…
SIGILKIT_LOG_FORMAT=json  sigilkit-indexer watch --manager 0x… | jq .
npm run verify            # full gate; each step reports independently
```

If you are reporting a bug, include: the exact command, the full output, `node --version`,
`forge --version` (if relevant), and your OS.
