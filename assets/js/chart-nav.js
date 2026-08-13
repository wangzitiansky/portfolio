// chart-nav.js — 净值走势图（Lightweight Charts v5）
//
// 参考官方示例：
//   - Simple Legend:  https://tradingview.github.io/lightweight-charts/tutorials/how_to/legends
//   - Range switcher: https://tradingview.github.io/lightweight-charts/tutorials/demos/range-switcher
// 官方 range-switcher 在 1D/1W/1M/1Y 多粒度数据集间切换（换数据 + 换色 + fitContent），
// 这里原样适配：日频净值在前端按周/月/年聚合出对应粒度序列。

import { fmtMoney } from './compute.js';

const SYMBOL_NAME = '组合净值';

// 粒度 → 线色（对应官方 intervalColors，取值于项目色板）
const INTERVALS = [
  { key: '1D', label: '1D', color: '#D9B96D' },
  { key: '1W', label: '1W', color: '#3B78E7' },
  { key: '1M', label: '1M', color: '#23A8A2' },
  { key: '1Y', label: '1Y', color: '#7B5AE4' },
];
const INTERVAL_MAP = Object.fromEntries(INTERVALS.map((i) => [i.key, i]));

let _chart = null;
let _series = null;
let _rangeEl = null;
let _tooltipEl = null;
let _resizeObserver = null;
let _legendName = SYMBOL_NAME; // 随粒度切换，如「组合净值 · 1W」
let _dataRef = [];             // 原始日频数据引用（setChartInterval 聚合用）

/**
 * 渲染净值走势图
 * @param {HTMLElement} el
 * @param {Array<{date: string, total: number}>} data  按日期升序
 */
export function renderNavTrend(el, data) {
  if (!el) return;
  if (!window.LightweightCharts) {
    console.warn('[chart-nav] lightweight-charts 未加载');
    return;
  }
  if (!data || data.length < 2) return;

  disposeCurrent();

  _dataRef = data;

  const container = el;
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  // ---- 图表（与官方示例一致）---------------------------------------------
  _chart = window.LightweightCharts.createChart(container, {
    layout: {
      textColor: '#737C94',
      fontSize: 11,
      background: { type: 'solid', color: 'transparent' },
      fontFamily:
        '"Inter", "Noto Sans SC", -apple-system, "PingFang SC", sans-serif',
    },
  });

  _chart.applyOptions({
    rightPriceScale: {
      scaleMargins: {
        top: 0.05,   // 顶部留少许呼吸空间
        bottom: 0.15,
      },
    },
    crosshair: {
      // 隐藏水平十字线
      horzLine: {
        visible: false,
        labelVisible: false,
      },
      // 垂直十字线：细线 + 蓝色日期标签
      vertLine: {
        color: 'rgba(217,185,109,0.28)',
        width: 1,
        style: 0,
        labelBackgroundColor: INTERVAL_MAP['1D'].color,
        labelVisible: true,
      },
      mode: 1, // Magnet
    },
    // 隐藏网格线
    grid: {
      vertLines: { color: 'rgba(255,255,255,.045)', visible: true },
      horzLines: { color: 'rgba(255,255,255,.065)', visible: true },
    },
    timeScale: {
      borderColor: 'rgba(217,185,109,0.08)',
      // timeVisible=false：标签只显示日期（MM-DD），不显示 "00:00"
      timeVisible: false,
      secondsVisible: false,
    },
    handleScroll: { vertTouchDrag: false },
    handleScale: {
      axisPressedMouseMove: { time: true, price: false },
    },
  });

  // ---- 面积序列（v5 API: addSeries）--------------------------------------
  _series = _chart.addSeries(window.LightweightCharts.AreaSeries, {
    topColor: 'rgba(217, 185, 109, 0.18)',
    bottomColor: 'rgba(217, 185, 109, 0.0)',
    lineColor: INTERVAL_MAP['1D'].color,
    lineWidth: 2,
    crosshairMarkerVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
    priceFormat: {
      type: 'custom',
      formatter: (price) => fmtMoney(price),
    },
  });

  const initial = aggregate(data, '1D');
  _series.setData(initial);
  applyTrendTone(initial);

  // ---- Floating Tooltip（官方 tooltip 示例）---------------------------------
  const tooltip = document.createElement('div');
	_tooltipEl = tooltip;
  tooltip.style.cssText =
    'position:absolute;display:none;z-index:3;pointer-events:none;' +
    'padding:6px 10px;border-radius:6px;' +
    'font-size:12px;font-family:"Inter","Noto Sans SC",-apple-system,sans-serif;' +
    'line-height:18px;white-space:nowrap;' +
    'background:rgba(20,24,33,0.96);' +
    'border:1px solid rgba(217,185,109,0.22);' +
    'box-shadow:0 4px 16px rgba(0,0,0,0.4);';
  container.appendChild(tooltip);

  _chart.subscribeCrosshairMove((param) => {
    if (!param.point || !param.time) {
      tooltip.style.display = 'none';
      return;
    }

    const seriesData = param.seriesData.get(_series);
	if (!seriesData) {
	  tooltip.style.display = 'none';
	  return;
	}
    const price = seriesData.value !== undefined ? seriesData.value : seriesData.close;
    if (price === undefined) {
      tooltip.style.display = 'none';
      return;
    }

    tooltip.innerHTML =
      `<strong style="color:#F4F1E9">${fmtMoney(price)}</strong>`;
    tooltip.style.display = 'block';

    // 定位：跟随十字线，加偏移避免遮挡
    const x = param.point.x;
    const y = param.point.y;
    const rect = container.getBoundingClientRect();
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;

    let left = x + 16;
    let top = y - th - 8;

    // 防止溢出右边界
    if (left + tw > rect.width) left = x - tw - 16;
    // 防止溢出上边界
    if (top < 0) top = y + 16;

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  });

  _chart.timeScale().fitContent();

  // ---- Range Switcher（1D/1W/1M/1Y 粒度切换，官方 demo 原版语义）----------
  _rangeEl = buildRangeSwitcher(container, (interval) => {
    setChartInterval(interval);
  });

  // ---- Resize -------------------------------------------------------------
	_resizeObserver = new ResizeObserver(() => {
    if (!_chart) return;
    const r = container.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      _chart.applyOptions({ width: r.width, height: r.height });
    }
  });
	_resizeObserver.observe(container);
}

