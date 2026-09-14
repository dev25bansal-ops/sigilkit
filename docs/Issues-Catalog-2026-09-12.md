# SigilKit — Issues Catalog (2026-09-12)

**Scope:** full-repository review — `contracts/` (src, test, script), `packages/*` (core, indexer, mcp, demo-agent),
`vectors/`, `vault/`, `docs/`, all CI workflows, build/tooling config, and packaging metadata.
**Method:** every file read; findings reproduced against a live toolchain (Foundry 1.7.x, Node 22.22.2, PyYAML 6.x, viem 2.x).
**Relationship to prior work:** supersedes `docs/Issues-Catalog-2026-09-11.md` (23/24 closed) and audits the
2026-09-12 enhancement wave (E1–E20, 19/20 implemented). Items here are **net-new** unless flagged `[REOPEN]`.

---

## 0. Verified baseline (evidence for the claims below)

| Signal | Command | Result |
|---|---|---|
| Foundry unit + fuzz | `forge test --no-match-contract '.*Invariant\|.*Fork'` | **86 / 86 passed** (9 suites) |
| Foundry invariant | `forge test --match-contract '.*Invariant'` | passed (4 suites) |
| TS core | `npm test --workspace @sigilkit/core` | **67 passed, 1 skipped** (~73 s) |
| TS indexer | `npm test --workspace @sigilkit/indexer` | 3 passed |
| TS mcp | `npm test --workspace @sigilkit/mcp` | 5 passed |
| Dependencies | `npm audit` | **0 vulnerabilities** |
| Contract sizes | `forge build --sizes` | SessionKeyManager 10,291 B · SigilKitDelegator 10,560 B · SessionKey7579Module 7,998 B (limit 24,576 B) |
| Compiler warnings | `forge build` | 4 × `block-timestamp`, 6 × `unsafe-typecast` |
| CI workflow validity | `python -c "import yaml;yaml.safe_load(open('.github/workflows/ci.yml'))"` | **ScannerError — invalid YAML** |
| Git | `git remote -v` | empty (no remote; branch `master`, 125 tracked files) |

**Legend**
*Severity* = business/risk impact. *Priority* = severity × operational urgency (P0 ship-blocker → P3 backlog).
*Effort* = engineering hours (h) or days (d) for a competent contributor.

---

## 1. Bugs

### BUG-1 — CI workflow is syntactically invalid; **every job is dead** — Critical / P0

**File:** `.github/workflows/ci.yml` lines 183–190 (`wallet-e2e-weekly`).

```yaml
      - run: npx tsx test/wallet-e2e/run-all.ts
        working-directory: packages/core
           - uses: actions/upload-artifact@v4      # ← 11 spaces; siblings use 8
        if: always()
        with:
          name: wallet-e2e-log
```

**Reproduction**
```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
# yaml.scanner.ScannerError: mapping values are not allowed here
#   in ".github/workflows/ci.yml", line 185, column 18
```

**Expected:** a valid workflow with 10 jobs.
**Actual:** the document does not parse. GitHub Actions rejects the *whole file* with
`Invalid workflow file` — it does not skip the offending step. Therefore **all 10 jobs are
inactive**: `forge-unit`, `forge-invariant`, `slither`, `ts-sdk`, `forge-deep-fuzz`,
`forge-fork-base`, `halmos`, `wallet-e2e-weekly`, `echidna-nightly`, `foundry-canary`.

**Impact:** the repository currently has **zero enforced CI**. Every green badge, the
ABI-drift gate (E5), the Slither `--fail-high` gate, and the coverage gate are all no-ops.
This also silently invalidates the CHANGELOG claim that 23/24 catalog issues were "closed in
code" — the gates that verify them never ran. Highest-impact single defect in the repo.

**Fix:** re-indent the step to 8 spaces:
```yaml
      - run: npx tsx test/wallet-e2e/run-all.ts
        working-directory: packages/core
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: wallet-e2e-log
          path: packages/core/test-results/
          if-no-files-found: ignore
```
**Dependencies:** none. **Effort:** 0.25 h. **Timeline:** immediately, before any push.
**Prevention:** add a `yaml-lint` / `actionlint` step (see CQ-1) — this class of error is
mechanically detectable.

---

### BUG-2 — ABI drift gate omits `SigilKitDelegator` — High / P1

**Files:** `.github/workflows/ci.yml` lines 90–96 vs `packages/core/test/abi-drift.test.ts` lines 15–20.

CI regenerates three ABIs:
```bash
for c in SessionKeyManager SessionKey7579Module ActionLog7579Executor; do ...
```
but the test *consumes* four:
```ts
const GENERATOR_ABI_NAMES = ["SessionKeyManager","SessionKey7579Module","ActionLog7579Executor","SigilKitDelegator"];
```
and `packages/core/abis/SigilKitDelegator.json` (16,962 B) is committed.

**Reproduction:** add/rename an event or error in `contracts/src/SigilKitDelegator.sol`, push.
CI's regeneration loop skips the file, so `git diff --exit-code packages/core/abis` stays
clean and `abi-drift.test.ts` still passes (it only asserts *presence* of fragments, not
*freshness* of the file).

**Expected:** any contract change that alters an ABI fails the drift gate.
**Actual:** `SigilKitDelegator` ABI drift passes silently; `src/abis.ts` can diverge from the
deployed implementation, breaking `decodeSigilKitError` / event decoding for the EIP-7702
native-wallet path — the newest and least-tested surface (E13).
**Fix:** add `SigilKitDelegator` to the loop; derive the list from a single source
(e.g. a `scripts/abi-targets.txt` read by both the loop and the test).
**Dependencies:** BUG-1 (CI must be valid to matter). **Effort:** 0.5 h. **Timeline:** with BUG-1.

---

### BUG-3 — `validateAgainstScope` off-by-one on `scope.expiresAt` — Medium / P2

