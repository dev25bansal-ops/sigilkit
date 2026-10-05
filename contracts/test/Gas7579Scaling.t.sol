// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {SessionKey7579Module, PackedUserOperation} from "../src/SessionKey7579Module.sol";

/// @dev Minimal ERC-7579 account: installs the module and forwards `validateUserOp`.
///      A real account (Kernel, Safe{Core}) does the same in its own context, which is
///      what the module's `msg.sender == userOp.sender` gate requires.
contract ScalingAccount {
    SessionKey7579Module public module;

    constructor(SessionKey7579Module module_) {
        module = module_;
    }

    function install(bytes memory data) external {
        module.onInstall(data);
    }

    function validate(PackedUserOperation memory op, bytes32 hash) external returns (uint256) {
        return module.validateUserOp(op, hash);
    }
}

/**
 * Gas SCALING curve for ERC-7579 batch validation (PERF-4 follow-up).
 *
 * Why a second file rather than more assertions in `SessionKey7579Module.t.sol`: that
 * suite pins ONE point on the curve — the 8-tuple worst case, against a flat 120 000
 * ceiling. A single point cannot distinguish "cost grows linearly in tuples" from "cost
 * grows quadratically", because at n=8 both fit under the same number. The failure this
 * really guards against is a FUTURE edit that makes the per-tuple cost depend on the
 * batch length: a re-scan of the batch inside the loop, a re-decode of the proof tail
 * per tuple, an O(n^2) window recomputation. At n=8 such an edit could add tens of
 * thousands of gas and still squeak under a flat ceiling. The curve makes that
 * impossible, because the per-tuple ceiling is asserted at EVERY point rather than only
 * at the last one, so a rising marginal cost trips it.
 *
 * Measurement discipline (same rules as GasBudget.t.sol):
 *
 *   - `before - gasleft()` wraps ONLY the `validate` call. Building the batch, the proof
 *     tail and the signature happens outside the window, so none of the ~1.5M of in-test
 *     fixture construction is charged against the budget;
 *
 *   - every point is measured on a FRESHLY INSTALLED ACCOUNT. `validateUserOp` mutates
 *     window state, so reusing one account would make point 2 pay warm SSTOREs and
 *     point 8 pay something else again — the curve would then measure storage warmth
 *     rather than batch size. Fresh accounts make all 8 points comparable first-call
 *     costs, which is also what a real user's first op in a window looks like;
 *
 *   - every tuple carries a 4-element proof, so the per-tuple cost bounded here is the
 *     WHITELISTED one (2 `MerkleWhitelist.verify` walks per tuple: the pinned-leaf
 *     attempt fails, the wildcard leaf matches). Bounding the expensive configuration
 *     bounds the cheap one for free.
 */
