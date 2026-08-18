import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

export interface DmgAsset {
  /** 资产文件名，如 ReadBrief_aarch64.dmg */
  name: string;
  /** 浏览器下载直链 */
  url: string;
}

export interface UpdateInfo {
  /** 是否存在可用更新（远端版本号高于本地） */
  hasUpdate: boolean;
  /** 当前已安装版本（来自 getVersion） */
  currentVersion: string;
  /** 远端最新版本号（已去掉前缀 v），无数据时为 null */
  latestVersion: string | null;
  /** 自动匹配本机架构后的下载地址（优先对应架构 dmg 直链，否则首个 dmg，再否则 Release 页）；无数据时为 null */
  releaseUrl: string | null;
  /** Release 标题/名称，无数据时为 null */
  releaseName: string | null;
  /** Release 更新说明（body），无数据时为 null */
  releaseNotes: string | null;
  /** 所有 .dmg 资产（已过滤出有效下载直链），供兜底手动选择 Apple 芯片 / Intel */
  dmgAssets: DmgAsset[];
  /** 检查失败时的错误信息，成功为 null */
  error: string | null;
  /** 诊断提示：针对常见失败原因给出的排查建议，成功为 null */
  hint: string | null;
}

const REPO = "CJSen/ReadBrief";

/** GitHub Releases 页面（即使 API 失败时也能用于手动查看） */
export const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;

// Vite 注入的 DEV 标志；用类型化的任意断言避免 tsconfig 未引入 vite/client 时报错
const IS_DEV = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

/** 仅 dev 环境打印，避免污染生产控制台。打开 Tauri DevTools（右键窗口 → Inspect / 调试菜单）即可看到 */
function log(...args: unknown[]): void {
  if (IS_DEV) console.debug("[update]", ...args);
}

interface GhRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

function normalize(v: string): string {
  return v.replace(/^v/i, "").trim();
}

function parse(v: string): [number, number, number] {
  const p = normalize(v)
    .split(".")
    .map((n) => parseInt(n, 10));
  return [
    Number.isFinite(p[0]) ? p[0] : 0,
    Number.isFinite(p[1]) ? p[1] : 0,
    Number.isFinite(p[2]) ? p[2] : 0,
  ];
}

function compare(a: string, b: string): number {
  const va = parse(a);
  const vb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

function statusHint(status: number): string | null {
  switch (status) {
    case 401:
      return "认证失败：GitHub 拒绝了请求。";
    case 403:
      return "GitHub API 限流（匿名请求每小时 60 次）或仓库无权限。稍后重试，或检查网络/代理。";
    case 404:
      return "未找到 Release：确认仓库 CJSen/ReadBrief 已发布过「非草稿」Release（draft 不计入 latest）。";
    default:
      return null;
  }
}

function errHint(msg: string): string | null {
  if (/Failed to fetch|NetworkError|net::|CORS|blocked/i.test(msg)) {
    return "请求被拦截或网络不可达：① 检查 tauri.conf.json 的 CSP connect-src 是否含 https://api.github.com；② 本机能否直连 github.com（代理/VPN/防火墙）；③ dev 模式下 CSP 是否被正确加载。";
  }
  return null;
}

/** 根据架构从 dmg 中找到匹配的下载项（兼容 aarch64/arm64 与 x86_64/x64/intel 命名） */
function pickDmg(dmgs: DmgAsset[], arch: string): DmgAsset | undefined {
  const a = arch.toLowerCase();
  if (a.includes("aarch64") || a.includes("arm64") || a.includes("arm")) {
    return dmgs.find((d) => /aarch64|arm64|apple/i.test(d.name));
  }
  if (a.includes("x86_64") || a.includes("x64") || a.includes("intel")) {
    return dmgs.find((d) => /x64|x86_64|intel/i.test(d.name));
  }
  return undefined;
}

// 同一窗口内短期缓存，避免重复请求（多窗口各自独立）
let cache: { promise: Promise<UpdateInfo>; ts: number } | null = null;
const TTL = 5 * 60 * 1000;

/**
 * 轻量版更新检查：仅查询 GitHub Releases 最新版本，不下载、不自动安装。
 * 适合尚未配置 Apple 签名/公证的免费阶段。
 */
export async function checkUpdate(opts?: { force?: boolean }): Promise<UpdateInfo> {
  const now = Date.now();
  if (!opts?.force && cache && now - cache.ts < TTL) return cache.promise;

  const promise = (async (): Promise<UpdateInfo> => {
    const currentVersion = normalize(await getVersion().catch(() => "0.0.0"));
    // 架构检测：用于匹配正确的 dmg（Apple 芯片 / Intel）。失败则回退到首个 dmg。
    let arch = "";
    try {
      arch = await invoke<string>("get_app_arch");
    } catch {
      /* 忽略：拿不到架构时回退到首个 dmg */
    }
    const url = `https://api.github.com/repos/${REPO}/releases/latest`;
    log("开始检查更新", { url, currentVersion, arch, force: opts?.force ?? false });
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "ReadBrief" },
      });
      log("响应状态", res.status, res.statusText);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log("HTTP 错误响应体", body.slice(0, 300));
        return {
          hasUpdate: false,
          currentVersion,
          latestVersion: null,
          releaseUrl: null,
          releaseName: null,
          releaseNotes: null,
          dmgAssets: [],
          error: `HTTP ${res.status} ${res.statusText}`,
          hint: statusHint(res.status),
        };
      }
      const data = (await res.json()) as GhRelease;
      const latestVersion = normalize(data.tag_name ?? "");
      const dmgs: DmgAsset[] = (data.assets ?? [])
        .filter((a) => !!a.name && a.name.toLowerCase().endsWith(".dmg") && !!a.browser_download_url)
        .map((a) => ({ name: a.name as string, url: a.browser_download_url as string }));
      const matched = pickDmg(dmgs, arch);
      const releaseUrl = matched?.url ?? dmgs[0]?.url ?? data.html_url ?? null;
      log("远端版本", latestVersion, "dmg 资产", dmgs, "本机架构", arch, "匹配", matched?.name ?? "（回退首个/Release页）", "→", releaseUrl);
      if (!latestVersion) {
        return {
          hasUpdate: false,
          currentVersion,
          latestVersion: null,
          releaseUrl: null,
          releaseName: null,
          releaseNotes: null,
          dmgAssets: [],
          error: null,
          hint: null,
        };
      }
      const hasUpdate = compare(latestVersion, currentVersion) > 0;
      log("比对结果", { hasUpdate, currentVersion, latestVersion, releaseUrl });
      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        releaseUrl,
        releaseName: (data.name ?? data.tag_name ?? null) as string | null,
        releaseNotes: (data.body ?? null) as string | null,
        dmgAssets: dmgs,
        error: null,
        hint: null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("检查异常", e);
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: null,
        releaseUrl: null,
        releaseName: null,
        releaseNotes: null,
        dmgAssets: [],
        error: msg,
        hint: errHint(msg),
      };
    }
  })();

  cache = { promise, ts: now };
  return promise;
}
