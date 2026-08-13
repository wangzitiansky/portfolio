import { fmtMoney, fmtPct } from './compute.js';

let root = null;
let chart = null;
let resizeObserver = null;
let closeTimer = null;
let pollTimer = null;
let pollInFlight = false;
let active = null;

export function openQuotePopup(target, { mobile = false } = {}) {
  const market = target.dataset.quoteMarket, code = target.dataset.quoteCode;
  if (!market || !code) return;
  closeQuotePopup();
  root = document.createElement('div'); root.className = 'pa-quote-popup';
  root.innerHTML = '<div class="pa-quote-popup__scrim" aria-hidden="true"></div><section class="pa-quote-popup__card" role="dialog" aria-label="行情详情" tabindex="-1"><button class="pa-quote-popup__close" aria-label="关闭">×</button><div class="pa-quote-popup__loading">加载行情中…</div></section>';
  document.body.appendChild(root); active = { market, code, mobile, range: '1D' };
  const card = root.querySelector('.pa-quote-popup__card');
  position(card, target, mobile);
  root.querySelector('.pa-quote-popup__close').addEventListener('click', closeQuotePopup);
  root.querySelector('.pa-quote-popup__scrim').addEventListener('click', closeQuotePopup);
  loadDetail('1D');
  pollTimer = window.setInterval(() => {
    if (active && !pollInFlight) loadDetail(active.range, { silent: true });
  }, 10000);
  if (mobile) requestAnimationFrame(() => card.focus());
}

export function scheduleQuoteClose() { clearTimeout(closeTimer); closeTimer = setTimeout(closeQuotePopup, 180); }
export function cancelQuoteClose() { clearTimeout(closeTimer); }

export function closeQuotePopup() {
  clearTimeout(closeTimer); clearTimeout(pollTimer); pollTimer = null; pollInFlight = false;
  if (resizeObserver) resizeObserver.disconnect(); resizeObserver = null;
  if (chart) { try { chart.remove(); } catch {} } chart = null;
  if (root) root.remove(); root = null; active = null;
}

