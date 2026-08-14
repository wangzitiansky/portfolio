// 高端投资组合轮盘：真实 SVG 环形扇区、图片裁切与联动交互

import { fmtMoney } from './compute.js';
import { COLORS } from './chart.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const VIEWBOX_SIZE = 440;
const CX = VIEWBOX_SIZE / 2;
const CY = VIEWBOX_SIZE / 2;
const OUTER_RADIUS = 196;
const INNER_RADIUS = 75;
const HOLDING_LABEL_THRESHOLD = 8;
const INDEX_LABEL_THRESHOLD = 4.5;
const PRIMARY_SECTOR_ANGLE = 0; // 最大扇区居右：为照片和中心信息留出更舒展的展示空间。

let instanceId = 0;

const HOLDING_COLORS = [
  '#2878FF', '#E23145', '#7C3AED', '#F07B16', '#11A7A3',
  '#D9A13A', '#4E56D8', '#35A965', '#D7438C', '#1B91C8',
];

const INDEX_THEMES = [
  {
    id: 'sp500-equal',
    match: ['标普500等权重', '标普 500 等权重', '标普500等权', 's&p500equalweight', 's&p 500 equal weight', 'sp500equalweight', 'sp 500 equal weight'],
    name: '标普500等权重',
    code: 'S&P 500 Equal Weight',
    brand: 'S&P EW',
    image: 'images/portfolio/sp500-nyse.jpg',
    colors: ['#19A99B', '#9F7A2B'],
    imageOpacity: 0.50,
  },
  {
    id: 'sp500',
    match: ['标普500', '标普 500', 's&p500', 's&p 500', 'sp500', 'sp 500'],
    name: '标普500',
    code: 'S&P 500',
    brand: 'S&P',
    image: 'images/portfolio/sp500-nyse.jpg',
    colors: ['#2C72F0', '#071A57'],
    imageOpacity: 0.54,
  },
  {
    id: 'nasdaq',
    match: ['纳斯达克100', '纳斯达克 100', '纳指100', '纳指 100', 'nasdaq100', 'nasdaq 100', 'ndx'],
    name: '纳斯达克100',
    code: 'NASDAQ 100',
    brand: 'NASDAQ',
    logoSrc: 'images/portfolio/nasdaq-logo.svg',
    image: 'images/portfolio/nasdaq-times-square.jpg',
    colors: ['#7B4DFF', '#261267'],
    imageOpacity: 0.52,
  },
  {
    id: 'berkshire',
    match: ['伯克希尔', 'berkshire', 'brk.b', 'brkb'],
    name: '伯克希尔',
    code: 'BRK.B',
    brand: 'BRK.B',
    image: 'images/portfolio/berkshire-omaha.jpg',
    colors: ['#D6A447', '#563314'],
    imageOpacity: 0.48,
  },
];

/**
 * 将持仓按市值从高到低整理，并只保留真正的 Top N。
 * 未进入 Top N 的项目不会被聚合为“其他”。
 */
export function buildPortfolioSeries(rows, limit = null) {
  const maxItems = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.max(1, Number(limit)) : Number.POSITIVE_INFINITY;
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      id: row.id || row.code || row.name || '',
      name: row.name || row.code || '未命名资产',
      code: row.code || '',
      value: Number(row.marketValueCNY ?? row.marketValue ?? 0),
      index: row.index || '',
    }))
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, maxItems);
}

/**
 * @param {Element} el 图表容器
 * @param {Array} data [{ name, code?, value, color?, backgroundImage?, logoSrc? }]
 * @param {string} centerId 中央卡片 ID
 * @param {string} legendId 图例容器 ID
 * @param {object} options { variant, mode, totalValue, maxItems, defaultSelection }
 */
