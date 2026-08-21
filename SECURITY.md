# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | :white_check_mark: |

## 报告漏洞

本项目处理你的 **Ollama Cloud API Key** 与用量数据，安全至上。请**不要**在公开 Issue 提交安全问题，改用私密报告（GitHub Security Advisory 或邮件 `[SECURITY]`）。

## 已知注意事项

- API Key 仅保存在本机 Electron `safeStorage`（系统级加密），不落盘明文、不上传。
- 网络请求仅指向 `api.ollama.com` / `ollama.com`。
- 勿分享你的 Key / quota-history.jsonl。
