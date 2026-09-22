# SigilKit: consolidated project review

> **Final status addendum — September 17, 2026.** This addendum supersedes any older execution-status statements below: the latest explicitly pinned Node/npm verification passed **7/7** (115 contract tests; 262 TypeScript tests passed, 1 skipped). Indexer 20/20 and logger 25/25 ran successfully. The four report-I/O tests are now persisted and the doc-guard suite passes 29/29. **F28: verified operational workaround, underlying cause unresolved.** No dependency reinstall or speculative config change was required. Earlier claims that npm invocation necessarily fails, auto-discovery causes the failure, or duplicate installs were conclusively eliminated are not established. Remaining substantive security/reliability and release-integration findings still apply. The separate denied `--with-ts` collection command has not been rerun.
>
> Verified Git Bash command from the project root:
> `PATH="/c/Program Files/nodejs:$PATH" FORGE_BIN="C:/Users/dev25/.foundry/bin/forge.exe" "C:/Program Files/nodejs/node.exe" "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" --prefix "D:/SigilKit" run verify`
>
> This command is local to this Windows installation; it was not added as a portable package script.

## Executive decision

**Latest result (September 17): all 7 verification gates passed with explicitly selected Node 24.12.0 and npm 11.6.2.** Contracts: 115 passed. TypeScript: core 190 passed + 1 skipped, demo-agent 12 passed, indexer 20 passed, MCP 40 passed (262 passed + 1 skipped total). The earlier 6/7 collection failure is historical and its root cause remains unresolved; the latest successful run is not proof that pinning runtime alone caused recovery. **Recommendation: resolve the remaining P1 issues before promoting affected workflows; consider a bounded developer preview, not unrestricted production readiness.** Priorities remain restrictive scope-builder defaults, cross-process lease correctness, release identity, and verification gaps. The strongest product direction is an auditable, standards-oriented agent execution toolkit with demonstrable wallet compatibility—not a claim to have invented session keys or spending limits.

This report covers all six requested categories plus implementation status, evidence corrections, and release sequencing. The accepted allocation was **70 agents / 80 assignments**: 60 review assignments, ten implementation assignments, and ten validation assignments using returning reviewers. This is allocation history from the resumed session, not 80 independently verified agent identities. The on-disk review set contains R01–R60 and V61–V70. Builder evidence has inconsistent locations: B65 and B69 are at the review-folder root; no standalone B70 handoff was located in the file inventory. Runtime work is supported by its script and V70 instead.

**Date provenance:** this continuation's supplied date is September 15, 2026; inherited artifacts use September 17. The requested `PROJECT-REVIEW-2026-09-17.md` filename and existing folder names are retained for continuity. Their timestamps should not be treated as independently validated chronology.

**Scope:** working tree at `D:\SigilKit`, inherited inventory commit `ea51320`, with uncommitted changes. No commit, push, deployment, wallet transaction, namespace change, or destructive cleanup was performed in this continuation. Existing user changes were preserved.

## Evidence rules and corrected baseline

- **Executed now:** an actual command result observed in this continuation.
- **Prior-run evidence:** a result carried by the resumed summary or an existing artifact; not rerun now.
- **Static finding:** source/config inspection identifies a mechanism; deployment impact has not necessarily been reproduced.
- **Proposed:** design or acceptance target, not shipped capability.
- **Blocked:** incomplete verification; never a pass.

| Check | Evidence and conclusion |
|---|---|
| Full local verification | **Latest executed run: all 7 gates passed, exit 0**, with explicit Node 24.12.0/npm 11.6.2 and Node 24 on child PATH. Workflow lint, static container packaging, non-TS doc counts, all workspace typechecks/builds, contracts and TS suites passed. This supersedes the earlier 6/7 result for current execution status, not root-cause analysis. |
| Contract execution | **Executed now: 115 passed, 0 failed, 0 skipped across 11 suites.** Invariants/fork suites excluded by this local gate; their execution is not implied. |
| Patch hygiene | `git diff --check` passed; tracked diff covered 13 files. This is whitespace validation, not behavioral proof. |
| Documentation inventory | Executed now before the blocked TS phase: 115 PR-scope contract tests / 11 suites; 5 excluded tests / 2 suites; 13 CI jobs; 11 Halmos specs; 4 Echidna properties; 4 invariants / 1 suite. `forge test --list` is inventory, not execution of those tests. |
| `--with-ts` | Executed now, exit 1: the environment's bulk-delete guard rejected report preparation at `tsTestCounts`. The stack names `rmSync`; this is **not a demonstrated TypeScript test failure or stale-lock diagnosis**. No retry after that denial. |
| Doc-guard unit suite | Latest Node 24 run: **29 tests, 29 passed, 0 failed**. |
| New report-I/O handling | Four injected-I/O cases are now persisted in `scripts/check-doc-counts.test.mjs`: preparation rejection, read rejection, cleanup rejection and successful collection. They pass without actual filesystem deletion. |
| Runtime diagnostic | Prior artifact/summary: Node 24.12.0 satisfies the project floor; Vitest 5.0.0 resolves consistently by version. Same version does not rule out all module-resolution problems. |
| Package artifact guard | Prior summary: 3 public packages, 23 entry targets, 1 warning for a stale core `dist/src` mirror. This is **not** clean-room installation proof. |
| Deep assurance | Inventory is explicitly static. No current Halmos, Echidna, Slither execution or external audit is established by counting specifications. |
| TypeScript totals | Latest complete run: **core 190 passed + 1 skipped; demo-agent 12 passed; indexer 20 passed; MCP 40 passed**. Total 262 passed + 1 skipped across 27 files. These replace earlier inconsistent counts. The separate `--with-ts` report-collection check remains unverified. |
| Indexer and logger validation | Latest complete run executed all **20 indexer tests**, including V64's two final cases, and all **25 logger tests** successfully. This closes their previous execution-evidence gap, not the residual design findings. |

