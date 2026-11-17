/* JavaScript mirror of contracts/CommitVault.sol (BigInt, same integer maths).
   Used by the demo mode of frontend/index.html so the dApp runs with no wallet. */
(function (root) {
  const E18 = 10n ** 18n, BPS = 10000n, DAY = 86400n;
  const TIERS = [{ d: 30n * DAY, m: 10000n }, { d: 90n * DAY, m: 15000n }, { d: 180n * DAY, m: 25000n }];
  const PENALTY_BPS = 1000n, PENALTY_STREAM = 7n * DAY, MIN_DEPOSIT = E18, MAX_POS = 20;
  const fail = (name) => { throw new Error(name); };

  class VaultModel {
    constructor() {
      this.now = 1700000000n; this.paused = false;
      this.wallet = {}; this.faucetAt = {}; this.pos = {};
      this.totalPrincipal = 0n; this.totalWeight = 0n; this.reserve = 0n;
      this.rate = 0n; this.finish = 0n; this.last = 0n; this.rpw = 0n;
      this.vaultBal = 0n; this.events = [];
    }
    bal(u) { return this.wallet[u] || 0n; }
    emit(name, data) { this.events.unshift({ t: this.now, name, ...data }); this.events.length = Math.min(this.events.length, 40); }
    advance(sec) { this.now += BigInt(sec); }
    applicable() { return this.now < this.finish ? this.now : this.finish; }
    rpwNow() {
      if (this.totalWeight === 0n) return this.rpw;
      return this.rpw + ((this.applicable() - this.last) * this.rate * E18) / this.totalWeight;
    }
    update() { this.rpw = this.rpwNow(); this.last = this.applicable(); }
    extend(amount, duration) {
      const remaining = this.now >= this.finish ? 0n : this.finish - this.now;
      this.rate = (amount + remaining * this.rate) / duration;
      if (this.rate * duration > this.reserve) fail('RateTooHigh');
      this.last = this.now; this.finish = this.now + duration;
    }
    settle(p) {
      const earned = p.stored + (p.weight * (this.rpw - p.paid)) / E18;
      p.paid = this.rpw; return earned;
    }
    payReward(user, r) {
      if (r > this.reserve) r = this.reserve;
      if (r === 0n) return 0n;
      this.reserve -= r; this.vaultBal -= r; this.wallet[user] = this.bal(user) + r; return r;
    }
    getOpen(user, id) {
      const list = this.pos[user] || [];
      if (id >= list.length) fail('InvalidPosition');
      if (list[id].closed) fail('PositionClosed');
      return list[id];
    }
    faucet(user) {
      const last = this.faucetAt[user];
      if (last !== undefined && this.now < last + DAY) fail('FaucetCooldown');
      this.faucetAt[user] = this.now; this.wallet[user] = this.bal(user) + 1000n * E18;
      this.emit('FaucetClaimed', { user, amount: 1000n * E18 });
    }
    deposit(user, amount, tier) {
      if (this.paused) fail('EnforcedPause');
      if (amount < MIN_DEPOSIT) fail('AmountTooSmall');
      if (!TIERS[tier]) fail('InvalidTier');
      const list = (this.pos[user] = this.pos[user] || []);
      if (list.length >= MAX_POS) fail('TooManyPositions');
      if (this.bal(user) < amount) fail('ERC20InsufficientBalance');
      this.update();
      const weight = (amount * TIERS[tier].m) / BPS;
      list.push({ amount, weight, unlock: this.now + TIERS[tier].d, tier, closed: false, paid: this.rpw, stored: 0n });
      this.totalPrincipal += amount; this.totalWeight += weight;
      this.wallet[user] = this.bal(user) - amount; this.vaultBal += amount;
      this.emit('Deposited', { user, id: list.length - 1, amount, tier });
    }
    claim(user, id) {
      const p = this.getOpen(user, id); this.update();
      const r = this.payReward(user, this.settle(p)); p.stored = 0n;
      this.emit('RewardClaimed', { user, id, reward: r });
    }
    withdraw(user, id) {
      const p = this.getOpen(user, id); this.update();
      const reward = this.settle(p), principal = p.amount;
      p.closed = true; p.stored = 0n; this.totalPrincipal -= principal; this.totalWeight -= p.weight;
      if (this.now >= p.unlock) {
        const paid = this.payReward(user, reward);
        this.vaultBal -= principal; this.wallet[user] = this.bal(user) + principal;
        this.emit('Withdrawn', { user, id, principal, reward: paid });
      } else {
        const penalty = (principal * PENALTY_BPS) / BPS;
        this.reserve += penalty;
        this.extend(penalty + reward, PENALTY_STREAM);
        this.vaultBal -= principal - penalty; this.wallet[user] = this.bal(user) + principal - penalty;
        this.emit('EarlyExit', { user, id, penalty, forfeited: reward });
      }
    }
    fund(owner, amount, duration) {
      if (this.paused) fail('EnforcedPause');
      if (BigInt(duration) < DAY) fail('DurationTooShort');
      if (this.bal(owner) < amount) fail('ERC20InsufficientBalance');
      this.update(); this.reserve += amount; this.extend(amount, BigInt(duration));
      this.wallet[owner] = this.bal(owner) - amount; this.vaultBal += amount;
      this.emit('RewardFunded', { user: owner, amount });
    }
    pending(user, id) {
      const list = this.pos[user] || []; if (id >= list.length || list[id].closed) return 0n;
      const p = list[id]; return p.stored + (p.weight * (this.rpwNow() - p.paid)) / E18;
    }
    apr() { // yearly reward / principal, as a number in %
      if (this.totalPrincipal === 0n || this.now >= this.finish) return 0;
      return Number((this.rate * 31536000n * 10000n) / this.totalPrincipal) / 100;
    }
  }
  VaultModel.TIERS = TIERS; VaultModel.E18 = E18; VaultModel.DAY = DAY;
  root.VaultModel = VaultModel;
  if (typeof module !== 'undefined') module.exports = VaultModel;
})(typeof window !== 'undefined' ? window : globalThis);