contract Gas7579ScalingTest is Test {
    SessionKey7579Module internal module;

    /// @dev One installed account per batch size 1..8. Deployed in setUp so each test's
    ///      snapshot entry records only the measured validations.
    ScalingAccount[9] internal accounts;

    uint256 internal constant KEY_PK = 0xC0FFEE;
    address internal key = vm.addr(KEY_PK);

    uint48 internal constant EXPIRES_AT = 1_900_000_000;
    uint48 internal constant WINDOW_SECONDS = 600;

    /// @dev MAX_BATCH_SIZE in the module. The curve is measured 1..8 and cannot go
    ///      further: 9 reverts with MalformedExecutionData, pinned by
    ///      `test_Validate_BatchOverMaxSize_Reverts_EightStillPasses`.
    uint256 internal constant MAX_TUPLES = 8;
    /// @dev Proof elements per tuple. The tree below has 16 leaves, so it is depth 4 and
    ///      each proof is 4 elements — and 8 x 4 = 32 is exactly
    ///      MAX_TOTAL_PROOF_ELEMENTS, so the last point of the curve sits on the
    ///      proof-element boundary as well as the batch-size one.
    uint256 internal constant ELEMENTS_PER_TUPLE = 4;
    uint256 internal constant LEAF_COUNT = 16;
    uint256 internal constant TREE_DEPTH = 4;

    // ── budgets ──────────────────────────────────────────────────────────────────
    // Policy (see GasBudget.t.sol for the full rationale): a ceiling is
    // `round_up_to_1k(measured x 1.3)`, and one is only ever RAISED deliberately.
    //
    //   path                                     measured   x1.3      budget
    //   8 tuples x 4 pinned elements (32 total)   122 524   159 281   160 000
    //   8 tuples x 4 WILDCARD elements (32 total) 136 328   177 226   180 000
    //
    // Both are the PROOF-BEARING worst case (MAX_BATCH_SIZE x MAX_TOTAL_PROOF_ELEMENTS
    // reached at the same time), and the two budgets are deliberately DIFFERENT: the
    // wildcard shape costs a full extra `MerkleWhitelist.verify` walk per tuple because
    // the module tries the pinned leaf first, fails, and only then checks the wildcard.
    // Collapsing them into one number would under-bound one of the two shapes.
    //
    // For contrast, the BARE 8-tuple batch (no whitelist) measures 58 838 — see
    // `test_Gas_ValidateMaxBatch_WithinVerificationBudget` in `SessionKey7579Module.t.sol`,
    // which already budgets that shape at 120 000. The roughly 2x jump is the entire
    // cost of carrying 32 proof elements, and it is the number this file exists to
    // pin.
    //
    // PER_TUPLE_CEILING is not a measurement — it is the SHAPE assertion, and it is
    // what turns "a ceiling" into "a curve". The measured marginal cost of one extra
    // tuple is ~7 300 gas (pinned leaves); 15 000 leaves room for real growth (a richer
    // leaf format, a second selector check) while leaving no room for the O(n^2) shape
    // this file exists to catch: at n=8 a quadratic term would have to stay under
    // 7 x 15 000 = 105 000 above the base, which nothing resembling a re-scan of the
    // batch inside the loop would manage.
    uint256 internal constant PER_TUPLE_CEILING = 15_000;

    /// Pinned-leaf worst case: 8 tuples each carrying a 4-element proof, so
    /// 32 = MAX_TOTAL_PROOF_ELEMENTS reached exactly. The shape a real integration
    /// builds, and the one a bundler must afford in practice.
    uint256 internal constant BUDGET_WORST_CASE_BATCH_PINNED = 160_000;
    /// Wildcard-leaf worst case: the same batch, but every tuple pays TWO proof walks
    /// instead of one. Higher than the pinned budget by exactly the cost of the second
    /// walk, and still comfortably inside the 150-200k band a typical bundler
    /// advertises — a regression here fails in CI rather than as a silent production
    /// rejection.
    uint256 internal constant BUDGET_WORST_CASE_BATCH_WILDCARD = 180_000;

    bytes32 internal leafRoot;
    /// @dev Proof for tuple i, level 0 first (the order `_parseBatchProofs` reads them
    ///      in and `MerkleWhitelist.verify` consumes them). Precomputed in setUp so the
    ///      measured window contains the validation only.
    bytes32[][8] internal tupleProofs;
    /// @dev A second, WILDCARD-leaf tree over the same targets, plus one account
    ///      installed with it. The wildcard shape makes the module's pinned-leaf walk
    ///      fail on every tuple and fall through to a second full walk, so it costs
    ///      measurably more than the pinned shape — and a budget covering only the
    ///      cheaper one would leave that regression unbounded.
    bytes32 internal wildcardRoot;
    bytes32[][8] internal wildcardProofs;
    ScalingAccount internal wildcardAccount;

    function setUp() public {
        module = new SessionKey7579Module();

        bytes4 sel = _selector();

        // 16 v2 leaves over 16 distinct fixture targets (the 8 tuples' own
        // 0xA1..0xA8 plus 8 fillers). The fillers are what make the tree depth 4
        // rather than 3 — a depth-3 tree would only yield 3-element proofs, and
        // 8 x 3 = 24 would sit UNDER the MAX_TOTAL_PROOF_ELEMENTS boundary this file
        // must measure.
        bytes32[] memory pinned = new bytes32[](LEAF_COUNT);
        bytes32[] memory wildcard = new bytes32[](LEAF_COUNT);
        for (uint256 i = 0; i < LEAF_COUNT; ++i) {
            // PINNED (argsHash = keccak256(calldata)) is the shape the SDK actually
            // builds: the module's FIRST `MerkleWhitelist.verify` walk matches and the
            // wildcard branch never runs, so a tuple costs one walk instead of two.
            pinned[i] = keccak256(abi.encode(_tupleTarget(i), sel, _tupleDataHash()));
            // WILDCARD (argsHash == 0, "any calldata") makes the pinned attempt fail
            // first, so the module pays a second full walk before matching.
            wildcard[i] = keccak256(abi.encode(_tupleTarget(i), sel, bytes32(0)));
        }

        leafRoot = _buildTree(pinned);
        wildcardRoot = _buildTree(wildcard);

        for (uint256 i = 0; i < MAX_TUPLES; ++i) {
            tupleProofs[i] = _proofFor(pinned, i);
            wildcardProofs[i] = _proofFor(wildcard, i);
        }

        // One installed account per batch size, plus one for the wildcard shape.
        // `onInstall` grants the scope in the same transaction, so each account is a
        // genuinely fresh wallet on first use.
        for (uint256 n = 1; n <= MAX_TUPLES; ++n) {
            ScalingAccount acct = new ScalingAccount(module);
            accounts[n] = acct;
            acct.install(abi.encode(key, _scope(leafRoot)));
        }
        wildcardAccount = new ScalingAccount(module);
        wildcardAccount.install(abi.encode(key, _scope(wildcardRoot)));
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Distinct fixture target for tuple/filler `i`. The cast narrows uint256 to
    ///      address's 160 bits, and the caller only ever passes a value below 32, so
    ///      nothing can be truncated away.
    function _tupleTarget(uint256 i) internal pure returns (address) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(0xA1 + i));
    }

    function _selector() internal pure returns (bytes4) {
        // A 4-byte literal widened to bytes4 — a label change, not a truncation. The
        // batch's `data` must be at least 4 bytes for `_selectorOf` to accept it under a
        // non-zero root, so every tuple carries this selector as its calldata.
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes4(hex"12345678");
    }

    /// @dev `keccak256(calldata)` for every tuple's calldata. All tuples share the same
    ///      4-byte selector, so one value serves all of them — which is what a pinned
    ///      leaf over a shared selector looks like.
    function _tupleDataHash() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_selector()));
    }

    function _scope(bytes32 root) internal pure returns (SessionKey7579Module.Scope memory) {
        return SessionKey7579Module.Scope({
            expiresAt: EXPIRES_AT,
            windowSeconds: WINDOW_SECONDS,
            perActionCap: 0.5 ether,
            perWindowCap: 1 ether,
            merkleRoot: root
        });
    }

    function _sortedHash(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev All node levels of a sorted-pair tree over `leaves`: `[level][index]`, where
    ///      level 0 is the leaves themselves. `leaves.length` must be a power of two.
    ///
    ///      Built bottom-up into FRESH arrays rather than folded in place. An in-place
    ///      fold reads `nodes[2i]` and `nodes[2i+1]` and writes `nodes[i]`, so once
    ///      `i >= 2` the write index is a READ index of an earlier iteration: the tree
    ///      comes out wrong, and — worse for a test — wrong *consistently*, so the root
    ///      and the proofs disagree in a way that looks like a valid tree.
    function _levels(bytes32[] memory leaves) internal pure returns (bytes32[][] memory levels) {
        uint256 n = leaves.length;
        require((n & (n - 1)) == 0, "leaf count must be a power of two");

        // Level count: log2(n) + 1 (the leaves themselves, then one row per fold).
        // Derived by repeated halving rather than a `1 << depth` comparison, which the
        // linter reads as a shift whose argument order is probably a mistake.
        uint256 depth = 0;
        for (uint256 w = n; w > 1; w = w / 2) {
            depth++;
        }
        levels = new bytes32[][](depth + 1);
        levels[0] = leaves;

        for (uint256 l = 0; l < depth; ++l) {
            bytes32[] memory cur = levels[l];
            uint256 nextWidth = cur.length / 2;
            bytes32[] memory nxt = new bytes32[](nextWidth);
            for (uint256 i = 0; i < nextWidth; ++i) {
                nxt[i] = _sortedHash(cur[2 * i], cur[2 * i + 1]);
            }
            levels[l + 1] = nxt;
        }
    }

    function _buildTree(bytes32[] memory leaves) internal pure returns (bytes32 root) {
        bytes32[][] memory levels = _levels(leaves);
        return levels[levels.length - 1][0];
    }

    /// @dev The sibling path for leaf `index`, from the leaf level up to the root — the
    ///      exact element order `MerkleWhitelist.verify` consumes. The index is
    ///      right-shifted one bit per level, so the parity at each level says which
    ///      neighbour is the sibling; that is the whole reason a sorted-pair tree needs
    ///      no direction bits.
    function _proofFor(bytes32[] memory leaves, uint256 index)
        internal
        pure
        returns (bytes32[] memory proof)
    {
        bytes32[][] memory levels = _levels(leaves);
        proof = new bytes32[](TREE_DEPTH);
        for (uint256 level = 0; level < TREE_DEPTH; ++level) {
            // Our node at `level` sits at `index >> level`; the sibling is that index
            // with its low bit flipped.
            // Test fixture: `index` is a bounded loop index and the level count is
            // TREE_DEPTH, so the shift and the XOR keep the result inside `levels[level]`.
            // forge-lint: disable-next-line(unsafe-typecast)
            proof[level] = levels[level][uint160((index >> level) ^ 1)];
        }
    }

    /// @dev Narrows a loop bound / constant to the `uint16` the proof wire format uses.
    ///      Every call site passes MAX_TUPLES (8) or ELEMENTS_PER_TUPLE (4) — both far
    ///      below 2**16 — so the narrowing cannot lose information.
    function _u16(uint256 v) internal pure returns (uint16) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(v);
    }

    /// @dev The module's batch proof wire format:
    ///      [uint16 tupleCount][n x {uint16 proofLen, proofLen x bytes32}], which is
    ///      exactly what `_parseBatchProofs` reads — including its
    ///      `offset == signature.length` exact-consumption requirement.
    function _batchProofTail(uint256 tupleCount, bytes32[][8] storage proofs)
        internal
        view
        returns (bytes memory)
    {
        bytes memory tail = abi.encodePacked(_u16(tupleCount));
        for (uint256 i = 0; i < tupleCount; ++i) {
            tail = abi.encodePacked(tail, _u16(ELEMENTS_PER_TUPLE));
            for (uint256 level = 0; level < ELEMENTS_PER_TUPLE; ++level) {
                tail = abi.encodePacked(tail, proofs[i][level]);
            }
        }
        return tail;
    }

    function _batchCallData(uint256 tupleCount) internal pure returns (bytes memory) {
        SessionKey7579Module.ExecTuple[] memory calls = new SessionKey7579Module.ExecTuple[](tupleCount);
        for (uint256 i = 0; i < tupleCount; ++i) {
            calls[i] = SessionKey7579Module.ExecTuple(_tupleTarget(i), 0, abi.encodePacked(_selector()));
        }
        return abi.encodePacked(bytes32(uint256(0x01 << 248)), abi.encode(calls));
    }

    function _digestFor(address acct, bytes32 userOpHash) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("UserOp(address sender,uint256 nonce,bytes32 userOpHash)"), acct, 0, userOpHash
            )
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

    function _signFor(address acct, bytes32 userOpHash, bytes memory tail)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY_PK, _digestFor(acct, userOpHash));
        return abi.encodePacked(r, s, v, tail);
    }

    function _makeOp(bytes memory callData, bytes memory signature)
        internal
        pure
        returns (PackedUserOperation memory op)
    {
        op.sender = address(0); // overwritten by the caller before validate
        op.nonce = 0;
        op.initCode = "";
        op.callData = callData;
        op.accountGasLimits = bytes32(0);
        op.preVerificationGas = 0;
        op.gasFees = bytes32(0);
        op.paymasterAndData = "";
        op.signature = signature;
    }

    /// @dev Measures ONE validation of a `tupleCount`-tuple batch on a fresh account.
    ///      Everything except `validate` happens outside the gas window.
    function _measure(uint256 tupleCount) internal returns (uint256 used) {
        return _measureOn(accounts[tupleCount], tupleCount, tupleProofs);
    }

    /// @dev The generic form, so the wildcard tree can be measured through the same
    ///      code path (and therefore through the same op shape) as the pinned one.
    function _measureOn(ScalingAccount acct, uint256 tupleCount, bytes32[][8] storage proofs)
        internal
        returns (uint256 used)
    {
        bytes32 opHash = keccak256(abi.encode("scaling", tupleCount, address(acct)));
        PackedUserOperation memory op = _makeOp(
            _batchCallData(tupleCount), _signFor(address(acct), opHash, _batchProofTail(tupleCount, proofs))
        );
        op.sender = address(acct);

        uint256 before = gasleft();
        uint256 vd = acct.validate(op, opHash);
        used = before - gasleft();

        // authorizer=0, validUntil=scope expiry: a real validation, not a silent no-op.
        assertEq(vd, uint256(EXPIRES_AT) << 160, "batch must validate");
    }

    // ------------------------------------------------------------------
    // Test 1 — the scaling curve
    // ------------------------------------------------------------------

    /// @dev The shape assertion. For every batch size n, g(n) must stay under
    ///      `g(1) + n x PER_TUPLE_CEILING` — adding a tuple may never cost more than
    ///      PER_TUPLE_CEILING on average, checked at EVERY point rather than only at
    ///      n=8. A quadratic (or worse) per-tuple cost violates the bound at large n
    ///      while still fitting under a flat ceiling, which is exactly the regression a
    ///      single-point budget would miss.
    ///
    ///      Measured on the WHITELISTED configuration, so what is bounded is the worst
    ///      per-tuple cost rather than a degenerate one.
    function test_Gas7579_BatchScaling_MarginalCostPerTupleIsBounded() public {
        uint256[9] memory points;

        for (uint256 n = 1; n <= MAX_TUPLES; ++n) {
            points[n] = _measure(n);
            emit log_named_uint("gas: validateUserOp (n-tuple batch)", points[n]);
        }

        uint256 base = points[1];
        emit log_named_uint("gas: base (n=1)", base);

        for (uint256 n = 1; n <= MAX_TUPLES; ++n) {
            assertLt(
                points[n],
                base + n * PER_TUPLE_CEILING,
                "per-tuple marginal cost exceeded its ceiling at this batch size"
            );
        }

        // The same bound as an average, which is the number an operator actually reads:
        // what does one more call in a batch cost?
        uint256 marginal = (points[MAX_TUPLES] - base) / (MAX_TUPLES - 1);
        emit log_named_uint("gas: mean marginal cost per extra tuple", marginal);
        assertLt(marginal, PER_TUPLE_CEILING, "mean marginal cost per tuple exceeded the ceiling");
    }

    /// @dev Monotonicity: g(n) must never DECREASE as the batch grows. A flat or falling
    ///      point means the measurement is contaminated — most likely a reused account
    ///      warming a storage slot, or a tree arrangement where a bigger batch
    ///      accidentally took a cheaper path. Either way the curve above would not be
    ///      measuring batch size, and this assertion is what says so instead of letting
    ///      a bogus curve pass every other check.
    function test_Gas7579_BatchScaling_IsMonotonic() public {
        uint256[9] memory points;
        for (uint256 n = 1; n <= MAX_TUPLES; ++n) {
            points[n] = _measure(n);
        }
        for (uint256 n = 2; n <= MAX_TUPLES; ++n) {
            assertGt(
                points[n],
                points[n - 1],
                "gas must grow with batch size; a flat or falling point invalidates the measurement"
            );
        }
    }

    // ------------------------------------------------------------------
    // Test 2 — the true worst case: 8 tuples, 32 proof elements
    // ------------------------------------------------------------------

    /// @dev The shape a bundler has to afford in practice: MAX_BATCH_SIZE (8) tuples,
    ///      each carrying a 4-element proof over a PINNED leaf, so 8 x 4 = 32 =
    ///      MAX_TOTAL_PROOF_ELEMENTS reached exactly. The tree is depth 4 (16 leaves)
    ///      precisely so the per-tuple proofs are 4 elements long and the aggregate lands
    ///      ON the ceiling rather than under it.
    ///
    ///      This is the last point of the curve above, re-asserted on its own with an
    ///      ABSOLUTE ceiling. `SessionKey7579Module.t.sol` already pins the BARE
    ///      (no-whitelist) 8-tuple batch against 120 000; the ceiling here covers the
    ///      PROOF-BEARING case, which that test would not notice if an edit made proofs
    ///      expensive while leaving the bare batch cheap.
    function test_Gas7579_WorstCaseBatch_WithinVerificationBudget() public {
        assertEq(
            MAX_TUPLES * ELEMENTS_PER_TUPLE, 32, "precondition: this batch sits on MAX_TOTAL_PROOF_ELEMENTS"
        );
        assertEq(ELEMENTS_PER_TUPLE, 4, "precondition: 16 leaves = depth 4 = 4-element proofs");

        uint256 used = _measure(MAX_TUPLES);
        emit log_named_uint("gas: validateUserOp (8 tuples, 32 pinned proof elements)", used);

        assertLt(
            used, BUDGET_WORST_CASE_BATCH_PINNED, "worst-case whitelisted batch exceeded the 4337 verification budget"
        );
    }

    /// @dev The WILDCARD-leaf shape of the same worst case, which is measurably more
    ///      expensive: the module tries the pinned leaf first, walks all 4 elements,
    ///      fails, and only then walks them again for the wildcard — a second full
    ///      `MerkleWhitelist.verify` per tuple, 8 times over.
    ///
    ///      This is a REAL configuration (a selector-level whitelist entry, which is
    ///      exactly what `MerkleWhitelist`'s wildcard leaf exists for), so it needs its
    ///      own budget rather than being assumed to fall under the pinned one. Measured
    ///      at 136 350 against a 180 000 ceiling.
    function test_Gas7579_WildcardLeafBatch_WithinVerificationBudget() public {
        uint256 used = _measureOn(wildcardAccount, MAX_TUPLES, wildcardProofs);
        emit log_named_uint("gas: validateUserOp (8 tuples, 32 wildcard proof elements)", used);

        // The premise of the separate budget: the wildcard shape really is dearer. If a
        // future edit made the two shapes cost the same, the two budgets could collapse
        // into one — and this assertion is what would say so.
        uint256 pinned = _measure(MAX_TUPLES);
        assertGt(used, pinned, "wildcard leaves must cost more than pinned ones (two walks, not one)");

        assertLt(
            used,
            BUDGET_WORST_CASE_BATCH_WILDCARD,
            "worst-case wildcard batch exceeded the 4337 verification budget"
        );
    }

    /// @dev The element ceiling must remain REACHABLE-and-accepted, not merely
    ///      parseable. 32 (8 x 4) validates, and 33 — one more — is still rejected at
    ///      the aggregate count check.
    ///
    ///      Without the 33 case, someone could raise MAX_TOTAL_PROOF_ELEMENTS to 64; the
    ///      budget above would go red (correctly), and the tempting "fix" would be to
    ///      raise the budget rather than ask whether the ceiling is still the right one.
    ///      This keeps the decision anchored to the real limit.
    function test_Gas7579_ProofElementCeiling_IsStillExactly32() public {
        // 32 (8 x 4) validates — the boundary is inclusive.
        assertLt(_measure(MAX_TUPLES), BUDGET_WORST_CASE_BATCH_PINNED);

        // 33 (7 x 4 + 5) is rejected at the aggregate count check, before any Merkle
        // work, so it must fail with InvalidSignature rather than TargetNotAllowed.
        ScalingAccount acct = accounts[MAX_TUPLES];
        bytes32 opHash = keccak256("scaling-33");
        bytes memory tail = abi.encodePacked(_u16(MAX_TUPLES));
        for (uint256 i = 0; i < MAX_TUPLES; ++i) {
            uint256 elems = (i == MAX_TUPLES - 1) ? 5 : 4; // 7x4 + 5 = 33
            tail = abi.encodePacked(tail, _u16(elems));
            for (uint256 level = 0; level < elems; ++level) {
                // The 5th element of the last tuple is filler: that proof is never
                // verified, because the aggregate count check fires first. Any distinct
                // value keeps the tail well-formed.
                tail = abi.encodePacked(
                    tail, level < ELEMENTS_PER_TUPLE ? tupleProofs[i][level] : keccak256("filler")
                );
            }
        }
        PackedUserOperation memory op =
            _makeOp(_batchCallData(MAX_TUPLES), _signFor(address(acct), opHash, tail));
        op.sender = address(acct);

        vm.expectRevert(SessionKey7579Module.InvalidSignature.selector);
        acct.validate(op, opHash);
    }
}