export function renderDonut(el, data, centerId, legendId, options = {}) {
  if (!el) return null;

  const uid = ++instanceId;
  const mode = options.mode === 'index' ? 'index' : 'holdings';
  const isShowcase = options.variant === 'showcase';
  const maxItems = Number.isFinite(Number(options.maxItems)) && Number(options.maxItems) > 0
    ? Math.max(1, Number(options.maxItems)) : Number.POSITIVE_INFINITY;
  const safeData = (Array.isArray(data) ? data : [])
    .filter((item) => Number.isFinite(Number(item?.value)) && Number(item.value) > 0)
    .sort((a, b) => Number(b.value) - Number(a.value))
    .slice(0, maxItems);

  el.replaceChildren();
  el.classList.toggle('pa-chart--showcase', isShowcase);
  el.classList.toggle('pa-chart--image-wheel', mode === 'index');

  const legendEl = legendId ? document.getElementById(legendId) : null;
  if (legendEl) legendEl.replaceChildren();

  const displayedTotal = safeData.reduce((sum, item) => sum + Number(item.value), 0);
  const requestedTotal = Number(options.totalValue);
  const total = Number.isFinite(requestedTotal) && requestedTotal >= displayedTotal
    ? requestedTotal
    : displayedTotal;

  const items = safeData.map((item, index) => normalizeItem(item, index, total, mode));
  if (mode === 'index') {
    const exportButton = document.getElementById('btn-export-index');
    if (exportButton) exportButton.disabled = items.length === 0;
  }
  el.classList.toggle('pa-chart--image-wheel', items.some((item) => Boolean(item.backgroundImage)));
  const defaultItem = items[0] || null;
  updateCenter(centerId, defaultItem, total, { showcase: isShowcase });

  if (total <= 0 || items.length === 0) {
    renderEmptyWheel(el, centerId, legendEl, { showcase: isShowcase });
    return { items: [], svg: null };
  }

  const svg = svgEl('svg', {
    viewBox: `0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`,
    class: 'pa-donut-svg',
    role: 'group',
    'aria-label': mode === 'index' ? '按跟踪标的划分的投资组合' : '全部持仓投资组合',
  });
  const title = svgEl('title');
  title.textContent = mode === 'index' ? '底层指数权重轮盘' : '全部持仓权重轮盘';
  svg.appendChild(title);

  const defs = createDefs(uid, items);
  svg.appendChild(defs);

  const basePath = svgEl('path', {
    d: describeFullAnnulus(CX, CY, OUTER_RADIUS, INNER_RADIUS),
    class: 'pa-donut-base',
    fill: `url(#pa-base-${uid})`,
    'fill-rule': 'evenodd',
  });
  svg.appendChild(basePath);

  const guide = svgEl('circle', {
    cx: CX,
    cy: CY,
    r: OUTER_RADIUS + 3,
    class: 'pa-donut-outer-guide',
    fill: 'none',
  });
  svg.appendChild(guide);

  const sectorsLayer = svgEl('g', { class: 'pa-donut-sectors' });
  svg.appendChild(sectorsLayer);

  // 最大项锚定在右侧；其余扇区逆时针展开，让主图片获得完整的横向展示空间。
  const firstSpan = items[0].pct * 3.6;
  const direction = -1;
  let cursorAngle = PRIMARY_SECTOR_ANGLE + firstSpan / 2;
  const interactiveItems = [];

  items.forEach((item, index) => {
    const span = item.pct * 3.6;
    const gap = sectorGap(span);
    const startAngle = cursorAngle - gap / 2;
    const endAngle = cursorAngle + direction * span + gap / 2;
    const midAngle = cursorAngle + direction * span / 2;
    cursorAngle += direction * span;

    if ((direction > 0 && endAngle <= startAngle) || (direction < 0 && endAngle >= startAngle)) return;

    const sectorPath = describeAnnularSector(CX, CY, OUTER_RADIUS, INNER_RADIUS, startAngle, endAngle, direction);
    const group = svgEl('g', {
      class: `pa-donut-sector-group pa-donut-sector-group--${item.themeId || 'holding'}`,
      'data-index': index,
    });
    group.style.setProperty('--sector-color', item.colors[0]);

    if (item.backgroundImage) {
      const image = svgEl('image', {
        x: 18,
        y: 18,
        width: VIEWBOX_SIZE - 36,
        height: VIEWBOX_SIZE - 36,
        preserveAspectRatio: item.imagePosition || 'xMidYMid slice',
        opacity: item.imageOpacity,
        class: 'pa-donut-sector-image',
        'clip-path': `url(#pa-clip-${uid}-${index})`,
      });
      image.setAttributeNS(XLINK_NS, 'href', item.backgroundImage);
      image.setAttribute('href', item.backgroundImage);
      image.addEventListener('error', () => image.remove(), { once: true });
      group.appendChild(image);
    }

    const colorLayer = svgEl('path', {
      d: sectorPath,
      class: 'pa-donut-sector-color',
      fill: `url(#pa-sector-${uid}-${index})`,
    });
    group.appendChild(colorLayer);

    const sheen = svgEl('path', {
      d: sectorPath,
      class: 'pa-donut-sector-sheen',
      fill: `url(#pa-sheen-${uid})`,
    });
    group.appendChild(sheen);

    const hitPath = svgEl('path', {
      d: sectorPath,
      class: 'pa-donut-sector',
      fill: 'transparent',
      tabindex: '0',
      role: 'button',
      'aria-pressed': 'false',
      'aria-label': `${item.name}${item.code ? ` ${item.code}` : ''}，占投资组合 ${item.pct.toFixed(1)}%`,
    });
    const sectorTitle = svgEl('title');
    sectorTitle.textContent = `${item.name}${item.code ? ` · ${item.code}` : ''} · ${item.pct.toFixed(1)}% · ${fmtMoney(item.value)}`;
    hitPath.appendChild(sectorTitle);
    group.appendChild(hitPath);

    const label = createSectorLabel(item, midAngle, mode);
    if (label) group.appendChild(label);

    sectorsLayer.appendChild(group);
    interactiveItems.push({ item, group, target: hitPath, midAngle, index });
  });

  const centerHalo = svgEl('circle', {
    cx: CX,
    cy: CY,
    r: INNER_RADIUS - 4,
    class: 'pa-donut-center-halo',
    fill: 'none',
  });
  svg.appendChild(centerHalo);
  el.appendChild(svg);

  const legendItems = renderLegend(legendEl, items);
  bindWheelInteractions({
    svg,
    sectorsLayer,
    interactiveItems,
    legendItems,
    centerId,
    total,
    defaultItem,
    isShowcase,
  });

  return { items, svg };
}

