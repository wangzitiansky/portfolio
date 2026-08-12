// main.js — Portfolio 入口装配（后端 snapshot 模式）
import { initStorage, getHoldings, saveHoldings, exportJSON, importJSON } from './storage.js';
import { loadFundList } from './fund-suggest.js';
import { recordToday, getNavHistory, initNavHistory } from './nav-history.js';
import { renderNavTrend, disposeNavChart } from './chart-nav.js';
import {
  renderHero, renderHeader, renderEmptyState,
  renderChartLegend, renderCards, renderSummaryTable, openAddModal, showToast,
  renderWheel, clearCharts, setRefreshCountdown
} from './ui.js';
import { renderDonut } from './donut-chart.js';

/* ── 初始化 ── */

async function init() {
  loadFundList().catch(() => {});

  const navReady = initNavHistory().catch(() => {});
  const holdings = await initStorage();

  if (holdings.length === 0) {
    renderEmptyState();
  } else {
    await navReady;
    await refresh(true);
  }

  bindEvents();
  startAutoRefresh();
}

/* ── Snapshot API ── */

async function fetchSnapshot(holdings, refreshFx = false) {
  const url = refreshFx ? '/api/snapshot?refresh_fx=1' : '/api/snapshot';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(holdings),
  });
  if (!resp.ok) throw new Error(`Snapshot HTTP ${resp.status}`);
  return resp.json();
}

/* ── 刷新主链路 ── */

let isRefreshing = false;
async function refresh(refreshFx = false) {
  if (isRefreshing) return;
  isRefreshing = true;
  setRefreshLoading(true);

  const errors = [];
  try {
    const holdings = getHoldings();
    if (holdings.length === 0) { renderEmptyState(); return; }

    // 1. 一次性拉取 snapshot（行情 + 加工 + KPI + 图表数据全在后端完成）
    let snap;
    try {
      snap = await fetchSnapshot(holdings, refreshFx);
    } catch (e) {
      console.error('[refresh] snapshot 拉取失败', e);
      throw new Error(`数据拉取失败: ${e.message}`);
    }

    const { kpi, rows, charts, errors: serverErrors } = snap;

    // 汇总后端错误
    if (serverErrors && serverErrors.length > 0) {
      errors.push(...serverErrors.map(e => typeof e === 'string' ? e : JSON.stringify(e)));
    }

    // 2. 行情回填名称（后端 enrich 已回填，这里持久化到 storage）
    let nameUpdated = false;
    for (const r of rows) {
      const orig = holdings.find(h => h.id === r.id);
      if (orig && r.name !== orig.name && r.name && r.name !== r.code) {
        orig.name = r.name; nameUpdated = true;
      }
    }
    if (nameUpdated) {
      try { await saveHoldings(holdings); } catch (e) { console.warn('[refresh] 名称回填保存失败', e.message); }
    }

    // 3. 记录今日净值
    const pnlPct = kpi.total > 0 && kpi.total !== kpi.totalPnl
      ? (kpi.totalPnl / (kpi.total - kpi.totalPnl)) * 100 : 0;
    const recordP = recordToday(kpi.total, kpi.todayPnl, pnlPct, kpi.count)
      .catch(e => { console.warn('[refresh] 净值记录失败', e.message); });

    // 4. 渲染双图 & 净值走势
    try {
      disposeNavChart();
      clearCharts();
      const typeEl = document.getElementById('chart-type');
      const indexEl = document.getElementById('chart-index');
      const byCat = charts.byCategory || [];
      const byIdx = charts.byIndex || [];
      if (typeEl && typeEl.clientWidth > 0) renderDonut(typeEl, byCat, 'type-center', 'legend-type');
      if (indexEl && indexEl.clientWidth > 0) renderDonut(indexEl, byIdx, 'index-center', 'legend-index');
      // legend-type 已由 renderDonut 内部处理
    } catch (e) { console.error('[refresh] 双图渲染失败', e); errors.push('图表渲染'); }

    // 5. 渲染 KPI / 表格（优先渲染，不等待 recordP）
    try { renderHero(kpi); } catch (e) { console.error('[refresh] renderHero 失败', e); errors.push('汇总'); }
    try {
      renderCards(rows,
        (h) => openAddModal((saved) => refresh(), h),
        async (h) => {
          const all = getHoldings().filter(x => x.id !== h.id);
          await saveHoldings(all);
          await refresh();
        }
      );
    } catch (e) { console.error('[refresh] renderCards 失败', e); errors.push('持仓表格'); }
    try { renderSummaryTable(rows); } catch (e) { console.warn('[refresh] renderSummaryTable 失败', e.message); }
    try { renderHeader(Date.now(), rows.filter(r => r.stale).length); } catch (e) { console.warn('[refresh] renderHeader 失败', e.message); }

    // 6. 净值走势图（需等待今日记录写入完成）
    try {
      await recordP;
      const navData = getNavHistory();
      const navEl = document.getElementById('chart-nav');
      const navEmpty = document.getElementById('nav-empty');
      const navWrap = navEl ? navEl.parentElement : null;
      if (navEl && navData.length >= 2) {
        if (navEmpty) navEmpty.style.display = 'none';
        if (navWrap) navWrap.style.display = '';
        if (navEl.clientWidth > 0) renderNavTrend(navEl, navData);
      } else if (navEmpty && navWrap) {
        navEmpty.style.display = 'block';
        navWrap.style.display = 'none';
      }
    } catch (e) { console.error('[refresh] 净值走势图失败', e); errors.push('净值走势图'); }



    if (errors.length > 0) {
      showToast(`部分异常: ${errors.slice(0, 2).join('、')}`, 'error');
    }

  } catch (e) {
    console.error('[refresh] 致命错误', e);
    showToast(`刷新失败: ${e.message}`, 'error');
  } finally {
    isRefreshing = false;
    setRefreshLoading(false);
  }
}

