# Deploy & Ops Manual — SigilKit

**Date:** 2026-09-26 · **Scope:** `contracts/script/`, `foundry.toml`, `echidna.yaml`,
`remappings.txt`, EIP-7702 upgrade/revocation paths · **Layer:** L3 (plan/ops record).
Per `docs/STATUS.md`, the **code is normative** — where this document and
`contracts/src/` disagree, the code is right and this document is a bug.

> **Pre-audit software.** No third party has reviewed these contracts
> (`SECURITY.md`, `docs/DEPLOYMENT.md`). Everything below assumes a testnet-first
> posture and a Safe in front of the owner role.

> **Verification status of this document.** No `forge` binary was available in the
> environment where this was written, so **no claim here is backed by a `forge`
> invocation.** Findings are from reading `contracts/`, `foundry.toml`, `echidna.yaml`,
> `remappings.txt`, `.github/workflows/`, `.gitleaks.toml` and `docs/`. Every item
> marked **[verify]** needs one command run to confirm or refute it; the command is
> given. Everything else is a direct read of a file that is quoted with its line number.

---

## 1. Deployment script assessment

`contracts/script/` contains exactly two files. There is no third.

### 1.1 Evaluation table

| # | Check | `Deploy.s.sol` | `DeployDeterministic.s.sol` |
|---|---|---|---|
| 1 | **Dry-run protection** (cannot accidentally hit mainnet) | ⚠️ **PARTIAL** — Foundry's `--broadcast` opt-in is the only guard. No chain-id assertion, no testnet allowlist, no "am I on mainnet?" check. | ⚠️ **PARTIAL** — same. Salt/owner guards are about *determinism*, not *target safety*. |
| 2 | **No well-known-key fallback** | ✅ `vm.envUint` (line 25) reverts when unset. The historical `0xA11CE` fallback (`vault/Audit Raw Findings 2026-08-24.md:80-82`) is fixed. | ✅ same (line 24). |
| 3 | **Owner address not silently the broadcaster** | ⚠️ **WEAK** — `vm.envOr("SIGILKIT_OWNER_ADDRESS", address(0))` then `owner = vm.addr(broadcasterKey)` (lines 26-33). A forgotten env var on mainnet yields a **single hot EOA** with `grantSessionKey` / `revokeSessionKey` / `withdraw` authority. | ✅ **STRONG** — reverts if owner is unset (lines 26-28), with a correct justification. |
| 4 | **Hardcoded key / API key / deterministic owner** | ✅ none. Key is env-injected; no literal. | ✅ none. `DEPLOYER_PROXY` (line 21) is a well-known **contract** address, not a key. |
| 5 | **Deploy-order dependencies handled** | ❌ **N/A-but-missing** — deploys only `SessionKeyManager`. Nothing depends on it, so ordering is trivially fine. But see §1.3: the contracts that *do* need ordering have no script. | same |
| 6 | **Post-deploy verification in-script** | ❌ none — only `console2.log` (lines 39-45). No `owner()` read-back, no `extcodehash != 0` assert. | ⚠️ partial — `require(deployed == predicted, …)` (line 50) is a genuine post-condition, but it is a **script-level revert, not a transaction**: the CREATE2 has already been broadcast when it fires (see §1.2). |
| 7 | **`forge verify-contract` / block-explorer verification** | ❌ **absent repo-wide.** `docs/DEPLOYMENT.md:60` tells the operator to pass `--verify`, but **no `ETHERSCAN_API_KEY` (or any explorer key) is read anywhere** — not in `.env.example`, not in `docs/CONFIGURATION.md`, not in CI secrets. `--verify` will silently fail or be skipped. | ❌ same |
| 8 | **Idempotency / re-run safety** | ⚠️ re-running mints a **second** manager at a new address (plain `CREATE`, nonce-derived). No "already deployed" check. | ✅ re-run reverts (CREATE2 to an occupied address), i.e. fails loud. Good. |
| 9 | **Solc/lint clean under `deny = "warnings"`** | ✅ builds clean — no suppression annotations needed. | ✅ one annotated: `// forge-lint: disable-next-line(unsafe-typecast)` (line 45) with a written justification. Correct use. |

### 1.2 Findings

**OPS-01 · `Deploy.s.sol` will happily deploy to mainnet with an EOA owner.**
`--broadcast` is opt-in, which is the only thing standing between a typo and a live
deployment. `DeployDeterministic` proves the author knew better — it reverts on an
unset owner with exactly the right reasoning — but the **default documented path for
mainnet** (`docs/DEPLOYMENT.md:55-61`) is the weaker script. Two concrete additions:

```
// after resolving owner, before startBroadcast
uint256 chainId = vm.envOr("SIGILKIT_CHAIN_ID", block.chainid);
require(block.chainid == chainId, "chain id mismatch: set SIGILKIT_CHAIN_ID explicitly");
require(owner != vm.addr(broadcasterKey) || vm.envOr("SIGILKIT_ALLOW_EOA_OWNER", false),
        "owner == broadcaster: set SIGILKIT_OWNER_ADDRESS (a Safe), or opt in explicitly");
```

**OPS-02 · `DeployDeterministic`'s post-condition is not atomic.**
`vm.stopBroadcast()` is line 48; `require(deployed == predicted, …)` is line 50. In
`forge script`, broadcast transactions are sent as they are executed, so if the
`require` fails the deployment is **already on chain** while the script exits non-zero.
An operator who sees the failure and re-runs gets a *different* outcome depending on
whether the proxy call reverted or the address merely mismatched. Move the comparison
**before** `vm.stopBroadcast()`, or drop the `require` in favour of a `console2.log`
warning plus an explicit non-zero exit — but do not leave a hard `require` after the
broadcast boundary. (Low severity: the mismatch case is close to unreachable, but the
failure mode is "operator re-runs a half-finished deploy".)

**OPS-03 · No explorer verification path exists.** `--verify` is documented but
unserviceable. Minimum fix: add `ETHERSCAN_API_KEY=` to `.env.example` and a row to
`docs/CONFIGURATION.md`, then have the script's usage comment state that `--verify`
requires it. Better: after broadcast, `forge verify-contract <addr> --watch` and let a
CI job own it.

