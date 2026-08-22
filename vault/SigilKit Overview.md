# SigilKit Overview

> **✅ STATUS (2026-08-23): IMPLEMENTED & COMMITTED (v0.1.0).** Components 1(core)+4+ERC-7579 module are built and verified — see `../CHANGELOG.md`. Component 2 replaced by the 7579 module; Component 3 dropped. Remaining: audit ("the trail"), deploys, real-wallet harness legs.

**SigilKit** is a proposed open-source (MIT-licensed), audited toolkit of four EVM primitives for "agent-native wallets" — smart-contract + SDK components that wallet products (Coinbase Smart Wallet, Biconomy, Pimlico, ZeroDev) are said to each re-implement from scratch. Defined in a July 2026 technical whitepaper (`D:\SigilKit\SigilKit_Whitepaper.pdf`, v2.0).

> ⚠️ The whitepaper reads as a **grant/marketing document** with several fabricated or stale specifics. See [[Whitepaper Corrections]] before trusting any number in it.

## The four components
1. **[[Component 1 — EIP-7702 Wallet Library]]** — `authorize()`/`revoke()`/`validateAuthorization()` + a cross-wallet conformance harness (viem, ethers, MetaMask, Coinbase Wallet) run in CI on every commit.
2. **[[Component 2 — EIP-2535 Diamonds Module]]** — `Diamond.sol` + facets, Foundry library. *Research recommends replacing this with an ERC-7579 module.*
3. **[[Component 3 — Multi-RPC Provider]]** — drop-in resilient viem/ethers transports with auto-reconnect. *Research recommends dropping/deferring — commoditized.*
4. **[[Component 4 — Agent Session-Key Manager]]** — `SessionKeyManager.sol` + `SpendPolicy.sol` + `ActionLogger.sol` with on-chain spend caps, per-window rate limits, Merkle target whitelists, mandatory `ActionLogged` audit event. **This is the moat.**

## Target chains
Base (primary) → Ethereum mainnet, Arbitrum, Optimism. All via CREATE2 deterministic deployment.

## The revised thesis (post-research)
The "standard library nobody built" framing is **false** — shared infra already exists ([[Competitive Landscape]]). The genuine differentiator is the **cross-wallet EIP-7702 revocation conformance harness + on-chain audit-per-call + formal verification** bundle. Build that, not all four components. See [[Build Plan]].

## Stack at a glance
Solidity 0.8.36, Foundry (nightly, pinned SHA), viem 2.55.19, ethers 6.17.0, Node 24 LTS, TypeScript 7, pnpm — full table in [[Verified Build Stack 2026]].

---
Tags: #sigilkit #overview
