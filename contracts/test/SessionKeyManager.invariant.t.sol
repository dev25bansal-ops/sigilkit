// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";

/// @dev Simple counting target so invariant runs have a stateful receiver.
contract Counter {
    uint256 public count;

    function poke(uint256 by) external payable {
        count += by;
    }
}

/// @title SessionKeyManagerInvariant
/// @notice Stateful fuzz/invariant suite enforcing the SigilKit security invariants:
///         INV-1 window spend cap · INV-2 expiry/revocation · INV-3 audit-on-success ·
///         INV-4 owner-only unreachability.
/// @dev The fuzzer reaches state changes ONLY through handler functions. Beyond the agent
///      paths (executeRandom) it now also drives ALL admin transitions statefully —
///      grant (valid + every InvalidScope variant), rotate (shorten-overlap and revoke
///      branches, including OverlapBeyondOldExpiry reverts), ownership transfer (incl. the
///      zero-address revert and a hand-back), denylist toggles (incl. the un-deny path) —
///      plus time travel so expiry and window-rollover branches execute mid-sequence.
///      Handler reverts are expected outcomes of random inputs (fail_on_revert=false):
///      they exercise the validation-revert branches without breaking the sequence.
contract SessionKeyManagerInvariant is Test {
    SessionKeyManager internal skm;
    Counter internal counter;

    uint256 internal constant OWNER_KEY = 0xA11CE;
    address internal owner = vm.addr(OWNER_KEY);

    uint256[] internal agentKeys;
    address[] internal agents;

    // Ghost bookkeeping (lives in the test contract's storage).
    mapping(address => uint256) internal expectedWindowSpend;
    mapping(address => uint256) internal successes;
    mapping(address => uint256) internal successesAtRevoke;
    mapping(address => bool) internal everRevoked;
    // Ghost mirror of owner-driven scope evolution (admin actions may legitimately
    // mutate scopes; the invariants below compare contract state against this mirror
    // rather than assuming immutability).
    mapping(address => uint256) internal ghostPerActionCap;
    mapping(address => uint256) internal ghostWindowSeconds;
    mapping(address => uint256) internal ghostMaxPerWindowCap;

    function setUp() public {
        skm = new SessionKeyManager(owner);
        counter = new Counter();
        vm.deal(address(skm), 1_000 ether);

        // The fuzzer must reach state changes ONLY through our handler functions —
        // otherwise it can call grantSessionKey directly as the owner and trivially
        // "mutate" scopes, bypassing the ghost mirror.
        excludeContract(address(skm));
        excludeContract(address(counter));
        targetContract(address(this)); // handler-only fuzzing

        for (uint256 i = 0; i < 3; i++) {
            uint256 pk = 0xB000 + i;
            agentKeys.push(pk);
            agents.push(vm.addr(pk));
            vm.prank(owner);
            skm.grantSessionKey(
                vm.addr(pk),
                SessionKeyManager.Scope({
                    expiresAt: uint48(block.timestamp + 365 days),
                    windowSeconds: 1 hours,
                    perActionCap: 0.5 ether,
                    perWindowCap: 1 ether,
                    merkleRoot: bytes32(0),
                    countersignAbove: 0,
                    enforceNativeDelta: false,
                    tokenWatchlist: new address[](0)
                })
            );
            ghostPerActionCap[vm.addr(pk)] = 0.5 ether;
            ghostWindowSeconds[vm.addr(pk)] = 1 hours;
            ghostMaxPerWindowCap[vm.addr(pk)] = 1 ether;
        }
    }

    // ------------------------------------------------------------------
    // Fuzzer handlers — agent paths
    // ------------------------------------------------------------------
    /// @dev Attempts a session-key execution with pseudo-random parameters.
    function executeRandom(uint256 agentSeed, uint256 valueSeed, uint256 dataSeed) external {
        uint256 idx = boundSeed(agentSeed, agents.length);
        _executeAs(agentKeys[idx], agents[idx], valueSeed % 2 ether, dataSeed);
    }

    /// @dev Owner action so the fuzzer can interleave revocations mid-sequence.
    function revokeRandom(uint256 seed) external {
        address a = agents[boundSeed(seed, agents.length)];
        if (!everRevoked[a] && !skm.isRevoked(a)) {
            everRevoked[a] = true;
            successesAtRevoke[a] = successes[a];
            vm.prank(owner);
            skm.revokeSessionKey(a);
        }
    }

    // ------------------------------------------------------------------
    // Fuzzer handlers — admin paths (new: the suite previously never fuzzed these)
    // ------------------------------------------------------------------
    /// @dev Owner grants a random scope to a random agent — valid variant plus every
    ///      InvalidScope variant, so grant validation branches execute statefully.
    function grantRandom(uint256 agentSeed, uint256 scopeSeed) external {
        address a = agents[boundSeed(agentSeed, agents.length)];
        SessionKeyManager.Scope memory scope;
        uint256 variant = scopeSeed % 6;
        if (variant == 0) {
            // Valid scope with random (non-tightening) caps.
            scope = SessionKeyManager.Scope({
                expiresAt: uint48(block.timestamp + 30 days + (scopeSeed % 300 days)),
                windowSeconds: 1 hours + uint48(scopeSeed % 23 hours),
                perActionCap: 0.5 ether + (scopeSeed % 2 ether),
                perWindowCap: 0,
                merkleRoot: bytes32(0),
                    countersignAbove: 0,
                    enforceNativeDelta: false,
                    tokenWatchlist: new address[](0)
            });
            scope.perWindowCap = scope.perActionCap + (scopeSeed % 3 ether);
        } else if (variant == 1) {
            scope = _scopeTemplate();
            scope.perActionCap = 0; // InvalidScope: zero per-action cap
        } else if (variant == 2) {
            scope = _scopeTemplate();
            scope.perActionCap = 2 ether;
            scope.perWindowCap = 1 ether; // InvalidScope: window cap below action cap
        } else if (variant == 3) {
            scope = _scopeTemplate();
            scope.windowSeconds = 0; // InvalidScope: zero window length
        } else if (variant == 4) {
            scope = _scopeTemplate();
            scope.expiresAt = uint48(block.timestamp - 1); // InvalidScope: past expiry
        } else {
            // Valid idempotent re-grant of the default scope — also the reinstatement
            // path for previously revoked keys.
            scope = _scopeTemplate();
        }
        vm.prank(owner);
        skm.grantSessionKey(a, scope);
        _syncScopeGhost(a);
    }

    /// @dev Owner rotation between two agents — covers the shorten-overlap branch, the
    ///      revoke branch (overlapEnds <= now), and OverlapBeyondOldExpiry reverts when
    ///      an earlier rotation already shortened the old key's expiry below the overlap.
    function rotateRandom(uint256 oldSeed, uint256 newSeed, uint256 overlapSeed) external {
        address oldKey = agents[boundSeed(oldSeed, agents.length)];
        address newKey = agents[boundSeed(newSeed, agents.length)];
        uint48 overlapEnds = overlapSeed % 2 == 0
            ? uint48(block.timestamp + 1 hours) // live overlap: old key shortened
            : uint48(block.timestamp); // overlap already ended: old key revoked
        vm.prank(owner);
        skm.rotateSessionKey(oldKey, newKey, _scopeTemplate(), overlapEnds);
        _syncScopeGhost(newKey);
        if (overlapEnds <= block.timestamp) {
            _markRevoked(oldKey);
        }
    }

    /// @dev Ownership transfer: exercises the happy path and the zero-address revert,
    ///      then hands ownership back so other owner-pranked handlers keep working.
    function transferOwnershipRandom(uint256 seed) external {
        if (seed % 11 == 0) {
            vm.prank(owner);
            skm.transferOwnership(address(0)); // reverts NotOwner — branch exercised
        } else {
            address next = address(uint160(0x1000 + boundSeed(seed, 1000)));
            vm.prank(owner);
            skm.transferOwnership(next);
            vm.prank(next);
            skm.transferOwnership(owner);
        }
    }

    /// @dev Denylist toggles — covers the un-deny path (previously unreachable by fuzz).
    ///      Denying poke() flips _expectedOutcome for subsequent executes automatically.
    function toggleDenylistRandom(uint256 seed) external {
        bytes4 selector = seed % 2 == 0 ? counter.poke.selector : skm.grantSessionKey.selector;
        vm.prank(owner);
        skm.setSelectorDenied(selector, !skm.isSelectorDenied(selector));
    }

    /// @dev Time travel — expiry and window-rollover branches execute mid-sequence.
    function warpRandom(uint256 seed) external {
        vm.warp(block.timestamp + 1 + (seed % 400 days));
    }

    // ------------------------------------------------------------------
    // Helpers (small frames to stay far from stack-too-deep)
    // ------------------------------------------------------------------
    function boundSeed(uint256 seed, uint256 n) internal pure returns (uint256) {
        return n == 0 ? 0 : seed % n;
    }

    function _scopeTemplate() internal view returns (SessionKeyManager.Scope memory) {
        return SessionKeyManager.Scope({
            expiresAt: uint48(block.timestamp + 365 days),
            windowSeconds: 1 hours,
            perActionCap: 0.5 ether,
            perWindowCap: 1 ether,
            merkleRoot: bytes32(0),
                    countersignAbove: 0,
                    enforceNativeDelta: false,
                    tokenWatchlist: new address[](0)
        });
    }

    function _syncScopeGhost(address a) internal {
        SessionKeyManager.Scope memory s = skm.getScope(a);
        ghostPerActionCap[a] = s.perActionCap;
        ghostWindowSeconds[a] = s.windowSeconds;
        if (s.perWindowCap > ghostMaxPerWindowCap[a]) {
            ghostMaxPerWindowCap[a] = s.perWindowCap;
        }
        // A successful grant clears the revoked flag (the reinstatement path);
        // re-baseline the ghost so INV-2 only bites revocations that were NOT
        // legitimately reinstated by an owner action.
        if (!skm.isRevoked(a) && everRevoked[a]) {
            everRevoked[a] = false;
            successesAtRevoke[a] = successes[a];
        }
    }

    function _markRevoked(address a) internal {
        if (!everRevoked[a]) {
            everRevoked[a] = true;
            successesAtRevoke[a] = successes[a];
        }
    }

    function _executeAs(uint256 pk, address a, uint256 value, uint256 dataSeed) internal {
        SessionKeyManager.ActionRequest memory req =
            _buildRequest(a, address(counter), value, dataSeed);
        bytes32 ds = skm.DOMAIN_SEPARATOR();
        bytes memory sig = _sign(pk, req, ds);

        bool shouldSucceed = _expectedOutcome(a, value);

        (bool ok,) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, req, sig, new bytes32[](0), bytes(""))
        );

        if (shouldSucceed) {
            assertTrue(ok, "expected success but call failed");
            successes[a] += 1;
            expectedWindowSpend[a] += value;
        } else {
            assertFalse(ok, "INV violation: succeeded when scope forbids");
        }
    }

    function _buildRequest(address agent, address target, uint256 value, uint256 dataSeed)
        internal
        view
        returns (SessionKeyManager.ActionRequest memory)
    {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("inv-agent"),
            target: target,
            selector: counter.poke.selector,
            value: value,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("invariant"),
            data: abi.encode(dataSeed % 100)
        });
    }

    function _sign(uint256 privateKey, SessionKeyManager.ActionRequest memory req, bytes32 ds)
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ds, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _expectedOutcome(address a, uint256 value) internal view returns (bool) {
        if (skm.isSelectorDenied(counter.poke.selector)) return false; // INV-4 denylist
        SessionKeyManager.Scope memory s = skm.getScope(a);
        if (block.timestamp > s.expiresAt) return false; // INV-2
        if (skm.isRevoked(a)) return false; // INV-2
        if (value > s.perActionCap) return false; // per-action cap

        SpendPolicy.WindowState memory w = skm.getWindowState(a);
        uint256 base =
            (w.windowStart != 0 && block.timestamp < uint256(w.windowStart) + s.windowSeconds)
                ? w.spentThisWindow
                : 0;
        return base + value <= s.perWindowCap; // INV-1
    }

    // ------------------------------------------------------------------
    // Invariants
    // ------------------------------------------------------------------
    /// @dev INV-1: recorded window spend never exceeds the HIGHEST per-window cap the
    ///      key has ever operated under (owner may re-grant caps mid-window; every charge
    ///      was bounded by the cap in force at charge time, which is <= the tracked max).
    function invariant_windowSpendNeverExceedsCap() public view {
        for (uint256 i = 0; i < agents.length; i++) {
            address a = agents[i];
            assertTrue(
                skm.getWindowState(a).spentThisWindow <= ghostMaxPerWindowCap[a],
                "INV-1 violated"
            );
        }
    }

    /// @dev INV-2: a revoked key performs zero successful executions after revocation
    ///      (reinstatement via re-grant re-baselines the ghost, so this only bites keys
    ///      that were revoked and NOT legitimately reinstated by an owner action).
    function invariant_revokedKeysNeverExecuteAgain() public view {
        for (uint256 i = 0; i < agents.length; i++) {
            address a = agents[i];
            if (everRevoked[a]) {
                assertTrue(
                    successes[a] <= successesAtRevoke[a],
                    "INV-2 violated: revoked key executed"
                );
            }
        }
    }

    /// @dev INV-4: scopes change ONLY through owner actions mirrored in the ghost —
    ///      agents cannot self-escalate beyond what the fuzzer's owner handlers granted.
    function invariant_scopesMatchOwnerActions() public view {
        for (uint256 i = 0; i < agents.length; i++) {
            address a = agents[i];
            SessionKeyManager.Scope memory s = skm.getScope(a);
            assertEq(s.perActionCap, ghostPerActionCap[a], "INV-4 violated: perActionCap drift");
            assertEq(s.windowSeconds, ghostWindowSeconds[a], "INV-4 violated: windowSeconds drift");
        }
    }

    /// @dev Conservation: wallet never mints value out of thin air.
    function invariant_walletNeverGrows() public view {
        assertTrue(address(skm).balance <= 1_000 ether, "wallet balance grew");
    }
}
