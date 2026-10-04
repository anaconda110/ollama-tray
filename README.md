# Ollama Tray

一个**开源、轻量、跨平台**的桌面托盘小工具，用于实时监控 [Ollama Cloud](https://ollama.com) 账号的模型用量配额。

![License](https://img.shields.io/github/license/anaconda110/ollama-tray)
![CI](https://github.com/anaconda110/ollama-tray/actions/workflows/ci.yml/badge.svg)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![Electron](https://img.shields.io/badge/electron-43.4-9feaf9)

**文档**：[README](#) · [Changelog](./CHANGELOG.md) · [配额重置规律](./docs/quota-reset-rules.md) · [贡献指南](./CONTRIBUTING.md) · [行为准则](./CODE_OF_CONDUCT.md) · [安全](./SECURITY.md) · [License](./LICENSE)

## ✨ 功能

- 🖥 **系统托盘常驻**：悬停/点击托盘图标弹出用量卡片
- 📊 **实时配额面板**：5h 会话 + 每周双进度条
- ⏳ **精确倒计时**：按固定锚点递减（5h 整点网格 / 周额度周一 08:00 北京）
- 🎨 **托盘状态角标**：按每周配额自动变色（绿/橙/红/灰）
- 🔄 **自动刷新**：60s 定时 + 弹出时智能刷新（超 30s 自动重拉）
- 🔑 **API Key 模式**：`api.ollama.com/api/usage`，本机加密存储，自动读 Maka vault
- 📈 **历史日志**：每次抓取记录 5h/周额度到 `quota-history.jsonl`
- 🌍 **中英文**、🔓 **跨平台**、📦 **一键打包**

## 快速开始

```bash
npm install
npm start            # 启动
npm test             # 单测
npm run build:win    # 打包 Windows
```

## 数据来源

- 端点：`api.ollama.com/api/usage`（Bearer API Key）
- 刷新规律详见 [docs/quota-reset-rules.md](./docs/quota-reset-rules.md)

## 结构

```
ollama-tray/
├── main.js / preload.js
├── lib/quota.js
├── renderer/   # popup / settings / about
├── scripts/    # gen-tray-icons.ps1
├── test/       # 单测
├── docs/       # 配额重置规律
└── .github/    # CI + Issue/PR 模板
```

## 免责声明

本项目**不是 Ollama 官方出品**。通过你主动提供的 API Key 访问数据，全部本地完成，请妥善保管 Key。

## 许可证

[MIT](LICENSE)
