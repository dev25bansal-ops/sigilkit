# Issues & Required Fixes — September 17, 2026

## Implementation checkpoint — September 17, 2026

Remediation has started; **the catalog is not complete**. This checkpoint supersedes the original review's unexecuted status only for the changes and checks listed here. The original issue descriptions below remain the historical baseline, not a claim that every defect is still unchanged.

| Issue | Current implementation status | Remaining closure work |
|---|---|---|
| SK-01 | Narrow `.codebuddy/models.json` exclusions added to Git and Docker ignore rules; Git exclusion verified | Credential-owner exposure review/rotation and approved secret storage remain external; no credential validity or breach claim |
| SK-02 | Private-key and URL validators withhold rejected values, including custom protocols; synthetic input and text/JSON aggregate-error tests added | External RPC/provider errors and other output boundaries still need separate sanitization review; issue partially remediated |
| SK-03 / SK-04 | No contract adapter changes in this implementation pass | Select a pinned real account integration and administration model; independent review and actual account tests required |
| SK-05 | Manager-path confirmation strictly decodes unique mined evidence bound to manager, transaction, and all five emitted request fields; demo supplies request identity; destination checked before sending | One-argument `assertAuditEmitted` intentionally confirms emitter-only evidence; unbound `parseActionLogged` remains an ingestion decoder, not confirmation. No 7579 executor certification or proof of un-emitted nonce/expiry/calldata/signature fields |
| SK-06 | Decoding catch narrowed; window-charge persistence errors propagate and prevent backfill cursor advancement | Regression first failed on the original behavior, then passed after the fix; retain regression in required gates |
| SK-07 | Atomic event/cursor persistence now covered by second-write, SQLite cursor-update trigger, pre-commit exception, and watcher rollback/retry tests; prior state preserved | Synthetic pre-commit failures do not simulate disk corruption, process termination, or uncertain post-commit acknowledgement; no throughput improvement measured |
| SK-08 | Rechecks captured checkpoint after collection; validates header heights, log source/range/hash membership, stable end, and resumed parent boundary; transaction rejects a changed local checkpoint | Requires trusted consistent canonical-header RPC; not a full ancestry or log-completeness proof. Parent mismatch regression failed before the boundary fix, then passed; checkpoint change/missing header/log mismatch/concurrent writer/watch cases pass |
| SK-09 | SQLite v2 atomic ownership, retained epochs, token-required renew/release, cooperative heartbeat/abort, and original-run SDK sign/send guards implemented; legacy adapters/layouts rejected; SQLite writer-lock and reader-blocked-commit failures now covered by real SQLite regressions | Partial closure: bounded lifecycle, mocked effect, SQLite failure, and one independent-holder forced-termination/recovery case pass; simultaneous multi-contender acceptance, duration telemetry, and migration review remain pending. No strict network fencing or production shared-key certification |
| SK-10 | Not implemented | Owner-authority separation remains open |
| SK-11 | Publish workflow builds workspace declarations before dependent lint | Static workflow checks and local build/lint passed; a fresh hosted release checkout has not been executed |
| SK-12 | Incomplete workflow split repaired: same-commit assurance dependency, identity output and environment-protected publish job; static validation passed | Hosted assurance, tested-artifact identity and release-tool compatibility remain unverified; not release certification |
| SK-13 | Implemented: runtime/execution/correctness/timing validity separated; pre-write freshness, independent whole-table SQL multiset comparison (catches unknown-agent/other-chain rows), all-agent field comparison, spend and target checks gate validity; build identity (sha256 of source/dist/harness/manifests + git commit/dirty, stability re-checked after run) and dataset hash recorded; invalid summaries suppressed; report always written before completion is judged; real runs execute in a fresh worker (fresh module cache) and the parent rejects invalid reports; report-write failure preserves diagnostics; reports remain non-authoritative | 43 benchmark tests passed, including injected construct/write/readback/close failures, unknown-agent/other-chain rows, preexisting fixtures, cleanup refusal, changing build identity, and an end-to-end worker run against the built dist artifact. Indexer 34/34 passed, including constructor close-on-init-failure and double-failure preservation. Full non-fork suite and helper gate (169 tests) passed. Hashes identify bytes, not source-to-build attestation; no production performance claim |
| SK-14 | Implemented: unique per-run `benchmark-run-<id>` directories with exclusive `wx` reservation of database and sidecars before construction; ownership registered before risky operations; preexisting artifacts refused and never deleted; `finally` cleanup of owned paths only (direct children, symlink-root refusal, nonrecursive empty-dir removal); cleanup/build/execution failures retained in the report and fail completion; workload bounds enforced on exported APIs; dataset sha256 recorded | 43 benchmark tests passed, including concurrent-run isolation, operator-file preservation, per-stage failure cleanup, and nonzero child exit on invalid completion. One bounded real CLI run (16 rows × 1 rep) passed with full verification and complete cleanup; reports are per-run and never overwritten. Not a latency guarantee or representative production benchmark |
| SK-15 | Seven helper suites wired into local verification and CI; artifact check follows build; missing required Forge fails; explicit partial and zero-check runs are labeled; root helper/artifact commands added | Local helper gate: 156 tests passed, including 16 verifier regressions. Build, lint and static workflow validation passed. Hosted CI and full release assurance were not executed; timed benchmarks remain optional |
| SK-16 | Queue and in-memory lease addresses validated/canonicalized; completed queue entries removed only if not replaced by later work | Eight nonce tests pass, including mixed-case ordering and cleanup after success/failure; this does not fix SK-09 ownership semantics |
| SK-17–SK-19 | Not implemented | Bounded ingestion/query/transport behavior remains open |
| SK-20 | Narrow manifest grammar documented and enforced; unsupported arrays/globs rejected explicitly; explicit workspace paths and deduplication supported; CLI requires regular-file targets | 23 guard tests passed; 23 workspace targets passed with the existing duplicated core dist/src warning. Static policy only, not npm glob/ignore parity or clean-install proof; gate wiring implemented under SK-15 |
| SK-21 | This checkpoint records actual implementation and verification status | Repository-wide authority index and assurance claims are not reconciled yet |
| SK-22 | Removed the tracked zero-byte ABI after finding no consumer or target-list entry; added directory-wide JSON/ABI-array checks; external memory notes are explicitly labeled rather than unresolved wikilinks | Six ABI drift tests passed. Original artifact creation provenance remains unknown; external notes were neither accessed nor copied |
| V-01–V-08 | Not newly verified | All listed investigations remain open |

### Latest continuation verification — SK-13/SK-14 benchmark closure

- `npm run test:full` (Forge non-fork suites + all workspace tests) exited 0 with the existing Foundry 1.7.1 on PATH; indexer 34/34 including the new constructor-failure regressions.
- `npm run test:helpers` passed 169 tests, including 43 benchmark regressions (lifecycle failures, fixture isolation, worker end-to-end).
- One bounded real CLI benchmark run (16 rows × 1 rep, seed 7) completed with `validity.valid: true`, full whole-table/agent/spend verification, stable build identity, and complete fixture cleanup; its report is preserved under `outputs/review-2026-09-17/benchmark-run-M3FbjC/`.
- Indexer typecheck (`tsc --noEmit`) passed. Hashes identify measured bytes only; no source-to-build attestation, production performance claim, commit, or publication was made.

