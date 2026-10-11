import assert from 'node:assert/strict';
import test from 'node:test';

import { FUND_CODE_INDEX_OVERRIDES, FUND_CODE_OVERRIDES } from './index-map-data.js';
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

test('Dow Jones Industrial Average names and aliases share one canonical index', () => {
  const names = [
    '鹏华道琼斯工业平均交易型开放式指数证券投资基金(QDII)',
    'Dow Jones Industrial Average ETF',
    'DJIA 指数基金',
    '道指 ETF',
    '道琼斯 ETF 鹏华',
  ];
  for (const name of names) {
    assert.equal(mapIndex({ name, othername: '', type: 'etf' }), '道琼斯工业平均指数');
  }
});

test('513400 has complete exchange fund metadata fallback', () => {
  assert.deepEqual(FUND_CODE_OVERRIDES['513400'], {
    market: 'sh',
    name: '道琼斯 ETF 鹏华',
    type: 'etf',
    index: '道琼斯工业平均指数',
  });
  assert.equal(FUND_CODE_INDEX_OVERRIDES['513400'], '道琼斯工业平均指数');
});
