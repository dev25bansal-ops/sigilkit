# Risk & De-risk Plan

From the risk planner, Aug 2026. Blunt version.

## 1. Technical risks
- **Diamond reentrancy & storage collision** (if bespoke): fixed `DiamondStorage` slot, explicit selector registry with collision checks, `nonReentrant` on mutating facets, Slither storage-layout diff in CI. → *Mitigated by shipping as ERC-7579 module instead ([[Component 2 — EIP-2535 Diamonds Module]]).*
- **7702 revoke gotchas:** (a) replay on nonce change — auth tuple bound to nonce; revoke by writing delegator `0x0000…0001`, never re-sign; (b) wrong chainId — `chainId: 0` is replayable cross-chain; enforce non-zero; (c) delegated-code replacement — EOA can point at any impl; forked-mainnet harness exercises set→revoke→re-set.
- **RPC flakiness in CI:** pin Foundry nightly SHA; run against **Anvil fork of Base**, never live public RPCs in CI.
- **Bundler/paymaster edges:** 7702 auth inside ERC-4337 UserOp has undefined edges across bundlers → local bundler integration test; **deferrable, not launch-critical**.

## 2. Competitive risks (per component)
- **C1 (7702):** `base/eip-7702-proxy` + viem/ethers already ship primitives. **Hedge:** build the *cross-wallet conformance matrix* + revoke harness, not a primitive. That's the bundle viem/ethers/Coinbase won't build.
- **C2 (Diamond):** **DEPRIORITIZE/REPLACE** with ERC-7579 module — redundant vs ModuleKit/RhinoStone/ZeroDev Kernel, no moat, audit+maintenance liability.
- **C3 (multi-RPC):** **KILL/DEFER** — commoditized.
- **C4 (audit+verification):** **KEEP** — the moat. Be standards-native (7579, 7702, 4337), not a new standard.

## 3. Market-realization risks
- "Nobody built it" narrative is **FALSE** — correct the whitepaper before launch.
- Agent-native wallets still "very early" (arXiv:2606.13892). Target *integrators*, not end users.
- **Grant dependence:** Code4rena closing; Gitcoin campaign-based; Optimism #274 closed; **Base Batches 004 ($100K)** + **Arbitrum Audit Program ($10M ARB)** are the real levers.
- **Audit cost:** $40k–$120k private, 2–3mo lead. Book week 1. Use Halmos not Certora.

## 4. Regulatory risks by region
- **US (GENIUS/CLARITY, SEC):** "no KYC / globally relevant" is a liability — GENIUS imposes KYC/AML on stablecoin flows; non-custodial tooling facilitating US stablecoin movement can attract BSA scrutiny. Position as **non-custodial open-source dev tooling**; ship no fiat ramp.
- **EU MiCA:** travel-rule/CASP obligations clash with "no KYC" — clarify SigilKit is **not a CASP**.
- **India (30% TDS, #1 adoption):** 30% TDS + 1% TCS makes retail flow friction-heavy; overstates India usability. Provide tax-reporting data hooks; don't evade.
- **Cross-cut:** retire "no KYC / globally relevant" → *permissionless, non-custodial, integrator-owns-compliance.*

## 5. Timeline realism
12 weeks for **all four + audit**, one engineer = **not real**. Critical path: (1) **audit booking** week 1; (2) conformance harness; (3) mainnet gate (fork + Halmos). **MVP cut:** ship C1 + C4 + harness + one audit (~6–8 wks), defer C2 (as 7579) and C3.

## 6. Decisions before writing code (recommended defaults)
1. Diamond vs ERC-7579 → **replace C2 with 7579 module.**
2. First-release scope → **C1 + C4 + harness + audit; defer C2/C3.**
3. Audit strategy → **book private audit week 1, Halmos not Certora, Arbitrum Audit Program subsidy, contest later.**
4. Positioning → **non-custodial dev tooling; integrator owns compliance.**
5. Messaging → **lead with cross-wallet 7702 revocation conformance + per-call audit + formal verification; correct fabricated citations (0xcc…, viem #3285, IC3 quote, Optimism #274, Helix) + false "nobody built it" before launch.**

---
Tags: #sigilkit #risk #de-risk
