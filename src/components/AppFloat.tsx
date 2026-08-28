import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getDefaultService } from "../lib/config/types";
import { useConfig } from "../lib/config/useConfig";
import { useSummarySession } from "../lib/ai/useSummarySession";
import { t, useLanguage } from "../lib/i18n";
import { keySymbol } from "../lib/shortcutKey";
import { isMac } from "../lib/platform";
import { Button } from "./Button";
import { Icon } from "./Icon";

interface CaptureResult {
  text: string;
  source: string;
  promptId?: string | null;
  serviceId?: string | null;
}

interface TagDef {
  name: string;
  color: string;
}

/** 每条记录最多标签数(与主窗口 AppMain 一致,后端 history_update_tags 也兜底校验) */
const MAX_RECORD_TAGS = 4;
/** 常用色板 8 色(与主窗口 AppMain 一致,新建标签未选色时随机取) */
const PALETTE = ["#EF4444", "#F97316", "#FACC15", "#22C55E", "#06B6D4", "#3B82F6", "#8B5CF6", "#94A3B8"];

/** 随机标签色:从常用色板取一个(协调不刺眼) */
function randomTagColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

/** 拉取全部标签定义(供打标浮层使用;失败返回空列表) */
async function fetchTags(): Promise<TagDef[]> {
  try {
    return await invoke<TagDef[]>("history_all_tags");
  } catch {
    return [];
  }
}

/** 标签颜色:allTags 定义优先,未定义用中性色(与主窗口 AppMain.tagColorOf 对齐) */
function tagColorOf(name: string, allTags: TagDef[]): string {
  return allTags.find((d) => d.name === name)?.color || "var(--rb-neutral-300)";
}

/** 标签文字色:快捷色(CSS 变量)取同族 600 变体,hex 直接用原色(与主窗口 AppMain.tagTextColor 对齐) */
function tagTextColor(color: string): string {
  const m = /^var\(--rb-(.+)-400\)$/.exec(color);
  if (m) return `var(--rb-${m[1]}-600)`;
  return color || "var(--rb-text-secondary)";
}

