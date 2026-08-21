import { useState } from "react";
import type { AppConfig, PromptConfig } from "../lib/config/types";
import { FREE_PROMPT_LIMIT } from "../lib/license";
import { useLicense } from "../lib/license/useLicense";
import { BUILTIN_PROMPTS, BUILTIN_ICONS, TAG_OPTIONS, TAG_LABELS, TAG_TIPS } from "../lib/prompts/builtins";
import type { PromptTag } from "../lib/prompts/builtins";
import { t } from "../lib/i18n";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icon";

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
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newTag, setNewTag] = useState<PromptTag>("summary");

  const license = useLicense(cfg);

  const userPrompts = (cfg.prompts ?? []).filter((p) => !p.isBuiltin);
  const shortcuts = cfg.shortcuts ?? [];
  const atLimit = !license.pro && userPrompts.length >= FREE_PROMPT_LIMIT;
  const shortcutCount = shortcuts.filter((s) => s.accelerator).length;

  async function savePrompts(next: PromptConfig[]) {
    const updated: AppConfig = { ...cfg, prompts: next };
    await invoke("config_save", { cfg: updated });
    onConfigChange(updated);
  }

  function handleCreate() {
    if (!newName.trim() || !newContent.trim()) return;
    const prompt: PromptConfig = {
      id: `p${crypto.randomUUID()}`,
      name: newName.trim(),
      content: newContent.trim(),
      model: "",
      shortcut: null,
      outputFormat: "md",
      isBuiltin: false,
      tag: newTag,
    };
    void savePrompts([...userPrompts, prompt]);
    setNewName("");
    setNewContent("");
    setNewTag("summary");
    setCreating(false);
  }

  async function handleDelete(id: string) {
    void savePrompts(userPrompts.filter((p) => p.id !== id));
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
                <span className="tag tag-brand" style={{ fontSize: 10 }}>默认</span>
              ) : null}
              <span className="tag tag-gray" style={{ fontSize: 10 }}>内置</span>
            </>
          ) : (
            <span className="tag tag-gray" style={{ fontSize: 10 }}>自定义</span>
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
              <button className="iconbtn" title="编辑" onClick={() => {
                setNewName(p.name);
                setNewContent(p.content);
                setNewTag((p.tag as PromptTag) ?? "summary");
                handleDelete(p.id);
                setCreating(true);
              }}>
                <Icon name="edit" size={14} />
              </button>
            ) : null}
            <button className="iconbtn" title="复制" onClick={() => void handleCopy(p)}>
              <Icon name="copy" size={14} />
            </button>
            {!isBuiltin ? (
              <button
                className="iconbtn"
                title="删除"
                style={{ color: "var(--rb-error)", opacity: 0.65 }}
                onClick={() => void handleDelete(p.id)}
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
          <div className="rb-prompt-title">提示词</div>
          <div className="muted rb-prompt-subtitle">
            3 个内置提示词 · 已创建 {userPrompts.length} 个自定义提示词 · {shortcutCount} 个快捷键
          </div>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => { setNewName(""); setNewContent(""); setNewTag("summary"); setCreating(true); }}
          disabled={atLimit}
        >
          <Icon name="plus" size={14} />
          新建提示词
        </button>
      </div>

      {/* 新建编辑器：仅在点击新建后显示 */}
      {creating ? (
        <div className="rb-prompt-editor">
          <div className="rb-prompt-editor-hd">
            <span>新建提示词</span>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span className="tag tag-gray" style={{ fontSize: 10 }}>自定义</span>
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
                如果需要捕获数据，必须包含 {"{{text}}"}
              </span>
            </div>
          </div>
          <input
            className="inp"
            placeholder="提示词名称，例如：写周报"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) handleCreate();
            }}
            autoFocus
          />
          <textarea
            className="inp"
            placeholder="提示词内容，用 {{text}} 代表选中的文本…"
            rows={6}
            style={{ resize: "vertical", lineHeight: 1.6, minHeight: 112, marginBottom: 8, padding: "8px 10px" }}
            value={newContent}
            onChange={(e) => setNewContent(e.currentTarget.value)}
          />
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: "var(--rb-text-xs)", fontWeight: 500, marginBottom: 6 }}>提示词类型</div>
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
            <span className="muted" style={{ fontSize: 11 }}>模型在「快捷键」中为每个快捷键分别选择</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setCreating(false)}>
                取消
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleCreate}
                disabled={!newName.trim() || !newContent.trim()}
              >
                保存
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
    </div>
  );
}
