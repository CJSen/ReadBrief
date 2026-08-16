<script setup lang="ts">
/**
 * 划词浮窗动效预览 —— 模拟「选中文本 → 气泡 → 浮窗流式总结」的完整链路
 * 视觉严格对齐 design-spec：32px 气泡 / 630px 浮窗 / 38px 拖拽条 /
 * 双层阴影 / 品牌色脉冲圆点 / 流式打字 + 闪烁光标 / 底部骨架条
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'

type Phase = 'idle' | 'bubble' | 'streaming' | 'done'

const phase = ref<Phase>('idle')

const sourceText = 'ReadBrief 是一款 macOS 上的 AI 划词总结桌面助手。在任何应用里选中一段文字，按下全局快捷键，AI 就会流式生成要点总结，并以系统级浮窗的形式出现在光标附近——即使你正全屏看视频、写代码，浮窗也会直接悬浮在当前页面。'

const title = 'ReadBrief：划词即总结的 AI 助手'
const bullets = [
  '支持 OpenAI / Claude / Gemini 三协议，密钥仅存本地、不进入渲染进程',
  '系统级浮窗悬浮于任意应用之上，不切出桌面、不打断心流',
  '每次总结自动入库，可搜索、打标签、收藏，随时回溯',
]

const shown = ref('')
const shownTitle = ref('')
const shownBullets = ref<string[]>([])

let timers: number[] = []
let disposed = false

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    const t = window.setTimeout(resolve, ms)
    timers.push(t)
  })
}

function clearAll() {
  timers.forEach((t) => window.clearTimeout(t))
  timers = []
}

async function typeText(text: string, onChar: (full: string) => void, stepMs = 22) {
  let i = 0
  return new Promise<void>((resolve) => {
    const tick = () => {
      i += 1
      onChar(text.slice(0, i))
      if (i < text.length) {
        const t = window.setTimeout(tick, stepMs)
        timers.push(t)
      } else {
        resolve()
      }
    }
    const t = window.setTimeout(tick, 40)
    timers.push(t)
  })
}

async function runLoop() {
  while (!disposed) {
    // 1. 划词选中
    await sleep(900)
    phase.value = 'bubble'
    await sleep(700)
    phase.value = 'streaming'

    // 2. 流式输出
    shown.value = ''
    shownTitle.value = ''
    shownBullets.value = []
    await typeText(sourceText.slice(0, 48) + '……', (s) => {
      shown.value = s
      phase.value = 'streaming'
    })
    await sleep(160)
    await typeText(title, (s) => {
      shownTitle.value = s
      phase.value = 'streaming'
    })
    await sleep(120)
    for (const b of bullets) {
      const list = [...shownBullets.value]
      await typeText(b, (s) => {
        shownBullets.value = [...list.slice(0, shownBullets.value.length), s]
      })
      list.push(b)
      shownBullets.value = [...list]
      await sleep(90)
    }

    // 3. 完成态停留
    phase.value = 'done'
    await sleep(3200)

    // 4. 重置，进入下一轮循环
    shown.value = ''
    shownTitle.value = ''
    shownBullets.value = []
    phase.value = 'idle'
    await sleep(600)
  }
}

onMounted(() => {
  runLoop()
})
onBeforeUnmount(() => {
  disposed = true
  clearAll()
})
</script>

<template>
  <div class="rb-fp" aria-hidden="true">
    <!-- 模拟的阅读区：用户正在浏览的"网页" -->
    <div class="rb-fp-stage">
      <div class="rb-fp-doc">
        <div class="rb-fp-doc-title">ReadBrief 使用指南</div>
        <p v-for="i in 3" :key="i" class="rb-fp-doc-line" :class="'w' + (i % 3)"></p>
        <p class="rb-fp-doc-line w1">
          ReadBrief 是一款 macOS 上的 AI 划词总结桌面助手。
          <span class="rb-fp-sel"
            >在任何应用里选中一段文字，按下全局快捷键，AI 就会流式生成要点总结</span
          >，并以系统级浮窗的形式出现在光标附近。
        </p>
        <p class="rb-fp-doc-line w2"></p>
        <p class="rb-fp-doc-line w0"></p>
        <p class="rb-fp-doc-line w1"></p>
      </div>

      <!-- 划词气泡：32×32 主色图标 -->
      <Transition name="bubble">
        <div v-if="phase === 'bubble' || phase === 'streaming' || phase === 'done'" class="rb-fp-bubble">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </div>
      </Transition>

      <!-- 总结浮窗：630px · 双层阴影 -->
      <Transition name="panel">
        <div v-if="phase === 'streaming' || phase === 'done'" class="rb-fp-panel">
          <!-- 38px 自绘拖拽条 -->
          <div class="rb-fp-titlebar">
            <span class="rb-fp-dots"><i></i><i></i><i></i></span>
            <span class="rb-fp-titlebar-text">ReadBrief · 总结</span>
          </div>

          <!-- 上段：划词 / 输入区 -->
          <div class="rb-fp-src">
            <span class="rb-fp-src-label">划词内容</span>
            <p class="rb-fp-src-text">{{ shown || '……' }}</p>
          </div>

          <!-- 下段：AI 输出区 -->
          <div class="rb-fp-ai">
            <div class="rb-fp-ai-hd">
              <span class="rb-fp-pulse"></span>
              <span class="rb-fp-ai-hd-text">{{ phase === 'done' ? '总结完成' : 'AI 正在总结' }}</span>
            </div>

            <div v-if="shownTitle" class="rb-fp-title">
              {{ shownTitle }}<span class="rb-fp-caret"></span>
            </div>

            <ul v-if="shownBullets.length" class="rb-fp-bullets">
              <li v-for="(b, idx) in shownBullets" :key="idx">
                <span class="rb-fp-bdot"></span>
                <span>{{ b }}<span v-if="idx === shownBullets.length - 1" class="rb-fp-caret"></span></span>
              </li>
            </ul>

            <!-- 流式中的骨架条 -->
            <div v-if="phase === 'streaming' && !shownBullets.length" class="rb-fp-skeleton">
              <span></span><span></span><span></span>
            </div>

            <!-- 完成态底栏 -->
            <Transition name="fade">
              <div v-if="phase === 'done'" class="rb-fp-actions">
                <button>复制</button>
                <button>追问</button>
                <button class="rb-fp-star">☆ 收藏</button>
                <button>切换提示词 ▾</button>
              </div>
            </Transition>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.rb-fp { max-width: 860px; margin: 0 auto 24px; }

.rb-fp-stage {
  position: relative;
  padding: 40px 36px 56px;
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-border);
  border-radius: var(--rb-radius-2xl);
  box-shadow: var(--rb-shadow-md);
  overflow: hidden;
  min-height: 420px;
}
/* 背景网格（对齐 ui-mockups 的 stage 点阵） */
.rb-fp-stage::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: radial-gradient(var(--rb-neutral-300) 1px, transparent 1px);
  background-size: 22px 22px;
  opacity: 0.35;
  pointer-events: none;
}

