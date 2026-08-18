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

1. 双击挂载 `.dmg`，将 `ReadBrief.app` 拖入「应用程序」
2. 首次启动后开启「辅助功能」权限（系统设置 → 隐私与安全性 → 辅助功能）

::: warning 安装包（.dmg）双击打不开？
当前为开发 / 免费阶段构建，尚未进行 Apple 公证（Notarization），属正常现象：

- 前往 **系统设置 → 隐私与安全性**，滚动到底部「安全性」区域，点 **仍要打开**
- 或在终端解除隔离标记（将 dmg 文件拖入终端）：`xattr -cr <dmg 路径>`
:::

::: warning 首次打开 App 提示「无法验证开发者」？
当前为开发 / 免费阶段构建，尚未进行 Apple 公证（Notarization），属正常现象：

- **右键打开**：在「应用程序」中右键点击 `ReadBrief.app` → **打开**，弹窗中再次点「打开」
- **系统设置放行**：前往 **系统设置 → 隐私与安全性**，滚动到底部「安全性」区域，点 **仍要打开**
- **终端解除隔离**：`xattr -cr /Applications/ReadBrief.app`

后续配置 Apple 开发者证书并公证后，该提示即会消失。
:::

## 从源码构建

```bash
# 环境要求：macOS 13+ / Rust stable / Node.js 22+ / Xcode Command Line Tools
npm install
npm run tauri build   # 产出 .app / .dmg，位于 src-tauri/target/release/bundle/
```

## 更新日志

- **v0.9.5（MVP）** —— 划词即总结、三协议 AI、系统级浮窗、本地历史、提示词管理、中英双语、亮暗主题、托盘常驻、历史查询与展示

> 完整路线图见 [路线图](/roadmap)。
