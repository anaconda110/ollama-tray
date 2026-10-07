const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, safeStorage, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { fetchQuota, setSecureKey, getApiKey, initStore, setFetchImpl } = require('./lib/quota');
const newapi = require('./lib/newapi');
const { computeCost } = require('./lib/cost');

// 用 Chromium 网络栈替换 Node 全局 fetch：本机 Kaspersky TLS 拦截会让 Node 的 undici
// fetch 对 api.ollama.com 间歇性抛 SELF_SIGNED_CERT_IN_CHAIN；net.fetch 走系统信任链，
// 实测同机 10/10 成功。绑到全局以避免各处传递。在 app ready 之前调用也可用。
setFetchImpl((...args) => net.fetch(...args));

const store = new Store({
  name: 'ollama-tray-config',
  schema: {
    apiKey: {
      type: 'string',
      default: '',
    },
    lang: {
      type: 'string',
      default: '',
    },
    refreshInterval: {
      type: 'number',
      default: 60,
      minimum: 10,
    },
    popupRefreshStaleSec: {
      type: 'number',
      default: 30,
      minimum: 5,
    },
    /** 5h 会话窗口重置锚点（ms 时间戳）；0=未锚定 */
    sessionAnchorMs: {
      type: 'number',
      default: 0,
    },
    /** 7d 每周窗口重置锚点（ms 时间戳）；0=未锚定 */
    weeklyAnchorMs: {
      type: 'number',
      default: 0,
    },
    /** NewAPI 凭证 + 地址（可选，用于获取按模型消耗明细） */
    newapiBaseUrl: { type: 'string', default: '' },
    newapiUsername: { type: 'string', default: '' },
    newapiPassword: { type: 'string', default: '' },
    /** 上次 Ollama usage 采样（用于计算 5h/周额度变化与成本分摊） */
    lastQuotaSnapshot: { type: 'object', default: {} },
  },
});

initStore(store, safeStorage);

// ─── NewAPI 密码安全存取（同 API Key：safeStorage 加密）────────────────
function setNewapiPassword(raw) {
  if (!raw || !safeStorage || !safeStorage.isEncryptionAvailable()) {
    store.set('newapiPassword', raw || '');
    return;
  }
  store.set('newapiPassword', safeStorage.encryptString(raw).toString('base64'));
}
function getNewapiPassword() {
  const raw = store.get('newapiPassword') || '';
  if (!raw) return '';
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return raw;
  try { return safeStorage.decryptString(Buffer.from(raw, 'base64')); } catch { return ''; }
}
const newapiConfig = () => ({
  baseUrl: store.get('newapiBaseUrl') || '',
  username: store.get('newapiUsername') || '',
  password: getNewapiPassword(),
  hasCreds: !!(store.get('newapiBaseUrl') && store.get('newapiUsername') && getNewapiPassword()),
});

let tray = null;
let popupWindow = null;
let settingsWindow = null;
let isPopupVisible = false;
let hideTimer = null;
let currentQuota = null;
let lastFetchedAt = 0;
let refreshTimer = null;
// 失败指数退避：断网 / 限流时避免狂刷（30s→1m→2m→4m→8m→10m 封顶）
let failCount = 0;
let nextRetryAt = 0;
let isRefreshing = false;
const OLLAMA_KEYS_URL = 'https://ollama.com/settings/keys';

// ─── 固定锚点（滚动窗口 5h / 7d）────────────────────────
// 5h 会话：整点滚动窗口。实测验证：最近一次 Ollama 显示「北京14:13 → 重置15:00」，
// 即下一个重置点为「北京整点网格」（每 5h 一个整点），故用北京时区(+8)网格。
// 倒计时 = 距下一个北京整点网格点，恒 <= 5h。
// 周额度：每周一 00:00 UTC（北京 08:00）固定重置。
const FIVE_H = 5 * 60 * 60 * 1000;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000; // UTC+8
let lastWeeklyPct = null;
let lastSessionPct = null;

// 5h 会话锚点：滚动窗口，相位随活动期不同。用持久化锚点 +5h 推进，保持相位。
// 校准种子：最近实测重置 = 北京 18:00（2026-08-25 18:00 = 2026-08-25 10:00 UTC）。
const SESSION_ANCHOR_SEED = Date.UTC(2026, 7, 25, 10, 0, 0); // 月 0-based：7=8 月

