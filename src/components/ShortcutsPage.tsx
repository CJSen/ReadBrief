import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig, ShortcutConfig } from "../lib/config/types";
import { invoke } from "@tauri-apps/api/core";
import { FREE_SHORTCUT_LIMIT } from "../lib/license";
import { useLicense } from "../lib/license/useLicense";
import { BUILTIN_PROMPT_OPTIONS } from "../lib/prompts/builtins";
import { Icon } from "./Icon";

const SYSTEM_SHORTCUTS = ["Cmd+Space", "Cmd+Tab", "Ctrl+Space", "Cmd+Shift+Z"];

const MODIFIER_KEYS = new Set(["CONTROL", "SHIFT", "ALT", "META", "ESCAPE", "CAPSLOCK", "TAB"]);

/* ═══ 修饰键符号显示(对齐设计稿:⌥⌘⇧⌃) ═══ */
const MOD_SYMBOLS: Record<string, string> = {
  CMD: "⌘",
  CTRL: "⌃",
  ALT: "⌥",
  SHIFT: "⇧",
};

function keySymbol(k: string): string {
  if (!k || k === " ") return "Space";
  return MOD_SYMBOLS[k.toUpperCase()] ?? k;
}

/* 键帽尺寸(设计稿:26×26) */
const KBD_STYLE = { height: 26, minWidth: 26 } as const;

function parseShortcut(e: React.KeyboardEvent): string {
  const key = e.key.toUpperCase();
  if (MODIFIER_KEYS.has(key)) return "";
  const parts: string[] = [];
  if (e.metaKey) parts.push("Cmd");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

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
}

const BUILTINS: BuiltinItem[] = [
  { id: "summarize", name: "划词总结", desc: "选中文本后触发默认提示词", action: "summarize" },
  { id: "paste", name: "呼出输入框", desc: "粘贴任意文本进行总结", action: "paste" },
  { id: "translate", name: "翻译并总结", desc: "翻译后总结选中内容", action: "prompt", proOnly: true },
  { id: "toggle-float", name: "显示/隐藏浮窗", desc: "快速呼出或关闭总结浮窗", action: "toggle-float" },
];

interface ShortcutsPageProps {
  cfg: AppConfig;
  onConfigChange: (cfg: AppConfig) => void;
}

