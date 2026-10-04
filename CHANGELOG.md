# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中
- 配额告警通知（weekly >=70%/90% 时 Windows 通知）
- 每周 Top 模型展示

## [1.0.0] - 2026-08-21

### 新增
- 系统托盘常驻，悬停/点击弹出用量卡片。
- 实时配额面板：5 小时 + 每周双进度条。
- **固定锚点倒计时**：5h 整点网格滚动 + 周额度每周一 08:00 北京（详见 docs/quota-reset-rules.md）。
- 托盘状态角标：按每周配额自动变色（绿/橙/红/灰）。
- 弹出时智能刷新 + 配额历史日志（quota-history.jsonl）。
- API Key 模式 + 自动读取 Maka 凭据库。
- **单实例锁**：避免重复打开多个托盘图标。
- **失败指数退避**：断网/限流时 30s→10m，防狂刷；手动刷新可强制。
- **运行日志**：写入 userData/app.log。
- **彩色线稿羊驼图标**（官网）+ 正方形底座，UI/托盘不变形。
- **NewAPI 数据源 + 成本明细页**：按模型 token × Ollama Usage Level 权重估算额度成本（可选，需自建 NewAPI 网关）。

### 变更
- 数据源从 Cookie 抓取改为 Bearer API（api.ollama.com/api/usage）。
- 卡片标题/副标题去掉套餐与 "API ·" 字样。
- 移除托盘 tooltip，悬停只弹面板。

### 安全
- API Key 仅本机 safeStorage 加密存储，不落盘明文、不上传。

[Unreleased]: https://github.com/anaconda110/ollama-tray/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/anaconda110/ollama-tray/releases/tag/v1.0.0
