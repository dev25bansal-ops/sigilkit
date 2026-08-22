# Agent Architecture

Implementation-ready design for the two hardest components, from the agent-architecture planner (Aug 2026). Pins Solidity 0.8.36 / Foundry nightly (whitepaper's 0.8.24 is outdated — see [[Whitepaper Corrections]]).

## Part A — Component 1 conformance harness (EIP-7702)

### Canonical test matrix
Drives one shared sequence; asserts **byte-identical** `authorization_tuple = [chain_id, address, nonce, y_parity, r, s]` + EIP-712 digest across all clients.
1. **getNonce** — `eth_getTransactionCount` on an Anvil fork pinned to a known block.
2. **buildAuthorization** — delegate: `address = EIP7702Proxy (0x7702cb554e6bFb442cb743A7dF23154544a7176C)`; revoke: `address = 0x0`.
3. **EIP-712 signing** — domain `{chainId, verifyingContract: 0x0000…0001}`; type `Authorization`, `MAGIC = 0x05`; digest `keccak(MAGIC || rlp([chain_id, address, nonce]))`. Self-signed off-chain.
4. **submit** — `eth_sendTransaction` with `setAuthorization` (viem/ethers local) + full **type-4** tx carrying `authorizationList`.
5. **4337+7702 combined** — bundle a 7702-delegated EOA as EntryPoint caller; assert `0xef0100||address` active post-confirmation.
6. **REVOKE** — zero-address tuple; assert delegation cleared; raw path **rejected** where #35520 applies.
7. **recommit/replace** — two auths same block; assert **last valid occurrence wins**.

### Wallet-by-wallet CI
- **viem:** anvil + viem test client, full control; snapshot tuple, replay vs ethers.
- **ethers:** `JsonRpcSigner` on same fork; `Signer.authorize()` reference; assert byte-equality.
- **MetaMask:** Anvil fork + **Playwright** driving the extension vs `metamask-test-dapp`. Empirically answer: (a) accepts `eth_sendTransaction` with `authorizationList`? (b) raw zero-address revoke fails with "External EIP-7702 transactions are not supported"? (c) in-UI revoke (PR #30969) produces valid tuple? Assert (b) true; regression-flag if it flips.
- **Coinbase Wallet:** same Playwright + fork via SDK; assert tuple matches spec; document RPC quirks in allowlist.

### What can't be automated + fallback
Real extension UIs can't be hermetically pinned (auto-updates, captcha, flaky popups). **Fallback:** assert the SDK/extension-produced `authorization_tuple` + signature bytes match the EIP-7702 spec deterministically via an independent reference impl (hand-rolled keccak/rlp/secp256k1); pin wallet RPC behaviors behind a versioned **`WALLET_BEHAVIOR_ALLOWLIST`** (e.g. `metamask:revoke-raw-rejected:true@ext-v12`). CI **fails** if a wallet regresses on any behavior SigilKit depends on.

### Security-control role
The harness is a **canary**. If MetaMask silently starts accepting raw zero-address revoke (or drops it), the allowlist assertion trips and CI fails **before any user** ships a broken revocation. Pin against `0x000100abaad02f1cfC8Bbe32bD5a564817339E72` (CoinbaseSmartWallet) to catch delegate-target drift.

### Repo layout
```
foundry-lib/test/conformance/7702Conformance.t.sol
ts/harness/runConformance.ts            # viem + ethers clients, tuple diff engine
ts/harness/playwright/metamask.spec.ts
ts/harness/playwright/coinbase.spec.ts
ts/harness/WALLET_BEHAVIOR_ALLOWLIST.json
.github/workflows/conformance.yml        # anvil fork + ts runner + playwright matrix
```

## Part B — Component 4 session-key manager + demo agent

### Contract sketch (Solidity 0.8.36; canonical-over-whitepaper)
Namespaced storage via `keccak(facetName) - 1`.

```solidity
struct SessionKey {
  address key; uint48 expiresAt; uint256 perActionCap; uint256 perWindowCap;
  uint48 windowStart; uint256 windowSeconds; uint256 spentThisWindow;
  bytes32 merkleRoot; bool revoked;
}
struct ActionRequest {
  bytes32 agentId; address target; bytes4 selector; uint256 value;
  uint256 nonce; uint48 expiry; bytes32 rationaleHash;
  bytes merkleProof; bytes callData;
}
```
EIP-712 `ActionRequest` signed by active session key, domain `{name:"SigilKit", version:"1", chainId, verifyingContract}`.

**Functions:** `grantSessionKey(SessionKey)`, `rotateSessionKey(old,new,overlapEnds)`, `revokeSessionKey(key)`, `executeWithSessionKey(ActionRequest, sig)`.
**Modifiers:** `onlyOwner` (Safe 2-of-3), `sessionScope` (rejects `OWNER_ONLY_DENYLIST` selectors — upgrade/withdraw-all/revoke), `nonReentrant`, `notRevoked`, `freshNonce`.
**Event:** `ActionLogged(bytes32 agentId, address target, bytes4 selector, uint256 value, bytes32 rationaleHash, uint48 blockTimestamp)` — **MANDATORY** after every successful inner call.

### Spend enforcement + blind-spot mitigation
`enforceSpend(req)`: `value <= perActionCap`; `value + spentThisWindow <= perWindowCap` (rolling reset when `now - windowStart >= windowSeconds`). Track `spentThisWindow += value` in effects. **Internal-transfer blind spot:** calldata can't see nested ERC-20 pulls → mitigate via (a) trusted-target allowlist (UniswapX settles via permit2, no arbitrary pull), (b) post-hoc `ActionLogger` reconciliation (sum `ActionLogged.value` vs balance deltas), (c) optional ERC-20 permit/allowance pre-check.

### Merkle target whitelist
`merkleRoot` per key; caller passes proof; `verify(root, keccak(target||selector), proof)`. **Empty root = allow all (dangerous); agent-first default = single-target root.**

### Demo agent — autonomous USDC treasury manager (Base Sepolia)
End-to-end across all four components: (1) C1 delegates EOA via `signAuthorization` → `0xef0100||EIP7702Proxy`; (2) C3 resilient RPC picks healthiest endpoint; (3) `grantSessionKey` scopes key to UniswapX, single target, 1h expiry, cap = min(balance, per-action); (4) agent emits limit-order intent → builds `ActionRequest` → signs via EIP-712 session key; (5) `executeWithSessionKey` enforces SpendPolicy (per-action + rolling window + Merkle), runs inner call CEI, emits `ActionLogged`; (6) receipt (tx hash, gas via paymaster, action id, signed audit proof) returned to agent fleet.

**Verification:** Halmos v0.3.3 proves Diamond + session-manager invariants (last-wins, owner-denylist unreachability by session key, mandatory-emit).

---
Tags: #sigilkit #architecture #conformance #session-key
