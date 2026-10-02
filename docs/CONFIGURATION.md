# Configuration reference

Every setting SigilKit reads from the environment. **All of them are optional** — each has
a working default, so a local run needs no `.env` at all. The canonical template is
[`.env.example`](../.env.example):

```bash
cp .env.example .env
```

Precedence, highest first:

1. command-line flag (`--rpc`, `--db`, …)
2. real environment variable (shell, CI, container)
3. `.env`, then `.env.local`, in the working directory
4. built-in default

Every CLI loads `.env` and `.env.local` from the current directory at startup, so
`cp .env.example .env` is all the setup a local run needs. A real environment variable always
wins over the file — that is what lets CI or a container override a checked-out `.env` without
editing it.

A variable that is **set but invalid** is an error, not a fallback — including the log
settings. `SIGILKIT_CHAIN_ID=base` fails with the variable name, and `SIGILKIT_LOG_FORMAT=xml`
fails listing the allowed values; a silently ignored typo is worse than a failed start.
Values are matched case-insensitively (`SIGILKIT_LOG_LEVEL=DEBUG` works).

---

## Runtime (SDK, demo agent, fleet demo)

| Variable | Default | Meaning |
|---|---|---|
| `SIGILKIT_RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC endpoint. Must be `http(s)://` or `ws(s)://`. |
| `SIGILKIT_CHAIN_ID` | `31337` | Chain id used for signing, indexing and query scoping. Must be ≥ 1. |
| `SIGILKIT_OWNER_KEY` | Anvil account #0 | Owner (wallet) private key — `0x` + 64 hex chars. |
| `SIGILKIT_AGENT_KEY` | Anvil account #1 | Session-key holder private key — `0x` + 64 hex chars. |

> The default keys are Anvil's **public development keys**. They are meaningless outside a
> local chain and are allowlisted in `.gitleaks.toml` so secret scanning stays meaningful
> for every other file. Never put a funded key in `.env` for a shared machine.

## SDK lease coordination (constructor options, not environment variables)

`SigilKitClientConfig.leaseStore` accepts only a v2 owner-token adapter. Without it,
`NonceGate` is an in-process queue. With it, sign/send operations require the same
client's run-issued context: `client.nonceGate.run(account.address, guard => client.execute(args, wallet, guard))`.

`leaseTtlMs` defaults to 30,000 ms, accepts integers from 10 to 2,147,483,647 ms,
and schedules serialized renewal at half-TTL. It is an operator-selected lease
lifetime, not a measured transaction-duration bound. Scheduler and I/O must progress
before expiry; merely keeping the process alive is insufficient. Loss aborts
`guard.signal` and subsequent checks fail closed; arbitrary callbacks are not preempted.

