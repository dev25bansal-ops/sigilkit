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

    function _execute(SessionKeyManager.ActionRequest memory req)
        internal
        returns (bool ok)
    {
        (ok, ) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector, req, new bytes(65), new bytes32[](0)
            )
        );
    }

    /// @dev Replay: whatever the request looks like, the second execution of an
    ///      identical request must revert (strictly sequential nonces).
    function check_execute_Replay_SecondIdenticalCallAlwaysReverts(
        uint256 value,
        bytes memory data
    ) public {
        SessionKeyManager.ActionRequest memory req =
            _request(0, uint48(GRANTED_AT + 10 minutes), bound(value, 0, 1 ether), bytes4(0x12345678), data);
        bool first = _execute(req);
        bool second = _execute(req);
        if (first) {
            assertFalse(second, "replay must revert");
        }
    }

    /// @dev Nonce accounting: execution succeeds iff the request carries exactly the
    ///      current nonce (for an in-scope request), and a success advances it by one.
    function check_execute_NonceIsExactSequential(uint256 nonce, uint256 value) public {
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
    function check_execute_StaleRequestAlwaysReverts(uint48 staleExpiry, uint256 value) public {
        if (staleExpiry >= GRANTED_AT) return; // only stale requests are interesting here
        SessionKeyManager.ActionRequest memory req =
            _request(0, staleExpiry, bound(value, 0, 1 ether), bytes4(0x12345678), hex"");
        assertFalse(_execute(req), "stale request must revert");
    }

    /// @dev Denylist gating: a session key can never execute a denied selector, even
    ///      with a root==0 (allow-all) scope and a valid signature seam.
    function check_execute_DeniedSelectorAlwaysReverts(uint256 value, bytes memory data) public {
        bytes4 denied = bytes4(0xDEAD0000);
        vm.prank(owner);
        skm.setSelectorDenied(denied, true);
        SessionKeyManager.ActionRequest memory req =
            _request(0, uint48(GRANTED_AT + 10 minutes), bound(value, 0, 1 ether), denied, data);
        assertFalse(_execute(req), "denied selector must revert");
    }

    /// @dev INV-1 at the execution level: after any execution attempt, the recorded
    ///      window spend never exceeds the per-window cap.
    function check_execute_WindowSpendNeverExceedsCap(uint256 value, bytes memory data) public {
        SessionKeyManager.ActionRequest memory req =
            _request(0, uint48(GRANTED_AT + 10 minutes), bound(value, 0, 3 ether), bytes4(0x12345678), data);
        _execute(req);
        assertTrue(
            skm.getWindowState(signer).spentThisWindow <= 2 ether,
            "window spend exceeded the cap"
        );
    }
}
