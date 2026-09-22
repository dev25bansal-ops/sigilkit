# @sigilkit/demo-agent

An end-to-end demo of the SigilKit primitives against a local chain: deploy, grant a
scoped session key, run an autonomous agent loop, and watch the enforcement hold.

This package is **private** — it is not published to npm. Run it from a clone.

## Run it

```bash
anvil &          # local chain on http://127.0.0.1:8545
npm run demo     # deploy → grant scoped key → 5 strategy ticks
```

Flags: `--rpc <url>`, `--chain-id <id>`, `--ticks <n>`, `--tick-delay <ms>`, `--json`.
`npm run demo -- --help` prints the full list.

## What it demonstrates

1. **Deploy** — `SessionKeyManager` plus a `Counter` target, via `forge script`.
2. **Fund** — the wallet receives 1 ETH so the agent has a budget to spend.
3. **Grant** — a 1-hour session key capped at 0.01 ETH/action and 0.05 ETH/window.
4. **Execute** — five strategy ticks; ticks 1 and 3 fire a 0.004 ETH rebalance. Each is
   signed by the agent's session key, enforced on-chain, and audited via `ActionLogged`.
5. **Verify** — `assertAuditEmitted` confirms the audit event landed in the receipt.

A strategy tick that exceeds the caps reverts on-chain rather than being silently
clamped — that is the point of the demo: the agent is untrusted, and the contract is
the authority.

## Fleet mode

```bash
npm run fleet
```

Two agents in **one process** share one session key and a local `NonceGate` queue.
This demo does not configure a cross-process lease store. Separate processes should
use distinct keys; SQLite v2 coordination requires explicit configuration and the
migration precautions in the [core README](../core/README.md).

## Keys

Uses Anvil's public development keys by default (they are meaningless outside a local
chain). Override with `SIGILKIT_OWNER_KEY` / `SIGILKIT_AGENT_KEY`, and never point this
at a funded chain.

See [GETTING-STARTED.md](../../docs/GETTING-STARTED.md) and
[TROUBLESHOOTING.md](../../docs/TROUBLESHOOTING.md).

MIT.
