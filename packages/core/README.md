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
| `NonceGate` + `FileLeaseStore` | Per-key execution serialization, in-process or cross-process |
| `assertAddress` / `assertHex` / `assertBigInt` / … | Boundary validation with messages that name the field |
| `loadServiceConfig` / `createLogger` | Environment-driven config and leveled logging |

Subpath exports keep the surface explicit: `@sigilkit/core/lease-fs`,
`/validation`, `/logger`, `/config`, `/cli`.

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