**Files:** `packages/core/src/signing.ts:294` vs `contracts/src/SessionKeyManager.sol:277`.

```ts
if (nowSec >= scope.expiresAt) return { ok: false, reason: "scope expired" };   // local: rejects AT expiresAt
```
```solidity
if (block.timestamp > scope.expiresAt) revert KeyExpired();                     // chain: allows AT expiresAt (INV-2)
```

**Reproduction:** grant a session key with `expiresAt = T`; at exactly `t = T` (same second),
`validateAgainstScope` returns `ok:false`, while `executeWithSessionKey` succeeds on-chain.

**Expected:** byte-identical boundary semantics between the advisory validator and the
enforcement core — the whole point of the golden-vector corpus (E7) is conformance.
**Actual:** a one-second window where the client refuses a transaction the chain would accept
(false negative). It is fail-safe, but it is a real divergence and the file's own comment at
line 313 asserts parity that does not hold for this check.
**Fix:** change to `if (nowSec > scope.expiresAt)`. Add a golden vector pinning
`t == expiresAt` for both sides.
**Dependencies:** none. **Effort:** 1 h (incl. vector + test). **Timeline:** next patch.

---

### BUG-4 — `checkTokenPath` queries the wrong spender for `transferFrom` — Medium / P2

**File:** `packages/core/src/client.ts:342` (inside `push`, called at :375).

```ts
args: kind === "balance" ? [holder] : [holder, request.target],
```

For `transferFrom(from, to, amount)` executed **by the manager**, the allowance that matters is
`allowance(from, msg.sender == managerAddress)`. The code instead reads
`allowance(from, request.target)` — i.e. *the token contract itself as spender* — which is
~always 0.

**Reproduction:** deploy an ERC-20, `approve(manager, X)`, then run `checkTokenPath` on a
`transferFrom` request whose `from == managerAddress`. Observe
`{ kind: "allowance", ok: false, detail: "allowance 0 vs amount X" }`.

**Expected:** `ok: true` when the manager has sufficient allowance.
**Actual:** a spurious advisory warning on the common happy path — the mitigation advertised in
`SECURITY.md` and CHANGELOG (E8) is wrong on its primary branch. Compounding: the inline ABI
declares `allowance` with a **single** `holder` input (a `balanceOf`-shaped signature) and is
force-cast `as never`, so the encoder is silently mis-specified.
**Fix:** `args: [holder, this.managerAddress]`; give `allowance` its own correct two-input ABI
fragment; delete the `as never` cast.
**Dependencies:** none. **Effort:** 1.5 h (incl. a test with a mock token). **Timeline:** next patch.

---

### BUG-5 — Indexer `actions` primary key silently drops distinct audits — Medium / P2

**File:** `packages/indexer/src/indexer.ts:54–65, 85`.

```sql
CREATE TABLE IF NOT EXISTS actions ( ..., value TEXT NOT NULL, rationale_hash TEXT NOT NULL, ts INTEGER NOT NULL, ...
  PRIMARY KEY (tx_hash, agent_id, target, selector, ts) );
-- writes: INSERT OR IGNORE INTO actions ...
```

`value` and `rationale_hash` are **not** in the key. Two audited actions in one transaction
with the same agent/target/selector and the same block timestamp collide, and `INSERT OR IGNORE`
discards the second.

**Reproduction:** index a tx containing two `transfer(token, 1 wei)` calls to the same target by
the same key (a legal batch); `SELECT count(*) FROM actions` returns 1.

**Expected:** one row per emitted `ActionLogged` — the contract guarantees a per-action audit
event (INV-3), so the index must be lossless.
**Actual:** audit rows are silently dropped. For a toolkit whose headline promise is a
*mandatory audit trail per action*, an index that under-counts is a correctness defect in the
product's core value proposition, not a cosmetic one.
**Fix:** widen the PK to include `value` and `rationale_hash` (or use the log index
`log_index` / `block_number`+`tx_index` as the natural key — the most robust option).
**Dependencies:** BUG-6 (same migration). **Effort:** 2 h + migration note. **Timeline:** next patch.

---

### BUG-6 — `window_charges` has no uniqueness constraint; re-ingest duplicates rows — Medium / P2

**File:** `packages/indexer/src/indexer.ts:66–74, 105`.

`window_charges` has no `PRIMARY KEY`/`UNIQUE`, and is written with a plain `INSERT INTO`.
Re-indexing the same block range (a normal operation after a restart, a reorg, or a backfill)
inserts the rows again.

**Reproduction:** `indexRange(a, b)` twice, then run the `spend` report → cumulative
`spentThisWindow` doubles.

**Expected:** idempotent ingest (`INSERT ... ON CONFLICT DO UPDATE` on a natural key such as
`(tx_hash, account, key, window_start)`).
**Actual:** doubled spend figures in every downstream report and in the MCP `audit_query`
`spend` output — a reconciliation figure that silently inflates is worse than no figure.
**Fix:** add the unique constraint + upsert. **Dependencies:** BUG-5. **Effort:** 2 h.
**Timeline:** next patch.

---

### BUG-7 — `watch()` never persists its cursor; restarts lose or replay blocks — Medium / P2

**File:** `packages/indexer/src/indexer.ts:163–179`.

```ts
watch(client, managerAddress, pollMs = 4000) {
  let lastBlock = 0n;                       // local; never persisted
  ... if (lastBlock === 0n) lastBlock = head; // start from "now" on every process start
```

**Reproduction:** start `watch()`, mine a block, kill the process, restart → the block mined
while the watcher was down is never indexed (the cursor resets to "now"). Conversely, if the
process is restarted within the same head, it re-scans and (with BUG-6) duplicates rows.

**Expected:** a persisted high-water mark (a `sync_state` row), so restart is exactly-once.
**Actual:** silent data loss on the first branch, duplicate data on the second.
**Fix:** persist `lastBlock` in a `sync_state` table; make `indexRange` idempotent (BUG-6).
**Dependencies:** BUG-6. **Effort:** 3 h. **Timeline:** next patch.

