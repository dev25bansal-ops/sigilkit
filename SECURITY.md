# Security Notes — Slither Triage (2026-08-24)

`slither contracts/src` reports **24 findings across 7 contracts, zero high-severity bugs**
(re-run 2026-09-14 after the E14-E20 components (executor, delegator, lease adapters)
landed; two new-surface findings FIXED in code: zero-address withdraw burn
(SessionKeyManager) and zero-target value burn (ActionLog7579Executor)). Every remaining finding is a known, deliberate
design pattern of an agent-action executor. This file is the reference the CI Slither gate and
future auditors should check against.

> **UNVERIFIED 2026-10-27 — the headline count does not reconcile with the table below.** This
> paragraph claims 24 findings across 7 contracts; the triage table that follows enumerates 13
> numbered rows (1, 2–8, 9–10, 11, 12–13) and accounts for none of the remaining 11. Either 11
> findings are untriaged, or the header over-counts. The number was deliberately NOT changed
> here: `slither` could not be re-run in this environment, and inventing a replacement would be
> worse than leaving the contradiction visible. Re-run `slither contracts/src`, then reconcile
> this paragraph and the table in one edit.

| # | Detector | Location | Triage |
|---|----------|----------|--------|
| 1 | `arbitrary-send-eth` | `SessionKeyManager.executeWithSessionKey` | **ACCEPTED (by design).** The contract's purpose is executing scoped calls on behalf of agents. Value transfer is bounded by: per-action cap + fixed-window (tumbling) cap (`SpendPolicy.enforce`, effects-before-interaction), Merkle target/selector whitelist, hard key expiry, per-key nonces, and the owner-only selector denylist. A compromised SDK cannot exceed scope (enforcement is on-chain). The 7579 module does NOT send ETH itself — it validates; the account executes. |
| 2–8 | `timestamp` (×7) | expiry/window comparisons in both SessionKeyManager and SessionKey7579Module | **ACCEPTED.** Session-key expiry, request expiry, and fixed (tumbling) spend windows are inherently timestamp-based (same as ERC-4337 session keys). Miner skew (~12 s) is immaterial vs minute-scale windows; no oracle exists for cheaper on-chain time. Module note: `validateUserOp` binds authorization to `validUntil = scope.expiresAt`, so the entrypoint enforces the same bound independently. |
| 9–10 | `assembly` | `_manager()` / `_m()` storage slots | **ACCEPTED.** Single inline-asm accesses to ERC-7201 namespaced slots — the standard collision-safety pattern. |
| 11 | `low-level-calls` | inner `.call{value:}` | **ACCEPTED.** Arbitrary-target execution IS the product. Success asserted; mandatory `ActionLogged`; reentrancy-guarded; CEI ordering enforced. |
| 12–13 | `naming-convention` | `DOMAIN_SEPARATOR()`, `ACTION_REQUEST_TYPEHASH()` | **ACCEPTED.** Uppercase view accessors for EIP-712 constants follow ecosystem convention and are consumed by SDKs reading them on-chain. |

## Module-specific design notes (SessionKey7579Module)

- Validation-time window mutation is conservative: a validated-but-dropped op still counts against
  the fixed (tumbling) window. Prefer tight windows.
- Batch ops under a non-zero Merkle root are NOT blanket-rejected — each tuple must carry its own
  proof (E16). `validateUserOp` parses one proof section per tuple out of the signature
  (`_parseBatchProofs`, `contracts/src/SessionKey7579Module.sol:381-385`) and `_enforceBatch`
  verifies them per tuple (`:436-441`), so a tuple with a missing or wrong proof reverts with
  `TargetNotAllowed`: the path is still fail-closed, just per tuple rather than per batch.
  Regression tests: `SessionKey7579Module.t.sol::test_BatchUnderWhitelist_PerTupleProofs_Accept`
  (`:455`), `…TamperedProof_Reverts` (`:493`), `…MalformedTail_Reverts` (`:522`). Both paths are
  gas-bounded: `MAX_SINGLE_PROOF_ELEMENTS` (8) per proof and `MAX_TOTAL_PROOF_ELEMENTS` (32)
  across a whole batch.
- No `ActionLogged` at validation time: validation passing ≠ execution landing (bundler may drop).
  Pair with an executor/hook for per-execution audit trails.

