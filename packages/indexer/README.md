# @sigilkit/indexer

Turns SigilKit's mandatory audit events into queryable spend reports.

- **Ingest:** `ingestLogs(logs)` / `backfill(client, manager)` / `watch(client, manager)`
  decode `ActionLogged` (per-action) and `WindowCharged` (per-spend-charge) events
  into SQLite via Node's built-in `node:sqlite` — no native dependencies.
- **Query:** `spendByAgent(agentId, chainId?)`, `actionsForAgent`, `actionsForTarget`,
  `latestWindowCharge(key)`, `summary()`, `chainIds()`.
- **CLI:** `sigilkit-indexer backfill|watch|spend|actions|window|summary` — run
  `sigilkit-indexer --help` for the full flag list.

This is the consumer half of the "mandatory audit" guarantee: every scoped agent
action is on-chain data, and this package makes it a compliance fact.

## Durability properties

These are the reasons the index can be trusted as a reconciliation source, and each
has dedicated tests in `test/indexer.test.ts`:

| Property | Guarantee |
|---|---|
| **Lossless** | Rows are keyed `(chain_id, tx_hash, log_index)`, so N actions in one transaction produce N rows. |
| **Idempotent** | Every write is an upsert on that key — re-indexing never duplicates rows. |
| **Resumable** | The sync cursor persists in `sync_state`; a restart resumes instead of skipping blocks. |
| **Reorg-aware** | `block_hash` is stored, `removed` logs are deleted, and polling stays `confirmations` blocks behind the head. |
| **Resilient** | `getLogs` is chunked to `maxBlockRange` and retried with exponential backoff. |
| **Multi-chain** | `chain_id` is a per-query filter; one database can hold several chains. |
| **Read-only mode** | `{ readOnly: true }` performs no mkdir, no DDL and no writes (used by the MCP `audit_query` tool). |

## Library use

`@sigilkit/indexer` is a normal ESM package, so the import below is what a consumer
writes. It resolves through the workspace, so **build the dependency graph once**
(`npm install && npm run build` at the repo root) before running a snippet that imports
a `@sigilkit/*` package — until `@sigilkit/core` has been built there is no `dist/` to
resolve and the import fails with `ERR_MODULE_NOT_FOUND`, which is an environment
problem, not a bug in the example.

```ts
// sigilkit-audit.ts
import { SigilIndexer } from "@sigilkit/indexer";
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";

const indexer = new SigilIndexer("./sigilkit-audit.db", 31337, { confirmations: 0 });
const client = createPublicClient({ chain: foundry, transport: http("http://127.0.0.1:8545") });

// Backfill history, then follow the head. Both are safe to re-run.
const stored = await indexer.backfill(client, "0xYourManagerAddress");
console.log(`indexed ${stored} event(s)`);

const stop = indexer.watch(client, "0xYourManagerAddress");
console.log(indexer.summary());        // "chain 31337: 12 audited actions across 2 agents, 9 window charges"
console.log(indexer.spendByAgent("0xAgentIdHash").toString());  // wei, as bigint
console.log(SigilIndexer.formatWei("4000000000000000"));         // "0.004"

// `watch` returns an awaitable disposer: awaiting it drains the in-flight tick.
await stop();
indexer.close();                      // releases the SQLite handle (required on Windows)
```

Two things the example deliberately shows, because they are the two that bite:

- **`await stop()`** — the disposer returned by `watch` is safe to ignore *and* safe to
  await. Awaiting it waits for the in-flight poll to finish, so you never close the
  database underneath a running tick.
- **`close()`** — SQLite holds an exclusive lock on Windows, so deleting or moving the
  database file before `close()` fails.

### Read-only consumers

The MCP `audit_query` tool opens the store with `{ readOnly: true }`, which performs no
`mkdir`, no DDL and no writes — safe to point at an operator's production database.

```ts
const reader = new SigilIndexer("./sigilkit-audit.db", 31337, { readOnly: true });
try {
  const recent = reader.actionsForAgent("0xAgentIdHash", undefined, 20); // newest 20
  const onBase = reader.actionsForTarget("0xTargetAddress", 8453);        // one chain only
} finally {
  reader.close();
}
```

`actionsForAgent` / `actionsForTarget` **throw** rather than silently truncate when a
filter matches more than 1 000 rows and no explicit `limit` was passed. Pass a `limit`
to page through a larger result — the throw is deliberate, because an audit listing
that looks complete but is not is worse than one that refuses to render.

## CLI

> **Not yet published.** The `@sigilkit` scope on npm belongs to an unrelated project, so run
> the CLI from a clone until that is resolved:
> `node packages/indexer/dist/cli.js <command>` (or `npx tsx packages/indexer/src/cli.ts`).
> The package does declare `bin: { "sigilkit-indexer": "./dist/cli.js" }`, so once it is
> published `npx -y @sigilkit/indexer <command>` works with no extra wiring.
> The `dist/` path needs `npm run build --workspace @sigilkit/indexer` first; the `tsx`
> form runs from source and needs no build.

```bash
sigilkit-indexer backfill --manager 0x… --confirmations 0   # index history
sigilkit-indexer watch    --manager 0x…                     # follow live
sigilkit-indexer summary  --db sigilkit-audit.db            # query (read-only)
sigilkit-indexer spend    --agent 0x<32-byte-id> --json
```

`--confirmations 0` is required on a local/dev chain: the default of 12 blocks refuses to
index anything on a chain shorter than 12 blocks, by design (a silent zero-row backfill
that still advanced the cursor would be worse than a loud failure).

Every flag has an environment fallback (`SIGILKIT_DB_PATH`, `SIGILKIT_MANAGER`,
`SIGILKIT_CONFIRMATIONS`, …) — see [CONFIGURATION.md](../../docs/CONFIGURATION.md).
Exit codes: `0` success · `1` runtime failure · `2` usage error.

**One writer per database.** SQLite allows a single writer, so run one `watch` per store.
Query commands open read-only and can run alongside it.

> **Pre-audit software.** The contracts have not been externally audited. See
> [SECURITY.md](../../SECURITY.md).

MIT.
