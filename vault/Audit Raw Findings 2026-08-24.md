> [!CAUTION] SUPERSEDED SNAPSHOT — NOT A DISCLOSURE, NOT A ROADMAP (added 2026-10-16)
>
> This file is the raw, unedited output of a multi-agent review round dated 2026-08-24,
> kept as a historical record only (see `docs/VAULT-AUDIT-2026-09-26.md`, item F4:
> "SPENT — keep as record"). For anything actionable read
> `docs/Issues-Catalog-2026-09-11.md` instead: every item below was re-verified there
> item-by-item and carries its current status.
>
> **The findings below are historical, not live.** The two High-severity contract findings
> called out here are already remediated in the committed code: `validateUserOp` now
> enforces `msg.sender != userOp.sender` (SessionKey7579Module.sol:316,
> `NotAuthorizedCaller`) and the uninstalled-account gate (`:320`, `NotInitialized`).
> Always re-verify against source before repeating any of this text as current.
>
> Per `vault/README.md`, where this note and the code/catalog disagree, the code and
> catalog win. Proof-of-concept sketches are retained for internal traceability only —
> do not run them against systems you are not authorised to test, and do not quote them
> externally.
>
> ⚠️ External citations that point at a line number *inside* this file shifted downward
> by 25 lines when this block was prepended on 2026-10-16 (old :2 is now :27).

<!-- AUDIT 2026-10-16 ci-security-3: added the supersession banner above and corrected two
     stale ci.yml assertions at the old :120 and :125. Kept as CRLF, line content otherwise
     byte-identical so the historical record stays auditable. -->

########## AGENT afb545fde8 | findings=7 strengths=6 opps=7

