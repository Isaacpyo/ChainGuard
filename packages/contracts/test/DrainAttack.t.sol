// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GuardedVault} from "../src/GuardedVault.sol";
import {VaultFixture} from "./VaultFixture.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Simulated drain: an attacker holds a withdrawer key and tries to empty the vault.
contract DrainAttackTest is VaultFixture {
    address internal attacker = makeAddr("attacker");
    bytes32 internal constant SALT = keccak256("attack");

    function setUp() public override {
        super.setUp();
        // How the attacker got the role does not matter here (leaked key, malicious insider…).
        _timelocked(abi.encodeCall(vault.grantRole, (vault.WITHDRAWER_ROLE(), attacker)));
    }

    /// @dev Fires `attempts` withdrawals of `amount`, ignoring failures, and returns how many landed.
    function _burst(uint256 attempts, uint256 amount) internal returns (uint256 landed) {
        for (uint256 i; i < attempts; ++i) {
            vm.prank(attacker);
            try vault.withdraw(payable(attacker), amount) {
                ++landed;
            } catch {}
        }
    }

    function test_withoutGuardian_rateLimitCapsTheLoss() public {
        // Burst: 20 x 5 ETH would empty the vault; the bucket only allows 10 ETH.
        assertEq(_burst(20, 5 ether), 2);
        assertEq(attacker.balance, LIMIT);

        // Keep hammering for six hours: the drain rate is pinned to 10 ETH/hour.
        for (uint256 h; h < 6; ++h) {
            vm.warp(block.timestamp + WINDOW);
            _burst(20, 5 ether);
        }
        assertEq(attacker.balance, 7 * LIMIT);
        assertEq(address(vault).balance, TVL - 7 * LIMIT);
    }

    function test_guardianFrontRunsTheDrain_zeroLoss() public {
        // The watcher sees the first drain transaction pending and its pause() lands first.
        vm.prank(guardian);
        vault.pause();

        assertEq(_burst(20, 5 ether), 0);
        assertEq(attacker.balance, 0);
        assertEq(address(vault).balance, TVL);
    }

    function test_guardianPausesMidAttack_lossBoundedByFirstTransaction() public {
        assertEq(_burst(1, 5 ether), 1); // first tx slipped through before detection
        vm.prank(guardian);
        vault.pause();

        assertEq(_burst(20, 5 ether), 0);
        vm.warp(block.timestamp + 7 days); // waiting for the bucket to refill does not help
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(attacker);
        vault.withdraw(payable(attacker), 1 ether);

        assertEq(attacker.balance, 5 ether);
        assertEq(address(vault).balance, TVL - 5 ether);
    }

    function test_stolenAdminKey_cannotUnpauseOrRaiseLimitBeforeGuardianCancels() public {
        vm.prank(guardian);
        vault.pause();

        // The attacker also stole the admin key and tries to undo the pause and lift the limit.
        vm.prank(admin);
        vm.expectRevert(GuardedVault.OnlyTimelock.selector);
        vault.unpause();

        bytes memory unpause = abi.encodeCall(GuardedVault.unpause, ());
        bytes memory raise = abi.encodeCall(GuardedVault.setRateLimit, (TVL, 1 minutes));
        vm.startPrank(admin);
        bytes32 unpauseId = vault.schedule(unpause, SALT);
        bytes32 raiseId = vault.schedule(raise, SALT);
        vm.stopPrank();

        // ChainGuard flags the schedule() calls; the guardian vetoes during the delay.
        vm.startPrank(guardian);
        vault.cancel(unpauseId);
        vault.cancel(raiseId);
        vm.stopPrank();

        vm.warp(block.timestamp + DELAY);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.OperationNotScheduled.selector, unpauseId));
        vault.execute(unpause, SALT);
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.OperationNotScheduled.selector, raiseId));
        vault.execute(raise, SALT);
        vm.stopPrank();

        assertTrue(vault.paused());
        assertEq(vault.withdrawLimit(), LIMIT);
        assertEq(address(vault).balance, TVL);
    }
}

/// @notice A malicious withdrawer contract that re-enters on receipt of ETH.
contract ReentrantDrainer {
    GuardedVault internal immutable VAULT;
    uint256 public reentries;

    constructor(GuardedVault vault_) {
        VAULT = vault_;
    }

    function attack(uint256 amount) external {
        VAULT.withdraw(payable(address(this)), amount);
    }

    receive() external payable {
        ++reentries;
        VAULT.withdraw(payable(address(this)), msg.value);
    }
}

contract ReentrancyAttackTest is VaultFixture {
    function test_reentrantWithdrawIsBlocked() public {
        ReentrantDrainer drainer = new ReentrantDrainer(vault);
        _timelocked(abi.encodeCall(vault.grantRole, (vault.WITHDRAWER_ROLE(), address(drainer))));

        // The nested withdraw hits the reentrancy guard; sendValue bubbles that revert up.
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        drainer.attack(1 ether);

        assertEq(address(drainer).balance, 0);
        assertEq(address(vault).balance, TVL);
        assertEq(vault.availableToWithdraw(), LIMIT);
    }
}
