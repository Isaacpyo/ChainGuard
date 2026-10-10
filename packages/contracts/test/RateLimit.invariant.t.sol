// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GuardedVault} from "../src/GuardedVault.sol";
import {Test} from "forge-std/Test.sol";

/// @dev Drives the vault with random withdrawals and time jumps while tracking total outflow.
contract RateLimitHandler is Test {
    GuardedVault internal immutable VAULT;
    address internal immutable WITHDRAWER;

    uint256 public immutable STARTED_AT;
    uint256 public totalWithdrawn;

    constructor(GuardedVault vault_, address withdrawer_) {
        VAULT = vault_;
        WITHDRAWER = withdrawer_;
        STARTED_AT = block.timestamp;
    }

    function withdraw(uint256 amount) external {
        uint256 available = VAULT.availableToWithdraw();
        if (available == 0) return;
        amount = bound(amount, 1, available);
        vm.prank(WITHDRAWER);
        VAULT.withdraw(payable(address(0xBEEF)), amount);
        totalWithdrawn += amount;
    }

    function tryOverdraw(uint256 extra) external {
        uint256 available = VAULT.availableToWithdraw();
        extra = bound(extra, 1, 1_000 ether);
        vm.prank(WITHDRAWER);
        vm.expectRevert();
        VAULT.withdraw(payable(address(0xBEEF)), available + extra);
    }

    function wait(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 3 hours));
    }
}

contract RateLimitInvariantTest is Test {
    GuardedVault internal vault;
    RateLimitHandler internal handler;

    uint256 internal constant LIMIT = 10 ether;
    uint256 internal constant WINDOW = 1 hours;

    function setUp() public {
        address withdrawer = makeAddr("withdrawer");
        address[] memory withdrawers = new address[](1);
        withdrawers[0] = withdrawer;
        vault = new GuardedVault(makeAddr("admin"), makeAddr("guardian"), withdrawers, LIMIT, WINDOW, 1 days);
        vm.deal(address(vault), 1_000_000 ether);

        handler = new RateLimitHandler(vault, withdrawer);
        targetContract(address(handler));
    }

    function invariant_bucketNeverExceedsLimit() public view {
        assertLe(vault.availableToWithdraw(), LIMIT);
    }

    /// @dev Over any run, outflow ≤ initial burst + linear refill for the elapsed time.
    function invariant_outflowIsBoundedByElapsedTime() public view {
        uint256 elapsed = block.timestamp - handler.STARTED_AT();
        assertLe(handler.totalWithdrawn(), LIMIT + elapsed * LIMIT / WINDOW);
    }
}
