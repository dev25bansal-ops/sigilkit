# Data formats, schema and consistency — audit of 2026-09-26

**Scope.** Every *structured data file* in the repository: what shape it is, who reads it,
who writes it, and whether the reading and the writing can disagree without anything
noticing. Written by the scripts-team data engineer. **Read-only audit** — nothing in the
repository was modified to produce this document; the two commands that were executed
(`node scripts/sync-facts.mjs --check`, `node scripts/check-vectors.mjs`) are both
read-only, and the fragility probes ran against in-memory copies of the real files.

**Headline results.**

| # | Finding | Severity |
|---|---|---|
| F1 | Three root-level `.bak-*.json` files are byte-identical, untracked copies of the three golden-vector files | **P2 — dead data** |
| F2 | `packages/core/abis/MerkleWhitelist.json` is `[]`; correct (it is a `library`) but *looks* like the SK-22 failure mode the gate was written for | P3 — document it |
| F3 | `check-waivers.mjs`: a blank line between the delimiter row and the first data row yields **0 rows, 0 errors, 0 warnings** | **P1 — silent hole** |
| F4 | `check-waivers.mjs`: removing a waiver row is a **WARN**, not a FAIL, so a deleted governance row cannot fail a PR | **P1 — gate is soft** |
| F5 | A workflow that is *valid YAML but truncated* produces no parse error and no failure — only warnings | **P1 (backstopped)** |
| F6 | `echidna.yaml` is consumed **only** by an external GitHub Action; nothing in the repo parses it, so a syntax error fails no local gate | P2 |
| F7 | `remappings.txt`, `.nvmrc`, `foundry.toml` have exactly one reader each and no schema assertion | P3 |
| F8 | `eip7702.json` stores `chainId`/`nonce` as **strings** while `actionrequest.json` stores `chainId`/`expiry` as **numbers** | P3 — intentional, but undocumented in-file |
| F9 | No credential, private key or mnemonic appears anywhere in `vectors/` | **clear** |
| F10 | `sync-facts --check` exits 1 on a pre-existing `bootstrap.mjs` defect, unrelated to the data files | P2 — pre-existing |

---

## 1. Inventory of structured data files

### 1.1 Golden vectors — `vectors/*.json`

| File | Bytes | Top-level keys | Count fields |
|---|---|---|---|
| `vectors/actionrequest.json` | 3 770 | `_doc`, `_provenance`, `casesCount`, `cases` | `casesCount` = 4 |
| `vectors/eip7702.json` | 1 875 | `_doc`, `_provenance`, `casesCount`, `cases` | `casesCount` = 6 |
| `vectors/merkle-v2.json` | 2 651 | `_doc`, `_provenance`, `leafCases`, `trees`, `leafCasesCount` | `leafCasesCount` = 3, `trees[0].leavesCount` = 3, `trees[0].proofsCount` = 3 |

**Reader / writer per file.** The corpus is genuinely dual-consumer and single-writer:

| File | Reads | Writes |
|---|---|---|
| `actionrequest.json` | `contracts/test/GoldenVectors.t.sol:19` (`vm.readFile`), `packages/core/test/vectors.test.ts:19` | `scripts/generate-vectors.mjs:238` |
| `eip7702.json` | `GoldenVectors.t.sol:20`, `vectors.test.ts:38` | `generate-vectors.mjs:239` |
| `merkle-v2.json` | `GoldenVectors.t.sol:21`, `vectors.test.ts:42` | `generate-vectors.mjs:240` |
| all three | `scripts/check-vectors.mjs` (shape + provenance gate) | — |

#### Schema — `actionrequest.json` (EIP-712 digest of `ActionRequest`)

| Path | Type | Meaning |
|---|---|---|
| `_doc` | string | what the file pins and who consumes it (asserted non-empty) |
| `_provenance.generator` | string | `"@sigilkit/core"` |
| `_provenance.externallyAnchored` | boolean | `false` — **self-certified** |
| `casesCount` | number | must equal `cases.length` |
| `cases[].name` | string | vector name, also the vitest `it()` title |
| `cases[].chainId` | **number** | EIP-712 domain chain id |
| `cases[].verifyingContract` | string | EIP-712 domain verifying contract (identical in all 4 cases) |
| `cases[].request.agentId` | string | `0x`+32 bytes |
| `cases[].request.target` | string | address |
| `cases[].request.selector` | string | `0x`+4 bytes |
| `cases[].request.value` | **string** | decimal; exceeds `MAX_SAFE_INTEGER` in 2 cases |
| `cases[].request.nonce` | **string** | decimal; `MAX_UINT256` in 1 case |
| `cases[].request.expiry` | **number** | `uint48`, max 2⁴⁸−1 fits exactly in a double |
| `cases[].request.rationaleHash` | string | `0x`+32 bytes |
| `cases[].request.data` | string | `0x`-prefixed calldata, up to 256 bytes |
| `cases[].digest` | string | `0x`+32 bytes |

The `request` object is exactly the 8 fields of the on-chain
`ActionRequest(bytes32,address,bytes4,uint256,uint256,uint48,bytes32,bytes)` struct, in
declaration order — and the generator's `TYPES` table and `GoldenVectors.t.sol:84`'s
`TYPEHASH` string are the same 8 names in the same order. **Three independent restatements
of one field list, none of which is asserted against the others.** (P2 suggestion in §7.)

#### Schema — `eip7702.json` (authorization digest)

