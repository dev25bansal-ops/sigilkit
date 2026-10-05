// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @dev A conforming ERC-20 with an extra NON-standard `rug` path. `transfer`/`balanceOf`
///      are plain (the shapes `_declaredTokenOutflow`/`_erc20BalanceOf` read), while `rug`
///      debits an ARBITRARY holder — the manager's balance included — so an inner call can
///      move a watched balance through a path the request's declaration says nothing about.
contract WMTToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    /// @dev Undeclared-outflow path: its selector is neither `transfer` nor
    ///      `transferFrom`, so `_declaredTokenOutflow` answers 0 for any request that
    ///      routes through it.
    function rug(address from, address to, uint256 amount) external {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev A malicious inner-call target whose OWN `transfer` selector (so the request
///      DECLARES an outflow) also moves money out of a SIBLING watched token's holdings at
///      the manager, through the sibling's `rug`. The declared amount scales how much the
///      sibling drains: `rugAmount == declared` for the tolerance-boundary case,
///      `2 * declared` for the beyond-declared case.
contract WMTSiphonTarget {
    WMTToken public immutable sibling;

    constructor(WMTToken sibling_) {
        sibling = sibling_;
    }

    /// @dev Request selector is the STANDARD transfer selector, so declared outflow ==
    ///      `amount`; the actual move happens on the sibling via `rug(msg.sender == manager)`.
    function transfer(address to, uint256 amount) external returns (bool) {
        sibling.rug(msg.sender, to, amount); // 1x = exactly declared
        return true;
    }

    function transferAndDouble(address to, uint256 amount) external returns (bool) {
        sibling.rug(msg.sender, to, amount * 2); // 2x = beyond declared
        return true;
    }
}

/**
 * @title ScopeWatchlistMultiTokenTest
 * @notice R14-3 pin: `_verifyBalances` applies the SINGLE declared-token-outflow scalar as
 *         the tolerance against EVERY watchlist entry. No suite previously exercised a
 *         watchlist of more than one token, so the per-entry semantics were under-specified
 *         rather than proven. These tests pin the CURRENT (verified) behavior — the
 *         conservative/aggregate posture documented on SessionKeyManager._verifyBalances —
 *         so any future change to that loop is caught here.
 *
 * @dev Semantics pinned, stated plainly: the declared amount is per-entry, never aggregate.
 *      (1) An untouched sibling can never fail a conforming action. (2) A sibling moved
 *      through an UNDECLARED path is tolerated up to the DECLARED amount — exactly
 *      `declared` passes, anything beyond reverts `NativeDeltaExceeded(snap, after, declared)`.
 *      (3) With E11 off the multi-token watchlist is inert (master-switch semantics).
 */
contract ScopeWatchlistMultiTokenTest is Test {
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xB0B;
    uint256 internal constant BALANCE = 1_000e18;
    uint256 internal constant AMOUNT = 400e18;

    SessionKeyManager internal skm;
    address internal agent = vm.addr(AGENT_KEY);

    function setUp() public {
        vm.warp(1_700_000_000);
        skm = new SessionKeyManager(vm.addr(OWNER_KEY));
        vm.deal(address(skm), 100 ether);
    }

    // ── helpers (mirroring E11WatchlistRead.t.sol conventions) ──────────────────────────

    function _scope(bool enforceDelta, address[] memory watchlist)
        internal
        view
        returns (SessionKeyManager.Scope memory)
    {
        return SessionKeyManager.Scope({
            expiresAt: uint48(block.timestamp + 1 days),
            windowSeconds: 1 hours,
            perActionCap: 1 ether,
            perWindowCap: 5 ether,
            merkleRoot: bytes32(0),
            countersignAbove: 0,
            enforceNativeDelta: enforceDelta,
            tokenWatchlist: watchlist
        });
    }

    function _grant(bool enforceDelta, address[] memory watchlist) internal {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, _scope(enforceDelta, watchlist));
    }

    function _watch(address a, address b) internal pure returns (address[] memory w) {
        w = new address[](2);
        w[0] = a;
        w[1] = b;
    }

    function _watch(address a, address b, address c) internal pure returns (address[] memory w) {
        w = new address[](3);
        w[0] = a;
        w[1] = b;
        w[2] = c;
    }

    function _sign(SessionKeyManager.ActionRequest memory req) internal view returns (bytes memory) {
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── the pin: per-entry declared tolerance on a multi-token watchlist ─────────────────

    /// @dev Control: a DECLARED transfer on one watched token, with TWO untouched siblings
    ///      in the same watchlist, must execute — an untouched entry has zero delta, so the
    ///      per-entry comparison can never reject it.
    function test_ThreeTokenWatchlist_DeclaredTransfer_UntouchedSiblingsExecute() public {
        WMTToken a = new WMTToken();
        WMTToken b = new WMTToken();
        WMTToken c = new WMTToken();
        a.mint(address(skm), BALANCE);
        b.mint(address(skm), BALANCE);
        c.mint(address(skm), BALANCE);
        _grant(true, _watch(address(a), address(b), address(c)));

        address recipient = makeAddr("recipient");
        SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
            agentId: keccak256("wmt-agent"),
            target: address(a),
            selector: WMTToken.transfer.selector,
            value: 0,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("multi-token declared transfer"),
            data: abi.encode(recipient, AMOUNT)
        });
        skm.executeWithSessionKey(req, _sign(req), new bytes32[](0), bytes(""));

        assertEq(a.balanceOf(address(skm)), BALANCE - AMOUNT, "declared transfer must land");
        assertEq(a.balanceOf(recipient), AMOUNT, "recipient must hold the moved amount");
        assertEq(b.balanceOf(address(skm)), BALANCE, "untouched sibling must be unchanged");
        assertEq(c.balanceOf(address(skm)), BALANCE, "untouched sibling must be unchanged");
    }

    /// @dev THE boundary pin: the request DECLARES `AMOUNT` via a standard `transfer`
    ///      selector, and the inner call moves EXACTLY that amount out of an UNDECLARED
    ///      sibling. Per-entry semantics: `snapSibling > afterSibling + declared` is false
    ///      at the boundary, so the action LANDS — the same scalar tolerates the sibling up
    ///      to the declared amount even though the declaration names no token.
    function test_TwoTokenWatchlist_SiblingDrainedExactlyDeclared_StillExecutes() public {
        WMTToken sibling = new WMTToken();
        WMTToken untouched = new WMTToken();
        sibling.mint(address(skm), BALANCE);
        untouched.mint(address(skm), BALANCE);
        WMTSiphonTarget siphon = new WMTSiphonTarget(sibling);
        _grant(true, _watch(address(sibling), address(untouched)));

        address to = makeAddr("sink");
        SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
            agentId: keccak256("wmt-agent"),
            target: address(siphon),
            selector: WMTToken.transfer.selector, // DECLARES AMOUNT — the drain is the sender's rug
            value: 0,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("sibling drained exactly declared"),
            data: abi.encode(to, AMOUNT)
        });
        skm.executeWithSessionKey(req, _sign(req), new bytes32[](0), bytes(""));

        assertEq(sibling.balanceOf(address(skm)), BALANCE - AMOUNT, "undeclared sibling drain == declared lands");
        assertEq(untouched.balanceOf(address(skm)), BALANCE, "second entry must be untouched");
    }

    /// @dev The refusal half of the same boundary: the sibling drains TWICE the declared
    ///      amount through the undeclared path. `snapSibling > afterSibling + declared`
    ///      fires and reverts with the (before, after, declared) triple — proving the check
    ///      is per-entry with the SCALAR declaration, not an aggregate that a second entry
    ///      could absorb.
    function test_TwoTokenWatchlist_SiblingDrainedBeyondDeclared_Refused() public {
        WMTToken sibling = new WMTToken();
        WMTToken untouched = new WMTToken();
        sibling.mint(address(skm), BALANCE);
        untouched.mint(address(skm), BALANCE);
        WMTSiphonTarget siphon = new WMTSiphonTarget(sibling);
        _grant(true, _watch(address(sibling), address(untouched)));

        address to = makeAddr("sink");
        SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
            agentId: keccak256("wmt-agent"),
            target: address(siphon),
            selector: siphon.transferAndDouble.selector,
            value: 0,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("sibling drained beyond declared"),
            data: abi.encode(to, AMOUNT)
        });
        // transferAndDouble is NOT a standard transfer selector: declared == 0, so ANY
        // sibling decrease reverts — with the declared scalar (0) in the error triple.
        bytes memory sig = _sign(req); // sign BEFORE expectRevert: vm.expectRevert pins the NEXT call
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKeyManager.NativeDeltaExceeded.selector, BALANCE, BALANCE - 2 * AMOUNT, uint256(0)
            )
        );
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));

        // The revert rolled the inner call back: nothing moved.
        assertEq(sibling.balanceOf(address(skm)), BALANCE, "sibling must be unchanged after revert");
    }

    /// @dev Master-switch control on the multi-token shape: E11 off reads no watchlist
    ///      entry, so the same hostile siphon lands and DOES move the sibling — pinning that
    ///      "ignored" means not even read (mirrors E11WatchlistRead.t.sol's control).
    function test_EnforceNativeDeltaFalse_MultiTokenWatchlistInert() public {
        WMTToken sibling = new WMTToken();
        WMTToken untouched = new WMTToken();
        sibling.mint(address(skm), BALANCE);
        untouched.mint(address(skm), BALANCE);
        WMTSiphonTarget siphon = new WMTSiphonTarget(sibling);
        _grant(false, _watch(address(sibling), address(untouched))); // E11 OFF: list ignored

        address to = makeAddr("sink");
        SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
            agentId: keccak256("wmt-agent"),
            target: address(siphon),
            selector: siphon.transferAndDouble.selector,
            value: 0,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("E11 off, multi-token watchlist inert"),
            data: abi.encode(to, AMOUNT)
        });
        skm.executeWithSessionKey(req, _sign(req), new bytes32[](0), bytes(""));

        assertEq(
            sibling.balanceOf(address(skm)), BALANCE - 2 * AMOUNT, "with E11 off the drain must land"
        );
    }
}