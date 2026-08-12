// holding-cost.js — 持仓成本录入的纯计算与资产类型判断

const FUND_TYPES = new Set(['fund', 'etf', 'money']);

/**
 * 判断识别结果是否属于可按投入金额录入的基金资产。
 * 场外基金可能被细分为 stock 类型，因此 market=of 始终按基金处理。
 */
export function isFundAsset(asset) {
  if (!asset) return false;
  if (asset.market === 'of') return true;
  return (asset.market === 'sh' || asset.market === 'sz') && FUND_TYPES.has(asset.type);
}

/**
 * 用实际投入金额和确认份额计算单位成本。
 * 返回 null 表示任一输入无效；成功时保留 JavaScript number 的完整精度。
 */
export function calculateUnitCost(totalAmount, quantity) {
  const amount = Number(totalAmount);
  const shares = Number(quantity);
  if (!Number.isFinite(amount) || !Number.isFinite(shares) || amount <= 0 || shares <= 0) {
    return null;
  }
  const cost = amount / shares;
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}

/** 最多显示 6 位小数，但不改变保存时的数值精度。 */
export function formatUnitCost(cost) {
  if (!Number.isFinite(cost)) return '';
  return cost.toFixed(6).replace(/\.?0+$/, '');
}