function normalizeItem(item, index, total, mode) {
  const rawName = String(item.name || item.code || '未命名资产');
  const rawCode = String(item.code || '');
  const value = Number(item.value);
  const indexTheme = mode === 'index'
    ? resolveIndexTheme(rawName, rawCode)
    : resolveIndexTheme(String(item.index || ''), `${rawName} ${rawCode}`);
  const isHolding = mode === 'holdings';
  const baseColor = Array.isArray(item.color)
    ? item.color[0]
    : typeof item.color === 'string'
      ? item.color
      : mode === 'holdings'
        ? HOLDING_COLORS[index % HOLDING_COLORS.length]
        : COLORS[index % COLORS.length];
  const colors = Array.isArray(item.color)
    ? item.color
    : isHolding ? gradientPair(baseColor) : indexTheme?.colors || gradientPair(baseColor);
  const holdingImageOpacity = indexTheme
    ? Math.min(0.38, Math.max(0.28, Number(indexTheme.imageOpacity || 0.5) * 0.68))
    : item.backgroundImage ? 0.34 : 0;

  return {
    ...item,
    name: mode === 'index' ? indexTheme?.name || rawName : rawName,
    code: item.code || (mode === 'index' ? indexTheme?.code : '') || '',
    value,
    pct: total > 0 ? value / total * 100 : 0,
    colors,
    themeId: indexTheme?.id || '',
    brand: item.brand || (mode === 'index' ? indexTheme?.brand : '') || createMonogram(rawName),
    backgroundImage: item.backgroundImage || indexTheme?.image || '',
    logoSrc: mode === 'index' ? item.logoSrc || indexTheme?.logoSrc || '' : '',
    imageOpacity: Number(item.imageOpacity ?? (isHolding ? holdingImageOpacity : indexTheme?.imageOpacity) ?? 0.5),
    imagePosition: item.imagePosition || indexTheme?.imagePosition || 'xMidYMid slice',
  };
}

export function resolveIndexTheme(name, code) {
  const haystack = `${name} ${code}`.toLowerCase().replace(/[\s_-]+/g, '');
  return INDEX_THEMES.find((theme) => theme.match.some((keyword) => (
    haystack.includes(keyword.toLowerCase().replace(/[\s_-]+/g, ''))
  ))) || null;
}

