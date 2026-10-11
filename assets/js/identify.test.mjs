import assert from 'node:assert/strict';
import test from 'node:test';

import { identify } from './identify.js';

test('513400 keeps complete ETF metadata with or without remote fund metadata', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          code: '513400',
          name: '道琼斯ETF鹏华',
          ftype: '指数型-海外股票',
          othername: '',
          nav: 1.3158,
          navDate: '2026-08-18',
        };
      },
    });

    const available = await identify('513400');
    assert.deepEqual(
      pickIdentity(available),
      expectedIdentity()
    );

    globalThis.fetch = async () => { throw new Error('offline'); };
    const unavailable = await identify('513400');
    assert.deepEqual(
      pickIdentity(unavailable),
      expectedIdentity()
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function pickIdentity(result) {
  return {
    market: result.market,
    name: result.name,
    type: result.type,
    index: result.index,
    currency: result.currency,
    priceSource: result.priceSource,
  };
}

function expectedIdentity() {
  return {
    market: 'sh',
    name: '道琼斯 ETF 鹏华',
    type: 'etf',
    index: '道琼斯工业平均指数',
    currency: 'CNY',
    priceSource: 'quote',
  };
}