.rb-fp-doc {
  position: relative;
  max-width: 400px;
  padding: 24px;
  background: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-border);
  border-radius: var(--rb-radius-lg);
  box-shadow: var(--rb-shadow-sm);
}
.rb-fp-doc-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
.rb-fp-doc-line {
  margin: 8px 0;
  height: 10px;
  border-radius: 5px;
  background: var(--rb-neutral-100);
}
.rb-fp-doc-line.w0 { width: 92%; }
.rb-fp-doc-line.w1 { width: 100%; height: auto; line-height: 1.75; font-size: 12px; color: var(--vp-c-text-2); background: none; }
.rb-fp-doc-line.w2 { width: 84%; }
.rb-fp-doc-line.w3 { width: 64%; }

.rb-fp-sel {
  background: var(--rb-marker-highlight);
  padding: 1px 2px;
  border-radius: 3px;
  color: var(--vp-c-text-1);
}

/* 气泡 */
.rb-fp-bubble {
  position: absolute;
  right: 44px;
  top: 120px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--rb-radius-md);
  background: var(--rb-brand-600);
  color: #fff;
  box-shadow: var(--rb-shadow-md);
  cursor: default;
}
.bubble-enter-active { transition: transform var(--rb-duration-slow) var(--rb-ease-out), opacity var(--rb-duration-slow) var(--rb-ease-out); }
.bubble-enter-from { transform: scale(0.5); opacity: 0; }
.bubble-leave-active { transition: transform var(--rb-duration-fast) var(--rb-ease-out), opacity var(--rb-duration-fast) var(--rb-ease-out); }
.bubble-leave-to { transform: scale(0.5); opacity: 0; }