### Verification actually executed

- Full available workspace tests: **283 passed, 1 skipped** (core 209/1 skipped, demo 12, indexer 22, MCP 40). This run preceded the final queue cleanup change. It included passing local conformance/demo E2E tests; it is not evidence of mainnet transactions or real-wallet certification.
- After the final queue change: `packages/core/test/nonce.test.ts` **8/8 passed**. Subsequently the complete core suite passed **211 tests, 1 skipped** across 20 test files, followed by successful full `npm run build` and `npm run lint` (workspace types plus static workflow/Docker checks), all with exit code 0. Other workspace suites were not rerun after those final queue changes.
- Indexer suite: **22/22 passed**, including write-failure propagation, rollback of earlier rows on a later write failure, and retry.
- Initial lint exposed an optional-string type error in the added validation test; it was corrected and subsequent full lint passed.
- Root `npm test` **blocked** because bare `forge` was unavailable on PATH. Solidity root-suite verification is not counted as passing, even though some local workspace E2E fixtures ran successfully through their own setup.
- `git diff --check` passed before this documentation update; existing user changes were preserved. No commits, publication, credential rotation, timed benchmark, or production deployment were performed.

### Continuation verification — SK-05 / SK-07 / SK-08

After all source changes in this batch, `npm run build`, `npm run test --workspaces --if-present`, and `npm run lint` each exited 0. Workspace totals: **311 passed, 1 skipped** (core 227/1 skipped; demo 12; indexer 32; MCP 40). These results supersede the earlier batch totals above. Focused audit tests: **21/21**. Indexer tests: **32/32**, including the added transaction and continuity cases. Diagnostics and `git diff --check` were clean before this checkpoint update.

The root Solidity suite was not rerun; its earlier PATH blocker is unchanged as verification evidence. Local conformance/demo tests passed, but do not certify a real standard account deployment. Existing changes were preserved; no commits, publication, credential rotation, production deployment, or timed benchmarks occurred.

### Continuation verification — SK-09 (September 18, 2026)

Implemented the breaking v2 lease API in `packages/core/src/client.ts` and `packages/core/src/lease-fs.ts`. SQLite acquisition/renewal use short `BEGIN IMMEDIATE` transactions with time sampled after the writer lock; release is owner/key/epoch-qualified and retains the epoch row. Currentness compares expiry after the database read. Legacy adapters and `.lock` layouts are rejected; the historical filesystem read-token/delete design is superseded, not implemented.

`NonceGate` now renews serially at half-TTL, exposes a sticky-loss cooperative abort signal, waits for callback settlement and in-flight renewal before release, and reports acquisition/release failures without poisoning queues. SDK pre-sign and pre-send checks require a same-client, same-run guard; prepared payload provenance binds the actual signing account (not `agentId` or relayer identity). Post-submission receipt processing is not retroactively cancelled. The fleet forwards its context but remains a one-process demo with no external store configured.

Final verification: **247 core tests passed, 1 skipped**, across 20 files. Focused suites: **57 passed** (lease store 13, nonce lifecycle 15, execution/audit 29). The full core run includes existing local conformance fixtures; no production transaction or live lease-collision reproduction was performed. Workspace `npm run build` and `npm run lint` passed; core build passed again after the full core run. `git diff --check` and edited-file diagnostics were clean before this checkpoint. The other workspace test suites and root Solidity suite were not rerun for the final SK-09 state. No commits or publication occurred.

**Still open:** independent OS-process contention/crash acceptance, explicit SQLite busy/commit-failure regressions, measured operation-duration/renewal telemetry, and broader migration review. Sequential independent-connection tests establish bounded lifecycle behavior, not cross-process certification. Local ownership checks cannot close the check/send gap; strict end-to-end fencing requires downstream enforcement. Arbitrary callbacks and direct wallet calls remain cooperative only. Distinct keys per process remain the recommended default; production shared-key restrictions are not lifted.

Next priority: finish the remaining SK-09 acceptance evidence, then SK-10 owner-authority separation and the remaining release/benchmark issues. The catalog remains unfinished.

### Continuation verification — SK-09 SQLite failure regressions (September 18, 2026)

Added five real-SQLite failure regressions to `packages/core/test/lease-fs.test.ts` (no source changes). Writer-lock cases use an independent `DatabaseSync` connection holding `BEGIN IMMEDIATE` with the store's `busy_timeout` set to 0, so `acquire`, `renew`, and `release` each fail at SQLite with `errcode` 5 (busy). Reader-blocked-commit cases hold a `BEGIN` + `SELECT` read lock (journal mode `DELETE`) while the store executes `BEGIN IMMEDIATE` → `COMMIT` → `ROLLBACK`; the spy records exactly that sequence, `db.isTransaction` is false afterward, and the full five-column lease row is unchanged on both connections. After the blocker releases, the same store connection retries successfully: acquire returns the next epoch, renew extends to the expected deadlines, and release clears ownership while retaining the epoch. Time is frozen at 1,000,000 ms for determinism; blockers roll back and close in `finally`.

Verification: lease suite **18/18 passed**; combined lease/nonce/execute suites **62/62 passed**; full core suite **252 passed, 1 skipped** across 20 files; core lint (both tsconfig passes) and core build exited 0; `git diff --check` clean. One intermediate lint failure (implicit-any callback in the new test) was fixed before the final runs. No production transactions, live cross-process reproduction, commits, or publication occurred.

**Still open for SK-09:** independent OS-process contention/crash acceptance, measured operation-duration/renewal telemetry, and broader migration review. These regressions exercise real SQLite busy/commit failure on one host, not multi-process certification. Strict network fencing and production shared-key use remain out of scope.

### Continuation verification — SK-09 independent-holder recovery (September 18, 2026)

Added a real-clock acceptance case in `packages/core/test/lease-fs.test.ts`: a separate Node process acquires the SQLite lease and reports readiness through IPC; the parent verifies exclusion, forcibly terminates only that test-owned holder, confirms exclusion before expiry and during recovery grace, then acquires the next epoch and rejects the old token's renewal/release. The child is awaited and cleaned up in `finally`. Core `pretest` and `pretest:coverage` now build first so the child imports current compiled code; direct Vitest invocations still require a prior build. This is an acceptance test of the existing implementation, not a new lease-source fix.

Executed: lease suite **19/19 passed**; full core **253 passed, 1 skipped**; all workspace tests **337 passed, 1 skipped** (core 253/1 skipped, demo 12, indexer 32, MCP 40). Workspace build and full lint exited 0. The demo E2E passed while also emitting a local RPC fetch error; this is retained as an observed diagnostic, not silently reported as log-clean. `git diff --check` passed with a line-ending warning for core's package manifest. No root Solidity suite, hosted CI, benchmark, production transaction, or publication was executed in this continuation.

**Remaining:** simultaneous multi-contender process acceptance, renewal/duration telemetry, broader migration review, and all other unfinished catalog work. One terminated holder on this Windows/Node environment is not platform-wide crash durability or production shared-key certification. Earlier checkpoint results and pending lists above describe their respective historical states; this paragraph and the status table reflect the added recovery evidence. The overall catalog remains incomplete.

### Additional verification — process-held reader lock and Windows root gate

