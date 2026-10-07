// popup-shot.js —— 一次性 UI 冒烟测试：以假数据渲染 popup.html，dump 可见文本并截图（不属于产品代码）
// 用法：npx electron scripts/popup-shot.js [mode]   mode = session-weekly（默认）| credit | error
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const mode = process.argv[2] || 'session-weekly';
const sample = {
  'session-weekly': {
    plan: null, status: 'ok', source: 'balance', mode: 'session-weekly',
    five_hour: { used_pct: 69, reset_at: '2026-10-07T13:00:00Z', resetSource: 'api' },
    weekly: { used_pct: 32, reset_at: '2026-10-12T00:00:00Z', resetSource: 'api' },
    monthly: null, cost: null, periodType: null, requests24h: 4261,
    updated_at: new Date().toISOString(),
  },
  credit: {
    plan: null, status: 'ok', source: 'balance', mode: 'credit',
    five_hour: { used_pct: 75, reset_at: '2026-11-01T00:00:00Z', resetSource: 'api' },
    weekly: { used_pct: 75, reset_at: '2026-11-01T00:00:00Z', resetSource: 'api' },
    monthly: { used_pct: 75, reset_at: '2026-11-01T00:00:00Z', resetSource: 'api', balance_usd: 12.5, allowance_usd: 50, purchased_usd: 3.25 },
    cost: null, periodType: null, requests24h: 128,
    updated_at: new Date().toISOString(),
  },
  error: null,
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 360, height: 456, show: false, frame: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'popup-shot-preload.js'),
      contextIsolation: true,
      additionalArguments: [`--shot-mode=${mode}`, `--shot-data=${encodeURIComponent(JSON.stringify(sample[mode]))}`],
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'popup.html'));
  await new Promise((r) => setTimeout(r, 1400)); // 等数字动画结束

  const txt = await win.webContents.executeJavaScript(
    `document.body.innerText.replace(/\\s+/g,' ').trim()`
  );
  console.log(`[text ${mode}] ${txt}`);

  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', `popup-shot-${mode}.png`);
  fs.writeFileSync(out, img.toPNG());
  console.log('shot written:', out);
  app.quit();
});
