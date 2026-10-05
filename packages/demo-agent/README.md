# @sigilkit/demo-agent

An end-to-end demo of the SigilKit primitives against a local chain: deploy, grant a
scoped session key, run an autonomous agent loop, and watch the enforcement hold.

This package is **private** — it is not published to npm. Run it from a clone.

> ## ⚠️ The demo topology is NOT a production topology
>
> `npm run demo -- --grant` runs the **owner and the agent in one process**, so the
> owner key is loaded alongside the agent key. That is convenient for a zero-setup demo
> and it is exactly the shape production must avoid. In this mode, "the blast radius of
> a compromised agent is the granted scope, never the wallet balance" is **false**: an
> attacker who owns the process has the owner key and can call `withdraw` directly.
>
> **Production must separate the roles across trust domains:**
>
> | Role | Holds | Can do | Where it belongs |
> |---|---|---|---|
> | **owner** | treasury authority | `grantSessionKey`, `revokeSessionKey`, `rotateSessionKey`, `withdraw` | Safe (2-of-3) or HSM, in a **separate process** |
> | **agent** (`sessionSigner`) | EIP-712 signing only | sign `ActionRequest`s within its scope | the agent process — a hot, short-lived key |
> | **relayer** | gas, nothing else | broadcast already-signed calldata | any key with a small gas float and **no balance** |
>
> The split is enforced in code, not merely documented: `TreasuryAgentConfig` has **no
> `ownerPrivateKey` field** (a `@ts-expect-error` test fails the build if it is ever
> re-added), and the agent can no longer grant itself a scope — `adoptGrant()` only
> accepts an already-mined owner transaction and verifies on-chain that the grant really
> is for its own key.

## Run it

```bash
anvil &                # local chain on http://127.0.0.1:8545
npm run demo -- --grant
```

`--grant` (or `SIGILKIT_DEMO_GRANT=1`) is the explicit **owner-side step**: deploy, fund,
and `grantSessionKey`. It is opt-in and it prints a warning, because it is the one path
where this process touches the owner key. The agent still only ever receives its own
session key plus a gas-only relayer key.

To keep the owner out of the process entirely, adopt a grant made elsewhere:

```bash
npm run demo -- --grant-tx 0x<owner-grant-hash> --counter 0x<counter>
```

Here no owner key is loaded at all — the agent recovers the manager address from the
owner's transaction and verifies the grant on-chain.

Flags: `--rpc <url>`, `--chain-id <id>`, `--ticks <n>`, `--tick-delay <ms>`, `--json`.
`npm run demo -- --help` prints the full list.

## Library use

`@sigilkit/demo-agent` is `private` and never published, but the agent itself is a
normal importable class. As with every `@sigilkit/*` package, build the workspace once
(`npm install && npm run build` at the repo root) before importing — until
`@sigilkit/core` has a `dist/`, the import fails with `ERR_MODULE_NOT_FOUND`, which is an
environment problem rather than a problem with the example.

The package's public entry is `agent.js`; `devkeys` is deliberately *not* re-exported, so
importing it does not pull the Anvil dev keys (and their import-time startup guard) into
your process.

```ts
import { TreasuryAgent, sessionSignerFromKey, type StrategyAction } from "@sigilkit/demo-agent";
import { foundry } from "viem/chains";

const agent = new TreasuryAgent({
  chain: foundry,
  rpcUrl: "http://127.0.0.1:8545",
  managerAddress: "0xYourManagerAddress",
  // A raw key is fine for a demo; a remote/KMS signer is the production shape.
  sessionSigner: "0x<agent-session-key>",
  relayer: "0x<gas-only-key>",   // omit entirely to sign without broadcasting
  scope: {
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    windowSeconds: 3600,
    perActionCap: 10_000_000_000_000_000n,  // 0.01 ETH
    perWindowCap: 50_000_000_000_000_000n,  // 0.05 ETH
    merkleRoot: "0x00…00",
    countersignAbove: 0n,
    enforceNativeDelta: false,
    tokenWatchlist: [],
  },
  // Fire on ticks 1 and 3; return null to idle.
  strategy: (tick): StrategyAction | null =>
    tick === 1 || tick === 3
      ? { agentId: "0x…", target: "0xCounter", selector: "0x…", value: 4_000_000_000_000_000n, rationaleHash: "0x…" }
      : null,
});

// The agent CANNOT grant itself a scope. Adopt a grant the owner already made, and
// the agent verifies on-chain that it really is for this session key.
await agent.adoptGrant({ grantTxHash: "0x<owner-grant-hash>" });

const result = await agent.tick();
if (result.executed && result.broadcast) console.log("mined", result.txHash);
```

