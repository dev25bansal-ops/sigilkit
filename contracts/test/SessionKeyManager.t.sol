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

contract SessionKeyManagerTest is Test {
    SessionKeyManager internal skm;
    Counter internal counter;
    OwnerOnlyTarget internal ownerTarget;

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xB0B;
    address internal agent = vm.addr(AGENT_KEY);

    // Default scope: 1 ETH per action, 2 ETH per 1-hour window, expires in 1 day.
    SessionKeyManager.Scope internal defaultScope;

    function setUp() public {
        skm = new SessionKeyManager(vm.addr(OWNER_KEY));
        counter = new Counter();
        ownerTarget = new OwnerOnlyTarget();
        vm.deal(address(skm), 100 ether);

        defaultScope = SessionKeyManager.Scope({
            expiresAt: uint48(block.timestamp + 1 days),
            windowSeconds: 1 hours,
            perActionCap: 1 ether,
            perWindowCap: 2 ether,
            merkleRoot: bytes32(0)
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
                skm.executeWithSessionKey.selector, req, sig, new bytes32[](0)
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
                skm.executeWithSessionKey.selector, req, abi.encodePacked(r, s, v), new bytes32[](0)
            )
        );
        assertTrue(ok, "low-s signature should execute");

        // Malleated twin (s' = N - s, flipped parity) recovers the same address but
        // must be rejected — recovery runs before any state check.
        uint256 secp256k1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sHigh = bytes32(secp256k1N - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        vm.expectRevert(SessionKeyManager.InvalidSignature.selector);
        skm.executeWithSessionKey(req, abi.encodePacked(r, sHigh, vFlip), new bytes32[](0));
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
        assertTrue(bytes4(ret) == SessionKeyManager.KeyExpired.selector || ret.length >= 4);
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
        bytes memory badSig = _signRequest(0xDEAD, req, ds); // not the granted key

        (bool ok, bytes memory ret) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, req, badSig, new bytes32[](0))
        );
        assertFalse(ok, "wrong signer should fail");
    }

    function test_RejectsValueFromRelayer() public {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, defaultScope);

        SessionKeyManager.ActionRequest memory req =
            _makeRequest(address(counter), counter.poke.selector, 0.1 ether, abi.encode(1));
        bytes memory sig = _signRequest(AGENT_KEY, req, skm.DOMAIN_SEPARATOR());

        vm.expectRevert(SessionKeyManager.ValueNotAccepted.selector);
        skm.executeWithSessionKey{value: 0.1 ether}(req, sig, new bytes32[](0));
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
        // Root over two leaves: counter.poke and ownerTarget.sweep (sorted-pair hashing).
        bytes32 leafA = keccak256(abi.encode(address(counter), counter.poke.selector));
        bytes32 leafB = keccak256(abi.encode(address(ownerTarget), ownerTarget.sweep.selector));
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
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, good, sig, proof)
        );
        assertTrue(ok, "listed target with proof should pass");

        // Unlisted target (Counter via adminAction's selector on ownerTarget) — wrong leaf.
        SessionKeyManager.ActionRequest memory bad =
            _makeRequest(address(ownerTarget), ownerTarget.adminAction.selector, 0 ether, "");
        proof[0] = leafA; // wrong proof
        bytes memory sig2 = _signRequest(AGENT_KEY, bad, skm.DOMAIN_SEPARATOR());
        (ok,) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, bad, sig2, proof)
        );
        assertFalse(ok, "unlisted target should fail");
    }

    function _sortedHash(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
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
