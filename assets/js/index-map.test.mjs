import assert from 'node:assert/strict';
import test from 'node:test';

import { FUND_CODE_INDEX_OVERRIDES } from './index-map-data.js';
import { mapIndex } from './index-map.js';

test('S&P 500 equal weight names map before the standard S&P 500 index', () => {
  assert.equal(
    mapIndex({ name: '大成标普500等权重指数(QDII)A人民币', othername: '', type: 'etf' }),
    '标普500等权重'
  );
  assert.equal(
    mapIndex({ name: '', othername: 'S&P 500 Equal Weight Index', type: 'etf' }),
    '标普500等权重'
  );
  assert.equal(
    mapIndex({ name: '标普500ETF南方', othername: '', type: 'etf' }),
    '标普500'
  );
});

test('S&P 500 equal weight aliases are distinct and generic equal weight is not mapped', () => {
  assert.equal(mapIndex({ name: '标普等权重指数基金', othername: '', type: 'etf' }), '标普500等权重');
  assert.equal(mapIndex({ name: '等权重策略基金', othername: '', type: 'etf' }), '');
});

test('096001 has an index fallback when fund lookup data is unavailable', () => {
  assert.equal(FUND_CODE_INDEX_OVERRIDES['096001'], '标普500等权重');
});
