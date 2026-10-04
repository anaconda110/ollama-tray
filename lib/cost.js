// 成本模型 —— 把 Ollama 额度消耗抽象成可衡量、可分摊的成本
//
// 原则（用户指定）：
//   - **不用 NewAPI 价格**（model_ratio / price / quota 均不作为参考）
//   - 基于四类「事实数据」：
//       1. 实际 token 消耗（按模型，来自 NewAPI 日志）
//       2. 调用次数（按模型）
//       3. 5h 会话额度消耗（Ollama /api/usage 的 used_pct）
//       4. 周额度消耗（Ollama /api/usage 的 used_pct）
//   - 把「额度消耗」抽象成成本：
//       · 窗口级成本 = 5h / 周 各自的 used_pct（这就是 Ollama 口径下的真实消耗）
//       · 模型级成本 = 该模型 token × Usage Level 权重，归一成占比，
//         再映射到窗口成本上，得到每个模型分摊的额度成本。
//
// 关键：额度重置是「时间锚点」驱动（对齐 ollama-tray 原理）：
//   - 5h：每 5 小时整点清零（nextFiveHGridReset）
//   - 周：每周一 00:00 UTC 清零（nextMondayUtcReset）
//   判断是否跨过重置点看 reset_at 锚点，**不是** used_pct 数值骤降。

const { getLevel } = require('./quota');

// 单模型相对成本权重：token × Ollama Usage Level 倍率（无映射按 1）
function modelWeight(model) {
  const lv = getLevel(model);
  return lv ? lv.ratio : 1;
}

// 判断两次采样是否跨过了重置点：reset_at（下一个重置点）往后跳了即发生重置。
// 跨重置时，窗口消耗 = (100 - prev.used) + cur.used（重置前剩余也要计入）。
function windowConsumed(prev, cur) {
  if (!prev || !cur) return 0;
  const pUsed = prev.used_pct;
  const cUsed = cur.used_pct;
  if (typeof pUsed !== 'number' || typeof cUsed !== 'number') return 0;
  const pReset = prev.reset_at ? new Date(prev.reset_at).getTime() : 0;
  const cReset = cur.reset_at ? new Date(cur.reset_at).getTime() : 0;
  const crossed = pReset > 0 && cReset > 0 && cReset > pReset;
  if (crossed) return Math.max(0, 100 - pUsed) + cUsed;
  return Math.max(0, cUsed - pUsed);
}

// 计算成本分摊
// modelAggs : newapi.aggregateByModel 的产出 [{model,calls,prompt,completion,...}]
// usageNow  : { five_hour:{used_pct,reset_at}, weekly:{used_pct,reset_at} } 当前窗口消耗
// usagePrev : 同上，上一次采样（无则 null，此时仅给相对占比，不做窗口分摊）
// 返回：{ models:[...], total:{...} }
function computeCost(modelAggs, usageNow, usagePrev) {
  const rows = (modelAggs || []).map((g) => {
    const tokens = (g.prompt || 0) + (g.completion || 0);
    const weight = modelWeight(g.model);
    return {
      model: g.model,
      calls: g.calls || 0,
      prompt: g.prompt || 0,
      completion: g.completion || 0,
      tokens,
      weight,
      relativeCost: tokens * weight, // 相对成本（未归一）
      avg_prompt: g.avg_prompt || 0,
      avg_completion: g.avg_completion || 0,
      avg_use_ms: g.avg_use_ms || 0,
      reasoning: g.reasoning || '',
      token_names: g.token_names || [],
    };
  });

  const totalRel = rows.reduce((s, r) => s + r.relativeCost, 0) || 0;
  const totalTokens = rows.reduce((s, r) => s + r.tokens, 0) || 0;
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0) || 0;

  // 窗口级成本：当前 5h / 周 的累计消耗（这就是 Ollama 口径下的成本）
  const fiveHourUsed = usageNow?.five_hour?.used_pct;
  const weeklyUsed = usageNow?.weekly?.used_pct;

  // 本次采样区间内新增消耗（跨重置 wrap-around，对齐锚点原理）
  const fiveHourDelta = usagePrev ? windowConsumed(usagePrev.five_hour, usageNow?.five_hour) : 0;
  const weeklyDelta = usagePrev ? windowConsumed(usagePrev.weekly, usageNow?.weekly) : 0;

  // 分摊：把窗口成本按「相对成本占比」拆到每个模型
  for (const r of rows) {
    const share = totalRel ? r.relativeCost / totalRel : 0;
    r.relativeRatio = totalRel ? Math.round(share * 1000) / 10 : 0; // %
    r.shareFiveHour = (typeof fiveHourUsed === 'number' ? fiveHourUsed : 0) * share;
    r.shareWeekly = (typeof weeklyUsed === 'number' ? weeklyUsed : 0) * share;
  }

  rows.sort((a, b) => b.relativeCost - a.relativeCost || b.tokens - a.tokens);

  return {
    models: rows,
    total: {
      relativeCost: Math.round(totalRel),
      tokens: totalTokens,
      calls: totalCalls,
      fiveHourUsed: typeof fiveHourUsed === 'number' ? fiveHourUsed : 0,
      weeklyUsed: typeof weeklyUsed === 'number' ? weeklyUsed : 0,
      fiveHourDelta,
      weeklyDelta,
      ts: Date.now(),
    },
  };
}

module.exports = { computeCost, windowConsumed, modelWeight };
