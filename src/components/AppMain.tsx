import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppConfig } from "../lib/config/types";
import { getServices } from "../lib/config/types";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t, useLanguage } from "../lib/i18n";
import { Icon } from "./Icon";
import { LogoMark } from "./LogoMark";
import { Onboarding } from "./Onboarding";
import { checkUpdate, type UpdateInfo } from "../lib/update/checkUpdate";

/**
 * 本地预览开关：测试「发现新版本」右下角弹窗。
 * 设为 true 后启动会强制弹出更新提示（无需真实 GitHub Release 高于本地版本）。
 * 预览完请改回 false 再提交。
 */
const DEV_TEST_UPDATE_POPUP = false;

/** 被动更新检查的轮询间隔：每 24 小时一次(macOS 用户常挂后台,启动检查已覆盖刚打开的窗口期;远低于 GitHub 匿名 60 次/小时限流) */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface HistoryRecord {
  id: number;
  sourceText: string;
  summary: string;
  aiTitle?: string | null;
  createdAt: string;
  model: string;
  promptName?: string | null;
  tags: string[];
  isFavorite: boolean;
}

/** 列表项投影:不含 sourceText(原文按需 history_get),summary 为截断预览 */
interface HistoryListItem {
  id: number;
  aiTitle?: string | null;
  summary: string;
  createdAt: string;
  model: string;
  promptName?: string | null;
  tags: string[];
  isFavorite: boolean;
  sourceCharCount: number;
}

interface HistoryPage {
  items: HistoryListItem[];
  total: number;
}

interface TagDef {
  name: string;
  color: string;
}

/** 创建标签浮层:快捷色(CSS 变量,跟随主题) */
const QUICK_COLORS = ["brand", "marker", "success", "error"] as const;
/** 常用色板 8 色 */
const PALETTE = ["#EF4444", "#F97316", "#FACC15", "#22C55E", "#06B6D4", "#3B82F6", "#8B5CF6", "#94A3B8"];
/** 色相渐变条色标(与设计稿 linear-gradient 一致) */
const HUE_STOPS = ["#EF4444", "#F97316", "#FACC15", "#22C55E", "#06B6D4", "#3B82F6", "#8B5CF6", "#EC4899", "#EF4444"];
const DEFAULT_TAG_COLOR = "#8B5CF6";
/** 删除确认浮层估算高度(px):决定向上/向下展开 */
const CONFIRM_POP_H = 92;
/** 每条记录最多标签数 */
const MAX_RECORD_TAGS = 4;
/** 列表分页大小(无限滚动每次拉取条数) */
const PAGE_SIZE = 50;

