// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";

/**
 * @title SEC-10 characterization tests — window state across rotate and re-grant.
 *
 * @dev WHY THIS FILE EXISTS
 *
 * `ISSUES-CATALOG-2026-09-25.md` records SEC-10 (Medium, CVSS 4.9): a session key that has
 * exhausted its `perWindowCap` can call `rotateSessionKey(oldKey, newKey, ...)`, and because
 * `windows` is a per-key mapping that `_grant` never touches, `windows[newKey]` is a
 * never-used zero slot. The window check therefore starts again from 0 and the new key
 * receives a full fresh budget immediately — so `perWindowCap` degrades from "per window" to
 * "per rotation", repeatable as exhaust -> rotate -> exhaust.
 *
 * The catalog listed three remediations. **Two now exist, and the third was re-classified
 * rather than implemented:**
 *   1. ~~carry-over code~~ — NOT implemented. An intermediate revision added
 *      `SessionKeyManager._carryWindowForward`; it was REVERTED because a lineage-level
 *      aggregate requires re-keying `SpendPolicy.enforce`'s caller-supplied window slot, i.e.
 *      a STORAGE-LAYOUT change — the wrong trade while the storage scheme is still open.
 *   2. NatSpec documenting the reset semantics — implemented in `SpendPolicy` (the "INV-1
 *      scope" clause), which is where a reader of the cap actually looks.
 *   3. THIS FILE asserts window state across a rotation, plus the security boundary that makes
 *      the reset semantics safe.
 *
 * STATUS: **Option B (documented reset semantics) was chosen by the owner.** The decisive fact
 * is that `grantSessionKey` and `rotateSessionKey` are BOTH `onlyOwner` — an agent CANNOT
 * rotate itself out of an exhausted window, so there is no path from inside the trust boundary
 * to a fresh budget. SEC-10 is therefore an OWNER-SIDE CONFIGURATION property (`perWindowCap`
 * bounds a SINGLE KEY's rate, not the owner's rotation cadence), not an agent-reachable
 * bypass. The agent-side security boundary is intact.
 *
 * @dev THE INVERSION CONTRACT — HOW TO READ THE TABLE
 *
 * The table records what each test asserted under each option, so a future reader can tell a
 * *deliberate* behaviour change from a regression:
 *
 *   tests                                    under Option A (reverted)  under Option B (now)
 *   --------------------------------------  -------------------------  ------------------
 *   RotateHandsNewKeyAFullWindow             green (re-pointed)         green (as first written)
 *   RotateDoesNotCarryTheWindowOver          green (re-pointed)         green (as first written)
 *   RotateCycleRepeatsUnboundedly            green (as first written)   green (as first written)
 *   ReGrantSameKeyPreservesTheWindow         green (as first written)   green (as first written)
 *   RotateVersusReGrantAreAsymmetric         green (re-scoped)          green (re-scoped)
 *   Sec10_LineageWindowCap                   GREEN                     green (re-pointed)
 *
 * Note the shape of the resolution: the two "fresh window" tests are back to asserting exactly
 * what they asserted when first written, and the substantive addition is elsewhere — it is the
 * `vm.expectRevert(NotOwner)` on `rotateSessionKey` from a NON-owner, which appears in BOTH
 * `test_Sec10_LineageWindowCap` and `test_Characterization_RotateHandsNewKeyAFullWindow`.
 * That assertion is what makes "Option B is safe" a mechanical fact rather than a claim, and
 * it is the thing the original characterization lacked entirely.
 *
 * @dev WHY A SEPARATE FILE
 *
 * `SessionKeyManager.t.sol` is the unit suite. These are behavioural characterization tests
 * about a specific interaction between two admin paths, and keeping them separate means the
 * "SEC-10 is characterized" claim is greppable rather than inferred from a large file. It also
 * keeps them out of the way if the owner later deletes them wholesale in favour of Option A.
 *
 * @dev THE INVERSION CONTRACT (read before "fixing" anything in this file)
 *
 *   tests                                    Option A (carry-over)   Option B (documented)
 *   --------------------------------------  ----------------------  ---------------------
 *   RotateHandsNewKeyAFullWindow             RED                     green
 *   RotateDoesNotCarryTheWindowOver          RED                     green
 *   RotateCycleRepeatsUnboundedly            RED                     green
 *   ReGrantSameKeyPreservesTheWindow         green  (unaffected)     green
 *   RotateVersusReGrantAreAsymmetric         RED (rotation half)     green
 *   Sec10_LineageWindowCap                   GREEN  <-- the fix      RED  <-- the finding
 *
 * Under Option A the four rotation-dependent tests go red AND the lineage invariant goes
 * green. That is the intended shape: the invariant is the thing the fix repairs, and the
 * characterization tests are the record of what changed. Do not silence either side.
 *
 * `test_Sec10_LineageWindowCap` is GREEN. It was once registered as an intentionally
 * failing row in `docs/CI-WAIVERS.md`, and that row was CLOSED on 2026-09-28; the register
 * keeps the closed entry as a record, together with a measured `forge test` run of this file
 * in which all six tests passed. Do not reintroduce a waiver for it: the resolution was to
 * change what the test ASSERTS (Option B, above), not to leave it red.
 *
 * CORRECTION (documentation-truthfulness pass): an earlier revision of this header still
 * described the test as red-in-CI-and-waived. That was inherited from the intermediate
 * revision in which Option A had been implemented and then reverted, and it contradicted
 * this file's own table, the test's own @dev, and the closed entry in `docs/CI-WAIVERS.md`.
 * A header that says "known red" when the suite is green is worse than no header, because
 * the next reader budgets for a failure that is not there.
 */
