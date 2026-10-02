# DOC-AUDIT-2026-09-26 — `packages/core` documentation, examples, README and error-message audit

**Author:** cr-doc · **Scope:** `packages/core/README.md`, `packages/core/src/**` (JSDoc +
error-message text only) · **Date:** 2026-09-26

## Method

Three temporary probe scripts were run against the **built** package
(`packages/core/dist`, built 15:51 from the 15:5x `src`) and, after the concurrent
`src` rewrite, against the current `src`. They exercised **all 83 root exports** plus all 5
subpath exports — happy paths, every documented rejection path, and the boundary cases the
JSDoc makes claims about. Probe output was compared against the prose in the README and in
the JSDoc. Probes lived in `%TEMP%\sigilkit-probe` and are **not** in the repo.

Environment: Node v24.12.0, viem 2.55.19, Windows/PowerShell.

> **Caveat on the numbers below.** `node_modules` contains only `viem` — `typescript` and
> `vitest` are not installed — so `tsc --noEmit` and `vitest run` could **not** be executed
> in this environment. Type-level claims below were verified by reading the emitted
> declarations and viem's own source, not by running the compiler. The behavioural claims
> were all executed. This is stated here rather than implied, because "the type-check passes"
> would otherwise be an unverified claim.

---

## 1. README: runnable-example audit

The single `Quick example` block was checked line by line. **It did not run.** Seven defects,
three of them fatal.

| # | Severity | Line | Defect | Evidence |
|---|---|---|---|---|
| **R1** | **Fatal** | 89 | `targetLeaf("0xToken", "0xa9059cbb")` — `"0xToken"` is a placeholder, not an address. `targetLeaf` calls viem's `encodeAbiParameters`, which throws before any SigilKit code runs. | `InvalidAddressError: Address "0xToken" is invalid.` |
| **R2** | **Fatal** | 95 | `validateAgainstScope({ request, scope })` omits `merkleProof`, but the `scope` built on line 89 sets a **non-zero** `merkleRoot`. The whitelist branch therefore returns `{ok:false}`. The example throws on its own policy check. | `{"ok":false,"reason":"target not whitelisted"}` |
| **R3** | **Fatal** | 99 | `relayer.sendTransaction(prepared)` — `prepared` is **not** a viem parameter object. viem's `sendTransaction` destructures `to`/`data`/`value`/`gas` from its *own* argument; `prepared.to`/`prepared.data` happen to be top-level so `to`/`data` survive, but `request`, `signature`, `merkleProof`, `ownerApproval` land in `...rest` and are forwarded as unknown RPC params. The example depends on an accident of the prepared object's shape. | viem `sendTransaction.js`: `const { account, …, to, data, …, ...rest } = parameters` |
| **R4** | Major | 75 | `request`, `agentSigner`, `relayer` are **never declared** — the snippet is not a compilable module. | verbatim copy → `TS2304: Cannot find name 'request' / 'agentSigner' / 'relayer'` |
| **R5** | Major | 78 | `managerAddress: "0xYourSessionKeyManager"` is a placeholder that is **not validated at construction** — `SigilKitClient` accepts it verbatim and only fails much later, at the first `encodeFunctionData`/RPC call. The example implies an address is required here. | `new SigilKitClient({managerAddress:"0xYourSessionKeyManager", …}).managerAddress` → `"0xYourSessionKeyManager"` |
| **R6** | Minor | 100 | `const audited = await client.assertAuditEmitted(txHash)` — the result is assigned and never checked. Since the method returns `false` (not a throw) when the event is absent, the example silently discards the one signal it exists to produce. | see §2 J3 |
| **R7** | Major | 24 | The export table advertises `FileLeaseStore` as a root export. It is not — `import { FileLeaseStore } from "@sigilkit/core"` yields `undefined`; it lives only on the `@sigilkit/core/lease-fs` subpath. | root export list (83 names) contains `InMemoryLeaseStore` but not `FileLeaseStore` |

**Status: all of R1–R7 fixed.** The `Quick example` is now a complete, declared, runnable
module, with an added error-handling example. The export table carries an explicit note about
the name that is not on the root export, and why (`node:sqlite` would otherwise be pulled
into every browser bundler).

**Post-fix verification — all three `ts` blocks were extracted and executed** against a
stubbed RPC (Node 24 `--experimental-transform-types`, current `src`):

