// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script, console2} from "forge-std/Script.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @notice Deploys SessionKeyManager.
/// @dev Governance posture (issues catalog A2 — decided):
///      - PRODUCTION: set SIGILKIT_OWNER_ADDRESS to an existing governance contract
///        (2-of-3 Gnosis Safe, per vault/Build Plan.md). The broadcaster key is then
///        only a deployer and holds NO authority over the deployed manager.
///      - LOCAL/TEST: set SIGILKIT_OWNER_KEY to deploy with a plain EOA owner
///        (the key derives the owner = its own address).
///      The manager is immutable-by-design pre-mainnet: no proxy/UUPS upgrade path
///      exists before the external audit; key migration happens via rotateSessionKey
///      and denylist policy, not code upgrades.
///
/// Usage:
///   SIGILKIT_OWNER_ADDRESS=0xSafe… SIGILKIT_OWNER_KEY=<funded deployer key> forge script …
///   SIGILKIT_OWNER_KEY=<owner key> forge script contracts/script/Deploy.s.sol --rpc-url <url> --broadcast
contract Deploy is Script {
    function run() external returns (SessionKeyManager manager) {
        // Hard-required: no well-known-key fallback. A forgotten env var must fail loudly,
        // not broadcast from a publicly-known private key (0xA11CE) anyone can spend from.
        uint256 broadcasterKey = vm.envUint("SIGILKIT_OWNER_KEY");
        address ownerAddress = vm.envOr("SIGILKIT_OWNER_ADDRESS", address(0));

        address owner;
        if (ownerAddress != address(0)) {
            owner = ownerAddress;
        } else {
            owner = vm.addr(broadcasterKey);
        }

        vm.startBroadcast(broadcasterKey);
        manager = new SessionKeyManager(owner);
        vm.stopBroadcast();
        // Log for scripts/CI to pick up.
        console2.log("SessionKeyManager deployed at:", address(manager));
        console2.log("Owner:", owner);
        if (ownerAddress != address(0) && owner != vm.addr(broadcasterKey)) {
            console2.log(
                "NOTE: broadcaster is a deployer only; authority lives at the owner address (e.g. a Safe)."
            );
        }
    }
}
