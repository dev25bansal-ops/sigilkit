# Component 2 — EIP-2535 Diamonds Module

**Role (whitepaper):** audited, OpenZeppelin-grade EIP-2535 Diamond Standard implementation — `Diamond.sol` + facets, Foundry library, Echidna property tests. Closes OZ #2793.

## Verified facts (Aug 2026)
- OZ #2793 **open**, exactly **+1:50 / 64 reactions** — most-upvoted open issue across OZ/ethers/hardhat/foundry. Opened by Nick Mudge (EIP author). OZ declined to ship ("work required to support diamond proxies is too much… become confident about their security").
- Whitepaper's file layout (`DiamondStorage.sol`, `FacetCutLib.sol`) is **non-canonical**. Real mudgen layout: `Diamond.sol` + `LibDiamond.sol` + `DiamondCutFacet.sol` + `DiamondLoupeFacet.sol` + `OwnershipFacet.sol` + `DiamondInit.sol`.
- EIP-2535 status: **Final** (live standard). louper.dev active as ecosystem inspector.
- mudgen reference repos stable but not heavily 2026-active. `solidstate-solidity` (MIT, active Jun 2026) is the best-maintained community Diamond lib. `Timidan/Foundry-Hardhat-Diamonds` (81★) is a modern Foundry template.
- Known Diamond vuln classes: storage collision (cross-facet slot clash), delegatecall reentrancy via facet ordering, ERC-165/loupe selector-correctness, missing `init`/reinitializer checks.

## ⚠️ Research recommendation: REPLACE, don't build
**A bespoke EIP-2535 Diamond for agent wallets is redundant.** EIP-2535 is now mainly used for *fixed-function upgradeable protocols* (Aave, ENS-scale contracts). **ERC-7579 / ERC-6900 own the agent-wallet extensibility slot** — `rhinestonewtf/modulekit` (ERC-7579 modules), RhinoStone SessionKeyManager, Safe7579, ZeroDev Kernel (255★) already provide audited, distributed modular-account infra.

**Default:** ship Component 4's session-key manager as an **ERC-7579 module** installable on Kernel/Safe, inheriting their audited surface + distribution. Drop the hand-rolled Diamond (it's an audit + maintenance liability with no moat). See [[Risk & De-risk Plan]] and [[Build Plan]].

---
Tags: #sigilkit #component #eip-2535 #diamond
