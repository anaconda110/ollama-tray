// popup-shot-preload.js —— 仅用于 UI 冒烟截图：伪造 window.api，避免依赖主进程 IPC（非产品代码）
const { contextBridge } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--shot-mode='));
const mode = arg ? arg.split('=')[1] : 'session-weekly';
const dataArg = process.argv.find((a) => a.startsWith('--shot-data='));
const data = dataArg ? JSON.parse(decodeURIComponent(dataArg.split('=')[1])) : null;

contextBridge.exposeInMainWorld('api', {
  onQuotaUpdate: () => {},
  onQuotaError: () => {},
  onQuotaRefreshing: () => {},
  getLang: async () => 'zh',
  refresh: async () => data,
  saveKey: async () => ({ ok: true }),
  clearKey: async () => ({ ok: true }),
  hasKey: async () => true,
  setLang: async (l) => ({ ok: true, lang: l }),
  openKeysPage: async () => ({ ok: true }),
});
