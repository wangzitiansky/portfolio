// index-map.js — 指数映射（三层降级）

import { INDEX_KEYWORDS, INDEX_ALIASES } from './index-map-data.js';

const SORTED_KEYWORDS = [...INDEX_KEYWORDS].sort((a, b) => b.keyword.length - a.keyword.length);
const SORTED_ALIASES = Object.entries(INDEX_ALIASES).sort((a, b) => b[0].length - a[0].length);

/**
 * 映射底层指数（三层降级）
 * @param {{name: string, othername: string, type: string}} info
 * @returns {string} 指数名或 ""
 */
export function mapIndex(info) {
  if (!info) return '';

  const name = info.name || '';
  const othername = info.othername || '';

  // 货币/现金类直接归类
  if (info.type === 'money' || info.type === 'cash') return '货币/现金';

  // L1: OTHERNAME 子串匹配
  if (othername) {
	const result = matchKeywords(normalizeAlias(othername));
    if (result) return result;
  }

  // L2: ETF 名称规则提取（"标普500ETF博时" → "标普500"）
  if (name) {
    // 尝试直接匹配
	const direct = matchKeywords(normalizeAlias(name));
    if (direct) return direct;

    // 名称去除 ETF/LOF/QDII 等后缀后尝试
    const stripped = name.replace(/(ETF|LOF|QDII|联接|指数|A|C)$/gi, '').trim();
    const strippedResult = matchKeywords(stripped);
    if (strippedResult) return strippedResult;

    // 提取 "ETF" 前导词再匹配
    const etfMatch = name.match(/^(.+?)ETF/);
    if (etfMatch) {
      const lead = normalizeAlias(etfMatch[1]);
      const leadResult = matchKeywords(lead);
      if (leadResult) return leadResult;
    }
  }

  // L3: 兜底
  return '';
}

/**
 * 别名归一化
 * @param {string} text
 * @returns {string}
 */
export function normalizeAlias(text) {
  if (!text) return '';
  let t = text.trim();
	const exact = SORTED_ALIASES.find(([alias]) => t.toLowerCase() === alias.toLowerCase());
	if (exact) return exact[1];
	// 非纯数字别名允许出现在基金名称中；数字简称只接受完整匹配，
	// 避免把“中证A500”中的 500 替换成“中证500”。
	for (const [alias, normalized] of SORTED_ALIASES) {
	if (!/^\d+$/.test(alias) && t.toLowerCase().includes(alias.toLowerCase())) {
	  return t.replace(new RegExp(alias, 'gi'), normalized);
    }
  }
  return t;
}

/**
 * 对文本做关键词表子串匹配
 * @param {string} text
 * @returns {string|null}
 */
function matchKeywords(text) {
  const lower = text.toLowerCase();
	for (const { keyword, index } of SORTED_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
      return index;
    }
  }
  return null;
}