`FileLeaseStore` from `@sigilkit/core/lease-fs` requires Node >=24 and a local directory.
`staleGraceMs` defaults to 5,000 ms (integer 0–2,147,483,647), postponing reassignment,
not extending validity. The holder's persisted recovery deadline governs contenders.
`createDir: false` requires an existing directory. Stop every legacy worker before
using a fresh directory; `.lock` layouts and legacy adapters are rejected, not migrated.
Close stores after all runs settle. Never replace an active database or use NFS.
See the [core migration notes](../packages/core/README.md#lease-api-v2-migration).

## Toolchain paths

| Variable | Default | Meaning |
|---|---|---|
| `FORGE_BIN` | `$HOME/.foundry/bin/forge` | Absolute path to `forge`. Set it when Foundry is not on `PATH`. |
| `ANVIL_BIN` | `$HOME/.foundry/bin/anvil` | Absolute path to `anvil`. |

`npm run setup` and `npm run verify` resolve these automatically and tell you what they
found. On Windows the binaries are `forge.exe` / `anvil.exe`; both resolvers handle that.

## Indexer and MCP services

| Variable | Default | Meaning |
|---|---|---|
| `SIGILKIT_DB_PATH` | `sigilkit-audit.db` | SQLite audit store. The indexer writes it; `audit_query` opens it read-only. |
| `SIGILKIT_MANAGER` | *(none)* | SessionKeyManager address to index. Required by `backfill` and `watch` (flag or variable). |
| `SIGILKIT_INDEXER_CHAIN_ID` | `SIGILKIT_CHAIN_ID`, else `31337` | Chain id the indexer writes under. |
| `SIGILKIT_CONFIRMATIONS` | `12` | Blocks to stay behind the head. Use `0` on local chains. |
| `SIGILKIT_MAX_BLOCK_RANGE` | `2000` | Largest block span per `eth_getLogs`; bigger catch-ups are chunked. |
| `SIGILKIT_LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` · `silent`. |
| `SIGILKIT_LOG_FORMAT` | `text` | `text` for humans, `json` for a log collector. |
| `SIGILKIT_AUDIT_DB_ROOT` | *(none — MCP `audit_query` is inert)* | **Required by the MCP server's `audit_query` tool.** `;`-separated list of **absolute** directories a database may live in. While unset, `audit_query` refuses **every** path, and the refusal surfaces as a "database not found"-style error rather than a "not configured" message. Read **once at startup** — a later change needs a restart. Relative entries are dropped with a warning. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#audit_query-returns-database-not-found). |

### Log output

`text` (default):

```
2026-09-15T05:36:20.123Z  INFO  indexer  backfill stored 42 event(s) chainId=8453 manager=0x…
```

`json` (`SIGILKIT_LOG_FORMAT=json`):

```json
{"ts":"2026-09-15T05:36:20.123Z","level":"info","scope":"indexer","msg":"backfill stored 42 event(s)","chainId":8453}
```

The MCP server always writes diagnostics to **stderr**, because stdout carries the
JSON-RPC protocol.

## Testing and CI

| Variable | Default | Meaning |
|---|---|---|
| `RPC_BASE` | *(unset)* | Archive RPC for the nightly Base fork smoke test. Unset ⇒ that job skips cleanly. |
| `RUN_WALLET_E2E` | *(unset)* | `1` enables the Playwright + MetaMask conformance harness. |
| `WALLET_DAPP_PORT` | *(unsupported)* | Not read by the CI wallet harness (`run.ts` honours `DAPP_URL` only); it survives solely in the standalone `dapp-server.ts` / `real-metamask.ts` dev helpers, which CI never invokes (DEBT-12). |
| `DAPP_URL` | `http://127.0.0.1:8765/dapp.html` | The one dapp variable that matters: the harness opens this URL and derives the dapp port from it. |

## Per-command flags

Flags override the environment. Run any binary with `--help` for the full list.

```bash
sigilkit-indexer --help
sigilkit-mcp --help
npm run demo -- --help
```

### `sigilkit-indexer`

| Flag | Applies to | Notes |
|---|---|---|
| `--rpc <url>` | backfill, watch | Falls back to `SIGILKIT_RPC_URL`. |
| `--manager <address>` | backfill, watch | Falls back to `SIGILKIT_MANAGER`. |
| `--db <path>` | all | Falls back to `SIGILKIT_DB_PATH`. |
| `--from <block>` / `--to <block>` | backfill | Default: persisted cursor → head − confirmations. |
| `--confirmations <n>` | backfill, watch | Default 12. On a chain whose head is at or below this value, `backfill` now **fails loudly** (exit 1) instead of storing nothing — pass `--confirmations 0` (or a smaller value) for local/dev chains. See AC-32. |
| `--max-range <n>` | backfill, watch | |
| `--chain-id <id>` | all | A **filter** on query commands; omit to aggregate every chain. |
| `--agent <hash>` | spend, actions | 32-byte agent id. |
| `--key <address>` | window | Session key address. |
| `--limit <n>` | actions | Default 20. |
| `--json` | all queries | Machine-readable output. |
| `--log-level <level>` | backfill, watch | Overrides `SIGILKIT_LOG_LEVEL`. |

### `sigilkit-mcp`

| Flag | Notes |
|---|---|
| `--log-level <level>` | Overrides `SIGILKIT_LOG_LEVEL`. |

### `sigilkit-demo`

| Flag | Default |
|---|---|
| `--rpc <url>` | `SIGILKIT_RPC_URL` |
| `--chain-id <id>` | `SIGILKIT_CHAIN_ID` |
| `--ticks <n>` | `5` |
| `--tick-delay <ms>` | `500` |
| `--json` | off |

## Exit codes

Every CLI uses the same three codes, so scripts can branch on them:

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Runtime failure — unreachable node, missing database, reverted transaction. |
| `2` | Usage error — unknown flag, missing required option, invalid value. |

```bash
if ! sigilkit-indexer summary --db audit.db; then
  case $? in
    2) echo "fix your command line" ;;
    1) echo "fix your environment" ;;
  esac
fi
```

## Configuration in code

The SDK exposes the same readers, so an embedder can validate its own config the same way:

```ts
import { loadServiceConfig, readEnvInt, requireEnv, createLogger } from "@sigilkit/core";

const config = loadServiceConfig();        // defaults + validation, never throws for absent vars
const port = readEnvInt(process.env, "PORT", { fallback: 8080, min: 1, max: 65535 });
const secret = requireEnv(process.env, "API_KEY", "create one in the dashboard");
const log = createLogger({ level: config.logLevel, format: config.logFormat, scope: "my-service" });
```