| Path | Type | Meaning |
|---|---|---|
| `cases[].name` | string | |
| `cases[].chainId` | **string** | decimal string, *not* a number |
| `cases[].contractAddress` | string | the address being authorized (the delegation designator) |
| `cases[].nonce` | **string** | decimal string |
| `cases[].digest` | string | `keccak256(0x05 ‖ rlp([chainId, address, nonce]))` |

#### Schema — `merkle-v2.json` (leaf preimages + one tree)

| Path | Type | Meaning |
|---|---|---|
| `leafCases[].name` | string | |
| `leafCases[].target` | string | address |
| `leafCases[].selector` | string | `0x`+4 bytes |
| `leafCases[].argsHash` | string | `keccak256(data)`, or 32 zero bytes for a wildcard |
| `leafCases[].data` | string \| **null** | `null` encodes "wildcard leaf" |
| `leafCases[].leaf` | string | `keccak256(abi.encode(target, selector, argsHash))` |
| `trees[].leaves[]` | string[] | sorted-pair tree, odd node promoted |
| `trees[].root` | string | |
| `trees[].proofs[].leaf` | string | |
| `trees[].proofs[].proof[]` | string[] | sibling nodes |
| `trees[].leavesCount`, `trees[].proofsCount` | number | hand-written, asserted |

---

## 2. Vector audit

### 2.1 Counts

**13 vectors total** — 4 ActionRequest digests + 6 EIP-7702 authorization digests +
3 Merkle leaves — plus **1 tree** (3 leaves, 3 proofs) derived from those 3 leaves. If you
count *assertions* rather than vectors, the Solidity suite runs 4 + 6 + 3 + 3 = 16 and the
TS suite runs 4 + 6 + 3 + 3 + 3 = 19.

All five hand-written counts are correct:

| Field | Declared | Actual | |
|---|---|---|---|
| `actionrequest.casesCount` | 4 | 4 | OK |
| `eip7702.casesCount` | 6 | 6 | OK |
| `merkle-v2.leafCasesCount` | 3 | 3 | OK |
| `merkle-v2.trees[0].leavesCount` | 3 | 3 | OK |
| `merkle-v2.trees[0].proofsCount` | 3 | 3 | OK |

`node scripts/check-vectors.mjs` → **exit 0**, all three corpora `ok`, provenance registry
agrees with both the in-file `_provenance` blocks and the generator source.

### 2.2 Schema consistency — **all entries uniform, no missing or extra fields**

| Array | Key-set | Verdict |
|---|---|---|
| `actionrequest.cases` (4) | `{chainId, digest, name, request, verifyingContract}` ×4 | **UNIFORM** |
| `actionrequest.cases[].request` (4) | `{agentId, data, expiry, nonce, rationaleHash, selector, target, value}` ×4 | **UNIFORM** |
| `eip7702.cases` (6) | `{chainId, contractAddress, digest, name, nonce}` ×6 | **UNIFORM** |
| `merkle-v2.leafCases` (3) | `{argsHash, data, leaf, name, selector, target}` ×3 | **UNIFORM** |
| `merkle-v2.trees` (1) | `{leaves, leavesCount, proofs, proofsCount, root}` ×1 | **UNIFORM** |

No entry has a missing field, no entry has an extra field, and no field has a union type
across entries of the same array. Every `digest` / `leaf` / `root` / `argsHash` /
`rationaleHash` / `agentId` is a well-formed 32-byte hex word (37 occurrences, all
validated by `check-vectors.mjs`).

Merkle proof coverage is complete: all 3 leaves are unique, and every leaf has a proof
(proof lengths 1, 2, 2 — the asymmetric depth of a 3-leaf odd-promoted tree).

### 2.3 Are the three schemas "related but different" — and is the difference right?

**Yes, and the differences are all semantically forced.** They are not three variations of
one shape; they are three different preimages that happen to share a wrapper vocabulary.

| | `actionrequest` | `eip7702` | `merkle-v2` |
|---|---|---|---|
| Wrapper | `cases[]` | `cases[]` | `leafCases[]` + `trees[]` |
| Authorization structure | `request` object, 8 typed fields | flat: `chainId` + `contractAddress` + `nonce` | flat: `target` + `selector` + `argsHash` |
| Digest input | EIP-712 `domainSeparator ‖ structHash` | `0x05 ‖ rlp([chainId, address, nonce])` | `keccak256(abi.encode(target, selector, argsHash))` |
| Domain binding | yes — `chainId` + `verifyingContract` | yes — `chainId` is *inside* the signed payload | **no** — leaves are chain-agnostic by design |
| `null` allowed | no | no | yes — `leafCases[].data` |
| External anchor | no (`externallyAnchored: false`) | **yes** (`viem:hashAuthorization`) | no |

Three points a reviewer should note, because they look like inconsistencies and are not:

1. **`chainId` is a number in `actionrequest.json` and a string in `eip7702.json`.** This is
   *not* arbitrary. `actionrequest.chainId` is a domain separator component, always small,
   and the Solidity side reads it with `vm.parseJsonUint`. `eip7702.chainId` is an RLP
   scalar, and keeping it a decimal string is what forces the SDK to go through `BigInt()`
   rather than letting a JS `number` sneak into an RLP encoder. The asymmetry is load-bearing.
   It is, however, undocumented *in the file* — only the generator's comments explain it.
2. **`merkle-v2` has no `chainId` at all.** Correct: a whitelist leaf is
   `(target, selector, argsHash)` and the same root is meant to be valid on every chain. If a
   `chainId` ever appears in a leaf, the file is wrong.
