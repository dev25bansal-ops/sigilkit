// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script, console2} from "forge-std/Script.sol";
import {SessionKeyManager} from "../src/SessionKeyManager.sol";

/// @notice Deploys SessionKeyManager deterministically via CREATE2 (issues catalog T5).
/// @dev Uses the canonical deterministic-deployment proxy (nick's method, per EIP-1014
///      workflow) at 0x4e59b44847b379578588920cA78FbF26c0B4956C — present on Base,
///      mainnet, and virtually every EVM chain. The resulting address depends only on
///      (salt, owner) — identical across every chain where the proxy exists, which is
///      the multi-chain requirement from the build plan. Fails loudly if the proxy is
///      missing rather than silently deploying at a different address class.
///
/// Usage:
///   SIGILKIT_OWNER_ADDRESS=0xSafe… SIGILKIT_CREATE2_SALT=0x… \
///     SIGILKIT_OWNER_KEY=<funded deployer key> forge script contracts/script/DeployDeterministic.s.sol --rpc-url <url> --broadcast
contract DeployDeterministic is Script {
    /// @notice Canonical deterministic-deployment proxy (deployed once per chain by
    ///         the 0x4e59… transaction; it simply CREATE2s `salt || initCode` calls).
    address internal constant DEPLOYER_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external returns (SessionKeyManager manager) {
        uint256 broadcasterKey = vm.envUint("SIGILKIT_OWNER_KEY");
        address ownerAddress = vm.envOr("SIGILKIT_OWNER_ADDRESS", address(0));
        if (ownerAddress == address(0)) {
            revert("SIGILKIT_OWNER_ADDRESS required: deterministic deploys are for cross-chain sameness, so the owner must be an explicit address (e.g. a Safe), not the broadcaster's");
        }
        bytes32 salt = vm.envBytes32("SIGILKIT_CREATE2_SALT");
        if (salt == bytes32(0)) revert("SIGILKIT_CREATE2_SALT must be non-zero");

        address proxyCode = DEPLOYER_PROXY.code.length > 0 ? DEPLOYER_PROXY : address(0);
        if (proxyCode == address(0)) {
            revert("deterministic-deploy proxy missing on this chain; deploy it first (see nick's method) or use Deploy.s.sol");
        }

        bytes memory initCode = abi.encodePacked(type(SessionKeyManager).creationCode, abi.encode(ownerAddress));
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), DEPLOYER_PROXY);

        vm.startBroadcast(broadcasterKey);
        (bool ok, bytes memory ret) = DEPLOYER_PROXY.call(abi.encodePacked(salt, initCode));
        if (!ok) revert("CREATE2 deploy failed");
        // CREATE2 returns exactly 20 bytes; narrowing bytes20 -> uint160 -> address is
        // lossless. The cast is the standard extraction, not a truncation.
        // forge-lint: disable-next-line(unsafe-typecast)
        address deployed = address(uint160(bytes20(ret)));
        manager = SessionKeyManager(payable(deployed));
        vm.stopBroadcast();

        require(deployed == predicted, "deployed address differs from prediction");
        console2.log("SessionKeyManager deployed deterministically at:", address(manager));
        console2.log("Owner:", ownerAddress);
        console2.log("Salt:");
        console2.logBytes32(salt);
    }
}
