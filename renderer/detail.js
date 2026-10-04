// detail.js —— 消耗明细（成本）页渲染
const $ = (id) => document.getElementById(id);

let currentCost = null;
let currentModels = [];
let sortKey = 'relativeCost';
let sortAsc = false;

// ─── 状态徽章 ───
function setStatus(text, kind) {
  const badge = $('statusBadge');
  const txt = $('statusText');
  badge.classList.remove('warn', 'error');
  if (kind === 'warn') badge.classList.add('warn');
  if (kind === 'error') badge.classList.add('error');
  txt.textContent = text;
}

// ─── 数字格式化 ───
function fmtNum(n) {
  if (n == null || isNaN(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '–';
  return n.toFixed(2) + '%';
}

// ─── 渲染总览卡 ───
function renderSummary(total) {
  $('sumTokens').textContent = fmtNum(total.tokens);
  $('sumCalls').textContent = fmtNum(total.calls);
  $('sum5h').textContent = fmtPct(total.fiveHourUsed);
  $('sumWeek').textContent = fmtPct(total.weeklyUsed);
}

// ─── 渲染表格 ───
function renderTable(models) {
  const tbody = $('modelRows');
  tbody.innerHTML = '';
  for (const m of models) {
    const tr = document.createElement('tr');
    const share = m.relativeRatio || 0;
    tr.innerHTML = `
      <td class="model-cell">${escapeHtml(m.model)}</td>
      <td class="num">${fmtNum(m.calls)}</td>
      <td class="num">${fmtNum(m.prompt)}</td>
      <td class="num">${fmtNum(m.completion)}</td>
      <td class="num">${fmtNum(m.tokens)}</td>
      <td class="num">${m.weight ?? 1}×</td>
      <td class="num">${fmtNum(m.relativeCost)}</td>
      <td class="num">${m.relativeRatio}%</td>
      <td class="num">${fmtPct(m.shareFiveHour)}</td>
      <td class="num">${fmtPct(m.shareWeekly)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── 原生 Canvas 柱状图（各模型相对成本占比）───
function renderChart(models) {
  const canvas = $('shareChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const top = models.slice(0, 10);
  if (!top.length) { ctx.fillStyle = '#b8b0b0'; ctx.fillText('暂无数据', 20, 40); return; }

  const max = Math.max(1, ...top.map((m) => m.relativeCost));
  const padLeft = 120, padRight = 20, padTop = 12, padBottom = 30;
  const chartW = w - padLeft - padRight;
  const chartH = h - padTop - padBottom;
  const barGap = 6;
  const barW = (chartW - barGap * (top.length - 1)) / top.length;

  // 网格线
  ctx.strokeStyle = '#f0eae8';
  ctx.fillStyle = '#b8b0b0';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = padTop + (chartH / 4) * i;
    ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(w - padRight, y); ctx.stroke();
    const val = max * (1 - i / 4);
    ctx.fillText(fmtNum(val), padLeft - 8, y + 4);
  }

  // 柱
  top.forEach((m, idx) => {
    const bh = (m.relativeCost / max) * chartH;
    const x = padLeft + idx * (barW + barGap);
    const y = padTop + chartH - bh;
    const grad = ctx.createLinearGradient(0, y, 0, padTop + chartH);
    grad.addColorStop(0, '#ff5e8a');
    grad.addColorStop(1, '#ff8fb1');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, bh, 4);
    ctx.fill();
    // 标签（旋转）
    ctx.fillStyle = '#8a7e7e';
    ctx.textAlign = 'right';
    ctx.save();
    ctx.translate(x + barW / 2, padTop + chartH + 6);
    ctx.rotate(-Math.PI / 6);
    ctx.fillText(shortName(m.model), 0, 0);
    ctx.restore();
  });
}

function shortName(name) {
  const s = String(name);
  return s.length > 14 ? s.slice(0, 13) + '…' : s;
}

// ─── 排序 ───
function applySort() {
  currentModels.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'number' && typeof bv === 'number') return sortAsc ? av - bv : bv - av;
    return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });
  renderTable(currentModels);
}

document.querySelectorAll('#modelTable thead th').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (sortKey === key) sortAsc = !sortAsc;
    else { sortKey = key; sortAsc = false; }
    applySort();
  });
});

// ─── 主渲染 ───
function render(cost) {
  currentCost = cost;
  currentModels = [...cost.models];
  renderSummary(cost.total);
  renderTable(currentModels);
  renderChart(currentModels);
  const hasNewapi = cost.total.calls >= 0;
  setStatus(hasNewapi ? '已更新' : '无数据', hasNewapi ? '' : 'warn');
}

function renderError(code) {
  if (code === 'NO_NEWAPI' || code === 'NO_CONFIG') {
    setStatus('未配置 NewAPI 凭证', 'warn');
    $('footNote').textContent = '请在设置中配置 NewAPI 地址/账号/密码后查看成本明细。';
  } else {
    setStatus('获取失败', 'error');
  }
}

// ─── 事件 ───
$('refreshBtn').addEventListener('click', async () => {
  setStatus('刷新中…');
  const r = await window.api.detailRefresh();
  if (r && r.ok) { /* detail-update 事件会推送数据 */ }
  else renderError(r?.code || 'FAILED');
});
$('historyBtn').addEventListener('click', () => window.api.detailOpenHistory());

window.api.onDetailUpdate((cost) => render(cost));

// ─── 初始加载 ───
(async () => {
  const r = await window.api.detailRefresh();
  if (r && r.ok && r.cost) render(r.cost);
  else if (r && !r.ok) renderError(r.code || 'FAILED');
})();
