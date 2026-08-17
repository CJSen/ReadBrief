---
title: 安装与权限
description: 下载安装 ReadBrief，并开启 macOS 辅助功能权限
---

# 安装与权限

## 系统要求

- **macOS 13.0** 及以上
- Apple Silicon（M 系列）或 Intel 双版本
- 安装包约 **3–5 MB**（复用系统 WebView，而非内置 Chromium）

## 安装步骤

1. 前往 [下载页](/download) 获取最新版 <code v-pre>ReadBrief_0.9.5_aarch64.dmg</code>（Apple Silicon）或 <code v-pre>ReadBrief_0.9.5_x64.dmg</code>（Intel）
2. 双击挂载，将 `ReadBrief.app` 拖入「应用程序」
3. 首次启动后，按提示前往 **系统设置 → 隐私与安全性 → 辅助功能**，为 ReadBrief 开启权限

::: warning 关于「辅助功能」权限
划词读取选中文本依赖 macOS Accessibility API，必须授权才能工作。ReadBrief 只在你按下快捷键、需要读取选区时才会调用该 API。
:::

## 从源码构建

如果你熟悉 Rust 工具链，也可以自行构建：

```bash
# 环境要求：macOS 13+ / Rust stable / Node.js 22+ / Xcode Command Line Tools

# 1. 安装前端依赖
npm install

# 2. 开发模式（同时启动 Vite + Rust，热更新）
npm run tauri dev

# 3. 生产构建（产出 .app / .dmg，位于 src-tauri/target/release/bundle/）
npm run tauri build
```

### 类型同步工作流

配置结构体以 Rust 为单一权威源。修改 `src-tauri/src/config.rs` 后重新生成前端类型：

```bash
cd src-tauri && cargo test export_types
# 自动更新 src/lib/config/generated.ts，前端直接 import 使用
```

## 遇到问题？

- 浮窗不显示 / 一闪而过 → 见 [常见问题](/faq#浮窗不显示-或一闪而过)
- 划词读不到文本 → 部分应用 AX 属性不完整，会回退到 AppleScript 模拟 <kbd>⌘C</kbd> 兜底，或使用托盘「粘贴并总结」