export function ShortcutsPage({ cfg, onConfigChange }: ShortcutsPageProps) {
  const shortcuts = useMemo(() => cfg.shortcuts ?? [], [cfg.shortcuts]);
  const allPrompts = useMemo(
    () => [...BUILTIN_PROMPT_OPTIONS, ...(cfg.prompts ?? []).filter((p) => !p.isBuiltin)],
    [cfg.prompts],
  );

  /* AI 服务模型列表(来自已配置的服务) */
  const models = useMemo(() => {
    const services = cfg.services?.length ? cfg.services : [cfg.api];
    return services.map((s) => ({
      value: s.model,
      label: `${s.name || s.protocol} · ${s.model}`,
    }));
  }, [cfg]);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const recordRef = useRef<HTMLDivElement | null>(null);

  const license = useLicense(cfg);
  const pro = license.pro;

  const boundCount = shortcuts.filter((s) => s.accelerator).length;
  const lockAll = !(pro || boundCount < FREE_SHORTCUT_LIMIT);

  /* ═══ 合并列表:内置 + 自定义 ═══ */
  const allItems = useCallback(() => {
    const builtin = BUILTINS.map((bi) => {
      const sc = shortcuts.find((s) => s.id === bi.id);
      return {
        id: bi.id,
        name: bi.name,
        desc: bi.desc,
        action: bi.action,
        proOnly: bi.proOnly ?? false,
        accelerator: sc?.accelerator ?? "",
        promptId: sc?.promptId ?? null,
        model: sc?.model ?? "",
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
        accelerator: s.accelerator ?? "",
        promptId: s.promptId ?? null,
        model: s.model ?? "",
        isDefault: false,
      }));
    return [...builtin, ...custom];
  }, [shortcuts]);

  const items = allItems();

  useEffect(() => {
    setConflict(null);
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
  }

  function handleKeyDown(e: React.KeyboardEvent, id: string) {
    if (recordingId !== id) return;
    e.preventDefault();
    e.stopPropagation();
    const combo = parseShortcut(e);
    if (!combo) return;
    setDraft(combo);
    setRecordingId(null);

    if (SYSTEM_SHORTCUTS.includes(combo)) {
      setConflict(`与系统「${combo}」冲突，请改用其他组合`);
      return;
    }
    const other = shortcuts.find((s) => s.id !== id && s.accelerator === combo);
    if (other) {
      const name = other.name || other.id;
      setConflict(`与「${name}」快捷键冲突，请改用其他组合`);
      return;
    }
    setConflict(null);

    const item = items.find((it) => it.id === id);
    const existing = shortcuts.find((s) => s.id === id);
    const entry: ShortcutConfig = {
      id,
      accelerator: combo,
      action: item?.action ?? "summarize",
      promptId: existing?.promptId ?? item?.promptId ?? null,
      model: existing?.model,
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

  function handlePromptChange(id: string, promptId: string | null) {
    const existing = shortcuts.find((s) => s.id === id);
    const item = items.find((it) => it.id === id);
    const entry: ShortcutConfig = {
      id,
      accelerator: existing?.accelerator ?? "",
      action: promptId ? "prompt" : (item?.action ?? "summarize"),
      promptId,
      model: existing?.model,
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

  function handleModelChange(id: string, model: string) {
    const existing = shortcuts.find((s) => s.id === id);
    const item = items.find((it) => it.id === id);
    const entry: ShortcutConfig = {
      id,
      accelerator: existing?.accelerator ?? "",
      action: existing?.action ?? item?.action ?? "summarize",
      promptId: existing?.promptId ?? item?.promptId ?? null,
      model: model || undefined,
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

  /* ═══ 冲突态的录制品项 id ═══ */
  const conflictItemId = conflict
    ? items.find((it) => {
        const sc = shortcuts.find((s) => s.id === it.id);
        return sc?.accelerator && conflict.includes(it.name);
      })?.id
    : null;

  return (
    <div>
      {/* 标题栏 */}
      <div className="flex ac jb g16" style={{ marginBottom: 8 }}>
        <div>
          <div className="rb-settings-title" style={{ fontSize: "var(--rb-text-2xl)", fontWeight: 600 }}>
            快捷键
          </div>
          <div className="muted" style={{ fontSize: "var(--rb-text-xs)", marginTop: 3 }}>
            点击右侧按键区开始录制，冲突会即时标红
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
          新增
        </button>
      </div>

      {/* 快捷键列表 */}
      <div className="rb-settings-card">
        {items.map((item) => {
          const bound = Boolean(item.accelerator);
          const locked = !bound && (lockAll || (item.proOnly && !pro));
          const isRecording = recordingId === item.id;
          const isConflictRow = conflictItemId === item.id;

          return (
            <div
              key={item.id}
              className={`rb-setting-row rb-shortcut-row${isConflictRow ? " rb-conflict" : ""}${locked ? " rb-locked-row" : ""}`}
            >
              {/* 第一行：名称（内置/PRO 标签）+ 说明，行尾固定删除按钮（仅自定义） */}
              <div className="flex ac jb g16">
                <div className="flex ac g8">
                  <div className="rb-shortcut-name">
                    {item.isDefault ? (
                      <span className="tag tag-gray" style={{ fontSize: 10 }}>
                        内置
                      </span>
                    ) : null}
                    {item.name}
                    {item.proOnly ? (
                      <span className="tag tag-pro" style={{ marginLeft: 4 }}>PRO</span>
                    ) : null}
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
                    title="删除快捷键"
                    onClick={() => handleDelete(item.id)}
                    style={{ color: "var(--rb-error)", opacity: 0.65 }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                ) : null}
              </div>

              {/* 第二行：录制区靠左，提示词/模型下拉靠右 */}
              <div className="flex ac jb g16">
                <div className="flex ac g4">
                  {/* 快捷键 / 录制区 */}
                  {isRecording ? (
                    <div
                      ref={recordRef}
                      className="rb-recording"
                      tabIndex={0}
                      onKeyDown={(e) => handleKeyDown(e, item.id)}
                    >
                      <span className="rb-recording-dot" />
                      <span>等待按键</span>
                      {draft ? <span className="rb-recording-combo">{draft}</span> : null}
                    </div>
                  ) : bound ? (
                    isConflictRow ? (
                      /* 冲突态:红框胶囊 + 完整组合(设计稿) */
                      <div className="rb-shortcut-combo">
                        <span className="mono rb-sc-conflict-text">
                          {item.accelerator.split("+").map(keySymbol).join(" ")}
                        </span>
                      </div>
                    ) : (
                      /* 已绑定:散排键帽,符号化(设计稿) */
                      <div className="flex ac g4">
                        {item.accelerator.split("+").map((k) => (
                          <span className="kbd" key={k} style={KBD_STYLE}>
                            {keySymbol(k)}
                          </span>
                        ))}
                      </div>
                    )
                  ) : locked ? (
                    <span className="tag tag-gray">升级 Pro</span>
                  ) : (
                    <button className="btn btn-sm btn-secondary" onClick={() => startRecord(item.id)}>
                      <Icon name="plus" size={14} />
                      录制
                    </button>
                  )}
                </div>

                <div className="flex ac g6">
                  {/* 提示词绑定下拉(始终显示) */}
                  <select
                    className="rb-sc-prompt-select"
                    value={item.promptId ?? ""}
                    onChange={(e) => handlePromptChange(item.id, e.target.value || null)}
                  >
                    <option value="">默认提示词</option>
                    {allPrompts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>

                  {/* AI 服务模型下拉 */}
                  {models.length > 0 ? (
                    <select
                      className="rb-sc-prompt-select rb-sc-model-select"
                      value={item.model ?? ""}
                      onChange={(e) => handleModelChange(item.id, e.target.value)}
                    >
                      <option value="">默认模型</option>
                      {models.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
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
                  <div style={{ fontWeight: 500, fontSize: "var(--rb-text-sm)" }}>新增快捷键</div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    添加后点击「录制」录入组合键
                  </div>
                </div>
              </div>
              <button className="iconbtn" onClick={() => setShowDialog(false)}>
                <Icon name="close" size={14} />
              </button>
            </div>

            <div className="rb-dialog-body">
              <div className="set-row">
                <div className="rb-setting-label">名称</div>
                <input
                  className="inp"
                  style={{ width: "100%", maxWidth: 260 }}
                  placeholder="例如：快速翻译"
                  value={newName}
                  onChange={(e) => setNewName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAdd();
                  }}
                  autoFocus
                />
              </div>
              <div className="set-row">
                <div className="rb-setting-label">说明</div>
                <input
                  className="inp"
                  style={{ width: "100%", maxWidth: 260 }}
                  placeholder="快捷键用途（选填）"
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
                取消
              </button>
              <button
                className="btn btn-sm btn-primary"
                onClick={handleAdd}
                disabled={!newName.trim()}
              >
                添加
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