A second independent-process case now holds a SQLite read transaction through IPC while acquisition attempts a write. The focused case passed: SQLite busy is reported at commit, the observed sequence is `BEGIN IMMEDIATE` → `COMMIT` → `ROLLBACK`, the original row is preserved, and retry on the same connection succeeds after the child releases its lock. No lease-source change was required. Core lint passed afterward.

The root gate first failed because bare `forge` was not on PATH. Using the installed Foundry directory in the current shell exposed a separate Windows npm quoting defect: single quotes did not protect the filter's pipe from `cmd.exe`. Root `package.json` now uses double-quoted regex filters for `test` and `test:full`. With the session-only PATH adjustment, `npm test` exited 0, running its configured non-invariant/non-fork Solidity selection followed by the workspace suites. This supersedes the earlier root-gate blocker for this session only; it does not configure permanent PATH or verify `test:full`, fork, or formal gates. Final workspace lint exited 0 and `git diff --check` passed. The catalog remains incomplete; these checks are not closure of unrelated issues.

### Release-workflow handoff repair (September 18, 2026)

Delayed teammate reports revealed that `.github/workflows/publish.yml` had been left in an incomplete intermediate state: registry steps remained in `assurance`, its SHA output referenced a missing identity step, and publishing environment/OIDC configuration was absent. Earlier generic workflow validation did not establish release correctness.

The split is now completed: assurance emits its checked-out commit only after its checks succeed; a separate `publish` job requires successful assurance and equality with `github.sha`, rechecks checkout identity, restores the `npm` environment and job-scoped OIDC permission, and rebuilds before the existing registry steps. This binds source commits, not byte-identical tested tarballs, since publishing rebuilds artifacts.

Actual checks: YAML/structural validation, `actionlint` (shellcheck and pyflakes disabled), and workflow whitespace checks passed. `npm publish --dry-run --ignore-scripts` stopped on core because version `0.1.0` already exists; it made a registry lookup but published nothing. Subsequent `npm pack --dry-run --ignore-scripts` passed for core, indexer and MCP. Core's preview still includes a duplicated `dist/src` tree. No hosted assurance run, environment approval, scope ownership verification or provenance publication was performed. Required tool compatibility, verifier completeness, artifact identity and broader SK-12/SK-15 closure remain unverified. Other stopped teammates reported no implementation changes.

## 1. Decision summary

**Recommendation: block promotion of affected production workflows until their P0/P1 items below are resolved or explicitly excluded from the supported product.** A limited developer preview is a separate decision, not evidence of production readiness.

This catalog consolidates the current read-only review into **22 remediation issues and 8 evidence-gathering follow-ups**. It covers software bugs, performance, security, code quality, architecture, and technical debt. It does not claim that all repository files or all possible defects have been audited.

No source fixes, regression tests, benchmarks, external transactions, credential validation, or deployments were executed while preparing this catalog. The earlier review directly observed Node `24.12.0`, an inventory of 20,763 files, and six populated API-key fields in local configuration; these are observations, not security incident or performance measurements. Existing user changes remain intact.

### Evidence and scoring rules

- **S — Static:** current source/configuration inspected; the mechanism is present, but runtime impact is not reproduced.
- **O — Observed:** repository metadata or a non-invasive inspection directly established the condition.
- **H — Historical:** an existing report claims a result; not re-executed or independently validated here.
- **V — Verification gap:** a plausible concern requiring additional evidence; not a confirmed defect.
- **Reproduction plans are unexecuted.** Ordinary correctness bugs include small local fixture procedures. Security findings use defensive acceptance criteria rather than exploit payloads or operational attack instructions. Use synthetic data, no live funds, and isolated owned fixtures.
- Severity is a business-risk assessment: **Critical** = established immediate catastrophic impact; **High** = material authority, audit-integrity, availability, or release risk; **Medium** = bounded operational/reliability or scaling impact; **Low** = maintenance/documentation impact. **No Critical issue is established.**
- **P0:** contain immediately. **P1:** block the affected release/use. **P2:** next minor cycle. **P3:** planned maintenance. Priority considers exposure and dependencies, not severity alone.
- Security items receive severity ratings rather than invented CVSS numbers. Valid CVSS vectors require confirmed deployment boundaries, privileges, interaction, and impact. No scored vulnerability or confirmed compromise is asserted.
- Estimates are focused engineer-days, **1 day = 8 hours**, including implementation and regression coverage. They exclude external audit, owner approvals, and waiting time. They are planning ranges, not commitments; overlapping work must not be added mechanically.
- Timelines run from maintainer acceptance of this catalog. Contract changes require separate security review and release planning; tests do not replace that review.
- Source ranges refer to the inspected working tree and can move after edits. This catalog proposes a new backlog; it does not silently replace the authority policy in `docs/STATUS.md`.

## 2. Ranked remediation register

| Rank / ID | Issue | Category | Evidence | Severity / priority | Effort | Dependency | Target / suggested owner |
|---|---|---|---|---|---|---|---|
| 1 / SK-01 | Local credential material lacks repository/build-context exclusion | Security | O/S | High / P0 | 2–4 h + rotation | Credential owners | Contain today; security/maintainer |
| 2 / SK-02 | Private-key and URL validation can expose submitted values | Security, quality | S | High / P1 | 1–2 d | Sensitive-error policy | 1–3 working days; core |
| 3 / SK-03 | ERC-7579 validator lacks an independent administration boundary | Security, architecture | S, account-dependent | High / P1 | 3–5 d + review | SK-04; account threat model | Before account support; contracts |
| 4 / SK-04 | Advertised ERC-7579 routing differs from standard account execution | Bug, architecture | S | High / P1 | 5–10 d + review | Pinned account/version | Start week 1; block affected integration; contracts/SDK |
| 5 / SK-05 | SDK audit evidence is not bound to emitter/request | Security, bug | S | High / P1 | 1–2 d | Expected-emitter contract | Week 1; core |
| 6 / SK-06 | Window-charge persistence errors are swallowed | Bug, reliability | S | High / P1 | 0.5–1 d | SK-07 integration | 1–3 working days; indexer |
| 7 / SK-07 | Rows and sync cursor are not committed atomically | Architecture, performance | S | High / P1 | 1–2 d | Failure/transaction semantics | Week 1; indexer |
| 8 / SK-08 | Reorg checks leave checkpoint-to-range continuity unverified | Bug, architecture | S | High / P1 | 2–4 d | SK-07; RPC consistency policy | Before trusted final audit use; indexer |
| 9 / SK-09 | Lease lifecycle does not preserve ownership | Reliability, architecture | S | High / P1 | 3–5 d | Atomic backend/API decision | Before shared-key multi-worker use; core |
| 10 / SK-10 | Demo agent retains owner authority and secret-bearing process arguments | Security, architecture | S | High / P1 | 3–5 d | Separate signer/provisioner design | Before non-disposable use; demo/core |
| 11 / SK-11 | Tag publishing typechecks before building workspace declarations | Bug, release | S | High / P1 | 2–4 h | Clean checkout fixture | Next release patch; release |
| 12 / SK-12 | Tag publishing is not gated on exact-commit assurance | Security assurance, debt | S | High / P1 | 2–4 d | Required checks/version policy | Before publication; release/security |
| 13 / SK-13 | Benchmark correctness does not control its authoritative label | Bug, evidence quality | S | Medium / P1 | 1–2 d | Correctness schema | Before performance claims; tooling |
| 14 / SK-14 | Benchmark disk fixtures are not guaranteed fresh or run-owned | Bug, evidence quality | S | Medium / P1 | 1–2 d | SK-13; fixture lifecycle | Before next benchmark; tooling |
| 15 / SK-15 | Assurance helpers are not integrated into complete gates | Debt, reliability | S | Medium / P1 | 0.5–1.5 d | Build order; gate policy | Week 1; tooling |
| 16 / SK-16 | In-process nonce identity is case-sensitive and queues retain keys | Bug, performance | S | Medium / P2 | 0.5–1 d | SK-09 compatibility | Next patch; core |
| 17 / SK-17 | Indexer catch-up buffers the complete requested log range | Performance, architecture | S | Medium / P2 | 2–3 d | SK-07/SK-08 | Next minor; indexer |
| 18 / SK-18 | Audit queries and spend aggregation materialize full result sets | Performance, architecture | S | Medium / P2 | 2–4 d | Pagination/API semantics | Next minor; indexer/MCP |
| 19 / SK-19 | MCP transport lacks application bounds and drain-aware shutdown | Reliability, performance | S | Medium / P2 | 3–5 d | SK-18; transport lifecycle | Before shared/unbounded input use; MCP |
| 20 / SK-20 | Package guard covers a narrower manifest grammar than advertised | Quality, debt | S | Low / P3 | 1–3 d | Supported manifest contract | Within 4–6 weeks; tooling |
| 21 / SK-21 | Documentation authority and assurance status contradict newer evidence | Quality, debt | O/S/H | Medium / P1 | 1–2 d | Maintainer authority decision | Before next release claims; docs/security |
| 22 / SK-22 | Empty ABI artifact and non-portable vault links create maintenance traps | Quality, debt | O/S | Low / P3 | 2–4 h | Artifact provenance; note ownership | Next maintenance patch; tooling/docs |

