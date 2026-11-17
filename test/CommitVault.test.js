const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const DAY = 24 * 3600;
const e = (n) => ethers.parseEther(String(n));

async function deployFixture() {
  const [owner, alice, bob, mallory] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("CampusToken")).deploy(e(1_000_000));
  const vault = await (await ethers.getContractFactory("CommitVault")).deploy(await token.getAddress());
  for (const u of [alice, bob, mallory]) {
    await token.transfer(u.address, e(10_000));
    await token.connect(u).approve(await vault.getAddress(), ethers.MaxUint256);
  }
  await token.approve(await vault.getAddress(), ethers.MaxUint256);
  return { owner, alice, bob, mallory, token, vault };
}

describe("CampusToken", () => {
  it("faucet pays 1000 CPT and enforces 1-day cooldown", async () => {
    const { token, mallory } = await loadFixture(deployFixture);
    const before = await token.balanceOf(mallory.address);
    await token.connect(mallory).faucet();
    expect(await token.balanceOf(mallory.address)).to.equal(before + e(1000));
    await expect(token.connect(mallory).faucet()).to.be.revertedWithCustomError(token, "FaucetCooldown");
    await time.increase(DAY + 1);
    await token.connect(mallory).faucet();
  });
  it("only owner can mint", async () => {
    const { token, mallory } = await loadFixture(deployFixture);
    await expect(token.connect(mallory).mint(mallory.address, 1)).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
  });
});