3. **Only `eip7702.json` is externally anchored.** The `_provenance` block says so, and
   `check-vectors.mjs` asserts that claim against both a registry *and* the generator
   source — including a positive check that `hashAuthorization` is still imported from
   `viem` **and still called**, with JS comments and string-literal bodies blanked so a
   `_doc` sentence cannot satisfy the anchor. This is the strongest data-integrity guard in
   the repository and it is worth reading before touching the generator.

### 2.4 Credential scan — **CLEAR, no P0**

Scanned for 32-byte hex words by field path, and for secret-shaped keywords repo-wide.

| Check | Result |
|---|---|
| 64-hex-digit values in `vectors/` | 37 — **all accounted for**: `agentId` (4), `rationaleHash` (4), `digest` (13), `argsHash` (3), `leaf` (3+3), `root` (1), `proof[]` (5), and one `data` blob of exactly 32 bytes |
| Any field named `privateKey` / `secret` / `mnemonic` / `seed` | **none** — the keyword scan for `PRIVATE_KEY|privateKey|mnemonic|seedPhrase` across the whole repo (excluding `lib/`) returns **0 matches** |
| Well-known Anvil dev keys in `vectors/` | **absent** |
| Anvil dev keys elsewhere | Present in `packages/demo-agent` and the e2e harness — **intentionally**, and scoped by `.gitleaks.toml` `allowlist.regexes`, which allowlists exactly two literal values by value (not by file) |
| `.gitleaks.toml` allowlist breadth | Correctly narrow: value-scoped for keys, path-scoped only for the *downloaded MetaMask binary* dirs, never for harness source (SEC-07 regression) |

The 32-byte values in the vectors are all structurally digest-like: `check-vectors.mjs`
requires each of them to sit at a named digest/leaf/root/argsHash/proof path, and there is
no field in any vector file where a key could hide without failing that gate. **No P0.**

### 2.5 Dead data — vectors that are never consumed

**All three vector files are consumed by both language suites.** No vector file is dead.

| File | Solidity consumer | TS consumer | Shape gate |
|---|---|---|---|
| `actionrequest.json` | `GoldenVectors.t.sol:19` → `test_Golden_ActionRequestDigests` | `vectors.test.ts:19` | `check-vectors.mjs` |
| `eip7702.json` | `GoldenVectors.t.sol:20` → `test_Golden_EIP7702Digests` | `vectors.test.ts:38` | `check-vectors.mjs` |
| `merkle-v2.json` | `GoldenVectors.t.sol:21` → `test_Golden_MerkleV2Leaves` + `test_Golden_MerkleTree_ProofsVerify` | `vectors.test.ts:42` | `check-vectors.mjs` |

`grep -r "vectors/"` finds no other reference. So the vector corpus itself is clean.

**But there is dead data next to it — see F1 in §4.**

Two subtler notes on consumption, both benign:

- `GoldenVectors.t.sol` reads `trees[0]` **by index only** (`.trees[0].leaves`,
  `.trees[0].root`, `.trees[0].proofsCount`). `check-vectors.mjs` deliberately checks
  *every* tree, and `vectors.test.ts` iterates `for (const tree of merkleVectors.trees)`, so
  a second tree added later would be shape-gated and TS-tested but **not** on-chain tested.
  Worth a comment in the Solidity file, not a bug today (there is exactly one tree).
- `merkle-v2.json`'s `leafCases[].data` is asserted to be present-and-typed but
  `check-vectors.mjs` never checks that `argsHash === keccak256(data)`. The TS suite
  recomputes it indirectly; the Solidity suite ignores `data` entirely and recomputes
  `keccak256(abi.encode(target, selector, argsHash))`. So `argsHash` is pinned on the TS
  side only.

---

## 3. `foundry-scope.json`

### 3.1 Schema

```json
{
  "$comment":    "provenance / how to add a new exclusion category",
  "unitExclude": ".*Invariant|.*Fork",   // owner: the ONLY place a category is added
  "invariantMatch": ".*Invariant",      // must be exactly one branch of unitExclude
  "forkMatch":      ".*Fork",           // must be exactly one branch of unitExclude
  "jsExclude":  "Invariant|Fork"        // derived mirror; regenerated by --write
}
```

Invariants the guard enforces *on the file itself*: all four pattern fields present and
non-empty; `jsExclude === deriveJsExclude(unitExclude)` (stale mirror reported); each of
`invariantMatch` / `forkMatch` names **exactly one** category and is a literal branch of
`unitExclude`; `jsExclude` compiles as a RegExp.

### 3.2 `node scripts/sync-facts.mjs --check` → **exit 1**

```
ERROR scripts/bootstrap.mjs:34  [node-floor.fragile-parse]
counts: error 1 · split 14 · info 1
```

The single error is **F10** and is *not* about the data files: `bootstrap.mjs:34` uses the
legacy digit-slice floor parse (`replace(/[^0-9]/g,"").slice(0,2)`), which is correct for
`">=24"` (→ 24) and silently wrong for a three-digit major (`">=100"` → 10). The guard
reports it as an `error` precisely because its value is right today, so no value comparison
can ever catch it. It is `writable: no` — JS source is asserted only, fixed by hand.

### 3.3 Do the four fields agree with the 7 declared consumers? **Yes — all 7 verified.**

`SCOPE_CONSUMERS` declares 7; `sync-facts` reported a `scope.*` finding for **every one**,
and I cross-checked each against the actual file content:

