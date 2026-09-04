import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppConfig, ShortcutConfig } from "../lib/config/types";
import { invoke } from "@tauri-apps/api/core";
import { BUILTIN_PROMPT_OPTIONS } from "../lib/prompts/builtins";
import { resolveShortcutKey, keySymbol } from "../lib/shortcutKey";
import { t, useLanguage } from "../lib/i18n";
import { checkParams, stripJsonComments, DS_CANONICAL_EXTRA } from "../lib/ai/paramsOverride";
import { Icon } from "./Icon";

const SYSTEM_SHORTCUTS = ["Cmd+Space", "Cmd+Tab", "Ctrl+Space"];

/** 拥有「参数覆盖」入口的内置快捷键:划词总结/翻译(deepseek 协议默认关思考) */
const PARAM_ELIGIBLE = new Set(["summarize", "translate"]);

/* 系统快捷键友好名(冲突时说明与什么冲突,设计稿 §3.5) */
const SYSTEM_SHORTCUT_NAMES: Record<string, string> = {
  "Cmd+Space": "shortcuts.sysFocusSearch",
  "Cmd+Tab": "shortcuts.sysAppSwitch",
  "Ctrl+Space": "shortcuts.sysImeSwitch",
};

/* 真正的修饰键(e.key 大写):单独按下时只回显、不提交 */
const MODIFIER_KEYS = new Set(["CONTROL", "SHIFT", "ALT", "META"]);
/* 录制中应忽略、不计入组合的键 */
const IGNORE_KEYS = new Set(["CAPSLOCK", "FN", "FUNCTION", "NUMLOCK"]);