describe("CommitVault", () => {
  describe("deposit", () => {
    it("creates a position with the right weight and emits Deposited", async () => {
      const { vault, alice } = await loadFixture(deployFixture);
      await expect(vault.connect(alice).deposit(e(1000), 2)).to.emit(vault, "Deposited");
      const [p] = await vault.positionsOf(alice.address);
      expect(p.amount).to.equal(e(1000));
      expect(p.weight).to.equal(e(2500)); // 2.5x
      expect(await vault.totalWeight()).to.equal(e(2500));
    });
    it("rejects dust, bad tier and >20 positions", async () => {
      const { vault, alice } = await loadFixture(deployFixture);
      await expect(vault.connect(alice).deposit(1, 0)).to.be.revertedWithCustomError(vault, "AmountTooSmall");
      await expect(vault.connect(alice).deposit(e(1), 3)).to.be.revertedWithCustomError(vault, "InvalidTier");
      for (let i = 0; i < 20; i++) await vault.connect(alice).deposit(e(1), 0);
      await expect(vault.connect(alice).deposit(e(1), 0)).to.be.revertedWithCustomError(vault, "TooManyPositions");
    });
  });

  describe("rewards", () => {
    it("splits a 7000 CPT stream 5:2 between 2.5x and 1.0x stakers", async () => {
      const { vault, owner, alice, bob } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(e(1000), 2);
      await vault.connect(bob).deposit(e(1000), 0);
      await vault.fundRewards(e(7000), 7 * DAY);
      await time.increase(7 * DAY);
      const a = await vault.pendingReward(alice.address, 0);
      const b = await vault.pendingReward(bob.address, 0);
      expect(a).to.be.closeTo(e(5000), e(1) / 1000n);
      expect(b).to.be.closeTo(e(2000), e(1) / 1000n);
    });
    it("claim() pays rewards without closing the position", async () => {
      const { vault, token, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(e(1000), 0);
      await vault.fundRewards(e(700), 7 * DAY);
      await time.increase(3 * DAY);
      const before = await token.balanceOf(alice.address);
      await vault.connect(alice).claim(0);
      expect(await token.balanceOf(alice.address)).to.be.gt(before);
      expect((await vault.positionsOf(alice.address))[0].closed).to.equal(false);
    });
  });

  describe("withdraw", () => {
    it("after unlock returns principal + rewards", async () => {
      const { vault, token, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(e(1000), 0);
      await vault.fundRewards(e(300), 30 * DAY);
      await time.increase(31 * DAY);
      const before = await token.balanceOf(alice.address);
      await expect(vault.connect(alice).withdraw(0)).to.emit(vault, "Withdrawn");
      expect(await token.balanceOf(alice.address)).to.be.closeTo(before + e(1300), e(1) / 1000n);
    });
    it("early exit: 10% penalty, rewards forfeited and re-streamed to remaining stakers", async () => {
      const { vault, token, alice, bob } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(e(1000), 2);
      await vault.connect(bob).deposit(e(1000), 2);
      await vault.fundRewards(e(1400), 7 * DAY);
      await time.increase(3 * DAY);
      const before = await token.balanceOf(bob.address);
      await expect(vault.connect(bob).withdraw(0)).to.emit(vault, "EarlyExit");
      expect(await token.balanceOf(bob.address)).to.equal(before + e(900));
      await time.increase(10 * DAY);
      expect(await vault.pendingReward(alice.address, 0)).to.be.gt(e(800)); // her share + penalty stream
    });
    it("cannot withdraw twice / invalid id / someone else's position", async () => {
      const { vault, alice, bob } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(e(10), 0);
      await expect(vault.connect(bob).withdraw(0)).to.be.revertedWithCustomError(vault, "InvalidPosition");
      await vault.connect(alice).withdraw(0);
      await expect(vault.connect(alice).withdraw(0)).to.be.revertedWithCustomError(vault, "PositionClosed");
    });
    it("solvency: vault token balance == principal + reward reserve", async () => {
      const { vault, token, alice, bob } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(e(500), 1);
      await vault.connect(bob).deposit(e(700), 0);
      await vault.fundRewards(e(900), 10 * DAY);
      await time.increase(5 * DAY);
      await vault.connect(bob).withdraw(0); // early
      await vault.connect(alice).claim(0);
      const bal = await token.balanceOf(await vault.getAddress());
      expect(bal).to.equal((await vault.totalPrincipal()) + (await vault.rewardReserve()));
    });
  });

  describe("admin / access control", () => {
    it("only owner can fund and pause", async () => {
      const { vault, mallory } = await loadFixture(deployFixture);
      await expect(vault.connect(mallory).fundRewards(e(1), DAY)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      await expect(vault.connect(mallory).pause()).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
    it("pause blocks deposits but users can still exit", async () => {
      const { vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(e(100), 0);
      await vault.pause();
      await expect(vault.connect(alice).deposit(e(1), 0)).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await expect(vault.connect(alice).withdraw(0)).to.emit(vault, "EarlyExit");
    });
    it("rejects too-short reward duration", async () => {
      const { vault } = await loadFixture(deployFixture);
      await expect(vault.fundRewards(e(1), 100)).to.be.revertedWithCustomError(vault, "DurationTooShort");
    });
  });

  describe("fuzz-style property", () => {
    it("random sequence keeps solvency invariant", async () => {
      const { vault, token, owner, alice, bob } = await loadFixture(deployFixture);
      await vault.fundRewards(e(5000), 20 * DAY);
      const users = [alice, bob];
      for (let i = 0; i < 25; i++) {
        const u = users[i % 2];
        const n = Number(await vault.positionCount(u.address));
        const op = (i * 7) % 4;
        try {
          if (op === 0 || n === 0) await vault.connect(u).deposit(e(10 + i), i % 3);
          else if (op === 1) await vault.connect(u).claim(n - 1);
          else if (op === 2) await vault.connect(u).withdraw(n - 1);
          else await vault.fundRewards(e(50), 2 * DAY);
        } catch (_) { /* reverts on closed positions are fine */ }
        await time.increase(2 * DAY);
        const bal = await token.balanceOf(await vault.getAddress());
        expect(bal).to.equal((await vault.totalPrincipal()) + (await vault.rewardReserve()));
      }
    });
  });
});
