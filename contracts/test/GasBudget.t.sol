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

/// @dev A minimal STANDARD ERC-20 for the E11 watchlist budget. `balanceOf` is a plain
///      mapping read returning a single 32-byte word — the shape `_erc20BalanceOf` expects,
///      so the 16 staticcalls in the full-watchlist measurement are the cheap, well-behaved
///      case rather than a reentrancy or short-return accident.
contract GasWatchToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Minimal ERC-1271 validator (E17): proves control of the digest with an embedded
///      ECDSA signature and answers with the canonical left-aligned magic word. Deliberately
///      the CHEAPEST conforming shape — the ERC-1271 budget then measures the manager's own
///      overhead (prefix read, `extcodesize` gate, staticcall, length dispatch), and a real
///      validator can only cost more.
contract Gas1271Key {
    address internal immutable inner;

    constructor(address inner_) {
        inner = inner_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (signature.length != 65) return bytes4(0xffffffff);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        return ecrecover(hash, v, r, s) == inner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @dev The reentrancy probe for gap 7. Re-enters `executeWithSessionKey` from INSIDE its
///      own inner call — the only way to reach a locked manager — and records how much gas
///      the refusal cost. Gas is sampled with `gasleft()` on either side of the nested
///      call, so the number the suite reads is the cost of the REJECTION itself rather
///      than of the successful outer call that wrapped it.
contract GasReentrantTarget {
    SessionKeyManager internal immutable mgr;

    /// @notice Gas the rejected re-entrant call consumed, or `type(uint256).max` if the
    ///         re-entry did not revert (which is the failure this test exists to catch).
    uint256 public rejectGas;
    bool public reentryRejected;

    constructor(SessionKeyManager manager_) {
        mgr = manager_;
    }

    function poke(uint256) external payable {
        // The signature is deliberately EMPTY. `nonReentrant` is a MODIFIER, so the lock
        // check runs before the function body and therefore before signature recovery —
        // a re-entrant call is refused on the lock alone, and this probe must not depend
        // on holding the agent key (the target contract has no business knowing it).
        SessionKeyManager.ActionRequest memory inner = SessionKeyManager.ActionRequest({
            agentId: keccak256("gas-agent"),
            target: address(this),
            selector: this.poke.selector,
            value: 0,
            nonce: 0,
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("reentrancy probe"),
            data: abi.encode(1)
        });

        uint256 before = gasleft();
        (bool ok,) = address(mgr).call(
            abi.encodeWithSelector(
                SessionKeyManager.executeWithSessionKey.selector,
                inner,
                bytes(""),
                new bytes32[](0),
                bytes("")
            )
        );
        uint256 used = before - gasleft();

        if (ok) {
            rejectGas = type(uint256).max;
            reentryRejected = false;
        } else {
            rejectGas = used;
            reentryRejected = true;
        }
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
 * Also produced: `forge snapshot` writes `.gas-snapshot`, so `forge snapshot --check`
 * can gate drift in CI. Snapshot and assertion are complementary: the snapshot catches
 * EXACT drift, these assertions catch the coarse "this path got structurally more
 * expensive" case and keep failing with a sentence that says which one.
 *
 * ───────────────────────── BUDGET POLICY ─────────────────────────
 * Every ceiling below is `round_up_to_1k(measured × 1.3)`. Not a round number picked by
 * feel, not copied from a sibling path, and never a value carried over from a measurement
 * of a DIFFERENT configuration. The procedure, in order:
 *
 *   1. write the test measuring `before - gasleft()` around the exact call under
 *      judgement — never around the test body, so setUp deployments, tree construction
 *      and signature building stay OUTSIDE the window (a budget that includes setup is a
 *      budget that mostly measures `new Contract()`);
 *   2. run `forge test --match-contract Gas -vv` and read the `gas: …` line the test logs
 *      itself. The value on the `PASS … (gas: N)` line is the WHOLE test and is the wrong
 *      number to budget against;
 *   3. set the constant to that measurement × 1.3, rounded up to the nearest 1 000, and
 *      record BOTH numbers in the table below.
 *
 * Why 1.3: it is the gap between "a regression someone shipped" and "somebody reordered
 * two statements / bumped the optimizer / changed solc patch". A real regression is at
 * least tens of percent; ordinary churn is single-digit percent. 1.3 sits above the
 * second and below the first. A budget is an ABSOLUTE CEILING and may only be RAISED
 * deliberately, with the new measurement and its justification in the PR — that friction
 * is the entire point of the file.
 *
 * ───────────────────────── THREAT MODEL ─────────────────────────
 * Every path below is reachable by whoever controls an agent, and an agent is UNTRUSTED
 * by construction. The gas a path costs is therefore a cost the RELAYER (or a bundler, or
 * the user's own EntryPoint quota) pays on the agent's behalf, so an unbounded path is a
 * denial-of-service primitive: an agent that can make one call cost a bundler's whole
 * verification-gas budget degrades every OTHER operation sharing that EntryPoint. Each
 * budget below therefore pins the cost of a path an attacker can choose, not of the happy
 * path only.
 *
 *  · SIMPLE / WHITELISTED / NATIVE — the baseline. The static configuration is the
 *    owner's, so a growth here is a code regression, not a configuration one.
 *
 *  · MERKLE DEPTH 8 (256 leaves) — the one whitelisted path that grows with CONFIGURATION.
 *    A proof element is 32 attacker-supplied calldata bytes, and each one costs a
 *    keccak round in `MerkleWhitelist.verify` plus non-zero calldata gas (16/byte). The
 *    manager does NOT cap proof length the way the 7579 module caps
 *    MAX_SINGLE_PROOF_ELEMENTS, so the operator-visible control is the tree size the SDK
 *    builds; this budget is what makes "somebody ships a 2^16-leaf tree by default"
 *    a red test instead of a slow mainnet.
 *
 *  · E11 FULL WATCHLIST (8 tokens) — THE MOST EXPENSIVE POLICY PATH IN THE CONTRACT, and
 *    deliberately so. `enforceNativeDelta` snapshots before AND verifies after the inner
 *    call, so a full watchlist is 16 `balanceOf` staticcalls (8 before + 8 after), not 8.
 *    That costs ~28k over the empty-watchlist form of the same check (measured), and it is
 *    all cross-contract traffic that a single `enforceNativeDelta: true` grant switches on.
 *    It is the ceiling because MAX_WATCHED_TOKENS caps the list at grant time, so 8 is not
 *    an arbitrary test fixture — it is the most expensive configuration the contract
 *    permits, which is exactly what a budget must be set against.
 *
 *    CORRECTION (2026-10 audit pass): this block used to justify that choice with "a
 *    non-standard token that reverts on `balanceOf` reads as 0 and costs LESS". That was
 *    FALSE, and false in the direction that matters: `_erc20BalanceOf` is fail-CLOSED
 *    (`if (!ok || ret.length < 32) revert UnreadableWatchToken(token);`), so a
 *    non-conforming token does not read as 0 — it reverts the whole action, which is the
 *    most expensive outcome available, not the cheapest.
 *
 *    The standard-token fixture is still the expensive case, but for a different reason: it
 *    performs all 16 real staticcalls and decodes 16 real returndata words. The residual,
 *    stated rather than glossed: `balanceOf` is caller-supplied code, so a watchlisted
 *    token with a deliberately expensive `balanceOf` can cost MORE than this fixture.
 *    `MAX_WATCHED_TOKENS` bounds the watchlist's LENGTH, not the cost of the code it
 *    points at, and the list is owner-curated — so this budget is a bound on OUR side of
 *    an untrusted-token call, not a bound on the token.
 *
 *  · E10 COUNTERSIGN ACCEPTED — one extra ECDSA recovery (3 000 gas) plus two keccaks on
 *    the approval digest, against the request digest it binds. This is a deliberate cost:
 *    graduated authority is worthless if the owner's second signature is free.
 *
 *  · E10 COUNTERSIGN REJECTED — and this one is expected to be the CHEAPEST test in the
 *    file, which is the interesting part. A missing (or wrong) countersignature is a CLIENT
 *    error, so the rejection has to land before any state mutation and before the inner
 *    call: the cost should be one signature recovery plus a few SLOADs, a few tens of
 *    thousands of gas at most, and none of the 100k+ of the accepting path. If this budget
 *    is ever raised, that is not a perf regression — it means the check drifted AFTER an
 *    effect or an interaction, which is a correctness bug this assertion now reports as
 *    one. It is budgeted low deliberately: a *tight* ceiling is a second correctness
 *    assertion.
 *
 *  · ERC-1271 VERIFICATION — replaces one `ecrecover` with a `staticcall` into an
 *    arbitrary key contract whose code and cost are NOT ours (this fixture is a cheap
 *    ecrecover, so a real validator can only cost more). Budgeting the fixture measures
 *    OUR side: the 20-byte prefix read, the `extcodesize` codeless check, the call, and
 *    `_isERC1271SuccessMagic`'s length-dispatch.
 *
 *  · REENTRANCY LOCK REJECTION — the cost the protocol ABSORBS when a malicious target
 *    tries to re-enter `executeWithSessionKey` from inside its own inner call. This is a
 *    pure attack path: nobody legitimate reaches it, so it exists purely so the refusal
 *    costs the attacker a bounded, known amount instead of an unbounded one. The inner
 *    attempt is measured from INSIDE the attacking target, so the number is the true cost
 *    of the refusal rather than of the surrounding successful call.
 */
contract GasBudgetTest is Test {
    SessionKeyManager internal skm;
    GasTarget internal target;
    // Second pair for the whitelist-delta test. Deployed in setUp so the test's
    // snapshot entry records only the two measured executions, not ~2.2M of
    // in-test deployment gas.
    SessionKeyManager internal manager2;
    GasTarget internal target2;

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xB0B;
    address internal agent = vm.addr(AGENT_KEY);

    // ── budgets ──────────────────────────────────────────────────────────────────
    // Procedure and the reasoning behind the 1.3 multiplier are in the file header.
    // Every number in the right-hand column is `measured × 1.3`, rounded up to the next
    // 1 000. Measurements: solc 0.8.36, optimizer 200 runs, EVM prague, forge 1.7.1
    // (2026-09-12). `forge test --match-contract Gas -vv` prints the measured value in
    // the `gas: …` log line of each test, so a budget can always be re-derived rather
    // than trusted.
    //
    //   path                        measured   ×1.3       budget    bound
    //   simple execute                112 819   146 665   150 000   absolute (kept from the original suite)
    //   whitelisted execute           115 434   150 064   150 000   absolute (kept from the original suite)
    //   whitelist delta                 2 798     3 637     5 000   absolute (kept from the original suite)
    //   native-value execute          139 399   181 219   180 000   absolute (kept from the original suite)
    //   E11 enforceNativeDelta        113 264   147 243   150 000   absolute (new)
    //   E11 full watchlist (8 tokens) 141 427   183 855   190 000   absolute (new)
    //   E10 countersign accepted      146 448   190 382   200 000   absolute (new)
    //   E10 countersign rejected       32 334    42 034    45 000   absolute (new)
    //   ERC-1271 verification         116 423   151 350   160 000   absolute (new)
    //   Merkle depth 8 (256 leaves)   121 003   157 304   160 000   absolute (new)
    //   reentrancy lock rejection       2 977     3 870     5 000   absolute (new)
    //
    // The four original budgets are LEFT UNCHANGED even though their own × 1.3 would now
    // compute a marginally different number (139 399 × 1.3 = 181 219, just above the
    // 180 000 already in place). A budget is only ever RAISED deliberately: re-deriving
    // an existing one would silently make an unrelated PR red for no real gain, and the
    // ~0.7% slack is irrelevant next to the churn. New budgets follow the policy exactly.
    /// Baseline: one 0-value call through the full policy + audit path.
    uint256 internal constant BUDGET_SIMPLE = 150_000;
    /// Whitelisted (Merkle proof) call — measured only ~2.6k above the baseline.
    uint256 internal constant BUDGET_WHITELISTED = 150_000;
    /// Native-value call — adds the balance-delta bookkeeping.
    uint256 internal constant BUDGET_NATIVE_VALUE = 180_000;

    /// E11: `enforceNativeDelta: true` with an EMPTY watchlist. Adds one cold `BALANCE`
    /// (2 100 gas) plus a pre/post comparison — the cheapest form of the delta check, and
    /// the floor the watchlist budget is measured against. Measured 113 264, which is
    /// only ~480 above the no-E11 baseline: the BALANCE is the whole delta.
    uint256 internal constant BUDGET_E11_NATIVE_DELTA = 150_000;
    /// E11 FULL: `enforceNativeDelta: true` plus MAX_WATCHED_TOKENS (8) standard ERC-20s.
    /// 16 cross-contract `balanceOf` staticcalls, the most expensive configuration the
    /// contract permits. Measured 141 427 — only ~28k over the empty-watchlist floor,
    /// because a warm `balanceOf` mapping read is a few hundred gas; the 2 600-gas cold
    /// ACCOUNT access is per-token, and the mint already warmed the contract.
    uint256 internal constant BUDGET_E11_FULL_WATCHLIST = 190_000;
    /// E10: request above `countersignAbove` carrying a VALID owner approval. One extra
    /// ECDSA recovery (~3 000) plus two keccaks over the approval digest.
    uint256 internal constant BUDGET_E10_APPROVAL_ACCEPTED = 200_000;
    /// E10: request above `countersignAbove` with an EMPTY approval. Measured 32 334 —
    /// a fifth of the accepting path, because the refusal precedes every effect, the
    /// window charge and the inner call. Deliberately the tightest ceiling in the file.
    uint256 internal constant BUDGET_E10_APPROVAL_MISSING = 45_000;
    /// ERC-1271: session key is a contract answering `isValidSignature` with the magic.
    /// Measured 116 423 — only ~3 600 over the ECDSA baseline, i.e. the 20-byte prefix
    /// read, the `extcodesize` gate, the staticcall and the length dispatch together.
    uint256 internal constant BUDGET_ERC1271_VERIFY = 160_000;
    /// Merkle depth 8: a 256-leaf tree, so an 8-element sorted-pair proof. Measured
    /// 121 003 — and the manager does NOT cap proof length, which is exactly what this
    /// ceiling is here to police.
    uint256 internal constant BUDGET_MERKLE_DEPTH_8 = 160_000;
    /// Reentrancy lock: a malicious target re-enters `executeWithSessionKey` from inside
    /// its own inner call and is refused. Measured 2 977 — one cold SLOAD of the lock
    /// flag and a revert, because `nonReentrant` is a MODIFIER and the check therefore
    /// runs before signature recovery, nonce writes, caps and the inner call.
    uint256 internal constant BUDGET_REENTRANCY_REJECT = 5_000;

    SessionKeyManager.Scope internal scope;

    function setUp() public {
        vm.warp(1_700_000_000);
        skm = new SessionKeyManager(vm.addr(OWNER_KEY));
        target = new GasTarget();
        vm.deal(address(skm), 100 ether);

        manager2 = new SessionKeyManager(vm.addr(OWNER_KEY));
        target2 = new GasTarget();
        vm.deal(address(manager2), 100 ether);

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

    /// @dev Grants `s` to the agent on the primary manager, then restores `scope` so a
    ///      caller can pass a variant without leaking it into the shared setUp field.
    function _grantScope(SessionKeyManager.Scope memory s) internal {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(agent, s);
    }

    /// @dev Grants `s` to an arbitrary key address (the ERC-1271 case, where the key IS a
    ///      contract the owner has authorized by address).
    function _grantScopeAt(SessionKeyManager.Scope memory s, address key_) internal {
        vm.prank(vm.addr(OWNER_KEY));
        skm.grantSessionKey(key_, s);
    }

    /// @dev E10: the owner's countersignature over `RequestApproval(requestDigest)`, which
    ///      binds the FULL request digest and is therefore single-use by nonce uniqueness.
    ///      Mirrors `SessionKeyManager`'s own `_domainSeparator` / `REQUEST_APPROVAL_TYPEHASH`
    ///      so the recovery below exercises the real branch, not a stand-in.
    function _signApproval(SessionKeyManager.ActionRequest memory req) internal view returns (bytes memory) {
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
        bytes32 requestDigest =
            keccak256(abi.encodePacked("\x19\x01", skm.DOMAIN_SEPARATOR(), structHash));
        bytes32 approvalDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                skm.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(skm.REQUEST_APPROVAL_TYPEHASH(), requestDigest)),
                vm.addr(AGENT_KEY)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, approvalDigest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev A 256-leaf (depth-8) sorted-pair Merkle tree over wildcard v2 leaves
    ///      (`argsHash == 0` — "any calldata for this target+selector"), returning the
    ///      root and the 8-element proof for the leaf at `index`. Mirrors the SDK /
    ///      `MerkleWhitelist` convention exactly: `leaf = keccak256(abi.encode(target,
    ///      selector, argsHash))`, `pair = keccak256(abi.encodePacked(lo, hi))` sorted.
    ///
    ///      Leaf `0` is built over the REAL target/selector the request will use, so the
    ///      proof genuinely verifies; the other 255 leaves are distinct filler entries
    ///      derived from the loop index, which is what makes the tree 256 leaves deep 8
    ///      instead of a 1-leaf stub. `argsHash == 0` is the wildcard form, so the caller
    ///      need not pin the exact calldata to measure proof LENGTH — and the manager's
    ///      pinned-leaf attempt fails first, which is the realistic worst case.
    function _depth8Tree(address target_, bytes4 selector_, uint256 index)
        internal
        pure
        returns (bytes32 root, bytes32[] memory proof)
    {
        bytes32[256] memory leaves;
        leaves[0] = keccak256(abi.encode(target_, selector_, bytes32(0)));
        for (uint256 i = 1; i < 256; ++i) {
            // Test fixture: distinct filler leaves. The cast is a widening of a bounded
            // loop index, so no information can be truncated away.
            // forge-lint: disable-next-line(unsafe-typecast)
            leaves[i] = keccak256(abi.encode(address(uint160(i + 1)), selector_, bytes32(0)));
        }

        // Bottom-up fold, one level per iteration. At each level the sibling of the node
        // on our path is recorded BEFORE the level is folded, so the collected siblings
        // are already in root-order and need no reversal.
        proof = new bytes32[](8);
        for (uint256 level = 0; level < 8; ++level) {
            uint256 idx = index >> level; // our node's position at this level
            proof[level] = leaves[idx % 2 == 0 ? idx + 1 : idx - 1];
            uint256 pairs = 256 / (2 ** (level + 1));
            for (uint256 i = 0; i < pairs; ++i) {
                // `i <= 2i`, so each write lands at or behind the next pair's reads.
                leaves[i] = _sortedHash(leaves[2 * i], leaves[2 * i + 1]);
            }
        }
        return (leaves[0], proof);
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

        // Same call under a 2-leaf whitelist, on a fresh manager so both measurements stay
        // cold-storage "first executions" and the delta isolates the whitelist check.
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

    // ══════════════════════════════════════════════════════════════════════════
    // Gap 1 — E11 `enforceNativeDelta: true`, empty watchlist
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Gap 1 of the gas-coverage review. `enforceNativeDelta: true` adds a
    ///      pre-call `BALANCE` snapshot and a post-call comparison, neither of which the
    ///      baseline test exercised — so this whole branch was unpriced. A 0-value call is
    ///      the cheapest instance, which is what makes it a usable FLOOR for the watchlist
    ///      budget below: the difference between the two measurements is then attributable
    ///      to the watchlist alone.
    function test_Gas_E11EnforceNativeDelta_WithinBudget() public {
        SessionKeyManager.Scope memory s = scope;
        s.enforceNativeDelta = true;
        s.tokenWatchlist = new address[](0);
        _grantScope(s);

        SessionKeyManager.ActionRequest memory req = _request(0, abi.encode(1));
        bytes memory sig = _sign(AGENT_KEY, req);

        uint256 before = gasleft();
        skm.executeWithSessionKey(req, sig, new bytes32[](0), "");
        uint256 used = before - gasleft();

        emit log_named_uint("gas: E11 enforceNativeDelta (no watchlist)", used);
        assertEq(target.count(), 1, "inner call must have landed");
        assertLt(used, BUDGET_E11_NATIVE_DELTA, "E11 native-delta execute exceeded its gas budget");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Gap 2 — E11 with the watchlist at MAX_WATCHED_TOKENS (8)
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Gap 2, and the single most expensive configuration the contract permits.
    ///      `_snapshotBalances` reads `balanceOf` on all 8 tokens BEFORE the inner call and
    ///      `_verifyBalances` reads all 8 again AFTER it — 16 cross-contract staticcalls,
    ///      not 8. Each of the 8 token accounts is cold the first time it is touched
    ///      (2 600 gas of account access) even though the wallet's own balance slots were
    ///      warmed by the mint, so this is the realistic worst case rather than a
    ///      best-case one.
    ///
    ///      MAX_WATCHED_TOKENS caps the list at grant time, so "8 tokens" is not a fixture
    ///      choice but the hard maximum — which is exactly what a budget must be measured
    ///      against. These standard tokens are the expensive case because all 16 reads are
    ///      real staticcalls returning real data. (A non-conforming token does NOT read as
    ///      0 — `_erc20BalanceOf` is fail-closed and reverts; see the correction in this
    ///      file's threat model.)
    function test_Gas_E11FullWatchlist_WithinBudget() public {
        address[] memory watch = new address[](8);
        for (uint256 i = 0; i < watch.length; ++i) {
            GasWatchToken token = new GasWatchToken();
            // 8 distinct token contracts: cold-account access is per-token, so sharing one
            // contract across the list would under-measure by ~8 x 2 600 gas.
            vm.deal(address(token), 0); // no-op; keeps the mint the only state write
            token.mint(address(skm), 1_000_000e18);
            watch[i] = address(token);
        }

        SessionKeyManager.Scope memory s = scope;
        s.enforceNativeDelta = true;
        s.tokenWatchlist = watch;
        _grantScope(s);

        SessionKeyManager.ActionRequest memory req = _request(0, abi.encode(1));
        bytes memory sig = _sign(AGENT_KEY, req);

        uint256 before = gasleft();
        skm.executeWithSessionKey(req, sig, new bytes32[](0), "");
        uint256 used = before - gasleft();

        emit log_named_uint("gas: E11 full watchlist (8 tokens)", used);
        assertEq(target.count(), 1, "inner call must have landed");
        assertLt(used, BUDGET_E11_FULL_WATCHLIST, "E11 full-watchlist execute exceeded its gas budget");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Gap 3 — E10 graduated authority, accepted vs rejected
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Gap 3a: the countersignature is PRESENT and valid. Costs one extra ECDSA
    ///      recovery plus two keccaks over the approval digest that binds the request
    ///      digest — a deliberate price, since graduated authority is worthless if the
    ///      owner's second signature is free.
    function test_Gas_E10CountersignAccepted_WithinBudget() public {
        SessionKeyManager.Scope memory s = scope;
        s.countersignAbove = 0.5 ether;
        s.perActionCap = 1 ether; // already 1 ether in setUp
        _grantScope(s);

        SessionKeyManager.ActionRequest memory req = _request(0.75 ether, abi.encode(1));
        bytes memory sig = _sign(AGENT_KEY, req);
        bytes memory approval = _signApproval(req);

        uint256 before = gasleft();
        skm.executeWithSessionKey(req, sig, new bytes32[](0), approval);
        uint256 used = before - gasleft();

        emit log_named_uint("gas: E10 countersign accepted", used);
        assertEq(target.count(), 1, "inner call must have landed");
        assertLt(used, BUDGET_E10_APPROVAL_ACCEPTED, "E10 accepted-countersign execute exceeded its gas budget");
    }

    /// @dev Gap 3b, and the only budget in this file that is expected to be the TIGHTEST
    ///      relative to what the path *could* cost. A missing countersignature is a CLIENT
    ///      error, and the check sits before every effect and before the inner call, so
    ///      the rejection must cost a signature recovery and a handful of SLOADs — nothing
    ///      like the 100k+ of the accepting path above.
    ///
    ///      This is why it is budgeted low ON PURPOSE: a tight ceiling is a second
    ///      correctness assertion. If the check ever drifts after an effect or an
    ///      interaction, the extra cost shows up here and the failure says "the rejection
    ///      path got expensive", which is the same fact stated as a perf number.
    function test_Gas_E10CountersignMissing_IsCheapRejection() public {
        SessionKeyManager.Scope memory s = scope;
        s.countersignAbove = 0.5 ether;
        _grantScope(s);

        SessionKeyManager.ActionRequest memory req = _request(0.75 ether, abi.encode(1));
        bytes memory sig = _sign(AGENT_KEY, req);

        uint256 before = gasleft();
        // Computed BEFORE expectRevert (view calls inside consume the cheatcode).
        vm.expectRevert(SessionKeyManager.OwnerCountersignRequired.selector);
        skm.executeWithSessionKey(req, sig, new bytes32[](0), "");
        uint256 used = before - gasleft();

        emit log_named_uint("gas: E10 countersign missing (revert)", used);
        // The nonce must NOT have advanced: the rejection has to precede the effect.
        assertEq(skm.getNonce(agent), 0, "rejected countersign must not consume the nonce");
        assertLt(used, BUDGET_E10_APPROVAL_MISSING, "E10 rejection path is too expensive");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Gap 4 — ERC-1271 (E17) verification path
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Gap 4. A non-65-byte signature is an ERC-1271 smart-account session key:
    ///      `address(keyContract) || 1271Signature`. The manager reads the 20-byte prefix,
    ///      gates on `extcodesize != 0`, `staticcall`s `isValidSignature`, and runs
    ///      `_isERC1271SuccessMagic`'s length dispatch. `Gas1271Key` is the cheapest
    ///      conforming validator (a single ecrecover), so this number is the manager's own
    ///      overhead and a real validator can only cost more.
    function test_Gas_ERC1271Verification_WithinBudget() public {
        Gas1271Key keyContract = new Gas1271Key(agent);
        // The owner grants the scope to the 1271 CONTRACT's address, not the inner key.
        _grantScopeAt(scope, address(keyContract));

        SessionKeyManager.ActionRequest memory req = _request(0, abi.encode(1));
        // Sign the digest with the agent key; the manager learns the key contract from the
        // 20-byte prefix and asks IT to prove control of the same digest.
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, digest);
        // Packed mode is capped at two values per call, so the 85-byte wire signature
        // (20-byte key-contract prefix || 65-byte ECDSA) is assembled in steps.
        bytes memory sig = abi.encodePacked(address(keyContract), r);
        sig = abi.encodePacked(sig, s, v);

        uint256 before = gasleft();
        skm.executeWithSessionKey(req, sig, new bytes32[](0), "");
        uint256 used = before - gasleft();

        emit log_named_uint("gas: ERC-1271 verification", used);
        assertEq(target.count(), 1, "inner call must have landed");
        assertLt(used, BUDGET_ERC1271_VERIFY, "ERC-1271 verification exceeded its gas budget");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Gap 5 — Merkle depth 8 (a 256-leaf tree, an 8-element proof)
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Gap 5. The one whitelisted path that grows with CONFIGURATION rather than with
    ///      code: a proof element is 32 attacker-supplied calldata bytes, each costing a
    ///      keccak round in `MerkleWhitelist.verify` plus 16 gas/byte of calldata. The
    ///      manager does not cap proof length the way the 7579 module caps
    ///      MAX_SINGLE_PROOF_ELEMENTS, so the operator-visible control is the tree size the
    ///      SDK builds — and this budget is what turns "somebody ships a 2^16-leaf tree by
    ///      default" into a red test instead of a slow mainnet.
    ///
    ///      Leaf 0 is the request's own (target, selector) wildcard leaf, so the proof is
    ///      GENUINE: the pinned-leaf verification fails and the wildcard branch runs, which
    ///      is the realistic worst case (2 `verify` walks over 8 elements each). A 1.3×
    ///      margin still only permits ~150k, so an 8-element proof at ~120k cannot silently
    ///      accommodate a 2^16-leaf default.
    function test_Gas_MerkleDepth8_WithinBudget() public {
        (bytes32 root, bytes32[] memory proof) =
            _depth8Tree(address(target), target.poke.selector, 0);

        assertEq(proof.length, 8, "precondition: a 256-leaf tree yields a depth-8 proof");
        SessionKeyManager.Scope memory s = scope;
        s.merkleRoot = root;
        _grantScope(s);

        SessionKeyManager.ActionRequest memory req = _request(0, abi.encode(1));
        bytes memory sig = _sign(AGENT_KEY, req);

        uint256 before = gasleft();
        skm.executeWithSessionKey(req, sig, proof, "");
        uint256 used = before - gasleft();

        emit log_named_uint("gas: Merkle depth 8 (256 leaves)", used);
        assertEq(target.count(), 1, "inner call must have landed");
        assertLt(used, BUDGET_MERKLE_DEPTH_8, "Merkle depth-8 execute exceeded its gas budget");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Gap 7 — reentrancy lock rejection (a pure attack path)
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Gap 7. A malicious target re-enters `executeWithSessionKey` from inside its own
    ///      inner call. The number measured is the cost of the REFUSAL, sampled from inside
    ///      the attacking target with `gasleft()` on either side of the nested call — not
    ///      the cost of the successful outer call that wrapped it, which is what a
    ///      test-body-level measurement would have reported.
    ///
    ///      `nonReentrant` is a modifier, so the lock check precedes signature recovery:
    ///      the nested call carries an EMPTY signature and is refused on the lock alone.
    ///      That is exactly why the target needs no copy of the agent key, and it is also
    ///      the reason this path must stay cheap — a refusal that ran the full policy path
    ///      first would let an attacker pay for work it never needed.
    function test_Gas_ReentrancyLockRejection_WithinBudget() public {
        _grant();
        GasReentrantTarget attacker = new GasReentrantTarget(skm);

        SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
            agentId: keccak256("gas-agent"),
            target: address(attacker),
            selector: attacker.poke.selector,
            value: 0,
            nonce: skm.getNonce(agent),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("gas budget measurement"),
            data: abi.encode(1)
        });
        bytes memory sig = _sign(AGENT_KEY, req);

        // The outer call is deliberately NOT budgeted: it is a legal, ordinary execution
        // and is already covered by BUDGET_SIMPLE. What is under judgement is the nested
        // attempt, which the target samples and records for us.
        skm.executeWithSessionKey(req, sig, new bytes32[](0), "");

        emit log_named_uint("gas: reentrancy lock rejection", attacker.rejectGas());
        assertTrue(attacker.reentryRejected(), "the re-entrant call must be refused by the lock");
        assertLt(attacker.rejectGas(), BUDGET_REENTRANCY_REJECT, "reentrancy refusal is too expensive");
    }
}
