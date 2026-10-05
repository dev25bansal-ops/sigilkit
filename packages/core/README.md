# @sigilkit/core

The TypeScript SDK for SigilKit: EIP-712 typed action requests, scoped session-key
signing, EIP-7702 authorization, Merkle whitelist construction, and revert decoding.

```bash
npm install @sigilkit/core
```

> **Not yet published.** The `@sigilkit` scope on npm is owned by an unrelated project, so this
> command installs *their* package today. Consume it from the repository workspace instead —
> see [GETTING-STARTED](../../docs/GETTING-STARTED.md).

## What it gives you

| Export | Purpose |
|---|---|
| `SigilKitClient` | Prepare, simulate, sign and send scoped actions; verify the audit event landed |
| `signActionRequest` / `validateAgainstScope` | Zero-gas pre-flight: reject locally what the chain would reject |
| `parseActionRequest` | Validate a deserialized request (e.g. from JSON) before it reaches the encoder |
| `signAuthorization` / `signRevocation` / `validateAuthorization` | EIP-7702 delegation with cast-verified RLP digests |
| `targetLeaf` / `merkleRoot` / `merkleProof` | Argument-bound (v2) Merkle whitelists |
| `decodeSigilKitError` / `decorateWithDecodedRevert` | Named custom-error decoding |
| `SigilKitError` + `code` | Typed failures: branch on `err.code`, never on the message |
| `NonceGate` + `FileLeaseStore` | Local per-key queue; optional single-host SQLite ownership with cooperative pre-effect checks |
| `assertAddress` / `assertHex` / `assertBigInt` / … | Boundary validation with messages that name the field |
| `loadServiceConfig` / `createLogger` (**subpath only**) | Environment-driven config and leveled logging — import from `@sigilkit/core/config` / `@sigilkit/core/logger`, not the root |

Subpath exports keep the surface explicit: `@sigilkit/core/lease-fs`,
`/validation`, `/logger`, `/config`, `/cli`.

> **Some names in the table above are not on the root export.** `FileLeaseStore` lives only on
> `@sigilkit/core/lease-fs` (`import { FileLeaseStore } from "@sigilkit/core/lease-fs"`) and
> pulls in `node:sqlite`, so it is deliberately not re-exported from the package root — which
> would drag a Node-only builtin into every browser bundler. `InMemoryLeaseStore` (the
> dependency-free default) *is* on the root export.
>
> `loadServiceConfig` and `createLogger` are also **not** on the root export — they are only
> reachable through `@sigilkit/core/config` and `@sigilkit/core/logger`. `config` is excluded
> because it statically imports `node:fs` / `node:path` at the top level, which no bundler can
> resolve or tree-shake away; `logger` and `cli` are excluded as entry-point hygiene. See
> `src/index.ts` for the full rationale.

## Lease API v2 migration

`FileLeaseStore` uses local SQLite (Node >=24), with atomic owner/epoch-qualified
acquire, renew, and release. `acquire(key, ttlMs)` returns a token or `null`;
`renew(token, ttlMs)`, `isCurrent(token)`, and `release(token)` return booleans.
Custom adapters must provide `version: 2` and all four methods (sync or Promise).
Boolean/tokenless v1 adapters are rejected before any run callback. Token IDs are
capabilities: do not log them. Epochs increase per key in the retained database;
they are not remote fencing tokens and do not survive database replacement.

Stop **all** old workers before starting v2 workers on a fresh directory. Legacy
`.lock` entries are rejected without deletion; directory inspection cannot prove
old workers have stopped. Do not mix old/new workers, remove database sidecars,
replace an active database, or use NFS/shared network storage. Call `close()` only
after runs settle. Distinct keys per process remain the recommended default.

With `leaseStore` configured, explicitly use
`client.nonceGate.run(args.account.address, guard => client.execute(args, wallet, guard))`.
The same original guard must reach `prepareExecution(args, guard)` and
`sendPrepared(prepared, wallet, guard)`, or `executeSimulated(args, wallet, from, guard)`.
Guarded prepared objects are immutable and bound to the original client/run;
cloned, deserialized, or earlier-run payloads must be prepared again. The signing
identity is `account.address`, **not** the request's `agentId` or relayer address.
No-store callers retain their existing signatures and local queue behavior.

