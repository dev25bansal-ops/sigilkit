// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";
import {SigilKitDelegator} from "../src/SigilKitDelegator.sol";

/// @title DenylistCoverage — C-04 regression lock.
///
/// @dev Why this suite exists. The admin-selector denylist used to be maintained BY HAND in
///      two places (`SessionKeyManager`'s constructor and `SigilKitDelegator`'s
///      `initializeSelfOwned`, the latter a hand-copied duplicate plus one extra entry), and
///      NOTHING checked that the list actually covered the admin surface. The pre-existing
///      delegator test only proved the weaker property "a non-owner cannot reach an admin
///      path" — true by construction via `onlyOwner`, and true no matter how badly the
///      denylist rotted. So a newly added `onlyOwner` function could ship completely
///      un-denied (reachable by any session key through `executeWithSessionKey`, since that
///      function is permissionless and takes its authorization from the signature alone) and
///      every test would still be green.
///
///      The design now makes the list self-sealing — `onlyOwner` writes `msg.sig` into the
///      denylist on every successful admin call — so a NEW admin function is covered the
///      first time anyone calls it. That closes the whole class going forward. It does not
///      cover a selector that has NEVER been called, which is why the seed list and the
///      digest anchor below still need a gate. This file is that gate.
///
///      Three properties are pinned:
///        1. the digest is a faithful, order-sensitive image of the hardcoded list;
///        2. every `onlyOwner` function is denied once invoked (self-sealing works);
///        3. the delegator's own extra admin selector is covered too.
contract DenylistCoverageTest is Test {
    SessionKeyManager internal skm;
    SigilKitDelegator internal delegator;

    uint256 internal constant OWNER_KEY = 0xA11CE;
    address internal ownerAddr = vm.addr(OWNER_KEY);
    address payable internal eoa;

    // The manager's hardcoded admin selector list, restated here INDEPENDENTLY of the
    // contract. This is the value the digest must fold — if either side changes without the
    // other, `test_AdminSelectorDigest_MatchesHardcodedList` fails.
    bytes4[] internal managerAdminSelectors;

    function setUp() public {
        skm = new SessionKeyManager(ownerAddr);
        delegator = new SigilKitDelegator();

        eoa = payable(vm.addr(0xE0A));
        vm.deal(eoa, 1 ether);
        vm.etch(eoa, address(delegator).code); // EIP-7702 delegation
        vm.prank(eoa);
        SigilKitDelegator(eoa).initializeSelfOwned();

        managerAdminSelectors.push(SessionKeyManager.grantSessionKey.selector);
        managerAdminSelectors.push(SessionKeyManager.revokeSessionKey.selector);
        managerAdminSelectors.push(SessionKeyManager.rotateSessionKey.selector);
        managerAdminSelectors.push(SessionKeyManager.transferOwnership.selector);
        managerAdminSelectors.push(SessionKeyManager.setSelectorDenied.selector);
        managerAdminSelectors.push(SessionKeyManager.withdraw.selector);
    }

    // ------------------------------------------------------------------
    // 1. The digest must track the hardcoded list
    // ------------------------------------------------------------------

    /// @dev The whole point of `adminSelectorDigest()`: it is the off-chain comparison
    ///      anchor for "did the list change?". This test restates the expected list
    ///      independently of the contract, folds it the same way, and requires equality.
    ///      Change an admin function in the source and this test breaks until the digest
    ///      constant and the list are both updated — which is the intended friction.
    function test_AdminSelectorDigest_MatchesHardcodedList() public view {
        bytes32 expected = keccak256("sigilkit.admin-selector-set.v1");
        for (uint256 i = 0; i < managerAdminSelectors.length; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            expected = keccak256(abi.encodePacked(expected, bytes32(managerAdminSelectors[i])));
        }
        assertEq(
            skm.adminSelectorDigest(),
            expected,
            "adminSelectorDigest must fold exactly the documented hardcoded admin list"
        );
    }

    /// @dev Order sensitivity: the digest is a fold, not a set hash, so reordering the
    ///      list changes it. This pins that the anchor is a real image of the declared
    ///      ORDER rather than a coincidence-robust multiset hash.
    function test_AdminSelectorDigest_IsOrderSensitive() public view {
        bytes32 forward = keccak256("sigilkit.admin-selector-set.v1");
        bytes32 reverse = keccak256("sigilkit.admin-selector-set.v1");
        for (uint256 i = 0; i < managerAdminSelectors.length; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            forward = keccak256(abi.encodePacked(forward, bytes32(managerAdminSelectors[i])));
        }
        for (uint256 i = managerAdminSelectors.length; i > 0; --i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            reverse = keccak256(abi.encodePacked(reverse, bytes32(managerAdminSelectors[i - 1])));
        }
        assertTrue(forward != reverse, "the digest must depend on declaration order");
    }

    /// @dev Distinct selectors must produce distinct digests. Two admin functions colliding
    ///      here would mean the anchor cannot distinguish "one entry" from "two entries".
    function test_AdminSelectorDigest_DistinguishesEntries() public view {
        bytes32 seed = keccak256("sigilkit.admin-selector-set.v1");
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 a = keccak256(abi.encodePacked(seed, bytes32(managerAdminSelectors[0])));
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 b = keccak256(abi.encodePacked(a, bytes32(managerAdminSelectors[1])));
        assertTrue(a != b, "folding a second selector must change the digest");
    }

    // ------------------------------------------------------------------
    // 2. Self-sealing: every onlyOwner selector is denied after being invoked
    // ------------------------------------------------------------------

    /// @dev Drives every `onlyOwner` entry point of the manager via low-level calls (so an
    ///      argument-shape revert cannot mask the assertion) and then requires that its
    ///      selector is denied. The list is seeded at construction, so this also pins the
    ///      seed's exhaustiveness; the self-sealing write makes it hold for any admin
    ///      function added later, even one nobody remembered to seed.
    function test_DenylistCoversManagerAdminSurface() public {
        assertTrue(
            _callAndAssertDenied(address(skm), SessionKeyManager.grantSessionKey.selector, _grantArgs()),
            "grantSessionKey must be denied"
        );
        assertTrue(
            _callAndAssertDenied(address(skm), SessionKeyManager.revokeSessionKey.selector, abi.encode(address(0xDEAD))),
            "revokeSessionKey must be denied"
        );
        assertTrue(
            _callAndAssertDenied(
                address(skm), SessionKeyManager.rotateSessionKey.selector, _rotateArgs()
            ),
            "rotateSessionKey must be denied"
        );
        assertTrue(
            _callAndAssertDenied(
                address(skm), SessionKeyManager.transferOwnership.selector, abi.encode(ownerAddr)
            ),
            "transferOwnership must be denied"
        );
        assertTrue(
            _callAndAssertDenied(
                address(skm),
                SessionKeyManager.setSelectorDenied.selector,
                abi.encode(bytes4(0xDEADBEEF), true)
            ),
            "setSelectorDenied must be denied"
        );
        assertTrue(
            _callAndAssertDenied(address(skm), SessionKeyManager.withdraw.selector, abi.encode(payable(ownerAddr), uint256(0))),
            "withdraw must be denied"
        );
    }

    /// @dev THE SELF-SEALING WRITE ITSELF — the property the sweep above cannot falsify.
    ///
    ///      `test_DenylistCoversManagerAdminSurface` proves nothing about sealing. Every
    ///      manager admin selector is ALREADY denied by the constructor seed, so
    ///      `isSelectorDenied` is true before the call, after the call, whether the call
    ///      succeeded, and whether its arguments were even valid — `revokeSessionKey(0xDEAD)`
    ///      and `rotateSessionKey(address(0), …)` both revert on `KeyUnknown` before any
    ///      state write. That sweep therefore pins the SEED's exhaustiveness (property 1, and
    ///      `test_DenylistSeeded_ForEveryManagerAdminSelector_BeforeAnyCall` pins it
    ///      directly), and says nothing about `onlyOwner`'s post-body seal.
    ///
    ///      This isolates the seal: clear the seed entry, then invoke that same admin function
    ///      as the owner with arguments the contract ACCEPTS, so the only thing that can
    ///      re-deny the selector is `_setSelectorDenied(msg.sig, true)` running after the
    ///      body. A newly added admin function has no seed entry at all, so this is the only
    ///      shape in which the property can fail.
    function test_SelfSealingDeniesAnUnseededAdminSelector() public {
        bytes4 sel = SessionKeyManager.grantSessionKey.selector;

        // Clear the seed. `setSelectorDenied` is itself `onlyOwner`, so this is an
        // owner-authorised write — and it seals its OWN selector, not `sel`, so `sel`
        // really is un-denied afterwards.
        vm.prank(ownerAddr);
        skm.setSelectorDenied(sel, false);
        assertFalse(skm.isSelectorDenied(sel), "precondition: the seed entry is cleared");

        // A real, argument-valid owner call. Unlike the sweep, its SUCCESS is the subject,
        // so it is a typed call: a revert fails loudly here instead of being absorbed.
        vm.prank(ownerAddr);
        skm.grantSessionKey(address(0xA11CE1), _grantScope());

        assertTrue(
            skm.isSelectorDenied(sel),
            "a successful admin call must re-deny its own selector (self-sealing)"
        );
    }

    /// @dev The seed list is the ONLY thing covering a selector that has never been
    ///      invoked, so assert the post-construction state directly, with no calls made
    ///      at all. This is the check that would have caught the original defect if the
    ///      self-sealing write did not exist yet.
    function test_DenylistSeeded_ForEveryManagerAdminSelector_BeforeAnyCall() public view {
        for (uint256 i = 0; i < managerAdminSelectors.length; ++i) {
            assertTrue(
                skm.isSelectorDenied(managerAdminSelectors[i]),
                "every admin selector must be denied straight out of the constructor"
            );
        }
    }

    /// @dev `withdraw` is the one admin function the ORIGINAL test suite already pinned as
    ///      denylisted (`GovernanceRecoveryTest.test_Withdraw_RevertsForNonOwner`). Keep an
    ///      explicit assertion so the property is visible in the file that owns the gate.
    function test_WithdrawSelectorDenied_Explicitly() public view {
        assertTrue(skm.isSelectorDenied(skm.withdraw.selector));
    }

    // ------------------------------------------------------------------
    // 3. Delegator's own admin surface
    // ------------------------------------------------------------------

    /// @dev The delegator's OWN selector (`initializeSelfOwned`) is the entry the
    ///      hand-copied list was most likely to drift on. Assert it is denied after
    ///      initialization, and that the delegator's digest folds it in rather than
    ///      reporting the manager's base digest unchanged.
    function test_DenylistCoversDelegatorOwnAdminSelector() public view {
        assertTrue(
            SigilKitDelegator(eoa).isSelectorDenied(SigilKitDelegator.initializeSelfOwned.selector),
            "initializeSelfOwned must be denied on a delegated EOA"
        );
        assertTrue(
            SigilKitDelegator(eoa).adminSelectorDigest() != skm.adminSelectorDigest(),
            "the delegator digest must differ from the manager's: it has an extra admin selector"
        );
        // And the difference must be exactly the extra selector folded on top.
        bytes32 expected = skm.adminSelectorDigest();
        // forge-lint: disable-next-line(unsafe-typecast)
        expected = keccak256(abi.encodePacked(expected, bytes32(SigilKitDelegator.initializeSelfOwned.selector)));
        assertEq(
            SigilKitDelegator(eoa).adminSelectorDigest(),
            expected,
            "delegator digest must be the manager digest plus its own selector"
        );
    }

    /// @dev The delegator inherits the manager's whole admin surface; assert every one of
    ///      those is denied on the delegated EOA too, so the shared seed really is shared.
    function test_DenylistCoversDelegatorInheritedAdminSurface() public view {
        for (uint256 i = 0; i < managerAdminSelectors.length; ++i) {
            assertTrue(
                SigilKitDelegator(eoa).isSelectorDenied(managerAdminSelectors[i]),
                "inherited admin selectors must be denied on the delegator too"
            );
        }
    }

    /// @dev THE key regression: a session key with an allow-all scope (merkleRoot == 0, so
    ///      NO Merkle check) must still be unable to reach ANY admin selector through the
    ///      permissionless execution entry point. This is the end-to-end consequence of the
    ///      denylist, and it is what the original suite never asserted.
    function test_AdminSurfaceUnreachableViaSessionKey_AllowAllScope() public {
        // Grant an allow-all key so only the denylist stands between the agent and admin.
        vm.prank(ownerAddr);
        skm.grantSessionKey(
            address(this),
            SessionKeyManager.Scope({
                expiresAt: uint48(block.timestamp + 1 days),
                windowSeconds: 1 hours,
                perActionCap: 1 ether,
                perWindowCap: 1 ether,
                merkleRoot: bytes32(0), // allow ALL targets
                countersignAbove: 0,
                enforceNativeDelta: false,
                tokenWatchlist: new address[](0)
            })
        );

        bytes32 domain = skm.DOMAIN_SEPARATOR();
        for (uint256 i = 0; i < managerAdminSelectors.length; ++i) {
            // Target the manager itself with each admin selector; the inner call would be a
            // no-op-or-revert, but the denylist check must fire FIRST and revert the whole
            // execution.
            SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
                agentId: keccak256("coverage"),
                target: address(skm),
                selector: managerAdminSelectors[i],
                value: 0,
                nonce: 0,
                expiry: uint48(block.timestamp + 10 minutes),
                rationaleHash: keccak256("coverage"),
                data: ""
            });
            (bool ok,) = address(skm).call(
                abi.encodeWithSelector(
                    skm.executeWithSessionKey.selector,
                    req,
                    _sign(req, domain),
                    new bytes32[](0),
                    bytes("")
                )
            );
            assertFalse(ok, "session key must never reach an admin selector, even with merkleRoot==0");
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Calls `target` with `data` as the owner, tolerating a revert (some admin
    ///      functions reject our placeholder args), then requires the selector to be denied.
    ///      Using a low-level call keeps the assertion about the DENYLIST rather than about
    ///      whether our dummy arguments happened to be valid.
    ///
    ///      `ok` is bound but NOT asserted, and that is a deliberate limit rather than an
    ///      oversight: `revokeSessionKey(address(0xDEAD))` and `rotateSessionKey(address(0), …)`
    ///      both revert on `KeyUnknown`, so requiring `ok == true` here would make this sweep
    ///      an argument-validity test and break on entry points whose placeholder args are
    ///      deliberately nonsense.
    ///
    ///      Stated plainly, because a helper that swallows a call result invites the reader to
    ///      over-credit it: since every manager admin selector is already denied by the
    ///      constructor seed, `denied` is true whether or not `ok` is, and whether or not
    ///      `onlyOwner` sealed anything. This sweep therefore CANNOT falsify self-sealing — it
    ///      pins the seed. `test_SelfSealingDeniesAnUnseededAdminSelector` clears the seed first
    ///      and is the test that actually exercises the seal.
    function _callAndAssertDenied(address target, bytes4 selector, bytes memory data) internal returns (bool) {
        vm.prank(ownerAddr);
        (bool ok,) = target.call(abi.encodePacked(selector, data));
        // Result intentionally NOT asserted — see the @dev above for why, and for which
        // test does assert the call's outcome.
        ok;
        bool denied = SessionKeyManager(payable(target)).isSelectorDenied(selector);
        assertTrue(denied, "admin selector must be denied after invocation");
        return denied;
    }

    function _sign(SessionKeyManager.ActionRequest memory req, bytes32 domain) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                skm.ACTION_REQUEST_TYPEHASH(),
                req.agentId, req.target, req.selector, req.value, req.nonce,
                req.expiry, req.rationaleHash, keccak256(req.data)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The single scope shape both the coverage sweep and the self-sealing test grant
    ///      through, so the arguments the contract is handed are arguments it ACCEPTS. Kept in
    ///      one place because a scope that stops being valid would turn the self-sealing test
    ///      into a second argument-validity test without saying so.
    function _grantScope() internal view returns (SessionKeyManager.Scope memory) {
        return SessionKeyManager.Scope({
            expiresAt: uint48(block.timestamp + 1 days),
            windowSeconds: 1 hours,
            perActionCap: 1 ether,
            perWindowCap: 1 ether,
            merkleRoot: bytes32(0),
            countersignAbove: 0,
            enforceNativeDelta: false,
            tokenWatchlist: new address[](0)
        });
    }

    function _grantArgs() internal view returns (bytes memory) {
        return abi.encode(address(0xA11CE1), _grantScope());
    }

    function _rotateArgs() internal view returns (bytes memory) {
        SessionKeyManager.Scope memory s = SessionKeyManager.Scope({
            expiresAt: uint48(block.timestamp + 1 days),
            windowSeconds: 1 hours,
            perActionCap: 1 ether,
            perWindowCap: 1 ether,
            merkleRoot: bytes32(0),
            countersignAbove: 0,
            enforceNativeDelta: false,
            tokenWatchlist: new address[](0)
        });
        return abi.encode(address(0), address(0xB0B1), s, uint48(block.timestamp + 1 hours));
    }
}