### Corrections that supersede raw reviewer notes

1. **R17-1:** the new Docker test is untracked and the workflow invocation is also an uncommitted edit. The present committed workflow was not proven broken. This is a **partial-commit hazard**: include both files together.
2. **Benchmark:** `benchmark-node24.json` declares `authoritative:true`, but all three disk repetitions fail read-back validation (target rows 67 versus expected 9, and spend totals also mismatch). **Reject the disk measurements as a valid clean-fixture baseline.** The artifact says its temporary directory pre-existed; contamination is plausible but its exact cause is not proven here. Do not “fix” expectations to accept unexplained rows.
3. **R16 microbenchmark:** 3,790 ms versus 11 ms for 2,000 synthetic SQLite-shaped writes is a *reviewer-reported microbenchmark*, approximately 345×. It is neither a measured speedup of a shipped implementation nor invalidated merely because a different benchmark failed. Retain it only as motivation to investigate batching, not a customer performance claim.
4. **R60:** version skew was a hypothesis, not an established cause. The original collection failure remains unresolved. Stale Vite files are also only a hypothesis.
5. **B63/V64:** source changes may be reasonable without a successful independent execution record. Do not call every builder output “verified.”
6. **Reorg remediation:** earlier R12 advice to simply call `rollbackTo` is superseded. It clears the cursor hash and can affect other managers' rows. Preserve the old database and rebuild into a separate database; do not silently delete or auto-rewind shared state.

## 1. Project analysis and strategic opportunities

### Strengths worth preserving

SigilKit combines EIP-7702 delegation, ERC-7579 integration, scoped session keys, spending controls, SDK ergonomics, MCP access, and an `ActionLogged` audit trail. Reviewers found genuine idempotent event keys, parameterized SQL, read-only write suppression, inclusive RPC-range chunking, and layered tool-input validation. The new documentation guard improves claim accuracy, and the cursor-hash check adds a useful fail-closed boundary.

Those are meaningful building blocks. They are not proof of complete reorg recovery, every token-path accounting guarantee, universal wallet compatibility, or externally audited security.

### Positioning and measurable opportunities

The following are product recommendations and **proposed targets**, not market measurements or achieved KPIs. Competitor observations in R01–R10 reflect earlier research, not fresh web verification in this continuation. Recheck official Rhinestone Smart Sessions and ZeroDev documentation before publishing a comparative claim.

| Opportunity | Concrete action | Proposed success measure | Effort / dependencies |
|---|---|---|---|
| Trustworthy distribution | Decide canonical repository and owned package namespace; align manifests, clone instructions, disclosure URLs and provenance. | All documented installation paths succeed in clean CI; no identity mismatch in packed manifests. | 1–2 days after maintainer ownership decision. |
| Auditable execution as the lead value proposition | Export finalized audit evidence with chain, manager, cursor/hash, scope/version, and rationale-hash verification. | Every exported row reconciles to the declared chain view; missing/unfinalized data explicitly labeled. | 5–10 days after storage correctness work. |
| Wallet-integrator segment | Start with one version-pinned ERC-7579 account adapter and honest compatibility evidence. | One complete install/use/revoke/uninstall integration path per supported account version. | 5–10 days plus account-specific validation. |
| Agent-framework builders | Restrictive scope presets, machine-readable errors, bounded queries, and an offline example. | At least 4 of 5 pilot integrators complete setup without direct maintainer help. | 3–5 days after scope-default fix. |
| Developer onboarding | Persist deployment identity; supply a local fixture/manifest flow and an explicit Node 24 requirement. Do not require users to copy addresses between tools. | Median first local audited action under 15 minutes in a supervised five-user pilot. | 2–4 days; fixture and deployment-manifest design. |
| Proof-scope transparency | Publish a matrix mapping each property to unit/fuzz/invariant/symbolic coverage and actual execution evidence. | Every assurance claim links to a commit-specific artifact; skips never appear green. | 2–4 days plus deep-tool execution. |
| Operations / fleet users | Fix leases, persist checkpoints, show per-chain budgets and staleness. | No duplicate in-flight ownership in the supported coordination model; recovery drill leaves original evidence intact. | 5–10 days; storage and lease design. |

**Build versus integrate:** own the policy/audit semantics, error contracts, and evidence format. Integrate existing wallet/signing systems through narrow versioned adapters rather than rebuilding custody. Delay predictive policy automation until recorded data can be trusted. Do not spend effort on broad branding or feature count before users can install the intended package.

## 2. Issues and required fixes

### Reading the catalog

