// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @dev Recover-seam harness (issues catalog A4): `_recover` is virtual, so this
///      harness pins the recovered signer to a concrete address. That lets Halmos
///      spec the NON-signature auth properties of executeWithSessionKey — replay,
///      request expiry, denylist gating, nonce accounting — without depending on the
///      uninterpreted ecrecover model (a symbolic signature's recovered address is
///      arbitrary, so signature validity itself is covered by the unit/fuzz suites
///      and the EIP-712 conformance tests instead of assumed here).
contract SeamManager is SessionKeyManager {
    address internal immutable forcedSigner;

    constructor(address owner_, address signer_) SessionKeyManager(owner_) {
        forcedSigner = signer_;
    }

    function _recover(ActionRequest calldata, bytes calldata)
        internal
        view
        override
        returns (address)
    {
        return forcedSigner;
    }
}

contract HalmosAuthTest is Test {
    SeamManager internal skm;
    address internal signer;
    address internal owner;
    uint48 internal constant GRANTED_AT = 1_700_000_000;
    uint48 internal constant SCOPE_EXPIRY = GRANTED_AT + 1 days;

    function setUp() public {
        vm.warp(GRANTED_AT);
        signer = vm.addr(0xB0B);
        owner = vm.addr(0xA11CE);
        skm = new SeamManager(owner, signer);
        vm.deal(address(skm), 1000 ether);
        vm.prank(owner);
        skm.grantSessionKey(
            signer,
            SessionKeyManager.Scope({
                expiresAt: SCOPE_EXPIRY,
                windowSeconds: 1 hours,
                perActionCap: 1 ether,
                perWindowCap: 2 ether,
                merkleRoot: bytes32(0),
                countersignAbove: 0,
                enforceNativeDelta: false,
                tokenWatchlist: new address[](0)
            })
        );
    }

    function _request(
        uint256 nonce,
        uint48 expiry,
        uint256 value,
        bytes4 selector,
        bytes memory data
    ) internal pure returns (SessionKeyManager.ActionRequest memory) {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("halmos-auth"),
            target: address(0x1234),
            selector: selector,
            value: value,
            nonce: nonce,
            expiry: expiry,
            rationaleHash: keccak256("spec"),
            data: data
        });
    }

    /// @dev Live-clock precondition. Halmos re-symbolizes `block.timestamp` in EVERY spec
    ///      body, so a `vm.assume` placed in `setUp()` (where `vm.warp` pins it to a
    ///      concrete value) would constrain nothing and leave all five checks clock-polymorphic.
    ///      Modifiers are inlined by solc, so this constraint lands in each spec body and is
    ///      what keeps the specs testing the AUTH properties rather than a symbolic clock.
    ///      Bounding the clock to the granted window does two things at once:
    ///        - `block.timestamp <= SCOPE_EXPIRY` keeps the key live, so a spec can never
    ///          pass merely because everything reverted with `KeyExpired`.
    ///        - `block.timestamp >= GRANTED_AT` makes the "stale request" spec's own guard
    ///          (`staleExpiry < GRANTED_AT`) sound: the request really is in the past.
    ///      A tighter clock would narrow coverage; a wider one would let the specs degenerate
    ///      into "everything reverts", which is the vacuity this module exists to prevent.
    modifier atLiveClock() {
        // Time-based by design: this harness deliberately pins the modelled clock to the
        // granted window so the specs isolate replay / nonce / denylist / cap behaviour.
        // forge-lint: disable-next-line(block-timestamp)
        vm.assume(block.timestamp >= GRANTED_AT && block.timestamp <= SCOPE_EXPIRY);
        _;
    }

    /// @dev Encodes the call with the EXACT production arity.
    ///      `executeWithSessionKey(ActionRequest, bytes signature, bytes32[] merkleProof,
    ///      bytes ownerApproval)` takes FOUR parameters. Encoding only three yields calldata
    ///      whose 4th head word is a payload value, so the 4-argument decoder reads a bogus
    ///      `bytes` offset/length past the end of calldata and reverts on the bounds check —
    ///      which would make every spec below pass on the trivial false branch.
    ///      `test_HalmosAuth_ArityIsFour` pins this contract: it asserts the 3-argument
    ///      encoding fails AND that this 4-argument encoding has a reachable success path.
    function _execute(SessionKeyManager.ActionRequest memory req)
        internal
        returns (bool ok)
    {
        (ok, ) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector, req, new bytes(65), new bytes32[](0), bytes("")
            )
        );
    }

    /// @dev Replay: whatever the request looks like, the second execution of an
    ///      identical request must revert (strictly sequential nonces).
    /// @dev CQ-1: the assertion is UNCONDITIONAL. It previously sat behind `if (first)`,
    ///      so a request that failed on the first call skipped the entire replay property —
    ///      the spec was vacuous for every input the first call rejected. Replay safety is
    ///      a two-step property: step 1 may legitimately fail (bad nonce, over cap, expired),
    ///      and it must fail with the nonce UNCONSUMED, so the identical step 2 still fails.
    ///      Asserting the second call is rejected unconditionally states exactly that.
    function check_execute_Replay_SecondIdenticalCallAlwaysReverts(
        uint256 value,
        bytes memory data
    ) public atLiveClock {
        SessionKeyManager.ActionRequest memory req =
            _request(0, uint48(GRANTED_AT + 10 minutes), bound(value, 0, 1 ether), bytes4(0x12345678), data);
        _execute(req);
        // Unconditional: a replay must be rejected no matter how the first call resolved.
        assertFalse(_execute(req), "replay must revert");
    }

    /// @dev Nonce accounting: execution succeeds iff the request carries exactly the
    ///      current nonce (for an in-scope request), and a success advances it by one.
    function check_execute_NonceIsExactSequential(uint256 nonce, uint256 value) public atLiveClock {
        uint256 before = skm.getNonce(signer);
        SessionKeyManager.ActionRequest memory req =
            _request(nonce, uint48(GRANTED_AT + 10 minutes), bound(value, 0, 1 ether), bytes4(0x12345678), hex"");
        bool ok = _execute(req);
        if (ok) {
            assertEq(skm.getNonce(signer), before + 1, "success must advance nonce by exactly one");
        } else {
            assertEq(skm.getNonce(signer), before, "failure must not advance the nonce");
        }
    }

    /// @dev Request expiry: a request whose expiry is already past the block timestamp
    ///      must revert regardless of every other input.
    function check_execute_StaleRequestAlwaysReverts(uint48 staleExpiry, uint256 value) public atLiveClock {
        if (staleExpiry >= GRANTED_AT) return; // only stale requests are interesting here
        SessionKeyManager.ActionRequest memory req =
            _request(0, staleExpiry, bound(value, 0, 1 ether), bytes4(0x12345678), hex"");
        assertFalse(_execute(req), "stale request must revert");
    }

    /// @dev Denylist gating: a session key can never execute a denied selector, even
    ///      with a root==0 (allow-all) scope and a valid signature seam.
    function check_execute_DeniedSelectorAlwaysReverts(uint256 value, bytes memory data) public atLiveClock {
        bytes4 denied = bytes4(0xDEAD0000);
        vm.prank(owner);
        skm.setSelectorDenied(denied, true);
        SessionKeyManager.ActionRequest memory req =
            _request(0, uint48(GRANTED_AT + 10 minutes), bound(value, 0, 1 ether), denied, data);
        assertFalse(_execute(req), "denied selector must revert");
    }

    /// @dev INV-1 at the execution level: after any execution attempt, the recorded
    ///      window spend never exceeds the per-window cap.
    ///
    ///      SEC-08b, fully fixed here. The history matters because the FIRST fix was wrong and
    ///      is recorded below rather than quietly replaced.
    ///
    ///      Cause 1 (original): `atLiveClock` was absent, so a symbolic clock made every call
    ///      revert with `KeyExpired` and `spentThisWindow` stayed 0. Fixed by `atLiveClock`.
    ///
    ///      Cause 2 (my first fix, INCOMPLETE): `bound(value, 0, 3 ether)` with
    ///      `perActionCap = 1 ether` meant every symbolic value above 1 ether was rejected by
    ///      the per-ACTION check first. `0 <= 2 ether` still held vacuously — the tautology
    ///      changed cause rather than disappearing.
    ///
    ///      Cause 3 (the error ck-test caught, and the one that matters): I "fixed" it with a
    ///      TWO-action structure — action 1 pinned at 1 ether, action 2 model-chosen in
    ///      [0, 3 ether] — and reported that the revert selector was `PerWindowCapExceeded`.
    ///      It is not. Measured, with the selector resolved by `cast keccak`:
    ///          two-action,  action2 = 2.5 ether -> 0x51b5c1c4 = PerActionCapExceeded(2.5e18, 1e18)
    ///          three-action, action3 = 0.5 ether -> 0x9cbe80f7 = PerWindowCapExceeded(2.5e18, 2e18)
    ///      The two-action structure is STRUCTURALLY UNABLE to make the window check the
    ///      rejecting party: to breach the window the second action needs `value > 1 ether`
    ///      (1 + value > 2), and to escape the per-action check it needs `value <= 1 ether`.
    ///      Those sets are disjoint, so the per-action check is ALWAYS the rejecting party and
    ///      the spec was still tautological. This is the "tautology by tighter sibling check"
    ///      failure mode: the assertion is immune to removal of the window check precisely
    ///      because a tighter check rejects first.
    ///
    ///      THE ACTUAL FIX: THREE actions. Actions 1 and 2 fill the window to exactly
    ///      `perWindowCap` (1 + 1 = 2), each legal on its own. Action 3 is model-chosen in
    ///      (0, 1 ether], which is `bound(value, 1, 1 ether)`:
    ///        - `value > 1 ether` is excluded by the bound, so the per-action check can never
    ///          fire and cannot be the rejecting party;
    ///        - `value > 0` guarantees `2 ether + value > 2 ether`, so the window check ALWAYS
    ///          fires and IS the rejecting party.
    ///      So the window check is now on the reachable path for every value the model can
    ///      pick, and deleting it from `SpendPolicy.enforce` turns this spec red.
    ///
    ///      Why the bound is `bound(value, 1, 1 ether)` and not the wider [0, 3 ether] the
    ///      original used: a WIDER bound re-admits the per-action-rejected region, which is
    ///      exactly cause 2 and cause 3. The bound is doing the work here, not the fixture.
    ///
    ///      WHY NOT `vm.assume` INSTEAD (measured, both placements). The obvious alternative —
    ///      keep two actions and add `vm.assume(spentThisWindow + value > perWindowCap)` — does
    ///      NOT work, and it is worth recording why because it looks correct:
    ///        - assume at spec entry, where spentThisWindow == 0: demands `value > 2 ether`,
    ///          which the per-ACTION cap (1 ether) rejects. Observed: action 2 reverts
    ///          `0x51b5c1c4` = PerActionCapExceeded, window stays at 1 ether.
    ///        - assume after action 1, where spentThisWindow == 1 ether: demands
    ///          `value > 1 ether`, which is STILL above perActionCap. Observed: same
    ///          `0x51b5c1c4`, window stays at 1 ether.
    ///      In both cases the assume does not remove the disjointness — it just re-expresses it,
    ///      because "breaches the window" always implies "above perActionCap" whenever
    ///      perWindowCap >= 2 * perActionCap, which `_validateScope` permits. So an assume alone
    ///      cannot make the window check the rejecting party in a two-action shape; the third
    ///      action is what brings the residual budget below perActionCap so a legal value can
    ///      breach the window. The assume is still worth keeping — it documents the regime the
    ///      spec is about — but it is the BOUND plus the third action that carries the property.
    ///
    ///      The scope stays VALID (`perActionCap 1 ether <= perWindowCap 2 ether`): raising
    ///      `perActionCap` above `perWindowCap` to breach in one call is rejected by
    ///      `_validateScope`, and a harness that reverts in `setUp()` has vacuous specs.
    function check_execute_WindowSpendNeverExceedsCap(uint256 value, bytes memory data) public atLiveClock {
        // Actions 1 and 2: exactly `perActionCap` each, so both are individually legal and
        // together they fill the window to exactly `perWindowCap`.
        _execute(_request(0, uint48(GRANTED_AT + 10 minutes), 1 ether, bytes4(0x12345678), data));
        _execute(_request(1, uint48(GRANTED_AT + 10 minutes), 1 ether, bytes4(0x12345678), data));

        // Action 3: model-chosen in (0, 1 ether]. Above perActionCap? impossible by the bound.
        // So the window check — already at its cap — is the only thing that can refuse it.
        _execute(_request(2, uint48(GRANTED_AT + 10 minutes), bound(value, 1, 1 ether), bytes4(0x12345678), data));

        assertTrue(
            skm.getWindowState(signer).spentThisWindow <= 2 ether,
            "window spend exceeded the cap"
        );
    }

    // ------------------------------------------------------------------
    // Anti-regression meta-test (P0 #1): pins the ABI arity of the harness.
    // ------------------------------------------------------------------
    /// @notice Guards the harness itself, not the manager.
    /// @dev The P0 #1 bug was invisible from inside the five specs: every one of them
    ///      asserted "execution did not succeed", and a 3-argument encoding that fails to
    ///      decode satisfies all five. The specs could not detect it, so this test does.
    ///
    ///      Two-sided criterion, and BOTH sides are required:
    ///
    ///      (1) UNDER-ENCODES ⇒ FAILS. Encoding only (request, signature, merkleProof) makes
    ///          the 4th head word alias the first word of `request`'s tail — i.e. the
    ///          keccak agentId, a 32-byte digest ≥ 2^160, far beyond `calldatasize`. The
    ///          decoder's bounds check therefore rejects it. Asserting `ok == false` proves
    ///          the call really is ABI-mismatched (a genuinely-succeeding path is NOT what
    ///          this branch tests).
    ///
    ///      (2) EXACT ARITY ⇒ SUCCEEDS. With the full 4-argument encoding and a request that
    ///          is in scope on every axis the manager checks (key granted & unrevoked, live
    ///          key, future request expiry, nonce == current, non-denied selector,
    ///          merkleRoot == 0, countersignAbove == 0, value 0 within caps, a target call
    ///          that succeeds), `ok == true` proves the harness has a REACHABLE SUCCESS PATH.
    ///
    ///      Together they make the five specs non-vacuous: (2) guarantees a green execution
    ///      exists, so (1)'s blanket-failure mode is pinned to encoding errors, not to a
    ///      harness that can only ever fail.
    ///
    ///      (3) SIDE (2) MUST GO THROUGH `_execute`, never an inline copy of the encoding.
    ///          That is what actually makes this test fire on the original defect: the
    ///      specs and this test share one helper, so reverting `_execute` to three
    ///          arguments fails the `assertTrue` here AND makes all five specs vacuous at
    ///      once. An inline 4-arg encoding would keep this test green while the specs stayed
    ///      dead — the exact blind spot P0 #1 was.
    function test_HalmosAuth_ArityIsFour() public atLiveClock {
        SessionKeyManager.ActionRequest memory req =
            _request(0, uint48(GRANTED_AT + 10 minutes), 0, bytes4(0x12345678), hex"");

        // --- (1) the 3-argument encoding must NOT reach the function body ---
        (bool ok3, ) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, req, new bytes(65), new bytes32[](0))
        );
        assertFalse(ok3, "3-arg encoding must fail to decode: executeWithSessionKey takes FOUR arguments");

        // --- (2) the 4-argument encoding must have a reachable success path, exercised
        //         through the SAME helper the five specs use ---
        uint256 nonceBefore = skm.getNonce(signer);
        assertTrue(_execute(req), "4-arg encoding with an in-scope request must succeed: harness has a success path");
        assertEq(
            skm.getNonce(signer), nonceBefore + 1, "successful execution must consume exactly one nonce"
        );
    }
}
