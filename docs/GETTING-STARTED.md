# Getting started

From a fresh clone to a working install in about five minutes.

## Prerequisites

| Requirement | Version | Needed for | Install |
|---|---|---|---|
| **Node.js** | **24 or newer** | Every TypeScript package | [nodejs.org](https://nodejs.org/) — or `nvm use` (`.nvmrc` is committed) |
| **npm** | 10+ (ships with Node 24) | Workspace install | — |
| **Foundry** | 1.7.x | Contract tests, the demo agent | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |

Foundry is **optional for the SDK, indexer and MCP server** — those build and test with
Node alone. It is required for `contracts/`, the demo agent, and the e2e smoke test.

> **Node 24 is a hard floor.** The indexer uses the built-in `node:sqlite` module, which
> is only stable from Node 24. On Node 20 or 22 the install may succeed and then fail at
> runtime. `npm run setup` checks this before doing anything else.

## 1. Install

```bash
git clone https://github.com/dev25bansal-ops/sigilkit.git
cd sigilkit
npm run setup
```

> **Audit note (2026-10-01):** the clone URL above was corrected in this documentation audit from the
> `github.com/sigilkit/sigilkit` organisation URL, which `docs/COMPLIANCE-2026-09-26.md:26` (L-1) and
> `docs/COMPLIANCE-2026-09-26.md:80` of this audit's own document set record as returning **HTTP 404
> anonymously** and "NOT this repo". The replacement string is quoted verbatim from those two lines; it was
> **not** re-verified against the live remote in this pass (no network access was made).

`npm run setup` checks your Node version and Foundry, installs dependencies from the
lockfile, and builds all four packages. It prints a summary of what it found and what to
do next. Flags: `--no-install`, `--no-build`.

## 2. Verify

```bash
npm run verify          # everything: lint, docs, contract tests, TS tests
npm run verify -- --quick   # skip the Foundry suites (fast inner loop)
```

Each step is independent — a failure in one does not hide the others — and the exit code
is non-zero if anything failed.

## 3. Run something

### The demo agent (whole stack, one command)

```bash
anvil &                 # a local chain on http://127.0.0.1:8545
npm run demo            # deploy → grant a scoped key → 5 strategy ticks
```

It deploys `SessionKeyManager` plus a `Counter` target, funds the wallet, grants a
1-hour session key capped at 0.01 ETH/action and 0.05 ETH/window, then runs five strategy
ticks — ticks 1 and 3 fire a 0.004 ETH rebalance. Every action is signed by the agent's
session key, enforced on-chain, and recorded as an `ActionLogged` event.

Useful flags: `--ticks <n>`, `--tick-delay <ms>`, `--rpc <url>`, `--json`.
See `npm run demo -- --help`.

### The SDK

```bash
npm install @sigilkit/core
```

> **Hold off on that for now.** The `@sigilkit` scope on npm is owned by an unrelated project,
> so this command installs *their* package, not this one. Until the scope is resolved, use the
> clone from step 1 and import from the workspace:
>
> ```bash
> node -e "import('@sigilkit/core').then(m => console.log(Object.keys(m).slice(0, 5)))"
> ```
>
> The examples below are otherwise accurate; only the install line is blocked.

```ts
import { SigilKitClient, validateAgainstScope, targetLeaf, merkleRoot } from "@sigilkit/core";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const client = new SigilKitClient({
  managerAddress: "0xYourSessionKeyManager",
  chain: base,
  rpcUrl: process.env.SIGILKIT_RPC_URL,
});

// 1. Describe what the agent may do.
const leaves = [targetLeaf("0xToken", "0xa9059cbb")]; // transfer(address,uint256)
const scope = {
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  windowSeconds: 600,
  perActionCap: 10n ** 16n,   // 0.01 ETH
  perWindowCap: 5n * 10n ** 16n,
  merkleRoot: merkleRoot(leaves),
  countersignAbove: 0n,
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

// 2. Check a request against the scope BEFORE spending gas.
const verdict = validateAgainstScope({ request, scope });
if (!verdict.ok) throw new Error(verdict.reason);

// 3. Sign it (local validation runs before any signature is produced).
const prepared = await client.prepareExecution({ account: agentSigner, request, scope });

// 4. Send it with any relayer, then confirm the audit event landed.
const txHash = await relayer.sendTransaction(prepared);
const audited = await client.assertAuditEmitted(txHash);
```

`client.executeSimulated({ ... })` wraps steps 3–4 when you want a dry run first without
paying the pre-flight twice.

### The indexer (audit trail → SQLite)

From the clone (the npm package is not published yet — see the note above):

```bash
# index history, then keep following the chain
node packages/indexer/dist/cli.js backfill --rpc http://127.0.0.1:8545 --manager 0xYourManager --confirmations 0
node packages/indexer/dist/cli.js watch    --manager 0xYourManager

# query it (read-only — never creates or modifies the file)
node packages/indexer/dist/cli.js summary --db sigilkit-audit.db
node packages/indexer/dist/cli.js spend   --db sigilkit-audit.db --agent 0x<32-byte-agent-id> --json
```

Once installed, the same commands are available as `sigilkit-indexer …`.

### The MCP server (for agent frameworks)

```bash
node packages/mcp/dist/cli.js --help    # or: npm run mcp
```

```json
{
  "mcpServers": {
    "sigilkit": { "command": "node", "args": ["packages/mcp/dist/cli.js"] }
  }
}
```

After publication that becomes `{ "command": "npx", "args": ["-y", "@sigilkit/mcp"] }`.

Four tools: `validate_request`, `build_scope`, `decode_error`, `audit_query`. The server
speaks JSON-RPC over stdio; diagnostics go to stderr so stdout stays a clean channel.

## Where to go next

| Document | Contents |
|---|---|
| [CONFIGURATION.md](CONFIGURATION.md) | Every environment variable, with defaults |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deploying contracts, publishing packages, running services |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Symptoms, causes, fixes |
| [STATUS.md](STATUS.md) | Which planning document is authoritative |
| [`../SECURITY.md`](../SECURITY.md) | Threat model, Slither triage, disclosure policy |
| [`../docs/WHITEPAPER-v2.1.md`](WHITEPAPER-v2.1.md) | Design rationale and audit status |

## A note on audit status

SigilKit has **not** been externally audited. The contracts carry verification tooling —
Foundry unit/fuzz/invariant suites, an independent Echidna fuzzer, Halmos symbolic specs,
Slither triage, and gas budgets — but no third party has reviewed them. Treat this as
pre-audit software and do not put real funds behind it yet.
