// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GuardedVault} from "../src/GuardedVault.sol";
import {Test} from "forge-std/Test.sol";

/// @dev Shared setup: a 100 ETH vault allowing 10 ETH per hour with a 1 day timelock.
abstract contract VaultFixture is Test {
    GuardedVault internal vault;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal ops = makeAddr("ops");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant LIMIT = 10 ether;
    uint256 internal constant WINDOW = 1 hours;
    uint256 internal constant DELAY = 1 days;
    uint256 internal constant TVL = 100 ether;

    function setUp() public virtual {
        address[] memory withdrawers = new address[](1);
        withdrawers[0] = ops;
        vault = new GuardedVault(admin, guardian, withdrawers, LIMIT, WINDOW, DELAY);
        vm.deal(address(this), TVL);
        vault.deposit{value: TVL}();
    }

    /// @dev Schedules `data` as admin, waits out the delay and executes it.
    function _timelocked(bytes memory data) internal {
        bytes32 salt = keccak256(abi.encode(data, block.timestamp));
        vm.prank(admin);
        vault.schedule(data, salt);
        vm.warp(block.timestamp + DELAY);
        vm.prank(admin);
        vault.execute(data, salt);
    }
}
