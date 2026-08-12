// ui-modal.js — 添加持仓弹窗完整交互逻辑

import { modalTemplate } from './ui-modal-dom.js';
import { identify, identifyWithMarket, IdentifyError } from './identify.js';
import { initAutocomplete } from './ui-autocomplete.js';
import { renderPreview, clearPreview } from './ui-preview.js';
import { showToast } from './ui-toast.js';
import { fmtMoney, trendClass, sign, typeLabel } from './compute.js';
import { saveHoldings, getHoldings, genId } from './storage.js';
async function fetchQuote({ market, code }) {
  const resp = await fetch(`/api/quote?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}`);
  if (!resp.ok) return null;
  return resp.json();
}

let modalEl = null;
let onSaveCallback = null;
let currentResult = null;    // 当前识别结果
let autoComp = null;
let lastRequestSeq = 0;
let _modalReady = false;     // 防止初始化期间误触发保存

/**
 * 打开弹窗
 * @param {(holding: Holding) => void} onSave
 * @param {Holding} [editHolding] 编辑模式：传入已有持仓数据
 */
export function openAddModal(onSave, editHolding) {
  if (modalEl) closeAddModal();
  _modalReady = false;
  onSaveCallback = onSave;
  currentResult = null;

  // 插入 DOM
  document.body.insertAdjacentHTML('beforeend', modalTemplate());
  modalEl = document.getElementById('add-modal');
  document.body.style.overflow = 'hidden';

  // 缓存关键元素引用
  const codeInput = document.getElementById('input-code');
  const nameEl = document.getElementById('input-name');
  const typeEl = document.getElementById('input-type');
  const indexEl = document.getElementById('input-index');
  const indexManual = document.getElementById('input-index-manual');
  const qtyInput = document.getElementById('input-quantity');
  const costInput = document.getElementById('input-cost');
  const previewEl = document.getElementById('modal-preview');
  const marketSelect = document.getElementById('market-select');
  const saveBtn = document.getElementById('modal-save');
  const errorBar = document.getElementById('modal-error');

  // 诊断：检查关键元素是否齐全
  const missing = [];
  if (!codeInput) missing.push('input-code');
  if (!saveBtn) missing.push('modal-save');
  if (!qtyInput) missing.push('input-quantity');
  if (!costInput) missing.push('input-cost');
  if (missing.length > 0) {
    throw new Error('弹窗初始化失败：缺少元素 ' + missing.join(', '));
  }

  // 编辑模式：预填表单
  if (editHolding) {
    document.getElementById('modal-title').textContent = '编辑持仓';
    codeInput.value = editHolding.code;
    currentResult = {
      market: editHolding.market,
      code: editHolding.code,
      name: editHolding.name,
      type: editHolding.type,
      index: editHolding.index,
      currency: editHolding.currency,
      priceSource: editHolding.priceSource || 'quote'
    };
    // 回填只读字段
    nameEl.textContent = editHolding.name || '—';
    typeEl.textContent = typeLabel(editHolding.type) || '—';
    indexEl.textContent = editHolding.index || '未映射';
    if (!editHolding.index) indexEl.style.color = 'var(--warn)';
    // 回填数量和成本
    qtyInput.value = editHolding.quantity;
    costInput.value = editHolding.cost;
    // 回填账户
    document.getElementById('input-account').value = editHolding.account || '';
    // 币种提示
    const hint = document.getElementById('cost-hint');
    if (editHolding.currency === 'USD') hint.textContent = 'USD · 成本价为美元价格';
    else if (editHolding.currency === 'HKD') hint.textContent = 'HKD · 成本价为港币价格';
    validateAndUpdateSave();
    updatePreview();
  }

  // 指数手动输入切换（只绑定一次，避免 applyResult 中重复绑定）
  indexEl.addEventListener('click', () => {
    indexEl.style.display = 'none';
    indexManual.style.display = 'block';
    if (!indexManual.value) indexManual.value = '';
    indexManual.focus();
  });

  // 快捷现金入口
  document.querySelectorAll('.quick-cash').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      codeInput.value = name;
      currentResult = { market: 'manual', code: name, name, type: 'cash', index: '', currency: 'CNY', priceSource: 'manual' };
      applyResult(currentResult);
      // 现金：成本价固定为 1
      costInput.value = '1';
      costInput.readOnly = true;
      const hint = document.getElementById('cost-hint');
      if (hint) hint.textContent = '现金类资产成本单价固定为 1，数量即金额';
      validateAndUpdateSave();
    });
  });

  // 自动补全初始化
  const codeContainer = document.getElementById('code-container');
  autoComp = initAutocomplete(codeInput, codeContainer);
  autoComp.onSelect((item) => {
    codeInput.value = item.code || item[0];
    triggerIdentify();
  });

  // 代码输入 → 触发识别（防抖 300ms）
  let identifyTimer;
  codeInput.addEventListener('input', () => {
    clearTimeout(identifyTimer);
    clearIdentification();
    identifyTimer = setTimeout(() => triggerIdentify(), 300);
  });

  async function triggerIdentify() {
    const raw = codeInput.value.trim();
    if (!raw || raw.length < 2) return;

    const seq = ++lastRequestSeq;
    try {
      const result = await identify(raw);
      if (seq !== lastRequestSeq) return; // 丢弃过期响应

      if (result.ambiguous) {
        showAmbiguitySelector(result.candidates);
        return;
      }

      applyResult(result);
    } catch (e) {
      if (seq !== lastRequestSeq) return;
      console.error('识别失败:', e);
      if (e instanceof IdentifyError) {
        showFieldError('code', e.message);
      } else {
        // 网络错误或其他异常：降级为手动录入
        showFieldError('code', '行情/识别接口暂不可用，可手动填写后保存');
      }
      // 无论何种错误，允许手动保存（AC-04）
      currentResult = { market: 'manual', code: raw, name: '', type: 'cash', index: '', currency: 'CNY', priceSource: 'manual' };
      applyResult(currentResult);
    }
  }

  // 市场选择器回调
  marketSelect.addEventListener('click', async (e) => {
    const opt = e.target.closest('[data-market]');
    if (!opt) return;
    const market = opt.dataset.market;
    marketSelect.querySelectorAll('.pa-market-select__option').forEach(el => el.classList.remove('pa-market-select__option--active'));
    opt.classList.add('pa-market-select__option--active');

    const seq = ++lastRequestSeq;
    try {
      const result = await identifyWithMarket(market, codeInput.value.trim());
      if (seq !== lastRequestSeq) return;
      applyResult(result);
      marketSelect.style.display = 'none';
    } catch { /* ignore */ }
  });

  function applyResult(result) {
    currentResult = result;
    hideFieldError('code');
    nameEl.textContent = result.name || '—';
    typeEl.textContent = typeLabel(result.type) || '—';

    // 指数
    if (result.index) {
      indexEl.textContent = result.index;
      indexEl.style.color = '';
      indexEl.style.display = 'flex';
      indexManual.style.display = 'none';
    } else {
      indexEl.textContent = '未映射';
      indexEl.style.color = 'var(--warn)';
      indexEl.style.display = 'flex';
      indexManual.style.display = 'none';
    }

    // 币种提示
    const hint = document.getElementById('cost-hint');
    if (result.currency === 'USD') hint.textContent = 'USD · 成本价为美元价格';
    else if (result.currency === 'HKD') hint.textContent = 'HKD · 成本价为港币价格';
    else hint.textContent = '';

    // 场外基金提示
    if (result.priceSource === 'nav') {
      const navInfo = result.nav ? ` · 净值 ${fmtMoney(result.nav)} (${result.navDate})` : '';
      showFieldHint('code', '场外基金使用单位净值（T-1），非实时价' + navInfo);
    }

    validateAndUpdateSave();
    updatePreview();
  }

  function showAmbiguitySelector(candidates) {
    marketSelect.innerHTML = candidates.map((c, i) =>
      `<div class="pa-market-select__option${i === 0 ? ' pa-market-select__option--active' : ''}" data-market="${c.market}" role="radio" aria-checked="${i === 0}">${escapeHtml(c.label)}</div>`
    ).join('');
    marketSelect.style.display = 'flex';
  }

  // 数量/成本 → 预览更新（updatePreview 带防抖，避免频繁 fetchQuote）
  let previewTimer;
  const debouncedPreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => updatePreview(), 300);
  };
  qtyInput.addEventListener('input', () => { validateAndUpdateSave(); debouncedPreview(); });
  costInput.addEventListener('input', () => { validateAndUpdateSave(); debouncedPreview(); });
  indexManual.addEventListener('input', () => validateAndUpdateSave());

  async function updatePreview() {
    const cr = currentResult;  // 快照，防止 await 期间被其他代码置 null
    if (!cr || !cr.market) { clearPreview(previewEl); return; }
    const qty = parseFloat(qtyInput.value);
    const cost = parseFloat(costInput.value);
    if (isNaN(qty) || qty <= 0 || isNaN(cost) || cost < 0) { clearPreview(previewEl); return; }

    // 尝试拉行情
    let price;
    if (cr.priceSource === 'nav' && cr.nav) {
      price = cr.nav;
    } else if (cr.market !== 'manual' && cr.market !== 'of') {
      try {
        const quote = await fetchQuote({ market: cr.market, code: cr.code });
        if (quote) price = quote.price;
      } catch { /* 行情失败不影响预览 */ }
    }

    const pnl = price !== undefined ? (price - cost) * qty : NaN;
    const pnlPct = price !== undefined && cost > 0 ? ((price - cost) / cost) * 100 : NaN;
    const marketValue = price !== undefined ? price * qty : cost * qty;

    const cr2 = currentResult;  // await 后再次检查
    if (!cr2) { clearPreview(previewEl); return; }
    renderPreview(previewEl, { marketValue, pnl, pnlPct, currency: cr2.currency || 'CNY' });
  }

  function validateAndUpdateSave() {
    const codeVal = codeInput.value.trim();
    const qty = parseFloat(qtyInput.value);
    const cost = parseFloat(costInput.value);
    const valid = codeVal.length > 0 && qty > 0 && cost >= 0;
    saveBtn.disabled = !valid;
  }

  // 保存
  saveBtn.addEventListener('click', async () => {
    if (!_modalReady) return;
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    showSaveLoading(true);

    try {
      const qty = parseFloat(qtyInput.value);
      const cost = parseFloat(costInput.value);
      const cr = currentResult || {};
      const indexVal = indexManual.style.display !== 'none' ? indexManual.value.trim() : (cr.index || '');

      const holding = {
        id: editHolding ? editHolding.id : genId(),
        code: cr.code || codeInput.value.trim(),
        market: cr.market || 'manual',
        name: cr.name || codeInput.value.trim(),
        type: cr.type || 'cash',
        index: indexVal,
        quantity: qty,
        cost,
        currency: cr.currency || 'CNY',
        account: document.getElementById('input-account').value.trim(),
        note: '',
        createdAt: editHolding ? editHolding.createdAt : Date.now(),
        updatedAt: Date.now()
      };

      const existing = getHoldings();
      if (editHolding) {
        // 编辑模式：替换旧记录
        const idx = existing.findIndex(h => h.id === editHolding.id);
        if (idx >= 0) existing[idx] = holding;
        else existing.push(holding);
      } else {
        existing.push(holding);
      }
      await saveHoldings(existing);

      if (onSaveCallback) await onSaveCallback(holding);
      closeAddModal();
      showToast(editHolding ? '已更新 ' + (holding.name || holding.code) : '已添加 ' + (holding.name || holding.code), 'success');
    } catch (e) {
      console.error('保存持仓失败:', e);
      showSaveLoading(false);
      saveBtn.disabled = false;
      const detail = e && e.message ? e.message : String(e);
      showError(detail || '保存失败，请重试');
    }
  });

  // 取消 / 关闭
  document.getElementById('modal-close').addEventListener('click', closeAddModal);
  document.getElementById('modal-cancel').addEventListener('click', closeAddModal);
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeAddModal(); });

  // 焦点 trap + Esc
  codeInput.focus();
  modalEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (autoComp?.dropdown?.classList.contains('open')) { autoComp.close(); return; }
      closeAddModal();
    }
  });

  // 所有事件绑定完成，允许保存
  _modalReady = true;
}

