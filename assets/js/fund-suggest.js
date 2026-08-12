// fund-suggest.js — 基金搜索 + 清单加载（用于添加持仓的 autocomplete / identify）
import { loadCache, saveCache } from './storage.js';

const SUGGEST_URL = '/api/fund/suggest';
const FUND_LIST_URL = '/api/fund/list';
const CACHE_DAYS = 7;

/* ── 基金搜索 / NAV（添加持仓时使用）── */

/**
 * 基金搜索（类型 + OTHERNAME + 单位净值）
 */
export async function suggest(key) {
  try {
	const resp = await fetch(`${SUGGEST_URL}?key=${encodeURIComponent(key)}`);
	if (!resp.ok) return null;
	const data = await resp.json();
	return data && data.code ? data : null;
  } catch { return null; }
}

/**
 * 拉取场外基金单位净值 + 日涨跌
 */
export async function fetchNav(code) {
  const result = await suggest(code);
  if (!result || result.nav === null || result.nav === undefined) return null;
	return { nav: result.nav, navDate: result.navDate || '', change: 0, changePct: 0 };
}

/* ── 基金清单加载 ── */

export async function loadFundList() {
  const cache = loadCache();
  if (cache.fundList && cache.fundList.data && cache.fundList.data.length > 0) {
    const age = Date.now() - (cache.fundList.ts || 0);
    if (age < CACHE_DAYS * 86400 * 1000) {
      return cache.fundList.data;
    }
  }

  try {
	const resp = await fetch(FUND_LIST_URL);
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	const list = await resp.json();
	if (!Array.isArray(list)) throw new Error('基金清单格式无效');
    if (list.length > 0) {
      saveCache({ fundList: { data: list, ts: Date.now() } });
    }
    return list;
  } catch {
    if (cache.fundList && cache.fundList.data) return cache.fundList.data;
    return [];
  }
}

/**
 * 获取已缓存的基金清单（同步）
 */
export function getFundListCache() {
  const cache = loadCache();
  if (cache.fundList && cache.fundList.data) {
    return { list: cache.fundList.data, ts: cache.fundList.ts };
  }
  return null;
}