---

### BUG-8 — Stale counts and mojibake across README / CHANGELOG / whitepaper — Low / P2

| Location | Says | Reality |
|---|---|---|
| `README.md:80` | `npm test  # 54 unit + fuzz tests` | **86** |
| `README.md:17` | wallet-e2e harnesses "(manual; **CI wiring pending**)" | CI job `wallet-e2e-weekly` exists (ci.yml:162) |
| `CHANGELOG.md:91` | "**55** Foundry tests: 54 unit/fuzz + 4 invariant suites + 1" | **86** unit/fuzz; the arithmetic doesn't even close (54+4+1≠55) |
| `docs/WHITEPAPER-v2.1.md:64` | "**38** Foundry tests … **6-job** CI" | 86 tests; **10** jobs |
| `README.md:78` | `git clone —depth 1 …` | mojibake: em-dash where `--` belongs; copy-paste breaks the command |

**Reproduction:** `grep -n "54 unit\|55 Foundry\|38 Foundry\|—depth" README.md CHANGELOG.md docs/WHITEPAPER-v2.1.md`.

**Expected:** docs state the measured numbers, generated from a single source.
**Actual:** a reviewer's first credibility check ("do the claimed tests exist?") fails, and the
one copy-pasteable install command is broken. The whitepaper is the artifact most likely to be
read by an auditor or grant reviewer.
**Fix:** correct the four numbers; fix `—depth` → `--depth`; add a `docs:check` script that
greps the counts out of a real `forge test` run (see TD-4).
**Dependencies:** none. **Effort:** 1 h. **Timeline:** next patch.

---

### BUG-9 — MCP `audit_query` is not read-only despite declaring so — Low / P3

**Files:** `packages/mcp/src/server.ts:138–154`; `packages/indexer/src/indexer.ts:49–79`.

Tool description (line 140): *"…or a summary. **Read-only.**"* But `audit_query` constructs a
`SigilIndexer`, whose constructor runs
`CREATE TABLE IF NOT EXISTS` × 2, `CREATE INDEX IF NOT EXISTS` × 3, and
`mkdirSync(dirname(dbPath), { recursive: true })`.

**Reproduction:** point `audit_query` at an existing **empty** SQLite file → the file gains five
schema objects; point it at a path in a non-existent directory → the directory is created.

**Expected:** a tool advertised read-only performs no writes (open the DB with
`readOnly: true`, or use `PRAGMA query_only`).
**Actual:** an MCP client that trusts the description will mount the DB read-only and the tool
will fail — or, worse, will mutate an artifact the caller believed immutable. Declared-behavior
violations are a trust problem for an MCP surface consumed by autonomous agents.
**Fix:** add a read-only open mode to `SigilIndexer` (or a `SigilIndexerReader`) used by the MCP
tool; keep the writable path for the indexer CLI.
**Dependencies:** none. **Effort:** 2 h. **Timeline:** next patch.

---

## 2. Performance bottlenecks

### PERF-1 — `checkTokenPath` issues redundant and sequential RPC round-trips — Medium / P2

**File:** `packages/core/src/client.ts:326–379`.

* `decimals()` is fetched inside **every** `push()` call and the result is discarded
  (`const [token, decoded] = …; void token;`) — pure dead round-trip, once per check.
* `push()` calls are `await`ed **sequentially**; a `transferFrom` from the manager runs
  `push("balance")` then `push("allowance")` — two serial waits, each itself a
  `Promise.all` of two reads.
* Worst case for one request: **4 RPC round-trips** where 2 suffice, serialized.

**Measurable impact:** against a typical 150–250 ms public RPC, a `transferFrom` pre-check adds
**~600–1,000 ms** of latency to a pre-flight that is documented as advisory; on a 1 s
congested RPC it exceeds 4 s. Throughput: an agent batching N requests pays this per request,
serially, because nothing is memoized across calls.
**Fix:** drop the `decimals()` call (unused); hoist a per-`client` `decimals` cache keyed by
token; issue the two `push`es concurrently; consider a multicall.
**Dependencies:** BUG-4 (fix both in one edit). **Effort:** 2 h. **Timeline:** next patch.

---

### PERF-2 — TS core suite is import-bound, not execution-bound — Medium / P3

**Evidence:** measured `npm test --workspace @sigilkit/core` ≈ **73 s**, of which ~**69 %** is
module graph load/collect (viem + barrel imports) rather than test bodies.

**Impact:** slow local feedback loop; the `ts-sdk` CI job's wall-clock is dominated by import
cost, and this cost is paid twice in the job (`npm test` **and** `npm run test:coverage`).
**Fix:** replace `src/index.ts` barrel re-exports in tests with deep imports; enable vitest
`isolate: false` for the pure modules; consider `pool: 'threads'` tuning. Target: < 40 s.
**Dependencies:** none. **Effort:** 3 h. **Timeline:** opportunistic.

---

### PERF-3 — `simulateExecution` re-runs the full pre-flight — Low / P2

**File:** `packages/core/src/client.ts:387–406` (line 391 calls `prepareExecution` again).

The documented flow is *simulate → execute*. Each call to `simulateExecution` performs its own
`prepareExecution` (nonce read + `getWindowState` read), and the subsequent `execute()` performs
another. Net effect: the nonce/window reads and the encoding work are done **twice** for the
recommended safe path, and the second nonce read can differ from the first (a TOCTOU-shaped
window that the local validator will not catch).

**Measurable impact:** ~2× pre-flight RPC cost on the recommended path; on a 200 ms RPC,
~400 ms of avoidable latency plus a widened nonce race.
**Fix:** return the prepared payload from `simulateExecution` (or accept an already-prepared
payload) and thread it into `execute`; or add `executeSimulated()` that prepares once.
**Dependencies:** none. **Effort:** 3 h. **Timeline:** next minor.

---

