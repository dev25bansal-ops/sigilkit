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
| `targetLeaf` / `merkleRoot` / proof helpers | Argument-bound (v2) Merkle whitelists |
| `decodeSigilKitError` / `decorateWithDecodedRevert` | Named custom-error decoding |
| `NonceGate` + `FileLeaseStore` | Local per-key queue; optional single-host SQLite ownership with cooperative pre-effect checks |
| `assertAddress` / `assertHex` / `assertBigInt` / … | Boundary validation with messages that name the field |
| `loadServiceConfig` / `createLogger` | Environment-driven config and leveled logging |

Subpath exports keep the surface explicit: `@sigilkit/core/lease-fs`,
`/validation`, `/logger`, `/config`, `/cli`.

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

```ts
import { SigilKitClient, validateAgainstScope, targetLeaf, merkleRoot } from "@sigilkit/core";
import { base } from "viem/chains";

const client = new SigilKitClient({
  managerAddress: "0xYourSessionKeyManager",
  chain: base,
  rpcUrl: process.env.SIGILKIT_RPC_URL,
});

const scope = {
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  windowSeconds: 600,
  perActionCap: 10n ** 16n,          // 0.01 ETH per action
  perWindowCap: 5n * 10n ** 16n,     // 0.05 ETH per 10-minute window
  merkleRoot: merkleRoot([targetLeaf("0xToken", "0xa9059cbb")]),
  countersignAbove: 0n,
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

const verdict = validateAgainstScope({ request, scope });
if (!verdict.ok) throw new Error(verdict.reason);

const prepared = await client.prepareExecution({ account: agentSigner, request, scope });
const txHash = await relayer.sendTransaction(prepared);
const audited = await client.assertAuditEmitted(txHash);
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
