const $ = (id) => document.getElementById(id);

let tickInterval = null;
let quotaData = null;
let currentLang = 'zh';

const I18N = {
  zh: {
    title: 'Ollama',
    subtitle: 'Cloud 配额',
    statusOk: '正常',
    statusTight: '紧张',
    statusExhausted: '即将用尽',
    statusExpired: 'Key 无效或过期',
    statusFailed: '获取失败',
    statusIncomplete: '未配置 Key',
    statusNoKey: '未设置 API Key',
    heroLabel: '5h 已用 ·',
    heroLabelPlanless: '5h 已用',
    label5h: '5h',
    labelWeekly: '每周',
    resetSuffix: '后重置',
    updated: '刚刚更新',
    refreshing: '正在刷新…',
    resetNow: '已可重置',
    minuteAgo: '分钟前更新',
    needKey: '请设置 API Key',
    req24h: '24h 请求',
    balance: '余额',
    monthlyLabel: '本期',
    monthlyUsed: '本期已用',
    remainLabel: '剩余',
    resetOn: '重置',
  },
  en: {
    title: 'Ollama',
    subtitle: 'Cloud quota',
    statusOk: 'Healthy',
    statusTight: 'Tight',
    statusExhausted: 'Almost exhausted',
    statusExpired: 'Key invalid/expired',
    statusFailed: 'Fetch failed',
    statusIncomplete: 'No key configured',
    statusNoKey: 'No API key set',
    heroLabel: '5h used ·',
    heroLabelPlanless: '5h used',
    label5h: '5h',
    labelWeekly: 'Weekly',
    resetSuffix: 'until reset',
    updated: 'Updated just now',
    refreshing: 'Refreshing…',
    resetNow: 'Reset now',
    minuteAgo: 'Updated {m} min ago',
    needKey: 'Please set an API key',
    req24h: '24h requests',
    balance: 'Balance',
    monthlyLabel: 'Period',
    monthlyUsed: 'Period used',
    remainLabel: 'Remaining',
    resetOn: 'Resets',
  },
};

function setLang(lang) {
  currentLang = lang === 'zh' ? 'zh' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (I18N[currentLang][key]) el.textContent = I18N[currentLang][key];
  });
}

// ─── 倒计时格式化（d h m，无空格）───────────────────────
function fmtRemain(ms) {
  if (ms <= 0) return I18N[currentLang].resetNow;
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d >= 1) return `${d}d${h}h${m}m`;
  if (h >= 1) return `${h}h${m}m`;
  return `${m}m`;
}

// ─── 状态徽章 ───────────────────────────────────────────
function setStatus(weekPct, status, code) {
  const badge = $('statusBadge');
  const text = $('statusText');
  badge.classList.remove('warn', 'error');

  if (code === 'NO_KEY' || code === 'KEY_INVALID') {
    badge.classList.add(code === 'KEY_INVALID' ? 'error' : 'warn');
    text.textContent = code === 'KEY_INVALID'
      ? I18N[currentLang].statusExpired
      : I18N[currentLang].statusNoKey;
    return;
  }
  if (status === 'error' || code) {
    badge.classList.add('error');
    text.textContent = I18N[currentLang].statusFailed;
    return;
  }
  if (weekPct >= 90) { badge.classList.add('warn'); text.textContent = I18N[currentLang].statusExhausted; }
  else if (weekPct >= 70) { badge.classList.add('warn'); text.textContent = I18N[currentLang].statusTight; }
  else text.textContent = I18N[currentLang].statusOk;
}

