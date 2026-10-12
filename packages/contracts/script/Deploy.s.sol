// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GuardedVault} from "../src/GuardedVault.sol";
import {Script, console2} from "forge-std/Script.sol";

/// @notice Deploys GuardedVault. Configure with env vars, sign with a keystore account:
///
///   forge script script/Deploy.s.sol --rpc-url sepolia --account deployer --broadcast --verify
///
/// Required: VAULT_ADMIN, VAULT_GUARDIAN.
/// Optional: VAULT_WITHDRAWERS (comma-separated), VAULT_WITHDRAW_LIMIT_WEI, VAULT_WINDOW_SECONDS,
///           VAULT_TIMELOCK_SECONDS, VAULT_SEED_WEI (initial deposit from the deployer).
contract Deploy is Script {
    function run() external returns (GuardedVault vault) {
        address admin = vm.envAddress("VAULT_ADMIN");
        address guardian = vm.envAddress("VAULT_GUARDIAN");
        address[] memory withdrawers = vm.envOr("VAULT_WITHDRAWERS", ",", new address[](0));
        uint256 limit = vm.envOr("VAULT_WITHDRAW_LIMIT_WEI", uint256(0.05 ether));
        uint256 window = vm.envOr("VAULT_WINDOW_SECONDS", uint256(1 hours));
        uint256 delay = vm.envOr("VAULT_TIMELOCK_SECONDS", uint256(1 hours));
        uint256 seed = vm.envOr("VAULT_SEED_WEI", uint256(0));

        vm.startBroadcast();
        vault = new GuardedVault(admin, guardian, withdrawers, limit, window, delay);
        if (seed > 0) vault.deposit{value: seed}();
        vm.stopBroadcast();

        console2.log("GuardedVault deployed at", address(vault));
        console2.log("  admin    ", admin);
        console2.log("  guardian ", guardian);
        console2.log("  limit    ", limit, "wei per", window);
        console2.log("  timelock ", delay, "seconds");
    }
}
