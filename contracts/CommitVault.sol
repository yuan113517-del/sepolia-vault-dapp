// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title CommitVault
/// @notice Commitment-based staking vault. Users lock tokens for 30/90/180 days to
///         earn a share of a streaming reward pool. Longer lock = bigger weight.
///         Leaving early costs a 10% penalty AND forfeits unclaimed rewards; both
///         are re-streamed (over 7 days) to the users who stay. (Novelty: "patient
///         savers are paid by impatient ones".)
/// @dev Reward streaming follows the well-known "rewardPerToken" accumulator idea
///      (Synthetix StakingRewards), adapted to weighted positions. No loops over users.
contract CommitVault is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ---------------------------------------------------------------- constants
    uint256 private constant PRECISION = 1e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant PENALTY_BPS = 1_000; // 10 %
    uint256 public constant PENALTY_STREAM_DURATION = 7 days;
    uint256 public constant MIN_DEPOSIT = 1 ether;
    uint256 public constant MAX_POSITIONS = 20; // bounds per-user array
    uint256 public constant MIN_REWARD_DURATION = 1 days;

    // ------------------------------------------------------------------ storage
    struct Position {
        uint128 amount; // principal
        uint128 weight; // amount * multiplier / BPS
        uint64 unlockTime;
        uint8 tier;
        bool closed;
        uint256 rewardPerWeightPaid;
        uint256 rewardsStored; // settled but unclaimed rewards
    }

    IERC20 public immutable token;

    uint256 public totalPrincipal;
    uint256 public totalWeight;
    uint256 public rewardReserve; // tokens held for rewards (not principal)

    uint256 public rewardRate; // tokens per second
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardPerWeightStored;

    mapping(address => Position[]) private _positions;

    // ------------------------------------------------------------------- events
    event Deposited(address indexed user, uint256 indexed id, uint256 amount, uint8 tier, uint64 unlockTime);
    event Withdrawn(address indexed user, uint256 indexed id, uint256 principalOut, uint256 rewardOut);
    event EarlyExit(address indexed user, uint256 indexed id, uint256 penalty, uint256 forfeitedRewards);
    event RewardClaimed(address indexed user, uint256 indexed id, uint256 reward);
    event RewardFunded(address indexed funder, uint256 amount, uint256 duration);
    event RewardStreamExtended(uint256 amount, uint256 newRate, uint256 periodFinish);

    // ------------------------------------------------------------------- errors
    error ZeroAddress();
    error AmountTooSmall();
    error InvalidTier();
    error TooManyPositions();
    error InvalidPosition();
    error PositionClosed();
    error DurationTooShort();
    error RateTooHigh();

    constructor(IERC20 token_) Ownable(msg.sender) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    // ------------------------------------------------------------ user actions
    function deposit(uint256 amount, uint8 tier) external nonReentrant whenNotPaused {
        if (amount < MIN_DEPOSIT) revert AmountTooSmall();
        (uint256 duration, uint256 multiplier) = tierInfo(tier);
        if (_positions[msg.sender].length >= MAX_POSITIONS) revert TooManyPositions();

        _updateGlobal();

        uint128 weight = ((amount * multiplier) / BPS).toUint128();
        uint64 unlockTime = (block.timestamp + duration).toUint64();

        _positions[msg.sender].push(
            Position({
                amount: amount.toUint128(),
                weight: weight,
                unlockTime: unlockTime,
                tier: tier,
                closed: false,
                rewardPerWeightPaid: rewardPerWeightStored,
                rewardsStored: 0
            })
        );
        totalPrincipal += amount;
        totalWeight += weight;

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, _positions[msg.sender].length - 1, amount, tier, unlockTime);
    }

    /// @notice Claim rewards of one position without closing it.
    function claim(uint256 id) external nonReentrant {
        Position storage p = _getOpen(msg.sender, id);
        _updateGlobal();
        uint256 reward = _settle(p);
        p.rewardsStored = 0;
        reward = _payReward(reward);
        emit RewardClaimed(msg.sender, id, reward);
    }

    /// @notice Close a position. After unlock: principal + rewards.
    ///         Before unlock: principal - 10% penalty, rewards forfeited.
    function withdraw(uint256 id) external nonReentrant {
        Position storage p = _getOpen(msg.sender, id);
        _updateGlobal();

        uint256 reward = _settle(p);
        uint256 principal = p.amount;

        // effects first (checks-effects-interactions)
        p.closed = true;
        p.rewardsStored = 0;
        totalPrincipal -= principal;
        totalWeight -= p.weight;

        if (block.timestamp >= p.unlockTime) {
            reward = _payReward(reward);
            token.safeTransfer(msg.sender, principal);
            emit Withdrawn(msg.sender, id, principal, reward);
        } else {
            uint256 penalty = (principal * PENALTY_BPS) / BPS;
            rewardReserve += penalty; // principal -> reward reserve
            // forfeited rewards are already inside the reserve; re-stream both
            _extendStream(penalty + reward, PENALTY_STREAM_DURATION);
            token.safeTransfer(msg.sender, principal - penalty);
            emit EarlyExit(msg.sender, id, penalty, reward);
            emit Withdrawn(msg.sender, id, principal - penalty, 0);
        }
    }

    // ------------------------------------------------------------- owner/admin
    /// @notice Owner adds reward tokens that stream to stakers over `duration`.
    function fundRewards(uint256 amount, uint256 duration) external onlyOwner nonReentrant whenNotPaused {
        if (duration < MIN_REWARD_DURATION) revert DurationTooShort();
        _updateGlobal();
        rewardReserve += amount;
        _extendStream(amount, duration);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardFunded(msg.sender, amount, duration);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
    // NOTE: withdraw()/claim() are intentionally NOT pausable: users can always exit.

    // -------------------------------------------------------------------- views
    /// @return duration lock length in seconds, multiplier in basis points
    function tierInfo(uint8 tier) public pure returns (uint256 duration, uint256 multiplier) {
        if (tier == 0) return (30 days, 10_000); // 1.0x
        if (tier == 1) return (90 days, 15_000); // 1.5x
        if (tier == 2) return (180 days, 25_000); // 2.5x
        revert InvalidTier();
    }

    function positionsOf(address user) external view returns (Position[] memory) {
        return _positions[user];
    }

    function positionCount(address user) external view returns (uint256) {
        return _positions[user].length;
    }

    function pendingReward(address user, uint256 id) external view returns (uint256) {
        if (id >= _positions[user].length) return 0;
        Position storage p = _positions[user][id];
        if (p.closed) return 0;
        return p.rewardsStored + (uint256(p.weight) * (_rewardPerWeight() - p.rewardPerWeightPaid)) / PRECISION;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    // ---------------------------------------------------------------- internals
    function _rewardPerWeight() internal view returns (uint256) {
        if (totalWeight == 0) return rewardPerWeightStored;
        return rewardPerWeightStored
            + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * PRECISION) / totalWeight;
    }

    function _updateGlobal() internal {
        rewardPerWeightStored = _rewardPerWeight();
        lastUpdateTime = lastTimeRewardApplicable();
    }

    /// @dev Must be called after _updateGlobal(). Caller must already have
    ///      increased rewardReserve by any new tokens.
    function _extendStream(uint256 amount, uint256 duration) internal {
        uint256 remaining = block.timestamp >= periodFinish ? 0 : periodFinish - block.timestamp;
        uint256 leftover = remaining * rewardRate;
        rewardRate = (amount + leftover) / duration;
        if (rewardRate * duration > rewardReserve) revert RateTooHigh();
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardStreamExtended(amount, rewardRate, periodFinish);
    }

    function _settle(Position storage p) internal returns (uint256) {
        uint256 current = rewardPerWeightStored;
        uint256 earned = p.rewardsStored + (uint256(p.weight) * (current - p.rewardPerWeightPaid)) / PRECISION;
        p.rewardPerWeightPaid = current;
        return earned;
    }

    function _payReward(uint256 reward) internal returns (uint256) {
        if (reward > rewardReserve) reward = rewardReserve; // rounding safety
        if (reward == 0) return 0;
        rewardReserve -= reward;
        token.safeTransfer(msg.sender, reward);
        return reward;
    }

    function _getOpen(address user, uint256 id) internal view returns (Position storage p) {
        if (id >= _positions[user].length) revert InvalidPosition();
        p = _positions[user][id];
        if (p.closed) revert PositionClosed();
    }
}