Severity describes impact; priority describes sequencing: **P1 before affected release/use, P2 next minor, P3 backlog**. No Critical vulnerability is established by this review. Estimates are engineering effort including focused tests, not deadlines or audit quotations. “Patch” means the next bounded release; timelines begin after owner decisions.

Security items are discussed defensively, without exploit payloads or operational attack reproduction. No validated CVSS score is assigned: deployment boundaries, privileges, and user approval requirements are insufficiently established. Reliability or assurance gaps should not receive invented vulnerability scores. Source line numbers below refer to reviewer snapshots and can shift after edits; named functions remain the primary anchors.

### A. Completed or partially implemented changes

| ID / source | Location and original expected-versus-actual behavior | Status / evidence | Severity; priority; effort; dependency; timeline |
|---|---|---|---|
| F01 / R11-F1 | `scripts/verify.mjs`, argument validation: expected unknown selectors to fail; actual typo could select zero checks and return success. | Implemented B61: shared labels and early exit 2. Prior V61 has 9 CLI tests; not rerun here. | High assurance; P1; 4 h; none; implemented. |
| F02 / R11-F2, R30 | `scripts/check-doc-counts.mjs`, count and rewrite logic: expected failed report collection and remaining drift to fail; actual missing reports skipped checks, invariant counts were unused, and rewrite could falsely succeed. | B62 pins invariant claims and rechecks after rewrite; 25 unit tests pass now. This continuation additionally makes I/O errors explicit and stops later workspaces on a blocked operation. Full TS run remains blocked. | High assurance; P1; 1–2 d; toolchain; partial execution verification. |
| F03 / R27 | `packages/core/src/logger.ts`, formatting/emit: expected error context and never-throws; actual text dropped errors and formatting/clock could throw. | Implemented B63, statically reviewed V63. Residuals in F19; no isolated logger run here. | Medium; P2; 4 h; none; implemented, final execution outstanding. |
| F04 / R12, R20 | `packages/indexer/src/indexer.ts`, cursor and resume: expected canonicality checking; actual cursor writes used null hashes and sync only advanced. | B64/V64 now persist/validate hashes and check range-end stability. This is detection/stop, **not automatic recovery**. V64's final tests require execution. | High data integrity; P1; 1–2 d; RPC headers; implemented, partial assurance. |
| F05 / R15-F3 | `packages/core/src/lease-fs.ts`, header example: expected valid API; actual example used `nonceGate` instead of `leaseStore`. | Comment corrected. Lease behavior not fixed by this change. | Low; P2; 0.5 h; none; implemented. |
| F06 / R19, R20 | `docs/DEPLOYMENT.md`, `docs/WHITEPAPER-v2.1.md`: expected deploy and proof claims to reflect reality; actual volume/recovery/spec-status drift. | Volume wording and separate-database recovery corrected; proof status scoped. Count drift and identity remain open. | Medium trust; P2; 2 h; source state; implemented in part. |

### B. Ranked remaining catalog

