# Deployment

Three things get deployed: **contracts** (on-chain), **packages** (to npm), and
**services** (indexer, MCP server). They are independent — you can use the SDK without
deploying anything, and run the MCP server without publishing to npm.

> **Pre-audit software.** No third party has reviewed these contracts. Deploy to a testnet
> first, and put a Safe in front of the owner role before anything holds value. See
> [`../SECURITY.md`](../SECURITY.md).

---

## 1. Contracts

### What gets deployed

| Contract | Role | Upgradeable |
|---|---|---|
| `SessionKeyManager` | Holds keys, scopes, spend policy, audit logging | No — immutable by design |
| `ActionLogger` | Emits `ActionLogged` / `WindowCharged` | No |
| `SpendPolicy` / `MerkleWhitelist` | Libraries used by the manager | No |
| `SessionKey7579Module` | ERC-7579 VALIDATION module for Kernel / Safe{Core} | No |
| `ActionLog7579Executor` | ERC-7579 EXECUTOR: audit at execution time | No |
| `SigilKitDelegator` | EIP-7702 delegation target (one per chain) | No |

Immutable-by-design means a policy bug is fixed by granting new keys and revoking old
ones, not by upgrading the contract. That is deliberate; plan your key rotation
accordingly.

### Local (Anvil)

```bash
anvil &
SIGILKIT_OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script contracts/script/Deploy.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast
```

The script **fails loudly** if `SIGILKIT_OWNER_KEY` is unset — it never falls back to a
well-known key.

### Testnet / mainnet

Two variables, and the distinction matters:

| Variable | Purpose |
|---|---|
| `SIGILKIT_OWNER_KEY` | The key that **broadcasts** the deployment and pays gas. |
| `SIGILKIT_OWNER_ADDRESS` | The address that **owns** the deployed manager. |

If `SIGILKIT_OWNER_ADDRESS` is unset, the broadcaster becomes the owner. On any
persistent network, set it to a Safe (or a TimelockController behind one) so ownership
is not a single hot key:

```bash
export SIGILKIT_OWNER_ADDRESS=0xYourSafe
export SIGILKIT_OWNER_KEY=0xYourFundedDeployerKey

forge script contracts/script/Deploy.s.sol \
  --rpc-url "$RPC_URL" --broadcast --verify --slow
```

### Deterministic, cross-chain-identical addresses

Use this when the same address must exist on several chains:

```bash
SIGILKIT_OWNER_ADDRESS=0xYourSafe \
SIGILKIT_CREATE2_SALT=0x<32-byte-nonzero-salt> \
SIGILKIT_OWNER_KEY=0xYourFundedDeployerKey \
  forge script contracts/script/DeployDeterministic.s.sol \
  --rpc-url "$RPC_URL" --broadcast
```

The script rejects a zero salt and rejects a missing `SIGILKIT_OWNER_ADDRESS` — with a
fixed salt, "same address everywhere" only holds if the owner is an explicit address
rather than whoever happened to broadcast.

### EIP-7702 delegation

`SigilKitDelegator` is deployed **once per chain** and is its own owner, so the
implementation address is permanently inert. Users point their EOA at the
implementation; they never delegate *into* a proxy. After deployment, verify:

```bash
cast call $DELEGATOR "owner()(address)" --rpc-url "$RPC_URL"   # must equal $DELEGATOR
```

Full rationale and the regression tests that pin it are in
[`../SECURITY.md`](../SECURITY.md).

### Post-deploy checklist

```bash
forge script contracts/script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast   # deploy
cast code $MANAGER --rpc-url "$RPC_URL" | head -c 20                          # non-empty
cast call $MANAGER "owner()(address)" --rpc-url "$RPC_URL"                    # == your Safe
forge test --match-contract '.*Fork' --fork-url "$RPC_URL"                    # live smoke
```

Record the addresses and the block number in your own runbook. The indexer needs the
deployment block as its `--from` starting point — starting at 0 works but scans far more
than necessary.

---

## 2. Packages (npm)

The three publishable packages are `@sigilkit/core`, `@sigilkit/indexer` and
`@sigilkit/mcp`. `@sigilkit/demo-agent` is private.

> **⚠ The `@sigilkit` scope is taken.** `@sigilkit/core` already exists on npm (v0.11.1) and
> belongs to an unrelated project, so `npm publish` will fail with `E403` and
> `npm install @sigilkit/core` installs the wrong package. **Decide the namespace before the
> first release**: publish under a scope this project controls, or rename the packages. The
> release workflow now checks ownership up front and fails with this explanation rather than
> after the whole gate.

Publishing is **tag-driven** — `.github/workflows/publish.yml` runs on a `v*` tag, and
only after the full gate passes (contract unit + invariant tests, all-workspace
lint/build/test, doc-count check, pack preview).