### PERF-4 — No gas snapshot exists; whitelisted batching gas is unmeasured — Medium / P2

**Evidence:** no `.gas-snapshot`, no `forge snapshot` in CI, no gas assertions in any test.

`SessionKey7579Module` verifies **per-tuple** Merkle proofs (E16) with
`MAX_BATCH_SIZE = 8` and `MAX_TOTAL_PROOF_ELEMENTS = 32`. Each tuple costs O(tree depth)
`keccak256` operations plus sorted-pair hashing, so verification gas grows linearly with batch
size × depth.

**Impact:** ERC-4337 `validateUserOp` has a hard, bundler-enforced verification-gas ceiling
(commonly ~150–200k on Base-class chains, and per-bundler policy). With no gas test, a
regression — or simply a deeper tree or a full 8-tuple batch — can push validation past the
ceiling and cause **silent bundler rejection in production**, with no CI signal. The
`MAX_TOTAL_PROOF_ELEMENTS = 32` cap is a static proxy for a gas bound that was never measured.
**Fix:** add `forge snapshot` + `assertLt(gasleft-before, budget)` tests for: worst-case
8-tuple batch at max depth, and the `MAX_TOTAL_PROOF_ELEMENTS` boundary. Publish the table in
README. **Dependencies:** none. **Effort:** 1 d. **Timeline:** before any mainnet/4337 launch.

---

### PERF-5 — `watch()` polls with unbounded `getLogs` ranges and no backoff — Low / P3

**File:** `packages/indexer/src/indexer.ts:163–179` (`pollMs = 4000`, `fromBlock: lastBlock + 1n`).

No chunking of the `[lastBlock+1, head]` range and no backoff. Most providers cap `eth_getLogs`
by block span or result count; after any downtime the catch-up range is large by construction
(compounded by BUG-7's unpersisted cursor, which resets to "now" and hides the problem until a
reorg). A failed `getLogs` in the loop is not retried with backoff.
**Impact:** the watcher fails hard on catch-up instead of degrading; reliability risk for the
audit-trail pipeline. **Fix:** chunk ranges (e.g. 2k blocks), exponential backoff, and a
persisted cursor (BUG-7). **Dependencies:** BUG-7. **Effort:** 4 h. **Timeline:** next minor.

---

## 3. Security vulnerabilities

> **Scope note:** the on-chain enforcement core is in unusually good shape — Checks-Effects-
> Interactions, `nonReentrant` on the payable entrypoint, EIP-2 low-`s` rejection, owner-only
> selectors denylisted in the constructor, ERC-7201 namespaced storage, and 86 passing tests
> plus invariant/Echidna/Halmos layers. **No exploitable on-chain vulnerability was found.**
> The findings below are trust, packaging, and audit-integrity issues.

### SEC-1 — Whitepaper describes the toolkit as "audited"; no external audit has occurred — High / P1

**File:** `docs/WHITEPAPER-v2.1.md:11`.

> "SigilKit is an open-source (MIT), **audited** toolkit for agent-native wallets…"

The same document, 56 lines later (line 67), lists the external audit as outstanding:
*"Remaining before public launch: external audit (Cantina/Sherlock + private review)…"*
`README.md:128` likewise presents the audit route as future work.

**CVSS:** not applicable (documentation/misrepresentation, not a software defect).
**Impact:** integrators, grant reviewers, and auditors reading the abstract will believe the
contracts have been reviewed by a third party. For a wallet-class toolkit handling spend
authority, that is a material misstatement with legal and reputational exposure — and it is the
single sentence most likely to be quoted out of context.
**Fix:** replace "audited" with "built for audit" / "with formal verification of the spend-policy
core (Halmos) and an independent audit in progress"; add an explicit status line at the top of
the document. **Dependencies:** none. **Effort:** 0.5 h. **Timeline:** immediately.

---

### SEC-2 — Wildcard internal dependency + no `engines` in published packages — Medium / P2

**Files:** `packages/{indexer,mcp,demo-agent}/package.json` — `"@sigilkit/core": "*"`.
Only the **root** declares `engines.node >= 24`; no workspace package does.

**Impact (supply chain):** when `@sigilkit/indexer` / `@sigilkit/mcp` are published, `"*"`
resolves to *whatever `@sigilkit/core` version is newest at install time* — including a future
breaking major. A consumer cannot reproduce a working install, and a compromised or regressed
core release propagates without any version gate. Separately, `node:sqlite` requires Node ≥ 22.5
(stable ≥ 24), yet no published package advertises a Node floor, so consumers on Node 20 install
successfully and fail at runtime.
**Fix:** pin `"@sigilkit/core": "^0.1.0"` (workspace protocol at dev time, semver on publish);
add `engines.node: ">=24"` and `publishConfig.access: "public"` to every published package.
**Dependencies:** ARCH-1. **Effort:** 2 h. **Timeline:** before first npm publish.

---

### SEC-3 — Empty-calldata audit selector collapses to `0x00000000`; `setAgentId` gated only by self-call — Medium / P3

**File:** `contracts/src/ActionLog7579Executor.sol` (`bytes4(callData)` for the audited selector).

`bytes4(callData)` on empty calldata zero-pads to `0x00000000`. That value collides with the
common `0x00000000` sentinel / ERC-165 `supportsInterface` first-selector space, so an audited
action with no calldata is indistinguishable in the log from a call whose selector is literally
zero. Downstream attribution (indexer, `audit_query`) cannot tell them apart.
*(Verified empirically: `bytes4(bytes)` right-pads, so 0 bytes → `0x00000000` and 2 bytes →
`0xab000000`; see the scratch Foundry check.)*

`setAgentId` is reachable only when `msg.sender == account` (the account calling its own
executor), which is correct for the module trust model, but it means agent identity for the
audit trail is **self-asserted** — an account can relabel its own agent id at will, and there is
no event/ownership check on the new value.