| ID / source | Problem and precise evidence anchor | Severity / priority | Effort | Dependencies / timeline |
|---|---|---|---|---|
| F07 / R13-1 | `mcp/src/server.ts:138–171`, `build_scope`: missing/empty targets produces zero-root allow-all scope. Existing test treats it as intended. Human grant approval still matters; this is an unsafe default, not demonstrated authorization bypass. | High / P1 | 0.5–1 d | API compatibility and explicit allow-all policy; next patch before promoting builder. |
| F08 / R15, R35 | `core/src/lease-fs.ts`, `release`; `core/src/client.ts`, `NonceGate`: release lacks ownership and TTL is fixed at 30 s without renewal. Mutual exclusion can lapse during slow work. | High reliability / P1 | 2–4 d | Atomic ownership/renewal model and backend contract; before multi-process support claim. |
| F09 / R20-F2 | Indexer DB construction, R20 snapshot: default journal/read-write behavior and no busy timeout undermine simultaneous indexer writer + MCP reader topology. | Medium / P1 | 1–2 d | Choose supported storage topology; next patch. |
| F10 / R16-F1 | `indexer.ts`, `ingestLogs` and cursor writes: per-row commits; rows and cursor are not one transaction. Throughput and crash consistency suffer. | Medium / P1 | 1–2 d | Transaction boundaries and crash semantics; next patch. |
| F11 / R17-1, V62/66/67 | Modified `.github/workflows/ci.yml:48` references untracked test; new guard suites are not routinely gated. Partial commit can break CI; checker tests can regress unnoticed. | Medium / P1 | 2–4 h | Maintainer reviews complete file set; before next push. |
| F12 / R07, R17-2 | Four package `repository.url` fields differ from git origin. Earlier notes also report npm namespace conflict; ownership must be rechecked before release. | High distribution impact / P1 | 1–2 d after decision | Canonical identity and credentials controlled by maintainer; pre-publish. |
| F13 / R58 | `core/test/wallet-e2e/run.ts:184–244`, `coinbase.ts:94–152`: generic rejection accepted as behavior proof; literal-to-identical-literal checks do not test implementation. | High assurance / P1 | 1–3 d initial correction | Version-pinned wallet fixture; before compatibility claims. |
| F14 / R12-3 | `indexer.ts`, address-filtered reads/writes: mixed-case stored addresses compared with raw input using case-sensitive text equality. | Medium / P2 | 0.5–1 d | Migration/backward-compatibility for existing rows; next patch. |
| F15 / R13-2 | `mcp/src/server.ts:199–217`, `audit_query`: caller selects filesystem path, without operator allowlist/canonical confinement. Arbitrary file-open/existence exposure is static evidence; content disclosure is unconfirmed. | Medium boundary concern / P2 | 1 d | Configure permitted DB identities/root; next minor. |
| F16 / R13-3, R16-F3 | MCP transport/queries: no explicit input-byte, concurrent-call or result-size bounds; indexer returns whole result sets and buffers catch-up ranges. | Medium / P2 | 2–3 d | Coordinated query/transport API; next minor. |
| F17 / R16-F2 | `indexer.ts`, query indexes: chain-first indexes poorly serve chain-omitted reads and ordering. Reviewer reports scans/temp sorts; scaling impact is not a production measurement. | Medium / P2 | 1 d | Representative data and query-plan baselines; next minor. |
| F18 / R28 | `core/src/config.ts:35` load order and `indexer/src/cli.ts:106–107`: `.env` wins over `.env.local`; env manager validation differs from CLI flag and handles blank differently. | Medium / P2 | 3–5 h | Explicit documented precedence; next minor. |
| F19 / V63 | `logger.ts`, `conciseError`/JSON retry: newline errors break one-line records; fallback converts valid numbers to strings; function values can render source. Cyclic non-string messages are outside the nominal TS API but still a robustness edge. | Low / P2 | 4–6 h | Stable logging schema; next patch. |
| F20 / R39 | `indexer.ts`, `spendByAgent`; `cli.ts:198–204`: raw native values from multiple chains are summed and labeled ETH without currency or snapshot semantics. | Medium / P2 | 1–2 d | Chain metadata and response versioning; next minor. |
| F21 / R14 | `contracts/test` invariant handlers: INV-3 audit-on-success is not established by the claimed invariant/property coverage; scope-field ghost coverage needs extension. | Medium assurance / P2 | 2–3 d | Written invariant semantics and supported handlers; before stronger proof claims. |
| F22 / R29 | Root `package.json` test shell quoting differs across Windows/Linux; prior reviewer found Windows npm invocation trouble. Direct Foundry execution passing does not validate the npm wrapper. | Medium / P2 | 4–6 h | Cross-platform child-process wrapper; next patch. |
| F23 / R17-3, R29/R59 | Static package/container checks cannot establish image build, clean tarball installation or current-build contents. Mutable Docker base tag adds reproducibility uncertainty. | Medium / P2 | 2–3 d | Docker runner, release-build/install fixtures; before supported container release. |
| F24 / V61, R19 | `CONTRIBUTING.md:35` uses `--only=docs`, which no longer matches `doc counts`; whitepaper TS totals need remeasurement; `CI-WAIVERS.md` remote statement is stale. | Low / P2 | 2–4 h plus TS run | Approved complete count run; next docs patch. |
| F25 / R18, R21/R23/R24 | Version/bootstrap duplication, unchecked row casts, inconsistent CLI JSON failures and prose-only MCP errors increase maintenance cost. | Low / P3 | 2–4 d | Shared error and lifecycle contracts; backlog. |
| F26 / current artifact inspection | `benchmark-node24.json`, `results.disk.reps[*].verified`: six false read-back assertions coexist with `authoritative:true`; invalid fixtures can be published as evidence. | Medium assurance / P1 | 1 d | Fail-closed benchmark validity and isolated fixtures; before any performance claim. |
| F28 / final verification | All four workspace Vitest suites fail collection under the final verification invocation (27 files, zero test bodies). The failure reproduces with the root runner directly (`vitest run --root packages/indexer`). Duplicate-install hypothesis eliminated: all four workspaces resolve to the single root `vitest@5.0.0`, one `vite` copy exists at the root, and no workspace has a local vitest. Timestamped `.vite-temp` staging files persist under workspace `node_modules`. | High assurance / P1 | 0.5–2 d investigation | Trace the runner-context/module-identity mismatch from the staging config path without deleting dependencies or altering evidence; before release. |
| F27 / R12/V64 | `indexer.ts`, stable-end check / `rollbackTo`: no manager-owned row scope, atomic recovery or guaranteed coherent multi-chunk snapshot. Existing helper is not safe automatic recovery. | High if trusted for final audit / P2 | 3–5 d | Schema ownership/versioning, transaction design, recovery specification; next minor before unattended recovery. |

### Expected behavior, safe verification and remedies

These are maintainer acceptance procedures on synthetic local fixtures. They are **not claims that every case was run**. Security-sensitive items specify defensive controls rather than exploitation steps.

