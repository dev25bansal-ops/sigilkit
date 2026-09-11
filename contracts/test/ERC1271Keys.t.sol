// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @title ERC1271Keys — E17: smart-account (ERC-1271) session keys. The session
///        "key" is a CONTRACT whose isValidSignature proves control of the request
///        digest; the owner grants the scope to the contract's address and agents
///        sign with `address(keyContract) || erc1271Signature`.
contract Counter {
    uint256 public count;

    function poke(uint256 by) external payable {
        count += by;
    }
}

/// @dev Realistic ERC-1271 validator: recovers an embedded signer via ECDSA.
contract MockERC1271 {
    address public immutable signer;
    bytes4 constant MAGIC = 0x1626ba7e;

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

contract ERC1271KeysTest is Test {
    SessionKeyManager internal skm;
    Counter internal counter;
    MockERC1271 internal key1271;
    MockERC1271 internal other1271;

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant CONTROLLER_KEY = 0xC7C7; // the key INSIDE the 1271 contract
    uint256 internal constant WRONG_KEY = 0xDEAD;
    address internal controller = vm.addr(CONTROLLER_KEY);

    function setUp() public {
        skm = new SessionKeyManager(vm.addr(OWNER_KEY));
        counter = new Counter();
        key1271 = new MockERC1271(controller);
        other1271 = new MockERC1271(vm.addr(WRONG_KEY));
        vm.deal(address(skm), 10 ether);
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(
            address(key1271),
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

    function _request() internal view returns (SessionKeyManager.ActionRequest memory) {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("erc1271"),
            target: address(counter),
            selector: counter.poke.selector,
            value: 0,
            nonce: skm.getNonce(address(key1271)),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("session"),
            data: abi.encode(1)
        });
    }

    function _digest(SessionKeyManager.ActionRequest memory req) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                skm.ACTION_REQUEST_TYPEHASH(),
                req.agentId, req.target, req.selector, req.value, req.nonce,
                req.expiry, req.rationaleHash, keccak256(req.data)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", skm.DOMAIN_SEPARATOR(), structHash));
    }

    function _pack(address keyContract, uint256 signerPk, SessionKeyManager.ActionRequest memory req)
        internal
        view
        returns (bytes memory)
    {
        bytes32 d = _digest(req);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, d);
        return abi.encodePacked(keyContract, r, s, v);
    }

    function test_ERC1271_KeyExecutes() public {
        SessionKeyManager.ActionRequest memory req = _request();
        (bool ok,) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector,
                req,
                _pack(address(key1271), CONTROLLER_KEY, req),
                new bytes32[](0),
                bytes("")
            )
        );
        assertTrue(ok, "1271 key with a valid inner signature should execute");
        assertEq(counter.count(), 1);
        // Nonce advanced under the 1271 CONTRACT's address, not the inner signer's.
        assertEq(skm.getNonce(address(key1271)), 1);
    }

    function test_ERC1271_WrongInnerSigner_Reverts() public {
        SessionKeyManager.ActionRequest memory req = _request();
        bytes memory sig = _pack(address(key1271), WRONG_KEY, req); // before expectRevert
        vm.expectRevert(SessionKeyManager.InvalidSignature.selector);
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
    }

    function test_ERC1271_UngrantedContract_Reverts() public {
        // The other 1271 contract has no scope → KeyUnknown after "recovery".
        SessionKeyManager.ActionRequest memory req = _request();
        bytes memory sig = _pack(address(other1271), WRONG_KEY, req); // before expectRevert
        vm.expectRevert(SessionKeyManager.KeyUnknown.selector);
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
    }

    function test_ERC1271_CodelessPrefix_Reverts() public {
        // Prefix names an address with no code — the 1271 path refuses.
        SessionKeyManager.ActionRequest memory req = _request();
        bytes32 d = _digest(req);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CONTROLLER_KEY, d);
        vm.expectRevert(SessionKeyManager.InvalidSignature.selector);
        skm.executeWithSessionKey(
            req,
            abi.encodePacked(address(0xBEEF), r, s, v),
            new bytes32[](0),
            bytes("")
        );
    }
}