function position(card, target, mobile) {
  if (mobile) return;
  const r = target.getBoundingClientRect(); const w = Math.min(460, window.innerWidth - 24); const h = 560;
  card.style.width = `${w}px`; card.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, r.right + 12))}px`; card.style.top = `${Math.max(12, Math.min(window.innerHeight - h - 12, r.top - 12))}px`;
}

async function loadDetail(range, { silent = false } = {}) {
  if (!root || !active) return;
  active.range = range;
  if (pollInFlight) return;
  pollInFlight = true;
  const card = root.querySelector('.pa-quote-popup__card'); if (!silent) card.classList.add('is-loading');
  try {
    const resp = await fetch(`/api/quote/detail?market=${encodeURIComponent(active.market)}&code=${encodeURIComponent(active.code)}&range=${range}`);
    if (!resp.ok) throw new Error('行情服务暂不可用');
    const detail = await resp.json();
    if (root && active) renderDetail(card, detail);
  } catch (e) { card.innerHTML = `<button class="pa-quote-popup__close" aria-label="关闭">×</button><div class="pa-quote-popup__empty">${escapeHtml(e.message || '暂无行情数据')}</div>`; card.querySelector('button').addEventListener('click', closeQuotePopup); }
  finally { pollInFlight = false; }
}

function renderDetail(card, d) {
  const down = Number(d.changePct) < 0; const tone = down ? 'is-down' : 'is-up';
  card.innerHTML = `<button class="pa-quote-popup__close" aria-label="关闭">×</button>
    <div class="pa-quote-popup__heading"><div><strong>${escapeHtml(d.code)}</strong><span>${escapeHtml(d.name || '--')}</span></div><small>${escapeHtml(d.exchange || '--')} · ${escapeHtml(d.currency || '--')}</small></div>
    <div class="pa-quote-popup__price ${tone}"><strong>${formatPrice(d.price, d.currency)}</strong><span>${d.changePct == null ? '--' : (down ? '' : '+') + Number(d.changePct).toFixed(2) + '%'}</span></div>
    <div class="pa-quote-popup__ranges">${[['1D','1日'],['1M','1个月'],['3M','3个月'],['1Y','1年'],['5Y','5年'],['10Y','10年'],['YTD','年初至今']].map(([v,l]) => `<button data-range="${v}" class="${d.range===v?'is-active':''}">${l}</button>`).join('')}</div>
    <div class="pa-quote-popup__chart" aria-label="行情走势"></div>
    <div class="pa-quote-popup__metrics">${metric('开盘价',d.open,d.currency)}${metric('最高价',d.high,d.currency)}${metric('最低价',d.low,d.currency)}${metric('成交量',d.volume,'')}${metric('市盈率',d.pe,'')}${metric('市值',d.marketCap,'')}${metric('52周最高',d.week52High,d.currency)}${metric('52周最低',d.week52Low,d.currency)}</div>`;
  card.querySelectorAll('[data-range]').forEach(btn => btn.addEventListener('click', () => loadDetail(btn.dataset.range)));
  card.querySelector('.pa-quote-popup__close').addEventListener('click', closeQuotePopup);
  renderChart(card.querySelector('.pa-quote-popup__chart'), d.points || [], tone);
}

function renderChart(el, points, tone) {
  if (!window.LightweightCharts || !points.length) { el.innerHTML = '<span>暂无历史行情</span>'; return; }
  if (chart) { try { chart.remove(); } catch {} }
  chart = window.LightweightCharts.createChart(el, { layout:{background:{type:'solid',color:'transparent'},textColor:'#737C94',fontSize:10}, grid:{vertLines:{color:'rgba(255,255,255,.06)'},horzLines:{color:'rgba(255,255,255,.06)'}}, rightPriceScale:{borderVisible:false}, timeScale:{borderColor:'rgba(255,255,255,.12)',timeVisible:true,secondsVisible:false}, crosshair:{mode:1} });
  const color = tone === 'is-down' ? '#F04444' : '#35D49A'; const series = chart.addSeries(window.LightweightCharts.AreaSeries, { lineColor:color,topColor: tone === 'is-down' ? 'rgba(240,68,68,.22)' : 'rgba(53,212,154,.22)',bottomColor:'rgba(0,0,0,0)',lineWidth:2,priceLineVisible:false });
  series.setData(points.map(p => ({time: Math.floor(p.time/1000), value:p.value}))); chart.timeScale().fitContent();
  resizeObserver = new ResizeObserver(() => { if (chart) chart.applyOptions({width:el.clientWidth,height:el.clientHeight}); }); resizeObserver.observe(el);
}

function metric(label, value, currency) { const valid = value != null && Number.isFinite(Number(value)); return `<div><span>${label}</span><strong>${valid ? formatValue(Number(value), currency) : '--'}</strong></div>`; }
function formatPrice(v, c) { return v == null ? '--' : `${c === 'USD' ? 'US$' : c === 'HKD' ? 'HK$' : '¥'}${Number(v).toFixed(Number(v)<1?4:2)}`; }
function formatValue(v, c) {
  if (c) return formatPrice(v,c);
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(2)}万亿`;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return v.toLocaleString('zh-CN',{maximumFractionDigits:2});
}
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeQuotePopup(); });
document.addEventListener('mouseover', e => { const t=e.target.closest?.('.pa-quote-trigger'); if (t && window.matchMedia('(hover:hover)').matches) { cancelQuoteClose(); clearTimeout(openQuotePopup._timer); openQuotePopup._timer=setTimeout(()=>openQuotePopup(t),150); } if (e.target.closest?.('.pa-quote-popup')) cancelQuoteClose(); });
document.addEventListener('mouseout', e => { if (e.target.closest?.('.pa-quote-trigger') || e.target.closest?.('.pa-quote-popup')) { clearTimeout(openQuotePopup._timer); scheduleQuoteClose(); } });
document.addEventListener('click', e => { const t=e.target.closest?.('.pa-quote-trigger'); if (t && !window.matchMedia('(hover:hover)').matches) openQuotePopup(t,{mobile:true}); });