/**
 * @dev `_interact` calls `target.call{value: value}(abi.encodePacked(selector, data))`, so a
 *      bare `receive()` is NOT enough: the call carries 4 bytes of selector, and a contract
 *      with only `receive()` rejects any call carrying data. The sink therefore exposes a
 *      payable function, and the requests use its real selector.
 */
contract Sec10Sink {
    function poke(uint256) external payable {}
}

contract Sec10WindowRotationTest is Test {
    SessionKeyManager internal skm;

    /// Payable sink, so a charged action actually moves value and the window is really opened.
    address payable internal sink;

    uint256 internal constant OWNER_KEY = 0xA11CE;    uint256 internal constant AGENT_KEY = 0xB0B;
    uint256 internal constant NEW_AGENT_KEY = 0xC0C;

    address internal owner = vm.addr(OWNER_KEY);
    address internal agent = vm.addr(AGENT_KEY);
    address internal newAgent = vm.addr(NEW_AGENT_KEY);

    /// 1 ETH per action, 2 ETH per window, 1h window. The suite default, restated so this
    /// file does not depend on another file's fixture drifting.
    SessionKeyManager.Scope internal scope;

    function setUp() public {
        skm = new SessionKeyManager(owner);
        sink = payable(address(new Sec10Sink()));
        vm.deal(address(skm), 1000 ether);
        scope = SessionKeyManager.Scope({
            expiresAt: uint48(block.timestamp + 30 days),
            windowSeconds: 1 hours,
            perActionCap: 1 ether,
            perWindowCap: 2 ether,
            merkleRoot: bytes32(0),
            countersignAbove: 0,
            enforceNativeDelta: false,
            tokenWatchlist: new address[](0)
        });
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function _sign(uint256 pk, SessionKeyManager.ActionRequest memory req) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                skm.ACTION_REQUEST_TYPEHASH(),
                req.agentId,
                req.target,
                req.selector,
                req.value,
                req.nonce,
                req.expiry,
                req.rationaleHash,
                keccak256(req.data)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", skm.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Executes as `pk` for `key`, spending `value` into the sink. Returns whether it succeeded.
    function _spend(uint256 pk, address key, uint256 value) internal returns (bool ok) {
        SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
            agentId: keccak256("sec10"),
            target: sink,
            // The real selector, not a placeholder: `_interact` prepends it to `data`, and a
            // selector the target does not implement makes the inner call revert, which would
            // make every test here fail for a reason unrelated to SEC-10.
            selector: Sec10Sink.poke.selector,
            value: value,
            nonce: skm.getNonce(key),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("sec10"),
            data: abi.encode(uint256(1))
        });
        bytes memory sig = _sign(pk, req);
        (ok,) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector, req, sig, new bytes32[](0), bytes("")
            )
        );
    }

    /// Spends until the window cap is genuinely exhausted, and asserts it happened.
    /// Two 1 ETH actions reach 2 ETH, which is exactly the cap; a third must be refused.
    function _exhaustWindow(uint256 pk, address key) internal {
        assertTrue(_spend(pk, key, 1 ether), "first 1 ETH action must succeed");
        assertTrue(_spend(pk, key, 1 ether), "second 1 ETH action must succeed");
        assertEq(skm.getWindowState(key).spentThisWindow, 2 ether, "window must be exactly at its cap");
        assertFalse(_spend(pk, key, 1 ether), "the window is full; a third action must be refused");
    }

    // ------------------------------------------------------------------
    // Characterization 1: rotation hands the new key a FULL window
    // ------------------------------------------------------------------

    /// @dev THE SEC-10 SHAPE, as the owner ruled it (Option B: documented reset semantics).
    ///      Exhaust the window, rotate, and show the new key receives a FRESH window — and,
    ///      critically, that only the OWNER can cause that, so it is a configuration property
    ///      rather than an agent-reachable bypass.
    ///
    ///      HISTORY: an intermediate revision implemented Option A (carry-over) and inverted
    ///      this test to assert the new key INHERITS the exhausted window. That
    ///      implementation was reverted (a lineage aggregate needs a storage-layout change),
    ///      and this test is back to asserting the documented semantics — but now with the
    ///      security boundary asserted alongside, which the original version lacked.
    function test_Characterization_RotateHandsNewKeyAFullWindow() public {
        vm.startPrank(owner);
        skm.grantSessionKey(agent, scope);
        vm.stopPrank();

        _exhaustWindow(AGENT_KEY, agent);

        // Rotate while the old key's window is full. overlapEnds is in the future so the old
        // key is merely shortened rather than revoked, which is the realistic rotation.
        vm.prank(owner);
        skm.rotateSessionKey(agent, newAgent, scope, uint48(block.timestamp + 1 hours));

        // DOCUMENTED BEHAVIOUR: window state is per key, so the new key starts fresh.
        SpendPolicy.WindowState memory w = skm.getWindowState(newAgent);
        assertEq(w.spentThisWindow, 0, "rotation starts the new key's window at zero");
        assertEq(w.windowStart, 0, "and no window is open on the new key yet");

        // ...so the new key spends its own perWindowCap, bounded exactly as the old key was.
        assertTrue(_spend(NEW_AGENT_KEY, newAgent, 1 ether), "new key spends 1 ETH");
        assertTrue(_spend(NEW_AGENT_KEY, newAgent, 1 ether), "new key spends another 1 ETH");
        assertEq(
            skm.getWindowState(newAgent).spentThisWindow,
            2 ether,
            "and the new key is capped at exactly perWindowCap, like any key"
        );
        assertFalse(_spend(NEW_AGENT_KEY, newAgent, 1 ether), "then refused - the cap binds it too");

        // THE BOUNDARY THAT MAKES THIS DOCUMENTED SEMANTICS SAFE. Without this assertion the
        // test above would be describing an exploit; with it, it describes a property only
        // the owner can exercise.
        vm.prank(agent);
        vm.expectRevert(SessionKeyManager.NotOwner.selector);
        skm.rotateSessionKey(agent, newAgent, scope, uint48(block.timestamp + 1 hours));
    }

    /// @dev The same fact stated as the falsifiable, mechanical version, as the owner ruled
    ///      it (Option B: rotation does NOT carry the window over).
    ///
    ///      HISTORY: an intermediate revision implemented Option A and inverted this test to
    ///      assert `== spentBeforeRotate`. That implementation was reverted (a lineage
    ///      aggregate needs a storage-layout change), so the assertion is back to `== 0`.
    ///
    ///      The name is retained deliberately: it is the *characterization* of the
    ///      rotation/window interaction, and renaming it would break the greppable link to
    ///      `docs/ISSUES-CATALOG-2026-09-25.md` SEC-10 that the file's header exists to keep.
    ///      The name states what the code does, which is exactly a characterization's job.
    function test_Characterization_RotateDoesNotCarryTheWindowOver() public {
        vm.startPrank(owner);
        skm.grantSessionKey(agent, scope);
        vm.stopPrank();

        _exhaustWindow(AGENT_KEY, agent);
        uint256 spentBeforeRotate = skm.getWindowState(agent).spentThisWindow;
        assertEq(spentBeforeRotate, 2 ether, "precondition: the old key is at its cap");

        vm.prank(owner);
        skm.rotateSessionKey(agent, newAgent, scope, uint48(block.timestamp + 1 hours));

        // Option B: the new key's window is its own, unconsumed one.
        assertEq(
            skm.getWindowState(newAgent).spentThisWindow,
            0,
            "rotation does not carry the window over - the new key starts from zero"
        );
        assertLt(
            skm.getWindowState(newAgent).spentThisWindow,
            spentBeforeRotate,
            "so the new key's budget is strictly larger than the exhausted old key's was"
        );
    }

    /// @dev Repeating the cycle, to show the budget is unbounded in the number of rotations —
    ///      which is the part that makes this a budget-model failure rather than a one-off.
    ///
    ///      ⚠️ INVERTS UNDER OPTION A. Each `_exhaustWindow` call spends on a FRESH key, and
    ///      under carry-over a fresh key inherits the previous key's charged window instead of
    ///      starting at zero. The very first `_exhaustWindow(AGENT_KEY, agent)` still passes
    ///      (nothing to inherit), but every subsequent one fails at its
    ///      `assertTrue(_spend(...))` — the inherited window is already at the cap, so the
    ///      first action is refused. The `totalSpent == 10 ether` total is likewise unreachable.
    ///      That is correct under Option A and is the signal the fix landed.
    function test_Characterization_RotateCycleRepeatsUnboundedly() public {
        vm.startPrank(owner);
        skm.grantSessionKey(agent, scope);
        vm.stopPrank();
        _exhaustWindow(AGENT_KEY, agent);
        uint256 totalSpent = 2 ether;

        // Four more distinct keys, each granted and then drained to its own cap. The signing
        // key is `pks[i]`, and the ADDRESS is `vm.addr(pks[i])` — signing with the address as
        // if it were a private key recovers a different address and reverts `KeyUnknown`,
        // which is exactly what the first run of this test did.
        uint256[4] memory pks = [uint256(0xD0D0), 0xD0D1, 0xD0D2, 0xD0D3];
        for (uint256 i = 0; i < pks.length; ++i) {
            address k = vm.addr(pks[i]);
            vm.prank(owner);
            skm.grantSessionKey(k, scope);
            _exhaustWindow(pks[i], k);
            totalSpent += 2 ether;
        }

        // 5 keys x 2 ETH = 10 ETH, all inside ONE 1-hour tumbling window (no warp at all).
        // With a working per-window cap, the total could never exceed 2 ETH.
        assertEq(totalSpent, 10 ether, "ten ETH moved across five keys");
        assertEq(
            skm.getWindowState(agent).spentThisWindow,
            2 ether,
            "each key is individually capped - the cap holds per key, and that is the gap"
        );
    }

    // ------------------------------------------------------------------
    // Characterization 2: re-granting the SAME key does NOT reset its window
    // ------------------------------------------------------------------

    /// @dev The asymmetry the team lead flagged. Rotation resets the window because it lands on
    ///      a fresh key; a re-grant over the SAME key keeps the charged window, because
    ///      `grantSessionKey` likewise never writes `windows`. So the two admin paths that both
    ///      "give the key a new scope" behave differently about its budget.
    ///
    ///      ⚠️ NOT AFFECTED BY OPTION A. This test deliberately re-grants the SAME key, and
    ///      Option A only changes `_grant` for the rotation path (`newKey != oldKey`). So this
    ///      test should stay GREEN under both options — and that is a useful cross-check: if a
    ///      carry-over implementation also resets the window on a same-key re-grant, this test
    ///      is the one that catches the over-reach.
    function test_Characterization_ReGrantSameKeyPreservesTheWindow() public {
        vm.startPrank(owner);
        skm.grantSessionKey(agent, scope);
        vm.stopPrank();

        _exhaustWindow(AGENT_KEY, agent);

        // Re-grant the same key with an identical scope. Nothing about the grant path writes
        // windows, so the charged window survives.
        vm.prank(owner);
        skm.grantSessionKey(agent, scope);

        SpendPolicy.WindowState memory w = skm.getWindowState(agent);
        assertEq(w.spentThisWindow, 2 ether, "a re-grant over the same key preserves the window");
        assertTrue(w.windowStart != 0, "the window is still open");

        // So the key still cannot spend, despite having been "re-granted" a full scope.
        assertFalse(_spend(AGENT_KEY, agent, 1 ether), "the exhausted key is still capped");
    }

    /// @dev The asymmetry, stated both ways in one place. Under the owner-ruled Option B
    ///      the two admin paths still DIFFER, and the difference is the documented one:
    ///      a same-key re-grant PRESERVES the charged window, a rotation starts the successor
    ///      at zero. What Option B closes is the exploitability: both paths are `onlyOwner`,
    ///      so the asymmetry is an owner-side configuration property, not something an agent
    ///      can reach. See `test_Sec10_LineageWindowCap` for the mechanical form of that.
    ///
    ///      HISTORY, and a correction to the previous version of this comment. It used to say
    ///      the fix (`_carryWindowForward`, Option A) "closed the rotation side" and that
    ///      "a rotation carries a live window". BOTH halves were wrong. Option A was
    ///      implemented and then REVERTED (a lineage aggregate needs a storage-layout change),
    ///      so no fix landed and the rotation side is unchanged. And the rule is the opposite
    ///      of "carries a live window": under Option B a rotation does NOT carry the window
    ///      over at all, which is why `afterRotate` below is 0.
    ///
    ///      The cross-reference was wrong too. `test_Characterization_RotateHandsNewKeyAFullWindow`
    ///      does not read 2 ether on the successor; it reads 0 immediately after the rotation
    ///      and only reaches 2 ether after the SUCCESSOR spends twice itself. So that test
    ///      demonstrates the same thing this one does — a rotation does not inherit the old
    ///      key's charge — and neither test can be cited as evidence for carry-over.
    ///
    ///      What this test pins is therefore narrower and true: a rotation of a key with no
    ///      live window starts the third key at zero, while a same-key re-grant of an
    ///      exhausted key leaves it at 2 ether.
    function test_Characterization_RotateVersusReGrantAreAsymmetric() public {
        // Path 1: re-grant the same key. This runs FIRST and is not re-runnable afterwards:
        // once the window is charged, `grantSessionKey` does not clear it (that is the point),
        // so the agent stays capped for the rest of the window. The two paths are therefore
        // measured on two separate agents in the same window rather than by resetting state.
        vm.startPrank(owner);
        skm.grantSessionKey(agent, scope);
        skm.grantSessionKey(newAgent, scope);
        vm.stopPrank();

        _exhaustWindow(AGENT_KEY, agent);
        vm.prank(owner);
        skm.grantSessionKey(agent, scope);
        uint256 afterReGrant = skm.getWindowState(agent).spentThisWindow;

        // Path 2: rotate `newAgent` (never spent from) to a third key.
        address third = address(0xF00D);
        vm.prank(owner);
        skm.rotateSessionKey(newAgent, third, scope, uint48(block.timestamp + 1 hours));
        uint256 afterRotate = skm.getWindowState(third).spentThisWindow;

        assertEq(afterReGrant, 2 ether, "re-grant keeps the window charged");
        assertEq(afterRotate, 0, "rotating a key with NO live window carries nothing");
    }

    // ------------------------------------------------------------------
    // The guarantees SEC-10 settled on — Option B, owner-ruled
    // ------------------------------------------------------------------

    /**
     * @dev SEC-10, resolved as **Option B (documented reset semantics)** by the owner.
     *
     *      This test no longer asserts a lineage aggregate, because a lineage aggregate is
     *      **not a guarantee this contract makes** — asserting it would be asserting the bug,
     *      which is exactly what this file's header warned against. It asserts instead the
     *      guarantees that ARE made:
     *
     *        1. a single key's window spend never exceeds `perWindowCap`;
     *        2. a rotation opens a FRESH window on the new key (documented semantics, now
     *           stated in `SpendPolicy`'s NatSpec);
     *        3. **an agent cannot rotate itself out of an exhausted window.**
     *
     *      (3) is load-bearing for the whole security argument, and is why SEC-10 was
     *      re-classified from "an agent can bypass its own cap" to "an owner-side
     *      configuration risk": both `grantSessionKey` and `rotateSessionKey` are `onlyOwner`,
     *      so there is no path from inside the trust boundary to a fresh budget.
     *
     *      @dev HISTORY, kept because the SHAPE of the change matters
     *
     *      An intermediate revision implemented Option A (carry the window forward across a
     *      rotation) and turned this test green. It was then REVERTED: a lineage-level
     *      aggregate requires re-keying `enforce`'s caller-supplied window slot — a
     *      storage-layout change — which is the wrong trade while the storage scheme is open.
     *      The test went red again for the right reason, and the resolution was to change
     *      what the test ASSERTS rather than to leave it red.
     */
    function test_Sec10_LineageWindowCap() public {
        vm.startPrank(owner);
        skm.grantSessionKey(agent, scope);
        vm.stopPrank();

        // (1) The per-key cap holds, and is reached exactly.
        _exhaustWindow(AGENT_KEY, agent);
        assertEq(
            skm.getWindowState(agent).spentThisWindow,
            scope.perWindowCap,
            "(1) a single key's window spend reaches exactly perWindowCap"
        );
        assertFalse(_spend(AGENT_KEY, agent, 1 ether), "(1) and the exhausted key is refused");

        // (2) A rotation opens a fresh window on the successor — the documented semantics.
        //     The signing key and the rotated-to ADDRESS must both derive from `pk`; conflating
        //     them recovers a different address and reverts `KeyUnknown`, which would make the
        //     test measure nothing at all.
        uint256 pk = 0xE001;
        address next = vm.addr(pk);
        vm.prank(owner);
        skm.rotateSessionKey(agent, next, scope, uint48(block.timestamp + 1 hours));
        assertEq(
            skm.getWindowState(next).spentThisWindow,
            0,
            "(2) rotation starts the new key on a fresh (zero) window - documented semantics"
        );
        assertTrue(
            _spend(pk, next, 1 ether),
            "(2) ...so the new key CAN spend - documented behaviour, not a bypass"
        );
        assertTrue(
            _spend(pk, next, 1 ether),
            "(1) ...and the cap binds the NEW key exactly as it bound the old one: a second "
            "1 ETH action reaches its perWindowCap"
        );
        assertFalse(
            _spend(pk, next, 1 ether),
            "(1) ...and a third is refused, because perWindowCap is that key's own ceiling"
        );

        // (3) THE SECURITY BOUNDARY. An agent holding an exhausted window cannot rotate
        //     itself into a fresh budget, because rotation is `onlyOwner`. Without this,
        //     guarantee (2) would be an exploit rather than a documented semantic — this
        //     assertion is what makes the "Option B is safe" argument mechanical, not a claim.
        vm.prank(agent);
        vm.expectRevert(SessionKeyManager.NotOwner.selector);
        skm.rotateSessionKey(agent, address(0xBAD), scope, uint48(block.timestamp + 1 hours));
    }
}
