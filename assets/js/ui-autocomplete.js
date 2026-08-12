// ui-autocomplete.js — 自动补全下拉组件

import { lookupFund } from './identify.js';
import { getFundListCache } from './fund-suggest.js';

/**
 * 初始化自动补全
 * @param {HTMLInputElement} inputEl
 * @param {HTMLElement} containerEl 下拉挂载容器（需 position:relative）
 * @returns {{dropdown: HTMLElement, onSelect: (cb: Function) => void}}
 */
export function initAutocomplete(inputEl, containerEl) {
  const dropdown = createDropdown();
	dropdown.id = 'pa-autocomplete-' + Math.random().toString(36).slice(2, 9);
	inputEl.setAttribute('role', 'combobox');
	inputEl.setAttribute('aria-autocomplete', 'list');
	inputEl.setAttribute('aria-controls', dropdown.id);
	inputEl.setAttribute('aria-expanded', 'false');
  containerEl.style.position = 'relative';
  containerEl.appendChild(dropdown);

  let activeIndex = -1;
  let candidates = [];
  let selectCallback = null;
  let debounceTimer;

  inputEl.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const val = inputEl.value.trim();
    if (val.length < 2) { closeDropdown(); return; }

    debounceTimer = setTimeout(() => {
      candidates = searchFunds(val);
      activeIndex = -1;
      renderCandidates(candidates, dropdown, inputEl, (item) => {
        if (selectCallback) selectCallback(item);
		closeDropdown();
      });
      openDropdown(dropdown, inputEl);
    }, 150);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (!dropdown.classList.contains('open')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, candidates.length - 1); updateActive(dropdown, activeIndex); }
    if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); updateActive(dropdown, activeIndex); }
    if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      const item = candidates[activeIndex];
      if (item && selectCallback) selectCallback(item);
      closeDropdown();
    }
    if (e.key === 'Escape') { closeDropdown(); }
  });

  // 点击外部关闭
  const onDocumentClick = (e) => {
    if (!containerEl.contains(e.target)) closeDropdown();
	};
	document.addEventListener('click', onDocumentClick);

  return {
    dropdown,
    onSelect(cb) { selectCallback = cb; },
    close: closeDropdown,
	destroy() {
	  clearTimeout(debounceTimer);
	  document.removeEventListener('click', onDocumentClick);
	  closeDropdown();
	  dropdown.remove();
	}
  };

  function closeDropdown() {
    dropdown.classList.remove('open');
    dropdown.innerHTML = '';
    candidates = [];
	inputEl.setAttribute('aria-expanded', 'false');
	inputEl.removeAttribute('aria-activedescendant');
  }

  function openDropdown(dd, inp) {
    const rect = inp.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    dd.style.top = (rect.bottom - containerRect.top + 4) + 'px';
    dd.style.left = (rect.left - containerRect.left) + 'px';
    dd.style.width = rect.width + 'px';
    dd.classList.add('open');
	inp.setAttribute('aria-expanded', 'true');
  }
}

/* ── 内部 ── */

function createDropdown() {
  const dd = document.createElement('div');
  dd.className = 'pa-autocomplete';
  dd.setAttribute('role', 'listbox');
  return dd;
}

function searchFunds(query) {
  const q = query.toLowerCase();
  const results = [];

  // 精确匹配优先（利用已有 lookupFund）
  try {
    const exact = lookupFund(query);
    if (exact) results.push(exact);
  } catch { /* fund list not loaded yet */ }

  // 前缀/子串搜索（在已缓存的基金清单中）
  const cache = getFundListCache();
  if (cache && cache.list) {
    // 只查6位纯数字且有基金清单缓存的场景
    for (const item of cache.list) {
      if (results.length >= 8) break; // 最多显示 8 条建议
      if (item[0] === query) continue; // 已在精确匹配中
      if (item[0].startsWith(query) || item[1].toLowerCase().includes(q)) {
        results.push({ code: item[0], name: item[1], ftype: item[2] });
      }
    }
  }

  return results;
}

function renderCandidates(items, dropdown, inputEl, onSelect) {
  dropdown.innerHTML = '';
  if (items.length === 0) {
    // 字母代码（美股/港股）不提示"未找到"，真正的识别在 triggerIdentify 里
    const val = inputEl.value.trim();
    if (/^[a-z]/i.test(val)) return;
    dropdown.innerHTML = '<div class="pa-autocomplete__empty">未找到匹配标的</div>';
    return;
  }
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'pa-autocomplete__item';
	row.id = dropdown.id + '-option-' + i;
    row.setAttribute('role', 'option');
	row.setAttribute('aria-selected', 'false');
    row.innerHTML = `
      <span class="pa-autocomplete__item-code">${escapeHtml(String(item.code))}</span>
      <span class="pa-autocomplete__item-name">${escapeHtml(item.name || '')}</span>
      <span class="pa-autocomplete__item-type">${item.ftype ? classifyBrief(item.ftype) : ''}</span>
    `;
    row.addEventListener('click', () => onSelect(item));
    dropdown.appendChild(row);
  });
}

function updateActive(dropdown, index) {
  const items = dropdown.querySelectorAll('.pa-autocomplete__item');
	items.forEach((el, i) => {
		const active = i === index;
		el.classList.toggle('pa-autocomplete__item--active', active);
		el.setAttribute('aria-selected', String(active));
	});
	const input = dropdown.parentElement?.querySelector('[role="combobox"]');
	if (input) {
		if (items[index]) input.setAttribute('aria-activedescendant', items[index].id);
		else input.removeAttribute('aria-activedescendant');
	}
}

function classifyBrief(ftype) {
  if (!ftype) return '';
  if (ftype.includes('货币')) return '货币';
  if (ftype.includes('指数') || ftype.includes('ETF')) return 'ETF';
  if (ftype.includes('混合')) return '混合';
  if (ftype.includes('股票')) return '股票';
  return '基金';
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}