function newScId(): string {
  return `sc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ═══ 内置快捷键(不可删除) ═══ */
interface BuiltinItem {
  id: string;
  name: string;
  desc: string;
  action: string;
  proOnly?: boolean;
  /** 无提示词/模型绑定(如「打开主窗口」这类纯窗口动作) */
  noPrompt?: boolean;
  /** i18n key:内置项名称(替代硬编码 name) */
  nameKey: string;
  /** i18n key:内置项说明(替代硬编码 desc) */
  descKey: string;
}

const BUILTINS: BuiltinItem[] = [
  { id: "open-main", name: "打开主窗口", desc: "显示并聚焦 ReadBrief 主窗口", action: "open-main", noPrompt: true, nameKey: "shortcuts.biOpenMain", descKey: "shortcuts.biOpenMainDesc" },
  { id: "summarize", name: "划词总结", desc: "选中文本后触发内置总结提示词", action: "summarize", nameKey: "shortcuts.biSummarize", descKey: "shortcuts.biSummarizeDesc" },
  { id: "paste", name: "呼出输入框", desc: "粘贴任意文本进行问答", action: "paste", nameKey: "shortcuts.biPaste", descKey: "shortcuts.biPasteDesc" },
  { id: "translate", name: "翻译", desc: "翻译选中内容", action: "prompt", proOnly: true, nameKey: "shortcuts.biTranslate", descKey: "shortcuts.biTranslateDesc" },
];

/* 内置快捷键默认绑定的内置提示词（均允许用户修改） */
const BUILTIN_DEFAULT_PROMPT: Record<string, string> = {
  summarize: "builtin-summarize",
  paste: "builtin-qa",
  translate: "builtin-translate",
};

interface ShortcutsPageProps {
  cfg: AppConfig;
  onConfigChange: (cfg: AppConfig) => void;
}

export function ShortcutsPage({ cfg, onConfigChange }: ShortcutsPageProps) {
  // 订阅语言变更,切语言时即时重渲染
  useLanguage();
  const shortcuts = useMemo(() => cfg.shortcuts ?? [], [cfg.shortcuts]);
  const allPrompts = useMemo(
    () => [...BUILTIN_PROMPT_OPTIONS, ...(cfg.prompts ?? []).filter((p) => !p.isBuiltin)],
    [cfg.prompts],
  );

  /* AI 服务列表(供快捷键「选择 AI 服务」下拉;引用式绑定,模型由服务决定) */
  const services = useMemo(() => {
    const list = cfg.services?.length ? cfg.services : [cfg.api];
    return list.map((s) => ({
      value: s.id ?? "",
      label: `${s.name || s.protocol} · ${s.model}`,
    }));
  }, [cfg]);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const [conflictId, setConflictId] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [confirmDel, setConfirmDel] = useState<{ id: string; name: string } | null>(null);
  /** 参数覆盖编辑态:当前编辑的快捷键 id + 草稿文本(null = 关闭) */
  const [paramsEditing, setParamsEditing] = useState<{ id: string; draft: string } | null>(null);
  /** ? 说明 tooltip(portal 到 body 居中,行内展示会被面板 overflow 裁剪) */
  const [paramsTipOpen, setParamsTipOpen] = useState(false);
  /** 编辑器实时校验:语法错误红 / 保留字段琥珀(与服务页 ParamsOverrideField 同一套) */
  const paramsIssue = paramsEditing ? checkParams(paramsEditing.draft) : null;
  const paramsGutterRef = useRef<HTMLDivElement>(null);
  const recordRef = useRef<HTMLDivElement | null>(null);

  /* ═══ 参数覆盖:动态默认(划词总结/翻译 + deepseek 协议 → 默认关思考) ═══ */
  const serviceProtocol = useCallback(
    (serviceId?: string | null) => {
      const list = cfg.services?.length ? cfg.services : [cfg.api];
      const svc = serviceId
        ? list.find((s) => s.id === serviceId)
        : (list.find((s) => s.isDefault) ?? list[0]);
      return svc?.protocol ?? "";
    },
    [cfg],
  );
  /** deepseek 预填(带注释,随界面语言),供编辑器展示动态默认值 */
  const dsPreset = useMemo(() => {
    const m = t("ai.paramsPresetDsNote");
    const v = t("ai.paramsPresetDsValues");
    return `{\n  // ${m}\n  // ${v}\n  "thinking": { "type": "disabled" }\n}`;
  }, []);
  const effectiveExtraParams = useCallback(
    (id: string, serviceId?: string | null, stored?: string | null) => {
      if (stored && stored.trim()) return stored;
      if (PARAM_ELIGIBLE.has(id) && serviceProtocol(serviceId) === "deepseek") return dsPreset;
      return "";
    },
    [serviceProtocol, dsPreset],
  );
  /** 保存参数:空或等于默认值(剥注释后) → 存 null(动态默认,协议切换自动跟随);否则原样存 */
  function saveExtraParams(id: string, text: string) {
    const stripped = stripJsonComments(text).trim();
    const value = !stripped || stripped === DS_CANONICAL_EXTRA ? null : text;
    const existing = shortcuts.find((s) => s.id === id);
    if (!existing) return;
    const entry: ShortcutConfig = {
      ...existing,
      extraParams: value ?? undefined,
    };
    void save(shortcuts.map((s) => (s.id === id ? entry : s)));
  }

  /* ═══ 合并列表:内置 + 自定义 ═══ */
  const allItems = useCallback(() => {
    const builtin = BUILTINS.map((bi) => {
      const sc = shortcuts.find((s) => s.id === bi.id);
      return {
        id: bi.id,
        name: t(bi.nameKey),
        desc: t(bi.descKey),
        action: bi.action,
        proOnly: bi.proOnly ?? false,
        noPrompt: bi.noPrompt ?? false,
        accelerator: sc?.accelerator ?? "",
        promptId: sc?.promptId ?? BUILTIN_DEFAULT_PROMPT[bi.id] ?? null,
        serviceId: sc?.serviceId ?? "",
        extraParams: sc?.extraParams ?? null,
        isDefault: true,
      };
    });
    const custom = shortcuts
      .filter((s) => !BUILTINS.some((bi) => bi.id === s.id))
      .map((s) => ({
        id: s.id,
        name: s.name ?? s.id,
        desc: s.description ?? "",
        action: s.action,
        proOnly: false,
        noPrompt: false,
        accelerator: s.accelerator ?? "",
        promptId: s.promptId ?? "builtin-summarize",
        serviceId: s.serviceId ?? "",
        extraParams: s.extraParams ?? null,
        isDefault: false,
      }));
    return [...builtin, ...custom];
  }, [shortcuts]);

  const items = allItems();

  useEffect(() => {
    setConflict(null);
    setConflictId(null);
  }, [cfg.shortcuts]);

  /* ═══ 录制区聚焦:Effect 保证在 DOM 提交后才 focus ═══ */
  useEffect(() => {
    if (recordingId) {
      recordRef.current?.focus();
    }
  }, [recordingId]);

  async function save(next: ShortcutConfig[]) {
    const updated: AppConfig = { ...cfg, shortcuts: next };
    await invoke("config_save", { cfg: updated });
    onConfigChange(updated);
  }

  function startRecord(id: string) {
    setRecordingId(id);
    setDraft("");
    setConflict(null);
    setConflictId(null);
  }

  /* 取消录制(不提交):Esc 或录制单元失焦,恢复原有组合 */
  function cancelRecord() {
    setRecordingId(null);
    setDraft("");
  }

  function handleKeyDown(e: React.KeyboardEvent, id: string) {
    if (recordingId !== id) return;
    const key = e.key.toUpperCase();
    // 实体键:Option 下 e.key 被合成死键字符(å/ø/∆),改用 e.code 还原字母/数字
    const physKey = resolveShortcutKey(e);

    // Tab 透传(允许焦点移动,不拦截)
    if (key === "TAB") return;

    // Cmd+W / Cmd+Q:取消录制并透传(避免误关窗口)
    if ((e.metaKey || e.ctrlKey) && (key === "W" || key === "Q")) {
      cancelRecord();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // 纯 Esc:取消录制(不提交)
    if (key === "ESCAPE") {
      cancelRecord();
      return;
    }

    // 纯 Delete/Backspace:清除快捷键绑定并退出录制(Bob 范式)
    if ((key === "DELETE" || key === "BACKSPACE") && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      clearShortcut(id);
      return;
    }

    // 忽略 CapsLock 等无意义键
    if (IGNORE_KEYS.has(key)) return;

    // 实时构建当前组合(含已按修饰键 + 当前非修饰键),用于录制中即时回显
    const parts: string[] = [];
    if (e.metaKey) parts.push("Cmd");
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (!MODIFIER_KEYS.has(physKey)) parts.push(physKey);
    const live = parts.join("+");
    setDraft(live);

    // 单独修饰键只回显、不提交
    if (MODIFIER_KEYS.has(physKey)) return;

    setRecordingId(null);
    setDraft("");

    if (SYSTEM_SHORTCUTS.includes(live)) {
      const sysName = t(SYSTEM_SHORTCUT_NAMES[live] ?? "shortcuts.sysOther");
      setConflict(t("shortcuts.conflictSystem", { name: sysName }));
      setConflictId(id);
      return;
    }
    const other = shortcuts.find((s) => s.id !== id && s.accelerator === live);
    if (other) {
      const name = other.name || other.id;
      setConflict(t("shortcuts.conflictOther", { name }));
      setConflictId(id);
      return;
    }
    setConflict(null);
    setConflictId(null);

    const item = items.find((it) => it.id === id);
    const existing = shortcuts.find((s) => s.id === id);
    const promptId = existing?.promptId ?? item?.promptId ?? null;
    const entry: ShortcutConfig = {
      id,
      accelerator: live,
      action: promptId ? "prompt" : (item?.action ?? "summarize"),
      promptId,
      serviceId: existing?.serviceId,
      extraParams: existing?.extraParams,
      name: item?.name,
      description: item?.desc,
      isDefault: item?.isDefault ?? false,
    };
    void save(
      existing
        ? shortcuts.map((s) => (s.id === id ? entry : s))
        : [...shortcuts, entry],
    );
  }

  function handleKeyUp(e: React.KeyboardEvent, id: string) {
    if (recordingId !== id) return;
    if (e.key.toUpperCase() === "TAB") return;
    e.preventDefault();
    e.stopPropagation();
    // 松开按键后仅保留当前仍按下的修饰键,回显实时组合
    const parts: string[] = [];
    if (e.metaKey) parts.push("Cmd");
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    setDraft(parts.join("+"));
  }

  /* 清除快捷键绑定:accelerator 置空,条目保留为空态待录制(内置/自定义均适用) */
  function clearShortcut(id: string) {
    setRecordingId(null);
    setDraft("");
    setConflict(null);
    setConflictId(null);
    const existing = shortcuts.find((s) => s.id === id);
    if (!existing) return; // 尚未绑定,无需处理
    const item = items.find((it) => it.id === id);
    const entry: ShortcutConfig = {
      id,
      accelerator: "",
      action: existing.action ?? item?.action ?? "summarize",
      promptId: existing.promptId ?? item?.promptId ?? null,
      serviceId: existing.serviceId,
      extraParams: existing.extraParams,
      name: item?.name,
      description: item?.desc,
      isDefault: item?.isDefault ?? false,
    };
    void save(shortcuts.map((s) => (s.id === id ? entry : s)));
  }

  function handlePromptChange(id: string, promptId: string | null) {
    const existing = shortcuts.find((s) => s.id === id);
    const item = items.find((it) => it.id === id);
    const entry: ShortcutConfig = {
      id,
      accelerator: existing?.accelerator ?? "",
      action: promptId ? "prompt" : (item?.action ?? "summarize"),
      promptId,
      serviceId: existing?.serviceId,
      extraParams: existing?.extraParams,
      name: item?.name,
      description: item?.desc,
      isDefault: item?.isDefault ?? false,
    };
    void save(
      existing
        ? shortcuts.map((s) => (s.id === id ? entry : s))
        : [...shortcuts, entry],
    );
  }

  function handleServiceChange(id: string, serviceId: string) {
    const existing = shortcuts.find((s) => s.id === id);
    const item = items.find((it) => it.id === id);
    const promptId = existing?.promptId ?? item?.promptId ?? null;
    const entry: ShortcutConfig = {
      id,
      accelerator: existing?.accelerator ?? "",
      action: promptId ? "prompt" : (existing?.action ?? item?.action ?? "summarize"),
      promptId,
      serviceId: serviceId || undefined,
      // 参数动态默认按「id + 协议」在展示/发送端计算,切换服务无需改写存储值
      extraParams: existing?.extraParams,
      name: item?.name,
      description: item?.desc,
      isDefault: item?.isDefault ?? false,
    };
    void save(
      existing
        ? shortcuts.map((s) => (s.id === id ? entry : s))
        : [...shortcuts, entry],
    );
  }

  function handleDelete(id: string) {
    void save(shortcuts.filter((s) => s.id !== id));
  }

  function handleAdd() {
    if (!newName.trim()) return;
    const id = newScId();
    void save([
      ...shortcuts,
      {
        id,
        accelerator: "",
        action: "summarize",
        promptId: null,
        name: newName.trim(),
        description: newDesc.trim(),
        isDefault: false,
      },
    ]);
    setShowDialog(false);
    setNewName("");
    setNewDesc("");
  }

  /* ═══ 冲突态的录制品项 id(录制冲突时记为该条目) ═══ */
  const conflictItemId = conflictId;

  return (
    <div>
      {/* 标题栏 */}
      <div className="flex ac jb g16" style={{ marginBottom: 8 }}>
        <div>
          <div className="rb-settings-title" style={{ fontSize: "var(--rb-text-2xl)", fontWeight: 600 }}>
            {t("shortcuts.title")}
          </div>
          <div className="muted" style={{ fontSize: "var(--rb-text-xs)", marginTop: 3 }}>
            {t("shortcuts.subtitle")}
          </div>
        </div>
        <button
          className="btn btn-sm btn-secondary"
          onClick={() => {
            setNewName("");
            setNewDesc("");
            setShowDialog(true);
          }}
        >
          <Icon name="plus" size={14} />
          {t("shortcuts.add")}
        </button>
      </div>

      {/* 快捷键列表 */}
      <div className="rb-settings-card">
        {items.map((item) => {
          const bound = Boolean(item.accelerator);
          const isRecording = recordingId === item.id;
          const isConflictRow = conflictItemId === item.id;

          return (
            <div
              key={item.id}
              className={`rb-setting-row rb-shortcut-row${isConflictRow ? " rb-conflict" : ""}`}
            >
              {/* 第一行：名称（内置/PRO 标签）+ 说明，行尾固定删除按钮（仅自定义） */}
              <div className="flex ac jb g16">
                <div className="flex ac g8">
                  <div className="rb-shortcut-name">
                    {item.isDefault ? (
                      <span className="tag tag-gray" style={{ fontSize: 10 }}>
                        {t("shortcuts.builtin")}
                      </span>
                    ) : null}
                    {item.name}
                  </div>
                  <div className="rb-shortcut-desc">
                    {isConflictRow ? (
                      <span style={{ color: "var(--rb-error)" }}>{conflict}</span>
                    ) : (
                      item.desc
                    )}
                  </div>
                </div>
                {!item.isDefault ? (
                  <button
                    className="iconbtn"
                    title={t("shortcuts.confirmDelete", { name: item.name })}
                    onClick={() => setConfirmDel({ id: item.id, name: item.name })}
                    style={{ color: "var(--rb-error)", opacity: 0.65 }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                ) : null}
              </div>

              {/* 第二行：录制区靠左，提示词/模型下拉靠右 */}
              <div className="flex ac jb g16">
                <div className="flex ac g4">
                  {/* 单一录制场(Bob/MASShortcut 范式):三态统一,右侧 hint 区常驻 */}
                  <div
                    ref={isRecording ? recordRef : undefined}
                    className={`rb-recorder ${
                      isRecording
                        ? "rb-recorder--recording"
                        : bound
                          ? "rb-recorder--bound"
                          : "rb-recorder--empty"
                    }${isConflictRow ? " rb-recorder--conflict" : ""}`}
                    tabIndex={0}
                    role="button"
                    title={bound ? t("shortcuts.reopenRecord") : t("shortcuts.record")}
                    onClick={() => {
                      if (!isRecording) startRecord(item.id);
                    }}
                    onKeyDown={(e) => handleKeyDown(e, item.id)}
                    onKeyUp={(e) => handleKeyUp(e, item.id)}
                    onBlur={() => cancelRecord()}
                  >
                      {/* 主区:空态 CTA / 绑定态键帽 / 录制态回显 */}
                      <span className="rb-recorder-main">
                        {isRecording ? (
                          <>
                            <span className="rb-recorder-dot" />
                            {draft ? (
                              <span className="rb-recorder-combo">
                                {draft.split("+").map(keySymbol).join("")}
                              </span>
                            ) : (
                              <span className="rb-recorder-wait">{t("shortcuts.waitKey")}</span>
                            )}
                          </>
                        ) : bound ? (
                          item.accelerator.split("+").map((k) => (
                            <span className="kbd" key={k}>
                              {keySymbol(k)}
                            </span>
                          ))
                        ) : (
                          <>
                            <Icon name="plus" size={13} />
                            {t("shortcuts.clickRecord")}
                          </>
                        )}
                      </span>
                      {/* hint 区:录制态显示 Esc 取消,绑定态显示 ✕ 清除 */}
                      {isRecording ? (
                        <span
                          className="rb-recorder-hint"
                          title={t("shortcuts.escCancel")}
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelRecord();
                          }}
                        >
                          Esc
                        </span>
                      ) : bound ? (
                        <span
                          className="rb-recorder-hint"
                          title={t("shortcuts.clear")}
                          onClick={(e) => {
                            e.stopPropagation();
                            clearShortcut(item.id);
                          }}
                        >
                          <Icon name="close" size={12} />
                        </span>
                      ) : null}
                    </div>
                </div>

                <div className="flex ac g6">
                  {/* 提示词绑定 / 模型下拉:纯窗口类动作(如「打开主窗口」)无此选项 */}
                  {!item.noPrompt && (
                    <>
                      {/* 提示词绑定下拉(始终显示,默认绑定内置提示词,均可在下拉中修改) */}
                      <select
                        className="rb-sc-prompt-select"
                        value={item.promptId ?? ""}
                        onChange={(e) => handlePromptChange(item.id, e.target.value || null)}
                      >
                        {allPrompts.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>

                      {/* AI 服务下拉(引用式:选服务即选其模型,改服务配置后快捷键自动跟随) */}
                      {services.length > 0 ? (
                        <select
                          className="rb-sc-prompt-select rb-sc-model-select"
                          value={item.serviceId ?? ""}
                          onChange={(e) => handleServiceChange(item.id, e.target.value)}
                        >
                          <option value="">{t("shortcuts.defaultService")}</option>
                          {services.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      ) : null}

                      {/* 参数覆盖入口:所有 AI 类快捷键均提供;留空时 deepseek 总结/翻译动态默认关思考;有显式自定义时加标记点 */}
                      <button
                        className="btn btn-sm btn-secondary"
                        style={{ position: "relative" }}
                        onClick={() =>
                          setParamsEditing({
                            id: item.id,
                            draft: effectiveExtraParams(item.id, item.serviceId, item.extraParams),
                          })
                        }
                      >
                        {t("ai.params")}
                        {item.extraParams?.trim() ? (
                          <span
                            style={{
                              position: "absolute",
                              top: 3,
                              right: 3,
                              width: 5,
                              height: 5,
                              borderRadius: "50%",
                              background: "var(--rb-accent, #4b4bc8)",
                            }}
                          />
                        ) : null}
                      </button>
                      {/* 注意:不能复用 .rb-seg 类名 —— App.css:715 历史规则会把 ? 拉成椭圆 */}
                      <span
                        onMouseEnter={() => setParamsTipOpen(true)}
                        onMouseLeave={() => setParamsTipOpen(false)}
                      >
                        <span className="rb-q">?</span>
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 冲突提示 */}
      {conflict ? (
        <div className="rb-byok-note rb-conflict-note">
          <Icon name="alert" style={{ color: "var(--rb-error)", flexShrink: 0 }} />
          <div style={{ color: "var(--rb-error)" }}>{conflict}</div>
        </div>
      ) : null}

      {showDialog ? (
        <div className="rb-overlay" onClick={() => setShowDialog(false)}>
          <div
            className="rb-dialog"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowDialog(false);
            }}
          >
              <div className="rb-dialog-hd">
                <div className="flex ac g9">
                  <span className="rb-dialog-mark">
                    <Icon name="plus" size={14} />
                  </span>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: "var(--rb-text-sm)" }}>{t("shortcuts.recTitle")}</div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {t("shortcuts.recHint")}
                    </div>
                  </div>
                </div>
                <button className="iconbtn" onClick={() => setShowDialog(false)}>
                  <Icon name="close" size={14} />
                </button>
              </div>

              <div className="rb-dialog-body">
                <div className="set-row">
                  <div className="rb-setting-label">{t("shortcuts.nameLabel")}</div>
                  <input
                    className="inp"
                    style={{ width: "100%", maxWidth: 260 }}
                    placeholder={t("shortcuts.namePlaceholder")}
                    value={newName}
                    onChange={(e) => setNewName(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAdd();
                    }}
                    autoFocus
                  />
                </div>
                <div className="set-row">
                  <div className="rb-setting-label">{t("shortcuts.descLabel")}</div>
                  <input
                    className="inp"
                    style={{ width: "100%", maxWidth: 260 }}
                    placeholder={t("shortcuts.descPlaceholder")}
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAdd();
                    }}
                  />
                </div>
              </div>

              <div className="rb-dialog-foot">
                <button className="btn btn-sm btn-secondary" onClick={() => setShowDialog(false)}>
                  {t("prompts.cancel")}
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleAdd}
                  disabled={!newName.trim()}
                >
                  {t("shortcuts.add")}
                </button>
              </div>
          </div>
        </div>
      ) : null}

      {confirmDel ? (
        <div className="rb-overlay" onClick={() => setConfirmDel(null)}>
          <div
            className="rb-dialog"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setConfirmDel(null);
            }}
          >
              <div className="rb-dialog-hd">
                <div className="flex ac g9">
                  <span className="rb-dialog-mark">
                    <Icon name="trash" size={14} />
                  </span>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: "var(--rb-text-sm)" }}>{t("shortcuts.deleteTitle")}</div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{t("shortcuts.deleteDesc")}</div>
                  </div>
                </div>
                <button className="iconbtn" onClick={() => setConfirmDel(null)}>
                  <Icon name="close" size={14} />
                </button>
              </div>
              <div className="rb-dialog-body">
                <div className="rb-confirm-msg">{t("shortcuts.confirmDelete", { name: confirmDel.name })}</div>
              </div>
              <div className="rb-dialog-foot">
                <button className="btn btn-sm btn-ghost" onClick={() => setConfirmDel(null)}>
                  {t("prompts.cancel")}
                </button>
                <button
                  className="btn btn-sm rb-confirm-del"
                  onClick={() => {
                    const id = confirmDel.id;
                    setConfirmDel(null);
                    handleDelete(id);
                  }}
                >
                  {t("prompts.delete")}
                </button>
              </div>
          </div>
        </div>
      ) : null}
      {/* 参数覆盖放大编辑器:portal 到 body,行号 + 大面积输入(与 AiServicesPage 同款样式) */}
      {paramsEditing
        ? createPortal(
            <div
              className="rb-params-zoom-overlay"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setParamsEditing(null);
              }}
            >
              <div className="rb-params-zoom">
                <div className="rb-params-zoom-hd">
                  <span>{t("shortcuts.paramsTitle")}</span>
                  <button className="iconbtn" onClick={() => setParamsEditing(null)}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <div className="rb-params-zoom-body">
                  <div className="rb-params-zoom-gutter" ref={paramsGutterRef}>
                    {paramsEditing.draft.split("\n").map((_, i) => (
                      <div key={i}>{i + 1}</div>
                    ))}
                  </div>
                  <textarea
                    className="rb-params-zoom-input"
                    spellCheck={false}
                    value={paramsEditing.draft}
                    placeholder={t("shortcuts.paramsPlaceholder")}
                    onChange={(e) =>
                      setParamsEditing({ ...paramsEditing, draft: e.currentTarget.value })
                    }
                    onScroll={(e) => {
                      if (paramsGutterRef.current) {
                        paramsGutterRef.current.scrollTop = e.currentTarget.scrollTop;
                      }
                    }}
                  />
                </div>
                <div className="rb-params-zoom-ft">
                  {paramsIssue ? (
                    <span className={paramsIssue.level === "error" ? "rb-svc-params-err" : "rb-svc-params-warn"}>
                      {paramsIssue.text}
                    </span>
                  ) : (
                    <span className="muted rb-svc-params-note" style={{ fontSize: 11 }}>
                      {t("shortcuts.paramsHint")}
                    </span>
                  )}
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      saveExtraParams(paramsEditing.id, paramsEditing.draft);
                      setParamsEditing(null);
                    }}
                  >
                    {t("ai.paramsZoomDone")}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {/* ? 说明 tooltip:portal 到 body,画面居中显示(与 AiServicesPage 同款) */}
      {paramsTipOpen
        ? createPortal(<div className="rb-params-tip-fixed">{t("ai.paramsTip")}</div>, document.body)
        : null}
    </div>
  );
}