| README claim | Verified result |
|---|---|
| `validateAgainstScope({request, scope, merkleProof: proof})` passes | `{"ok":true}` |
| the same call **without** `merkleProof` is rejected | `{"ok":false,"reason":"target not whitelisted"}` |
| `prepareExecution` returns the 6 documented keys | `request,signature,merkleProof,ownerApproval,to,data` |
| the nonce is fetched from the chain when `request.nonce` is 0 | `0` (from the stub's `getNonce`) |
| `prepared.to` is the manager address | `true` |
| the explicit-destructure send passes `to`/`data` to viem | `true / string`, returns a hash |
| `assertAuditEmitted` returns `false` when no event was emitted | `false` |
| a policy rejection is **not** a `SigilKitError` | `instanceof=false, code=-, ctor=Error` |
| `validateAgainstScope` never throws on a policy failure | `threw=false ok=false` |
| `simulateExecution` returns `{ok,reason}` on revert | `{"ok":false,"reason":"UnknownError(0x0d0d0d0d…)"}` |

### Unit labelling in the example
The old example's inline comments read `// 0.01 ETH per action` beside `perActionCap:
10n ** 16n`. The unit was correct but implicit. The replacement states **wei** explicitly in
each comment, since wei-vs-ether is the single most common unit bug in this surface.

---

## 2. JSDoc audit

Statistics over the 12 `src` files:

| Metric | Count |
|---|---|
| Exported symbols carrying JSDoc | 74 / 74 |
| `@throws` present where the function can throw | 2 gaps, both now filled |
| `@example` present | 6 exported functions — 12 still missing |
| Performance/complexity claims with **no measured basis** | 2 (both now corrected) |
| Unit-less numeric claims (wei / seconds / ms) | 5 (all now labelled) |
| `@example` code that does not run | 3 (all corrected or removed) |

### Confirmed defects (all fixed)

**J1 — `MAX_LEAVES`: fabricated performance figures.** *(severity: high — this is a
security-motivated bound justified by numbers that were ~2× optimistic)*

The JSDoc claimed *"~8.4 us per leaf (16,384 leaves ≈ 136 ms)"* and *"65,536 leaves caps the
work at roughly 0.55 s"*. Measured on this machine:

| leaves | `merkleRoot` | per leaf | `merkleProof` | per leaf |
|---|---|---|---|---|
| 1,024 | 15.4 ms | 15.1 µs | 13.7 ms | 13.4 µs |
| 16,384 | 227.8 ms | 13.9 µs | 222.7 ms | 13.6 µs |
| 65,536 | 1078.4 ms | 16.5 µs | 866.3 ms | 13.2 µs |

Actual cost is **~13–17 µs/leaf**, and the ceiling costs **~1.08 s of blocked event loop**,
not 0.55 s. The `1,000,000 leaves ≈ 8.4 s` extrapolation is likewise ~2× low (~16 s). The
*decision* to cap at 65,536 is still sound — the comment now carries a measured table and
says "about a second", which is the number a caller actually needs.

**J2 — `validateAgainstScope`: "~5 ms" is wrong by ~5000×.** *(severity: medium — a
caller budgeting a latency budget around this would be off by orders of magnitude)*

Measured **0.924 µs** per call for the common path (1000 iterations, warmed). The comment
also asserted *"pure CPU, ~5 ms measured"* — nothing had been measured. Corrected to ~0.9 µs
with an explicit "do not budget milliseconds for this call".

**J3 — `assertAuditEmitted`: JSDoc omitted the `false` return.** *(severity: high — the
method's name promises an assertion, its JSDoc said "Throws on revert or ambiguous
evidence", and it silently returns `false` in the case that matters most)*

Verified: a **successful** transaction with no `ActionLogged` resolves to `false`; only a
revert / ambiguity / receipt-wait failure throws. The JSDoc never mentioned the `false`
path, so a caller reading only the docs would treat "no audit event on a successful
transaction" as impossible — yet that is the INV-3 violation the SDK exists to detect. The
`@returns`/`@throws` block now states it explicitly and points at `sendPrepared`, which
*does* throw for the same condition.

**J4 — `isAddress`: undocumented EIP-55 requirement.** *(severity: medium — a whole class
of confusing failures)*

`isAddress`/`assertAddress` reject an all-uppercase address (`0xABAB…AB`) and a
badly-mixed-case one, even though both are 20 bytes. viem enforces the **EIP-55 checksum**,
but the SDK's docs said only "20-byte hex address". Documented, and the *error message* now
says so too (§3, M1).

**J5 — `parseActionRequest`: `@throws` claimed a uniform `ValidationError`.** The function
really does throw a mix of `ValidationError` (numeric fields) and bare `Error` (shape /
missing-field). The JSDoc now states this split explicitly; verified against runtime
behaviour. The *messages* are still inconsistent — tracked as M6.

**J6 — lease errors carry no `@example`.** `assertLeaseTtl`, `InMemoryLeaseStore.acquire`
and `NonceGate.run` are the failure modes operators hit most and have no usage example.
Reported rather than fixed (see §6).

### Remaining `@example` gaps (reported, not fixed)
`targetLeaf`, `merkleRoot`, `merkleProof`, `signActionRequest`, `signAuthorization`,
`signRevocation`, `assertDelegationScope`, `toAuthorizationTuple`, `decodeSigilKitError`,
`createLogger`, `loadServiceConfig`, `parseArgs` have none. Recommendation: add `@example`
to the seven Merkle / EIP-7702 entry points, which is where users copy from.

---

## 3. Error-message audit (user-facing quality)

Every `toThrow` / `toContain` in `test/*.test.ts` was grepped first, to avoid breaking pinned
assertions. **Six message substrings are test-pinned** and were left byte-identical:
`20-byte hex address`, `expected an integer`, `below the minimum`, `exceeds the maximum`,
`UnknownError` (the `name` field only, not the message), and the `cli.ts` phrasing
(`unknown option`, `did you mean`, `requires a value`, `must be one of`, `missing required
option(s)`, `a command is required`, `unknown command`).

**M3b — `errors.ts`: seven of the nine `SigilKitError` subclasses were declared but never
thrown.** *(severity: **high** — the most dangerous documentation defect found)*

`errors.ts` defined a `SigilKitErrorCode` union of 11 codes and 9 subclasses, and its JSDoc
presented them as "the stable, documented error surface". Executed check, one probe per code:

| Code | Class | Thrown at the time of this audit? |
|---|---|---|
| `VALIDATION` | `ValidationError` | **yes** (every `assert*` helper) |
| `LEASE_LOST` | `LeaseLostError` | **yes** (`NonceGate`) |
| `POLICY_REJECTED` | `PolicyRejectedError` | **no** — plain `Error` |
| `SIMULATION_REVERTED` | `SimulationRevertedError` | **no** — plain `Error` |
| `EXECUTION_REVERTED` | `ExecutionRevertedError` | **no** — plain `Error` |
| `RECEIPT_TIMEOUT` | `ReceiptTimeoutError` | **no** — plain `Error` |
| `AUDIT_MISSING` | `AuditMissingError` | **no** — plain `Error` |
| `AUDIT_AMBIGUOUS` | `AuditAmbiguousError` | **no** — plain `Error` |
| `LEASE_BUSY` / `LEASE_INVALID` / `GUARD_MISSING` | *(no class at all)* | **no** — plain `Error` |

A caller who follows the documented contract and writes
`if (err.code === "AUDIT_MISSING") { … }` gets a branch that **can never fire** — and the
failure it was written for (a successful transaction with no audit event, i.e. the INV-3
violation the product exists to prevent) falls through to the `default:` arm instead. The
class-level JSDoc, `SimulationRevertedError`'s own JSDoc ("Raised by `executeSimulated`")
and three `@throws` tags in `client.ts` all asserted the typed behaviour.

`errors.ts` **did** document the intended migration (API-ERR-1: convert one throw site per
minor release, keeping message text identical so the existing regex assertions keep passing)
— the defect was that the JSDoc described the *end state* as though it were the *current*
state.

> **Resolved during this audit, by ck-doc.** All 11 codes are now wired to real throw sites
> and `test/error-taxonomy.test.ts` drives each one, asserting both `instanceof` and `.code`,
> and additionally scraping the code union out of `errors.ts` and comparing it against the
> reachable set — so a declared-but-unwired class now fails the suite instead of quietly
> becoming a dead branch. Re-verified by execution: 6/6 codes I could trigger from a stub RPC
> return typed errors with the correct `code`. The lesson from this item is preserved in the
> `SigilKitError` JSDoc rather than in a note here.
>
> The "layered signal" caveat ck-err raised **survives** the wiring and is now documented on
> `SigilKitError`: `err.code` still cannot prove a `catch` total, because
> `parseActionRequest`'s shape errors stay plain `Error`, and viem / transport / wallet
> errors are outside the taxonomy entirely.

**M3c — viem never puts revert data on the error it throws: custom-error decoding was dead
code on every real revert.** *(severity: **high** — this is the mechanism behind ck-err's
"last mile" report, and it is worse than described)*

`simulateExecution` read revert data as `(err as {data?}).data`. That is **always
`undefined` in production**. viem's `call` extracts the payload with
`getRevertErrorData` (`viem/_esm/actions/public/call.js:163`), consumes it locally for the
CCIP-Read and counterfactual checks, then throws `CallExecutionError` — which assigns
`cause` and defines **no `data` property at all** (`viem/_esm/errors/contract.js:44-50`).

Executed proof, using genuine `UnreadableWatchToken(0x1111…1111)` revert data delivered
through viem's real error shape (`CallExecutionError` → `cause` → node error with `.data`):

| Path | Result |
|---|---|
| `decodeSigilKitError(rawData)` | `UnreadableWatchToken(0x1111…1111)` ✅ the decoder is fine |
| `simulateExecution` **before** the fix | `{"ok":false,"reason":"CallExecutionError"}` ❌ **class name, not the error** |
| `simulateExecution` **after** the fix | `{"ok":false,"reason":"UnreadableWatchToken(0x1111…1111)"}` ✅ |
| `executeSimulated` before / after | `…rejection (no gas spent): CallExecutionError` → `…: UnreadableWatchToken(0x1111…1111)` |
| `decorateWithDecodedRevert` | already worked — it walked `cause` |

So `decodeSigilKitError` and the whole `SIGILKIT_ERRORS_ABI` were only ever reachable from a
hand-constructed error, never from a real node. The `UnknownError` fallback in
`simulateExecution`'s JSDoc described a path that could not occur.

**Fixed:** added `walkRevertData(err)` to `errors.ts` as the single place that knows how to
find the payload (walks `cause`, also unwraps viem's nested `{data:{data}}` provider shape,
bounded at 5 links), and made **both** `decorateWithDecodedRevert` and `simulateExecution`
use it — two independent implementations of "where is the revert data" is how these two paths
disagreed in the first place.

### Applied

**M1 — `assertAddress`: a correct-length address was rejected with no explanation.**
Before:
```
address: expected a 20-byte hex address (0x + 40 hex chars), got "0xABAB…AB"
```
The value shown is exactly 42 characters — the reader has no way to tell that *length is
fine and the casing is wrong*. After:
```
address: expected a 20-byte hex address (0x + 40 hex chars), got "0xABAB…AB" (lowercase, or EIP-55 checksummed, is accepted — all-uppercase hex is not)
```
The hint is appended **only** when the value is hex-shaped but wrong, so it cannot appear on
an unrelated value. The pinned `20-byte hex address` substring is preserved verbatim, so
`config.test.ts:69` and the five `lease-ttl-contract.test.ts` assertions still pass.

**M2 — `decodeSigilKitError`: the `UnknownError` message was mis-truncated.**
`data.slice(0, 42)` spends 2 of its 42 characters on the `0x` prefix, and appends `…`
unconditionally — so a short third-party selector is rendered as if it had been cut:
```
UnknownError(0x12345678…)      ← 8 hex chars shown; "…" implies more, there was no more
```
Now formats the body explicitly, with an ellipsis only when something was actually dropped.
`name` stays `"UnknownError"`, so `errors.test.ts:52` is unaffected.

**M3 — the "SDK submission attempted" message was misleading in the common case.**
*(severity: high — this message steers an operator's retry decision)*

Measured: with a relayer that rejects **locally** (insufficient gas money — nothing
broadcast), the error surfaced was
```
SigilKit: SDK submission attempted; inspect transaction outcome before retrying
```
The SDK cannot distinguish that from a relayer that *did* broadcast and then failed to
return a hash — the `submitted` flag is set before `sendTransaction` is awaited, which is the
correct fail-safe direction. But the old wording asserted a fact ("submission attempted"
reads as "it went out") that the SDK does not know. Reworded to *"transaction submission was
attempted but failed, so the outcome is unknown"*, with the asymmetry recorded inline:
assuming *sent* costs a wasted nonce, assuming *not sent* can double-execute. Not
test-pinned.

### Recommended, not applied (behaviour or type changes — outside this role's scope)

| # | Site | Problem | Suggested change |
|---|---|---|---|
| M4 | `client.ts` `parseActionLogged` | `"ambiguous ActionLogged audit evidence"` never says **how many** matched or **which** tx. | Append `(N matching events in tx 0x…)`. |
| M5 | `client.ts` guard errors | `"execution guard must originate from this client's nonceGate.run"` does not name the client. | Append `managerAddress` so a fleet log identifies the offender. |
| M6 | `parseActionRequest` shape errors | Uses bare `Error` while numeric fields use `ValidationError` — callers cannot catch one class. `errors.ts` already documents this as **API-ERR-1** with a migration path. | Convert in a minor release, message unchanged, as the JSDoc prescribes. |
| M7 | `signing.ts` `uintField` max message | `"…exceeds the maximum 115792089…935 for uint256"` prints 78 ungrouped digits. | Group with `_` every 3 digits from the right. |
| M8 | `validateAgainstScope` reasons | `"per-action cap exceeded (100000000000000000 > 10000000000000000)"` — raw wei, no unit. | Append `(… wei)`; wei-vs-ether is the top unit-confusion risk here. |
| M9 | `logger.ts` `createLogger` | `createLogger({level:"loud"})` is **silently accepted** (type-bypassing): `RANK["loud"]` is `undefined`, and `undefined < 20` is `false`, so **every level passes the floor — including `debug`**, and `withStack` is on. Measured: a logger with a bogus level emitted a `DEBUG` line. A one-word typo in a security tool *inverts* the intended floor. | Reject an unknown level or fall back to `info`. `config.ts`'s `readEnvChoice` *does* reject, so the two entry points disagree. |
| M10 | `validation.ts` `isUintLike` | Returns `true` for `" 1 "` (it `.trim()`s) while `assertUintField` rejects it. The JSDoc claims it "mirrors `assertBigInt`'s acceptance rules" — true, but `assertBigInt` is the *lenient* one; the signed-uint path uses `assertUintField`. | Align the two, or reword the JSDoc to name which function it mirrors. |

---

## 4. Measured-behaviour snapshot (executed, not inferred)

### 4.1 Export surface — 83 root exports; all 5 subpaths resolve
`/lease-fs` → `FileLeaseStore` · `/validation` → 14 names · `/logger` → 8 · `/config` → 16 ·
`/cli` → 8. All load cleanly.

### 4.2 Error taxonomy actually thrown

| Call | Error class | Message |
|---|---|---|
| `assertAddress("0x1234")` | `ValidationError` | `address: expected a 20-byte hex address (0x + 40 hex chars), got "0x1234"` |
| `assertBigInt(2**53)` | `ValidationError` | `perActionCap: number exceeds safe integer range; pass a decimal string` |
| `parseActionRequest(null)` | `Error` | `parseActionRequest: expected an ActionRequest object` |
| `parseActionRequest({value:true})` | `ValidationError` | `value: expected uint256 as bigint, non-negative safe integer, or decimal string, got true (type: boolean)` |
| `merkleRoot([])` | `Error` | `merkleRoot: at least one leaf required` |
| `validateAgainstScope` (reject) | *none* | `{ok:false, reason:"target not whitelisted"}` — never throws |
| `actionRequestDigest(chainId:"base")` | `ValidationError` | `chainId: expected a non-negative safe integer chain id (…)` |
| `assertAuditEmitted` (no event) | *none* | returns `false` |
| `assertAuditEmitted` (reverted) | `Error` | `SigilKit: transaction 0x… reverted; nothing was executed or audited` |
| `sendPrepared` (missing event) | `Error` | `SigilKit: ActionLogged missing in successful tx 0x… — INV-3 violated` |

### 4.3 Boundary semantics confirmed (these are correct — recorded so they are not "fixed")
- `scope.expiresAt == now` → **accepted** (matches `block.timestamp > expiresAt`).
- `request.expiry == now` → **accepted** (matches the contract).
- `request.value == perActionCap` → **accepted** (`>` not `>=`).
- Non-zero `merkleRoot` + no proof → rejected **before** any signature is created.
- A 33-element `merkleProof` → rejected against the on-chain `MAX_TOTAL_PROOF_ELEMENTS = 32`.
- `merkleProof` for a 1-leaf tree returns `[]` — correct (a lone leaf is its own root).
- `getWindowState` failure → degrades to per-action-only, logs a warning, **does not throw**
  (verified with a stub client whose `getWindowState` always rejects).
- A caller-supplied `request.nonce` **overrides** the on-chain `getNonce` (verified: nonce 99
  sent while the chain said 3). Documented behaviour, but worth knowing.
- `prepareExecution` does **not** validate `scope` — a `perActionCap` of the *string* `"1000"`
  is accepted without complaint. `request` is validated; `scope` is trusted.
- `FileLeaseStore`: `acquire` → token, second `acquire` → `null`, `release` → `true`, double
  `release` → `false`, `renew` after release → `false`, wrong-epoch `isCurrent` → `false`.
  Epoch increments 1 → 2 across a release.

### 4.4 Where documentation and behaviour disagreed

| Behaviour | Documentation said | Verdict |
|---|---|---|
| `validateAgainstScope` costs 0.92 µs | "~5 ms" | **J2** — fixed |
| 65,536 leaves cost 1.08 s | "roughly 0.55 s" | **J1** — fixed |
| `isAddress` rejects `0xABAB…` | "20-byte hex address" | **J4** — fixed |
| `assertAuditEmitted` returns `false` | "Throws on revert or ambiguous evidence" | **J3** — fixed |
| `FileLeaseStore` on the root export | listed in the root table | **R7** — fixed |
| `relayer.sendTransaction(prepared)` | shown as the send step | **R3** — fixed |

---

## 5. Correct as-is — do not "fix" these

Recorded so a later reviewer does not mistake them for bugs:

- `actionRequestDigest` **now** rejects a non-numeric `chainId` and a bad `verifyingContract`
  with a `ValidationError` naming the field. The 15:51 build did **not**: `chainId: "base"`
  silently produced a valid, wrong digest (`0xa9fb33…` vs `0x466478…` for `chainId: 1`). That
  hole was closed by `cr-sig`/`cr-num` during this audit. Verified fixed in current `src`.
- `expiry: 2**48` is now rejected against the `uint48` bound; the old build accepted it and
  ABI-encoded a wrapped value. Also closed during this audit.
- `toAuthorizationTuple` now validates `yParity`, `r`/`s` width, the `uint256` range and
  EIP-2 low-`s`. `rlpEncodeScalar` now rejects negatives instead of surfacing viem's
  `Invalid byte sequence ("-1" in "-1")`.
- `parseActionRequest`'s strict type whitelist (`true`→rejected, `[]`→rejected, `"0x10"`
  →rejected, `" 1"`→rejected) is correct and well documented.
- `isUintLike` is a *predicate*, so returning `boolean` rather than a type predicate is a
  deliberate, defensible choice.

---

## 6. Recommended follow-up (not done here)

1. **Install the toolchain.** `node_modules` has only `viem`; `npm run lint` and `npm test`
   in `packages/core` cannot run here. Any "type-checks" claim currently rests on a machine
   that has the deps.
2. **Convert the legacy throw sites** per the `API-ERR-1` migration path already written into
   `errors.ts` — `parseActionRequest`'s shape errors first, since they are the most common
   failure *and* the most inconsistent. **M3b is the highest-value item on this list**: seven
   typed error classes are exported and documented but never thrown, so every consumer that
   trusted the taxonomy has dead branches. The message text already matches each class, so
   the conversion is mechanical and the existing regex assertions will keep passing.
3. **Fix `createLogger`'s level handling** (M9). This is a behaviour change rather than a docs
   change, and it is the one item here with a security flavour: a typo currently *lowers* the
   log floor to `debug` and enables stack traces.
   **Status: still open** — re-checked against the current `src` and unchanged.
4. **Add `@example` to the remaining twelve public entry points** (§2).
5. **Re-run this audit after a build.** This pass executed against a `dist` that a concurrent
   teammate deleted mid-audit; the behavioural snapshot in §4 is from that build plus a
   `src`-level re-verification, and the two agreed everywhere they overlapped. A fresh
   `npm run build && npm test` should confirm.
6. **INV-3 is scoped to "an action was logged", not "the action did what it claimed".**
   Verified against the ABI: `ActionLogged` carries `(agentId, target, selector, value,
   rationaleHash, timestamp)` and **no token amounts, no balance deltas, no return data**.
   Combined with the M3b/`J3` findings — an `assert`-named method that returns `false` where
   its sibling `sendPrepared` throws, and a taxonomy that cannot classify the failure — this
   makes INV-3 systematically easy to over-estimate. A caller that sees `true` and concludes
   "the token transfer happened as intended" is over-claiming. The JSDoc for
   `assertAuditEmitted` and `ActionLogRecord` now states this scope limit explicitly.