| IDs | Expected versus actual; remediation and acceptance |
|---|---|
| F28 | Expected `npm run verify` completes TS collection and execution; actual final run failed all 27 files before bodies. Record resolved Vitest/runner paths in each workspace and actual child Node executable. Fix only after a discriminating diagnosis; no mass dependency deletion or version downgrade based on speculation. Require a complete final rerun with workspace totals to close this issue. |
| F01 | Expected unknown selector exits nonzero; previous actual zero-check success. Use `node scripts/verify.mjs --only=not-a-step` and require exit 2 before work. Keep valid selector cases in CLI tests. |
| F02 | Expected missing/stale/unreadable reports never certify counts; prior actual skipping/crash. Inject denied I/O and failed child results, require a recorded failure and no later workspace work. Add the four new injected cases to persistent tests; rerun full TS only after permission. |
| F03/F19 | Expected one text record with error context, numeric JSON fields retained, no thrown logger error. Use ordinary multiline/cyclic test values with in-memory sinks; sanitize line breaks, serialize only offending fields, avoid rendering function source. |
| F04/F27 | Expected mismatched/absent canonical headers cause no additional writes/cursor advance; old code continued. Synthetic header-provider acceptance tests should assert immutable existing rows, explicit failure, restart behavior and recovery backup preservation. Require per-log/range consistency rules before claiming stronger guarantees. |
| F07 | Expected normal scope-builder success requires explicit restrictive targets. Current omission selects allow-all. Require validation failure by default; allow-all, if retained, must be an explicit owner-visible opt-in. Do not alter contract zero-root semantics casually. |
| F08 | Expected only a valid lease owner may renew/release and stale ownership cannot authorize further work. Current interface does not provide this guarantee. Use a proven atomic backend or redesign the lease interface with tokens, renewal, expiry cancellation and fencing where enforceable. A read-token-then-delete patch alone is not atomic and is insufficient. |
| F09/F10 | Expected supported readers/writers coexist and event rows plus cursor commit together. Validate bounded concurrent readers and process interruption in synthetic databases. Consider WAL plus busy timeout, but test checkpointing/backup and document unsupported network filesystems. Batch bounded chunks, rollback on failure, cache prepared statements. |
| F11/F12 | Expected clean checkout includes all invoked files and identity matches the intended project. Review `git status --short`, `git ls-files scripts/check-dockerfile.test.mjs`, `git show HEAD:.github/workflows/ci.yml`, and `git remote get-url origin`. Commit matched changes only after review; verify namespace ownership before registry actions. |
| F13 | Expected wallet-specific, causally attributable behavior evidence; actual unrelated rejection and tautological checks. Match explicit observed behavior, call real adapter methods against a local fixture, report unavailable environments as skip/gap, fail on missing promised artifacts. |
| F14 | Expected equivalent address representations return identical results; actual case-sensitive mismatch. Normalize at boundaries and migrate or compatibly query legacy rows; test mixed and normalized representations with non-sensitive fixtures. |
| F15/F16 | Expected tools access only operator-authorized databases and bounded resources. Prefer configured DB identifiers over arbitrary paths, sanitize open failures, bound transport bytes before parsing, cap in-flight work and paginate in SQL. Test allowed/denied configuration and just-over-limit fixtures without exhaustion attempts. |
| F17 | Expected common filtered/ordered queries use appropriate indexes. Capture `EXPLAIN QUERY PLAN` on representative fixtures and measure scoped/unscoped p50/p95. Add only justified covering indexes; record write-amplification trade-offs. |
| F18 | Expected explicit real environment > local overrides > defaults, and flag/env validators agree. Define the desired order first, then test duplicate keys, absent/blank values and the shared address validator. Existing order may have consumers: document the behavior change. |
| F20 | Expected values grouped by chain/native asset with independent cursor/finality metadata; actual unlabeled mixed-unit scalar. Return per-chain groups; no cross-chain atomicity/global-budget claim. Test two distinct native-unit fixtures. |
| F21 | Expected every claimed invariant links to an executable property and a passing artifact. Count/spec existence alone is actual present evidence. Add event/ghost assertions and run scoped deep tools; record unsupported token/router paths and assumptions. |
| F22/F23 | Expected documented npm commands, tarball imports and container CLI work in a fresh environment. Add Windows/Linux CI, build then pack, install tarballs outside the monorepo, smoke-test exports/bin and container startup. No publish or install result is inferred from static checks. |
| F24/F25 | Expected documentation commands match real labels and structured errors are consistent. Correct selector example to `--only="doc counts"`; generate or verify counts only from complete runs. Share types/schema incrementally; add CLI snapshot and compile-checked example tests. |
| F26 | Expected correctness checks and fixture isolation determine benchmark validity. Actual `authoritative:true` despite failed assertions. Set valid/authoritative false and exit nonzero on any assertion failure; refuse pre-existing fixtures or allocate isolated fixtures in an approved run. Record runtime/build identity. Never hide unexplained data or bypass cleanup denials. |

## 3. Enhancements and modifications

These are implementation approaches, not additional independently confirmed vulnerabilities. Estimates include targeted tests and documentation.