**Impact:** audit-trail ambiguity and unauthenticated (though self-scoped) agent labeling — a
data-integrity concern for the "who did what" guarantee, not a fund-loss vector.
**Fix:** for empty calldata, emit an explicit `bytes4(0)`-documented sentinel or log the full
`callData` hash instead; document the `setAgentId` trust boundary in `SECURITY.md`.
**Dependencies:** none. **Effort:** 3 h. **Timeline:** next minor.

---

### SEC-4 — Well-known Anvil private keys committed in source; no secret scanning in CI — Low / P3

**File:** `packages/demo-agent/src/cli.ts:24–25`.

```ts
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1
```

These are the canonical public Anvil dev keys and are correctly scoped to a local demo, but:
(a) any secret scanner (gitleaks/trufflehog/GitHub push protection) will flag them, and
(b) the pattern teaches copy-paste of inline key literals into production scripts.
There is **no secret-scanning job** in CI (`grep -rn gitleaks .github/workflows/` → no hits).
**Fix:** read from `process.env` with the Anvil defaults as a documented fallback; add a
`.gitleaks.toml` allowlist for the two Anvil keys; add a `gitleaks` CI job.
**Dependencies:** BUG-1. **Effort:** 2 h. **Timeline:** next patch.

---

### SEC-5 — `test_RejectsWrongSigner` asserts a bare revert with no reason pinned — Low / P3

**Evidence:** the test reverts with `EvmError: Revert` and **no reason data**, so the assertion
is effectively `expectRevert()` with no selector.

**Impact:** the negative test would still pass if the contract reverted for the *wrong* reason
(e.g. a nonce error, a cap error, or an out-of-gas style failure), so it does not actually prove
that a wrong signer is rejected by signature recovery. This is the highest-value negative test in
the suite (it guards the core "agent key is untrusted" claim) and it is the weakest assertion.
**Fix:** pin the expected custom error (e.g. `InvalidSignature`) via
`vm.expectRevert(SessionKeyManager.InvalidSignature.selector)`.
**Dependencies:** none. **Effort:** 0.5 h. **Timeline:** next patch.

---

### SEC-6 — `SigilKitDelegator` implementation is deployed inert; takeover path must stay documented — Low / P3

**File:** `contracts/src/SigilKitDelegator.sol` (constructor passes `address(this)` to
`SessionKeyManager`), with `initializeSelfOwned()` as a one-shot.

The implementation contract (the delegation *target*) has `owner == itself` and is intentionally
inert. This is correct design for EIP-7702 — but the risk is that the **implementation address
itself** is ever initialized (if the one-shot guard were bypassable) or that an integrator points
a delegation at a *proxy* rather than the implementation.
**Assessment:** the one-shot `initializeSelfOwned()` guard holds; this is informational. Action:
document explicitly in `SECURITY.md` that the implementation address must never be initialized,
and add a regression test asserting `initializeSelfOwned()` reverts on second call and that the
implementation has no owner-controlled state.
**Dependencies:** none. **Effort:** 1 h. **Timeline:** opportunistic.

---

## 4. Code quality issues

### CQ-1 — Ten compiler warnings are ungated; CI never denies warnings — Medium / P2

**Evidence:** `forge build` emits 4 × `block-timestamp` and 6 × `unsafe-typecast`:

| Warning | Locations |
|---|---|
| `block-timestamp` | `SpendPolicy.sol:64`; `SessionKey7579Module.sol:168`; `SessionKeyManager.sol:217, 229` |
| `unsafe-typecast` | `DeployDeterministic.s.sol:43`; `ActionLog7579Executor.sol:94`; `GoldenVectors.t.sol:122`; `SessionKey7579Module.t.sol:284, 588, 598` |

`forge build --sizes` runs in CI (ci.yml:37) but there is no `--deny-warnings`, and no
`foundry.toml` lint severity gate.

**Impact:** the two `unsafe-typecast` warnings in **production** code
(`ActionLog7579Executor.sol:94` is the `bytes4` truncation of SEC-3) are exactly the class of
warning that should block a merge in a wallet toolkit. `block-timestamp` in a spend policy is
intentional (windows are time-based) but that intent is not recorded, so it reads as an oversight
to any reviewer or auditor. Warning count only grows.
**Fix:** add `[profile.ci] deny_warnings = true` (or a `forge build --deny-warnings` step);
annotate the intentional `block.timestamp` uses with a `// intentional: time-based window`
comment; fix or explicitly justify each `unsafe-typecast` with a `// safe: …` note plus a
range assertion where applicable.
**Dependencies:** BUG-1. **Effort:** 4 h. **Timeline:** next patch.

---

### CQ-2 — Type-safety escape hatches and dead code in `checkTokenPath` — Medium / P2

**File:** `packages/core/src/client.ts:328–363`.

* `const [token, decoded] = await Promise.all([…decimals…, …balanceOf/allowance…]); void token;`
  — a live RPC call whose result is explicitly discarded (dead code *and* a live cost, PERF-1).
* `args: … : [holder, request.target] } as never` — the `as never` cast suppresses the type
  error that would have caught BUG-4.
* The `allowance` ABI fragment is declared with a single `holder` input (a `balanceOf` shape)
  and reused for both calls.

**Impact:** the cast is precisely what allowed a wrong-argument bug to ship; the dead
`decimals()` read adds latency for nothing. In a package whose stated selling point is
cross-language conformance, type-safety escapes undermine the guarantee.
**Fix:** remove the `decimals` call; correct and separate the ABI fragments; delete `as never`.
**Dependencies:** BUG-4. **Effort:** 1.5 h (shared with BUG-4). **Timeline:** next patch.

---

### CQ-3 — CI covers only part of the test surface — Medium / P2

**File:** `.github/workflows/ci.yml:82–87`.