function createDefs(uid, items) {
  const defs = svgEl('defs');

  const baseGradient = svgEl('radialGradient', { id: `pa-base-${uid}`, cx: '50%', cy: '44%', r: '62%' });
  baseGradient.append(
    stop('0%', '#141E40', 0.94),
    stop('66%', '#091128', 0.98),
    stop('100%', '#020611', 1),
  );
  defs.appendChild(baseGradient);

  const sheen = svgEl('linearGradient', { id: `pa-sheen-${uid}`, x1: '12%', y1: '2%', x2: '76%', y2: '100%' });
  sheen.append(
    stop('0%', '#FFFFFF', 0.28),
    stop('26%', '#FFFFFF', 0.07),
    stop('58%', '#FFFFFF', 0),
    stop('100%', '#000000', 0.24),
  );
  defs.appendChild(sheen);

  items.forEach((item, index) => {
    const gradient = svgEl('radialGradient', {
      id: `pa-sector-${uid}-${index}`,
      cx: '36%',
      cy: '26%',
      r: '82%',
    });
    const imageFactor = item.backgroundImage ? 0.42 : 0.96;
    gradient.append(
      stop('0%', item.colors[0], imageFactor),
      stop('55%', item.colors[0], item.backgroundImage ? 0.38 : 0.9),
      stop('100%', item.colors[1], item.backgroundImage ? 0.68 : 1),
    );
    defs.appendChild(gradient);

    const clip = svgEl('clipPath', { id: `pa-clip-${uid}-${index}` });
    const span = item.pct * 3.6;
    const firstSpan = items[0].pct * 3.6;
    const previous = items.slice(0, index).reduce((sum, current) => sum + current.pct * 3.6, 0);
    const rawStart = PRIMARY_SECTOR_ANGLE + firstSpan / 2 - previous;
    const gap = sectorGap(span);
    clip.appendChild(svgEl('path', {
      d: describeAnnularSector(CX, CY, OUTER_RADIUS, INNER_RADIUS, rawStart - gap / 2, rawStart - span + gap / 2, -1),
    }));
    defs.appendChild(clip);
  });

  return defs;
}

function createSectorLabel(item, angle, mode) {
  const threshold = mode === 'index' ? INDEX_LABEL_THRESHOLD : HOLDING_LABEL_THRESHOLD;
  if (item.pct < threshold) return null;

  const radius = item.pct > 48 ? 137 : 140;
  const position = polarToCartesian(CX, CY, radius, angle);
  const group = svgEl('g', {
    class: `pa-donut-label pa-donut-label--${mode}`,
    transform: `translate(${position.x} ${position.y})`,
    'aria-hidden': 'true',
  });

  const showBrand = mode === 'index' && item.pct >= 14;
  let textOffset = showBrand ? 17 : -2;
  if (showBrand) group.appendChild(createBrandBadge(item));

  const name = svgEl('text', {
    x: 0,
    y: textOffset,
    class: 'pa-donut-label__name',
    'text-anchor': 'middle',
  });
  name.textContent = abbreviate(item.name, item.pct >= 20 ? 9 : 6);
  group.appendChild(name);

  if (item.code && item.pct >= 10) {
    const code = svgEl('text', {
      x: 0,
      y: textOffset + 15,
      class: 'pa-donut-label__code',
      'text-anchor': 'middle',
    });
    code.textContent = item.code;
    group.appendChild(code);
  }

  const pct = svgEl('text', {
    x: 0,
    y: textOffset + (item.code && item.pct >= 10 ? 40 : 25),
    class: 'pa-donut-label__pct',
    'text-anchor': 'middle',
  });
  pct.textContent = `${item.pct.toFixed(1)}%`;
  group.appendChild(pct);
  return group;
}

function createBrandBadge(item) {
  const group = svgEl('g', { class: 'pa-donut-brand', transform: 'translate(0 -31)' });
  const circle = svgEl('circle', { cx: 0, cy: 0, r: 17, class: 'pa-donut-brand__disc' });
  group.appendChild(circle);

  if (item.logoSrc) {
    const image = svgEl('image', { x: -11, y: -11, width: 22, height: 22, preserveAspectRatio: 'xMidYMid meet' });
    image.setAttributeNS(XLINK_NS, 'href', item.logoSrc);
    image.setAttribute('href', item.logoSrc);
    image.addEventListener('error', () => {
      image.remove();
      group.appendChild(createBrandText(item.brand));
    }, { once: true });
    group.appendChild(image);
  } else {
    group.appendChild(createBrandText(item.brand));
  }
  return group;
}