| Component | Approach | Benefit / acceptance | Trade-off | Effort / sequence |
|---|---|---|---|---|
| Core SDK (R21) | Export named prepared-action/result types; use package ValidationError consistently. | Consumers can narrow errors and compile examples without casts. | Public API compatibility. | 1–2 d after error-contract decision. |
| Indexer (R22) | Transaction per bounded ingestion chunk including cursor; keyset pagination and ordered covering indexes. | Bounded memory, crash consistency, measurable throughput. | More schema/migration and ordering design. | 3–5 d after F09/F10. |
| MCP (R23) | Generate tool schemas from one runtime-validation definition; structured error codes. | No drift between advertised and enforced fields. | Schema/version migration for clients. | 2–3 d after F07/F15/F16. |
| CLIs (R24) | Single JSON envelope for success/failure; diagnostics only on stderr in machine mode. | Every documented `--json` path parses even on failure. | Existing parsers may need migration. | 1–2 d. |
| Contracts (R25) | Extract shared encoding/signature/denylist logic only after behavior equivalence is specified. | Smaller duplication and audit surface. | Gas/bytecode changes and fresh review; avoid refactor alongside urgent fixes. | 3–5 d plus review, next contract version. |
| Tooling (R26/R30) | Shared runtime/Forge resolution; persist all checker regression tests in CI; integrate TS count evidence. | Reproducible behavior across shells. | Longer release checks; keep quick versus full explicit. | 1–2 d. |
| Observability (R27) | Progress, cursor lag, failure counters, lease contention, healthy/stale status, redacted structured errors. | Operator can distinguish idle, blocked and broken states. | Cardinality/privacy controls. | 2–3 d after storage contract. |
| Configuration (R28) | Explicit precedence, shared validators, compile-checked examples and offline doctor. | Setup errors found before RPC/file operations. | Behavior-change communication. | 1–2 d. |
| Distribution (R29) | Build-before-pack, clean tarball import/bin smoke and release manifest. | Test what users actually receive. | Runner/registry-fixture upkeep. | 2–3 d after identity decision. |

## 4. Advanced features

All proposed. Day estimates are planning ranges, not implementation commitments.

| Feature / review | Implementation direction | Value and acceptance | Dependencies / trade-offs / effort |
|---|---|---|---|
| Typed policy compiler / R31 | Deterministic typed policy to existing Scope/Merkle, versioned encoding and explanation. | Round-trip fixtures and human-readable grant summary match encoded constraints. | Restrictive defaults; no unsupported fiat-budget promises without oracle design. 5–10 d. |
| Simulation and dry-run / R32 | Compare prospective execution with policy checks at a declared block. | Show estimated effects, denials and staleness explicitly. | RPC/account support; simulation never guarantees inclusion. 3–5 d. |
| Evidence reconciliation / R33 | Finalized per-chain export with provenance, consistency checks and offline verifier. | Each artifact identifies its chain view and verifies deterministically. | F27, versioned store; no claim that signatures prove completeness. 5–10 d. |
| Graduated autonomy / R34 | Human approval/countersign workflow tied to scope/action identifiers and expiry. | Approval cannot be silently reused for a different action; audit approval outcomes. | Existing countersign semantics and UX; latency. 5–10 d. |
| Durable fleet coordination / R35 | Checkpoint intent/result state; owned leases and recovery states. | Restart resumes or stops explicitly rather than silently duplicating work. | F08 and receipt semantics; distributed complexity. 5–10 d after foundations. |
| Executed assurance manifests / R36 | Extend static inventory with tool version, commit, command, scope, outcome and artifact hash. | Inventory is visibly distinct from execution and audit. | CI integration/retention; signed artifacts need trust model. 3–5 d. |
| Conformance evidence platform / R37 | Versioned wallet matrix with pass/fail/skip/gap, freshness and causal evidence. | No unsupported row green; missing uploads fail promised checks. | F13, account fixtures; maintenance per wallet release. 5–10 d. |
| Private rationale provenance / R38 | Canonical rationale commitment; optional encrypted off-chain storage and reveal verification. | Authorized reveal verifies commitment; sensitive content not logged on-chain. | Key management, retention, dictionary-guessing/privacy analysis; hash is not privacy proof. 3–5 d initial design. ZK is not required by this proposal. |
| Multi-chain audit views / R39 | Per-chain units, budgets, cursor/finality watermarks; optional clearly separate valuation layer. | Never present mixed native units as one enforced global cap. | F20/F27, metadata; no atomic multi-chain snapshot. 3–5 d. |
| Shadow-mode anomaly suggestions / R40 | Read-only rules over verified history; human-reviewed policy proposals. | Suggestions never directly broaden grants or execute actions. | Reliable data, false-positive evaluation, privacy; 5–10 d after evidence layer. |

## 5. New additions

| Addition / review | Architecture-aligned scope | Acceptance / value | Effort / dependency / trade-off |
|---|---|---|---|
| Account install adapters / R41 | Versioned core adapter interface plus one supported ERC-7579 implementation. | Local install/use/uninstall and preflight checks. | 3–5 d; account ABI/version; avoid universal compatibility claim. |
| Monitoring exporter / R42 | Read-only indexer metrics with bounded labels. | Export lag/error/freshness without sensitive payloads. | 2–3 d; metric semantics; operational upkeep. |
| Signer interface / R43 | Abstract signer operations with capability checks; one mock integration first. | No custody credentials in SDK logs/fixtures. | 2–4 d interface; remote signer latency/retry semantics. |
| Audit export / R44 | Streaming JSONL with schema version, chain units and evidence manifest. | Deterministic bounded-memory export; visible partial status. | 3–5 d; pagination/finality; format compatibility. |
| Reference examples / R45 | Local-only countersign and token-path examples. | Run from clean checkout with disposable funded fixtures. | 2–3 d; documented contract assumptions. |
| Restrictive presets / R46 | Explicit target/selector presets and owner-readable warnings. | No normal preset accidentally creates unrestricted scope. | 1–2 d; F07; presets require versioning. |
| Offline doctor / R47 | Runtime, config and artifact checks; online checks opt-in. | Clear status and remediation without reading secrets. | 2–3 d; reuse runtime diagnostic; not a full health guarantee. |
| Migration/backup checker / R48 | Schema version, preflight, backup verification, dry-run planning. | Original DB remains intact on failure; restore drill succeeds. | 3–5 d; manager ownership and SQLite backup semantics. |
| Release manifest / R49 | Package versions, build identity, exported targets, SBOM/provenance links. | Clean installation and manifest correspond to released tarballs. | 2–3 d; owned namespace and release runner. |
| Operator status view / R50 | Read-only scoped spend/cap/freshness view. | Distinguish unknown cap from zero remaining; no signing surface. | 3–5 d; per-chain units and reliable history. |

