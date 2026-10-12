// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GuardedVault} from "../src/GuardedVault.sol";
import {VaultFixture} from "./VaultFixture.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract GuardedVaultTest is VaultFixture {
    // ------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------

    function test_constructor_setsRolesAndLimits() public view {
        assertTrue(vault.hasRole(vault.ADMIN_ROLE(), admin));
        assertTrue(vault.hasRole(vault.GUARDIAN_ROLE(), guardian));
        assertTrue(vault.hasRole(vault.WITHDRAWER_ROLE(), ops));
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), address(vault)));
        assertFalse(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(vault.withdrawLimit(), LIMIT);
        assertEq(vault.windowDuration(), WINDOW);
        assertEq(vault.timelockDelay(), DELAY);
        assertEq(vault.availableToWithdraw(), LIMIT);
    }

    function test_constructor_rejectsBadConfig() public {
        address[] memory none = new address[](0);
        vm.expectRevert(GuardedVault.ZeroAddress.selector);
        new GuardedVault(address(0), guardian, none, LIMIT, WINDOW, DELAY);

        vm.expectRevert(abi.encodeWithSelector(GuardedVault.InvalidRateLimit.selector, 0, WINDOW));
        new GuardedVault(admin, guardian, none, 0, WINDOW, DELAY);

        vm.expectRevert(abi.encodeWithSelector(GuardedVault.InvalidRateLimit.selector, LIMIT, 10));
        new GuardedVault(admin, guardian, none, LIMIT, 10, DELAY);

        vm.expectRevert(abi.encodeWithSelector(GuardedVault.InvalidTimelockDelay.selector, 1));
        new GuardedVault(admin, guardian, none, LIMIT, WINDOW, 1);

        address[] memory zero = new address[](1);
        vm.expectRevert(GuardedVault.ZeroAddress.selector);
        new GuardedVault(admin, guardian, zero, LIMIT, WINDOW, DELAY);
    }

    // ------------------------------------------------------------------
    // Deposits & withdrawals
    // ------------------------------------------------------------------

    function test_deposit_emitsAndHoldsFunds() public {
        vm.deal(ops, 1 ether);
        vm.expectEmit(address(vault));
        emit GuardedVault.Deposited(ops, 1 ether);
        vm.prank(ops);
        vault.deposit{value: 1 ether}();
        assertEq(address(vault).balance, TVL + 1 ether);
    }

    function test_deposit_rejectsZero() public {
        vm.expectRevert(GuardedVault.ZeroAmount.selector);
        vault.deposit();
    }

    function test_receive_acceptsPlainTransfers() public {
        vm.deal(ops, 1 ether);
        vm.prank(ops);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, TVL + 1 ether);
    }

    function test_withdraw_sendsFundsAndConsumesCapacity() public {
        vm.expectEmit(address(vault));
        emit GuardedVault.Withdrawn(ops, treasury, 4 ether, 6 ether);
        vm.prank(ops);
        vault.withdraw(payable(treasury), 4 ether);

        assertEq(treasury.balance, 4 ether);
        assertEq(address(vault).balance, TVL - 4 ether);
        assertEq(vault.availableToWithdraw(), 6 ether);
    }

    function test_withdraw_requiresWithdrawerRole() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, vault.WITHDRAWER_ROLE()
            )
        );
        vm.prank(stranger);
        vault.withdraw(payable(stranger), 1 ether);
    }

    function test_withdraw_rejectsZeroAmountAndZeroAddress() public {
        vm.startPrank(ops);
        vm.expectRevert(GuardedVault.ZeroAmount.selector);
        vault.withdraw(payable(treasury), 0);
        vm.expectRevert(GuardedVault.ZeroAddress.selector);
        vault.withdraw(payable(address(0)), 1 ether);
        vm.stopPrank();
    }

    function test_withdraw_revertsAboveCapacity() public {
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.RateLimitExceeded.selector, LIMIT + 1, LIMIT));
        vm.prank(ops);
        vault.withdraw(payable(treasury), LIMIT + 1);
    }

    // ------------------------------------------------------------------
    // Rate limit (token bucket)
    // ------------------------------------------------------------------

    function test_rateLimit_refillsLinearly() public {
        vm.prank(ops);
        vault.withdraw(payable(treasury), LIMIT);
        assertEq(vault.availableToWithdraw(), 0);

        vm.warp(block.timestamp + WINDOW / 4);
        assertEq(vault.availableToWithdraw(), LIMIT / 4);

        vm.warp(block.timestamp + WINDOW / 4);
        assertEq(vault.availableToWithdraw(), LIMIT / 2);
    }

    function test_rateLimit_capsAtLimit() public {
        vm.warp(block.timestamp + 10 * WINDOW);
        assertEq(vault.availableToWithdraw(), LIMIT);
    }

    function test_rateLimit_partialWithdrawalsShareTheBucket() public {
        vm.startPrank(ops);
        vault.withdraw(payable(treasury), 6 ether);
        vault.withdraw(payable(treasury), 4 ether);
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.RateLimitExceeded.selector, 1, 0));
        vault.withdraw(payable(treasury), 1);
        vm.stopPrank();
    }

    function testFuzz_rateLimit_neverAllowsMoreThanAvailable(uint256 amount, uint256 elapsed) public {
        vm.prank(ops);
        vault.withdraw(payable(treasury), LIMIT);
        elapsed = bound(elapsed, 0, 2 * WINDOW);
        vm.warp(block.timestamp + elapsed);

        uint256 available = vault.availableToWithdraw();
        assertEq(available, elapsed >= WINDOW ? LIMIT : elapsed * LIMIT / WINDOW);

        amount = bound(amount, 1, 2 * LIMIT);
        vm.prank(ops);
        if (amount > available) {
            vm.expectRevert(
                abi.encodeWithSelector(GuardedVault.RateLimitExceeded.selector, amount, available)
            );
            vault.withdraw(payable(treasury), amount);
        } else {
            vault.withdraw(payable(treasury), amount);
            assertEq(vault.availableToWithdraw(), available - amount);
        }
    }

    function test_getState_reportsEverything() public {
        vm.prank(ops);
        vault.withdraw(payable(treasury), 3 ether);
        GuardedVault.VaultState memory s = vault.getState();
        assertEq(s.balance, TVL - 3 ether);
        assertEq(s.availableToWithdraw, 7 ether);
        assertEq(s.withdrawLimit, LIMIT);
        assertEq(s.windowDuration, WINDOW);
        assertEq(s.timelockDelay, DELAY);
        assertFalse(s.paused);
    }

    // ------------------------------------------------------------------
    // Pause
    // ------------------------------------------------------------------

    function test_pause_onlyGuardian() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, vault.GUARDIAN_ROLE()
            )
        );
        vm.prank(admin);
        vault.pause();
    }

    function test_pause_blocksWithdrawals() public {
        vm.prank(guardian);
        vault.pause();
        assertTrue(vault.paused());

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(ops);
        vault.withdraw(payable(treasury), 1 ether);
    }

    function test_pause_isIdempotent() public {
        vm.startPrank(guardian);
        vault.pause();
        vault.pause();
        vm.stopPrank();
        assertTrue(vault.paused());
    }

    function test_pause_stillAcceptsDeposits() public {
        vm.prank(guardian);
        vault.pause();
        vm.deal(ops, 1 ether);
        vm.prank(ops);
        vault.deposit{value: 1 ether}();
        assertEq(address(vault).balance, TVL + 1 ether);
    }

    function test_unpause_cannotBeCalledDirectly() public {
        vm.prank(guardian);
        vault.pause();
        vm.expectRevert(GuardedVault.OnlyTimelock.selector);
        vm.prank(admin);
        vault.unpause();
    }

    function test_unpause_worksThroughTimelock() public {
        vm.prank(guardian);
        vault.pause();
        _timelocked(abi.encodeCall(GuardedVault.unpause, ()));
        assertFalse(vault.paused());
    }

    function test_unpause_cannotBeScheduledWhileUnpaused() public {
        vm.expectRevert(Pausable.ExpectedPause.selector);
        vm.prank(admin);
        vault.schedule(abi.encodeCall(GuardedVault.unpause, ()), bytes32(0));
    }

    /// @dev A stolen admin key queues spare unpauses during one pause, waits for it to be lifted,
    ///      then tries to use a leftover to instantly undo the next emergency pause.
    function test_unpause_leftoverCannotLiftALaterPause() public {
        bytes memory data = abi.encodeCall(GuardedVault.unpause, ());
        vm.prank(guardian);
        vault.pause();
        assertEq(vault.pauseCount(), 1);

        vm.startPrank(admin);
        vault.schedule(data, bytes32(uint256(1)));
        bytes32 leftover = vault.schedule(data, bytes32(uint256(2)));
        vm.warp(block.timestamp + DELAY);
        vault.execute(data, bytes32(uint256(1)));
        vm.stopPrank();
        assertFalse(vault.paused());

        vm.prank(guardian);
        vault.pause();
        assertEq(vault.pauseCount(), 2);

        vm.expectRevert(abi.encodeWithSelector(GuardedVault.StaleUnpause.selector, leftover));
        vm.prank(admin);
        vault.execute(data, bytes32(uint256(2)));
        assertTrue(vault.paused());

        // An unpause scheduled against the current pause still works.
        _timelocked(data);
        assertFalse(vault.paused());
    }

    // ------------------------------------------------------------------
    // Timelock
    // ------------------------------------------------------------------

    function test_schedule_onlyAdmin() public {
        bytes memory data = abi.encodeCall(GuardedVault.setRateLimit, (1 ether, WINDOW));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, vault.ADMIN_ROLE()
            )
        );
        vm.prank(guardian);
        vault.schedule(data, bytes32(0));
    }

    function test_schedule_rejectsNonAdminFunctions() public {
        bytes memory data = abi.encodeCall(GuardedVault.withdraw, (payable(admin), 1 ether));
        vm.expectRevert(
            abi.encodeWithSelector(GuardedVault.OperationNotAllowed.selector, GuardedVault.withdraw.selector)
        );
        vm.prank(admin);
        vault.schedule(data, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(GuardedVault.OperationNotAllowed.selector, bytes4(0)));
        vm.prank(admin);
        vault.schedule(hex"1234", bytes32(0));
    }

    function test_schedule_rejectsDuplicates() public {
        bytes memory data = abi.encodeCall(GuardedVault.setTimelockDelay, (2 days));
        vm.startPrank(admin);
        bytes32 id = vault.schedule(data, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.OperationAlreadyScheduled.selector, id));
        vault.schedule(data, bytes32(0));
        vm.stopPrank();
    }

    function test_execute_revertsBeforeDelay() public {
        bytes memory data = abi.encodeCall(GuardedVault.setRateLimit, (50 ether, WINDOW));
        vm.prank(admin);
        bytes32 id = vault.schedule(data, bytes32(0));
        uint256 readyAt = block.timestamp + DELAY;

        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.OperationNotReady.selector, id, readyAt));
        vm.prank(admin);
        vault.execute(data, bytes32(0));
    }

    function test_execute_revertsWhenNotScheduled() public {
        bytes memory data = abi.encodeCall(GuardedVault.setRateLimit, (50 ether, WINDOW));
        bytes32 id = vault.hashOperation(data, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.OperationNotScheduled.selector, id));
        vm.prank(admin);
        vault.execute(data, bytes32(0));
    }

    function test_execute_cannotReplay() public {
        bytes memory data = abi.encodeCall(GuardedVault.setTimelockDelay, (2 days));
        vm.prank(admin);
        bytes32 id = vault.schedule(data, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.startPrank(admin);
        vault.execute(data, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.OperationNotScheduled.selector, id));
        vault.execute(data, bytes32(0));
        vm.stopPrank();
    }

    function test_setRateLimit_viaTimelock_neverAddsCapacity() public {
        vm.prank(ops);
        vault.withdraw(payable(treasury), 8 ether); // 2 ether left
        // The schedule→execute path waits a full day, so capture the state right before execution.
        bytes memory data = abi.encodeCall(GuardedVault.setRateLimit, (50 ether, 2 hours));
        vm.prank(admin);
        vault.schedule(data, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        assertEq(vault.availableToWithdraw(), LIMIT); // refilled under the old limit
        vm.prank(admin);
        vault.execute(data, bytes32(0));

        assertEq(vault.withdrawLimit(), 50 ether);
        assertEq(vault.windowDuration(), 2 hours);
        assertEq(vault.availableToWithdraw(), LIMIT); // carried over, not topped up to 50
        vm.warp(block.timestamp + 1 hours);
        assertEq(vault.availableToWithdraw(), LIMIT + 25 ether);
    }

    function test_setters_onlyTimelock() public {
        vm.startPrank(admin);
        vm.expectRevert(GuardedVault.OnlyTimelock.selector);
        vault.setRateLimit(1 ether, WINDOW);
        vm.expectRevert(GuardedVault.OnlyTimelock.selector);
        vault.setTimelockDelay(2 days);
        vm.stopPrank();
    }

    function test_grantRole_onlyViaTimelock() public {
        address newOps = makeAddr("newOps");
        bytes32 role = vault.WITHDRAWER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, vault.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(admin);
        vault.grantRole(role, newOps);

        _timelocked(abi.encodeCall(vault.grantRole, (role, newOps)));
        assertTrue(vault.hasRole(role, newOps));

        _timelocked(abi.encodeCall(vault.revokeRole, (role, newOps)));
        assertFalse(vault.hasRole(role, newOps));
    }

    function test_defaultAdminRole_cannotLeaveTheVault() public {
        bytes32 defaultAdmin = vault.DEFAULT_ADMIN_ROLE();
        bytes memory grant = abi.encodeCall(vault.grantRole, (defaultAdmin, admin));
        vm.prank(admin);
        vault.schedule(grant, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(GuardedVault.ProtectedRole.selector);
        vm.prank(admin);
        vault.execute(grant, bytes32(0));

        bytes memory revoke = abi.encodeCall(vault.revokeRole, (defaultAdmin, address(vault)));
        vm.prank(admin);
        vault.schedule(revoke, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(GuardedVault.ProtectedRole.selector);
        vm.prank(admin);
        vault.execute(revoke, bytes32(0));
    }

    function test_cancel_byGuardian() public {
        bytes memory data = abi.encodeCall(GuardedVault.setRateLimit, (100 ether, WINDOW));
        vm.prank(admin);
        bytes32 id = vault.schedule(data, bytes32(0));

        vm.expectEmit(address(vault));
        emit GuardedVault.OperationCancelled(id, guardian);
        vm.prank(guardian);
        vault.cancel(id);
        assertEq(vault.operationReadyAt(id), 0);

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.OperationNotScheduled.selector, id));
        vm.prank(admin);
        vault.execute(data, bytes32(0));
    }

    function test_cancel_rejectsOthersAndUnknownIds() public {
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.NotAdminOrGuardian.selector, ops));
        vm.prank(ops);
        vault.cancel(bytes32(uint256(1)));

        vm.expectRevert(
            abi.encodeWithSelector(GuardedVault.OperationNotScheduled.selector, bytes32(uint256(1)))
        );
        vm.prank(guardian);
        vault.cancel(bytes32(uint256(1)));
    }

    function test_setTimelockDelay_validatesBounds() public {
        bytes memory data = abi.encodeCall(GuardedVault.setTimelockDelay, (31 days));
        vm.prank(admin);
        vault.schedule(data, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.InvalidTimelockDelay.selector, 31 days));
        vm.prank(admin);
        vault.execute(data, bytes32(0));
    }
}
