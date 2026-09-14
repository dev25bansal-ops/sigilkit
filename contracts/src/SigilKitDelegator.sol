// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SessionKeyManager} from "./SessionKeyManager.sol";

/// @title SigilKitDelegator
/// @notice An EIP-7702-native agent wallet (enhancement E13): the implementation
///         contract an EOA designates via a 7702 authorization (`0xef0100 || this`),
///         giving the EOA the full SigilKit enforcement core — scoped session keys,
///         on-chain spend caps, argument-bound Merkle whitelists, denylist, and the
///         mandatory `ActionLogged` audit — with value flowing from the EOA's OWN
///         balance. No separate treasury contract.
/// @dev Lifecycle:
///      1. The canonical instance is deployed once per chain (its constructor runs
///         there, harmlessly). EOAs designate the canonical address.
///      2. After delegation, the EOA calls `initializeSelfOwned()` exactly once:
///         owner = address(this) (the EOA owns itself) and the admin-selector
///         denylist is seeded. Storage is the EOA's own (ERC-7201 namespaced, so it
///         coexists with other 7702-safe facets).
///      3. The EOA key grants/revokes scoped agent keys directly; anyone may relay
///         `executeWithSessionKey` — value moves from the EOA balance, authorization
///         comes entirely from the session-key signature.
///      Revocation of the delegation itself is the SDK's `signRevocation` (address 0
///      designator), which clears the code entirely.
/// @dev DOMAIN_SEPARATOR binds address(this) = the EOA, so signatures are per-account
///      by construction. An uninitialized delegator is inert: owner == 0 makes every
///      admin path revert NotOwner and no scopes can exist, so executeWithSessionKey
///      always hits KeyUnknown.
contract SigilKitDelegator is SessionKeyManager {
    error AlreadyInitialized();

    constructor() SessionKeyManager(address(this)) {}

    /// @notice One-time self-initialization in the EOA's context after delegation.
    function initializeSelfOwned() external {
        ManagerStorage storage s = _manager();
        if (s.owner != address(0)) revert AlreadyInitialized();
        s.owner = address(this);
        emit OwnershipTransferred(address(0), address(this));
        // Seed the denylist exactly like the manager constructor (defense in depth):
        // even an allow-all-merkle key can never reach administration.
        // CQ-1: contract-qualified selectors (not `this.f.selector`).
        _setSelectorDenied(SessionKeyManager.grantSessionKey.selector, true);
        _setSelectorDenied(SessionKeyManager.revokeSessionKey.selector, true);
        _setSelectorDenied(SessionKeyManager.rotateSessionKey.selector, true);
        _setSelectorDenied(SessionKeyManager.transferOwnership.selector, true);
        _setSelectorDenied(SessionKeyManager.setSelectorDenied.selector, true);
        _setSelectorDenied(SessionKeyManager.withdraw.selector, true);
        _setSelectorDenied(SigilKitDelegator.initializeSelfOwned.selector, true);
    }
}
