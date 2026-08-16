---
title: 配置 AI 服务
description: 在 ReadBrief 中添加 OpenAI / Claude / Gemini 服务，支持多服务并存与测速
---

# 配置 AI 服务

打开 **设置 → AI 服务**，点击右上角「+」，先选择格式（OpenAI / Claude / Gemini / 从剪贴板导入），再填写字段。

## 支持的协议

| 协议 | 必填字段 | 说明 |
| --- | --- | --- |
| OpenAI | API Key、模型名 | 兼容所有 OpenAI 格式网关 |
| Claude | API Key、模型名、max_tokens | `system` 独立，`max_tokens` 必填 |
| Gemini | API Key、模型名 | 使用 `contents/parts` 结构 |

## 填写字段

- **API Key** —— 明文存于本地 `config.json`，不上传、不进前端
- **Base URL**（可选）—— 兼容 OpenAI 格式的中转 / 代理地址
- **模型名** —— 如 `gpt-4o-mini`、`claude-3-5-sonnet`、`gemini-1.5-flash`

保存后可点「**测试连接**」验证并回显耗时。

## 多服务并存

大多数用户会同时挂一个官方账号和一个便宜的兼容网关——ReadBrief 支持：

- 列表行内直接显示：名称、格式、模型、Base URL、**当前响应耗时**、连接状态
- **拖动排序**调整优先级
- 点击星标把某个服务设为**默认**
- 失效服务（如 401）整行标红但仍保留在原位——它是待修复项，不是垃圾

## BYOK：自带密钥，永久免费

::: tip BYOK（Bring Your Own Key）
填入自己的密钥后，全功能**永久免费**。请求直连服务商，不经过任何中转服务器。免费版限制见 [提示词管理](/guide/prompts)（自定义提示词 3 个 / 快捷键 2 个）。
:::

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 401 鉴权失败 | 密钥无效或已过期，检查是否完整粘贴 |
| 429 限流/额度 | 触发频率或额度限制，切换服务或稍后再试 |
| 网络异常 | 无法连接，检查代理设置后重试 |