Two things worth knowing before you copy this:

- **The agent has no authority to grant.** `adoptGrant` takes an already-mined owner
  transaction and checks on-chain that it emitted `SessionKeyGranted` for *this* session
  key. Omitting the call and calling `tick()` anyway will fail the local scope pre-check.
- **`nonce` is optional** in a `StrategyAction`. `prepareExecution` fetches the on-chain
  nonce at fire time, so a reverted tick cannot permanently desync the agent's nonces.

## What it demonstrates

1. **Deploy** — `SessionKeyManager` plus a `Counter` target, via `forge script`.
2. **Fund** — the *manager* receives 1 ETH so the agent has a budget to spend; the
   relayer receives only a small gas float.
3. **Grant** — the owner grants a 1-hour session key capped at 0.01 ETH/action and
   0.05 ETH/window. The agent adopts that transaction and verifies it.
4. **Execute** — five strategy ticks; ticks 1 and 3 fire a 0.004 ETH rebalance. Each is
   signed by the agent's session key, relayed by the gas-only key, enforced on-chain, and
   audited via `ActionLogged`.
5. **Verify** — `assertAuditEmitted` confirms the audit event landed in the receipt.

A strategy tick that exceeds the caps reverts on-chain rather than being silently
clamped — that is the point of the demo: the agent is untrusted, and the contract is
the authority.

The relayer is a **pure courier**: the contract recovers the *session* key from the
EIP-712 signature, so the relayer needs no authority and should hold no balance.

## Where each private key lives (SEC-6)

| Key | Held by | Can move treasury funds? |
|---|---|---|
| owner | the operator — Safe/HSM, or `--grant` in the demo | **yes** (`withdraw`) |
| agent | `TreasuryAgent.sessionSigner` — signs EIP-712 only | no (caps apply, and the chain enforces them) |
| relayer | `TreasuryAgent.relayer` — broadcasts signed calldata | no (holds only gas) |

Inside the agent process there are exactly two hot keys, and **neither is the owner**.
That is the whole point: an attacker who fully compromises the agent process can drain
the *granted scope* and burn the relayer's gas float, and nothing else.

## Keys and the startup guardrail

The demo uses Anvil's public development keys by default. They are printed by every
Anvil install and are therefore **worthless on a public chain and catastrophic on a
funded one**, so the package enforces the rule that used to be only a comment:

> A dev key + a non-loopback `SIGILKIT_RPC_URL` = **the process refuses to start.**

```
$ SIGILKIT_RPC_URL=https://mainnet.infura.io/v3/key npm run demo -- --grant
refusing to start: the owner, agent and relayer keys are Anvil's PUBLIC development
keys, and https://mainnet.infura.io/v3/key is not a loopback address.
```

Override with `SIGILKIT_OWNER_KEY` / `SIGILKIT_AGENT_KEY` / `SIGILKIT_RELAYER_KEY` to
point at a real chain, or set `SIGILKIT_RPC_URL` back to loopback. Loopback detection
accepts `127.0.0.0/8`, `localhost` and `::1`, and fails closed on anything it cannot
parse — a hostname that merely *resolves* to `127.0.0.1` is not treated as local, since
`/etc/hosts` and DNS rebinding make that untrustworthy.

## Fleet mode

```bash
npm run fleet
```

Two agents in **one process** share one session key and a local `NonceGate` queue.
This demo does not configure a cross-process lease store. Separate processes should
use distinct keys; SQLite v2 coordination requires explicit configuration and the
migration precautions in the [core README](../core/README.md).

Fleet workers hold only the shared agent key and the gas-only relayer. The owner key is
used once, in the setup block, and never handed to a worker.

See [GETTING-STARTED.md](../../docs/GETTING-STARTED.md) and
[TROUBLESHOOTING.md](../../docs/TROUBLESHOOTING.md).

MIT.
