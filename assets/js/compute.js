// compute.js — 前端纯展示层（格式化 + 分类，计算逻辑已迁移至后端）

/** 格式化金额（千分位，固定两位小数） */
export function fmtMoney(n, currency) {
  if (isNaN(n) || n === undefined) return '--';
  const prefix = currency === 'USD' ? '$' : currency === 'HKD' ? 'HK$' : '¥';
  // +Number.EPSILON 防止 1.005→1.00 的经典浮点舍入 bug
  return prefix + (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}

/** 格式化数值（千分位，不带货币符号）。decimals 默认 2 位 */
export function fmtNum(n, decimals = 2) {
  if (isNaN(n) || n === undefined || n === null) return '--';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** 涨跌 CSS 类 */
export function trendClass(pct) {
  return pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
}

/** 正负号 */
export function sign(v) {
  return v > 0 ? '+' : v < 0 ? '-' : '';
}

/** 格式化涨跌幅 */
export function fmtPct(pct) {
  if (isNaN(pct)) return '--';
  return sign(pct) + Math.abs(pct).toFixed(2) + '%';
}

/** 类型枚举 → 展示名 */
export function typeLabel(type) {
  const map = { stock: '股票', etf: 'ETF', fund: '基金', money: '货币', cash: '现金' };
  return map[type] || '其他';
}

/** 持仓大类（兜底，优先用后端返回的 category 字段） */
export function holdingsCategory(h) {
  if (!h) return '其他';
  const { market, type } = h;
  if (market === 'us' && type === 'stock') return '美股';
  if (market === 'hk' && type === 'stock') return '港股';
  if ((market === 'sh' || market === 'sz') && (type === 'etf' || type === 'fund')) return '场内基金';
  if (market === 'of' && (type === 'etf' || type === 'fund')) return '场外基金';
  if (market === 'us') return '美股';
  if (market === 'hk') return '港股';
  if (market === 'sh' || market === 'sz') return '场内';
  if (market === 'of') return '场外基金';
  if (market === 'manual') return '手动';
  return '其他';
}
