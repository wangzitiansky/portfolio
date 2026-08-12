// fund-suggest.js — 基金搜索 + 清单加载（用于添加持仓的 autocomplete / identify）
import { loadCache, saveCache } from './storage.js';

const SUGGEST_URL = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx';
const FUND_LIST_URL = 'https://fund.eastmoney.com/js/fundcode_search.js';
const TIMEOUT = 8000;
const CACHE_DAYS = 7;

/* ── 基金搜索 / NAV（添加持仓时使用）── */

/**
 * 基金搜索（类型 + OTHERNAME + 单位净值）
 */
export async function suggest(key) {
  try {
    const url = `${SUGGEST_URL}?m=1&key=${encodeURIComponent(key)}`;
    const data = await loadJsonp(url, TIMEOUT);
    if (!data || !data.Datas || data.Datas.length === 0) return null;
    const item = data.Datas[0];
    const info = item.FundBaseInfo || {};
    return {
      code: item.CODE || key,
      name: info.SHORTNAME || item.NAME || '',
      ftype: info.FTYPE || '',
      othername: info.OTHERNAME || '',
      nav: info.DWJZ ? Number(info.DWJZ) : null,
      navDate: info.FSRQ || ''
    };
  } catch { return null; }
}

/**
 * 拉取场外基金单位净值 + 日涨跌
 */
export async function fetchNav(code) {
  const result = await suggest(code);
  if (!result || result.nav === null || result.nav === undefined) return null;

  let change = 0, changePct = 0;
  try {
    const histUrl = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=2`;
    const histData = await loadJsonp(histUrl, 8000);
    if (histData && histData.Data && histData.Data.LSJZList && histData.Data.LSJZList.length >= 2) {
      const latest = histData.Data.LSJZList[0];
      const prev = histData.Data.LSJZList[1];
      const latestNav = Number(latest.DWJZ);
      const prevNav = Number(prev.DWJZ);
      if (latestNav > 0 && prevNav > 0) {
        change = latestNav - prevNav;
        changePct = (change / prevNav) * 100;
      }
    }
  } catch { /* 历史接口失败不影响主流程 */ }

  return { nav: result.nav, navDate: result.navDate || '', change, changePct };
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
    const raw = await loadScript(FUND_LIST_URL, TIMEOUT);
    const re = /\["(\d{6})","[^"]*","([^"]*)","([^"]*)"/g;
    const list = [];
    let m;
    while ((m = re.exec(raw)) !== null) {
      list.push([m[1], m[2], m[3]]);
    }
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

/* ── 内部 ── */

function loadJsonp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cbName = '__paFs' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const script = document.createElement('script');
    const sep = url.includes('?') ? '&' : '?';
    const fullUrl = url + sep + 'callback=' + cbName;

    const timer = setTimeout(() => { cleanup(); reject(new Error('基金搜索超时')); }, timeoutMs);

    window[cbName] = (data) => { clearTimeout(timer); cleanup(); resolve(data); };

    function cleanup() {
      clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
      delete window[cbName];
    }

    script.charset = 'UTF-8';
    script.src = fullUrl;
    script.onerror = () => { cleanup(); reject(new Error('基金搜索加载失败')); };
    document.head.appendChild(script);
  });
}

function loadScript(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      if (script.parentNode) script.parentNode.removeChild(script);
      reject(new Error('基金清单加载超时'));
    }, timeoutMs);

    script.src = url;
    script.onload = () => {
      clearTimeout(timer);
      const raw = window.r ? JSON.stringify(window.r) : '';
      if (script.parentNode) script.parentNode.removeChild(script);
      resolve(raw);
    };
    script.onerror = () => {
      clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
      reject(new Error('基金清单加载失败'));
    };
    document.head.appendChild(script);
  });
}
