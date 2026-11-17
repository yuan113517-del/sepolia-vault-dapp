// Sanity checks of the JS mirror (run: node test/model.check.js). Not the Hardhat suite.
const V = require('../frontend/vault-model.js'); const E = V.E18, D = V.DAY;
const assert = require('assert');
const near = (a, b, tol = 10n ** 6n) => assert(a >= b - tol && a <= b + tol, `${a} !~ ${b}`);
const inv = (v) => assert.strictEqual(v.vaultBal, v.totalPrincipal + v.reserve, 'solvency invariant');

let v = new V(); v.wallet.owner = 10000n * E; v.wallet.alice = 1000n * E; v.wallet.bob = 1000n * E;
v.deposit('alice', 1000n * E, 2); v.deposit('bob', 1000n * E, 0);        // weights 2500 / 1000
v.fund('owner', 7000n * E, 7 * 86400); inv(v);
v.advance(7 * 86400);
near(v.pending('alice', 0), 5000n * E); near(v.pending('bob', 0), 2000n * E);  // 5/7 and 2/7
v.advance(173 * 86400);                                                         // past both locks
v.withdraw('alice', 0); v.withdraw('bob', 0); inv(v);
near(v.bal('alice'), 6000n * E); near(v.bal('bob'), 3000n * E);

// early exit: penalty 10% + forfeited rewards go to the one who stays
v = new V(); v.wallet.owner = 5000n * E; v.wallet.alice = 1000n * E; v.wallet.bob = 1000n * E;
v.deposit('alice', 1000n * E, 2); v.deposit('bob', 1000n * E, 2);
v.fund('owner', 1400n * E, 7 * 86400); v.advance(3 * 86400 + 1);
v.withdraw('bob', 0);                                   // early
assert(v.bal('bob') === 900n * E, 'bob got 90%'); inv(v);
v.advance(10 * 86400);
const a = v.pending('alice', 0); assert(a > 800n * E, 'alice got her share + penalty stream');
v.advance(180 * 86400); v.withdraw('alice', 0); inv(v);
assert.throws(() => v.withdraw('bob', 0), /PositionClosed/);
assert.throws(() => v.deposit('alice', 1n, 0), /AmountTooSmall/);
assert.throws(() => v.deposit('alice', E, 5), /InvalidTier/);
console.log('model checks OK; alice final =', Number(v.bal('alice') / 10n ** 15n) / 1000);
