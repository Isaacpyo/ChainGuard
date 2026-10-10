// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deploy} from "../script/Deploy.s.sol";
import {GuardedVault} from "../src/GuardedVault.sol";
import {Test} from "forge-std/Test.sol";

contract DeployScriptTest is Test {
    function test_run_deploysWithEnvConfig() public {
        address admin = makeAddr("admin");
        address guardian = makeAddr("guardian");
        address ops = makeAddr("ops");
        vm.setEnv("VAULT_ADMIN", vm.toString(admin));
        vm.setEnv("VAULT_GUARDIAN", vm.toString(guardian));
        vm.setEnv("VAULT_WITHDRAWERS", vm.toString(ops));
        vm.setEnv("VAULT_WITHDRAW_LIMIT_WEI", "1000000000000000000");
        vm.setEnv("VAULT_WINDOW_SECONDS", "7200");
        vm.setEnv("VAULT_TIMELOCK_SECONDS", "3600");
        vm.setEnv("VAULT_SEED_WEI", "0");

        GuardedVault vault = new Deploy().run();

        assertTrue(vault.hasRole(vault.ADMIN_ROLE(), admin));
        assertTrue(vault.hasRole(vault.GUARDIAN_ROLE(), guardian));
        assertTrue(vault.hasRole(vault.WITHDRAWER_ROLE(), ops));
        assertEq(vault.withdrawLimit(), 1 ether);
        assertEq(vault.windowDuration(), 2 hours);
        assertEq(vault.timelockDelay(), 1 hours);
    }
}
