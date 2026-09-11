# @sigilkit/indexer

Turns SigilKit's mandatory audit events into queryable spend reports.

- **Ingest:** `ingestLogs(logs)` / `backfill(client, manager)` / `watch(client, manager)`
  decode `ActionLogged` (per-action) and `WindowCharged` (per-spend-charge) events
  into SQLite via Node's built-in `node:sqlite` — no native dependencies.
- **Query:** `spendByAgent(agentId)`, `actionsForAgent`, `actionsForTarget`,
  `latestWindowCharge(key)` (window reconciliation), `summary()`.
- **CLI:** `node dist/cli.js backfill --rpc … --manager 0x… --db audit.db --watch`,
  then `spend/actions/window/summary` for reports.

This is the consumer half of the "mandatory audit" guarantee: every scoped agent
action is on-chain data, and this package makes it a compliance fact. Tests cover
the decode→store→query pipeline with canonically-encoded logs; the getLogs/watch
wiring is a thin viem layer over the same path.