function nextMondayUtcReset(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const utcDay = d.getUTCDay(); // 0=Sun .. 1=Mon .. 6=Sat
  const daysToMon = (8 - utcDay) % 7;
  const todayUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let anchor = todayUtcMidnight + daysToMon * 86400000;
  if (anchor <= nowMs) anchor += 7 * 86400000;
  return anchor;
}

function applyFixedResetAnchor(quota) {
  const now = Date.now();
  const sPct = quota.five_hour.used_pct;
  const wPct = quota.weekly.used_pct;

  // 2026-10-07 起 /api/balance 直接返回权威 resets_at：有则优先采用，不再自行推算锚点
  const sApiReset = quota.five_hour.resetSource === 'api' && quota.five_hour.reset_at
    ? new Date(quota.five_hour.reset_at).getTime() : 0;
  const wApiReset = quota.weekly.resetSource === 'api' && quota.weekly.reset_at
    ? new Date(quota.weekly.reset_at).getTime() : 0;

  // 5h：持久化整点锚点 +5h 滚动，保持相位；usage 大幅下降（>50%）= 窗口重置，沿用旧相位 +5h
  let sAnchor = store.get('sessionAnchorMs');
  const sessionReset = lastSessionPct !== null && sPct < lastSessionPct * 0.5;
  if (sApiReset > 0) {
    sAnchor = sApiReset;
    store.set('sessionAnchorMs', sAnchor);
  } else {
    if (!sAnchor || sAnchor <= now || sessionReset) {
      let base = sAnchor && (now - sAnchor) <= 7 * 24 * 3_600_000 ? sAnchor : SESSION_ANCHOR_SEED;
      let ref = base;
      while (ref <= now) ref += FIVE_H;
      sAnchor = ref;
      store.set('sessionAnchorMs', sAnchor);
    }
  }
  lastSessionPct = sPct;

  // 周额度：固定周一 00:00 UTC；窗口重置或锚点已过期时重新锚定
  let wAnchor = store.get('weeklyAnchorMs');
  const weeklyReset = lastWeeklyPct !== null && wPct < lastWeeklyPct * 0.5;
  if (wApiReset > 0) {
    wAnchor = wApiReset;
    store.set('weeklyAnchorMs', wAnchor);
  } else if (!wAnchor || wAnchor <= now || weeklyReset) {
    wAnchor = nextMondayUtcReset();
    store.set('weeklyAnchorMs', wAnchor);
  }
  lastWeeklyPct = wPct;

  quota.five_hour.reset_at = new Date(sAnchor).toISOString();
  quota.weekly.reset_at = new Date(wAnchor).toISOString();
}

// ─── 配额历史日志（JSONL 追加）─────────────────────────
const HISTORY_FILE = () => path.join(app.getPath('userData'), 'quota-history.jsonl');

// 简单运行日志（userData/app.log）
const LOG_FILE = () => path.join(app.getPath('userData'), 'app.log');
function log(msg) {
  try { fs.appendFileSync(LOG_FILE(), `[${new Date().toISOString()}] ${msg}\n`, 'utf8'); } catch {}
}

function appendHistory(quota) {
  try {
    const rec = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      session_usage: quota.five_hour.used_pct,
      weekly_usage: quota.weekly.used_pct,
      cost: quota.cost ?? null,
      period: quota.periodType ?? null,
      // 数据来源与模式（balance=新 /api/balance；usage=旧结构兜底；credit=USD 余额制）
      source: quota.source ?? null,
      mode: quota.mode ?? null,
      requests24h: quota.requests24h ?? null,
    };
    fs.appendFileSync(HISTORY_FILE(), JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    console.error('写入配额历史失败:', e);
  }
}

function openHistory() {
  const f = HISTORY_FILE();
  if (!fs.existsSync(f)) fs.writeFileSync(f, '', 'utf8');
  shell.openPath(f);
}