| # | Consumer | Kind | Field | Restatement site(s) | Agreement |
|---|---|---|---|---|---|
| 1 | `package.json` (`npm test`) | `unit` | `unitExclude` | line 19 | `.*Invariant\|.*Fork` ✓ |
| 2 | `package.json` (`npm run test:full`) | `full` | `forkMatch` | line 20 | `.*Fork` ✓ |
| 3 | `.github/workflows/ci.yml` | `unit` | `unitExclude` | lines 100, 258, 426 | ✓ (3 sites, all agree) |
| 4 | `.github/workflows/ci.yml` | `invariant` | `invariantMatch` | lines 112, 248, 425 | ✓ (3 sites) |
| 5 | `.github/workflows/ci.yml` | `fork` | `forkMatch` | line 303 | ✓ |
| 6 | `scripts/verify.mjs` | `unit` | `unitExclude` | line 576 (argv form) | ✓ |
| 7 | `scripts/check-doc-counts.mjs` | `js` | `jsExclude` | line 45 `EXCLUDED = /Invariant\|Fork/` | ✓ |

**14 `split` findings, 0 scope drifts.** Notable properties worth recording:

- The `full` consumer correctly reads `forkMatch`, not `unitExclude` — `npm run test:full`
  is the *wide* scope, so reading it from the wrong field would silently narrow the command
  it is meant to widen.
- `ci.yml` legitimately carries three different scopes in three different jobs, so each hit
  is classified by *which field its pattern belongs to* and only that kind's hits are
  checked. A pattern matching no field at all is reported as genuine drift.
- `halmos --match-contract Halmos` (ci.yml:322) is correctly **not** read as forge scope —
  `NON_FORGE_RUNNER` excludes halmos/echidna/slither/mythril/aderyn.
- The JSDoc in `verify.mjs:400` and `check-doc-counts.mjs:44` both *quote* the patterns in
  prose and are correctly ignored; `blankComments` keeps `file:line` true while blanking
  the text, and preserves import/export specifiers.
- The only inconsistency in the repo: `ci.yml:100` uses `unitExclude` while the drift-test
  string at `sync-facts.test.mjs:313` notes a historical bug where the same site read
  `.*Fork`. It reads correctly today.

**No action needed on `foundry-scope.json`.** It is the best-designed data file in the
repository: a single owner, a derived mirror, an explicit list of every restatement, and a
guard that classifies hits rather than assuming one-per-file. §7 recommends extending the
same pattern to the vectors, not fixing anything here.

---

## 4. Dead data: three untracked vector clones at the repo root (F1)

| File | Bytes | Byte-identical to | Git |
|---|---|---|---|
| `.bak-ar.json` | 3 770 | `vectors/actionrequest.json` | **untracked**, not in `.gitignore` |
| `.bak-eip.json` | 1 875 | `vectors/eip7702.json` | **untracked**, not in `.gitignore` |
| `.bak-mk.json` | 2 651 | `vectors/merkle-v2.json` | **untracked**, not in `.gitignore` |

Verified byte-for-byte equal (same length, same content). They are a **complete shadow copy
of the golden-vector corpus outside `vectors/`**.

Why this is a real problem, not cosmetic:

1. `check-vectors.mjs` reads `VECTOR_FILES = ["actionrequest.json", "eip7702.json",
   "merkle-v2.json"]` from `vectors/` only. The clones are **not** shape-gated, **not**
   provenance-checked, and **not** covered by the `vectors:generate && git diff --exit-code
   -- vectors/` no-op gate.
2. Because they are untracked but **not** gitignored, a `git add -A` commits them. Once
   committed they are permanent, reviewable-looking files that duplicate the corpus.
3. If they ever diverge from `vectors/`, there is no gate anywhere that notices. The
   `vectors:generate` no-op gate diffs `-- vectors/` only.
4. `.gitleaks.toml` scans them (they are not in any path allowlist), so at least the secret
   scanner still sees them. That is the only guard that applies.

**Recommendation (P2).** Delete the three files and add `.bak-*.json` to `.gitignore`.
Worth doing together with F6 in one commit so the "untracked but not ignored" class is
closed out.

### Related: `fleet-manifest.json` is *not* dead

`fleet-manifest.json` (41 lines: `manager`, `counter`, `scope`, `sharedKey`,
`auditedActions[]`) sits at the repo root and looks like committed fixture data. It is not:

- written by `packages/demo-agent/src/fleet.ts:176` on every `npm run fleet`;
- listed in `.gitignore` (line "`fleet-manifest.json`") and confirmed untracked;
- removed by `scripts/clean.mjs:57`.

Its `auditedActions[].agentId` values decode to ASCII (`666c6565742d616c706861` =
"fleet-alpha", `666c6565742d62657461` = "fleet-beta"), which is a nice confirmation that it
is demo output and not key material. **Correctly classified. No action.**

### `packages/core/abis/*.json` — 7 files, one of which is `[]` (F2)

| File | ABI entries | Source |
|---|---|---|
| `SessionKeyManager.json` | 47 | contract |
| `SigilKitDelegator.json` | 49 | contract |
| `SessionKey7579Module.json` | 29 | contract |
| `ActionLog7579Executor.json` | 12 | contract |
| `SpendPolicy.json` | 3 | contract |
| `ActionLogger.json` | 1 | contract |
| `MerkleWhitelist.json` | **0** | **`library MerkleWhitelist`** (internal/library functions only) |