## Invariants under formal verification

- **INV-1**: window spend ≤ per-window cap **within any single fixed (tumbling) window** — covered by
  stateful invariant fuzz suite **and 4 Halmos symbolic specs** over the `SpendPolicy.enforce` core
  (exact-spend recording, over-cap reversion, rollover isolation, per-action cap) **plus 1
  auth-path spec** (`check_execute_WindowSpendNeverExceedsCap`). Window
  semantics: the window RESETS to zero when fully elapsed (tumbling, not sliding), so up to ~2×
  `perWindowCap` can legitimately cross a window boundary; a boundary-burst unit test pins this.
  Run: `halmos --match-contract Halmos` (11 specs: 6 spend-cap/Merkle core + 5 auth-path over a
  recover-seam harness).
  > **UNVERIFIED 2026-10-27 — the two spec counts in this bullet contradict each other.** The
  > opening says 4 Halmos specs over the `SpendPolicy.enforce` core plus 1 auth-path spec; the
  > `Run:` line says 11 specs = 6 core + 5 auth-path. They cannot both be right. Neither figure
  > was changed here — `halmos` could not be run in this environment, and guessing which number is
  > correct would be worse than leaving both visible. Cross-reference only (not a correction):
  > `PROJECT-MAP.md` (2026-09-25) records "6 Halmos(spec)" for INV-1, which agrees with the second
  > figure and not the first. Resolve by running `halmos --match-contract Halmos`, counting, and
  > then fixing both figures in one edit.
- **INV-2**: expired or revoked keys cannot execute (covered by invariant fuzz suite).
- **INV-3**: `ActionLogged` emitted iff inner call succeeded (asserted in unit + TS E2E tests; on
  the 7579 path, `ActionLog7579Executor` emits it at execution time with the same negative
  guarantee — no audit on failed execution).
- **INV-4**: owner-only selectors unreachable via `executeWithSessionKey` (denylist, covered by
  unit + invariant suites).

## Governance posture (decided 2026-09 — issues catalog A2)

The manager is **immutable-by-design pre-mainnet**: no proxy/UUPS upgrade path exists before the
external audit; key migration happens via `rotateSessionKey` and denylist policy, not code
upgrades. Production deployments MUST set `SIGILKIT_OWNER_ADDRESS` to a governance contract
(2-of-3 Gnosis Safe per the build plan) — the deploy script then treats the broadcaster key as a
deployer with NO authority over the deployed manager. Plain-EOA ownership via
`SIGILKIT_OWNER_KEY` is supported for local/test only. Treasury recovery is the owner-only
`withdraw` (denylisted from session keys by default).

## Known limitation (documented, mitigated)

Calldata cannot observe nested/internal token transfers inside the target call, so
`request.value` may undercount actual outflow for targets that pull tokens mid-call.
Mitigations: trusted-target allowlists (e.g. routers that settle via permit2 without arbitrary
pulls), post-hoc reconciliation off-chain against cumulative `ActionLogged` records, and
argument-bound whitelist leaves. An SDK-side ERC-20 pre-check **is implemented**
(`SigilKitClient.checkTokenPath`, enhancement E8) — it is **advisory only**: it reads
`balanceOf(from)` and, for `transferFrom` where the manager is not the owner,
`allowance(from, managerAddress)`, and never blocks a request. On-chain enforcement remains the
only authority; do not treat a passing pre-check as a guarantee.

## Executor audit attribution (`ActionLog7579Executor`)

`ActionLogged.agentId` on the 7579 executor path is an **account-asserted** claim, not a
third-party attestation. The binding is strictly self-scoped: `onInstall`/`setAgentId` write
`agentIds[msg.sender]`, and `execute` requires `msg.sender == account` while reading
`agentIds[msg.sender]`. No address can therefore forge another account's attribution — but an
account **can relabel itself at any time**. Operators that need a trustworthy agent identity must
pin the binding at install time and treat later `AgentBound` events as governance-relevant.