// ─── 多语言 ─────────────────────────────────────────────
const I18N = {
  zh: {
    tooltip: 'Ollama · 用量',
    refresh: '立即刷新',
    history: '打开历史数据',
    detail: '消耗明细（成本）',
    settings: '设置 API Key…',
    about: '关于',
    quit: '退出',
    statusOk: '正常',
    statusTight: '紧张',
    statusExhausted: '即将用尽',
    statusExpired: 'Key 无效或过期',
    statusFailed: '获取失败',
    statusIncomplete: '未配置 Key',
    label5h: '5h',
    labelWeekly: '每周',
    updated: '刚刚更新',
    openAtLogin: '开机启动',
  },
  en: {
    tooltip: 'Ollama · Usage',
    refresh: 'Refresh Now',
    history: 'Open history',
    detail: 'Cost Detail',
    settings: 'Set API Key…',
    about: 'About',
    quit: 'Quit',
    statusOk: 'Healthy',
    statusTight: 'Tight',
    statusExhausted: 'Almost exhausted',
    statusExpired: 'Key invalid/expired',
    statusFailed: 'Fetch failed',
    statusIncomplete: 'No key configured',
    label5h: '5h',
    labelWeekly: 'Weekly',
    updated: 'Updated just now',
    openAtLogin: 'Open at login',
  },
};

function getLang() {
  return store.get('lang') || (app.getLocale().startsWith('zh') ? 'zh' : 'en');
}
function t(key) {
  return (I18N[getLang()] || I18N.en)[key] || key;
}

// ─── 托盘图标（状态角标）────────────────────────────────
const TRAY_ICON_VARIANTS = {
  ok: 'tray-ok.png',
  warn: 'tray-warn.png',
  error: 'tray-error.png',
  idle: 'tray-idle.png',
};
function loadTrayIcon(variant) {
  const name = TRAY_ICON_VARIANTS[variant] || TRAY_ICON_VARIANTS.idle;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', name));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon;
}
function updateTrayIcon(quota, errCode) {
  if (!tray) return;
  let variant = 'idle';
  if (!errCode && quota && quota.weekly && typeof quota.weekly.used_pct === 'number') {
    const w = quota.weekly.used_pct;
    variant = w >= 90 ? 'error' : w >= 70 ? 'warn' : 'ok';
  }
  tray.setImage(loadTrayIcon(variant));
}

function createTray() {
  tray = new Tray(loadTrayIcon('idle'));

  const contextMenu = Menu.buildFromTemplate([
    { label: t('refresh'), click: () => refreshQuota(true) },
    { type: 'separator' },
    { label: t('history'), click: () => openHistory() },
    { label: t('detail'), click: () => openDetail() },
    { type: 'separator' },
    { label: t('settings'), click: () => openSettings() },
    {
      label: t('openAtLogin'),
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: t('about'), click: () => openAbout() },
    { type: 'separator' },
    { label: t('quit'), click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('mouse-enter', (_e, position) => {
    clearTimeout(hideTimer);
    showPopup(position);
  });
  tray.on('mouse-leave', () => {
    hideTimer = setTimeout(() => hidePopup(), 200);
  });
  tray.on('click', (_e, bounds) => {
    if (isPopupVisible) hidePopup();
    else showPopup(bounds);
  });
}

// ─── 弹出窗口 ──────────────────────────────────────────
function getPopupStaleMs() {
  return Math.max(5, store.get('popupRefreshStaleSec') || 30) * 1000;
}
function maybeRefreshOnPopupShow() {
  if (Date.now() - lastFetchedAt > getPopupStaleMs()) void refreshQuota();
}

function createPopupWindow() {
  popupWindow = new BrowserWindow({
    width: 360,
    height: 456,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  popupWindow.loadFile(path.join(__dirname, 'renderer', 'popup.html'));
  popupWindow.on('mouseleave', () => { hideTimer = setTimeout(() => hidePopup(), 200); });
  popupWindow.on('mouseenter', () => { clearTimeout(hideTimer); });
}

function showPopup(position) {
  if (!popupWindow || !tray) return;
  const [width, height] = popupWindow.getSize();
  const display = screen.getDisplayNearestPoint(position);
  let x = Math.round(position.x - width / 2);
  let y = Math.round(position.y - height - 8);
  const wa = display.workArea;
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - width - 8));
  if (y < wa.y + 8) y = position.y + 32;
  popupWindow.setPosition(x, y, false);
  popupWindow.showInactive();
  popupWindow.setAlwaysOnTop(true, 'floating');
  isPopupVisible = true;
  if (currentQuota) popupWindow.webContents.send('quota-update', currentQuota, getLang());
  maybeRefreshOnPopupShow();
}
function hidePopup() {
  if (!popupWindow) return;
  popupWindow.hide();
  isPopupVisible = false;
}

// ─── 设置窗口 ──────────────────────────────────────────
function openSettings() {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: true,
    minimizable: false,
    maximizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'ollama-icon.png')),
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
    settingsWindow.webContents.send('settings-init', {
      hasKey: !!getApiKey(),
      lang: getLang(),
    });
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ─── 关于窗口 ──────────────────────────────────────────
function openAbout() {
  const aboutWindow = new BrowserWindow({
    width: 420,
    height: 240,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'ollama-icon.png')),
  });
  aboutWindow.loadFile(path.join(__dirname, 'renderer', 'about.html'));
  // 版本号取自 package.json，避免 HTML 里硬编码过时
  aboutWindow.webContents.on('did-finish-load', () => {
    aboutWindow.webContents
      .executeJavaScript(`document.querySelector('.ver').textContent = 'v${app.getVersion()}'`)
      .catch(() => {});
  });
}

