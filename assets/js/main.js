// main.js — Portfolio 入口装配（后端 snapshot 模式）
import { initStorage, getHoldings, getStorageVersion, saveHoldings, exportJSON, importJSON } from './storage.js';
import { loadFundList } from './fund-suggest.js';
import { recordToday, getNavHistory, initNavHistory } from './nav-history.js';
import { renderNavTrend, disposeNavChart } from './chart-nav.js';
import {
  renderHero, renderHeader, renderEmptyState,
  renderChartLegend, renderCards, renderSummaryTable, openAddModal, showToast,
  renderWheel, clearCharts, setRefreshCountdown
} from './ui.js';
import { buildPortfolioSeries, renderDonut } from './donut-chart.js';
import { exportIndexCardPNG } from './index-chart-export.js';

/* ── 初始化 ── */

async function init() {
	const fundReady = loadFundList().catch((e) => { console.warn('[init] 基金清单加载失败', e); });
	const navReady = initNavHistory().catch((e) => { console.warn('[init] 净值历史加载失败', e); });
	let holdings;
	try {
		holdings = await initStorage();
	} catch (e) {
		console.error('[init] 持仓加载失败', e);
		renderEmptyState();
		showToast('持仓加载失败，为避免覆盖数据，本次会话已停止编辑；请刷新页面重试', 'error');
		return;
	}
	// 添加资产依赖完整基金清单；加载失败仍可使用代码规则和远程识别。
	await fundReady;

  if (holdings.length === 0) {
    renderNoDataCharts();
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

function renderNoDataCharts() {
  renderDonut(document.getElementById('chart-portfolio'), [], 'portfolio-center', 'legend-portfolio', {
    variant: 'showcase', mode: 'holdings',
  });
  renderDonut(document.getElementById('chart-index'), [], 'index-center', 'legend-index', {
    variant: 'showcase', mode: 'index',
  });
}

/* ── 刷新主链路 ── */

let isRefreshing = false;
let refreshQueued = false;
let refreshQueuedFx = false;
async function refresh(refreshFx = false) {
	if (isRefreshing) {
		refreshQueued = true;
		refreshQueuedFx = refreshQueuedFx || refreshFx;
		return false;
	}
	isRefreshing = true;
	setRefreshLoading(true);

  const errors = [];
	try {
		const holdings = getHoldings();
		const storageVersion = getStorageVersion();
		if (holdings.length === 0) {
			disposeNavChart();
			clearCharts();
			renderNoDataCharts();
			renderEmptyState();
			return true;
		}

    // 1. 一次性拉取 snapshot（行情 + 加工 + KPI + 图表数据全在后端完成）
    let snap;
    try {
			snap = await fetchSnapshot(holdings, refreshFx);
    } catch (e) {
      console.error('[refresh] snapshot 拉取失败', e);
      throw new Error(`数据拉取失败: ${e.message}`);
		}
		// 刷新期间发生了增删改时，旧快照不得渲染或回写名称。
		if (getStorageVersion() !== storageVersion) {
			refreshQueued = true;
			return false;
		}

		const { kpi, rows, charts, ts, errors: serverErrors } = snap;

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
		const snapshotComplete = !serverErrors || serverErrors.length === 0;
		const previousTotal = kpi.total - kpi.todayPnl;
		const pnlPct = previousTotal > 0 ? (kpi.todayPnl / previousTotal) * 100 : 0;
		let recordFailed = false;
		// 部分行情失败时只展示当前快照，不允许用兜底价格覆盖最近一次完整记录。
		const recordP = snapshotComplete
		  ? recordToday(kpi.total, kpi.todayPnl, pnlPct, kpi.count)
		      .catch(e => { recordFailed = true; throw e; })
		  : Promise.resolve(false);

    // 4. 渲染双图 & 净值走势
    try {
      disposeNavChart();
      clearCharts();
      const portfolioEl = document.getElementById('chart-portfolio');
      const indexEl = document.getElementById('chart-index');
      const byHolding = buildPortfolioSeries(rows);
      const portfolioCount = document.getElementById('portfolio-count');
      if (portfolioCount) portfolioCount.textContent = String(byHolding.length);
      const byIdx = charts.byIndex || [];
      const exportIndexBtn = document.getElementById('btn-export-index');
      if (exportIndexBtn) exportIndexBtn.disabled = true;
      if (portfolioEl && portfolioEl.clientWidth > 0) {
        renderDonut(portfolioEl, byHolding, 'portfolio-center', 'legend-portfolio', {
          variant: 'showcase',
          mode: 'holdings',
          totalValue: kpi.total,
        });
      }
      if (indexEl && indexEl.clientWidth > 0) {
        renderDonut(indexEl, byIdx, 'index-center', 'legend-index', {
          variant: 'showcase',
          mode: 'index',
        });
      }
      if (exportIndexBtn && indexEl?.querySelector('.pa-donut-sector')) {
        exportIndexBtn.disabled = false;
      }
      requestAnimationFrame(() => {
        if (exportIndexBtn && indexEl?.querySelector('.pa-donut-sector')) exportIndexBtn.disabled = false;
      });
    } catch (e) { console.error('[refresh] 组合图表渲染失败', e); errors.push('图表渲染'); }

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
		try { renderHeader(ts, rows.filter(r => r.stale).length); } catch (e) { console.warn('[refresh] renderHeader 失败', e.message); }

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
		return !recordFailed;

	} catch (e) {
		console.error('[refresh] 致命错误', e);
		showToast(`刷新失败: ${e.message}`, 'error');
		return false;
	} finally {
		isRefreshing = false;
		setRefreshLoading(false);
		if (refreshQueued) {
			const queuedFx = refreshQueuedFx;
			refreshQueued = false;
			refreshQueuedFx = false;
			queueMicrotask(() => refresh(queuedFx));
		}
	}
}

/* ── 事件绑定 ── */

function bindEvents() {
  const btnAdd = document.getElementById('btn-add');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnRecordNav = document.getElementById('btn-record-nav');
  if (!btnAdd || !btnRefresh || !btnRecordNav) return;

  btnAdd.addEventListener('click', () => openAddModal(async () => { await refresh(); }));
  const btnExportIndex = document.getElementById('btn-export-index');
  if (btnExportIndex) {
    btnExportIndex.addEventListener('click', async () => {
      const chart = document.getElementById('chart-index');
      if (!chart?.querySelector('.pa-donut-sector')) { showToast('暂无指数数据', 'error'); return; }
      btnExportIndex.disabled = true;
      const previousText = btnExportIndex.textContent;
      btnExportIndex.textContent = '生成中…';
      try {
        await exportIndexCardPNG(document.querySelector('.pa-portfolio-feature--index'));
        showToast('底层指数图片已导出');
      } catch (error) {
        showToast(error?.message || '导出失败', 'error');
      } finally {
        btnExportIndex.disabled = false;
        btnExportIndex.textContent = previousText;
      }
    });
  }
  btnRefresh.addEventListener('click', () => refresh(true));

	btnRecordNav.addEventListener('click', async () => {
    const holdings = getHoldings();
    if (holdings.length === 0) { showToast('暂无持仓数据', 'error'); return; }
		if (isRefreshing) { showToast('正在刷新中，请稍候...', 'info'); return; }
		try {
			const ok = await refresh();
			showToast(ok ? '已记录今日资产' : '记录失败，请重试', ok ? 'success' : 'error');
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
    // 兼容旧版 ECharts 实例；SVG 轮盘会随容器自动缩放
    ['chart-portfolio', 'chart-index'].forEach(id => {
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