The `ts-sdk` job runs:
```bash
npm run lint --workspace @sigilkit/core
npm run lint --workspace @sigilkit/demo-agent
npm run lint --workspace @sigilkit/indexer          # ← mcp omitted
npm run build --workspaces
npm test --workspace @sigilkit/core                 # ← indexer + mcp tests never run
npm run test:coverage --workspace @sigilkit/core
```

**Impact:** `@sigilkit/mcp` is never linted in CI; the **8 test files** in `packages/indexer/test`
and `packages/mcp/test` (3 + 5 tests) are never executed in CI — a change to the indexer schema
or an MCP tool can merge red-free. (Note `publish.yml:33` *does* run `npm run lint --workspaces`,
so the two workflows disagree on the gate.) The irony is sharp: the ungated packages are the ones
carrying BUG-5/6/7 and BUG-9.
**Fix:** `npm test --workspaces --if-present` and `npm run lint --workspaces` in `ts-sdk`; make
`publish.yml` reuse the same commands. **Dependencies:** BUG-1. **Effort:** 1 h. **Timeline:** with BUG-1.

---

### CQ-4 — `demo-agent` has no tests at all — Low / P3

**Evidence:** `packages/demo-agent/package.json` has no `test` script and no `test/` directory.
The root script uses `--if-present`, so the gap is silent.

**Impact:** the demo CLI (the primary "does this thing work?" artifact for a newcomer) and the
E20 fleet runner are entirely untested; a regression there breaks the first-run experience that
the README leads with. **Fix:** add a smoke test that deploys against Anvil and asserts the two
documented rebalance actions emit `ActionLogged`. **Dependencies:** none. **Effort:** 1 d.
**Timeline:** next minor.

---

### CQ-5 — Comment asserts a conformance parity that does not hold — Low / P3

**File:** `packages/core/src/client.ts:313–316` and `signing.ts:278–294`.

The comment at `client.ts:313` correctly states the request-expiry mirror
(`block.timestamp > request.expiry`), but it sits directly beneath a scope-expiry check that
does **not** mirror the contract (BUG-3). A reader is told parity holds for the pair of checks
when it holds for only one.
**Fix:** fix BUG-3 and state the boundary explicitly (`now > expiresAt`, inclusive expiry).
**Dependencies:** BUG-3. **Effort:** 0.25 h. **Timeline:** with BUG-3.

---

### CQ-6 — Repository hygiene: large ignored artifacts and tracked binaries — Low / P3

* `packages/core/test/wallet-e2e/` holds `metamask.zip` (**21.7 MB**), an extracted `metamask/`
  tree, `.playwright-profile/`, and `test-dapp-main/`. All are correctly gitignored
  (`.gitignore:40–44`) but consume substantial disk on every developer machine, and CI
  re-downloads the 21.7 MB zip and re-unzips it on every weekly run.
* `SigilKit_Whitepaper.pdf` (**1.51 MB**) and `SigilKit_Whitepaper.txt` (63 KB) are **tracked**
  in git; a binary PDF in the history is permanent bloat with no diff value.

**Fix:** cache the MetaMask download in CI (`actions/cache` keyed on the pinned version); move
the PDF to a release asset or Git LFS and keep the `.txt`/`.md` as the diffable source.
**Dependencies:** none. **Effort:** 2 h. **Timeline:** opportunistic.

---

## 5. Architectural problems

### ARCH-1 — Release topology is incomplete: only `@sigilkit/core` is publishable — High / P1

**File:** `.github/workflows/publish.yml` (single job `publish-core`).

`publish.yml` publishes **only** `@sigilkit/core`. Yet `README.md` and `CHANGELOG.md` advertise
`@sigilkit/indexer` (E9) and `@sigilkit/mcp` (E14) as shipped deliverables, and the dependency
graph is `mcp → indexer → core`.

**Impact on extensibility/adoption:** the MCP server — the package explicitly built so agent
frameworks can consume SigilKit — cannot be installed from npm. `npx @sigilkit/mcp` fails; a
consumer must clone the monorepo and build locally. The advertised "installable via
`forge install` / npm" story (whitepaper line 22) is therefore **half-true**: contracts install
from git, but two of the four packages do not install from npm at all.
**Fix:** add `publish-indexer` and `publish-mcp` jobs (ordered after core, since they depend on
it), or a single matrix job publishing all three with `--provenance`. Add a `packages/*/package.json`
`publishConfig` and verify each with `npm pack --dry-run`.
**Dependencies:** SEC-2 (version pinning), ARCH-5. **Effort:** 4 h. **Timeline:** before public launch.

---

### ARCH-2 — The audit-trail pipeline has no reorg/finality policy — Medium / P2

**Files:** `packages/indexer/src/indexer.ts` (`block_number` stored; no `removed` handling; no
finality tag).

The on-chain side is sound: `ActionLogged` is emitted atomically with execution (INV-3). The
**off-chain consumer** that turns those events into queryable state has no reorg strategy —
`getLogs` results with `removed: true` are not handled, no confirmation depth is configured, and
`block_number` is stored but never used to roll back.

**Impact on reliability:** after a reorg, the index contains orphaned rows and (via BUG-6)
duplicated rows for the surviving branch. Since the indexer is the substrate for the
`audit_query` MCP tool and the `spend` report, a reorg silently corrupts the reconciliation
figures an operator would use to detect overspend. For a product whose differentiator is a
*trustworthy* audit trail, the durable layer must be as reorg-aware as the event layer.
**Fix:** index against a `finalized` block tag (or a configurable depth), handle `removed` logs
with a delete/rollback, and add a reorg test.
**Dependencies:** BUG-5, BUG-6, BUG-7. **Effort:** 2 d. **Timeline:** before mainnet launch.

---

### ARCH-3 — `watch()` is a bare polling loop with no resilience policy — Medium / P3

