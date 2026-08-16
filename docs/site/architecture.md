---
title: 技术架构
description: ReadBrief 的 Tauri v2 架构：三窗口、系统级浮层、AI 下沉 Rust
---

# 技术架构

ReadBrief 采用 **Tauri v2** 桌面框架：**Rust 后端 + WebView 前端**。复用系统 WebView 而非内置 Chromium，使安装包从 60–100MB 降到 **3–5MB**——对常驻托盘的轻量工具而言，这是决定性的体积优势。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Tauri 2（Rust 后端 + WebView 前端） |
| 后端语言 | Rust |
| 前端框架 | React 19 + TypeScript |
| 构建工具 | Vite（前端）/ Cargo（后端） |
| 数据库 | SQLite（rusqlite，WAL 模式） |
| AI 协议 | OpenAI / Claude / Gemini 三协议（Rust 侧 `reqwest` 流式） |
| macOS 原生 | objc2 + objc2-app-kit（NSPanel 浮层） |
| 全局快捷键 | tauri-plugin-global-shortcut |
| 剪贴板 | tauri-plugin-clipboard-manager |
| 开机启动 | tauri-plugin-autostart（LaunchAgent） |
| 类型同步 | ts-rs（Rust 结构体 → TS 类型） |
| 国际化 | 自建轻量 i18n（zh / en） |

## 三窗口架构

| 窗口 | 尺寸 | 特性 |
| --- | --- | --- |
| `main`（主窗口） | 960×640 | 历史记录浏览，关闭时默认最小化到托盘 |
| `settings`（设置） | 915×580 | 设置中心，关闭即隐藏（可再次打开） |
| `float`（浮窗） | 630×560 | 透明、无边框、置顶、跨 Space，常驻 show/hide |

## 核心交互链路

```
全局快捷键 ──▶ Rust 后端 (shortcuts.rs)
                 ├─ 预捕获光标位置（避免 AX 读取期间鼠标移动）
                 ├─ Accessibility(AX) 读取选中文本（selection crate）
                 ├─ 系统级浮窗 (NSPanel) 显示在光标附近（不激活应用、不切 Space）
                 └─ 派发捕获结果 ──▶ 前端浮窗 (AppFloat.tsx)
                                          │
                                          ▼
                                   useSummarySession.run(text)
                                          │
                                          ▼
                      streamChat ──▶ invoke("ai_stream") ──▶ Rust ai.rs
                                          │                    ├─ 校验协议白名单
                                          │                    ├─ 截断输入(20k 字符)
                                          │                    ├─ 三协议序列化 + reqwest 流式
                                          │                    └─ SSE 解析 ──emit──▶ ai-delta ×N ──▶ 前端逐字渲染
                                          ▼
                              完成 ──▶ history_create ──▶ SQLite 落库
```

## 系统级浮窗（NSPanel）原理

最核心也最复杂的部分：`native.rs` 在运行期通过 `object_setClass` 将 Tauri 窗口转换为 `NSPanel` 子类，设置：

- `NonactivatingPanel` —— 不激活应用
- `CanJoinAllSpaces | FullScreenAuxiliary` —— 跨 Space、全屏上方悬浮
- 面板级 `level` 置顶

全程只用 `orderFront`（**绝不调用 `show`/`set_focus`**），从而做到「悬浮在任意应用（含全屏）之上、不激活应用、不切出桌面」。所有 AppKit 操作均在主线程执行，规避 macOS 静默忽略。

## AI 调用下沉 Rust

所有 AI 请求在 Rust 侧发起，前端只通过 Tauri 命令调用、只接收流式事件：

- 密钥保存在本地 `config.json`，**不进入渲染进程、不打印、不日志输出**
- 统一超时、输入截断（20k 字符）、协议白名单
- 三协议序列化差异由 `ai.rs` 消化，前端只认统一的 `ai-delta` 流式事件

## 类型同步工作流

配置结构体以 Rust 为单一权威源，经 `ts-rs` 自动导出前端 TS 类型（`src/lib/config/generated.ts`），避免前后端 schema 漂移。修改 Rust 配置后运行：

```bash
cd src-tauri && cargo test export_types
```
