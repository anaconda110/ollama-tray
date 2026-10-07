# Ollama Cloud 配额重置规律（实测分析）

> 日期：2026-08-21（2026-10-07 更新：官方 API 改版后以 `resets_at` 为准）
> 数据来源：用户连续多日观测 + `api.ollama.com/api/usage` / `api.ollama.com/api/balance` 实测
> 结论：**5h 会话额度为「整点滚动窗口」，周额度为「每周一 00:00 UTC 固定重置」**

---

## 〇、2026-10-07 API 改版的接口变化

| 项 | 旧（2026-10-07 前） | 新（2026-10-07 起） |
|----|--------------------|-------------------|
| 配额百分比 | `GET /api/usage` → `limits.session/weekly.usage`（0..1 已用） | `GET /api/balance` → `included.session/weekly.remaining_percent`（0..100 **剩余**），credit 计划为 `balance_usd/allowance_usd` |
| 重置时间 | 不返回，本地锚点推算 | **`resets_at` 权威返回**（session / weekly 各自） |
| cost / 周期类型 | `activity.cost` / `activity.period.type` | 无（credit 计划 `/api/usage?range=24h` 的 `totals.usage_usd` 近似） |
| `/api/usage` | 配额 + 模型请求数 | 仅按天请求量序列（`totals.request_count` / `buckets`），`range=24h\|7d\|30d` |

代码适配：`lib/quota.js` 的 `normalizeBalance`（新主路径）/ `normalizeQuota`（旧结构兜底）；
`main.js` 的 `applyFixedResetAnchor` 在检测到 `resetSource === 'api'` 时直接采用 `resets_at`。

---

## 一、5h 会话额度（Session limit）

### 实测观测

| 观察时间(北京) | resets in | 实际重置点 |
|---------------|-----------|-----------|
| 07-27 03:56 | 3 minutes | 07-27 **04:00** |
| 07-27 04:00 | 5 hours | 07-27 **09:00** |
| 07-27 05:48 | 3 hours | 07-27 **09:00** |
| 07-27 06:02 | 3 hours | 07-27 **09:00** |
| 08-02 16:31 | 3 hours | 08-02 **20:00** |
| 08-02 22:48 | 2 hours | 08-03 **01:00** |
| 08-10 00:28 | 3 hours | 08-10 **04:00** |
| 08-25 18:00 | 5 hours | 08-25 **23:00** |

### 规律

- 重置点**全部是整点**：`04:00 / 09:00 / 20:00 / 01:00 / 04:00`
- 相邻重置点相差 **5 小时整**
- 5h 是**滚动窗口**，从某整点起算，每 5h 推进，重置点必然落在整点
- **整点网格相位不固定**（不同活动期相位不同），但窗口内部保持整点

### 锚点算法

```js
if (!sAnchor || sessionReset) {
  sAnchor = (sAnchor || now) + SESSION_ANCHOR_MS; // 沿用旧整点锚点 + 5h
  while (sAnchor <= now) sAnchor += SESSION_ANCHOR_MS;
  store.set('sessionAnchorMs', sAnchor);
}
```

- 窗口重置检测：`usage` 相对上次大幅下降（>50%）
- **校准记录**：2026-08-25 实测重置点北京 18:00（相位 ≡ 03:00 mod 5h），种子 `SESSION_ANCHOR_SEED = 2026-08-25T10:00Z`

---

## 二、周额度（Weekly limit）

### 实测观测

| 观察时间(北京) | resets in | 实际重置点 |
|---------------|----------|-----------|
| 07-27 03:56 | 4 hours | 07-27 07:56 |
| 07-27 04:00 | 4 hours | 07-27 08:00 |
| 08-02 16:31 | 15 hours | 08-03 07:31 |
| 08-10 00:28 | 8 hours | 08-10 08:28 |

三个重置日 `07-27` / `08-03` / `08-10` **都是星期一**，重置时刻≈**北京 08:00 = UTC 00:00**。

### 规律

- **每周一 00:00 UTC（北京 08:00）固定重置**，每 7 天一次
- `resets in` 取整到小时，反推时刻在 07:31~08:28 波动，真实值即周一 08:00 北京

### 锚点算法

```js
function nextMondayUtcReset(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const utcDay = d.getUTCDay();
  const daysToMon = (8 - utcDay) % 7;
  const thisMonUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let anchor = thisMonUtc + daysToMon * 86400000;
  if (anchor <= nowMs) anchor += 7 * 86400000;
  return anchor;
}
```

---

## 三、与官方文档印证

多个来源确认 Ollama Cloud 限制为两条滚动周期：
> *"Every plan has two rolling limits: a session limit that resets every 5 hours and a weekly limit that resets every 7 days."*

实测进一步细化：5h 整点滚动；7d **固定周一 00:00 UTC**。

## 四、实现要点（main.js `applyFixedResetAnchor`）

- 优先采用 API 返回的 `resets_at`（`resetSource === 'api'`），锚点不再用于此场景
- 无 `resets_at` 时回退：锚点持久化到 electron-store（`sessionAnchorMs` / `weeklyAnchorMs`）
- 窗口重置靠 `usage` 大幅下降（>50%）检测（仅兜底路径）
- 5h 用「旧锚点+5h」保持整点；weekly 用 `nextMondayUtcReset()` 固定周一

## 五、参考

- `lib/quota.js`：`normalizeBalance`（新）/ `normalizeQuota`（旧结构兜底）
- `main.js`：`applyFixedResetAnchor` + `nextMondayUtcReset`
- `renderer/popup.js`：`startTick()` 每秒按 `reset_at` 递减显示