No backoff, no chunking, no reconnection semantics, no provider-failover — unlike the `Multi-RPC`
concerns the whitepaper explicitly de-scoped (line 30) on the grounds that "viem already provides
WS reconnect + retry/fallback". That reasoning applies to a viem *transport*, but `watch()` is
hand-rolled on top of a `PublicClient` and does not inherit the retry/fallback policy.
**Impact:** the audit pipeline is the least resilient component in the stack while carrying the
most durable-state responsibility. **Fix:** build `watch()` on `getLogs` with chunking + retry,
or use viem's `watchEvent` with a fallback transport. **Dependencies:** PERF-5, BUG-7.
**Effort:** 1 d. **Timeline:** next minor.

---

### ARCH-4 — One `chainId` per indexer instance limits the multi-chain story — Medium / P3

**Files:** `packages/indexer/src/indexer.ts:49` (`constructor(dbPath, chainId)`);
`packages/mcp/src/server.ts:148` (`chainId` as a single tool arg).

Every row stores `chain_id`, but a `SigilIndexer` is bound to one chain at construction, and
`audit_query` accepts a single `chainId`. Multi-chain indexing therefore requires one DB per
chain, and there is no cross-chain aggregate query.
**Impact:** the whitepaper positions SigilKit for agent wallets across Base/Arbitrum/etc.; the
audit layer cannot answer "total spend by this agent across chains" without external joins.
**Fix:** make `chainId` a per-row/per-query parameter rather than an instance field (or add a
`queryAcrossChains` API and a composite index on `(chain_id, agent_id)`).
**Dependencies:** none. **Effort:** 1 d. **Timeline:** next minor.

---

### ARCH-5 — No per-package publish metadata; pack output unverified for 2 of 3 packages — Low / P2

No workspace `package.json` declares `engines`, `publishConfig`, `files`, or a verified `exports`
map; `npm pack --dry-run` runs **only** for `@sigilkit/core` (`publish.yml:38`). `demo-agent`
is `private`-ish in intent but carries a `*` core dependency like the others.
**Impact:** an accidental publish of indexer/mcp would ship an unvetted tarball (missing
`dist/`, stray test files, no Node floor). **Fix:** add `files: ["dist"]`, `publishConfig`,
`engines`; extend the pack preview to every publishable package. **Dependencies:** ARCH-1, SEC-2.
**Effort:** 2 h. **Timeline:** before public launch.

---

### ARCH-6 — `LeaseStore` seam has no production backend — Low / P3

**Files:** `packages/core/src/client.ts` (`NonceGate`, `InMemoryLeaseStore`).

E18 is described as "per-key serialization with a cross-worker coordination seam", but the only
implementation is in-process. A seam without a backend is an invitation to assume safety: two
agent workers sharing a session key will each serialize correctly *within* their process and
happily race *across* processes, producing nonce collisions that the on-chain nonce check will
reject (fail-safe, but with confusing operator-visible failures).
**Fix:** ship a reference Redis/etcd `LeaseStore` (or document loudly that the in-memory store is
single-process only and that multi-worker deployments must supply their own).
**Dependencies:** none. **Effort:** 1 d. **Timeline:** next minor.

---

## 6. Technical debt

| ID | Item | Severity | Priority | Effort | Dependencies | Business impact | Timeline |
|---|---|---|---|---|---|---|---|
| TD-1 | No gas snapshot / gas-budget tests anywhere (see PERF-4) | Medium | P2 | 1 d | — | Unmeasured 4337 verification-gas headroom → silent bundler rejection | Before mainnet |
| TD-2 | No coverage gate for Foundry (lcov artifact only); vitest v8 thresholds exist for core only; indexer/mcp coverage unknown | Medium | P3 | 4 h | CQ-3 | Untested indexer/mcp is exactly where BUG-5/6/7 live | Next minor |
| TD-3 | No Dependabot/Renovate; npm deps float on `^` (`viem ^2.55.19`) with no lockfile-drift gate | Medium | P3 | 2 h | — | Silent supply-chain drift in a wallet toolkit; toolchain pins (foundry v1.7.1, slither 0.11.6, halmos 0.3.3) are good, npm side is not | Next minor |
| TD-4 | Three overlapping planning docs (`Issues-Catalog-2026-09-11`, `Enhancements-2026-09-12`, `WHITEPAPER-v2.1`) + 21 `vault/` notes with contradictory status; no single source of truth | Medium | P2 | 1 d | BUG-8 | Stale counts (BUG-8) and the "audited" claim (SEC-1) are symptoms; reviewer cannot determine real status | Next patch |
| TD-5 | 21.7 MB MetaMask zip re-downloaded and unzipped on every weekly CI run; no artifact cache | Low | P3 | 2 h | — | CI cost/flakiness on the least-reliable job | Opportunistic |
| TD-6 | `continue-on-error: true` on `wallet-e2e-weekly`, `echidna-nightly`, `foundry-canary` with **no tracking issue and no removal criterion** | Low | P3 | 0.5 h | — | "Temporarily non-blocking" becomes permanently ignored; the stated intent ("until it has a few green weeks of history") has no enforcement | Next patch |
| TD-7 | No secret scanning in CI (gitleaks/trufflehog) and no `.well-known/security.txt` / disclosure automation despite `SECURITY.md` | Low | P3 | 3 h | SEC-4, BUG-1 | Hardcoded keys ship unflagged; researchers have no machine-readable disclosure channel | Next minor |
| TD-8 | `vault/` (21 research notes: competitive landscape, funding/bounty strategy, risk plans) is committed; only `vault/.obsidian/` internals are ignored | Low | P2 | 2 h | — | Publishing the repo exposes strategy and competitive analysis that was written as private research; decide deliberately (keep+document, or move to a private repo) | Before public launch |
| TD-9 | No `actionlint`/YAML-lint gate — the class of error in BUG-1 is mechanically detectable | Low | P0 | 1 h | BUG-1 | Prevents recurrence of the defect that disabled all CI | With BUG-1 |
| TD-10 | `docs/WHITEPAPER-v2.1.md` dated "August 2026" but authored 2026-09-11; `CHANGELOG` "Unreleased — 2026-09-11" contains 2026-09-12 work | Low | P3 | 0.5 h | TD-4 | Date drift undermines the changelog's auditability | Next patch |

