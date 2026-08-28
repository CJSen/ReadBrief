import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig, ShortcutConfig } from "../lib/config/types";
import { invoke } from "@tauri-apps/api/core";
import { BUILTIN_PROMPT_OPTIONS } from "../lib/prompts/builtins";
import { resolveShortcutKey, keySymbol } from "../lib/shortcutKey";
import { t, useLanguage } from "../lib/i18n";
import { Icon } from "./Icon";

const SYSTEM_SHORTCUTS = ["Cmd+Space", "Cmd+Tab", "Ctrl+Space"];

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
  { id: "screenshot-ocr", name: "截图 OCR 总结", desc: "截取屏幕区域后 OCR 识别并总结", action: "screenshot-ocr", nameKey: "shortcuts.biScreenshotOcr", descKey: "shortcuts.biScreenshotOcrDesc" },
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
  const [newAction, setNewAction] = useState<"summarize" | "screenshot-ocr">("summarize");
  const [confirmDel, setConfirmDel] = useState<{ id: string; name: string } | null>(null);
  const recordRef = useRef<HTMLDivElement | null>(null);

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
    const action = resolveAction(item, existing, promptId);
    const entry: ShortcutConfig = {
      id,
      accelerator: live,
      action,
      promptId,
      serviceId: existing?.serviceId,
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

  /**
   * 保留原始 action：
   * - 内置项（如 summarize/screenshot-ocr/paste/open-main）保留原始 action
   * - 用户自定义的截图 OCR 类型也保留 screenshot-ocr action
   * - 其他自定义项：有提示词时用 "prompt"，否则用默认
   */
  function resolveAction(item: { action: string; isDefault: boolean } | undefined, existing: ShortcutConfig | undefined, promptId: string | null): string {
    if (item?.isDefault && item.action !== "prompt") {
      return item.action;
    }
    if (existing?.action === "screenshot-ocr") {
      return "screenshot-ocr";
    }
    return promptId ? "prompt" : (item?.action ?? "summarize");
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
      name: item?.name,
      description: item?.desc,
      isDefault: item?.isDefault ?? false,
    };
    void save(shortcuts.map((s) => (s.id === id ? entry : s)));
  }

  function handlePromptChange(id: string, promptId: string | null) {
    const existing = shortcuts.find((s) => s.id === id);
    const item = items.find((it) => it.id === id);
    const action = resolveAction(item, existing, promptId);
    const entry: ShortcutConfig = {
      id,
      accelerator: existing?.accelerator ?? "",
      action,
      promptId,
      serviceId: existing?.serviceId,
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
    const action = resolveAction(item, existing, promptId);
    const entry: ShortcutConfig = {
      id,
      accelerator: existing?.accelerator ?? "",
      action,
      promptId,
      serviceId: serviceId || undefined,
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
        action: newAction,
        promptId: null,
        name: newName.trim(),
        description: newDesc.trim(),
        isDefault: false,
      },
    ]);
    setShowDialog(false);
    setNewName("");
    setNewDesc("");
    setNewAction("summarize");
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
                  <div className="rb-setting-label">{t("shortcuts.typeLabel")}</div>
                  <select
                    className="rb-dialog-select"
                    value={newAction}
                    onChange={(e) => setNewAction(e.currentTarget.value as "summarize" | "screenshot-ocr")}
                  >
                    <option value="summarize">{t("shortcuts.typeSelection")}</option>
                    <option value="screenshot-ocr">{t("shortcuts.typeOcr")}</option>
                  </select>
                </div>
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
    </div>
  );
}
