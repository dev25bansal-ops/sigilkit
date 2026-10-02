// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @dev A CONFORMING ERC-20 for the control cases: `balanceOf` is a plain mapping read
///      returning one 32-byte word — the shape `_erc20BalanceOf` requires.
contract E11StandardToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    /// @dev A rug-style pull: debits an ARBITRARY holder. Its selector is neither
    ///      `transfer` nor `transferFrom`, so `_declaredTokenOutflow` answers 0 for it and
    ///      the outflow is UNDECLARED by construction — which is what makes it the action a
    ///      watched balance must refuse. A malicious or upgradeable token really can move
    ///      the manager's balance out from under it, so the delta check has to be able to
    ///      see it.
    function rug(address from, address to, uint256 amount) external {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev A token whose `balanceOf` REVERTS. This is the shape a paused / upgradeable /
///      hostile token takes: it holds real balances, but the read the watchlist depends on
///      is no longer answerable. Before the fix this read as 0 on BOTH sides of the delta
///      check, which silently disabled that token's entire E11 protection.
contract E11RevertingToken {
    mapping(address => uint256) internal _balances;
    bool internal _paused;

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
    }

    /// @dev The literal "pausable token" shape, which is the most likely way a real
    ///      watchlist entry goes blind: the read depends on storage (hence `view`), and
    ///      while paused it is not answerable at all. Crucially the token can STILL move
    ///      funds while paused — a watchlist that goes blind while the token remains fully
    ///      capable of draining is precisely the dangerous case, and it is why reading an
    ///      unreadable balance as 0 must not be tolerated.
    function balanceOf(address holder) external view returns (uint256) {
        require(!_paused, "E11RevertingToken: paused");
        return _balances[holder];
    }

    function pause() external {
        _paused = true;
    }

    /// @dev Still fully functional — a drain does not care that `balanceOf` is unavailable.
    function rug(address from, address to, uint256 amount) external {
        _balances[from] -= amount;
        _balances[to] += amount;
    }
}

/// @dev A token whose `balanceOf` SUCCEEDS but answers with 4 bytes instead of a full ABI
///      word. This is the only way to reach the `ret.length < 32` half of the fail-open
///      condition with `ok == true`: a Solidity `uint64`/`uint256` return would be
///      ABI-padded to 32 bytes and pass the length guard, so a raw `return` is required.
contract E11ShortReturnToken {
    function balanceOf(address) external pure returns (uint256) {
        assembly {
            mstore(0, 7)
            return(0, 4)
        }
    }
}

/// @dev A drain target. `siphon` asks the token to move the MANAGER's balance out from
///      under it via the token's `rug` function. Because `rug` is neither `transfer` nor
///      `transferFrom`, `_declaredTokenOutflow` answers 0 and the outflow is UNDECLARED —
///      so a watched token may not net-decrease at all across a `siphon`. That is exactly
///      the action the E11 delta check exists to refuse, and the action whose silence WAS
///      the fail-open vulnerability.
contract E11DrainTarget {
    /// @dev The drain rides the token's own `rug(address,address,uint256)`, derived from the
    ///      fixture so it can never drift out of sync with it. `rug` is deliberately neither
    ///      `transfer` nor `transferFrom`, so `_declaredTokenOutflow` answers 0 and the
    ///      outflow is undeclared by construction.
    function siphon(address token, address from, address to, uint256 amount) external {
        (bool ok,) = token.call(abi.encodeWithSelector(E11StandardToken.rug.selector, from, to, amount));
        require(ok, "E11DrainTarget: rug failed");
    }
}

/// @dev A payable target, for pinning the NATIVE half of the E11 delta check. `deposit`
///      accepts value and keeps it, so the manager's balance drops by exactly the declared
///      `value` — the case the native branch must ALLOW.
contract E11PayableTarget {
    receive() external payable {}

    function deposit() external payable {}
}

