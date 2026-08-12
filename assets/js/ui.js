// ui.js — Premium Portfolio UI 渲染

import { fmtMoney, fmtNum, trendClass, sign, fmtPct, typeLabel, holdingsCategory } from './compute.js';
import { openAddModal, closeAddModal } from './ui-modal.js';
import { showToast } from './ui-toast.js';
import { renderWheel, clearCharts, COLORS } from './chart.js';

export { openAddModal, closeAddModal, showToast, renderWheel, clearCharts };

/* ── Hero ── */

export function renderHero(kpi) {
  const tc = trendClass(kpi.totalPnl);
  document.getElementById('hero-total').textContent = fmtMoney(kpi.total);
  document.getElementById('hero-pnl').innerHTML = `
    <span class="pa-hero__pnl-val ${tc}">${sign(kpi.totalPnl)}${fmtMoney(Math.abs(kpi.totalPnl))}</span>
    <span class="pa-hero__pnl-pct ${tc}">${kpi.total > 0 && kpi.total !== kpi.totalPnl ? sign(kpi.totalPnl) + (kpi.totalPnl / (kpi.total - kpi.totalPnl) * 100).toFixed(1) + '%' : '--'}</span>
  `;
  document.getElementById('hero-meta').textContent = `${kpi.count} Assets · ${kpi.indexCount} Indices`;
}

/* ── 图例 ── */

export function renderChartLegend(id, data) {
  const el = document.getElementById(id);
  if (!el) return;
  const total = data.reduce((s, d) => s + d.value, 0);
  el.innerHTML = data.map((d, i) => `
    <div class="pa-chart-legend__item">
      <span class="pa-chart-legend__dot" style="background:${COLORS[i % COLORS.length]}"></span>
      <span>${escHtml(d.name)}</span>
      <span>${fmtMoney(d.value)}</span>
      <span class="pa-chart-legend__pct">${total > 0 ? (d.value / total * 100).toFixed(1) : '0.0'}%</span>
    </div>
  `).join('');
}

/* ── Holdings Table ── */

const currencySymbols = { CNY: '¥', USD: '$', HKD: 'HK$' };

let _sortKey = 'marketValueCNY';
let _sortDir = -1;
let _currentRows = [];
let _onEdit = null;
let _onDelete = null;
let _tableReady = false;

export function renderCards(rows, onEdit, onDelete) {
  const grid = document.getElementById('cards-grid');
  const empty = document.getElementById('cards-empty');
  const count = document.getElementById('cards-count');
  if (!grid) return;

  if (!rows || rows.length === 0) {
    grid.innerHTML = '';
    grid.style.display = 'none';
    if (empty) empty.style.display = '';
    if (count) count.textContent = '0 Assets';
    _tableReady = false;
    return;
  }

  if (empty) empty.style.display = 'none';
  grid.style.display = '';
  if (count) count.textContent = rows.length + ' Assets';
  _currentRows = rows;
  _onEdit = onEdit;
  _onDelete = onDelete;

  if (!_tableReady) {
    grid.innerHTML = '<div class="pa-table-wrap"><table class="pa-table">' +
      '<colgroup><col class="col-name"><col class="col-type"><col class="col-index"><col class="col-pos"><col class="col-price"><col class="col-mv"><col class="col-pnl"><col class="col-act"></colgroup>' +
      '<thead><tr>' +
      '<th>名称 / 代码</th><th>类型</th><th>指数</th>' +
      '<th class="pa-table--r">持仓 / 成本</th>' +
      '<th class="pa-table--r">现价</th>' +
      '<th class="pa-table--r pa-th-sort" data-sort="marketValueCNY">市值</th>' +
      '<th class="pa-table--r pa-th-sort" data-sort="pnl">盈亏</th>' +
      '<th class="pa-table--c">操作</th>' +
      '</tr></thead><tbody></tbody></table></div>';

    grid.querySelectorAll('.pa-th-sort').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (_sortKey === key) _sortDir *= -1;
        else { _sortKey = key; _sortDir = -1; }
        renderTbody(_currentRows);
      });
    });
    _tableReady = true;
  }

  renderTbody(rows);
}

