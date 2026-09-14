// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @dev Minimal target; the gas cost of the *policy* path is what this suite measures,
///      so the target deliberately does almost nothing.
contract GasTarget {
    uint256 public count;

    function poke(uint256 by) external payable returns (uint256) {
        count += by;
        return count;
    }
}

/**
 * Gas budgets for the enforcement hot path (PERF-4).
 *
 * Why this exists: the repo shipped no gas snapshot and no gas assertion anywhere, so a
 * regression in `executeWithSessionKey` — or a deeper Merkle tree, or a fuller ERC-4337
 * batch — could push validation past a bundler's verification-gas ceiling with no CI
 * signal at all. The whitelist path is the one that grows with configuration (tree depth),
 * so it is budgeted explicitly.
 *
 * The numbers are absolute ceilings, not snapshots: they must be raised deliberately,
 * with a justification in the PR, which is the point.
 *
 * Also produced: `forge snapshot` writes `.gas-snapshot`, so `forge snapshot --check`
 * can gate drift in CI.
 */
contract GasBudgetTest is Test {
    SessionKeyManager internal skm;
    GasTarget internal target;

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xB0B;
    address internal agent = vm.addr(AGENT_KEY);

    // ── budgets ──────────────────────────────────────────────────────────────────
    // Measured 2026-09-12 (solc 0.8.36, optimizer default, Foundry 1.7.x):
    //   simple execute     112,805
    //   whitelisted        115,418
    //   whitelist delta         69   (one sorted-pair hash for a 1-element proof)
    //   native value       see test (forwarded from the wallet's own balance)
    // Budgets sit ~30% above measurement: a real regression trips them, ordinary
    // refactors do not.
    /// Baseline: one 0-value call through the full policy + audit path.
    uint256 internal constant BUDGET_SIMPLE = 150_000;
    /// Whitelisted (Merkle proof) call — measured only ~2.6k above the baseline.
    uint256 internal constant BUDGET_WHITELISTED = 150_000;
    /// Native-value call — adds the balance-delta bookkeeping.
    uint256 internal constant BUDGET_NATIVE_VALUE = 180_000;

    SessionKeyManager.Scope internal scope;

    function setUp() public {
        vm.warp(1_700_000_000);
        skm = new SessionKeyManager(vm.addr(OWNER_KEY));
        target = new GasTarget();
        vm.deal(address(skm), 100 ether);

        scope = SessionKeyManager.Scope({
            expiresAt: uint48(block.timestamp + 1 days),
            windowSeconds: 1 hours,
            perActionCap: 1 ether,
            perWindowCap: 5 ether,
            merkleRoot: bytes32(0),
            countersignAbove: 0,
            enforceNativeDelta: false,
            tokenWatchlist: new address[](0)
        });
    }

    // ── helpers ──────────────────────────────────────────────────────────────────

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
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", skm.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _request(uint256 value, bytes memory data)
        internal
        view
        returns (SessionKeyManager.ActionRequest memory)
    {
        return SessionKeyManager.ActionRequest({
            agentId: keccak256("gas-agent"),
            target: address(target),
            selector: target.poke.selector,
            value: value,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("gas budget measurement"),
            data: data
        });
    }

    function _sortedHash(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _grant() internal {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, scope);
    }

    // ── tests ────────────────────────────────────────────────────────────────────

    /// @dev The headline budget: everything a session key can do costs less than this.
    function test_Gas_SimpleExecute_WithinBudget() public {
        _grant();
        SessionKeyManager.ActionRequest memory req = _request(0, abi.encode(1));
        bytes memory sig = _sign(AGENT_KEY, req);

        uint256 before = gasleft();
        skm.executeWithSessionKey(req, sig, new bytes32[](0), "");
        uint256 used = before - gasleft();

        emit log_named_uint("gas: simple execute", used);
        assertLt(used, BUDGET_SIMPLE, "simple execute exceeded its gas budget");
    }

    /// @dev A whitelist adds a Merkle verification; the budget bounds that addition.
    function test_Gas_WhitelistedExecute_WithinBudget() public {
        bytes32 leafSelf = keccak256(abi.encode(address(target), target.poke.selector, bytes32(0)));
        bytes32 leafOther = keccak256(abi.encode(address(0xDEAD), bytes4(0xdeadbeef), bytes32(0)));
        scope.merkleRoot = _sortedHash(leafSelf, leafOther);
        _grant();

        SessionKeyManager.ActionRequest memory req = _request(0, abi.encode(1));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafOther;
        bytes memory sig = _sign(AGENT_KEY, req);

        uint256 before = gasleft();
        skm.executeWithSessionKey(req, sig, proof, "");
        uint256 used = before - gasleft();

        emit log_named_uint("gas: whitelisted execute", used);
        assertLt(used, BUDGET_WHITELISTED, "whitelisted execute exceeded its gas budget");
    }

    /// @dev Native value moves real ETH from the wallet's own balance — the relayer sends
    ///      none, so `msg.value` must stay 0 (the contract reverts `ValueNotAccepted`
    ///      otherwise). The balance-delta bookkeeping must stay bounded.
    function test_Gas_NativeValueExecute_WithinBudget() public {
        _grant();
        SessionKeyManager.ActionRequest memory req = _request(0.01 ether, abi.encode(1));
        bytes memory sig = _sign(AGENT_KEY, req);

        uint256 before = gasleft();
        skm.executeWithSessionKey(req, sig, new bytes32[](0), "");
        uint256 used = before - gasleft();

        emit log_named_uint("gas: native-value execute", used);
        assertEq(target.count(), 1, "inner call must have landed");
        assertLt(used, BUDGET_NATIVE_VALUE, "native-value execute exceeded its gas budget");
    }

    /// @dev Documents the incremental cost of the whitelist check, so a future regression
    ///      in MerkleWhitelist.verify shows up as a *delta* failure rather than noise.
    function test_Gas_WhitelistDelta_IsBounded() public {
        // Baseline (no whitelist).
        _grant();
        SessionKeyManager.ActionRequest memory plain = _request(0, abi.encode(1));
        bytes memory sigPlain = _sign(AGENT_KEY, plain);
        uint256 before = gasleft();
        skm.executeWithSessionKey(plain, sigPlain, new bytes32[](0), "");
        uint256 plainGas = before - gasleft();

        // Same call under a 2-leaf whitelist.
        SessionKeyManager manager2 = new SessionKeyManager(vm.addr(OWNER_KEY));
        vm.deal(address(manager2), 100 ether);
        GasTarget target2 = new GasTarget();
        SessionKeyManager.Scope memory scope2 = scope;
        bytes32 leafSelf = keccak256(abi.encode(address(target2), target2.poke.selector, bytes32(0)));
        bytes32 leafOther = keccak256(abi.encode(address(0xDEAD), bytes4(0xdeadbeef), bytes32(0)));
        scope2.merkleRoot = _sortedHash(leafSelf, leafOther);
        vm.prank(vm.addr(OWNER_KEY));
        manager2.grantSessionKey(agent, scope2);

        SessionKeyManager.ActionRequest memory wreq = SessionKeyManager.ActionRequest({
            agentId: keccak256("gas-agent"),
            target: address(target2),
            selector: target2.poke.selector,
            value: 0,
            nonce: manager2.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("gas budget measurement"),
            data: abi.encode(1)
        });
        bytes32 structHash = keccak256(
            abi.encode(
                manager2.ACTION_REQUEST_TYPEHASH(),
                wreq.agentId,
                wreq.target,
                wreq.selector,
                wreq.value,
                wreq.nonce,
                wreq.expiry,
                wreq.rationaleHash,
                keccak256(wreq.data)
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", manager2.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, digest);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafOther;

        before = gasleft();
        manager2.executeWithSessionKey(wreq, abi.encodePacked(r, s, v), proof, "");
        uint256 whitelistedGas = before - gasleft();

        emit log_named_uint("gas: plain", plainGas);
        emit log_named_uint("gas: whitelisted", whitelistedGas);
        emit log_named_uint("gas: whitelist delta", whitelistedGas - plainGas);
        // A 1-element proof is ONE sorted-pair keccak (measured 69 gas). Bounding the
        // delta catches an accidental O(depth) or O(n) blowup that the absolute budget
        // above would absorb.
        assertLt(whitelistedGas - plainGas, 5_000, "whitelist check delta is too large");
    }
}
