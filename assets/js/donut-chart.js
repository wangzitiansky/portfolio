// donut-chart.js — 纯 SVG 环形图，替代 ECharts 饼图
//
// 用法（与 renderWheel 签名兼容）：
//   renderDonut(el, data, centerId)
//   el        — 图表容器（如 #chart-type），SVG 渲染其中
//   data      — [{ name, value }, ...]
//   centerId  — 中央卡片 ID，hover 扇区时更新

import { fmtMoney } from './compute.js';
import { COLORS } from './chart.js';

/** 由 hex 颜色生成 [亮色, 暗色] 渐变对 */
function gradientPair(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const dr = Math.round(r * 0.60);
  const dg = Math.round(g * 0.60);
  const db = Math.round(b * 0.60);
  const dark = '#' + [dr, dg, db].map(v => v.toString(16).padStart(2, '0')).join('');
  return [hex, dark];
}

const svgNS = 'http://www.w3.org/2000/svg';
let _instanceId = 0;

/**
 * 在指定容器内渲染 SVG 环形图，同时填充对应的图例元素。
 *
 * @param {Element}  el         图表容器 (#chart-type)
 * @param {Array}    data       [{ name, value }, ...]
 * @param {string}   centerId   中央卡片 ID ('type-center')
 * @param {string}   legendId   图例容器 ID ('legend-type')，可选
 */
