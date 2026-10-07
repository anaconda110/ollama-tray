// Ollama Cloud 用量配额获取（Bearer API 模式）
//
// 端点（2026-10-07 官方 API 改版后）：
//   GET {OLLAMA_BALANCE_API}         主数据源：剩余额度
//       · legacy 计划：included.session/weekly.remaining_percent（0..100，剩余）+ 权威 resets_at
//       · credit 计划：included.balance_usd / allowance_usd / period.until（USD 余额制）
//   GET {OLLAMA_USAGE_API}?range=24h 请求量统计（totals.request_count，best-effort，失败不致命）
//
// 改版说明：旧 /api/usage 的 limits.session/weekly + activity.cost 结构已于 2026-10-07 移除
// （同一路径改为按天请求量序列）。normalizeQuota 保留旧结构兼容分支，作为自建代理 /
// 未来回滚场景的兜底；主路径走 normalizeBalance。参考：ollama/ollama#18829。
// Key 来源优先级：本机加密存储（electron-store + safeStorage）> Maka credential vault
let store = null;
let safeStorage = null;

const OLLAMA_BALANCE_API = process.env.OLLAMA_BALANCE_API || 'https://api.ollama.com/api/balance';
const OLLAMA_USAGE_API = process.env.OLLAMA_USAGE_API || 'https://api.ollama.com/api/usage';
const MAKA_VAULT_CONNECTION_ID = process.env.OLLAMA_CONNECTION_ID || 'cf7993e3-252e-42e3-b07d-062fa90fe6e0';

const SESSION_WINDOW_MS = 5 * 3_600_000;
const WEEKLY_WINDOW_MS = 7 * 24 * 3_600_000;

function initStore(s, ss) {
  store = s;
  safeStorage = ss;
}

// ─── key 安全存取 ───────────────────────────────────────
function setSecureKey(raw) {
  if (!store) throw new Error('Store not initialized');
  if (!raw || !safeStorage || !safeStorage.isEncryptionAvailable()) {
    store.set('apiKey', raw || '');
    return;
  }
  store.set('apiKey', safeStorage.encryptString(raw).toString('base64'));
}

function getSecureKey() {
  if (!store) return '';
  const raw = store.get('apiKey') || '';
  if (!raw) return '';
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return raw;
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'));
  } catch {
    return ''; // 解密失败：不把密文当 key 返回
  }
}

// ─── Maka credential vault 兜底读取 ─────────────────────
function readMakaVaultKey() {
  try {
    const appdata = process.env.APPDATA;
    if (!appdata) return null;
    const vaultPath = require('path').join(appdata, 'Maka', 'workspaces', 'default', 'credential-vault.json');
    const vault = JSON.parse(require('fs').readFileSync(vaultPath, 'utf8'));
    const entry = (vault.entries || []).find((e) => e.locator?.connectionId === MAKA_VAULT_CONNECTION_ID);
    return entry?.secret || null;
  } catch {
    return null;
  }
}

function getApiKey() {
  return getSecureKey() || readMakaVaultKey() || process.env.OLLAMA_CLOUD_KEY || '';
}

// 候选 key 列表（按优先级去重）：某个来源失效（401）时自动降级到下一个，
// 避免 Maka vault 里残留的旧 key 阻断整条链路。
function getApiKeyCandidates() {
  const list = [getSecureKey(), readMakaVaultKey(), process.env.OLLAMA_CLOUD_KEY || ''];
  return [...new Set(list.filter((k) => typeof k === 'string' && k.trim()))];
}

function validateApiKey(raw) {
  const ok = typeof raw === 'string' && raw.trim().length >= 8;
  return { ok, missing: ok ? [] : ['api_key'] };
}

