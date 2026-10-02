// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @dev Recover-seam harness (same technique as the Halmos specs): Echidna has no
///      vm.sign, so the fuzzer picks WHICH granted key acts by setting the forced
///      signer. Everything else is the real enforcement core.
///
/// @dev FUNDING (BUG-18). The wallet must hold native value or every `value > 0`
///      execution dies in `_interact`'s `request.target.call{value: request.value}`
///      for lack of funds, `ok` stays false, and the ghost counters the properties
///      read never move — the suite degenerates into vacuous passes. Three funding
///      routes were considered; only the one marked (A) actually works under Echidna:
///
///      (A) CHOSEN — a public `refill()` the fuzzer can call with value, which then
///          pulls the amount into `skm` (see `_ensureFunded`). Echidna funds the
///          SENDER accounts it draws transactions from (`balanceAddr`, `maxValue`),
///          so `msg.value` on that call is real money; the wallet therefore ends up
///          holding native value no matter what sequence the fuzzer builds.
///      (B) REJECTED — `new EchidnaHarness{value: 100 ether}(...)`: the harness is
///          deployed by THIS contract, and Echidna gives the contract under test
///          `balanceContract: 0` (its own default, not a repo setting). The
///          deployment carries no value, so the constructor's `msg.value` is 0 and
///          `transfer(100 ether)` then throws `InsufficientBalance` — the refund
///          makes things worse, not better.
///      (C) REJECTED — `balanceContract` in echidna.yaml would fund the CONTRACT
///          (`SessionKeyManagerEchidna`), not `skm`; even a raised value never
///          reaches the wallet the agent path spends from. It also needs a config
///          change outside this file, and echidna.yaml is not mine to edit.
contract EchidnaHarness is SessionKeyManager {
    address public forced;

    constructor(address owner_) SessionKeyManager(owner_) {}

    function setForced(address a) external {
        forced = a;
    }

    function _recover(ActionRequest calldata, bytes calldata) internal view override returns (address) {
        return forced;
    }
}

