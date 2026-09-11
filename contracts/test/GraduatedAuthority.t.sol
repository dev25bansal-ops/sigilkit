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
