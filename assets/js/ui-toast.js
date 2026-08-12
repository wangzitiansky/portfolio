// ui-toast.js — Toast 通知组件

const TOAST_DURATION = 2600;

/**
 * 显示 Toast
 * @param {string} msg
 * @param {'success'|'error'|'info'} type
 */
export function showToast(msg, type = 'success') {
  let container = document.querySelector('.pa-toast');
  if (!container) {
    container = document.createElement('div');
    container.className = 'pa-toast';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const item = document.createElement('div');
  item.className = `pa-toast__item pa-toast__item--${type}`;

  const iconMap = {
    success: '<svg class="pa-icon--16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg class="pa-icon--16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    info: '<svg class="pa-icon--16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  item.innerHTML = `${iconMap[type] || iconMap.info}<span>${escapeHtml(msg)}</span>`;
  container.appendChild(item);

  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateX(20px)';
    item.style.transition = 'opacity 200ms, transform 200ms';
    setTimeout(() => { if (item.parentNode) item.parentNode.removeChild(item); }, 200);
  }, TOAST_DURATION);
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
