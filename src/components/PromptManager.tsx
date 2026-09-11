import { useState } from "react";
import type { AppConfig, PromptConfig } from "../lib/config/types";
import { FREE_PROMPT_LIMIT } from "../lib/license";
import { useLicense } from "../lib/license/useLicense";
import { BUILTIN_PROMPTS, BUILTIN_ICONS, TAG_OPTIONS, TAG_LABELS, TAG_TIPS } from "../lib/prompts/builtins";
import type { PromptTag } from "../lib/prompts/builtins";
import { t, useLanguage } from "../lib/i18n";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icon";
import { useToast, errText } from "./Toast";

function HighlightText({ content }: { content: string }) {
  const parts = content.split(/(\{\{(?:text|language)\}\})/g);
  return (
    <>
      {parts.map((p, i) =>
        p === "{{text}}" || p === "{{language}}" ? (
          <span key={i} style={{ color: "var(--rb-brand-600)" }}>
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

interface PromptManagerProps {
  cfg: AppConfig;
  onConfigChange: (cfg: AppConfig) => void;
}

export function PromptManager({ cfg, onConfigChange }: PromptManagerProps) {
  // 订阅语言变更,切语言时即时重渲染
  useLanguage();
  const [creating, setCreating] = useState(false);
  // 编辑器当前编辑的条目 id:null = 新建态
  const [editingId, setEditingId] = useState<string | null>(null);
  // 删除二次确认:{id,name} 非空时展示确认弹窗
  const [confirmDel, setConfirmDel] = useState<{ id: string; name: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newTag, setNewTag] = useState<PromptTag>("summary");

  const license = useLicense(cfg);
  const { showToast, toastNode } = useToast();

  const userPrompts = (cfg.prompts ?? []).filter((p) => !p.isBuiltin);
  const shortcuts = cfg.shortcuts ?? [];
  const atLimit = !license.pro && userPrompts.length >= FREE_PROMPT_LIMIT;
  const shortcutCount = shortcuts.filter((s) => s.accelerator).length;

  /** 落盘:成功返回 true。失败时提示且不改动上层状态(旧值保留,用户可重试) */
  async function savePrompts(next: PromptConfig[]): Promise<boolean> {
    const updated: AppConfig = { ...cfg, prompts: next };
    try {
      await invoke("config_save", { cfg: updated });
    } catch (e) {
      showToast({ text: `${t("prompts.saveFailed")}: ${errText(e)}`, ok: false });
      return false;
    }
    onConfigChange(updated);
    return true;
  }

  /** 关闭编辑器并清空草稿(取消 / 保存成功后调用) */
  function closeEditor() {
    setCreating(false);
    setEditingId(null);
    setNewName("");
    setNewContent("");
    setNewTag("summary");
  }

  async function handleCreate() {
    if (!newName.trim() || !newContent.trim()) return;
    const name = newName.trim();
    const content = newContent.trim();
    // 编辑态:就地更新字段,保留 id / model / shortcut(避免绑定该提示词的快捷键悬空)
    // 新建态:追加新条目
    const next = editingId
      ? userPrompts.map((p) => (p.id === editingId ? { ...p, name, content, tag: newTag } : p))
      : [
          ...userPrompts,
          {
            id: `p${crypto.randomUUID()}`,
            name,
            content,
            model: "",
            shortcut: null,
            outputFormat: "md" as const,
            isBuiltin: false,
            tag: newTag,
          },
        ];
    // 保存失败不关闭编辑器,草稿保留
    if (await savePrompts(next)) closeEditor();
  }

  async function handleDelete(id: string) {
    await savePrompts(userPrompts.filter((p) => p.id !== id));
  }

  async function handleCopy(prompt: PromptConfig) {
    await invoke("clipboard_write_text", { text: prompt.content });
  }

  /* 查找绑定的快捷键 */
  function findShortcut(promptId: string): string | null {
    return shortcuts.find((s) => s.promptId === promptId)?.accelerator ?? null;
  }

  /* 渲染单张提示词卡片 */
  function renderCard(p: PromptConfig, isBuiltin: boolean) {
    const sc = findShortcut(p.id);
    const iconInfo = isBuiltin ? BUILTIN_ICONS[p.id] : null;

    return (
      <div
        key={p.id}
        className={`rb-prompt-card${isBuiltin ? " rb-prompt-card-builtin" : ""}`}
      >
        <div className="rb-prompt-card-head">
          <span
            className="rb-prompt-icon"
            style={
              isBuiltin && iconInfo
                ? { background: iconInfo.bg, color: iconInfo.fg }
                : { background: "var(--rb-bg-sunken)", color: "var(--rb-text-secondary)" }
            }
          >
            <Icon name={iconInfo?.icon ?? "edit"} size={14} />
          </span>
          <span className="grow trunc rb-prompt-name">{p.name}</span>
          {p.tag ? (
            <span className="tag tag-brand" style={{ fontSize: 10 }}>
              {TAG_LABELS[p.tag as PromptTag] ?? p.tag}
            </span>
          ) : null}
          {isBuiltin ? (
            <>
              {p.id === "builtin-summarize" ? (
                <span className="tag tag-brand" style={{ fontSize: 10 }}>{t("prompts.default")}</span>
              ) : null}
              <span className="tag tag-gray" style={{ fontSize: 10 }}>{t("prompts.builtin")}</span>
            </>
          ) : (
            <span className="tag tag-gray" style={{ fontSize: 10 }}>{t("prompts.custom")}</span>
          )}
        </div>
        <div className="rb-prompt-preview">
          <HighlightText content={p.content} />
        </div>
        <div className="rb-prompt-card-foot">
          <div className="rb-prompt-shortcut-info">
            {sc ? (
              sc.split("+").map((k) => (
                <span className="kbd" key={k}>{k}</span>
              ))
            ) : null}
          </div>
          <div className="rb-prompt-actions">
            {!isBuiltin ? (
              <button className="iconbtn" title={t("prompts.edit")} onClick={() => {
                setEditingId(p.id);
                setNewName(p.name);
                setNewContent(p.content);
                setNewTag((p.tag as PromptTag) ?? "summary");
                setCreating(true);
              }}>
                <Icon name="edit" size={14} />
              </button>
            ) : null}
            <button className="iconbtn" title={t("prompts.copy")} onClick={() => void handleCopy(p)}>
              <Icon name="copy" size={14} />
            </button>
            {!isBuiltin ? (
              <button
                className="iconbtn"
                title={t("prompts.delete")}
                style={{ color: "var(--rb-error)", opacity: 0.65 }}
                onClick={() => setConfirmDel({ id: p.id, name: p.name })}
              >
                <Icon name="trash" size={14} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rb-prompt-page">
      <div className="rb-prompt-header">
        <div>
          <div className="rb-prompt-title">{t("prompts.title")}</div>
          <div className="muted rb-prompt-subtitle">
            {t("prompts.subtitle", { n: userPrompts.length, m: shortcutCount })}
          </div>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => { setEditingId(null); setNewName(""); setNewContent(""); setNewTag("summary"); setCreating(true); }}
          disabled={atLimit}
        >
          <Icon name="plus" size={14} />
          新建提示词
        </button>
      </div>

      {/* 编辑器:新建 / 编辑两态(编辑就地改,取消不写盘) */}
      {creating ? (
        <div className="rb-prompt-editor">
          <div className="rb-prompt-editor-hd">
            <span>{editingId ? t("prompts.editEditorTitle") : t("prompts.newEditorTitle")}</span>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span className="tag tag-gray" style={{ fontSize: 10 }}>{t("prompts.custom")}</span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--rb-error)",
                  background: "var(--rb-error-bg)",
                  border: "1px solid var(--rb-error-border)",
                  padding: "4px 9px",
                  borderRadius: "var(--rb-radius-sm)",
                }}
              >
                <svg className="ic" viewBox="0 0 24 24" style={{ width: 14, height: 14, flex: "none" }}>
                  <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
                  <path d="M12 9v4M12 17h.01" />
                </svg>
                {t("prompts.needText")}
              </span>
            </div>
          </div>
          <input
            className="inp"
            placeholder={t("prompts.namePlaceholder")}
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) void handleCreate();
            }}
            autoFocus
          />
          <textarea
            className="inp"
            placeholder={t("prompts.contentPlaceholder")}
            rows={6}
            style={{ resize: "vertical", lineHeight: 1.6, minHeight: 112, marginBottom: 8, padding: "8px 10px" }}
            value={newContent}
            onChange={(e) => setNewContent(e.currentTarget.value)}
          />
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: "var(--rb-text-xs)", fontWeight: 500, marginBottom: 6 }}>{t("prompts.typeLabel")}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {TAG_OPTIONS.map((t) => {
                const active = newTag === t;
                return (
                  <span
                    key={t}
                    className="rb-seg"
                    onClick={() => setNewTag(t)}
                    style={{
                      flex: 1,
                      textAlign: "center",
                      padding: "7px 0",
                      fontSize: 12,
                      fontWeight: active ? 600 : 400,
                      color: active ? "#fff" : "var(--rb-text-secondary)",
                      background: active ? "var(--rb-brand-600)" : "var(--rb-bg-surface)",
                      border: `1px solid ${active ? "var(--rb-brand-600)" : "var(--rb-border-default)"}`,
                      borderRadius: "var(--rb-radius-sm)",
                      cursor: "pointer",
                    }}
                  >
                    {TAG_LABELS[t]}
                    <span className="rb-q">?</span>
                    <span className="rb-tip">{TAG_TIPS[t]}</span>
                  </span>
                );
              })}
            </div>
          </div>
          {/* 翻译类型提示:目标语言由提示词写明,或引用 {{language}} 跟随「输出语言」设置 */}
          {newTag === "translate" ? (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                fontSize: 12,
                lineHeight: 1.6,
                color: "var(--rb-text-secondary)",
                background: "var(--rb-brand-50)",
                border: "1px solid var(--rb-border-default)",
                borderRadius: "var(--rb-radius-sm)",
                padding: "7px 10px",
                marginBottom: 8,
              }}
            >
              <svg
                className="ic"
                viewBox="0 0 24 24"
                style={{ width: 14, height: 14, flex: "none", marginTop: 2 }}
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8h.01M12 12v4" />
              </svg>
              <span>
                {t("prompts.translateTargetHintBefore")}{" "}
                <span style={{ color: "var(--rb-brand-600)", fontFamily: "var(--rb-font-mono)" }}>
                  {"{{language}}"}
                </span>{" "}
                {t("prompts.translateTargetHintAfter")}
              </span>
            </div>
          ) : null}
          <div className="rb-prompt-editor-row">
            <span className="muted" style={{ fontSize: 11 }}>{t("prompts.modelHint")}</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={closeEditor}>
                {t("prompts.cancel")}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void handleCreate()}
                disabled={!newName.trim() || !newContent.trim()}
              >
                {t("prompts.save")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 卡片网格：内置 + 自定义 */}
      <div className="rb-prompt-grid">
        {BUILTIN_PROMPTS.map((p) => renderCard(p, true))}
        {userPrompts.map((p) => renderCard(p, false))}
      </div>

      {/* 删除二次确认:不可撤销,确认后才落盘 */}
      {confirmDel ? (
        <div className="rb-overlay" onClick={() => setConfirmDel(null)}>
          <div
            className="rb-dialog rb-dialog-sm"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setConfirmDel(null);
            }}
          >
            <div className="rb-dialog-hd">
              <div className="flex ac g8">
                <span className="rb-dialog-mark">
                  <Icon name="trash" size={14} />
                </span>
                <div>
                  <div style={{ fontWeight: 500, fontSize: "var(--rb-text-sm)" }}>
                    {t("prompts.deleteTitle")}
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    {t("prompts.deleteDesc")}
                  </div>
                </div>
              </div>
              <button className="iconbtn" onClick={() => setConfirmDel(null)}>
                <Icon name="close" size={14} />
              </button>
            </div>
            <div className="rb-dialog-body">
              <div className="rb-confirm-msg">
                {t("prompts.confirmDelete", { name: confirmDel.name })}
              </div>
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
                  // 正在编辑该条目时一并收起编辑器,避免编辑已不存在的条目
                  if (editingId === id) closeEditor();
                  void handleDelete(id);
                }}
              >
                {t("prompts.delete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toastNode}
    </div>
  );
}
