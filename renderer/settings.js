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

init();
