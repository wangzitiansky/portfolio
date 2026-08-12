// storage.js — 持仓走 API（行情/汇率/净值已迁移至后端）
const MAX_HOLDINGS = 200;

/* ── 内存缓存 ── */
let _cache = null;

/* ── 持仓 CRUD ── */

export async function loadHoldings() {
  if (_cache !== null) return _cache;
  try {
    const resp = await fetch('/api/data');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const arr = await resp.json();
    if (!Array.isArray(arr)) { _cache = []; return []; }
    _cache = arr.filter(h => h && typeof h.code === 'string' && typeof h.market === 'string');
    return _cache;
  } catch {
    _cache = [];
    return [];
  }
}

export async function initStorage() {
  return loadHoldings();
}

export async function saveHoldings(holdings) {
  if (!Array.isArray(holdings)) throw new Error('数据格式错误：需要数组');
  if (holdings.length > MAX_HOLDINGS) throw new Error(`超过最大持仓数 ${MAX_HOLDINGS} 条`);

  const resp = await fetch('/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(holdings)
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `保存失败 (HTTP ${resp.status})`);
  }
  _cache = holdings;
}

export function getHoldings() {
  return _cache || [];
}

/* ── localStorage 缓存（仅基金列表，用于 autocomplete） ── */

const CK = 'pa_cache';

export function loadCache() {
  try {
    const raw = localStorage.getItem(CK);
    if (!raw) return { fundList: null };
    return JSON.parse(raw);
  } catch { return { fundList: null }; }
}

export function saveCache(patch) {
  try {
    const current = loadCache();
    localStorage.setItem(CK, JSON.stringify({ ...current, ...patch }));
  } catch { /* 静默忽略 */ }
}

/* ── 导出 / 导入 ── */

export async function exportJSON() {
  const holdings = getHoldings();
  const blob = new Blob([JSON.stringify(holdings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  a.download = `pa_holdings-${date}.json`;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function importJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const arr = JSON.parse(reader.result);
        if (!Array.isArray(arr)) throw new Error('格式错误：需要 JSON 数组');
        let count = 0, skipped = 0;
        const valid = [];
        for (const item of arr) {
          if (isValidHolding(item)) { valid.push(item); count++; }
          else { skipped++; }
        }
        if (arr.length > 0 && valid.length === 0) {
          reject(new Error('未识别到有效持仓数据，请检查 JSON 格式（需要 code、market、quantity、cost 字段）'));
          return;
        }
        if (valid.length > MAX_HOLDINGS) {
          reject(new Error(`导入数据 ${valid.length} 条超过上限 ${MAX_HOLDINGS} 条`));
          return;
        }
        const existing = getHoldings();
        const map = new Map();
        for (const h of existing) map.set(h.market + '|' + h.code, h);
        for (const h of valid) {
          if (typeof h.quantity === 'string') h.quantity = parseFloat(h.quantity);
          if (typeof h.cost === 'string') h.cost = parseFloat(h.cost);
          const key = h.market + '|' + h.code + '|' + (h.account || '');
          h.id = h.id || genId();
          h.createdAt = h.createdAt || Date.now();
          h.updatedAt = Date.now();
          map.set(key, h);
        }
        await saveHoldings(Array.from(map.values()));
        resolve({ count, skipped });
      } catch (e) { reject(e); }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

export function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'pa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function isValidHolding(item) {
  if (!item || typeof item !== 'object') return false;
  if (!item.code || !item.market) return false;
  let quantity = typeof item.quantity === 'string' ? parseFloat(item.quantity) : item.quantity;
  let cost = typeof item.cost === 'string' ? parseFloat(item.cost) : item.cost;
  if (typeof quantity !== 'number' || isNaN(quantity) || quantity <= 0) return false;
  if (typeof cost !== 'number' || isNaN(cost) || cost < 0) return false;
  if (!['sh', 'sz', 'us', 'hk', 'of', 'manual'].includes(item.market)) return false;
  return true;
}
