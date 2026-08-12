// chart.js — 双环形图渲染（暗黑主题）

import { fmtMoney } from './compute.js';

const COLORS = [
  '#3B82F6', '#EF4444', '#8B5CF6', '#F97316', '#14B8A6',
  '#F59E0B', '#6366F1', '#22C55E', '#EC4899', '#06B6D4',
  '#84CC16', '#F43F5E', '#A855F7', '#0EA5E9', '#EAB308',
];
export { COLORS };
const instances = [];
/** 注册外部图表实例，使其可被 clearCharts() 统一销毁 */
export function registerChart(chart) { instances.push(chart); }

export function renderWheel(el, data, centerId) {
  if (!el || !window.echarts) return;
  disposeOne(el);
  const isReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const chart = window.echarts.init(el, null, { renderer: 'svg' });
  instances.push(chart);

  // 默认显示最大份额
  const totalVal = data.reduce((s, d) => s + d.value, 0);
  const maxItem = data.reduce((a, b) => (a.value > b.value ? a : b), data[0]);
  if (maxItem) maxItem.percent = totalVal > 0 ? (maxItem.value / totalVal * 100) : 0;
  updateCenter(centerId, maxItem);

  chart.setOption({
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(13,19,48,.95)',
      borderColor: 'rgba(255,255,255,.08)',
      textStyle: { color: '#E8ECF4', fontSize: 13 },
      formatter: (p) => `${p.name}<br/>${fmtMoney(p.value)} · ${p.percent.toFixed(1)}%`
    },
    series: [{
      type: 'pie',
      radius: ['28%', '76%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 4, borderColor: '#050817', borderWidth: 2 },
      label: {
        show: true,
        position: 'inside',
        fontSize: 12,
        color: '#fff',
        formatter: '{b}',
      },
      emphasis: { scaleSize: 8, focus: 'self', blurScope: 'coordinateSystem' },
      blur: { itemStyle: { opacity: .25 } },
      data: data.map((d, i) => ({
        name: d.name, value: d.value,
        itemStyle: { color: COLORS[i % COLORS.length] }
      })),
      animationType: isReduced ? false : 'scale',
      animationDuration: isReduced ? 0 : 600,
      animationEasing: 'cubicInOut',
      animationDurationUpdate: isReduced ? 0 : 300
    }]
  });

  // hover 更新中央卡
  chart.on('mouseover', (p) => {
    if (p.seriesType === 'pie') updateCenter(centerId, { name: p.name, value: p.value, percent: p.percent });
  });
  chart.on('mouseout', () => updateCenter(centerId, maxItem));

  // 渲染完成后更新一次
  setTimeout(() => updateCenter(centerId, maxItem), 700);

  bindResize(chart, el);
  return chart;
}

function updateCenter(centerId, item) {
  if (!centerId || !item) return;
  const card = document.getElementById(centerId);
  if (!card) return;
  const label = card.querySelector('.pa-wheel__center-label');
  const value = card.querySelector('.pa-wheel__center-value');
  if (!label || !value) return;
  if (item.name) {
    label.textContent = item.name.length > 12 ? item.name.slice(0, 12) + '…' : item.name;
    const pct = item.percent !== undefined ? item.percent.toFixed(1) : '--';
    value.textContent = pct + '%';
  }
}

export function clearCharts() {
  for (const c of instances) { try { c.dispose(); } catch {} }
  instances.length = 0;
}

function disposeOne(el) {
  try { const old = window.echarts.getInstanceByDom(el); if (old) old.dispose(); } catch {}
}

function bindResize(c, el) {
  const ro = new ResizeObserver(() => { try { c.resize(); } catch {} });
  ro.observe(el);
}