Renewal is serialized at half of `leaseTtlMs` (default 30,000 ms), and requires
scheduler/I/O progress within TTL. Expiry prevents renewal even during the default
5,000 ms reclamation grace. Loss aborts `guard.signal` and future checks fail with
`LeaseLostError`; the gate still waits for the callback and pending renewal before
releasing. Await all work inside the callback; cancellation does not preempt
arbitrary JavaScript or direct wallet calls. An abandoned callback retains the
local queue until it settles.

SDK checks run before signing and sending, but a pause between checking and sending
remains possible. Strict end-to-end fencing requires enforcement by the effect
owner and is not provided here. After SDK submission, receipt/outcome processing
continues; do not assume lease loss means nothing was sent or retry blindly.
On-chain nonce checks are an independent defense, not a no-gas-loss guarantee.
Local lifecycle tests do not certify cross-process crash behavior or distributed use.
Rebuild `dist` before packaging this breaking API change.

## Quick example

Runnable end to end. Every identifier is declared, every value is a real address/hash, and
the whole flow is the one the SDK actually supports.

```ts
import {
  SigilKitClient,
  validateAgainstScope,
  targetLeaf,
  merkleRoot,
  merkleProof,
} from "@sigilkit/core";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";

// --- inputs -----------------------------------------------------------------
const managerAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // SessionKeyManager
const token = "0x1111111111111111111111111111111111111111";        // the ERC-20 you allow
const transferSelector = "0xa9059cbb";                              // transfer(address,uint256)

const agent = privateKeyToAccount(process.env.SIGILKIT_AGENT_KEY as `0x${string}`);
const relayer = privateKeyToAccount(process.env.SIGILKIT_RELAYER_KEY as `0x${string}`);

const nowSec = Math.floor(Date.now() / 1000);

// A wildcard leaf whitelists `transfer` on `token` for ANY calldata.
const leaf = targetLeaf(token, transferSelector);

const scope = {
  expiresAt: nowSec + 3600,
  windowSeconds: 600,
  perActionCap: 10n ** 16n,          // wei: 0.01 ETH per action
  perWindowCap: 5n * 10n ** 16n,     // wei: 0.05 ETH per 10-minute window
  merkleRoot: merkleRoot([leaf]),     // non-zero => a proof is REQUIRED
  countersignAbove: 0n,               // 0 = never require an owner countersignature
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

const request = {
  agentId: "0x" + "ab".repeat(32),    // bytes32, your own agent identifier
  target: token,
  selector: transferSelector,
  value: 0n,                          // wei
  nonce: 0n,                          // 0 => prepareExecution fetches it from the chain
  expiry: nowSec + 600,               // unix seconds; keep <= scope.expiresAt
  rationaleHash: "0x" + "cd".repeat(32),
  data: "0x",
};

const proof = merkleProof([leaf], leaf);

// --- 1. zero-gas pre-flight -------------------------------------------------
// scope.merkleRoot is non-zero, so merkleProof is REQUIRED here — without it this
// returns { ok: false, reason: "target not whitelisted" }.
const verdict = validateAgainstScope({ request, scope, merkleProof: proof });
if (!verdict.ok) throw new Error(verdict.reason);

// --- 2. prepare + sign ------------------------------------------------------
const client = new SigilKitClient({
  managerAddress,
  chain: base,
  rpcUrl: process.env.SIGILKIT_RPC_URL,
});

const prepared = await client.prepareExecution({
  account: agent,
  request,
  scope,
  merkleProof: proof,
});
// prepared = { request, signature, merkleProof, ownerApproval, to, data }

// --- 3. send ---------------------------------------------------------------
// `prepared` is NOT a viem parameter object: sendTransaction reads to/data/value/
// gas from its own argument, so destructure explicitly.
const relayerClient = createWalletClient({ account: relayer, chain: base, transport: http() });
const txHash = await relayerClient.sendTransaction({
  account: relayer,
  chain: base,
  to: prepared.to,
  data: prepared.data,
});

// --- 4. confirm the mandatory audit event (INV-3) ---------------------------
// `execute`/`sendPrepared` do all of 2-4 in one call and additionally THROW when a
// successful tx is missing ActionLogged. assertAuditEmitted is the standalone,
// non-throwing form: it returns false when no matching event was found.
const audited = await client.assertAuditEmitted(txHash, {
  agentId: request.agentId,
  target: request.target,
  selector: request.selector,
  value: request.value,
  rationaleHash: request.rationaleHash,
});
if (!audited) throw new Error("no ActionLogged event — treat this as unaudited, not as success");
```

