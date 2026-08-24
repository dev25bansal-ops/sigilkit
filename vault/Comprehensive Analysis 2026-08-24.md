# Comprehensive Project Analysis — SigilKit (2026-08-24)

Four specialist review agents audited the repo (solidity-security, CI/infra, TS-SDK quality,
strategy/differentiation). 43 findings, spot-verified against the working tree. Raw transcripts:
[[Audit Raw Findings 2026-08-24]].

## Executive summary

The core engineering is strong — on-chain enforcement with correct CEI ordering, three-encoder
digest conformance, handler-only invariant fuzzing, and a genuinely runnable vertical slice are all
real and above category norms. But the audit surfaced **two High-severity contract bugs**, a
**High-severity SDK crypto bug**, several claims that outrun the code (the project's own brand is
claim-rigor), and a CI/publishing pipeline that has literally never executed (no remote; branch
mismatch). All are fixable in roughly 1–2 focused weeks before the audit ("trail").

## Top issues by severity

### HIGH (fix before anything public)
1. **7579 module: no `msg.sender == account` gate on `validateUserOp`** (~2h) — anyone holding a
   mempool-copied userOp can burn a victim's spend window directly (DoS on the key until rollover).
   Fix: gate at top of function + test. ERC-4337-compatible since accounts invoke validators in
   their own context.
2. **EIP-7702 digest wrong for leading-zero addresses & revocations** (~2h) — `rlpEncodeScalar`
   strips leading zero bytes; canonical RLP encodes addresses as fixed 20 bytes. ~1/256 of delegate
   addresses and ALL revocations (0x0) diverge from viem/go-ethereum. Fix: dedicated
   `rlpEncodeAddress` padding to 20 bytes + property test vs viem's `hashAuthorization`.
3. **Caps cover native value only, but docs claim token-drain mitigations that don't exist**
   (~6h) — whitelisted `USDC.transfer` can drain the whole balance within caps (`value=0`). README/
   SECURITY/INV-1 wording must be corrected immediately, then ship a real mitigation
   (amount-binding leaves or the advertised SDK allowance pre-check).
4. **CI Slither job pins nonexistent version** `slither-analyzer==6.2.4` (PyPI tops at 0.11.x)
   (~0.5h) — job red-screens every run.
5. **Repo unpublished: no git remote; CI triggers on `main` but only branch is `master`** (~4h) —
   no workflow has ever run anywhere. Create GitHub repo, push as main, iterate to green.

### MEDIUM (this sprint)
6. Uninstalled-module scopes stay validatable + resurrect on reinstall (~2h): check
   `initialized[account]` in validateUserOp; document or zero scopes.
7. Both nightly CI jobs dead: no schedule trigger; Echidna condition unsatisfiable even with one;
   fork job matches zero tests (~3h).
8. "Formally verified" claims exceed proof scope — Halmos covers SpendPolicy math only, not auth
   paths (~16h to extend; 1h to reword now).
9. Local zero-gas pre-check skips scope hard-expiry and Merkle membership (~1.5h).
10. Demo nonce derived from confirmed-executions counter → one failed tick wedges future actions
    (~0.5h): let `prepareExecution` fetch nonce itself.
11. Client error paths blur revert vs missing-audit; reverted grant prints "granted" (~2h).
12. Multi-level Merkle proofs never tested against any contract (max depth exercised = 1) (~3h).
13. Invariant suite never fuzzes admin transitions or time-based branches (~8h).
14. No coverage measurement anywhere (~4h): add forge coverage + vitest coverage-v8 thresholds.
15. `handleOps` end-to-end simulation absent — calldata-convention compatibility unproven (~12h).

### LOW (hygiene)
16. Hand-picked ERC-7201 slot constant in module ≠ derived from its namespace (~1h) — fix before
    deploy, breaking after.
17. No low-s malleability check in either ecrecover wrapper (~1h).
18. Deploy script falls back to well-known key 0xA11CE if env unset (~3h); README says
    "deterministic deploy" without CREATE2.
19. rotateSessionKey accepts unknown oldKey when overlapEnds=0, emitting spurious events (~1h).
20. Vacuous conformance test ("digest matches on-chain recovery" asserts nothing) (~1h).
21. README self-contradicts on test counts (34/38/21) and CI size (8 vs 7 jobs, 2 dead) (~1h).
22. Demo-agent invisible to CI (~0.5h); mojibake in its package.json description (~0.25h);
   cli.ts docstring misstates economics 10× (~0.25h); odd-length hex silently left-padded (~0.5h);
   `DelegationStatus.revoked` unreachable via live protocol (~0.25h); dead `toTuple()` (~0.1h).

## Strategic opportunities (beyond fixing)

- **Wire the real wallet legs OR rename the claim**: the flagship differentiator ("cross-wallet
  conformance harness") exists today only as signer-library parity. Either build the two Playwright
  legs (~2wks) or re-market honestly as "three-way signer parity, first cell of the matrix."
- **Executor/hook module emitting ActionLogged** restores the audit moat on the standards-native
  7579 path where adoption will actually happen.
- **Argument-committing whitelist leaves** (binding amounts/recipients per target) would make
  SigilKit the only session-key kit with real token caps — direct differentiator vs Biconomy/OZ.
- **Balance-delta enforcement** inside `executeWithSessionKey` closes the internal-transfer blind
  spot structurally.
- **MCP-server packaging** of prepareExecution/validateAgainstScope/assertAuditEmitted puts
  SigilKit in front of the agent-framework wave.
- **ActionLog indexer + explorer** turns the mandatory event into a visible product surface.
- **ElizaOS memory-injection repro demo** (arXiv:2503.16248) is the perfect threat-model showcase.
- **IEEE S&P 2027 submission** (deadline 2026-11-17, open) — the verified publishable gap is
  exactly this subject matter.
- **Grant double-track**: Arbitrum Audit Program ($10M ARB) + EF ESP rolling window.
- **ERC-7710 delegation adapter / ERC-8004 identity hook** position ahead of standards churn.

## Recommended sequence

Week 1 (pre-public hygiene): items 1–7 + doc corrections (3, 8-short, 21) + low items 16–22.
Week 2: Halmos extension (8), invariant admin/time handlers (13), coverage gates (14),
handleOps sim start (15), decide wallet-legs strategy.
Then: GitHub publish → green CI → npm publish → grant applications → audit booking ("the trail").