export function AppFloat() {
  // 订阅语言变更,切语言时即时重渲染(浮窗在前台时切换也能生效)
  useLanguage();
  const [capture, setCapture] = useState<CaptureResult | null>(null);
  /** 浮窗内「去授权」进行中:禁用按钮并显示「检测中…」,防止重复点击(对齐 Onboarding/设置) */
  const [authInProgress, setAuthInProgress] = useState(false);
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [favHint, setFavHint] = useState(false);
  /** 当前记录是否已收藏(historyId 落库后同步,收藏按钮图标随状态切换) */
  const [isFavorite, setIsFavorite] = useState(false);
  /** 总结耗时读秒(streaming 时每秒 +1;完成/停止时保留最终值) */
  const [elapsed, setElapsed] = useState(0);
  // 标签新增浮层(与主窗口右侧「添加标签」同款):全部标签定义 + 弹层开关 + 新建输入 + 当前记录标签
  const [allTags, setAllTags] = useState<TagDef[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerInput, setPickerInput] = useState("");
  const [tagSearch, setTagSearch] = useState("");
  const [currentTags, setCurrentTags] = useState<string[]>([]);
  /** 本次会话实际绑定的 AI 服务 id(来自快捷键/捕获);为空表示用默认服务。用于按引用解析模型 */
  const [boundServiceId, setBoundServiceId] = useState<string | null>(null);
  /** 思考过程折叠:done 且存在思考内容时,点击展开/收起本次会话的思考内容 */
  const [showReasoning, setShowReasoning] = useState(false);
  const pickerInputRef = useRef<HTMLInputElement>(null);
  /** 思考期流式输出容器:reasoning 累积时自动滚到底,容器限高两行 + overflow hidden,视觉上始终只显示最新两行 */
  const thinkingStreamRef = useRef<HTMLDivElement>(null);

  const { cfg, ref: cfgRef } = useConfig();
  const summonAccel =
    cfg?.shortcuts?.find((s) => s.id === "summarize")?.accelerator ??
    (isMac() ? "Cmd+Shift+Z" : "Ctrl+Shift+Z");
  const {
    output,
    state,
    error,
    historyId,
    thinking,
    reasoning,
    run: runSummary,
    stop,
    reset: resetSession,
    outputRef,
    setPromptId,
    setServiceId,
    promptName,
  } = useSummarySession(cfgRef);

  /** 派生:按绑定服务 id 解析出的实际模型(改 AI 服务配置后自动跟随);未绑定回退默认服务模型 */
  const boundModel =
    boundServiceId && cfg
      ? (cfg.services?.find((s) => s.id === boundServiceId)?.model ?? getDefaultService(cfg).model)
      : (cfg ? getDefaultService(cfg).model : "");

  // 思考内容流式追加 → 滚到最新(overflow hidden 仍可编程式 scrollTop,无滚动条视觉噪音)
  useEffect(() => {
    const el = thinkingStreamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning]);

  const inputRef = useRef("");
  const stateRef = useRef(state);
  const handleCopyRef = useRef<() => void>(() => {});

  // 上报浮窗就绪:Rust 侧补发启动早期(页面加载完成前)触发的捕获结果,避免事件丢失
  useEffect(() => {
    void invoke("float_mark_ready");
  }, []);

  // 挂载时加载标签定义(供打标浮层使用)
  useEffect(() => {
    void fetchTags().then(setAllTags);
  }, []);

  // 总结耗时读秒:streaming 时每秒 +1(从 0 开始);done/error/停止时清除 interval,数值保留不消失
  useEffect(() => {
    if (state !== "streaming") return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);

  // 总结落库后(historyId 非空)同步该记录的当前标签与收藏状态;新会话(idle)时清空
  useEffect(() => {
    if (historyId == null) {
      setCurrentTags([]);
      setIsFavorite(false);
      return;
    }
    void (async () => {
      try {
        const rec = await invoke<{ tags?: string[]; isFavorite?: boolean } | null>("history_get", {
          id: historyId,
        });
        setCurrentTags(rec?.tags ?? []);
        setIsFavorite(Boolean(rec?.isFavorite));
      } catch {
        // 忽略
      }
    })();
  }, [historyId]);

  // 停止按钮(流式中 Esc):中止流并进入 done 态(不落库,P0-3 门控)
  const handleEsc = useCallback(() => {
    if (pinned) return;
    if (state === "streaming") {
      stop();
      return;
    }
    // 设置页「Esc 关闭悬浮窗」开关(默认开启)
    if (
      (state === "done" || state === "error" || state === "idle") &&
      cfgRef.current?.escClose !== false
    ) {
      void invoke("float_hide");
    }
  }, [pinned, state, stop, cfgRef]);

  // 拖拽浮窗:用 JS + set_position 实现,避免 OS 原生拖拽(无论 start_dragging 还是 CSS
  // app-region)在 Windows 透明 WebView2 + WS_EX_NOACTIVATE 浮窗上触发 WebView 重载丢数据。
  // set_position 移动与 hide_float_window 移出屏幕外同源,安全不重载。
  // 用 Pointer 事件 + setPointerCapture:光标移出浮窗外(到桌面)时也持续派发 move,拖拽跟手。
  //
  // 防抖动关键:
  // 1) 位移用 e.movementX/Y(原始鼠标位移,与窗口当前位置无关)做【累积】,而非
  //    e.clientX - startX。后者 clientX 是相对窗口坐标,窗口一旦移动就把「已移动量」算进
  //    位移,在 set_position 的异步 IPC 延迟下形成自反馈振荡 → 抖动。
  // 2) 用 requestAnimationFrame 节流:每帧只发一次 float_drag_move,避免 pointermove 高频
  //    触发大量异步 invoke 堆积造成跳变。
  const dragState = useRef<{
    winX: number;
    winY: number;
    sf: number;
    ready: boolean;
    pointerId: number;
    lastClientX: number;
    lastClientY: number;
  } | null>(null);
  // 拖拽目标窗口位置(设备像素),随 movement 累积;rAF 帧末发给 Rust
  const dragTarget = useRef<{ x: number; y: number } | null>(null);
  const dragRaf = useRef(0);

  const flushDrag = useCallback(() => {
    dragRaf.current = 0;
    const t = dragTarget.current;
    if (t) void invoke("float_drag_move", { x: Math.round(t.x), y: Math.round(t.y) });
  }, []);

  const onTitlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return; // 按钮区不触发拖拽(钉住/关闭点不动)
    e.preventDefault();
    const pid = e.pointerId;
    const el = e.currentTarget;
    // 同步先建占位(记录 pointerId + client 初值),窗口位置/scale 异步取回后 ready
    dragState.current = {
      winX: 0,
      winY: 0,
      sf: 1,
      ready: false,
      pointerId: pid,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
    };
    const win = getCurrentWindow();
    void Promise.all([win.outerPosition(), win.scaleFactor()]).then(([pos, sf]) => {
      const d = dragState.current;
      if (!d) return;
      d.winX = pos.x;
      d.winY = pos.y;
      d.sf = sf;
      d.ready = true;
      dragTarget.current = { x: pos.x, y: pos.y };
    });
    try {
      el.setPointerCapture(pid);
    } catch {
      // 某些环境不支持 pointer capture:降级为无捕获拖拽(光标在浮窗内仍可拖)
    }
  }, [flushDrag]);

  const onTitlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragState.current;
    if (!d || !d.ready) return;
    // movementX/Y 是原始鼠标位移(与窗口位置无关);WebView2 不支持时退回 clientX 增量
    const dx =
      typeof e.movementX === "number" && Number.isFinite(e.movementX)
        ? e.movementX
        : e.clientX - d.lastClientX;
    const dy =
      typeof e.movementY === "number" && Number.isFinite(e.movementY)
        ? e.movementY
        : e.clientY - d.lastClientY;
    d.lastClientX = e.clientX;
    d.lastClientY = e.clientY;
    const t = dragTarget.current ?? { x: d.winX, y: d.winY };
    t.x += dx * d.sf;
    t.y += dy * d.sf;
    dragTarget.current = t;
    if (!dragRaf.current) dragRaf.current = requestAnimationFrame(flushDrag);
  }, [flushDrag]);

  const onTitlePointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragState.current;
    if (!d) return;
    try {
      e.currentTarget.releasePointerCapture(d.pointerId);
    } catch {
      // ignore
    }
    dragState.current = null;
    dragTarget.current = null;
    if (dragRaf.current) {
      cancelAnimationFrame(dragRaf.current);
      dragRaf.current = 0;
    }
  }, []);

  const handleSubmit = useCallback(() => {
    if (input.trim()) {
      void runSummary(input);
    }
  }, [input, runSummary]);

  const handleCopy = useCallback(async () => {
    if (!output) return;
    await invoke("clipboard_write_text", { text: output });
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [output]);

  // 重新生成:用当前输入重新总结(与键盘 ⌘R 一致,不带之前的总结作为上下文)。
  // replace=true → 总结成功后 update 原历史记录(保留原文/标签/收藏),而非新建记录
  const handleRegenerate = useCallback(() => {
    if (!inputRef.current) return;
    void runSummary(inputRef.current, { replace: true });
  }, [runSummary]);

  // 浮窗内「去授权」:对齐 Onboarding 的辅助功能授权流程。
  // macOS 原生弹窗一生只弹一次,弹过/被拒后要回退到系统设置面板,否则点按钮像"没反应"。
  const grantAccessibility = useCallback(async () => {
    setAuthInProgress(true);
    try {
      // 首次会弹系统原生授权窗;之后(用户取消/曾拒绝)不再弹,需走 open_privacy_settings 兜底
      await invoke("request_accessibility");
      let ok = false;
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 500));
        ok = await invoke<boolean>("accessibility_status").catch(() => false);
        if (ok) break;
      }
      if (ok) {
        // 授权成功:清掉 unauthorized 态(红条+按钮消失),用户重新划词即可正常捕获
        setCapture((c) => (c && c.source === "unauthorized" ? { ...c, source: "empty" } : c));
        return;
      }
      // 未授权:打开系统设置 → 隐私与安全性 → 辅助功能,引导手动开启
      await invoke("open_privacy_settings", { kind: "accessibility" }).catch(() => {});
    } catch {
      await invoke("open_privacy_settings", { kind: "accessibility" }).catch(() => {});
    } finally {
      setAuthInProgress(false);
    }
  }, []);

  // 确保当前总结已落库,返回 historyId(收藏/打标签共用;停止后未落库时先手动保存)
  const ensureHistory = useCallback(async (): Promise<number | null> => {
    if (historyId != null) return historyId;
    if (!outputRef.current) return null;
    const c = cfgRef.current;
    // 与 useSummarySession.saveHistory 对齐:落库服务名 = 本次快捷键绑定服务名(未绑定回退默认服务)
    let serviceName = "";
    if (c) {
      const svc = boundServiceId
        ? (c.services?.find((s) => s.id === boundServiceId) ?? getDefaultService(c))
        : getDefaultService(c);
      serviceName = svc?.name ?? "";
    }
    try {
      return await invoke<number>("history_create", {
        sourceText: inputRef.current,
        summary: outputRef.current,
        // 与 useSummarySession.parseOutput 的 summary 分支一致(停止后未走自动落库时的兜底):标题取首行、全量保留不截断
        aiTitle: outputRef.current.split("\n")[0]?.trim() || "总结",
        // 与 useSummarySession.saveHistory 对齐:落库模型 = 本次快捷键绑定模型(未绑定回退默认服务)
        model: boundModel || (c ? getDefaultService(c).model : ""),
        serviceName,
        promptName: "",
        tags: [],
      });
    } catch {
      return null;
    }
  }, [historyId, outputRef, inputRef, cfgRef, boundModel, boundServiceId]);

  // 收藏:真实写入历史收藏标记,并用返回值同步本地状态(图标即时切换)
  const handleFavorite = useCallback(async () => {
    if (!output) return;
    const id = await ensureHistory();
    if (id == null) return;
    try {
      const fav = await invoke<boolean>("history_toggle_favorite", { id });
      setIsFavorite(fav);
    } catch {
      // 忽略
    }
    setFavHint(true);
    setTimeout(() => setFavHint(false), 1500);
  }, [output, ensureHistory]);

  // 切换标签:已打标则移除,否则添加(满 4 个时仅可移除);操作后关闭浮层
  const handleToggleTag = useCallback(
    async (name: string) => {
      const id = await ensureHistory();
      if (id == null) return;
      const has = currentTags.includes(name);
      if (!has && currentTags.length >= MAX_RECORD_TAGS) return;
      const next = has ? currentTags.filter((x) => x !== name) : [...currentTags, name];
      setCurrentTags(next);
      try {
        await invoke("history_update_tags", { id, tags: next });
      } catch {
        // 忽略
      }
      // 不关闭浮层:方便连续多选/移除(关闭由外部点击或 Esc 完成)
    },
    [ensureHistory, currentTags],
  );

  // 回车新建标签:未定义则随机给色;满 4 个时禁止新增;保持浮层打开便于继续添加
  const handleAddTag = useCallback(async () => {
    const name = pickerInput.trim();
    if (!name) return;
    const id = await ensureHistory();
    if (id == null) return;
    if (currentTags.includes(name) || currentTags.length >= MAX_RECORD_TAGS) return;
    if (!allTags.some((d) => d.name === name)) {
      try {
        await invoke("history_create_tag", { name, color: randomTagColor() });
      } catch {
        // 忽略
      }
    }
    const next = [...currentTags, name];
    setCurrentTags(next);
    try {
      await invoke("history_update_tags", { id, tags: next });
    } catch {
      // 忽略
    }
    setPickerInput("");
    setAllTags(await fetchTags());
  }, [pickerInput, ensureHistory, currentTags, allTags]);

  // 打开标签浮层:切换开关 + 刷新标签定义
  const openTagPicker = useCallback(() => {
    setPickerOpen((v) => !v);
    void fetchTags().then(setAllTags);
  }, []);

  // 浮窗三态与固定状态同步到 Rust(托盘/点击外部关闭逻辑使用)
  useEffect(() => {
    const s = state === "streaming" ? 1 : state === "done" ? 2 : state === "error" ? 3 : 0;
    void invoke("float_set_state", { state: s, fixed: pinned });
  }, [state, pinned]);

  // 同步 ref 供键盘监听使用(effect 中而非 render 期间)
  useEffect(() => {
    handleCopyRef.current = handleCopy;
    inputRef.current = input;
    stateRef.current = state;
  }, [handleCopy, input, state]);

  useEffect(() => {
    // 公共面板清空逻辑:重置会话(output/state) + 清空 UI 状态(input/capture/pinned 等)。
    // float-shown(显示时)和 float-hidden(隐藏时)共用 —— 双保险:
    //  - float-hidden 在窗口隐藏后触发,WebView 清空过程用户看不到 → 下次显示时已是空白态(主修复)
    //  - float-shown 在窗口显示时触发,作为兜底(防 float-hidden 时序遗漏)
    const clearPanel = () => {
      resetSession();
      setCapture(null);
      setInput("");
      setPinned(false);
      setCopied(false);
      setFavHint(false);
      setIsFavorite(false);
      setElapsed(0);
      setCurrentTags([]);
      setBoundServiceId(null);
      setShowReasoning(false);
      setPickerOpen(false);
      setPickerInput("");
      setTagSearch("");
    };

    const unlistenCapture = listen<CaptureResult>("capture-result", (event) => {
      setCapture(event.payload);
      setPromptId(event.payload.promptId ?? null);
      setServiceId(event.payload.serviceId ?? null);
      setBoundServiceId(event.payload.serviceId ?? null);
      // 空捕获不清空已有输入:浮窗弹出后自身成为前台应用,AX 可能读到空文本
      // (双保险,配合 Rust 侧 dispatch_capture 的空文本过滤)
      // 未捕获到任何有效文本(含纯空白)时绝不调用大模型接口
      if (!event.payload.text || !event.payload.text.trim()) return;
      setInput(event.payload.text);
      void runSummary(event.payload.text);
    });

    // 快捷键呼出新会话:重置面板(空白输入框),随后 capture-result 再填充
    const unlistenFloatShown = listen<null>("float-shown", () => {
      clearPanel();
    });

    // 窗口隐藏时清空面板:窗口已不可见,清空过程用户看不到。
    // 下次 show_overlay 时 WebView 已是空白态,不会闪现上次内容。
    const unlistenFloatHidden = listen<null>("float-hidden", () => {
      clearPanel();
    });

    // 托盘「粘贴并总结」:显式剪贴板动作,填入输入框并标记来源
    const unlistenTrayPaste = listen<null>("tray-paste", () => {
      void (async () => {
        try {
          const text = await invoke<string>("clipboard_read_text");
          if (text) {
            setCapture({ text, source: "clipboard" });
            setInput(text);
            void runSummary(text);
          }
        } catch {
          // 忽略
        }
      })();
    });

    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleEsc();
        return;
      }
      // 跨平台快捷键:macOS 用 ⌘(metaKey),Windows/Linux 用 Ctrl(ctrlKey)。
      // 键盘地图(设计稿 §10):⌘/Ctrl+C 复制,⌘/Ctrl+R 重新生成,⌘/Ctrl+P 固定。
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === "c") {
          // 仅在有可复制输出时拦截并复制整段输出;否则交给浏览器默认(选中文本复制),
          // 避免「未生成完成时按 Ctrl+C 反而被吞掉、什么都没复制」。
          if (stateRef.current === "done" && outputRef.current) {
            e.preventDefault();
            void handleCopyRef.current();
          }
        } else if (k === "r") {
          // ⌘/Ctrl+R 必须 preventDefault:否则 WebView2 执行默认「刷新页面」→ 浮窗全部数据丢失。
          e.preventDefault();
          // 重新生成:update 原历史记录而非新建
          if (inputRef.current) void runSummary(inputRef.current, { replace: true });
        } else if (k === "p") {
          e.preventDefault();
          setPinned((v) => !v);
        }
      } else if (e.key === "F5") {
        // F5 / Ctrl+F5 同样是刷新:阻止浮窗 WebView 重载丢失数据(与 Ctrl+R 同类风险)。
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", keyHandler);

    return () => {
      void unlistenCapture.then((fn) => fn());
      void unlistenTrayPaste.then((fn) => fn());
      void unlistenFloatShown.then((fn) => fn());
      void unlistenFloatHidden.then((fn) => fn());
      window.removeEventListener("keydown", keyHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSummary, handleEsc, resetSession, setPromptId, setServiceId]);

  const errorKey =
    error?.type === "auth"
      ? "errors.auth"
      : error?.type === "rate_limit"
        ? "errors.rate_limit"
        : error?.type === "network"
          ? "errors.network"
          : "errors.unknown";

  // 标题栏:默认显示当前生效提示词名称;仅生成失败态显示「生成失败」(流式/完成态均显示提示词名)。
  // 此前写死「要点总结」,与历史 promptName 错显同源 —— 现统一由 session.promptName 驱动。
  const title = state === "error" ? t("float.titleError") : promptName || t("float.titleDefault");
  const dotColor =
    state === "streaming" ? "brand" : state === "error" ? "error" : state === "done" ? "success" : "brand";

  // 标题栏展示的「使用模型」= 本次会话实际将调用的模型:
  // 快捷键绑定了具体模型优先(如绑定到某服务的特定模型),否则用当前默认服务模型。
  // cfg 经 config-changed 实时同步,改 AI 服务后立即反映最新默认模型,避免显示陈旧模型。
  const displayModel = boundModel || t("float.notConfiguredModel");

  // 标题栏展示的「AI 服务名称」= 本次会话实际绑定的服务名(快捷键绑定优先,否则默认服务)。
  // 与 displayModel 同款派生:serviceName + model 合并展示为"服务名 · 模型"。
  const displayServiceName = (() => {
    if (!cfg) return "";
    const svc = boundServiceId
      ? (cfg.services?.find((s) => s.id === boundServiceId) ?? getDefaultService(cfg))
      : getDefaultService(cfg);
    return svc?.name ?? "";
  })();

  // 捕获模式标签:selection=划词 / clipboard=托盘粘贴 / history=历史重新生成 / empty=未捕获
  const captureMode =
    capture?.source === "clipboard"
      ? t("float.clipboardMode")
      : capture?.source === "history"
        ? t("float.historyMode")
        : capture?.source === "selection"
          ? t("float.selectionMode")
          : null;

  const canCopy = Boolean(output && state === "done");
  const canRegenerate = Boolean(input && state === "done");
  const canFavorite = Boolean(output && state === "done");

  // 完成态:首行作为标题,全量显示不截断(rb-summary-title 已设 word-break:break-all 可换行)
  const summaryLines = output.split("\n").filter((l) => l.trim());
  const summaryTitle = summaryLines[0]?.trim() ?? "";
  const summaryBody =
    summaryLines.length <= 1 ? output.trim() : summaryLines.slice(1).join("\n");

  return (
    <div className="float-root">
      <div className="rb-float win">
        {/* 自绘标题栏 38px:整条可拖拽(JS + set_position,见 onTitlePointer* 处理器),
            按钮区在处理器内排除,不触发拖拽 */}
        <div
          className="tbar rb-float-tbar"
          onPointerDown={onTitlePointerDown}
          onPointerMove={onTitlePointerMove}
          onPointerUp={onTitlePointerUp}
        >
          <span className={`rb-status-dot rb-status-${dotColor}`} />
          <span className="tbar-title">{title}</span>
          {cfg ? (
            <span className="tag tag-gray">
              {[displayServiceName, displayModel].filter(Boolean).join(" · ")}
            </span>
          ) : null}
          <div style={{ marginLeft: "auto" }} className="rb-tbar-actions">
            <button className="iconbtn" title="固定" onClick={() => setPinned((v) => !v)}>
              <Icon name="pin" className={pinned ? "rb-pinned" : ""} />
            </button>
            <button className="iconbtn" title="关闭" onClick={() => invoke("float_hide")}>
              <Icon name="close" />
            </button>
          </div>
        </div>

        {/* 上半段 划词/输入区:始终存在,捕获文本自动填入,可编辑 */}
        <div className="rb-region">
          <div className="rb-region-label">
            <span className="rb-dot" />
            <span className="rb-region-title">{t("float.regionTitle")}</span>
            {captureMode ? (
              <span className="tag tag-brand rb-capture-mode">{captureMode}</span>
            ) : (
              <span className="rb-region-extra">
                {t("float.regionHint")}
                {summonAccel ? (
                  <span style={{ display: "inline-flex", gap: 4, marginLeft: 6, alignItems: "center" }}>
                    {summonAccel.split("+").map((k, i) => (
                      <span className="kbd" key={`${k}-${i}`}>{keySymbol(k)}</span>
                    ))}
                  </span>
                ) : null}
              </span>
            )}
          </div>

          <textarea
            className="rb-input"
            placeholder={t("float.promptPlaceholder")}
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            rows={2}
            onKeyDown={(e) => {
              // Enter 总结,Shift+Enter 换行(设计稿 §3.2:回车触发总结)
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <div className="rb-input-row">
            <span className={`rb-region-min${capture?.source === "unauthorized" ? " rb-region-warn" : ""}`}>
              {capture?.source === "unauthorized"
                ? t("float.notAuthorized")
                : capture?.source === "empty"
                  ? t("float.emptyCapture")
                  : capture
                    ? t("float.capturedNChars", { n: capture.text.length })
                    : t("float.noCapture")}
            </span>
            {capture?.source === "unauthorized" ? (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => void grantAccessibility()}
                disabled={authInProgress}
              >
                {authInProgress ? t("float.detecting") : t("float.grant")}
              </button>
            ) : null}
            <button className="btn btn-sm btn-primary" onClick={handleSubmit} disabled={!input.trim()}>
              <Icon name="send" size={14} />
              {t("float.send")}
            </button>
          </div>
        </div>

        {/* 下半段 AI 输出区:内容滚动,操作栏始终沉底 */}
        <div className="rb-float-output">
          {/* 耗时读秒:总结中实时递增,完成后停止并保留;显示在展示区右上角(浅灰) */}
          {elapsed > 0 ? <span className="rb-elapsed">{elapsed}s</span> : null}
          <div className="rb-float-output-body">
            {state === "streaming" ? (
              <div className="rb-streaming">
                {/* 标题始终为总结标题/流式文案;思考型模型思考期在标题下方显示灰色小字「思考中......」动画 */}
                <div className="rb-stream-title">
                  {output.split("\n")[0] || t("float.streaming")}
                </div>
                {thinking ? (
                  <>
                    <div className="rb-thinking">
                      <span>{t("float.thinking")}</span>
                      <span className="rb-thinking-dots">
                        {[0, 1, 2, 3, 4, 5].map((i) => (
                          <span key={i} className="rb-thinking-dot" />
                        ))}
                      </span>
                    </div>
                    {reasoning ? (
                      <div className="rb-thinking-stream" ref={thinkingStreamRef}>
                        {reasoning}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="rb-output-text">
                      {output.split("\n").slice(1).join("\n")}
                      <span className="rb-stream-cursor" />
                    </div>
                    <div className="rb-skeleton">
                      <div style={{ width: "100%" }} />
                      <div style={{ width: "82%" }} />
                      <div style={{ width: "54%" }} />
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {state === "done" ? (
              <div className="rb-done">
                <div className="rb-stream-title rb-summary-title">{summaryTitle}</div>
                <div className="rb-output-text rb-summary-body">{summaryBody}</div>
                {/* 思考过程:本次会话的思考内容(不落库),点击展开/收起 */}
                {reasoning ? (
                  <div className="rb-reasoning">
                    <button
                      className="rb-reasoning-toggle"
                      onClick={() => setShowReasoning((v) => !v)}
                    >
                      <span className={`rb-reasoning-arrow${showReasoning ? " open" : ""}`}>▸</span>
                      {t("float.reasoningToggle")}
                    </button>
                    {showReasoning ? <div className="rb-reasoning-body">{reasoning}</div> : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {state === "error" && error ? (
              <div className="rb-error">
                <div className="rb-error-card">
                  <Icon name="alert" style={{ color: "var(--rb-error)", marginTop: 1, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 500, color: "var(--rb-error)", marginBottom: 4 }}>
                      {t(errorKey)}
                    </div>
                    <div className="rb-error-detail">{error.message}</div>
                  </div>
                </div>
                <div className="rb-error-actions">
                  {error.type === "auth" ? (
                    <Button size="sm" variant="primary" onClick={() => invoke("open_settings")}>
                      {t("float.goSettings")}
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => input && void runSummary(input)}>
                      {t("float.retry")}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => invoke("clipboard_write_text", { text: error.message })}>
                    {t("float.copyError")}
                  </Button>
                </div>
                <div className="rb-error-legend">
                  <div>
                    <span style={{ color: "var(--rb-error)" }}>401</span> {t("float.err401")}
                  </div>
                  <div>
                    <span style={{ color: "var(--rb-warning)" }}>429</span> {t("float.err429")}
                  </div>
                  <div>
                    <span className="muted">NET</span> {t("float.errNet")}
                  </div>
                </div>
              </div>
            ) : null}

            {state === "idle" ? <div className="rb-idle-hint">{t("float.promptPlaceholder")}</div> : null}
          </div>

          {/* 操作栏:始终沉底(复制 / 重新生成 / 标签 / 收藏;流式中为停止) */}
          <div className="rb-float-actions">
            {state === "streaming" ? (
              <>
                <span className="rb-region-min">{t("float.generating", { n: output.length })}</span>
                <button className="btn btn-sm btn-secondary" onClick={handleEsc}>
                  {t("float.stop")} <span className="kbd">⌫</span>
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-sm btn-primary" onClick={handleCopy} disabled={!canCopy}>
                  <Icon name="copy" size={14} />
                  {copied ? t("float.copied") : t("float.copy")}
                  <span className="rb-action-kbd">{isMac() ? "Cmd C" : "Ctrl C"}</span>
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={handleRegenerate}
                  disabled={!canRegenerate}
                  title="使用当前输入重新生成总结"
                >
                  <Icon name="refresh" size={14} />
                  {t("float.regenerate")}
                </button>
                <div style={{ marginLeft: "auto" }} className="flex g4">
                  {/* 已选标签:显示在标签功能前方(小号字 + 底部色块,对齐主窗口),点击移除 */}
                  {currentTags.length > 0 ? (
                    <div className="rb-float-selected-tags">
                      {currentTags.map((name) => {
                        const color = tagColorOf(name, allTags);
                        return (
                          <span
                            key={name}
                            className="rb-tag-under"
                            style={{ color: tagTextColor(color) }}
                            title="点击移除标签"
                            onClick={() => void handleToggleTag(name)}
                          >
                            <span>{name}</span>
                            <span className="rb-tag-under-dot" style={{ background: color }} />
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  {/* 标签新增:与主窗口右侧「添加标签」同款浮层(已有标签点选 + 新建输入),置于收藏按钮前 */}
                  <div style={{ position: "relative" }}>
                    <button
                      className="iconbtn"
                      title={t("history.addTag")}
                      onClick={openTagPicker}
                      disabled={!canFavorite}
                    >
                      <Icon name="tag" />
                    </button>
                    {pickerOpen ? (
                      <div className="rb-popover rb-tag-picker rb-tag-picker-up">
                        {/* 顶部:搜索框(查找已有标签,带 x 清除)+ 关闭按钮 */}
                        <div className="rb-tag-picker-search">
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
                          <button
                            className="iconbtn rb-create-tag-close"
                            title={t("history.close")}
                            onClick={() => setPickerOpen(false)}
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                        <div className="rb-tag-picker-list">
                          {(tagSearch.trim()
                            ? allTags.filter((d) =>
                                d.name.toLowerCase().includes(tagSearch.trim().toLowerCase()),
                              )
                            : allTags
                          ).map((def) => {
                            const on = currentTags.includes(def.name);
                            const disabled = !on && currentTags.length >= MAX_RECORD_TAGS;
                            return (
                              <div
                                key={def.name}
                                className={`rb-tag-picker-item${on ? " on" : ""}${disabled ? " disabled" : ""}`}
                                onClick={() => void handleToggleTag(def.name)}
                              >
                                <span
                                  className="rb-tag-dot"
                                  style={{ background: def.color || "var(--rb-neutral-300)" }}
                                />
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
                              currentTags.length >= MAX_RECORD_TAGS
                                ? t("history.maxTags")
                                : t("history.newTagPlaceholder")
                            }
                            value={pickerInput}
                            onChange={(e) => setPickerInput(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void handleAddTag();
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
                  <button
                    className="iconbtn"
                    title={isFavorite ? t("float.unfavTitle") : t("float.favTitle")}
                    onClick={() => void handleFavorite()}
                    disabled={!canFavorite}
                  >
                    <Icon name="favorite" className={isFavorite ? "rb-star" : "rb-star-off"} />
                  </button>
                </div>
              </>
            )}
          </div>
          {favHint ? <div className="rb-toast">{t("float.favorite")} ✓</div> : null}
        </div>
      </div>
    </div>
  );
}