`agent` and `relayer` are **different keys on purpose**: the session key (`agent`) signs the
request, the relayer only pays gas. `client.execute(...)` / `client.sendPrepared(...)` take a
`WalletClient` and handle the send for you if you would rather not assemble the transaction
yourself.

Errors carry a machine-readable `code` — prefer branching on `err.code` over matching on
message text. Every code in the union is raised by a real throw site, so the `switch` below
is exhaustive over `SigilKitError`.

```ts
import { SigilKitError } from "@sigilkit/core";

try {
  await client.execute({ account: agent, request, scope, merkleProof: proof }, relayerClient);
} catch (err) {
  if (err instanceof SigilKitError) {
    switch (err.code) {
      case "VALIDATION":          /* bad field: err.field names it */ break;
      case "POLICY_REJECTED":     /* local pre-flight refused, zero gas spent */ break;
      case "SIMULATION_REVERTED": /* eth_call reverted, zero gas spent */ break;
      case "EXECUTION_REVERTED":  /* mined and reverted: nothing happened */ break;
      case "RECEIPT_TIMEOUT":     /* NOT safe to retry — reconcile err.txHash */ break;
      case "AUDIT_MISSING":       /* executed but unaudited (INV-3) */ break;
      case "AUDIT_AMBIGUOUS":     /* >1 ActionLogged matched; evidence unusable */ break;
      case "LEASE_LOST":          /* superseded by another worker */ break;
      case "LEASE_BUSY":          /* key held elsewhere; normal fleet contention */ break;
      case "LEASE_INVALID":       /* misconfigured lease store — fix, do not retry */ break;
      case "GUARD_MISSING":       /* sign/send crossed without a valid run guard */ break;
    }
  } else {
    // Not ours: viem / RPC transport / wallet-client errors land here
    // (CallExecutionError, ProviderRpcError, NonceTooLowError, UserRejectedRequest…).
    // `err.code` is a layered signal, NOT an exhaustive enumeration of everything a
    // process can throw — see the note on SigilKitError.
  }
  throw err;
}
```

Two cases carry data you will need:

```ts
import { SigilKitError, PolicyRejectedError } from "@sigilkit/core";

try {
  await client.execute({ account: agent, request, scope, merkleProof: proof }, relayerClient);
} catch (err) {
  if (err instanceof SigilKitError && err.code === "RECEIPT_TIMEOUT") {
    // Do NOT resend: the nonce is likely already consumed. Reconcile this hash on chain.
    console.error("unresolved:", err.txHash, "after", err.timeoutMs, "ms");
  }
  if (err instanceof PolicyRejectedError) {
    console.error("refused locally, nothing signed:", err.reason);
  }
  throw err;
}
```

### Error handling

`validateAgainstScope` and `client.simulateExecution` **never throw** for a policy or
simulation failure — both return the same `SigilKitCheck` union, `{ ok: false, reason }`. Use
them when you want a result instead of an exception:

```ts
const pre = validateAgainstScope({ request, scope, merkleProof: proof });
if (!pre.ok) {
  // "per-action cap exceeded (…)" | "target not whitelisted" | "request already expired" | …
  console.warn("refused locally, zero gas:", pre.reason);
}

const sim = await client.simulateExecution(prepared);
if (!sim.ok) {
  // decoded SigilKit custom error when recognised, else the raw revert
  console.warn("would revert on chain:", sim.reason);
}
```

## Design notes

- **The agent is untrusted.** Local validation is advisory only; the contract is the
  authority. Every check in `validateAgainstScope` mirrors a specific on-chain check and
  is pinned by a boundary test, so the two cannot silently diverge.
- **The audit trail is mandatory.** `ActionLogged` is emitted iff the inner call
  succeeded (INV-3). `assertAuditEmitted` is how you confirm it on-chain.
- **Strict TypeScript.** `noUncheckedIndexedAccess` is on; the SDK does not use
  `as never`/`as any` to paper over type errors.

Full documentation: [GETTING-STARTED](../../docs/GETTING-STARTED.md) ·
[CONFIGURATION](../../docs/CONFIGURATION.md) · [TROUBLESHOOTING](../../docs/TROUBLESHOOTING.md).

> **Pre-audit software.** The contracts have not been externally audited. See
> [SECURITY.md](../../SECURITY.md).

MIT.