/**
 * @title E11WatchlistReadTest
 * @notice E11-S1 regression: `_erc20BalanceOf` must be FAIL-CLOSED.
 *
 * @dev The bug this pins. `SessionKeyManager._erc20BalanceOf` used to answer `return 0`
 *      whenever the `balanceOf` staticcall failed or returned less than a full ABI word:
 *
 *        if (!ok || ret.length < 32) return 0;
 *
 *      The pre-call snapshot and the post-call read then both saw 0, so the E11 delta
 *      assertion `snap[i] > afterBal + declaredTokens` collapsed to `0 > 0 + declared`,
 *      which is always false. The token's ENTIRE E11 protection was therefore silently
 *      disabled while the owner still believed the grant was enforcing it — and it was
 *      remotely TRIGGERABLE, because a watchlist entry is an arbitrary token contract whose
 *      `balanceOf` can start reverting at any time via an upgrade or a pause.
 *
 *      Reading as 0 also DEFEATS the check rather than merely skipping it: a non-zero
 *      "before" is what makes the comparison fire at all.
 *
 *      It also contradicted the native-coin half of the same guarantee, which was already
 *      fail-closed (`NativeDeltaExceeded`) — two halves of one "the inner call must not
 *      siphon value" invariant failing in OPPOSITE directions.
 *
 *      The fix reverts with `UnreadableWatchToken(token)` from inside the shared helper, so
 *      both `_snapshotBalances` (pre) and `_verifyBalances` (post) are covered and no future
 *      caller can reintroduce fail-open.
 *
 *      Coverage shape. Every hostile-token case pairs the hostile entry with a CONFORMING
 *      sibling in the SAME watchlist, which is what gives each case its teeth: the old code
 *      reverted nothing, it merely read 0, so a LONE hostile token would let the drain land
 *      and produce no failure at all. Paired, the drain would land under the old code and
 *      the balance would go unnoticed; now the execution is refused up front.
 */
