// NewAPI 数据源（局域网 Ollama 中转网关）—— 用于获取「按模型的 token/请求明细」
//
// 数据来源（均需要管理员凭证 1/密码）：
//   POST {base}/api/user/login                     -> access_token
//   GET  {base}/api/log/self?p=..&page_size=..     -> 模型调用日志(逐条 prompt/completion/耗时)
//   GET  {base}/api/log/self/stat                  -> 累计 rpm / tpm
//
// 成本口径：**以 Ollama Usage Level（1-4）为准，不用 NewAPI 的 model_ratio/price。**
//   NewAPI 日志只用来拿到「每个模型实际烧了多少 token、多少次请求」（事实数据），
//   然后由 aggregateByModel 用 Ollama Level 权重(1/2/4/8)估算相对额度消耗。
//   注意：NewAPI 日志里的 `quota` 字段是 NewAPI 自己的计费口径，**不作为参考**。

const { getLevel } = require('./quota'); // 复用 Ollama Level 映射

let token = '';
let baseUrl = '';

function setEndpoint(url) {
  baseUrl = (url || '').replace(/\/+$/, '');
}

function authHeaders() {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

// 登录管理员，取 access_token（NewAPI 有 429 登录限流）
async function login(username, password, url) {
  const base = (url || baseUrl).replace(/\/+$/, '');
  const res = await fetch(`${base}/api/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: String(username || '').trim(), password: String(password || '') }),
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error('NewAPI 登录限流，稍后再试');
    throw new Error(`NewAPI 登录 HTTP ${res.status}`);
  }
  const body = await res.json();
  const tk = body?.data?.access_token;
  if (!tk) throw new Error(body?.message || 'NewAPI 登录失败');
  baseUrl = base;
  token = tk;
  return tk;
}

function ensureLogin() {
  if (!token) throw new Error('未登录 NewAPI');
}

function parseOther(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// 拉取模型调用日志（type=2）。分页。返回单条记录数组。
async function fetchCallLogs({ pageSize = 200, maxPages = 15 } = {}) {
  ensureLogin();
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${baseUrl}/api/log/self?p=${page}&page_size=${pageSize}&type=2`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`log HTTP ${res.status}`);
    const body = await res.json();
    const items = body?.data?.items || [];
    if (!items.length) break;
    for (const it of items) {
      if (it.type !== 2) continue;
      const other = parseOther(it.other);
      out.push({
        id: it.id,
        ts: (it.created_at || 0) * 1000,
        model: it.model_name || '',
        token_name: it.token_name || '',
        prompt: it.prompt_tokens || 0,
        completion: it.completion_tokens || 0,
        use_time: it.use_time || 0,
        stream: !!it.is_stream,
        channel: it.channel_name || '',
        group: it.group || '',
        reasoning_effort: other.reasoning_effort,
        request_path: other.request_path,
      });
    }
    if (items.length < pageSize) break; // 到底了
  }
  return out;
}

// 全局量统计：rpm / tpm（不含 quota，因为 NewAPI 计费不作为参考）
async function fetchStat() {
  ensureLogin();
  const res = await fetch(`${baseUrl}/api/log/self/stat`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`stat HTTP ${res.status}`);
  const body = await res.json();
  const d = body?.data || {};
  return { rpm: d.rpm || 0, tpm: d.tpm || 0 };
}

// 按模型聚合（日志明细 -> 每模型汇总），按「估算消耗」降序。
// 估算消耗 = prompt × level.ratio + completion × level.ratio（同一模型同 level，故等价于总token×ratio）。
function aggregateByModel(logs) {
  const m = new Map();
  for (const l of logs) {
    if (!l.model) continue;
    if (!m.has(l.model)) {
      m.set(l.model, {
        model: l.model, calls: 0, prompt: 0, completion: 0, use_time: 0,
        reasoning: l.reasoning_effort || '', paths: new Set(), token_names: new Set(), last_ts: 0,
      });
    }
    const g = m.get(l.model);
    g.calls++;
    g.prompt += l.prompt;
    g.completion += l.completion;
    g.use_time += l.use_time;
    if (l.reasoning_effort) g.reasoning = l.reasoning_effort;
    if (l.request_path) g.paths.add(l.request_path);
    if (l.token_name) g.token_names.add(l.token_name);
    if (l.ts > g.last_ts) g.last_ts = l.ts;
  }
  const arr = [...m.values()].map((g) => {
    const lv = getLevel(g.model);
    const level = lv ? lv.level : null;
    const weight = lv ? lv.ratio : 1;
    const tokens = g.prompt + g.completion;
    return {
      ...g,
      level,
      weight,
      tokens,
      // 相对消耗（按 Ollama Level 权重估算，用于横向对比各模型烧额度的相对成本）
      estimated_cost: Math.round(tokens * weight),
      avg_prompt: g.calls ? Math.round(g.prompt / g.calls) : 0,
      avg_completion: g.calls ? Math.round(g.completion / g.calls) : 0,
      avg_use_ms: g.calls ? Math.round(g.use_time / g.calls) : 0,
      paths: [...g.paths],
      token_names: [...g.token_names],
    };
  });
  arr.sort((a, b) => b.estimated_cost - a.estimated_cost || b.tokens - a.tokens);
  return arr;
}

module.exports = {
  setEndpoint,
  login,
  fetchCallLogs,
  fetchStat,
  aggregateByModel,
};