## 3. Detailed issues

### SK-01 — Local credentials can enter commits or build contexts

**Evidence:** `.codebuddy/models.json` has six populated API-key fields; the earlier `git status` listed `.codebuddy/` as untracked. `.gitignore` and `.dockerignore` do not exclude that local configuration. Values are intentionally omitted. Credential validity, privileges, and historical exposure are unknown.

**Expected / actual:** local service secrets should stay outside versioned/shared project content. Currently local configuration is eligible for accidental inclusion. Selective Docker `COPY` statements mean this is **not proof that secrets enter the final image**.

**Impact/example:** sharing the working directory or staging all untracked files can include credential material. High severity reflects potential service access and billing exposure, not a demonstrated breach.

**Defensive acceptance:** use a synthetic marker, not a real credential, to verify approved exclusions and archive/build-context handling. Require a redacted scan disposition and credential-owner review of exposure; do not print or test keys.

**Fix:** contain access, move secrets to approved storage, rotate/revoke if exposed, and add narrowly scoped exclusions. Preserve `.codebuddy/` project data; **do not delete the folder**. Document safe sharing and review history through an authorized secret-response process.

**Delivery:** High/P0; 2–4 h plus provider rotation; credential-owner dependency; contain today. Business value: prevents avoidable secret distribution.

### SK-02 — Validation truncation is not redaction

**Evidence:** `packages/core/src/validation.ts:27–38,63–80,140–150`; `packages/core/src/logger.ts:92–116`; shared CLI error output in `packages/core/src/cli.ts:399–408`. Generic invalid-value formatting is used for private-key/URL validation. Strings up to 66 characters can be rendered whole; longer values retain a 20-character prefix.

**Expected / actual:** sensitive validation should identify the field and expected shape without echoing its value. Current errors can carry submitted secret-like material into text/JSON logs and CLI diagnostics.

**Impact/example:** a malformed credential copied into configuration can be included in an error report; URL userinfo or tokens need equivalent treatment. No actual log disclosure was established.

**Defensive acceptance:** a redaction test suite using unmistakably synthetic sentinels must assert that no sensitive input or prefix appears in messages, structured fields, or chained errors. Existing validity tests do not establish non-disclosure.

**Fix:** mark sensitive validators, omit input values, sanitize credential-bearing URLs and external errors at output boundaries, and retain useful field/error codes. Do not rely on truncation or stack omission alone.

**Delivery:** High/P1; 1–2 d; common redaction policy; 1–3 working days. Business value: safer support logs and incident handling.

### SK-03 — Validator administration is not isolated from session execution

**Evidence:** `contracts/src/SessionKey7579Module.sol:125–163,249–288`. Administration uses the initialized account's caller identity; validation enforces configured targets/selectors but does not independently distinguish account governance from account-originated session execution. Installation does not seed mandatory administrative restrictions.

**Expected / actual:** an untrusted scoped session must not receive account-administration authority merely because execution originates from the account. The current guarantee depends on account routing and the granted policy, especially with an unrestricted root.

**Impact:** possible privilege-boundary failure in permissive integrations. This is account/policy-dependent, not a demonstrated universal bypass or confirmed loss.

**Defensive acceptance:** an account-specific access-control matrix must show governance remains unavailable to session execution across install/use/revoke/uninstall. Verify least-privilege defaults and immutable restrictions; no live-network or exploit procedure is prescribed.

**Fix:** define account-specific non-session administration boundaries and enforce them at the correct routing layer. Do not assume a mutable selector denylist alone is sufficient. Review interaction with SK-04 before changing contract semantics.

**Delivery:** High/P1; 3–5 d plus independent review; depends on SK-04 and account threat model; before account support. Business value: makes the central scoped-authority promise defensible.

### SK-04 — ERC-7579 compatibility and caller context mismatch

**Evidence:** `contracts/src/ActionLog7579Executor.sol:42–44,100–126` reports executor module type 6 instead of standard type 2 and directly calls the target. `contracts/src/SessionKey7579Module.sol:217–237` reads a raw mode word followed by tuple-encoded payloads. `contracts/test/Module7579AccountE2E.t.sol:7–13,50–73` uses a custom matching account decoder.

**Expected / actual:** the supported real account should recognize the executor, decode its actual execution framing, and preserve account identity at targets. Current tests establish custom-component agreement, not standard account compatibility; direct forwarding makes the executor the target's caller.

**Local verification plan:** (1) select one pinned account library/version; (2) build a disposable integration fixture using its supported interfaces; (3) exercise a benign call to a caller-recording target; (4) compare account identity, execution framing, and module discovery against that account's requirements. **Expected:** account recognized and recorded as caller. **Static actual:** module type/routing differ; runtime result remains unexecuted.

**Fix:** implement a narrow versioned adapter, correct module identification and execution encoding, and use the account's executor interface. Validate complete modes rather than only an initial byte. Add real-account integration coverage instead of modifying the mock to agree again.

**Delivery:** High/P1; 5–10 d plus review; pinned account decision; start week 1, block affected integration until complete. Business value: avoids failed integrations and incorrect token/permission semantics.

### SK-05 — SDK accepts audit events without source/request binding

**Evidence:** `packages/core/src/client.ts:357–365,522–554,625–649`. `assertAuditEmitted` checks event topic shape; `parseActionLogged` returns the first matching decoded event; `sendPrepared` does not compare it with the prepared request.

**Expected / actual:** audit confirmation should authenticate the expected emitter and match available request fields. Current matching is event-shaped, not execution-identity-bound.

