# SigilKit 7702 Threat Map

**Date started:** 2026-09-23 (30-day plan W1-1.4) · **Status:** living doc — every row ends in a task ID, an audit-prep check, or an accept-with-reason. Sources: `docs/ECOSYSTEM-RESEARCH-2026-09-23.md` §2 (which carries the primary URLs).

**Assessment procedure (per vector):** (1) locate the corresponding trust assumption in `contracts/src/SigilKitDelegator.sol`, the ERC-7579 validation module, and the core SDK's signing path; (2) mark exposure **Exposed / Mitigated / Not-applicable** with the exact code anchor; (3) assign severity (Critical/High/Medium/Low); (4) attach a task ID (W*.*) or an accept-with-reason.

## Vectors

| # | Vector (source) | Where SigilKit touches it | Exposure | Severity | Action |
|---|---|---|---|---|---|
| 1 | `tx.origin == msg.sender` broken by delegation → reentrancy bypass (CertiK 2025-05-06) | SDK-user contracts + module callback paths that gate on origin | Not assessed on Day 1 | High | W1-5.2 deep-dive; W4-1.1 audit-prep check |
| 2 | Flash-loan sandwiching of EOA-code checks (CertiK) | Any `extcodesize`-style checks in module/manager | Not assessed on Day 1 | Medium | W1-5.2; docs note in W3-4.1 |
| 3 | `extcodesize` misclassification of delegated EOAs (CertiK) | SDK key-storage heuristics, manager guards | Not assessed on Day 1 | Medium | W1-5.2; docs note in W3-4.1 |
| 4 | One signed authorization tuple = persistent control (arXiv:2512.12174) | Grant/revoke lifecycle: revocation must actually clear delegation | Mitigated-by-test: harness asserts raw zero-address revoke is REJECTED by MetaMask (canary PASS 13.49.0) | High | Retest each wallet leg: W-1 cadence; allowlist `metamask:revoke-raw-rejected` |
| 5 | ERC-4337 remote activation of the delegation (arXiv:2512.12174) | Module executes through EntryPoint; delegated EOA could be activated remotely | Not assessed on Day 1 | High | W1-5.2; W4-1.1 |
| 6 | Chain-agnostic replay via `chain_id=0` authorization tuples (arXiv:2512.12174) | How SigilKit builds/relays type-4 txs and signAuthorization payloads | Not assessed on Day 1 | High | W3-4.1: chain-id-bound tuples + negative tests |
| 7 | Sweeper contracts copy-pasted onto delegated EOAs (>97% of early delegations; $1.54M loss 2025-08-24) | Designator address is a fixed, audited contract — users must never delegate to arbitrary code | Mitigated-by-design: fixed SigilKitDelegator designator | High | Sweep-guard test in W3-4.1 |
| 8 | `validateUserOp`/`postOp` mistakes (Trail of Bits six-mistakes, 2026-03) | ERC-7579 module validation flow | Not assessed on Day 1 | High | W4-1.1 checklist (all six items), W3-3.2 ERC-1271 chain-binding test |
| 9 | Delegation revocation rejected by raw zero-address tuple (MetaMask #35520) | SDK revoke path must route via in-UI revoke or relayer-signed type-4, never raw eth_sendTransaction | Mitigated: canary PASS on 13.49.0; allowlist entry `metamask:revoke-raw-rejected` | Medium | Keep canary in every wallet leg run (W-1) |
| 10 | Unbounded authorization nonce reuse / inheritance | Grant nonce handling in the SDK | Not assessed on Day 1 | Medium | W1-5.2 |

## Day-1 state
- Rows 4, 7, 9: mitigation evidence exists (harness canary + fixed-designator design) — evidence logged in `outputs/wallet-e2e-20260922an.log` and the allowlist.
- Rows 1-3, 5, 6, 8, 10: assessment deferred to W1-5.2 (deep-dive) and closed by W3-4.1 mitigations + W4-1.1 audit-prep report. Both are scheduled tasks in `docs/PLAN-30-DAYS-2026-09-23-to-2026-10-22.md`; nothing here is unowned.