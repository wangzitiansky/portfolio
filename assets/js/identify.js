// identify.js — 类型识别（fundcode_search + 前缀规则 + 歧义处理）

import { getFundListCache, suggest, fetchNav } from './fund-suggest.js';
import { mapIndex } from './index-map.js';
import { FUND_CODE_INDEX_OVERRIDES } from './index-map-data.js';

/** 股票代码段 → 市场映射 */
const STOCK_SEGMENTS = {
  sh: /^(?:60[0-9]|601|603|605|688)/,
  sz: /^(?:00[0-3]|300|301)/
};

/**
 * 主要入口：识别用户输入
 * @param {string} raw
 * @returns {Promise<IdentifyResult>}
 */
export async function identify(raw) {
  const input = raw.trim();
  if (!input) throw new IdentifyError('NOT_FOUND', '请输入标的代码');

  // Step 1: 前缀判定
  const dm = detectMarket(input);

  // Step 2: 显式前缀 → 直接路由
  if (dm.prefix && dm.market) {
    return await enrich(dm.market, dm.code, false, []);
  }

  // Step 3: 字母代码 → 美股个股
  if (/^[a-z]{1,5}(\.[a-z]{1,2})?$/i.test(input)) {
    return await enrich('us', input.toUpperCase(), false, []);
  }

  // Step 4: 6 位纯数字 → 查基金清单
  if (/^\d{6}$/.test(input)) {
    const fundEntry = lookupFund(input);

    // 判断 A股股票歧义
    let isStockAmbiguous = false;
    for (const [market, re] of Object.entries(STOCK_SEGMENTS)) {
      if (re.test(input)) { isStockAmbiguous = true; break; }
    }

    if (fundEntry && isStockAmbiguous) {
      // 歧义：同时是基金和股票
      const candidates = buildCandidates(input, fundEntry);
      return {
        market: null, code: input, name: '', type: null, currency: null,
        priceSource: null, ambiguous: true, candidates
      };
    }

    if (fundEntry) {
      // 纯基金
      const market = fundMarket(input);
      return await enrich(market, input, false, [], fundEntry);
    }

    // 未命中基金清单 → 按 A股股票处理
    if (isStockAmbiguous) {
      const market = stockMarket(input);
      const stockName = input; // 名称由行情接口回填
      return await enrich(market, input, false, []);
    }

    // 都不是 → 尝试基金
    const market = fundMarket(input);
    return await enrich(market, input, false, []);
  }

  // Step 5: 1-5 位纯数字 → 港股
  if (/^\d{1,5}$/.test(input)) {
    return await enrich('hk', input, false, []);
  }

  // Step 6: 无法解析
  throw new IdentifyError('NOT_FOUND', '未识别该代码，请检查后重试（支持 513500 / brk.b / 00700）');
}

/**
 * 使用已确认的市场重新识别（歧义解决后调用）
 * @param {string} market
 * @param {string} code
 * @returns {Promise<IdentifyResult>}
 */
export async function identifyWithMarket(market, code) {
	return await enrich(market, code, false, [], undefined, market === 'sh' || market === 'sz');
}

/**
 * 同步查本地基金清单
 * @returns {{code:string, name:string, type:string}|null}
 */
export function lookupFund(code) {
  const cache = getFundListCache();
  if (!cache || !cache.list) return null;
  for (const item of cache.list) {
    if (item[0] === code) {
      return { code: item[0], name: item[1], ftype: item[2] };
    }
  }
  return null;
}

/**
 * 前缀判定（同步）
 * @returns {{market: string|null, code: string, prefix: string|null}}
 */
export function detectMarket(raw) {
	const separated = raw.match(/^(sh|sz|us|hk|of)[:.\-/](.+)$/i);
	if (separated) {
		return { market: separated[1].toLowerCase(), code: separated[2], prefix: separated[1].toLowerCase() };
	}
	// 无分隔符前缀仅用于数字代码，避免 SHOP、HKIT 等美股代码被误识别。
	const compact = raw.match(/^(sh|sz|of)(\d{6})$/i) || raw.match(/^(hk)(\d{1,5})$/i);
	if (compact) {
		return { market: compact[1].toLowerCase(), code: compact[2], prefix: compact[1].toLowerCase() };
	}
  return { market: null, code: raw, prefix: null };
}

/**
 * 获取歧义代码的候选列表
 * @returns {Array<{market:string, label:string}>}
 */
export function getCandidates(code) {
  const fundEntry = lookupFund(code);
  return buildCandidates(code, fundEntry);
}

/* ── 内部 ── */