```bash
# 1. Bump the version in every package you are publishing (keep them in lockstep).
npm version 0.2.0 --workspaces --include-workspace-root --no-git-tag-version

# 2. Confirm the gate locally.
npm run verify

# 3. Commit, then tag and push.
git commit -am "release 0.2.0"
git tag v0.2.0
git push origin master --follow-tags
```

The workflow publishes in dependency order (`core` → `indexer` → `mcp`), skips any
version already on the registry, and attaches provenance. Internal dependencies are
pinned to `^0.1.0` — never `"*"` — so a consumer cannot silently pick up a future
breaking major.

### Preview what a package will contain

```bash
npm pack --dry-run --workspace @sigilkit/core
npm pack --dry-run --workspace @sigilkit/indexer
npm pack --dry-run --workspace @sigilkit/mcp
```

Each `files[]` list is `["dist", "README.md"]`. If `dist/` is missing, build first:
`npm run build`.

### Manual publish (break-glass)

```bash
npm run build
npm publish --workspace @sigilkit/core     --access public --provenance
npm publish --workspace @sigilkit/indexer  --access public --provenance
npm publish --workspace @sigilkit/mcp      --access public --provenance
```

`--provenance` requires a CI environment with an OIDC token; drop the flag if you are
publishing from a laptop.

---

## 3. Services

### Indexer

The indexer is a long-running process that turns audit events into a queryable SQLite
file. It is safe to restart: the sync cursor is persisted, so it resumes rather than
rescanning (or skipping) — but resume is **fail-closed**: the cursor's stored
`end`-block hash is re-validated against the chain before every range fetch, and a
null (legacy) or mismatched hash stops the process **before any write**. There is
**no automatic rollback**; see §5 for recovery.

```bash
export SIGILKIT_RPC_URL=https://your-rpc
export SIGILKIT_MANAGER=0xYourManager
export SIGILKIT_DB_PATH=/var/lib/sigilkit/audit.db
export SIGILKIT_CONFIRMATIONS=12

sigilkit-indexer backfill --from 12345678    # one-off catch-up
sigilkit-indexer watch                       # then follow the chain
```

Operational notes:

- **`SIGILKIT_CONFIRMATIONS`** trades latency for reorg safety. The default 12 suits
  Base-class chains; raise it for chains with deeper reorgs, lower it for dev.
- **Backups:** the store is a single SQLite file. Copy it while the process is stopped,
  or use `sqlite3 audit.db ".backup backup.db"` for an online copy.
- **Only one writer.** SQLite allows a single writer; run one `watch` per database. Query
  commands open read-only and can run concurrently with it.
- **One manager per database (recommended).** Recovery rewinds are scoped by chain, not by
  manager: `rollbackTo` and the `removed`-log delete both remove rows
  `WHERE chain_id = ? AND block_number > ?`. If several managers share one store, rewinding
  one chain rewinds every manager's rows for that chain. Keep one manager per database unless
  you are prepared to re-index the whole chain.
- **`--max-range`** controls `eth_getLogs` chunk size. Lower it if your provider caps
  block spans; raise it to catch up faster.

### MCP server

The MCP server is spawned by the agent framework, not run as a daemon:

```json
{
  "mcpServers": {
    "sigilkit": {
      "command": "npx",
      "args": ["-y", "@sigilkit/mcp"],
      "env": { "SIGILKIT_LOG_LEVEL": "warn" }
    }
  }
}
```

`audit_query` takes the database path per call and opens it read-only. It never creates
directories, tables or rows — pointing it at a missing file returns a "database not found"
result instead of writing anything.

**It is inert until you allowlist a directory.** `audit_query` refuses **every** path while
`SIGILKIT_AUDIT_DB_ROOT` is unset, and the refusal is reported as a database-not-found style error
rather than a "not configured" message — so an operator can spend a long time on the wrong diagnosis.
Set it to the absolute directory holding the store before starting the server:

```
export SIGILKIT_AUDIT_DB_ROOT=/var/lib/sigilkit   # several roots: ";"-separated
```

The value is read **once at startup**, so it must be exported before the MCP process launches — adding
it to the environment of an already-running framework has no effect. Relative entries are dropped with
a warning. Full symptom-to-fix entry:
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#audit_query-returns-db_not_allowed).

### Containers

A `Dockerfile` and `docker-compose.yml` are provided for the indexer:

```bash
docker compose up --build
```

`docker-compose.yml` keeps the SQLite file on the **named volume `sigilkit-data`**, mounted at
`/data` — the `indexer` service reads/writes it, and the `mcp` service mounts the same volume
read-only. There is no host `./data` bind mount. The services read the same environment
variables documented in [CONFIGURATION.md](CONFIGURATION.md). Set `SIGILKIT_MANAGER` and
`SIGILKIT_RPC_URL` before starting it.

---

## 4. Before public launch — blocking prerequisites

Two things are **declared but not yet real**, and both are prerequisites rather than code
problems. Neither can be fixed by a change to this repository.