/* ── 事件绑定 ── */

function bindEvents() {
  const btnAdd = document.getElementById('btn-add');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnRecordNav = document.getElementById('btn-record-nav');
  if (!btnAdd || !btnRefresh || !btnRecordNav) return;

  btnAdd.addEventListener('click', () => openAddModal(async () => { await refresh(); }));
  btnRefresh.addEventListener('click', () => refresh(true));

  btnRecordNav.addEventListener('click', async () => {
    const holdings = getHoldings();
    if (holdings.length === 0) { showToast('暂无持仓数据', 'error'); return; }
    if (isRefreshing) { showToast('正在刷新中，请稍候...', 'info'); return; }
    try {
      await refresh();
      showToast('已记录今日净值', 'success');
    } catch {
      showToast('记录失败，请重试', 'error');
    }
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('#btn-add-first')) openAddModal(async () => { await refresh(); });
  });

  document.addEventListener('click', async (e) => {
    if (e.target.closest('#btn-export')) { await exportJSON(); showToast('已导出'); }
  });

  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = '.json';
  fileInput.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;';
  document.body.appendChild(fileInput);
  document.addEventListener('click', (e) => {
    if (e.target.closest('#btn-import')) fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const { count, skipped } = await importJSON(file);
      showToast(`导入 ${count} 条${skipped > 0 ? '，跳过 ' + skipped + ' 条' : ''}`);
      await refresh();
    } catch (e) { showToast(e.message || '导入失败', 'error'); }
    fileInput.value = '';
  });

  window.addEventListener('resize', () => {
    // ECharts 双饼图 resize；净值走势图由 chart-nav.js 内 ResizeObserver 自行处理
    ['chart-type', 'chart-index'].forEach(id => {
      const el = document.getElementById(id);
      if (el && window.echarts) {
        try { const inst = window.echarts.getInstanceByDom(el); if (inst) inst.resize(); } catch {}
      }
    });
  });
}

/* ── 定时刷新 ── */

let countdown = 60;
let _refreshTimer, _countdownTimer;

function startAutoRefresh() {
  _refreshTimer = setInterval(async () => { if (!isRefreshing) { await refresh(); countdown = 60; } }, 60000);
  _countdownTimer = setInterval(() => { countdown = Math.max(0, countdown - 1); setRefreshCountdown(countdown); if (countdown <= 0) countdown = 60; }, 1000);
}

function setRefreshLoading(loading) {
  const btn = document.getElementById('btn-refresh');
  if (!btn) return;
  btn.disabled = loading;
  btn.style.opacity = loading ? '.4' : '';
}

/* ── 启动 ── */
document.addEventListener('DOMContentLoaded', init);
