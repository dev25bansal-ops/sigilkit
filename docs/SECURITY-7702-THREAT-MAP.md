# SigilKit 7702 Threat Map

**Date started:** 2026-09-23 (30-day plan W1-1.4) · **Status:** living doc — every row ends in a task ID, an audit-prep check, or an accept-with-reason. Sources: `docs/ECOSYSTEM-RESEARCH-2026-09-23.md` §2 (which carries the primary URLs).

**Assessment procedure (per vector):** (1) locate the corresponding trust assumption in `contracts/src/SigilKitDelegator.sol`, the ERC-7579 validation module, and the core SDK's signing path; (2) mark exposure **Exposed / Mitigated / Not-applicable** with the exact code anchor; (3) assign severity (Critical/High/Medium/Low); (4) attach a task ID (W*.*) or an accept-with-reason.

## Vectors

| # | Vector (source) | Where SigilKit touches it | Exposure | Severity | Action |
|---|---|---|---|---|---|
| 1 | `tx.origin == msg.sender` broken by delegation → reentrancy bypass (CertiK 2025-05-06) | **Zero `tx.origin` uses anywhere in `contracts/src/` (grep-verified 2026-09-23)** — SigilKit neither consumes nor guarantees origin invariants. | Mitigated-by-construction | High | W4-1.1 auditor confirm; residual risk is only in target dapps called via `execute` — SECURITY.md warns operators |
| 2 | Flash-loan sandwiching of EOA-code checks (CertiK) | No EOA-code assumptions in src outside the deliberate ERC-1271 check (row 3). | Not-applicable | Medium | Closed with row 3 |
| 3 | `extcodesize` misclassification of delegated EOAs (CertiK) | Only use: `SessionKeyManager.sol:524` (`_recover`) — treats any coded key as an ERC-1271 contract signer. For 7702-delegated EOAs this is the INTENDED semantics (a delegated session key IS a smart key). | Accepted-by-design | Medium | Docs warning added to SECURITY.md (7702 section); W4-1.1 auditor confirm |
| 4 | One signed authorization tuple = persistent control (arXiv:2512.12174) | Grant/revoke lifecycle: revocation must actually clear delegation | Mitigated-by-test: harness asserts raw zero-address revoke is REJECTED by MetaMask. **Verification level corrected 2026-09-28 — see the correction note below this table; the original cell read "canary PASS 13.49.0", which overstated the record.** CI *pins* extension 13.49.0 (`ci.yml:405`); the last recorded harness verification of *this behavior* is **12.5.0 (2026-08)** (`packages/core/test/WALLET_BEHAVIOR_ALLOWLIST.json:38`). No 13.x verification of this behavior is recorded anywhere. | High | Retest each wallet leg: W-1 cadence; allowlist `metamask:revoke-raw-rejected` |
| 5 | ERC-4337 remote activation of the delegation (arXiv:2512.12174) | EntryPoint-reachable surface on a delegated EOA is only `SessionKey7579Module.validateUserOp` (line 193) — every op must carry a valid 4337 signature over `userOpHash` (session-scope-checked via ERC-1271). No unsigned path reaches `ActionLog7579Executor.execute` (requires `msg.sender == account`), and admin paths revert on the delegated EOA (`owner == address(this)` holds). | Mitigated-by-design | High | W4-1.1 auditor confirm against this two-line argument |
| 6 | Chain-agnostic replay via `chain_id=0` authorization tuples (arXiv:2512.12174) | App-layer signatures ARE chain-bound: `_domainSeparator()` (SessionKeyManager.sol:499) encodes `block.chainid` + `address(this)`. The unprotected surface is the 7702 AUTHORIZATION tuple itself (signed at SDK/wallet layer, outside the contracts). | Partial — SDK layer exposed | High | **W3-4.1**: SDK asserts non-zero chainId on authorization build + negative cross-chain replay tests |
| 7 | Sweeper contracts copy-pasted onto delegated EOAs (>97% of early delegations; $1.54M loss 2025-08-24) | Designator address is a fixed, **NOT-yet-audited** contract (pre-mainnet; verification tooling only — no third party has reviewed it, see `../SECURITY.md`) — users must never delegate to arbitrary code | Mitigated-by-design: fixed SigilKitDelegator designator | High | Sweep-guard test in W3-4.1; SECURITY.md warns never to sign delegations to unknown addresses |
| 8 | `validateUserOp`/`postOp` mistakes (Trail of Bits six-mistakes, 2026-03) | ERC-7579 module validation flow (validateUserOp at SessionKey7579Module.sol:193) | Pending checklist | High | W3-3.2 ERC-1271 chain-binding test; W4-1.1 runs all six items |
| 9 | Delegation revocation rejected by raw zero-address tuple (MetaMask #35520) | SDK revoke path must route via in-UI revoke or relayer-signed type-4, never raw eth_sendTransaction | Mitigated: canary mechanism is real and the harness fails on a silent flip; **verification level corrected 2026-09-28 (see note below this table)** — last recorded harness verification of this behavior is **12.5.0 (2026-08)**, not the 13.49.0 the CI pins; allowlist entry `metamask:revoke-raw-rejected` | Medium | Keep canary in every wallet leg run (W-1) |
| 10 | Unbounded authorization nonce reuse / inheritance | App-layer replay is closed by per-key nonces (`getNonce`, line 361) monotonic through `executeWithSessionKey`. Authorization-tuple nonce is SDK/wallet layer. | Partial — SDK layer | Medium | W3-4.1: nonce-non-reuse assertion in SDK authorization builder |
| 11 | **Asymmetric enforcement: the 7579 path has no E10 owner-countersign, and the struct makes it impossible** | `SessionKey7579Module.Scope` (SessionKey7579Module.sol:79-85) declares **5** fields: `expiresAt, windowSeconds, perActionCap, perWindowCap, merkleRoot`. `SessionKeyManager.Scope` (SessionKeyManager.sol:55) declares **8**: the same five **plus `countersignAbove`, `enforceNativeDelta`, `tokenWatchlist`**. `countersignAbove` is the *only* field that triggers E10 (SessionKeyManager.sol:524), so **no 7579 scope can ever require an owner countersign.** | **Unmitigated — structural, not an oversight** | **High** | **DECIDED 2026-09-28 (team-lead): document the asymmetry, do NOT change the struct this cycle.** Adding the three fields is an **ERC-7201 storage-layout change** that conflicts with the storage gate (ck-arch §3.7, current highest priority) and would invalidate already-granted 7579 scopes. Instead: state the asymmetry in `SECURITY.md` and here, so no integrator assumes parity. `docs/ISSUES-CATALOG-2026-09-25.md` SEC-05 tracks the field-level fix. |
| 12 | **MEV / sandwich / front-running of agent actions** | Every enforcement input is public-mempool-visible and there is no privacy mechanism anywhere in `contracts/src/`: caps, expiry and window state are readable on-chain, the `ActionRequest` is a plain EIP-712 payload, and the inner `target.call` is executed in the same transaction. **No commit-reveal, no private relay requirement, no calldata encryption, no batch auction** — grep-verified 2026-09-28 across `contracts/src` (no `commit`/`reveal` mechanism, no oracle/aggregator). | **Unmitigated — no code-level control exists** | **Medium** (High where `merkleRoot == 0`, i.e. target-allow-all, since the whole action shape is public before inclusion) | **PENDING — team-lead decision required, no code change this cycle.** Options: (a) document as a known property of public-mempool execution; (b) recommend a private relay (Flashbots Protect / MEV Blocker) in `DEPLOYMENT.md` for agent-operated accounts; (c) bind the request to a block hash to kill inclusion delay — **not recommended**, it breaks the tumbling-window model. |
| 13 | **Governance capture — one-step ownership transfer with no timelock and no accept step** | `transferOwnership` (SessionKeyManager.sol:331-334) is `onlyOwner` and assigns `s.owner = newOwner` **immediately**: one transaction, no delay, no two-step accept, no pending-owner slot. Its own NatSpec concedes the risk: *"a typo in `newOwner` is immediately unrecoverable."* `SigilKitDelegator.initializeSelfOwned` (SigilKitDelegator.sol:35-46) is likewise one-shot — `if (s.owner != address(0)) revert AlreadyInitialized()` — so a re-initialization front-run against a freshly delegated EOA is a permanent outcome, not a recoverable one. Grep-verified 2026-09-28: **no `timelock`, `timeLock`, `pendingOwner` or `acceptOwnership` exists anywhere in `contracts/src/`.** | **Unmitigated in code; the stated mitigation is an OPERATIONAL control, not a design one** | **High** | The only stated mitigation is `SECURITY.md:48-52`, which *mandates* `SIGILKIT_OWNER_ADDRESS` be a 2-of-3 Gnosis Safe. That is a deployment-posture requirement the code does not enforce and cannot enforce — exactly the "documented control presented as a design control" pattern named in `docs/SECURITY-AUDIT-2026-09-26.md:38`. `initializeSelfOwned` is also **unguarded on the manager path**: it is not in `_seedAdminDenylist` until after it has already run, so a session key cannot reach it, but an EOA that delegates and never initializes leaves the code live with `owner == 0`, which reverts every admin path (`NotOwner`) — safe by accident rather than by design. |

## Correction record — canary verification level (2026-09-28)

Rows 4 and 9 originally read **"canary PASS 13.49.0"** / **"canary PASS on 13.49.0"**. That was an overstatement of the record, and the original wording is preserved here rather than silently replaced:

| What was claimed | What the evidence actually records | Verdict |
|---|---|---|
| rows 4, 9 + `SECURITY.md:196` — *"canary PASS 13.49.0"* / *"canary-verified on 13.49.0"* | `packages/core/test/WALLET_BEHAVIOR_ALLOWLIST.json:38` — `"verifiedOn": "extension 12.5.0 (2026-08 live harness via Playwright + persistent Chromium)"` | The **13.49.0** figure is a real fact but the **wrong fact**: it is the extension version CI *pins and downloads* (`ci.yml:405`, `:396-397`, `:429` manifest check). It is **not** a record that this behavior was observed on 13.x. The last recorded observation of *this* behavior is **12.5.0**. |

**Nothing in the allowlist was changed.** `WALLET_BEHAVIOR_ALLOWLIST.json` is evidence, not prose — its `verifiedOn: 12.5.0` is the accurate record and rewriting it to 13.49.0 would be fabricating a verification that never happened. The error was always in the prose, never in the record. (The `13.48.0` entry at `:28` is a *different* behavior — gesture activation — and was never cited by rows 4/9.)

## Status (2026-09-23, post W1-5.2 deep dive)
- Rows 1, 2, 3, 5, 7, 9: resolved with code anchor evidence — no open work.
- Rows 6, 10: contract layer safe; SDK-layer guards scheduled as **W3-4.1**.
- Row 8: checklist scheduled as **W3-3.2 + W4-1.1** (audit-prep report).
- Row 4: canary cadence continues (W-1).
- **Rows 11, 12, 13 added 2026-09-28 (dc-sec2).** None of the three has a code-level mitigation; see each row's Action column. Row 11 is a deliberate accepted-documentation decision, not a deferral.

---

## Correction record — `validateUserOp` line anchor (2026-10-01, docs-2 audit pass)

Rows 5 (`:15`) and 8 (`:18`) cite `SessionKey7579Module.validateUserOp` at **line 193** /
`SessionKey7579Module.sol:193`. The original cells are preserved; the anchor is annotated rather
than rewritten because the audit documents inside this repository contradict each other about the
correct line:

| Document (in this audit set) | Line it gives for `validateUserOp` |
|---|---|
| `docs/STALENESS-2026-09-26.md` §3.3 line-anchor table (row 5) | `SessionKey7579Module.sol:287` (and `:308` in the same row) |
| `docs/DOC-AUDIT-CONTRACTS-2026-09-26.md:245` (H-01) | `SessionKey7579Module.sol:287` — "Line 193 is inside `isInitialized`'s doc comment" |
| `docs/DOC-AUDIT-CONTRACTS-2026-09-26.md:61` | `SessionKey7579Module.sol:295` |
| `docs/STALENESS-2026-09-26.md` §3.3 confirmations list | `SessionKey7579Module.sol:316` |
| `docs/SECURITY-AUDIT-2026-09-26.md:307` | `:280` |

> **Unverified as of 2026-10-01:** the correct line number was **not re-measured in this pass** —
> the pass had no access to `contracts/src/SessionKey7579Module.sol`. The values above are mutually
> contradictory (280 / 287 / 295 / 308 / 316), so no single one of them can be adopted as
> authoritative here, and **line 193 is not replaced with any of them**. Do not cite line 193, and do
> not cite any of the candidates, until `grep -n "function validateUserOp"
> contracts/src/SessionKey7579Module.sol` has been re-run and the result recorded with its date.