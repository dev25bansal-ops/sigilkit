# Verified Build Stack 2026

Exact versions to pin, verified against npm registry / GitHub releases / official docs on **2026-08-21** by the build-stack research agent (it corrected its own initial misread: viem is still **v2**, ethers is **v6**).

| Tool | Version | Note for SigilKit |
|---|---|---|
| **Solidity** | `0.8.36` (2026-07-09) | `evm_version = prague` default since 0.8.30. EIP-7702 enabled since 0.8.30; 0.8.36 adds Amsterdam EVM. **No high-level `tx.authorization` global** — sign 7702 auths off-chain in TS. |
| **Foundry** (forge/anvil/cast) | nightly `af70ca2` (2026-08-20); last stable **v1.7.1** | **Pin a nightly commit SHA** in CI (`foundryup -v <SHA>`). Since v1.7.1 only nightlies ship. Built-in `--fuzz-runs`, `--invariant`, `anvil --fork-url` all work. |
| **forge-std** | `v1.16.2` | Install via `forge install`. |
| **Echidna** | `2.3.3` | Secondary fuzzer; Foundry fuzz/invariant is primary. |
| **Slither** | `6.2.4` | CI static-analysis gate (`slither .`), fail on high/medium. |
| **solhint** | `6.2.4` | Lint; defer formatting to `forge fmt`. |
| **Certora Prover** | CLI (pip) | Viable for OSS (free license); heavyweight. |
| **Halmos** | `v0.3.3` (a16z) | **Recommended** Foundry-native symbolic verifier for Diamond/session-manager. Lighter than Certora. |
| **Kontrol** | `v1.0.255` (RV) | Deep specs; higher setup cost than Halmos. |
| **viem** | `2.55.19` (**v2**) | **Primary** TS SDK dep — best 7702/4337/AA typing. |
| **ethers** | `6.17.0` (**v6**) | Optional; viem preferred for new code. |
| **wagmi** | `3.7.6` | Demo/wallet e2e only, not SDK core. |
| **Node.js** | `24` "Krypton" (Active LTS) | `engines: >=24`. |
| **TypeScript** | `7.0.2` (**v7**) | `strict: true`. |
| **pnpm** | `11.22.0` | pnpm workspaces for monorepo. |
| **ERC-4337** | `@account-abstraction/contracts` `0.8.0` (EntryPoint v0.8) | Bundle via Rundler `v0.11.0` / Stackup `v0.6.47`. |
| **UniswapX** | `@uniswap/uniswapx-sdk` `3.1.0` | Treasury demo agent swap/limit-order lib. |

## Monorepo layout (recommended)
```
sigilkit/
├─ pnpm-workspace.yaml        # packages: *
├─ packages/
│  ├─ core/                   # TS SDK: viem wrappers (7702, multi-RPC, session keys)
│  ├─ contracts/              # Foundry lib (forge-installable): src/ + test/ + script/
│  └─ demo-agent/             # wagmi + UniswapX treasury demo (Playwright e2e)
├─ foundry.toml               # src = packages/contracts/src, evm_version = prague
├─ remappings.txt             # forge-std, @account-abstraction -> lib/
└─ .github/workflows/ci.yml   # foundry-rs/foundry-toolchain@v1 + pnpm + slither + halmos
```
Ship Solidity as `forge install`-able + TS as npm SDK; **prefer Foundry over Hardhat**.

---
Tags: #sigilkit #stack #tooling