---

## 7. Consolidated priority ranking

### P0 — stop everything
| ID | Issue | Sev | Effort |
|---|---|---|---|
| **BUG-1** | CI workflow invalid YAML → all 10 jobs dead | Critical | 0.25 h |
| **TD-9** | Add `actionlint` gate so it cannot recur | Low | 1 h |

### P1 — before the next push / before any public claim
| ID | Issue | Sev | Effort |
|---|---|---|---|
| **SEC-1** | Whitepaper claims "audited" with no audit | High | 0.5 h |
| **BUG-2** | ABI drift gate omits `SigilKitDelegator` | High | 0.5 h |
| **ARCH-1** | indexer + mcp are never published from npm | High | 4 h |
| **SEC-2** | `"@sigilkit/core": "*"` + no `engines` | Medium | 2 h |

### P2 — next patch / next minor
| ID | Issue | Sev | Effort |
|---|---|---|---|
| **BUG-3** | `expiresAt` off-by-one vs on-chain | Medium | 1 h |
| **BUG-4** | `checkTokenPath` wrong allowance spender | Medium | 1.5 h |
| **CQ-2** | `as never` + dead `decimals()` in same function | Medium | 1.5 h |
| **BUG-5** | `actions` PK drops distinct audits | Medium | 2 h |
| **BUG-6** | `window_charges` duplicates on re-ingest | Medium | 2 h |
| **BUG-7** | `watch()` cursor not persisted | Medium | 3 h |
| **CQ-3** | indexer/mcp tests + mcp lint absent from CI | Medium | 1 h |
| **CQ-1** | 10 compiler warnings ungated | Medium | 4 h |
| **PERF-1** | 4 serial RPC round-trips, dead `decimals` | Medium | 2 h |
| **PERF-3** | `simulateExecution` double pre-flight | Low | 3 h |
| **PERF-4** | No gas snapshot / budget tests | Medium | 1 d |
| **ARCH-2** | Indexer has no reorg/finality policy | Medium | 2 d |
| **BUG-8** | Stale counts (54/55/38 vs 86) + `—depth` mojibake | Low | 1 h |
| **TD-1** | No gas snapshot / gas-budget tests (≡ PERF-4) | Medium | 1 d |
| **TD-4** | No single source of truth for status | Medium | 1 d |
| **TD-8** | `vault/` research notes committed | Low | 2 h |
| **ARCH-5** | No per-package publish metadata | Low | 2 h |

### P3 — backlog / opportunistic
`BUG-9` (MCP not read-only) · `PERF-2` (import-bound suite) · `PERF-5` (unbounded `getLogs`) ·
`SEC-3` (empty-calldata selector) · `SEC-4` (Anvil keys + no secret scan) · `SEC-5` (bare-revert
test) · `SEC-6` (delegator impl docs) · `CQ-4` (demo-agent untested) · `CQ-5` (parity comment) ·
`CQ-6` (21.7 MB zip, tracked PDF) · `ARCH-3` (watch resilience) · `ARCH-4` (single-chain indexer) ·
`ARCH-6` (`LeaseStore` has no backend) · `TD-2` · `TD-3` · `TD-5` · `TD-6` · `TD-7` · `TD-10`

---

## 8. Recommended sequencing

1. **Same hour:** fix BUG-1's indentation, add the `actionlint` gate (TD-9), push, confirm all
   10 jobs appear. *Nothing else in this catalog is verifiable until CI actually runs* — this is
   also the first real CI run in the project's history.
2. **Same day:** SEC-1 (whitepaper wording), BUG-2 (ABI loop), BUG-8 (counts + mojibake), CQ-3
   (run indexer/mcp tests in CI). All are small, and together they restore the credibility of the
   project's own claims.
3. **Same week:** the audit-trail correctness cluster — BUG-5 → BUG-6 → BUG-7 (shared migration),
   then ARCH-2 (finality/reorg). Do them as one change set with one migration.
4. **Next:** the client-conformance pair BUG-3 + BUG-4/CQ-2 + PERF-1 (one edit to `checkTokenPath`,
   one to `validateAgainstScope`, plus golden vectors pinning both boundaries).
5. **Before public launch:** ARCH-1 + SEC-2 + ARCH-5 (publish the real package set, pinned and
   gated), PERF-4 (gas budget), CQ-1 (`--deny-warnings`), TD-8 (decide `vault/`), SEC-4/TD-7
   (secret scanning).
6. **Backlog:** the remainder, revisited after the first green CI week.

---

## 9. Summary

**42 issues** — 9 bugs, 5 performance, 6 security, 6 code quality, 6 architectural, 10 technical debt.
By severity: **1 Critical · 3 High · 20 Medium · 18 Low**. By priority: **2 P0 · 4 P1 · 17 P2 · 19 P3**.

The **on-chain enforcement core is genuinely strong** — 86 passing tests, invariant suites, an
independent Echidna fuzzer, Halmos symbolic specs, Slither in the gate, no exploitable
vulnerability found, and all contracts comfortably under the size limit. The engineering that
went into `SessionKeyManager` / `SessionKey7579Module` is the best part of this repository.

The problems cluster in the **seams around that core**: CI that cannot run (BUG-1), a
documentation layer that overstates ("audited") and miscounts its own tests, a release pipeline
that ships one of four packages, and a durable audit layer (indexer) with three
data-integrity bugs sitting in the one place the toolkit promises correctness. None of these
are hard to fix — the entire P0+P1 set is under a day of work — but together they mean the
project's *claims* currently outrun its *verified reality*. Fix the verification pipeline first;
everything else becomes checkable the moment CI is real.

---

*Generated 2026-09-12 · review of SigilKit `master` (125 tracked files) · every finding above
reproduced against a live toolchain.*
