// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script, console2} from "forge-std/Script.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @notice Deploys SessionKeyManager with the broadcaster as owner.
/// Usage: SIGILKIT_OWNER_KEY=<0x-prefixed key> forge script contracts/script/Deploy.s.sol --rpc-url <url> --broadcast
contract Deploy is Script {
    function run() external returns (SessionKeyManager manager) {
        // Hard-required: no well-known-key fallback. A forgotten env var must fail loudly,
        // not broadcast from a publicly-known private key (0xA11CE) anyone can spend from.
        uint256 ownerKey = vm.envUint("SIGILKIT_OWNER_KEY");
        address owner = vm.addr(ownerKey);
        vm.startBroadcast(ownerKey);
        manager = new SessionKeyManager(owner);
        vm.stopBroadcast();
        // Log for scripts/CI to pick up.
        console2.log("SessionKeyManager deployed at:", address(manager));
        console2.log("Owner:", owner);
    }
}
