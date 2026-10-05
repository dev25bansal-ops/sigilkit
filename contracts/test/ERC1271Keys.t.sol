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

/// @dev SEC-11 adversarial mock: a "signature service" that returns the ERC-1271 magic
///      but NEVER validates the digest. The magic sits in the HIGH 4 bytes of the returned
///      word — where a CONFORMING validator also puts it — but the remaining 28 bytes are
///      `garbage` instead of zero padding. That is the shape the removed
///      `bytes4(ret) == 0x1626ba7e` branch accepted: it compared only the leading 4 bytes,
///      so any non-zero payload riding below the magic was invisible to it.
contract MockMagicWithPayload1271 {
    bytes32 public immutable garbage;

    constructor(bytes32 garbage_) {
        garbage = garbage_;
    }

    function isValidSignature(bytes32, bytes memory) external view returns (bytes32) {
        // magic in bytes [0:4] of the word, attacker-chosen payload in bytes [4:32].
        // Bit 32 is FORCED on so the payload is non-zero for every `garbage`: otherwise
        // `garbage < 2**32` would clear down to the canonical magic word and the mock
        // would be answering correctly, which is a different (and separately tested) case.
        return bytes32(
            (uint256(0x1626ba7e) << 224) | ((uint256(garbage) & ~uint256(0xffffffff)) | (1 << 32))
        );
    }
}

/// @dev SEC-11: a non-standard validator that returns a BARE 4-byte magic (no ABI
///      padding). Still accepted — see the `ret.length == 4` branch in
///      `SessionKeyManager._isERC1271SuccessMagic`, which is safe precisely because a
///      4-byte return has no room to hide a payload.
contract MockBareBytes41271 {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

/// @dev SEC-11: the native-wallet overload's magic (0x20c13b0b) in the canonical
///      left-aligned word. Must keep working — the fix tightens the *alignment*
///      check, not the set of accepted magic values.
contract MockNativeWallet1271 {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return 0x20c13b0b;
    }
}

