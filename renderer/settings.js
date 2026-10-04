const I18N = {
  zh: {
    settingsTitle: '设置 API Key',
    settingsSubtitle: '用于安全获取 Ollama Cloud 账号的用量配额',
    keyLabel: '粘贴 Ollama Cloud API Key',
    keyHint: 'Key 仅保存在本机安全存储中（Electron safeStorage 加密），不会上传。未设置时会自动读取本机 Maka 凭据库中的 Ollama Cloud key。',
    openSite: '打开 API Keys 页面',
    siteOpened: '已在浏览器打开 ollama.com/settings/keys',
    save: '保存并刷新',
    clear: '清除',
    saved: '已保存，正在刷新…',
    cleared: '已清除 Key',
    needKey: '请先粘贴 API Key',
    newapiTitle: 'NewAPI 消耗明细（可选）',
    newapiUrl: 'NewAPI 地址',
    newapiUser: '管理员账号',
    newapiPass: '管理员密码',
    newapiHint: '用于从 NewAPI 日志拉取按模型的实际 token/调用次数明细，进而按 Ollama Usage Level 权重估算额度成本。凭证仅存本机加密存储。NewAPI 价格不作参考。',
    newapiSave: '保存 NewAPI 配置',
    newapiClear: '清除',
    newapiSaved: 'NewAPI 配置已保存',
    newapiCleared: 'NewAPI 配置已清除',
  },
  en: {
    settingsTitle: 'Set API Key',
    settingsSubtitle: 'Used to securely fetch your Ollama Cloud usage quota',
    keyLabel: 'Paste Ollama Cloud API Key',
    keyHint: 'Key is stored locally in encrypted storage (Electron safeStorage) and never uploaded. If unset, the Ollama Cloud key in the local Maka credential vault is used automatically.',
    openSite: 'Open API Keys page',
    siteOpened: 'Opened ollama.com/settings/keys in browser',
    save: 'Save & Refresh',
    clear: 'Clear',
    saved: 'Saved, refreshing…',
    cleared: 'Key cleared',
    needKey: 'Please paste an API key first',
    newapiTitle: 'NewAPI Cost Detail (optional)',
    newapiUrl: 'NewAPI base URL',
    newapiUser: 'Admin username',
    newapiPass: 'Admin password',
    newapiHint: 'Pulls per-model token/call counts from NewAPI logs, then estimates cost via Ollama Usage Level weights. Credentials stored locally (encrypted). NewAPI pricing is not used.',
    newapiSave: 'Save NewAPI config',
    newapiClear: 'Clear',
    newapiSaved: 'NewAPI config saved',
    newapiCleared: 'NewAPI config cleared',
  },
};

let currentLang = 'zh';

function setLang(lang) {
  currentLang = lang === 'zh' ? 'zh' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (I18N[currentLang][key]) el.textContent = I18N[currentLang][key];
  });
  document.getElementById('langZh').classList.toggle('active', currentLang === 'zh');
  document.getElementById('langEn').classList.toggle('active', currentLang === 'en');
}

function showStatus(text, type) {
  const msg = document.getElementById('statusMsg');
  msg.textContent = text;
  msg.className = 'status-msg ' + (type || '');
  setTimeout(() => { msg.textContent = ''; msg.className = 'status-msg'; }, 3000);
}

async function init() {
  const lang = await window.api.getLang();
  setLang(lang);
  const initData = await new Promise((resolve) => {
    window.api.onSettingsInit((data) => resolve(data));
    setTimeout(async () => {
      if (!resolve._called) {
        const r = await window.api.hasKey();
        resolve(r);
      }
    }, 50);
  });
  if (initData.hasKey) {
    const savedText = currentLang === 'zh' ? '（已配置 Key，粘贴可覆盖）' : '(Key configured; paste to override)';
    document.getElementById('keyInput').placeholder = savedText;
  }
}

document.getElementById('openSiteBtn').addEventListener('click', async () => {
  await window.api.openKeysPage();
  showStatus(I18N[currentLang].siteOpened, 'ok');
});
document.getElementById('saveBtn').addEventListener('click', async () => {
  const key = document.getElementById('keyInput').value.trim();
  if (!key) { showStatus(I18N[currentLang].needKey, 'error'); return; }
  showStatus(I18N[currentLang].saved, 'ok');
  const result = await window.api.saveKey(key);
  showStatus(result.ok ? 'OK' : 'Failed', result.ok ? 'ok' : 'error');
});
document.getElementById('clearBtn').addEventListener('click', async () => {
  document.getElementById('keyInput').value = '';
  await window.api.clearKey();
  showStatus(I18N[currentLang].cleared, 'ok');
});
document.getElementById('langZh').addEventListener('click', async () => { await window.api.setLang('zh'); setLang('zh'); });
document.getElementById('langEn').addEventListener('click', async () => { await window.api.setLang('en'); setLang('en'); });

// ─── NewAPI 配置 ───
async function loadNewapiConfig() {
  const r = await window.api.newapiConfig();
  const cfg = r?.config || {};
  if (cfg.baseUrl) document.getElementById('newapiUrlInput').value = cfg.baseUrl;
  if (cfg.username) document.getElementById('newapiUserInput').value = cfg.username;
  if (cfg.hasCreds) document.getElementById('newapiPassInput').placeholder = '（已保存，留空保持不变）';
}
document.getElementById('newapiSaveBtn').addEventListener('click', async () => {
  const baseUrl = document.getElementById('newapiUrlInput').value.trim();
  const username = document.getElementById('newapiUserInput').value.trim();
  const password = document.getElementById('newapiPassInput').value;
  if (!baseUrl || !username || !password) { showStatus(I18N[currentLang].needKey, 'error'); return; }
  const r = await window.api.newapiSaveConfig({ baseUrl, username, password });
  showStatus(r?.ok ? I18N[currentLang].newapiSaved : 'Failed', r?.ok ? 'ok' : 'error');
});
document.getElementById('newapiClearBtn').addEventListener('click', async () => {
  document.getElementById('newapiUrlInput').value = '';
  document.getElementById('newapiUserInput').value = '';
  document.getElementById('newapiPassInput').value = '';
  await window.api.newapiClearConfig();
  showStatus(I18N[currentLang].newapiCleared, 'ok');
});

init();
loadNewapiConfig();
