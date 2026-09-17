# Contributing

Thanks for considering a contribution. This document is the short version of how the
project is built, tested and reviewed.

## Setup

```bash
git clone https://github.com/sigilkit/sigilkit.git
cd sigilkit
npm run setup        # checks Node/Foundry, installs deps, builds all packages
npm run verify       # the full gate — run this before opening a PR
```

Requirements: Node 24+ (`.nvmrc`), and Foundry 1.7.x if you are touching contracts.

## Layout

```
contracts/           Foundry project — src/, test/, script/
packages/core/       @sigilkit/core    — TS SDK (signing, EIP-7702, Merkle, client)
packages/indexer/    @sigilkit/indexer — audit events → SQLite
packages/mcp/        @sigilkit/mcp     — MCP server
packages/demo-agent/ @sigilkit/demo-agent — end-to-end demo (private)
scripts/             repo tooling (bootstrap, verify, doc counts, ABI targets)
vectors/             golden vectors consumed by BOTH the TS and Solidity suites
docs/                user and operator documentation
```

## Running things

```bash
npm run verify                       # everything
npm run verify -- --quick            # skip Foundry (fast loop)
npm run verify -- --only="doc counts" # run one step (substring match)
npm test                             # Foundry unit+fuzz, then every TS workspace
npm test --workspace @sigilkit/core  # one workspace
npm run test:coverage                # per-package v8 thresholds
npm run lint                         # workflow YAML + container packaging + all-workspace typecheck
npm run demo                         # needs anvil
npm run clean                        # remove generated artifacts (~170 MB)
```

## Optional verification tools

`npm run verify` does not need these — they run in the nightly/weekly CI jobs. Install them if
you are changing the contracts and want the deeper checks locally:

| Tool | Install | Command | What it covers |
|---|---|---|---|
| Halmos | `pip install halmos==0.3.3` | `halmos --match-contract Halmos` | 11 symbolic specs (spend-cap core, Merkle boundaries, auth paths) |
| Slither | `pip install slither-analyzer==0.11.6` | `slither contracts/src` | Static analysis; every finding is triaged in [`SECURITY.md`](SECURITY.md) |
| Echidna | binary release `v2.2.5` | `echidna contracts/test/EchidnaProperties.t.sol --config echidna.yaml` | Independent property fuzzer |

Halmos needs `HALMOS_ALLOW_DOWNLOAD=1` on first run (it fetches solc).

The counts these tools produce are **statically** checked by `npm run check:docs` — it counts
`check_` functions and `forge test --list` entries — so a spec you add is validated even on a
machine where the tool is not installed.

## Conventions

### TypeScript

- **Strict mode is on**, including `noUncheckedIndexedAccess` in `core`. Do not reach for
  `as never` or `as any` to silence a type error — the last one hid a real bug (a
  mis-shaped ERC-20 `allowance` ABI). Fix the type.
- Validate at the boundary with the helpers in `core/src/validation.ts` rather than
  ad-hoc checks. Errors should name the field: `assertAddress(v, "managerAddress")`.
- Log through `core/src/logger.ts`, not `console`. Libraries default to a console logger;
  pass `silentLogger()` to be quiet.
- Never log to **stdout** from the MCP server — that is the protocol channel.

### Solidity

- `foundry.toml` sets `deny = "warnings"`: every compiler warning and lint finding fails
  the build. If a warning is a deliberate design choice, annotate it and say why:

  ```solidity
  // forge-lint: disable-next-line(block-timestamp)
  if (block.timestamp > scope.expiresAt) revert KeyExpired();
  ```

- Keep contracts under the 24,576-byte limit (`forge build --sizes`).
- Any behaviour change needs a test that would fail without it. Boundary conditions get
  both sides of the boundary (see `validate.test.ts` "scope-expiry boundary").

### Documentation

Numbers in the **README and the whitepaper** are verified against the toolchain:

```bash
npm run check:docs              # README + whitepaper: Foundry totals, CI jobs, breakdown sums
npm run check:docs -- --write   # rewrite the README numbers in place
npm run check:docs:full         # also runs every suite to verify the TS totals (~1 min)
```

Do not hand-edit those counts. If you add a test, run `check:docs --write` and update the
per-suite breakdown by hand (the checker validates the sum). The whitepaper's numbers are
prose and are never auto-rewritten — fix them manually; `--with-ts` (run in the release
workflow) will tell you when they have drifted.

## Common change recipes

### Adding a contract

1. Add the source under `contracts/src/`.
2. **Add its name to `scripts/abi-targets.txt`.** This one file feeds both the CI
   regeneration loop and the vitest ABI-drift gate — a contract added to one side but not
   the other silently escapes the gate (that was BUG-2).
3. Commit the regenerated ABI: `forge inspect contracts/src/X.sol:X abi --json > packages/core/abis/X.json`.
4. Add tests; run `npm run check:docs -- --write`.

### Adding an environment variable

1. Read it through `core/src/config.ts` (`readEnvInt`, `readEnvUrl`, …) so it is validated.
2. Document it in **both** `.env.example` and `docs/CONFIGURATION.md`.
3. Prefer a working default — a variable that must be set to start is a papercut.

### Adding a CLI flag

Use the shared parser in `core/src/cli.ts` (`FlagSpec`). You get `--help`, `--version`,
`--flag=value`, unknown-flag suggestions and exit codes 0/1/2 for free. Throw
`UserError` for an expected failure (one clean line) and `CliUsageError` for a bad
invocation.

## Tests

- Every bug fix gets a regression test that fails before the fix.
- Prefer a negative test that pins the *reason* (an exact error selector) over a bare
  "it reverts".
- The indexer's durability properties (lossless, idempotent, resumable, reorg-aware) have
  dedicated tests in `packages/indexer/test/indexer.test.ts` — extend them rather than
  adding parallel coverage elsewhere.

## Pull requests

1. Branch from `master`.
2. Keep the change focused; one concern per PR.
3. `npm run verify` must pass.
4. Update `CHANGELOG.md` under `## [Unreleased]` for user-visible changes.
5. Describe **why**, not just what. If the change has a trade-off, say what you chose and
   what you rejected.

CI runs the full gate plus secret scanning, Slither, and the ABI-drift check. A red PR
gate is the norm for a real problem — please investigate rather than re-running.

## Security

Do **not** open a public issue for a vulnerability. Follow the disclosure process in
[`SECURITY.md`](SECURITY.md) / [`.well-known/security.txt`](.well-known/security.txt).

## License

Contributions are accepted under the MIT license (see [`LICENSE`](LICENSE)).
