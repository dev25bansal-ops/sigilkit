# Component 1 — EIP-7702 Wallet Library

**Role:** hardened, wallet-agnostic TypeScript library for EIP-7702 (now ERC-7702) delegation, plus the **cross-wallet conformance harness** — SigilKit's single strongest differentiator.

**API:** `authorize(wallet, {implementationAddress, chain})`, `validateAuthorization(wallet, auth)` → `true | false | {error:'REVOKED'|'EXPIRED'|'WRONG_CONTRACT'}`, `revoke(wallet, auth)`.

## Verified EIP-7702 facts (Aug 2026)
- **Final** standard. Delegation code = `0xef0100 || address`. Wire format: `authorization_list = [[chain_id, address, nonce, y_parity, r, s], ...]`.
- **REVOKE** = authorization tuple with `address = 0x0`, self-signed; `msg = keccak(MAGIC || rlp([chain_id, address, nonce]))`, `MAGIC = 0x05`.
- **No expiry field.** Replacement = last valid occurrence wins (nonce semantics). **No 2026 erratum.**
- Solidity **has no high-level `tx.authorization` global** — auths are signed **OFF-CHAIN** in the TS lib (Yul/assembly only if verified in-contract).
- Real canonical addresses (CREATE2, all chains): `EIP7702Proxy 0x7702cb554e6bFb442cb743A7dF23154544a7176C`; `CoinbaseSmartWallet 0x000100abaad02f1cfC8Bbe32bD5a564817339E72`. The whitepaper's "0xcc… SecurityControl" is **fabricated** (see [[Whitepaper Corrections]]).
- Wallet support: MetaMask (in-UI revoke shipped PR #30969; raw zero-address revoke via `eth_sendTransaction` **still rejected** — issue #35520 **open, 14 reactions**); Coinbase Wallet (via `base/eip-7702-proxy`); Ambire "7702-ready"; OKX wallet-core. **Rabby: no 7702 code found. Safe: experimental POC only (`5afe/safe-eip7702`, 52★).**
- viem 2.55.19 has `signAuthorization` + `erc7702` helpers (7702 stabilized in v2.x, PR #3427 Mar 2025). viem #3285 (0 reactions): **JSON-RPC account signing still local-accounts-only**. ethers 6.17.0 has `Signer.authorize()` / `Authorization` (no v7; a `beta-eip-7702` tag exists).

## Conformance harness design → see [[Agent Architecture]]
Test matrix: getNonce → build tuple → EIP-712 sign → submit (eth_sendTransaction setAuthorization + type-4 tx) → 4337+7702 bundle → REVOKE → recommit. Asserts **byte-identical** `authorization_tuple` + digest across viem, ethers, MetaMask, Coinbase. Acts as a **security canary** via a versioned `WALLET_BEHAVIOR_ALLOWLIST`.

## Competitors already shipping
`base/eip-7702-proxy` (73★), `codeesura/eip7702-clean-delegation` (revoke CLI, 13★), `ethanzhrepo/eip7702cleaner` (Go, 23★), `Uniswap/calibur` (65★), `okx/wallet-core` (68★), `openfort-xyz/openfort-7702-account` (7★). The conformance harness is what none of these build.

---
Tags: #sigilkit #component #eip-7702
