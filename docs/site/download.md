---
title: 下载
description: 下载 ReadBrief 安装包（macOS）
---

# 下载 ReadBrief

**当前版本 v0.9.5** · 要求 **macOS 13.0+**

## 安装包

| 芯片 | 下载 |
| --- | --- |
| Apple Silicon（M 系列） | [ReadBrief_0.9.5_aarch64.dmg](https://github.com/CJSen/ReadBrief/releases/download/0.9.5/ReadBrief_0.9.5_aarch64.dmg) |
| Intel | [ReadBrief_0.9.5_x64.dmg](https://github.com/CJSen/ReadBrief/releases/download/0.9.5/ReadBrief_0.9.5_x64.dmg) |

安装步骤：

1. 双击挂载 `.dmg`
2. 将 `ReadBrief.app` 拖入「应用程序」
3. 首次启动后开启「辅助功能」权限（系统设置 → 隐私与安全性 → 辅助功能）

## 从源码构建

```bash
# 环境要求：macOS 13+ / Rust stable / Node.js 22+ / Xcode Command Line Tools
npm install
npm run tauri build   # 产出 .app / .dmg，位于 src-tauri/target/release/bundle/
```

## 更新日志

- **v0.1.0（MVP）** —— 划词即总结、三协议 AI、系统级浮窗、本地历史、提示词管理、中英双语、亮暗主题、托盘常驻

> 完整路线图见 [路线图](/roadmap)。
