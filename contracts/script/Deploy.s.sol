// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script, console2} from "forge-std/Script.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @notice Deploys SessionKeyManager with the broadcaster as owner.
/// Usage: forge script contracts/script/Deploy.s.sol --rpc-url <url> --broadcast
contract Deploy is Script {
    function run() external returns (SessionKeyManager manager) {
        uint256 ownerKey = vm.envOr("SIGILKIT_OWNER_KEY", uint256(0xA11CE));
        address owner = vm.addr(ownerKey);
        vm.startBroadcast(ownerKey);
        manager = new SessionKeyManager(owner);
        vm.stopBroadcast();
        // Log for scripts/CI to pick up.
        console2.log("SessionKeyManager deployed at:", address(manager));
        console2.log("Owner:", owner);
    }
}