| # | Prerequisite | Current state (external checks run 2026-09-15 — historical, not re-run for this revision) | Why it blocks |
|---|---|---|---|
| 1 | **A public repository at the declared URL** | `github.com/sigilkit/sigilkit` and `github.com/sigilkit` both return **HTTP 404** anonymously — not created yet, or still private | The README/GETTING-STARTED `git clone` fails; `.well-known/security.txt`'s Contact and Policy URIs are dead; `repository.url` in every `package.json` resolves to nothing; the whitepaper's "installable via `forge install`" is not possible |
| 2 | **An npm namespace this project controls** | `@sigilkit/core` exists on npm at v0.11.1, owned by an unrelated project; `@sigilkit/indexer` and `@sigilkit/mcp` return E404 | `npm install @sigilkit/core` installs someone else's package; `npm publish` fails E403 |

> **2026-10-01 文档真实性审计：本表的前提已部分过期。**
> **已证伪并更正的部分：** 本行称 `repository.url` in every `package.json` "resolves to
> nothing"，并以 `github.com/sigilkit/sigilkit` 为前提。2026-10-01 实读：
> `packages/core/package.json`、`packages/indexer/package.json`、`packages/mcp/package.json`、
> `packages/demo-agent/package.json` 四份的 `repository.url` 全部是
> `git+https://github.com/dev25bansal-ops/sigilkit.git`（**不是** `github.com/sigilkit/sigilkit`），
> 且 `.git/config` 的 `[remote "origin"]` 指向同一地址。「仓库尚不存在」的前提因此不成立。
> **仍然未证的部分（不得据此认为前置条件 #1 已解除）：**
> - 上述 URL 是否**公开可匿名访问** —— 本次审计无网络、无法发起 HTTP 请求，**未复测**；
> - `github.com/sigilkit/sigilkit` 与 `github.com/sigilkit` 在 2026-09-15 是否真的 404 ——
>   **未复测**；
> - npm 命名空间（前置条件 #2，`@sigilkit/*` 被他人占用）—— **未复测**。
> **冲突登记：** `docs/WHITEPAPER-v2.1.md`「⚠ Distribution status」写「Contracts are
> installable today via `forge install`」，与本行「the whitepaper's "installable via
> `forge install`" is not possible」直接矛盾。DEPLOYMENT.md 的外部检查标注为 2026-09-15，
> 白皮书 v2.1 标注为 2026 年 8 月的复核；文件 mtime 同为 2026-09-26（DEPLOYMENT 16:07Z，
> WHITEPAPER 12:28Z），**两文均晚于各自声明的检查日期，无法据日期判定谁取代谁**。
> 两段原文均按审计规则保留，未删除。

Resolving them:

1. Create the organisation/repository, or point `repository.url` (in the root and all four
   `packages/*/package.json`) at wherever it actually lives.
2. Decide the package namespace — rename the packages, or publish under a scope you own — and
   update the `name`, `repository` and `homepage` fields together.
3. Once both are true: replace the `security.txt` Contact with a `mailto:` you control, add an
   `Encryption` key, refresh `Expires`, and re-run `npm run check:docs` (it validates that file).

The release workflow now fails fast on #2 — `Check npm scope ownership` compares `npm whoami`
against the registry's maintainer list and reports the conflict instead of an opaque E403 after
the whole gate has run.

---

## 5. Rollback and recovery

| Situation | Action |
|---|---|
| Bad package version published | `npm deprecate @sigilkit/x@1.2.3 "reason"` — never unpublish; consumers may have locked it. |
| Indexer produced bad rows | Stop it, `sqlite3 audit.db ".backup pre-fix.db"`, then re-run `backfill --from <block>`; writes are idempotent. |
| Reorg detected | **Implemented — fail-closed.** The resume path validates the stored cursor hash (`sync_state.last_block_hash`) against the chain at that exact height and **stops before any write on a mismatch** instead of advancing past the fork (`validateCursor` / `fetchRangeWithStableEnd` in `packages/indexer/src/indexer.ts`). A cursor whose hash is **null** (legacy: written before cursor-hash hardening) or that **mismatches** the chain is refused — no rows are modified and **no automatic rollback runs**; `rollbackTo(block)` is a manual, chain-wide delete. For either case: **preserve a backup** (`sqlite3 audit.db ".backup pre-rebuild.db"`), then rebuild by indexing from the deployment block into a **separate new database** — do not destructively reset the live store. Two caveats: rows are ingested and the cursor advanced as separate statements (**not one atomic transaction**, so a crash between them can leave rows ahead of the cursor), and the stable-`end` check proves only that the *end* header did not change — an RPC is not required to give a coherent snapshot, so a deep reorg inside a fetched range can still mix forks (`removed` logs + stored `block_hash` are the second line of defence). Run one manager per database for recovery (see §3). |
| Compromised session key | Revoke on-chain via the owner path, then grant a new key. Keys are not upgradeable, but they are revocable. |
| Compromised owner key | Transfer ownership from the Safe; a single EOA owner means the Safe threshold, not the EOA, is the real control. |
