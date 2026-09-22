// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";

/// @dev Accepts ANY selector/arguments, so policy tests cannot pass accidentally
///      because the destination rejects the calldata or cannot receive ETH.
contract NativeTransferRecipient {
    uint256 public calls;

    receive() external payable {
        ++calls;
    }

    /// @dev Accepts any selector with the pinned argument so tests cannot pass
    ///      because the destination rejects calldata.
    fallback(bytes calldata) external payable returns (bytes memory) {
        ++calls;
        return "";
    }
}

/// @dev Regression evidence for the narrow arbitrary-send-eth triage on _interact.
///      All calls use the real four-argument entrypoint and real EIP-712 signatures.
contract NativeTransferAuthorizationTest is Test {
    SessionKeyManager internal manager;
    NativeTransferRecipient internal allowed;
    NativeTransferRecipient internal other;
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xB0B;
    address internal agent;
    bytes4 internal constant SELECTOR = 0x11223344;
    SessionKeyManager.Scope internal scope;
    bytes32[] internal proof;

    function setUp() public {
        vm.warp(1_000_000);
        agent = vm.addr(AGENT_KEY);
        manager = new SessionKeyManager(vm.addr(OWNER_KEY));
        allowed = new NativeTransferRecipient();
        other = new NativeTransferRecipient();
        vm.deal(address(manager), 10 ether);

        // A real two-leaf tree, with arguments pinned for the allowed recipient.
        bytes32 leaf = keccak256(abi.encode(address(allowed), SELECTOR, keccak256(abi.encode(7))));
        bytes32 sibling = keccak256(abi.encode(address(0xCAFE), SELECTOR, bytes32(0)));
        proof.push(sibling);
        scope = SessionKeyManager.Scope({
            expiresAt: uint48(block.timestamp + 1 days),
            windowSeconds: 1 hours,
            perActionCap: 1 ether,
            perWindowCap: 2 ether,
            merkleRoot: leaf < sibling
                ? keccak256(abi.encodePacked(leaf, sibling))
                : keccak256(abi.encodePacked(sibling, leaf)),
            countersignAbove: 0,
            enforceNativeDelta: false,
            tokenWatchlist: new address[](0)
        });
        _grant();
    }

    function _grant() internal {
        vm.prank(vm.addr(OWNER_KEY));
        manager.grantSessionKey(agent, scope);
    }

    function _request(uint256 value) internal view returns (SessionKeyManager.ActionRequest memory) {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("native-transfer-agent"),
            target: address(allowed),
            selector: SELECTOR,
            value: value,
            nonce: manager.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("authorized native transfer"),
            data: abi.encode(7)
        });
    }

    function _sign(SessionKeyManager.ActionRequest memory req, uint256 key) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                manager.ACTION_REQUEST_TYPEHASH(),
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", manager.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _execute(SessionKeyManager.ActionRequest memory req) internal {
        bytes memory signature = _sign(req, AGENT_KEY);
        manager.executeWithSessionKey(req, signature, proof, "");
    }

    /// @dev Check ETH, recipient side effects AND manager accounting after rejection.
    function _assertState(uint256 spent, uint256 nonce) internal view {
        assertEq(address(manager).balance, 10 ether - spent, "treasury balance");
        assertEq(address(allowed).balance, spent, "allowed recipient balance");
        assertEq(allowed.calls(), nonce, "allowed recipient calls");
        assertEq(address(other).balance, 0, "unlisted recipient received ETH");
        assertEq(other.calls(), 0, "unlisted recipient reached");
        assertEq(manager.getNonce(agent), nonce, "nonce");
        SpendPolicy.WindowState memory window = manager.getWindowState(agent);
        assertEq(window.spentThisWindow, spent, "window spend");
        assertEq(window.windowStart, nonce == 0 ? 0 : 1_000_000, "window start");
    }

    function _reject(SessionKeyManager.ActionRequest memory req, bytes memory reason) internal {
        bytes memory signature = _sign(req, AGENT_KEY);
        vm.expectRevert(reason);
        manager.executeWithSessionKey(req, signature, proof, "");
        _assertState(0, 0);
    }

    function test_NativeTransfer_ValidRequestCanBeRelayedByStranger() public {
        SessionKeyManager.ActionRequest memory req = _request(1 ether);
        bytes memory signature = _sign(req, AGENT_KEY);
        vm.prank(address(0xBAD));
        manager.executeWithSessionKey(req, signature, proof, "");
        _assertState(1 ether, 1);
    }

    function test_NativeTransfer_UngrantedSignerCannotSpendEvenWithZeroRoot() public {
        scope.merkleRoot = bytes32(0);
        _grant();
        SessionKeyManager.ActionRequest memory req = _request(1 ether);
        bytes memory signature = _sign(req, 0xDEAD);
        vm.expectRevert(SessionKeyManager.KeyUnknown.selector);
        manager.executeWithSessionKey(req, signature, proof, "");
        _assertState(0, 0);
    }

    function test_NativeTransfer_RelayerCannotSubstituteSignedDestination() public {
        // No Merkle restriction: the signature must independently bind the target.
        scope.merkleRoot = bytes32(0);
        _grant();
        SessionKeyManager.ActionRequest memory req = _request(1 ether);
        bytes memory signature = _sign(req, AGENT_KEY);
        req.target = address(other);
        vm.expectRevert(SessionKeyManager.KeyUnknown.selector);
        manager.executeWithSessionKey(req, signature, proof, "");
        _assertState(0, 0);
    }

    function test_NativeTransfer_RelayerCannotIncreaseSignedValue() public {
        SessionKeyManager.ActionRequest memory req = _request(0.5 ether);
        bytes memory signature = _sign(req, AGENT_KEY);
        req.value = 1 ether; // Still within cap: rejection must be signature authorization.
        vm.expectRevert(SessionKeyManager.KeyUnknown.selector);
        manager.executeWithSessionKey(req, signature, proof, "");
        _assertState(0, 0);
    }

    function test_NativeTransfer_CompromisedKeyCannotRedirectMerkleProof() public {
        SessionKeyManager.ActionRequest memory req = _request(1 ether);
        req.target = address(other); // A valid agent signature is NOT sufficient.
        _reject(req, abi.encodeWithSelector(SessionKeyManager.TargetNotAllowed.selector, req.target, req.selector));
        _execute(_request(1 ether)); // Same proof/nonce works for the authorized destination.
        _assertState(1 ether, 1);
    }

    function test_NativeTransfer_CompromisedKeyCannotChangeMerkleSelector() public {
        SessionKeyManager.ActionRequest memory req = _request(1 ether);
        req.selector = 0x55667788;
        _reject(req, abi.encodeWithSelector(SessionKeyManager.TargetNotAllowed.selector, req.target, req.selector));
        _execute(_request(1 ether));
        _assertState(1 ether, 1);
    }

    function test_NativeTransfer_CompromisedKeyCannotChangePinnedArguments() public {
        SessionKeyManager.ActionRequest memory req = _request(1 ether);
        req.data = abi.encode(8);
        _reject(req, abi.encodeWithSelector(SessionKeyManager.TargetNotAllowed.selector, req.target, req.selector));
        _execute(_request(1 ether));
        _assertState(1 ether, 1);
    }

    function test_NativeTransfer_OverActionCapRevertsBeforeSending() public {
        _reject(
            _request(1 ether + 1),
            abi.encodeWithSelector(SpendPolicy.PerActionCapExceeded.selector, 1 ether + 1, 1 ether)
        );
        _execute(_request(1 ether));
        _assertState(1 ether, 1);
    }

    function test_NativeTransfer_OverWindowCapRevertsBeforeSending() public {
        _execute(_request(1 ether));
        _execute(_request(1 ether));
        SessionKeyManager.ActionRequest memory req = _request(1);
        bytes memory signature = _sign(req, AGENT_KEY);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PerWindowCapExceeded.selector, 2 ether + 1, 2 ether));
        manager.executeWithSessionKey(req, signature, proof, "");
        _assertState(2 ether, 2);
    }

    function test_NativeTransfer_ReplayedRequestCannotSendTwice() public {
        SessionKeyManager.ActionRequest memory req = _request(1 ether);
        bytes memory signature = _sign(req, AGENT_KEY);
        manager.executeWithSessionKey(req, signature, proof, "");
        vm.expectRevert(SessionKeyManager.NonceUsed.selector);
        manager.executeWithSessionKey(req, signature, proof, "");
        _assertState(1 ether, 1);
    }

    function test_NativeTransfer_RevokedKeyCannotSend() public {
        vm.prank(vm.addr(OWNER_KEY));
        manager.revokeSessionKey(agent);
        _reject(_request(1 ether), abi.encodeWithSelector(SessionKeyManager.KeyRevoked.selector));
    }

    function test_NativeTransfer_ExpiredKeyCannotSend() public {
        vm.warp(uint256(scope.expiresAt) + 1);
        _reject(_request(1 ether), abi.encodeWithSelector(SessionKeyManager.KeyExpired.selector));
    }

    function test_NativeTransfer_SelfWithdrawalSelectorCannotBypassCaps() public {
        scope.merkleRoot = bytes32(0);
        _grant();
        SessionKeyManager.ActionRequest memory req = _request(0);
        req.target = address(manager);
        req.selector = SessionKeyManager.withdraw.selector;
        req.data = abi.encode(address(other), 10 ether);
        _reject(req, abi.encodeWithSelector(SessionKeyManager.SelectorDenied.selector, req.selector));
    }

    function test_NativeTransfer_ZeroRootExplicitlyAllowsOtherDestinationsWithinCaps() public {
        scope.merkleRoot = bytes32(0); // Owner opt-in, not an authorization bypass.
        _grant();
        SessionKeyManager.ActionRequest memory req = _request(1 ether);
        req.target = address(other);
        _execute(req);
        assertEq(address(other).balance, 1 ether);
        assertEq(other.calls(), 1);
        assertEq(address(manager).balance, 9 ether);
        assertEq(manager.getNonce(agent), 1);
        assertEq(manager.getWindowState(agent).spentThisWindow, 1 ether);
    }
}