## 6. Verification and testing strategy

**Tests are gates for specific claims, not a substitute for security review.** Avoid broad “fully verified” language. Suggested owners below are roles, not newly assigned people.

| Layer / owner | Tests and fixtures | Acceptance criteria | Cadence / effort |
|---|---|---|---|
| Unit / component maintainers (R51) | Scope defaults, boundary values, error serialization, config precedence, lease state model, cursor/hash handling, count guard injected I/O. | Intended accepted/denied inputs explicit; no regression-threshold reductions merely to turn CI green. Persist regression tests for every fixed bug. | PR; 2–3 d initial gap closure. |
| Integration / SDK-indexer maintainer (R52) | Fresh owned Anvil fixture: SDK action → receipt/event → indexer → MCP query; isolated DB; shutdown/restart. | Receipt, row and query agree; duplicates do not inflate totals; no dependence on an already-running user node. | PR or dedicated integration gate; 2–4 d. |
| Performance / storage maintainer (R53) | Validity-first bounded synthetic runs, cold/warm distinction, build/runtime identity, insertion versus update mix, query plans. | Every correctness assertion passes before timing is accepted. Report median/p95 and variability. Establish stable baseline before a proposed 20% regression budget; no claimed 345× production improvement. | Scheduled and storage changes; 2–3 d harness repair/baseline. |
| Security assurance / contract reviewer (R54) | Threat-model review, scoped static analysis, property/invariant checks, access-control and replay-denial assertions on local fixtures, dependency/secret scans. | Each finding disposition and invariant maps to commit-specific evidence; assumptions explicit. No live-target exploitation or exposure of keys. | Contract PRs + scheduled deep runs; 3–5 d setup, external review separate. |
| UAT / developer advocate (R55) | Developer installs and first action; operator backup/restart; integrator restrictive scope and machine errors. | At least 4/5 pilot users finish local workflow unassisted; all data-preservation and least-privilege criteria mandatory; record failures, not just completion. | Pre-release; 2–3 d preparation plus sessions. |
| Recovery / storage maintainer (R56) | Canonical header stubs, absent/malformed header, legacy null cursor, checkpoint interruption, separate-database rebuild. | No hidden writes on mismatch; no deletion of other managers' rows; original evidence preserved. Recovery status never falsely claims canonical completeness. | PR + release recovery drill; 2–4 d. |
| Platform / release maintainer (R57) | Windows/Linux under supported Node floor; clean install, npm wrappers, paths with spaces. | All documented commands work in native platform shell; unsupported runtimes fail early. Managed Node 22 here is below this project's floor; Node 24 is required. | PR matrix; 1–2 d setup. |
| Wallet / integration maintainer (R58) | Version-pinned allowlist entries with causal observation, no literal tautologies. | Pass means behavior observed; environment absent is skip; no harness is gap. Every declared run writes an artifact or fails. | Relevant PR + weekly; 2–5 d initial repair. |
| Release / release maintainer (R59) | Build then pack; isolated tarball imports/bin; container build/start; SBOM; identity/ownership check; rollback/withdrawal plan. | No missing exports or wrong package identity; published evidence tied to exact tarballs. Do not publish automatically as part of this review. | Tag/release; 2–3 d setup. |
| Runtime diagnosis / tooling maintainer (R60/V70) | Record executable, dependency resolution paths, runner output and fixture ownership when collection fails. | Avoid attributing cause solely to version coincidence or dirty directories. A complete successful rerun plus discriminating evidence closes diagnosis. | On failure; bounded investigation. |

### Immediate verification follow-up

1. Preserve this continuation's explicit `--with-ts` denial. Do not rerun it through a different path, cleanup method, privilege level or temp location without approval.
2. Persist the four injected-I/O regression checks; the current test file only imports the new helper, while those additional cases were exercised directly in memory.
3. The final `npm run verify` was subsequently executed and returned 6/7: 115 contract tests passed, all workspaces built/typechecked, but 27 TS files failed collection with no test bodies run. Diagnose the runner-context failure (F28) before another release attempt; collect actual module identities and child runtimes rather than guessing version skew. V64 test bodies remain unverified.
4. Only then update whitepaper counts from the authoritative output. Wire the guard suites into CI without masking skipped/blocked checks.
5. Repair benchmark validity before another timed run. Keep historical invalid output as evidence, not as a performance baseline.