/** 色相条插值取色:ratio 0..1 → #RRGGBB */
function hueColorAt(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const seg = clamped * (HUE_STOPS.length - 1);
  const i = Math.min(HUE_STOPS.length - 2, Math.floor(seg));
  const f = seg - i;
  const pa = [1, 3, 5].map((p) => parseInt(HUE_STOPS[i].slice(p, p + 2), 16));
  const pb = [1, 3, 5].map((p) => parseInt(HUE_STOPS[i + 1].slice(p, p + 2), 16));
  const mix = pa.map((v, k) => Math.round(v + (pb[k] - v) * f));
  return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** 将任意 hex(#rgb/#rrggbb)规范化为 #rrggbb;非法返回 null */
function normalizeHex(input: string): string | null {
  let v = input.trim();
  if (!v.startsWith("#")) v = `#${v}`;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (!m) return null;
  let hex = m[1].toLowerCase();
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return `#${hex}`;
}

/** 标签文字色:快捷色(CSS 变量)取同族 600 变体,hex 直接用原色 */
function tagTextColor(color: string): string {
  const m = /^var\(--rb-(.+)-400\)$/.exec(color);
  if (m) return `var(--rb-${m[1]}-600)`;
  return color || "var(--rb-text-secondary)";
}

/** 随机标签色:从常用色板取一个(协调不刺眼) */
function randomTagColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

export function AppMain() {
  // 订阅语言变更,切语言时即时重渲染
  useLanguage();
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [records, setRecords] = useState<HistoryListItem[]>([]);
  const [detail, setDetail] = useState<HistoryRecord | null>(null);
  /** 详情刷新计数器:history-changed 时自增,强制重载当前选中记录(selectedId 不变也会刷新) */
  const [detailTick, setDetailTick] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [favCount, setFavCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState<"all" | "favorites">("all");
  const [timeFilter, setTimeFilter] = useState<"all" | "today" | "week">("all");
  const [copied, setCopied] = useState(false);
  const [allTags, setAllTags] = useState<TagDef[]>([]);
  /** 首启引导覆盖层:仅主窗口,config.onboardingDone=false 时显示 */
  const [showOnboarding, setShowOnboarding] = useState(false);
  /** 首屏配置是否加载完成(config_get 成功/失败均置 true) */
  const [cfgLoaded, setCfgLoaded] = useState(false);
  /** 首屏历史列表是否完成首次加载(翻页/过滤不重置) */
  const [bootstrapped, setBootstrapped] = useState(false);
  /** 首屏标签列表是否加载完成 */
  const [tagsLoaded, setTagsLoaded] = useState(false);
  // 左侧标签多选(至多 4 个,交集 AND 筛选)
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  // 左侧标签搜索框
  const [tagSearch, setTagSearch] = useState("");
  // 删除标签二次确认:正在确认的标签名 + 浮层 fixed 定位(避免滚动容器裁剪)
  const [confirmDeleteTag, setConfirmDeleteTag] = useState<string | null>(null);
  const [confirmPos, setConfirmPos] = useState<{ top: number; left: number } | null>(null);
  // 标签编辑器(创建/编辑共用):mode + 原标签名(编辑时) + fixed 定位
  const [tagEditor, setTagEditor] = useState<"create" | "edit" | null>(null);
  const [editTagName, setEditTagName] = useState<string | null>(null);
  const [editorPos, setEditorPos] = useState<{ top: number; left: number } | null>(null);

  // 启动检查更新(轻量版:仅检测 GitHub Release,有更新则在主窗右下角提示)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showUpdatePopup, setShowUpdatePopup] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(`var(--rb-brand-400)`);
  const [newTagHex, setNewTagHex] = useState(DEFAULT_TAG_COLOR);
  const newTagInputRef = useRef<HTMLInputElement>(null);
  // 无限滚动:列表容器 / 请求序号(防竞态) / 最新过滤条件 / 已加载记录镜像 / 同步锁
  const listRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);
  const filterRef = useRef({
    keyword: "",
    view: "all" as "all" | "favorites",
    timeFilter: "all" as "all" | "today" | "week",
    selectedTags: [] as string[],
  });
  const recordsRef = useRef<HistoryListItem[]>([]);
  const inflightRef = useRef(false);
  const hasMoreRef = useRef(false);
  // 当前过滤条件的命中总数(仅 reset 时由后端计算一次,追加页复用,避免每次翻页都跑 COUNT)
  const filteredTotalRef = useRef(0);
  // 主窗自己触发的写操作(收藏/打标)会经后端 emit "history-changed" 广播回本窗口,
  // 用时间戳屏蔽这段"自回声",避免乐观更新被 history-changed 的全量刷新覆盖(列表/详情闪烁)。
  const selfMutateUntil = useRef(0);
  // 详情「添加标签」浮层
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerInput, setPickerInput] = useState("");
  const pickerInputRef = useRef<HTMLInputElement>(null);
  // 已弹出过提示的版本号:同版本只提示一次,避免 3 小时轮询反复打扰
  const notifiedVersionRef = useRef<string | null>(null);

  const hasApiKey = cfg ? getServices(cfg).some((s) => s.apiKey) : false;

  /** 首屏是否已就绪:配置 + 历史列表 + 标签均加载完成,三者一起渲染避免"标签先出、列表后出"的割裂 */
  const ready = cfgLoaded && bootstrapped && tagsLoaded;

  // 每次渲染同步最新过滤条件(供稳定的 loadPage 读取,避免闭包过期)
  filterRef.current = { keyword, view, timeFilter, selectedTags };

  useEffect(() => {
    invoke<AppConfig>("config_get")
      .then((c) => {
        setCfg(c);
        if (!c.onboardingDone) setShowOnboarding(true);
      })
      .catch(() => setCfg(null))
      .finally(() => setCfgLoaded(true));
  }, []);

  // 每 24 小时静默检查一次更新(轻量版:仅查 GitHub Release,不下载/不自动安装);启动即查一次已覆盖刚打开的窗口期。
  // 同版本只提示一次(notifiedVersionRef),失败/已是最新均无感(仅 DevTools 日志);卸载时清理定时器。
  useEffect(() => {
    let alive = true;

    const runCheck = () => {
      checkUpdate()
        .then((info) => {
          if (!alive) return;
          setUpdateInfo(info);
          if (info.hasUpdate && info.latestVersion && info.latestVersion !== notifiedVersionRef.current) {
            notifiedVersionRef.current = info.latestVersion;
            setShowUpdatePopup(true);
          } else if (info.error) {
            console.warn("[update] 检查失败：", info.error, info.hint ?? "");
          }
        })
        .catch((e) => console.warn("[update] 检查异常：", e));
    };

    // 本地预览：强制弹出更新提示，无需真实 Release
    if (DEV_TEST_UPDATE_POPUP) {
      const fake: UpdateInfo = {
        hasUpdate: true,
        currentVersion: "0.9.5",
        latestVersion: "1.2.0",
        releaseUrl: "https://github.com/CJSen/ReadBrief/releases/download/v1.2.0/ReadBrief_aarch64.dmg",
        releaseName: "v1.2.0",
        releaseNotes:
          "## 更新内容\n\n- 新增轻量版更新检查（自动匹配本机架构）\n- 关于页可「查看更新」查看更新说明\n- 修复若干已知问题\n\n详情见 [Release 页面](https://github.com/CJSen/ReadBrief/releases/tag/v1.2.0)",
        dmgAssets: [
          { name: "ReadBrief_aarch64.dmg", url: "https://github.com/CJSen/ReadBrief/releases/download/v1.2.0/ReadBrief_aarch64.dmg" },
          { name: "ReadBrief_x86_64.dmg", url: "https://github.com/CJSen/ReadBrief/releases/download/v1.2.0/ReadBrief_x86_64.dmg" },
        ],
        error: null,
        hint: null,
      };
      if (alive) {
        setUpdateInfo(fake);
        notifiedVersionRef.current = fake.latestVersion ?? null;
        setShowUpdatePopup(true);
      }
      return () => {
        alive = false;
      };
    }

    runCheck();
    const timer = setInterval(runCheck, UPDATE_CHECK_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  async function handleGoUpdate() {
    try {
      await invoke("open_settings");
      await emit("navigate-settings", "about");
    } catch {
      /* 忽略:设置窗口打开失败时不阻塞 */
    }
    setShowUpdatePopup(false);
  }

  // 配置变更(设置窗口改 AI 服务/语言/主题等)时同步到主窗口 cfg,
  // 避免常驻主窗口持有陈旧配置(如设置里配好 Key 后主窗仍显示「未配置」横幅)。
  useEffect(() => {
    const un = listen<AppConfig>("config-changed", (e) => {
      setCfg(e.payload);
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  // 主窗浮层是否打开(供 Esc 优先关闭浮层,而非直接隐藏主窗)
  const popoversOpen = useRef(false);
  useEffect(() => {
    popoversOpen.current = Boolean(tagEditor || confirmDeleteTag || pickerOpen);
  }, [tagEditor, confirmDeleteTag, pickerOpen]);

  // Esc:优先关闭主窗浮层(标签编辑器/删除确认/添加标签),无浮层才隐藏主窗(设计稿 §10)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (popoversOpen.current) {
        closeTagEditor();
        setConfirmDeleteTag(null);
        setConfirmPos(null);
        setPickerOpen(false);
        return;
      }
      void invoke("hide_main");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /** 侧边栏计数(历史/收藏总数,独立于当前过滤条件) */
  const loadCounts = useCallback(async () => {
    try {
      const [t, f] = await Promise.all([
        invoke<number>("history_count", { favorite: false }),
        invoke<number>("history_count", { favorite: true }),
      ]);
      setTotalCount(t);
      setFavCount(f);
    } catch {
      // ignore
    }
  }, []);

  /**
   * 分页加载:reset=true 回到第一页(过滤变化/历史变更),否则追加下一页(无限滚动)。
   * 读 filterRef 拿最新过滤条件,用 seq 序号丢弃过期响应(防竞态)。
   */
  const loadPage = useCallback(async (reset: boolean) => {
    if (!reset && inflightRef.current) return;
    inflightRef.current = true;
    setLoading(true);
    const f = filterRef.current;
    const offset = reset ? 0 : recordsRef.current.length;
    const seq = ++seqRef.current;
    try {
      const page = await invoke<HistoryPage>("history_list", {
        keyword: f.keyword.trim() || null,
        favorite: f.view === "favorites",
        timeFilter: f.timeFilter,
        tags: f.selectedTags,
        limit: PAGE_SIZE,
        offset,
      });
      if (seq !== seqRef.current) return; // 已被更新的请求取代,丢弃过期结果
      const next = reset ? page.items : [...recordsRef.current, ...page.items];
      recordsRef.current = next;
      setRecords(next);
      // 过滤条件变化(reset)时回到列表顶部,便于从首条开始浏览
      if (reset) listRef.current?.scrollTo({ top: 0 });
      // total 仅在过滤变化(reset)时从后端取一次,追加页复用,避免每次翻页都跑 COUNT(10w 数据下约 150ms)
      if (reset) filteredTotalRef.current = page.total;
      // 注意:导航「历史数据」计数只来自 loadCounts(history_count(false)) 的全量,
      // 不能用当前过滤的 page.total 覆盖,否则切到「收藏」时会把历史计数变成收藏计数。
      hasMoreRef.current = offset + page.items.length < filteredTotalRef.current;
      setHasMore(hasMoreRef.current);
      setSelectedId((prev) => (reset ? (next[0]?.id ?? null) : prev));
    } catch {
      if (seq === seqRef.current && reset) {
        recordsRef.current = [];
        setRecords([]);
        hasMoreRef.current = false;
        setHasMore(false);
      }
    } finally {
      if (seq === seqRef.current) {
        inflightRef.current = false;
        setLoading(false);
        setBootstrapped(true);
      }
    }
  }, []);

  const loadTags = useCallback(async () => {
    try {
      const tags = await invoke<TagDef[]>("history_all_tags");
      setAllTags(tags);
    } catch {
      // ignore
    } finally {
      setTagsLoaded(true);
    }
  }, []);

  /** 刷新列表第一页数据(替换 records),但不动 selectedId —— 浮窗数据变更后主窗口保持选中、原地刷新 */
  const refreshList = useCallback(async () => {
    const f = filterRef.current;
    const seq = ++seqRef.current; // 使 in-flight 的 loadPage 响应过期,避免与滚动追加竞争
    try {
      const page = await invoke<HistoryPage>("history_list", {
        keyword: f.keyword.trim() || null,
        favorite: f.view === "favorites",
        timeFilter: f.timeFilter,
        tags: f.selectedTags,
        limit: PAGE_SIZE,
        offset: 0,
      });
      if (seq !== seqRef.current) return;
      recordsRef.current = page.items;
      setRecords(page.items);
      filteredTotalRef.current = page.total;
      hasMoreRef.current = page.items.length < page.total;
      setHasMore(hasMoreRef.current);
    } catch {
      // 忽略刷新失败
    }
  }, []);

  // 初始数据加载(Windows 冷启动兜底):
  // 主窗口以 visible:false 创建、后由 Rust 显示。Windows WebView2 冷启动早期 invoke 可能尚未就绪,
  // 首次加载被各 loader 内部的 catch 静默吞掉 → 主窗口空白,需点击/获焦触发 onFocusChanged 才成功。
  // 故先以一次直接 invoke 探测 IPC 是否就绪(失败会抛错、可被检测);未就绪则按递增间隔重试,
  // 直到通道可用再正式加载一次。macOS 探测首试即成功,不会反复重载。
  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const doLoad = () => {
      void loadCounts();
      void loadTags();
      void loadPage(true);
    };
    const probe = async (attempt: number) => {
      if (cancelled) return;
      try {
        await invoke("history_count", { favorite: false }); // 探测通道是否就绪
      } catch {
        if (attempt < 8) {
          timers.push(setTimeout(() => void probe(attempt + 1), 150 * (attempt + 1)));
        }
        return;
      }
      doLoad(); // IPC 就绪:正式加载一次(后续不再重试)
    };
    void probe(0);
    return () => {
      cancelled = true;
      timers.forEach((t) => clearTimeout(t));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 视图/时间/标签 过滤变化 → 重置回第一页(并回到顶部)。
  // 首帧跳过:初始数据由上方带重试的 loader 负责,避免冷启动竞态失败留下空态。
  const skipFirstFilter = useRef(true);
  useEffect(() => {
    if (skipFirstFilter.current) {
      skipFirstFilter.current = false;
      return;
    }
    void loadPage(true);
  }, [view, timeFilter, selectedTags, loadPage]);

  // 关键词输入防抖 300ms 后重新搜索
  useEffect(() => {
    const timer = setTimeout(() => void loadPage(true), 300);
    return () => clearTimeout(timer);
  }, [keyword, loadPage]);

  // 选中变化 → 按需加载详情(全文 sourceText / summary)
  useEffect(() => {
    let disposed = false;
    if (selectedId == null) {
      setDetail(null);
      return;
    }
    setDetail(null);
    invoke<HistoryRecord>("history_get", { id: selectedId })
      .then((r) => {
        if (!disposed) setDetail(r);
      })
      .catch(() => {
        if (!disposed) setDetail(null);
      });
    return () => {
      disposed = true;
    };
  }, [selectedId, detailTick]);

  // 无限滚动:接近底部且还有更多时加载下一页
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!hasMoreRef.current || inflightRef.current) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
        void loadPage(false);
      }
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [loadPage]);

  // 历史数据变更(浮窗打标/收藏/重新生成/新增)时:刷新计数/标签/列表数据,并强制重载当前详情。
  // 用 refreshList(不动 selectedId)而非 loadPage(true):保持选中、不跳页,详情经 detailTick 原地刷新。
  // 注意:主窗自己的收藏/打标已做乐观更新,其后端广播回来的 history-changed 会在此被 selfMutateUntil 屏蔽,
  // 避免"操作一次→全量刷新一次"的闪烁(只保留浮窗等其它窗口触发的变更)。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen("history-changed", () => {
      if (Date.now() < selfMutateUntil.current) return; // 自己操作的广播,乐观更新已覆盖
      void loadCounts();
      void loadTags();
      void refreshList();
      setDetailTick((t) => t + 1);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadCounts, loadTags, refreshList]);

  // 主窗口获得焦点时全量刷新(用户不常开主窗口,打开瞬间保证数据最新;防隐藏期间事件丢失/时序遗漏)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        void loadCounts();
        void loadTags();
        void refreshList();
        setDetailTick((t) => t + 1);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadCounts, loadTags, refreshList]);

  // 窗口显示后强制刷新一次(Windows WebView2 首帧不提交合成的兜底):
  // 主窗口以 visible:false 创建、后由 Rust 显示,WebView2 首帧可能不绘制 —— 即便数据已加载,
  // 也需点击/获焦才显示。Rust 在显示后 emit "main-shown",本监听重拉数据并触发重渲染,
  // 与 Rust 侧 force_webview_repaint 形成双保险,确保首次启动即显示已加载的内容。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen("main-shown", () => {
      void loadCounts();
      void loadTags();
      void refreshList();
      setDetailTick((t) => t + 1);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadCounts, loadTags, refreshList]);

  /** 左侧标签列表:按搜索框过滤 */
  const filteredTags = tagSearch.trim()
    ? allTags.filter((d) => d.name.toLowerCase().includes(tagSearch.trim().toLowerCase()))
    : allTags;

  async function handleDelete(id: number) {
    try {
      await invoke("history_delete", { id });
    } catch {
      return;
    }
    // 乐观移除本地记录,避免整页重载跳回顶部
    const next = recordsRef.current.filter((r) => r.id !== id);
    recordsRef.current = next;
    setRecords(next);
    if (detail?.id === id) {
      setDetail(null);
      setSelectedId(next[0]?.id ?? null);
    }
    void loadCounts();
    void loadTags();
  }

  async function handleToggleFavorite(id: number) {
    selfMutateUntil.current = Date.now() + 500;
    const nextFav = await invoke<boolean>("history_toggle_favorite", { id });
    // 乐观同步列表与详情,不整页重载
    recordsRef.current = recordsRef.current.map((r) =>
      r.id === id ? { ...r, isFavorite: nextFav } : r,
    );
    setRecords(recordsRef.current);
    setDetail((d) => (d && d.id === id ? { ...d, isFavorite: nextFav } : d));
    void loadCounts();
  }

  async function handleUpdateTags(id: number, tags: string[]) {
    selfMutateUntil.current = Date.now() + 500;
    await invoke("history_update_tags", { id, tags });
    recordsRef.current = recordsRef.current.map((r) => (r.id === id ? { ...r, tags } : r));
    setRecords(recordsRef.current);
    setDetail((d) => (d && d.id === id ? { ...d, tags } : d));
    void loadTags();
  }

  /** 打开标签编辑器(创建):重置表单 + 记录按钮位置 */
  function openCreateEditor(btn: HTMLElement) {
    placeEditor(btn);
    setEditTagName(null);
    setNewTagName("");
    setNewTagColor("var(--rb-brand-400)");
    setNewTagHex(DEFAULT_TAG_COLOR);
    setTagEditor("create");
  }

  /** 打开标签编辑器(编辑):预填当前名称与颜色 */
  function openEditEditor(def: TagDef, btn: HTMLElement) {
    placeEditor(btn);
    setEditTagName(def.name);
    setNewTagName(def.name);
    setNewTagColor(def.color || "var(--rb-brand-400)");
    setNewTagHex(normalizeHex(def.color) || DEFAULT_TAG_COLOR);
    setTagEditor("edit");
  }

  /** 计算编辑器 fixed 位置(右对齐按钮,底部空间不足向上展开) */
  function placeEditor(btn: HTMLElement) {
    const rect = btn.getBoundingClientRect();
    const popH = 300;
    const below = rect.bottom + 4;
    const top = below + popH > window.innerHeight ? Math.max(4, rect.top - 4 - popH) : below;
    setEditorPos({ top, left: Math.max(4, rect.right - 224) });
  }

  /** 关闭标签编辑器(创建/编辑共用) */
  function closeTagEditor() {
    setTagEditor(null);
    setEditTagName(null);
    setEditorPos(null);
    setNewTagName("");
    setNewTagColor("var(--rb-brand-400)");
    setNewTagHex(DEFAULT_TAG_COLOR);
  }

  /** 保存标签:创建走 UPSERT,编辑走重命名+改色(同步历史记录) */
  async function handleSaveTag() {
    const name = newTagName.trim();
    if (!name) return;
    if (tagEditor === "edit" && editTagName) {
      try {
        await invoke("history_update_tag", { oldName: editTagName, newName: name, color: newTagColor });
      } catch {
        // ignore
      }
      const next = selectedTags.includes(editTagName ?? "") ? [name] : selectedTags;
      setSelectedTags(next);
      closeTagEditor();
      await loadTags();
      // 重命名标签后刷新第一页,让列表中的标签名同步
      void loadPage(true);
    } else {
      // 创建:未主动选色(仍是默认品牌紫)时赋予随机色
      const color = newTagColor === "var(--rb-brand-400)" ? randomTagColor() : newTagColor;
      try {
        await invoke("history_create_tag", { name, color });
      } catch {
        // ignore
      }
      closeTagEditor();
      await loadTags();
    }
  }

  /** 详情浮层:点选已有标签,已打标则移除(toggle);满 4 个时仅可移除;操作后自动关闭浮层 */
  async function handleToggleTagOnRecord(id: number, name: string) {
    const rec = detail;
    if (!rec || rec.id !== id) return;
    const has = rec.tags.includes(name);
    if (!has && rec.tags.length >= MAX_RECORD_TAGS) return; // 已达上限
    await handleUpdateTags(id, has ? rec.tags.filter((x) => x !== name) : [...rec.tags, name]);
    setPickerOpen(false);
  }

  /** 详情浮层:回车新建标签(未定义则随机给色);满 4 个时禁止新增;操作后自动关闭浮层 */
  async function handleAddTagFromPicker(id: number) {
    const name = pickerInput.trim();
    if (!name) return;
    const rec = detail;
    if (!rec || rec.id !== id || rec.tags.includes(name)) return;
    if (rec.tags.length >= MAX_RECORD_TAGS) return; // 已达上限
    if (!allTags.some((d) => d.name === name)) {
      await invoke("history_create_tag", { name, color: randomTagColor() });
    }
    await handleUpdateTags(id, [...rec.tags, name]);
    setPickerInput("");
    setPickerOpen(false);
  }

  function handleRemoveTag(id: number, currentTags: string[], tag: string) {
    void handleUpdateTags(id, currentTags.filter((t) => t !== tag));
  }

  function handleClickTag(tag: string) {
    // 标签多选(至多 4 个,交集 AND 筛选),在当前视图(历史/收藏)内生效
    setSelectedTags((prev) => {
      if (prev.includes(tag)) return prev.filter((t) => t !== tag);
      if (prev.length >= MAX_RECORD_TAGS) return prev; // 已达上限 4 个,忽略
      return [...prev, tag];
    });
  }

  /** 回到列表顶部:作用于当前列表滚动容器(全部/今天/本周/收藏/关键词均复用同一容器) */
  function scrollListToTop() {
    const el = listRef.current;
    if (!el) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }

  /** 删除标签:确认后移除定义 + 从所有记录剔除,并清理选中态 */
  async function handleDeleteTag(name: string) {
    try {
      await invoke("history_delete_tag", { name });
    } catch {
      // ignore
    }
    const nextSelected = selectedTags.filter((t) => t !== name);
    setConfirmDeleteTag(null);
    setConfirmPos(null);
    setSelectedTags(nextSelected);
    await loadTags();
    // 从已加载记录中剔除该标签,再刷新第一页
    recordsRef.current = recordsRef.current.map((r) => ({
      ...r,
      tags: r.tags.filter((t) => t !== name),
    }));
    setRecords(recordsRef.current);
    void loadPage(true);
  }

  /** 点击行尾 x:计算浮层 fixed 位置(底部空间不足时向上展开) */
  function openDeleteConfirm(name: string, btn: HTMLElement) {
    const rect = btn.getBoundingClientRect();
    const below = rect.bottom + 4;
    const top = below + CONFIRM_POP_H > window.innerHeight ? Math.max(4, rect.top - 4 - CONFIRM_POP_H) : below;
    setConfirmPos({ top, left: Math.max(4, rect.right - 168) });
    setConfirmDeleteTag(name);
  }

  /** 标签颜色查表:未定义色用中性灰 */
  function tagColorOf(name: string): string {
    return allTags.find((d) => d.name === name)?.color || "var(--rb-neutral-300)";
  }

  // 打开标签编辑器时聚焦名称输入
  useEffect(() => {
    if (tagEditor) newTagInputRef.current?.focus();
  }, [tagEditor]);

  // 打开添加浮层时聚焦新建输入
  useEffect(() => {
    if (pickerOpen) pickerInputRef.current?.focus();
  }, [pickerOpen]);

  async function handleCopy(record: HistoryRecord) {
    await invoke("clipboard_write_text", { text: record.summary });
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  /** 首启引导:仅同步配置;关闭由 Onboarding 的 onClose(完成/跳过)驱动 */
  function handleOnboardingUpdate(next: AppConfig) {
    setCfg(next);
  }

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return sameDay ? hhmm : `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
  };

  return (
    <div className="rb-history-layout">
      {/* 左侧导航 208px */}
      <aside className="rb-sidebar">
        <div className="rb-sidebar-brand">
          <span className="rb-logo-mark">
            <LogoMark size={20} className="rb-logo-icon" />
          </span>
          <span>ReadBrief</span>
        </div>

        <div className="rb-nav">
          <div
            className={`rb-nav-item${view === "all" ? " active" : ""}`}
            onClick={() => {
              setView("all");
              setSelectedTags([]);
            }}
          >
            <Icon name="history" size={14} />
            {t("update.historyAll")}
            <span className="rb-nav-count">{ready ? totalCount : "…"}</span>
          </div>
          <div
            className={`rb-nav-item${view === "favorites" ? " active" : ""}`}
            onClick={() => {
              setView("favorites");
              setSelectedTags([]);
            }}
          >
            <Icon name="favorite" size={14} />
            {t("update.favorites")}
            <span className="rb-nav-count">{ready ? favCount : "…"}</span>
          </div>
        </div>

        <div className="rb-nav-section rb-nav-section-row">
          <span className="rb-nav-section-label">
            {t("history.tags")}
            {selectedTags.length > 0 && (
              <button
                type="button"
                className="rb-tag-sel-count"
                title={t("history.clearSelectedTags")}
                onClick={() => setSelectedTags([])}
              >
                已选 {selectedTags.length}/{allTags.length}
              </button>
            )}
          </span>
          <div className="rb-tag-search">
            <Icon name="search" size={12} className="rb-tag-search-icon" />
            <input
              className="inp rb-tag-search-input"
              placeholder={t("history.searchTags")}
              value={tagSearch}
              onChange={(e) => setTagSearch(e.currentTarget.value)}
            />
            {tagSearch ? (
              <button
                className="iconbtn rb-search-clear"
                title={t("history.clear")}
                onClick={() => setTagSearch("")}
              >
                <Icon name="close" size={11} />
              </button>
            ) : null}
          </div>
          <div style={{ position: "relative", flex: "none" }}>
            <button
              className="iconbtn rb-nav-section-add"
              title={t("history.createTag")}
              onClick={(e) => openCreateEditor(e.currentTarget)}
            >
              <Icon name="plus" size={12} />
            </button>
          </div>
        </div>
        {/* 标签列表:可滚动,行尾 编辑+x 删除(浮层均 fixed 渲染于 body,不受容器裁剪) */}
        <div className="rb-tag-scroll" onScroll={() => { setConfirmDeleteTag(null); closeTagEditor(); }}>
          {!ready ? (
            <div className="rb-skeleton" style={{ padding: "var(--rb-space-3) var(--rb-space-3)", marginTop: 0 }}>
              <div style={{ width: "70%" }} />
              <div style={{ width: "85%" }} />
              <div style={{ width: "55%" }} />
              <div style={{ width: "75%" }} />
            </div>
          ) : filteredTags.length === 0 ? (
              <div className="rb-nav-item" style={{ color: "var(--rb-text-tertiary)", cursor: "default" }}>
              <span className="rb-tag-dot" style={{ background: "var(--rb-neutral-300)" }} />
              {t("update.noTags")}
            </div>
          ) : (
            filteredTags.map((def) => (
                <div
                  key={def.name}
                  className={`rb-nav-item rb-tag-nav-item${selectedTags.includes(def.name) ? " active" : ""}`}
                  onClick={() => handleClickTag(def.name)}
                >
                  <span className="rb-tag-dot" style={{ background: def.color || "var(--rb-neutral-300)" }} />
                  <span className="grow trunc">{def.name}</span>
                  <button
                    className="iconbtn rb-tag-del rb-tag-edit"
                    title={t("history.editTag")}
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditEditor(def, e.currentTarget);
                    }}
                  >
                    <Icon name="edit" size={12} />
                  </button>
                  <button
                    className="iconbtn rb-tag-del"
                    title={t("history.deleteTag")}
                    onClick={(e) => {
                      e.stopPropagation();
                      openDeleteConfirm(def.name, e.currentTarget);
                    }}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              ),
            )
          )}
        </div>

        <div className="rb-sidebar-footer">
          <div className="rb-nav-item" onClick={() => invoke("open_settings")}>
            <Icon name="settings" size={14} />
            {t("update.settings")}
            <span className="rb-nav-kbd">⌘ + ,</span>
          </div>
        </div>
      </aside>

      {/* 历史三栏 */}
      <>
        {/* 中间列表 296px */}
        <div className="rb-list-col">
          {!hasApiKey ? (
            <button
              type="button"
              className="rb-banner rb-banner-warn rb-banner-inline"
              onClick={() => invoke("open_settings")}
            >
              <span>{t("banner.unconfigured")}</span>
              <span className="rb-banner-action">→ {t("banner.unconfiguredAction")}</span>
            </button>
          ) : null}
          <div className="rb-list-toolbar">
              <div className="rb-search-wrap">
                <Icon name="search" size={14} className="rb-search-icon" />
                <input
                  className="inp rb-search-input"
                  placeholder={t("history.search")}
                  value={keyword}
                  onChange={(e) => setKeyword(e.currentTarget.value)}
                />
                {keyword ? (
                  <button
                    className="iconbtn rb-search-clear"
                    title={t("history.clear")}
                    onClick={() => setKeyword("")}
                  >
                    <Icon name="close" size={11} />
                  </button>
                ) : null}
              </div>
              <div className="seg rb-seg">
                <span
                  className={timeFilter === "all" ? "on" : ""}
                  style={{ flex: 1, textAlign: "center" }}
                  onClick={() => setTimeFilter("all")}
                >
                  {t("update.all")}
                </span>
                <span
                  className={timeFilter === "today" ? "on" : ""}
                  style={{ flex: 1, textAlign: "center" }}
                  onClick={() => setTimeFilter("today")}
                >
                  {t("update.today")}
                </span>
                <span
                  className={timeFilter === "week" ? "on" : ""}
                  style={{ flex: 1, textAlign: "center" }}
                  onClick={() => setTimeFilter("week")}
                >
                  {t("update.week")}
                </span>
              </div>
            </div>

            <div className="rb-list" ref={listRef}>
              {!ready ? (
                <div className="rb-skeleton" style={{ padding: "var(--rb-space-4) var(--rb-space-3)", marginTop: 0 }}>
                  <div style={{ width: "82%" }} />
                  <div style={{ width: "56%" }} />
                  <div style={{ width: "32%", marginBottom: 14 }} />
                  <div style={{ width: "76%" }} />
                  <div style={{ width: "62%" }} />
                  <div style={{ width: "38%", marginBottom: 14 }} />
                  <div style={{ width: "70%" }} />
                  <div style={{ width: "50%" }} />
                </div>
              ) : records.length === 0 ? (
                <div className="rb-empty-list">{t("history.empty")}</div>
              ) : (
                records.map((r) => (
                  <div
                    key={r.id}
                    className={`rb-list-card${selectedId === r.id ? " selected" : ""}`}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <div className="rb-list-card-head">
                      <span className="rb-list-title">{r.aiTitle || r.summary.split("\n")[0] || t("update.summaryTitle")}</span>
                      {/* 收藏常显(未收藏灰色描边) + 快捷删除(与右侧详情区删除一致,直接删无确认) */}
                      <div className="rb-list-card-actions">
                        <button
                          className="iconbtn"
                          title={r.isFavorite ? t("history.unfavorite") : t("history.favorite")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleToggleFavorite(r.id);
                          }}
                        >
                          <Icon
                            name="favorite"
                            size={14}
                            className={r.isFavorite ? "rb-star" : "rb-star-off"}
                          />
                        </button>
                        <button
                          className="iconbtn rb-list-trash"
                          title={t("history.delete")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDelete(r.id);
                          }}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="rb-list-summary">
                      {r.summary.split("\n")[0]?.slice(0, 60) || r.summary.slice(0, 60)}
                    </div>
                    <div className="rb-list-meta">
                      <span>{formatTime(r.createdAt)}</span>
                      <span className="rb-meta-dot" />
                      <span>{t("update.words", { n: r.sourceCharCount })}</span>
                      {r.promptName ? (
                        <span className="tag tag-brand rb-list-tag">{r.promptName}</span>
                      ) : null}
                    </div>
                    {r.tags.length > 0 ? (
                      <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                        {r.tags.map((t) => (
                          <span
                            key={t}
                            className="tag tag-gray rb-list-tag-item"
                            style={{ height: 16, fontSize: "var(--rb-text-2xs)", display: "inline-flex", alignItems: "center", gap: 4 }}
                          >
                            <span className="rb-tag-dot" style={{ background: tagColorOf(t) }} />
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
              {hasMore ? <div className="rb-list-more">{loading ? t("update.loadingMore") : ""}</div> : null}
            </div>

            {/* 回到顶部:固定悬浮于列表右下角,对全部/今天/本周均生效(列表用同一滚动容器) */}
            <button
              type="button"
              className="rb-totop"
              title={t("history.backToTop")}
              aria-label={t("history.backToTop")}
              onClick={scrollListToTop}
            >
              <Icon name="arrowUp" size={16} />
            </button>
          </div>

          {/* 右侧详情 */}
          <div className="rb-detail-col">
            {!ready || (selectedId != null && !detail) ? (
              <div className="rb-skeleton" style={{ padding: "24px 20px", marginTop: 0 }}>
                <div style={{ width: "38%" }} />
                <div style={{ width: "100%" }} />
                <div style={{ width: "92%" }} />
                <div style={{ width: "78%" }} />
                <div style={{ width: "55%" }} />
              </div>
            ) : detail ? (
              <>
                <div className="rb-detail-head">
                  <span className="tag tag-brand">{detail.promptName || t("update.summaryTitle")}</span>
                  <span className="muted rb-detail-model">
                    {detail.model} · {formatTime(detail.createdAt)}
                  </span>
                  <div className="rb-detail-head-actions">
                    <button
                      className="iconbtn"
                      title={detail.isFavorite ? t("history.unfavorite") : t("history.favorite")}
                      onClick={() => void handleToggleFavorite(detail.id)}
                    >
                      <Icon name="favorite" size={14} className={detail.isFavorite ? "rb-star" : undefined} />
                    </button>
                    <button
                      className="iconbtn"
                      title={copied ? t("float.copied") : t("float.copy")}
                      onClick={() => void handleCopy(detail)}
                    >
                      <Icon name="copy" size={14} />
                    </button>
                    <button className="iconbtn" title={t("history.delete")} onClick={() => void handleDelete(detail.id)}>
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>

                {/* 顶栏第二行:标签(小号字 + 底部色块,可多个) + 添加按钮浮层 */}
                <div className="rb-detail-tags-row">
                  {detail.tags.map((tagName) => {
                    const color = tagColorOf(tagName);
                    return (
                      <span
                        key={tagName}
                        className="rb-tag-under"
                        style={{ color: tagTextColor(color) }}
                        title="点击移除"
                        onClick={() => handleRemoveTag(detail.id, detail.tags, tagName)}
                      >
                        <span>{tagName}</span>
                        <span className="rb-tag-under-dot" style={{ background: color }} />
                      </span>
                    );
                  })}
                  <div style={{ position: "relative" }}>
                    <button
                      className="btn btn-ghost btn-sm rb-detail-tag-add"
                      title={t("history.addTag")}
                      onClick={() => setPickerOpen((v) => !v)}
                    >
                      <Icon name="plus" size={12} />
                      {t("history.addTag")}
                    </button>
                    {/* 标签添加浮层:已有标签点选(带对勾) + 新建输入;满 4 个时新增项禁用 */}
                    {pickerOpen ? (
                      <div className="rb-popover rb-tag-picker">
                        <div className="rb-tag-picker-head">
                          <span className="rb-popover-title">
                            {t("history.tagThis")}
                            {detail.tags.length >= MAX_RECORD_TAGS ? (
                              <span className="rb-tag-limit">{t("history.maxTags")}</span>
                            ) : null}
                          </span>
                          <button
                            className="iconbtn rb-create-tag-close"
                            title={t("history.close")}
                            onClick={() => setPickerOpen(false)}
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                        <div className="rb-tag-picker-list">
                          {allTags.map((def) => {
                          const on = detail.tags.includes(def.name);
                          const disabled = !on && detail.tags.length >= MAX_RECORD_TAGS;
                          return (
                            <div
                              key={def.name}
                              className={`rb-tag-picker-item${on ? " on" : ""}${disabled ? " disabled" : ""}`}
                              onClick={() => void handleToggleTagOnRecord(detail.id, def.name)}
                            >
                              <span className="rb-tag-dot" style={{ background: def.color || "var(--rb-neutral-300)" }} />
                              <span className="grow">{def.name}</span>
                              {on ? <Icon name="check" size={12} /> : null}
                            </div>
                          );
                        })}
                        </div>
                        <div className="rb-tag-picker-new">
                          <input
                            ref={pickerInputRef}
                            className="inp"
                            placeholder={
                              detail.tags.length >= MAX_RECORD_TAGS
                                ? t("history.maxTags")
                                : t("history.newTagPlaceholder")
                            }
                            value={pickerInput}
                            onChange={(e) => setPickerInput(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void handleAddTagFromPicker(detail.id);
                              else if (e.key === "Escape") {
                                e.stopPropagation();
                                setPickerOpen(false);
                              }
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* 上方 2/3：总结（标题 + 要点，可滚动） */}
                <div className="rb-detail-body">
                  <h3 className="rb-detail-h3">
                    {detail.aiTitle || detail.summary.split("\n")[0] || t("update.summaryTitle")}
                  </h3>
                  <div className="rb-points">
                    {detail.summary
                      .split("\n")
                      .filter((l) => l.trim())
                      .map((line, i) => (
                        <div className="rb-point" key={i}>
                          <span className="rb-point-num">{i + 1}</span>
                          <span>{line.replace(/^[0-9]+[.、]?\s*/, "")}</span>
                        </div>
                      ))}
                  </div>
                </div>

                {/* 下方 1/3：原文（固定高度，滚动浏览，右上角复制） */}
                <div className="rb-original">
                  <div className="rb-original-label">
                    <Icon name="list" size={14} />
                    <span>{t("history.original", { n: detail.sourceText.length })}</span>
                    <button
                      className="iconbtn"
                      title={t("float.copy")}
                      onClick={() => void invoke("clipboard_write_text", { text: detail.sourceText })}
                    >
                      <Icon name="copy" size={13} />
                    </button>
                  </div>
                  <div className="rb-original-text">{detail.sourceText}</div>
                </div>
              </>
            ) : (
              <div className="rb-empty-list">{t("history.empty")}</div>
            )}
          </div>
        </>

        {/* 删除标签确认浮层:portal 到 body + fixed 定位,不受 .rb-tag-scroll overflow 裁剪 */}
        {confirmDeleteTag && confirmPos
          ? createPortal(
              <div
                className="rb-popover rb-confirm-popover rb-confirm-fixed"
                style={{ top: confirmPos.top, left: confirmPos.left }}
              >
                <div className="rb-confirm-msg">{t("history.confirmDeleteTag", { name: confirmDeleteTag })}</div>
                <div className="rb-confirm-actions">
                  <button className="btn btn-sm rb-confirm-del" onClick={() => void handleDeleteTag(confirmDeleteTag)}>
                    {t("history.delete")}
                  </button>
                  <button
                    className="btn btn-sm btn-ghost rb-confirm-cancel"
                    onClick={() => {
                      setConfirmDeleteTag(null);
                      setConfirmPos(null);
                    }}
                  >
                    {t("history.cancel")}
                  </button>
                </div>
              </div>,
              document.body,
            )
          : null}

        {/* 标签编辑器(创建/编辑共用):portal 到 body + fixed 定位,名称 + 快捷色 + 色板 + 色相条 + hex */}
          {tagEditor && editorPos
            ? createPortal(
              <div className="rb-popover rb-create-tag rb-editor-fixed" style={{ top: editorPos.top, left: editorPos.left }}>
                <div className="rb-create-tag-head">
                  <span className="rb-popover-title">
                    {tagEditor === "edit" ? t("history.editTag") : t("history.createTag")}
                  </span>
                  <button className="iconbtn rb-create-tag-close" title={t("history.close")} onClick={closeTagEditor}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
                <input
                  ref={newTagInputRef}
                  className="inp rb-create-tag-name"
                  placeholder={tagEditor === "edit" ? t("history.editTagPlaceholder") : t("history.createTagPlaceholder")}
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveTag();
                    else if (e.key === "Escape") {
                      e.stopPropagation();
                      closeTagEditor();
                    }
                  }}
                />
                <div className="rb-create-tag-color-row">
                  <span className="rb-color-label">{t("history.color")}</span>
                  {QUICK_COLORS.map((c) => (
                    <span
                      key={c}
                      className={`rb-color-swatch${newTagColor === `var(--rb-${c}-400)` ? " on" : ""}`}
                      style={{ background: `var(--rb-${c}-400)` }}
                      title={c}
                      onClick={() => setNewTagColor(`var(--rb-${c}-400)`)}
                    />
                  ))}
                </div>
                <div className="rb-create-tag-palette">
                  {PALETTE.map((c) => (
                    <span
                      key={c}
                      className={`rb-color-swatch${newTagColor === c ? " on" : ""}`}
                      style={{ background: c }}
                      title={c}
                      onClick={() => {
                        setNewTagColor(c);
                        setNewTagHex(c);
                      }}
                    />
                  ))}
                </div>
                <div
                  className="rb-hue-bar"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const ratio = (e.clientX - rect.left) / rect.width;
                    const c = hueColorAt(ratio);
                    setNewTagColor(c);
                    setNewTagHex(c);
                  }}
                >
                  <span
                    className="rb-hue-thumb"
                    style={{ left: "72%", borderColor: newTagColor.startsWith("#") ? newTagColor : "var(--rb-brand-600)" }}
                  />
                </div>
                <div className="rb-create-tag-hex">
                  <span className="rb-color-label">{t("history.custom")}</span>
                  <input
                    className="inp rb-hex-input"
                    value={newTagHex}
                    spellCheck={false}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setNewTagHex(v);
                      const c = normalizeHex(v);
                      if (c) setNewTagColor(c);
                    }}
                  />
                  <span
                    className="rb-color-preview"
                    style={{ background: normalizeHex(newTagHex) || "transparent" }}
                  />
                </div>
              </div>,
              document.body,
            )
            : null}

          {/* 首启引导覆盖层(仅主窗口、config.onboardingDone=false 时) */}
          {showOnboarding && cfg ? (
            <Onboarding cfg={cfg} onUpdate={handleOnboardingUpdate} onClose={() => setShowOnboarding(false)} />
          ) : null}

          {/* 更新提示:主窗右下角小弹窗,点击跳转设置-关于 */}
          {showUpdatePopup && updateInfo?.hasUpdate
            ? createPortal(
                <div className="rb-update-popup" role="alert">
                  <div className="rb-update-popup-icon">
                    <Icon name="refresh" size={16} />
                  </div>
                  <div className="rb-update-popup-body">
                    <div className="rb-update-popup-title">{t("update.found", { version: updateInfo.latestVersion ?? "" })}</div>
                    <div className="rb-update-popup-desc">
                      {t("update.desc", { current: updateInfo.currentVersion })}
                    </div>
                  </div>
                  <button className="rb-update-popup-btn" onClick={() => void handleGoUpdate()}>
                    {t("update.go")}
                  </button>
                  <button
                    className="rb-update-popup-close"
                    onClick={() => setShowUpdatePopup(false)}
                    aria-label={t("history.close")}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>,
                document.body,
              )
            : null}
    </div>
  );
}
