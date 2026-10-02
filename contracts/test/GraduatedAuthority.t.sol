// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @title GraduatedAuthority — covers E10 (owner countersign above a threshold) and
///        E11 (balance-delta enforcement) from the enhancements doc.
contract GraduatedAuthorityTest is Test {
    SessionKeyManager internal skm;

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xB0B;
    address internal agent = vm.addr(AGENT_KEY);

    function setUp() public {
        skm = new SessionKeyManager(vm.addr(OWNER_KEY));
        vm.deal(address(skm), 100 ether);
    }

    function _grant(uint256 countersignAbove, bool enforceNativeDelta, address[] memory watchlist)
        internal
    {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(
            agent,
            SessionKeyManager.Scope({
                expiresAt: uint48(block.timestamp + 1 days),
                windowSeconds: 1 hours,
                perActionCap: 5 ether,
                perWindowCap: 10 ether,
                merkleRoot: bytes32(0),
                countersignAbove: countersignAbove,
                enforceNativeDelta: enforceNativeDelta,
                tokenWatchlist: watchlist
            })
        );
    }

    function _request(address target, bytes4 selector, uint256 value, bytes memory data)
        internal
        view
        returns (SessionKeyManager.ActionRequest memory)
    {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("e10"),
            target: target,
            selector: selector,
            value: value,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("e10/e11"),
            data: data
        });
    }

    function _signRequest(SessionKeyManager.ActionRequest memory req) internal view returns (bytes memory) {
        return _signRequestWith(AGENT_KEY, req);
    }

    function _signRequestWith(uint256 key, SessionKeyManager.ActionRequest memory req)
        internal
        view
        returns (bytes memory)
    {
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Owner approval over the request digest (E10): the digest binds the whole
    ///      request, so the approval is single-use by nonce uniqueness.
    function _signApproval(SessionKeyManager.ActionRequest memory req, uint256 signerKey)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                skm.ACTION_REQUEST_TYPEHASH(),
                req.agentId, req.target, req.selector, req.value, req.nonce,
                req.expiry, req.rationaleHash, keccak256(req.data)
            )
        );
        bytes32 requestDigest = keccak256(abi.encodePacked("\x19\x01", skm.DOMAIN_SEPARATOR(), structHash));
        bytes32 approvalDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                skm.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(skm.REQUEST_APPROVAL_TYPEHASH(), requestDigest))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, approvalDigest);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------
    // Manager-parameterised helpers (D-13)
    //
    // The helpers above close over the suite's own `skm`, so they can only exercise an
    // EOA owner. D-13 needs a SECOND manager whose owner is a contract, and a digest is
    // domain-bound to `address(manager)` — so these variants take the manager explicitly
    // rather than duplicating the typehash/domain logic a third time.
    // ------------------------------------------------------------------

    function _requestFor(
        SessionKeyManager m,
        address target,
        bytes4 selector,
        uint256 value,
        bytes memory data
    ) internal view returns (SessionKeyManager.ActionRequest memory) {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("e10"),
            target: target,
            selector: selector,
            value: value,
            nonce: m.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("e10/e11"),
            data: data
        });
    }

    function _signRequestFor(
        SessionKeyManager m,
        uint256 key,
        SessionKeyManager.ActionRequest memory req
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _requestDigestFor(m, req));
        return abi.encodePacked(r, s, v);
    }

    function _requestDigestFor(SessionKeyManager m, SessionKeyManager.ActionRequest memory req)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                m.ACTION_REQUEST_TYPEHASH(),
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
        return keccak256(abi.encodePacked("\x19\x01", m.DOMAIN_SEPARATOR(), structHash));
    }

    function _approvalDigestFor(SessionKeyManager m, SessionKeyManager.ActionRequest memory req)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                m.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(m.REQUEST_APPROVAL_TYPEHASH(), _requestDigestFor(m, req)))
            )
        );
    }

    /// @dev A raw 65-byte ECDSA approval — what the OLD (ECDSA-only) path required. Used
    ///      as the negative control: a contract owner can never satisfy it.
    function _signApprovalFor(SessionKeyManager m, SessionKeyManager.ActionRequest memory req, uint256 signerKey)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, _approvalDigestFor(m, req));
        return abi.encodePacked(r, s, v);
    }

    function _tryExecute(
        SessionKeyManager m,
        SessionKeyManager.ActionRequest memory req,
        bytes memory sig,
        bytes memory approval
    ) internal returns (bool ok) {
        (ok,) = address(m).call(
            abi.encodeWithSelector(
                m.executeWithSessionKey.selector, req, sig, new bytes32[](0), approval
            )
        );
    }

    // ------------------------------------------------------------------
    // E10 — graduated authority
    // ------------------------------------------------------------------
    function test_Countersign_RequiredAboveThreshold() public {
        _grant(1 ether, false, new address[](0));
        SessionKeyManager.ActionRequest memory req = _request(address(0xBEEF), bytes4(0x12345678), 2 ether, "");
        bytes memory sig = _signRequest(req); // computed BEFORE expectRevert (view calls consume it)
        vm.expectRevert(SessionKeyManager.OwnerCountersignRequired.selector);
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
    }

    function test_Countersign_BelowThresholdExempt() public {
        _grant(1 ether, false, new address[](0));
        SessionKeyManager.ActionRequest memory req = _request(address(0xBEEF), bytes4(0x12345678), 0.5 ether, "");
        (bool ok,) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, req, _signRequest(req), new bytes32[](0), bytes(""))
        );
        assertTrue(ok, "value at/below the threshold needs no countersign");
    }

    function test_Countersign_ValidApprovalExecutes() public {
        _grant(1 ether, false, new address[](0));
        SessionKeyManager.ActionRequest memory req = _request(address(0xBEEF), bytes4(0x12345678), 2 ether, "");
        (bool ok,) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector, req, _signRequest(req), new bytes32[](0), _signApproval(req, OWNER_KEY)
            )
        );
        assertTrue(ok, "owner-approved large action should execute");
    }

    function test_Countersign_ApprovalByNonOwnerReverts() public {
        _grant(1 ether, false, new address[](0));
        SessionKeyManager.ActionRequest memory req = _request(address(0xBEEF), bytes4(0x12345678), 2 ether, "");
        bytes memory sig = _signRequest(req);
        bytes memory badApproval = _signApproval(req, 0xDEAD);
        vm.expectRevert(SessionKeyManager.InvalidOwnerApproval.selector);
        skm.executeWithSessionKey(req, sig, new bytes32[](0), badApproval);
    }

    function test_Countersign_OwnerKeyExempt() public {
        // The session key IS the owner key: no countersign needed even above threshold.
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(
            vm.addr(OWNER_KEY),
            SessionKeyManager.Scope({
                expiresAt: uint48(block.timestamp + 1 days),
                windowSeconds: 1 hours,
                perActionCap: 5 ether,
                perWindowCap: 10 ether,
                merkleRoot: bytes32(0),
                countersignAbove: 0.1 ether,
                enforceNativeDelta: false,
                tokenWatchlist: new address[](0)
            })
        );
        SessionKeyManager.ActionRequest memory req =
            _request(address(0xBEEF), bytes4(0x12345678), 2 ether, "");
        (bool ok,) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector, req, _signRequestWith(OWNER_KEY, req), new bytes32[](0), bytes("")
            )
        );
        assertTrue(ok, "owner's own key is exempt from countersign");
    }

    // ------------------------------------------------------------------
    // D-13 — a CONTRACT owner must be able to countersign (ERC-1271 owner approval)
    // ------------------------------------------------------------------

    /// @dev D-13 regression. The owner is a CONTRACT (a Safe-style 1271 validator), and
    ///      the scope sets `countersignAbove`. The owner approval is therefore supplied in
    ///      the E17 wire format — `address(owner) ‖ 1271signature` — rather than as a raw
    ///      65-byte ECDSA signature.
    ///
    ///      Before the fix this reverted `InvalidOwnerApproval`: the countersign path
    ///      called `_ecrecover` directly, and `ecrecover` can never return a contract
    ///      address. So the production topology `Deploy.s.sol` recommends (a 2-of-3 Gnosis
    ///      Safe as owner) silently disabled E10 entirely — every action above the
    ///      threshold became unexecutable, discoverable only by hitting the revert.
    function test_Countersign_ContractOwner_1271Approval_Executes() public {
        MockSafeOwner safe = new MockSafeOwner(vm.addr(OWNER_KEY));
        SessionKeyManager manager = new SessionKeyManager(address(safe));
        vm.deal(address(manager), 100 ether);

        vm.prank(address(safe));
        manager.grantSessionKey(
            agent,
            SessionKeyManager.Scope({
                expiresAt: uint48(block.timestamp + 1 days),
                windowSeconds: 1 hours,
                perActionCap: 5 ether,
                perWindowCap: 10 ether,
                merkleRoot: bytes32(0),
                countersignAbove: 1 ether,
                enforceNativeDelta: false,
                tokenWatchlist: new address[](0)
            })
        );

        SessionKeyManager.ActionRequest memory req =
            _requestFor(manager, address(0xBEEF), bytes4(0x12345678), 2 ether, "");
        bytes memory sig = _signRequestFor(manager, AGENT_KEY, req);

        // Sanity: the contract owner cannot produce a plain ECDSA approval, because
        // ecrecover of ANY preimage is an EOA. This is the exact reason the old
        // ECDSA-only path could never work for a contract owner.
        assertFalse(
            _tryExecute(manager, req, sig, _signApprovalFor(manager, req, OWNER_KEY)),
            "a bare 65-byte ECDSA approval must NOT satisfy a contract owner"
        );

        // The E17 wire format: address(owner) ‖ 1271 signature.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, _approvalDigestFor(manager, req));
        assertTrue(
            _tryExecute(manager, req, sig, abi.encodePacked(address(safe), r, s, v)),
            "D-13: a 1271 contract owner must be able to countersign"
        );
    }

    /// @dev The negative control for the test above: a 1271 approval signed by the WRONG
    ///      inner signer must still be rejected. Without this, the test above would also
    ///      pass if `_recoverSigner` accepted any 1271-shaped blob.
    ///
    ///      Note the error is `InvalidSignature`, not `InvalidOwnerApproval`: a contract
    ///      that answers `0xffffffff` is a FAILED signature, and `_recoverSigner` rejects
    ///      it there — before the recovered address is ever compared to `s.owner`. That
    ///      distinction is deliberate and is what the pre-existing EOA-owner tests pin
    ///      from the other side (a VALID signature by the wrong key yields
    ///      `InvalidOwnerApproval`, because recovery succeeds and only the comparison
    ///      fails). Both paths reject; only the diagnosis differs.
    function test_Countersign_ContractOwner_WrongInnerSigner_Reverts() public {
        MockSafeOwner safe = new MockSafeOwner(vm.addr(OWNER_KEY));
        SessionKeyManager manager = new SessionKeyManager(address(safe));
        vm.deal(address(manager), 100 ether);

        vm.prank(address(safe));
        manager.grantSessionKey(
            agent,
            SessionKeyManager.Scope({
                expiresAt: uint48(block.timestamp + 1 days),
                windowSeconds: 1 hours,
                perActionCap: 5 ether,
                perWindowCap: 10 ether,
                merkleRoot: bytes32(0),
                countersignAbove: 1 ether,
                enforceNativeDelta: false,
                tokenWatchlist: new address[](0)
            })
        );

        SessionKeyManager.ActionRequest memory req =
            _requestFor(manager, address(0xBEEF), bytes4(0x12345678), 2 ether, "");
        bytes memory sig = _signRequestFor(manager, AGENT_KEY, req);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEAD, _approvalDigestFor(manager, req));
        bytes memory badApproval = abi.encodePacked(address(safe), r, s, v);
        vm.expectRevert(SessionKeyManager.InvalidSignature.selector);
        manager.executeWithSessionKey(req, sig, new bytes32[](0), badApproval);

        // And the diagnosis is symmetric: a VALID 1271 signature by a contract that is
        // NOT the owner recovers fine, so it must fail at the owner comparison instead.
        MockSafeOwner impostor = new MockSafeOwner(vm.addr(0xDEAD));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(0xDEAD, _approvalDigestFor(manager, req));
        vm.expectRevert(SessionKeyManager.InvalidOwnerApproval.selector);
        manager.executeWithSessionKey(
            req, sig, new bytes32[](0), abi.encodePacked(address(impostor), r2, s2, v2)
        );
    }

    // ------------------------------------------------------------------
    // E11 — balance-delta enforcement
    // ------------------------------------------------------------------
    function test_NativeDelta_LegitimateDeclaredValuePasses() public {
        _grant(0, true, new address[](0));
        SessionKeyManager.ActionRequest memory req =
            _request(address(0xBEEF), bytes4(0x12345678), 0.3 ether, "");
        (bool ok,) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, req, _signRequest(req), new bytes32[](0), bytes(""))
        );
        assertTrue(ok, "sending exactly the declared value must pass");
        assertEq(address(0xBEEF).balance, 0.3 ether);
    }

    function test_NativeDelta_SiphonReverts() public {
        NativeSiphon target = new NativeSiphon(address(skm));
        _grant(0, true, new address[](0));
        SessionKeyManager.ActionRequest memory req =
            _request(address(target), target.poke.selector, 0.3 ether, abi.encode(0));
        bytes memory sig = _signRequest(req);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKeyManager.NativeDeltaExceeded.selector,
                100 ether, // balance at snapshot
                1 ether, // after the "siphon" deal
                0.3 ether // declared value
            )
        );
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
    }

    function test_TokenDelta_UndeclaredOutflowReverts() public {
        MockToken token = new MockToken();
        token.mint(address(skm), 1000e18);
        address[] memory watch = new address[](1);
        watch[0] = address(token);
        TokenDrain target = new TokenDrain(token);
        _grant(0, true, watch);

        // Target moves watched tokens out with a non-transfer selector → declared = 0.
        SessionKeyManager.ActionRequest memory req =
            _request(address(target), target.drain.selector, 0, abi.encode(10e18));
        bytes memory sig = _signRequest(req);
        vm.expectRevert();
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
    }

    function test_TokenDelta_DeclaredTransferPasses() public {
        MockToken token = new MockToken();
        token.mint(address(skm), 1000e18);
        address[] memory watch = new address[](1);
        watch[0] = address(token);
        _grant(0, true, watch);

        // A standard transfer WITH the transfer selector: declared = amount → allowed.
        SessionKeyManager.ActionRequest memory req = _request(
            address(token), token.transfer.selector, 0, abi.encode(address(0xCAFE), uint256(10e18))
        );
        (bool ok,) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, req, _signRequest(req), new bytes32[](0), bytes(""))
        );
        assertTrue(ok, "declared transfer of a watched token must pass");
        assertEq(token.balanceOf(address(0xCAFE)), 10e18);
    }
}