[High] (16h) Flagship differentiator 'cross-wallet conformance harness' is ~1 cell implemented; wallet legs are hardcoded placeholder assertions
  area: differentiation credibility
  desc: The vault thesis (vault/Research Summary.md:38, vault/Component 4:8) stakes the moat on 'the cross-wallet 7702 revocation conformance harness'. What actually exists is signer-LIBRARY parity: packages/core/test/parity.test.ts proves viem↔ethers↔SDK byte-identical digests/signatures, and conformance.test.ts proves TS↔Solidity on-chain acceptance. The actual WALLET legs (MetaMask, Coinbase Playwright) are unwired stubs: packages/core/test/wallet-e2e.manual.test.ts:52 executes `expect(b.expected).to
  fix : Either (a) wire the two Playwright legs for real (~2 weeks: persistent context, metamask-test-dapp, Anvil fork, capture in-UI revoke tuple vs signRevocation()), or (b) rename the claim everywhere to 'three-way signer-library parity' and market the harness as 'first cell of the matrix'. Option (a) converts the flagship differentiator from aspiration to fact and is the single highest-leverage engine

[High] (4h) Repo is unpublished and CI can never fire: no git remote, CI triggers on 'main' but the only branch is 'master'
  area: go-to-market readiness
  desc: `git remote -v` returns empty — there is no GitHub repository, so the npm `repository.url` fields (github.com/sigilkit/sigilkit) point at a repo that does not exist, CI badges cannot exist, and the '8-job CI' claim (CHANGELOG.md:41) has zero public evidence. Worse, .github/workflows/ci.yml:4-6 triggers pushes only on branch `main`, while the sole local branch is `master` (verified via git branch -a) — so even after pushing, nothing runs until the trigger is fixed, including the Halmos release ga
  fix : Create the GitHub org/repo, push master as main (or change the trigger to the actual default branch), confirm all 7 jobs green including Halmos on main, add status badges to README, then publish @sigilkit/core to npm. Do this before any grant application or outreach — reviewers click links.

[Medium] (1h) README contradicts itself on verification status — lethal for a project whose brand IS claim-correction
  area: brand integrity (verification rigor)
  desc: README.md:24-33 states Slither triaged (✅), Halmos 6 specs passing (✅), 34 Foundry tests. Nine lines later, README.md:105-107 states the same two items as ⬜ unchecked/pending and cites '21 Foundry tests'. CHANGELOG.md:35 says 38. Ground truth: grep counts 17+17 unit tests = 34, plus 4 invariant functions = 38 total; Slither triage exists (SECURITY.md, 13 findings accepted-by-design); Halmos.t.sol contains exactly 6 check_* specs. So the lower section is stale, not dishonest — but SigilKit's enti
  fix : Delete or rewrite the stale 'Audit & verification status' section; derive test/spec counts mechanically from CI output (job summary artifact) rather than hand-editing. Sweep whitepaper/CHANGELOG for the same numbers. One hour, do before anything public.

[Medium] (50h) "Formally verified" marketing exceeds proof scope: Halmos covers only the cap-math library, not the auth flow
  area: verification claims
  desc: contracts/test/Halmos.t.sol contains 6 genuine symbolic specs, but all target a SpendPolicyHarness wrapping the SpendPolicy.enforce library function plus two Merkle boundary checks — not SessionKeyManager or SessionKey7579Module. SECURITY.md:27-33 is honest (INV-2/4 covered by fuzz, INV-3 by unit+E2E), but WHITEPAPER-v2.1.md:31 says Component 4 is 'Implemented, formally verified' unqualified, and the README component table says 'Implemented + formally verified'. The signature-recovery path (_rec
  fix : Short term: qualify every claim to 'spend-cap core formally verified' (1 hour). Medium term: extend Halmos specs to the module's validateUserOp accept/reject boundary and the manager's expiry/revocation paths — this doubles as the peer-review artifact and pre-empts the strongest auditor objection.

[Medium] (30h) The mandatory-audit moat is absent on the standards-native path: SessionKey7579Module emits no ActionLogged
  area: product architecture / moat coherence
  desc: SECURITY.md:22-23 documents that SessionKey7579Module emits no ActionLogged because validation-passing ≠ execution-landing (bundler may drop). Correct reasoning — but it means the ERC-7579 path, which the vault identifies as where extensibility lives (Competitive Landscape.md:23) and which README.md:18 presents as bringing 'the same scope enforcement' to Kernel/Safe{Core}, delivers caps WITHOUT the audit trail. An integrator who picks the standards-native path silently loses the exact feature th
  fix : Ship a companion ERC-7579 EXECUTOR (or hook-type) module that wraps execution and emits ActionLogged at execution time, paired with the validator — the SECURITY.md note already gestures at this ('pair with an executor/hook'). This restores bundle coherence on the path where adoption will actually happen.

[Medium] (10h) Standalone SessionKeyManager concentrates treasury control in a single EOA owner, diverging from the planned 2-of-3 Safe + Timelock governance
  area: institutional positioning
  desc: The corrected whitepaper targets integrators and treasury operators, and Build Plan.md:40 specifies 'upgrade authority: UUPS under 2-of-3 Gnosis Safe + 24h TimelockController' before mainnet. None of that exists: SessionKeyManager has a plain address owner set once in the constructor (SessionKeyManager.sol:119-130), no proxy/UUPS wiring (ERC-7201 namespaced storage at :66-67 shows proxy-readiness intent only), and Deploy.s.sol takes SIGILKIT_OWNER_KEY as a plain EOA (see conformance.test.ts:73 e
  fix : Before any mainnet deploy: make the canonical deployment story owner=Safe{Wallet} (deploy script accepts a Safe address; demo shows 2-of-3), and write the UUPS-proxy variant or explicitly declare the manager immutable-by-design with migration via rotation. Decide now — it changes audit scope.

[Low] (8h) CI claims inflate: '8-job CI' is 7 jobs including an echo-placeholder, and the nightly fork job has no fork tests to run
  area: claim hygiene
  desc: .github/workflows/ci.yml defines 7 jobs. Two are non-functional today: echidna-nightly (:71-78) only echoes a string and is additionally unreachable because its `if: github.event.schedule == 'nightly'` condition is never true (no schedule trigger is defined in the workflow at all), and forge-fork-base (:81-92) requires secrets.RPC_BASE (not configured) and runs `--match-contract '.*Fork'` against a test directory containing zero Fork-matching contracts (verified file listing). The '8 testing lay
  fix : Add the missing schedule: cron trigger, wire one minimal Base-fork smoke test (deploy script + one state assertion), either implement Echidna config or remove it from counts. Cheap fix; do it alongside finding #2.
  + STRENGTH: Verified-before-shipped intellectual honesty: the vault contains a full self-audit (vault/Whitepaper Corrections.md) documenting the project's own fabricated claims (fake 0xcc… add
  + STRENGTH: Genuinely runnable vertical slice: one command (`npm run demo`) deploys the manager, grants a scoped key, signs with it, enforces on-chain, and asserts ActionLogged in the receipt 
  + STRENGTH: Security model enforced in the contract, not the SDK: caps, window accounting, denylist, expiry and nonce are all checked on-chain with CEI ordering and nonReentrant before the inn
  + STRENGTH: Verification depth well beyond category norms: handler-only invariant fuzzing with correct excludeContract/targetContract reasoning (contracts/test/SessionKeyManager.invariant.t.so
  + STRENGTH: Strategy discipline actually executed: the vault's de-risk decisions (kill Diamond → ERC-7579 VALIDATION module with account-bound EIP-712 domains and fail-closed batch+whitelist s
  + STRENGTH: The wallet-behavior allowlist (packages/core/test/WALLET_BEHAVIOR_ALLOWLIST.json) is a legitimately novel artifact class: versioned, issue-linked (MetaMask #35520, viem discussion 
  * OPPORTUNITY: Grant double-track per vault/Funding Audit Bounty.md bottom line: Arbitrum Audit Program ($10M ARB pool subsidizing third-party audits — active) to cover the Cantina/Sherlock contest, plus EF ESP rolling (FOSS builder-to
  * OPPORTUNITY: IEEE S&P 2027 research submission — deadline 2026-11-17, confirmed OPEN in vault/Academic Literature.md:18 (~12 weeks away). The verified publishable gap (same file, :13-14) is exactly SigilKit's subject matter: no forma
  * OPPORTUNITY: MCP-server packaging of @sigilkit/core (my judgment; the old whitepaper mentions MCP tools but nothing ships it): wrap prepareExecution/validateAgainstScope/assertAuditEmitted as MCP tools ('grant_scoped_session', 'propo
  * OPPORTUNITY: ActionLog indexer + explorer package: the ActionLogged event (ActionLogger.sol) is emitted data with no consumer. A small viem-based indexer (log → SQLite/Postgres) plus a read-only web view turns 'mandatory audit event'
  * OPPORTUNITY: Balance-delta enforcement to close the internal-transfer blind spot: snapshot native+known-token balances around the inner call inside executeWithSessionKey and revert if net outflow exceeds request.value + declared slip
  * OPPORTUNITY: ElizaOS attack-repro demo: arXiv:2503.16248 ('Real AI Agents with Fake Memories') shows memory injection causing unauthorized asset transfers — precisely SigilKit's threat model (compromised agent bounded by scope). A pu
  * OPPORTUNITY: Standards-churn optionality: an ERC-7710 delegation adapter (parent wallet delegates to scoped sub-agents under the emerging standard) and an ERC-8004 identity hook position SigilKit ahead of the standards it depends on;

########## AGENT a84223693f | findings=7 strengths=11 opps=6

[High] (2h) SessionKey7579Module.validateUserOp has no msg.sender==account gate: anyone can burn a victim's spend window from a mempool-copied userOp
  area: contracts/src/SessionKey7579Module.sol
  desc: validateUserOp (D:\SigilKit\contracts\src\SessionKey7579Module.sol:180-218) derives `account` solely from `userOp.sender` (line 185) and never checks msg.sender. Signature recovery binds the domain to that sender (lines 319-341), so ANY caller who possesses a validly-signed userOp can invoke validateUserOp directly and execute the state-changing enforcement paths (_enforceSingle :223-235, _enforceBatch :237-261) against the victim's window. Signed userOps are public in 4337 mempools by design. T
  fix : Add `if (msg.sender != account) revert InvalidSignature();` (or dedicated NotAuthorizedCaller error) at the top of validateUserOp. This is ERC-4337/7579-compatible because Kernel/Safe{Core} invoke validation modules in the account's context (msg.sender == account); verify against each target account framework before mainnet. Add a test asserting a non-account direct call reverts.

[Medium] (2h) Stale scopes stay validatable after module onUninstall, become irrevocable, and are silently resurrected by reinstall
  area: contracts/src/SessionKey7579Module.sol
  desc: onUninstall (D:\SigilKit\contracts\src\SessionKey7579Module.sol:127-132) deletes only `initialized[msg.sender]`, commenting 'Scopes/windows intentionally retained for audit reconstruction; revoke gates them.' But revokeSessionKey (lines 142-148) is _requireInitialized-gated (line 143), so after uninstall the account can never revoke; and validateUserOp (180-218) never checks `s.initialized[account]`, so an uninstalled account's unexpired, unrevoked scopes still pass all checks. Because onInstall
  fix : Check `_requireInitialized(account)` (or explicit initialized lookup keyed by userOp.sender) inside validateUserOp; additionally either zero out scopes in onUninstall or emit an Uninstalled event plus document resurrection semantics. Allow revocation while uninitialized only if you keep scopes queryable for audit.

[High] (6h) Spend caps protect native value only; README/SECURITY claim mitigations (amount-binding allowlist, SDK ERC-20 allowance pre-check) that do not exist in v0.1.0
  area: contracts/src/SessionKeyManager.sol, README.md, SECURITY.md
  desc: SpendPolicy.enforce (D:\SigilKit\contracts\src\SpendPolicy.sol:28-53) only sees the native value passed by executeWithSessionKey (D:\SigilKit\contracts\src\SessionKeyManager.sol:254-256). The whitelist leaf is keccak(abi.encode(request.target, request.selector)) (SessionKeyManager.sol:245): target+selector only, no argument commitment. So a session key whitelisted for USDC.transfer(address,uint256) can move the manager's ENTIRE token balance to any recipient in one value=0 call, fully within per
  fix : Immediately: correct README/SECURITY/INV-1 wording to state caps cover native value only and whitelisted token selectors are uncapped unless additional binding exists. Then implement one real mitigation: per-target leaf encoders committing calldata (or at least amount ceilings) into the leaf, and/or the SDK allowance pre-check the docs already advertise.

[Low] (1h) No low-s (signature malleability) check in either ecrecover wrapper
  area: contracts/src/SessionKeyManager.sol, contracts/src/SessionKey7579Module.sol
  desc: _ecrecover (D:\SigilKit\contracts\src\SessionKeyManager.sol:329-338) and _recover (SessionKey7579Module.sol:319-349) restrict yParity to {27,28} and reject the zero address (good), but accept s values above secp256k1 N/2. Wire format is standard r||s||v (matches SDK: packages/core/test sign via viem account.sign; test helper abi.encodePacked(r,s,v) at SessionKey7579Module.t.sol:110), so decoding is correct despite the misleading 'EIP-2098-unpacked' naming. Practical replay is already blocked by 
  fix : Add `if (uint256(s) > 0x7FFFFFFF...FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert InvalidSignature();` in both helpers; update conformance tests.

[Low] (1h) SessionKey7579Module ERC-7201 slot constant is hand-picked, not derived from its namespace (manager slot verified correct)
  area: contracts/src/SessionKey7579Module.sol
  desc: Computed with keccak: erc7201("sigilkit.storage.SessionKeyManager") = 0xff085e2083c01c9e351b5b4768e82a6e2037764ef8b048b601e1aeafbe014800, exactly matching SessionKeyManager.sol:66-67 (comment even cites cast index-erc7201) -- correct. The module's constant at SessionKey7579Module.sol:80-81 is 0x8f2e6dcba7d3cefa0b2623ad1e9d4a1bd3e9a14c9dbf7bbf3a2d5c1ee90f7100, whereas erc7201("sigilkit.storage.SessionKey7579Module") = 0x37fff519afacb07519d05d86325a08e1838a39976731130004177cffe6d58f00; a dozen pla
  fix : Regenerate the slot with cast index-erc7201 "sigilkit.storage.SessionKey7579Module" and replace the constant BEFORE mainnet deployment (safe now since nothing is live; breaking afterwards would orphan state).

[Low] (3h) Deploy script falls back to publicly-known private key 0xA11CE and README mislabels it 'deterministic deploy' (no CREATE2)
  area: contracts/script/Deploy.s.sol, README.md
  desc: Deploy.s.sol:11 reads `vm.envOr("SIGILKIT_OWNER_KEY", uint256(0xA11CE))` -- if the operator forgets the env var on a public network, the deploy broadcasts FROM the universally-known 0xA11CE key and sets owner to its address, giving anyone with the well-known private key owner rights over the wallet (grant/revoke/rotate/denylist + self-granting an uncapped-to-owner key path). Separately, README.md:45 labels Deploy.s.sol '# deterministic deploy' but run() uses plain `new SessionKeyManager(owner)` 
  fix : Use vm.envUint("SIGILKIT_OWNER_KEY") (reverts when unset) and assert the derived address is not a known-anvil/default address; log a loud warning. Add CREATE2 deployment (forge verify-contract style salt via a deterministic-deploy proxy or Foundry --create2 workflow) to honor the documented promise.

[Low] (1h) rotateSessionKey accepts unknown oldKey with overlapEnds=0, emitting spurious SessionKeyRevoked/SessionKeyRotated events
  area: contracts/src/SessionKeyManager.sol
  desc: At D:\SigilKit\contracts\src\SessionKeyManager.sol:167, an unknown oldKey has expiresAt==0, so only overlapEnds==0 escapes OverlapBeyondOldExpiry; _grant (179-187) then sets revoked[unknown]=true and emits SessionKeyRevoked(oldKey) plus SessionKeyRotated for a key that never existed. Purely event/state noise (revoked flag on unknown key is meaningless); rotation can never EXTEND life since overlapEnds <= original expiry is enforced and the write at :184 only shortens. Verified tests cover normal
  fix : Add `if (_manager().scopes[oldKey].expiresAt == 0 && oldKey != address(0)) revert KeyUnknown();` in rotateSessionKey; one unit test.
  + STRENGTH: EIP-712 domains correctly bind chainId AND verifyingContract in both contracts (SessionKeyManager.sol:301-305 uses address(this); SessionKey7579Module.sol:327-341 binds the install
  + STRENGTH: Disciplined CEI in executeWithSessionKey: msg.value rejected (SessionKeyManager.sol:224), nonce effect written before interaction (:238), window charged before the inner call (:254
  + STRENGTH: Batch ops under a non-zero Merkle root fail closed with a dedicated error (SessionKey7579Module.sol:244) rather than skipping proofs -- exactly the right default for v1
  + STRENGTH: _parseTrailingProof (SessionKey7579Module.sol:274-289) uses exact-length equality (length == 67 + count*32) making OOB slicing impossible; uint16 count bounds the loop; malformed t
  + STRENGTH: The unchecked totalValue accumulation in _enforceBatch (lines 252-254) is justified: each tuple is individually checked <= perActionCap first, so overflowing uint256 needs ~2^256/p
  + STRENGTH: Empty batches are provably harmless: enforce(totalValue=0,...) can only roll an ALREADY-elapsed window (equivalent to time passing) and never extends a live window's start (SpendPo
  + STRENGTH: Scope validation is thorough and symmetric across both contracts: zero key, past expiry, zero perActionCap, perWindowCap < perActionCap, and windowSeconds==0 all rejected at grant 
  + STRENGTH: Constructor seeds the denylist with all five admin selectors (SessionKeyManager.sol:125-129), so even a merkleRoot==0 'allow-all' key cannot reach administration -- genuine defense
  + STRENGTH: Rotation can shorten but never extends a key's life: OverlapBeyondOldExpiry bound at SessionKeyManager.sol:167 guarantees old-expiry >= overlapEnds, and overlapEnds==0 cleanly expr
  + STRENGTH: Verification infrastructure is real, not decorative: 4 invariant suites gated in CI (.github/workflows/ci.yml forge-invariant job), Halmos symbolic specs gated (ci.yml:95-109), Sli
  + STRENGTH: Manager ERC-7201 slot independently recomputed and confirmed exact: erc7201('sigilkit.storage.SessionKeyManager') == 0xff085e...4800 (SessionKeyManager.sol:66-67)
  * OPPORTUNITY: The two module fixes (msg.sender gate + initialized gate) plus a max-batch-size constant close every adversarial path in the 7579 surface for roughly half a day -- do them before any public testnet so the audit story sta
  * OPPORTUNITY: Argument-committing whitelist leaves (binding amounts/recipients per target) would turn SigilKit's 'caps are real' pitch into something competitors' session-key kits (Biconomy, OZ session key plugin) do not offer for tok
  * OPPORTUNITY: Deterministic CREATE2 deployment + hardened key handling is a prerequisite for the vault's Base-first multi-chain plan (vault/Build Plan.md) and simultaneously fixes the README accuracy issue; small effort, unblocks the 
  * OPPORTUNITY: Emitting a WindowCharged(account,key,value,spentThisWindow) event (module and manager) would give off-chain reconciliation and monitoring the exact signal the ActionLogger lacks for value=0 flows, and would make direct-c
  * OPPORTUNITY: Align the module with ERC-7739 nested-EIP-712 smart-account signatures as a follow-on: the account-bound domain plumbing already exists, and 7739 support is becoming a listing requirement for wallet-integrated verifiers 
  * OPPORTUNITY: Consider surfacing getNonce-style concurrency guidance (sequential nonces mean two in-flight requests from one key collide): a tiny SDK helper reserving nonces would remove a realistic operational foot-gun as fleets scal

########## AGENT a5dea39d29 | findings=16 strengths=8 opps=6

[High] (0.5h) CI Slither gate can never run: pinned slither-analyzer==6.2.4 does not exist on PyPI
  area: CI pipeline
  desc: .github/workflows/ci.yml:52 runs `pip install slither-analyzer==6.2.4`. Verified against PyPI: available versions top out at 0.11.6; pip errors with "No matching distribution found for slither-analyzer==6.2.4". The `--fail-high` flag itself is correct syntax (confirmed against a local slither 0.11.6 --help). Net effect: the job named 'Slither static analysis (PR gate)' red-screens at the install step on every run, so either CI is ignored/red permanently and high-severity regressions ship unflagg
  fix : Pin slither-analyzer==0.11.6 (or `>=0.11,<0.12`), add a `slither --version` log step, and add a weekly `pip install --upgrade` canary job so a future major bump (which likely renamed behavior) is caught deliberately rather than by red X.

[High] (6h) Public, state-mutating validateUserOp with no op-hash dedup lets any third party exhaust a session key's window from a mempool-observed op
  area: ERC-7579 module testing
  desc: `validateUserOp` (contracts/src/SessionKey7579Module.sol:180-218) is external, has no msg.sender restriction, and mutates window state via `_enforceSingle` -> `SpendPolicy.enforce` (:232-234) with no userOpHash/keccak(op) dedup. Signed userOps are broadcast publicly (relayers, bundlers), so anyone holding one observed op can call the module directly N times, charging the rolling window N times, bricking the agent's key until window rollover without ever executing anything. Proven with a temporar
  fix : Pick one mitigation and pin it with tests: (a) dedupe on keccak(abi.encode(userOp)) storing consumed hashes until the key's nonce advances; (b) charge the window lazily via an execution hook instead of at validation; or (c) accept and document the DoS bound, adding tests that quantify it. Also add a test asserting the exact SECURITY.md 'validated-but-dropped' accounting semantics.

[High] (3h) Both nightly CI jobs are dead code: no schedule trigger exists, and the Echidna condition can never be true even with one
  area: CI pipeline
  desc: The `on:` block (ci.yml:3-7) contains only push(main)/pull_request/workflow_dispatch — there is no `schedule:` key (verified by grep). [CORRECTED 2026-10-16 — STALE ASSERTION: the current .github/workflows/ci.yml DOES define `schedule:`, with three cron entries (nightly 03:17 UTC, weekly Monday 04:23 UTC, monthly 1st 04:43 UTC) at ci.yml:7-13, and both echidna-nightly and forge-fork-base now gate on `github.event.schedule` matching those cron strings, so they are reachable. Everything after this point describes the 2026-08-24 state only.] Therefore `echidna-nightly` (`if: github.event.schedule == 'nightly'`, :73) and `forge-fork-base` (`if: github.event_name == 'schedule'`, :83) can never run. The echidna condition is doubly broken: for schedule events GitHub sets `github.event.schedule` to the cron expression string (e.g. '17 3 * * *'), never the literal 'nightly'. Even if triggered, forge-fork-b
  fix : Add `schedule: [{cron: '17 3 * * *'}]`; change echidna's condition to `github.event_name == 'schedule'`; write at least one contracts/test/*Fork.t.sol (e.g. deploy on a Base fork, exercise DOMAIN_SEPARATOR chainId binding) or delete the job; guard `${{ secrets.RPC_BASE != '' }}`; implement a real echidna.yaml + properties contract porting the invariant ghost bookkeeping.

[High] (0.5h) Pushes to the repo's only/default branch (master) trigger no CI, and no remote exists — none of these workflows have ever run
  area: CI pipeline
  desc: ci.yml:5 triggers pushes only on `branches: [main]` [CORRECTED 2026-10-16 — STALE ASSERTION: the current ci.yml:5 uses `branches: [main, master]`, so pushes to master do now trigger CI; and a remote IS configured (`github.com/dev25bansal-ops/sigilkit`), unlike the 2026-08-24 state described here.], but the repository's only branch is master (git branch -a -> '* master'; recent commits live there) and there is no main branch. There is also no git remote configured (git remote -v is empty), so no workflow has ever executed anywhere. Every 'PR gate' framing in ci.yml comments, README.md:48 ('8-layer CI'), and whitepaper ('8-job CI', docs/WHITEPAPER-v2.1.md:65) describes infrastructure that has never processed a single commit — which is pres
  fix : Create/rename to main (or change the filter to master + add branch protection), add the GitHub remote, push, and iterate until the first fully-green run including fixed slither/halmos jobs. Treat 'first green CI run' as the actual definition of v0.1.0 verification status.

[Medium] (3h) validateUserOp succeeds for UNINSTALLED accounts with leftover non-revoked scopes — untested lifecycle path contradicts module-removal expectations
  area: ERC-7579 module lifecycle testing
  desc: `onUninstall` deletes only `initialized[msg.sender]` and deliberately retains scopes/windows (contracts/src/SessionKey7579Module.sol:127-132, comment: 'revoke gates them'). But `validateUserOp` (:184-192) never calls `_requireInitialized` — it reads `scopes[account][signer]` directly. If an account uninstalls without first revoking each key, those keys keep authorizing userOps through the entrypoint until expiry, contradicting the 7579 expectation that uninstall neutralizes a module. Proven with
  fix : Decide the semantics and pin it: either add `if (!_m().initialized[account]) revert NotInitialized();` to validateUserOp (recommended, one line), or auto-revoke all keys in onUninstall, or document the footgun in SECURITY.md and add a test asserting current behavior so a future refactor cannot flip it silently.

[Medium] (8h) Invariant suite never fuzzes admin state transitions: grant/rotate/transferOwnership/setSelectorDenied are unreachable by construction, and time-based branches 
  area: Solidity invariant/fuzz testing
  desc: With excludeContract(skm)+targetContract(address(this)) (SessionKeyManager.invariant.t.sol:46-48), the fuzzer can only reach executeRandom/revokeRandom (confirmed by the run's selector statistics: only those two selectors). Consequently never fuzz-covered: (1) grantSessionKey post-setUp including all InvalidScope revert branches (SessionKeyManager.sol:190-196); (2) rotateSessionKey entirely — both the shorten-overlap branch (:184) and the revoke branch when overlapEnds<=now (:180-182); OverlapBe
  fix : Keep excludeContract(skm) but add owner-pranked handler wrappers (like revokeRandom already is) for grantRandom (random valid+invalid scopes), rotateRandom (overlapEnds straddling block.timestamp), transferOwnershipRandom, and toggleDenylistRandom; add a warpRandom handler stepping past expiresAt and windowSeconds so expiry and rollover branches execute statefully. Extend invariant_scopesImmutable

[Medium] (1h) INV-3 'iff' is only half-tested: no negative test proves absence of ActionLogged on failed inner call, and the invariant suite claims an INV-3 function that doe
  area: Audit-trail (INV-3) testing
  desc: README.md:95 states ActionLogged is emitted 'iff the inner call succeeded'. Tests assert only the positive direction: vm.expectEmit + successful execute (SessionKeyManager.t.sol:175-181) and client.assertAuditEmitted on a successful relay (conformance.test.ts:259-260). No test anywhere asserts the ABSENCE of ActionLogged when the inner call reverts (InnerCallFailed at SessionKeyManager.sol:261) or on any earlier revert. Compounding this, the invariant suite docstring claims to enforce 'INV-3 aud
  fix : Add a unit test: vm.recordLogs -> force inner-call revert (target that reverts) -> assert zero logs from skm; symmetric positive control. Add invariant_actionLogCountEqualsSuccessCount() using a counting target + ghost successes map (already tracked) compared against a vm.getRecordedLogs-derived count or an emitted-counter wrapper around ActionLogger.

[Medium] (16h) Halmos coverage stops at SpendPolicy math + 1-level Merkle: neither executeWithSessionKey nor validateUserOp is symbolically specified, while docs claim formal 
  area: Symbolic verification (Halmos)
  desc: Halmos.t.sol contains 6 check_ functions: 4 over SpendPolicyHarness.enforce and 2 over MerkleWhitelist.verify (empty-proof identity, single-level completeness). Nothing symbolically exercises executeWithSessionKey (signature gating, replay/nonces, expiry ordering, denylist gating, audit emission) or validateUserOp (proof-tail parsing, batch aggregation, domain binding). Yet README.md:20 markets Component 4 as 'Implemented + formally verified' and vault/Agent Architecture.md:71 promises Halmos pr
  fix : Implement specs (1)-(3) first — they need only the recover-seam harness and no new tooling; add (4)-(5) next. Retitle README's claim to 'spend-policy core formally verified' until the execution-path specs land.

[Medium] (3h) Multi-level Merkle proofs are never tested end-to-end anywhere: max depth exercised against contracts is 1 element, and the SDK's multi-level proof builder (odd
  area: Merkle whitelist testing
  desc: Largest proof used against any contract: ONE element (SessionKeyManager.t.sol:306-333, two-leaf tree; empty-proof case elsewhere). The module whitelist test uses a single-leaf root with EMPTY proof (SessionKey7579Module.t.sol:340-359). Halmos covers depth-1 symbolically only. Meanwhile packages/core/src/signing.ts implements full multi-level merkleRoot()/merkleProof() (:106-158) with odd-level node-promotion logic (unpaired nodes promoted WITHOUT hashing, corresponding proof element omitted) — a
  fix : Add a TS property test (or plain loop over sizes 1..32) asserting for every leaf: SDK merkleProof(leaves,leaf) satisfies a local reimplementation of MerkleWhitelist.verify, plus a Foundry unit test granting a 4-leaf scope and executing with a 2-element proof (and rejecting a tampered one). Cheap and closes the largest untested correctness surface in the whitelist feature.

[Medium] (12h) No entrypoint.handleOps end-to-end simulation for the 7579 module: MockAccount never executes tuples, and account-side calldata decoding is never proven consist
  area: ERC-7579 module testing
  desc: All 17 module tests construct PackedUserOperation structs by hand and call module.validateUserOp directly (e.g. SessionKey7579Module.t.sol:204, 216, 233). MockAccount (t.sol:9-25) only installs/uninstalls — it never decodes or executes the ExecTuple payloads the module validates, and no EntryPoint v0.7 is deployed. Unverified: (a) the ERC-7579 callData convention the module parses (callType byte at offset 0, payload at [32:], t.sol helper :64-81) is the SAME layout a real account's execute() con
  fix : Add contracts/test/ModuleHandleOps.e2e.t.sol deploying solady/eth-infrastructureEntryPoint v0.7 (vendored), a minimal 7579 account whose execute(mode,tuple(s)) decodes exactly the module's convention, and a simple bundler: fund beneficiary, sign op with the module's digest format, assert target received value and window charged once. This doubles as the integration proof for Kernel/Safe{Core} adop

[Medium] (2h) EIP-7702 RLP encoder is pinned to a single externally-derived vector; multi-byte RLP paths are tested only as 'does not throw and is deterministic', not for cor
  area: EIP-7702 library testing
  desc: eip7702.test.ts:25-36 checks exactly one cast-computed vector (chainId 31337, nonce 0 — both single-byte RLP scalars). The large-values test (:47-56) asserts only that authorizationDigest returns a 64-hex-char string, is deterministic, and accepts bigint/number interchange — it never compares a multi-byte-length preimage against an externally computed digest. rlpEncodeScalar/rlpEncodeList (src/eip7702.ts:48-74) implement minimal big-endian encoding, length-prefix thresholds (0x80 single-byte, 56
  fix : Generate 5-10 golden vectors with `cast keccak` (nonce 0, 127, 128, 2^16-1; chainId 1, 127, 128, 11155111; one long-address-list case) and assert exact digests. Optionally cross-check signAuthorization tuples against anvil's eth_sendTransaction authorizationList echo on a type-4 tx (anvil supports 7702).

[Medium] (4h) No coverage measurement or thresholds on either side: no forge coverage step/profile, no vitest coverage provider/config/script
  area: Coverage infrastructure
  desc: grep for 'coverage|cov' across foundry.toml, vitest.config.ts, and ci.yml returns nothing. foundry.toml has fuzz profiles only ([profile.default.fuzz], [profile.ci.fuzz]); vitest.config.ts sets only fileParallelism; @vitest/coverage-v8 is absent from packages/core/package.json devDeps. This is why the gaps enumerated above (transferOwnership, OverlapBeyondOldExpiry, _parseTrailingProof InvalidSignature tails at SessionKey7579Module.sol:281-283 — no test feeds a malformed proof tail, un-deny path
  fix : Add `forge coverage --report lcov` step with a threshold check (start ~85% lines / 75% branches given known gaps, ratchet up as findings close); add @vitest/coverage-v8 with thresholds in vitest.config.ts and a `test:coverage` script; publish summaries as CI artifacts.

[Medium] (2h) Demo-agent package is invisible to CI: never built, linted, typechecked, or smoke-run
  area: CI pipeline
  desc: ci.yml references only @sigilkit/core (lines 67-68). @sigilkit/demo-agent has build and lint scripts (packages/demo-agent/package.json) that no job invokes, and the flagship quickstart `npm run demo` (README.md:53-63: deploy -> grant -> scoped sign -> enforce -> ActionLogged) is never executed anywhere. A type break in agent.ts/cli.ts or a drift between the demo's ABI usage and core exports would ship unreleased-quality code in a repo whose selling point is reliability.
  fix : Extend the ts-sdk job (or add a job) with `npm run build --workspace @sigilkit/demo-agent && npm run lint --workspace @sigilkit/demo-agent`; add a lightweight smoke test that spawns anvil, runs the CLI headlessly, and greps for the two expected ActionLogged receipts (reuse conformance.test.ts's spawn/waitForRpc pattern).

[Low] (1h) README verification-status numbers contradict each other and reality (34 vs 38 vs '21 Foundry tests'; '8-layer/8-job CI' vs 7 jobs, 2 dead)
  area: Docs consistency
  desc: Three mutually inconsistent counts in one file: ':28 ✅ 34 tests (17 manager + 17 ERC-7579)' (unit-only count), ':69 34 unit + 4 invariant suites, 38 total' (matches reality — verified by running: 38 passed), ':105 ✅ 21 Foundry tests (unit + stateful invariant, 128k fuzz calls each...)'. The 21 figure matches no configuration; '128k fuzz calls each' mischaracterizes 256 invariant runs x 500 depth aggregated across the whole suite. Line 48 calls ci.yml '8-layer CI'; the file defines 7 jobs, of whi
  fix : Regenerate the verification-status table from a script (parse `forge test` summary + ci.yml jobs) or hand-fix to: 38 tests, 4 invariants, 7 jobs (5 active). Delete the stale 'Audit & verification status' bullet list or reconcile it with the table at :24-33.

[Low] (0.5h) ts-sdk job uses npm install --workspaces instead of npm ci — works today but fragile
  area: CI pipeline
  desc: ci.yml:66 runs `npm install --workspaces`, which (a) intentionally skips root devDependencies (root typescript@^7.0.2 — currently unused by CI steps since each workspace carries its own typescript, so nothing breaks today), and (b) can rewrite package-lock.json on CI runners, producing noisy diffs and nondeterministic dependency resolution versus the committed lockfile. Verified workable as-is (all scripts used by CI resolve to workspace-local deps), hence Low.
  fix : Replace with `npm ci` (installs lockfile-exact across all workspaces including root). One-line change.

[Low] (1h) Conformance test 'digest matches on-chain DOMAIN_SEPARATOR-based recovery' asserts nothing about recovery (vacuously passes)
  area: TS SDK testing
  desc: conformance.test.ts:102-136 computes actionRequestDigest, signs it, then calls publicClient.verifyMessage (personal_sign semantics, which CANNOT verify this digest), catches the inevitable failure to null, and finally asserts `expect(recovered === null || typeof recovered === 'boolean').toBe(true)` — true for every possible outcome. The test name suggests digest compatibility is proven here; it actually only checks hex shape and 65-byte length. Genuine cross-language proof happens later (SDK-sig
  fix : Replace with viem's verifyTypedData or a deployed echo contract calling ecrecover(digest, sig) and returning the signer; assert equality with agent.address. Or rename/relocate the structural checks into the signing unit describe block so no reader credits it as cryptographic verification.
  + STRENGTH: All 38 Foundry tests pass locally (34 unit + 4 invariant functions, verified by running `forge test`), and the unit matrix is thorough for the enforcement surface: expiry, revocati
  + STRENGTH: The invariant harness uses genuine ghost-variable modeling (expectedWindowSpend, successesAtRevoke, everRevoked in SessionKeyManager.invariant.t.sol:32-35) computing outcomes indep
  + STRENGTH: Genuine differential testing for EIP-712 digests: three independent encoders (viem hashTypedData, ethers TypedDataEncoder, and a hand-rolled reference in reference.test.ts) must ag
  + STRENGTH: The TS<->on-chain E2E conformance test is real end-to-end verification: spawns Anvil, deploys via forge script, grants a scope, relays an SDK-signed request, asserts receipt status
  + STRENGTH: The EIP-7702 digest fixture is externally derived via `cast keccak` on the hand-built RLP preimage (eip7702.test.ts:22-36), explicitly avoiding self-confirming encoder tests, and d
  + STRENGTH: Honest, specific security self-assessment: SECURITY.md triages all 13 slither findings with per-item rationale, documents the nested-transfer blind spot with mitigations, and corre
  + STRENGTH: CI structure shows correct instincts even where broken: separated invariant job with elevated runs (--invariant-runs 256), Halmos release-gated to main/dispatch, concurrency cancel
  + STRENGTH: The WALLET_BEHAVIOR_ALLOWLIST pattern (pin wallet behaviors like MetaMask's raw-revoke rejection, fail CI on silent flips) is a differentiated conformance idea carried into code, w
  * OPPORTUNITY: Differential fuzzing upgrade: reference.test.ts already contains a hand-rolled third EIP-712 encoder — wrap it with fast-check property tests generating random ActionRequest fields (boundary uint48 expiries, empty/full b
  * OPPORTUNITY: Marketing-aligned verification: closing finding F7 (recover-seam harness + replay/denylist/expiry specs) converts README's 'Implemented + formally verified' from overstatement to fact, and gives the launch announcement a
  * OPPORTUNITY: Port the invariant ghost bookkeeping (expectedWindowSpend/successes maps) into an Echidna properties contract once the nightly cron is fixed — two independent fuzzers on the same invariants is a strong audit-readiness si
  * OPPORTUNITY: handleOps E2E (finding F9) doubles as the integration showcase for Kernel/Safe{Core} teams evaluating the module — publish it as an example, not just a test.
  * OPPORTUNITY: Coverage badges + nightly job results embedded in README's verification-status table would make the table self-updating and prevent the count-drift seen in finding F13.
  * OPPORTUNITY: Golden-vector corpus directory (vectors/eip7702.json, vectors/actionrequest.json) shared by Solidity tests, TS tests, and docs makes future cross-language changes (e.g. adding a field to ActionRequest) a one-place update

########## AGENT aae74d4054 | findings=13 strengths=7 opps=7

[High] (2h) EIP-7702 digest is wrong for leading-zero-byte delegation addresses and for every revocation (ZERO_ADDRESS)
  area: packages/core/src/eip7702.ts
  desc: rlpEncodeScalar (eip7702.ts:48-56) encodes minimal big-endian bytes, and authorizationDigest (eip7702.ts:89) feeds it hexToBigInt(address). Canonical implementations encode the address field as exactly 20 bytes: viem's hashAuthorization (node_modules/viem/_esm/utils/authorization/hashAuthorization.js:14-18) passes the raw address string to toRlp, and go-ethereum RLP-encodes common.Address as a fixed [20]byte array. Divergence occurs whenever the address's first byte is 0x00 (~1/256 of random add
  fix : Add an rlpEncodeAddress that pads to 20 bytes (pad(address,{size:20}) then prefix 0x94 since len=20 -> 0x80+20) and use it in authorizationDigest for the address slot only; keep scalar encoding for chainId/nonce. Add tests that assert authorizationDigest equals viem's hashAuthorization for ZERO_ADDRESS, 0x0000…abcd, and fuzzed random addresses, plus a recoverAuthorizationAddress round-trip test fo

[Medium] (0.5h) Demo strategy derives nonce from state.actionsExecuted — one mined-but-failed tick permanently wedges all future actions
  area: packages/demo-agent/src
  desc: cli.ts:88 sets `nonce: BigInt(state.actionsExecuted)` in the strategy instead of omitting nonce and letting SigilKitClient.prepareExecution fetch getNonce (client.ts:120-127). agent.ts increments actionsExecuted only after BOTH receipt.status==='success' (agent.ts:115) and assertAuditEmitted (agent.ts:118-119). If sendTransaction throws after broadcast, or the tx mines successfully but assertAuditEmitted throws/wait times out (viem waitForTransactionReceipt default timeout), the on-chain nonce I
  fix : Drop the explicit `nonce:` from the strategy return so prepareExecution fetches getNonce itself (the SDK already supports this); or increment a separate 'noncesIssued' counter at strategy-fire time rather than at confirmed-execution time. Also document in agent.ts why the distinction matters — this file is the copy-paste template for integrators.

[Medium] (1h) Local zero-gas policy check skips the scope hard expiry (and merkle membership), so expired keys still pay gas to revert
  area: packages/core/src/signing.ts + client.ts
  desc: validateAgainstScope (signing.ts:170-197) checks per-action cap, per-window cap, and request.expiry — but never compares scope.expiresAt against Date.now(). The contract enforces `block.timestamp > scope.expiresAt -> KeyExpired` (SessionKeyManager.sol:233). Merkle-whitelist membership is also not checked locally even when a merkleProof is supplied, so a bad proof still costs a mined revert despite the whitepaper's zero-gas-rejection claim (signing.ts:167-169 docstring says it 'mirrors SpendPolic
  fix : Add `if (now >= scope.expiresAt) return {ok:false, reason:'scope hard-expired'}` to validateAgainstScope (requires widening its args to take the full Scope), and add a local root check in prepareExecution when scope.merkleRoot !== 0 using the existing targetLeaf/merkleProof helpers.

[Medium] (2h) Client/demo error paths blur failure modes: revert vs missing-audit indistinguishable, reverted grants reported as granted, swallowed RPC errors, no chainId san
  area: packages/core/src/client.ts + packages/demo-agent/src
  desc: (a) assertAuditEmitted (client.ts:177-184) returns false both when the tx reverted and when a successful tx somehow lacks ActionLogged — callers can't distinguish 'execution failed' from 'INV-3 violated'. (b) TreasuryAgent.grantScope (agent.ts:66-79) returns just the hash; cli.ts:98 waits for the receipt WITHOUT checking status, so a reverted grant prints 'granted' and proceeds to run ticks that all fail. (c) The getWindowState read failure is swallowed wholesale (client.ts:144-146), silently di
  fix : Make assertAuditEmitted throw (or return a discriminated union) on receipt.status!=='success' with the revert reason if available; check status after waitForTransactionReceipt in cli.ts:98; validate chain id lazily in the constructor (getChainId vs chain.id, cached); log-or-warn when getWindowState is unavailable; document shared-key nonce behavior on prepareExecution.

[Medium] (1.5h) number/bigint type fiction across JSON boundaries: deserialized ActionRequest crashes validateAgainstScope with opaque TypeError
  area: packages/core/src/signing.ts + types.ts
  desc: ActionRequest.value/nonce are typed bigint (types.ts:32-33) with no runtime validation anywhere before use. JSON.stringify throws on bigint and JSON.parse yields numbers, so persisting/reloading a request (a realistic fleet workflow) silently violates the type. The mixed comparisons behave inconsistently: signing.ts:178 (`request.value > scope.perActionCap`) works between number and bigint, but signing.ts:190 (`base + request.value`) throws TypeError 'Cannot mix BigInt and other types'. Verified
  fix : Export a parseActionRequest(raw: unknown): ActionRequest normalizer (coerce value/nonce via BigInt(), validate hex sizes for agentId/selector/rationaleHash/data, normalize checksummed address) and call it at the top of prepareExecution/actionRequestDigest. Also document the JSON caveat on ActionRequest.

[Low] (1h) conformance.test.ts first test is placeholder theater mislabeled as on-chain digest recovery
  area: packages/core/test/conformance.test.ts
  desc: The test named 'digest matches on-chain DOMAIN_SEPARATOR-based recovery' calls publicClient.verifyMessage (personal_sign scheme — wrong for an EIP-712 digest), .catch(() => null) discards everything, then asserts only sig.length===132 and a hex regex (conformance.test.ts:126-135). Its own comment admits 'verifyMessage uses personal_sign; instead assert structural validity + length'. The suite name promises TS↔Solidity conformance; real on-chain coverage exists only in the separate full-E2E test 
  fix : Replace with a staticcall to a contract helper that recovers the EIP-712 signer (or reuse the existing E2E which already proves acceptance), or delete lines 102-136 and rely on the E2E. Cheap alternative: assert digest equality against the contract's DOMAIN_SEPARATOR via a hand-rolled expectation like reference.test.ts does off-chain.

[Low] (0.25h) CI never builds, lints, or tests @sigilkit/demo-agent
  area: .github/workflows/ci.yml
  desc: ci.yml job ts-sdk runs only `npm run lint --workspace @sigilkit/core` and `npm test --workspace @sigilkit/core` (ci.yml:67-68). Nothing runs tsc --noEmit or build for @sigilkit/demo-agent, even though the package ships compiled entry points (dist/) and its own lint script exists and passes today.
  fix : Add `npm run lint --workspace @sigilkit/demo-agent` and `npm run build --workspaces` (which compiles both) to the ts-sdk job; optionally gate releases on npm pack --dry-run succeeding.

[Low] (0.25h) Mojibake in @sigilkit/demo-agent package.json description (broken UTF-8 arrow)
  area: packages/demo-agent/package.json
  desc: Line 4 contains â†’ sequences — the UTF-8 bytes of '→' (E2 86 92) were decoded as CP1252 and re-escaped. Verified via node -e require(): description.includes('â') === true, includes('→') === false.
  fix : Rewrite the description with ASCII arrows ('->') to make the file encoding-proof, or write real UTF-8 arrows ensuring the editor saves UTF-8. Scan other manifests for the same artifact (core/package.json is clean).

[Low] (0.25h) cli.ts docstring misstates demo economics 10x and hardcoded Anvil keys carry no warning
  area: packages/demo-agent/src/cli.ts + README.md
  desc: cli.ts:6-7 says '0.05 ETH/action, 0.1 ETH/window' and 'a 0.04 ETH rebalance poke', but the code sets perActionCap 10^16 (0.01 ETH), perWindowCap 5e16 (0.05 ETH) at cli.ts:77-78 and value 4e15 (0.004 ETH) at cli.ts:87 — README.md:55-58 states the correct numbers, so header and reality disagree by 10x. Keys at cli.ts:23-24 are the standard Anvil #0/#1 dev keys with no comment or README warning that they must never touch a funded chain.
  fix : Fix the header comment to 0.01/0.05 ETH and 0.004 ETH; add a loud comment above OWNER_KEY/AGENT_KEY ('well-known Anvil keys — DEMO ONLY') and one line in the README demo section.

[Low] (0.5h) actionRequestDigest accepts odd-length hex data and silently left-pads nibbles instead of rejecting
  area: packages/core/src/signing.ts
  desc: Verified traces: uppercase '0xABCD' and lowercase produce identical digests (no drift); missing-prefix 'abcd' normalizes correctly; '' and '0x' both yield the empty-bytes digest matching abi.encode(bytes). But '0x123' passes the strict:false isHex guard (returns true — verified) and viem's typed-data encoder LEFT-pads nibbles: digest('0x123') === digest('0x0123'), not digest('0x1230'). The intended custom error at signing.ts:36-37 is unreachable for odd-length input because isHex(data) uses the 
  fix : Tighten to isHex(request.data, {strict:true}) after prefix normalization so odd-length input hits the descriptive throw at signing.ts:37; drop the redundant startsWith('0x') clause (isHex already requires the prefix).

[Low] (0.25h) DelegationStatus.revoked is unreachable through live protocol behavior — API suggests a state the EVM never exposes
  area: packages/core/src/eip7702.ts
  desc: Per EIP-7702, an authorization with address=0x0 clears the account's code entirely, so a genuinely revoked EOA returns getCode()==='0x' and validateAuthorization (eip7702.ts:176-179) reports {delegated:false, revoked:false}. The branch at eip7702.ts:187 (implementation === ZERO_ADDRESS) requires code literally equal to 0xef0100||0x00*20, which the protocol never sets in production — the test achieves it only via anvil_setCode (eip7702.test.ts:121-125).
  fix : Keep the branch (harmless, matches raw designator semantics) but document that mainnet revocations surface as delegated:false, and consider renaming to `explicitZeroDesignator` or adding a JSDoc example of the expected lifecycle.

[Low] (0.1h) Dead code: private toTuple() in client.ts defined but never called
  area: packages/core/src/client.ts
  desc: toTuple (client.ts:193-213) has zero call sites — encodeFunctionData at client.ts:161-165 consumes the request object directly via the ABI's named components. Verified by grep: single occurrence repo-wide.
  fix : Delete it, or export it and actually route encodeFunctionData through it if the tuple form is meant to be load-bearing for consumers on older bundlers.

[Low] (0.1h) .gitignore omits dist/ while built dist directories exist on disk
  area: repo hygiene / packaging
  desc: .gitignore covers out/, cache/, broadcast/ (Foundry) but has no dist/ entry. Both workspace packages currently have dist/ on disk (built), untracked only by accident.
  fix : Add `dist/` to .gitignore and `git rm -r --cached` if it ever gets committed; consider a prepublishOnly build script so published dist is guaranteed fresh.
  + STRENGTH: Genuinely strong digest conformance discipline: three independent encoders must agree byte-for-byte — viem↔ethers parity (parity.test.ts:64-118), a hand-rolled EIP-712 encoder writ
  + STRENGTH: The full-stack E2E is real, not staged: owner grants scope on-chain, SDK prepares+signs, relayer submits, receipt asserted, ActionLogged verified, and CounterTarget state asserted 
  + STRENGTH: Pre-signature local policy validation with a clean result-type ({ok}|{ok:false,reason}) and actionable messages like 'per-action cap exceeded (X > Y)' (signing.ts:170-197, client.t
  + STRENGTH: validateAuthorization is defensively designed: refuses to interpret any code that isn't exactly 0xef0100||20-byte-address (eip7702.ts:180-182), which EIP-3541 makes impossible for 
  + STRENGTH: Thoughtful Windows-aware test infrastructure: absolute foundry binary resolution with env overrides (anvil.ts:8-9, conformance.test.ts:23-24) and vitest fileParallelism:false with 
  + STRENGTH: Publish hygiene is mostly right: proper exports maps, files field limiting to dist+README, tsconfig.build.json excluding tests from declarations, private flags correctly placed on 
  + STRENGTH: ACTION_LOGGED_TOPIC in client.ts:188-190 exactly matches the 3-indexed-param ActionLogged event in ActionLogger.sol:11-18 (topics.length===4 check is correct), and the topic consta
  * OPPORTUNITY: Fix rlpEncodeAddress, then market it honestly: add a property/fuzz test asserting authorizationDigest === viem hashAuthorization across thousands of random + adversarial addresses including 0x0, and a signRevocation->rec
  * OPPORTUNITY: Ship a parseActionRequest / serializeRequest pair (bigint-safe JSON codec) — fleet integrations persisting signed requests is the obvious first integration path, and right now the type system lies to them at exactly that
  * OPPORTUNITY: Add optional nonce reservation semantics to SigilKitClient (reserveNonce(key): Promise<{nonce, release}>) or a documented retry-on-nonce-replay wrapper — unlocks the shared-key fleet story the JSDoc already advertises.
  * OPPORTUNITY: Complete the zero-gas story end to end (scope expiry + local merkle verification + optional eth_call simulation fallback) and put a comparison table in the README: checked locally vs enforced on-chain. This is the differ
  * OPPORTUNITY: CI: one small job for demo-agent lint+build and an npm pack --dry-run gate makes the publish story trustworthy before v0.2; also fix the push trigger (branches:[main] while development happens on master) so CI actually r
  * OPPORTUNITY: Consider delegating 7702 signing to viem's native wallet signAuthorization where a wallet is available and keeping the hand-rolled path only for raw HashSigner integrators — with the canonical-digest test pinning equival
  * OPPORTUNITY: Leverage the existing three-encoder conformance pattern (viem/ethers/hand-rolled): the same table-driven harness generalizes to the 7702 module and to Merkle roots vs the Solidity verifier, giving one matrix screenshot f