// ─── 消耗明细（独立详情窗口 + 历史落盘）─────────────────────
const DETAIL_HISTORY_FILE = () => path.join(app.getPath('userData'), 'cost-detail-history.jsonl');
let detailWindow = null;

// 把 NewAPI 明细 + 成本分摊写入历史（JSONL，供详情页趋势图用）
function appendDetailHistory(cost, logs, usageSnapshot) {
  try {
    const rec = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      summary: cost.total,
      usage: {
        fiveHour: usageSnapshot.five_hour.used_pct,
        weekly: usageSnapshot.weekly.used_pct,
      },
      models: cost.models.map((m) => ({
        model: m.model, calls: m.calls, tokens: m.tokens, weight: m.weight,
        relativeRatio: m.relativeRatio, shareFiveHour: m.shareFiveHour, shareWeekly: m.shareWeekly,
      })),
    };
    fs.appendFileSync(DETAIL_HISTORY_FILE(), JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) { log(`appendDetailHistory failed: ${e}`); }
}

// 聚合 NewAPI 明细 + 成本（供详情页与落盘共用）
async function collectCostDetail() {
  const cfg = newapiConfig();
  if (!cfg.hasCreds) throw new Error('NO_NEWAPI');
  newapi.setEndpoint(cfg.baseUrl);
  await newapi.login(cfg.username, cfg.password);
  const logs = await newapi.fetchCallLogs({ pageSize: 200, maxPages: 10 });
  const agg = newapi.aggregateByModel(logs);
  // 当前窗口消耗（含锚点 reset_at，用于跨重置 wrap-around）+ 上次采样
  const usageNow = {
    five_hour: currentQuota?.five_hour,
    weekly: currentQuota?.weekly,
  };
  const usagePrev = store.get('lastQuotaSnapshot');
  const cost = computeCost(agg, usageNow, usagePrev);
  return { cost, logs, agg };
}

async function refreshDetail(force) {
  try {
    const d = await collectCostDetail();
    if (!d) return { ok: false, code: 'NO_CONFIG' };
    appendDetailHistory(d.cost, d.logs, currentQuota);
    if (detailWindow && !detailWindow.isDestroyed()) {
      detailWindow.webContents.send('detail-update', d.cost, d.logs);
    }
    return { ok: true, cost: d.cost };
  } catch (e) {
    log(`detail refresh failed: ${e && e.message || e}`);
    return { ok: false, code: (e && e.message) || 'FAILED' };
  }
}

function openDetail() {
  if (detailWindow) { detailWindow.show(); detailWindow.focus(); void refreshDetail(true); return; }
  detailWindow = new BrowserWindow({
    width: 900,
    height: 640,
    resizable: true,
    minimizable: true,
    maximizable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'ollama-icon.png')),
  });
  detailWindow.loadFile(path.join(__dirname, 'renderer', 'detail.html'));
  detailWindow.once('ready-to-show', () => {
    detailWindow.show();
    void refreshDetail(true);
  });
  detailWindow.on('closed', () => { detailWindow = null; });
}