/// @dev Simulates a malicious inner call: uses the test VM cheatcode to shrink the
///      wallet's native balance beyond the declared value.
contract NativeSiphon {
    address internal immutable manager;
    address internal constant VM = 0x7109709ECfa91a80626fF3989D68f67F5b1DD12D;

    constructor(address manager_) {
        manager = manager_;
    }

    function poke(uint256) external payable {
        (bool ok,) = VM.call(abi.encodeWithSignature("deal(address,uint256)", manager, 1 ether));
        require(ok, "cheat failed");
    }
}

/// @dev Minimal ERC-20-shaped token with an admin move that bypasses `transfer`
///      (models a compromised/vulnerable target pulling tokens without the standard
///      selector — exactly what the E11 watchlist exists to catch).
contract MockToken {
    mapping(address => uint256) public balanceOf;
    uint8 public constant decimals = 18;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    /// @notice Admin move — decreases the holder's balance WITHOUT the transfer selector.
    function adminMove(address from, address to, uint256 amount) external {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Target that drains watched tokens from the wallet via the admin move.
contract TokenDrain {
    MockToken internal immutable token;

    constructor(MockToken token_) {
        token = token_;
    }

    function drain(uint256 amount) external {
        // msg.sender is the wallet (the manager) during the scoped inner call.
        token.adminMove(msg.sender, address(0xDEAD), amount);
    }
}

/// @dev D-13: a contract owner in the shape of a Safe/multisig — an ERC-1271 validator
///      that proves control of an approval digest by recovering an embedded EOA signer.
///      The point is that the OWNER ADDRESS IS A CONTRACT, which is exactly the case the
///      old ECDSA-only countersign path could never satisfy: `ecrecover` returns an EOA
///      for every preimage, so no 65-byte signature can ever resolve to this address.
contract MockSafeOwner {
    address public immutable signer;
    bytes4 internal constant MAGIC = 0x1626ba7e;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        return ecrecover(hash, v, r, s) == signer ? MAGIC : bytes4(0xffffffff);
    }
}