/** 关闭弹窗 */
export function closeAddModal() {
  _modalReady = false;
  if (modalEl) {
    modalEl.remove();
    modalEl = null;
  }
  autoComp = null;
  currentResult = null;
  document.body.style.overflow = '';
  // 焦点还原到添加按钮
  const addBtn = document.getElementById('btn-add');
  if (addBtn) addBtn.focus();
}

/* ── 内部工具 ── */

function clearIdentification() {
  document.getElementById('input-name').textContent = '—';
  document.getElementById('input-type').textContent = '—';
  document.getElementById('input-index').textContent = '—';
  document.getElementById('input-index').style.color = '';
  document.getElementById('input-index').style.display = 'flex';
  document.getElementById('input-index-manual').style.display = 'none';
  document.getElementById('market-select').style.display = 'none';
  const hint = document.getElementById('cost-hint');
  if (hint) hint.textContent = '';
  costInput.readOnly = false;
  hideFieldError('code');
}

function showFieldError(field, msg) {
  const el = document.getElementById('error-' + field);
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  const input = document.getElementById('input-' + field);
  if (input) input.classList.add('pa-input--error');
}

function hideFieldError(field) {
  const el = document.getElementById('error-' + field);
  if (!el) return;
  el.textContent = '';
  el.style.display = 'none';
  const input = document.getElementById('input-' + field);
  if (input) input.classList.remove('pa-input--error');
}

function showFieldHint(_field, msg) {
  const hint = document.getElementById('cost-hint');
  if (hint) hint.textContent = msg;
}

function showSaveLoading(loading) {
  const icon = document.getElementById('modal-save-icon');
  const btn = document.getElementById('modal-save');
  if (!icon) return;
  icon.style.display = loading ? 'inline-block' : 'none';
  if (loading) icon.style.animation = 'spin 0.8s linear infinite';
  else icon.style.animation = '';
}

function showError(msg) {
  const bar = document.getElementById('modal-error');
  if (!bar) return;
  bar.innerHTML = `<svg class="pa-icon--16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> ${escapeHtml(msg)}`;
  bar.style.display = 'flex';
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s || '');
  return div.innerHTML;
}
