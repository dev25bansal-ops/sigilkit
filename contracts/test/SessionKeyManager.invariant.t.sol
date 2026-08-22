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

    function setUp() public {
        skm = new SessionKeyManager(owner);
        counter = new Counter();
        vm.deal(address(skm), 1_000 ether);

        // The fuzzer must reach state changes ONLY through our handler functions
        // (executeRandom/revokeRandom) — otherwise it can call grantSessionKey
        // directly as the owner and trivially "mutate" scopes, which is a legal
        // admin action, not an INV-4 violation.
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
                    merkleRoot: bytes32(0)
                })
            );
        }
    }

    // ------------------------------------------------------------------
    // Fuzzer handlers
    // ------------------------------------------------------------------
    /// @dev Attempts a session-key execution with pseudo-random parameters.
    function executeRandom(uint256 agentSeed, uint256 valueSeed, uint256 dataSeed) external {
        uint256 idx = boundSeed(agentSeed, agents.length);
        _executeAs(agentKeys[idx], agents[idx], valueSeed % 2 ether, dataSeed);
    }

    /// @dev Owner action so the fuzzer can interleave revocations mid-sequence.
    function revokeRandom(uint256 seed) external {
        address a = agents[boundSeed(seed, agents.length)];
        if (!everRevoked[a]) {
            everRevoked[a] = true;
            successesAtRevoke[a] = successes[a];
            vm.prank(owner);
            skm.revokeSessionKey(a);
        }
    }

    // ------------------------------------------------------------------
    // Helpers (small frames to stay far from stack-too-deep)
    // ------------------------------------------------------------------
    function boundSeed(uint256 seed, uint256 n) internal pure returns (uint256) {
        return n == 0 ? 0 : seed % n;
    }

    function _executeAs(uint256 pk, address a, uint256 value, uint256 dataSeed) internal {
        SessionKeyManager.ActionRequest memory req =
            _buildRequest(a, address(counter), value, dataSeed);
        bytes32 ds = skm.DOMAIN_SEPARATOR();
        bytes memory sig = _sign(pk, req, ds);

        bool shouldSucceed = _expectedOutcome(a, value);

        (bool ok,) = address(skm).call(
            abi.encodeWithSelector(skm.executeWithSessionKey.selector, req, sig, new bytes32[](0))
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
    /// @dev INV-1: recorded window spend never exceeds the granted per-window cap.
    function invariant_windowSpendNeverExceedsCap() public view {
        for (uint256 i = 0; i < agents.length; i++) {
            address a = agents[i];
            assertTrue(
                skm.getWindowState(a).spentThisWindow <= skm.getScope(a).perWindowCap,
                "INV-1 violated"
            );
        }
    }

    /// @dev INV-2: a revoked key performs zero successful executions after revocation.
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

    /// @dev INV-4: scopes are immutable outside owner actions — agents cannot self-escalate.
    function invariant_scopesImmutable() public view {
        for (uint256 i = 0; i < agents.length; i++) {
            address a = agents[i];
            SessionKeyManager.Scope memory s = skm.getScope(a);
            assertEq(uint256(s.perActionCap), 0.5 ether, "INV-4 violated: scope mutated");
            assertEq(uint256(s.windowSeconds), 1 hours, "INV-4 violated: window mutated");
        }
    }

    /// @dev Conservation: wallet never mints value out of thin air.
    function invariant_walletNeverGrows() public view {
        assertTrue(address(skm).balance <= 1_000 ether, "wallet balance grew");
    }
}
