---
title: 路线图
description: ReadBrief 已规划但尚未实现的功能方向
---

# 路线图

下列为已规划、尚未在 MVP 中实现的后续方向：

## Windows 适配

划词、剪贴板、快捷键已做平台无关封装，主要补齐 Rust 侧原生窗口逻辑（非 macOS 平台当前走 `show + set_focus` 降级路径）。

## PopClip 插件支持

为 ReadBrief 开发一个 PopClip 扩展，让用户**选中文字后在 PopClip 弹出条里直接点按 ReadBrief 动作**即可发起总结，作为全局快捷键（<kbd>⌘</kbd><kbd>Shift</kbd><kbd>Z</kbd>）之外的另一种触发方式。

<!-- ## 收藏高级筛选与标签树

对收藏记录提供更精细的筛选维度与树状标签组织。

## 长文批量总结

支持超长文档的批量分片总结，与多窗口并排对比。

## 密钥加密存储

接入 macOS Keychain / Windows Credential Manager，替换 MVP 阶段的明文 `config.json`。 -->

## 截图 OCR 总结 <span class="rb-badge rb-badge-pro">待定</span>
<!-- ## 截图 OCR 总结 <span class="rb-badge rb-badge-pro">PRO</span> -->

对屏幕截图做 OCR 后总结。
<!-- UI 中已预埋 <span class="rb-badge rb-badge-pro">PRO</span> 标识与 <kbd>⌥</kbd><kbd>S</kbd> 快捷键位，接入后只需切换 enabled 态，无需重排界面。 -->

## 云端能力（Pro）<span class="rb-badge rb-badge-pro">待定</span>

托管模型调用、跨设备历史同步等云端能力。

---

> 想优先看到哪个功能？欢迎提交 Issue 或 PR 一起共建。

> 有更多想法？欢迎提交 Issue，告诉我们你的功能建议。
