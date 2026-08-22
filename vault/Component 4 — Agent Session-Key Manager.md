# Component 4 — Agent Session-Key Manager

**Role:** agent-first session-key manager — the **moat** of SigilKit. Three Solidity contracts + a TS SDK. On-chain spend caps, per-window rate limits, Merkle target whitelists, and a **mandatory `ActionLogged` audit event per call**.

**Files:** `SessionKeyManager.sol`, `SpendPolicy.sol`, `ActionLogger.sol`. TS SDK wraps them. Exports `grantSessionKey()`, `rotateSessionKey()`, `executeWithSessionKey()`.

## Why this is the differentiator
Competitors exist for 7702 primitives and RPC, but **nobody bundles on-chain audit-per-call + formal verification** for agent session keys. RhinoStone SessionKeyManager and `noders-team/monad-agent-kit` ship session keys, but SigilKit's edge is the **mandatory audit event + Halmos formal verification** of the four security invariants.

## Verified design (from [[Agent Architecture]])
- **EIP-712 typed-action** `ActionRequest { agentId, target, selector, value, nonce, expiry, rationaleHash, merkleProof, callData }` signed by the active session key. Domain `{name:"SigilKit", version:"1", chainId, verifyingContract}`.
- **Namespaced storage** via `keccak(facetName) - 1` to prevent Diamond-style collisions.
- **Spend enforcement (on-chain, no oracle):** `value <= perActionCap`; `value + spentThisWindow <= perWindowCap`; rolling window reset when `now - windowStart >= windowSeconds`.
- **Internal-transfer blind spot (ACKNOWLEDGED):** calldata can't see nested ERC-20 pulls, so `value` undercounts a target that drains tokens mid-call. Mitigations: (a) allowlist of trusted targets that provably never move funds (e.g. UniswapX settles via permit2); (b) post-hoc reconciliation — `ActionLogger` lets off-chain sum `ActionLogged.value` vs balance deltas; (c) optional ERC-20 permit/allowance pre-check.
- **Merkle target whitelist:** `merkleRoot` per session key; caller passes proof; `verify(root, keccak(target||selector), proof)`. **Empty root = allow all (documented as dangerous); agent-first default = single-target root.**
- **ReentrancyGuard + Checks-Effects-Interactions**; **owner gating via `sessionScope` denylist** — session keys can NEVER call owner-only selectors (upgrade / withdraw-all / revoke).
- **Mandatory `ActionLogged(agentId, target, selector, value, rationaleHash, blockTimestamp)`** after every successful inner call — no silent success path.
- **Key rotation:** `rotateSessionKey(old, new, overlapEnds)` — overlap window where both valid; hard blackout = no gap.

## The four security invariants (formally verify with Halmos)
- INV-1: sum of values out via `executeWithSessionKey` within any window ≤ `perWindowCap`.
- INV-2: if `K.expiry < block.timestamp`, no call signed by K modifies state.
- INV-3: `ActionLogged` emitted **iff** inner call succeeded — no silent success.
- INV-4: owner-only functions unreachable via `executeWithSessionKey` regardless of scope.

## Default: ship as ERC-7579 module
Rather than a standalone contract, install on Kernel/Safe (see [[Component 2 — EIP-2535 Diamonds Module]]).

---
Tags: #sigilkit #component #session-key #security