async function enrich(market, code, ambiguous, candidates, fundEntryOverride, forceStock = false) {
  let name = '', type = '', indexName = '', currency = 'CNY', priceSource = 'quote';
	let suggestion = null;

  // 货币推断
  if (market === 'us') currency = 'USD';
  if (market === 'hk') currency = 'HKD';

  // 价格源推断
  if (market === 'of') priceSource = 'nav';

  // 类型推断
  if (market === 'us' || market === 'hk') {
    type = 'stock';
  } else if (market === 'sh' || market === 'sz') {
	const entry = forceStock ? null : (fundEntryOverride || lookupFund(code));
	if (forceStock) {
	  type = 'stock';
	} else if (entry) {
      type = classifyType(entry.ftype);
      name = entry.name;
    } else {
      type = 'stock';
    }
  } else if (market === 'of') {
    const entry = fundEntryOverride || lookupFund(code);
    if (entry) {
      type = classifyType(entry.ftype);
      name = entry.name;
    } else {
      type = 'fund';
    }
  }

  // 已知基金代码兜底：代码级映射优先于名称/远程结果，避免错误缓存覆盖明确的指数归类。
  const codeOverride = !forceStock && (market === 'sh' || market === 'sz' || market === 'of')
    ? (FUND_CODE_INDEX_OVERRIDES[code] || '')
    : '';
  indexName = codeOverride;

  // 先尝试用本地信息映射指数
  if (name) {
    const localIndex = mapIndex({ name, othername: '', type });
    if (localIndex && !codeOverride) indexName = localIndex;
  }

  // 远程搜索补充信息（美股/港股跳过——天天基金只覆盖中国基金）
  // 如果本地已能匹配指数，跳过远程调用
	if (!forceStock && (market === 'sh' || market === 'sz' || market === 'of') && (!name || !indexName)) {
	const sugg = await suggest(code);
	suggestion = sugg;
    if (sugg) {
      if (!name) name = sugg.name;
	  if (sugg.ftype) type = classifyType(sugg.ftype);
      const mappedIndex = mapIndex({ name: name || sugg.name, othername: sugg.othername || '', type });
      if (mappedIndex && !codeOverride) indexName = mappedIndex;
    } else if (name) {
      indexName = mapIndex({ name, othername: '', type });
    }
  } else if (!indexName && (market === 'us' || market === 'hk')) {
    // 美股/港股：名称由腾讯行情接口在 refresh 时回填，识别阶段用代码作为名称
    if (!name) name = code;
    if (name) indexName = mapIndex({ name, othername: '', type });
  }

  // 场外基金取净值
  let nav = null;
  if (market === 'of') {
	nav = suggestion && suggestion.nav != null
	  ? { nav: suggestion.nav, navDate: suggestion.navDate || '', change: 0, changePct: 0 }
	  : await fetchNav(code);
  }

  const result = {
    market, code, name, type, index: indexName, currency,
    priceSource: market === 'of' ? 'nav' : 'quote',
    ambiguous: false, candidates: [],
    nav: nav ? nav.nav : null,
    navDate: nav ? nav.navDate : ''
  };
  return result;
}

/** 基金类型 → 内部 type */
function classifyType(ftype) {
  if (!ftype) return 'fund';
  const f = ftype.toLowerCase();
  if (f.includes('货币')) return 'money';
  if (f.includes('指数') || f.includes('etf')) return 'etf';
  if (f.includes('股票')) return 'stock';
  if (f.includes('混合') || f.includes('债券') || f.includes('灵活')) return 'fund';
  return 'fund';
}

/** 6 位代码 → 场内市场 */
function fundMarket(code) {
  // 上交所：501xxx（LOF）、502xxx（分级）、510xxx-518xxx（ETF）、588xxx（科创板 ETF）
  if (/^50[12]\d{3}$/.test(code)) return 'sh';
  if (/^51[0-8]\d{3}$/.test(code)) return 'sh';
  if (/^588\d{3}$/.test(code)) return 'sh';
  // 深交所：159xxx（ETF）、16xxxx（LOF）
  if (/^159\d{3}$/.test(code)) return 'sz';
  if (/^16\d{4}$/.test(code)) return 'sz';
  return 'of'; // 默认场外（含 500xxx/519xxx/539xxx 等非交易型基金）
}

/** 6 位代码 → A股市场 */
function stockMarket(code) {
  if (/^(?:60[0-9]|601|603|605|688)/.test(code)) return 'sh';
  return 'sz';
}

/** 构建歧义候选 */
function buildCandidates(code, fundEntry) {
  const cand = [];
  if (fundEntry) {
    cand.push({ market: 'of', label: `场外基金（${fundEntry.name}）` });
  }
  const mkt = stockMarket(code);
  const mktLabel = mkt === 'sh' ? '沪市 A 股' : '深市 A 股';
  cand.push({ market: mkt, label: `A 股股票（${mktLabel} ${code}）` });
  return cand;
}

/* ── 错误类型 ── */
export class IdentifyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IdentifyError';
    this.code = code;
  }
}
