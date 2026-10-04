# @sigilkit/agent

The agent runtime for SigilKit: pluggable decision "brains" that propose actions, which
`McpAgentRunner` validates against on-chain scope **before** anything is signed, then relays
and confirms the mandatory `ActionLogged` audit event.

Models are advisory. Hard guardrails veto. The brain never holds keys.

```bash
npm install @sigilkit/agent @sigilkit/core viem
```

## How a tick works

```
brain.propose(context)        → an ActionRequest, or null to decline
  ↓
validateAgainstGuardrails()   → expiry, per-action cap, Merkle-leaf presence  (zero gas)
  ↓
prepareExecution()            → EIP-712 sign + calldata, with the manager's nonce
  ↓
relay + waitForReceipt
  ↓
assertAuditEmitted()         → INV-3: a success without ActionLogged is a failure
```

`state.tick` advances once per **attempt**, including declined ones, so a brain that gates on
phase (`tick % period === offset`) still reaches its fire condition.

## Brains

A brain is anything with `propose(context)`:

```ts
import type { DecisionProvider, AgentContext } from "@sigilkit/agent";

const brain: DecisionProvider = {
  name: "every-third-tick",
  async propose(ctx: AgentContext) {
    if (ctx.tick % 3 !== 0) return null;
    return {
      agentId,
      target,
      selector,
      value: 0n,
      nonce: ctx.nonce,
      expiry: Math.floor(Date.now() / 1000) + 600,
      rationaleHash,
      data: "0x",
    };
  },
};
```

Two implementations ship in-box:

| Brain | Purpose |
|---|---|
| `StubBrain` | Deterministic, schedule-driven. For demos and tests. |
| `LocalModelBrain` | A small MLP (`nn/mlp.ts`) scores the state; the amount still comes from the deterministic `Policy` engine, never from the model. |

`AgentContext` carries only observations — balance, nonce, cap, expiry, tick. It never contains
anything that can sign.

## Running one

```ts
import { McpAgentRunner } from "@sigilkit/agent";

const runner = new McpAgentRunner({
  managerAddress,
  sessionSigner: process.env.SESSION_KEY!,   // the agent's key — never the owner's
  scope,
  brain,
  rpcUrl,
  relayer: process.env.RELAYER_KEY,           // optional: omit for a dry run
});

for (let i = 0; i < 10; i++) {
  const r = await runner.tick();
  if (r.executed) console.log("acted:", r);
}
```

Omitting `relayer` returns the prepared payload instead of broadcasting — useful for inspecting
what *would* be sent.

## Security posture

- **SEC-06 role separation.** The runner holds a session key, never owner authority. Owner-only
  selectors are denylisted on-chain, and the runner never has the means to bypass them.
- **Fail closed.** A non-zero `merkleRoot` with no supplied leaves is rejected rather than
  treated as allow-all. A whitelist miss throws instead of falling through.
- **Advisory model.** `LocalModelBrain` proposes; `safeAmountWei` decides the amount. The policy
  engine cannot return a value above `perActionCap` by construction.

## Development

```bash
npm run build          # tsc -p tsconfig.build.json
npm test               # vitest run
npm run test:coverage  # gated on the floors in vitest.config.ts
npm run lint           # tsc -p tsconfig.typecheck.json (src AND test)
```

`lint` deliberately runs a separate typecheck config rather than the build one: the build config
sets `rootDir: ./src` and excludes `**/*.test.ts`, so `tsc --noEmit` against it never saw a
single test file. Two tests carried type errors for that reason.

## License

MIT — see [LICENSE](./LICENSE).