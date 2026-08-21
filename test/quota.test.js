const { normalizeQuota, validateApiKey } = require('../lib/quota');
const assert = require('assert');

// ─── 新结构：/api/usage（limits.session/weekly，usage 为 0..1 比例）────────
const sampleApi = normalizeQuota({
  activity: { cost: '0.00000', period: { type: 'last_4_weeks' } },
  limits: {
    session: { usage: 0.039, models: [{ name: 'kimi-k3', request_count: 12 }] },
    weekly: { usage: 0.563, models: [{ name: 'glm-5.2', request_count: 6039 }] },
  },
});
assert.strictEqual(sampleApi.five_hour.used_pct, 4, 'session 3.9% -> 4%');
assert.strictEqual(sampleApi.weekly.used_pct, 56, 'weekly 56.3% -> 56%');
assert.ok(sampleApi.five_hour.reset_at, 'reset_at 存在');
assert.ok(sampleApi.weekly.reset_at, 'reset_at 存在');
assert.strictEqual(sampleApi.plan, null, 'API 不提供 plan 时为 null');
assert.strictEqual(sampleApi.cost, '0.00000');
assert.strictEqual(sampleApi.periodType, 'last_4_weeks');

// limits 缺失时按 0 处理（不崩溃）
const sampleEmpty = normalizeQuota({});
assert.strictEqual(sampleEmpty.five_hour.used_pct, 0);
assert.strictEqual(sampleEmpty.weekly.used_pct, 0);

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

// ─── API Key 校验 ─────────────────────────────────────────
assert.strictEqual(validateApiKey('sk-abc123456789').ok, true);
assert.strictEqual(validateApiKey('').ok, false);
assert.strictEqual(validateApiKey('short').ok, false);
assert.strictEqual(validateApiKey(null).ok, false);

console.log('✅ quota tests passed');
