// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";
import {SigilKitDelegator} from "../src/SigilKitDelegator.sol";
import {ActionLogger} from "../src/ActionLogger.sol";

/// @title SigilKitDelegatorTest — the EIP-7702-native wallet (enhancement E13).
/// @dev vm.etch replicates the POST-delegation effect of a 7702 authorization (the
///      canonical implementation's runtime code executing in the EOA's context with
///      the EOA's own storage and balance); the designator format itself is covered
///      by the SDK's eip7702 tests.
contract Counter {
    uint256 public count;
    event Poked(address caller, uint256 value);

    function poke(uint256 by) external payable returns (uint256) {
        count += by;
        emit Poked(msg.sender, msg.value);
        return count;
    }
}

contract SigilKitDelegatorTest is Test {
    SigilKitDelegator internal impl;
    Counter internal counter;

    uint256 internal constant EOA_KEY = 0xA11CE; // the human owner's EOA key
    uint256 internal constant AGENT_KEY = 0xB0B;
    address payable internal eoa;
    address internal agent = vm.addr(AGENT_KEY);

    function setUp() public {
        impl = new SigilKitDelegator(); // canonical deployment
        counter = new Counter();
        eoa = payable(vm.addr(EOA_KEY));
        vm.deal(eoa, 10 ether);

        // Simulate EIP-7702 delegation: the EOA now runs the implementation's code.
        vm.etch(eoa, address(impl).code);
        vm.prank(eoa);
        SigilKitDelegator(eoa).initializeSelfOwned();
    }

    function _grant() internal {
        vm.prank(eoa); // the EOA owns itself — its key is the admin
        SigilKitDelegator(eoa).grantSessionKey(
            agent,
            SessionKeyManager.Scope({
                expiresAt: uint48(block.timestamp + 1 days),
                windowSeconds: 1 hours,
                perActionCap: 0.5 ether,
                perWindowCap: 1 ether,
                merkleRoot: bytes32(0),
                countersignAbove: 0,
                enforceNativeDelta: false,
                tokenWatchlist: new address[](0)
            })
        );
    }

    function _request(uint256 value, bytes memory data)
        internal
        view
        returns (SessionKeyManager.ActionRequest memory)
    {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("delegator-agent"),
            target: address(counter),
            selector: counter.poke.selector,
            value: value,
            nonce: SigilKitDelegator(eoa).getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("top up the protocol position"),
            data: data
        });
    }

    function _sign(SessionKeyManager.ActionRequest memory req) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                SigilKitDelegator(eoa).ACTION_REQUEST_TYPEHASH(),
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
        // The domain binds address(this) of the WALLET — the EOA itself.
        bytes32 ds = SigilKitDelegator(eoa).DOMAIN_SEPARATOR();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ds, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_Initialize_SetsSelfOwnership_AndIsOneShot() public {
        assertEq(SigilKitDelegator(eoa).owner(), eoa, "the EOA must own itself");
        vm.prank(eoa);
        vm.expectRevert(SigilKitDelegator.AlreadyInitialized.selector);
        SigilKitDelegator(eoa).initializeSelfOwned();
    }

    function test_DomainSeparator_BindsTheEoa() public view {
        bytes32 ds = SigilKitDelegator(eoa).DOMAIN_SEPARATOR();
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("SigilKit"),
                keccak256("1"),
                block.chainid,
                eoa
            )
        );
        assertEq(ds, expected, "domain must bind the EOA address");
    }

    function test_AgentExecutes_FromEoaBalance_EmitsAudit() public {
        _grant();
        SessionKeyManager.ActionRequest memory req = _request(0.2 ether, abi.encode(3));
        uint256 eoaBefore = eoa.balance;

        vm.expectEmit(true, true, true, true, eoa);
        emit ActionLogger.ActionLogged(
            req.agentId, address(counter), counter.poke.selector, 0.2 ether, req.rationaleHash, uint48(block.timestamp)
        );
        // Permissionless relay: anyone can submit; value leaves the EOA balance.
        SigilKitDelegator(eoa).executeWithSessionKey(req, _sign(req), new bytes32[](0), bytes(""));

        assertEq(counter.count(), 3);
        assertEq(address(counter).balance, 0.2 ether);
        assertEq(eoa.balance, eoaBefore - 0.2 ether, "value must flow from the EOA balance");
    }

    function test_UninitializedEoa_IsInert() public {
        // A freshly-delegated EOA that never initialized: no scopes can exist, so the
        // execution path always reverts KeyUnknown — delegation alone grants nothing.
        address payable fresh = payable(vm.addr(0xC0DE));
        vm.deal(fresh, 1 ether);
        vm.etch(fresh, address(impl).code);
        SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
            agentId: keccak256("x"),
            target: address(counter),
            selector: counter.poke.selector,
            value: 0,
            nonce: 0,
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("x"),
            data: ""
        });
        bytes32 structHash = keccak256(
            abi.encode(
                SigilKitDelegator(fresh).ACTION_REQUEST_TYPEHASH(),
                req.agentId, req.target, req.selector, req.value, req.nonce,
                req.expiry, req.rationaleHash, keccak256(req.data)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", SigilKitDelegator(fresh).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, digest);
        vm.expectRevert(SessionKeyManager.KeyUnknown.selector);
        SigilKitDelegator(fresh).executeWithSessionKey(req, abi.encodePacked(r, s, v), new bytes32[](0), bytes(""));
    }

    function test_CapsEnforcedOnTheEoa() public {
        _grant();
        SessionKeyManager.ActionRequest memory req = _request(0.6 ether, abi.encode(1));
        bytes memory sig = _sign(req); // computed BEFORE expectRevert (view calls consume it)
        vm.expectRevert(); // PerActionCapExceeded (0.6 > 0.5)
        SigilKitDelegator(eoa).executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
        assertEq(counter.count(), 0, "nothing executed");
    }

    function test_NonOwnerCannotGrant() public {
        vm.prank(agent);
        vm.expectRevert(SessionKeyManager.NotOwner.selector);
        SigilKitDelegator(eoa).grantSessionKey(
            agent,
            SessionKeyManager.Scope({
                expiresAt: uint48(block.timestamp + 1 days),
                windowSeconds: 1 hours,
                perActionCap: 0.5 ether,
                perWindowCap: 1 ether,
                merkleRoot: bytes32(0),
                countersignAbove: 0,
                enforceNativeDelta: false,
                tokenWatchlist: new address[](0)
            })
        );
    }
}