**Impact:** an unrelated receipt event can be reported as the requested action's audit record. This is an audit-integrity finding, not proof of contract authorization bypass.

**Defensive acceptance:** define the expected emitter for each supported manager/delegator/account path, then require strict source and request matching and explicit ambiguity handling. Tests must cover unrelated events, absence, and multiple matching records without constructing attack payloads.

**Fix:** pass expected execution identity through parsing/confirmation, decode strictly, bind agent/target/selector/value/rationale where represented, and document what the event schema cannot prove.

**Delivery:** High/P1; 1–2 d; emitter semantics, coordinated with SK-04 where needed; week 1. Business value: trustworthy SDK receipts and downstream audit reports.

### SK-06 — Database failures are treated as unrelated events

**Evidence:** `packages/indexer/src/indexer.ts:297–316`. The `WindowCharged` decoding catch also surrounds `storeWindowCharge`; sync later advances the cursor at `565–566` and `611–612`.

**Expected / actual:** persistence failure must stop sync and preserve retryability. A write exception can currently be swallowed as a non-SigilKit event, allowing a missing record behind an advanced cursor.

**Reproduction plan:** (1) supply one valid synthetic window-charge log to an isolated test; (2) inject a deterministic database-write failure; (3) call the ingestion/sync path; (4) inspect error propagation and cursor state. **Expected:** explicit failure, no committed cursor advancement. **Static actual:** the catch suppresses the write exception. No real disk-failure or production database experiment is needed.

**Fix/closure:** limit the catch to decoding; propagate persistence errors; integrate with SK-07. Assert the failed chunk is retriable and missing charges cannot be silently certified.

**Delivery:** High/P1; 0.5–1 d; SK-07 integration; 1–3 working days. Business value: prevents silent spend-report incompleteness.

### SK-07 — Ingestion and cursor lack an atomic commit boundary

**Evidence:** `packages/indexer/src/indexer.ts:281–319,367–379,559–567,605–612`. Events are persisted individually and the cursor is set afterward, without a surrounding transaction in these paths.

**Expected / actual:** an accepted bounded batch and its checkpoint should commit together or neither should commit. Current partial progress can remain after failure, and per-row autocommit adds transaction overhead.

**Reproduction plan:** (1) create a small owned fixture with several valid rows; (2) inject a failure on a later write or cursor write; (3) inspect rows/cursor before retry. **Expected:** atomic rollback or an explicitly documented transactional chunk boundary. **Static actual:** earlier successful writes can remain. Idempotent retry helps but is not atomicity.

**Metrics:** structural worst case is N event-write autocommits plus a cursor write for N events. Actual rows/s, commit latency, lock waits, and crash behavior are unmeasured.

**Fix/closure:** stage only a bounded verified chunk, transactionally write its events and cursor, cache appropriate prepared statements, and test rollback/retry. Do not keep a database transaction open across RPC waits. Preserve exact numeric semantics.

**Delivery:** High/P1; 1–2 d; transaction/failure specification; week 1. Business value: reliable checkpoints and potentially higher ingestion throughput; no speedup promised.

### SK-08 — Cursor canonicality is not tied continuously to the fetched range

**Evidence:** `packages/indexer/src/indexer.ts:458–517,536–566,592–612`. The previous cursor is checked before fetching, while range stability compares only the new end header before/after log retrieval.

**Expected / actual:** previously accepted history and the newly committed range must belong to a coherent chain view. Current checks leave a time gap and do not independently verify intermediate log/header continuity. Stored hashes alone do not establish reconciliation.

**Verification plan:** use a deterministic canonical-header model and isolated indexer fixtures; specify consistency across checkpoint, log blocks, and range end, then assert inconsistent snapshots do not change persisted evidence. This is a defensive consistency test specification, not a live-chain manipulation procedure.

**Fix/closure:** revalidate the previous checkpoint around collection, validate log/header relationships under a documented RPC trust policy, and commit coherent chunks via SK-07. A double-read reduces a race but is not a universal snapshot guarantee. Preserve fail-closed behavior and originals during separate-database rebuilds.

**Delivery:** High/P1 for trusted final audit use; 2–4 d; SK-07 and RPC policy; before that use is promoted. Business value: avoids mixed-history audit conclusions.

### SK-09 — Lease ownership, renewal, and fencing are absent

**Evidence:** `packages/core/src/lease-fs.ts:43–52,106–140`; `packages/core/src/client.ts:179–219`. The interface returns a boolean, release uses only the key, stale cleanup separates expiry inspection from removal, and `NonceGate` holds a fixed 30-second lease across an arbitrary callback.

**Expected / actual:** only the current holder can release/renew, and lost ownership must prevent further guarded side effects. Current code lacks the identity/renewal contract needed to enforce those rules. Its header explicitly says this remains unfixed.

**Defensive acceptance:** specify and verify exclusive ownership, owner-bound release, renewal under slow work, safe stale recovery, cancellation, and pre-side-effect fencing. Existing tests cover basic exclusion/expiry but do not establish ownership across reassignment. No transaction-collision demonstration is required.

**Fix:** choose a proven atomic coordination model; version the public lease API if necessary. A non-atomic token-read followed by deletion is insufficient. Until fixed, use a distinct session key per process or serialize work outside this adapter. On-chain nonce checks remain a separate defense; this finding does not prove duplicate successful spending.

**Metrics:** 30,000 ms gate TTL and 5,000 ms default filesystem grace are code constants, not measured transaction-duration limits. Track lease contention, lost ownership, guarded duration p95/p99, and renewal failures after implementation.

**Delivery:** High/P1; 3–5 d; backend/API decision; before shared-key multi-worker use. Business value: predictable fleet operation and avoidance of unnecessary failed transactions.

### SK-10 — Demo process holds more authority than its scoped-agent claim

**Evidence:** `packages/demo-agent/src/agent.ts:36–69,107–115`; `packages/demo-agent/src/cli.ts:127–158,186–216`; `packages/demo-agent/src/fleet.ts:30–45,75–95`. The retained configuration includes the owner key, the owner signer relays routine actions, and deployment subprocess arguments carry owner material.

**Expected / actual:** a hot scoped agent should not retain provisioning authority. Current demo isolation limits a stolen session key, not compromise of the entire process.

**Defensive acceptance:** validate signer capabilities and lifecycle using synthetic/mock signers; the steady-state agent must have no owner material or owner-capable handle. Verify process invocation/error reporting contains no credentials. No key extraction or process-inspection procedure is prescribed.

**Fix:** separate provisioning/grant/revoke from execution, inject a restricted relayer, use approved signing interfaces instead of secret-bearing arguments, and document expiry/teardown responsibilities. JavaScript string deletion is not guaranteed zeroization.

**Delivery:** High/P1; 3–5 d; signer/provisioner architecture; before non-disposable use. Business value: makes demo reuse safer and aligns the advertised trust boundary.

### SK-11 — Release lint runs before declarations exist

**Evidence:** `.github/workflows/publish.yml:40–42` lints before build; `.github/workflows/ci.yml:137–142` explicitly documents and uses the opposite ordering because consumers resolve core's `dist` declarations.

**Expected / actual:** fresh-checkout dependent typechecks should run after generating declarations. The release path can fail before the build that supplies them.

