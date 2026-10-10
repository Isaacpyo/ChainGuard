// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title GuardedVault
/// @notice ETH treasury with three independent layers of drain protection:
///         1. a token-bucket withdrawal rate limit, so even a fully compromised
///            withdrawer key can only move `withdrawLimit` per `windowDuration`;
///         2. an instant guardian pause, driven by the off-chain ChainGuard watcher
///            that front-runs suspicious mempool transactions;
///         3. a timelock on every admin change (role grants, limit changes and
///            unpausing), so a stolen admin key cannot quietly widen the limits or
///            undo an emergency pause. Guardians can cancel queued operations.
/// @dev The vault holds DEFAULT_ADMIN_ROLE itself, which makes `execute` the only
///      path to `grantRole` / `revokeRole`.
contract GuardedVault is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant WITHDRAWER_ROLE = keccak256("WITHDRAWER_ROLE");

    uint256 public constant MIN_TIMELOCK_DELAY = 1 minutes;
    uint256 public constant MAX_TIMELOCK_DELAY = 30 days;
    uint256 public constant MIN_WINDOW = 1 minutes;
    uint256 public constant MAX_WINDOW = 30 days;
    /// @dev Keeps `elapsed * withdrawLimit` far away from overflow.
    uint256 public constant MAX_WITHDRAW_LIMIT = type(uint128).max;

    /// @notice Bucket capacity: the most that can leave the vault in a burst.
    uint256 public withdrawLimit;
    /// @notice Seconds for an empty bucket to refill to `withdrawLimit`.
    uint256 public windowDuration;
    /// @notice Seconds between `schedule` and `execute` for admin operations.
    uint256 public timelockDelay;

    uint256 private _bucket;
    uint256 private _bucketUpdatedAt;

    /// @notice Timestamp at which a scheduled operation becomes executable (0 = not scheduled).
    mapping(bytes32 id => uint256 readyAt) public operationReadyAt;

    struct VaultState {
        uint256 balance;
        uint256 availableToWithdraw;
        uint256 withdrawLimit;
        uint256 windowDuration;
        uint256 timelockDelay;
        bool paused;
    }

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed by, address indexed to, uint256 amount, uint256 remainingCapacity);
    event RateLimitUpdated(uint256 withdrawLimit, uint256 windowDuration);
    event TimelockDelayUpdated(uint256 delay);
    event OperationScheduled(
        bytes32 indexed id, address indexed proposer, bytes data, bytes32 salt, uint256 readyAt
    );
    event OperationExecuted(bytes32 indexed id, address indexed executor);
    event OperationCancelled(bytes32 indexed id, address indexed canceller);

    error ZeroAddress();
    error ZeroAmount();
    error RateLimitExceeded(uint256 requested, uint256 available);
    error InvalidRateLimit(uint256 withdrawLimit, uint256 windowDuration);
    error InvalidTimelockDelay(uint256 delay);
    error OnlyTimelock();
    error OperationNotAllowed(bytes4 selector);
    error OperationAlreadyScheduled(bytes32 id);
    error OperationNotScheduled(bytes32 id);
    error OperationNotReady(bytes32 id, uint256 readyAt);
    error NotAdminOrGuardian(address account);
    error ProtectedRole();

    /// @dev Restricts a function to calls made by `execute`, i.e. after the timelock delay.
    modifier onlyTimelock() {
        _checkTimelock();
        _;
    }

    constructor(
        address admin,
        address guardian,
        address[] memory withdrawers,
        uint256 limit,
        uint256 window,
        uint256 delay
    ) {
        if (admin == address(0) || guardian == address(0)) revert ZeroAddress();
        _validateRateLimit(limit, window);
        _validateDelay(delay);

        _grantRole(DEFAULT_ADMIN_ROLE, address(this));
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        for (uint256 i; i < withdrawers.length; ++i) {
            if (withdrawers[i] == address(0)) revert ZeroAddress();
            _grantRole(WITHDRAWER_ROLE, withdrawers[i]);
        }

        withdrawLimit = limit;
        windowDuration = window;
        timelockDelay = delay;
        _bucket = limit;
        _bucketUpdatedAt = block.timestamp;

        emit RateLimitUpdated(limit, window);
        emit TimelockDelayUpdated(delay);
    }

    // ---------------------------------------------------------------------
    // Funds
    // ---------------------------------------------------------------------

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Sends `amount` wei to `to`, consuming rate-limit capacity.
    function withdraw(address payable to, uint256 amount)
        external
        onlyRole(WITHDRAWER_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 available = availableToWithdraw();
        if (amount > available) revert RateLimitExceeded(amount, available);

        _bucket = available - amount;
        _bucketUpdatedAt = block.timestamp;

        emit Withdrawn(msg.sender, to, amount, _bucket);
        Address.sendValue(to, amount);
    }

    /// @notice Capacity currently available, including linear refill since the last withdrawal.
    function availableToWithdraw() public view returns (uint256) {
        uint256 refill = (block.timestamp - _bucketUpdatedAt) * withdrawLimit / windowDuration;
        uint256 available = _bucket + refill;
        return available > withdrawLimit ? withdrawLimit : available;
    }

    /// @notice Everything a monitor needs in one RPC call.
    function getState() external view returns (VaultState memory) {
        return VaultState({
            balance: address(this).balance,
            availableToWithdraw: availableToWithdraw(),
            withdrawLimit: withdrawLimit,
            windowDuration: windowDuration,
            timelockDelay: timelockDelay,
            paused: paused()
        });
    }

    // ---------------------------------------------------------------------
    // Emergency controls
    // ---------------------------------------------------------------------

    /// @notice Stops withdrawals immediately. Idempotent so racing guardians never revert.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        if (!paused()) _pause();
    }

    /// @notice Resumes withdrawals. Timelocked: a stolen admin key cannot undo a pause instantly.
    function unpause() external onlyTimelock {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Timelocked administration
    // ---------------------------------------------------------------------

    function hashOperation(bytes calldata data, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(data, salt));
    }

    /// @notice Queues a call to one of this contract's admin functions.
    /// @param data ABI-encoded call to grantRole, revokeRole, setRateLimit, setTimelockDelay or unpause.
    /// @param salt Distinguishes otherwise identical operations.
    function schedule(bytes calldata data, bytes32 salt) external onlyRole(ADMIN_ROLE) returns (bytes32 id) {
        _requireTimelockable(data);
        id = hashOperation(data, salt);
        if (operationReadyAt[id] != 0) revert OperationAlreadyScheduled(id);

        uint256 readyAt = block.timestamp + timelockDelay;
        operationReadyAt[id] = readyAt;
        emit OperationScheduled(id, msg.sender, data, salt, readyAt);
    }

    function execute(bytes calldata data, bytes32 salt) external onlyRole(ADMIN_ROLE) nonReentrant {
        bytes32 id = hashOperation(data, salt);
        uint256 readyAt = operationReadyAt[id];
        if (readyAt == 0) revert OperationNotScheduled(id);
        if (block.timestamp < readyAt) revert OperationNotReady(id, readyAt);

        delete operationReadyAt[id];
        Address.functionCall(address(this), data);
        emit OperationExecuted(id, msg.sender);
    }

    /// @notice Drops a queued operation. Guardians can veto a malicious admin during the delay.
    function cancel(bytes32 id) external {
        if (!hasRole(ADMIN_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert NotAdminOrGuardian(msg.sender);
        }
        if (operationReadyAt[id] == 0) revert OperationNotScheduled(id);
        delete operationReadyAt[id];
        emit OperationCancelled(id, msg.sender);
    }

    function setRateLimit(uint256 limit, uint256 window) external onlyTimelock {
        _validateRateLimit(limit, window);
        uint256 available = availableToWithdraw();
        withdrawLimit = limit;
        windowDuration = window;
        // Never hand out fresh capacity just because the limit changed.
        _bucket = available < limit ? available : limit;
        _bucketUpdatedAt = block.timestamp;
        emit RateLimitUpdated(limit, window);
    }

    function setTimelockDelay(uint256 delay) external onlyTimelock {
        _validateDelay(delay);
        timelockDelay = delay;
        emit TimelockDelayUpdated(delay);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev DEFAULT_ADMIN_ROLE stays with the vault forever; handing it to an EOA
    ///      would let that account grant roles without the timelock.
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE && account != address(this)) revert ProtectedRole();
        return super._grantRole(role, account);
    }

    function _revokeRole(bytes32 role, address account) internal override returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE) revert ProtectedRole();
        return super._revokeRole(role, account);
    }

    function _checkTimelock() private view {
        if (msg.sender != address(this)) revert OnlyTimelock();
    }

    function _requireTimelockable(bytes calldata data) private pure {
        if (data.length < 4) revert OperationNotAllowed(bytes4(0));
        bytes4 selector = bytes4(data[:4]);
        if (
            selector != this.grantRole.selector && selector != this.revokeRole.selector
                && selector != this.setRateLimit.selector && selector != this.setTimelockDelay.selector
                && selector != this.unpause.selector
        ) revert OperationNotAllowed(selector);
    }

    function _validateRateLimit(uint256 limit, uint256 window) private pure {
        if (limit == 0 || limit > MAX_WITHDRAW_LIMIT || window < MIN_WINDOW || window > MAX_WINDOW) {
            revert InvalidRateLimit(limit, window);
        }
    }

    function _validateDelay(uint256 delay) private pure {
        if (delay < MIN_TIMELOCK_DELAY || delay > MAX_TIMELOCK_DELAY) revert InvalidTimelockDelay(delay);
    }
}