function createBrandText(value) {
  const text = svgEl('text', { x: 0, y: 4, class: 'pa-donut-brand__text', 'text-anchor': 'middle' });
  text.textContent = abbreviate(value || 'INDEX', 6);
  return text;
}

function renderLegend(legendEl, items) {
  if (!legendEl) return [];
  const legendItems = [];

  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'pa-portfolio-legend__item';
    row.dataset.index = String(index);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-pressed', 'false');
    row.setAttribute('aria-label', `${item.name}${item.code ? ` ${item.code}` : ''}，占投资组合 ${item.pct.toFixed(1)}%`);
    row.style.setProperty('--item-color', item.colors[0]);
    row.style.setProperty('--item-pct', `${Math.min(100, item.pct).toFixed(1)}%`);

    const rank = document.createElement('span');
    rank.className = 'pa-portfolio-legend__rank';
    rank.textContent = String(index + 1).padStart(2, '0');
    const dot = document.createElement('span');
    dot.className = 'pa-portfolio-legend__dot';
    const copy = document.createElement('span');
    copy.className = 'pa-portfolio-legend__copy';
    const name = document.createElement('span');
    name.className = 'pa-portfolio-legend__name';
    name.textContent = item.name;
    const code = document.createElement('span');
    code.className = 'pa-portfolio-legend__code';
    code.textContent = item.code || 'ASSET';
    const pct = document.createElement('span');
    pct.className = 'pa-portfolio-legend__pct';
    pct.textContent = `${item.pct.toFixed(1)}%`;

    copy.append(name, code);
    row.append(rank, dot, copy, pct);
    legendEl.appendChild(row);
    legendItems.push(row);
  });
  return legendItems;
}

function bindWheelInteractions({ svg, sectorsLayer, interactiveItems, legendItems, centerId, total, defaultItem, isShowcase }) {
  let lockedIndex = null;

  const setPressed = (index) => {
    interactiveItems.forEach(({ target }, itemIndex) => target.setAttribute('aria-pressed', String(itemIndex === index)));
    legendItems.forEach((target, itemIndex) => target.setAttribute('aria-pressed', String(itemIndex === index)));
  };

  const reset = () => {
    sectorsLayer.classList.remove('pa-donut-sectors--has-active');
    interactiveItems.forEach(({ group }) => {
      group.classList.remove('is-active');
      group.removeAttribute('transform');
    });
    legendItems.forEach((item) => item.classList.remove('is-active'));
    setPressed(lockedIndex);
    updateCenter(centerId, lockedIndex === null ? defaultItem : interactiveItems[lockedIndex]?.item, total, { showcase: isShowcase });
  };

  const activate = (index, transient = false) => {
    const current = interactiveItems[index];
    if (!current) return;
    sectorsLayer.classList.add('pa-donut-sectors--has-active');
    interactiveItems.forEach(({ group, midAngle }, itemIndex) => {
      const isActive = itemIndex === index;
      group.classList.toggle('is-active', isActive);
      if (isActive) {
        const offset = polarToCartesian(0, 0, 5, midAngle);
        group.setAttribute('transform', `translate(${offset.x.toFixed(2)} ${offset.y.toFixed(2)})`);
      } else {
        group.removeAttribute('transform');
      }
    });
    legendItems.forEach((item, itemIndex) => item.classList.toggle('is-active', itemIndex === index));
    if (!transient) setPressed(index);
    updateCenter(centerId, current.item, total, { showcase: isShowcase });
  };

  const bindTarget = (target, index) => {
    target.addEventListener('mouseenter', () => activate(index, true));
    target.addEventListener('mouseleave', () => {
      if (!target.matches(':focus-visible')) {
        if (lockedIndex === null) reset(); else activate(lockedIndex);
      }
    });
    target.addEventListener('focus', () => activate(index, true));
    target.addEventListener('blur', () => {
      if (lockedIndex === null) reset(); else activate(lockedIndex);
    });
    target.addEventListener('click', (event) => {
      event.stopPropagation();
      lockedIndex = lockedIndex === index ? null : index;
      if (lockedIndex === null) reset(); else activate(lockedIndex);
    });
    target.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        target.click();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        lockedIndex = null;
        target.blur();
        reset();
      }
    });
  };

  interactiveItems.forEach(({ target }, index) => bindTarget(target, index));
  legendItems.forEach((target, index) => bindTarget(target, index));
  svg.addEventListener('click', () => {
    lockedIndex = null;
    reset();
  });
  reset();
}

