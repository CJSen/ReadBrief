---
title: 下载
description: 下载 ReadBrief 安装包（macOS / Windows）
---

# 下载 ReadBrief

<DownloadCards />

::: warning macOS · 安装包（.dmg）双击打不开？
当前为开发 / 免费阶段构建，尚未进行 Apple 公证（Notarization），属正常现象：

- 前往 **系统设置 → 隐私与安全性**，滚动到底部「安全性」区域，点 **仍要打开**
- 或在终端解除隔离标记（将 dmg 文件拖入终端）：`xattr -cr <dmg 路径>`
:::

::: warning macOS · 首次打开 App 提示「无法验证开发者」？
当前为开发 / 免费阶段构建，尚未进行 Apple 公证（Notarization），属正常现象：

- **右键打开**：在「应用程序」中右键点击 `ReadBrief.app` → **打开**，弹窗中再次点「打开」
- **系统设置放行**：前往 **系统设置 → 隐私与安全性**，滚动到底部「安全性」区域，点 **仍要打开**
- **终端解除隔离**：`xattr -cr /Applications/ReadBrief.app`

后续配置 Apple 开发者证书并公证后，该提示即会消失。
:::

::: warning Windows · SmartScreen 提示「Windows 已保护你的电脑」？
当前为开发 / 免费阶段构建，尚未使用 Authenticode 代码签名证书，属正常现象：

- 在 SmartScreen 拦截页点 **「更多信息」**，再点 **「仍要运行」** 即可继续安装
- 或在下载的 `.exe` 上右键 → **属性 → 常规**，勾选底部「解除锁定」后确定

配置代码签名证书（EV / OV）并签名后，该提示即会消失。
:::

## 从源码构建

```bash
# macOS 环境要求：macOS 13+ / Rust stable / Node.js 22+ / Xcode Command Line Tools
# Windows 环境要求：Windows 10/11（64 位）/ Rust stable / Node.js 22+ / VS 2022 生成工具 + NSIS
npm install
npm run tauri build   # 产出 macOS 的 .app/.dmg 或 Windows 的 .exe，位于 src-tauri/target/release/bundle/
```
