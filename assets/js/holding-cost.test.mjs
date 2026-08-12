import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateUnitCost, formatUnitCost, isFundAsset } from './holding-cost.js';

test('calculateUnitCost keeps the unrounded quotient', () => {
  const cost = calculateUnitCost('10000', '8234.56');
  assert.equal(cost, 10000 / 8234.56);
  assert.equal(formatUnitCost(cost), '1.214394');
});

test('calculateUnitCost rejects invalid amount and quantity values', () => {
  for (const [amount, quantity] of [
    ['', '100'], ['0', '100'], ['-1', '100'], ['100x', '100'],
    ['100', ''], ['100', '0'], ['100', '-1'], ['100', '8x'],
    [Infinity, 100], [100, Infinity]
  ]) {
    assert.equal(calculateUnitCost(amount, quantity), null);
  }
});

test('isFundAsset includes exchange and off-exchange funds only', () => {
  assert.equal(isFundAsset({ market: 'of', type: 'stock' }), true);
  assert.equal(isFundAsset({ market: 'sh', type: 'etf' }), true);
  assert.equal(isFundAsset({ market: 'sz', type: 'fund' }), true);
  assert.equal(isFundAsset({ market: 'sh', type: 'money' }), true);
  assert.equal(isFundAsset({ market: 'sh', type: 'stock' }), false);
  assert.equal(isFundAsset({ market: 'manual', type: 'money' }), false);
  assert.equal(isFundAsset(null), false);
});
