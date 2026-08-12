import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateUnitCost, findFundMergeMatches, formatUnitCost, isFundAsset, mergeFundHolding
} from './holding-cost.js';

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

test('mergeFundHolding uses the original investment amount as cost basis', () => {
  const existing = [{
    id: 'old', market: 'of', code: '000001', type: 'fund',
    quantity: 100, cost: 1, account: '天天基金', note: '保留', index: '沪深300',
    createdAt: 1000, updatedAt: 1000
  }];
  const incoming = {
    id: 'new', market: 'of', code: '000001', type: 'fund',
    quantity: 50, cost: 2, account: '支付宝', createdAt: 2000, updatedAt: 3000
  };

  const result = mergeFundHolding(existing, incoming, { incomingTotalCost: 100 });

  assert.equal(result.merged, true);
  assert.equal(result.holdings.length, 1);
  assert.equal(result.holding.id, 'old');
  assert.equal(result.holding.quantity, 150);
  assert.equal(result.holding.cost, 200 / 150);
  assert.equal(result.holding.account, '天天基金');
  assert.equal(result.holding.note, '保留');
  assert.equal(result.holding.index, '沪深300');
  assert.equal(result.holding.createdAt, 1000);
  assert.equal(result.holding.updatedAt, 3000);
});

test('mergeFundHolding consolidates all matching accounts into the earliest record', () => {
  const existing = [
    { id: 'later', market: 'sh', code: '513500', type: 'etf', quantity: 20, cost: 2, account: 'B', createdAt: 200 },
    { id: 'other', market: 'of', code: '513500', type: 'fund', quantity: 5, cost: 3, account: '', createdAt: 50 },
    { id: 'earliest', market: 'sh', code: '513500', type: 'etf', quantity: 10, cost: 1, account: 'A', createdAt: 100 }
  ];
  const incoming = {
    id: 'new', market: 'sh', code: '513500', type: 'etf', quantity: 5, cost: 4,
    account: 'C', createdAt: 300, updatedAt: 400
  };

  const result = mergeFundHolding(existing, incoming);

  assert.equal(result.mergedCount, 2);
  assert.equal(result.holdings.length, 2);
  assert.equal(result.holding.id, 'earliest');
  assert.equal(result.holding.account, 'A');
  assert.equal(result.holding.quantity, 35);
  assert.equal(result.holding.cost, 70 / 35);
  assert.equal(result.holdings[0].id, 'other');
  assert.equal(result.holdings[1].id, 'earliest');
});

test('fund matching ignores accounts but keeps market boundaries and non-funds separate', () => {
  const existing = [
    { market: 'of', code: '000001', type: 'stock', account: 'A' },
    { market: 'of', code: '000001', type: 'fund', account: 'B' },
    { market: 'sz', code: '000001', type: 'stock', account: 'A' }
  ];

  assert.equal(findFundMergeMatches(existing, { market: 'of', code: '000001', type: 'fund' }).length, 2);
  assert.equal(findFundMergeMatches(existing, { market: 'sz', code: '000001', type: 'stock' }).length, 0);

  const stock = { market: 'us', code: 'BRK.B', type: 'stock', quantity: 1, cost: 500 };
  const result = mergeFundHolding([], stock);
  assert.equal(result.merged, false);
  assert.deepEqual(result.holdings, [stock]);
});