**Audit selector for calls that carry no selector.** `bytes4(callData)` silently right-pads input
shorter than 4 bytes: empty calldata becomes `0x00000000` — which collides with ERC-165's reserved
selector space — and 2-byte calldata becomes `0xab000000`, indistinguishable in the log from a
genuine selector. The executor therefore records `bytes4(keccak256(callData))` whenever calldata is
shorter than a selector; empty calldata is audited as `0xc5d24601` (the well-known `keccak256("")`
prefix). An indexer can always distinguish "no real selector" from a real `0x00000000` call, and
short payloads no longer collapse onto one another. Calls with 4+ bytes are audited with their
true selector, unchanged.

## EIP-7702 delegator: the implementation address must stay inert

`SigilKitDelegator` is deployed **once per chain** as the canonical delegation target. Its
constructor passes `address(this)` as the owner, so the implementation contract owns *itself*:
no external account can ever be its owner, `initializeSelfOwned()` on the implementation reverts
`AlreadyInitialized`, and every `onlyOwner` path (`grantSessionKey`, `transferOwnership`, …)
reverts `NotOwner` because nobody can present themselves as `msg.sender == address(impl)`.

**Operational rule:** never initialize, proxy, or delegate *into* the implementation address in a
way that gives it an owner. Delegation must target the canonical implementation directly
(`0xef0100 || implementation`); the EOA then calls `initializeSelfOwned()` in its own context, and
its own storage holds the owner. Regression tests:
`SigilKitDelegator.t.sol::test_Implementation_IsSelfOwnedAndUninitializable`,
`…InitializeSelfOwnedReverts`, `…AdminPathsAreUnreachable`, `…HasNoScopes`.

Delegation itself is revoked with the SDK's `signRevocation` (an authorization naming address 0),
which clears the account's code entirely.

## Whitelist leaf format v2 (argument binding)

Leaves commit the calldata: `leaf = keccak256(abi.encode(target, selector, argsHash))` with
`argsHash = keccak256(calldata)`. A **pinned** leaf authorizes exactly one calldata payload for
that target+selector (e.g. a single `transfer(recipient, amount)` — the compromised-agent drain
scenario is closed); the **wildcard** leaf (`argsHash = bytes32(0)`) authorizes any calldata for
the selector, matching the pre-v2 behavior. `keccak256` of real data is never zero, so the two
never collide. `SessionKeyManager._targetAllowed` / `SessionKey7579Module._whitelisted` accept a
proof against either form. Leaf format v2 supersedes the v0.1.0 preimage
(`abi.encode(target, selector)`); pre-mainnet this is a breaking root-format change by design.

## Safe harbour

SigilKit welcomes security research. If you follow this process, we commit to the following:

- **We will not pursue legal action against you** for good-faith research that stays within the
  scope below — including PoCs, automated scanners, fuzzers, and disclosure of a vulnerability to
  us before it is public.
- **We will not revoke your access, unfork your repository, or issue a public demand to remove a
  finding** while you are working with us in good faith.
- **We will not cut you off for "sending it to the press first."** We ask for 90 days (see the
  disclosure window below) so users are not left exposed; we do not condition any future
  relationship on that window.
- **You are not required to sign a CLA, a NDA, or any agreement** to report a vulnerability, and we
  will not ask you to assign the copyright in your PoC.
- **You may run scanners, fuzzers, and load generators against code you have deployed yourself.**
  We do not permit testing against third-party infrastructure, deployed instances belonging to
  other operators, mainnet forking against third-party routers, denial-of-service testing, spam,
  or credential/social-engineering attacks against maintainers or users. (Deployed contracts are
  immutable-by-design pre-mainnet with no upgrade path — see the governance posture section above,
  so there is no privileged backdoor to abuse.)

**In scope:** `contracts/src/`, `packages/*/src/`, and the deploy scripts — including the
EIP-7702 authorization encoder, the ERC-7579 validation/execution path, `SpendPolicy`,
`MerkleWhitelist` leaf construction, session-key scope/rotation/revocation, the 7702 delegator's
self-owned invariant, the indexer's cursor/reorg handling, and the MCP server's path allowlist.

**Out of scope:** findings that depend on a third party you do not control; DoS or resource
exhaustion; anything requiring a leaked or misappropriated credential; theoretical findings with no
demonstrated impact; and issues in dependencies (`lib/forge-std`, `viem`, `node` itself) — report
those upstream.

