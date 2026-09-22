// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @dev Recover-seam harness (same technique as the Halmos specs): Echidna has no
///      vm.sign, so the fuzzer picks WHICH granted key acts by setting the forced
///      signer. Everything else is the real enforcement core.
contract EchidnaHarness is SessionKeyManager {
    address public forced;

    constructor(address owner_) SessionKeyManager(owner_) {}

    function setForced(address a) external {
        forced = a;
    }

    function _recover(ActionRequest calldata, bytes calldata) internal view override returns (address) {
        return forced;
    }
}

/// @title EchidnaProperties — the invariant suite's ghost bookkeeping ported to
///        Echidna properties (enhancement E19): a second, independent fuzzer over
///        the same invariants is a strong audit-readiness signal. Run nightly via
///        CI (echidna-nightly job) with the repository-root echidna.yaml:
///        echidna contracts/test/EchidnaProperties.t.sol SessionKeyManagerEchidna --config echidna.yaml
contract SessionKeyManagerEchidna {
    EchidnaHarness internal skm;
    address[] internal agents;
    mapping(address => uint256) internal successes;
    mapping(address => uint256) internal successesAtRevoke;
    mapping(address => bool) internal everRevoked;
    mapping(address => uint256) internal ghostMaxPerWindowCap;

    constructor() {
        // Owner = this contract: handler_* calls arrive as msg.sender == this (the
        // fuzzer drives this contract), so onlyOwner admin handlers pass.
        skm = new EchidnaHarness(address(this));
        address[2] memory keys;
        keys[0] = address(0xA11);
        keys[1] = address(0xB22);
        for (uint256 i = 0; i < 2; ++i) {
            agents.push(keys[i]);
            skm.grantSessionKey(
                keys[i],
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
            ghostMaxPerWindowCap[keys[i]] = 1 ether;
        }
        skm.setForced(keys[0]);
    }

    // ------------------------------------------------------------------
    // Handlers (only reachable state transitions)
    // ------------------------------------------------------------------
    function h_execute(uint256 agentSeed, uint256 valueSeed, uint256 dataSeed) external {
        address a = agents[agentSeed % agents.length];
        skm.setForced(a);
        SessionKeyManager.ActionRequest memory req = SessionKeyManager.ActionRequest({
            agentId: keccak256("echidna"),
            target: address(this),
            selector: this.sink.selector, // payable no-op target on this contract
            value: valueSeed % 2 ether,
            nonce: skm.getNonce(a),
            expiry: uint48(block.timestamp + 10 minutes),
            rationaleHash: keccak256("echidna"),
            data: abi.encode(dataSeed)
        });
        // The inner call targets THIS contract with a payable no-op so executions
        // succeed whenever the scope allows — the fuzzer explores scope states.
        (bool ok, ) = address(skm).call(
            abi.encodeWithSelector(
                skm.executeWithSessionKey.selector, req, hex"deadbeef", new bytes32[](0), bytes("")
            )
        );
        if (ok) successes[a] += 1;
    }

    /// @dev Payable no-op execution target. NOT named `echidna_*`: under
    ///      `testMode: property` Echidna treats every public `echidna_*` function
    ///      as a property, and a non-bool-returning one is falsified instantly
    ///      (found by the local Echidna 2.2.5 run 2026-09-18).
    function sink() external payable {}

    function h_revoke(uint256 agentSeed) external {
        address a = agents[agentSeed % agents.length];
        if (!everRevoked[a] && !skm.isRevoked(a)) {
            everRevoked[a] = true;
            successesAtRevoke[a] = successes[a];
            skm.revokeSessionKey(a);
        }
    }

    function h_regrant(uint256 agentSeed) external {
        address a = agents[agentSeed % agents.length];
        skm.grantSessionKey(
            a,
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
        ghostMaxPerWindowCap[a] = 1 ether;
        if (!skm.isRevoked(a) && everRevoked[a]) {
            everRevoked[a] = false; // reinstatement re-baselines INV-2
            successesAtRevoke[a] = successes[a];
        }
    }

    // ------------------------------------------------------------------
    // Properties
    // ------------------------------------------------------------------
    function echidna_windowSpendUnderCap() public view returns (bool) {
        for (uint256 i = 0; i < agents.length; ++i) {
            if (skm.getWindowState(agents[i]).spentThisWindow > ghostMaxPerWindowCap[agents[i]]) {
                return false;
            }
        }
        return true;
    }

    function echidna_revokedKeysNeverExecuteAgain() public view returns (bool) {
        for (uint256 i = 0; i < agents.length; ++i) {
            address a = agents[i];
            if (everRevoked[a] && successes[a] > successesAtRevoke[a]) return false;
        }
        return true;
    }

    function echidna_ownerImmutableByFuzzer() public view returns (bool) {
        // The fuzzer never gets ownership (it IS the owner here — but transferOwnership
        // handlers are deliberately NOT exposed, so ownership must never drift).
        return keccak256(abi.encode(skm.owner())) == keccak256(abi.encode(address(this)));
    }

    function echidna_scopesMatchOwnerActions() public view returns (bool) {
        // Every handler grants exactly this scope shape; any drift means an
        // unexposed mutation path exists.
        for (uint256 i = 0; i < agents.length; ++i) {
            SessionKeyManager.Scope memory s = skm.getScope(agents[i]);
            if (s.perActionCap != 0.5 ether || s.windowSeconds != 1 hours) return false;
        }
        return true;
    }
}
