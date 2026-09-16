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

## CLI

> **Not yet published.** The `@sigilkit` scope on npm belongs to an unrelated project, so run
> the CLI from a clone until that is resolved:
> `node packages/indexer/dist/cli.js <command>` (or `npx tsx packages/indexer/src/cli.ts`).

```bash
sigilkit-indexer backfill --manager 0x… --confirmations 0   # index history
sigilkit-indexer watch    --manager 0x…                     # follow live
sigilkit-indexer summary  --db sigilkit-audit.db            # query (read-only)
sigilkit-indexer spend    --agent 0x<32-byte-id> --json
```

Every flag has an environment fallback (`SIGILKIT_DB_PATH`, `SIGILKIT_MANAGER`,
`SIGILKIT_CONFIRMATIONS`, …) — see [CONFIGURATION.md](../../docs/CONFIGURATION.md).
Exit codes: `0` success · `1` runtime failure · `2` usage error.

**One writer per database.** SQLite allows a single writer, so run one `watch` per store.
Query commands open read-only and can run alongside it.

> **Pre-audit software.** The contracts have not been externally audited. See
> [SECURITY.md](../../SECURITY.md).

MIT.