**What happens to a report:** triage within 7 days, a fix in the next patch release, and public
credit in the release notes unless you ask otherwise. **There is no paid bounty program yet**
(see the bounty-status section below) — please do not report on the assumption of a payout.

---

## Disclosure policy (TD-7)

SigilKit follows a 90-day coordinated-disclosure window. Report vulnerabilities through the
machine-readable channel defined in [`.well-known/security.txt`](.well-known/security.txt)
(RFC 9116): **the primary Contact is the `mailto:` address in that file** (it reaches a human even
while the repository is private or the GitHub advisory page is unavailable); the GitHub Security
Advisories page of the `dev25bansal-ops/sigilkit` repository is the secondary Contact, and this file
is the Policy document. Reports received via either channel are triaged within 7 days; fixes ship in
the next patch release, with credit to the reporter unless they prefer otherwise. The
`security.txt` `Expires` field is set 12 months out and is re-validated by
`scripts/check-doc-counts.mjs` on every CI run — an expired or malformed `security.txt` fails the
workflow-lint job, so the disclosure channel cannot silently rot. The **safe harbour above applies
to every one of these channels.**

## Bounty status (2026-09-23)

**There is no formal paid bounty program yet** — the codebase is pre-audit and unpublished.
Reports submitted through the disclosure channel above get: triage within 7 days, public
credit in the patch release notes unless the reporter prefers anonymity, and a written
root-cause note in the catalog. A paid bounty (scope table + severity ladder) is planned
**after** the external audit lands — do not rely on any informal payout expectation before then.

## Supported versions (2026-09-23, pre-mainnet)

- **Contracts:** the tagged commit deployed on each chain is the only supported surface. No
  upgrade path exists by design before the external audit; fixes land as new tags.
- **@sigilkit/core and workspace packages:** latest published version only, Node >= 24
  (the indexer uses `node:sqlite`, experimental on Node 24; see AC-33 fix note in the catalog).
- **Toolchain:** Foundry pinned to `FOUNDRY_VERSION` in the CI workflows (v1.7.1 as of this
  writing). No backport support before 1.0.

## Key-handling statement

- Production deployments MUST use `SIGILKIT_OWNER_ADDRESS` (a governance contract, e.g. 2-of-3
  Safe). Plain-EOA ownership via `SIGILKIT_OWNER_KEY` is local/test only.
- The SDK never writes private keys to logs: invalid private-key input is rejected without
  being echoed (redaction in `assertPrivateKey`). Keys are env-injected at runtime; the only
  keys committed anywhere are the public Anvil dev keys and the Anvil dev mnemonic (fixtures).
- Exposed-credential hygiene is tracked in the issues catalog (SK-01/AC-01/AC-05): any key
  that ever appears in a log, error, or commit is treated as exposed and rotated.

## EIP-7702 user warnings

- **Delegation is persistent code on your EOA.** Revoke it with `signRevocation` (an
  authorization naming address 0) or via MetaMask's in-UI revoke. Submitting a raw
  zero-address revocation through `eth_sendTransaction` is REJECTED by MetaMask
  (allowlist `metamask:revoke-raw-rejected`, canary-verified on 13.49.0) — do not build a
  product flow on that path.
- **Never sign a delegation to an address you don't own the code of.** Within four weeks of
  Pectra, >97% of mainnet 7702 delegations pointed at copy-pasted sweeper contracts with
  $1.54M+ documented single losses. SigilKit's canonical `SigilKitDelegator` address is the
  only target the SDK ever names.
- **Treat every `signAuthorization` prompt as fully owning that ENTIRE account**, not just
  one transaction: one signed authorization tuple grants persistent control (see
  arXiv:2512.12174). Chain-agnostic (`chain_id=0`) authorizations replay across chains —
  always bind the chain.
- **`extcodesize` no longer distinguishes EOAs.** A delegated EOA carries code; anything
  gating behavior on "this address has no code" (including your own monitoring) is now
  wrong for SigilKit accounts.

---
*Generated from `slither .` runs of 2026-08-22/23, plus the re-run of 2026-09-14 recorded in the
header above (slither-analyzer on solc 0.8.36 output). Those are the only runs folded into this
file; nothing later than 2026-09-14 has been triaged here.*
