# Docs ↔ Contracts consistency audit — 2026-09-26

**Scope (read-only audit):** `docs/CONFIGURATION.md`, `docs/GETTING-STARTED.md`, `docs/DEPLOYMENT.md`,
`docs/SECURITY-7702-THREAT-MAP.md` vs. all 7 `contracts/src/*.sol`.
**Method:** every technical assertion in the 4 documents was traced to a code anchor. Anchors are given
as `file:line`, but **`contracts/src` was being refactored concurrently while this audit ran** (named
wire-format constants extracted, `validateUserOp` split, NatSpec expanded). Line numbers are therefore
a convenience, not the contract. **§6 is a symbol-anchor index** — resolve a finding by symbol name if a
line number has drifted.

**Result: 39 discrepancies — 9 Critical, 13 High, 12 Medium, 5 Low** (of which **2 are now
resolved** by ck-arch's D-13, and **1 is half-resolved**).
Plus 28 missing-functionality gaps (§2, incl. X-02b) and 9 NatSpec/behaviour contradictions (§3, of
which **1 is now resolved**). **+ 7 further doc-layer defects (§1b X-28…X-34), surfaced by
cross-review rather than by my own pass.**

**Status:** N-05 and H-07 were fixed by ck-arch after I reported them (D-13; both verified against
current source). C-02 is **half-resolved** — the manager side is fixed, the 7579 side is still open
and currently blocked. All other findings open.
**Doc-count drift (9 items): FIXED 2026-09-26 by me — see §6 (re-verified 18:09:30).**

### Outcome metric worth keeping (team-lead)

**The value of an audit is not "how much did I fix" but "how much of what I reported got fixed."**

| Finding | Reported by me | Fixed by | Status |
|---|---|---|---|
| N-05 — `Scope` "all fields immutable" contradicted `rotateSessionKey` | yes | the author, after my report | **closed** |
| H-07 — E10 countersign unusable with a Safe owner | yes | ck-arch (D-13), after my report | **closed** |
| `SECURITY.md` Halmos count unguarded | yes | team-lead (committed `checkSecurityDocCounts`) | **closed** |
| 9 doc-count drifts | no | **me** | **closed, gate-verified** |

**All three findings I reported are closed, and I fixed none of them.** That ratio is the honest
measure of whether a reporting channel works — and a better signal than raw finding count, since a
large count with no closures would mean the reports are wrong, not that the auditor is productive.

> The 4 audited documents were **not modified**. Everything below is a finding for a human fix pass.

---

## Severity scale

| Level | Meaning |
|---|---|
| **Critical** | Following the doc produces a wrong on-chain outcome, funds loss, or a security control the doc claims exists but does not. |
| **High** | Doc states a fact that is false; a reader makes a materially wrong decision (deploy posture, key handling, incident response). |
| **Medium** | Imprecise/stale detail; correctable without changing a decision, but it misleads. |
| **Low** | Cosmetic or trivially stale. |

---

## 1. Inconsistencies (39: 9 C + 13 H + 12 M + 5 L)

### CRITICAL (9)

#### C-01 · `SECURITY-7702-THREAT-MAP.md:15,18` — the 7579 module is NOT reachable from a delegated EOA at all, but the map describes it as the reachable surface

* **Doc says** (row 5): "EntryPoint-reachable surface on a delegated EOA is **only** `SessionKey7579Module.validateUserOp` (line 193)… every op must carry a valid 4337 signature over `userOpHash` (session-scope-checked via ERC-1271)."
  Row 8 repeats "validateUserOp at SessionKey7579Module.sol:193".
* **Code actually is:** `SessionKey7579Module.validateUserOp` opens with
  `if (msg.sender != userOp.sender) revert NotAuthorizedCaller();` (`SessionKey7579Module.sol:295`).
  `userOp.sender` must be an ERC-4337 smart account that itself called `onInstall`
  (`SessionKey7579Module.sol:202-210`, gated on `msg.sender`). A 7702-delegated EOA has **no
  EntryPoint and no module registry**, so it never appears as `userOp.sender` and the module is
  unreachable for it. The entire row-5/row-8 argument is built on a path that cannot exist.
* **Consequence:** the map's "Mitigated-by-design (High)" verdict for the ERC-4337 remote-activation
  vector rests on a fictional attack surface. The real delegated-EOA surface
  (`SessionKeyManager.executeWithSessionKey`, reached by anyone, permissionless) is not analysed in
  the map at all.
* **Fix:** rewrite rows 5 and 8 to state that the 7579 module is a **separate smart-account path**,
  and analyse the delegated-EOA surface (`executeWithSessionKey` + the self-sealing denylist) as
  row 5's real subject.

#### C-02 · `SECURITY-7702-THREAT-MAP.md:15` — "session-scope-checked via ERC-1271" is false for the 7579 module — **STILL OPEN on the 7579 side (partially resolved on the manager side)**

* **Doc says** (row 5): validateUserOp's signature is "session-scope-checked via ERC-1271".
* **Code actually is (re-verified 2026-09-26 ~18:20, after ck-arch's D-13):**
  `SessionKey7579Module._recover` (`:605-647`) is annotated **"EIP-191 ECDSA only"** and calls
  `ecrecover` at `:647`. There is still **no** `extcodesize` probe and **no** `isValidSignature`
  staticcall anywhere in that file (grep-verified). An ERC-1271 smart-contract session key remains
  **structurally impossible** on the 7579 path.
* **⚠️ Scope correction — this finding is HALF resolved, and the surviving half is the 7579 one.**
  D-13 landed `_recoverSigner(digest, sig)` as a single dispatch point in `SessionKeyManager`
  (`:805-828`), and the E10 owner countersign now routes through it (`:515`). So:

  | | 7702 path (`SessionKeyManager`) | 7579 path (`SessionKey7579Module`) |
  |---|---|---|
  | session key supports ERC-1271 | ✅ yes (always did) | ❌ **still ECDSA-only** |
  | owner countersign supports ERC-1271 | ✅ **fixed by D-13** (was permanently unusable) | n/a — no E10 |

  **My original wording ("the two `_recover` implementations are capability-asymmetric … should be
  merged into one helper, which would give the 7579 path 1271 support for free") is now half
  obsolete: the helper exists, and the manager side is fixed; D-16 is still open on the 7579 side
  and is currently *blocked*, not merely undone.
* **Why D-16 is blocked (ck-arch):** giving the 7579 module the shared helper requires a new
  `contracts/src/KeyRecovery.sol`, and `abi-drift.test.ts` directory-scans `contracts/src/*.sol`
  asserting equality with `scripts/abi-targets.txt` — so a new source file fails the ABI-drift gate
  until `scripts/` and a committed ABI JSON are updated together. Both are outside the contracts lane.
  Note ck-arch's sharper reason it is *deliberate for now*: the 7579 proof tail is parsed
  **positionally from the bytes after the 65-byte ECDSA** (`_parseTrailingProof`), so there is no
  length-prefixed field in which to carry a variable-length 1271 blob — 1271 is not a one-line
  addition even once unblocked.
  **✅ Ruled: not scheduled this round (team-lead).** Reasons: (1) a wire-format change plus SDK sync
  plus vector regeneration is not engineering to start during closeout — it would also require
  reworking `GoldenVectors`; (2) the value is *capability symmetry* (letting the 7579 path accept a
  contract owner), **not the repair of a defect**, and the 7579 module's own NatSpec now states the
  ECDSA-only limitation explicitly, so the documentation is honest without it; (3) `contracts/` is
  frozen and SEC-10 is undecided, so a wire-format change would interfere with both.
  **→ backlog, to be evaluated by an owner after SEC-10 and this round's closeout. No action now.**
* **Consequence (unchanged):** a reader concludes the 7579 module supports contract session keys. An
  integrator grants a scope to a smart key and every validation reverts `InvalidSignature` — not a
  silent downgrade, but still a rejected signature. The module's own new NatSpec (`:605-621`) now
  states both the asymmetry and that structural reason explicitly, which is the right place for it.
* **Fix (revised):** correct the threat-map parenthetical to **"7579 path is currently ECDSA-only for
  session keys (ERC-1271 session keys are supported on the 7702 path only)"**, and add an explicit
  ECDSA-only limitation row. **Do not** word it as though the two paths are unified — they are not.
* **Cross-ref (ck-arch D-16):** independently confirmed and sharpened — the two `_recover`
  implementations are **capability-asymmetric**: `SessionKeyManager._recover` has the full ERC-1271
  branch; `SessionKey7579Module._recover` has none. ck-arch notes these should be merged into one
  `_recoverSigner(digest, sig)` helper (zero external ABI change), which would give the 7579 path
  1271 support for free. Worth pairing with this finding — see also D-13 (E10/Safe), which shares
  the same helper-extraction rationale.

#### C-03 · `SECURITY-7702-THREAT-MAP.md:13` — the `extcodesize` anchor points at the wrong line, and the row omits the delegated-key *and* destroy-code cases

* **Doc says** (row 3): "Only use: `SessionKeyManager.sol:524` (`_recover`)". Line 524 in the current
  file is inside `_interact`'s doc comment. The actual `extcodesize` is at
  `SessionKeyManager.sol:698` (inside `_recover`, which begins at `:681`).
* **Also missing:** the row treats delegated session keys as "the INTENDED semantics" but says nothing
  about the two ways that semantics breaks:
  1. **Any coded address is treated as an ERC-1271 contract** (`SessionKeyManager.sol:700` only checks
     `codeSize == 0`). A session key that was a plain EOA and later receives *any* code — including
     via its own 7702 delegation — silently changes the signature encoding it requires.
  2. **A 7702 delegation can be revoked**, dropping the key's code to zero. A scope granted to a
     delegated key stops validating at that moment (revert `InvalidSignature`) — a liveness break the
     map records nowhere.
* **Fix:** correct the line anchor, and split the row into "delegated key = intended" and
  "code appears/disappears on a key = silent encoding change" (liveness risk, not just a semantic note).

#### C-04 · `GETTING-STARTED.md:47-49` — the documented `npm run demo` invocation fails immediately

* **Doc says:**
  ```bash
  anvil &
  npm run demo            # deploy → grant a scoped key → 5 strategy ticks
  ```
* **Code actually is:** `packages/demo-agent/src/cli.ts:142` — `const doGrant = args.has("--grant") || process.env.SIGILKIT_DEMO_GRANT === "1";`.
  Without `--grant` (or `SIGILKIT_DEMO_GRANT=1`) the owner-side branch at `cli.ts:193` is skipped, and
  the flow reaches `cli.ts:321` `if (!adoptedGrant)` → `throw new UserError("internal: no owner grant to adopt")`.
  The CLI's own usage line (`cli.ts:53`) is `sigilkit-demo --grant [--ticks <n>] …`.
* **Consequence:** this is step 3 of a 5-minute quickstart, the first command a new user runs. It
  fails with a message that says "this is a bug" — actively sending the reader to file an issue.
* **Fix:** change to `npm run demo -- --grant`, and document `SIGILKIT_DEMO_GRANT=1` as the env equivalent.

#### C-05 · `GETTING-STARTED.md:51-54` — the demo numbers are right but the stated ordering/effect is wrong in a way that hides the actual cap interaction

* **Doc says:** "deploys `SessionKeyManager` plus a `Counter` target, funds the wallet, grants a
  1-hour session key capped at 0.01 ETH/action and 0.05 ETH/window, then runs five strategy ticks —
  ticks 1 and 3 fire a 0.004 ETH rebalance."
* **Code actually is** (`packages/demo-agent/src/cli.ts:255-264`, `:275-291`): the scope values match
  exactly (3600s / 600s / 10¹⁶ / 5·10¹⁶). Two omissions matter:
  1. The demo scope sets **`merkleRoot: toHex(new Uint8Array(32))` = allow-all** (`cli.ts:260`) — the
     whitelist is **off**, i.e. the demo key can call **any selector on any target**. The doc's
     "enforced on-chain" reads as if the Merkle whitelist were part of the demo.
  2. `enforceNativeDelta: false` and `tokenWatchlist: []` (`cli.ts:262-263`) — no balance-delta
     enforcement, which is the protection that would otherwise bound ERC-20 outflow.
  3. The demo funds the manager with `10n ** 18n` and separately floats the relayer
     `10n ** 17n` (`cli.ts:228-234`); the doc says only "funds the wallet".
* **Severity note:** the numbers being correct is what makes this dangerous — a reader who copies this
  scope shape into production gets an allow-all, no-delta-check key.
* **Fix:** state that the demo scope is deliberately allow-all with delta checks off, and say why that
  is a demo-only posture.

#### C-06 · `DEPLOYMENT.md:20` — `ActionLogger` is documented as emitting `WindowCharged`, which it does not

* **Doc says:** "| `ActionLogger` | Emits `ActionLogged` / `WindowCharged` | No |".
* **Code actually is:** `WindowCharged` is declared and emitted in **`SpendPolicy`**
  (`SpendPolicy.sol:30-36` declaration, `SpendPolicy.sol:81` emit). `ActionLogger.sol` contains only
  the `ActionLogged` event (`ActionLogger.sol:11-18`) and `_logAction` (`:26-34`).
* **Consequence:** an integrator looking for the spend-accounting event greps the `ActionLogger`
  contract, finds nothing, and misses that the event they need is emitted from a library — which also
  means it fires on the 7579 path where `ActionLogged` deliberately does not.
* **Fix:** attribute `WindowCharged` to `SpendPolicy`, and note it is the *only* audit signal on the
  7579 validator path.

#### C-07 · `DEPLOYMENT.md:19` — the deployment table omits the deployed contract's actual owner, so the "one per chain" 7702 claim is unverifiable as written

* **Doc says:** "| `SigilKitDelegator` | EIP-7702 delegation target (one per chain) | No |", and at
  `:86` `cast call $DELEGATOR "owner()(address)"  # must equal $DELEGATOR`.
* **Code actually is:** `SigilKitDelegator`'s constructor is
  `constructor() SessionKeyManager(address(this)) {}` (`SigilKitDelegator.sol:32`). So the
  implementation address **is** its own owner from deployment — `owner() == address(this)` holds
  *immediately*, and `initializeSelfOwned` (`:35`) then reverts `AlreadyInitialized` for that address.
* **Consequence — the verification command is a tautology.** `cast call $DELEGATOR "owner()"` returns
  `$DELEGATOR` for *any* correctly deployed `SigilKitDelegator`, so the post-deploy check cannot detect
  a wrong deployment. It reads as a meaningful invariant check but proves nothing beyond "you deployed
  the contract you meant to."
* **Fix:** replace with a check that discriminates, e.g. `cast call $DELEGATOR "adminSelectorDigest()(bytes32)"`
  against the pinned source-tree value (that is the anchor the code itself documents at
  `SessionKeyManager.sol:236-261`), and state explicitly that `owner() == address(this)` is true at
  construction time, not after `initializeSelfOwned`.
* **✅ UNBLOCKED (was waiting on the ERC-7579 numbering decision).** I had assumed this fix depended
  on the module-type numbering question, because the delegator's `adminSelectorDigest()` override
  folds in an extra selector (`SigilKitDelegator.sol:55-58`, verified). That was wrong: it folds in
  `SigilKitDelegator.initializeSelfOwned.selector`, which is **unrelated to any module-type id**.
  With D-04 settled as 1-indexed, this recommendation can proceed independently — no longer gated.

#### C-08 · `DEPLOYMENT.md:86` + `SECURITY-7702-THREAT-MAP.md` — the "implementation address is permanently inert" guarantee is weaker than stated, because `receive()` is open

* **Doc says** (`DEPLOYMENT.md:81-83`): "Users point their EOA at the implementation; they never
  delegate *into* a proxy. …the implementation address is permanently inert."
* **Code actually is:** `SessionKeyManager.sol:283` — `receive() external payable {}` with the comment
  "fund the wallet so agents can spend from it". The implementation address therefore **accepts
  ETH from anyone, forever**, and holds it: there is no `withdraw` reachable (it is `onlyOwner`, and
  the owner is the contract itself, which can never call itself), and no admin path exists. Any ETH
  sent to the implementation address is **permanently locked**.
* **Consequence:** "inert" reads as "nothing can happen there." In fact the address is a guaranteed
  fund-black-hole, and it is the **canonical, publicly advertised** address users are told to delegate
  to — so the natural user error ("let me top up the implementation address first") loses funds with
  no recovery.
* **Fix:** document the open `receive()` and the permanent lock explicitly, and add a warning not to
  send funds to the implementation address (direct to a delegated EOA instead).

#### C-09 · `SECURITY-7702-THREAT-MAP.md:16` — the `chain_id=0` row's severity is understated and its cross-chain claim is mis-scoped

* **Doc says** (row 6): "App-layer signatures ARE chain-bound: `_domainSeparator()`
  (`SessionKeyManager.sol:499`) encodes `block.chainid` + `address(this)`." Severity **High**,
  exposure "Partial — SDK layer exposed".
* **Code actually is:** `_domainSeparator` is at `SessionKeyManager.sol:631-635` (line 499 in the current
  file is a blank line between `getNonce` and `getWindowState`). The chain binding is real, but the
  row's own framing understates the residual: a
  `chainId == 0` 7702 authorization tuple is signed **outside** the contracts, and
  `SigilKitDelegator`'s designator address is the one thing the *user* chooses. Nothing in
  `contracts/src` validates the authorization tuple at all — the delegator only sees the resulting code.
* **Consequence:** the map's residual-risk line points at "SDK asserts non-zero chainId on
  authorization build". But the SDK is not the only author of that tuple — a wallet builds it. The
  real control is wallet-side; the doc implies an SDK-side fix is sufficient.
* **Fix:** correct the anchor; move the residual risk to the wallet/user layer and keep an SDK-side
  assertion as defence-in-depth only.

### HIGH (13)

| # | Doc:line | Doc says | Code actually | Impact |
|---|---|---|---|---|
| H-01 | `SECURITY-7702-THREAT-MAP.md:18` | `validateUserOp at SessionKey7579Module.sol:193` | `validateUserOp` is at `SessionKey7579Module.sol:287`. Line 193 is inside `isInitialized`'s doc comment | Anchor wrong; combined with C-01/C-02 the row cannot be verified by a reader |
| H-02 | `SECURITY-7702-THREAT-MAP.md:20` | "per-key nonces (`getNonce`, line 361)" | `getNonce` is at `SessionKeyManager.sol:496`. Line 361 is inside `_verifyBalances` | Same; the nonce claim is correct in substance (`SessionKeyManager.sol:452-453`) |
| H-03 | `SECURITY-7702-THREAT-MAP.md:13,15,18,20` | 4 distinct line anchors into `contracts/src` | All four resolve to unrelated code in the current files (C-01, C-02, C-03, H-01, H-02) | A reader auditing these rows cannot find the code; a stale-anchor doc is worse than no anchor because it reads as verified |
| H-04 | `GETTING-STARTED.md:51` | demo deploys "a `Counter` target" | Deployed contract is `CounterTarget` (`cli.ts:210`: `contracts/test/CounterTarget.sol:CounterTarget`) | Wrong artifact name; a reader grepping `Counter` finds a test fixture, not a deployable target |
| H-05 | `GETTING-STARTED.md:76` | `import { … } from "@sigilkit/core"` presented as the SDK example | `@sigilkit/core` is **not published** and the scope is taken by an unrelated project (`DEPLOYMENT.md:112-117`, `.env` note) — the doc's own blockquote says so, but the example below still uses the bare specifier | Copy-paste fails at resolution; the blockquote disclaimer is 3 lines above working code, so it is read as a temporary caveat |
| H-06 | `GETTING-STARTED.md:88-97` | The example `Scope` includes `countersignAbove`, `enforceNativeDelta`, `tokenWatchlist` | Correct **as a type** (`packages/core/src/types.ts:8-41`), but the doc never explains what these do, and the doc set has **no** coverage of E10/E11 semantics anywhere | A reader sets `enforceNativeDelta: false` (as the doc's own demo does) with no idea they have disabled token-outflow protection |
| H-07 | `DEPLOYMENT.md:44-53` | "`SIGILKIT_OWNER_ADDRESS` … If unset, the broadcaster becomes the owner. On any persistent network, set it to a Safe" | `Deploy.s.sol:26-33` behaves as documented. **The E10 incompatibility is now FIXED (ck-arch D-13):** the owner countersign validates through `_recoverSigner(approvalDigest, ownerApproval)` (`SessionKeyManager.sol:515`), which has an ERC-1271 branch — so a Safe owner is now viable. Zero external ABI change. | **Was:** following the doc's own recommendation (Safe owner) made every `countersignAbove`-gated action permanently unusable. **Now:** the doc's posture is sound and needs no caveat. Kept in the table as a **resolved** finding because the doc was never wrong — the code was, and has been fixed to match the doc. |
| H-08 | `DEPLOYMENT.md:135-139` | "Internal dependencies are pinned to `^0.1.0` — never `"*"`" | Grep for `@sigilkit/` in `packages/*/package.json` returns **0 matches** — there are currently no internal cross-package dependencies at all | The claim is vacuously true but reads as if a pinning policy is in force and being maintained. When someone adds the first `@sigilkit/core` dep, the doc implies a check exists; none does |
| H-09 | `DEPLOYMENT.md:119-121` | "Publishing is tag-driven — `.github/workflows/publish.yml` runs on a `v*` tag" | `.github/workflows/publish.yml` exists; the doc also asserts the workflow "checks npm scope ownership up front" (`:116`, `:258-260`) | Consistent, but the check's failure text is asserted, not verifiable from the repo (network-dependent). Flagged so a reviewer confirms against the workflow rather than trusting the doc |
| H-10 | `GETTING-STARTED.md:146` | "Four tools: `validate_request`, `build_scope`, `decode_error`, `audit_query`" | Tool **names** match (`packages/mcp/src/server.ts:463,497,620,626`). But `audit_query` is inert unless `SIGILKIT_AUDIT_DB_ROOT` is set (`server.ts:241-247`) — see M-04 | A reader wires up the MCP server, calls `audit_query`, and gets a "disabled" error with no doc explaining why |
| H-11 | `DEPLOYMENT.md:219-221` | "`audit_query` takes the database path per call and opens it read-only… pointing it at a missing file returns a 'database not found' result instead of writing anything" | Read-only is accurate. The **fail-closed allowlist is undocumented** (`server.ts:150-189, 241-247`): unset ⇒ *every* path refused; relative allowlist entries are dropped with a warning; symlinks are resolved | Understates the operational requirement. An operator reads "takes the path per call", never sets `SIGILKIT_AUDIT_DB_ROOT`, and concludes the tool is broken |
| H-12 | `SECURITY-7702-THREAT-MAP.md:19` (row 9) and `:14` (row 4) | "canary PASS on 13.49.0" / "canary PASS 13.49.0" | `SECURITY.md:156` does say "canary-verified on 13.49.0" — but the machine-readable allowlist records the behavior as verified on **extension 12.5.0** (`packages/core/test/WALLET_BEHAVIOR_ALLOWLIST.json:38`), and a sibling entry states "no live-harness coverage exists for this behavior (only the revoke-rejection canary runs)" (`:48`) | Two records of the same wallet behavior disagree on the version it was verified on, and the allowlist — the file the CI gate reads — carries the older number. The threat map inherits whichever it read. A regression on 13.x would not be caught by a check pinned to 12.5.0 |
| H-13 | `SECURITY-7702-THREAT-MAP.md:14` (row 4) | "Mitigated-by-test: harness asserts raw zero-address revoke is REJECTED by MetaMask" as the *sole* control for "one signed tuple = persistent control" | The canary exists (`packages/core/test/wallet-e2e/run.ts:476`) and is allowlist-driven (`:515-516`), but it only runs under `RUN_WALLET_E2E=1` + a real browser + MetaMask — i.e. **never in `npm run verify`**. The row's "Action" column defers to a "W-1 cadence" not defined anywhere in the repo | The control is real but is an opt-in manual harness, presented in the map as a standing mitigation. `SECURITY.md:99-100` also states the actual revocation path is the SDK's `signRevocation` — which the threat map never mentions |

### MEDIUM (12)

| # | Doc:line | Doc says | Code actually |
|---|---|---|---|
| M-01 | `CONFIGURATION.md:36-37` | `SIGILKIT_OWNER_KEY` default = "Anvil account #0"; `SIGILKIT_AGENT_KEY` default = "Anvil account #1" | Correct for the demo (`packages/demo-agent/src/devkeys.ts:44-45`). But a **third** key is read: `SIGILKIT_RELAYER_KEY` (`devkeys.ts:149`), undocumented in both `CONFIGURATION.md` and `.env.example` |
| M-02 | `CONFIGURATION.md:36-37` | The two default keys are "allowlisted in `.gitleaks.toml`" | `.gitleaks.toml` exists, but the demo module now derives the **relayer** key from a public string rather than hardcoding it (`devkeys.ts:46-52`), and enforces a non-loopback guard at import time (`devkeys.ts:154-158`). Neither the guard nor the third key is in the doc |
| M-03 | `CONFIGURATION.md:34-37` | Runtime table lists 4 variables | `SIGILKIT_DEMO_GRANT` is read by the demo CLI (`packages/demo-agent/src/cli.ts:142`) and gates the entire owner-side flow — see C-04. Undocumented |
| M-04 | `CONFIGURATION.md:73-83` + `GETTING-STARTED.md:130-147` + `DEPLOYMENT.md:203-221` | The indexer/MCP env table is presented as the complete set | `SIGILKIT_AUDIT_DB_ROOT` is a **required** MCP variable (`packages/mcp/src/server.ts:151, 241-247`) and appears in none of the three documents nor in `.env.example`. Highest-impact omission in this group (see H-10/H-11) |
| M-05 | `CONFIGURATION.md:129` | "`--confirmations <n>` … On a chain whose head is at or below this value, `backfill` now **fails loudly** (exit 1)" | Correct, and stronger than stated: the guard fires on the **chain head**, not on the requested end, and `--to` is explicitly not an opt-out (`packages/indexer/src/indexer.ts:962-971`, BUG-16) | 
| M-06 | `CONFIGURATION.md:129` | fails with "exit 1" | `UserError` → `EXIT_RUNTIME` = 1 (`packages/core/src/cli.ts:21, 39`); correct. But the AC-32 error is thrown as a plain `Error` from `backfill`, not a `UserError`, so it is classified as an **unexpected** error and prints a **stack trace** (`cli.ts:403-409`). The doc's exit-code table implies a clean one-line failure | 
| M-07 | `CONFIGURATION.md:154-171` | "Every CLI uses the same three codes" | Correct (`cli.ts:20-22`). However `verify.mjs` exits **2** on a bad invocation (`scripts/verify.mjs:177`) and the indexer/MCP/demo CLIs all accept `--help`/`--version` exiting 0 (`cli.ts:385-394`) — the doc never mentions `npm run verify -- --list/--json/--only` (`verify.mjs:57-61`), which is the one flag surface with its own semantics |
| M-08 | `CONFIGURATION.md:146-152` | `sigilkit-demo` flags: `--rpc`, `--chain-id`, `--ticks`, `--tick-delay`, `--json` | Two flags are missing: **`--grant`** and `--grant-tx` / `--counter` (`cli.ts:61-70`). The missing `--grant` is the difference between the command working and failing (C-04) |
| M-09 | `DEPLOYMENT.md:94-99` | Post-deploy checklist runs `Deploy.s.sol` then `cast code $MANAGER` then `cast call $MANAGER "owner()"` | The checklist never deploys or verifies `SigilKitDelegator`, `SessionKey7579Module`, or `ActionLog7579Executor` — all three are in the "What gets deployed" table (`:22-24`) but no step deploys them. A reader following the checklist ends up with a chain that cannot use 7702 or 7579 at all |
| M-10 | `DEPLOYMENT.md:98` | `forge test --match-contract '.*Fork' --fork-url "$RPC_URL"` as a post-deploy smoke test | `RPC_BASE` is the variable the CI fork job actually uses (`.github/workflows/ci.yml:303`); the doc reuses the deployment RPC name. Minor, but it is the exact flag/env pair the "Live smoke" step needs |
| M-11 | `GETTING-STARTED.md:16-18` | "The indexer uses the built-in `node:sqlite` module, which is only stable from Node 24" | Consistent with `package.json:12` (`"node": ">=24"`) and `bootstrap.mjs:34`. Correct as written; listed for completeness since it is one of the few hard technical claims in the doc set that fully holds |
| M-12 | `docs/CI-WAIVERS.md:14` **and** `.github/workflows/ci.yml:393-394` (identical wording in both) | Criterion: "14 consecutive green nightly runs (**on or after 2026-09-26 if every run since 2026-09-12 passed**)" | The **"Expiry hard stop" is `2026-10-31`**, and the machine gate `scripts/check-waivers.mjs` enforces expiry as `today >= expiry` (`check-waivers.mjs:365-373`). Verified by running it: `node scripts/check-waivers.mjs` → **exit 0, "evaluated 2026-09-26"**; `--today=2026-10-31` → **exit 1**, flagging this row *and* `wallet-e2e-weekly` as expired. So the 14 runs must all land inside the ~5 remaining weeks to 2026-10-31; the 2026-09-26 date is the *earliest start*, not a completion date | Surfaced by ck-test reading this cell as "the waiver is judged expired today". Nothing is expiring today, so the urgency is unfounded — but the wording is genuinely ambiguous, it is **duplicated verbatim in the workflow**, and the ambiguity has already made one competent reader draw the wrong conclusion and act on it. Suggest rewording both to: "14 consecutive green nightly runs, all on or after 2026-09-26; hard stop 2026-10-31" |

### LOW (5)

| # | Doc:line | Doc says | Code actually |
|---|---|---|---|
| L-01 | `GETTING-STARTED.md:29` | "`npm run setup` … builds all four packages" | 4 workspace packages exist (`core`, `indexer`, `mcp`, `demo-agent`) and `bootstrap.mjs:135` runs `npm run build` across workspaces — correct, though `demo-agent` is private and not a published package. "Four packages" is right; the doc set never states which four |
| L-02 | `GETTING-STARTED.md:30` | "Flags: `--no-install`, `--no-build`" | Correct (`bootstrap.mjs:23-24`), but a third flag **`--install`** exists (`bootstrap.mjs:31`, 113-133) and is the documented Windows workaround for `npm ci` handle failures — an omission a Windows user (this repo's primary OS) will hit |
| L-03 | `DEPLOYMENT.md:11` | Foundry prerequisite "1.7.x" | CI pins `v1.7.1` (`.github/workflows/ci.yml:32`, `publish.yml:15`) — consistent |
| L-04 | `DEPLOYMENT.md:112-117` | "`@sigilkit/core` already exists on npm (v0.11.1)" | External fact, un-reverifiable offline. Carried forward verbatim as a *stated* fact; flagging so a human re-checks it, since §4 of the same doc admits these checks were "historical, not re-run for this revision" (`:244`) |
| L-05 | `DEPLOYMENT.md:270` | Recovery names `validateCursor` / `fetchRangeWithStableEnd` in `packages/indexer/src/indexer.ts` | Both exist (`indexer.ts:809` region, `:875`). Correct. Listed to mark that the rollback guidance's anchors are the only code anchors in the doc set that still resolve |

---

## 1b. Cross-review findings (3, raised by ck-test on 2026-09-26)

These are **doc-layer** findings in my lane that surfaced from reviewing ck-test's coverage audit
rather than from my own pass. Each is a case of a *document* asserting a status the code does not
support — my primary finding class, reached by a different route. Not re-verified by me beyond what
is cited; ck-test owns the underlying test-layer analysis.

| # | Doc | Doc says | Reality | Severity |
|---|---|---|---|---|
| X-28 | `docs/ISSUES-CATALOG-2026-09-25.md:134-143` (SEC-08b) | SEC-08b is recorded with a **fix** ("`vm.assume(block.timestamp < expiresAt)` … fix", 0.5 d, Week 1 P1) and is treated as closed | The `atLiveClock` modifier now exists (`HalmosAuth.t.sol:91-97`) and does pin the clock, so the *stated* mechanism landed. But `check_execute_WindowSpendNeverExceedsCap` (`:173-181`) asserts `spentThisWindow <= 2 ether` while the scope's real `perWindowCap` is `2 ether` (`:51`) and `perActionCap` is `1 ether` (`:50`) — the assertion is satisfied by construction for any single execution, so the property remains tautological for a **different** reason than the one SEC-08b diagnosed. The catalog entry should record that the vacuity was relocated, not removed | **High** — a closed status on an audit-prep doc is exactly what an auditor reads |
| X-29 | `docs/ISSUES-CATALOG-2026-09-25.md` (BUG-18 / `EchidnaProperties.t.sol:63-72` NatSpec) | The suite's own comment states the waiver "is exactly what let a suite whose two headline properties were VACUOUS … stay green for weeks, which is the failure mode BUG-18 fixed" — i.e. BUG-18 is presented as **fixed** | `echidna_windowSpendUnderCap` (`:308-315`) compares `spentThisWindow` against `ghostMaxPerWindowCap`, whose smallest assigned value is `0.2 ether` (`:214`, shape 0), while the only tier that moves real value is tier 1, capped at `1 + (valueSeed >> 2) % 1e9` wei (`:161`). With Echidna's `balanceAddr` float (~`0xffffffff` wei/sender), the cap is unreachable in a 50k-transaction campaign, so the property still cannot fail. BUG-18 fixed the *funding* and the *re-grant shape* vacuity, not this one | **High** |
| X-30 | `docs/CI-WAIVERS.md:14` + `.github/workflows/ci.yml` | The `echidna-nightly` waiver is `continue-on-error: true` and its removal criterion is "14 consecutive green nightly runs" | Independently of the vacuity above, **a green run of a vacuous property satisfies this criterion** — so the register's own rule #3 ("red runs don't reset silently") counts runs that measure nothing toward removing a waiver. Any future reader of `CI-WAIVERS.md` will read "14 green runs" as evidence of coverage | **High** — a governance doc whose success metric is satisfiable by a no-op |

**Suggested wording for X-29/X-30** (for whoever owns the fix): state in `CI-WAIVERS.md` that the
echidna job's green runs are **coverage instrumentation, not correctness evidence**, and that the
14-run criterion counts *runs completed*, not *properties proven*. The `EchidnaProperties.t.sol`
NatSpec at `:70-72` already says something close to this — the defect is that the register does not.

**④ Concurrent-environment sampling (ck-perf) — "we both saw it" is not "we agree on the cause".**
ck-perf's sequence: I ran `ERR_MODULE_NOT_FOUND: yaml`, inferred "wiped", escalated to team-lead; he
then queried the tree, found the残缺 state, and reported it as *"relaying your transient
observation"*. **Wrong: he was sampling the same phenomenon I was, and mistook his sample for
confirmation of my explanation.** Concretely — I hit the **cause**, he hit the **consequence**, and
"we both saw it" was then used as if the causal claim were corroborated. **This is the most
insidious of the four classes because it is dressed as confirmation** — a second independent
observation feels like corroboration, while the second observer was in fact only verifying the
phenomenon, never the explanation. It is most likely exactly when the second person was prompted to
look *by* the first person's message.

**⑤ "The cause is not here" ≠ "this is fine" (ck-perf).** On the junction: "dependencies are
complete, so `npm ci` is not needed" is true, and "nothing is blocking" is false — the e2e test is
red and it does need policy relief. A correct root-cause exclusion is not a clearance. I conflated
the two, which is how a correct finding got used to dismiss a real problem.

---

## 1c. A closeout trap: a registered red test that mimics the P0 symptom

⚠️ **Recorded because it is the most likely way this round's work gets wasted at handoff.** ck-perf
surfaced it; I reproduced it (2026-09-26 ~19:00, `forge test --match-contract Sec10WindowRotationTest`).

`forge test` full run is **red on exactly one test**, and it is `test_Sec10_LineageWindowCap`,
failing with `4000000000000000000 > 2000000000000000000` — a **window cap exceeded** message.
**The SpendPolicy P0 was also a window cap not being enforced, and it failed the same way.** A
reader scanning the failure list at closeout can therefore conclude either that the P0 is unfixed or
that its fix was incomplete — and act on it. **Both conclusions would be wrong.**

The trace distinguishes them, and the distinction is the whole point:

| | SpendPolicy P0 (fixed) | SEC-10 (open, by design) |
|---|---|---|
| Failure text | window cap not exceeded when it should be | window cap exceeded when the business says it should not be |
| What it means | **the guard was broken**; the test correctly caught it | **the guard works**; the *semantics* allow bypass |
| Per-window arithmetic | cap silently not applied | **each window respected its 2e18 cap** |
| Status | fixed at `SpendPolicy.sol:80` (clean single condition, no `&&` residue — re-verified) | registered in `docs/CI-WAIVERS.md:63`, **intentionally red**, expiry 2026-10-31 |

In the SEC-10 trace, **`rotateSessionKey` is called 2 times, producing 3 keys**, and `WindowCharged`
fires **4 times** — two spends of 1e18 on each of the **first two** keys (the third key is rotated in
at the end of round 1 and never spends). So **each key spends 2e18**, which is exactly
`perWindowCap = 2e18` — **at the cap, never over it.** Only the test's own `lineageSpend` accumulator
reaches 4e18, and that is the value being asserted against the cap.

**⚠️ Two corrections to my earlier description of this trace (ck-perf, both verified against
`Sec10WindowRotation.t.sol:399-423` and the `-vvv` trace).** I had written "three successive
`rotateSessionKey` calls each **reset** `windowStart`/`spentThisWindow`, each key spends **1e18**."
Both halves were wrong:

1. **2 rotations, not 3** — the loop is `uint256[2] memory pks` with `++round`, so 2 rounds each
   ending in one rotation = 2 calls, 3 keys.
2. **2e18 per key, not 1e18** — each key spends 1e18 **twice**. The test's own comment at `:416-418`
   says so correctly: *"`spentThisWindow` is per key and reads **2 ether** on each of the three
   keys."* My 1e18 figure contradicted a comment that was sitting in the file.

**And the more consequential error: no `windowStart` was ever "reset".** `distinct windowStart` is
**1** for the whole run (`vm.warp(1)`, `windowSeconds: 3600`, time never advanced). What actually
happens is that **each new key gets a fresh `windows[key]` slot**, which is zero-initialised and
therefore takes `SpendPolicy`'s `start == 0` branch, stamping it with the current `block.timestamp`.
**That is slot initialisation, not time reset — and the distinction is exactly what determines the
Option A fix.** Option A is *"copy `windows[oldKey]` into `windows[newKey]` inside `_grant`"*, a
carry-over; it **does not touch time semantics at all**. Had I written "rotation resets the window",
the next implementer would have gone looking for a time-based fix and taken the wrong first step.

So `perWindowCap` is being enforced exactly as written; the open question is whether a key's
*lineage* should share one budget — a catalog decision (Option A / Option B in the waiver row), not a
code defect.

**One implementation detail for whoever picks up Option A — corrected below; my first version was a
dimensional error (ck-perf).** Both rotations pass `overlapEnds = block.timestamp + 1 hours`
(= `3601` at `block.timestamp == 1`) while `windowSeconds = 3600`. **My earlier claim that "the
overlap window is one second longer than the spend window, so Option A must decide whether that
trailing second counts" was wrong**, for two reasons:

1. **Different dimensions.** `overlapEnds` is an **absolute unix timestamp** (what the old key's
   `expiresAt` is truncated to); `windowSeconds` is a **relative duration**. `3601` and `3600` differ
   by 1, but subtracting one from the other is meaningless — the "one second longer" reading does not
   survive contact with the units.
2. **No overlap branch is even taken.** `vm.warp` appears **0 times** in
   `Sec10WindowRotation.t.sol` (the file says so itself at `:280` — "no warp at all"), so
   `block.timestamp` stays `1` and `overlapEnds = 3601 > now`. `_grant` therefore takes its **`else`
   branch** (`s.scopes[oldKey].expiresAt = overlapEnds`) — the old key is **not revoked**, only
   re-dated. **`3601` has no bearing on window accounting at all.**

**What Option A actually is, mechanically (ck-perf, and I verified the anchor):** `windows[...]` is
touched in **exactly two places** in `SessionKeyManager.sol` — `:546` (`s.windows[signer].enforce(...)`
in `executeWithSessionKey`) and `:583` (the `getWindowState` read-only view). **`_grant` never touches
`windows`.** So Option A is pure **state transfer**: copy `windowStart` and `spentThisWindow` from
`windows[oldKey]` to `windows[newKey]`. `windowStart` remains an absolute timestamp after the copy, so
`enforce`'s `block.timestamp >= windowStart + windowSeconds` test is **unchanged**. **There is no
`overlapEnds` or time-boundary decision point in Option A.** The only owner decision is the catalog
semantic one: *should rotation inherit the budget?* (A = inherit, B = not inherit and reset).

**And a coverage caveat that follows from the above:** because the test never advances time, it does
**not** exercise the `overlapEnds`-already-elapsed branch (old key revoked outright). **Neither A nor
B should treat that path as verified.**

**⚠️ The first methodology rule, and it outranks everything else in this section (team-lead, and it is
a correction to how I framed my own §5 entry):**

> **"The cause is not here" ≠ "this is fine."** Eliminating one cause proves only **that it was not
> that cause**; it cannot prove **there is no other cause.**
> **The dangerous form: using one correct elimination to declare a whole area healthy.**
> **Operable form: list every candidate cause and mark each "eliminated / not eliminated / cannot
> eliminate" — do not stop at the first one you knock down.**

**It is a two-step error, and the second step is the actual defect (team-lead's decomposition — sharper
than my original framing, because it explains why I stopped rather than merely what I got wrong):**

1. **Correctly eliminate one cause.** This step is fine.
2. **Use that elimination to close the whole question.** ← **the defect.** It promotes a *partial*
   conclusion into a *complete* one.

My instance: I correctly eliminated `npm ci`, and then said "no blocker" — while the junction block
was real, **and at least five people were reporting the junction problem at that moment.** The
elimination was true and it buried a live blocker. This is more fundamental than the taxonomy in
§1c, because it is a defect in the *form* of elimination reasoning, and the taxonomy is one of its
instances.

**Reporting form, adopted team-wide:** after eliminating a cause, **enumerate the remaining candidates
and label each one.** "Not eliminated" and "cannot eliminate" are both acceptable answers; **"no
problem" is not, unless every candidate has actually been ruled out.**

**Practical rule for whoever closes this out:** a red test is only evidence of a regression if it is
red *for a new reason*. `docs/CI-WAIVERS.md` is the register of intentionally-red assertions, and
the "red run" is expected until 2026-10-31. Check the failure is a *registered* one before treating
it as a break.

**The executable form of that rule (ck-perf's contribution, promoted by team-lead) — order matters:**

```powershell
# 1. Is the failing test a registered, intentionally-red assertion?
Select-String -Path docs/CI-WAIVERS.md -Pattern '<failing test name>'
#   HIT     → registered expectation: read its expiry + removal criterion, do NOT treat as a regression
#   MISS    → treat as a new regression
# 2. Only then decide *what kind*: read the -vvv trace, NOT the failure message.
```

**The order is the whole point.** This round I ran `forge test` first, saw `4e18 > 2e18` — a message
that reads exactly like the SpendPolicy P0 — and only *then* confirmed it was registered. Had I
concluded from the message, I would have reported a fixed P0 as broken. **Two problems of completely
different character can produce literally identical failure text**, so the message cannot classify the
failure; only the trace can. Distinguishing evidence: in SEC-10 every `spentThisWindow` value stays
≤ 2e18 (the guard is working), whereas the P0's signature would be the cap never being applied at all.



---

## 2. Missing from the documentation (28 items)


Everything in this section **exists in `contracts/src` or the services** and is **absent from all four
audited documents**. Ordered by how likely a reader is to hit it.

### Security-critical, undocumented (8)

| # | Missing | Anchor | Why it matters |
|---|---|---|---|
| X-01 | **`countersignAbove` / E10 graduated authority** — the whole owner-countersign mechanism, its `RequestApproval` typehash, `ownerApproval` argument, and the owner's-key exemption | `SessionKeyManager.sol:53, 110-111, 401-405, 431-448, 516-518, 689-691, 735-737` | `GETTING-STARTED.md:94` shows the field in an example with zero explanation. A reader cannot construct a valid `ownerApproval` from the docs. Directly causes H-07 |
| X-02 | **`enforceNativeDelta` / E11 balance-delta verification** | `SessionKeyManager.sol:54, 516, 550-580` | Same: appears as `false` in the example (`GETTING-STARTED.md:95`) with no semantics. This is the control that would stop an ERC-20 drain; a reader cannot tell it exists |
| **X-02b** | **E11's gas cost is not derivable from any document** — not merely undocumented | see below | **Upgraded from X-02 by ck-perf's measurements.** The gap is worse than "E11 has no docs": a reader cannot compute the cost even in principle. See §2.1 |
| X-03 | **`tokenWatchlist` (max 8) + declared-outflow rules** | `SessionKeyManager.sol:55, 113, 377, 553-554, 574-579, 749-767` | The 8-token cap, and the fact that only `transfer`/`transferFrom` declare a non-zero tolerance (`_declaredTokenOutflow`), are documented nowhere. A reader adds a watchlist entry and believes all token outflow is bounded |
| X-04 | **ERC-1271 smart-contract session keys (E17)** — the 65-byte-vs-other signature split, the 20-byte address prefix, the dual magic values, and the SEC-11 strictness | `SessionKeyManager.sol:139-140, 162, 637-709` | Zero mentions in the four docs. This changes the **signature wire format** — an SDK implementer building from these docs produces signatures the contract rejects |
| X-05 | **`NativeDeltaExceeded` / `OwnerCountersignRequired` / `InvalidOwnerApproval` / `ValueNotAccepted` / `OverlapBeyondOldExpiry` / `WithdrawFailed`** errors | `SessionKeyManager.sol:25-41` | `GETTING-STARTED.md` points at `TROUBLESHOOTING.md` for error decoding; none of these six are named in the audited set |
| X-06 | **The self-sealing denylist** — `onlyOwner` adds its own selector to the denylist on every successful admin call, and `adminSelectorDigest()` is the review anchor | `SessionKeyManager.sol:167-185, 236-261` | The single most distinctive security property of the manager, and the only thing keeping the denylist exhaustive as admin functions are added. Documented in code comments only |
| X-07 | **ERC-1271 magic-value strictness (SEC-11)** — only a 4-byte bare return or an exact 32-byte word is accepted | `SessionKeyManager.sol:637-674` | An operator choosing a "signature service" contract has no documented way to learn that a contract returning the magic with garbage in the low 28 bytes is rejected |
| X-08 | **`WindowCharged` is the *only* audit signal on the 7579 validator path** | `SpendPolicy.sol:26-36, 81`; `SessionKey7579Module.sol:32-33` | The module's own NatSpec says it emits no `ActionLogged`; the pairing is documented in the library, not the docs. Compounds C-06 |

### Contract surface undocumented (11)

| # | Missing | Anchor |
|---|---|---|
| X-09 | `owner()`, `getScope`, `isRevoked`, `getNonce`, `getWindowState`, `isSelectorDenied`, `DOMAIN_SEPARATOR`, `ACTION_REQUEST_TYPEHASH`, `REQUEST_APPROVAL_TYPEHASH` | `SessionKeyManager.sol:291-293, 488-518` |
| X-10 | `withdraw` + `TreasuryWithdrawal` — the owner-only treasury recovery path | `SessionKeyManager.sol:96, 311-321` |
| X-11 | `rotateSessionKey` + `SessionKeyRotated` — the recommended key-rotation mechanism `DEPLOYMENT.md:271` tells you to use after a compromise | `SessionKeyManager.sol:92, 329-367` |
| X-12 | `SessionKeyReinstated` — the only observable signal that a revoked key was silently un-revoked by a re-grant | `SessionKeyManager.sol:94-95, 301-305, 348-350` |
| X-13 | `OwnerOnlySelectorSet` | `SessionKeyManager.sol:93, 386-389` |
| X-14 | `adminSelectorDigest()` as an off-chain review/gate value (with the `cast call` invocation) | `SessionKeyManager.sol:236-261` |
| X-15 | `initializeSelfOwned` + `AlreadyInitialized` — the mandatory first call after delegation, and the only way the delegator's denylist gets seeded | `SigilKitDelegator.sol:30, 35-46` |
| X-16 | The 7579 wire formats: the 65-byte ECDSA + `uint16` proof-count tail for single calls, and the per-tuple batch proof tail; `MAX_BATCH_SIZE=8`, `MAX_TOTAL_PROOF_ELEMENTS=32`, `MAX_SINGLE_PROOF_ELEMENTS=8` | `SessionKey7579Module.sol:35-48, 90-101, 380-430` |
| X-17 | 7579 `ScopeGranted` / `ScopeRevoked` / `SelectorDenylistSet` / `ModuleUninstalled` / `AgentBound` / `AgentUnbound` events, and `isModuleType` (1 = VALIDATION, 6 = EXECUTOR) | `SessionKey7579Module.sol:120-123, 128-130`; `ActionLog7579Executor.sol:22-25, 42-44` |
| X-18 | `ActionLog7579Executor`'s trust boundary — the `agentId` is an **account-asserted claim, not an attestation**, and must be pinned at install time to be trustworthy | `ActionLog7579Executor.sol:63-73` |
| X-19 | The executor's `msg.value != value` requirement (it never holds funds; the account must forward value), and `EmptyAgentId` | `ActionLog7579Executor.sol:104-115` |

### Service/tooling undocumented (8)

| # | Missing | Anchor |
|---|---|---|
| X-20 | `SIGILKIT_RELAYER_KEY` | `packages/demo-agent/src/devkeys.ts:149` |
| X-21 | `SIGILKIT_DEMO_GRANT` | `packages/demo-agent/src/cli.ts:142` |
| X-22 | The import-time guard refusing Anvil dev keys against a non-loopback RPC | `packages/demo-agent/src/devkeys.ts:98-129, 154-158` |
| X-23 | `SIGILKIT_AUDIT_DB_ROOT` (required for `audit_query`; unset ⇒ tool disabled) | `packages/mcp/src/server.ts:150-189, 241-247` |
| X-24 | Indexer SEC-15 chain-identity binding: every fetch asserts the RPC's own `eth_chainId` and **refuses to write** on mismatch | `packages/indexer/src/indexer.ts:35-44, 818-867` |
| X-25 | `validateAgainstScope` in the SDK mirrors only **5** of the on-chain checks — it does **not** model E10 or E11, so the SDK can say "ok" for a request the chain will revert | `packages/core/src/signing.ts:454`; independently recorded at `docs/ISSUES-CATALOG-2026-09-25.md:485` |
| X-26 | `validateAgainstScope` returning `ok:false` with a reason, and the `verdict.reason` field used in `GETTING-STARTED.md:100-101` — the doc uses it without ever naming the return shape | `packages/core/src/signing.ts:454-456` |
| X-27 | The Merkle leaf **v2** convention (pinned `argsHash` vs wildcard `argsHash == 0`) that `targetLeaf`'s optional `data` argument implements | `MerkleWhitelist.sol:6-10`; `packages/core/src/signing.ts:329-331` |

| ④ Dimensional comparison (ck-perf) — "these two numbers look comparable" is the most dangerous
signal, because it removes the urge to verify. My three published errors had *different*
mechanisms, so one defence does not cover them:

| # | Mechanism | Correct defence |
|---|---|---|
| 1 | counting by **eye** from trace text ("3 rotations") | count a machine-countable quantity |
| 2 | **accepting someone else's** number without re-running it | re-run it yourself |
| 3 | **comparing two values of different dimensions** | confirm units before comparing |
| 4 | **concluding from an `exit 2`** that a dependency was broken | read the message; non-zero ≠ the thing you assumed |

The third is the most insidious precisely *because* it needs no tool: `3601` and `3600` look
comparable, differ by 1, and "one second longer" feels like arithmetic that cannot be wrong. **That
convenience is the hazard** — a claim requiring no verification is exactly the one nobody checks.
`overlapEnds` (an absolute timestamp) and `windowSeconds` (a duration) differ by one *number* and by
an entire *quantity*. Rule: **before comparing two values, confirm they share a unit — and if the
comparison feels obvious, that is precisely when to check.**

**⑤ Adjacent line numbers are not the same fact (ck-perf, found by re-checking his own claim).** For
two rounds he stated "`.gitignore:101` covers the probe, so it can't pollute a commit," and I verified
`scripts/.bench-probe-*` at `:121` and treated that as corroborating him. **It did not — we were
describing two different directories with two different rules.** `git check-ignore -v` settles it:

```
.gitignore:101:.sigilkit-junction-probe/   → .sigilkit-junction-probe/x        (repo root, sc-sec)
.gitignore:121:scripts/.bench-probe-*      → scripts/.bench-probe-<id>/y      (scripts/, ck-perf)
```

Both lines are real and both probes are ignored — **so no conclusion changes.** But two *correct*
line numbers, sitting close together, had been read as one fact, which is the same failure as ④ in a
different costume: **proximity substituted for verification.** If the closeout report had cited `:121`
as the reason the *root* probe is ignored, the next reader would have checked, found it uncovered, and
doubted every conclusion built on it. **Rule: when citing an ignore rule, a guard clause or any
narrow anchor, name the specific path it covers — a bare line number is not a reference.**

**⚠️ The sharper form of ⑤, and it is worse than it looks: this error tends to occur in PAIRS.**
ck-perf and I made it **simultaneously, in the same exchange, in the same direction** — each of us took
the other's `:121` as confirmation of our own `:101` claim, each of us having actually checked the
`scripts/` rule while the conclusion at stake was about the repo root. **Two people confirming the
same error is harder to catch than one, because it presents as cross-validation.**

The generalisation covers both this and the earlier "inherited credibility" case:

> **Adjacency merges credibility.** Observations that are adjacent in the text — whether from a
> measurement, someone else's relay, or your own earlier conclusion — get treated as confirming each
> other. **The test is not whether they agree; it is whether they share a source.** In a parallel
> conversation the freshest number in the thread is the most likely to be borrowed as confirmation,
> and a number borrowed from someone else is not re-verified by being cited twice.

**Practical form: before accepting a corroborating detail, ask "did I check *that* thing, or did I
check a nearby thing and assume it was the same?"** In this instance the honest answer was the latter,
on both sides.

**Gate-result provenance (team-lead's third condition, adopted).** A green gate result is a statement
about a *moment*, and this session produced two concrete demonstrations: a `node_modules` tree that went
from 10 top-level entries to 5 mid-session (taking `yaml` with it) turned a green gate into a
non-runnable one **within the same conversation**, and earlier a stale-blocker report outlived its cause.
**Therefore every gate or test result quoted anywhere must carry three things:**

| # | Field | This run |
|---|---|---|
| ① | when it was run | **2026-09-26 22:06:50** |
| ② | `git rev-parse HEAD` at the time | **`ce8eea2`** |
| ③ | dependency tree complete **for that command** | **yes — the gate's only external import (`yaml`) resolves; the rest are node builtins** |

**⇒ Adopted rule (team-lead, 2026-09-26, after accepting my correction):** *the dependency completeness of a
result is judged **per command**, not per repository.* A script that imports only `yaml` is not
invalidated by a missing `typescript`. Whenever a green result is quoted, record **whether every
external import of that command resolved** — not whether the repository's dependency tree is intact.
**"The gate is green" and "the repo is healthy" are two independent assertions and neither substitutes
for the other.** The word "global" in the earlier phrasing of rule ③ was the defect, and it is removed.

A green result missing ③ is downgraded to "observed once" and may not be used as acceptance evidence.
Recorded with this corrected scope (re-measured, not recalled):

| # | Field | This run |
|---|---|---|
| ① | when it was run | **2026-09-26 22:21:59** (earlier 22:06:50 run superseded) |
| ② | `git rev-parse HEAD` at the time | **`ce8eea2`** |
| ③ | **this command's** external imports all resolved | **yes — `check-doc-counts.mjs` imports `node:child_process`, `node:fs`, `node:path`, `node:url` (builtins) + `yaml` (1 external); `require.resolve('yaml')` → OK** |

**⚠️ Correction to the note that used to sit here (my dependency list was stale).** I had written that
`abitype`, `isows`, `ws` and `@scure` were still missing. Re-measured at 22:21: `node_modules` holds
**6 top-level entries** (`.bin`, `@noble`, `@sigilkit`, `ox`, `viem`, `yaml`); the **actually** missing
packages are now **`vitest`** and **`typescript`** — and those two are precisely why the TypeScript
suites cannot run. So the corrected statement is: **`check-doc-counts exit 0` at 22:21:59 on `ce8eea2`
is valid because that command's sole external dependency (`yaml`) resolves; `vitest`/`typescript` are
still absent, therefore the TS suites remain unrunnable.** The earlier list was a snapshot from a
different minute of a tree that was changing under us — the same decay profile as the stale gas and
test counts tabulated below.

**One mechanical prerequisite worth recording, because its absence looks like a red gate (adopted as a
team-wide rule by team-lead, 2026-09-26).** `check-doc-counts.mjs` resolves `forge` via `FORGE_BIN`.
Without it the run fails with `could not run forge test --list` / `spawnSync forge ENOENT` and **exit 2**
even though every count in the toolchain is correct. On this machine forge exists at
`C:\Users\dev25\.foundry\bin\forge.exe`, so `$env:FORGE_BIN="C:\Users\dev25\.foundry\bin\forge.exe"`
is required. The rule:

> **An environment-class failure (`ERR_MODULE_NOT_FOUND` / `ENOENT`) and a documentation defect are
> different assertions and must never be merged.** When a gate fails for an environment reason, **no
> document figure may be edited in response.** Test: *if the tool already fails loud and distinctly*
> (`exit 2` plus an explicit message), **its failure is not the documents' failure.**

This rule is also why the correction above needed the method column: `git grep` measures git's stored
content, the gate measures the working tree, and a document number is only ever comparable to the
latter.

**A companion lesson from the same round — a count is meaningless without its scope.** I reported
"10 references" to `_declaredTokenOutflow`; team-lead measured **5** and asked me to state my scope.
Re-measuring: **5 in Solidity** (matching them exactly) and **58 across all file types** — the extra 53
are coverage HTML, compiler JSON, teammate message logs and my own report. My "10" was neither number:
it was a **double-count**, because a recursive scan emitted each Solidity hit twice. **So the error was
not a wrong scope, it was a broken tool** — and both of us initially read it as a scope disagreement.
Stated scope for every count in this report: **Solidity sources under `contracts/`, excluding
`node_modules`, `out`, `cache`, `lib`, `dist`, `coverage`.** Team-lead's figure is the one recorded.

**Gate discipline (team-lead, extended to the whole team): re-run the doc gate after *every* document
edit — and the earlier the better.** Found by me the hard way: while editing only my own report, the
gate went red with `TROUBLESHOOTING says 56 forge-lint annotations, actual is 57`. **I had changed
nothing in that file** — a teammate's concurrent contract edits had transiently added a 57th
`forge-lint: disable-next-line` annotation. **A gate that turns red mid-edit is usually someone else's
change, not yours; a gate run only at the end will misattribute it to you.**

**⚠️ The "fix" I applied then was itself wrong — corrected after re-deriving the number. First attempt
at the correction was *also* wrong, in a way team-lead caught.** I "fixed it to 57" and recorded 57 as
the true value. The settled value is **56**.

**Correction attempt #1 (withdrawn): I presented a "HEAD = 28 vs working tree = 56" table.** The 28
was real — I measured it with `git grep -c … HEAD -- contracts` — but the table's *framing* was wrong,
and team-lead rejected it for a reason that should have been obvious to me:

> `check-doc-counts.mjs:722-727` computes `forgeLintAnnotationCount()` as
> `soliditySources(join(ROOT, "contracts"))` → `readFileSync(f)` → regex per file.
> **`soliditySources` (`:704-716`) is a `readdirSync` walk of the working directory. There is no git
> call anywhere in the path.** The gate reads the **working tree, always**. It has never had a "HEAD
> mode" and never will.

So "HEAD 28 vs worktree 56" was not "two trees the gate can see" — it was *"what git stores"* vs
*"what the gate actually reads"*, and the latter is invariantly the working tree. **A table titled
"Tree" invited the reader to conclude the gate distinguishes them, which is a mechanism that does not
exist.** The fact is still worth recording, so it is kept below — relabelled to say what each column
actually is.

| Measured by | Method | `forge-lint: disable-next-line` lines |
|---|---|---|
| **What git stores at `ce8eea2`** | `git grep -c … HEAD -- contracts` | **28** across 10 files — `DeployDeterministic.s.sol` 1, `ActionLog7579Executor.sol` 1, `SessionKey7579Module.sol` 4, `SessionKeyManager.sol` 6, `SpendPolicy.sol` 1, `GoldenVectors.t.sol` 4, `Halmos.t.sol` 2, `SessionKey7579Module.t.sol` 4, `SessionKeyManager.invariant.t.sol` 4, `SessionKeyManager.t.sol` 1 |
| **What the gate reads (and therefore the only figure it can ever report)** | `soliditySources(ROOT/contracts)` walk of the working tree | **56** across 14 files — the same 10, plus `SessionKeyManager.sol` 6→8, `SessionKey7579Module.t.sol` 4→8, and 4 newly annotating files (`ERC1271Keys.t.sol` 2, `EchidnaProperties.t.sol` 2, `GasBudget.t.sol` 1, `HalmosAuth.t.sol` 1) |

**⇒ Rule: never present a figure the tool cannot produce as if it were one of the tool's outputs.**
The gate's output space is {working-tree annotation count}. A "28" from `git grep` is a *different
measurement of a different object*, useful for attribution ("this annotation arrived with commit
X") and useless as a gate baseline. **Adopted as a team-wide rule by team-lead, 2026-09-26**, on the
ground that team-lead's own phrasing of the error was sharper than mine was: **数字对、口径错，比数字错
更难发现 —— 因为数字看起来可被复核.**

**Attribution of 57, per team-lead's correction — and my wording was wrong in a way that mattered.**
I had written that 57 was "a transient state" and "never a fact about the repository". **The first half
is right and the second half is not, and the distinction is not pedantry:**

- 57 **was** a real intermediate state of the working tree. It was observed inside a live session by
  several people independently, and it **passed the gate's content check** — it was not a stray
  untracked file that a reader would never see.
- So 57 was **not wrong** and **not fabricated**. It is **an intermediate state that has since passed.**
- The operative consequence is unchanged but must be stated correctly: **a value that was once true is
  not citable as a current attribution.** Recording "57 confirmed" was the error, not "57 occurred".

**The error that actually mattered, which team-lead confirmed applies symmetrically to their own
message.** My report said *"team-lead independently confirmed 57 is the true value"*, and that sentence
is **withdrawn**. Team-lead's own "我实测的 57 正确" was a **restatement of the gate's output, not a
second independent measurement** — they had not counted either state themselves. **⇒ Team-lead has
banned the phrase "我实测" for the rest of this session unless the speaker actually took their own
reading. Relay is not a second observation.**

**One more thing the re-measurement turned up, which strengthens the `FORGE_BIN` rule below.** At
`ce8eea2` the committed `docs/TROUBLESHOOTING.md` says **"31 such annotations"** while the committed
contracts tree holds **28** — the gate was **already red on a clean checkout of `ce8eea2`**, before
anyone in this session touched a contract. Two implications:

1. **`check:docs` had demonstrably not been run green against `ce8eea2`.** "The gate is green" must
   never be inferred from the existence of the gate, from a CI badge, or from a teammate's report.
2. It also means the pre-session 31 → 28 gap was **real drift, not a transient** — a committed
   document that had drifted from a committed tree and shipped anyway. That is the exact failure this
   gate was written to prevent, and it is why the guard's own JSDoc
   (`check-doc-counts.mjs:16-22`) is emphatic about historical records versus live counts.

**⇒ Team-wide rule (team-lead, 2026-09-26, from this instance).** `git grep` measures what git *stores*;
`soliditySources()` measures what the gate *reads*. A document figure is only ever comparable to the
latter. **Do not present a number the tool cannot produce as one of the tool's outputs.**

**⚠️ Scope discipline, applied to the fix I proposed.** Team-lead assigned the 31-vs-28 record to
ck-arch (contract-side history) and told me not to chase it. I have therefore **not** touched
`check-doc-counts.mjs` or `.gitignore`. My part is limited to stating the fact and the two rules above.

**⚠️ Scope discipline, applied to my own numbers — and team-lead's 205 does not mean what it appears
to mean.** I had reported "untracked = 55" and team-lead measured **205**, concluding 205 was the
untracked count. Both are wrong about *which quantity* they measured. Measured, by status-code prefix:

| Prefix | Count | Meaning |
|---|---|---|
| `??` | **55** | untracked paths (collapsed — directories count as one) |
| ` M` | **85** | tracked, modified, unstaged |
| `M ` | **15** | tracked, modified, **staged** |
| `A ` | **40** | **staged** additions (e.g. `docs/ARCH-CORE-2026-09-26.md`, `docs/DOC-AUDIT-CORE-2026-09-26.md`, 13 `packages/core/test/*.test.ts`) |
| `AM` | **8** | staged add, then modified again in the working tree |
| `MM` | 1 | staged modify, then modified again |
| `D ` | 1 | staged deletion |
| **total porcelain lines** | **205** | **all four categories, not an untracked count** |

**⇒ The rule, adopted as team-wide by team-lead, 2026-09-26, in their words:**
> **裸整数不是关于集合的断言，而是关于集合 + 口径 的断言，而口径是衰减最快的部分。**

This is the precise form, because it explains why 55 and 205 can both be true without conflict: **they
are two different scopes, not one right and one wrong.**

**⚠️ And the reason team-lead's own 205 was wrong is sharper than "miscounted" — it was a wildcard bug,
which makes it the most reusable lesson in this section.** Their command was:

```powershell
$s | Where-Object { $_ -like '??*' }
```

**`?` is a single-character wildcard in PowerShell `-like`, so `'??*'` matches "any string starting
with any two characters" — i.e. all 205 lines.** The filter was a no-op. **They had measured "all
lines" and believed they had measured "untracked".** Two rules, both adopted team-wide:

> **Never filter git status prefixes with shell wildcards.** `'??*'` matches everything. Use
> `StartsWith()` with an explicit length check, or a `--`-delimited git-side filter.
>
> **Any git count must state three things together: the command as written, whether directories are
> collapsed, and whether ignore rules are applied.** If any of the three differs, two numbers can both
> be correct while measuring different things.

**This is now the third same-shape event in this round** — 55 vs 205 (untracked vs total delta),
78 vs 55 (files vs collapsed paths), and this wildcard. **⇒ The generalisation worth keeping: a filter
that cannot fail is not a filter.** `-like '??*'` is the exact sibling of the prefix-scoped grep in the
absence-claims section below — a narrowing that silently matches everything, and therefore reports a
confident wrong number instead of an obviously broken one.

Related trap in the same area: `git ls-files --others` (no `--exclude-standard`) reports **18,615**
lines here, because it does not apply ignore rules; the correct untracked file count is `78`
(`--others --exclude-standard`, or `status -uall` minus ignored).

**⇒ And the practical consequence for closeout, which is the reason this matters:** the 40 staged
additions include two *earlier* audit reports (`DOC-AUDIT-CORE-2026-09-26.md`, `ARCH-CORE-2026-09-26.md`)
— so **staging is already happening for some deliverables**, meaning "all deliverables live only in the
working tree" is not a uniform condition. Per-file status is needed, not a global claim. **Both of my
deliverables (`docs/DOC-AUDIT-CONTRACTS-2026-09-26.md` and `docs/ADVANCED-FEATURES-1-CONTRACTS-DATA.md`)
are `??` — genuinely untracked, and the second is a teammate's file I only fixed one line in.**

**⇒ Recording the outcome so the next reader does not have to re-derive it (the actionable part of
this whole section).** Concretely, for closeout:

1. **✅ DONE — my two files are staged (`A `), 2026-09-26 23:12.** `git add -- docs/DOC-AUDIT-CONTRACTS-2026-09-26.md
   docs/ADVANCED-FEATURES-1-CONTRACTS-DATA.md`, authorised by team-lead with the scope limited to those
   two paths. Verified after staging: both report `A ` in `git status --porcelain` and `A` in
   `git diff --cached --name-status`. **Not committed** — `HEAD` is still `ce8eea2`. Git emitted
   `CRLF will be replaced by LF the next time Git touches it` for both files (working copy is CRLF,
   repo normalises to LF); that is a pre-existing repo-wide EOL policy, not something these two files
   introduced, and it did not alter the staged content.
2. **Do not treat "untracked" as "not mine to worry about"** — the 55 untracked paths include 32
   `docs/*.md` from *this* round, and at least one (`contracts/test/Sec10WindowRotation.t.sol`) is a
   teammate's test that another teammate's findings depend on. **After my two additions the untracked
   count is 54 and staged additions are 42** (was 55 / 40); every other status bucket was unchanged,
   which is the check that proves I touched nothing else in the index.
3. **`.docgate-fixture-*` should be deleted, not committed.** Verified: `git check-ignore -v
   .docgate-fixture-0uSChc` → **exit 1, no rule matches** (`.gitignore` has 124 lines and contains no
   `docgate` / `fixture` / `mkdtemp` pattern). So the residue would be committed as a real directory
   unless someone removes it. Team-lead approved both actions; execution assigned to sc-clean, and
   the `.gitignore` line was assigned separately to avoid conflicting with concurrent `.gitignore`
   edits. **I have not deleted or edited anything in either file** — re-confirmed after staging: both
   directories are still present.

**⚠️ One caveat on `--write` that team-lead surfaced, and it is a real limit (verified in the script):
`check-doc-counts.mjs`'s write path for `docs/TROUBLESHOOTING.md` is a **regular-expression
replacement of the number**, not a semantic edit. So **any fix applied via `--write` is never
semantically checked** — the regex changes digits, not meaning. In this instance the result was
correct, but the general consequence is that "the gate is green after `--write`" is weaker evidence than
"the gate is green after a human edit". Same family as the shared-regex issue between
`rewriteStatus` and `checkStatusCounts`.

**A corollary about which numbers decay fastest (ck-perf, found by applying rule ④ to his own report).**
My three errors were all in *trace/number* claims, so it is worth recording the opposite case: he
found **two places where his report said "31 tests" when the file actually had 33** (two tests added
mid-round), and the headline count never followed. Two different decay profiles:

| Kind | Decay behaviour | Correct source of truth |
|---|---|---|
| **gas / measurement numbers** | re-runnable, so a stale one is *detectable* | re-run and quote the new value |
| **metadata counts** (tests, files, assertions) | drift silently with every incremental change, and a wrong one is only visible to whoever re-counts | **`forge test --list`**, never a document's self-description |
| **line-number anchors** (ck-perf's addition) | drift when *other people* edit — and **the text can change meaning while the number stays "correct"** | **symbol name + line number, both** |

The third row is the most dangerous of the three, and the reason is worth stating plainly: a stale
*count* is discovered by recounting, but a **stale anchor is not** — `benchmark-indexer.mjs:516` is the
symlink-refusal branch today, and after anyone inserts three lines above it, `:516` still points
somewhere plausible while naming something else entirely. **A wrong reference looks completely
trustworthy**, which is strictly worse than a wrong number.

**⇒ Rule: when citing another file's code, always give symbol + line together** — e.g.
"`benchmark-indexer.mjs:516`, the `isSymbolicLink()` refusal inside `collectBuildIdentity`". A bare
line number has a very short shelf life in a repo where six `.md` files are being edited at once.

**⚠️ Self-audit after team-lead's "corrections must be verified too" norm (2026-09-26).** That norm
is **"when asserting that a symbol does not exist, use a full-string search or a tool listing — never a
prefix glob."** Three of my findings are load-bearing **absence** claims, so I re-ran all three the
required way. **All three survive, but not for the reason I assumed:**

| Claim | Method | Result | Verdict |
|---|---|---|---|
| C-06 — `ActionLogger` does not emit `WindowCharged` | full-string | **1 hit**, at `ActionLogger.sol:43` | **holds** — the hit is NatSpec prose (*"the signing key is known on-chain (it is the WindowCharged…)"*), not an emit |
| C-02 — `SessionKey7579Module` has no ERC-1271 support | 5 tokens, full-string | `isValidSignature` **1 hit**, `1626ba7e` 0, `20c13b0b` 0, `extcodesize` 0 | **holds** — the single hit is NatSpec at `:610` explaining that such keys *cannot* be used here |
| X-04 — `isValidSignature` exists only in `SessionKeyManager` | full-string across `contracts/src` | 1 additional hit | **holds** — and it is that **same** `:610` comment, not code |

**The methodological point, and the reason to record this:** my original greps were **prefix-scoped**
and would have reported "0 hits" for all three — the *right answer reached by a method that could not
have detected a violation*. **A grep returning zero because its pattern was too narrow is
indistinguishable from one returning zero because the fact holds.** All three claims are now backed by
full-string searches, and the two ERC-1271 ones are further backed by *positive* evidence that the only
mentions are the comments explaining their absence. **Absence claims need a method whose failure mode is visible.**

**Second pass over the remaining absence claims — one produced a genuine near-miss:**

| Claim | Full-string result | Verdict |
|---|---|---|
| X-01 — `tokenWatchlist` is in no operator-facing doc | `GETTING-STARTED.md` **1 hit** (the `tokenWatchlist: []` line in the example scope); CONFIGURATION / DEPLOYMENT / README 0 | **holds as stated** — it appears only as an unexplained example field, never defined. That is precisely the "undocumented field" claim, so the hit does not refute it |
| X-03 — `_declaredTokenOutflow`'s `transferFrom` branch has **no test** | **5 references in Solidity** (`SessionKeyManager.sol:659,944`; `E11WatchlistRead.t.sol:23,83,90`) | **substance holds, but my "全仓 0 引用" phrasing was literally false.** All three test-file references are NatSpec explaining that *other* selectors (`rug`) return 0 — the file discusses the function, never exercises the `transferFrom` branch. **"Not referenced" and "referenced but not exercised" are different claims, and only the second is what I should have written** |
| H-12 — allowlist records a different version than the docs claim | the `metamask:revoke-raw-rejected` row reads `verifiedOn: extension 12.5.0 (2026-08 live harness …)` | **holds** |

**The X-03 case is the one worth keeping.** My original wording — "全仓 0 引用" — was **literally false**
and would not have survived a reviewer's full-string search. The *substance* (the branch is untested) is
correct and unchanged, but I had overstated it in a way a reader could have caught, which is worse than
being imprecise about something already known. **Corrected wording: the `transferFrom` branch of
`_declaredTokenOutflow` is discussed in `E11WatchlistRead.t.sol` but never exercised by any test** —
and the cheap fix remains a one-line addition to that file's existing fixture.

 — and it changes which form of a number to publish
(ck-perf, verified by re-running four headline measurements).** Absolute gas figures drift on every
re-run because of fixed per-deployment overhead (code deposit and similar), which is charged
identically into every configuration:

| Quantity | Re-run delta | Use for conclusions? |
|---|---|---|
| **Delta / slope / per-item marginal** (E11 switch = **+28,206**, watchlist = **+27,762 cold**, **+27,742 warm**) | **0 — exact** | ✅ **yes** |
| **Absolute** (no-E11 baseline, E11 full, plain execute) | **+17 to +41** | ⚠️ re-run before quoting |

**⇒ Publish gas conclusions as deltas, not absolutes.** This is strictly more useful than "absolutes go
stale, re-run them": **a re-run can only update an absolute, whereas the delta form stays true across
environment changes** — because the drift cancels. ck-perf notes two of his own figures (the denylist
slope 14,222 over 7 calls; ~790 per element) are already delta-form and therefore more decay-resistant
than his absolute table, which he had not realised.

**This also applies to the authority I cited in §2.1 — and the re-measurement refuted the
explanation. (ck-perf measured 5 of 6 budget rows, found every one at exactly +68, and concluded the
offset was environmental. I measured the sixth row he had not tested. It breaks the pattern.)**

| `GasBudget.t.sol` row | Recorded (2026-09-12) | Measured (2026-09-26) | Δ |
|---|---|---|---|
| simple execute | 112,819 | 112,887 | **+68** |
| whitelisted execute | 115,434 | 115,502 | **+68** |
| ERC-1271 verification | 116,423 | 116,491 | **+68** |
| Merkle depth 8 (256 leaves) | 121,003 | 121,071 | **+68** |
| E11 enforceNativeDelta (no watchlist) | 113,264 | 113,332 | **+68** |
| **E11 full watchlist (8 tokens)** | **141,427** | **141,111** | **−316** ⚠️ |

**Nothing here is explained. Both the +68 and the −316 are unattributed, and the closeout must not
claim otherwise.** Two successive explanations were proposed and **both were wrong**:
- **"+68 is a constant environmental offset"** — inferred from 5 of 6 rows agreeing, never independently
  evidenced. It remains a **hypothesis**, not a finding.
- **"the watchlist row carries the E11 fail-open→fail-closed change"** — **false.** `_erc20BalanceOf`
  reverts only on `!ok || ret.length < 32` (`SessionKeyManager._erc20BalanceOf`, `:912-917`), and
  `GasWatchToken.balanceOf` is a public mapping read returning a canonical 32-byte word
  (`GasBudget.t.sol:22-23`, stated at `:18-21`), with a real balance minted at `:611-620`. **That branch
  is unreachable on this path.**

**The lead worth recording:** two tests both measuring an "8-token E11" configuration differ by **2,160
gas** — ck-perf's `test_GasUncovered_E11CostDecomposition` reports **143,271** where `GasBudget` reports
**141,111** — so **the two fixtures are not the same** (token deployment timing, count, or `vm.warp`
origin). **The narrow sentence is the correct one for the closeout:** *"this row's delta is not
comparable to the others; cause unattributed; two same-named '8-token E11' measurements differ by
2,160 gas, fixtures differ, open."*

**⚠️ And the consequence team-lead drew from `GasBudget.t.sol:132-134` — *"never a value carried over
from a measurement of a DIFFERENT configuration."* Row 6 is exactly that case: its `measured` value is
**out of date for the current configuration** (unexplained −316), so by the file's own stated policy
**that measured value is invalid even though `test_Gas_E11FullWatchlist_WithinBudget` still PASSes.**
**So the correct action is narrower and more precise than "do not adjust budgets":**

| | Status |
|---|---|
| The **budget constants** (`BUDGET_*`) | **still valid — do not change them.** A budget may only be *raised* deliberately, with the new measurement and justification in the PR |
| **Row 6's `measured` column** (141,427) | **invalid — needs re-measurement.** It came from a configuration that is no longer the one being measured |

**Drift therefore invalidates a recorded *measurement*, never a *ceiling*.** Those are different
columns and conflating them is how a +68 would turn into an unjustified budget raise.

**Boundary that must not be crossed (team-lead, verified):** the **budget constants are design
decisions, not measurements.** `GasBudget.t.sol:131-151` states the policy — every ceiling is
`round_up_to_1k(measured × 1.3)` — and that *"a budget is an ABSOLUTE CEILING and may only be RAISED
deliberately, with the new measurement and its justification in the PR."* **The drift is in the measured
column, not the budget column: do not adjust any budget because of a +68 or a −316.**

**The measurement facts (all that is established):** five rows sit at exactly **+68** and the sixth at
**−316**; **neither figure has an attributed cause.** Two explanations were offered and both were
withdrawn — the "+68 is environmental" reading was never independently evidenced, and the
"watchlist row carries the E11 fail-closed change" reading is **false** (`_erc20BalanceOf` reverts only
on `!ok || ret.length < 32`, and `GasWatchToken.balanceOf` is a public mapping read returning a
canonical 32-byte word, with a real balance minted). The one concrete lead: **two tests both measuring
an "8-token E11" configuration differ by 2,160 gas** (143,271 vs 141,111), so **the fixtures are not
the same.** **Neither the size nor the direction of either drift may be asserted as environmental.**

**(superseded — see the withdrawn-claims note above.)**

**So the −316 is UNEXPLAINED, and the honest reading is narrower than "one row differs":**
- the five non-watchlist rows share a common offset of **+68** (cause unattributed);
- the watchlist row differs by **−316** for a reason **not yet attributed**;
- **and the two are not even cross-fixture comparable.** ck-perf's independent measurement of the
  same "8-token E11" shape is **143,271** (`GasUncoveredPathsTest.test_GasUncovered_E11CostDecomposition`),
  which is **2,160** away from `GasBudget`'s 141,111 — so the two tests differ in fixture (token
  deployment timing, count, or `vm.warp` origin), and **an absolute value from one cannot be compared
  against the other.**

**Practical consequence, and it is the useful part: the E11 numbers are still available — just not from
that table.** `test_GasUncovered_E11CostDecomposition` (`GasUncoveredPaths.t.sol:380`) reproduces all four deltas exactly against current code
(switch **+28,206** cold and warm; watchlist **+27,762** cold / **+27,742** warm), because its tokens
are standard ERC-20s, so neither the fail-open nor the fail-closed branch is triggered. **Use it as the
reference for E11 figures; treat the `GasBudget` watchlist row as a snapshot of unknown provenance.**

**And the derived factors, recomputed from the table's own rows today:** switch = 113,332 − 112,887 =
**+445**; watchlist = 141,111 − 113,332 = **+27,779**. Both remain consistent with the
independently-measured deltas (+444 and +27,762/+27,742) within measurement noise, which is the
cross-check that matters — **the ratios hold even though the absolutes do not.**

**Instruction to a reader of §2.1, revised:** the `GasBudget.t.sol` table records measurements from a
specific fixture environment on 2026-09-12. **Use it for the shape of the decomposition only; re-run for
values.** It is a snapshot, not an authority — it is the same *kind* of object as any other recorded gas
number, and it carries the same obligation to be re-measured.

**Practical rule: at closeout, re-derive every count from the tool, and never quote a count from a
document — including your own.** A reader who checks "31" against the file and finds 33 loses trust in
the *whole* report, not just in that number. (For the record: `GasUncoveredPathsTest` is **33** — I
verified against `forge test --list` — and that is the figure already published in my §6 breakdown.)

### 2.1 E11's cost cannot be derived from the documentation (X-02b)

ck-perf measured the E11 path and passed me the numbers; this is the doc-layer consequence, which is
my lane. **X-02 said "E11 is undocumented". The stronger and more useful statement is that E11's
cost is not *derivable* from anything a reader has.**

| Configuration | Cold (first action in window) | Warm (second, same window) |
|---|---|---|
| `enforceNativeDelta: false` (baseline) | 115,024 | 43,393 |
| E11, empty watchlist (delta only) | 115,468 | 43,857 |
| **E11 + 8-token watchlist** | **143,230** | **71,599** |
| → E11 total over baseline | **+28,206** | **+28,206** |
| → of which the `enforceNativeDelta` switch alone | **+444** | **+444** |
| → of which the 8-token watchlist | +27,762 | +27,742 |

> **Measurement note (ck-perf, self-corrected twice).** Use these, not earlier figures. His first
> pass mislabelled the +28,207 total as the cost of "the switch" (it is the watchlist; the switch is
> +444). His second prediction — that watchlist cost would collapse on the warm path — was **wrong
> and he retracted it**: cold and warm are the same. The reason is that the inner `CALL` already
> pays the cold-account access (2,600), warming the account, so the 16 `balanceOf` staticcalls all
> hit warm slots at ~100. He also caught his own fixture pollution: three configurations sharing one
> `GasProbeTarget` made the delta-only path appear 24k *cheaper* than baseline. **The tell was a
> negative delta.** The repo's own `GasBudget.t.sol` avoids this by using a fresh manager per
> measurement, and his numbers now agree with that file's recorded `112,819 / 113,264 / 141,427`.
> `docs/Issues-Catalog-2026-09-23-C-Performance.md:233`'s 567,551 is **whole-test gas** (fixture
> deploy + mint + signing), not path cost — citing it over-estimates 3–4×.

Three consequences for the docs:

1. **A doc-default baseline cannot be extrapolated to a full watchlist.** The documented path *is*
   the cheap path (every example sets `enforceNativeDelta: false`), so a baseline built from the
   docs is **accurate for that configuration** — the error is in extrapolating from it. A full
   watchlist is **+28,206 (cold and warm alike), ≈ +24% over baseline**.
2. **E11 is a per-action cost, not a per-window one.** This *reverses* the intuition: the base path
   saves ~71,631 warm (115,024 → 43,393), but **E11's multiplier is the same on every action**, so a
   reader who plans E11 as "cheap in steady state" underestimates it by roughly half. (An earlier
   draft of this section said the opposite and was wrong.)
3. **The switch is nearly free; the watchlist is the cost.** +444 vs +27,762. Docs must not describe
   enabling `enforceNativeDelta` as expensive, or readers will enable it where it is not needed —
   and, worse, may treat an 8-token watchlist as equally cheap.

**Suggested doc change:** in whichever document first introduces the field, state that the 8-token
watchlist costs ~+28k per action (cold and warm alike), that the `enforceNativeDelta` switch itself
is ~+444, and that E11 is charged per action rather than per window. No document currently does.

---

## 3. NatSpec ↔ behaviour contradictions (9: 8 open, 1 resolved)

In-code comments that assert something the adjacent code does not do. All in `contracts/src`.

| # | Location | Comment says | Code does |
|---|---|---|---|
| N-01 | `SigilKitDelegator.sol:13-19` | Lifecycle step 2: "After delegation, the EOA calls `initializeSelfOwned()` exactly once: owner = address(this) … and the admin-selector denylist is seeded" | For the **canonical implementation address** this is impossible: the constructor already set `owner = address(this)` (`SigilKitDelegator.sol:32` → `SessionKeyManager.sol:200`), so `initializeSelfOwned` reverts `AlreadyInitialized` (`:37`). The NatSpec describes the EOA's post-delegation context but is written as if it also described the deployed contract — and `DEPLOYMENT.md:81-86` reads it that way (C-07) |
| N-02 | `SigilKitDelegator.sol:17-18` | "Storage is the EOA's own (ERC-7201 namespaced, so it coexists with other 7702-safe facets)" | True for a delegated EOA. But the doc reads the same sentence as applying to the canonical instance, whose storage is equally its own — so "coexists with other facets" is a property of *any* ERC-7201 contract, not something this design achieves. Overstated |
| N-03 | `SessionKeyManager.sol:15-17` | "Owner-only functions are unreachable through executeWithSessionKey (INV-4): they are gated by `onlyOwner`, and additionally every selector in `ownerOnlySelectors` is denied to session keys even when targeting other contracts" | The denylist is **opt-in per selector** and seeded only for 6 selectors (`:223-230`) plus the delegator's own (`:45`). Any *new* `onlyOwner` function is denied only **after it has been called once** (the self-sealing at `:184`). The comment reads as a standing property; it is a property that holds *eventually*, and only because of the seal — which the comment does not mention here |
| N-04 | `SessionKeyManager.sol:48` (Scope field) and `:65` (ActionRequest) | `expiry` — "request-level expiry (**<= key expiry recommended**)" | "Recommended" is accurate and the code does not enforce it: `executeWithSessionKey` checks `block.timestamp > request.expiry` (`:428`) and separately `block.timestamp > scope.expiresAt` (`:426`). A request expiry beyond the key expiry is harmless, not rejected. The wording implies a soft constraint the contract does not check. Low-impact but it is a stated-but-unenforced rule in a security-relevant field |
| N-05 | `SessionKeyManager.sol:46` (original) | ~~"All fields immutable once granted."~~ | **✅ RESOLVED — fixed 2026-09-26, verified.** Now reads (`:47-48`): "Every field is fixed at grant time **EXCEPT `expiresAt`, which `rotateSessionKey` may shorten to `overlapEnds`**" — matches `:389` (`s.scopes[oldKey].expiresAt = overlapEnds`). ck-arch flagged the fix; I re-verified. **Retained as a positive example: a reported NatSpec defect that was actually actioned** |
| N-06 | `SessionKey7579Module.sol:27-28` | "The EIP-712 domain binds to `msg.sender` (the installing account), so a signature cannot be replayed through a different account" | The domain binds to the **`account` parameter** of `_recover`, which is `userOp.sender` (`SessionKey7579Module.sol:217, 221, 460, 466-482`) — not `msg.sender`. They coincide only because of the `msg.sender == userOp.sender` guard at `:214`. The stated mechanism is a different (and weaker) invariant than the actual one |
| N-07 | `SessionKey7579Module.sol:29-31` | "Window spend state mutates during validation (checks + effects BEFORE the account executes): conservative — a validated-but-dropped op still counts against the window" | Accurate. Flagged only because it is the one place the contract documents a **deliberate** over-charge, and none of the four audited docs carry that warning — an operator sizing `windowSeconds` for expected throughput will under-provision by the bundler's drop rate. Documentation gap, not a code defect |
| N-08 | `SessionKeyManager.sol:435-441` (`_verifyBalances` doc) / `:749-752` (`_declaredTokenOutflow` doc) | "watched tokens must not net-decreased by more than the amount their standard transfer selector declared (**0 otherwise**)" and "any other selector declares nothing (zero tolerance on watched tokens)" | Internally consistent, but the practical consequence is the opposite of "protection": with `merkleRoot == 0` and a `transfer`-shaped call to an unlisted token, nothing bounds the outflow. The comment describes the rule accurately while a reader of the *docs* (which never mention E11) would assume a watchlist entry bounds all token movement. Compounds X-02/X-03 |
| N-09 | `SessionKeyManager.sol:527-533` (`_interact` Slither annotation) | "The **sole production call site** is executeWithSessionKey" | True today. But `_interact` is `internal` and the annotation explicitly instructs subclasses ("Keep those checks before every call to this helper (including subclasses)") — a `SigilKitDelegator`-style subclass that adds a call site inherits an annotation asserting a property the new call site may not have, with nothing enforcing it. Latent-drift risk in a security annotation |

---

## 3b. Cross-team doc-index findings (5, from sc-chain + dc-plan on 2026-09-26)

Both teammates filed doc-vs-reality findings in my lane. **I verified every claim; one is wrong, and
two teammates each missed drift the other caught.** All targets are files my scope forbids me to
write, so these are recorded here for a human/owner fix rather than applied.

### Verified — dc-plan's finding #1 is partly stale

dc-plan wrote that `docs/STATUS.md:47` cites "latest catalog (100 items)" but "L3 表里没有
`ISSUES-CATALOG-2026-09-25.md` 这一行". **The row exists**, at `STATUS.md:47`, immediately under the
`PLAN-30-DAYS` row and marked `**ACTIVE** — latest catalog (100 items, 2026-09-25)`. The citation and
the row are on the same line. Please re-check before acting.

The *rest* of finding #1 stands and I confirmed it: `ENHANCEMENTS-2026-09-25.md`,
`NEW-ADDITIONS-2026-09-25.md`, `ADVANCED-FEATURES-1/2/3-*.md`, `VERIFICATION-STRATEGY-2026-09-25.md`,
`VERIFICATION-STRATEGY-2-CI-UAT.md` are in `docs/` but in no L1–L4 table, against the file's own
exhaustiveness rule (`STATUS.md:110-112`).

### Verified — dc-plan's two stale numbers are real, and one fails a gate

| Claim | Verified value | Note |
|---|---|---|
| `PLAN-30-DAYS-…:67` writes "forge full **119** pass/1 skip" | `158 tests / 14 suites` in PR scope (+ invariant+fork 5 tests / 2 suites) | L3 plan, expires 2026-10-22 |
| `ci.yml:306` comment writes Halmos "**6 specs**" | **11** `check_` functions across `Halmos.t.sol` + `HalmosAuth.t.sol` (counted directly) | Not gate-enforced — `check-doc-counts.mjs` reads Halmos from the **source**, not the comment, so this is stale-but-harmless |
| dc-plan: "no live numeric drift; all counts OK" | **Correct, and worth repeating** | This is the repo's doc-count gate working as designed |

**A pattern worth recording: a stale *factual* assertion is indistinguishable from a wrong one.**
ck-test's own §5.0 stated "`GasUncoveredPaths.t.sol` — 0 `assert*`", written from a single grep
snapshot and never re-checked. On re-measurement it is **57 `log_named_uint` / 4 `assert*`** — the
assertions exist. ck-test corrected it and, importantly, **kept the wrong claim visible in the
document as the record of how it arose.** That is the right call and it generalises: a reader who
sees only the corrected number learns nothing about why the error was plausible, whereas one who
sees the correction learns that every count in these reports decays.

Refined by ck-test, and more useful than the original claim: the problem was never "are there
assertions" but "**what do they assert**". As of the re-measurement —
**4 behavioural** assertions (path executes) exist, so the file *does* protect against regressions in
"these paths work"; **0 gas-threshold** assertions (`assertLt(used, BUDGET)`) exist across 57 gas
probes, so it protects **nothing** about cost; and **0 policy** assertions (e.g. "window must not
exceed `perWindowCap`"), so the SpendPolicy P0 was free to land inside it. **A file of 33 gas
probes and 0 threshold assertions is measurement, not a gate** — and my §7 breakdown table now
publishes its 33 tests as a *count* while making no coverage claim, which is the correct treatment.

### NEW (ck-test) — the catalog has no status field, so "fixed" and "identified" read identically


ck-test supplied a **reverse-family** case to my X-28, and it is worse:

| | Code under test | Test | Catalog status |
|---|---|---|---|
| SEC-08b (my X-28) | no defect | **tautological** | recorded as fixed (fixed cause A, vacuity remains) |
| **SEC-10** | **has an exploitable defect** | **zero coverage** | has an entry + two mutually-exclusive prescriptions, none landed |

The mechanism is the same, so is the fix. ck-test verified the SEC-10 gap by full-text search across
all 20 files in `contracts/test/`: `SessionKeyManager.t.sol:407`,
`SessionKeyManager.invariant.t.sol:314-321` and `Halmos.t.sol:112` all exercise **time** window
rollover, and the invariant's ghost variables reproduce `SpendPolicy.enforce`'s **time** rules
verbatim — **no test covers the "spend the cap → `rotateSessionKey` → new key's budget is full"
path**, which is exactly where `_grant` (`SessionKeyManager.sol:369-393`) does not touch `windows`.

**The doc-layer finding, which is mine:** the catalog has **no status field**. Each entry carries
only `位置 / 机制 / 修复 / 工时 / 依赖 / 时间线`. So there is **no mechanism preventing an entry that
is "landed but unresolved" from being read as "resolved"** — the reader infers status from
prose. SEC-08b is the first instance; SEC-10 is the second, and more dangerous, because its code
genuinely has the defect. A reader of the catalog alone will conclude "identified + prescription
exists" = safe.

**Minimal structural fix** (implementation is ck-quality/ck-ops territory, not mine): add a
script-checked `verify:` field naming the concrete test function or grep pattern that proves the
prescription landed, so "fixed" becomes a gate-checked fact rather than a reader's inference.

**Recorded as X-31 (High)** — the structural absence of a status/verification field in
`docs/ISSUES-CATALOG-2026-09-25.md`, of which SEC-08b and SEC-10 are two instances.

**X-32 (High, ck-test) — a THIRD class that `verify:` cannot fix, and the catalog has no entry at all.**
ck-test found `SpendPolicy.sol` had been altered to
`if (projected > perWindowCap && projected == type(uint256).max)` — making the per-window cap fire
**only** when the running total equals `type(uint256).max`, i.e. never, i.e. **INV-1 breached**. This
matters for the doc layer in a way the other two do not:

| Class | Catalog has an entry? | Can a `verify:` field catch it? |
|---|---|---|
| SEC-08b (X-28) | yes | yes — point at the test |
| SEC-10 | yes | yes — point at the (missing) test |
| **SpendPolicy INV-1 (X-32)** | **no — never triaged** | **no — nothing to attach a pointer to** |

So a `verify:` field only governs *registered* items' landing state; it cannot govern an
**unregistered** defect. The register is populated by manual audit, while `contracts/src` already
states INV-1/2/3/4 as **NatSpec invariants** (`SpendPolicy.sol:6-7` is the canonical example).
**The doc-layer gap is therefore a whole class of automatically-extractable registration targets that
the catalog has no concept of:** the invariants the code already promises in prose, which nothing
turns into assertions. (Note: this defect is **now fixed** — `SpendPolicy.sol:80` reads
`if (projected > perWindowCap) revert …`, and `Sec10WindowRotationTest` is its regression suite.
The *registration* gap is what remains — and see **X-34** for why the obvious mechanical form of
that registration does not actually work.)

**X-33 (Medium, ck-test) — NatSpec is the closest thing to a spec here, and nothing checks it.**
`SpendPolicy.sol:40-44` asserted "the batch path calls this ONCE for the batch total with
`perActionCap = type(uint256).max`, having already checked each tuple individually — so this
function must never be the only per-action check on a path." The injected defect **contradicted that
NatSpec directly**, yet no mechanism flagged it: tests do not read NatSpec. Unlike a count in prose,
a NatSpec invariant is *already written down* and machine-locatable — it is simply never promoted to
an assertion. Listed as a candidate source of gate-checkable specs, ahead of prose, for exactly that
reason.

**X-34 (High, ck-test) — ⚠️ CRITERION PROPOSED, THEN FALSIFIED. Do not implement as originally worded.**

*Original proposal (my text, adopted from ck-test):* every invariant declared in `contracts/src`
NatSpec (INV-x / "must never" / "always") should have an exception test explicitly bound to it;
**an invariant that no test references is neither verified nor waived — it is unowned.**

**ck-test implemented the mechanical form and it does not work (measured 2026-09-26 18:14:48).
My claim that it "would catch the SpendPolicy P0 at the moment it was introduced" is FALSE — the
gate would have stayed green throughout.** Two independent reasons, both verified by me:

1. **"Reference" ≠ "assertion".** Grepping tests for INV-1's symbols returns a large number of hits
   that assert nothing. I measured **17 test files** referencing `perWindowCap` / `getWindowState` /
   `WindowCharged` (ck-test counted 8 under a narrower pattern; the true figure is larger, so the
   false-negative is *worse* than reported, not better). The decisive counter-example is
   `GasUncoveredPaths.t.sol:1026`:

   ```solidity
   skm.getWindowState(agent);
   emit log_named_uint("GAP view: getWindowState", before - gasleft());
   ```

   A **read-only view call with a gas probe and no assertion** — indistinguishable from a real
   assertion at grep level. It was green while P0 was live.
2. **A tautological assertion also counts as a "reference".** ck-test's F4 is exactly this: it has a
   reference *and* an assertion *and* is constant-true. A reference-counting gate passes it.

**Corrected form — a strength ladder, with the greppable floor at L2:**

| Level | Form | Greppable? |
|---|---|---|
| L0 | mentions the invariant's literal | yes — **no information** (F4 sits here) |
| L1 | references the invariant's state/function | yes — **no information** (`GasUncoveredPaths:1026` sits here) |
| **L2** | **asserts its policy semantics** (e.g. `assertLe(spentThisWindow, perWindowCap)`) | **yes — this is the implementable floor** |
| L3 | that assertion is proven falsifiable by mutation | **no — requires execution** |

**A gate should require ≥ L2; L3 cannot be automated and must be answered by a human.** My original
wording sat at L0/L1 and therefore could not catch what it was written to catch.

**Second, separate conflict ck-test surfaced — X-34 must not fight the SEC-10 waiver.**
`Sec10WindowRotation.t.sol` contains `test_Sec10_LineageWindowCap`, which is **RED on purpose** and
is a registered waiver in `docs/CI-WAIVERS.md` (its own header says so at `:63-66`: the redness is
"never mistaken for an unknown regression"). So a naive "the invariant's assertions must exist and
be green" gate would go red on that intentional failure. **X-34 must treat "intentionally red +
registered waiver" as a legitimate state**, or it will pressure someone into suppressing the very
test that documents SEC-10. Any implementation has to reconcile with `check-waivers.mjs` first.

**Status: X-34 is recorded here as a *falsified* criterion, deliberately not deleted.** The
sequence — proposed, adopted into this report, then measured and found wanting — is itself the
evidence for the rule ck-test and I have both been converging on: **a criterion must be tested before
it is adopted, exactly as an invariant must be tested before it is trusted.** I adopted ck-test's
wording without testing it and inherited its defect; the failure mode is identical to F1/F3/F4, one
layer up.

**Refinement to X-32 (ck-perf) — split the gap, because the two halves have different risk.**
My X-32 said only "INV-1 was never registered in the catalog", which understates what actually
happened and mis-describes the fix. The NatSpec **already stated INV-1 in prose**
(`SpendPolicy.sol:6-7`); the injected defect was code **contradicting its own documented promise**. So
the automatable guard is *"does the code still satisfy the invariant its NatSpec declares?"* — not
*"is this invariant in the catalog?"*. Two distinct states:

| State | Automatable guard | Risk |
|---|---|---|
| **(a) no independent assertion exists** | **missing** — this is the dangerous state | **high** |
| **(b) assertion exists but is unregistered** | present; registration buys only **searchability** | **low** |

**INV-1 is currently (b)** — `test_PerWindowCapEnforced_AcrossActions` and
`test_WindowIsTumbling_BoundaryBurstPinned` already carry that job, and ck-perf notes the P0 was
*caught by running those assertions*, not by reading the catalog. **But without the split, (a) and
(b) look identical in the catalog, and a future invariant with neither a registration nor a test
would be indistinguishable from today's low-risk case.** That is the part worth fixing.



**On ck-test's §4 mechanical-fact table:** I agree with their scope and the reasoning matches mine.
My position: a table asserting *"`vm.assume` is present at line N" / "no test exercises path P"* is
a checkable fact and belongs in their artifact. A table asserting *therefore the property holds*
would not. They have drawn that line themselves in the document's opening constraints. **No change
needed from me; they should keep §4.** They also correctly cited my X-30 by reference rather than
re-recording it.

**One audit-baseline note to pass on:** ck-test's baseline is 19 test files; `GasUncoveredPaths.t.sol`
(47.22 KB) was added during the audit. Their §5 flags this. Worth team-lead noting that several
audit baselines in this round predate the round's own new files.



sc-chain reported `FILE-MANIFEST.md:28` zone H (62 → **63** after `SUPPLYCHAIN-2026-09-26.md`). I
checked **every** zone. Two more are wrong, and G by a lot:

| Zone | Manifest says | Actual | Delta |
|---|---|---|---|
| B `contracts/src`+`script` | 9 | 9 | ✅ |
| **C** `contracts/test` | **18** | **20** | **+2** |
| **G** `scripts/` | **20** | **35** | **+15** |
| **H** `docs`+`vault`+`vectors`+白皮书 | 62 | 63 | +1 (sc-chain) |

Zone C's +2 is `GasUncoveredPaths.t.sol` and `HalmosAuth.t.sol` (both new this round — the latter is
the file behind ck-test's F1). Zone G's +15 includes
`ARCH-2026-09-26.md`, `assurance-inventory.mjs`, `check-runtime.mjs`, `check-vectors.mjs`,
`sync-facts.mjs`, `check-waivers.mjs` and their `.test.mjs` siblings — i.e. **the gate scripts
themselves, added this round.** The manifest's `:3` total (204) is likewise stale; `git ls-files`
returns **206 tracked** plus 148 untracked-not-ignored.

**sc-chain's reasoning was right even though the scope was incomplete**: the manifest is not
machine-checked (zero hits in `scripts/`), so it drifts silently — which is exactly the failure mode
this repo built `check-doc-counts.mjs` to kill. Two of us found drift the other missed, which is the
same story one level up.

#### Guard coverage boundary — sc-chain's open question, answered

sc-chain asked whether `check-doc-counts.mjs` covers the Halmos spec count in the `ci.yml:306`
comment, so the two findings could be merged into one guard proposal. **Answer: no — and the
boundary is precise.**

`halmosSpecCount()` (`check-doc-counts.mjs:761-773`) globs `contracts/test/Halmos*.t.sol` and counts
`^\s*function check_` — i.e. it derives the count **from the Solidity source**. Its consumers are
`checkWhitepaperCounts` (`:222-223`, two patterns) and `checkReadmeCounts` (`:286`).
**The `ci.yml:306` comment is in none of these consumer sets, so it is an unguarded manual count —
same class as `FILE-MANIFEST.md`.** sc-chain's inference is correct.

**One important nuance in the other direction:** `ciJobCount()` (`:848-864`) and `ciMetamaskPin()`
(`:624-629`) *do* read `.github/workflows/*.yml`. So the script already parses workflow files for
two specific values. A new guard would not be starting from zero — but note that `ciJobCount`
**parses YAML and counts job keys**, it does **not** lint comments. Nothing in the script can ever
see the `(6 specs …)` text, because a YAML parser discards comments by construction.

**Therefore the merge is *partly* sound and needs splitting:**

| Target | Guard status | Note |
|---|---|---|
| `FILE-MANIFEST.md` zone counts | **unguarded** | No script reads it at all |
| `ci.yml:306` Halmos comment | **unguarded** | Reason: YAML parsing drops comments — **not** merely "not implemented" |
| `STATUS.md` vault `22` | **guarded** (`:591-596`) | Already fails the build on drift |
| README / whitepaper Halmos counts | **guarded** (`:222`, `:286`) | Derived from source |
| `CHANGELOG` MetaMask pin | **guarded** (`:463-467`) | Compares against `ci.yml`'s pin |

**Recommended split, not a single merge:** a `check-manifest-counts.mjs` (shape copied from
`check-waivers.mjs`) should cover `FILE-MANIFEST.md`. The `ci.yml` comment case needs a *different*
mechanism — a **regex over raw text** (like `metamaskPinFromCi` does) rather than a YAML parse, since
no YAML-aware approach can ever reach it. Sharing one script is fine; sharing one *mechanism* is not.

**A second nuance that makes the MetaMask case *not* a parallel:** `ci.yml` names **two** MetaMask
versions — the live pin (13.49.0) in the release asset filename, and a **superseded 12.5.0 in a
cache-key comment** (which is why `metamaskPinFromCi` anchors on `metamask-chrome-<v>.zip` rather
than the first version-shaped token it finds, `check-doc-counts.mjs:562-568`). So a future guard
scanning workflow comments for a version must **not** naively match the first `13.49.0`-shaped
string, or it will pick up the dead 12.5.0 and invert the finding. This is also the concrete reason
my **H-12** matters: the threat map and `SECURITY.md` both assert "canary-verified on 13.49.0" while
the allowlist records 12.5.0 as the version the canary was actually verified on — a guard that
resolves the pin correctly would surface that disagreement automatically.


### dc-plan finding #2 — confirmed, and it is a live-doc hazard

`vault/Milestones.md` M1(w3) still demands "Multi-RPC shipped + health scoring demo passes", while
`vault/Risk & De-risk Plan.md:14` says **C3 KILL/DEFER** and `vault/Build Plan.md:8` says
**Drop/defer**; `MultiRpc|healthScore` has **0 matches** across `packages/`. Under `STATUS.md`'s own
L4 < L1 rule the milestone doc is wrong. It currently reads as a live roadmap, so a reader will
believe M1–M5 are upcoming. This is the highest-value item in dc-plan's report: one banner line
fixes it.

---

## 4. Where the documentation is actually correct

Recorded so a fix pass does not disturb it:

- `DEPLOYMENT.md:63-77` — the `DeployDeterministic.s.sol` behaviour is exactly as documented: zero salt rejected
  (`DeployDeterministic.s.sol:30`), missing `SIGILKIT_OWNER_ADDRESS` rejected (`:26-28`), and the
  deployer-proxy dependency correctly disclosed (`:32-35`).
- `DEPLOYMENT.md:170-175` + `:270` — the fail-closed cursor revalidation description matches
  `packages/indexer/src/indexer.ts` (`validateCursor` null/mismatch refusal at `:809-813`, no automatic
  rollback at `:643-644`), including the "not one atomic transaction" and "stable-`end` only" caveats.
- `DEPLOYMENT.md:195-199` — "recovery rewinds are scoped by chain, not by manager" is exactly right:
  `rollbackTo` issues `DELETE … WHERE chain_id = ? AND block_number > ?` (`indexer.ts:645-648`).
- `CONFIGURATION.md:11-21` — the four-level precedence and "real env wins over file" match
  `loadDotEnv` + the flag-overrides-env ordering in every CLI.
- `CONFIGURATION.md:23-26` — "set but invalid is an error, not a fallback, including the log settings"
  matches `readEnvChoice` → `ValidationError` (`config.ts:167-168`).
- `GETTING-STARTED.md:11` / `DEPLOYMENT.md:11` — Foundry 1.7.x matches the CI pin `v1.7.1`.
- `CONFIGURATION.md:82-83` — the log level/format value sets match `LOG_LEVELS` / `LOG_FORMATS` exactly
  (`packages/core/src/logger.ts:47, 50`), including the `silent` level.

---

## 5. Recommended fix order

1. **C-04** (demo command fails) — one-line fix, unblocks the quickstart.
2. **C-01 / C-02** (threat map rows 5 and 8 built on a non-existent attack surface) — the map is the
   document a security reviewer reads first; two of its ten rows are not about reachable code.
3. **H-07** (Safe owner + E10 countersign are mutually exclusive) — the doc's own recommended
   production posture breaks a documented feature. Either document the limitation or resolve it in
   `SessionKeyManager`.
4. **M-04 / X-23** (`SIGILKIT_AUDIT_DB_ROOT`) — add to `CONFIGURATION.md`, `.env.example`, and both
   MCP sections of the deployment/getting-started docs.
5. **C-08** (open `receive()` on the implementation address = permanent fund lock) — a warning, not a
   behaviour change.
6. **C-06 / C-03 / C-09** and the H-01…H-03 line-anchor set — mechanical, but they are what makes the
   rest of the map checkable.
7. **X-01…X-04** — document E10, E11, and ERC-1271. These are the features most likely to be used
   incorrectly by a reader who has only the current docs.
8. **§1b X-28 / X-29** — the two `ISSUES-CATALOG-2026-09-25` entries recorded as fixed whose
   vacuity was relocated rather than removed. These are audit-prep documents; a wrong "closed" is
   the most expensive class of doc error in this set.
9. **X-30 / M-12** — `CI-WAIVERS.md` counts vacuous green runs toward removing a waiver, and its
   criterion wording is ambiguous in a way that has already misled a reader into false urgency.
   Wording-only fix, but it is the document that governs whether a control is enforced.

---

## 6. Doc-count reconciliation (assigned by team-lead, 2026-09-26) — DONE, GATE GREEN

**Why this section exists:** this audit had claimed the doc-count gate could not be run. That was
wrong — `forge` **is** available on this machine and only the `FORGE_BIN` env var was missing. Once
set, `node scripts/check-doc-counts.mjs` runs and reports real drift. Correcting that matters: an
earlier teammate (dc-plan) reported 9 "drifts" read out of a *dead* command's stderr and then
"corrected" them twice. The gate was never red for the reason we all assumed.

**Measured with `FORGE_BIN` set, immediately before editing** (not a relayed number):

```
forge (PR scope): 220 tests across 17 suites
forge (excluded: invariant + fork): 5 tests across 2 suites
forge-lint annotations: 56
```

**The 9 drifts fixed** (all in one change, per `STATUS.md:96-98`):

| File | Field | Was | Now |
|---|---|---|---|
| `README.md:45` | tests / suites + 14-row breakdown | 158 / 14 | **220 / 17** (17-row breakdown) |
| `README.md:111` | `npm test` comment | 158 | **220** |
| `docs/WHITEPAPER-v2.1.md:19` | audit-status banner | 158 | **220** |
| `docs/WHITEPAPER-v2.1.md:77-79` | tests / suites + breakdown | 158 / 14 | **220 / 17** |
| `docs/WHITEPAPER-v2.1.md:96` | "Foundry total above" | 158 | **220** |
| `docs/TROUBLESHOOTING.md:166` | forge-lint annotations | 49 | **56** |
| `docs/STATUS.md:63` | L3 row for this audit | — | now also records the reconciliation |

`README.md:47` and `README.md:54` were **already correct** (4 invariants / 14 CI jobs) and were left
alone. The whitepaper's CI-job and Halmos counts were already correct too.

**Verification:** `node scripts/check-doc-counts.mjs` → **exit 0**,
`doc counts OK — README, whitepaper, CHANGELOG, STATUS, TROUBLESHOOTING and SECURITY match the toolchain.`

> ⚠️ **Timestamp discipline (ck-test's rule, adopted).** Gate results are **"(value, when)"**, never
> just "(value)" — an `exit 0` is a statement about a moment and environment changes overturn it just
> as they overturn a number.
>
> **Re-verified 2026-09-26 22:22:44 — gate is still GREEN, at a new HEAD-adjacent moment.**
> `$env:FORGE_BIN="C:\Users\dev25\.foundry\bin\forge.exe"` →
> `node scripts/check-doc-counts.mjs` → **exit 0**, `doc counts OK — README, whitepaper, CHANGELOG,
> STATUS, TROUBLESHOOTING and SECURITY match the toolchain.`
>
> **Gate-result provenance for this run** (the three fields required before a green result may be used
> as acceptance evidence):
>
> | ① when | ② `git rev-parse HEAD` | ③ this command's external imports |
> |---|---|---|
> | **2026-09-26 22:22:44** (immediately after my last edit, per the re-run-after-every-edit rule) | **`ce8eea2`** | **all resolved — `yaml` is the only one; the other four imports are node builtins** |
>
> So the 220 / 17 / 56 written into `README.md:45,111`, `docs/WHITEPAPER-v2.1.md:19,77-79,96` and
> `docs/TROUBLESHOOTING.md:166` are confirmed by the repo's own gate, not only by my hand-rolled
> `forge test --list` parse — **and `vitest`/`typescript` still missing is irrelevant to this claim**,
> because ③ is judged per command. The earlier ~18:32 green is superseded, not contradicted.
>
> **Without `FORGE_BIN` the same command exits 2 with `spawnSync forge ENOENT`** even though every
> count is correct. Reproduced at 22:21:50, deliberately, to confirm the failure mode is the env var
> and not the documents. **A red gate whose stderr is `ENOENT` on an installed binary is an environment
> defect; do not edit documentation in response to it.**

### 🔴 A false root cause I published, and its correction

Between ~18:10 and ~18:30 I reported — to team-lead, ck-test and ck-perf — that
**`node_modules` had been wiped by someone's `npm run clean`**, and that `npm ci` was required.
**That diagnosis was wrong on both counts, and I checked before acting on ck-perf's challenge:**

| My claim | Verified | Verdict |
|---|---|---|
| `node_modules/yaml` is MISSING | `node_modules/yaml/` exists with `package.json`, `dist/`, full tree | **false** |
| someone ran `npm run clean` | `scripts/clean.mjs:50-61` deletes `out`, `cache`, `coverage`, `packages/*/dist`, `packages/*/coverage` — **`node_modules` is not in its list** | **false** |
| `npm ci` is needed | not needed; nothing was missing | **false** |

**The actual cause is mundane and I should have checked it in the first place:** `FORGE_BIN` is set
per-shell, and each new shell starts without it. Unset, `check-doc-counts.mjs` cannot find `forge`,
prints `could not run forge test --list … spawnSync forge ENOENT` and exits **2** — which I
misread as a dependency failure. The `ERR_MODULE_NOT_FOUND: Cannot find package 'yaml'` I reported
was a **transient state during a concurrent `npm install`**, not a persistent condition; by 18:32
`yaml` resolved normally.

**Two lessons, both of which I have now been on the receiving end of:**
1. **A non-zero exit from a tooling script is a "result", not "missing data".** dc-plan drew the same
   wrong inference earlier today (reading numbers out of a dead command's stderr and "correcting"
   them twice). I did the same thing one step removed: I read `exit 2` + a module error as
   "environment broken" instead of "the tool could not find its input".
2. **"Set but unresolved in this shell" ≠ "absent".** `forge` and `node_modules` were both present the
   whole time. Reporting an absence I had not actually verified cost three colleagues a detour.

### ⚠️ A second correction: the retraction above was itself incomplete

I published the table above and then **stopped verifying**. ck-perf re-tested the other half of the
story; I re-verified it myself before accepting, because my first and second versions were each
wrong in a *different* direction:

| Check | Result |
|---|---|
| `node_modules/@sigilkit/` | **4 entries, all `LinkType = Junction`** — present |
| Junction target | `D:\SigilKit\packages\core` — **physically exists** (`Test-Path packages/core/package.json` → `True`) |
| `Test-Path node_modules\@sigilkit\core\package.json` | **False** |
| `node -e "import('@sigilkit/core')"` | **`ERR_MODULE_NOT_FOUND`** |

**The dependency tree is complete and the junction target is valid, yet the junction is not
traversable on this machine.** That is a *host policy* condition (reparse-point / controlled-folder
access), not a missing dependency. So my retraction was right that **`npm ci` is not needed** and
wrong to imply nothing was actually wrong: **there is a real, persistent, machine-local condition
behind `@sigilkit/*` resolution.**

**⚠️ Corrected precisely, at team-lead's prompting — "nothing was missing" was itself too strong.**
I verified the split:

| Dependency class | State (verified 18:47) |
|---|---|
| **Production** — `yaml`, `abitype`, `ox`, `ws`, `viem` | **all present** |
| **Dev** — `vitest`, `typescript`, `@vitest/coverage-v8`, `@playwright/test` | **all MISSING** |

**⚠️ The 18:47 row above is a point-in-time snapshot and is now STALE — re-measured 22:21 the split is:**

| Package | 22:21 state | note |
|---|---|---|
| `yaml` | **present** | the doc gate's only external import |
| `ox`, `viem`, `@noble` | **present** | present via the workspaces that remain linked |
| `abitype`, `isows`, `ws` | **MISSING** | were listed "present" at 18:47 — they went with the tree churn |
| `vitest`, `typescript` | **MISSING** | the actual reason the TS suites cannot run |
| `@sigilkit/*` (4 junctions) | present but not traversable | host-policy condition, unchanged — see below |

**⇒ The durable statement is the command-scoped one, not the package list:** a package inventory is
the fastest-decaying fact in this document, and quoting it without a timestamp is how the 18:47 row
became wrong inside the same session. The current correct claim is: **`check-doc-counts` is green
because its own import resolves; the TS suites are unrunnable because `vitest` and `typescript` do
not.** Any future statement about "dependencies" in this report must name the command it is about.

So the accurate statement is: **the production dependency tree is complete; the dev/test
dependencies are not.** My earlier claim of "no blocker" was right about the junction and wrong
overall — `check-runtime` exits 1 precisely because `vitest` cannot be resolved. **I had collapsed
"the packages I was using were fine" into "nothing was missing", which is the same
over-generalisation from a partial observation that this section is about.** `npm ci` would *not*
fix the junction, but it *would* restore the dev tree; the two issues are independent.

**Scope, verified: this does NOT affect the doc gate.** `check-doc-counts.mjs` mentions `@sigilkit`
three times but imports none of it, and with `FORGE_BIN` set it exits **0** regardless. It blocks
`@sigilkit/core`-importing Node code (e.g. the `benchmark-indexer` e2e), not `check:docs` and not
the Solidity half of `verify`. **The 220/17/56 delivery stands** — it is gate-confirmed.

**Still open and genuinely unowned:** who clears the host policy, or whether the affected test
should stop depending on package-name resolution. `collectBuildIdentity` explicitly refuses symlinks
(`build identity refuses symlink`), so substituting a symlink for the junction is not available.

**✅ RESOLVED — ruled by team-lead 2026-09-26: not fixed, not a P0, and no code change.** The
junction block is registered as a **known machine-local environment constraint**. Reasoning, which
I accept: (1) relaxing reparse-point traversal is a system-level change (controlled-folder access /
WDAC) that is out of repo scope **and unverifiable** — and after four unverified "fix proposals"
today, adding a fifth is the wrong move; (2) switching to relative-path `load:` injection would make
`build.files` — a **supply-chain declaration** — disagree with the code actually loaded, which is
worse than a test that cannot run. Neither of my two rejected options is reconsidered.

**Dev-dependency restoration is a separate matter and was mis-bundled with the junction issue.**
The dev tree (`vitest`, `typescript`, `@vitest/coverage-v8`, `@playwright/test`) is missing and
`check-runtime` exits 1 because of it. I had folded both into one "dependency" story; they are
independent, and the one with a real remedy is the one I initially misdiagnosed as healthy.

**⚠️ My proposed remedy (`npm ci`) was wrong, and team-lead's override is verified.** I measured the
lockfile to check the objection:

```
lockfileVersion            3
node_modules/* entries     150
@sigilkit/* entries        4   — all link: true
   node_modules/@sigilkit/core       → resolved: packages/core
   node_modules/@sigilkit/indexer    → resolved: packages/indexer
   node_modules/@sigilkit/mcp        → resolved: packages/mcp
   node_modules/@sigilkit/demo-agent → resolved: packages/demo-agent
```

**Those 4 link entries are precisely the 4 junctions this machine cannot traverse.** `npm ci` deletes
`node_modules` by design and rebuilds the tree from the lockfile, so it must recreate exactly the
constructs that are known to be broken here — reproducing T4 (a re-arranged/half-cleaned tree) is a
real risk. **I had asserted the remedy worked without checking that it touched the failing
construct**, which is the same class of error as everything else in this section: a plausible
mechanism, verified nowhere. Approved substitute: **`npm pack` + `tar`, restoring dev deps without
touching the lockfile or rebuilding workspace links** (sc-e2e measured it working — `validate-workflows`
15/15, `check-waivers` 31/31, `check-vectors` 56/56, `check-dockerfile` 37/37).

**One residual uncertainty, recorded so the decision is not over-read.** The *current* state already
has all 4 junctions present-but-non-traversable, so "rebuild reproduces the present condition" is a
**known-tolerable** outcome, not a new failure. The genuinely bad outcome is the half-cleaned tree.
Whether `npm ci` lands in the first bucket or the second depends on reify order, which I did not
determine. That is an argument *for* the `npm pack` route, not against — but it is not proof that
`npm ci` would fail, and the P1 should not be justified on that basis.

**P1 justification, as tightened by team-lead — note the explicit disclaimer:**
> Choose `npm pack` + `tar` **because it has been measured working** (sc-e2e: 4 suites at 15/31/56/37,
> all green). Do **not** choose `npm ci` because in the best case it merely circles back to the
> current state, and in the worst case it leaves a half-cleaned tree.
> **⚠️ This is NOT a proof that `npm ci` would fail.**

**The annotation style is adopted team-wide:** when a conclusion rests on the *absence* of a failure
mode rather than a demonstration of it, **write "this is not a proof that X" explicitly.** At least
three people this round (including team-lead) stated something stronger than their evidence supported
before this convention existed.

**One further constraint on any future fix (ck-perf, measured) — it downgrades a candidate option.**
`benchmark-indexer.test.mjs` is now 45 tests / 44 pass / 1 fail, and the failure **self-reports its
cause** (the earlier generic-message-plus-empty-stderr observability defect is fixed; his earlier
`JSON.stringify(error.report.errors)` workaround is withdrawn). The reported failed validity checks
are `completed, correctness, timingValid, buildIdentified`. **`buildIdentified` is in that list, which
matters:** switching the test to a relative-path `load:` injection would not fix it — the bytes
actually executed would no longer be the bytes `build.files` declares, so `buildIdentified` stays red
and the test trades an import failure for an identity mismatch. **That is a correctness property, not
a cosmetic one, and it is the decisive argument against that option** (consistent with team-lead's
ruling that `build.files` is a supply-chain declaration). Anyone reviving this option must address
build identity in the same change, or it has not been fixed.

**A third failure mode, added by ck-perf and correct — retracting an unverified conclusion requires
re-measurement, not a different unverified reason.** ck-perf's sequence was: (1) observe "untrusted
mount point" → declare "pre-existing environment issue"; (2) on being challenged, switch to "the
dependency tree is probably incomplete" — **also without re-measuring**. He had *observed
correctly* both times and *characterised* correctly only after a clean re-test. The retraction
itself became a fresh error source, and it is harder to challenge because it wears the costume of
self-correction. **The rule: to overturn an unverified claim, produce a re-measurement — not another
inference.**

**The asymmetry that makes this urgent (team-lead's formulation, adopted as the primary rule — it is
sharper than my three-way taxonomy above, which classifies *what* went wrong rather than *how
harmful* it is):**

> **Inferring "it changed" from a stale count is a WEAK error** — right direction, imprecise, and it
> self-corrects on the next look.
> **Inferring "it did not change" from a stable mtime is a STRONG error** — it actively denies a
> fact that was true, **and it removes the reason to look again, so it cannot self-correct.**
> **Operational form: saying something loudly when it is wrong is more dangerous than saying it
> quietly — a false negative suppresses the next check; a false positive only costs one re-read.**

My `"npm ci` is not needed, so it was over-read"` retraction is exactly the strong form: it denied a
real condition *and* removed the reason to re-test the junction. My own note that "a retraction is
harder to challenge because it wears the costume of self-correction" is the same point from the
other side.

**⚠️ A SECOND primary rule, added by team-lead, which indicts my own reasoning above.**
My retraction and the stable-mtime error are the *same shape*, and the generalisation is more useful
than either instance:

> **Rule 1 (ck-perf):** to overturn an unverified conclusion, produce a **re-measurement** — not
> another inference.
> **Rule 2 (mine, generalised by team-lead):** **eliminating one option does not verify the
> remaining ones.** It looks like progress, which is exactly why it is the more insidious of the two.

My concrete instance: "`npm ci` is not needed" was **true** — and I used it to close the question,
without checking that `npm ci` was even the right remedy for the *other* half of the problem. Two
steps of the same error: I excluded an option, then treated the remainder as verified. That is how
"dependencies are fine, so there is no dependency problem" survived long enough to also hide the
missing dev tree.

**⑥ A constant offset across a sample can be a coincidence of an incomplete sample — and the
explanation offered for the odd row can be wrong too (found by measuring the row that had been
skipped).** ck-perf measured 5 of the 6 `GasBudget.t.sol` budget rows, found **all five at exactly +68**,
and inferred a clean environmental constant. **Five identical deltas is very strong evidence** — and it
was still wrong, because the sixth row is **−316**. **I then offered a confident explanation for the
odd row (the E11 fail-open→fail-closed change) and that was wrong too** — the fixture uses a standard
ERC-20 whose `balanceOf` returns a full 32-byte word, so that branch is never reached. **The −316
remains unattributed.** Two lessons, and the second is the one that generalises:
- **A constant pattern is only evidence for the rows it was measured on.**
- **A plausible mechanism is not an attribution.** Having a ready explanation for an anomaly makes it
  *more* likely to be accepted, not less — which is the opposite of the intended direction.

**Generalised: before generalising a uniform drift to "the whole table", identify which rows share the
mechanism the drift is attributed to.** Rows that share a code path are comparable; the row that
differs is the one that carries independent information. **Sampling uniformly and then extrapolating
is the same error as sampling partially and then declaring a cause** — in opposite directions.

**⚠️ And the causality, which ck-perf corrected and which is the more useful half.** I credited his
restraint — "he didn't test the row" — and he rejected that framing, correctly: **what actually saved the
report was that he left the cell blank, not that he happened not to measure it.** Restraint-as-luck is
not a control; leaving a gap visible is.

> **Leave "unmeasured" blank; do not fill it by extrapolation.** An extrapolated cell enters the
> report wearing the costume of a measurement — and if a second person confirms it, it enters as a
> *double-confirmed* one, which is harder to challenge than the original error. **A blank cell is
> visible and gets asked about; an invented one is invisible and gets cited.**

Applied to this round: the correct entry for the watchlist row was **"−316, cause unattributed"**, and
the wrong entry was **"+68, environmental"** — a plausible number, uniformly consistent with five
others, and wrong. I filled it, and ck-perf caught it. **The gap was the safety mechanism; I removed it
myself.**


support a conclusion must be **sampled at least twice, ≥3 seconds apart, with both results stated.**
This is the cheapest reliable discriminator between a transient state and a persistent condition, and
at least four blocker reports today failed on exactly that confusion. **The converse half matters
equally: a single sample cannot establish that something is stable _or_ that it is unstable.** ck-perf
fell into both halves himself — one sample said "2 entries, wiped", and after recovery another single
sample said "10 entries, complete"; neither was a stable observation.

**A shared rule this round earned, proposed by ck-perf and adopted here.** Three separate blocker
reports circulated today, and each failed for a different reason: dc-plan's B-0 pointed at a
**deleted** file; ck-perf's "untrusted mount point" turned out to be a **correct observation
characterised too early** (re-testing confirmed the condition is real and persistent — see the
second correction above); mine was an **unverified absence escalated to a blocker**. The common
defect is that none carried an observation time or a
reproducibility statement, so a reader could not tell a live blocker from an expired one. **Proposed
for team-wide adoption: every blocker report must state `(observed at, reproducible yes/no, checked
how)`.** An expired blocker report and a fabricated one are equally harmful, because both send someone
to fix something that is not broken — and in a parallel-work repo, that is the default outcome.



**Two notes for the record:**

1. **team-lead's snapshot (203 / 16 / 54) was already stale when it reached me** — it was taken
   45 seconds earlier, but `GasUncoveredPathsTest` (33) and `Sec10WindowRotationTest` (6) landed in
   between. I re-measured rather than transcribing, per the same rule team-lead applied to dc-plan.
   The numbers I wrote are the ones the gate now agrees with.
2. **`--write` was deliberately not used.** It only rewrites headline numbers; both breakdown tables
   needed hand-editing row by row, which is why they went from 14 to 17 rows with three new suites
   named (`gas uncovered paths 33`, `E11 watchlist read 9`, `SEC-10 window rotation 6`).
   `Sec10WindowRotationTest` is itself the regression suite for the SpendPolicy P0, so its
   appearance in the published count is the doc layer finally reflecting a security fix.

---

## 7. Symbol-anchor index (line-number-independent)

`contracts/src` was edited during this audit, so resolve findings by symbol. This is the
authoritative map from every symbol cited above to its home.

### `SessionKeyManager.sol` (contract at :21)

| Symbol | Line | Cited in |
|---|---|---|
| `Scope` struct (`countersignAbove` :53, `enforceNativeDelta` :54, `tokenWatchlist` :55) | 47-56 | X-01, X-02, X-03, N-05 |
| `ActionRequest` struct (`expiry` :65) | 59-68 | N-04 |
| `MAX_WATCHED_TOKENS = 8` | 113 | X-03 |
| `_ERC1271_MAGIC` / `_ERC1271_MAGIC_BYTES` | 139-140 | X-04, X-07 |
| `_ERC1271_PREFIX_LENGTH = 20` | 162 | X-04 |
| `onlyOwner` (self-sealing denylist write) | 167-185 | N-03, X-06 |
| `_seedAdminDenylist` (6 selectors) | 223-230 | C-07, N-03 |
| `adminSelectorDigest` | 251-261 | X-14, C-07 |
| `receive()` — **open, funds permanently locked on the implementation address** | 283 | C-08 |
| `grantSessionKey` | 298-309 | X-12 |
| `withdraw` + `TreasuryWithdrawal` | 311-321 | X-10 |
| `rotateSessionKey` / `_grant` (`expiresAt` overwrite) | 329-367 | X-11, N-05 |
| `_validateScope` (watchlist cap) | 369-378 | X-03 |
| `executeWithSessionKey` (countersign :431-448, nonce :452-453, denylist :456, merkle :464-469) | 406-483 | C-01, H-07, N-04 |
| `getNonce` | 496-498 | H-02 |
| `DOMAIN_SEPARATOR` / `ACTION_REQUEST_TYPEHASH` / `REQUEST_APPROVAL_TYPEHASH` | 508-518 | X-01, X-09, C-09 |
| `_interact` (Slither "sole call site" annotation) | 523-541 | N-09 |
| `_verifyBalances` | 564-580 | N-08 |
| `_revertInnerCall` | 587-604 | — |
| `_targetAllowed` (leaf v2, pinned-or-wildcard) | 609-629 | X-27 |
| `_domainSeparator` (`block.chainid` + `address(this)`) | 631-635 | C-09 |
| `_isERC1271SuccessMagic` (SEC-11) | 658-674 | X-07 |
| `_recover` (**`extcodesize` at :698**) | 681-709 | C-03, X-04 |
| `_declaredTokenOutflow` (transfer/transferFrom only) | 753-767 | X-03, N-08 |

### `SessionKey7579Module.sol` (contract at :49)

| Symbol | Line | Cited in |
|---|---|---|
| MAX_BATCH_SIZE / MAX_TOTAL_PROOF_ELEMENTS / MAX_SINGLE_PROOF_ELEMENTS | 141 / 143 / 151 | X-16 |
| `ScopeGranted` / `ScopeRevoked` / `SelectorDenylistSet` / `ModuleUninstalled` | 177-180 | X-17 |
| `isModuleType` (1 = VALIDATION) | 188-190 | X-17 |
| `onInstall` (gated on `msg.sender`) | 202-210 | C-01 |
| `setSelectorDenied` (**no self-seal** — explicitly documented as a filter, not containment) | 251-255 | N-03 |
| `validateUserOp` (`msg.sender != userOp.sender` guard) | 287-315 | C-01, H-01 |
| `_validateExecution` (extracted dispatch) | 322-361 | H-01 |
| `_selectorOf` (rejects sub-4-byte calldata, BUG-19) | — | — |
| `_recover` (**ECDSA-only: no `extcodesize`, no ERC-1271**) | 584-608 | C-02, N-06 |

### `ActionLog7579Executor.sol` (contract at :17)

| Symbol | Line | Cited in |
|---|---|---|
| `EmptyAgentId` | 28 | X-19 |
| `AgentBound` / `AgentUnbound` | 40 / 48 | X-17 |
| `isModuleType` (6 = EXECUTOR) | 68-70 | X-17 |
| `setAgentId` — trust boundary: "account-asserted claim, not a third-party attestation" | 101-106 | X-18 |
| `agentId` view | 111-113 | X-18 |
| `execute` (`msg.sender == account`, `msg.value == value`, zero target, reentrancy, non-empty agentId) | 136-175 | C-01, X-19 |

### `SpendPolicy.sol` / `ActionLogger.sol` / `MerkleWhitelist.sol`

| Symbol | Line | Cited in |
|---|---|---|
| `SpendPolicy.event WindowCharged` — **not in ActionLogger** | SpendPolicy:30-41 | C-06, X-08 |
| `emit WindowCharged` | SpendPolicy:86 | C-06 |
| `ActionLogger.event ActionLogged` | ActionLogger:64-72 | C-06 |
| `ActionLogger._logAction` | ActionLogger:79-87 | C-06 |
| `MerkleWhitelist.verify` (sorted-pair) | MerkleWhitelist:14-24 | X-27 |
| Leaf-v2 convention doc | MerkleWhitelist:7-10 | X-27 |

### `SigilKitDelegator.sol` (contract at :29)

| Symbol | Line | Cited in |
|---|---|---|
| `AlreadyInitialized` | 30 | X-15 |
| `constructor() SessionKeyManager(address(this))` — **owner is set at construction** | 32 | C-07, N-01 |
| `initializeSelfOwned` | 35-46 | C-07, N-01, X-15 |
| `adminSelectorDigest` override (folds its own selector) | 55-59 | X-14 |