**OPS-04 · No deploy script for `SigilKitDelegator`, `SessionKey7579Module`, or
`ActionLog7579Executor`.** Grepped `contracts/script/` and `scripts/`: zero references.
`docs/DEPLOYMENT.md:79-90` documents the 7702 flow in prose, and `SECURITY.md:84-100`
documents the inert-implementation rule, but **there is no runnable command that puts
`SigilKitDelegator` on a chain.** Since `contracts/script/` is this document's exclusive
scope, this is flagged here as the top gap; see §3.4 for the required ordering.

**OPS-05 · Key passed by value on the command line leaks to shell history.**
`docs/DEPLOYMENT.md:57` — `export SIGILKIT_OWNER_KEY=0xYourFundedDeployerKey`. On a
shared or logged host that is in `~/.bash_history` / PowerShell history. Use a
`--ledger` / keystore signer, or read from a file descriptor, for anything past testnet.
The script itself is fine; the doc is the leak.

---

## 2. Key & secret scan

**Bottom line: no real credential is present in the tree.** Every 32-byte hex literal
is either a public Anvil fixture, an ERC-7201 storage slot, a secp256k1 constant, or a
Merkle/digest test vector. Details and the one item that still deserves action below.

### 2.1 Classification of every 64-hex literal (first-party code, deps excluded)