function renderTbody(rows) {
  const grid = document.getElementById('cards-grid');
  if (!grid) return;

  const sorted = [...rows].sort((a, b) => {
    const va = a[_sortKey] || 0;
    const vb = b[_sortKey] || 0;
    return (va - vb) * _sortDir;
  });

  // 更新表头
  grid.querySelectorAll('.pa-th-sort').forEach(th => {
    const key = th.dataset.sort;
    th.classList.toggle('pa-th-sort--active', key === _sortKey);
    th.textContent = (key === 'marketValueCNY' ? '市值' : '盈亏') + (_sortKey === key ? (_sortDir === -1 ? ' ▾' : ' ▴') : '');
  });

  const tbody = grid.querySelector('tbody');
  if (!tbody) return;

  tbody.innerHTML = sorted.map(r => buildRow(r)).join('');
  bindRowEvents(grid, rows);
}

function buildRow(r) {
  const pc = trendClass(r.pnlPct);
  const tc = trendClass(r.changePct || 0);
  const sym = currencySymbols[r.currency] || '';
  const cat = r.category || holdingsCategory(r);
  const priceStr = r.priceSource === 'nav'
    ? fmtNum(r.price, 4) : r.price != null ? fmtNum(r.price, r.price < 1 ? 4 : 2) : '--';
  const cd = r.changePct ? '<span class="' + tc + '">' + fmtPct(r.changePct) + '</span>' : '&nbsp;';
  const isForeign = r.currency === 'USD' || r.currency === 'HKD';

  return '<tr data-id="' + escHtml(r.id) + '">' +
    '<td><div class="pa-td-name">' + escHtml(r.name || r.code) + '</div><div class="pa-td-code">' + escHtml(r.code) + '</div></td>' +
    '<td>' + escHtml(cat) + '</td>' +
    '<td><span class="pa-table--meta">' + escHtml(r.index || '--') + '</span></td>' +
    '<td class="pa-table--r"><div>' + fmtNum(r.quantity, r.quantity % 1 ? 2 : 0) + ' 份</div><div class="pa-table--meta">' + sym + fmtNum(r.cost, r.cost % 1 ? 4 : 2) + '</div></td>' +
    '<td class="pa-table--r"><div>' + priceStr + '</div><div class="pa-table--meta">' + cd + '</div></td>' +
    '<td class="pa-table--r"><div class="pa-table--strong">' + fmtMoney(r.marketValueCNY || r.marketValue, 'CNY') + '</div><div class="pa-table--meta">' + (isForeign ? fmtMoney(r.marketValue, r.currency) : '&nbsp;') + '</div></td>' +
    '<td class="pa-table--r"><div class="' + pc + ' pa-table--strong">' + sign(r.pnlPct) + Math.abs(r.pnlPct).toFixed(2) + '%</div><div class="' + pc + ' pa-table--meta">' + sign(r.pnl) + fmtMoney(Math.abs(r.pnl), r.currency) + '</div></td>' +
    '<td class="pa-table--c">' +
      '<button class="pa-btn pa-btn--icon pa-btn--sm" data-action="edit" data-id="' + escHtml(r.id) + '" aria-label="编辑"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
      '<button class="pa-btn pa-btn--icon pa-btn--sm" data-action="delete" data-id="' + escHtml(r.id) + '" aria-label="删除" style="color:var(--danger)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>' +
    '</td></tr>';
}

function bindRowEvents(grid, rows) {
  grid.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = rows.find(r => r.id === btn.dataset.id);
      if (row && _onEdit) _onEdit(row);
    });
  });
  grid.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = rows.find(r => r.id === btn.dataset.id);
      if (!row) return;
      if (confirm('确定要删除「' + (row.name || row.code) + '」吗？')) {
        if (_onDelete) _onDelete(row);
      }
    });
  });
}

/* ── Index Summary Table ── */

