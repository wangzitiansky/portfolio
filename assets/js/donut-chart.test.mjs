import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveIndexTheme } from './donut-chart.js';

test('S&P 500 equal weight receives a distinct theme before the standard S&P 500 theme', () => {
  const equal = resolveIndexTheme('标普500等权重', 'S&P 500 Equal Weight');
  const standard = resolveIndexTheme('标普500', 'S&P 500');

  assert.equal(equal.id, 'sp500-equal');
  assert.equal(equal.name, '标普500等权重');
  assert.equal(equal.code, 'S&P 500 Equal Weight');
  assert.equal(equal.brand, 'S&P EW');
  assert.notDeepEqual(equal.colors, standard.colors);
  assert.equal(standard.id, 'sp500');
});

test('Dow Jones Industrial Average receives its own DJIA theme', () => {
  const dow = resolveIndexTheme('道琼斯工业平均指数', 'DJIA');
  const standard = resolveIndexTheme('标普500', 'S&P 500');

  assert.equal(dow.id, 'dow-jones');
  assert.equal(dow.name, '道琼斯工业平均指数');
  assert.equal(dow.code, 'DJIA');
  assert.equal(dow.brand, 'DJIA');
  assert.notDeepEqual(dow.colors, standard.colors);
  assert.equal(resolveIndexTheme('道琼斯', '').id, 'dow-jones');
});