/// @dev SEC-11 negative: returns a 32-byte word whose HIGH 4 bytes are the magic and whose
///      remaining 28 bytes are garbage. No conforming ERC-1271 validator produces this (the
///      declared `bytes4` return leaves the low 28 bytes zero), and it is the exact bypass
///      the catalog describes.
contract MockMagicWithPayloadFixed1271 {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes32) {
        return bytes32((uint256(0x1626ba7e) << 224) | 0xdeadbeef);
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

    /// @dev Grants a scope to an arbitrary 1271-style contract, reproducing the SEC-11
    ///      threat model: the owner mis-grants authority to a contract that answers
    ///      `isValidSignature` without ever checking the digest.
    function _grantTo(address key) internal {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(
            key,
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

    /// @dev Drives a full executeWithSessionKey for an arbitrary "key contract", signing
    ///      the request with junk (the point is that the contract is supposed to reject
    ///      it on its own).
    function _tryExecuteAs(address keyContract) internal returns (bool ok) {
        SessionKeyManager.ActionRequest memory req = _request();
        bytes memory sig = abi.encodePacked(keyContract, new bytes(65)); // no valid inner sig
        (ok,) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector, req, sig, new bytes32[](0), bytes("")
            )
        );
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

    // ------------------------------------------------------------------
    // SEC-11: the magic-value alignment check
    // ------------------------------------------------------------------

    /// @dev THE regression test. The contract returns a 32-byte word whose LOW 4 bytes
    ///      are the ERC-1271 magic and whose remaining 28 bytes are attacker-chosen
    ///      garbage — it never looks at the digest. The previous
    ///      `|| bytes4(ret) == bytes4(0x1626ba7e)` branch matched exactly this and
    ///      accepted the response as a valid signature, so a mis-scoped owner would have
    ///      handed the key full authority to a contract that verifies nothing.
    function test_ERC1271_HighAlignedMagic_IsRejected() public {
        MockMagicWithPayloadFixed1271 bad = new MockMagicWithPayloadFixed1271();
        _grantTo(address(bad));
        assertFalse(
            _tryExecuteAs(address(bad)),
            "SEC-11: a magic word carrying a garbage payload must be rejected"
        );
    }

    /// @dev Same attack, garbage varied: the rejected shape must be rejected for EVERY
    ///      value of the non-magic bytes, not just one fixture. Fuzzing the payload
    ///      rules out the "rejected by coincidence" failure mode where a single
    ///      hardcoded value happens not to match.
    function test_ERC1271_HighAlignedMagic_RejectedForAnyGarbage(uint256 garbage) public {
        MockMagicWithPayload1271 bad = new MockMagicWithPayload1271(bytes32(garbage));
        _grantTo(address(bad));
        assertFalse(
            _tryExecuteAs(address(bad)),
            "SEC-11: a magic word carrying any garbage payload must never be accepted"
        );
    }

    /// @dev Positive control for the same code path: a real validator's canonical
    ///      left-aligned ABI word (magic in the HIGH 4 bytes, zero padding below) — which
    ///      is byte-for-byte the shape `_isERC1271SuccessMagic` still accepts. This is the
    ///      case the fix must NOT break; `test_ERC1271_KeyExecutes` is the ECDSA-in-1271
    ///      version of the same guarantee.
    function test_ERC1271_StandardLeftAlignedMagic_StillAccepted() public {
        SessionKeyManager.ActionRequest memory req = _request();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CONTROLLER_KEY, _digest(req));
        bytes memory inner = abi.encodePacked(r, s, v);

        // MockERC1271 declares `bytes4`, so a success is the canonical form: the magic
        // occupying the HIGH 4 bytes of the word with zero padding in the low 28.
        (bool ok, bytes memory ret) = address(key1271).staticcall(
            abi.encodeWithSelector(0x1626ba7e, _digest(req), inner)
        );
        assertTrue(ok && ret.length == 32, "standard 1271 must answer with one 32-byte word");
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes4(ret), bytes4(0x1626ba7e), "the success magic occupies the high 4 bytes");
        // ...and the low 28 bytes are ZERO, so the whole word equals the magic.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(uint256(bytes32(ret)), uint256(0x1626ba7e) << 224, "canonical word carries no extra payload");

        (bool execOk,) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector,
                req,
                _pack(address(key1271), CONTROLLER_KEY, req),
                new bytes32[](0),
                bytes("")
            )
        );
        assertTrue(execOk, "the canonical form must remain accepted");
    }

    /// @dev A non-standard validator returning a BARE 4-byte magic is still accepted.
    ///      Safe because a 4-byte return has no payload to hide the magic's position
    ///      behind — the SEC-11 shape is inherently 32 bytes.
    function test_ERC1271_BareBytes4Return_StillAccepted() public {
        MockBareBytes41271 key = new MockBareBytes41271();
        _grantTo(address(key));
        assertTrue(
            _tryExecuteAs(address(key)),
            "a bare 4-byte magic return is unambiguous and must remain accepted"
        );
    }

    /// @dev The native-wallet overload magic (0x20c13b0b) in canonical alignment must
    ///      keep working: the fix narrows the *alignment* rule, not the accepted set.
    function test_ERC1271_NativeWalletMagic_StillAccepted() public {
        MockNativeWallet1271 key = new MockNativeWallet1271();
        _grantTo(address(key));
        assertTrue(
            _tryExecuteAs(address(key)), "the 0x20c13b0b overload magic must remain accepted"
        );
    }

    /// @dev Empty return data must not be treated as success (a contract that returns
    ///      nothing is a `false` answer, not a missing one).
    function test_ERC1271_EmptyReturn_IsRejected() public {
        MockEmpty1271 key = new MockEmpty1271();
        _grantTo(address(key));
        assertFalse(_tryExecuteAs(address(key)), "empty 1271 return data must be rejected");
    }
}

/// @dev A validator that answers `isValidSignature` with no data at all.
contract MockEmpty1271 {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        assembly ("memory-safe") {
            mstore(0x00, 0)
            return(0x00, 0)
        }
    }
}
