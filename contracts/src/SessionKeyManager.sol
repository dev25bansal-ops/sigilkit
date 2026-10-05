// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SpendPolicy} from "./SpendPolicy.sol";
import {MerkleWhitelist} from "./MerkleWhitelist.sol";
import {ActionLogger} from "./ActionLogger.sol";

/// @title SessionKeyManager
/// @notice Agent-first session-key manager: scoped keys with on-chain spend caps,
///         fixed-window (tumbling) rate limits, Merkle target whitelists, and a mandatory
///         audit event per executed action.
/// @dev Security model:
///      - The agent (session key holder) is treated as UNTRUSTED. A compromised agent or SDK
///        cannot exceed the granted scope: caps are enforced here, not off-chain.
///      - Owner-only functions are unreachable through executeWithSessionKey (INV-4): they are
///        gated by onlyOwner, and additionally every selector in `ownerOnlySelectors` is denied
///        to session keys even when targeting other contracts.
///      - Every successful inner call emits ActionLogged (INV-3); there is no silent success path.
///      - Storage uses an ERC-7201 namespaced slot so the manager can sit behind proxies or
///        coexist with facet storage without collision.
contract SessionKeyManager is ActionLogger {
    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error NotOwner();
    error KeyUnknown();
    error KeyRevoked();
    error KeyExpired();
    error RequestExpired();
    error NonceUsed();
    error SelectorDenied(bytes4 selector);
    error TargetNotAllowed(address target, bytes4 selector);
    error InnerCallFailed();
    error ValueNotAccepted();
    error InvalidScope();
    error InvalidSignature();
    error OverlapBeyondOldExpiry();
    error WithdrawFailed();
    error OwnerCountersignRequired();
    error InvalidOwnerApproval();
    error NativeDeltaExceeded(uint256 balanceBefore, uint256 balanceAfter, uint256 declared);
    error UnreadableWatchToken(address token);

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------
    /// @notice Scope granted to a session key. Every field is fixed at grant time
    ///         EXCEPT `expiresAt`, which `rotateSessionKey` may shorten to `overlapEnds`.
    struct Scope {
        uint48 expiresAt; // hard expiry; must be in the future at grant time
        uint48 windowSeconds; // fixed (tumbling) window length for the spend cap
        uint256 perActionCap; // max native value per single action
        uint256 perWindowCap; // max cumulative native value per fixed (tumbling) window
        bytes32 merkleRoot; // root over keccak(target,selector,argsHash) leaves (v2: argsHash binds calldata, 0 = wildcard); 0 = allow ALL (dangerous)
        uint256 countersignAbove; // E10: actions with value > this need an owner approval signature; 0 = never
        /// @notice E11 MASTER SWITCH. When true, the inner call must not siphon native value
        ///         beyond `value`, AND every token in `tokenWatchlist` must not net-decrease
        ///         beyond its declared amount.
        /// @dev THIS IS THE MASTER SWITCH FOR `tokenWatchlist`, NOT AN INDEPENDENT FLAG. The
        ///      two E11 halves are gated by this ONE boolean: both `_snapshotBalances` and
        ///      `_verifyBalances` return early when it is false, so with it false the
        ///      watchlist is never read, never snapshotted, and never compared — the E11
        ///      guarantee is not weakened, it is ENTIRELY ABSENT. There is no second
        ///      configuration in which `tokenWatchlist` does anything on its own.
        ///
        ///      A non-empty watchlist with this flag off is therefore NOT a "weaker
        ///      setting" — it is a NO-OP that still LOOKS like a configured guarantee, and
        ///      `_validateScope` deliberately does not reject it (see the comment at
        ///      `_validateScope` and the test pinned there). An owner who filled in a
        ///      watchlist must therefore confirm this flag is true, because the E11
        ///      guarantee they believe they configured is not merely bypassable while this
        ///      is false — it was never running.
        ///
        ///      Set it to true to use the watchlist; leave both at their defaults
        ///      (false / empty) to disable E11 entirely. Those are the only two meaningful
        ///      configurations.
        bool enforceNativeDelta;
        /// @notice E11: up to 8 tokens whose balances must not net-decrease beyond declared
        ///         amounts.
        /// @dev ONLY EFFECTIVE WHEN `enforceNativeDelta == true`. When that flag is false this
        ///      list is COMPLETELY IGNORED — it is stored, returned verbatim by `getScope`,
        ///      and read by nobody.
        ///
        ///      "Ignored" here means NOT EVEN READ, which is a materially stronger statement
        ///      than "read but not enforced", and the difference is load-bearing. `_erc20BalanceOf`
        ///      is FAIL-CLOSED: it reverts `UnreadableWatchToken` when the call fails or returns
        ///      fewer than 32 bytes. So for a list that WAS read, one hostile or
        ///      non-conforming entry would revert the action and make the whole scope unusable.
        ///      Because with this flag false the list is never read, an unreadable entry in it
        ///      CANNOT cause a revert — the difference between "ignored" and "fail-closed" is
        ///      exactly what the pinned test below protects.
        ///
        ///      This is deliberate and test-pinned, NOT an oversight:
        ///      `E11WatchlistRead.t.sol :: test_EnforceNativeDeltaFalse_UnaffectedByHostileWatchlist`
        ///      requires that a hostile/unreadable entry changes nothing when E11 is off, so
        ///      that populating this field can never turn an E11-off grant into a denial of
        ///      service. The cost of that decision is that a watchlist written under a disabled
        ///      `enforceNativeDelta` is quietly inert — so the pairing must be checked when the
        ///      scope is written, not when it is used.
        address[] tokenWatchlist;
    }

    /// @notice EIP-712 signed action request.
    struct ActionRequest {
        bytes32 agentId;
        address target;
        bytes4 selector;
        uint256 value;
        uint256 nonce;
        uint48 expiry; // request-level expiry (<= key expiry recommended)
        bytes32 rationaleHash; // hash of off-chain rationale; plaintext never on-chain
        bytes data; // calldata suffix appended after `selector`
    }

    using SpendPolicy for SpendPolicy.WindowState;

    // ERC-7201 namespaced storage slot (cast index-erc7201 "sigilkit.storage.SessionKeyManager").
    bytes32 private constant _STORAGE_LOCATION =
        0xff085e2083c01c9e351b5b4768e82a6e2037764ef8b048b601e1aeafbe014800;

    struct ManagerStorage {
        address owner;
        mapping(address key => Scope scope) scopes;
        mapping(address key => bool revoked) revoked;
        mapping(address key => SpendPolicy.WindowState) windows;
        mapping(address key => uint256 nonce) nonces;
        mapping(bytes4 selector => bool denied) ownerOnlySelectors;
        bool reentrancyLocked;
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SessionKeyGranted(address indexed key, uint48 expiresAt);
    event SessionKeyRevoked(address indexed key);
    event SessionKeyRotated(address indexed oldKey, address indexed newKey, uint48 overlapEnds);
    event OwnerOnlySelectorSet(bytes4 indexed selector, bool denied);
    /// @notice A previously revoked key was reinstated by a fresh grant of the same address.
    event SessionKeyReinstated(address indexed key);
    event TreasuryWithdrawal(address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // EIP-712
    // ------------------------------------------------------------------
    bytes32 private constant _ACTION_REQUEST_TYPEHASH =
        keccak256(
            "ActionRequest(bytes32 agentId,address target,bytes4 selector,uint256 value,uint256 nonce,uint48 expiry,bytes32 rationaleHash,bytes data)"
        );
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("SigilKit");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    /// @notice E10: owner countersignature typehash over a request digest.
    bytes32 private constant _REQUEST_APPROVAL_TYPEHASH =
        keccak256("RequestApproval(bytes32 requestDigest)");
    /// @notice E11: hard cap on watchlist length (gas bound on balance snapshots).
    uint256 private constant MAX_WATCHED_TOKENS = 8;
    /// @dev Hard cap on the `merkleProof` length `_targetAllowed` will walk (gas bound on
    ///      the Merkle verification). Same value as `SessionKey7579Module`'s
    ///      MAX_SINGLE_PROOF_ELEMENTS, and the depth-8 (256-leaf) whitelist shape
    ///      `GasBudget.t.sol` already budgets for, so a whitelisted call stays inside the
    ///      ceiling that file measures. The 7579 module reverts on overflow; this one
    ///      returns "not allowed" instead, because the caller already reverts
    ///      `TargetNotAllowed` and a distinct error would change the external surface
    ///      for a gas bound rather than for a new failure mode.
    uint256 private constant MAX_SINGLE_PROOF_ELEMENTS = 8;

    // ------------------------------------------------------------------
    // Wire-format constants
    //
    // CQ-1: every literal in this block is an EXTERNAL contract — an EIP-712
    // prefix, an ERC-1271/ERC-20 selector, or a signature-encoding length — not a
    // value chosen by this codebase. Naming them does two things a bare hex
    // literal cannot: it says WHICH standard the number comes from (so a reader
    // never has to recognise 0xa9059cbb on sight), and it makes every use greppable,
    // so a standard's encoding can be audited in one pass instead of line by line.
    // It also stops a security-relevant literal from drifting: the selectors in
    // `_revertInnerCall` decide which inner revert reasons bubble up verbatim.
    // ------------------------------------------------------------------

    /// @dev EIP-712 domain-separation PREFIX `"\x19\x01"`, kept as ONE `bytes2` because
    ///      that is what it is: a single 2-byte literal prepended to the digest preimage
    ///      keccak("\x19\x01" ‖ domainSeparator ‖ structHash). Named for its ROLE (the
    ///      EIP-712 prefix) rather than for the standard that happens to define the byte
    ///      values, because the role is what a caller must not get wrong.
    ///
    ///      The two bytes are NOT the same thing and must not be read as one field:
    ///      0x19 is the EIP-191 sign-prefix marker and 0x01 is EIP-191's version byte,
    ///      chosen by EIP-712 — but NEITHER is EIP-712's own `version` domain field, which
    ///      is `keccak("1")` (`_VERSION_HASH`) and lives INSIDE the domain separator. An
    ///      earlier revision split these into `_EIP712_PREFIX` / `_EIP712_VERSION`, and
    ///      the latter name was actively misleading: it invited the reader to link 0x01 to
    ///      `_VERSION_HASH`. A second revision then renamed it `_EIP191_VERSION`, which
    ///      fixed that confusion but introduced a worse one — the NatSpec calls this the
    ///      EIP-712 prefix while the identifier claims EIP-191, so the code now
    ///      contradicts its own documentation. `_EIP712_PREFIX` is restored for that
    ///      reason: it is the one name that is true of both the role and the value.
    ///
    ///      `encodePacked` of this `bytes2` and of the original `"\x19\x01"` string literal
    ///      are byte-identical, so the digest is unchanged (verified against the committed
    ///      golden vectors in vectors/actionrequest.json).
    bytes2 private constant _EIP712_PREFIX = hex"1901";

    /// @dev ERC-1271 success values, one per `isValidSignature` overload. ERC-1271 declares
    ///      the return as `bytes4`, so a conforming implementation returns it occupying the
    ///      HIGH 4 bytes of an ABI word with the low 28 bytes zero-padded; `_isERC1271SuccessMagic`
    ///      accepts both that form and a bare 4-byte return.
    ///
    ///      D-10: an earlier revision mislabelled these — it called `0x1626ba7e` "the
    ///      `isValidSignature(bytes32,bytes)` selector AND its magic" while ALSO calling
    ///      `0x20c13b0b` "the `isValidSignature(bytes,bytes)` overload's magic", which
    ///      reads as though the two constants belonged to one overload. They do not: each
    ///      value is the success value OF its own overload, and the selector used to CALL
    ///      1271 is only ever `0x1626ba7e` (see `_recover`). Recomputed and self-checked
    ///      against known keccak values: keccak("isValidSignature(bytes32,bytes)")[:4] ==
    ///      0x1626ba7e and keccak("isValidSignature(bytes,bytes)")[:4] == 0x20c13b0b.
    ///      Behaviour is unchanged — both values were already accepted — so this is a
    ///      comment-only correction. See docs/ARCH-CONTRACTS-2026-09-26.md (D-10).
    bytes4 private constant _ERC1271_MAGIC = 0x1626ba7e;
    bytes4 private constant _ERC1271_MAGIC_BYTES = 0x20c13b0b;

    /// @dev Canonical Solidity revert-data selectors bubbled verbatim by
    ///      `_revertInnerCall`: Error(string) and Panic(uint256).
    bytes4 private constant _ERROR_STRING_SELECTOR = 0x08c379a0;
    bytes4 private constant _PANIC_SELECTOR = 0x4e487b71;

    /// @dev Standard ERC-20 function selectors: balanceOf(address), transfer(address,uint256)
    ///      and transferFrom(address,address,uint256).
    bytes4 private constant _ERC20_BALANCE_OF_SELECTOR = 0x70a08231;
    bytes4 private constant _ERC20_TRANSFER_SELECTOR = 0xa9059cbb;
    bytes4 private constant _ERC20_TRANSFER_FROM_SELECTOR = 0x23b872dd;

    /// @dev secp256k1 group order N. Anything above N/2 is a malleable twin of a
    ///      signature that already verifies (EIP-2), so recovery rejects it.
    uint256 private constant _SECP256K1_HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @dev Length of a 65-byte (r ‖ vs ‖ yParity) ECDSA signature: the only signature
    ///      length that is NOT an ERC-1271 encoding, so it is also the branch selector
    ///      between the two key kinds in `_recover`.
    uint256 private constant _ECDSA_SIGNATURE_LENGTH = 65;
    /// @dev Width of the leading `address(keyContract)` in an E17 smart-account key's
    ///      `address ‖ 1271 signature` blob. A signature shorter than this cannot carry
    ///      a contract address, so it is rejected before any slicing.
    uint256 private constant _ERC1271_PREFIX_LENGTH = 20;

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------
    /// @dev Gates an admin entry point to the owner AND self-seals the running selector
    ///      into the session-key denylist (see the sealing note below). Both halves matter:
    ///      `onlyOwner` alone proves the caller is the owner, while the seal is what makes
    ///      the property hold for a selector nobody has called yet.
    modifier onlyOwner() {
        if (msg.sender != _manager().owner) revert NotOwner();
        _;
        // C-04 self-sealing denylist. `msg.sig` is the selector of the frame currently
        // executing, so EVERY `onlyOwner` entry point adds its own selector to the
        // session-key denylist the moment it is successfully invoked. A newly added admin
        // function is therefore covered the first time it runs, with no second edit to any
        // hand-maintained list — which is the whole point (the list used to live in two
        // files and every addition had to be remembered twice).
        //
        // Sealed AFTER the body, deliberately: `setSelectorDenied(x, false)` is itself
        // `onlyOwner`, so sealing before the body would let an owner un-seal
        // `setSelectorDenied`'s OWN selector within that same call. Sealing after makes
        // "an admin selector, once reached, stays denied" unconditional.
        //
        // A reverting body rolls this write back together with the rest of the call, so a
        // call that did not happen never seals anything.
        _setSelectorDenied(msg.sig, true);
    }

    /// @dev Single-slot reentrancy guard around `executeWithSessionKey`. It reverts with
    ///      `InnerCallFailed` — deliberately the same error an inner-call failure produces,
    ///      so a reentrant caller cannot use the error to tell "the target reverted" from
    ///      "you may not call this now" and probe the wallet's state that way.
    ///      The lock lives in the ERC-7201 slot rather than a dedicated `uint256`, so a
    ///      7702 facet delegating to this core cannot collide with it.
    modifier nonReentrant() {
        ManagerStorage storage s = _manager();
        if (s.reentrancyLocked) revert InnerCallFailed();
        s.reentrancyLocked = true;
        _;
        s.reentrancyLocked = false;
    }

    // ------------------------------------------------------------------
    // Construction / ownership
    // ------------------------------------------------------------------
    constructor(address owner_) {
        if (owner_ == address(0)) revert NotOwner();
        _manager().owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        _seedAdminDenylist();
    }

    /// @notice Denies the manager's own administration surface to session keys by default
    ///         (defense in depth beyond `onlyOwner`): even a `merkleRoot == 0` allow-all key
    ///         can never reach these selectors, on any target.
    /// @dev C-04 — SINGLE SOURCE OF TRUTH. This list used to be hand-written in the
    ///      constructor AND copied a seventh time (plus one extra entry) in
    ///      `SigilKitDelegator.initializeSelfOwned`, with nothing keeping the two in sync
    ///      and no test asserting the denylist actually covered the admin surface. Both
    ///      call sites now share this one function, and `onlyOwner` additionally seals
    ///      whichever selector is running, so the list below is a *starting* state rather
    ///      than the thing that makes the property hold.
    ///
    ///      It still has to be exhaustive at deploy time, for a selector nobody has called
    ///      yet — hence `adminSelectorDigest()` and the DenylistCoverage suite.
    ///
    ///      CQ-1: contract-qualified selectors rather than `this.f.selector`. `this` in a
    ///      constructor trips solc warning 5805 ("external functions cannot be called while
    ///      constructing"); the selectors are compile-time constants, so the qualified form
    ///      is both warning-free and clearer about intent.
    function _seedAdminDenylist() internal {
        _setSelectorDenied(SessionKeyManager.grantSessionKey.selector, true);
        _setSelectorDenied(SessionKeyManager.revokeSessionKey.selector, true);
        _setSelectorDenied(SessionKeyManager.rotateSessionKey.selector, true);
        _setSelectorDenied(SessionKeyManager.transferOwnership.selector, true);
        _setSelectorDenied(SessionKeyManager.setSelectorDenied.selector, true);
        _setSelectorDenied(SessionKeyManager.withdraw.selector, true);
    }

    /// @dev Domain-separation prefix for the digest, so a folded digest can never collide
    ///      with an unrelated keccak over the same selectors.
    bytes32 private constant _ADMIN_SELECTOR_DIGEST_SEED = keccak256("sigilkit.admin-selector-set.v1");

    /// @notice C-04 comparison anchor: `keccak256` over the manager's hardcoded admin
    ///         selector set, in declaration order.
    /// @dev Purely a REVIEW/GATE aid, not an authorization mechanism. It turns "did anyone
    ///      remember to update the denylist list?" from an unauditable hunch into a single
    ///      value an operator can compare off-chain (`cast call <mgr>
    ///      "adminSelectorDigest()(bytes32)"`) against the value in this source tree, and
    ///      into a constant a test can pin. Change the admin surface and this digest MUST
    ///      change with it — that is the entire contract, and `DenylistCoverage.t.sol`
    ///      enforces it.
    ///
    ///      Each selector is left-padded to 32 bytes (an ABI `bytes4` is right-padded, which
    ///      would put the meaningful bits in the wrong place and alias distinct selectors),
    ///      and folded into a running hash so the order is fixed by this function rather
    ///      than by the caller. Derived contracts MUST override to fold in their own extra
    ///      selectors — `SigilKitDelegator` does, and the coverage test asserts it does.
    function adminSelectorDigest() public pure virtual returns (bytes32 digest) {
        digest = _adminSelectorDigest(
            _ADMIN_SELECTOR_DIGEST_SEED,
            SessionKeyManager.grantSessionKey.selector,
            SessionKeyManager.revokeSessionKey.selector,
            SessionKeyManager.rotateSessionKey.selector,
            SessionKeyManager.transferOwnership.selector,
            SessionKeyManager.setSelectorDenied.selector,
            SessionKeyManager.withdraw.selector
        );
    }

    /// @dev Folds a list of selectors into a running digest. The cast to `bytes32` is
    ///      deliberate left-padding (an ABI `bytes4` is right-padded, which would put the
    ///      meaningful bits in the wrong place and alias distinct selectors).
    function _adminSelectorDigest(bytes32 seed, bytes4 s0, bytes4 s1, bytes4 s2, bytes4 s3, bytes4 s4, bytes4 s5)
        internal
        pure
        returns (bytes32 digest)
    {
        digest = _foldSelector(seed, s0);
        digest = _foldSelector(digest, s1);
        digest = _foldSelector(digest, s2);
        digest = _foldSelector(digest, s3);
        digest = _foldSelector(digest, s4);
        digest = _foldSelector(digest, s5);
    }

    function _foldSelector(bytes32 digest, bytes4 selector) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(digest, bytes32(selector)));
    }

    receive() external payable {} // fund the wallet so agents can spend from it

    /// @notice Hands the admin role to `newOwner`. Single-step: the caller must already
    ///         be the owner, so there is no accept step and a typo in `newOwner` is
    ///         immediately unrecoverable. `address(0)` is rejected so ownership can never
    ///         be burned — an ownerless manager would seal every selector and strand funds.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert NotOwner();
        emit OwnershipTransferred(_manager().owner, newOwner);
        _manager().owner = newOwner;
    }

    /// @notice The current owner. Zero until a delegating EOA calls
    ///         `SigilKitDelegator.initializeSelfOwned` (in which case it is the EOA).
    function owner() external view returns (address) {
        return _manager().owner;
    }

    // ------------------------------------------------------------------
    // Admin: key lifecycle (owner only)
    // ------------------------------------------------------------------
    /// @notice Grants `key` an execution scope, or re-grants (and thereby REINSTATES)
    ///         one that was previously revoked. Every scope field is validated by
    ///         `_validateScope`; an invalid scope reverts without touching storage.
    function grantSessionKey(address key, Scope calldata scope) external onlyOwner {
        _validateScope(key, scope);
        ManagerStorage storage s = _manager();
        if (s.revoked[key]) {
            // This grant reinstates a previously revoked key — make the reversal
            // observable instead of silently clearing the revocation (issues catalog S5).
            emit SessionKeyReinstated(key);
        }
        s.scopes[key] = scope;
        s.revoked[key] = false;
        emit SessionKeyGranted(key, scope.expiresAt);
    }

    /// @notice Owner-only treasury recovery (issues catalog S6): the only sanctioned way
    ///         to move funds out besides scoped agent execution. Denylisted from session
    ///         keys by default like the other admin selectors.
    /// @dev Slither missing-zero-check: a zero `to` would permanently burn the funds
    ///      (no burn semantics intended), so it is rejected outright.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert WithdrawFailed();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit TreasuryWithdrawal(to, amount);
    }

    /// @notice Revokes `key`, blocking it from authorizing any further action. The scope
    ///         is retained (for audit reconstruction) and a later `grantSessionKey` for the
    ///         same key clears the flag and emits `SessionKeyReinstated`.
    function revokeSessionKey(address key) external onlyOwner {
        if (_manager().scopes[key].expiresAt == 0) revert KeyUnknown();
        _manager().revoked[key] = true;
        emit SessionKeyRevoked(key);
    }

    /// @notice Grants `newKey` and shortens `oldKey`'s life to `overlapEnds` (bounded by its
    ///         existing expiry). Overlap avoids an agent blackout between rotation steps.
    /// @dev `oldKey == address(0)` IS supported — it is the "grant a fresh key with no
    ///      predecessor" path, which is why the `KeyUnknown` check below is guarded by
    ///      `oldKey != address(0)`. But that guard is not sufficient on its own, and the
    ///      reachability of this path is easy to get wrong:
    ///
    ///      With `oldKey == address(0)`, the very next line compares `overlapEnds` against
    ///      `scopes[address(0)].expiresAt`, which is 0 because the zero key was never granted.
    ///      So `overlapEnds > 0` reverts `OverlapBeyondOldExpiry`, and the zero-old-key path
    ///      is reachable ONLY with `overlapEnds == 0`.
    ///
    ///      In other words: passing a zero `oldKey` with a realistic (non-zero) overlap does
    ///      NOT silently succeed — it reverts. Callers wanting a fresh key with no predecessor
    ///      must pass `overlapEnds == 0` explicitly. Pinned by
    ///      `SessionKeyManagerTest.test_Rotate_ZeroOldKey_RequiresZeroOverlap`, which asserts
    ///      both halves (non-zero overlap reverts; zero overlap grants).
    function rotateSessionKey(address oldKey, address newKey, Scope calldata newScope, uint48 overlapEnds)
        external
        onlyOwner
    {
        // Reject unknown keys outright: with expiresAt==0 the only surviving path
        // (overlapEnds==0) would emit spurious Revoked/Rotated events for a key
        // that never existed.
        if (oldKey != address(0) && _manager().scopes[oldKey].expiresAt == 0) revert KeyUnknown();
        if (overlapEnds > _manager().scopes[oldKey].expiresAt) revert OverlapBeyondOldExpiry();
        _grant(oldKey, newKey, newScope, overlapEnds);
    }

    function _grant(address oldKey, address newKey, Scope calldata newScope, uint48 overlapEnds)
        internal
    {
        _validateScope(newKey, newScope);
        ManagerStorage storage s = _manager();
        if (s.revoked[newKey]) {
            emit SessionKeyReinstated(newKey); // rotation reinstates a revoked newKey
        }
        s.scopes[newKey] = newScope;
        s.revoked[newKey] = false;
        emit SessionKeyGranted(newKey, newScope.expiresAt);
        if (oldKey != address(0)) {
            // SEC-10 (RESOLVED as documented semantics, owner-ruled): window state is
            // deliberately PER-KEY, and a rotation intentionally starts the new key on a
            // fresh window. This is a documented property, not an oversight — see the
            // rotation clause in `SpendPolicy`'s NatSpec for the full statement and, more
            // importantly, for why this is NOT an agent-reachable bypass.
            //
            // The decisive property: BOTH `grantSessionKey` and `rotateSessionKey` are
            // `onlyOwner`, so an agent CANNOT rotate itself out of an exhausted window. What
            // a rotation resets is the OWNER's bookkeeping, and the owner is the party that
            // chose both the cap and the rotation. `perWindowCap` bounds a single key's
            // rate, not the owner's rotation cadence.
            //
            // An earlier revision carried the window forward across a rotation. It was
            // reverted because a lineage-level aggregate would require re-keying `enforce`'s
            // window slot (it takes a caller-supplied storage pointer), i.e. a storage-layout
            // change — the wrong trade while the storage scheme is still open.
            //
            // Rotation overlap: if the overlap already elapsed, revoke the old key outright.
            // Time-based by design; validator drift of seconds only affects whether the old
            // key is revoked now or expires naturally at `overlapEnds`.
            // forge-lint: disable-next-line(block-timestamp)
            if (overlapEnds <= block.timestamp) {
                s.revoked[oldKey] = true;
                emit SessionKeyRevoked(oldKey);
            } else {
                s.scopes[oldKey].expiresAt = overlapEnds;
            }
            emit SessionKeyRotated(oldKey, newKey, overlapEnds);
        }
    }


    function _validateScope(address key, Scope calldata scope) internal view {
        if (key == address(0)) revert InvalidScope();
        // Grant-time sanity check: the expiry must be in the future. Time-based by design.
        // forge-lint: disable-next-line(block-timestamp)
        if (uint256(scope.expiresAt) <= block.timestamp) revert InvalidScope(); // expiry in past
        if (scope.perActionCap == 0) revert InvalidScope(); // value cap zero
        if (scope.perWindowCap < scope.perActionCap) revert InvalidScope(); // window below action cap
        if (scope.windowSeconds == 0) revert InvalidScope();
        if (scope.tokenWatchlist.length > MAX_WATCHED_TOKENS) revert InvalidScope(); // E11 gas bound
        //
        // DELIBERATELY NOT VALIDATED HERE: `tokenWatchlist.length > 0 && !enforceNativeDelta`.
        //
        // That combination grants nothing — `enforceNativeDelta` is the master switch for the
        // whole of E11, so a non-empty watchlist with it false is inert (see the NatSpec on the
        // struct field). It is tempting to "fix" that by reverting, turning a silently ignored
        // configuration into an explicit failure. DO NOT. That exact revert was written, and it
        // broke a test-pinned invariant:
        //
        //   E11WatchlistRead.t.sol :: test_EnforceNativeDeltaFalse_UnaffectedByHostileWatchlist
        //
        // whose `@dev` states the requirement explicitly: with E11 off, a hostile/unreadable
        // entry in the watchlist must change NOTHING, because the list is never read. Its
        // stated purpose is to stop exactly this class of "fix" from turning E11-off grants
        // into a new denial of service — an owner who configured a watchlist for a scope with
        // E11 disabled, or who has tooling that always populates the field, must keep being
        // able to grant.
        //
        // So the combination is a DELIBERATE no-op, not an oversight, and the correct remedy for
        // its danger is DOCUMENTATION (the struct field says the list is ignored), not
        // REJECTION. A documented ignore is far less harmful than an undocumented one, and far
        // less harmful than a hard revert that fails a legitimate owner's grant.
    }

    /// @notice Adds/removes a selector from the session-key denylist. Session keys can NEVER
    ///         call a denied selector on ANY target (INV-4, defense in depth beyond onlyOwner).
    function setSelectorDenied(bytes4 selector, bool denied) external onlyOwner {
        _setSelectorDenied(selector, denied);
    }

    function _setSelectorDenied(bytes4 selector, bool denied) internal {
        _manager().ownerOnlySelectors[selector] = denied;
        emit OwnerOnlySelectorSet(selector, denied);
    }

    // ------------------------------------------------------------------
    // Agent execution path
    // ------------------------------------------------------------------
    /// @notice Executes `request` if it carries a valid signature from an active, in-scope
    ///         session key. Permissionless to call (anyone may relay); authorization comes
    ///         entirely from the signature.
    /// @param request The signed action request.
    /// @param signature EIP-712 signature over the request, from the session key.
    /// @param merkleProof Sorted-pair Merkle proof over the v2 whitelist leaves;
    ///        required when the key's scope has a non-zero merkleRoot, ignored otherwise.
    /// @param ownerApproval EIP-712 owner signature over `RequestApproval(requestDigest)`
    ///        — required (non-empty) iff the scope sets `countersignAbove` and
    ///        `request.value` exceeds it (graduated authority, enhancement E10). The
    ///        digest binding (plus the signer commitment added in the SEC-11 replay fix)
    ///        makes approvals single-use by construction. Ignored
    ///        otherwise; the owner's own key is always exempt.
    ///        D-13: resolved through the same ECDSA-or-ERC-1271 dispatch as a session
    ///        key, so a CONTRACT owner (Safe, multisig) can countersign. The wire
    ///        format is the E17 one — 65 bytes for ECDSA, or
    ///        `address(owner) ‖ 1271signature` for a contract owner. Previously this
    ///        path was ECDSA-only, which made the documented production setup (a 2-of-3
    ///        Safe as owner) unable to ever produce a valid approval.
    function executeWithSessionKey(
        ActionRequest calldata request,
        bytes calldata signature,
        bytes32[] calldata merkleProof,
        bytes calldata ownerApproval
    ) external payable nonReentrant {
        if (msg.value != 0) revert ValueNotAccepted(); // value flows from wallet balance, not relayer

        ManagerStorage storage s = _manager();

        // --- Signature & key state ---
        address signer = _recover(request, signature);
        Scope storage scope = s.scopes[signer];
        if (scope.expiresAt == 0) revert KeyUnknown();
        if (s.revoked[signer]) revert KeyRevoked();
        // INV-2: key hard expiry, and the request's own expiry. Both are time-based by
        // design; a validator shifting the clock by seconds can only tighten or loosen the
        // final moments of a key — it cannot exceed the spend caps, which are enforced
        // independently below.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > scope.expiresAt) revert KeyExpired(); // INV-2
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > request.expiry) revert RequestExpired();

        // --- Graduated authority (E10): owner countersign for large actions ---
        if (scope.countersignAbove != 0 && request.value > scope.countersignAbove) {
            if (signer != s.owner) {
                if (ownerApproval.length == 0) revert OwnerCountersignRequired();
                bytes32 requestDigest = _requestDigest(request);
                // E10 single-use fix: the approval commits the SIGNER, so a signature over one
                // key's request can never validate for another key.
                //
                // The EIP-712 struct is `ActionRequest(bytes32 agentId, address target, bytes4
                // selector, uint256 value, uint256 nonce, uint48 expiry, bytes32 rationaleHash,
                // bytes data)` — no signer, and `agentId` is a free bytes32 the CALLER supplies
                // (never checked against the recovered signer or any scope). Two different keys
                // presenting a byte-identical request therefore produce the identical digest,
                // and one owner approval passed for BOTH. Reproduced end-to-end with forge:
                // one 5 ETH approval over key A's request at its nonce was replayed by two
                // other keys carrying their own nonces, for 15 ETH against the 5 ETH approval.
                // The per-key nonce only makes a replay *by the same key* fail.
                //
                // Rather than change the announcement-leading typehash (a wire-format break
                // recorded as D-13), the approval digest now additionally commits the signer —
                // keccak(approvalStructHash(requestDigest), signer) — which keeps the owner's
                // signature verifiable exactly as before for the intended key and makes it
                // underivable for any other.
                bytes32 approvalDigest = keccak256(
                    abi.encodePacked(
                        _EIP712_PREFIX,
                        _domainSeparator(),
                        _approvalStructHash(requestDigest),
                        signer
                    )
                );
                if (_recoverSigner(approvalDigest, ownerApproval) != s.owner) {
                    revert InvalidOwnerApproval();
                }
            }
            // The owner's own session key carries owner authority — exempt.
        }
        // Approval binds the full request digest AND the session-key signer — single-use by
        // nonce uniqueness per key, and by signer commitment across keys (SEC-11 replay fix).

        // --- Replay protection ---
        if (request.nonce != s.nonces[signer]) revert NonceUsed();
        s.nonces[signer] = request.nonce + 1; // effect before interaction

        // --- Privilege containment (INV-4) ---
        if (s.ownerOnlySelectors[request.selector]) revert SelectorDenied(request.selector);

        // --- Target whitelist ---
        // Leaf format v2: leaves commit the calldata too, so a whitelisted entry can
        // bind the EXACT arguments (e.g. one specific token transfer) — the fix for
        // "whitelisted token selectors are uncapped". argsHash == 0 is the wildcard
        // leaf (selector whitelisted for any calldata); keccak256 of real data is
        // never zero, so pinned and wildcard leaves never collide.
        if (scope.merkleRoot != bytes32(0)) {
            if (!_targetAllowed(scope.merkleRoot, request.target, request.selector, request.data, merkleProof))
            {
                revert TargetNotAllowed(request.target, request.selector);
            }
        }
        // merkleRoot == 0 means "allow all" — documented as dangerous; owners should always
        // grant a real root in production.

        // --- Spend caps: checks + effects BEFORE the inner call (CEI) ---
        s.windows[signer].enforce(
            address(this), signer, request.value, scope.perActionCap, scope.perWindowCap, scope.windowSeconds
        );

        // --- Interaction + balance-delta verification (E2/E11) ---
        _interact(scope, request);

        // --- Mandatory audit (INV-3): no silent success path ---
        _logAction(request.agentId, request.target, request.selector, request.value, request.rationaleHash);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    /// @notice The scope granted to `key`. An all-zero scope means no grant exists.
    ///         Revocation does NOT clear the scope — pair with `isRevoked`.
    function getScope(address key) external view returns (Scope memory) {
        return _manager().scopes[key];
    }

    /// @notice Whether `key` is revoked. A revoked key with a live scope is still
    ///         refused; a later `grantSessionKey` for the same key clears the flag and
    ///         emits `SessionKeyReinstated`.
    function isRevoked(address key) external view returns (bool) {
        return _manager().revoked[key];
    }

    /// @notice The next nonce a request from `key` must carry. Strictly sequential:
    ///         a gap or a repeat reverts `NonceUsed`, so the SDK must read this value
    ///         and cannot front-run a nonce.
    function getNonce(address key) external view returns (uint256) {
        return _manager().nonces[key];
    }

    /// @notice Current fixed-window accounting for `key`. `windowStart` is 0 until the
    ///         first charged action opens a window.
    function getWindowState(address key) external view returns (SpendPolicy.WindowState memory) {
        return _manager().windows[key];
    }

    /// @notice Whether session keys are refused `selector` on every target (INV-4).
    function isSelectorDenied(bytes4 selector) external view returns (bool) {
        return _manager().ownerOnlySelectors[selector];
    }

    /// @notice EIP-712 domain separator. NOTE: it is a FUNCTION, not an immutable,
    ///         because it commits `block.chainid` and `address(this)`. In a proxy or a
    ///         7702 facet that is what you want, but it also means the value changes on
    ///         a chain-id change and a redelegation — an SDK must not cache it forever.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator();
    }

    /// @notice EIP-712 typehash for `ActionRequest`, exported so an SDK can build the
    ///         digest without duplicating the field order.
    function ACTION_REQUEST_TYPEHASH() external pure returns (bytes32) {
        return _ACTION_REQUEST_TYPEHASH;
    }

    /// @notice EIP-712 typehash for the owner countersignature (E10), exported for the
    ///         same reason as `ACTION_REQUEST_TYPEHASH`.
    function REQUEST_APPROVAL_TYPEHASH() external pure returns (bytes32) {
        return _REQUEST_APPROVAL_TYPEHASH;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------
    /// @dev The interaction step, isolated in its own frame (stack-depth): snapshot
    ///      balances (E11), make the inner call with revert-data bubbling (E2), then
    ///      verify balances. Runs inside the reentrancy lock; reverts roll everything
    ///      back, so the CEI ordering is preserved.
    /// @dev Slither arbitrary-send-eth: the sole production call site is
    ///      executeWithSessionKey, AFTER recovery of an active owner-granted key,
    ///      request/nonce/selector checks, the scope's Merkle check, and native
    ///      per-action/per-window charging. The signature binds target and value;
    ///      a zero Merkle root deliberately authorizes any target within those caps.
    ///      Keep those checks before every call to this helper (including subclasses).
    ///      Regression coverage: NativeTransferAuthorizationTest.
    /// @dev WRITING A TEST TARGET: the inner call is
    ///      `target.call{value: value}(abi.encodePacked(request.selector, request.data))`,
    ///      so the target is invoked WITH DATA — the 4-byte selector followed by `data`.
    ///      A bare `receive() external payable {}` is therefore NOT a usable test sink: a
    ///      contract that only declares `receive()` rejects any call carrying calldata, so
    ///      every action reverts and the failure looks like a policy or cap decision rather
    ///      than a malformed target. A test target must expose a payable function at exactly
    ///      `request.selector` and the request must set that real selector (not a placeholder):
    ///      `contract Sink { function poke(uint256) external payable {} }` with
    ///      `selector: Sink.poke.selector`. See `Sec10WindowRotation.t.sol`'s `Sec10Sink`.
    // slither-disable-next-line arbitrary-send-eth
    function _interact(Scope storage scope, ActionRequest calldata request) internal {
        BalanceSnapshot memory snap = _snapshotBalances(scope);
        (bool ok, bytes memory ret) =
            request.target.call{value: request.value}(abi.encodePacked(request.selector, request.data));
        if (!ok) _revertInnerCall(ret);
        _verifyBalances(scope, snap, request.value, _declaredTokenOutflow(request.selector, request.data));
    }

    /// @dev Pre/post balance capture for the E11 delta check. One memory struct keeps
    ///      the execution frame shallow.
    struct BalanceSnapshot {
        uint256 nativeBefore;
        uint256[] tokenBalances;
    }

    /// @dev C-01: the `n > MAX_WATCHED_TOKENS` guard is defence in depth, not the
    ///      primary bound. `_validateScope` already rejects an over-long watchlist at
    ///      grant time, and a scope is immutable, so an installed scope can never
    ///      reach that state. The guard is kept because a future grant path that
    ///      skipped `_validateScope` would otherwise turn an over-long watchlist into
    ///      unbounded `staticcall`s against attacker-chosen token addresses — i.e. a
    ///      gas bomb inside the E11 check itself.
    ///
    ///      It REVERTS rather than truncating, and that direction is the point. A clamp
    ///      would silently SKIP every entry past the ceiling: E11 would be enforced on 8
    ///      of N tokens and the action would report success on the rest — a fail-OPEN
    ///      weakening of the exact guarantee this check exists to provide, and one no
    ///      event or caller could observe. An unreachable revert is the safer of the two
    ///      failure modes; the gas bomb it rules out is the milder one.
    function _snapshotBalances(Scope storage scope) internal view returns (BalanceSnapshot memory snap) {
        if (!scope.enforceNativeDelta) return snap;
        snap.nativeBefore = address(this).balance;
        uint256 n = scope.tokenWatchlist.length;
        if (n > MAX_WATCHED_TOKENS) revert InvalidScope();
        snap.tokenBalances = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            snap.tokenBalances[i] = _erc20BalanceOf(scope.tokenWatchlist[i], address(this));
        }
    }

    /// @dev After the inner call: native balance must not have dropped by more than the
    ///      declared value, and watched tokens must not have net-decreased by more than
    ///      the amount their standard transfer selector declared (0 otherwise).
    ///
    ///      WATCHLIST LOOP SEMANTICS (R14-3, documented — NOT changed by this patch):
    ///      `declaredTokens` is ONE scalar derived from the REQUEST's selector/calldata via
    ///      `_declaredTokenOutflow`, and that SAME amount is applied as the tolerance against
    ///      EVERY watchlist entry: the comparison is per-entry, never aggregate. Two
    ///      consequences follow, and both are deliberate (conservative/aggregate posture):
    ///      (a) an untouched watched token has delta 0, so it always satisfies
    ///      `before <= after + declared` and can never fail a conforming action; and
    ///      (b) a token the inner call moved through an UNDECLARED path is tolerated up to
    ///      the DECLARED amount, because the declaration names no token. The check therefore
    ///      never over-rejects, but it CAN under-attribute which entry actually moved — an
    ///      owner needs per-token reconciliation if they want attribution, not just refusal.
    ///      Pinned by ScopeWatchlistMultiToken.t.sol (multi-token watchlists).
    ///
    ///      BOTH halves revert `NativeDeltaExceeded`, so the token branch reports under an
    ///      error whose name reads as native-only. That is deliberate and pinned: the
    ///      argument triple is the same shape in both cases (before, after, declared), and
    ///      the token refusal is asserted as `NativeDeltaExceeded` by
    ///      `E11WatchlistRead.t.sol :: test_ConformingWatchlist_UndeclaredOutflow_StillRefused`,
    ///      which is the test proving this check still speaks. Splitting it into a distinct
    ///      error would change the external revert surface for a naming gain and would
    ///      break that assertion — do not "fix" the name without an owner decision and a
    ///      deliberate test update.
    function _verifyBalances(
        Scope storage scope,
        BalanceSnapshot memory snap,
        uint256 declaredNative,
        uint256 declaredTokens
    ) internal view {
        if (!scope.enforceNativeDelta) return;
        if (address(this).balance < snap.nativeBefore - declaredNative) {
            revert NativeDeltaExceeded(snap.nativeBefore, address(this).balance, declaredNative);
        }
        for (uint256 i = 0; i < snap.tokenBalances.length; ++i) {
            uint256 afterBal = _erc20BalanceOf(scope.tokenWatchlist[i], address(this));
            if (snap.tokenBalances[i] > afterBal + declaredTokens) {
                revert NativeDeltaExceeded(snap.tokenBalances[i], afterBal, declaredTokens);
            }
        }
    }

    /// @dev Bubbles recognizable inner revert reasons (enhancement E2): empty reason
    ///      (plain require(false)) is indistinguishable from a bare failure and stays
    ///      InnerCallFailed; Error(string)/Panic and known SigilKit errors pass through
    ///      so integrators see WHY the target failed. Unknown selectors keep the
    ///      blanket error — INV: every revert of this contract is identifiable.
    function _revertInnerCall(bytes memory reason) internal pure {
        if (reason.length >= 4) {
            // The length check above guarantees a full selector is present, so the cast
            // truncates padding, not data.
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes4 sel = bytes4(reason);
            if (
                sel == _ERROR_STRING_SELECTOR || sel == _PANIC_SELECTOR
                    || sel == SpendPolicy.PerActionCapExceeded.selector
                    || sel == SpendPolicy.PerWindowCapExceeded.selector
            ) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
        }
        revert InnerCallFailed();
    }

    /// @dev Whitelist check against leaf format v2: the proof must verify against
    ///      either the pinned leaf (commits keccak256(data)) or the wildcard leaf
    ///      (argsHash == 0 — any calldata for this target+selector).
    function _targetAllowed(
        bytes32 root,
        address target,
        bytes4 selector,
        bytes calldata data,
        bytes32[] calldata proof
    ) internal pure returns (bool) {
        bytes32 argsHash = keccak256(data);
        // MAX_SINGLE_PROOF_ELEMENTS bounds the walk BEFORE `MerkleWhitelist.verify`
        // copies the calldata array into memory, so an over-length proof costs O(1) here
        // instead of O(n) memory expansion plus O(n) keccak rounds.
        //
        // `merkleProof` is deliberately NOT part of the signed EIP-712 struct, and needs
        // no binding there: it is a pure witness for `keccak256(target, selector, argsHash)`,
        // and every one of those three inputs IS signed. So the proof carries no authority
        // a signature could have withheld - it can only decide whether an already-authorized
        // leaf is proven, and an attacker who supplies a wrong one simply fails. What it CAN
        // do is make the manager walk attacker-chosen calldata, and that cost is paid by
        // whoever relays the call, so unbounded it is a gas-DoS primitive. Return false,
        // not revert: the caller's existing `TargetNotAllowed` is the correct refusal and
        // no new error name enters the external surface.
        if (proof.length > MAX_SINGLE_PROOF_ELEMENTS) return false;
        if (MerkleWhitelist.verify(proof, root, keccak256(abi.encode(target, selector, argsHash)))) {
            return true;
        }
        if (
            argsHash != bytes32(0)
                && MerkleWhitelist.verify(
                    proof, root, keccak256(abi.encode(target, selector, bytes32(0)))
                )
        ) {
            return true;
        }
        return false;
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
    }

    /// @dev SEC-11. Decides whether an `isValidSignature` return payload is an
    ///      affirmative answer, accepting ONLY the two standard encodings:
    ///
    ///        1. a canonical 32-byte ABI word whose HIGH 4 bytes are the magic and whose
    ///           remaining 28 bytes are ZERO (the ERC-1271-conforming form); and
    ///        2. a bare 4-byte return (a non-standard implementation returning the declared
    ///           `bytes4` without ABI padding), which is unambiguous BECAUSE the length is
    ///           exactly 4 — there is no room for a payload to hide in.
    ///
    ///      The check this replaces ALSO accepted a 32-byte word whose high 4 bytes were
    ///      the magic and whose remaining 28 bytes were ARBITRARY. That branch let a
    ///      contract that never validated the digest at all pass, as long as it returned
    ///      `0x1626ba7e` in the top word and 224 bits of its own choosing below. An owner
    ///      who granted a scope to such a "signature service" would find every request it
    ///      answered accepted, unverified. A non-zero payload below the magic is not a real
    ///      ERC-1271 encoding — a conforming `bytes4` return leaves those bytes zero — so
    ///      requiring the whole 32-byte word to equal the magic (or the length to be exactly
    ///      4) closes it without rejecting any conforming validator.
    ///
    ///      Both casts below are guarded by the preceding length checks, so each reads
    ///      only bytes that exist in `ret`.
    ///
    /// @dev WHY BOTH MAGICS ARE ACCEPTED (deliberate, do not "narrow" without an owner
    ///      decision). `_recoverSigner` calls exactly ONE selector, `_ERC1271_MAGIC`
    ///      (`isValidSignature(bytes32,bytes)`). The other accepted value,
    ///      `_ERC1271_MAGIC_BYTES` = `0x20c13b0b`, is the success value of the
    ///      `isValidSignature(bytes,bytes)` overload — an overload this contract never
    ///      invokes. It is accepted anyway for two reasons:
    ///
    ///      1. It is the de-facto wire answer of ERC-1271 "native wallet" implementations
    ///         in the wild, and the repo pins it as required behaviour in
    ///         `ERC1271Keys.t.sol` (`test_ERC1271_NativeWalletMagic_StillAccepted`).
    ///         Narrowing the set would break a tested, deliberate behaviour.
    ///      2. The looseness is INHERENT to ERC-1271, not an artefact of this
    ///         implementation: a permissive validator that returns a constant without ever
    ///         inspecting the digest is observationally indistinguishable from a real one.
    ///         No local check can detect it, and the party exposed to the risk is the OWNER,
    ///         who chooses which contract to grant a scope to. That is a documented trust
    ///         boundary, not a defect to be patched here.
    ///
    ///      What this function DOES police — and what SEC-11 was about — is the RETURN
    ///      ENCODING: the whole 32-byte word must equal the magic (or the length must be
    ///      exactly 4). A magic followed by 224 bits of garbage is rejected. That
    ///      hardening is unrelated to how many magics are on the accept list, and is
    ///      unaffected by the decision above.
    function _isERC1271SuccessMagic(bytes memory ret) internal pure returns (bool) {
        if (ret.length == 4) {
            // Non-standard bare-bytes4 return: only padding-free equality counts.
            // forge-lint: disable-next-line(unsafe-typecast)
            return bytes4(ret) == _ERC1271_MAGIC || bytes4(ret) == _ERC1271_MAGIC_BYTES;
        }
        if (ret.length == 32) {
            // Standard ABI word: the WHOLE word must be the magic, which is equivalent
            // to requiring the trailing 28 bytes to be zero. A magic followed by garbage
            // fails here — that was the SEC-11 bypass.
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes32 word = bytes32(ret);
            // forge-lint: disable-next-line(unsafe-typecast)
            return word == bytes32(_ERC1271_MAGIC) || word == bytes32(_ERC1271_MAGIC_BYTES);
        }
        return false; // empty, or oversized/non-canonical (e.g. 64 bytes)
    }


    /// @notice Resolves `signature` over `digest` to a signer address, accepting BOTH
    ///         plain ECDSA and an ERC-1271 smart-account key.
    ///
    /// @dev D-13/D-16: this is the single dispatch point for "who signed this digest".
    ///      It was previously inlined in `_recover` only, which meant the E10 owner
    ///      countersignature had to re-derive the signer by hand — and it did so with the
    ///      ECDSA-only path. A contract owner (a Safe, say) can never be the result of
    ///      `ecrecover`, so the documented production setup
    ///      (`Deploy.s.sol`: "PRODUCTION: set SIGILKIT_OWNER_ADDRESS to an existing
    ///      governance contract (2-of-3 Gnosis Safe)") made every countersigned action
    ///      revert `InvalidOwnerApproval` — silently, on first use. Routing both call
    ///      sites through one helper is what makes the ERC-1271 case reachable at all.
    ///
    ///      Wire format (unchanged, E17):
    ///        - exactly 65 bytes -> ECDSA, `yParity` 27/28, EIP-2 low-s enforced;
    ///        - anything else     -> `address(keyContract) ‖ 1271signature`, the first
    ///          20 bytes are the contract's address and the rest is forwarded verbatim.
    ///
    ///      The 1271 branch is a STATICCALL, so it cannot mutate state and therefore
    ///      cannot re-enter before the caller's own effects are applied.
    function _recoverSigner(bytes32 digest, bytes calldata signature)
        internal
        view
        returns (address)
    {
        if (signature.length != _ECDSA_SIGNATURE_LENGTH) {
            if (signature.length < _ERC1271_PREFIX_LENGTH) revert InvalidSignature();
            address keyContract = address(bytes20(signature[0:20]));
            uint256 codeSize;
            assembly ("memory-safe") {
                codeSize := extcodesize(keyContract)
            }
            // extcodesize == 0 means EOA or self-destructed: there is no contract to ask.
            if (codeSize == 0) revert InvalidSignature();
            (bool ok, bytes memory ret) =
                keyContract.staticcall(abi.encodeWithSelector(_ERC1271_MAGIC, digest, signature[20:]));
            if (ok && _isERC1271SuccessMagic(ret)) {
                return keyContract;
            }
            revert InvalidSignature();
        }
        return _ecrecover(digest, signature);
    }

    /// @dev Internal-virtual so symbolic-verification harnesses can pin the recovered
    ///      signer and spec the non-signature properties (replay, expiry, denylist,
    ///      nonce accounting) independently of ECDSA — Halmos models ecrecover as an
    ///      uninterpreted function, so the recovery result must be assumed, not proven.
    function _recover(ActionRequest calldata request, bytes calldata signature)
        internal
        view
        virtual
        returns (address)
    {
        // 65-byte signatures take the ECDSA path. Any other length is an ERC-1271
        // smart-account session key (E17). The owner grants the scope to the 1271
        // CONTRACT's address; the contract proves control of the digest via
        // isValidSignature. Dispatch lives in `_recoverSigner` so the E10 owner
        // approval path resolves signers by exactly the same rules (D-13).
        return _recoverSigner(_requestDigest(request), signature);
    }

    function _requestStructHash(ActionRequest calldata request) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _ACTION_REQUEST_TYPEHASH,
                request.agentId,
                request.target,
                request.selector,
                request.value,
                request.nonce,
                request.expiry,
                request.rationaleHash,
                keccak256(request.data)
            )
        );
    }

    /// @dev Full EIP-712 digest of an ActionRequest — also bound into owner approvals
    ///      (E10) so a countersignature authorizes exactly one request.
    function _requestDigest(ActionRequest calldata request) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(_EIP712_PREFIX, _domainSeparator(), _requestStructHash(request))
        );
    }

    function _approvalStructHash(bytes32 requestDigest) internal pure returns (bytes32) {
        return keccak256(abi.encode(_REQUEST_APPROVAL_TYPEHASH, requestDigest));
    }

    /// @dev Reads `balanceOf(holder)` on a watchlist token.
    ///
    ///      FAIL-CLOSED (E11-S1). This used to read `return 0` on a failed call or short
    ///      return, which is a silent-failure hole rather than a robustness nicety:
    ///
    ///        1. A snapshot taken before the inner call read 0, and the post-call read is
    ///           also 0, so the delta test `snap[i] > afterBal + declaredTokens` becomes
    ///           `0 > 0 + declared` — always false. The token's entire E11 protection was
    ///           silently DISABLED while the owner still believed it was enforced.
    ///        2. Reading as 0 also DEFEATS the check rather than merely skipping it. A
    ///           non-zero "before" is what makes the comparison fire; forcing "before"
    ///           to 0 means the check can never trip for that token even in the cases
    ///           where it otherwise would have.
    ///        3. It is remotely TRIGGERABLE. A watchlist entry is an arbitrary token
    ///           contract, and its `balanceOf` can start reverting (or start returning
    ///           short data) at any time via an upgrade, a pause, or a hostile
    ///           implementation — and the moment that best serves an attacker who has
    ///           found a way to drain the wallet is the moment the watchlist goes blind.
    ///           The owner's grant is immutable, so there is no way to notice from the
    ///           scope that the protection it names is no longer running.
    ///        4. It contradicted the NATIVE check in the same feature, which is already
    ///           fail-closed: an under-siphoned native balance reverts
    ///           (`NativeDeltaExceeded`), while an unreadable TOKEN silently passes. Two
    ///           halves of one "the inner call must not siphon value" guarantee failing
    ///           in opposite directions is the most dangerous shape a known-and-accepted
    ///           design flaw can take.
    ///
    ///      Reverting instead is what makes the guarantee hold: an unreadable watched
    ///      balance is indistinguishable from an unverifiable one, and the only safe
    ///      response to "I cannot verify this" is to refuse to proceed. A non-standard
    ///      entry is a GRANT-TIME mistake (`_validateScope` cannot probe it), and the
    ///      remedy is to drop it from the watchlist — never to let it silently consume
    ///      the protection budget of the entries that do work.
    ///
    ///      This deliberately reverts from inside the shared helper rather than at each
    ///      call site, so BOTH `_snapshotBalances` (pre-call) and `_verifyBalances`
    ///      (post-call) are covered, and so no future caller can reintroduce fail-open.
    function _erc20BalanceOf(address token, address holder) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSelector(_ERC20_BALANCE_OF_SELECTOR, holder));
        if (!ok || ret.length < 32) revert UnreadableWatchToken(token);
        return abi.decode(ret, (uint256));
    }

    /// @dev Declared token outflow for standard transfer selectors: `transfer` and
    ///      `transferFrom` declare their amount in the calldata; any other selector
    ///      declares nothing (zero tolerance on watched tokens). NOTE: request.data
    ///      EXCLUDES the 4-byte selector — amounts sit at the ABI arg offsets. Both
    ///      length guards are `>=`, not `==`, so a caller that appended extra trailing
    ///      calldata still has its declared amount read (a stricter check would silently
    ///      downgrade the watched-token tolerance to zero).
    function _declaredTokenOutflow(bytes4 selector, bytes calldata data)
        internal
        pure
        returns (uint256)
    {
        if (selector == _ERC20_TRANSFER_SELECTOR && data.length >= 64) {
            // transfer(address,uint256): amount is the 2nd arg → bytes 32..64
            return uint256(bytes32(data[32:64]));
        }
        if (selector == _ERC20_TRANSFER_FROM_SELECTOR && data.length >= 96) {
            // transferFrom(address,address,uint256): amount is the 3rd arg → bytes 64..96
            return uint256(bytes32(data[64:96]));
        }
        return 0;
    }

    /// @dev ECDSA recovery over a 65-byte (r ‖ vs ‖ yParity) signature. `yParity` is
    ///      taken as the SIGNED 27/28 encoding rather than the raw parity bit, so this
    ///      matches the EIP-2098 short-form `v` that ERC-7579 bundles and most wallets
    ///      emit, and keeps a 0/1-parity signature out of scope by construction.
    ///      Mirrors SessionKey7579Module._recover.
    function _ecrecover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != _ECDSA_SIGNATURE_LENGTH) revert InvalidSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 vs = bytes32(signature[32:64]);
        uint8 yParity = uint8(signature[64]);
        if (yParity != 27 && yParity != 28) revert InvalidSignature();
        // EIP-2: reject malleable high-s signatures (s' = N - s verifies identically).
        if (uint256(vs) > _SECP256K1_HALF_ORDER) {
            revert InvalidSignature();
        }
        address recovered = ecrecover(digest, yParity, r, vs);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }

    function _manager() internal pure returns (ManagerStorage storage s) {
        assembly ("memory-safe") {
            s.slot := _STORAGE_LOCATION
        }
    }
}