**Reproduction plan:** (1) use a fresh isolated checkout with no generated `dist`; (2) install the locked dependencies; (3) execute the release lint/build stages in their defined order. **Expected:** all modules resolve. **Static actual:** declaration-producing build occurs too late; clean-run failure is not executed here.

**Fix/closure:** build before dependent lint and share ordering across local, PR, and release checks. Add a clean-checkout regression gate; do not delete the user's generated tree to simulate cleanliness.

**Delivery:** High/P1 release blocker; 2–4 h; clean checkout fixture; next release patch. Business value: avoids tag-time release failures.

### SK-12 — Release assurance is not bound to the publishing commit

**Evidence:** `.github/workflows/publish.yml:33–59,103–110`; `.github/workflows/ci.yml:3–14,237–253`. Publishing has no dependency on successful deep/security jobs for its exact commit. CI lacks a tag trigger, Halmos eligibility is branch/dispatch-based, and published manifest versions are not checked against the triggering tag.

**Expected / actual:** required release evidence and package versions should match the exact commit/tag. A comment saying “full gate” does not provide that dependency. External protected-environment rules were not inspected and may impose additional controls.

**Defensive acceptance:** review the release dependency graph and test policy with synthetic workflow contexts, including absent/failed required evidence and tag/version disagreement. Missing checks must block, not inherit an unrelated green branch result.

**Fix:** use a reusable required-check workflow or explicit commit-bound attestations, validate tag/version policy, and make skip/waiver handling explicit. Define which deep checks are genuinely required rather than labeling every inventory entry a release gate.

**Delivery:** High/P1; 2–4 d; maintainer release policy; before publication. Business value: prevents publishing unverified or mislabeled artifacts.

### SK-13 — Benchmark can certify incorrect results

**Evidence:** `scripts/benchmark-indexer.mjs:417–454,465–477,519–529`. Readback booleans do not determine failure or `authoritative`, which depends on runtime eligibility. The inspected checks cover one target count and one agent total, not complete fixture integrity.

**Expected / actual:** correctness must pass before timings become valid evidence. Current schema can label a result authoritative despite unsuccessful readback.

**Reproduction plan:** inject a benchmark adapter returning a mismatched synthetic count/total, generate the report, and inspect validity and exit status. **Expected:** invalid/non-authoritative and nonzero completion status. **Static actual:** the label is independent of the mismatches.

**Fix:** separate runtime eligibility, completed execution, and correctness; fail closed on any required check; validate total row/content integrity and record build identity. Label memory sampling accurately: current sampling also includes readback allocations outside the write-loop timing interval.

**Delivery:** Medium/P1; 1–2 d; benchmark result schema; before performance claims. Business value: prevents false optimization decisions and misleading customer claims.

### SK-14 — Benchmark fixtures may reuse or leave behind databases

**Evidence:** `scripts/benchmark-indexer.mjs:418–420,470–476,489–512`. Disk paths are deterministic; there is no fresh-run ownership guarantee. Cleanup registration follows successful return from the repetition, so earlier errors can leave unregistered artifacts.

**Expected / actual:** each repetition should operate on a fresh, owned dataset and clean only its own artifacts. Existing files can contaminate the workload; failures can bypass bookkeeping.

**Reproduction plan:** use an injected filesystem/database adapter representing an already-existing fixture and another that fails during initialization. **Expected:** reject/isolate pre-existing state and track owned resources before risky operations. **Static actual:** lifecycle ordering does not enforce those conditions. Never use an existing operator database.

**Fix:** unique run directories, exclusive creation or explicit refusal, early ownership registration, `finally` cleanup of owned resources, and preservation of invalid evidence. Record executable/build/fixture identities. Apply workload validation to exported APIs as well as CLI parsing.

**Metrics:** the inspected CLI permits at most 1,000 rows × 3 repetitions × 2 modes = 6,000 writes. This bound is neither a latency guarantee nor a representative production benchmark.

**Delivery:** Medium/P1; 1–2 d; SK-13 and fixture policy; before another timed run. Business value: reproducible evidence without accidental data handling.

### SK-15 — Local/CI assurance wiring is incomplete

**Evidence:** `scripts/verify.mjs:30–38,127–151`; root `package.json:14–31`; `.github/workflows/ci.yml:47–54`. Package-artifact validation and several new helper regression suites are outside inspected routine gates. Missing Forge can be treated as a successful skip in the local verifier.

**Expected / actual:** a complete result should mean all required checks executed successfully. Tools existing on disk do not mean CI enforces them; successful skipping is not complete assurance.

**Reproduction plan:** run the verifier through its injected command/tool-availability fixtures and capture selected checks and final status. **Expected:** unavailable required tooling marks a full gate incomplete/nonpassing, while an explicitly selected quick mode states its reduced scope. **Static actual:** a missing-tool path can be reported as successful skip.

**Fix/closure:** enumerate required helper suites, run artifact checks after build, and separate quick/partial/full outcomes. Keep performance benchmark execution optional while gating its correctness tests. Ensure source/test/workflow changes travel together in maintainer-reviewed commits.

**Delivery:** Medium/P1; 0.5–1.5 d; gate policy/build order; week 1. Business value: stops false confidence and helper regressions.

### SK-16 — Address casing splits queues; completed keys stay resident

**Evidence:** `packages/core/src/client.ts:186–229`. In-memory maps use caller-provided address strings; filesystem leases separately lowercase keys. The queue map retains a promise for each distinct key without completed-entry removal.

**Expected / actual:** equivalent address representations should share one logical queue, and idle queues should not accumulate indefinitely. Current casing can split in-process identity; lifetime key count governs retained entries.

**Reproduction plan:** with an ordinary synthetic address, submit two short callbacks using equivalent casing, record start/end ordering, and inspect retained key count after many distinct callbacks complete. **Expected:** equivalent identities serialize; idle entries are removed safely. **Static actual:** distinct strings use distinct map slots and entries remain.

**Fix:** validate/canonicalize once at every public queue/store boundary and remove completed entries only if they still reference that operation. Preserve ordering when a later operation already replaced the map entry.

**Metrics:** retained entries are O(K) for K distinct address strings used over process lifetime; heap bytes and latency are unmeasured.

**Delivery:** Medium/P2; 0.5–1 d; SK-09 API compatibility; next patch. Business value: consistent identity handling and stable long-running SDK memory.

### SK-17 — Catch-up chunking bounds RPC size, not total memory

**Evidence:** `packages/indexer/src/indexer.ts:383–398,502–517,559–566`. `fetchLogsChunked` appends every chunk into one array before ingestion.

**Expected / actual:** long catch-up should have a configured application memory/work bound. RPC chunks are bounded, but the entire requested history remains accumulated.

**Reproduction plan:** use a capped synthetic RPC fixture returning increasing finite row counts across several chunks; record RSS, heap, fetched rows, and time before first commit. **Expected after fix:** memory bounded by configured chunk/queue size and explicit progress. **Static actual:** O(L) buffered logs for L returned logs. Runtime impact is not measured.

**Fix:** ingest bounded coherent chunks with checkpoint atomicity and backpressure. Preserve SK-08 consistency checks; do not sacrifice reorg safety merely to stream earlier. Add cancellation/progress limits and operator-visible lag.

**Delivery:** Medium/P2; 2–3 d; SK-07/SK-08; next minor. Business value: predictable recovery and catch-up on larger histories.