function updateCenter(centerId, item, total, { showcase = false } = {}) {
  const card = centerId ? document.getElementById(centerId) : null;
  if (!card) return;
  const label = card.querySelector('.pa-wheel__center-label');
  const code = card.querySelector('.pa-wheel__center-code');
  const value = card.querySelector('.pa-wheel__center-value');
  if (!label || !value) return;

  if (!item) {
    label.textContent = '暂无持仓';
    if (code) code.textContent = 'ADD YOUR FIRST ASSET';
    value.textContent = showcase ? '0%' : fmtMoney(0);
    return;
  }

  label.textContent = abbreviate(item.name, 11);
  if (code) code.textContent = item.code ? `${item.code} · ${fmtMoney(item.value)}` : fmtMoney(item.value);
  value.textContent = showcase ? `${item.pct.toFixed(1)}%` : fmtMoney(item.value);
  card.style.setProperty('--center-accent', item.colors?.[0] || '#D8B76B');
}

function renderEmptyWheel(el, centerId, legendEl, { showcase }) {
  const svg = svgEl('svg', { viewBox: `0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`, class: 'pa-donut-svg pa-donut-svg--empty' });
  const ring = svgEl('path', {
    d: describeFullAnnulus(CX, CY, OUTER_RADIUS, INNER_RADIUS),
    class: 'pa-donut-base',
    'fill-rule': 'evenodd',
  });
  svg.appendChild(ring);
  el.appendChild(svg);
  if (legendEl) {
    const empty = document.createElement('div');
    empty.className = 'pa-portfolio-legend__empty';
    empty.textContent = '添加资产后，这里会显示真实权重';
    legendEl.appendChild(empty);
  }
  updateCenter(centerId, null, 0, { showcase });
}

function gradientPair(hex) {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#2878FF';
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  const dark = [r, g, b]
    .map((channel) => Math.round(channel * 0.42).toString(16).padStart(2, '0'))
    .join('');
  return [normalized, `#${dark}`];
}

function sectorGap(span) {
  // 极小持仓的间隔必须小于扇区本身，否则真实持仓会被视觉间隔吞掉。
  return Math.min(1.4, Math.max(0.02, span * 0.13), span * 0.45);
}

function createMonogram(value) {
  return String(value || 'ASSET')
    .replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '')
    .slice(0, 4)
    .toUpperCase();
}

function abbreviate(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text;
}

function stop(offset, color, opacity) {
  return svgEl('stop', { offset, 'stop-color': color, 'stop-opacity': opacity });
}

function svgEl(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => {
    if (value !== undefined && value !== null) element.setAttribute(key, String(value));
  });
  return element;
}

function polarToCartesian(cx, cy, radius, angleInDegrees) {
  const radians = angleInDegrees * Math.PI / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function describeAnnularSector(cx, cy, outerRadius, innerRadius, startAngle, endAngle, direction = 1) {
  const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, endAngle);
  const innerEnd = polarToCartesian(cx, cy, innerRadius, endAngle);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);
  const largeArcFlag = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  const outerSweep = direction > 0 ? 1 : 0;
  const innerSweep = outerSweep ? 0 : 1;

  return [
    `M ${outerStart.x.toFixed(3)} ${outerStart.y.toFixed(3)}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} ${outerSweep} ${outerEnd.x.toFixed(3)} ${outerEnd.y.toFixed(3)}`,
    `L ${innerEnd.x.toFixed(3)} ${innerEnd.y.toFixed(3)}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} ${innerSweep} ${innerStart.x.toFixed(3)} ${innerStart.y.toFixed(3)}`,
    'Z',
  ].join(' ');
}

function describeFullAnnulus(cx, cy, outerRadius, innerRadius) {
  return [
    `M ${cx} ${cy - outerRadius}`,
    `A ${outerRadius} ${outerRadius} 0 1 1 ${cx - 0.01} ${cy - outerRadius}`,
    'Z',
    `M ${cx} ${cy - innerRadius}`,
    `A ${innerRadius} ${innerRadius} 0 1 0 ${cx - 0.01} ${cy - innerRadius}`,
    'Z',
  ].join(' ');
}
