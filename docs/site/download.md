---
title: 下载
description: 下载 ReadBrief 安装包（macOS）
---

# 下载 ReadBrief

<DownloadCards />

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