### SK-18 — Audit queries and aggregation are unbounded

**Evidence:** `packages/mcp/src/server.ts:198–219,273–276`; `packages/indexer/src/indexer.ts:635–657` and action-query paths. Queries materialize matching rows, map them, and serialize complete results; spend aggregation materializes values before JavaScript summation.

**Expected / actual:** audit retrieval should paginate and exact-value aggregation should avoid full-result application allocation. Read-only mode protects mutation, not resource consumption.

**Reproduction plan:** query owned synthetic fixtures at 100, 1,000, and 10,000 rows under a fixed process budget; measure p50/p95 response time, serialized bytes, and peak RSS. **Expected after fix:** capped pages with stable ordering and no missing/duplicated rows; aggregation memory does not grow with full result size. **Static actual:** O(N) materialization with no action-page bound.

**Fix:** SQL-level keyset pagination with stable composite ordering; streamed exact-bigint aggregation or a proven exact-value strategy. Do not replace JavaScript bigint sums with overflow-prone SQLite integer/float sums. Version response semantics where necessary.

**Delivery:** Medium/P2; 2–4 d; pagination/API contract; next minor. Business value: usable audit history at scale without incorrect monetary totals.

### SK-19 — MCP has no explicit queue bounds or drain-safe shutdown

**Evidence:** `packages/mcp/src/server.ts:296–343`; `packages/mcp/src/cli.ts:65–84`; `packages/core/src/cli.ts:344–347,396–398`; logger output in `packages/core/src/logger.ts:133–151`. Transport ignores output backpressure, does not define maximum input-line size/pending work, and shutdown does not await all responses/output before the shared CLI exits.

**Expected / actual:** bounded requests should either complete with an emitted response or terminate with documented cancellation. Slow output should pause production. Current paths can accumulate buffered work or lose pending output; synchronous write-error tests do not cover asynchronous stream errors or draining.

**Local verification plan:** use a small slow writable stub that returns false and later emits `drain`; send a fixed small batch and request orderly shutdown. **Expected:** bounded dispatch, handled stream errors, and completed/drained responses or explicit cancellation. **Static actual:** no tracked drain/pending-response lifecycle. Do not perform exhaustion testing.

**Fix:** bounded framing before parsing, pending-work caps, input pause/resume, asynchronous error handling, cancellation, and bounded graceful shutdown. Define a separate explicit overload policy for logging rather than introducing an unbounded logging queue.

**Metrics:** input bytes, active requests, queued responses, writable-buffer bytes, shutdown duration, and lost-response count. No runtime failure rate or safe throughput limit is established.

**Delivery:** Medium/P2; 3–5 d; SK-18 and transport contract; before shared/unbounded input use. Business value: reliable agent tooling under slow consumers and shutdown.

### SK-20 — Artifact guard silently omits supported-looking manifest forms

**Evidence:** `scripts/check-package-artifacts.mjs:64–90,148–158,194–211,224–231`. Export arrays are skipped, allowlist matching is prefix-based rather than complete npm glob semantics, workspace discovery assumes a particular layout, and target validation checks existence rather than regular-file type.

**Expected / actual:** a general guard should support or explicitly reject manifest forms; unsupported syntax should not silently reduce validation. This is a maintainability/coverage issue, not proof a current package is broken.

**Reproduction plan:** add small manifest fixtures containing an export fallback array, a glob allowlist, and a directory at an expected file target. **Expected:** correct validation or explicit unsupported-form errors. **Static actual:** some forms are skipped/approximated or accepted by existence alone.

**Fix:** document a narrow supported grammar or implement the needed semantics, require regular files, and retain separate clean-tarball install tests. Do not market static existence checks as installation proof.

**Delivery:** Low/P3; 1–3 d; supported manifest contract; 4–6 weeks. Business value: avoids future packaging regressions and confusing false confidence.

### SK-21 — Authority index and verification claims need reconciliation

**Evidence:** `docs/STATUS.md:3–18` calls September 12 the only active plan and lists 21 vault notes; 22 Markdown notes were observed. `docs/PROJECT-REVIEW-2026-09-17.md:3–12` supersedes older failure narratives still present later in that report. `README.md:20,28–37` presents broad assurance labels; `docs/WHITEPAPER-v2.1.md` carries narrower caveats and older TS totals.

**Expected / actual:** a reader should identify one active backlog and distinguish specifications from executed, commit-specific evidence. Current documents can imply both completed remediation and unresolved release work, or current failure and later success.

**Reproduction plan:** follow only the status index, then compare it with the September 17 report's opening addendum and remaining-issues section. **Expected:** consistent navigation/status. **Observed actual:** the newer review is absent from the index; superseded results remain prominent in older sections.

**Fix:** maintainer classifies this catalog and historical reports, updates the authority index, and uses an evidence matrix with commit/tool/scope/pass/fail/skip/blocked. Retain history but visibly mark superseded claims. Do not reactivate the historical Vitest failure as a current reproduced bug: the report's later addendum records a successful run, while root cause remains unresolved. That run was not repeated here.

**Delivery:** Medium/P1 for release claims; 1–2 d; authority decision and fresh evidence when needed; before publication. Business value: credible assurance and fewer contradictory implementation instructions.

### SK-22 — Empty ABI and external-only wikilinks undermine portability

**Evidence:** `packages/core/abis/SessionKeyManagerSessionKey7579ModuleActionLog7579ExecutorSigilKitDelegator.json` is zero bytes. `vault/Memory Index.md:3–6` links to `sigilkit-project` and `sigilkit-whitepaper-verified`, explicitly described as living outside this vault; the local wikilink check could not resolve them.

**Expected / actual:** ABI JSON artifacts should be valid or explicitly excluded; vault navigation should make external dependencies usable and clear. A glob consumer can encounter invalid JSON, and a cloned vault cannot resolve the two bare wikilinks. Their absence is not proof the user's external notes are missing.

**Reproduction plan:** parse only the empty ABI fixture as JSON and open the two links from the cloned vault. **Expected:** valid artifact and resolvable or explicitly external references. **Observed actual:** zero-byte JSON is invalid; links have no local targets.

**Fix:** determine ABI provenance and intended consumer, then regenerate or remove only the obsolete artifact after review; add a nonempty/parseable artifact check. Replace external-only wikilinks with clearly described supported references or user-approved mirrored notes. Do not copy private external notes without authorization.

**Delivery:** Low/P3; 2–4 h; artifact/note ownership; next maintenance patch. Business value: cleaner packaging and portable project knowledge.

## 4. Performance evidence and measurement plan

**There is no valid current performance baseline from this review.** Do not invent response times, RSS numbers, throughput degradation, or speedups to complete a table.

The older consolidated report records invalid readbacks in `benchmark-node24.json` and a separate reviewer-reported microbenchmark of 3,790 ms versus 11 ms for 2,000 synthetic writes. Both are **historical claims**, not measurements performed here. The latter must not be presented as a shipped 345× improvement; the invalid disk fixture must not be used as a baseline.

