---
title: 安装与权限
description: 下载安装 ReadBrief，并开启 macOS 辅助功能权限
---

# 安装与权限

## 系统要求

- **macOS 13.0** 及以上（Apple Silicon M 系列或 Intel）
- **Windows 10 / 11（64 位）**
- 安装包约 **3–5 MB**（复用系统 WebView，而非内置 Chromium）

## macOS 安装步骤

1. 前往 [下载页](/download) 获取最新版 <code v-pre>ReadBrief_x.y.z_aarch64.dmg</code>（Apple Silicon）或 <code v-pre>ReadBrief_x.y.z_x64.dmg</code>（Intel）
2. 双击挂载，将 `ReadBrief.app` 拖入「应用程序」

::: warning 安装包（.dmg）双击打不开？
当前为开发 / 免费阶段构建，尚未进行 Apple 公证（Notarization），属正常现象：

- 前往 **系统设置 → 隐私与安全性**，滚动到底部「安全性」区域，点 **仍要打开**
- 或在终端解除隔离标记（将 dmg 文件拖入终端）：`xattr -cr <dmg 路径>`
:::

3. 首次启动后，按提示前往 **系统设置 → 隐私与安全性 → 辅助功能**，为 ReadBrief 开启权限

::: warning 首次打开 App 提示「无法验证开发者」？
当前为开发 / 免费阶段构建，尚未进行 Apple 公证（Notarization），属正常现象：

- **右键打开**：在「应用程序」中右键点击 `ReadBrief.app` → **打开**，弹窗中再次点「打开」
- **系统设置放行**：前往 **系统设置 → 隐私与安全性**，滚动到底部「安全性」区域，点 **仍要打开**
- **终端解除隔离**：`xattr -cr /Applications/ReadBrief.app`

后续配置 Apple 开发者证书并公证后，该提示即会消失。
:::

::: warning 关于「辅助功能」权限
划词读取选中文本依赖 macOS Accessibility API，必须授权才能工作。ReadBrief 只在你按下快捷键、需要读取选区时才会调用该 API。
:::

## Windows 安装步骤

1. 前往 [下载页](/download) 获取最新版 <code v-pre>ReadBrief_x.y.z_x64-setup.exe</code>
2. 双击运行安装向导，按提示完成安装（默认写入开始菜单与「添加/删除程序」）

::: warning SmartScreen 提示「Windows 已保护你的电脑」？
当前为开发 / 免费阶段构建，尚未使用 Authenticode 代码签名证书，属正常现象：

- 在拦截页点 **「更多信息」**，再点 **「仍要运行」** 即可继续安装
- 或在 `.exe` 上右键 → **属性 → 常规**，勾选底部「解除锁定」后确定

配置代码签名证书并签名后，该提示即会消失。
:::

::: tip Windows 权限说明
Windows 端的划词读取走原生 API，一般无需额外授权；若个别应用读不到选区，可使用托盘「粘贴并总结」走剪贴板路径。
:::

## 从源码构建

如果你熟悉 Rust 工具链，也可以自行构建：

```bash
# macOS 环境：macOS 13+ / Rust stable / Node.js 22+ / Xcode Command Line Tools
# Windows 环境：Windows 10/11（64 位）/ Rust stable / Node.js 22+ / VS 2022 生成工具 + NSIS

# 1. 安装前端依赖
npm install

# 2. 开发模式（同时启动 Vite + Rust，热更新）
npm run tauri dev

# 3. 生产构建
#    macOS  → 产出 .app / .dmg，位于 src-tauri/target/release/bundle/
#    Windows → 产出 .exe（nsis），位于 src-tauri/target/release/bundle/
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