/// @title EchidnaProperties — the invariant suite's ghost bookkeeping ported to
///        Echidna properties (enhancement E19): a second, independent fuzzer over
///        the same invariants is a strong audit-readiness signal. Run nightly via
///        CI (echidna-nightly job) with the repository-root echidna.yaml:
///        echidna contracts/test/EchidnaProperties.t.sol SessionKeyManagerEchidna --config echidna.yaml
///
/// @dev WHY THE TARGET SINK IS `sink()` AND NOT AN `echidna_*` NAME. Under
///      `testMode: property` Echidna treats EVERY public `echidna_*` function as a
///      property to falsify. A payable no-op that never returns bool is not a
///      property at all: the ABI has no bool word, so its "return value" reads as
///      empty/false and Echidna falsifies it on the very first call — a guaranteed
///      red run that measures nothing. `sink` is deliberately outside the prefix, so
///      it is an ordinary state-transition target the fuzzer may call but that is
///      never itself asserted on. (Found by the local Echidna 2.2.5 run 2026-09-18.)
///      The same rule governs every new handler added below: `h_*` mutates,
///      `echidna_*` must return a bool, and nothing in between is allowed to carry
///      the prefix by accident.
///
/// @dev THE `continue-on-error: true` EXEMPTION ON THE NIGHTLY JOB. `ci.yml`'s
///      `echidna-nightly` step is not a release gate: it is advisory instrumentation,
///      waived under the documented TD-6 removal criterion in CI-WAIVERS. The
///      waiver exists because a nightly fuzzer red-lights on properties that are
///      still being specified — but a waiver is also exactly what let a suite whose
///      two headline properties were VACUOUS (they could not fail, so they could
///      not inform) stay green for weeks, which is the failure mode BUG-18 fixed.
///      The exemption is retained deliberately: it is a coverage signal, not an
///      assertion of correctness, and it must not be read as evidence the properties
///      hold. A red nightly is a real finding to triage, not a waiver to extend.
contract SessionKeyManagerEchidna {
    EchidnaHarness internal skm;
    address[] internal agents;
    mapping(address => uint256) internal successes;
    mapping(address => uint256) internal successesAtRevoke;
    mapping(address => bool) internal everRevoked;
    mapping(address => uint256) internal ghostMaxPerWindowCap;
    // BUG-18: whether each admin function, invoked by a NON-owner, ever succeeded.
    mapping(uint256 => bool) internal adminSucceeded;

    constructor() {
        // Owner = this contract: h_* calls arrive as msg.sender == this (the fuzzer
        // drives this contract), so onlyOwner admin handlers pass.
        skm = new EchidnaHarness(address(this));
        address[2] memory keys;
        keys[0] = address(0xA11);
        keys[1] = address(0xB22);
        for (uint256 i = 0; i < 2; ++i) {
            agents.push(keys[i]);
            // The seed shape is the "mid" one of the three shapes
            // `echidna_scopesMatchOwnerActions` enumerates — see h_regrant. Using
            // the same triple here is what makes that property's enumeration
            // exhaustive: every scope the suite can produce is one of the three,
            // so a mismatch really does mean an unexposed mutation path.
            skm.grantSessionKey(
                keys[i],
                SessionKeyManager.Scope({
                    expiresAt: uint48(block.timestamp + 365 days),
                    windowSeconds: 7 days,
                    perActionCap: 0.5 ether,
                    perWindowCap: 1 ether,
                    merkleRoot: bytes32(0),
                    countersignAbove: 0,
                    enforceNativeDelta: false,
                    tokenWatchlist: new address[](0)
                })
            );
            ghostMaxPerWindowCap[keys[i]] = 1 ether;
        }
        skm.setForced(keys[0]);
    }

    // ------------------------------------------------------------------
    // Handlers (only reachable state transitions)
    // ------------------------------------------------------------------
    /// @dev BUG-18 funding, step 1 of 2. Echidna funds the SENDER accounts it draws
    ///      transactions from (`balanceAddr`, `maxValue` defaults), never the
    ///      contract under test (`balanceContract` is 0). This public payable is the
    ///      only way value gets in: the fuzzer calls it, `msg.value` is real, and it
    ///      accumulates here as a RESERVE that `_ensureFunded` later pulls into `skm`.
    ///      `payable` is deliberate — it is a state transition, not a property, and
    ///      the fuzzer picks the amount, so the wallet is funded whatever it spends.
    function refill() external payable {}

    /// @dev Tops the wallet up to cover the pending request before executing, so a
    ///      long sequence cannot spend the balance dry and leave every later
    ///      `value > 0` call reverting for the wrong reason (insufficient funds
    ///      instead of a cap decision). Skips the call entirely when already funded.
    function _ensureFunded(uint256 need) internal {
        uint256 bal = address(skm).balance;
        if (bal >= need) return;
        (bool funded,) = payable(address(skm)).call{value: need - bal}("");
        // If the pull failed the wallet cannot cover `need`; returning here keeps the
        // ghost counters honest (no increment) instead of recording a balance-driven
        // revert as if it had been a policy decision.
        if (!funded) return;
    }

    function h_execute(uint256 agentSeed, uint256 valueSeed, uint256 dataSeed) external payable {
        address a = agents[agentSeed % agents.length];
        skm.setForced(a);
        // BUG-18: three value tiers so BOTH the success path and the cap-rejection
        // path are reachable on purpose rather than by luck.
        //
        //   tier 0 — 0 wei: always succeeds, needs no funding. This is the tier
        //            that keeps the ghost counters moving even on the driest run,
        //            and it is what makes the properties non-vacuous at all.
        //   tier 1 — 1 wei .. ~1e9 wei: a REAL transfer, so `_interact` must
        //            actually move value for the call to return true. The bound is
        //            deliberate: Echidna's `balanceAddr` default is 0xffffffff wei
        //            per sender (~1.29e10 wei total), so a wei-scale spend is
        //            fundable from the fuzzer's own float while a 0.5 ether cap is
        //            not. The tier still clears the "inner call failed" path and is
        //            charged against the window exactly like a full-size action.
        //   tier 2 — 2 ether: above every granted perActionCap (0.5 ether), so
        //            SpendPolicy reverts PerActionCapExceeded. Reachable regardless
        //            of wallet balance because the cap check precedes `_interact`.
        //   tier 3 — 0.1 ether (F3): the only value that can actually CHARGE a window.
        //            Added because tiers 0-2 left `echidna_windowSpendUnderCap` with a
        //            ceiling no 50k-transaction campaign could ever breach: the largest
        //            chargeable action was ~1e9 wei, so exhausting even the tightest ghost
        //            cap (0.2 ether) needed ~4e11 actions and the largest (1 ether) ~2e8 —
        //            4000x the `testLimit: 50000` in echidna.yaml. The property compared a
        //            real counter against a constant nothing could reach, so it was
        //            unfalsifiable. 0.1 ether charges against the tight 0.2 ether cap in two
        //            actions and the 1 ether cap in ten, so the cap check is now on the
        //            reachable path for every scope shape the harness grants.
        uint256 tier = valueSeed % 4;
        uint256 value = tier == 0 ? 0 : (tier == 1 ? 1 + (valueSeed >> 2) % 1e9 : (tier == 2 ? 2 ether : 0.1 ether));
        _ensureFunded(value);
        SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
            agentId: keccak256("echidna"),
            target: address(this),
            selector: this.sink.selector, // payable no-op target on this contract
            value: value,
            nonce: skm.getNonce(a),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("echidna"),
            data: abi.encode(dataSeed)
        });
        // The inner call targets THIS contract with a payable no-op so executions
        // succeed whenever the scope allows — the fuzzer explores scope states.
        (bool ok, ) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector, req, hex"deadbeef", new bytes32[](0), bytes("")
            )
        );
        if (ok) successes[a] += 1;
    }

    /// @dev Payable no-op execution target. NOT named `echidna_*`: under
    ///      `testMode: property` Echidna treats every public `echidna_*` function
    ///      as a property, and a non-bool-returning one is falsified instantly
    ///      (found by the local Echidna 2.2.5 run 2026-09-18).
    function sink() external payable {}

    function h_revoke(uint256 agentSeed) external {
        address a = agents[agentSeed % agents.length];
        if (!everRevoked[a] && !skm.isRevoked(a)) {
            everRevoked[a] = true;
            successesAtRevoke[a] = successes[a];
            skm.revokeSessionKey(a);
        }
    }

    /// @dev Re-grants a key with one of THREE deliberately different scope shapes.
    ///      BUG-18: the suite used to re-grant the single 0.5/1 ether/1h shape, so
    ///      `echidna_scopesMatchOwnerActions` compared the contract against a
    ///      constant the owner always wrote — `x == x`, unfalsifiable by
    ///      construction. Differing shapes make "the on-chain scope is one of the
    ///      shapes an owner actually granted" a claim the fuzzer can break: a
    ///      non-owner write path, or a silently mutated field, lands the scope
    ///      outside all three and the property fails.
    ///      `ghostMaxPerWindowCap` tracks the shape's real perWindowCap so INV-1
    ///      stays meaningful as the cap moves.
    function h_regrant(uint256 agentSeed, uint256 shapeSeed) external {
        address a = agents[agentSeed % agents.length];
        // tight: 0.1/0.2 ether over 1h   |   mid: 0.5/1 ether over 7d
        // loose: 1/10 ether over 1d      — all satisfy perWindowCap >= perActionCap.
        uint256 shape = shapeSeed % 3;
        (uint256 perActionCap, uint256 perWindowCap, uint48 windowSeconds) =
            shape == 0 ? (0.1 ether, 0.2 ether, uint48(1 hours))
            : shape == 1 ? (0.5 ether, 1 ether, uint48(7 days)) : (1 ether, 10 ether, uint48(1 days));
        // F3 note: cast to `EchidnaHarness` (via `payable`, because the harness has a payable
        // fallback) rather than calling through the untyped `skm` field, so the `Scope` struct
        // is built against the harness's own declaration. An untyped call silently accepts any
        // ABI-encoding-compatible tuple, which means a field reordered or resized in `Scope`
        // would not be caught here at all — and this file is compiled but never executed by CI
        // (CI runs Echidna, not forge), so the compiler is the only thing standing between a
        // drifted harness and a silently weakened property.
        //
        // BUG-FIX (2026-10 audit pass): the cast target used to be `a` — the AGENT address
        // (`agents[0] = 0xA11`, `agents[1] = 0xB22`). Those are CODELESS addresses, and a
        // high-level Solidity call to an address with no code SUCCEEDS silently (there are no
        // return values to check, so the empty returndata is not an error). Every re-grant
        // therefore landed on an EOA and never reached `skm`.
        //
        // Why that made the suite lie rather than merely do nothing:
        //   • `echidna_scopesMatchOwnerActions` compared `skm.getScope(agent)` — frozen at the
        //     constructor's "mid" shape — against a three-member set, so only the `isMid`
        //     branch was ever live and the re-grant path could not be exercised at all.
        //   • `ghostMaxPerWindowCap[a]` was still overwritten with the SHAPE THAT WAS ASKED
        //     FOR, so `echidna_windowSpendUnderCap` compared real spend against a ceiling the
        //     on-chain scope never had. Fixing only the call target restores both, which is why
        //     the ghost and the on-chain scope must be written by the same call.
        //
        // The call now targets the real harness. `a` remains the KEY being granted.
        EchidnaHarness(payable(address(skm))).grantSessionKey(
            a,
            SessionKeyManager.Scope({
                expiresAt: uint48(block.timestamp + 365 days),
                windowSeconds: windowSeconds,
                perActionCap: perActionCap,
                perWindowCap: perWindowCap,
                merkleRoot: bytes32(0),
                countersignAbove: 0,
                enforceNativeDelta: false,
                tokenWatchlist: new address[](0)
            })
        );
        ghostMaxPerWindowCap[a] = perWindowCap;
        if (!skm.isRevoked(a) && everRevoked[a]) {
            everRevoked[a] = false; // reinstatement re-baselines INV-2
            successesAtRevoke[a] = successes[a];
        }
    }

    /// @dev BUG-18: attacks the admin surface AS A NON-OWNER. Echidna has no
    ///      `vm.prank`, and a low-level `address(skm).call(...)` still arrives with
    ///      `msg.sender == address(this)` — which IS `skm`'s owner — so calling the
    ///      real manager can never impersonate an attacker.
    ///
    ///      The honest way to model "a stranger calls an admin function" without a
    ///      prank cheatcode is to attack a FRESH manager whose owner is the
    ///      attacker: a plain `SessionKeyManager` (the real contract, not the
    ///      recover-seam harness) constructed with `attacker` as owner. This
    ///      contract deploys it, so it is emphatically NOT the owner, and
    ///      `onlyOwner`'s `msg.sender` check is exercised against a caller that
    ///      genuinely lacks authority.
    ///
    ///      A throwaway instance is deliberate. Handing `skm` itself to the
    ///      attacker cannot be undone — the harness would lose the owner role for
    ///      the rest of the campaign, every h_revoke/h_regrant would silently
    ///      no-op, and the OTHER properties would go vacuous again. Attacking a
    ///      separate instance keeps `skm` untouched and the latch monotonic, and
    ///      costs one `CREATE` per call so a 50k-transaction campaign stays cheap.
    ///
    ///      `which` probes every admin function:
    ///        0 grantSessionKey   1 revokeSessionKey   2 rotateSessionKey
    ///        3 transferOwnership 4 setSelectorDenied   5 withdraw
    ///      Each outcome is latched in `adminSucceeded[which]`; nothing here is
    ///      allowed to revert, or the latch would roll back with it.
    function h_attackerAdmin(uint256 which, uint256 seed) external {
        address attacker = address(0xBAD);
        // Fresh instance, real contract, attacker-owned. `skm` is never touched.
        SessionKeyManager victim = new SessionKeyManager(attacker);
        address key = agents[seed % agents.length];
        (bool ok,) = address(victim).call(_adminPayload(which % 6, attacker, key));
        adminSucceeded[which % 6] = adminSucceeded[which % 6] || ok;
    }

    /// @dev Builds the calldata for one admin probe. Split out of `h_attackerAdmin`
    ///      to keep that frame's stack shallow: it holds six branch-local `Scope`
    ///      literals, which inlined blew past the 16-slot limit.
    function _adminPayload(uint256 which, address attacker, address key) private view returns (bytes memory) {
        SessionKeyManager.Scope memory scope = SessionKeyManager.Scope({
            // Time-based by design; the probe only cares about the auth gate.
            // forge-lint: disable-next-line(block-timestamp)
            expiresAt: uint48(block.timestamp + 1 days),
            windowSeconds: 1 hours,
            perActionCap: 0.5 ether,
            perWindowCap: 1 ether,
            merkleRoot: bytes32(0),
            countersignAbove: 0,
            enforceNativeDelta: false,
            tokenWatchlist: new address[](0)
        });
        if (which == 0) return abi.encodeCall(SessionKeyManager.grantSessionKey, (attacker, scope));
        if (which == 1) return abi.encodeCall(SessionKeyManager.revokeSessionKey, (key));
        if (which == 2) {
            // Time-based by design; overlapEnds = now makes rotate revoke the old
            // key outright, exercising the strongest branch.
            // forge-lint: disable-next-line(block-timestamp)
            return abi.encodeCall(SessionKeyManager.rotateSessionKey, (key, attacker, scope, uint48(block.timestamp)));
        }
        if (which == 3) return abi.encodeCall(SessionKeyManager.transferOwnership, (attacker));
        if (which == 4) return abi.encodeCall(SessionKeyManager.setSelectorDenied, (bytes4(0xdeadbeef), false));
        // Amount 0 on purpose. The property tests the AUTHORIZATION gate, and a
        // non-zero amount would mask a bypass: with `onlyOwner` removed, a 1-wei
        // withdraw from an empty wallet fails on BALANCE and the probe would report
        // "safe" for entirely the wrong reason. `to.call{value: 0}` to a codeless
        // address always succeeds, so a bypassed gate shows up as `ok == true` and
        // nothing else can mask it.
        return abi.encodeCall(SessionKeyManager.withdraw, (payable(attacker), 0));
    }

    // ------------------------------------------------------------------
    // Properties
    // ------------------------------------------------------------------
    function echidna_windowSpendUnderCap() public view returns (bool) {
        for (uint256 i = 0; i < agents.length; ++i) {
            if (skm.getWindowState(agents[i]).spentThisWindow > ghostMaxPerWindowCap[agents[i]]) {
                return false;
            }
        }
        return true;
    }

    function echidna_revokedKeysNeverExecuteAgain() public view returns (bool) {
        for (uint256 i = 0; i < agents.length; ++i) {
            address a = agents[i];
            if (everRevoked[a] && successes[a] > successesAtRevoke[a]) return false;
        }
        return true;
    }

    /// @dev BUG-18 REPLACEMENT for the old `echidna_ownerImmutableByFuzzer`, which
    ///      asserted `skm.owner() == address(this)` while no handler could ever move
    ///      ownership — a tautology that could not fail, so its green told us
    ///      nothing. This one states the real claim (INV-4): a non-owner must never
    ///      administer a manager.
    ///
    ///      Why it CAN fail: `h_attackerAdmin` deploys a real `SessionKeyManager`
    ///      owned by `address(0xBAD)` and calls each admin function from this
    ///      contract — a caller that is demonstrably NOT the owner. If `onlyOwner`
    ///      were ever bypassed (modifier regression, a new admin function that
    ///      forgets the guard, a partial-write bug), the probe returns `ok`, the
    ///      latch flips and this returns false. The latch is monotonic, so one
    ///      successful probe in the whole campaign is enough to fail the run.
    ///
    ///      Not vacuous by construction: the probe is a genuine non-owner call, and
    ///      the withdraw probe uses amount 0 so that an auth bypass cannot be
    ///      masked by an insufficient-balance failure.
    function echidna_attackerNeverSucceedsAtAdmin() public view returns (bool) {
        for (uint256 i = 0; i < 6; ++i) {
            if (adminSucceeded[i]) return false;
        }
        return true;
    }

    /// @dev BUG-18 REPLACEMENT for the old `echidna_scopesMatchOwnerActions`, which
    ///      asserted the contract's scopes equalled a hard-coded 0.5 ether / 1 hours
    ///      while every grant handler wrote that same constant — `x == x`. The
    ///      property now asserts the weaker-but-meaningful claim: **every scope on
    ///      chain is one of the three shapes an owner actually granted.**
    ///
    ///      Why it CAN fail: if any write path mutates a scope without going
    ///      through the owner-gated grant handlers — a non-owner write, a silently
    ///      altered field, a partial-update bug — the resulting scope matches none
    ///      of the three enumerated shapes (perActionCap, perWindowCap AND
    ///      windowSeconds must all agree), the loop returns false, and the run
    ///      reports a genuine finding. It is no longer self-fulfilling because the
    ///      compared set has three distinct members instead of one repeated value.
    function echidna_scopesMatchOwnerActions() public view returns (bool) {
        for (uint256 i = 0; i < agents.length; ++i) {
            SessionKeyManager.Scope memory s = skm.getScope(agents[i]);
            bool isTight = s.perActionCap == 0.1 ether && s.perWindowCap == 0.2 ether
                && s.windowSeconds == uint48(1 hours);
            bool isMid = s.perActionCap == 0.5 ether && s.perWindowCap == 1 ether
                && s.windowSeconds == uint48(7 days);
            bool isLoose = s.perActionCap == 1 ether && s.perWindowCap == 10 ether
                && s.windowSeconds == uint48(1 days);
            if (!isTight && !isMid && !isLoose) return false;
        }
        return true;
    }
}
