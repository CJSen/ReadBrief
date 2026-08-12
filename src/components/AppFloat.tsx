import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getDefaultService } from "../lib/config/types";
import { t } from "../lib/i18n";
import { useConfig } from "../lib/config/useConfig";
import { useSummarySession } from "../lib/ai/useSummarySession";
import { Button } from "./Button";
import { Icon } from "./Icon";

interface CaptureResult {
  text: string;
  source: string;
  promptId?: string | null;
  model?: string | null;
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
  const [capture, setCapture] = useState<CaptureResult | null>(null);
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
  const pickerInputRef = useRef<HTMLInputElement>(null);

  const { cfg, ref: cfgRef } = useConfig();
  const {
    output,
    state,
    error,
    historyId,
    run: runSummary,
    stop,
    reset: resetSession,
    outputRef,
    setPromptId,
    setModelId,
  } = useSummarySession(cfgRef);

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

  // 确保当前总结已落库,返回 historyId(收藏/打标签共用;停止后未落库时先手动保存)
  const ensureHistory = useCallback(async (): Promise<number | null> => {
    if (historyId != null) return historyId;
    if (!outputRef.current) return null;
    try {
      return await invoke<number>("history_create", {
        sourceText: inputRef.current,
        summary: outputRef.current,
        // 与 useSummarySession.splitTitleBody 一致:标题全量保留,不截断
        aiTitle: outputRef.current.split("\n")[0]?.trim() || "总结",
        model: cfgRef.current ? getDefaultService(cfgRef.current).model : "",
        promptName: "",
        tags: [],
      });
    } catch {
      return null;
    }
  }, [historyId, outputRef, inputRef, cfgRef]);

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
      setPickerOpen(false);
      setPickerInput("");
      setTagSearch("");
    };

    const unlistenCapture = listen<CaptureResult>("capture-result", (event) => {
      setCapture(event.payload);
      setPromptId(event.payload.promptId ?? null);
      setModelId(event.payload.model ?? null);
      // 空捕获不清空已有输入:浮窗弹出后自身成为前台应用,AX 可能读到空文本
      // (双保险,配合 Rust 侧 dispatch_capture 的空文本过滤)
      if (!event.payload.text) return;
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
      // 键盘地图(设计稿 §10):⌘C 复制,⌘R 重新生成,⌘P 固定
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (e.key.toLowerCase() === "c") {
          e.preventDefault();
          if (stateRef.current === "done" && outputRef.current) {
            void handleCopyRef.current();
          }
        } else if (e.key.toLowerCase() === "r") {
          e.preventDefault();
          // ⌘R 重新生成:update 原历史记录而非新建
          if (inputRef.current) void runSummary(inputRef.current, { replace: true });
        } else if (e.key.toLowerCase() === "p") {
          e.preventDefault();
          setPinned((v) => !v);
        }
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
  }, [runSummary, handleEsc, resetSession, setPromptId, setModelId]);

  const errorKey =
    error?.type === "auth"
      ? "errors.auth"
      : error?.type === "rate_limit"
        ? "errors.rate_limit"
        : error?.type === "network"
          ? "errors.network"
          : "errors.unknown";

  const title = state === "streaming" ? t("float.streaming") : state === "error" ? "生成失败" : "要点总结";
  const dotColor =
    state === "streaming" ? "brand" : state === "error" ? "error" : state === "done" ? "success" : "brand";

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

  // 标题栏拖拽：调用 Tauri start_dragging() 实现系统级窗口拖动
  const handleTitleBarMouseDown = useCallback((e: React.MouseEvent) => {
    // 仅在鼠标左键按下且未点在按钮/可交互元素上时触发拖拽
    const target = e.target as HTMLElement;
    if (e.button === 0 && target.tagName !== "BUTTON" && !target.closest("button")) {
      void invoke("float_start_drag");
    }
  }, []);

  // 完成态:首行作为标题,全量显示不截断(rb-summary-title 已设 word-break:break-all 可换行)
  const summaryLines = output.split("\n").filter((l) => l.trim());
  const summaryTitle = summaryLines[0]?.trim() ?? "";
  const summaryBody =
    summaryLines.length <= 1 ? output.trim() : summaryLines.slice(1).join("\n");

  return (
    <div className="float-root">
      <div className="rb-float win">
        {/* 自绘标题栏 38px */}
        <div className="tbar rb-float-tbar" onMouseDown={handleTitleBarMouseDown}>
          <span className={`rb-status-dot rb-status-${dotColor}`} />
          <span className="tbar-title">{title}</span>
          {cfg ? <span className="tag tag-gray">{getDefaultService(cfg).model || "未配置模型"}</span> : null}
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
            <span className="rb-region-title">划词 / 输入区</span>
            {captureMode ? (
              <span className="tag tag-brand rb-capture-mode">{captureMode}</span>
            ) : (
              <span className="rb-region-extra">⌘+Shift+Z 划词</span>
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
            <span className="rb-region-min">
              {capture?.source === "unauthorized"
                ? "未授权辅助功能 · 划词捕获不可用"
                : capture?.source === "empty"
                  ? "未捕获到选中文本 · 可直接粘贴或输入"
                  : capture
                    ? `已捕获 ${capture.text.length} 字`
                    : "未捕获划词 · 直接粘贴文本"}
            </span>
            {capture?.source === "unauthorized" ? (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => void invoke("request_accessibility")}
              >
                去授权
              </button>
            ) : null}
            <button className="btn btn-sm btn-primary" onClick={handleSubmit} disabled={!input.trim()}>
              <Icon name="send" size={14} />
              发送
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
                <div className="rb-stream-title">{output.split("\n")[0] || "总结中…"}</div>
                <div className="rb-output-text">
                  {output.split("\n").slice(1).join("\n")}
                  <span className="rb-stream-cursor" />
                </div>
                <div className="rb-skeleton">
                  <div style={{ width: "100%" }} />
                  <div style={{ width: "82%" }} />
                  <div style={{ width: "54%" }} />
                </div>
              </div>
            ) : null}

            {state === "done" ? (
              <div className="rb-done">
                <div className="rb-stream-title rb-summary-title">{summaryTitle}</div>
                <div className="rb-output-text rb-summary-body">{summaryBody}</div>
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
                    复制错误详情
                  </Button>
                </div>
                <div className="rb-error-legend">
                  <div>
                    <span style={{ color: "var(--rb-error)" }}>401</span> 鉴权失败
                  </div>
                  <div>
                    <span style={{ color: "var(--rb-warning)" }}>429</span> 限流/额度
                  </div>
                  <div>
                    <span className="muted">NET</span> 网络异常
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
                <span className="rb-region-min">已生成 {output.length} 字</span>
                <button className="btn btn-sm btn-secondary" onClick={handleEsc}>
                  停止 <span className="kbd">⌫</span>
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-sm btn-primary" onClick={handleCopy} disabled={!canCopy}>
                  <Icon name="copy" size={14} />
                  {copied ? t("float.copied") : t("float.copy")}
                  <span className="rb-action-kbd">⌘C</span>
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={handleRegenerate}
                  disabled={!canRegenerate}
                  title="使用当前输入重新生成总结"
                >
                  <Icon name="refresh" size={14} />
                  重新生成
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
                    title={isFavorite ? "取消收藏" : "收藏"}
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