// ─── 刷新配额 ──────────────────────────────────────────
async function refreshQuota(force) {
  if (isRefreshing) return; // 并发守卫：避免定时器 + 手动刷新同时抓取
  // 失败退避中：非强制(手动)刷新则跳过，防止断网/限流时狂刷
  if (!force && Date.now() < nextRetryAt) return;

  isRefreshing = true;
  if (popupWindow && isPopupVisible) {
    popupWindow.webContents.send('quota-refreshing', getLang());
  }
  try {
    currentQuota = await fetchQuota();
    lastFetchedAt = Date.now();
    failCount = 0;
    nextRetryAt = 0;
    applyFixedResetAnchor(currentQuota);
    // 记录 usage 快照（供成本 Δ 计算）；带 ts
    store.set('lastQuotaSnapshot', {
      five_hour: currentQuota.five_hour,
      weekly: currentQuota.weekly,
      ts: Date.now(),
    });
    updateTrayIcon(currentQuota);
    appendHistory(currentQuota);
    if (popupWindow && isPopupVisible) {
      popupWindow.webContents.send('quota-update', currentQuota, getLang());
    }
  } catch (e) {
    console.error('刷新配额失败:', e);
    const code = e.message;
    // 指数退避：30s 起，每次 ×2，封顶 10 分钟
    failCount += 1;
    const delay = Math.min(30_000 * Math.pow(2, failCount - 1), 600_000);
    nextRetryAt = Date.now() + delay;
    log(`refresh failed code=${code} retryIn=${(delay / 1000).toFixed(0)}s err=${String(e && e.message || e)}`);
    updateTrayIcon(null, code);
    if (popupWindow && isPopupVisible) {
      popupWindow.webContents.send('quota-error', code, getLang());
    }
  } finally {
    isRefreshing = false;
  }
}

// ─── IPC ───────────────────────────────────────────────
ipcMain.handle('quota:refresh', async () => {
  await refreshQuota(true); // 用户主动刷新：强制，跳过退避
  return currentQuota;
});
ipcMain.handle('settings:saveKey', async (_e, key) => {
  setSecureKey(String(key || '').trim());
  await refreshQuota(true);
  return { ok: true };
});
ipcMain.handle('settings:clearKey', async () => {
  setSecureKey('');
  currentQuota = null;
  return { ok: true };
});
ipcMain.handle('settings:hasKey', async () => ({ hasKey: !!getApiKey() }));
ipcMain.handle('settings:setLang', async (_e, lang) => {
  store.set('lang', lang === 'zh' ? 'zh' : 'en');
  return { ok: true, lang: getLang() };
});
ipcMain.handle('settings:openKeysPage', async () => {
  await shell.openExternal(OLLAMA_KEYS_URL);
  return { ok: true };
});
ipcMain.handle('app:getLang', () => getLang());

// ─── NewAPI 凭证 + 消耗明细 IPC ───────────────────────────
ipcMain.handle('newapi:saveConfig', async (_e, { baseUrl, username, password }) => {
  store.set('newapiBaseUrl', String(baseUrl || '').trim());
  store.set('newapiUsername', String(username || '').trim());
  setNewapiPassword(String(password || ''));
  return { ok: true, config: newapiConfig() };
});
ipcMain.handle('newapi:clearConfig', async () => {
  store.set('newapiBaseUrl', '');
  store.set('newapiUsername', '');
  store.set('newapiPassword', '');
  return { ok: true, config: newapiConfig() };
});
ipcMain.handle('newapi:config', async () => ({ config: newapiConfig() }));
ipcMain.handle('detail:refresh', async () => refreshDetail(true));
ipcMain.handle('detail:open', async () => { openDetail(); return { ok: true }; });
ipcMain.handle('detail:openHistory', async () => {
  const f = DETAIL_HISTORY_FILE();
  if (!fs.existsSync(f)) fs.writeFileSync(f, '', 'utf8');
  shell.openPath(f);
  return { ok: true };
});

// ─── 生命周期 ──────────────────────────────────────────
// 单实例锁：避免重复打开多个托盘图标
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (popupWindow && !popupWindow.isDestroyed()) popupWindow.show();
  });
  app.whenReady().then(() => {
    createTray();
    createPopupWindow();
    refreshQuota();
    const interval = Math.max(10, store.get('refreshInterval') || 60) * 1000;
    refreshTimer = setInterval(refreshQuota, interval);
    // 消耗明细后台定时抓取（若配置了 NewAPI）：独立慢速周期（5 分钟）
    setInterval(() => {
      const cfg = newapiConfig();
      if (cfg.hasCreds) void refreshDetail(false);
    }, 5 * 60 * 1000);
  });
}

app.on('window-all-closed', () => {
  // 托盘常驻应用：窗口关闭不退出（由托盘菜单「退出」结束进程）
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createPopupWindow();
});

if (process.platform === 'darwin') app.dock.hide();