export function renderDonut(el, data, centerId, legendId) {
  if (!el) return;

  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return;

  const uid = ++_instanceId;  // 唯一实例 ID，避免多图表时 SVG defs ID 冲突

  // 预处理：排序 + 计算百分比
  const main = data.map((d, i) => ({
    name: d.name || '?',
    value: d.value,
    pct: (d.value / total) * 100,
    color: gradientPair(COLORS[i % COLORS.length]),
  }));
  main.sort((a, b) => b.value - a.value);

  // ── 清空容器 ──
  el.innerHTML = '';
  el.classList.add('pa-chart');

  // ── 常量 ──
  const CX = 200, CY = 200, R = 132, SW = 84;
  const CIRCUM = 2 * Math.PI * R;
  const GAP = 1.0;

  // ── 构建 SVG ──
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 400 400');
  svg.setAttribute('class', 'pa-donut-svg');
  svg.style.width = '100%';
  svg.style.height = '100%';

  // defs: 阴影 + 渐变
  const defs = document.createElementNS(svgNS, 'defs');

  // 文字阴影滤镜
  const shadowF = document.createElementNS(svgNS, 'filter');
  shadowF.setAttribute('id', `pa-dn-shadow-${uid}`);
  shadowF.setAttribute('x', '-50%'); shadowF.setAttribute('y', '-50%');
  shadowF.setAttribute('width', '200%'); shadowF.setAttribute('height', '200%');
  shadowF.innerHTML =
    '<feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#000" flood-opacity="0.6"/>';
  defs.appendChild(shadowF);

  // 扇区渐变
  main.forEach((d, i) => {
    const g = document.createElementNS(svgNS, 'linearGradient');
    g.id = `pa-dn-grad-${uid}-${i}`;
    g.setAttribute('x1', '0%'); g.setAttribute('y1', '0%');
    g.setAttribute('x2', '100%'); g.setAttribute('y2', '100%');
    g.innerHTML =
      `<stop offset="0%"   stop-color="${d.color[0]}"/>` +
      `<stop offset="100%" stop-color="${d.color[1]}"/>`;
    defs.appendChild(g);
  });

  svg.appendChild(defs);

  // 底环（暗衬底，显露扇区间 1px 黑缝）
  const base = document.createElementNS(svgNS, 'circle');
  base.setAttribute('cx', CX); base.setAttribute('cy', CY);
  base.setAttribute('r', R); base.setAttribute('fill', 'none');
  base.setAttribute('stroke', '#0E0E1A');
  base.setAttribute('stroke-width', SW);
  svg.appendChild(base);

  // 内外亮边（dual-ring 质感）
  for (const [r, op] of [[90, 0.04], [174, 0.06]]) {
    const edge = document.createElementNS(svgNS, 'circle');
    edge.setAttribute('cx', CX); edge.setAttribute('cy', CY);
    edge.setAttribute('r', r); edge.setAttribute('fill', 'none');
    edge.setAttribute('stroke', `rgba(255,255,255,${op})`);
    edge.setAttribute('stroke-width', '1.5');
    svg.appendChild(edge);
  }

  // 扇区组（rotate -90° 从顶部 12 点方向开始）
  const sectorsG = document.createElementNS(svgNS, 'g');
  sectorsG.setAttribute('transform', 'rotate(-90 200 200)');
  sectorsG.setAttribute('class', 'pa-donut-sectors');

  // 标签组
  const labelsG = document.createElementNS(svgNS, 'g');
  labelsG.setAttribute('filter', `url(#pa-dn-shadow-${uid})`);

  let cumulative = 0;

  main.forEach((d, i) => {
    const startPct = cumulative;
    const centerPct = startPct + d.pct / 2;

    const dashLen = Math.max(0.5, (d.pct / 100) * CIRCUM - GAP);
    const offset = -(startPct / 100) * CIRCUM;

    // 主扇区
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', CX); circle.setAttribute('cy', CY);
    circle.setAttribute('r', R); circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', `url(#pa-dn-grad-${uid}-${i})`);
    circle.setAttribute('stroke-width', SW);
    circle.setAttribute('stroke-dasharray', `${dashLen.toFixed(2)} ${CIRCUM.toFixed(2)}`);
    circle.setAttribute('stroke-dashoffset', offset.toFixed(2));
    circle.setAttribute('stroke-linecap', 'butt');
    circle.classList.add('pa-donut-sector');
    circle.dataset.index = i;
    if (i === 0) {
      // 标记默认项，供 hover leave 恢复
      circle.dataset.default = 'true';
      circle.dataset.name = d.name;
      circle.dataset.value = fmtMoney(d.value);
    }
    sectorHover(circle, d, centerId, total);
    sectorsG.appendChild(circle);

    // 内层半透明覆盖（增加立体感）
    const inner = document.createElementNS(svgNS, 'circle');
    inner.setAttribute('cx', CX); inner.setAttribute('cy', CY);
    inner.setAttribute('r', R); inner.setAttribute('fill', 'none');
    inner.setAttribute('stroke', 'rgba(255,255,255,0.07)');
    inner.setAttribute('stroke-width', SW * 0.62);
    inner.setAttribute('stroke-dasharray', `${dashLen.toFixed(2)} ${CIRCUM.toFixed(2)}`);
    inner.setAttribute('stroke-dashoffset', offset.toFixed(2));
    inner.setAttribute('stroke-linecap', 'butt');
    inner.style.pointerEvents = 'none';
    sectorsG.appendChild(inner);

    // 扇区内文本标签
    const angleDeg = centerPct / 100 * 360;
    const angleRad = (angleDeg - 90) * Math.PI / 180;
    const lx = +(CX + R * Math.cos(angleRad)).toFixed(1);
    const ly = +(CY + R * Math.sin(angleRad)).toFixed(1);

    const isSmall = d.pct < 6;
    const shortName = d.name.length > 8 ? d.name.slice(0, 7) + '…' : d.name;

    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', lx); text.setAttribute('y', ly);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('fill', '#fff');
    text.style.pointerEvents = 'none';

    if (isSmall) {
      text.innerHTML =
        `<tspan x="${lx}" dy="0" font-weight="800" font-size="14">${d.pct.toFixed(1)}%</tspan>`;
    } else {
      text.innerHTML =
        `<tspan x="${lx}" dy="-12" font-weight="700" font-size="${shortName.length > 6 ? 11 : 12}">${shortName}</tspan>` +
        `<tspan x="${lx}" dy="14" fill="#B0B0C0" font-size="9">${d.pct.toFixed(1)}%</tspan>`;
    }
    labelsG.appendChild(text);

    cumulative += d.pct;
  });

  svg.appendChild(sectorsG);
  svg.appendChild(labelsG);
  el.appendChild(svg);

  // 默认选中第一大项，更新中央卡
  const defaultItem = main.length > 0 ? main[0] : null;
  if (centerId && defaultItem) {
    updateCenter(centerId, defaultItem, total);
  }

  // ── 图例 ──
  if (legendId) {
    const legendEl = document.getElementById(legendId);
    if (legendEl) {
      legendEl.innerHTML = main.map((d, i) =>
        `<div class="pa-chart-legend__item">
          <span class="pa-chart-legend__dot" style="background:${d.color[0]}"></span>
          <span>${d.name}</span>
          <span class="pa-chart-legend__pct">${d.pct.toFixed(1)}%</span>
        </div>`
      ).join('');
    }
  }

  return { items: main, svg };
}

/** 扇区 hover 交互 */
function sectorHover(circle, item, centerId, total) {
  if (!centerId) return;

  circle.addEventListener('mouseenter', () => {
    updateCenter(centerId, item, total);
  });

  circle.addEventListener('mouseleave', () => {
    // 恢复默认 — 在当前 SVG 内查找默认项
    const svg = circle.closest('svg');
    if (!svg) return;
    const def = svg.querySelector('.pa-donut-sector[data-default]');
    if (def) {
      const label = document.getElementById(centerId)?.querySelector('.pa-wheel__center-label');
      const value = document.getElementById(centerId)?.querySelector('.pa-wheel__center-value');
      if (label) label.textContent = def.dataset.name || '';
      if (value) value.textContent = def.dataset.value || '';
    }
  });
}

/** 更新中央卡片内容 */
function updateCenter(centerId, item, total) {
  const card = document.getElementById(centerId);
  if (!card) return;
  const label = card.querySelector('.pa-wheel__center-label');
  const value = card.querySelector('.pa-wheel__center-value');
  if (!label || !value) return;
  const shortName = item.name.length > 10 ? item.name.slice(0, 9) + '…' : item.name;
  label.textContent = shortName;
  value.textContent = fmtMoney(item.value);
}
