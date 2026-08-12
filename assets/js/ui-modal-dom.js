// ui-modal-dom.js — 添加持仓弹窗 DOM 模板（纯 HTML 字符串）

/**
 * 弹窗完整 HTML 模板
 * @returns {string}
 */
export function modalTemplate() {
  return `
<div class="pa-modal" id="add-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <div class="pa-modal__dialog">
    <div class="pa-modal__header">
      <h3 id="modal-title">添加持仓</h3>
      <button class="pa-btn pa-btn--icon" id="modal-close" aria-label="关闭">
        <svg class="pa-icon--20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="pa-modal__body">
      <div class="pa-form" id="modal-form">
        <!-- 代码 -->
        <div class="pa-field pa-field--code" id="field-code">
          <label class="pa-field__label" for="input-code">标的代码 <span class="required">*</span></label>
          <div class="pa-field__control" style="position:relative" id="code-container">
            <input class="pa-input" id="input-code" type="text" placeholder="输入代码 或直接填写名称添加现金/存款" autocomplete="off" aria-describedby="error-code">
          </div>
          <div style="display:flex;gap:8px;margin-top:4px">
            <button type="button" class="pa-btn pa-btn--secondary pa-btn--sm quick-cash" data-name="银行存款">🏦 银行存款</button>
            <button type="button" class="pa-btn pa-btn--secondary pa-btn--sm quick-cash" data-name="现金">💵 现金</button>
            <button type="button" class="pa-btn pa-btn--secondary pa-btn--sm quick-cash" data-name="货币基金">📊 货币基金</button>
          </div>
          <div class="pa-field__error" id="error-code"></div>
          <div class="pa-market-select" id="market-select" style="display:none" role="radiogroup" aria-label="选择市场"></div>
        </div>
        <!-- 名称（只读） -->
        <div class="pa-field" id="field-name">
          <label class="pa-field__label">名称</label>
          <div class="pa-field__control--readonly" id="input-name">—</div>
        </div>
        <!-- 类型（只读） -->
        <div class="pa-field" id="field-type">
          <label class="pa-field__label">类型</label>
          <div class="pa-field__control--readonly" id="input-type">—</div>
        </div>
        <!-- 指数 -->
        <div class="pa-field" id="field-index">
          <label class="pa-field__label">底层指数</label>
          <div class="pa-field__control--readonly" id="input-index">—</div>
          <input class="pa-input" id="input-index-manual" type="text" placeholder="手动指定指数，如 沪深300" style="display:none">
        </div>
        <!-- 数量 -->
        <div class="pa-field" id="field-quantity">
          <label class="pa-field__label" for="input-quantity">持仓数量 <span class="required">*</span></label>
          <input class="pa-input" id="input-quantity" type="text" inputmode="decimal" placeholder="0" autocomplete="off" aria-describedby="error-qty">
          <div class="pa-field__error" id="error-qty"></div>
        </div>
        <!-- 成本价 -->
        <div class="pa-field" id="field-cost">
          <label class="pa-field__label" for="input-cost">成本价 <span class="required">*</span></label>
          <input class="pa-input" id="input-cost" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-describedby="error-cost">
          <div class="pa-field__hint" id="cost-hint"></div>
          <div class="pa-field__error" id="error-cost"></div>
        </div>
        <!-- 账户 -->
        <div class="pa-field" id="field-account">
          <label class="pa-field__label" for="input-account">券商/账户</label>
          <input class="pa-input" id="input-account" type="text" placeholder="如 华泰证券" autocomplete="off" list="account-list">
          <datalist id="account-list">
            <option value="华泰证券"><option value="中信证券"><option value="国泰君安"><option value="招商证券">
            <option value="天天基金"><option value="支付宝"><option value="富途牛牛"><option value="老虎证券">
            <option value="银行理财"><option value="银行存款">
          </datalist>
        </div>
      </div>
      <!-- 预览条 -->
      <div class="pa-preview" id="modal-preview" aria-live="polite" style="display:none; margin-top:16px;"></div>
      <!-- 错误条 -->
      <div class="pa-error-bar" id="modal-error" style="display:none; margin-top:12px;"></div>
    </div>
    <div class="pa-modal__footer">
      <button class="pa-btn pa-btn--secondary" id="modal-cancel">取消</button>
      <button class="pa-btn pa-btn--primary" id="modal-save" disabled>
        <svg class="pa-icon--20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" id="modal-save-icon" style="display:none"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
        保存
      </button>
    </div>
  </div>
</div>`;
}