| Class | Values | Verdict |
|---|---|---|
| **Anvil public dev keys** (placeholders) | `0xac0974…2ff80` (anvil #0), `0x59c699…8690d` (anvil #1), `0x65bccb…9003d` (a third "relayer" role) | ✅ Acceptable. Public in every Anvil install; meaningless off a local chain. Already allowlisted by value in `.gitleaks.toml`. |
| **ERC-7201 storage slots** (not keys) | `SessionKeyManager.sol:74`, `SessionKey7579Module.sol:88`, `ActionLog7579Executor.sol:29` | ✅ Not a secret. |
| **secp256k1 group constants** (not keys) | `SessionKeyManager.sol:731`, `SessionKey7579Module.sol:488` (`N/2`), `contracts/test/SessionKeyManager.t.sol:170`, `SessionKey7579Module.t.sol:46` (`N`) | ✅ Not a secret. |
| **Digest / Merkle test vectors** (not keys) | `packages/core/test/eip7702.test.ts:31,47,50,52,54,57,59,61,63`; `merkle.test.ts:98`; `parity.test.ts:29`; `parse.test.ts:19`; `reference.test.ts:117`; all of `vectors/*.json` | ✅ Not a secret. |
| **Real credentials** | — | ✅ **None found.** |

### 2.2 The one item that still deserves action

**OPS-06 · HIGH (exposure, not a secret) — an Anvil private key sits inside a
copy-pasteable `--broadcast` command in the file an SRE opens first.**

- `docs/DEPLOYMENT.md:34` — `0xac0974…2ff80` inside a `forge script … --broadcast` block.

The block is correctly headed `### Local (Anvil)` and immediately followed by prose
about the loud-failure behaviour, so the *intent* is right. The risk is mechanical: a
reader copies the block, swaps `--rpc-url` for a mainnet endpoint, and broadcasts from
a key printed by every Anvil install on earth. The resulting manager is owned by that
EOA and has full `grantSessionKey` / `withdraw` authority.

**The TypeScript path already defends against exactly this and the Forge path does
not.** `packages/demo-agent/src/devkeys.ts:98` `assertSafeDemoEnvironment()` refuses to
start when a known dev key meets a non-loopback RPC, and it runs at **import time**
(line 154) so every entry point is covered. The equivalent assertion does not exist in
`Deploy.s.sol` — which is exactly the fix in **OPS-01**.

Secondary occurrences of the same two Anvil literals (all acceptable, listed for the
rotation SOP's benefit): `packages/demo-agent/src/devkeys.ts:44-45`;
`packages/demo-agent/test/agent.test.ts:26-28`, `smoke.e2e.test.ts:27-29`,
`grant.test.ts:23`; `packages/core/test/conformance.test.ts:28-29`,
`execute.test.ts:17`, `limits.test.ts:35`, `parity.test.ts:19`, `reference.test.ts:106`,
`eip7702.test.ts:111`; `docs/Issues-Catalog-2026-09-12.md:441-442`.

**OPS-07 · LOW — `devkeys.ts`'s comment contradicts its own code.**
Lines 46-51 say the relayer key is *"derived deterministically from a public string
rather than pasted in"*. Line 52 pastes it in as a literal. The key is a throwaway with
no authority, so nothing leaks — but a comment that describes a mechanism the code does
not use is a trap for the next reader. Either derive it (`keccak256`-style, at import)
or fix the comment.

**OPS-08 · Verified clean.** `.env` does not exist (only `.env.example`, and every
value in it is blank or a documented default). No `*.key`, `*.pem`, `*.p12`, keystore,
or mnemonic file outside fixtures. No explorer/RPC/infura/alchemy key literal anywhere.
`broadcast/` is gitignored **and untracked** (verified: `git ls-files broadcast` is
empty), and `scripts/clean.mjs:26-31` documents that it holds only chain-31337 runs
with no `privateKey` field. `.codebuddy/models.json` is gitignored.
The only mnemonic in the tree is Anvil's public dev phrase
(`packages/core/test/wallet-e2e/run.ts:36`) plus a test-only password (`:37`), both
labelled as public fixtures — and **`.gitleaks.toml` does not allowlist the mnemonic**,
so gitleaks is free to keep flagging it if its rules change. **[verify]** with
`node scripts/…`-free manual check: `gitleaks detect --config .gitleaks.toml` locally.

**OPS-09 · History scan is delegated to CI, and that is correct.** `.github/workflows/ci.yml`
`secret-scan` job checks out with `fetch-depth: 0` and runs `gitleaks detect` over full
history. That is the right place for it. **[verify]** the job is green on the current
`main` — a past real key that was later deleted would surface only there, and the
two-literal value allowlist would not hide it.

---

## 3. Upgrade, migration and revocation paths

### 3.1 There is no on-chain upgrade mechanism, by design

`SessionKeyManager`, `SigilKitDelegator`, `SessionKey7579Module` and
`ActionLog7579Executor` are **all immutable and non-upgradeable**. There is no
`upgradeTo`, no UUPS, no `EIP-1967` implementation slot, no beacon. The full external
surface of `SessionKeyManager` is: `adminSelectorDigest`, `transferOwnership`, `owner`,
`grantSessionKey`, `withdraw`, `revokeSessionKey`, `rotateSessionKey`,
`setSelectorDenied`, the five views, and the three typehash getters. Nothing upgrades
anything. `docs/DEPLOYMENT.md:17-28` states this and it is accurate.

**Therefore "upgrade" means: deploy new code at a new address, then move authority and
authority-*adjacent* state across.** For the non-7702 manager that means redeploy and
re-grant keys (cheap — keys are just owner-gated grants). For 7702 it is subtler.

### 3.2 Revoking a 7702 delegation

- **Mechanism.** `packages/core/src/eip7702.ts:143` `signRevocation()` signs an
  authorization whose `contractAddress` is `ZERO_ADDRESS`. Per EIP-7702 that clears the
  account's code entirely. `validateAuthorization()` (`:187`) reads the designator and
  reports `revoked: true` for `0xef0100 ‖ 0x00…00`, `delegated: false` for plain `0x`
  code.
- **The encoding trap is already handled and worth keeping.** `rlpEncodeAddress()`
  (`:68`) emits a fixed **20-byte** string item (`0x94 ‖ 20 × 0x00`) for the address
  field, never the empty-string `0x80`. Using the scalar encoder there would diverge
  from canonical digests for any address with a leading zero byte *and for every
  revocation*. Do not "simplify" this.
- **⚠️ Wallet caveat, already documented at `SECURITY.md:153-157`:** MetaMask
  **rejects** a raw zero-address revocation submitted through `eth_sendTransaction`
  (allowlist `metamask:revoke-raw-rejected`, canary-verified on **12.5.0** — the last
  recorded harness verification of this behavior; CI *pins* 13.49.0 but no 13.x
  verification of this behavior is recorded). Revocation
  must go through a relayer-signed type-4 transaction or the wallet's in-UI revoke.
  Do not build a product flow on the raw path.
- **SDK-layer residual risk** (`docs/SECURITY-7702-THREAT-MAP.md` rows 6 and 10):
  `chain_id = 0` authorizations replay across chains and the authorization nonce is
  not bound by any contract. Both are **SDK/wallet layer, not contract layer** — the
  contracts are safe because the app-layer EIP-712 domain
  (`SessionKeyManager.sol:642-646`, binding `block.chainid` **and** `address(this)`)
  is per-account and per-chain. Scheduled as W3-4.1.

**Runbook — revoke one delegation**

```bash
# 1. Read the current designator. Expect 0xef0100 || <20-byte impl>.
cast code $EOA --rpc-url "$RPC_URL"
# 2. Ask the SDK to build the revocation authorization (address 0x0).
#    Then submit it as a TYPE-4 transaction (relayer-signed), NOT eth_sendTransaction.
# 3. Re-read. code MUST be 0x (or 0xef0100||0x00*20), never the old implementation.
cast code $EOA --rpc-url "$RPC_URL"
```

### 3.3 Migrating a delegated EOA to a new implementation

**This is the upgrade path, and it has a sharp edge that no test currently guards.**

When an EOA delegates, it does **not** get the implementation's storage — it keeps
**its own**, at the ERC-7201 slot hardcoded in
`SessionKeyManager.sol:74` (`0xff085e2083c01c9e351b5b4768e82a6e2037764ef8b048b601e1aeafbe014800`).
So when it re-delegates to a new implementation, **all of its state survives the
migration**: `owner` (which is `address(this)`, the EOA), every `scopes` entry, every
`revoked` flag, every `windows` entry, every `nonces` counter, every
`ownerOnlySelectors` bit.

Consequences an operator must know:

1. **Storage-layout compatibility is the whole migration.** The new implementation must
   keep the **identical** ERC-7201 `_STORAGE_LOCATION` and the **identical**
   `ManagerStorage` field order and types. A reordering, a retype, or a widened integer
   silently reinterprets live delegated-EOA storage. The slot is a compile-time constant,
   so it will not drift on its own — but nothing enforces the *rest* of the layout.
2. **Do NOT call `initializeSelfOwned()` after a re-delegation.** `s.owner` is already
   non-zero in the EOA's own storage, so the one-shot initializer reverts
   `AlreadyInitialized` (`SigilKitDelegator.sol:37`). **That revert is the correct
   outcome** — it means authority carried over. The designator change alone carries the
   authority; no re-initialization is needed or possible.
3. **Session keys survive the migration.** They do not need re-granting, but their
   scopes were written by the *old* code. Review them against the new code's semantics
   before the new implementation is canonical.
4. **`adminSelectorDigest()` is `virtual` and must be overridden by any subclass that
   adds an `onlyOwner` function.** `SigilKitDelegator.sol:55-59` does, and
   `contracts/test/DenylistCoverage.t.sol` asserts the override exists and is folded. A
   new subclass that forgets it understates the admin surface and breaks the digest
   comparison gate.

**OPS-10 · HIGH — the ABI drift gate does not cover storage layout.**
`scripts/abi-targets.txt` regenerates **ABIs only** (`forge inspect … abi --json`) and
CI fails on `git diff --exit-code packages/core/abis`. A change that reorders or retypes
`ManagerStorage` **passes that gate** and then misreads storage in every already-delegated
EOA. The gate is thorough about the ABI (it caught BUG-2 and ABI-01) and silent about
the one thing that makes 7702 migrations lossy.

Recommended gate — compare Foundry's `storageLayout` entry, which it already writes into
the build artifact, for `SessionKeyManager` and `SigilKitDelegator`:

```bash
# in ci.yml, beside the existing ABI-drift step
node -e '
  const a = require("./out/SessionKeyManager.sol/SessionKeyManager.json").storageLayout;
  const b = require("./out/SigilKitDelegator.sol/SigilKitDelegator.json").storageLayout;
  require("fs").writeFileSync("/tmp/sl.json", JSON.stringify({a, b}, null, 2));
'
git diff --exit-code storage-layout.lock   # committed snapshot
```

Ideally that snapshot is generated **once**, reviewed, and then only allowed to change
in a PR that also carries a migration note. That converts "did you break the layout"
from an audit finding into a red CI run.

**Does `SigilKitDelegator` need its own upgrade mechanism?** No — and it must not have
one. Its constructor passes `address(this)` as owner (`:32`), so the implementation owns
*itself*: no external account can ever be its owner, `initializeSelfOwned()` on the
implementation reverts `AlreadyInitialized`, and every `onlyOwner` path reverts
`NotOwner` because nobody can be `msg.sender == address(impl)`. That inertness is the
security property, pinned by `test_Implementation_IsSelfOwnedAndUninitializable`,
`…InitializeSelfOwnedReverts`, `…AdminPathsAreUnreachable`, `…HasNoScopes`
(`SECURITY.md:84-97`). An upgradeable delegator would be strictly worse. The *account*
upgrades; the *implementation* never does.

### 3.4 Required deploy order for EIP-7702 (currently undocumented as commands)

No script implements this. Until one does, an operator must do it by hand, in this order:

1. **Deploy `SigilKitDelegator`** to the chain. *(No script — `forge create` works; it
   takes no constructor arguments.)*
2. **Verify the implementation is inert** *before anyone delegates to it*:
   ```bash
   cast call $IMPL "owner()(address)" --rpc-url "$RPC_URL"   # MUST equal $IMPL
   cast call $IMPL "initializeSelfOwned()" --rpc-url "$RPC_URL"  # MUST revert AlreadyInitialized
   ```
3. **Only then** may users sign authorizations naming `$IMPL`. A user then calls
   `initializeSelfOwned()` **in their own EOA context** — not on the implementation.
4. **Verify per-user** after delegation: `cast code $EOA` is `0xef0100 ‖ $IMPL`, and
   `cast call $EOA "owner()(address)"` is `$EOA`.

**Never** delegate *into* the implementation in a way that could give it an owner
(`SECURITY.md:92-95`). Users must never sign a delegation to any address other than the
canonical `SigilKitDelegator` — >97% of early post-Pectra delegations pointed at
copy-pasted sweeper contracts, with $1.54M+ in documented single losses
(`SECURITY.md:158-161`).

---

## 4. `foundry.toml` audit

`remappings.txt` is **correct and complete** — verified by enumerating every `import` in
`contracts/`: all are either relative (`../src/…`, `./X.sol`) or `forge-std/…`, and the
single line `forge-std/=lib/forge-std/src/` resolves all of them. `.gitmodules` pins
`lib/forge-std` at `680ee6692649dcc7c617e05b2144932618264a83`, and it is a real tracked
submodule (`git ls-files lib/forge-std` → `lib/forge-std`). Dependency resolution is
sound.

### 4.1 What is already right

| Setting | Value | Assessment |
|---|---|---|
| `deny` | `"warnings"` | ✅ Correct, and the modern spelling (`deny_warnings` is the deprecated one — the comment at line 20 is right). Inherited by `ci`/`deep` because Foundry merges `profile.default` as the base layer under the selected profile, so the comment at line 19 is accurate. |
| `optimizer` / `optimizer_runs` | `true` / `200` | ✅ Sensible. 200 is the standard deploy-cost/runtime balance for contracts of this size. |
| `solc` | `0.8.36` | ✅ Pinned. |
| `evm_version` | `prague` | ✅ **Required** for EIP-7702 (Pectra). Correct. |
| `ffi` | `false` | ✅ Correct hardening — no shell escape from a test. |
| profile ladder | `default` 256 · `ci` fuzz 2000 / invariant 256 · `deep` fuzz 10000 / invariant 1000 | ✅ Well-shaped. `ci` is the PR gate, `deep` is nightly, and the nightly job sets `FOUNDRY_PROFILE: deep` (`ci.yml:242`). |
| `libs` / `script` / `test` / `src` | `["lib"]`, `contracts/{script,test,src}` | ✅ Unconventional layout, correctly declared. |

### 4.2 Problems

**OPS-11 · HIGH — `invariant.depth` is never declared, and the repo's own doc-count
guard depends on it.** This is a live `npm run check:docs` failure, not a style note.

`foundry.toml:31-32` (`ci`) and `:38-39` (`deep`) set `runs` and nothing else. The
comment at line 27 says *"invariant depth is config-only"*, which is true — but the
config then declines to set it, so the depth in every run is forge's **default**,
unstated.

That default is load-bearing for CI:

- `scripts/check-doc-counts.mjs:820` `checkInvariantConfig()` resolves
  `forge config --json` under **both** `ci` and `default` (line 900) and compares
  against README. It reads `ciConfig.invariant.depth` (line 826) and treats a
  non-integer-or-≤0 value as a hard problem: *"resolved Foundry configuration is
  missing or invalid"*.
- `README.md:47` claims `4 invariants in 1 suite × **256 runs × 500 calls**`.
- `README.md:112` claims `4 invariants × 256 runs`.

So the README documents a **500-call depth that `foundry.toml` does not state**, and
the guard exists specifically to catch that class of drift. It can only pass today if
forge's built-in default happens to be exactly 500 — an unstated coincidence the repo
does not control and never pinned. It is equally likely the guard is already red
locally and nobody noticed, because the README *table* pattern
(`invariants in N suites × R runs × C calls`) and the *inline* pattern
(`# invariant suite (N invariants × R runs`) are different regexes and only the first
carries a depth group.

**Fix — declare the depth and make it a decision rather than a default:**

```toml
[profile.default.invariant]
runs  = 256
depth = 500      # matches the README table; total call budget = runs × depth

[profile.ci.invariant]
runs  = 256
depth = 500

[profile.deep.invariant]
runs  = 1000
depth = 500
```

**[verify]** run `node scripts/check-doc-counts.mjs` and `FOUNDRY_PROFILE=ci forge config --json | grep -A3 invariant`.
If the resolved depth is not 500, that is the guard doing its job — fix the config or
correct the README table, do not delete the check.

Note the knock-on for OPS-12: `fail_on_revert` is read by neither
`checkInvariantConfig` nor anything else, so the same "rely on an unset default"
pattern applies to it, uncaught.

**OPS-12 · MEDIUM — a test-file comment asserts a config fact the config does not state.**
`contracts/test/SessionKeyManager.invariant.t.sol:27-28` says handler reverts are
expected "(`fail_on_revert=false`)". **No `fail_on_revert` key exists in
`foundry.toml`.** If forge's default for it differs from the assumption — and it has
moved across 1.x — every handler revert becomes a red CI run, or a silently weakened
suite. State it explicitly in `[profile.default.invariant]`, `ci`, and `deep` rather than
depending on a default that can drift.

**OPS-13 · MEDIUM — the seed is not pinned, so failing runs are not replayable.**
No `fuzz.seed`, no `invariant.seed` anywhere. Correct, and the usual instinct is to pin
it — **don't, in CI**: a fixed seed stops the fuzzer finding new inputs, and this
project's whole verification story rests on 2 000/10 000 random runs. Forge prints the
seed of a failing run, so replay is possible but manual. The right fix is documentation
plus a profile, not a pinned CI seed:

```toml
# replay a known failure: FOUNDRY_PROFILE=repro forge test --match-test <name>
[profile.repro.fuzz]
seed = "0x0"        # set from the seed forge printed
[profile.repro.invariant]
seed = "0x0"
runs = 10000
```

Add the seed → command incantation to `docs/TROUBLESHOOTING.md`. Note the knock-on:
`.gas-snapshot` is committed and drift is only *reported* (`ci.yml:256-264`), which is
correct precisely because unit gas lines are deterministic while invariant `reverts:`
counts are seed-dependent — that reasoning is sound and should be preserved.

**OPS-14 · LOW — `fs_permissions` grants read on the entire repository.**
`foundry.toml:13` — `[{ access = "read", path = "./" }]`. The only consumer is
`contracts/test/GoldenVectors.t.sol:19-21`, which `vm.readFile`s exactly three files in
`vectors/`. `./` also covers `.env` and `.git` when present. Narrow it:

```toml
fs_permissions = [{ access = "read", path = "./vectors" }]
```

`ffi = false` plus a scoped `fs_permissions` is a genuinely tight test sandbox; widening
it to the repo root gives that back for no benefit.

**OPS-15 · MEDIUM — `forge lint` is not run anywhere, so the stated guarantee is
stronger than what is enforced.**
`foundry.toml:14-20` claims: *"a compiler warning **or lint finding** is a build
failure … Every remaining occurrence now carries an explicit
`// forge-lint: disable-next-line(...)` … so a NEW one anywhere fails the build."* There
are currently **49** such annotations across `contracts/` (counted).

> **Unverified as of 2026-10-01 (documentation-truthfulness pass):** the "**49** such
> annotations across `contracts/` (counted)" figure was **not re-measured** in this pass — this
> machine has no Foundry, and the `forge-lint: disable-next-line` occurrences live in
> `contracts/**/*.sol`, which is outside this audit slice's editable set. The sentence is left
> in place but is **no longer established fact**; re-run the count before citing it.
> **Conflict registered:** `docs/VERIFY-FIELD-DESIGN-2026-09-26.md` §7.1 states the repository
> actually holds **56** `forge-lint:` annotations, and `docs/SUPPLYCHAIN-2026-09-26.md` restates
> **49**. All three self-date 2026-09-26 and predate this audit, so **no document can be shown
> to supersede the others on date alone**; none of 49 / 56 is treated as proven.
> (The 56 figure in VERIFY-FIELD-DESIGN carries the same unverified marker.)

Solc warnings are unambiguously gated by `deny = "warnings"`. The **linter** is a
half-step: `forge build` runs an inline linter that `deny` does cover, but `forge lint`
is a separate subcommand with a **superset** rule set. Grepping the whole repo for
`forge lint` in `ci.yml`, `publish.yml`, `package.json` and `verify.mjs` returns **no
invocation** — the only matches are `check-doc-counts.mjs` *counting the annotations* for
a docs guard. **[verify]** run `forge lint` locally and confirm whether its output is a
superset of what `deny` blocks; if it is, add one line to the `forge-unit` job:

```yaml
- run: forge lint contracts/src contracts/script
```

This is cheap and makes the comment at `foundry.toml:14-20` true rather than aspirational.

**OPS-16 · INFO — optional reproducibility hardening.**
`bytecode_hash` / `cbor_metadata` are unset, so Foundry's default CBOR metadata is
appended to deployed bytecode. In practice the metadata is a hash of **source content**,
not build paths, so the `DeployDeterministic` CREATE2 address is stable across machines
as long as source and settings match — the prediction at
`DeployDeterministic.s.sol:38` is sound. Setting `bytecode_hash = "none"` would remove
the variable entirely and is worth doing only if the team ever needs byte-identical
runtime code across toolchains. Not urgent; noted for completeness.

**OPS-17 · INFO — `via_ir` is unset (default `false`).** `SessionKeyManager.sol:527`
notes `_interact` is *"isolated in its own frame (stack-depth)"* — i.e. the codegen is
near a stack limit and the code is structured around it. That is fine today; a future
feature that pushes a frame further should reach for `via_ir = true` rather than more
frame-splitting. No action now.

### 4.3 `echidna.yaml`

| Finding | Detail |
|---|---|
| ✅ Config shape correct | `testMode: property`, `seqLen: 100`, `shrinkLimit: 5000` use the **camelCase** forms Echidna 2.x actually reads. The comment at lines 7-8 correctly records that `sequenceLength` / `shrinkingSequenceLength` are silently ignored — that is a real trap and it is documented. |
| ✅ `testLimit: 50000` matches the job | Consistent with `contracts/test/EchidnaProperties.t.sol`'s "one `CREATE` per call so a 50k-transaction campaign stays cheap" reasoning. |
| ✅ Non-vacuous by construction | The harness is carefully built: funding via a public payable `refill()` (BUG-18), `sink` deliberately **not** named `echidna_*` (a payable no-op under `testMode: property` is falsified on call 1), and the admin-attack probe uses `amount 0` so an auth bypass cannot be masked by an insufficient balance. The properties are real claims, not tautologies. |
| ⚠️ **OPS-18 · MEDIUM — `corpusDir: echidna-corpus` does not exist and is not gitignored** | Verified: the directory is absent from the working tree, and `.gitignore` has no entry for it. Two consequences: (a) the first run creates an untracked directory that a `git add -A` will commit, and (b) **there is no persisted regression corpus**, so every nightly starts from zero and all of Echidna's shrinking work is discarded between runs. Fix: commit the minimized corpus (Echidna's `echidna.config` regression file) and add the coverage output to `.gitignore`. |
| ⚠️ **OPS-19 · LOW — no `seed` in `echidna.yaml` either** | Same reproducibility position as OPS-13. Echidna prints its seed; record it in the triage process rather than pinning it. |
| ✅ Waiver is registered and dated | The `echidna-nightly` job carries `continue-on-error: true` (`ci.yml:400`) and has a matching row in `docs/CI-WAIVERS.md` with criterion "14 consecutive green nightly runs" and hard expiry **2026-10-31** — enforced in both directions by `scripts/check-waivers.mjs` in the `workflow-lint` job. The waiver is a *coverage signal, not an assertion of correctness*, and `EchidnaProperties.t.sol:63-72` says so explicitly. That framing is right and should be preserved when the waiver is cleared. |
| ✅ `balanceAddr` / `balanceContract` deliberately unset | `EchidnaProperties.t.sol:27-30` records that `balanceContract` in `echidna.yaml` would fund the *contract under test*, not the wallet — so the `refill()` route was chosen instead. Correct analysis; no action. |

---

## 5. Deployment prerequisites

Nothing below is optional. Items 1-4 are **deployment blockers** that no code change can
resolve (they mirror `docs/DEPLOYMENT.md` §4).

1. **A public repository at the declared URL.** `github.com/sigilkit/sigilkit` and
   `github.com/sigilkit` both returned HTTP 404 anonymously as of 2026-09-15. Until this
   exists, `forge install` as documented in the whitepaper is impossible and
   `repository.url` in every `package.json` resolves to nothing.
2. **An npm namespace this project controls.** `@sigilkit/core` exists on npm at
   v0.11.1, owned by an **unrelated project**. `npm publish` fails `E403`, and
   `npm install @sigilkit/core` installs someone else's package. Decide the scope before
   the first release. `publish.yml` now fails fast on this.
3. **An owner that is not a hot key.** A 2-of-3 Safe (per `vault/Build Plan.md`), or a
   TimelockController behind one. Set `SIGILKIT_OWNER_ADDRESS` — and until **OPS-01** is
   fixed, verify it took effect: `cast call $MANAGER "owner()(address)"` must return the
   Safe, not the deployer EOA.
4. **A funded, disposable deployer key** used only to pay gas, holding no authority.
5. **An archive RPC endpoint** for the target chain (needed by `forge verify-contract`
   and by the fork smoke test).
6. **An explorer API key** for the target chain's block explorer — currently read
   nowhere (**OPS-03**).
7. **A recorded baseline**: the deployment block number and contract address, for the
   indexer's `--from`. Starting at 0 works but scans far more than necessary.
8. **A rehearsed dry run** on a testnet with the *exact* command from §6, including the
   verification step.

---

## 6. Deployment command sequence

### 6.1 SessionKeyManager (non-deterministic address)

```bash
# ── Stage 0 · environment ────────────────────────────────────────────────────
export RPC_URL="https://<testnet-rpc>"
export SIGILKIT_OWNER_ADDRESS="0x<YourSafe>"        # REQUIRED in practice (see OPS-01)
export SIGILKIT_OWNER_KEY="0x<funded deployer key>" # broadcaster ONLY; holds no authority
                                                        # avoid `export` on a shared host (OPS-05)
                                                        # never use an Anvil key here (OPS-06)

# ── Stage 1 · dry run. NO --broadcast. Simulates only; nothing is sent. ──────
forge script contracts/script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL"

# ── Stage 2 · read the simulation output before doing anything else ──────────
#   Confirm: chain id, the constructor arg, the nonce, the gas estimate,
#   and that the broadcaster is NOT the owner.

# ── Stage 3 · broadcast ─────────────────────────────────────────────────────
forge script contracts/script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" --broadcast --slow

# ── Stage 4 · verify (do not skip) ─────────────────────────────────────────
MANAGER=<address from stage 3>
cast code  $MANAGER --rpc-url "$RPC_URL" | head -c 20   # must be non-empty ("0x" + ≥1 hex char)
cast call  $MANAGER "owner()(address)" --rpc-url "$RPC_URL"  # MUST equal $SIGILKIT_OWNER_ADDRESS
cast call  $MANAGER "adminSelectorDigest()(bytes32)" --rpc-url "$RPC_URL"  # review aid; compare to source

# ── Stage 5 · optional explorer verification (needs an API key — OPS-03) ───
# forge verify-contract $MANAGER --watch --rpc-url "$RPC_URL"

# ── Stage 6 · live smoke against the fork ──────────────────────────────────
forge test --match-contract '.*Fork' --fork-url "$RPC_URL"

# ── Stage 7 · record ───────────────────────────────────────────────────────
# Address + block number into your runbook; the indexer needs the block as --from.
```

### 6.2 Deterministic, cross-chain-identical address

Use when the **same address must exist on several chains**. Note the script *requires*
`SIGILKIT_OWNER_ADDRESS` (line 26-28) and a non-zero salt (line 30) — with a fixed salt,
"same address everywhere" only holds if the owner is an explicit address rather than
whoever happened to broadcast.

```bash
export SIGILKIT_OWNER_ADDRESS="0x<YourSafe>"     # same on every chain
export SIGILKIT_CREATE2_SALT="0x<32-byte non-zero>"
export SIGILKIT_OWNER_KEY="0x<funded deployer key>"

# Prerequisite: the canonical deterministic-deploy proxy must exist on the chain.
cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C --rpc-url "$RPC_URL" | head -c 20
# empty ⇒ the script will revert with an actionable message; deploy the proxy
# (nick's method) first, or use Deploy.s.sol instead.

forge script contracts/script/DeployDeterministic.s.sol:DeployDeterministic \
  --rpc-url "$RPC_URL"                                    # dry run
forge script contracts/script/DeployDeterministic.s.sol:DeployDeterministic \
  --rpc-url "$RPC_URL" --broadcast --slow                 # broadcast
```

**The CREATE2 address is a function of `(salt, owner, initCode)` only** — it does not
depend on the chain or the broadcaster. Record it once; it is the same everywhere.
Re-running on a chain where it already exists reverts (fails loud) — that is intended.

### 6.3 EIP-7702: `SigilKitDelegator` (⚠️ no script — manual, see §3.4)

```bash
# 1. Deploy (no constructor args).
forge create contracts/src/SigilKitDelegator.sol:SigilKitDelegator \
  --rpc-url "$RPC_URL" --broadcast --private-key "$SIGILKIT_OWNER_KEY"
IMPL=<deployed address>

# 2. GATE — the implementation must be inert. Do not proceed until both hold.
cast call $IMPL "owner()(address)"            --rpc-url "$RPC_URL"  # MUST equal $IMPL
cast call $IMPL "initializeSelfOwned()"       --rpc-url "$RPC_URL"  # MUST revert AlreadyInitialized

# 3. Only now may users sign authorizations naming $IMPL.
#    User side: sign authorization → submit as type-4 → call initializeSelfOwned()
#               in their OWN EOA context → cast code $EOA == 0xef0100 || $IMPL
```

---

## 7. Upgrade & revocation runbook

### 7.1 Revoke one 7702 delegation

```bash
cast code $EOA --rpc-url "$RPC_URL"
# expect 0xef0100 || <current implementation>

# Build a revocation authorization (address 0x0) with the SDK's signRevocation(),
# then submit it as a TYPE-4 transaction — relayer-signed.
# ⚠️ Do NOT submit a raw zero-address revocation via eth_sendTransaction:
#    MetaMask rejects it (SECURITY.md:153-157, canary 13.49.0).

cast code $EOA --rpc-url "$RPC_URL"
# expect 0x  (or 0xef0100 || 0x00…00) — the old implementation must be GONE
```

### 7.2 Migrate delegated EOAs to a new implementation

```bash
NEW_IMPL=<newly deployed, verified-inert SigilKitDelegator>

# Pre-flight, BEFORE any user migrates:
#  1. storage layout gate is green (OPS-10) — same _STORAGE_LOCATION, same
#     ManagerStorage field order/types.
#  2. adminSelectorDigest() overridden in any subclass that adds onlyOwner (SEC §3.3 #4).

# Per user: sign a NEW authorization naming $NEW_IMPL (incrementing nonce), submit type-4.
cast code   $EOA    --rpc-url "$RPC_URL"   # 0xef0100 || $NEW_IMPL
cast call  $EOA "owner()(address)" --rpc-url "$RPC_URL"   # STILL $EOA — authority carried over
cast call  $EOA "getNonce($AGENT)"  --rpc-url "$RPC_URL"   # nonces survived; do NOT reset

# ⚠️ Do NOT call initializeSelfOwned() after re-delegation. It reverts
#    AlreadyInitialized — and that revert is the CORRECT outcome: it proves owner
#    was never cleared. The designator change alone carries authority.
```

### 7.3 "Upgrade" the non-7702 `SessionKeyManager`

There is none — the contract is immutable. A policy fix means: deploy a new manager,
re-grant keys against it, migrate funds with `withdraw`, and retire the old one (its
keys are individually revocable; the contract cannot be paused or self-destructed).
**Plan key rotation on that assumption** (`docs/DEPLOYMENT.md:26-28`).

### 7.4 Rollback

| Situation | Action |
|---|---|
| Deploy script reverted / wrong address | Nothing to undo — a reverted `forge script` broadcast sends nothing. If a deployment **succeeded** with a wrong owner, that is not revertible: deploy a new manager with the correct owner and migrate funds. `SessionKeyManager` has no pause and no self-destruct. |
| 7702 delegation to a wrong/sweeper implementation | **Revoke immediately** (§7.1) — this is the highest-urgency item in this document. Then have the user sign a fresh authorization naming the canonical `SigilKitDelegator`. |
| Compromised session key | Revoke on-chain via the owner path, then grant a new key (`revokeSessionKey`, then `grantSessionKey`, or `rotateSessionKey` with `overlapEnds` to avoid an agent blackout). |
| Compromised owner key | Transfer ownership **from the Safe** — a single EOA owner means the Safe threshold, not the EOA, is the real control. |
| Compromised deployer key | Nothing to do: it holds no authority by design. Rotate it for gas-funding hygiene only. |
| Explorer verification failed | Not a security event. Investigate metadata/compiler-version mismatch; the on-chain bytecode is unaffected. |

---

## 8. Key rotation SOP

Applies to the **real** deployer/owner/relayer credentials. The Anvil dev keys are
fixtures and are never rotated.

1. **Generate** the replacement on an offline/air-gapped machine. Prefer a hardware
   wallet or an HSM-backed signer; `forge script --ledger` and `--keystore` avoid the
   key ever appearing in argv or shell history (**OPS-05**).
2. **Verify the new credential** against a non-production endpoint before it is trusted
   with anything. Never dry-run a *new* key against mainnet.
3. **Stage it** in the environment as a secret (CI secret, vault, or a
   `SIGILKIT_OWNER_KEY` exported from a file descriptor — not `export KEY=0x…` in a
   shared shell).
4. **Move authority, not just the key.** For the owner, the transfer happens *from the
   Safe*; rotating the deployer key alone changes nothing, because the deployer holds
   no authority. Sequence: rotate Safe signers → confirm threshold → then rotate the
   gas-funding deployer.
5. **Retire the old key** only after the new one has performed one successful
   end-to-end action. Keep the old key offline, not destroyed, until the new one has
   survived a full rotation cycle.
6. **If the old key is ever suspected exposed**: treat as compromised immediately —
   rotate on the Safe, revoke every session key, and re-grant. Do not wait for
   confirmation.
7. **Scan before committing.** `gitleaks detect --config .gitleaks.toml --staged`.
   Remember the allowlist matches the two Anvil values **by value**, so it will not hide
   anything else — but it also means a scanner "pass" on those two files is not evidence.
8. **If a real key ever lands in history**, rotation is not optional and neither is
   history rewriting: rotate first, then rewrite, then force-push and tell every
   collaborator to re-clone. Rewriting alone does not un-expose anything.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `vm.envUint("SIGILKIT_OWNER_KEY")` reverts | Env var unset. **Intentional** — there is no well-known-key fallback. | Export it. Never "fix" this by adding a default. |
| `SIGILKIT_OWNER_ADDRESS required: deterministic deploys are…` | `DeployDeterministic` refuses an unset owner. Intentional. | Set the Safe address. |
| `SIGILKIT_CREATE2_SALT must be non-zero` | Salt unset or `0x0`. | Supply a real 32-byte salt. |
| `deterministic-deploy proxy missing on this chain` | `0x4e59b448…` has no code on this chain. | Deploy the proxy (nick's method), or use `Deploy.s.sol` and accept a chain-specific address. |
| `require(deployed address differs from prediction)` | Post-condition fired — **after** broadcast, so the deployment may already be on chain (**OPS-02**). | Check the chain before re-running. Do not blind-retry. |
| `SessionKeyManager_NotOwner` right after a successful deploy | `SIGILKIT_OWNER_ADDRESS` was not set, so the broadcaster became the owner (**OPS-01**). | Not recoverable on that contract. Deploy again with the Safe set, migrate funds. |
| `AlreadyInitialized` after re-delegating an EOA | Expected and correct — owner survived in the EOA's own storage. | Do nothing. See §7.2. |
| `KeyUnknown` from a freshly delegated EOA | Delegation alone grants nothing; `initializeSelfOwned()` was not called, so `owner == 0` and every admin path reverts. | Call `initializeSelfOwned()` in the EOA's own context. |
| `NotOwner` when calling the delegator *implementation* directly | Correct — the implementation owns itself and nobody can be it. | Call through the delegated EOA, never the implementation. |
| MetaMask refuses a revocation | Known and documented: raw zero-address revocation via `eth_sendTransaction` is rejected (13.49.0 canary). | Use a relayer-signed type-4 transaction, or the wallet's in-UI revoke. |
| An invariant run fails only in CI | Seed is not pinned (**OPS-13**). | Copy the seed forge printed; replay with `FOUNDRY_PROFILE=repro` and a fixed `seed`/`runs`. |
| `forge build` fails on a lint finding you cannot suppress cleanly | 49 annotations already exist; the policy is a written justification per line. | Fix the code, or add a justified `// forge-lint: disable-next-line(<rule>)`. Never add a blanket disable. |
| `check-doc-counts` fails on forge-lint annotations | It counts `forge-lint: disable-next-line` occurrences and compares to the number in `docs/TROUBLESHOOTING.md`. | `node scripts/check-doc-counts.mjs --write`, then update the prose by hand. |
| Echidna job is red | The job is under a registered waiver (`docs/CI-WAIVERS.md`, expiry 2026-10-31) — **a red nightly is a real finding to triage, not a waiver to extend.** | Triage it. Clear the waiver only after the documented criterion is met. |

> **Unverified as of 2026-10-01 (documentation-truthfulness pass):** the troubleshooting row
> above, "`forge build` fails on a lint finding you cannot suppress cleanly", repeats
> "49 annotations already exist". That is the **same unmeasured figure** flagged in **OPS-15**
> (§ the annotation after OPS-15, and contradicted by the **56** in
> `docs/VERIFY-FIELD-DESIGN-2026-09-26.md` §7.1). Not re-measured here; do not cite without
> re-running the count. The row's *advice* — a written justification per suppression line, never
> a blanket disable — is unaffected by the count.

---

## 10. Summary of findings

| ID | Sev | Area | Finding |
|---|---|---|---|
| OPS-01 | Med | `Deploy.s.sol` | No chain-id or owner-vs-broadcaster assertion; will deploy to mainnet with a hot-EOA owner. `DeployDeterministic` already does this correctly. |
| OPS-02 | Low | `DeployDeterministic.s.sol:48-50` | Hard `require` sits **after** `vm.stopBroadcast()` — fails loud but not atomically. |
| OPS-03 | Med | repo-wide | No explorer API key handling anywhere; `--verify` is documented but unserviceable. |
| OPS-04 | **High** | `contracts/script/` | No deploy script for `SigilKitDelegator` / `SessionKey7579Module` / `ActionLog7579Executor`; the entire 7702 path is not deployable from this repo. |
| OPS-05 | Low | `docs/DEPLOYMENT.md:57` | Key exported by value → shell history. |
| OPS-06 | **High** | `docs/DEPLOYMENT.md:34` | An Anvil **private key** inside a copy-pasteable `--broadcast` command. The TS path has `assertSafeDemoEnvironment()`; the Forge path has no equivalent. Not a secret leak — an exposure. |
| OPS-07 | Low | `devkeys.ts:46-52` | Comment describes a derivation the code does not perform. |
| OPS-08 | — | repo-wide | ✅ **No real credentials found.** `.env` absent, no keystore/pem/key files, no API-key literals, `broadcast/` untracked, mnemonic is Anvil's public fixture. |
| OPS-09 | — | CI | ✅ Full-history gitleaks scan in place. Verify the job is green. |
| OPS-10 | **High** | `scripts/abi-targets.txt` | The drift gate covers **ABIs only**. A `ManagerStorage` reordering passes CI and then silently misreads storage in every already-delegated EOA. |
| OPS-11 | **High** | `foundry.toml` | `invariant.depth` never declared. `scripts/check-doc-counts.mjs:820-836` reads `ciConfig.invariant.depth` and fails on a missing value, while `README.md:47` documents `256 runs × 500 calls`. Either forge's default is exactly 500 by coincidence, or `npm run check:docs` is already red. **[verify]** |
| OPS-12 | Med | `foundry.toml` / `SessionKeyManager.invariant.t.sol:27` | A test comment asserts `fail_on_revert=false`; the config never states it. |
| OPS-13 | Med | `foundry.toml` | No `fuzz.seed` / `invariant.seed`; failing runs need manual replay. *(Do not pin in CI — that would stop exploration. Add a `repro` profile + docs.)* |
| OPS-14 | Low | `foundry.toml:13` | `fs_permissions` grants read on the whole repo; only `vectors/` is needed. |
| OPS-15 | Med | `foundry.toml:14-20` | `forge lint` is never invoked; the comment's "or lint finding … fails the build" is stronger than what is enforced. |
| OPS-16 | Info | `foundry.toml` | CBOR metadata left at default. Not a defect; optional hardening. |
| OPS-17 | Info | `foundry.toml` | `via_ir` unset; codegen is near a stack limit by design. |
| OPS-18 | Med | `echidna.yaml:5` | `corpusDir` does not exist and is not gitignored; no persisted regression corpus. |
| OPS-19 | Low | `echidna.yaml` | No seed, same reproducibility position as OPS-13. |
| — | — | `remappings.txt` | ✅ Correct and complete; `lib/forge-std` is a real pinned submodule. |
| — | — | upgrade paths | ✅ `SigilKitDelegator` correctly has **no** upgrade mechanism; its self-ownership is the security property. Migration = re-delegate, and authority carries over automatically. |
