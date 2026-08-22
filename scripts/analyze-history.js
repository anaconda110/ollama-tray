#!/usr/bin/env node
// analyze-history.js — 分析 ollama-tray 配额历史（quota-history.jsonl）
// 用法：node scripts/analyze-history.js [历史文件路径]
// 默认读取 %APPDATA%\ollama-tray\quota-history.jsonl
// 输出：全部汇总 / 每个5小时窗口 / 每个一周窗口 三组统计
const fs = require('fs');
const path = require('path');

const BJ = 8 * 3600000; // 北京 +8
const FIVE_H = 5 * 3600000;
const DAY = 86400000;
const WEEK = 7 * DAY;

const histFile = process.argv[2]
  || path.join(process.env.APPDATA, 'ollama-tray', 'quota-history.jsonl');

if (!fs.existsSync(histFile)) {
  console.error('历史文件不存在:', histFile);
  process.exit(1);
}

const records = fs.readFileSync(histFile, 'utf8')
  .split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

if (!records.length) { console.log('无历史数据'); process.exit(0); }

// —— 窗口归属 ——
// 5h 窗口起点：全局连续 5h 网格（不按每天 00:00 重置，避免跨天重叠）
function fiveHStart(ts) {
  return Math.floor(ts / FIVE_H) * FIVE_H;
}
// 周窗口起点：本周一 00:00 UTC
function weekStart(ts) {
  const d = new Date(ts);
  const back = (d.getUTCDay() + 6) % 7;
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return day - back * DAY;
}
const fmt = (ts) => new Date(ts + BJ).toUTCString().slice(0, 22); // 北京时间
const fmtShort = (ts) => { const d = new Date(ts + BJ); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:00`; };

// ----- 全部汇总 -----
const all = records.map((r) => r.weekly_usage);
console.log('════════ 全部数据汇总 ════════');
console.log(`记录数        : ${records.length}`);
console.log(`时间跨度      : ${fmt(records[0].ts)} ~ ${fmt(records[records.length - 1].ts)}`);
console.log(`session 首→末 : ${records[0].session_usage}% → ${records[records.length - 1].session_usage}%`);
console.log(`weekly  首→末 : ${records[0].weekly_usage}% → ${records[records.length - 1].weekly_usage}%`);
console.log(`weekly 最小/最大: ${Math.min(...all)}% / ${Math.max(...all)}%`);
console.log('');

// ----- 5h 窗口 -----
const fiveMap = new Map();
for (const r of records) {
  const ws = fiveHStart(r.ts);
  if (!fiveMap.has(ws)) fiveMap.set(ws, { n: 0, first: null, last: null, maxS: 0 });
  const g = fiveMap.get(ws);
  g.n++;
  if (g.first === null) g.first = r.session_usage;
  g.last = r.session_usage;
  g.maxS = Math.max(g.maxS, r.session_usage);
}
console.log('==== 每个 5 小时窗口（北京整点网格）====');
for (const [ws, g] of [...fiveMap.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(
    `[${fmtShort(ws)}]  记录${String(g.n).padStart(3)}  session ${g.first}%→${g.last}% (峰值${g.maxS}%)`
  );
}
console.log('');

// ----- 周窗口 -----
const weekMap = new Map();
for (const r of records) {
  const ws = weekStart(r.ts);
  if (!weekMap.has(ws)) weekMap.set(ws, { n: 0, first: null, last: null, maxW: 0 });
  const g = weekMap.get(ws);
  g.n++;
  if (g.first === null) g.first = r.weekly_usage;
  g.last = r.weekly_usage;
  g.maxW = Math.max(g.maxW, r.weekly_usage);
}
console.log('==== 每个一周窗口（周一 00:00 UTC 起点）====');
for (const [ws, g] of [...weekMap.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(
    `周起始 ${fmtShort(ws)}  记录数 ${String(g.n).padStart(3)}  weekly ${g.first}%→${g.last}% (峰值${g.maxW}%)`
  );
}
console.log('');
console.log('注：session_usage 为 5h 额度使用%，weekly_usage 为周额度使用%。');
