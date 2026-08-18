---
layout: home

hero:
  name: ReadBrief
  text: 划词即总结
  tagline: 在任何应用里选中一段文字，按下全局快捷键，AI 流式生成要点总结，浮窗直接出现在光标附近 —— 即使全屏看视频、写代码，也不会把你切回桌面。
  actions:
    - theme: brand
      text: 立即下载
      link: /download
    - theme: alt
      text: 快速上手
      link: /guide/install
---

<!-- 划词浮窗动效预览：选中 → 气泡 → 流式总结 -->
<FloatPreview />

<div class="rb-platform-badges">
<span class="rb-platform-badge">🍎 macOS 13.0+</span>
<span class="rb-platform-badge">🔷 Tauri 2</span>
<span class="rb-platform-badge">⚛️ React 19</span>
<span class="rb-platform-badge">🦀 Rust 后端</span>
<span class="rb-platform-badge">🤖 OpenAI / Claude / Gemini</span>
</div>

<div class="rb-home">
<h2 class="rb-section-title" id="features">让「看见结论」快一点，再快一点</h2>
<p class="rb-section-sub">产品的竞争力不在功能多，而在从选中文字到看见结论之间的摩擦有多小。</p>

<div class="rb-features">
<div class="rb-feature">
<div class="rb-f-icon">
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a2 2 0 012-2h2"/><path d="M4 17v2a2 2 0 002 2h2"/><path d="M17 3h2a2 2 0 012 2v2"/><path d="M17 21h2a2 2 0 002-2v-2"/><path d="M9 12h6"/><path d="M12 9v6"/></svg>
</div>
<h3>划词即总结</h3>
<p>在任意应用中选中文本，按下 <kbd>⌘</kbd><kbd>Shift</kbd><kbd>Z</kbd>，浮窗即时流式输出总结，全屏应用之上也不切出桌面。</p>
</div>

<div class="rb-feature">
<div class="rb-f-icon">
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 8.7l5.4-.8z"/></svg>
</div>
<h3>三协议 AI 适配</h3>
<p>内置 OpenAI / Anthropic Claude / Google Gemini 三套协议层，可同时配置多个服务、测速、设默认，兼容中转网关。</p>
</div>

<div class="rb-feature">
<div class="rb-f-icon">
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 18v3"/></svg>
</div>
<h3>系统级浮层</h3>
<p>基于 <code>objc2</code> 将窗口转换为非激活 NSPanel：跨 Space、悬浮于任意应用（含全屏）之上，绝不打断当前工作。</p>
</div>

<div class="rb-feature">
<div class="rb-f-icon">
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 5v14c0 1.66-4 3-9 3s-9-1.34-9-3V5"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/></svg>
</div>
<h3>本地历史 · 可回溯</h3>
<p>每一次总结自动存入本地 SQLite：搜索、标签、收藏、复制、重新生成，AI 小标题让你在数百条记录里一眼扫读。</p>
</div>

<div class="rb-feature">
<div class="rb-f-icon">
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
</div>
<h3>密钥不进前端</h3>
<p>AI 请求全部由 Rust 后端发起，密钥永不进入渲染进程；统一超时、截断、协议白名单，更安全也更健壮。</p>
</div>

<div class="rb-feature">
<div class="rb-f-icon">
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18"/><path d="M3 12h18"/><path d="M3 19h12"/></svg>
</div>
<h3>中英双语</h3>
<p>界面默认中文、可切英文；「总结语言」独立设置（跟随界面 / 中文 / English），输出语言最多支持 10 种。</p>
</div>
</div>

<h2 class="rb-section-title">一次划词的完整旅程</h2>
<p class="rb-section-sub">全局快捷键 → Rust 捕获选中文本 → AI 流式返回 → 浮窗逐字渲染 → 落库可回溯，全程不到一次呼吸。</p>

<div class="rb-terminal">
<div class="rb-term-hd"><i></i><i></i><i></i><span>readbrief · 划词链路</span></div>
<pre><span class="t-kw">全局快捷键</span> ──▶ <span class="t-fn">Rust 后端</span> <span class="t-com">(shortcuts.rs)</span>
                 ├─ 预捕获光标位置 <span class="t-com">(避免 AX 读取期间鼠标移动)</span>
                 ├─ Accessibility(AX) 读取选中文本 <span class="t-com">(selection crate)</span>
                 ├─ 系统级浮窗 (NSPanel) 显示在光标附近
                 └─ 派发捕获结果 ──▶ 前端浮窗 <span class="t-fn">(AppFloat.tsx)</span>
                                          │
                                          ▼
                      <span class="t-kw">streamChat</span> ──▶ invoke("ai_stream") ──▶ <span class="t-fn">Rust ai.rs</span>
                                          ├─ 校验协议白名单 <span class="t-com">/ 截断输入 20k 字符</span>
                                          ├─ 三协议序列化 + reqwest 流式
                                          └─ SSE 解析 ──▶ ai-delta ×N ──▶ 前端逐字渲染
                                          ▼
                              <span class="t-ok">完成</span> ──▶ history_create ──▶ <span class="t-hl">SQLite 落库</span></pre>
</div>

<h2 class="rb-section-title">三步，跑通第一次总结</h2>
<p class="rb-section-sub">工具类软件的留存拐点在于「第一次成功」，而不是「看完介绍」。</p>

<div class="rb-steps">
<div class="rb-step">
<h3>下载并安装</h3>
<p><strong>.dmg 安装包双击打不开</strong>：前往 <strong>系统设置 → 隐私与安全性</strong> 点「仍要打开」，或终端 <code>xattr -cr &lt;dmg 路径&gt;</code> 解除隔离。</p>
<p><strong>首次打开 App 提示「无法验证开发者」</strong>：右键点击 App → <strong>打开</strong> 即可；或前往 <strong>系统设置 → 隐私与安全性</strong> 点「仍要打开」，或终端 <code>xattr -cr /Applications/ReadBrief.app</code> 解除隔离。首次启动按提示开启「辅助功能」权限，用于划词读取选中文本。</p>
</div>

<div class="rb-step">
<h3>配置 AI 服务</h3>
<p>选择 OpenAI / Claude / Gemini 任一协议，粘贴自己的密钥，点「测试连接」验证。密钥只存本机。</p>
</div>

<div class="rb-step">
<h3>划词，看结论</h3>
<p>在任意应用选中文字，按 <kbd>⌘</kbd><kbd>Shift</kbd><kbd>Z</kbd>，浮窗出现在光标附近，AI 开始逐字输出。</p>
</div>
</div>

<div class="rb-cta">
<h2>准备好体验了吗？</h2>
<p>划词即总结，从今天开始。支持 macOS 13.0 及以上，Apple Silicon 与 Intel 双版本。</p>
<div class="rb-cta-btns">
<a class="rb-btn rb-btn-primary" href="/download">
<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
立即下载
</a>
<a class="rb-btn rb-btn-ghost" href="/guide/install">查看使用指南</a>
</div>
</div>
</div>