// ─── HTTP ───────────────────────────────────────────────
async function fetchJson(url, key) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${key}` },
  });
  if (res.status === 401 || res.status === 403) throw new Error('KEY_INVALID');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── 归一化辅助 ─────────────────────────────────────────
function isoOrNull(v) {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

// remaining_percent（0..100 剩余）→ used_pct（0..100 已用）
function pctFromRemaining(remaining) {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null;
  return Math.min(100, Math.max(0, Math.round(100 - remaining)));
}

// ─── /api/balance 归一化（2026-10-07 起的主数据源）────────
// legacy 计划实测结构：
//   included.session.remaining_percent  0..100 剩余（session 窗口 / 权威 resets_at）
//   included.weekly.remaining_percent   0..100 剩余（weekly 窗口 / 权威 resets_at）
//   purchased.balance_usd               已购余额
// credit 计划实测结构：
//   included.balance_usd / allowance_usd / period.{from,until}
function normalizeBalance(body) {
  const inc = body?.included || {};
  const purchased = typeof body?.purchased?.balance_usd === 'number' ? body.purchased.balance_usd : null;
  const updatedAt = new Date().toISOString();

  // ① legacy 计划：session / weekly 剩余百分比 + 权威重置时间
  if (inc.session || inc.weekly) {
    const sReset = isoOrNull(inc.session?.resets_at);
    const wReset = isoOrNull(inc.weekly?.resets_at);
    return {
      plan: null,
      status: 'ok',
      source: 'balance',
      mode: 'session-weekly',
      five_hour: {
        used_pct: pctFromRemaining(inc.session?.remaining_percent) ?? 0,
        reset_at: sReset,
        resetSource: sReset ? 'api' : undefined,
      },
      weekly: {
        used_pct: pctFromRemaining(inc.weekly?.remaining_percent) ?? 0,
        reset_at: wReset,
        resetSource: wReset ? 'api' : undefined,
      },
      monthly: null,
      cost: null,
      periodType: null,
      requests24h: null,
      updated_at: updatedAt,
    };
  }

  // ② credit 计划：USD 余额制（无 5h/周窗口，额度按订阅周期计）
  const allowance = typeof inc.allowance_usd === 'number' ? inc.allowance_usd : null;
  const balance = typeof inc.balance_usd === 'number' ? inc.balance_usd : null;
  if (allowance !== null || balance !== null || inc.period) {
    const used = allowance && allowance > 0 && balance !== null
      ? Math.min(100, Math.max(0, Math.round((1 - balance / allowance) * 100)))
      : 0;
    const resetAt = isoOrNull(inc.period?.until);
    const monthly = {
      used_pct: used,
      reset_at: resetAt,
      resetSource: resetAt ? 'api' : undefined,
      balance_usd: balance,
      allowance_usd: allowance,
      purchased_usd: purchased,
    };
    return {
      plan: null,
      status: 'ok',
      source: 'balance',
      mode: 'credit',
      monthly,
      // 其余模块（托盘角标 / 历史 / 成本分摊）沿用两窗口字段：镜像月度口径
      five_hour: { used_pct: used, reset_at: resetAt, resetSource: monthly.resetSource },
      weekly: { used_pct: used, reset_at: resetAt, resetSource: monthly.resetSource },
      cost: null,
      periodType: null,
      requests24h: null,
      updated_at: updatedAt,
    };
  }

  return null; // 未知结构：明确失败，而非静默全 0
}

// ─── Ollama Usage Level（1-4，官方按「模型难度/算力」给每个 token 定的额度权重）───
// 实测各模型页 usage gauge 点数：1=low / 2=medium / 3=high / 4=extra heavy
// ratio = 每 token 相对 Level 1 的消耗倍率（1 / 2 / 4 / 8）
const OLLAMA_LEVEL = {
  'gpt-oss:20b': { level: 1, ratio: 1 },
  'nemotron-3-nano:30b': { level: 1, ratio: 1 },
  'gemma4:31b': { level: 1, ratio: 1 },
  'gpt-oss:120b': { level: 2, ratio: 2 },
  'deepseek-v4-flash:0731': { level: 2, ratio: 2 },
  'deepseek-v4-flash:preview': { level: 2, ratio: 2 },
  'mistral-large-3:675b': { level: 2, ratio: 2 },
  'minimax-m2.7': { level: 2, ratio: 2 },
  'nemotron-3-super': { level: 2, ratio: 2 },
  'qwen3.5:397b': { level: 2, ratio: 2 },
  'glm-5.1': { level: 3, ratio: 4 },
  'glm-5.2': { level: 3, ratio: 4 },
  'kimi-k2.6': { level: 3, ratio: 4 },
  'kimi-k2.7-code': { level: 3, ratio: 4 },
  'kimi-k3': { level: 3, ratio: 4 },
  'minimax-m3': { level: 3, ratio: 4 },
  'nemotron-3-ultra': { level: 3, ratio: 4 },
  'deepseek-v4-pro:0813': { level: 4, ratio: 8 },
  'deepseek-v4-pro:preview': { level: 4, ratio: 8 },
};
// 从模型名解析 Level（含 -rsp 变体：推理变体按基础模型同 Level）
function getLevel(modelName) {
  if (!modelName) return null;
  const base = modelName.replace(/-rsp$/, '');
  const hit = OLLAMA_LEVEL[base];
  if (hit) return hit;
  // 兜底：按知名前缀猜（_rsp 带 '*』）
  const n = modelName.toLowerCase();
  if (n.includes('deepseek-v4-pro')) return { level: 4, ratio: 8 };
  if (n.includes('deepseek-v4-flash')) return { level: 2, ratio: 2 };
  if (n.includes('kimi') || n.includes('glm') || n.includes('minimax-m3') || n.includes('nemotron-3-ultra')) return { level: 3, ratio: 4 };
  if (n.includes('minimax-m2.7') || n.includes('nemotron-3-super') || n.includes('mistral') || n.includes('qwen') || n.includes('gpt-oss:120b')) return { level: 2, ratio: 2 };
  if (n.includes('gpt-oss:20b') || n.includes('nemotron-3-nano') || n.includes('gemma')) return { level: 1, ratio: 1 };
  return null;
}

// 归一并附上每模型请求数（旧 /api/usage 里 limits.session/weekly.models）
function attachModels(target, models) {
  if (!Array.isArray(models)) return;
  target.models = models
    .filter((x) => x && x.name)
    .map((x) => ({ name: x.name, requests: x.request_count || 0, level: getLevel(x.name) }));
}

// ─── 旧结构兼容归一化（自建代理 / 回滚兜底）──────────────
// 旧 /api/usage（2026-10-07 前）实测结构：
//   limits.session.usage   0..1 滚动会话窗口（~5h）使用比例
//   limits.weekly.usage    0..1 滚动周窗口（~7d）使用比例
//   activity.cost / activity.period.type
// 无法识别时返回 null（由调用方显式报错，避免"静默全 0"再次掩盖故障）。
function normalizeQuota(body) {
  const now = Date.now();
  const sessionUsage = body?.limits?.session?.usage;
  const weeklyUsage = body?.limits?.weekly?.usage;

  if (typeof sessionUsage === 'number' || typeof weeklyUsage === 'number') {
    const frac = (v) => Math.min(100, Math.max(0, Math.round((v ?? 0) * 100)));
    const out = {
      plan: body.plan || body.subscription || null, // API 不提供 plan 时为 null（UI 不显示）
      status: body.status || 'ok',
      source: 'usage',
      mode: 'session-weekly',
      five_hour: {
        used_pct: frac(sessionUsage),
        reset_at: new Date(now + SESSION_WINDOW_MS).toISOString(),
      },
      weekly: {
        used_pct: frac(weeklyUsage),
        reset_at: new Date(now + WEEKLY_WINDOW_MS).toISOString(),
      },
      monthly: null,
      cost: body?.activity?.cost ?? null,
      periodType: body?.activity?.period?.type ?? null,
      requests24h: null,
      updated_at: new Date().toISOString(),
    };
    attachModels(out.five_hour, body?.limits?.session?.models);
    attachModels(out.weekly, body?.limits?.weekly?.models);
    return out;
  }

  // 更早结构兼容：five_hour / weekly
  const five = body?.five_hour || body?.fiveHour || body?.five;
  const weekly = body?.weekly || body?.week || body?.sevenDay;
  if (!five && !weekly) return null;

  function toPct(value, used, total) {
    if (typeof value === 'number') return Math.min(100, Math.max(0, value));
    if (typeof used === 'number' && typeof total === 'number' && total > 0) {
      return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
    }
    return 0;
  }
  function resetAt(input) {
    if (!input) return new Date(now + SESSION_WINDOW_MS).toISOString();
    return new Date(input).toISOString();
  }

  return {
    plan: body.plan || body.subscription || null,
    status: body.status || 'ok',
    source: 'usage',
    five_hour: {
      used_pct: toPct(five.used_pct, five.used, five.total),
      reset_at: resetAt(five.reset_at || five.resetAt),
    },
    weekly: {
      used_pct: toPct(weekly.used_pct, weekly.used, weekly.total),
      reset_at: resetAt(weekly.reset_at || weekly.resetAt),
    },
    monthly: null,
    cost: body?.activity?.cost ?? null,
    periodType: body?.activity?.period?.type ?? null,
    requests24h: null,
    updated_at: new Date().toISOString(),
  };
}

// ─── 抓取 ───────────────────────────────────────────────
// 单个 key 的一轮抓取：balance 为主数据源；usage（24h 请求量）best-effort，失败不影响主流程。
async function fetchWithKey(key) {
  const [bal, usage] = await Promise.allSettled([
    fetchJson(OLLAMA_BALANCE_API, key),
    fetchJson(`${OLLAMA_USAGE_API}?range=24h`, key),
  ]);

  let quota = null;
  if (bal.status === 'fulfilled') quota = normalizeBalance(bal.value) || normalizeQuota(bal.value);
  if (!quota && usage.status === 'fulfilled') quota = normalizeQuota(usage.value); // 旧结构兜底

  if (!quota) {
    // 明确失败而不是静默全 0：优先抛 balance 的错误（KEY_INVALID / 网络），否则 NO_LIMITS
    if (bal.status === 'rejected') throw bal.reason;
    if (usage.status === 'rejected') throw usage.reason;
    throw new Error('NO_LIMITS');
  }

  if (usage.status === 'fulfilled') {
    const t = usage.value?.totals || {};
    if (typeof t.request_count === 'number') quota.requests24h = t.request_count;
    if (quota.cost == null && t.usage_usd != null) quota.cost = t.usage_usd;
  }
  return quota;
}

async function fetchQuota() {
  const keys = getApiKeyCandidates();
  if (!keys.length) throw new Error('NO_KEY');

  let lastErr = null;
  for (const key of keys) {
    try {
      return await fetchWithKey(key);
    } catch (e) {
      lastErr = e;
      // 仅 KEY_INVALID 降级到下一个候选；网络类错误直接抛出（换 key 无意义）
      if (e.message !== 'KEY_INVALID') throw e;
    }
  }
  throw lastErr || new Error('KEY_INVALID');
}

module.exports = {
  normalizeBalance,
  normalizeQuota,
  fetchQuota,
  setSecureKey,
  getSecureKey,
  getApiKey,
  getApiKeyCandidates,
  initStore,
  validateApiKey,
  OLLAMA_BALANCE_API,
  OLLAMA_USAGE_API,
  getLevel,
  OLLAMA_LEVEL,
};
