// nav-history.js — 净值历史 CRUD（镜像 storage.js 模式，数据走 API + 内存缓存）

let _cache = null; // null = 未初始化

/* ── 公开接口 ── */

/** 加载净值历史（GET /api/nav），自动缓存 */
export async function loadNavHistory() {
  if (_cache !== null) return _cache;
  try {
    const resp = await fetch('/api/nav');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const arr = await resp.json();
    if (!Array.isArray(arr)) { _cache = []; return []; }
    _cache = arr;
    return _cache;
  } catch {
    _cache = [];
    return [];
  }
}

/** 初始化：预加载，后续 getNavHistory() 可同步返回 */
export async function initNavHistory() {
  return loadNavHistory();
}

/** 同步读取已缓存的净值历史 */
export function getNavHistory() {
  return _cache || [];
}

/** 保存净值历史（POST /api/nav），更新内存缓存 */
export async function saveNavHistory(list) {
  if (!Array.isArray(list)) {
    throw new Error('数据格式错误：需要数组');
  }
  const resp = await fetch('/api/nav', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(list)
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `保存失败 (HTTP ${resp.status})`);
  }
  _cache = list;
}

/**
 * 记录今日净值（同日覆盖最新值）
 * @param {number} total 总市值 CNY
 * @param {number} todayPnl 当日盈亏
 * @param {number} todayPnlPct 当日涨跌幅 %
 * @param {number} count 持仓数
 * @returns {Promise<boolean>} true = 新增记录, false = 更新已有记录
 */
export async function recordToday(total, todayPnl, todayPnlPct, count) {
  const history = await loadNavHistory();
  const today = formatDate(new Date());
  const existing = history.find(h => h.date === today);
  let isNew = false;

  if (existing) {
    existing.total = total;
    existing.todayPnl = todayPnl;
    existing.todayPnlPct = todayPnlPct;
    existing.count = count;
  } else {
    history.push({ date: today, total, todayPnl, todayPnlPct, count });
    history.sort((a, b) => a.date.localeCompare(b.date));
    isNew = true;
  }

  await saveNavHistory(history);
  return isNew;
}

/* ── 内部工具 ── */

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