`MerkleWhitelist.sol:11` declares `library MerkleWhitelist`, so `forge inspect … abi` on a
library with only internal functions legitimately yields `[]`. The SK-22 test
(`abi-drift.test.ts:370`) asserts `raw.trim().length > 0` and `Array.isArray(parsed)` — `[]`
satisfies both, correctly.

**This is fine, but it is a trap for the next reader**: the SK-22 test exists *because* an
empty `SessionKeyManager…SigilKitDelegator.json` was once committed, and now a legitimately
empty `MerkleWhitelist.json` sits in the same directory. Anyone tightening SK-22 to
"must be non-empty" would break the build on a correct file. Worth one line of comment in
`abi-drift.test.ts`. (P3, docs-only — not in my write scope.)

The rest of the ABI gate is genuinely two-sided and I verified the invariant holds:
`scripts/abi-targets.txt` lists exactly the 7 stems in `contracts/src/`, the drift test
asserts the set difference is empty **in both directions**, asserts each entry has a
committed JSON, and asserts `ci.yml` reads the same list rather than a hard-coded one.

---

## 5. Markdown tables as a data source — fragility verdict

`docs/CI-WAIVERS.md` is a governance register that `scripts/check-waivers.mjs` parses with
a hand-rolled table reader (`splitRow` + header regex + delimiter-row detection). I ran 22
in-memory mutations of the real file through the real parser and then through the full
`crossCheck`, to separate "the parser complains" from "the gate still holds".

**Verdict: the format is brittle at the *parser* level but, with three exceptions, fails
loudly rather than silently. The brittleness is concentrated in one place — a blank line
immediately under the delimiter row — and that place fails *silently*.**

| Mutation | Parser result | Gate verdict |
|---|---|---|
| Consistent reorder (Criterion ↔ Expiry, header + rows together) | 3 rows, correct job + expiry | **PASSES correctly** ✓ |
| Reorder header only (rows not moved) | 0 rows, **FAIL** "no CI waiver table found" | loud ✓ |
| Add a trailing column | 3 rows, unaffected | **PASSES correctly** ✓ |
| 2-space indent on every table line | 3 rows, unaffected | **PASSES correctly** ✓ |
| CRLF line endings | 3 rows, unaffected | **PASSES correctly** ✓ |
| Leading/trailing pipe removed from rows | 0 rows, **FAIL** | loud ✓ |
| No delimiter row at all | 0 rows, **FAIL** | loud ✓ |
| Header renamed (`Job (ci.yml)` → `CI Job`) | 0 rows, **FAIL** | loud ✓ |
| Header renamed (`Waiver` → `Why waived`) | 0 rows, **FAIL** | loud ✓ |
| Header renamed (`Expiry hard stop` → `Hard stop`) | 0 rows, **FAIL** | loud ✓ |
| Every ISO date replaced by prose | 3 errors, per-row "no ISO date" | loud ✓ |
| Expiry extended 2026-11-30 → 2026-12-12 | accepted | **silently weakens rule #2** (F4 class) |
| Duplicate row with a later expiry | 4 rows, "registered more than once" WARN, **earliest wins** | correct and safe ✓ |
| Criterion column deleted | 3 rows + 1 WARN | **WARN only — gate soft** |
| Job name containing `/` | 2 rows + 1 FAIL | loud ✓ |
| **Blank line between header and delimiter** | 0 rows, **FAIL** | loud ✓ |
| **Blank line between delimiter and first row** | **0 rows, 0 errors, 0 warnings** | **SILENT — F3** |
| **HTML comment between two rows** | table truncated to 1 row, **0 errors** | fails, but via the *other* direction ✓ |
| Unescaped `\|` inside a cell | 3 rows, **0 errors, expiry silently changed** | **SILENT — F3 class** |

### F3 (P1) — two silent mis-parses

**(a) Blank line under the delimiter row.** `parseRegister` scans for `|`-prefixed lines and
consumes rows in a `while` loop that stops at the first non-`|` line. Inserting one blank
line after `|---|---|---|---|` yields `rows: 0` with **no error and no warning** — a
populated register that reads as an empty one. It does not currently pass the gate, but only
*by accident*: `crossCheck` rule #1 then reports all three YAML waivers as unregistered, so
the build goes red for a reason that points at ci.yml rather than at the markdown.

**(b) Unescaped pipe inside a cell.** `splitRow` handles `\|` correctly, but nothing
*requires* it. A literal `|` in the Waiver cell shifts every later column left by one, and
because the parser reads columns by index, the shifted cell still yields a plausible-looking
ISO date. In my probe, a `|` in `wallet-e2e-weekly`'s Waiver cell silently changed its
effective expiry from `2026-10-12` to `2026-09-15` — a *stricter* date by luck. A `|` in a
different cell could shift a later date the permissive way, and the gate would report a
correct-looking expiry that is not the one in the file. **Nothing detects this.**

Both are the same root cause: the parser trusts the rendered table to be well-formed and has
no way to notice when it is not. The fix is cheap and needs no schema change — assert
`cells.length === header.length` for every row and report a mismatch as an error.

### F4 (P1) — the register is advisory in both directions

