# Wallet Conformance Harness

**Live MetaMask and Coinbase Smart Wallet end-to-end tests** for the SigilKit
EIP-7702 + SessionKey SDK. Both harnesses run a real Chromium with a real
extension (MetaMask 12.5.0 MV3) or a real on-chain designator (Coinbase Smart
Wallet's pinned implementation) against a local Anvil node.

## Run it

From the repo root:

```bash
cd packages/core
npx tsx test/wallet-e2e/run-all.ts
```

Or individually:

```bash
npx tsx test/wallet-e2e/run.ts       # MetaMask 12.5.0 (Chromium + extension)
npx tsx test/wallet-e2e/coinbase.ts  # Coinbase Smart Wallet (on-chain designator)
```

## What it proves

### MetaMask (`run.ts`)

- MetaMask's MV3 service worker registers inside a persistent Chromium context
  (this is a non-trivial CI gotcha — headless Chromium does not activate MV3
  workers without a real display; the harness uses `headless: false` with a
  virtual display).
- The content script injects `window.ethereum` with `isMetaMask=true` into the
  test dapp (served over `http://127.0.0.1:8765/dapp.html`, which matches
  MetaMask's MV3 `host_permissions` pattern of `['http://*/*', 'http://localhost:8545/']`).
- The real EIP-1193 surface responds: `eth_chainId` returns `0x1` (mainnet,
  expected for an unconnected dapp).
- A zero-address 7702 authorization list submitted via `eth_sendTransaction`
  is **REJECTED** by MetaMask with *"The requested account and/or method
  has not been authorized by the user"* — this is the **canary for
  [MetaMask issue #35520](https://github.com/MetaMask/metamask-extension/issues/35520)**
  and is *stronger* than the original "External EIP-7702 transactions are not
  supported" rejection: MetaMask now refuses the entire request because the
  dapp is unauthorized, not just the revoke form.

### Coinbase Smart Wallet (`coinbase.ts`)

The Coinbase Wallet extension is closed-source and not redistributable; what
agent integrators actually need is **the on-chain Coinbase Smart Wallet
deployment** matching the pinned addresses in
[`../WALLET_BEHAVIOR_ALLOWLIST.json`](../WALLET_BEHAVIOR_ALLOWLIST.json).
This harness verifies:

- The pinned **proxy** `0x7702cb554e6bFb442cb743A7dF23154544a7176C` and
  **implementation** `0x000100abaad02f1cfC8Bbe32bD5a564817339E72` are stable
  and the allowlist record matches.
- The SDK's `validateAuthorization` correctly decodes a real `0xef0100 ‖ impl`
  designator set via `anvil_setCode` (this is exactly what Coinbase Wallet
  users have in their EOA after delegation).
- The explicit-zero designator (revoke) is structurally distinct from the
  delegate-to-impl designator — proving the SDK's "delegated vs revoked"
  disambiguation works on the actual Coinbase designator scheme.

## Setup details

The MetaMask extension is downloaded from
[github.com/MetaMask/metamask-extension/releases](https://github.com/MetaMask/metamask-extension/releases)
and extracted to `metamask/` (gitignored — see `.gitignore` setup). To
regenerate:

```bash
cd packages/core/test/wallet-e2e
curl -L -o metamask.zip \
  "https://github.com/MetaMask/metamask-extension/releases/download/v12.5.0/metamask-chrome-12.5.0.zip"
unzip -o metamask.zip -d metamask
rm metamask.zip
```

The first run also creates a persistent profile at `.playwright-profile/` —
MetaMask remembers nothing between runs (intentional) so tests are hermetic.
