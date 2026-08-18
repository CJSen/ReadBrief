<script setup lang="ts">
/**
 * 更新日志列表 —— 数据来自构建时抓取的 GitHub Releases（最近 5 个稳定版），
 * 更早的版本引导去 GitHub。发版后官网自动重建刷新，无需手改文案，页面也不会无限膨胀。
 */
import { data as release } from '../../data/release.data'
</script>

<template>
  <div class="rb-cl">
    <p v-if="release.history.length === 0" class="rb-cl-empty">
      暂未读取到版本记录，请前往
      <a :href="release.releasesUrl" target="_blank" rel="noreferrer">GitHub Releases</a> 查看。
    </p>

    <section v-for="entry in release.history" :key="entry.tag" class="rb-cl-entry">
      <header class="rb-cl-hd">
        <h2 class="rb-cl-ver">v{{ entry.version }}</h2>
        <span class="rb-cl-date">{{ entry.dateText }}</span>
        <a class="rb-cl-link" :href="entry.url" target="_blank" rel="noreferrer">查看发布说明 ↗</a>
      </header>

      <p v-if="entry.summary" class="rb-cl-summary">{{ entry.summary }}</p>

      <div v-for="g in entry.groups" :key="g.label" class="rb-cl-group">
        <h3 class="rb-cl-gtitle">{{ g.label }}</h3>
        <ul class="rb-cl-items">
          <li v-for="(it, i) in g.items" :key="i" class="rb-cl-item">
            <span>{{ it.text }}</span>
            <code v-if="it.hash" class="rb-cl-hash">{{ it.hash.slice(0, 7) }}</code>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rb-cl {
  margin: 8px 0 4px;
}

.rb-cl-empty {
  font-size: 14px;
  line-height: 1.75;
  color: var(--vp-c-text-2);
}

.rb-cl-entry {
  padding: 28px 0 4px;
  border-top: 1px solid var(--vp-c-divider);
}
.rb-cl-entry:first-child {
  border-top: none;
  padding-top: 8px;
}

.rb-cl-hd {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 6px;
}
.rb-cl-ver {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  font-family: var(--rb-font-mono);
  color: var(--rb-brand-600);
  border: none;
  padding: 0;
}
.rb-cl-date {
  font-size: 13px;
  color: var(--vp-c-text-3);
}
.rb-cl-link {
  margin-left: auto;
  font-size: 13px;
  color: var(--vp-c-text-2);
  text-decoration: none;
  transition: color var(--rb-duration-fast) var(--rb-ease-out);
}
.rb-cl-link:hover {
  color: var(--rb-brand-600);
}

.rb-cl-summary {
  margin: 0 0 14px;
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--vp-c-text-2);
}

.rb-cl-group {
  margin: 14px 0;
}
.rb-cl-gtitle {
  margin: 0 0 8px;
  font-size: 14.5px;
  font-weight: 600;
  border: none;
  padding: 0;
}

.rb-cl-items {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.rb-cl-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--vp-c-text-1);
}
.rb-cl-item::before {
  content: "";
  flex: none;
  width: 5px;
  height: 5px;
  margin-top: 9px;
  border-radius: 2px;
  background: var(--rb-brand-300);
}
.rb-cl-hash {
  flex: none;
  font-size: 11.5px;
  color: var(--vp-c-text-3);
  background: none;
  padding: 0;
}
</style>