- A waiver in YAML with no row → **FAIL** (rule #1). Good.
- An expired row while the waiver is live → **FAIL** (rule #2). Good.
- **A row whose waiver has been removed → WARN, exit 0.** So the "register must be deleted
  the day the waiver is" rule cannot fail a PR. Deleting the *governance* record is the
  cheapest possible way to launder a waiver: remove `continue-on-error: true` from the job,
  leave the row, get a warning nobody reads.
- **Extending an expiry is invisible.** `2026-11-30` → `2026-12-12` is a pure edit to a
  markdown cell. There is no history, no git-derived immutability, no signature. The
  register's own rule #3 ("red runs don't reset silently") is prose in a `## Rules`
  section that the parser never reads — there is no `history` column in the table at all,
  although the rules section tells authors to append to one.
- The duplicate-row guard is the one place the design is genuinely strong: the **earliest**
  expiry wins, so appending a second, later row cannot extend a waiver. Verified.

**Recommendation.** Make rule #2's sibling symmetric: a row with no waiver should FAIL, not
WARN. `--strict` exists and escalates it, but CI runs `node scripts/check-waivers.mjs`
**without** `--strict` (`ci.yml:59`), so in CI the check is permanently in its soft mode.
Moving stale rows to FAIL, or adding `--strict` to the CI step, closes it.

---

## 6. YAML consumers — what happens when parsing fails

Three scripts parse YAML, all with the `yaml` package (this is already the improved state —
`assurance-inventory.mjs` replaced a hand-rolled indentation reader, per its own header).
Behaviour on failure is **not** uniform, and one case is genuinely dangerous.

| Consumer | Parse error | Malformed-but-valid | No `jobs:` mapping |
|---|---|---|---|
| `validate-workflows.mjs` (layer 1) | **FAIL**, `file:line:col` | layer 2 shape asserts run | **FAIL** "workflow has no `jobs` mapping" |
| `check-waivers.mjs` → `parseWorkflow` | **FAIL**, `file:line:col`, 1–3 errors | see below | **FAIL** |
| `check-waivers.mjs` → `runChecks` | **fails closed** — returns parse errors *alone* and skips every cross-check, so it can never report "the waiver is gone" for a job it failed to load | see below | **FAIL** |
| `assurance-inventory.mjs` → `parseWorkflowJobs` | **THROWS** `YAMLParseError`, uncaught → non-zero exit | see below | returns `{}` → `jobs: []` |
| `check-doc-counts.mjs` → `ciJobCount` | **THROWS** (same) | see below | `?? {}` → 0 jobs |

`check-waivers.mjs` is the best of the three: `parseWorkflow` collects `doc.errors` with
`linePos`, and `runChecks` has an explicit comment explaining why it reports the parse error
alone rather than continuing — *"a workflow could not be parsed [so] its jobs were never
enumerated, so every cross-checked verdict would be derived from a partial view."* That is
the right call and it is implemented.

### F5 (P1, backstopped) — a truncated workflow is not a parse error

This is the case that matters. Cutting `ci.yml` at any job boundary produces a **smaller but
perfectly valid** workflow. `parseWorkflow` returns `errors: 0`. Measured, with the real
register:

| Scenario | Waivers found | Rows | Failures | Warnings | Verdict |
|---|---|---|---|---|---|
| Unmodified | 3 | 3 | 0 | 0 | exit 0 |
| Cut before `halmos:` (all 3 waivers gone) | 0 | 3 | **0** | 3 | **exit 0** |
| Cut before `echidna-nightly` (1 of 3 gone) | 1 | 3 | **0** | 2 | **exit 0** |
| Cut before `foundry-canary` (1 of 3 gone) | 2 | 3 | **0** | 1 | **exit 0** |

The `check-waivers` gate cannot see a job disappear. **It is backstopped, though**, and the
backstop is real: `check-doc-counts.mjs:848` `ciJobCount()` parses both workflows with the
`yaml` package and asserts the count against prose that is itself asserted —
`docs/WHITEPAPER-v2.1.md:85` ("**14-job CI across 2 workflows** (12 in …") and
`README.md:54` ("✅ 14 jobs across 2 workflows — `ci.yml` (12) … `publish.yml` (2)"). All
three numbers are cross-checked, and `ci.yml`'s per-file count is checked against the
per-file prose too. Deleting three jobs from `ci.yml` breaks that gate. So the *system* is
covered — but only because a **documentation** guard happens to read the workflow. That is
an accident of coverage, not a design, and it is worth stating plainly in the report.

### F6 (P2) — `echidna.yaml` has no local consumer at all

`echidna.yaml` is passed to `cryic/echidna-action@v2.0.2` as `config: echidna.yaml`
(`ci.yml:408`). `grep` across `scripts/`, `packages/`, `contracts/` finds **no** script that
reads or validates it. Consequences:

- A syntax error in `echidna.yaml` fails only in the nightly `echidna-nightly` job — which
  is `continue-on-error: true` and therefore **does not block anything**. So a broken
  Echidna config is invisible to the PR gate *and* non-blocking in the one job that reads it.
- The file's 5 keys (`testMode`, `testLimit`, `corpusDir`, `coverage`, `seqLen`,
  `shrinkLimit`) have no schema assertion, and the comment at lines 7–8 documents a
  *silent-ignore* class of defect ("`sequenceLength`/`shrinkingSequenceLength` are silently
  ignored") — which is exactly what a typo in this file would produce, with no local signal.
- `corpusDir: echidna-corpus` names a directory that is not in `.gitignore`. Minor, but the
  first local `echidna` run creates an untracked, non-ignored directory — the same
  "untracked but not ignored" class as F1.

**Recommendation.** A 15-line `scripts/check-echidna-config.mjs` that parses the file with
`yaml`, asserts the six keys and their types, and cross-checks the contract/function name
against `contracts/test/EchidnaProperties.t.sol` would close this for the price of the
`check-vectors.mjs` header comment. Same pattern, same repo, no new paradigm. (P2)

---

## 7. Remaining data files, briefly

| File | Format | Schema | Read by | Written by | Assessment |
|---|---|---|---|---|---|
| `foundry.toml` | TOML | `[profile.default]` + `.fuzz` + `.invariant` × `default`/`ci`/`deep` | `forge` (external binary) | humans | **F7.** 3 profiles, 8 keys. `FOUNDRY_PROFILE: ci` in ci.yml and `deep` in publish.yml/nightly select among them; nothing asserts a profile name is valid, so a typo in `FOUNDRY_PROFILE` silently falls back to `default` (1 fuzz run instead of 2 000) with no error. Same class as F6. |
| `remappings.txt` | text, 1 line | `<prefix>=<path>` | `forge` | humans | **F7.** Single entry `forge-std/=lib/forge-std/src/`. Trivially correct; `lib/forge-std/` is gitignored (installed at build time), so a missing checkout surfaces as a forge error, not a silent one. No gate needed. |
| `.nvmrc` | text, 1 line | bare major | `nvm`, `sync-facts.mjs` | `sync-facts --write` | Well-governed: it is a *restatement* with a named owner (`package.json → engines.node`), `--write`-repairable, and `--check` reports it. **Exemplar.** |
| `package.json` (root) | JSON | `name, version, license, private, type, workspaces, engines, scripts, devDependencies` | npm, `sync-facts`, `publish.yml` (inline node), `check-doc-counts` | humans | Owner of the node floor. Explicitly **excluded** from `--write` — "a tool that rewrites its own inputs cannot be audited". Correct. |
| `packages/*/package.json` (4) | JSON | see below | npm, `sync-facts` (engines), `check-package-artifacts`, `publish.yml` (version) | humans + `sync-facts --write` | All 4 declare `engines.node: ">=24"`, all agree with the root. **Schema divergence worth noting:** field *sets* differ — root has `workspaces`+`private`, `demo-agent` has `private: true` and no `publishConfig`, `mcp` alone has `bin: {sigilkit-mcp}`, and `files: ["dist","README.md"]` is identical across all 4. Only `mcp` is `private`-less-and-bin-bearing; the `version` field is `0.1.0` in all 5 and is asserted against the git tag by `publish.yml:39`. Consistent. |
| `echidna.yaml` | YAML | 6 keys | `cryic/echidna-action` only | humans | **F6** — no local consumer, non-blocking consumer. |
| `docker-compose.yml` | YAML | 2 services + 1 volume | `docker compose` | humans | Env-var driven with `:?` / `:-` defaults. Not gated. Acceptable: a wrong value surfaces at `docker compose up`, not silently. |
| `.well-known/security.txt` | RFC 9116 text | `Contact`×2, `Expires`, `Preferred-Languages`, `Canonical`, `Policy` | `check-doc-counts.mjs:checkSecurityTxt()` | humans | **Well gated** — presence, shape, and an unexpired `Expires` are all asserted. The file's own header documents that the URIs are dead until the repo is public. Good practice. |
| `.gitleaks.toml` | TOML | `extend.useDefault`, `allowlist.regexes[]`, `allowlist.paths[]` | `gitleaks` (CI `secret-scan` + `publish.yml`) | humans | Correctly scoped (see §2.4). The `paths` allowlist is pinned to specific download products so a tracked harness source can never match. |
| `.github/workflows/ci.yml` | YAML | 12 jobs | GitHub Actions, `sync-facts`, `check-doc-counts`, `check-waivers`, `validate-workflows`, `assurance-inventory`, `abi-drift.test.ts`, gitleaks | humans | Assert-only by design: a workflow's `env:` block cannot read a repo JSON, so `foundry-scope.json` and `FOUNDRY_VERSION` are asserted and hand-edited. **12 jobs, 3 of them `continue-on-error: true`**, all three registered in `docs/CI-WAIVERS.md`. |
| `.github/workflows/publish.yml` | YAML | 2 jobs (`assurance`, `publish`) | GitHub Actions, same validators | humans | Tag-gated. `publish` requires `needs.assurance.result == 'success'` **and** `sha == github.sha`, so the published artifact is bound to the tested commit twice (job output + `git rev-parse` check). |
| `docs/CI-WAIVERS.md` | Markdown table | see §5 | `check-waivers.mjs` | humans | **F3, F4.** |
| `packages/core/test/WALLET_BEHAVIOR_ALLOWLIST.json` | JSON | `$schema`, `_doc`, `behaviors[]` with `{id, wallet, behavior, expected, verifiedOn, sigilkitDependency, assert}` and optional `{issue, source, harness}` | `wallet-e2e/run.ts:513`, `wallet-e2e/coinbase.ts:102`, `wallet-e2e.manual.test.ts:23` | humans | **Schema is open-ended by design and correctly so** — entries carry wildly different evidence (`verifiedOn` says "not harness-verified" for two of them, which is honest). 8 entries, 5 distinct `assert` kinds. Unlike the vectors, there is no `check-*.mjs` shape gate: a typo'd `assert` value or a missing `expected` is not asserted anywhere. **P3 suggestion:** a 20-line shape check asserting `{id, wallet, behavior, expected, assert}` present and `assert` drawn from a fixed set. The `$schema` URL points at a `schemas/` directory that **does not exist in the repo** — a dangling machine-readable reference. |
| `packages/core/abis/*.json` (7) | JSON ABI array | forge-generated | `abi-drift.test.ts`, `src/abis.ts`, CI + publish regeneration loops | `forge inspect` (both workflows) | **F2** for the empty one. Otherwise the best-gated data in the repo: two-directional set difference, per-file presence, non-empty + parseable + is-array, and a cross-check that CI reads the shared list. |
| `fleet-manifest.json` | JSON | `manager`, `counter`, `scope{expiresAt, windowSeconds, perActionCap, perWindowCap, merkleRoot, countersignAbove, enforceNativeDelta, tokenWatchlist}`, `sharedKey`, `auditedActions[]` | `demo-agent` output | `packages/demo-agent/src/fleet.ts:176` | Demo output, gitignored, `clean.mjs`-removable. Not data. |
| `.bak-ar.json` / `.bak-eip.json` / `.bak-mk.json` | JSON | clones of the 3 vector files | **nothing** | unknown | **F1 — dead data.** |

---

## 8. Recommendations, ordered

| # | Pri | Action | Effort |
|---|---|---|---|
| 1 | **P1** | `check-waivers.mjs`: assert `cells.length === header.length` per row → turns both F3 silent mis-parses into loud failures. Also make a *stale* row a FAIL, or add `--strict` to the `ci.yml:59` step (F4). | 1 h |
| 2 | **P1** | Document the `check-doc-counts.mjs` job-count assertion as the **designated** backstop for F5, in `check-waivers.mjs`'s header. The coverage is real but accidental; a future refactor of the doc guard would silently remove it. | 15 min |
| 3 | **P2** | Delete `.bak-*.json` ×3; add `.bak-*.json` and `echidna-corpus/` to `.gitignore` (F1, F6). | 5 min |
| 4 | **P2** | `scripts/check-echidna-config.mjs`: parse `echidna.yaml`, assert the 6 keys and the contract/function name against `EchidnaProperties.t.sol` (F6). | 2 h |
| 5 | **P2** | Fix the `bootstrap.mjs:34` digit-slice parse → `parseEngineFloor()` from `sync-facts.mjs`. This is the one `error` making `sync-facts --check` exit 1 today (F10), and it is a latent 4 000-machine setup failure. | 15 min |
| 6 | **P2** | Extend the `sync-facts` pattern to a **third fact**: the golden-vector `_provenance` / `casesCount` fields are already asserted by `check-vectors.mjs`, so the remaining gap is that `vectors/*.json` and `.bak-*` clones are indistinguishable to every gate. Asserting "no JSON file outside `vectors/` duplicates a vector corpus" would be a 10-line addition. | 1 h |
| 7 | **P2** | Assert `FOUNDRY_PROFILE` values in ci.yml/publish.yml against the profiles `foundry.toml` actually defines. A typo currently degrades 2 000 fuzz runs to 1 with no error (F7). | 1 h |
| 8 | **P3** | Add a `_schema` note to `eip7702.json` explaining the string-vs-number `chainId` asymmetry, next to the existing `_doc` (F8). The reasoning is in `generate-vectors.mjs` comments; it belongs in the data file. | 10 min |
| 9 | **P3** | One comment in `abi-drift.test.ts` recording that `MerkleWhitelist.json === []` is correct because it is a `library`, so a future "must be non-empty" tightening does not break the build (F2). | 5 min |
| 10 | **P3** | Add a `schemas/` directory or drop the dangling `$schema` URL in `WALLET_BEHAVIOR_ALLOWLIST.json`; add a shape check for the 5 required `behaviors[]` fields. | 1 h |
| 11 | **P3** | Add a comment to `GoldenVectors.t.sol` that it reads `trees[0]` by index, so a second tree would be TS-tested but not on-chain tested. | 5 min |

### Missing schema, stated plainly

Two things a reader would expect to exist and do not:

1. **No JSON Schema anywhere in the repository.** `WALLET_BEHAVIOR_ALLOWLIST.json`
   references `https://raw.githubusercontent.com/sigilkit/sigilkit/main/schemas/wallet-behavior-allowlist.schema.json`,
   and that `schemas/` directory does not exist. The vector corpus, the ABI files, the
   waiver table, and the scope file all have hand-written shape gates instead — which is a
   legitimate choice (a gate that runs beats a schema nobody validates), but it means the
   schema lives in the *checker*, not next to the data, and a consumer that has not read
   `check-vectors.mjs` has no way to know the shape.
2. **No `schema` version field on the vector corpus.** `actionrequest.json` and
   `eip7702.json` share a wrapper vocabulary but have different entry schemas, and nothing
   records which version of either they are. `assurance-inventory.mjs` gets this right for
   itself — it exports `SCHEMA = "sigilkit.assurance-inventory/1"` — and the vectors should
   too. A one-line `"schema": "sigilkit.vectors/2"` per file, asserted by
   `check-vectors.mjs`, would make a future breaking change to the `request` object
   detectable rather than merely visible in a diff.

---

## Appendix — commands run (all read-only)

```
node scripts/sync-facts.mjs --check     # exit 1 — F10, unrelated to the data files
node scripts/sync-facts.mjs --json      # 16 findings, cross-checked against file content
node scripts/check-vectors.mjs          # exit 0 — 3 corpora ok, provenance registry agrees
```

Fragility probes imported `parseRegister` / `parseWorkflow` / `crossCheck` /
`parseWorkflowJobs` / `inventoryCi` as modules and fed them **in-memory mutations** of the
real files. Truncation scenarios wrote only into OS temp directories. No repository file
was created, modified, or deleted in the course of this audit; the one temporary JSON
written into the repo root during the `sync-facts --json` step was removed immediately.
