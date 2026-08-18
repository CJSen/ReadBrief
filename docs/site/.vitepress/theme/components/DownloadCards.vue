<script setup lang="ts">
/**
 * 下载卡片 —— 版本号、dmg 直链与体积全部来自构建时抓取的 latest.json，
 * 发版后由 CI 触发官网重建自动刷新，无需手改文案。
 * 抓取失败（degraded）时不给出可能失效的直链，改为引导到 Releases 页面。
 */
import { data as release } from '../../data/release.data'

const arches = [
  { key: 'aarch64' as const, title: 'Apple Silicon', desc: 'M1 / M2 / M3 / M4 等 M 系列芯片' },
  { key: 'x64' as const, title: 'Intel', desc: 'x86_64 处理器机型' },
]
</script>

<template>
  <div class="rb-dl">
    <div class="rb-dl-meta">
      <span v-if="release.version" class="rb-dl-ver">v{{ release.version }}</span>
      <span v-if="release.dateText" class="rb-dl-date">发布于 {{ release.dateText }}</span>
      <span class="rb-dl-req">要求 macOS 13.0+</span>
    </div>

    <div class="rb-dl-grid">
      <div v-for="a in arches" :key="a.key" class="rb-dl-card">
        <div class="rb-dl-hd">
          <span class="rb-dl-icon">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="6" y="6" width="12" height="12" rx="2" />
              <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
            </svg>
          </span>
          <div>
            <h3>{{ a.title }}</h3>
            <p>{{ a.desc }}</p>
          </div>
        </div>

        <a
          v-if="release.assets[a.key]"
          class="rb-dl-btn"
          :href="release.assets[a.key]!.url"
          :download="release.assets[a.key]!.name"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <path d="M7 10l5 5 5-5" />
            <path d="M12 15V3" />
          </svg>
          下载 .dmg
          <span v-if="release.assets[a.key]!.sizeText" class="rb-dl-size">
            {{ release.assets[a.key]!.sizeText }}
          </span>
        </a>
        <a v-else class="rb-dl-btn rb-dl-btn-alt" :href="release.latestUrl" target="_blank" rel="noreferrer">
          前往 Releases 页面
        </a>

        <code v-if="release.assets[a.key]" class="rb-dl-file">{{ release.assets[a.key]!.name }}</code>
      </div>
    </div>

    <div v-if="release.highlights.length" class="rb-dl-whats">
      <h3 class="rb-dl-whats-h">本次更新</h3>
      <ul class="rb-dl-whats-list">
        <li v-for="(h, i) in release.highlights" :key="i">{{ h.text }}</li>
      </ul>
    </div>

    <p v-if="release.degraded" class="rb-dl-note">
      未能读取到最新发版清单，上方按钮指向 Releases 页面；请在页面内选择与你芯片对应的 <code>.dmg</code>。
    </p>

    <p class="rb-dl-links">
      <a :href="release.releasesUrl" target="_blank" rel="noreferrer">查看所有历史版本</a>
      <span class="rb-dl-sep">·</span>
      <a href="/changelog">完整更新日志</a>
    </p>
  </div>
</template>

<style scoped>
.rb-dl {
  margin: 20px 0 8px;
}

.rb-dl-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}
.rb-dl-ver {
  font-family: var(--rb-font-mono);
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: var(--rb-brand-600);
  padding: 3px 10px;
  border-radius: var(--rb-radius-sm);
}
.rb-dl-date,
.rb-dl-req {
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.rb-dl-req {
  padding: 2px 8px;
  border: 1px solid var(--vp-c-border);
  border-radius: var(--rb-radius-sm);
}

.rb-dl-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.rb-dl-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-border);
  border-radius: var(--rb-radius-xl);
  transition: border-color var(--rb-duration-normal) var(--rb-ease-out),
    box-shadow var(--rb-duration-normal) var(--rb-ease-out);
}
.rb-dl-card:hover {
  border-color: var(--rb-brand-300);
  box-shadow: var(--rb-shadow-sm);
}

.rb-dl-hd {
  display: flex;
  align-items: flex-start;
  gap: 11px;
}
.rb-dl-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: var(--rb-radius-md);
  color: var(--rb-brand-600);
  background: var(--rb-brand-50);
}
.rb-dl-hd h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  border: none;
  padding: 0;
}
.rb-dl-hd p {
  margin: 2px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.rb-dl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 9px 14px;
  font-size: 14px;
  font-weight: 500;
  color: #fff !important;
  background: var(--rb-brand-600);
  border-radius: var(--rb-radius-md);
  text-decoration: none !important;
  transition: background var(--rb-duration-fast) var(--rb-ease-out);
}
.rb-dl-btn:hover {
  background: var(--rb-brand-700);
}
.rb-dl-btn-alt {
  color: var(--vp-c-text-1) !important;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-border);
}
.rb-dl-btn-alt:hover {
  background: var(--vp-c-bg-alt);
  border-color: var(--rb-brand-300);
}
.rb-dl-size {
  font-size: 12px;
  font-weight: 400;
  opacity: 0.85;
}

.rb-dl-file {
  font-size: 11.5px;
  color: var(--vp-c-text-3);
  background: none;
  padding: 0;
  word-break: break-all;
}

.rb-dl-note {
  margin: 14px 0 0;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--rb-marker-600);
  background: var(--rb-marker-50);
  border-radius: var(--rb-radius-md);
}

.rb-dl-whats {
  margin: 18px 0 0;
  padding: 14px 16px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-border);
  border-radius: var(--rb-radius-lg);
}
.rb-dl-whats-h {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--rb-brand-600);
  border: none;
  padding: 0;
}
.rb-dl-whats-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rb-dl-whats-list li {
  position: relative;
  padding-left: 16px;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--vp-c-text-1);
}
.rb-dl-whats-list li::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 9px;
  width: 5px;
  height: 5px;
  border-radius: 2px;
  background: var(--rb-brand-400);
}

.rb-dl-links {
  margin: 16px 0 0;
  font-size: 13.5px;
}
.rb-dl-sep {
  margin: 0 8px;
  color: var(--vp-c-text-3);
}

@media (max-width: 640px) {
  .rb-dl-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