/* 浮窗 */
.rb-fp-panel {
  position: absolute;
  right: 36px;
  top: 24px;
  width: 400px;
  border-radius: var(--rb-radius-xl);
  background: var(--vp-c-bg-elv);
  border: 0.5px solid var(--vp-c-border);
  box-shadow: var(--rb-shadow-float);
  overflow: hidden;
}
.panel-enter-active { transition: transform var(--rb-duration-slow) var(--rb-ease-out), opacity var(--rb-duration-slow) var(--rb-ease-out); }
.panel-enter-from { transform: translateY(14px) scale(0.97); opacity: 0; }
.panel-leave-active { transition: transform var(--rb-duration-fast) var(--rb-ease-out), opacity var(--rb-duration-fast) var(--rb-ease-out); }
.panel-leave-to { transform: translateY(8px) scale(0.98); opacity: 0; }

.rb-fp-titlebar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 38px;
  padding: 0 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  user-select: none;
}
.rb-fp-dots { display: flex; gap: 6px; }
.rb-fp-dots i { width: 10px; height: 10px; border-radius: 50%; }
.rb-fp-dots i:nth-child(1) { background: #FF5F57; }
.rb-fp-dots i:nth-child(2) { background: #FEBC2E; }
.rb-fp-dots i:nth-child(3) { background: #28C840; }
.rb-fp-titlebar-text { font-size: 12px; color: var(--vp-c-text-2); }

.rb-fp-src {
  margin: 12px 14px 0;
  padding: 10px 12px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-border);
  border-radius: var(--rb-radius-md);
}
.rb-fp-src-label {
  display: inline-block;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--rb-marker-600);
  background: var(--rb-marker-50);
  padding: 1px 7px;
  border-radius: var(--rb-radius-xs);
  margin-bottom: 6px;
}
.rb-fp-src-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.rb-fp-ai { padding: 12px 14px 14px; }
.rb-fp-ai-hd { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.rb-fp-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--rb-brand-500);
  animation: rb-pulse 1.4s var(--rb-ease-out) infinite;
}
@keyframes rb-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(98, 98, 217, 0.4); }
  50% { box-shadow: 0 0 0 5px rgba(98, 98, 217, 0); }
}
.rb-fp-ai-hd-text { font-size: 12px; font-weight: 500; color: var(--vp-c-text-1); }

.rb-fp-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}
.rb-fp-bullets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.rb-fp-bullets li { display: flex; gap: 8px; font-size: 12px; line-height: 1.7; color: var(--vp-c-text-2); }
.rb-fp-bdot {
  flex: none;
  width: 5px;
  height: 5px;
  margin-top: 7px;
  border-radius: 2px;
  background: var(--rb-brand-400);
}

.rb-fp-caret {
  display: inline-block;
  width: 2px;
  height: 13px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--rb-brand-500);
  animation: rb-blink 1s step-end infinite;
}
@keyframes rb-blink { 50% { opacity: 0; } }

.rb-fp-skeleton { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.rb-fp-skeleton span { height: 10px; border-radius: 5px; background: var(--rb-neutral-100); animation: rb-shimmer 1.3s ease-in-out infinite; }
.rb-fp-skeleton span:nth-child(2) { width: 86%; animation-delay: 0.15s; }
.rb-fp-skeleton span:nth-child(3) { width: 62%; animation-delay: 0.3s; }
@keyframes rb-shimmer {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

.rb-fp-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--vp-c-divider);
}
.rb-fp-actions button {
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-border);
  border-radius: var(--rb-radius-sm);
  cursor: default;
}
.rb-fp-actions button.rb-fp-star { color: var(--rb-marker-600); border-color: var(--rb-marker-200); background: var(--rb-marker-50); }
.fade-enter-active { transition: opacity var(--rb-duration-normal) var(--rb-ease-out); }
.fade-enter-from { opacity: 0; }

@media (max-width: 720px) {
  .rb-fp-stage { padding: 24px 18px 40px; min-height: 360px; }
  .rb-fp-panel { position: relative; right: auto; top: auto; width: 100%; margin-top: 18px; }
  .rb-fp-bubble { right: 26px; top: 190px; }
}
</style>
