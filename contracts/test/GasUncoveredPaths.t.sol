// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";
import {SessionKey7579Module, PackedUserOperation} from "../src/SessionKey7579Module.sol";
import {ActionLog7579Executor} from "../src/ActionLog7579Executor.sol";
import {SigilKitDelegator} from "../src/SigilKitDelegator.sol";

/// @dev Minimal target: costs almost nothing so the measurement reflects the POLICY path.
contract GasProbeTarget {
    uint256 public count;

    function poke(uint256 by) external payable returns (uint256) {
        count += by;
        return count;
    }
}

/// @dev Standard ERC-20 for the E11 watchlist measurement.
contract GasProbeToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

/// @dev Minimal ERC-7579 account: forwards module calls so `msg.sender` is the account,
///      which is what the module's `msg.sender == userOp.sender` gate requires.
contract GasProbe7579Account {
    SessionKey7579Module internal module;

    constructor(SessionKey7579Module module_) {
        module = module_;
    }

    function install(bytes memory data) external {
        module.onInstall(data);
    }

    function uninstall() external {
        module.onUninstall("");
    }

    function grant(address key, SessionKey7579Module.Scope memory scope) external {
        module.grantSessionKey(key, scope);
    }

    function revoke(address key) external {
        module.revokeSessionKey(key);
    }

    function denySelector(bytes4 selector, bool denied) external {
        module.setSelectorDenied(selector, denied);
    }

    function validate(PackedUserOperation memory op, bytes32 hash) external returns (uint256) {
        return module.validateUserOp(op, hash);
    }
}

/// @dev Minimal ERC-7579 EXECUTOR account: the account itself is `msg.sender`, which is
///      the trust boundary `execute` enforces.
contract GasProbeExecutorAccount {
    ActionLog7579Executor internal executor;

    constructor(ActionLog7579Executor executor_) {
        executor = executor_;
    }

    function install(bytes memory data) external {
        executor.onInstall(data);
    }

    function uninstall() external {
        executor.onUninstall("");
    }

    function setAgentId(bytes32 boundAgentId) external {
        executor.setAgentId(boundAgentId);
    }

    function exec(address target, uint256 value, bytes calldata callData)
        external
        payable
        returns (bytes memory)
    {
        return executor.execute{value: value}(address(this), target, value, callData);
    }
}

/**
 * Gas measurements for the paths NO existing budget suite covers.
 *
 * Why this file exists: `GasBudget.t.sol` prices the `executeWithSessionKey` variants
 * and `Gas7579Scaling.t.sol` prices the ERC-7579 batch CURVE. Between them they cover the
 * two hottest paths in the codebase — and nothing else. Every administrative entry point
 * (grant / revoke / rotate / withdraw / transferOwnership / setSelectorDenied), every
 * install-uninstall hook, the entire `ActionLog7579Executor` surface, the 7579 SINGLE-call
 * validation, and the delegator initializer are all unpriced. A regression in any of them
 * is invisible to CI.
 *
 * This file is MEASUREMENT ONLY. It asserts nothing about cost — it prints numbers, so
 * the gaps can be priced deliberately rather than by copying a sibling path's budget
 * (the mistake `GasBudget.t.sol`'s own policy section warns about). Turning any of these
 * numbers into a ceiling is a separate, deliberate act.
 *
 * Two disciplines inherited from the existing suites:
 *   - `before - gasleft()` wraps ONLY the call under judgement; fixture construction
 *     (deployments, tree building, signing) stays outside the window;
 *   - every measurement that depends on storage WARMTH uses a FRESH contract, because
 *     `forge snapshot` and a warm second call measure different things and only the
 *     first number is comparable to the published budgets.
 *
 * The one deliberate exception is the explicit WARM-PATH series at the bottom, whose
 * entire point is that a reused slot costs less than a fresh one.
 */