| Issue | Established structural impact | Runtime metrics required | Proposed acceptance, not measured outcome |
|---|---|---|---|
| SK-07 | Per-event writes and separate cursor update; no surrounding sync transaction | Rows/s; p50/p95 batch commit ms; commits/batch; reader lock waits | Atomic batch/cursor; compare valid identical datasets before/after |
| SK-09 | 30 s TTL; default 5 s stale grace; no renewal | Guarded duration p95/p99; lost ownership; contention; renewal failures | Ownership invariants hold for documented operation durations |
| SK-16 | O(K) retained map entries across distinct key strings | Heap delta after completed callbacks; entry count | No idle-key retention; equivalent identities use one queue |
| SK-17 | O(L) accumulated RPC logs for complete range | Peak RSS/heap; time-to-first-commit; RPC calls; rows/s; lag | Configured chunk/queue bound; coherent restartable checkpoints |
| SK-18 | O(N) query result materialization and serialization | Query p50/p95; peak RSS; result bytes; rows visited/query plan | Capped page/result bytes; exact totals; no cross-page omissions |
| SK-19 | No application-level framing/dispatch/output bounds | Queue depth; buffered bytes; completed requests/s; shutdown ms | Explicit limits; bounded backpressure; no silent response loss |

**Benchmark protocol:** fix SK-13/SK-14 first; identify commit, source/build identity, Node/SQLite versions, OS/CPU/storage, journal mode, dataset shape, indexes, and insert/update mix. Use fresh owned bounded fixtures, warm-up separately, and repeated runs. Report medians and p95 only with sample counts and dispersion; three repetitions alone are weak tail-latency evidence. Capture correctness before accepting timing, and distinguish sampled memory from instrumented peak memory. Start small with explicit time/memory abort budgets; this is not a load-exhaustion exercise.

After a stable baseline, maintainers may adopt a **proposed 20% regression alert** on comparable environments. It is not an existing SLO and is not meaningful before baseline variance is known.

## 5. Follow-ups requiring confirmation, not additional proven defects

These keep inherited concerns visible without importing old reports as current facts. Their effort is an **investigation estimate**, not remediation sizing. Suggested severity is conditional on confirmation; CVSS is not assigned.

| ID | Concern / evidence source | Evidence needed and expected behavior | Conditional severity / priority | Investigation effort | Dependency / target |
|---|---|---|---|---|---|
| V-01 | Permissive `build_scope` defaults; prior report F07 | Inspect current default/empty-target handling and owner approval contract; default should be restrictive or explicitly owner-approved allow-all | High / P1 if confirmed | 2–4 h | Scope API decision; week 1 |
| V-02 | Caller-selectable MCP database path; prior report F15 | Confirm operator configuration and client trust boundary; only authorized database identities should be accessible | Medium / P2 if confirmed | 2–4 h | Allowed DB policy; before multi-user use |
| V-03 | SQLite reader/writer contention and index selection; F09/F17 | Inspect journal/busy policy and query plans; measure bounded concurrent reader/writer fixtures before assigning bottleneck numbers | Medium / P2 | 0.5–1 d | SK-07, valid fixtures; next minor |
| V-04 | Case-sensitive database address filters and cross-chain native totals; F14/F20 | Compare current storage/query normalization and per-chain unit semantics; equivalent addresses must match and unlike native units must stay separated | Medium / P2 if confirmed | 0.5–1 d | Migration/report contract; next minor |
| V-05 | Wallet harness accepts unrelated rejection or tautological assertions; F13 | Inspect current assertions and artifacts; green must require causally observed supported wallet behavior | High assurance / P1 if confirmed | 0.5–1 d | Pinned wallet fixture; before compatibility claims |
| V-06 | Formal/invariant coverage and countersign scope assumptions | Map each claimed property to assertions and current execution evidence; clarify approval identity/single-use semantics before declaring a replay defect | High assurance / P1 for stronger claims | 1–2 d | Written threat model, SK-03/SK-04; pre-release |
| V-07 | Distribution identity, npm namespace, Windows wrappers, clean-install/container proof; F12/F22/F23 | Maintainer confirms owned namespace/repository; clean supported-platform and tarball/container checks establish actual delivery behavior | High distribution / P1 for publish | 1–2 d + owner wait | Owner decisions, SK-11/SK-12; pre-publish |
| V-08 | Configuration precedence, logger schema/newlines, duplicated validation/error contracts; F18/F19/F25 | Inspect current intended contracts; ordinary local fixtures should preserve numeric log fields, line framing, consistent config/errors | Low–Medium / P2 if confirmed | 0.5–1 d | SK-02, stable public schema; next minor |

## 6. Remediation sequence and business trade-offs

### Today: contain risk, without broad refactoring

1. SK-01: credential-owner containment and sharing exclusions; preserve project data.
2. Restrict supported use: no production ERC-7579 compatibility claim pending SK-03/SK-04; no shared-key multi-process guarantee pending SK-09; no valid benchmark claim pending SK-13/SK-14.
3. Assign owners and approve required release checks. Decide whether this catalog becomes the active backlog through SK-21.

### First working week: bounded reliability and release fixes

- Core: SK-02 and SK-05; begin SK-09 design.
- Indexer: SK-06 → SK-07 → SK-08. Review as separate small changes with a shared consistency specification.
- Release/tooling: SK-11 → SK-12/SK-15; SK-13/SK-14 before new measurements.
- Documentation: SK-21 updates evidence and support boundaries, not unsupported green badges.

These are parallel workstreams, **not a claim one engineer can finish the entire list in a week**.

### Following cycles

- Contracts/account integration: SK-04 and SK-03 together, with dedicated review before release.
- Fleet/demo: SK-09 and SK-10; do not claim safe whole-process compromise based only on session-key caps.
- Scaling: SK-17 → SK-18 → SK-19 after storage correctness. SK-16 is a small independent patch coordinated with the lease API.
- Maintenance: SK-20/SK-22 and confirmed V-items. Defer broad shared-code refactors until urgent behavior is stable.

### Required closure evidence

Each issue closes only with: owner and decision; reviewed patch; regression acceptance results; source/build commit identity; supported deployment assumptions; updated user-facing contract; and remaining limitations. Mark a mitigation as **mitigated**, not **fixed**, when the defect remains but the affected mode is disabled.

For affected releases require: no unresolved P0/P1 in promoted capabilities; clean-checkout build/typecheck; passing exact-commit required checks with skipped/blocked states explicit; valid install artifacts; redacted secret-handling review; coherent audit/checkpoint semantics; safe lease topology; and version-specific account/wallet evidence. Contract changes also need independent security review proportional to risk.

## 7. Coverage and provenance limits

The preceding review read all 26 project Solidity files, first-party core SDK/harness/configuration, all 30 discovered service-package source/test/config/README files, all 19 scripts, all 11 then-existing docs, all 22 vault notes plus its Obsidian config, and relevant root/hidden configuration. The original whitepaper text was read, not the PDF's visual content. Some delegated output was truncated; it is not a complete retained per-file proof ledger.

Dependencies, vendored wallet bundles, generated artifacts, Git internals, binary/database contents, and all historical output/vendor files were **not fully audited**. No current dependency vulnerability scan, real-account execution, external audit, or benchmark baseline is established. The user's “nothing left” objective therefore remains broader than the completed source review.

The vault was used as design context: its README labels research non-normative, and superseded Diamond/custom multi-RPC plans are not missing implementation requirements. `vault/Memory Index.md` explains the external-memory links. The September 17 consolidated report is historical evidence with its opening addendum taking precedence over older status text inside it; its previous executions are not reclassified as executions of this catalog task.