/* ── 粒度切换（对应官方 setChartInterval）────────────────────────────────── */

function setChartInterval(interval) {
  const { key, color } = INTERVAL_MAP[interval];
  _legendName = interval === '1D' ? SYMBOL_NAME : `${SYMBOL_NAME} · ${interval}`;

  // 换数据 + 换线色 + 时间标签格式
  const points = aggregate(_dataRef, key);
  _series.setData(points);
  applyTrendTone(points);
  _series.applyOptions({
    lineColor: color,
    topColor: hexA(color, 0.20),
    bottomColor: hexA(color, 0.0),
  });
  _chart.applyOptions({
    crosshair: {
      vertLine: { labelBackgroundColor: color },
    },
    timeScale: {
      // 标签统一只显示日期（月/年粒度天然显示年月，无 "00:00"）
      timeVisible: false,
    },
  });
  applyTrendTone(points);
  _chart.timeScale().fitContent();
}

function applyTrendTone(points) {
  if (!_series || !points.length) return;
  const first = Number(points[0].value);
  const last = Number(points[points.length - 1].value);
  const color = Number.isFinite(first) && Number.isFinite(last)
    ? (last > first ? '#35D49A' : last < first ? '#F04444' : '#D9B96D')
    : '#D9B96D';
  _series.applyOptions({
    lineColor: color,
    topColor: hexA(color, 0.24),
    bottomColor: hexA(color, 0.0),
  });
  _chart?.applyOptions({ crosshair: { vertLine: { labelBackgroundColor: color } } });
}

/** 日频数据按粒度聚合（官方 demo：1D/1W/1M/1Y 各一套数据集） */
function aggregate(data, interval) {
  if (interval === '1D') {
    return data.map((d) => ({ time: d.date, value: d.total }));
  }
  // 分组 key：1W=所属周的周一日期，1M='YYYY-MM'，1Y='YYYY'
  const keyOf = interval === '1W'
    ? (date) => weekKey(date)
    : interval === '1M'
      ? (date) => date.slice(0, 7)
      : (date) => date.slice(0, 4);

  // 数据升序 → 每组最后写入的即该组最后一个交易日
  const map = new Map();
  for (const d of data) {
    map.set(keyOf(d.date), { time: d.date, value: d.total });
  }
  // 按时间排序返回
  return [...map.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
}

/** 日期 → 所属周的周一（本地时间手工格式化，避免 toISOString 时区偏移） */
function weekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const offset = (dt.getDay() + 6) % 7; // 周一=0
  dt.setDate(dt.getDate() - offset);
  const Y = dt.getFullYear();
  const M = String(dt.getMonth() + 1).padStart(2, '0');
  const D = String(dt.getDate()).padStart(2, '0');
  return `${Y}-${M}-${D}`;
}

/** '#RRGGBB' → 'rgba(r,g,b,a)' */
function hexA(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/* ── Range Switcher 按钮组 ── */

/**
 * 构建右上角按钮组。
 * 价格轴绘图区从 scaleMargins top 0.30（30% 高度）才开始，
 * 按钮只占顶部 ~12%，不会遮挡右侧价格轴刻度。
 */
function buildRangeSwitcher(container, onSelect) {
  const old = container.querySelector('.pa-nav-ranges');
  if (old) old.remove();

  const wrap = document.createElement('div');
  wrap.className = 'pa-nav-ranges';
  wrap.style.cssText =
    'position:absolute;top:-36px;right:8px;z-index:2;';

  const buttons = INTERVALS.map((item) => {
    const btn = document.createElement('button');
    btn.className = 'pa-nav-ranges__btn';
    btn.type = 'button';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      onSelect(item.key);
      buttons.forEach((b) => b.classList.toggle('pa-nav-ranges__btn--active', b === btn));
    });
    wrap.appendChild(btn);
    return btn;
  });

  // 默认 1D（与初始状态一致）
  buttons[0].classList.add('pa-nav-ranges__btn--active');
  container.appendChild(wrap);
  return wrap;
}

/* ── 销毁 ── */

export function disposeNavChart() {
  disposeCurrent();
}

function disposeCurrent() {
	if (_resizeObserver) {
		_resizeObserver.disconnect();
		_resizeObserver = null;
	}
	if (_tooltipEl) {
		_tooltipEl.remove();
		_tooltipEl = null;
	}
	if (_rangeEl) _rangeEl.remove();
  if (_chart) {
    try { _chart.remove(); } catch {}
    _chart = null;
    _series = null;
		_rangeEl = null;
    _legendName = SYMBOL_NAME;
    _dataRef = [];
  }
}