contract GasUncoveredPathsTest is Test {
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xB0B;
    address internal agent = vm.addr(AGENT_KEY);
    address internal ownerAddr = vm.addr(OWNER_KEY);

    uint48 internal constant EXPIRES_AT = 1_900_000_000;

    /// @dev MIRRORS `SessionKeyManager.MAX_SINGLE_PROOF_ELEMENTS`. That constant is
    ///      `private`, so a test cannot read it off the contract and the value has to be
    ///      duplicated here — keep this copy at 8 and change it only together with the
    ///      contract's. The two contracts already share the value deliberately (the 7579
    ///      module REVERTS past it, the manager returns "not allowed").
    uint256 internal constant MAX_SINGLE_PROOF_ELEMENTS = 8;

    /// @dev Absolute ceiling for the AT-BOUND (depth-8) proof walk, measured at
    ///      ~65.4k. The bound itself is what makes an oversized proof cheap, so without
    ///      an independent ceiling on the in-bound path a regression that made depth 8
    ///      itself expensive would still be invisible. Roughly 1.8x the measured number.
    uint256 internal constant BOUND_PROOF_WALK_GAS_CEILING = 120_000;

    SessionKeyManager internal skm;
    GasProbeTarget internal target;

    constructor() {
        vm.warp(1_700_000_000);
    }

    function setUp() public {
        skm = new SessionKeyManager(ownerAddr);
        target = new GasProbeTarget();
        vm.deal(address(skm), 100 ether);
    }

    // ── helpers ─────────────────────────────────────────────────────────────────

    function _scope() internal pure returns (SessionKeyManager.Scope memory) {
        return SessionKeyManager.Scope({
            expiresAt: EXPIRES_AT,
            windowSeconds: 1 hours,
            perActionCap: 1 ether,
            perWindowCap: 100 ether,
            merkleRoot: bytes32(0),
            countersignAbove: 0,
            enforceNativeDelta: false,
            tokenWatchlist: new address[](0)
        });
    }

    function _request(uint256 value, bytes memory data, uint256 nonce)
        internal
        view
        returns (SessionKeyManager.ActionRequest memory)
    {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("gas-probe"),
            target: address(target),
            selector: target.poke.selector,
            value: value,
            nonce: nonce,
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("uncovered-path measurement"),
            data: data
        });
    }

    /// @dev Signs `req` for an ARBITRARY manager instance. `_sign` is bound to the
    ///      shared `skm` field and would compute the wrong EIP-712 domain for the
    ///      throwaway managers `test_GasUncovered_E11CostDecomposition` measures on,
    ///      because the domain separator commits `address(this)`.
    function _signFor(SessionKeyManager m, uint256 pk, SessionKeyManager.ActionRequest memory req)
        internal
        view
        returns (bytes memory)
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", m.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sign(uint256 pk, SessionKeyManager.ActionRequest memory req)
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SessionKeyManager — administrative surface (no budget anywhere)
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Deploy cost. The constructor writes `owner` and seeds SIX denylist entries,
    ///      so it pays 7 cold SSTOREs (7 x ~22.1k) plus deployment itself. Nobody budgets
    ///      a constructor, but for the EIP-7702 delegator the equivalent work happens in
    ///      `initializeSelfOwned` inside the EOA's context, so the number is not academic.
    function test_GasUncovered_ManagerConstructor() public {
        uint256 before = gasleft();
        new SessionKeyManager(ownerAddr);
        uint256 used = before - gasleft();
        emit log_named_uint("GAP manager: constructor (owner + 6 denylist SSTOREs)", used);
    }

    /// @dev First grant to a key that holds no state: every scope slot is a cold SSTORE
    ///      from zero, plus the `revoked[key] = false` write. This is the MOST expensive
    ///      grant shape and the one an operator actually pays on day one.
    function test_GasUncovered_GrantSessionKey_FirstGrant() public {
        uint256 before = gasleft();
        vm.prank(ownerAddr);
        skm.grantSessionKey(agent, _scope());
        uint256 used = before - gasleft();
        emit log_named_uint("GAP manager: grantSessionKey (first, cold)", used);
    }

    /// @dev Re-granting the SAME key over an identical scope. Every slot is already
    ///      non-zero, so this is the warm/reset price — and it is what a scope refresh or
    ///      a rotation-overlap extension costs. The gap versus the first grant is the
    ///      whole 20k-vs-2.9k SSTORE spread.
    function test_GasUncovered_GrantSessionKey_ReGrant() public {
        vm.prank(ownerAddr);
        skm.grantSessionKey(agent, _scope());

        uint256 before = gasleft();
        vm.prank(ownerAddr);
        skm.grantSessionKey(agent, _scope());
        uint256 used = before - gasleft();
        emit log_named_uint("GAP manager: grantSessionKey (re-grant, warm)", used);
    }

    /// @dev Revoke: one cold SLOAD of the scope (the `expiresAt == 0` existence probe)
    ///      and one cold SSTORE 0 -> true. The scope is deliberately retained.
    function test_GasUncovered_RevokeSessionKey() public {
        vm.prank(ownerAddr);
        skm.grantSessionKey(agent, _scope());

        uint256 before = gasleft();
        vm.prank(ownerAddr);
        skm.revokeSessionKey(agent);
        uint256 used = before - gasleft();
        emit log_named_uint("GAP manager: revokeSessionKey", used);
    }

    /// @dev Rotation: a full grant for `newKey` PLUS the old key's expiry truncation,
    ///      so it costs strictly more than a single grant. The overlap branch is the
    ///      interesting one — it writes `scopes[oldKey].expiresAt` in place rather than
    ///      replacing the whole struct, which is why it is much cheaper than the grant.
    function test_GasUncovered_RotateSessionKey_OverlapBranch() public {
        address newKey = vm.addr(0xBEEF01);
        vm.prank(ownerAddr);
        skm.grantSessionKey(agent, _scope());

        SessionKeyManager.Scope memory newScope = _scope();
        uint48 overlap = EXPIRES_AT - 1 days;

        uint256 before = gasleft();
        vm.prank(ownerAddr);
        skm.rotateSessionKey(agent, newKey, newScope, overlap);
        uint256 used = before - gasleft();
        emit log_named_uint("GAP manager: rotateSessionKey (overlap branch)", used);
    }

    /// @dev The other rotation branch: overlap already elapsed, so the old key is revoked
    ///      instead. Costs a grant plus a revoke instead of a grant plus a field write.
    function test_GasUncovered_RotateSessionKey_RevokeBranch() public {
        address newKey = vm.addr(0xBEEF02);
        vm.prank(ownerAddr);
        skm.grantSessionKey(agent, _scope());

        uint256 before = gasleft();
        vm.prank(ownerAddr);
        // overlapEnds == 0 is <= block.timestamp, so the revoke branch runs.
        skm.rotateSessionKey(agent, newKey, _scope(), 0);
        uint256 used = before - gasleft();
        emit log_named_uint("GAP manager: rotateSessionKey (revoke branch)", used);
    }

    /// @dev Denylisting a selector nobody denied before: a cold zero -> true SSTORE.
    ///      Every `onlyOwner` entry point self-seals through this same function, so this
    ///      is also the marginal cost the seal adds to the FIRST admin call of any kind.
    function test_GasUncovered_SetSelectorDenied_Fresh() public {
        uint256 before = gasleft();
        vm.prank(ownerAddr);
        skm.setSelectorDenied(bytes4(0xdeadbeef), true);
        uint256 used = before - gasleft();
        emit log_named_uint("GAP manager: setSelectorDenied (fresh, 0->true)", used);
    }

    /// @dev Re-writing an ALREADY-denied selector with the same value `true`. The
    ///      `onlyOwner` self-seal does this on every single admin call, so this is the
    ///      recurring cost of the C-04 self-sealing property — paid forever, forever
    ///      invisible. A no-op SSTORE (same value) is the cheapest write there is.
    function test_GasUncovered_SetSelectorDenied_AlreadyDenied() public {
        vm.prank(ownerAddr);
        skm.setSelectorDenied(bytes4(0xdeadbeef), true);

        uint256 before = gasleft();
        vm.prank(ownerAddr);
        skm.setSelectorDenied(bytes4(0xdeadbeef), true);
        uint256 used = before - gasleft();
        emit log_named_uint("GAP manager: setSelectorDenied (already denied, no-op write)", used);
    }

    /// @dev Ownership handover. Deliberately NOT re-entranting the owner slot in place:
    ///      a different address means an SSTORE to a different non-zero value, which is
    ///      the 2.9k reset price plus the 2.1k cold access. The `onlyOwner` seal adds a
    ///      second write on top.
    function test_GasUncovered_TransferOwnership() public {
        uint256 before = gasleft();
        vm.prank(ownerAddr);
        skm.transferOwnership(vm.addr(0xCAFE));
        uint256 used = before - gasleft();
        emit log_named_uint("GAP manager: transferOwnership", used);
    }

    /// @dev Treasury withdrawal. Cost is dominated by the `CALL` and its 2.6k cold
    ///      account access, not by SigilKit's own bookkeeping — but the beneficiary is
    ///      OWNER-chosen, so the callee may also burn gas, and nothing bounds that.
    function test_GasUncovered_Withdraw() public {
        uint256 before = gasleft();
        vm.prank(ownerAddr);
        skm.withdraw(payable(vm.addr(0xBEEF03)), 1 ether);
        uint256 used = before - gasleft();
        emit log_named_uint("GAP manager: withdraw (1 ether, EOA beneficiary)", used);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SessionKeyManager — the WARM path (every published budget measures cold)
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Decomposes the E11 multiplier into its two independent halves, which the
    ///      existing prose in `GasBudget.t.sol` conflates into a single "~28k over the
    ///      empty-watchlist form".
    ///
    ///      `enforceNativeDelta` alone (empty watchlist) adds a `BALANCE` opcode plus a
    ///      pre/post comparison. The watchlist then adds 16 cross-contract staticcalls.
    ///      These are separate multipliers and they behave DIFFERENTLY against warmth,
    ///      which is why the one-number summary is misleading:
    ///
    ///        - the `BALANCE`/comparison half is ~constant in both states;
    ///        - the 16 staticcalls are ~2.6k each COLD (account access) and ~100 each WARM,
    ///          so the watchlist multiplier is the part that collapses in steady state.
    ///
    ///      Reported on the SAME manager instance is impossible (a scope's watchlist is
    ///      immutable), so each configuration is measured on its own fresh manager and the
    ///      cold/warm pair for each is printed alongside. That keeps every number a real
    ///      measurement rather than a subtraction across incompatible fixtures.
    function test_GasUncovered_E11CostDecomposition() public {
        uint256 coldNoE11;
        uint256 warmNoE11;
        {
            SessionKeyManager m = new SessionKeyManager(ownerAddr);
            (coldNoE11, warmNoE11) = _measurePair(m, false, new address[](0));
        }
        uint256 coldDeltaOnly;
        uint256 warmDeltaOnly;
        {
            SessionKeyManager m = new SessionKeyManager(ownerAddr);
            (coldDeltaOnly, warmDeltaOnly) = _measurePair(m, true, new address[](0));
        }
        uint256 coldFull;
        uint256 warmFull;
        {
            SessionKeyManager m = new SessionKeyManager(ownerAddr);
            address[] memory watch = new address[](8);
            for (uint256 i = 0; i < watch.length; ++i) {
                GasProbeToken t = new GasProbeToken();
                t.mint(address(m), 1_000_000e18);
                watch[i] = address(t);
            }
            (coldFull, warmFull) = _measurePair(m, true, watch);
        }

        emit log_named_uint("E11 base: no E11, cold", coldNoE11);
        emit log_named_uint("E11 base: no E11, warm", warmNoE11);
        emit log_named_uint("E11 delta-only (empty watchlist), cold", coldDeltaOnly);
        emit log_named_uint("E11 delta-only (empty watchlist), warm", warmDeltaOnly);
        emit log_named_uint("E11 full (8 tokens), cold", coldFull);
        emit log_named_uint("E11 full (8 tokens), warm", warmFull);
        emit log_named_uint("E11 delta half, cold (full - base)", coldFull - coldNoE11);
        emit log_named_uint("E11 delta half, warm (full - base)", warmFull - warmNoE11);
        emit log_named_uint("E11 watchlist half, cold (full - delta-only)", coldFull - coldDeltaOnly);
        emit log_named_uint("E11 watchlist half, warm (full - delta-only)", warmFull - warmDeltaOnly);
    }

    /// @dev One cold + one warm execution on a FRESH manager AND a FRESH target.
    ///
    ///      The fresh target is essential, not cosmetic: the inner `poke` does
    ///      `count += by`, so a shared target would make the FIRST configuration pay a
    ///      cold account access (2 600) plus a cold zero-to-one SSTORE (22 100) that
    ///      every later configuration avoids. That contamination (~24k) is larger than
    ///      the effect being measured, and it inverts the sign of the delta-only row —
    ///      an earlier revision of this test reported `delta-only cold` as CHEAPER than
    ///      the no-E11 baseline, which is impossible, and that was the tell.
    ///
    ///      With a fresh target per configuration, all three pay the identical 22 100
    ///      first-write SSTORE and the differences are attributable to E11 alone.
    function _measurePair(SessionKeyManager m, bool enforceDelta, address[] memory watch)
        internal
        returns (uint256 cold, uint256 warm)
    {
        GasProbeTarget fresh = new GasProbeTarget();
        vm.deal(address(m), 100 ether);
        SessionKeyManager.Scope memory s;
        s.expiresAt = EXPIRES_AT;
        s.windowSeconds = 1 hours;
        s.perActionCap = 1 ether;
        s.perWindowCap = 100 ether;
        s.merkleRoot = bytes32(0);
        s.countersignAbove = 0;
        s.enforceNativeDelta = enforceDelta;
        s.tokenWatchlist = watch;
        vm.prank(ownerAddr);
        m.grantSessionKey(agent, s);

        SessionKeyManager.ActionRequest memory r1 = SessionKeyManager.ActionRequest({
            agentId: keccak256("gas-probe"),
            target: address(fresh),
            selector: fresh.poke.selector,
            value: 0,
            nonce: 0,
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("e11-decomposition"),
            data: abi.encode(1)
        });
        uint256 before = gasleft();
        m.executeWithSessionKey(r1, _signFor(m, AGENT_KEY, r1), new bytes32[](0), "");
        cold = before - gasleft();

        SessionKeyManager.ActionRequest memory r2 = SessionKeyManager.ActionRequest({
            agentId: keccak256("gas-probe"),
            target: address(fresh),
            selector: fresh.poke.selector,
            value: 0,
            nonce: 1,
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("e11-decomposition"),
            data: abi.encode(1)
        });
        before = gasleft();
        m.executeWithSessionKey(r2, _signFor(m, AGENT_KEY, r2), new bytes32[](0), "");
        warm = before - gasleft();
    }

    /// @dev THE MOST IMPORTANT NUMBER IN THIS FILE.
    ///
    ///      Every `GasBudget.t.sol` measurement is a FIRST execution: the nonce slot, the
    ///      `windowStart` slot and the `spentThisWindow` slot are all cold and zero, so
    ///      the measured ~112k is dominated by three 22.1k SSTOREs. Production's steady
    ///      state is the SECOND action inside the same window, where those same three
    ///      writes are warm: `windowStart` is a no-op (100), the other two are 2.9k resets.
    ///
    ///      So the published budgets describe a cost users pay once per key per window,
    ///      and nothing in CI describes the cost they pay on every subsequent action. The
    ///      gap below is the size of that unmeasured difference.
    function test_GasUncovered_WarmVsCold_Execute() public {
        vm.prank(ownerAddr);
        skm.grantSessionKey(agent, _scope());

        // COLD: first action in the window (comparable to BUDGET_SIMPLE).
        SessionKeyManager.ActionRequest memory cold = _request(0, abi.encode(1), 0);
        bytes memory coldSig = _sign(AGENT_KEY, cold);
        uint256 before = gasleft();
        skm.executeWithSessionKey(cold, coldSig, new bytes32[](0), "");
        uint256 coldGas = before - gasleft();

        // WARM: second action in the SAME window — the production steady state.
        SessionKeyManager.ActionRequest memory warm = _request(0, abi.encode(1), 1);
        bytes memory warmSig = _sign(AGENT_KEY, warm);
        before = gasleft();
        skm.executeWithSessionKey(warm, warmSig, new bytes32[](0), "");
        uint256 warmGas = before - gasleft();

        // And a third, to show the warm cost is a plateau rather than a one-off.
        SessionKeyManager.ActionRequest memory third = _request(0, abi.encode(1), 2);
        bytes memory thirdSig = _sign(AGENT_KEY, third);
        before = gasleft();
        skm.executeWithSessionKey(third, thirdSig, new bytes32[](0), "");
        uint256 thirdGas = before - gasleft();

        emit log_named_uint("PATH execute: 1st action (cold, = BUDGET_SIMPLE basis)", coldGas);
        emit log_named_uint("PATH execute: 2nd action (warm, same window)", warmGas);
        emit log_named_uint("PATH execute: 3rd action (warm, same window)", thirdGas);
        emit log_named_uint("PATH execute: cold-minus-warm (unmeasured by any budget)", coldGas - warmGas);
    }

    /// @dev The E11 watchlist cost is measured COLD (each of the 8 token accounts is
    ///      touched for the first time, so each pays 2.6k of account access). In the
    ///      steady state the same 16 staticcalls hit warm accounts. The published
    ///      BUDGET_E11_FULL_WATCHLIST therefore describes the first action of a window,
    ///      not the recurring one.
    function test_GasUncovered_WarmVsCold_E11FullWatchlist() public {
        address[] memory watch = new address[](8);
        for (uint256 i = 0; i < watch.length; ++i) {
            GasProbeToken token = new GasProbeToken();
            token.mint(address(skm), 1_000_000e18);
            watch[i] = address(token);
        }
        SessionKeyManager.Scope memory s = _scope();
        s.enforceNativeDelta = true;
        s.tokenWatchlist = watch;
        vm.prank(ownerAddr);
        skm.grantSessionKey(agent, s);

        SessionKeyManager.ActionRequest memory cold = _request(0, abi.encode(1), 0);
        bytes memory coldSig = _sign(AGENT_KEY, cold);
        uint256 before = gasleft();
        skm.executeWithSessionKey(cold, coldSig, new bytes32[](0), "");
        uint256 coldGas = before - gasleft();

        SessionKeyManager.ActionRequest memory warm = _request(0, abi.encode(1), 1);
        bytes memory warmSig = _sign(AGENT_KEY, warm);
        before = gasleft();
        skm.executeWithSessionKey(warm, warmSig, new bytes32[](0), "");
        uint256 warmGas = before - gasleft();

        emit log_named_uint("PATH E11 x8: 1st action (cold accounts)", coldGas);
        emit log_named_uint("PATH E11 x8: 2nd action (warm accounts)", warmGas);
        emit log_named_uint("PATH E11 x8: cold-minus-warm", coldGas - warmGas);
    }

    /// @dev The window-ROLLOVER action: the one steady-state action that is as expensive
    ///      as the first, because `windowStart` and `spentThisWindow` both go back to a
    ///      different value. This is the true per-window worst case and it is the number
    ///      that should be compared against a bundler's or relayer's per-op ceiling.
    function test_GasUncovered_WindowRollover() public {
        vm.prank(ownerAddr);
        skm.grantSessionKey(agent, _scope());

        SessionKeyManager.ActionRequest memory first = _request(0, abi.encode(1), 0);
        skm.executeWithSessionKey(first, _sign(AGENT_KEY, first), new bytes32[](0), "");

        // Roll the fixed window past its boundary.
        vm.warp(block.timestamp + 1 hours + 1);

        SessionKeyManager.ActionRequest memory rolled = _request(0, abi.encode(1), 1);
        bytes memory sig = _sign(AGENT_KEY, rolled);
        uint256 before = gasleft();
        skm.executeWithSessionKey(rolled, sig, new bytes32[](0), "");
        uint256 used = before - gasleft();
        emit log_named_uint("PATH execute: window-rollover action (warm nonce, cold window)", used);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // The Merkle proof walk — measuring the bound, pricing the in-bound path
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Caches the two per-tuple SLOADs the batch loop performs, so the
    ///      optimization estimate in the report is anchored to a measurement instead of
    ///      an EVM price table. The batch loop re-reads
    ///      `deniedSelectors[account][selector]` and `scope.perActionCap` for EVERY
    ///      tuple; both are the same slot every iteration.
    ///
    ///      Measured as the delta between a batch whose tuples all share one selector
    ///      (the second SLOAD is warm) and one whose tuples are all distinct. The
    ///      difference is the per-tuple price of a repeated denylist read, and it is
    ///      what a `bytes4(0)` short-circuit would remove.
    function test_GasUncovered_7579_DenylistReadIsPerTuple() public {
        SessionKey7579Module module = new SessionKey7579Module();

        // (a) 8 tuples sharing ONE selector => one cold denylist slot, seven warm reads.
        GasProbe7579Account shared = new GasProbe7579Account(module);
        shared.install(abi.encode(agent, _mScope(bytes32(0))));
        bytes32 hashA = keccak256("denylist-shared");
        PackedUserOperation memory opA = _mOp(
            _batchCallData(8, _SEL), _mSign(address(shared), hashA, "")
        );
        opA.sender = address(shared);
        uint256 beforeA = gasleft();
        shared.validate(opA, hashA);
        uint256 sharedGas = beforeA - gasleft();

        // (b) 8 tuples with EIGHT distinct selectors => eight cold denylist slots.
        GasProbe7579Account distinct = new GasProbe7579Account(module);
        distinct.install(abi.encode(agent, _mScope(bytes32(0))));
        bytes memory distinctData = new bytes(8 * 32);
        for (uint256 i = 0; i < 8; ++i) {
            // Distinct 4-byte selector per tuple: 0x1000 + i.
            // Test fixture: `i < 8`, so `0x1000 + i` fits in 32 bits and the bytes4
            // conversion is a pure narrowing of an already-provably-fitting value.
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes4 sel = bytes4(uint32(0x1000 + i));
            uint256 off = i * 32;
            assembly ("memory-safe") {
                mstore(add(add(distinctData, 32), off), sel)
            }
        }
        bytes32 hashB = keccak256("denylist-distinct");
        PackedUserOperation memory opB = _mOp(
            _batchCallDataFromData(distinctData), _mSign(address(distinct), hashB, "")
        );
        opB.sender = address(distinct);
        uint256 beforeB = gasleft();
        distinct.validate(opB, hashB);
        uint256 distinctGas = beforeB - gasleft();

        emit log_named_uint("REF 7579 batch x8, 1 shared selector (7 warm denylist SLOADs)", sharedGas);
        emit log_named_uint("REF 7579 batch x8, 8 distinct selectors (8 cold denylist SLOADs)", distinctGas);
        emit log_named_uint("REF cold-minus-warm denylist read (7 reads)", distinctGas - sharedGas);
    }

    /// @dev Measures the manager's `merkleProof` gas bound. `_targetAllowed` refuses a
    ///      proof longer than MAX_SINGLE_PROOF_ELEMENTS (8) BEFORE the walk, so the cost
    ///      curve is NOT monotonic: it climbs to the bound, then falls off a cliff for
    ///      every over-bound length. This test used to assume monotonicity and divided
    ///      two raw samples unguarded, which reverted with 0x11 the moment the bound
    ///      landed mid-series.
    ///
    ///      It now reports the marginal against a RUNNING PEAK — never against a lower
    ///      predecessor — and prints an explicit "DROPPED" line wherever the curve falls,
    ///      so the discontinuity is VISIBLE instead of silently skipped. The assertions
    ///      below then pin the shape that used to be an assumption:
    ///
    ///        - an over-bound proof costs LESS than an at-bound one (the early return);
    ///        - the at-bound walk stays under an absolute ceiling.
    ///
    ///      Deleting the early return restores monotonic growth and turns the first
    ///      assertion red; the second keeps the bound from masking a regression that
    ///      makes the in-bound path itself expensive.
    ///
    ///      Every walk REVERTS — at the final root comparison in-bound, on the
    ///      `TargetNotAllowed` refusal out-of-bound — so each number is the cost of the
    ///      work actually performed before the refusal, which is what a relayer pays.
    function test_GasUncovered_UnboundedProofWalk() public {
        bytes32 leaf = keccak256(abi.encode(address(target), target.poke.selector, bytes32(0)));
        bytes32 other = keccak256(abi.encode(address(0xDEAD), bytes4(0xdeadbeef), bytes32(0)));
        SessionKeyManager.Scope memory s = _scope();
        s.merkleRoot = _sortedHash(leaf, other);
        vm.prank(ownerAddr);
        skm.grantSessionKey(agent, s);

        uint256[4] memory lengths = [uint256(1), 8, 32, 128];
        uint256 peak; // highest `used` so far — the ONLY safe subtrahend
        uint256 peakN; // the element count that produced `peak`
        uint256 boundGas; // cost at exactly MAX_SINGLE_PROOF_ELEMENTS
        uint256 cheapestOverBound = type(uint256).max; // cheapest out-of-bound sample
        for (uint256 k = 0; k < lengths.length; ++k) {
            uint256 n = lengths[k];
            SessionKeyManager.ActionRequest memory req = _request(0, abi.encode(1), 0);
            bytes memory sig = _sign(AGENT_KEY, req);

            bytes32[] memory proof = new bytes32[](n);
            for (uint256 i = 0; i < n; ++i) {
                // Distinct filler so the walk cannot short-circuit on repeated hashing.
                proof[i] = keccak256(abi.encode("filler", i));
            }

            uint256 before = gasleft();
            vm.expectRevert();
            skm.executeWithSessionKey(req, sig, proof, "");
            uint256 used = before - gasleft();

            emit log_named_uint(string.concat("DOS proof walk: elements=", _u(n)), used);
            bool improved = used > peak;
            if (k > 0) {
                if (improved) {
                    // `lengths` is strictly increasing and `peakN <= lengths[k - 1]`, so
                    // `n - peakN` is positive whenever the walk got more expensive.
                    // ASSERTED rather than assumed, so widening the series can never
                    // reintroduce the 0x11 underflow this test used to revert with.
                    assertGt(n, peakN, "marginal denominator must be positive");
                    emit log_named_uint(
                        string.concat("DOS marginal per element (", _u(n), ")"), (used - peak) / (n - peakN)
                    );
                } else {
                    emit log_named_string(
                        string.concat(
                            "DOS cost DROPPED at elements=", _u(n), " (vs peak ", _u(peak), " at ", _u(peakN),
                            ") - MAX_SINGLE_PROOF_ELEMENTS bound engaged"
                        ),
                        "no marginal emitted: cost is not monotonic past the bound"
                    );
                }
            }
            if (improved) {
                peak = used;
                peakN = n;
            }
            if (n == MAX_SINGLE_PROOF_ELEMENTS) {
                boundGas = used;
            }
            if (n > MAX_SINGLE_PROOF_ELEMENTS && used < cheapestOverBound) {
                cheapestOverBound = used;
            }
        }

        // POSITIVE assertion, not a tautology: the early return in `_targetAllowed`
        // makes an over-bound proof CHEAPER than one exactly at the bound. Deleting
        // `MAX_SINGLE_PROOF_ELEMENTS` restores monotonic growth, every over-bound sample
        // climbs above `boundGas`, and this turns red.
        assertLt(
            cheapestOverBound,
            boundGas,
            "over-bound proof must cost LESS than an at-bound proof (MAX_SINGLE_PROOF_ELEMENTS early return)"
        );
        // Absolute ceiling on the in-bound depth-8 walk, so the bound cannot mask a
        // regression that makes the at-bound path itself expensive.
        assertLt(
            boundGas,
            BOUND_PROOF_WALK_GAS_CEILING,
            "at-bound (depth-8) proof walk must stay under its absolute ceiling"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SessionKey7579Module — install / lifecycle / SINGLE-call validation
    // ══════════════════════════════════════════════════════════════════════════

    function _mScope(bytes32 root) internal pure returns (SessionKey7579Module.Scope memory) {
        return SessionKey7579Module.Scope({
            expiresAt: EXPIRES_AT,
            windowSeconds: 1 hours,
            perActionCap: 1 ether,
            perWindowCap: 100 ether,
            merkleRoot: root
        });
    }

    function _mDigest(address acct, bytes32 userOpHash) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(keccak256("UserOp(address sender,uint256 nonce,bytes32 userOpHash)"), acct, 0, userOpHash)
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SigilKit7579"),
                keccak256("1"),
                block.chainid,
                acct
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _mSign(address acct, bytes32 userOpHash, bytes memory tail)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, _mDigest(acct, userOpHash));
        return abi.encodePacked(r, s, v, tail);
    }

    function _mOp(bytes memory callData, bytes memory signature)
        internal
        pure
        returns (PackedUserOperation memory op)
    {
        op.sender = address(0);
        op.nonce = 0;
        op.initCode = "";
        op.callData = callData;
        op.accountGasLimits = bytes32(0);
        op.preVerificationGas = 0;
        op.gasFees = bytes32(0);
        op.paymasterAndData = "";
        op.signature = signature;
    }

    function _singleCallData(address tgt, uint256 value, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        SessionKey7579Module.ExecTuple memory t =
            SessionKey7579Module.ExecTuple(tgt, value, data);
        return abi.encodePacked(bytes32(0), abi.encode(t));
    }

    /// @dev The SINGLE-call validation path has NO gas budget. `Gas7579Scaling.t.sol`
    ///      prices the batch curve and `SessionKey7579Module.t.sol` prices the 8-tuple
    ///      worst case, but a single whitelisted call — arguably the shape a real
    ///      integration sends most often — is unpriced.
    function test_GasUncovered_7579_SingleCall_ZeroRoot() public {
        SessionKey7579Module module = new SessionKey7579Module();
        GasProbe7579Account acct = new GasProbe7579Account(module);
        acct.install(abi.encode(agent, _mScope(bytes32(0))));

        bytes32 opHash = keccak256("gap-single-zero-root");
        PackedUserOperation memory op =
            _mOp(_singleCallData(address(target), 0, abi.encode(1)), _mSign(address(acct), opHash, ""));
        op.sender = address(acct);

        uint256 before = gasleft();
        uint256 vd = acct.validate(op, opHash);
        uint256 used = before - gasleft();
        assertEq(vd, uint256(EXPIRES_AT) << 160, "single call must validate");
        emit log_named_uint("GAP 7579: validateUserOp single (zero root)", used);
    }

    /// @dev The whitelisted single call, where the pinned-leaf attempt FAILS and the
    ///      wildcard walk runs — i.e. two full proof walks, the same worst-case shape the
    ///      batch suite bounds, but on the path with no ceiling at all.
    function test_GasUncovered_7579_SingleCall_WildcardProof() public {
        SessionKey7579Module module = new SessionKey7579Module();
        GasProbe7579Account acct = new GasProbe7579Account(module);

        // A 2-leaf wildcard tree: the pinned leaf never matches, so both walks run.
        bytes32 leafSelf = keccak256(abi.encode(address(target), target.poke.selector, bytes32(0)));
        bytes32 leafOther = keccak256(abi.encode(address(0xDEAD), bytes4(0xdeadbeef), bytes32(0)));
        bytes32 root = _sortedHash(leafSelf, leafOther);
        acct.install(abi.encode(agent, _mScope(root)));

        bytes32 opHash = keccak256("gap-single-wildcard");
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafOther;
        // Trailing proof wire format: [uint16 count][count x bytes32].
        bytes memory tail = abi.encodePacked(uint16(1), proof[0]);

        // The module's selector comes from the TUPLE's own calldata, so the payload must
        // begin with the real selector for the wildcard leaf (argsHash == 0) to match.
        bytes memory tupleData = abi.encodePacked(target.poke.selector, uint256(1));
        PackedUserOperation memory op =
            _mOp(_singleCallData(address(target), 0, tupleData), _mSign(address(acct), opHash, tail));
        op.sender = address(acct);

        uint256 before = gasleft();
        uint256 vd = acct.validate(op, opHash);
        uint256 used = before - gasleft();
        assertEq(vd, uint256(EXPIRES_AT) << 160, "whitelisted single call must validate");
        emit log_named_uint("GAP 7579: validateUserOp single (wildcard proof, 2 walks)", used);
    }

    /// @dev The native-transfer encoding: EMPTY `data` with non-zero value. Reaches
    ///      `bytes4(call_.data) == 0x00000000` in the denylist, so this is the one path
    ///      where a zero selector is meaningful rather than a padding artifact.
    function test_GasUncovered_7579_SingleCall_NativeTransfer() public {
        SessionKey7579Module module = new SessionKey7579Module();
        GasProbe7579Account acct = new GasProbe7579Account(module);
        acct.install(abi.encode(agent, _mScope(bytes32(0))));

        bytes32 opHash = keccak256("gap-single-native");
        PackedUserOperation memory op =
            _mOp(_singleCallData(address(target), 0.1 ether, hex""), _mSign(address(acct), opHash, ""));
        op.sender = address(acct);

        uint256 before = gasleft();
        uint256 vd = acct.validate(op, opHash);
        uint256 used = before - gasleft();
        assertEq(vd, uint256(EXPIRES_AT) << 160, "native-transfer single call must validate");
        emit log_named_uint("GAP 7579: validateUserOp single (native transfer, empty data)", used);
    }

    /// @dev `onInstall` with no grant: one cold SSTORE. The cheapest possible install,
    ///      and the shape a user lands on when they install the module before creating
    ///      any keys.
    function test_GasUncovered_7579_OnInstall_Empty() public {
        SessionKey7579Module module = new SessionKey7579Module();
        GasProbe7579Account acct = new GasProbe7579Account(module);

        uint256 before = gasleft();
        acct.install("");
        uint256 used = before - gasleft();
        emit log_named_uint("GAP 7579: onInstall (no grant)", used);
    }

    /// @dev `onInstall` WITH an initial grant — the shape both the SDK and every fixture
    ///      use. Pays the `initialized` SSTORE plus a full 5-field scope write, so it is
    ///      markedly more expensive than the empty form.
    function test_GasUncovered_7579_OnInstall_WithGrant() public {
        SessionKey7579Module module = new SessionKey7579Module();
        GasProbe7579Account acct = new GasProbe7579Account(module);

        uint256 before = gasleft();
        acct.install(abi.encode(agent, _mScope(bytes32(0))));
        uint256 used = before - gasleft();
        emit log_named_uint("GAP 7579: onInstall (with initial grant)", used);
    }

    /// @dev A post-install grant. Separate from `onInstall` because the scope slot is
    ///      then already warm from the install-time write only if the SAME key is
    ///      re-granted; a fresh key is the cold, expensive case an operator hits when
    ///      rotating a session key in.
    function test_GasUncovered_7579_GrantSessionKey_Fresh() public {
        SessionKey7579Module module = new SessionKey7579Module();
        GasProbe7579Account acct = new GasProbe7579Account(module);
        acct.install("");

        address newKey = vm.addr(0xBEEF04);
        uint256 before = gasleft();
        acct.grant(newKey, _mScope(bytes32(0)));
        uint256 used = before - gasleft();
        emit log_named_uint("GAP 7579: grantSessionKey (fresh key, cold)", used);
    }

    function test_GasUncovered_7579_RevokeSessionKey() public {
        SessionKey7579Module module = new SessionKey7579Module();
        GasProbe7579Account acct = new GasProbe7579Account(module);
        acct.install(abi.encode(agent, _mScope(bytes32(0))));

        uint256 before = gasleft();
        acct.revoke(agent);
        uint256 used = before - gasleft();
        emit log_named_uint("GAP 7579: revokeSessionKey", used);
    }

    /// @dev Unlike the manager, the module has NO `onlyOwner` self-seal: an account
    ///      writing the same denylist entry twice pays the no-op SSTORE both times, and
    ///      the mapping is per-account so a large install base multiplies the storage.
    function test_GasUncovered_7579_SetSelectorDenied() public {
        SessionKey7579Module module = new SessionKey7579Module();
        GasProbe7579Account acct = new GasProbe7579Account(module);
        acct.install("");

        uint256 before = gasleft();
        acct.denySelector(bytes4(0xdeadbeef), true);
        uint256 used = before - gasleft();
        emit log_named_uint("GAP 7579: setSelectorDenied (fresh)", used);
    }

    /// @dev `onUninstall` clears only `initialized`; scopes and windows are RETAINED by
    ///      design. So uninstall is one cheap refund-SSTORE, and all the per-key state
    ///      stays resident and un-reclaimable forever. This is the state-bloat headline
    ///      for the 7579 path, priced.
    function test_GasUncovered_7579_OnUninstall() public {
        SessionKey7579Module module = new SessionKey7579Module();
        GasProbe7579Account acct = new GasProbe7579Account(module);
        acct.install(abi.encode(agent, _mScope(bytes32(0))));

        uint256 before = gasleft();
        acct.uninstall();
        uint256 used = before - gasleft();
        emit log_named_uint("GAP 7579: onUninstall (state RETAINED, not reclaimed)", used);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ActionLog7579Executor — the whole surface is unbudgeted
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev `execute` is the executor's only hot path and it has NO gas budget at all —
    ///      `GasBudget.t.sol` covers the manager and `Gas7579Scaling.t.sol` covers the
    ///      validator, so the module that PRODUCES the mandatory audit trail is unpriced.
    ///      Measured with a zero-value call so the number is the executor's own overhead.
    function test_GasUncovered_Executor_Execute_ZeroValue() public {
        ActionLog7579Executor executor = new ActionLog7579Executor();
        GasProbeExecutorAccount acct = new GasProbeExecutorAccount(executor);
        acct.install(abi.encode(keccak256("agent-1")));

        uint256 before = gasleft();
        acct.exec(address(target), 0, abi.encodeWithSelector(target.poke.selector, 1));
        uint256 used = before - gasleft();
        assertEq(target.count(), 1, "inner call must have landed");
        emit log_named_uint("GAP executor: execute (zero value, warm agentIds slot)", used);
    }

    /// @dev The same path with value, which adds the CALL's value-transfer accounting
    ///      and a cold recipient account. The cold case is the first execution; the
    ///      reentrancy lock is also cold on it.
    function test_GasUncovered_Executor_Execute_ColdFirstCall() public {
        ActionLog7579Executor executor = new ActionLog7579Executor();
        GasProbeExecutorAccount acct = new GasProbeExecutorAccount(executor);
        acct.install(abi.encode(keccak256("agent-1")));
        vm.deal(address(acct), 10 ether);

        uint256 before = gasleft();
        acct.exec{value: 0.1 ether}(address(target), 0.1 ether, abi.encodeWithSelector(target.poke.selector, 1));
        uint256 used = before - gasleft();
        emit log_named_uint("GAP executor: execute (0.1 ether, cold lock + cold target)", used);
    }

    /// @dev The reentrancy lock is two SSTOREs around the call: `true` before, `false`
    ///      after. Both are non-zero -> non-zero on the SECOND execution, so the steady
    ///      state is 2 x 2.9k. Priced here because `execute` has no ceiling and this is
    ///      a recurring cost on the executor's hot path.
    function test_GasUncovered_Executor_Execute_WarmSecondCall() public {
        ActionLog7579Executor executor = new ActionLog7579Executor();
        GasProbeExecutorAccount acct = new GasProbeExecutorAccount(executor);
        acct.install(abi.encode(keccak256("agent-1")));

        acct.exec(address(target), 0, abi.encodeWithSelector(target.poke.selector, 1));
        uint256 before = gasleft();
        acct.exec(address(target), 0, abi.encodeWithSelector(target.poke.selector, 2));
        uint256 used = before - gasleft();
        emit log_named_uint("GAP executor: execute (2nd call, warm lock writes)", used);
    }

    function test_GasUncovered_Executor_OnInstall_WithAgentId() public {
        ActionLog7579Executor executor = new ActionLog7579Executor();
        GasProbeExecutorAccount acct = new GasProbeExecutorAccount(executor);

        uint256 before = gasleft();
        acct.install(abi.encode(keccak256("agent-1")));
        uint256 used = before - gasleft();
        emit log_named_uint("GAP executor: onInstall (binds agentId)", used);
    }

    function test_GasUncovered_Executor_SetAgentId() public {
        ActionLog7579Executor executor = new ActionLog7579Executor();
        GasProbeExecutorAccount acct = new GasProbeExecutorAccount(executor);
        acct.install(abi.encode(keccak256("agent-1")));

        uint256 before = gasleft();
        acct.setAgentId(keccak256("agent-2"));
        uint256 used = before - gasleft();
        emit log_named_uint("GAP executor: setAgentId (rebind)", used);
    }

    /// @dev `onUninstall` DELETES the agentId binding, so unlike the 7579 validator's
    ///      uninstall this one does return a 15k refund. Priced to show the asymmetry
    ///      between the two modules' uninstall semantics.
    function test_GasUncovered_Executor_OnUninstall() public {
        ActionLog7579Executor executor = new ActionLog7579Executor();
        GasProbeExecutorAccount acct = new GasProbeExecutorAccount(executor);
        acct.install(abi.encode(keccak256("agent-1")));

        uint256 before = gasleft();
        acct.uninstall();
        uint256 used = before - gasleft();
        emit log_named_uint("GAP executor: onUninstall (DELETES agentId -> refund)", used);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SigilKitDelegator — the 7702 initializer
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Every EOA that delegates pays this once, in its own storage. It is a
    ///      constructor-equivalent (owner write + SIX denylist SSTOREs + one extra for
    ///      `initializeSelfOwned` itself) and it is completely unbudgeted. Since it is
    ///      per-EOA rather than per-contract, it is also the one admin cost in the
    ///      codebase that scales with the USER COUNT instead of the install count.
    function test_GasUncovered_Delegator_InitializeSelfOwned() public {
        SigilKitDelegator impl = new SigilKitDelegator();
        address payable eoa = payable(vm.addr(0xD06));
        vm.etch(eoa, address(impl).code);

        uint256 before = gasleft();
        SigilKitDelegator(eoa).initializeSelfOwned();
        uint256 used = before - gasleft();
        emit log_named_uint("GAP delegator: initializeSelfOwned (owner + 7 denylist SSTOREs)", used);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Views — cheap, but unbounded in calldata and free to call by anyone
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev `getScope` returns the whole struct INCLUDING the `tokenWatchlist` array,
    ///      so its calldata cost is data-dependent and an attacker-chosen watchlist
    ///      length is what drives it. The other views are single-word and bounded.
    ///      Measured as a group because each is far below any plausible ceiling — the
    ///      point is that NONE of them is budgeted, so a `getScope` that starts copying
    ///      a second unbounded array would not fail anything.
    function test_GasUncovered_Views() public {
        vm.prank(ownerAddr);
        skm.grantSessionKey(agent, _scope());

        uint256 before = gasleft();
        skm.getScope(agent);
        emit log_named_uint("GAP view: getScope", before - gasleft());

        before = gasleft();
        skm.getWindowState(agent);
        emit log_named_uint("GAP view: getWindowState", before - gasleft());

        before = gasleft();
        skm.isRevoked(agent);
        emit log_named_uint("GAP view: isRevoked", before - gasleft());

        before = gasleft();
        skm.getNonce(agent);
        emit log_named_uint("GAP view: getNonce", before - gasleft());

        before = gasleft();
        skm.isSelectorDenied(bytes4(0xdeadbeef));
        emit log_named_uint("GAP view: isSelectorDenied", before - gasleft());

        before = gasleft();
        skm.DOMAIN_SEPARATOR();
        emit log_named_uint("GAP view: DOMAIN_SEPARATOR (recomputed every call)", before - gasleft());

        before = gasleft();
        skm.adminSelectorDigest();
        emit log_named_uint("GAP view: adminSelectorDigest (7 keccak folds)", before - gasleft());
    }

    // ── shared helpers ─────────────────────────────────────────────────────────

    /// @dev The single fixture selector every tuple in the reference batch shares.
    ///      A 4-byte literal widened to bytes4 — a label change, not a truncation.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes4 internal constant _SEL = bytes4(hex"12345678");

    /// @dev An 8-tuple batch callData where every tuple carries the SAME 4-byte
    ///      calldata. Under a zero Merkle root no selector check runs, so this is the
    ///      cheapest possible batch shape — which is what makes it the right baseline
    ///      for isolating the denylist SLOAD cost.
    function _batchCallData(uint256 tupleCount, bytes4 sel)
        internal
        pure
        returns (bytes memory)
    {
        SessionKey7579Module.ExecTuple[] memory calls =
            new SessionKey7579Module.ExecTuple[](tupleCount);
        for (uint256 i = 0; i < tupleCount; ++i) {
            // Test fixture: synthetic target address `0xA1 + i`; `i < 8` so the value
            // fits in 160 bits and the address conversion cannot truncate.
            // forge-lint: disable-next-line(unsafe-typecast)
            address tgt = address(uint160(0xA1 + i));
            calls[i] = SessionKey7579Module.ExecTuple(tgt, 0, abi.encodePacked(sel));
        }
        return abi.encodePacked(bytes32(uint256(0x01 << 248)), abi.encode(calls));
    }

    /// @dev The same 8-tuple batch, but built from pre-baked 32-byte calldata words so
    ///      each tuple can carry a DIFFERENT selector. Same ABI shape as
    ///      `_batchCallData`, so the two measurements differ only in selector distinctness.
    function _batchCallDataFromData(bytes memory dataWords) internal pure returns (bytes memory) {
        uint256 tupleCount = dataWords.length / 32;
        SessionKey7579Module.ExecTuple[] memory calls =
            new SessionKey7579Module.ExecTuple[](tupleCount);
        for (uint256 i = 0; i < tupleCount; ++i) {
            // Test fixture: synthetic target address `0xA1 + i`; `i < 8` so the value
            // fits in 160 bits and the address conversion cannot truncate.
            // forge-lint: disable-next-line(unsafe-typecast)
            address tgt = address(uint160(0xA1 + i));
            calls[i] = SessionKey7579Module.ExecTuple(tgt, 0, _slice32(dataWords, i * 32));
        }
        return abi.encodePacked(bytes32(uint256(0x01 << 248)), abi.encode(calls));
    }

    function _slice32(bytes memory b, uint256 start) internal pure returns (bytes memory out) {
        out = new bytes(32);
        for (uint256 i = 0; i < 32; ++i) {
            out[i] = b[start + i];
        }
    }

    function _sortedHash(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Decimal string for a loop-bound value, so `log_named_uint` labels stay
    ///      readable. Test-only convenience.
    function _u(uint256 v) internal pure returns (string memory s) {
        if (v == 0) return "0";
        while (v > 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            s = string.concat(string(abi.encodePacked(bytes1(uint8(48 + v % 10)))), s);
            v /= 10;
        }
    }
}
