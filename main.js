const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { fetchQuota, setSecureKey, getApiKey, initStore } = require('./lib/quota');

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
  },
});

initStore(store, safeStorage);

let tray = null;
let popupWindow = null;
let settingsWindow = null;
let isPopupVisible = false;
let hideTimer = null;
let currentQuota = null;
let lastFetchedAt = 0;
let refreshTimer = null;
const OLLAMA_KEYS_URL = 'https://ollama.com/settings/keys';

// ─── 固定锚点（滚动窗口 5h / 7d）────────────────────────
// 5h 会话：整点滚动窗口，每 5h 一个重置点（网格步长 5h，相位 UTC 16:00）。
//   倒计时 = 距下一个网格整点，恒 <= 5h（不再漂移到未来）。
// 周额度：每周一 00:00 UTC（北京 08:00）固定重置。
const FIVE_H = 5 * 60 * 60 * 1000;
const PHASE_UTC_HOUR = 16; // 用户实测锚点 8/22 16:00 UTC 的相位
let lastWeeklyPct = null;

/** 下一个 5h 整点网格重置时刻（5h 步长，相位 PHASE_UTC_HOUR）。倒计时恒 <= 5h。 */
function nextFiveHGridReset(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let ref = dayStart + PHASE_UTC_HOUR * 3600000; // 当天相位整点
  while (ref > nowMs) ref -= FIVE_H; // 回退到 now 之前最近的网格点
  while (ref <= nowMs) ref += FIVE_H; // 推进到 now 之后最近的网格点
  return ref;
}

function nextMondayUtcReset(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const utcDay = d.getUTCDay(); // 0=Sun .. 1=Mon .. 6=Sat
  const daysToMon = (8 - utcDay) % 7;
  const thisMonUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let anchor = thisMonUtc + daysToMon * 86400000;
  if (anchor <= nowMs) anchor += 7 * 86400000;
  return anchor;
}

function applyFixedResetAnchor(quota) {
  const now = Date.now();
  const wPct = quota.weekly.used_pct;

  // 5h：确定性整点网格，倒计时恒 <= 5h
  const sAnchor = nextFiveHGridReset(now);

  // 周额度：固定周一 00:00 UTC（窗口重置由 usage 突降检测触发重锚）
  let wAnchor = store.get('weeklyAnchorMs');
  const weeklyReset = lastWeeklyPct !== null && wPct < lastWeeklyPct * 0.5;
  if (!wAnchor || weeklyReset) {
    wAnchor = nextMondayUtcReset();
    store.set('weeklyAnchorMs', wAnchor);
  }
  lastWeeklyPct = wPct;

  quota.five_hour.reset_at = new Date(sAnchor).toISOString();
  quota.weekly.reset_at = new Date(wAnchor).toISOString();
}

// ─── 配额历史日志（JSONL 追加）─────────────────────────
const HISTORY_FILE = () => path.join(app.getPath('userData'), 'quota-history.jsonl');

function appendHistory(quota) {
  try {
    const rec = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      session_usage: quota.five_hour.used_pct,
      weekly_usage: quota.weekly.used_pct,
      cost: quota.cost ?? null,
      period: quota.periodType ?? null,
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
  tray.setToolTip(t('tooltip'));

  const contextMenu = Menu.buildFromTemplate([
    { label: t('refresh'), click: () => refreshQuota() },
    { type: 'separator' },
    { label: t('history'), click: () => openHistory() },
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
    width: 480,
    height: 420,
    resizable: false,
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
}

// ─── 刷新配额 ──────────────────────────────────────────
async function refreshQuota() {
  if (popupWindow && isPopupVisible) {
    popupWindow.webContents.send('quota-refreshing', getLang());
  }
  try {
    currentQuota = await fetchQuota();
    lastFetchedAt = Date.now();
    applyFixedResetAnchor(currentQuota);
    updateTrayIcon(currentQuota);
    appendHistory(currentQuota);
    const tt = `${t('tooltip')}\n${t('label5h')}: ${currentQuota.five_hour.used_pct}%\n${t('labelWeekly')}: ${currentQuota.weekly.used_pct}%`;
    tray.setToolTip(tt);
    if (popupWindow && isPopupVisible) {
      popupWindow.webContents.send('quota-update', currentQuota, getLang());
    }
  } catch (e) {
    console.error('刷新配额失败:', e);
    const code = e.message;
    updateTrayIcon(null, code);
    if (code === 'NO_KEY') tray.setToolTip(t('statusIncomplete'));
    else if (code === 'KEY_INVALID') tray.setToolTip(t('statusExpired'));
    else tray.setToolTip(t('statusFailed'));
    if (popupWindow && isPopupVisible) {
      popupWindow.webContents.send('quota-error', code, getLang());
    }
  }
}

// ─── IPC ───────────────────────────────────────────────
ipcMain.handle('quota:refresh', async () => {
  await refreshQuota();
  return currentQuota;
});
ipcMain.handle('settings:saveKey', async (_e, key) => {
  setSecureKey(String(key || '').trim());
  await refreshQuota();
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

// ─── 生命周期 ──────────────────────────────────────────
app.whenReady().then(() => {
  createTray();
  createPopupWindow();
  refreshQuota();
  const interval = Math.max(10, store.get('refreshInterval') || 60) * 1000;
  refreshTimer = setInterval(refreshQuota, interval);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createPopupWindow();
});

if (process.platform === 'darwin') app.dock.hide();
