const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onQuotaUpdate: (callback) => ipcRenderer.on('quota-update', (_e, data, lang) => callback(data, lang)),
  onQuotaError: (callback) => ipcRenderer.on('quota-error', (_e, code, lang) => callback(code, lang)),
  onQuotaRefreshing: (callback) => ipcRenderer.on('quota-refreshing', (_e, lang) => callback(lang)),
  onSettingsInit: (callback) => ipcRenderer.on('settings-init', (_e, data) => callback(data)),
  refresh: () => ipcRenderer.invoke('quota:refresh'),
  saveKey: (key) => ipcRenderer.invoke('settings:saveKey', key),
  clearKey: () => ipcRenderer.invoke('settings:clearKey'),
  hasKey: () => ipcRenderer.invoke('settings:hasKey'),
  openKeysPage: () => ipcRenderer.invoke('settings:openKeysPage'),
  getLang: () => ipcRenderer.invoke('app:getLang'),
  setLang: (lang) => ipcRenderer.invoke('settings:setLang', lang),
});
