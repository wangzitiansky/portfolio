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

/** 查找与待新增基金同市场、同代码的已有持仓；账户不参与匹配。 */
export function findFundMergeMatches(holdings, incoming) {
  if (!Array.isArray(holdings) || !isFundAsset(incoming)) return [];
  return holdings.filter((holding) =>
    isFundAsset(holding) &&
    holding.market === incoming.market &&
    holding.code === incoming.code
  );
}

/**
 * 将一笔新增基金合并进现有持仓。
 * incomingTotalCost 可传入投入金额模式的原始金额，避免金额 / 份额再相乘带来的精度损失。
 */
export function mergeFundHolding(holdings, incoming, { incomingTotalCost } = {}) {
  if (!Array.isArray(holdings)) throw new TypeError('持仓数据必须是数组');

  const quantity = Number(incoming?.quantity);
  const cost = Number(incoming?.cost);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(cost) || cost < 0) {
    throw new TypeError('新增基金的份额或成本无效');
  }

  const matches = findFundMergeMatches(holdings, incoming);
  if (matches.length === 0) {
    return {
      holdings: [...holdings, incoming],
      holding: incoming,
      merged: false,
      mergedCount: 0,
      existingQuantity: 0
    };
  }

  const canonical = matches.reduce((earliest, holding) => {
    const earliestAt = Number(earliest.createdAt) || Number.MAX_SAFE_INTEGER;
    const holdingAt = Number(holding.createdAt) || Number.MAX_SAFE_INTEGER;
    return holdingAt < earliestAt ? holding : earliest;
  });

  let existingQuantity = 0;
  let totalCostBasis = 0;
  for (const holding of matches) {
    const oldQuantity = Number(holding.quantity);
    const oldCost = Number(holding.cost);
    if (!Number.isFinite(oldQuantity) || oldQuantity <= 0 || !Number.isFinite(oldCost) || oldCost < 0) {
      throw new TypeError('已有基金的份额或成本无效');
    }
    existingQuantity += oldQuantity;
    totalCostBasis += oldQuantity * oldCost;
  }

  const addedCostBasis = incomingTotalCost === undefined
    ? quantity * cost
    : Number(incomingTotalCost);
  if (!Number.isFinite(addedCostBasis) || addedCostBasis < 0) {
    throw new TypeError('新增基金的总投入无效');
  }

  const mergedQuantity = existingQuantity + quantity;
  const mergedHolding = {
    ...canonical,
    quantity: mergedQuantity,
    cost: (totalCostBasis + addedCostBasis) / mergedQuantity,
    updatedAt: incoming.updatedAt
  };

  const mergedHoldings = [];
  for (const holding of holdings) {
    if (holding === canonical) {
      mergedHoldings.push(mergedHolding);
    } else if (!matches.includes(holding)) {
      mergedHoldings.push(holding);
    }
  }

  return {
    holdings: mergedHoldings,
    holding: mergedHolding,
    merged: true,
    mergedCount: matches.length,
    existingQuantity
  };
}
