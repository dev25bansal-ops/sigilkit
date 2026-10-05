// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";
import {ActionLogger} from "../src/ActionLogger.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";

contract Counter {
    uint256 public count;
    event Poked(address caller, uint256 value);

    function poke(uint256 by) external payable returns (uint256) {
        count += by;
        emit Poked(msg.sender, msg.value);
        return count;
    }
}

contract OwnerOnlyTarget {
    address public lastCaller;

    function adminAction() external {
        lastCaller = msg.sender;
    }

    function sweep() external payable {}
}

/// @dev A recipient whose receive() reverts, so `to.call{value:}("")` returns false and
///      `withdraw` must surface it as `WithdrawFailed` rather than losing the funds silently.
contract Rejector {
    receive() external payable {
        revert("no thanks");
    }
}

/// @dev Targets with distinct revert behaviors for the E2 bubbling tests.
contract RevertingTarget {
    error SomeUnknownError(uint256 x); // selector intentionally absent from the allowlist

    function stringRevert() external pure {
        revert("slippage: out of bounds");
    }

    function unknownRevert() external pure {
        revert SomeUnknownError(1);
    }
}

contract SessionKeyManagerTest is Test {
    SessionKeyManager internal skm;
    Counter internal counter;
    OwnerOnlyTarget internal ownerTarget;
    RevertingTarget internal reverter;

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xB0B;
    address internal agent = vm.addr(AGENT_KEY);

    // Default scope: 1 ETH per action, 2 ETH per 1-hour window, expires in 1 day.
    SessionKeyManager.Scope internal defaultScope;

    function setUp() public {
        skm = new SessionKeyManager(vm.addr(OWNER_KEY));
        counter = new Counter();
        ownerTarget = new OwnerOnlyTarget();
        reverter = new RevertingTarget();
        vm.deal(address(skm), 100 ether);

        defaultScope = SessionKeyManager.Scope({
            expiresAt: uint48(block.timestamp + 1 days),
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
    function _signRequest(
        uint256 privateKey,
        SessionKeyManager.ActionRequest memory req,
        bytes32 domainSeparator
    ) internal view returns (bytes memory) {
        bytes32 typehash = skm.ACTION_REQUEST_TYPEHASH();
        bytes32 structHash = keccak256(
            abi.encode(
                typehash,
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _makeRequest(
        address target,
        bytes4 selector,
        uint256 value,
        bytes memory data
    ) internal view returns (SessionKeyManager.ActionRequest memory) {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("agent-1"),
            target: target,
            selector: selector,
            value: value,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("swap USDC->WETH per treasury strategy"),
            data: data
        });
    }

    function _execute(SessionKeyManager.ActionRequest memory req)
        internal
        returns (bool ok, bytes memory ret)
    {
        bytes32 ds = skm.DOMAIN_SEPARATOR();
        bytes memory sig = _signRequest(AGENT_KEY, req, ds);
        (ok, ret) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector, req, sig, new bytes32[](0), bytes("")
            )
        );
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------
    function test_Execute_RejectsMalleableHighS() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0 ether, abi.encode(1));
        bytes32 ds = skm.DOMAIN_SEPARATOR();
        bytes32 typehash = skm.ACTION_REQUEST_TYPEHASH();
        bytes32 structHash = keccak256(
            abi.encode(
                typehash,
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ds, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, digest);

        // Canonical low-s signature executes fine.
        (bool ok,) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector, req, abi.encodePacked(r, s, v), new bytes32[](0), bytes("")
            )
        );
        assertTrue(ok, "low-s signature should execute");

        // Malleated twin (s' = N - s, flipped parity) recovers the same address but
        // must be rejected — recovery runs before any state check.
        uint256 secp256k1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sHigh = bytes32(secp256k1N - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        vm.expectRevert(SessionKeyManager.InvalidSignature.selector);
        skm.executeWithSessionKey(req, abi.encodePacked(r, sHigh, vFlip), new bytes32[](0), bytes(""));
    }

    function test_GrantRequiresOwner() public {
        vm.prank(agent);
        vm.expectRevert(SessionKeyManager.NotOwner.selector);
        skm.grantSessionKey(agent, defaultScope);
    }

    function test_GrantRejectsPastExpiry() public {
        defaultScope.expiresAt = uint48(block.timestamp - 1);
        vm.prank(vm.addr(OWNER_KEY));
        vm.expectRevert(SessionKeyManager.InvalidScope.selector);
        skm.grantSessionKey(agent, defaultScope);
    }

    function test_GrantRejectsWindowBelowActionCap() public {
        defaultScope.perWindowCap = 0.5 ether; // < perActionCap 1 ether
        vm.prank(vm.addr(OWNER_KEY));
        vm.expectRevert(SessionKeyManager.InvalidScope.selector);
        skm.grantSessionKey(agent, defaultScope);
    }

    function test_RotateGrantsNewAndShortensOld() public {
        vm.startPrank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);
        uint48 overlapEnd = uint48(block.timestamp + 30 minutes);
        skm.rotateSessionKey(agent, vm.addr(0xC0C), defaultScope, overlapEnd);
        vm.stopPrank();

        assertEq(scm_getExpiry(vm.addr(0xC0C)), defaultScope.expiresAt);
        assertEq(scm_getExpiry(agent), overlapEnd); // old key shortened
        assertFalse(skm.isRevoked(agent)); // still valid during overlap
    }

    function scm_getExpiry(address k) internal view returns (uint48) {
        return skm.getScope(k).expiresAt;
    }

    // ------------------------------------------------------------------
    // #2 · E11 watchlist bound (MAX_WATCHED_TOKENS)
    //
    // The gate `tokenWatchlist.length > MAX_WATCHED_TOKENS => InvalidScope` had no
    // assertion at all: 8 legal was covered incidentally by a gas test, and 9 — the whole
    // point of the bound — was never executed. A flipped comparison operator would have
    // silently turned an E11 gas bound into a no-op, and nothing in the suite would go red.
    // Both directions are asserted here, because "9 reverts" alone does not distinguish a
    // working bound from one that rejects everything.
    // ------------------------------------------------------------------
    function test_ValidateScope_AcceptsExactlyEightWatchlistTokens() public {
        address[] memory eight = new address[](8);
        for (uint256 i = 0; i < 8; ++i) {
            // Distinct non-zero addresses, so the length is what is under test.
            // Synthetic test address; `i < 8`, so the value cannot truncate.
            // forge-lint: disable-next-line(unsafe-typecast)
            eight[i] = address(uint160(0xA000 + i));
        }
        defaultScope.tokenWatchlist = eight;
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);
        assertEq(skm.getScope(agent).tokenWatchlist.length, 8, "all eight tokens must be stored");
    }

    function test_ValidateScope_RejectsNineWatchlistTokens() public {
        address[] memory nine = new address[](9);
        for (uint256 i = 0; i < 9; ++i) {
            // Distinct non-zero addresses: the bound under test is the LENGTH, and reusing one
            // address would let a de-duplicating implementation pass a test that should fail.
            // Synthetic test address; `i < 9`, so the value cannot truncate.
            // forge-lint: disable-next-line(unsafe-typecast)
            nine[i] = address(uint160(0xA000 + i));
        }
        defaultScope.tokenWatchlist = nine;
        vm.prank(vm.addr(OWNER_KEY));
        vm.expectRevert(SessionKeyManager.InvalidScope.selector);
        skm.grantSessionKey(agent, defaultScope);
    }

    // ------------------------------------------------------------------
    // #3 · withdraw: the two WithdrawFailed branches + the event
    //
    // This is the only sanctioned way to move funds out (S6), and the only test of it was a
    // happy path. `to == address(0)` would permanently burn the funds; a recipient that
    // rejects ETH must not be able to consume the whole call either.
    // ------------------------------------------------------------------
    function test_Withdraw_RevertsOnZeroRecipient() public {
        vm.deal(address(skm), 5 ether);
        vm.prank(vm.addr(OWNER_KEY));
        vm.expectRevert(SessionKeyManager.WithdrawFailed.selector);
        skm.withdraw(payable(address(0)), 1 ether);
        assertEq(address(skm).balance, 5 ether, "a rejected withdrawal must move nothing");
    }

    function test_Withdraw_RevertsWhenRecipientRejects() public {
        Rejector r = new Rejector();
        vm.deal(address(skm), 5 ether);
        vm.prank(vm.addr(OWNER_KEY));
        vm.expectRevert(SessionKeyManager.WithdrawFailed.selector);
        skm.withdraw(payable(address(r)), 1 ether);
        assertEq(address(skm).balance, 5 ether, "a rejected withdrawal must move nothing");
    }

    function test_Withdraw_EmitsTreasuryWithdrawal() public {
        address recipient = address(0xBEEF);
        vm.deal(address(skm), 5 ether);
        uint256 before = recipient.balance;
        vm.expectEmit(true, true, true, true, address(skm));
        emit SessionKeyManager.TreasuryWithdrawal(recipient, 1.5 ether);
        vm.prank(vm.addr(OWNER_KEY));
        skm.withdraw(payable(recipient), 1.5 ether);
        assertEq(recipient.balance, before + 1.5 ether, "recipient must receive the funds");
        assertEq(address(skm).balance, 3.5 ether, "wallet must be debited");
    }

    // ------------------------------------------------------------------
    // #4 · transferOwnership actually moves authority    //
    // The suite covered the happy path and the zero-address revert, but never asserted that
    // the NEW owner can act or that the OLD one is now powerless. Both halves matter: a
    // transfer that emits the event without moving `_manager().owner` would leave the old
    // owner in control of every admin selector while the logs claim otherwise.
    // ------------------------------------------------------------------
    function test_TransferOwnership_MovesAuthority() public {
        address newOwner = address(0xFEED);
        vm.expectEmit(true, true, true, true, address(skm));
        emit SessionKeyManager.OwnershipTransferred(vm.addr(OWNER_KEY), newOwner);
        vm.prank(vm.addr(OWNER_KEY));
        skm.transferOwnership(newOwner);

        // New owner can act.
        vm.prank(newOwner);
        skm.grantSessionKey(agent, defaultScope);
        assertEq(skm.getScope(agent).expiresAt, defaultScope.expiresAt, "new owner's grant must land");

        // Old owner is now powerless, with the specific error — not a bare failure.
        vm.prank(vm.addr(OWNER_KEY));
        vm.expectRevert(SessionKeyManager.NotOwner.selector);
        skm.grantSessionKey(agent, defaultScope);

        // And withdraw, the other admin surface, is likewise transferred.
        vm.deal(address(skm), 1 ether);
        vm.prank(vm.addr(OWNER_KEY));
        vm.expectRevert(SessionKeyManager.NotOwner.selector);
        skm.withdraw(payable(address(0xBEEF)), 1 ether);
    }

    // ------------------------------------------------------------------
    // #6 · rotateSessionKey revert branches
    //
    // `KeyUnknown`, `OverlapBeyondOldExpiry` and the `oldKey == address(0)` path had no
    // assertions. `OverlapBeyondOldExpiry` in particular is the guard that stops a rotation
    // from EXTENDING a key's life past its original expiry, and it appeared only in comments.
    // ------------------------------------------------------------------
    function test_Rotate_RevertsUnknownOldKey() public {
        address neverGranted = address(0xDEAD);
        vm.prank(vm.addr(OWNER_KEY));
        vm.expectRevert(SessionKeyManager.KeyUnknown.selector);
        skm.rotateSessionKey(neverGranted, address(0xC0C), defaultScope, uint48(block.timestamp + 1 hours));
    }

    function test_Rotate_RevertsOverlapBeyondOldExpiry() public {
        vm.startPrank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);
        // The old key expires in 1 day; ask for a 2-day overlap.
        vm.expectRevert(SessionKeyManager.OverlapBeyondOldExpiry.selector);
        skm.rotateSessionKey(agent, address(0xC0C), defaultScope, uint48(block.timestamp + 2 days));
        vm.stopPrank();
    }

    /// @dev `oldKey == address(0)` is the documented "grant a fresh key with no predecessor"
    ///      path — the `oldKey != address(0) &&` guard exists specifically to let it through
    ///      `KeyUnknown`. Characterization, because it is reachable only in ONE shape:
    ///
    ///      The very next line compares `overlapEnds` against `scopes[address(0)].expiresAt`,
    ///      which is 0 for the zero key because it was never granted. So ANY non-zero
    ///      `overlapEnds` reverts `OverlapBeyondOldExpiry`, and the zero-old-key path survives
    ///      only with `overlapEnds == 0`.
    ///
    ///      Both halves are asserted. The first is the surprising one and is the reason this
    ///      test exists: the guard reads as "zero old key is supported", but any realistic
    ///      overlap makes it revert. Recorded as behaviour, not as a verdict.
    function test_Rotate_ZeroOldKey_RequiresZeroOverlap() public {
        address fresh = address(0xC0C);

        // (a) A non-zero overlap reverts, because the zero key's stored expiry is 0.
        vm.prank(vm.addr(OWNER_KEY));
        vm.expectRevert(SessionKeyManager.OverlapBeyondOldExpiry.selector);
        skm.rotateSessionKey(address(0), fresh, defaultScope, uint48(block.timestamp + 1 hours));

        // (b) With overlapEnds == 0 the path is reachable and does grant.
        vm.prank(vm.addr(OWNER_KEY));
        skm.rotateSessionKey(address(0), fresh, defaultScope, uint48(0));
        assertEq(skm.getScope(fresh).expiresAt, defaultScope.expiresAt, "the new key must be granted");
    }

    // ------------------------------------------------------------------
    // Happy path + audit
    // ------------------------------------------------------------------
    function test_ExecuteWithSessionKey_Succeeds_AndEmitsAudit() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0.5 ether, abi.encode(7));

        uint256 before = counter.count();
        (bool ok,) = _execute(req);
        assertTrue(ok, "execute failed");

        assertEq(counter.count(), before + 7);
        assertEq(address(counter).balance, 0.5 ether, "counter did not receive value");
        assertEq(skm.getNonce(agent), 1);

        // Mandatory audit event with exact fields (second action).
        SessionKeyManager.ActionRequest memory req2 =
            _makeRequest(address(counter), counter.poke.selector, 0.1 ether, abi.encode(1));
        vm.expectEmit(true, true, true, true, address(skm));
        emit ActionLogger.ActionLogged(
            req2.agentId, req2.target, req2.selector, req2.value, req2.rationaleHash, uint48(block.timestamp)
        );
        (ok,) = _execute(req2);
        assertTrue(ok);
    }

    // ------------------------------------------------------------------
    // Scope enforcement
    // ------------------------------------------------------------------
    function test_RejectsExpiredKey() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);
        vm.warp(defaultScope.expiresAt + 1);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0 ether, abi.encode(1));
        (bool ok, bytes memory ret) = _execute(req);
        assertFalse(ok, "expired key should fail");
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes4(ret), SessionKeyManager.KeyExpired.selector, "wrong revert reason");
    }

    function test_RejectsRevokedKey() public {
        vm.startPrank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);
        skm.revokeSessionKey(agent);
        vm.stopPrank();

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0 ether, abi.encode(1));
        (bool ok,) = _execute(req);
        assertFalse(ok, "revoked key should fail");
    }

    function test_RejectsUsedNonce() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0 ether, abi.encode(1));
        (bool ok,) = _execute(req);
        assertTrue(ok);

        (ok,) = _execute(req); // same nonce again → replay blocked
        assertFalse(ok, "replay should fail");
    }

    function test_RejectsStaleRequest() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0 ether, abi.encode(1));
        req.expiry = uint48(block.timestamp - 1);
        (bool ok,) = _execute(req);
        assertFalse(ok, "stale request should fail");
    }

    function test_RejectsWrongSigner() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0 ether, abi.encode(1));
        bytes32 ds = skm.DOMAIN_SEPARATOR();
        bytes memory badSig = _signRequest(0xDEAD, req, ds); // a valid signature, but not the granted key

        // SEC-5: this test previously called the 4-argument entrypoint with only 3 encoded
        // arguments and asserted a bare `assertFalse(ok)`. It therefore "passed" because the
        // ABI decoder rejected the malformed calldata — not because the signer was rejected —
        // and would have kept passing if signature recovery were removed entirely.
        //
        // The contract recovers the (wrong) signer successfully, finds no scope for it, and
        // reverts KeyUnknown. Pin exactly that.
        vm.expectRevert(SessionKeyManager.KeyUnknown.selector);
        skm.executeWithSessionKey(req, badSig, new bytes32[](0), "");
    }

    /// @dev The other rejection branch: a signature that is not even well-formed.
    function test_RejectsMalformedSignature() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0 ether, abi.encode(1));

        // 64 bytes — cannot be a 65-byte (r,s,v) ECDSA signature.
        bytes memory shortSig = new bytes(64);

        vm.expectRevert(SessionKeyManager.InvalidSignature.selector);
        skm.executeWithSessionKey(req, shortSig, new bytes32[](0), "");
    }

    /// @dev Guard against the entrypoint's arity drifting out from under the tests: an
    ///      under-encoded call must fail loudly rather than silently "revert for free".
    function test_ExecuteWithSessionKey_ArityIsFour() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0 ether, abi.encode(1));
        bytes memory sig = _signRequest(AGENT_KEY, req, skm.DOMAIN_SEPARATOR());

        // 3 args instead of 4: must NOT succeed.
        (bool ok3,) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, req, sig, new bytes32[](0))
        );
        assertFalse(ok3, "an under-encoded call must not execute");

        // 4 args: succeeds — proving the 3-arg form above failed on arity, not on policy.
        (bool ok4,) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector, req, sig, new bytes32[](0), bytes("")
            )
        );
        assertTrue(ok4, "the correctly-encoded call must execute");
    }

    function test_RejectsValueFromRelayer() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0.1 ether, abi.encode(1));
        bytes memory sig = _signRequest(AGENT_KEY, req, skm.DOMAIN_SEPARATOR());

        vm.expectRevert(SessionKeyManager.ValueNotAccepted.selector);
        skm.executeWithSessionKey{value: 0.1 ether}(req, sig, new bytes32[](0), bytes(""));
    }

    // ------------------------------------------------------------------
    // E1/E2: window-charged observability + inner revert bubbling
    // ------------------------------------------------------------------
    function test_Execute_EmitsWindowCharged() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0.1 ether, abi.encode(1));

        // First charge opens a fresh window at the current timestamp.
        vm.expectEmit(true, true, true, true, address(skm));
        emit SpendPolicy.WindowCharged(address(skm), agent, 0.1 ether, uint48(block.timestamp), 0.1 ether);
        (bool ok,) = _execute(req);
        assertTrue(ok, "execution should succeed");
    }

    function test_Execute_BubblesRecognizableInnerRevert() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(reverter), reverter.stringRevert.selector, 0 ether, "");
        bytes memory sig = _signRequest(AGENT_KEY, req, skm.DOMAIN_SEPARATOR());

        vm.expectRevert(bytes("slippage: out of bounds"));
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
    }

    function test_Execute_UnknownInnerRevertStaysInnerCallFailed() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(reverter), reverter.unknownRevert.selector, 0 ether, "");
        bytes memory sig = _signRequest(AGENT_KEY, req, skm.DOMAIN_SEPARATOR());

        vm.expectRevert(SessionKeyManager.InnerCallFailed.selector);
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
    }

    function test_WindowIsTumbling_BoundaryBurstPinned() public {
        // Pins SpendPolicy's window semantics: the window is a FIXED (tumbling) window
        // that resets fully on rollover — NOT a sliding window. See the INV-1 note in
        // SpendPolicy.sol: up to ~2x perWindowCap can legitimately cross a boundary.
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope); // 1 ETH/action, 2 ETH/window, 1h window

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0.9 ether, abi.encode(1));
        (bool ok,) = _execute(req);
        assertTrue(ok, "first spend should pass");
        req = _makeRequest(address(counter), counter.poke.selector, 0.9 ether, abi.encode(2));
        (ok,) = _execute(req);
        assertTrue(ok, "second spend should pass (1.8 <= 2 ETH window cap)");

        // A third spend inside the same window is capped (1.8 + 0.9 > 2).
        req = _makeRequest(address(counter), counter.poke.selector, 0.9 ether, abi.encode(3));
        (ok,) = _execute(req);
        assertFalse(ok, "window cap must hold inside the window");

        // Cross the boundary: the window resets fully, so the same 0.9 ETH passes —
        // a sliding-window reading of INV-1 would reject this; tumbling is the actual
        // (documented) behavior.
        vm.warp(block.timestamp + 1 hours + 1);
        req = _makeRequest(address(counter), counter.poke.selector, 0.9 ether, abi.encode(4));
        (ok,) = _execute(req);
        assertTrue(ok, "post-rollover spend should pass (tumbling window; SpendPolicy INV-1 note)");
    }

    // ------------------------------------------------------------------
    // Spend caps
    // ------------------------------------------------------------------
    function test_PerActionCapEnforced() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 1.1 ether, abi.encode(1));
        (bool ok,) = _execute(req);
        assertFalse(ok, "over-cap action should fail");
    }

    function test_PerWindowCapEnforced_AcrossActions() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope); // 1 ETH/action, 2 ETH/hour

        SessionKeyManager.ActionRequest memory r1 =
            _makeRequest(address(counter), counter.poke.selector, 1 ether, abi.encode(1));
        (bool ok,) = _execute(r1);
        assertTrue(ok, "first within cap");

        SessionKeyManager.ActionRequest memory r2 =
            _makeRequest(address(counter), counter.poke.selector, 1 ether, abi.encode(2));
        (ok,) = _execute(r2);
        assertTrue(ok, "second hits window cap exactly (2.0 of 2.0)");

        SessionKeyManager.ActionRequest memory r3 =
            _makeRequest(address(counter), counter.poke.selector, 0.5 ether, abi.encode(3));
        (ok,) = _execute(r3); // 2.0 spent + 0.5 = 2.5 > 2.0
        assertFalse(ok, "window overflow should fail");

        // Window rolls over after an hour.
        vm.warp(block.timestamp + 1 hours + 1);
        SessionKeyManager.ActionRequest memory r4 =
            _makeRequest(address(counter), counter.poke.selector, 0.5 ether, abi.encode(4));
        (ok,) = _execute(r4);
        assertTrue(ok, "post-window action should pass");
    }

    // ------------------------------------------------------------------
    // Merkle whitelist
    // ------------------------------------------------------------------
    function test_MerkleWhitelist_AllowsListed_BlocksUnlisted() public {
        // Root over two WILDCARD leaves (argsHash=0 — any calldata) in leaf format v2:
        // counter.poke and ownerTarget.sweep (sorted-pair hashing).
        bytes32 leafA = keccak256(abi.encode(address(counter), counter.poke.selector, bytes32(0)));
        bytes32 leafB =
            keccak256(abi.encode(address(ownerTarget), ownerTarget.sweep.selector, bytes32(0)));
        bytes32 root = _sortedHash(leafA, leafB);

        defaultScope.merkleRoot = root;
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        // Allowed target with correct proof.
        SessionKeyManager.ActionRequest memory good =
            _makeRequest(address(counter), counter.poke.selector, 0 ether, abi.encode(1));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafB;
        bytes memory sig = _signRequest(AGENT_KEY, good, skm.DOMAIN_SEPARATOR());
        (bool ok,) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, good, sig, proof, bytes(""))
        );
        assertTrue(ok, "listed target with proof should pass");

        // Unlisted target (Counter via adminAction's selector on ownerTarget) — wrong leaf.
        SessionKeyManager.ActionRequest memory bad =
            _makeRequest(address(ownerTarget), ownerTarget.adminAction.selector, 0 ether, "");
        proof[0] = leafA; // wrong proof
        bytes memory sig2 = _signRequest(AGENT_KEY, bad, skm.DOMAIN_SEPARATOR());
        (ok,) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, bad, sig2, proof, bytes(""))
        );
        assertFalse(ok, "unlisted target should fail");
    }

    function _sortedHash(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function test_Whitelist_ArgumentBoundLeaf_CapsCalldata() public {
        // Leaf format v2 pinned entry: whitelisting transfer(address,uint256) with the
        // calldata COMMITTED means a compromised agent cannot vary the arguments — the
        // fix for "whitelisted token selectors are uncapped" (issues catalog S1).
        // Single-leaf tree: root == leaf, empty proof verifies by identity.
        address tokenLike = address(0x9001);
        bytes4 transferSel = 0xa9059cbb; // transfer(address,uint256)
        bytes memory pinnedData = abi.encode(address(0xCAFE), uint256(1000));
        bytes32 pinnedLeaf =
            keccak256(abi.encode(tokenLike, transferSel, keccak256(pinnedData)));

        defaultScope.merkleRoot = pinnedLeaf;
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        // Exact pinned calldata → allowed.
        SessionKeyManager.ActionRequest memory good =
            _makeRequest(tokenLike, transferSel, 0 ether, pinnedData);
        (bool ok,) = _executeWithProof(good, new bytes32[](0));
        assertTrue(ok, "pinned calldata should pass");

        // Same whitelisted target+selector, DIFFERENT calldata (e.g. a 10^9-unit
        // transfer to another recipient) → rejected even though the selector is
        // whitelisted: the arguments are bound by the leaf.
        SessionKeyManager.ActionRequest memory drain =
            _makeRequest(tokenLike, transferSel, 0 ether, abi.encode(address(0xDEAD), uint256(1e9)));
        (ok,) = _executeWithProof(drain, new bytes32[](0));
        assertFalse(ok, "non-pinned calldata for a whitelisted selector must be rejected");
    }

    function _executeWithProof(SessionKeyManager.ActionRequest memory req, bytes32[] memory proof)
        internal
        returns (bool ok, bytes memory ret)
    {
        bytes memory sig = _signRequest(AGENT_KEY, req, skm.DOMAIN_SEPARATOR());
        (ok, ret) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, req, sig, proof, bytes(""))
        );
    }

    // ------------------------------------------------------------------
    // Privilege containment (INV-4)
    // ------------------------------------------------------------------
    function test_OwnerOnlySelectorsDeniedToSessionKeys() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        // grantSessionKey is denied by default in constructor.
        SessionKeyManager.ActionRequest memory selfGrant = SessionKeyManager.ActionRequest({
            agentId: keccak256("agent-1"),
            target: address(skm),
            selector: skm.grantSessionKey.selector,
            value: 0,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("escalate"),
            data: abi.encode(agent, defaultScope)
        });
        (bool ok,) = _execute(selfGrant);
        assertFalse(ok, "session key must never reach denied selectors");

        // Even targeting ANOTHER contract that shares the selector name is denied.
        bytes4 arbitrary = bytes4(keccak256("adminAction()"));
        vm.prank(vm.addr(OWNER_KEY));
        skm.setSelectorDenied(arbitrary, true);

        SessionKeyManager.ActionRequest memory escalate =
            _makeRequest(address(ownerTarget), arbitrary, 0 ether, "");
        (ok,) = _execute(escalate);
        assertFalse(ok, "denied selector blocked cross-contract too");
    }

    function test_UnknownKeyFails() public {
        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0 ether, abi.encode(1));
        (bool ok,) = _execute(req);
        assertFalse(ok, "unknown key must fail");
    }

    function test_DomainSeparator_ChainsAndAddress() public {
        // Deploy a second manager at a different address; separators must differ.
        SessionKeyManager other = new SessionKeyManager(vm.addr(OWNER_KEY));
        assertTrue(skm.DOMAIN_SEPARATOR() != other.DOMAIN_SEPARATOR(), "domains must be unique");
    }
}
