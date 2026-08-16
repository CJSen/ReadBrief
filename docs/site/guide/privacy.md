---
title: 隐私与数据
description: ReadBrief 的数据存储、密钥安全与隐私说明
---

# 隐私与数据

## 你的数据存在哪

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 历史记录 | <code v-pre>~/Library/Application Support/ReadBrief/readbrief.db</code> | SQLite，WAL 模式，损坏自动重建 |
| 配置与密钥 | <code v-pre>~/.config/ReadBrief/config.json</code> | 明文存储，MVP 阶段不做系统钥匙串加密 |

## 密钥安全

- AI 请求**全部由 Rust 后端发起**，前端渲染进程**拿不到密钥**
- 密钥不打印、不日志输出、不上传
- 设置页明示 BYOK：请求直连服务商，**不经过任何中转**

::: warning 关于明文存储
MVP 阶段密钥以明文存于本地 `config.json`，请妥善保管本机。路线图计划接入 macOS Keychain / Windows Credential Manager 加密存储。
:::

## 数据管理

设置中心「隐私与数据」页提供：

- **导出 JSON** —— 一键导出全部历史记录
- **清空历史** —— 红色危险操作，二次确认后执行
- **匿名诊断** —— 可选开关，帮助改进产品

## 权限最小化

ReadBrief 只申请两类系统能力：

| 权限 | 用途 | 触发时机 |
| --- | --- | --- |
| 辅助功能 (Accessibility) | 读取选中文本 | 仅在你按下快捷键时 |
| 剪贴板 | 粘贴并总结 | 仅在你主动触发粘贴时 |

我们不申请网络权限以外的任何数据访问，不采集使用行为（匿名诊断默认关闭）。
