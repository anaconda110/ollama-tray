const { normalizeBalance, normalizeQuota, getLevel, validateApiKey } = require('../lib/quota');
const assert = require('assert');

// ─── /api/balance（2026-10-07 起的主数据源）——legacy 计划：remaining_percent ───
const balLegacy = normalizeBalance({
  included: {
    session: { remaining_percent: 56.31, resets_at: '2026-10-07T13:00:00Z' },
    weekly: { remaining_percent: 72.71, resets_at: '2026-10-12T00:00:00Z' },
  },
  purchased: { balance_usd: 0 },
});
assert.strictEqual(balLegacy.mode, 'session-weekly');
assert.strictEqual(balLegacy.source, 'balance');
assert.strictEqual(balLegacy.five_hour.used_pct, 44, '剩余 56.31% -> 已用 44%');
assert.strictEqual(balLegacy.weekly.used_pct, 27, '剩余 72.71% -> 已用 27%');
assert.strictEqual(balLegacy.five_hour.resetSource, 'api', '权威 resets_at 标记');
assert.strictEqual(balLegacy.five_hour.reset_at, '2026-10-07T13:00:00.000Z');
assert.strictEqual(balLegacy.weekly.reset_at, '2026-10-12T00:00:00.000Z');

// 边界：0 / 100 remaining
const balEdge = normalizeBalance({
  included: { session: { remaining_percent: 0 }, weekly: { remaining_percent: 100 } },
});
assert.strictEqual(balEdge.five_hour.used_pct, 100);
assert.strictEqual(balEdge.weekly.used_pct, 0);
assert.strictEqual(balEdge.five_hour.resetSource, undefined, '无 resets_at 时不标记 api 来源');

// ─── /api/balance——credit 计划：USD 余额制 ───
const balCredit = normalizeBalance({
  included: {
    balance_usd: 12.5,
    allowance_usd: 50,
    period: { from: '2026-10-01T00:00:00Z', until: '2026-11-01T00:00:00Z' },
  },
  purchased: { balance_usd: 3.25 },
});
assert.strictEqual(balCredit.mode, 'credit');
assert.strictEqual(balCredit.monthly.used_pct, 75, '12.5/50 余额 -> 已用 75%');
assert.strictEqual(balCredit.monthly.balance_usd, 12.5);
assert.strictEqual(balCredit.monthly.allowance_usd, 50);
assert.strictEqual(balCredit.monthly.purchased_usd, 3.25);
assert.strictEqual(balCredit.monthly.reset_at, '2026-11-01T00:00:00.000Z');
// 双窗口字段镜像月度口径（供托盘角标/历史/成本分摊复用）
assert.strictEqual(balCredit.weekly.used_pct, 75);
assert.strictEqual(balCredit.five_hour.used_pct, 75);

// 未知结构：明确返回 null（不再静默全 0）
assert.strictEqual(normalizeBalance({ foo: 'bar' }), null);
assert.strictEqual(normalizeBalance({}), null);

// ─── 旧结构兼容：/api/usage（2026-10-07 前的 limits.session/weekly）────────
const sampleApi = normalizeQuota({
  activity: { cost: '0.00000', period: { type: 'last_4_weeks' } },
  limits: {
    session: { usage: 0.039, models: [{ name: 'kimi-k3', request_count: 12 }] },
    weekly: { usage: 0.563, models: [{ name: 'glm-5.2', request_count: 6039 }] },
  },
});
assert.strictEqual(sampleApi.mode, 'session-weekly');
assert.strictEqual(sampleApi.five_hour.used_pct, 4, 'session 3.9% -> 4%');
assert.strictEqual(sampleApi.weekly.used_pct, 56, 'weekly 56.3% -> 56%');
assert.ok(sampleApi.five_hour.reset_at, 'reset_at 存在');
assert.ok(sampleApi.weekly.reset_at, 'reset_at 存在');
assert.strictEqual(sampleApi.plan, null, 'API 不提供 plan 时为 null');
assert.strictEqual(sampleApi.cost, '0.00000');
assert.strictEqual(sampleApi.periodType, 'last_4_weeks');
assert.strictEqual(sampleApi.five_hour.models[0].name, 'kimi-k3');
assert.strictEqual(sampleApi.weekly.models[0].level.level, 3, 'kimi-k3 -> Level 3');

// 改版后的 /api/usage（纯请求量序列）：不再冒充 quota，归一化返回 null
const newUsage = normalizeQuota({
  range: '7d', scope: 'self', granularity: 'day',
  totals: { request_count: 5548 },
  buckets: [{ from: '2026-10-06T00:00:00Z', until: '2026-10-07T00:00:00Z', request_count: 2359 }],
});
assert.strictEqual(newUsage, null, '新 usage 结构不再是 quota 源');

// 空对象同样返回 null（由 fetchQuota 抛错，不静默 0）
assert.strictEqual(normalizeQuota({}), null);

// ─── 旧结构兼容：used/total 比例 ────────────────────────────
const sample1 = normalizeQuota({
  plan: 'Pro',
  five_hour: { used: 12, total: 100, reset_at: '2026-08-13T00:00:00Z' },
  weekly: { used: 71, total: 100, reset_at: '2026-08-18T00:00:00Z' },
});
assert.strictEqual(sample1.five_hour.used_pct, 12);
assert.strictEqual(sample1.weekly.used_pct, 71);
assert.strictEqual(sample1.plan, 'Pro');

// used_pct 直接提供
const sample2 = normalizeQuota({
  plan: 'Free',
  five_hour: { used_pct: 34, reset_at: '2026-08-13T00:00:00Z' },
  weekly: { used_pct: 56, reset_at: '2026-08-18T00:00:00Z' },
});
assert.strictEqual(sample2.five_hour.used_pct, 34);
assert.strictEqual(sample2.weekly.used_pct, 56);

// ─── 模型 Level 解析 ─────────────────────────────────────
assert.strictEqual(getLevel('deepseek-v4-pro:0813').level, 4);
assert.strictEqual(getLevel('deepseek-v4-pro:0813-rsp').level, 4, '-rsp 变体同 Level');
assert.strictEqual(getLevel('unknown-model'), null);
assert.strictEqual(getLevel(null), null);

// ─── API Key 校验 ─────────────────────────────────────────
assert.strictEqual(validateApiKey('sk-abc123456789').ok, true);
assert.strictEqual(validateApiKey('').ok, false);
assert.strictEqual(validateApiKey('short').ok, false);
assert.strictEqual(validateApiKey(null).ok, false);

console.log('✅ quota tests passed');
