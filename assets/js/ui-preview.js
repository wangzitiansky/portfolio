// ui-preview.js — 实时预览条

import { fmtMoney, sign, fmtPct, trendClass } from './compute.js';

/**
 * 更新实时预览条
 * @param {HTMLElement} el 预览条容器
 * @param {{marketValue:number, pnl:number, pnlPct:number, currency:string}} p 预览数据
 */
export function renderPreview(el, p) {
  if (!el) return;
  const hasData = !isNaN(p.marketValue) && !isNaN(p.pnl);

  if (!hasData) {
    el.innerHTML = '<span style="color:var(--muted)">输入数量和成本后自动预览</span>';
    el.style.display = 'flex';
    return;
  }

  const cls = trendClass(p.pnlPct);
  const currency = p.currency || 'CNY';
  el.innerHTML = `
	<span>预估市值 <strong>${fmtMoney(p.marketValue, currency)}</strong></span>
    <span style="margin:0 8px;color:var(--border)">·</span>
	<span>预估盈亏 <strong class="${cls} num">${sign(p.pnl)}${fmtMoney(Math.abs(p.pnl), currency)} (${fmtPct(p.pnlPct)})</strong></span>
  `;
  el.style.display = 'flex';
}

/** 清空预览条 */
export function clearPreview(el) {
  if (!el) return;
  el.innerHTML = '';
  el.style.display = 'none';
}
