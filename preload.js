const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onQuotaUpdate: (callback) => ipcRenderer.on('quota-update', (_e, data, lang) => callback(data, lang)),
  onQuotaError: (callback) => ipcRenderer.on('quota-error', (_e, code, lang) => callback(code, lang)),
  onQuotaRefreshing: (callback) => ipcRenderer.on('quota-refreshing', (_e, lang) => callback(lang)),
  onSettingsInit: (callback) => ipcRenderer.on('settings-init', (_e, data) => callback(data)),
  onDetailUpdate: (callback) => ipcRenderer.on('detail-update', (_e, cost, logs) => callback(cost, logs)),
  refresh: () => ipcRenderer.invoke('quota:refresh'),
  saveKey: (key) => ipcRenderer.invoke('settings:saveKey', key),
  clearKey: () => ipcRenderer.invoke('settings:clearKey'),
  hasKey: () => ipcRenderer.invoke('settings:hasKey'),
  openKeysPage: () => ipcRenderer.invoke('settings:openKeysPage'),
  getLang: () => ipcRenderer.invoke('app:getLang'),
  setLang: (lang) => ipcRenderer.invoke('settings:setLang', lang),
  // 消耗明细
  detailRefresh: () => ipcRenderer.invoke('detail:refresh'),
  detailOpenHistory: () => ipcRenderer.invoke('detail:openHistory'),
  newapiSaveConfig: (cfg) => ipcRenderer.invoke('newapi:saveConfig', cfg),
  newapiClearConfig: () => ipcRenderer.invoke('newapi:clearConfig'),
  newapiConfig: () => ipcRenderer.invoke('newapi:config'),
});