contract E11WatchlistReadTest is Test {
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xB0B;
    uint256 internal constant BALANCE = 1_000e18;
    uint256 internal constant NATIVE = 0.5 ether;

    SessionKeyManager internal skm;
    address internal agent = vm.addr(AGENT_KEY);
    E11DrainTarget internal target;

    function setUp() public {
        vm.warp(1_700_000_000);
        skm = new SessionKeyManager(vm.addr(OWNER_KEY));
        target = new E11DrainTarget();
        vm.deal(address(skm), 100 ether);
    }

    // ── helpers ──────────────────────────────────────────────────────────────────

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

    /// @dev Asks the drain target to move `BALANCE` of `token` out of the MANAGER (the only
    ///      account that actually holds it) and into the target. The move rides the token's
    ///      `rug` selector, so the outflow is undeclared by construction.
    function _siphonRequest(address token) internal view returns (SessionKeyManager.ActionRequest memory) {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("e11-agent"),
            target: address(target),
            selector: target.siphon.selector,
            value: 0,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("e11 watchlist read"),
            data: abi.encode(token, address(skm), address(target), BALANCE)
        });
    }

    /// @dev Moves `token` through its OWN `transfer` selector, so the outflow IS declared
    ///      and a conforming watchlist must let it through.
    function _declaredTransferRequest(address token)
        internal
        view
        returns (SessionKeyManager.ActionRequest memory)
    {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("e11-agent"),
            target: token,
            selector: E11StandardToken.transfer.selector,
            value: 0,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("e11 declared transfer"),
            data: abi.encode(address(target), BALANCE)
        });
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

    function _grant(bool enforceDelta, address[] memory watchlist) internal {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, _scope(enforceDelta, watchlist));
    }

    function _watch(address a) internal pure returns (address[] memory w) {
        w = new address[](1);
        w[0] = a;
    }

    function _watch(address a, address b) internal pure returns (address[] memory w) {
        w = new address[](2);
        w[0] = a;
        w[1] = b;
    }

    // ── the regression: an unreadable watched balance must REFUSE the execution ──

    /// @dev The core case. A reverting token beside a conforming one. Under the old
    ///      behaviour the reverting token read 0 on both sides, the drain landed, and the
    ///      balance went unnoticed; now the execution is refused while taking the PRE-call
    ///      snapshot — before the inner call is made at all.
    function test_UnreadableWatchToken_RevertingBalanceOf_RefusesExecution() public {
        E11StandardToken ok1 = new E11StandardToken();
        E11RevertingToken hostile = new E11RevertingToken();
        ok1.mint(address(skm), BALANCE);
        hostile.mint(address(skm), BALANCE);
        hostile.pause();
        _grant(true, _watch(address(ok1), address(hostile)));

        SessionKeyManager.ActionRequest memory req = _siphonRequest(address(ok1));
        bytes memory sig = _sign(req);

        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyManager.UnreadableWatchToken.selector, address(hostile))
        );
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));

        // The inner call was never made, so nothing moved.
        assertEq(ok1.balanceOf(address(skm)), BALANCE, "conforming token must be untouched");
    }

    /// @dev The other half of the fail-open condition: the call SUCCEEDS (`ok == true`)
    ///      but answers with 4 bytes, so only the length guard can catch it.
    function test_UnreadableWatchToken_ShortReturn_RefusesExecution() public {
        E11StandardToken ok1 = new E11StandardToken();
        E11ShortReturnToken hostile = new E11ShortReturnToken();
        ok1.mint(address(skm), BALANCE);
        _grant(true, _watch(address(ok1), address(hostile)));

        SessionKeyManager.ActionRequest memory req = _siphonRequest(address(ok1));
        bytes memory sig = _sign(req);

        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyManager.UnreadableWatchToken.selector, address(hostile))
        );
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
    }

    /// @dev An address with no code answers `balanceOf` with a 0-byte return, reaching the
    ///      same `ret.length < 32` branch with no contract behind it at all. The reported
    ///      token is the FIRST unreadable entry, because the snapshot walks the watchlist in
    ///      order and fails before reaching any later one.
    function test_UnreadableWatchToken_NoCodeAddress_RefusesExecution() public {
        E11StandardToken ok1 = new E11StandardToken();
        ok1.mint(address(skm), BALANCE);
        address empty = address(0xDEAD); // never constructed: no code
        _grant(true, _watch(address(ok1), empty));

        SessionKeyManager.ActionRequest memory req = _siphonRequest(address(ok1));
        bytes memory sig = _sign(req);

        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyManager.UnreadableWatchToken.selector, empty)
        );
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
    }

    /// @dev The case that IS the vulnerability: a LONE unreadable entry. This is the one
    ///      that matters most, and the reason the paired cases above exist only as support.
    ///
    ///      With one unreadable token and nothing else watched, the old code read 0 before
    ///      and 0 after, so `0 > 0 + 0` was false and the drain LANDED — silently, with no
    ///      revert and no event. Under the fix the read is refused outright.
    function test_LoneUnreadableWatchToken_RefusesExecution() public {
        E11RevertingToken hostile = new E11RevertingToken();
        hostile.mint(address(skm), BALANCE);
        hostile.pause(); // the read goes blind; the token can still drain
        _grant(true, _watch(address(hostile)));

        SessionKeyManager.ActionRequest memory req = _siphonRequest(address(hostile));
        bytes memory sig = _sign(req);

        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyManager.UnreadableWatchToken.selector, address(hostile))
        );
        skm.executeWithSessionKey(req, sig, new bytes32[](0), "");
    }

    // ── controls: the fix must not break the working paths ──

    /// @dev A fully CONFORMING watchlist with a DECLARED outflow must still execute.
    ///      Without this control, a contract that simply refused everything would also
    ///      satisfy every test above.
    function test_ConformingWatchlist_DeclaredOutflow_StillExecutes() public {
        E11StandardToken good = new E11StandardToken();
        good.mint(address(skm), BALANCE);
        _grant(true, _watch(address(good)));

        SessionKeyManager.ActionRequest memory req = _declaredTransferRequest(address(good));
        bytes memory sig = _sign(req);

        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));

        assertEq(good.balanceOf(address(skm)), 0, "declared transfer must have landed");
        assertEq(good.balanceOf(address(target)), BALANCE, "tokens must sit with the target");
    }

    /// @dev The E11 protection actually FIRING on a readable token: the drain moves value
    ///      through a non-transfer selector, so the outflow is undeclared and must be
    ///      refused with `NativeDeltaExceeded`. This is the exact check whose silence was the
    ///      vulnerability — here it is proven to still speak.
    function test_ConformingWatchlist_UndeclaredOutflow_StillRefused() public {
        E11StandardToken good = new E11StandardToken();
        good.mint(address(skm), BALANCE);
        _grant(true, _watch(address(good)));

        SessionKeyManager.ActionRequest memory req = _siphonRequest(address(good));
        bytes memory sig = _sign(req);

        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKeyManager.NativeDeltaExceeded.selector, BALANCE, uint256(0), uint256(0)
            )
        );
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
    }

    /// @dev `enforceNativeDelta == false` must remain completely UNAFFECTED: E11 is off, so
    ///      the watchlist is never read and a hostile entry in it changes nothing. This is
    ///      what keeps the fix from turning E11-off grants into a new denial of service.
    function test_EnforceNativeDeltaFalse_UnaffectedByHostileWatchlist() public {
        E11StandardToken good = new E11StandardToken();
        E11RevertingToken hostile = new E11RevertingToken();
        good.mint(address(skm), BALANCE);
        _grant(false, _watch(address(good), address(hostile)));

        SessionKeyManager.ActionRequest memory req = _siphonRequest(address(good));
        bytes memory sig = _sign(req);

        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
        assertEq(good.balanceOf(address(skm)), 0, "drain must have landed (E11 off)");
    }

    /// @dev An EMPTY watchlist with E11 on reads nothing, so there is no entry that could be
    ///      unreadable and nothing to refuse. Pins that the fix adds no cost or failure mode
    ///      to the most common grant shape.
    function test_EmptyWatchlist_Unaffected() public {
        E11StandardToken good = new E11StandardToken();
        good.mint(address(skm), BALANCE);
        _grant(true, new address[](0));

        SessionKeyManager.ActionRequest memory req = _declaredTransferRequest(address(good));
        bytes memory sig = _sign(req);

        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));
        assertEq(good.balanceOf(address(skm)), 0, "declared transfer must have landed");
    }

    /// @dev The native-coin half of the same guarantee was ALREADY fail-closed and must stay
    ///      that way. This now genuinely exercises the native branch of `_verifyBalances`
    ///      (the `address(this).balance < snap.nativeBefore - declaredNative` comparison),
    ///      with E11 on and an EMPTY watchlist so nothing else is in play — which is what
    ///      makes it a real control on the coin path rather than a second token test.
    ///
    ///      Note on direction: this pins that a correctly-DECLARED native outflow is
    ///      allowed. The opposite direction (a target draining MORE than the declared
    ///      `value`) is not reachable in this contract by construction — the manager's only
    ///      ETH-sending paths are `withdraw` (onlyOwner) and `executeWithSessionKey`
    ///      (nonReentrant, so a re-entrant call is refused), and a target can only ever
    ///      increase the manager's balance. So the native check's refusal branch has no
    ///      reachable trigger here, and claiming otherwise would overstate the test.
    function test_NativeDeclaredOutflow_StillAllowedWithEmptyWatchlist() public {
        E11PayableTarget sink = new E11PayableTarget();
        _grant(true, new address[](0));
        vm.deal(address(skm), 100 ether);

        SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
            agentId: keccak256("e11-agent"),
            target: address(sink),
            selector: E11PayableTarget.deposit.selector,
            value: NATIVE,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("native declared outflow"),
            data: ""
        });
        bytes memory sig = _sign(req);

        uint256 before = address(skm).balance;
        skm.executeWithSessionKey(req, sig, new bytes32[](0), bytes(""));

        // Exactly `value` left the manager: the native delta check compared
        // `before - declaredNative` and it held, so execution was allowed through.
        assertEq(before - address(skm).balance, NATIVE, "exactly the declared value must have moved");
        assertEq(address(sink).balance, NATIVE, "the payable target must have received it");
    }
}