// ─── 数字滚动动画 ───────────────────────────────────────
function animateNumber(el, target) {
  const start = parseInt(el.textContent) || 0;
  if (start === target) return;
  const duration = 600;
  const startTime = performance.now();
  function step(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(start + (target - start) * eased);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
  el.classList.add('bump');
  setTimeout(() => el.classList.remove('bump'), 300);
}

// ─── 渲染数据 ──────────────────────────────────────────
function render(d, lang) {
  quotaData = d;
  if (lang) setLang(lang);

  // credit 计划（USD 余额制）：无 5h/周窗口，改展示「本期已用 + USD 余额」
  const credit = d.mode === 'credit' && !!d.monthly;
  if (credit) {
    const used = d.monthly.used_pct;
    const bal = d.monthly.balance_usd;
    const allow = d.monthly.allowance_usd;
    animateNumber($('heroNum'), used);
    $('planLabel').textContent = '';
    $('planLabel').style.display = 'none';
    $('heroLabel').textContent = I18N[currentLang].monthlyUsed;

    $('label5h').textContent = I18N[currentLang].monthlyUsed;
    $('pct5h').textContent = used + '%';
    $('fill5h').style.width = used + '%';
    $('reset5h').textContent = d.monthly.reset_at
      ? `${I18N[currentLang].resetOn} ${fmtResetDate(d.monthly.reset_at)}` : '--';
    $('reset5hSuffix').textContent = '';

    $('labelWeekly').textContent = I18N[currentLang].remainLabel;
    $('pctWeek').textContent = bal != null && allow != null ? `$${bal.toFixed(2)} / $${allow.toFixed(2)}`
      : bal != null ? `$${bal.toFixed(2)}` : '';
    $('pctWeek').classList.remove('warn');
    $('fillWeek').style.width = allow > 0 && bal != null
      ? Math.min(100, Math.max(0, Math.round((bal / allow) * 100))) + '%' : '0%';
    $('resetWeek').parentElement.style.visibility = 'hidden';
  } else {
    const plan = (d.plan || '').trim();
    animateNumber($('heroNum'), d.five_hour.used_pct);
    $('planLabel').textContent = plan;
    $('planLabel').style.display = plan ? '' : 'none';
    $('heroLabel').textContent = plan ? I18N[currentLang].heroLabel : I18N[currentLang].heroLabelPlanless;

    $('label5h').textContent = I18N[currentLang].label5h;
    $('pct5h').textContent = d.five_hour.used_pct + '%';
    $('fill5h').style.width = d.five_hour.used_pct + '%';
    $('reset5hSuffix').textContent = I18N[currentLang].resetSuffix;

    $('labelWeekly').textContent = I18N[currentLang].labelWeekly;
    $('pctWeek').textContent = d.weekly.used_pct + '%';
    $('fillWeek').style.width = d.weekly.used_pct + '%';
    $('pctWeek').classList.toggle('warn', d.weekly.used_pct >= 70);
    $('resetWeek').parentElement.style.visibility = '';
  }

  setStatus(d.weekly.used_pct, d.status);

  const req = typeof d.requests24h === 'number' ? d.requests24h : null;
  $('req24h').textContent = req != null ? `${I18N[currentLang].req24h} ${req}` : '';

  const time = new Date(d.updated_at).toLocaleTimeString(currentLang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  $('updatedText').textContent = `${I18N[currentLang].updated} · ${time}`;

  startTick();
}

// 权威重置时间格式（credit 模式展示日期）
function fmtResetDate(iso) {
  if (!iso) return '--';
  return new Date(iso).toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

// ─── 渲染错误 ──────────────────────────────────────────
function renderError(code, lang) {
  if (lang) setLang(lang);
  setStatus(0, 'error', code);
  $('planLabel').textContent = '';
  $('planLabel').style.display = 'none';
  $('heroLabel').textContent = I18N[currentLang].heroLabelPlanless;
  // 还原标准标签（上一次成功渲染可能处于 credit 模式，改写过文案）
  $('label5h').textContent = I18N[currentLang].label5h;
  $('labelWeekly').textContent = I18N[currentLang].labelWeekly;
  $('reset5hSuffix').textContent = I18N[currentLang].resetSuffix;
  $('resetWeek').parentElement.style.visibility = '';
  if (code === 'NO_KEY') $('updatedText').textContent = I18N[currentLang].needKey;
  else if (code === 'KEY_INVALID') $('updatedText').textContent = I18N[currentLang].statusExpired;
  else $('updatedText').textContent = I18N[currentLang].statusFailed;
}

// ─── 倒计时每秒刷新 ────────────────────────────────────
function startTick() {
  clearInterval(tickInterval);
  // credit 模式显示的是绝对日期（非实时倒计时），无需每秒刷新
  if (quotaData && quotaData.mode === 'credit') return;
  tickInterval = setInterval(() => {
    if (!quotaData) return;
    $('reset5h').textContent = fmtRemain(new Date(quotaData.five_hour.reset_at) - Date.now());
    $('resetWeek').textContent = fmtRemain(new Date(quotaData.weekly.reset_at) - Date.now());
  }, 1000);
  if (quotaData) {
    $('reset5h').textContent = fmtRemain(new Date(quotaData.five_hour.reset_at) - Date.now());
    $('resetWeek').textContent = fmtRemain(new Date(quotaData.weekly.reset_at) - Date.now());
  }
}

// ─── 监听主进程推送 ─────────────────────────────────────
window.api.onQuotaUpdate((data, lang) => render(data, lang));
window.api.onQuotaError((code, lang) => renderError(code, lang));
window.api.onQuotaRefreshing((lang) => {
  if (lang) setLang(lang);
  $('updatedText').textContent = I18N[currentLang].refreshing;
});

// ─── 初始加载 ──────────────────────────────────────────
(async () => {
  try {
    const lang = await window.api.getLang();
    setLang(lang);
    const data = await window.api.refresh();
    if (data) render(data, lang);
    else renderError('NO_KEY'); // 无 key 时明确提示，避免空白弹窗
  } catch (e) {
    renderError('FAILED'); // 网络/其它错误，显示"获取失败"
  }
})();
