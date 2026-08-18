/**
 * 发版数据加载器 —— 官网下载页与更新日志页的唯一数据来源。
 *
 * 在 build 时（Node 环境，无 CORS 限制）抓取两份数据：
 *   1. latest.json —— CI 随每个正式版上传的固定名清单，含真实 dmg 直链与体积。
 *      地址 releases/latest/download/latest.json 永久有效，走 CDN 不受 API 限流，
 *      且 GitHub 的 latest 语义天然跳过 prerelease，beta / test 版不会污染下载入口。
 *   2. Releases 列表 —— 供更新日志页展示最近若干版的变更分组。
 *
 * 容错原则：网络不可达时降级为本地 .version + Releases 页面链接，
 * 绝不抛异常。官网构建不能因为 GitHub 抖动而失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineLoader } from 'vitepress'

const REPO = 'CJSen/ReadBrief'
const REPO_URL = `https://github.com/${REPO}`
const LATEST_JSON_URL = `${REPO_URL}/releases/latest/download/latest.json`
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=15`

/** 更新日志页展示的版本数上限，更早的引导去 GitHub，避免页面无限膨胀。 */
const HISTORY_LIMIT = 5
const FETCH_TIMEOUT_MS = 12_000

export interface ChangeItem {
  text: string
  hash: string
}

export interface ChangeGroup {
  type: string
  label: string
  items: ChangeItem[]
}

export interface DownloadAsset {
  name: string
  url: string
  size: number
  sizeText: string
}

export interface HistoryEntry {
  version: string
  tag: string
  dateText: string
  summary: string
  groups: ChangeGroup[]
  url: string
}

export interface ReleaseData {
  version: string
  dateText: string
  assets: {
    aarch64: DownloadAsset | null
    x64: DownloadAsset | null
  }
  highlights: ChangeItem[]
  history: HistoryEntry[]
  releasesUrl: string
  latestUrl: string
  /** true 表示未取到 latest.json，页面应引导用户去 Releases 页面而非给出直链。 */
  degraded: boolean
}

export declare const data: ReleaseData

interface GhRelease {
  tag_name: string
  name: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
  published_at: string | null
  created_at: string
  html_url: string
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function fetchJson<T>(url: string, accept: string): Promise<T | null> {
  const headers: Record<string, string> = {
    accept,
    'user-agent': 'readbrief-docs-build',
  }
  // 本地或 CI 若有 token 则带上，把 API 限额从 60/h 提到 5000/h；缺省不带也能跑。
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[release.data] ${url} 返回 ${res.status}，走降级路径`)
      return null
    }
    return (await res.json()) as T
  } catch (e) {
    console.warn(`[release.data] 抓取 ${url} 失败：${(e as Error).message}，走降级路径`)
    return null
  }
}

/** 兜底读仓库根的 .version（单一版本源），用于网络不可达时至少显示正确版本号。 */
function readLocalVersion(): string {
  const candidates = [
    fileURLToPath(new URL('../../../../.version', import.meta.url)),
    path.resolve(process.cwd(), '../../.version'),
    path.resolve(process.cwd(), '.version'),
  ]
  for (const p of candidates) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim()
      if (v) return v
    } catch {
      // 换下一个候选路径
    }
  }
  return ''
}

/**
 * 解析 release 正文里的变更分组。
 *
 * 正文由 .github/gen-release-notes.py 生成，格式固定：
 *   > 相对上一个版本 x · 共 n 条提交
 *   ### ✨ 新功能
 *   - 描述 (`abc1234`)
 * 「## 📥 下载」及其之后是下载与安装说明，官网自有下载页，此处截断丢弃。
 */
function parseNotes(body: string): { summary: string; groups: ChangeGroup[] } {
  const head = body.split(/\n##\s+(?:📥|📋)/)[0] ?? body
  const summary = (head.match(/^>\s*(.+)$/m)?.[1] ?? '').trim()

  const groups: ChangeGroup[] = []
  let current: ChangeGroup | null = null
  for (const raw of head.split('\n')) {
    const line = raw.trim()
    const heading = line.match(/^###\s+(.+)$/)
    if (heading) {
      current = { type: '', label: heading[1].trim(), items: [] }
      groups.push(current)
      continue
    }
    const bullet = line.match(/^[-*]\s+(.*)$/)
    if (bullet && current) {
      const withHash = bullet[1].match(/^(.*?)\s*\(`([0-9a-f]{6,40})`\)\s*$/)
      current.items.push(
        withHash
          ? { text: withHash[1].trim(), hash: withHash[2] }
          : { text: bullet[1].trim(), hash: '' },
      )
    }
  }

  const nonEmpty = groups.filter((g) => g.items.length > 0)
  if (nonEmpty.length > 0) return { summary, groups: nonEmpty }

  // 手写或旧格式的 release 正文解析不出分组，退化为整段纯文本，保证有内容可读。
  const lines = head
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('>'))
  if (lines.length === 0) return { summary, groups: [] }
  return {
    summary,
    groups: [
      {
        type: 'other',
        label: '变更内容',
        items: lines.map((text) => ({ text, hash: '' })),
      },
    ],
  }
}

/** 最新版要点：新功能优先、问题修复补位，最多 3 条，供下载页概览。 */
function pickHighlights(groups: ChangeGroup[]): ChangeItem[] {
  const byType = (t: string) => groups.filter((g) => g.type === t).flatMap((g) => g.items)
  const byLabel = (kw: string) =>
    groups.filter((g) => g.label.includes(kw)).flatMap((g) => g.items)

  const feats = byType('feat').length ? byType('feat') : byLabel('新功能')
  const fixes = byType('fix').length ? byType('fix') : byLabel('修复')
  return [...feats, ...fixes].slice(0, 3)
}

export default defineLoader({
  async load(): Promise<ReleaseData> {
    const [latest, releases] = await Promise.all([
      fetchJson<{
        version: string
        tag: string
        pub_date: string
        changelog: ChangeGroup[]
        assets: Record<string, { name: string; url: string; size: number }>
      }>(LATEST_JSON_URL, 'application/json'),
      fetchJson<GhRelease[]>(RELEASES_API, 'application/vnd.github+json'),
    ])

    const stable = (releases ?? []).filter((r) => !r.draft && !r.prerelease)
    const history: HistoryEntry[] = stable.slice(0, HISTORY_LIMIT).map((r) => {
      const parsed = parseNotes(r.body ?? '')
      return {
        version: r.tag_name.replace(/^v/, ''),
        tag: r.tag_name,
        dateText: formatDate(r.published_at ?? r.created_at),
        summary: parsed.summary,
        groups: parsed.groups,
        url: r.html_url,
      }
    })

    const toAsset = (a?: { name: string; url: string; size: number }): DownloadAsset | null =>
      a && a.url
        ? { name: a.name, url: a.url, size: a.size, sizeText: formatSize(a.size) }
        : null

    const version =
      latest?.version || history[0]?.version || readLocalVersion() || ''

    const highlights = latest?.changelog?.length
      ? pickHighlights(latest.changelog)
      : pickHighlights(history[0]?.groups ?? [])

    return {
      version,
      dateText: formatDate(latest?.pub_date) || history[0]?.dateText || '',
      assets: {
        aarch64: toAsset(latest?.assets?.aarch64),
        x64: toAsset(latest?.assets?.x64),
      },
      highlights,
      history,
      releasesUrl: `${REPO_URL}/releases`,
      latestUrl: `${REPO_URL}/releases/latest`,
      degraded: !latest,
    }
  },
})