export function renderSummaryTable(rows) {
  const section = document.getElementById('summary-section');
  const grid = document.getElementById('summary-grid');
  const count = document.getElementById('summary-count');
  if (!section || !grid) return;

  const groups = {};
  for (const r of rows) {
    const key = r.index || '__other__';
    if (!groups[key]) groups[key] = { name: r.index || '个股 / 其他', items: [] };
    groups[key].items.push(r);
  }

  const summaries = Object.values(groups).map(g => {
    let totalCNY = 0, totalPnl = 0, costCNY = 0;
    for (const r of g.items) {
      totalCNY += r.marketValueCNY || 0;
      const rate = r.currency === 'USD' ? (r.marketValueCNY / r.marketValue)
        : r.currency === 'HKD' ? (r.marketValueCNY / r.marketValue) : 1;
      totalPnl += (r.pnl || 0) * (isNaN(rate) ? 1 : rate);
      costCNY += (r.cost || 0) * r.quantity * (isNaN(rate) ? 1 : rate);
    }
    const pnlPct = costCNY > 0 ? (totalPnl / costCNY) * 100 : 0;
    return { name: g.name, count: g.items.length, totalCNY, totalPnl, pnlPct };
  });

  summaries.sort((a, b) => b.totalCNY - a.totalCNY);

  if (summaries.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';
  if (count) count.textContent = summaries.length + ' Indices';

  const pc = s => s >= 0 ? 'up' : 'down';

  // 8 列，与 holdings 表完全一致
  grid.innerHTML =
    '<div class="pa-table-wrap"><table class="pa-table">' +
    '<colgroup><col class="col-name"><col class="col-type"><col class="col-index"><col class="col-pos"><col class="col-price"><col class="col-mv"><col class="col-pnl"><col class="col-act"></colgroup>' +
    '<thead><tr>' +
    '<th>指数</th><th></th><th></th>' +
    '<th class="pa-table--r">持仓数</th><th></th>' +
    '<th class="pa-table--r">总市值</th>' +
    '<th class="pa-table--r">总盈亏</th><th></th>' +
    '</tr></thead><tbody>' +
    summaries.map(s =>
      '<tr>' +
      '<td><span class="pa-td-name">' + escHtml(s.name) + '</span></td><td></td><td></td>' +
      '<td class="pa-table--r">' + s.count + '</td><td></td>' +
      '<td class="pa-table--r pa-table--strong">' + fmtMoney(s.totalCNY, 'CNY') + '</td>' +
      '<td class="pa-table--r"><span class="' + pc(s.totalPnl) + ' pa-table--strong">' +
        sign(s.totalPnl) + Math.abs(s.pnlPct).toFixed(2) + '%</span>' +
        '<div class="pa-table--meta ' + pc(s.totalPnl) + '">' +
        sign(s.totalPnl) + fmtMoney(Math.abs(s.totalPnl), 'CNY') + '</div></td>' +
      '<td></td>' +
      '</tr>'
    ).join('') +
    '</tbody></table></div>';
}

/* ── Header ── */

export function renderHeader(ts, staleCount) {
  const t = document.querySelector('.pa-header__updated');
	if (t) {
		const updated = ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--';
		t.textContent = `数据更新于 ${updated}${staleCount > 0 ? ` · ${staleCount} 条行情过期` : ''}`;
	}
}

export function setRefreshCountdown(s) {
  const el = document.querySelector('.pa-header__countdown');
  if (el) el.textContent = '· ' + s + 's';
}

/* ── Empty Hero ── */

export function renderEmptyState() {
	_tableReady = false;
	_currentRows = [];
  document.getElementById('hero-total').textContent = '¥0';
  document.getElementById('hero-pnl').innerHTML = '<span class="pa-hero__pnl-val" style="color:var(--muted)">--</span>';
  document.getElementById('hero-meta').textContent = 'No Assets';
  const legendType = document.getElementById('legend-type');
  const legendIndex = document.getElementById('legend-index');
  if (legendType) legendType.innerHTML = '';
  if (legendIndex) legendIndex.innerHTML = '';
  const grid = document.getElementById('cards-grid');
  if (grid) { grid.innerHTML = ''; grid.style.display = 'none'; }
  const empty = document.getElementById('cards-empty');
  if (empty) empty.style.display = '';
	const count = document.getElementById('cards-count');
	if (count) count.textContent = '0 Assets';
	for (const id of ['chart-type', 'chart-index']) {
		const el = document.getElementById(id);
		if (el) el.replaceChildren();
	}
	for (const id of ['type-center', 'index-center']) {
		const center = document.getElementById(id);
		if (center) {
			const label = center.querySelector('.pa-wheel__center-label');
			const value = center.querySelector('.pa-wheel__center-value');
			if (label) label.textContent = '暂无数据';
			if (value) value.textContent = '¥0.00';
		}
	}
	const summary = document.getElementById('summary-section');
	const summaryGrid = document.getElementById('summary-grid');
	if (summary) summary.style.display = 'none';
	if (summaryGrid) summaryGrid.replaceChildren();
	const navEl = document.getElementById('chart-nav');
	const navEmpty = document.getElementById('nav-empty');
	const navWrap = navEl?.parentElement;
	if (navEl) navEl.replaceChildren();
	if (navEmpty) navEmpty.style.display = 'block';
	if (navWrap) navWrap.style.display = 'none';
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}
