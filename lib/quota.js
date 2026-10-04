// Ollama Cloud 用量配额获取（Bearer API 模式）
// 端点：https://api.ollama.com/api/usage（test 项目已验证）
// Key 来源优先级：本机加密存储（electron-store + safeStorage）> Maka credential vault
let store = null;
let safeStorage = null;

const OLLAMA_USAGE_API = process.env.OLLAMA_USAGE_API || 'https://api.ollama.com/api/usage';
const MAKA_VAULT_CONNECTION_ID = process.env.OLLAMA_CONNECTION_ID || 'cf7993e3-252e-42e3-b07d-062fa90fe6e0';

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

function validateApiKey(raw) {
  const ok = typeof raw === 'string' && raw.trim().length >= 8;
  return { ok, missing: ok ? [] : ['api_key'] };
}

// ─── 抓取 ───────────────────────────────────────────────
async function fetchQuota() {
  const key = getApiKey();
  if (!key) throw new Error('NO_KEY');

  const res = await fetch(OLLAMA_USAGE_API, {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${key}` },
  });

  if (res.status === 401 || res.status === 403) throw new Error('KEY_INVALID');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.json();
  return normalizeQuota(body);
}

// ─── 归一化：兼容 /api/usage 与旧结构 ────────────────────
// /api/usage 实测结构（api.ollama.com）：
//   limits.session.usage   0..1 滚动会话窗口（~5h）使用比例
//   limits.weekly.usage    0..1 滚动周窗口（~7d）使用比例
//   activity.cost / activity.period.type
const SESSION_WINDOW_MS = 5 * 3_600_000;
const WEEKLY_WINDOW_MS = 7 * 24 * 3_600_000;

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

// 归一并附上每模型请求数（Ollama /api/usage 里 limits.session/weekly.models）
function attachModels(target, models) {
  if (!Array.isArray(models)) return;
  target.models = models
    .filter((x) => x && x.name)
    .map((x) => ({ name: x.name, requests: x.request_count || 0, level: getLevel(x.name) }));
}

function normalizeQuota(body) {
  const now = Date.now();
  const sessionUsage = body?.limits?.session?.usage;
  const weeklyUsage = body?.limits?.weekly?.usage;

  if (typeof sessionUsage === 'number' || typeof weeklyUsage === 'number') {
    const frac = (v) => Math.min(100, Math.max(0, Math.round((v ?? 0) * 100)));
    const out = {
      plan: body.plan || body.subscription || null, // API 不提供 plan 时为 null（UI 不显示）
      status: body.status || 'ok',
      five_hour: {
        used_pct: frac(sessionUsage),
        reset_at: new Date(now + SESSION_WINDOW_MS).toISOString(),
      },
      weekly: {
        used_pct: frac(weeklyUsage),
        reset_at: new Date(now + WEEKLY_WINDOW_MS).toISOString(),
      },
      cost: body?.activity?.cost ?? null,
      periodType: body?.activity?.period?.type ?? null,
      updated_at: new Date().toISOString(),
    };
    attachModels(out.five_hour, body?.limits?.session?.models);
    attachModels(out.weekly, body?.limits?.weekly?.models);
    return out;
  }

  // 旧结构兼容：five_hour / weekly
  const five = body.five_hour || body.fiveHour || body.five || {};
  const weekly = body.weekly || body.week || body.sevenDay || {};

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
    five_hour: {
      used_pct: toPct(five.used_pct, five.used, five.total),
      reset_at: resetAt(five.reset_at || five.resetAt),
    },
    weekly: {
      used_pct: toPct(weekly.used_pct, weekly.used, weekly.total),
      reset_at: resetAt(weekly.reset_at || weekly.resetAt),
    },
    cost: body?.activity?.cost ?? null,
    periodType: body?.activity?.period?.type ?? null,
    updated_at: new Date().toISOString(),
  };
}

module.exports = {
  normalizeQuota,
  fetchQuota,
  setSecureKey,
  getSecureKey,
  getApiKey,
  initStore,
  validateApiKey,
  OLLAMA_USAGE_API,
  getLevel,
  OLLAMA_LEVEL,
};