## 7. Sequencing, ownership decisions and release criteria

| Phase | Scope | Dependencies / exit criteria |
|---|---|---|
| First 1–2 engineering days | F07 restrictive builder; F11 matched CI/test file set; F24 selector example; F26 benchmark invalidity; persistent I/O tests. | No accidental allow-all defaults or false-green evidence. Source changes require focused regression runs. |
| Following 3–5 engineering days | Lease design/implementation, writer-reader DB behavior, atomic bounded ingestion, final-tree tests. | F08 ownership guarantees documented and tested; data preserved on interrupted sync; clean supported-platform verification. |
| Next minor cycle | Address normalization/migration, query bounds, path authorization, per-chain reporting and recovery design. | Versioned API/schema migration; approved DB root policy; successful operator recovery drill. |
| Product expansion | Audit exports, one wallet adapter, executed assurance artifacts, reference examples. | Correctness/release foundations first; pilot acceptance data guides further expansion. |

Estimates overlap and are not additive sprint commitments. Audit scheduling and account/namespace authorization are external dependencies. Prefer small reviewed changes to implementing every recommendation in a single unverified wave.

**Maintainer decisions needed:** canonical repository and owned npm scope; whether allow-all builder behavior remains an explicit opt-in; supported lease/storage backend and single-manager DB policy; permitted audit DB configuration; supported account/wallet versions; whether contract changes wait for a separately reviewed release.

**Production release criteria:** owned distribution identity, no open P1 in promoted workflows, final-tree green checks with skips explained, coherent audit/recovery semantics, realistic wallet claims, scoped security review and documented residual assumptions. This review does not assert that those criteria are already met.

## 8. Implementation ledger and review coverage

### Delivered in the earlier wave

- `scripts/verify.mjs`: fail-closed selector validation.
- `scripts/check-doc-counts.mjs` and tests: invariant/TS/report/rewrite checking.
- `packages/core/src/logger.ts` and tests: error rendering and never-throws handling.
- `packages/indexer/src/indexer.ts` and tests: cursor hash validation and safe operator guidance; final validator execution unresolved.
- `packages/core/src/lease-fs.ts`: comments only; no ownership fix.
- `docs/DEPLOYMENT.md`, `docs/WHITEPAPER-v2.1.md`: narrowed/deployment claim corrections.
- New script families: package-artifact checks, static assurance inventory, runtime diagnostics and bounded benchmark. These are authored tools, not automatically active CI assurance.

### This continuation

Changed `scripts/check-doc-counts.mjs` to collect reports through injected I/O, return explicit incomplete-verification problems on preparation/read/cleanup failures, stop later workspaces after a blocked operation, and retain nonzero overall status. Updated the test import; 25 existing unit cases and four direct in-memory cases passed. The denied `--with-ts` report-collection command was not retried. A separate final `npm run verify` ran to completion: six gates passed, while 27 TypeScript files failed collection; no TS bodies ran. That failed result now supersedes prior green summaries. Produced this consolidated report and corrected the evidence interpretation of CI state, benchmark validity, runtime diagnosis and test chronology. No other proposed behavioral fix is claimed as implemented here.

### Perspectives: ten per requested category

| Category | Report mapping |
|---|---|
| 1 Strategy | R01 positioning; R02 onboarding; R03 conformance; R04 audit product; R05 wallet segment; R06 assurance; R07 distribution; R08 user segments; R09 sequencing; R10 claim differentiation. |
| 2 Issues | R11 guards; R12 cursor/queries; R13 MCP boundaries; R14 contracts; R15 leases; R16 performance; R17 release; R18 quality; R19 docs; R20 architecture. |
| 3 Enhancements | R21 core types; R22 storage; R23 MCP schemas; R24 CLI; R25 contracts; R26 build; R27 observability; R28 config; R29 packaging; R30 claim generation. |
| 4 Advanced | R31 policy compiler; R32 simulation; R33 reconciliation; R34 approvals; R35 fleet; R36 attestations; R37 conformance platform; R38 rationale privacy; R39 multi-chain; R40 anomaly suggestions. |
| 5 Additions | R41 account adapters; R42 monitoring; R43 signers; R44 ETL; R45 examples; R46 presets; R47 doctor; R48 migrations; R49 release manifest; R50 operator view. |
| 6 Verification | R51 unit; R52 integration; R53 performance; R54 security; R55 UAT; R56 recovery; R57 platforms; R58 wallets; R59 releases; R60 runtime diagnosis. |
| Implementation/validation pairs | B61/V61 selector; B62/V62 counts; B63/V63 logging; B64/V64 cursor; B65/V65 lease design; B66/V66 artifacts; B67/V67 assurance; B68/V68 docs; B69/V69 benchmark; runtime work/V70 diagnostic. |

**Source navigation:** review notes are in `outputs/review-2026-09-17/agents/`; B65/B69 and `lease-coordination-design.md` are in its parent review folder. `benchmark-node24.json` is the invalid disk-evidence artifact discussed above. `assurance-inventory.json` and `runtime.json` are historical diagnostics. Raw reviewer recommendations are subordinate to this report's corrections and evidence limitations.
