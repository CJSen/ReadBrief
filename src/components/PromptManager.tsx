import { useState } from "react";
import type { AppConfig, PromptConfig } from "../lib/config/types";
import { FREE_PROMPT_LIMIT } from "../lib/license";
import { useLicense } from "../lib/license/useLicense";
import { BUILTIN_PROMPTS, BUILTIN_ICONS } from "../lib/prompts/builtins";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icon";

function HighlightText({ content }: { content: string }) {
  const parts = content.split(/(\{\{text\}\})/g);
  return (
    <>
      {parts.map((p, i) =>
        p === "{{text}}" ? (
          <span key={i} style={{ color: "var(--rb-brand-600)" }}>
            {"{{text}}"}
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
    };
    void savePrompts([...userPrompts, prompt]);
    setNewName("");
    setNewContent("");
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
            3 个内置提示词 · 已使用 {userPrompts.length} / {FREE_PROMPT_LIMIT} 个自定义提示词 · {shortcutCount} / 2 个快捷键
          </div>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => { setNewName(""); setNewContent(""); setCreating(true); }}
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
            <span className="tag tag-gray" style={{ fontSize: 10 }}>自定义</span>
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
            rows={3}
            style={{ resize: "vertical", lineHeight: 1.6, minHeight: 64, padding: "8px 10px" }}
            value={newContent}
            onChange={(e) => setNewContent(e.currentTarget.value)}
          />
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
        {atLimit ? (
          <div className="rb-prompt-card rb-prompt-locked">
            <span className="rb-prompt-lock-icon">
              <Icon name="lock" size={16} />
            </span>
            <div style={{ fontWeight: 500 }}>已达免费版上限</div>
            <div className="muted" style={{ fontSize: "var(--rb-text-xs)", lineHeight: 1.6, maxWidth: 230, textAlign: "center" }}>
              升级 Pro 可创建无限提示词，并为每个提示词绑定独立快捷键
            </div>
            <button className="btn btn-sm btn-secondary" style={{ marginTop: 2 }}>
              升级 Pro
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
