// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CampusToken (CPT)
/// @notice Test-only ERC-20 used by CommitVault on Sepolia. It has a rate-limited
///         faucet so classmates can get play money. It has NO real-world value.
contract CampusToken is ERC20, Ownable {
    uint256 public constant MAX_SUPPLY = 100_000_000 ether;
    uint256 public constant FAUCET_AMOUNT = 1_000 ether;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    mapping(address => uint256) public lastFaucetClaim;

    event FaucetClaimed(address indexed user, uint256 amount);

    error FaucetCooldown(uint256 availableAt);
    error MaxSupplyExceeded();

    constructor(uint256 initialSupply) ERC20("Campus Token", "CPT") Ownable(msg.sender) {
        if (initialSupply > MAX_SUPPLY) revert MaxSupplyExceeded();
        _mint(msg.sender, initialSupply);
    }

    /// @notice Anyone can claim FAUCET_AMOUNT once per cooldown period.
    function faucet() external {
        uint256 last = lastFaucetClaim[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) {
            revert FaucetCooldown(last + FAUCET_COOLDOWN);
        }
        if (totalSupply() + FAUCET_AMOUNT > MAX_SUPPLY) revert MaxSupplyExceeded();
        lastFaucetClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Owner can mint more (e.g. to fund rewards), still capped.
    function mint(address to, uint256 amount) external onlyOwner {
        if (totalSupply() + amount > MAX_SUPPLY) revert MaxSupplyExceeded();
        _mint(to, amount);
    }
}
