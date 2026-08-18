import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppConfig, ApiConfig, ProviderType } from "../lib/config/types";
import { getServices } from "../lib/config/types";
import { testConnection, listModels } from "../lib/ai/provider";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icon";
import { t } from "../lib/i18n";

const FORMAT_META: Record<ProviderType, { name: string; desc: string; mark: string }> = {
  openai: { name: "OpenAI 格式", desc: "官方 API 及绝大多数兼容网关", mark: "O" },
  claude: { name: "Claude 格式", desc: "Anthropic 官方", mark: "C" },
  gemini: { name: "Gemini 格式", desc: "Google AI Studio / Vertex", mark: "G" },
  deepseek: { name: "DeepSeek 官方", desc: "DeepSeek 官方 API", mark: "D" },
};

/** DeepSeek 官方固定 Base URL(选中该格式后不可更改) */
const DEEPSEEK_BASE = "https://api.deepseek.com";

/** 格式选择是否锁定 Base URL */
const LOCKED_BASE_URL: Partial<Record<ProviderType, string>> = {
  deepseek: DEEPSEEK_BASE,
};

/** 模型下拉候选(组合框:可手输,打开态供选择) */
const MODEL_SUGGESTIONS: string[] = ["deepseek-v4-flash", "deepseek-v4-pro"];

const PROVIDER_MARKS: Record<string, string> = {
  OpenAI: "O",
  DeepSeek: "D",
  Claude: "C",
  Gemini: "G",
};

function markFor(name: string): string {
  if (PROVIDER_MARKS[name]) return PROVIDER_MARKS[name];
  return (name[0] ?? "?").toUpperCase();
}

interface AiServicesPageProps {
  cfg: AppConfig;
  onConfigChange: (cfg: AppConfig) => void;
}

interface LatencyMap {
  [id: string]: { ok: boolean; ms: number };
}

export function AiServicesPage({ cfg, onConfigChange }: AiServicesPageProps) {
  const services = useMemo(() => getServices(cfg), [cfg]);
  const [editing, setEditing] = useState<ApiConfig | null>(null);
  const [confirmDel, setConfirmDel] = useState<ApiConfig | null>(null);
  const [latency, setLatency] = useState<LatencyMap>({});
  const [testing, setTesting] = useState(false);
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const idCounter = useRef(1);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function saveAll(next: ApiConfig[]) {
    // 保证至多一个默认服务:无默认时第一个为默认
    const firstDefaultIdx = next.findIndex((s) => s.isDefault);
    const normalized = next.map((s, i) => ({
      ...s,
      isDefault: firstDefaultIdx === -1 ? i === 0 : i === firstDefaultIdx,
    }));
    const updated: AppConfig = { ...cfg, services: normalized, api: normalized[0] ?? cfg.api };
    await invoke("config_save", { cfg: updated });
    onConfigChange(updated);
  }

  /** 点「+」直接弹出新增服务弹窗(格式在弹窗内下拉选择,不再两步菜单) */
  function openNewForm() {
    setEditing({
      id: `svc${idCounter.current++}`,
      name: "",
      protocol: "openai",
      apiKey: "",
      baseUrl: "",
      model: "",
      isDefault: services.length === 0,
      stream: true,
    });
  }

  async function handleSaveService(svc: ApiConfig) {
    const exists = services.some((s) => s.id === svc.id);
    const next = exists
      ? services.map((s) => (s.id === svc.id ? svc : s))
      : [...services, svc];
    await saveAll(next);
    setEditing(null);
  }

  async function handleDelete(id: string) {
    const target = services.find((s) => s.id === id);
    if (target?.isDefault) return; // 默认服务不可删除(前端兜底,按钮已置灰)
    const next = services.filter((s) => s.id !== id);
    await saveAll(next);
  }

  /** 拖动排序:把 dragId 移到 targetId 位置并持久化 */
  function handleDrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const from = services.findIndex((s) => s.id === dragId);
    const to = services.findIndex((s) => s.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...services];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDragId(null);
    void saveAll(next);
  }

  /** 导出服务配置 JSON 到剪贴板 */
  async function handleExportConfig() {
    const payload = JSON.stringify(services, null, 2);
    await invoke("clipboard_write_text", { text: payload });
    setToast("服务配置已复制到剪贴板");
  }

  async function handleTestAll() {
    setTesting(true);
    const map: LatencyMap = {};
    for (const svc of services) {
      if (!svc.apiKey) continue;
      const r = await testConnection({
        type: svc.protocol as ProviderType,
        apiKey: svc.apiKey,
        baseUrl: svc.baseUrl,
        model: svc.model,
      });
      map[svc.id!] = { ok: r.ok, ms: r.latencyMs ?? 0 };
    }
    setLatency(map);
    setTesting(false);
  }

  async function handleTestOne(svc: ApiConfig) {
    if (!svc.apiKey) return;
    setTestingIds((s) => new Set(s).add(svc.id!));
    try {
      const r = await testConnection({
        type: svc.protocol as ProviderType,
        apiKey: svc.apiKey,
        baseUrl: svc.baseUrl,
        model: svc.model,
      });
      setLatency((m) => ({ ...m, [svc.id!]: { ok: r.ok, ms: r.latencyMs ?? 0 } }));
    } finally {
      setTestingIds((s) => {
        const n = new Set(s);
        n.delete(svc.id!);
        return n;
      });
    }
  }

  return (
    <div>
      <div className="flex ac jb g16">
        <div style={{ fontSize: "var(--rb-text-2xl)", fontWeight: 600 }}>AI 服务</div>
        <button className="svc-add" title="新增服务" onClick={openNewForm}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="muted rb-svc-subtitle">
        可同时配置多个服务，拖动排序即失效转移顺序。密钥仅保存在本机，不会上传到任何服务器。始终保留一个默认服务且不可删除。
      </div>

      {/* 服务列表 */}
      <div className="svc-list" style={{ marginBottom: 12 }}>
        {services.map((svc) => {
          const lat = latency[svc.id!];
          const failed = lat && !lat.ok;
          return (
            <div
              key={svc.id}
              className={`svc-row${failed ? " rb-svc-failed" : ""}${dragId !== null && dragId === svc.id ? " rb-svc-dragging" : ""}`}
              draggable
              onDragStart={(e) => {
                setDragId(svc.id!);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(svc.id!);
              }}
              onDragEnd={() => setDragId(null)}
              onClick={() => setEditing(svc)}
            >
              <span className="svc-grip">⣿</span>
              <span className={`svc-mark${svc.isDefault ? " pri" : ""}`}>
                {markFor(svc.name ?? svc.protocol)}
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="flex ac g6">
                  <span className="svc-name">{svc.name || FORMAT_META[svc.protocol as ProviderType]?.name || svc.protocol}</span>
                  {svc.isDefault ? <span className="tag tag-brand">默认</span> : null}
                </div>
                <div className="svc-meta">
                  <span>{FORMAT_META[svc.protocol as ProviderType]?.name}</span>
                  <span className="svc-sep" />
                  <span className="mono">{svc.model || "-"}</span>
                  {svc.baseUrl ? (
                    <>
                      <span className="svc-sep" />
                      <span className="mono">{svc.baseUrl.replace(/^https?:\/\//, "")}</span>
                    </>
                  ) : null}
                </div>
              </div>
              {/* 测速状态:有结果显示响应/停用,未测显示未测速 */}
              {lat ? (
                lat.ok ? (
                  <span className="tag tag-ok">
                    <Icon name="check" size={11} />
                    {lat.ms}ms
                  </span>
                ) : (
                  <span className="tag rb-svc-failed-tag">已停用</span>
                )
              ) : (
                <span className="tag tag-gray">未测速</span>
              )}
              {/* 行操作三图标:重新测速 → 修改 → 删除 */}
              <div className="flex ac g2">
                <button
                  className="iconbtn"
                  title="重新测速"
                  disabled={!svc.apiKey || testingIds.has(svc.id!)}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleTestOne(svc);
                  }}
                >
                  <Icon name="refresh" size={14} className={testingIds.has(svc.id!) ? "rb-spin" : ""} />
                </button>
                <button
                  className="iconbtn"
                  title="修改"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(svc);
                  }}
                >
                  <Icon name="edit" size={14} />
                </button>
                <button
                  className="iconbtn rb-svc-del"
                  title={svc.isDefault ? "默认服务不可删除" : "删除"}
                  disabled={svc.isDefault}
                  style={
                    svc.isDefault
                      ? { color: "var(--rb-neutral-300)", cursor: "not-allowed" }
                      : { color: "var(--rb-error)", opacity: 0.65 }
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDel(svc); // 二次确认后再删除
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
          );
        })}
        {services.length === 0 ? (
          <div className="rb-empty-list">暂无服务，点击右上角 + 新增</div>
        ) : null}
      </div>

      {/* 操作条(剪贴板导入已移除,保留导出) */}
      <div className="flex ac g8" style={{ marginBottom: 14 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => void handleTestAll()} disabled={testing}>
          <Icon name="refresh" size={14} className={testing ? "rb-spin" : ""} />
          {testing ? "测速中…" : "全部重新测速"}
        </button>
        <span className="muted rb-svc-last">上次测速 {services.length ? "刚刚" : "—"}</span>
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => void handleExportConfig()}>
          导出配置
        </button>
      </div>

      {toast ? <div className="rb-toast rb-toast-static">{toast}</div> : null}

      {/* 删除服务二次确认 */}
      {confirmDel ? (
        <div className="rb-svc-form-overlay" onClick={() => setConfirmDel(null)}>
          <div className="rb-svc-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="rb-confirm-msg">
              确定删除服务「{confirmDel.name || FORMAT_META[confirmDel.protocol as ProviderType]?.name || confirmDel.protocol}」吗？
            </div>
            <div className="rb-confirm-actions">
              <button
                className="btn btn-sm rb-confirm-del"
                onClick={() => {
                  const id = confirmDel.id!;
                  setConfirmDel(null);
                  void handleDelete(id);
                }}
              >
                删除
              </button>
              <button className="btn btn-sm btn-ghost rb-confirm-cancel" onClick={() => setConfirmDel(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 新增/编辑表单 */}
      {editing ? (
        <ServiceForm
          svc={editing}
          isNew={!services.some((s) => s.id === editing.id)}
          onSave={handleSaveService}
          onCancel={() => setEditing(null)}
          onTest={(s) => handleTestOne(s)}
          latency={latency[editing.id!]}
        />
      ) : null}
    </div>
  );
}

interface ServiceFormProps {
  svc: ApiConfig;
  isNew: boolean;
  onSave: (svc: ApiConfig) => void;
  onCancel: () => void;
  /** 测试连接:传表单实时值(而非打开弹窗时的快照),确保改完 key/model 再测的是新值 */
  onTest: (svc: ApiConfig) => Promise<void>;
  latency?: { ok: boolean; ms: number };
}

function ServiceForm({ svc, isNew, onSave, onCancel, onTest, latency }: ServiceFormProps) {
  const [form, setForm] = useState<ApiConfig>(svc);
  const [showKey, setShowKey] = useState(false);
  const [fmtOpen, setFmtOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelMenuPos, setModelMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  /** 测试连接:本地记录 spinning 状态,完成后恢复(owait onTest 拿到结果) */
  async function handleTestClick() {
    setTesting(true);
    try {
      await onTest(form);
    } finally {
      setTesting(false);
    }
  }
  const fmt = FORMAT_META[form.protocol as ProviderType];
  /** 锁定格式的固定 Base URL(deepseek 官方);非锁定格式为 undefined */
  const lockedBase = LOCKED_BASE_URL[form.protocol as ProviderType];
  const modelInputRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  /** 打开下拉时记录的触发输入框视口坐标,供 useLayoutEffect 做实际高度对齐 */
  const openRectRef = useRef<DOMRect | null>(null);

  const set = (patch: Partial<ApiConfig>) => setForm((f) => ({ ...f, ...patch }));

  /** 打开模型下拉:记录触发器位置(portal 用 fixed 定位)并用表单实时值调接口拉取 */
  async function openModelPicker() {
    const el = modelInputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    openRectRef.current = rect;
    // 初始置于输入框下方;向上翻转及贴合细节由 useLayoutEffect 按菜单实际高度修正
    setModelMenuPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    setModelOpen((v) => !v);
    if (!modelOpen) {
      setLoadingModels(true);
      setModelErr(null);
      const list = await listModels({
        type: form.protocol as ProviderType,
        apiKey: form.apiKey,
        baseUrl: form.baseUrl,
        model: form.model,
      });
      setModels(list);
      setLoadingModels(false);
      if (!list.length) setModelErr("未获取到模型列表，可手动输入");
    }
  }

  /** 点击下拉外部(mousedown)关闭 portal 菜单;菜单内部点击不关(由菜单项 onClick 处理) */
  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (modelInputRef.current?.contains(target)) return;
      if (modelMenuRef.current?.contains(target)) return;
      setModelOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelOpen]);

  /**
   * 模型下拉定位修正:菜单经 portal 渲染到 body,高度随模型数量变化(加载占位 196px,
   * 实际 2~N 项更矮)。向上展开时必须用「菜单实际高度」把底部贴住输入框上沿,
   * 否则少数模型时菜单会悬空在输入框上方留白处。绘制前修正,无闪烁。
   * 翻转与否用最大高度(196)判定以保持加载/加载后一致,避免菜单在列表返回时跳动。
   */
  useLayoutEffect(() => {
    if (!modelOpen || !modelMenuPos) return;
    const rect = openRectRef.current;
    const menu = modelMenuRef.current;
    if (!rect || !menu) return;
    const MENU_MAX_H = 196;
    const menuH = menu.offsetHeight;
    let top = rect.bottom + 4;
    if (top + MENU_MAX_H > window.innerHeight) {
      // 底部空间不足:向上展开,底部对齐输入框上沿(用实际高度,避免矮菜单悬空)
      top = Math.max(4, rect.top - menuH - 4);
    }
    if (top !== modelMenuPos.top) {
      setModelMenuPos((p) => (p ? { ...p, top } : p));
    }
  }, [modelOpen, loadingModels, models, modelMenuPos]);

  /** 模型候选:接口结果优先;失败/为空回退 [当前值 + 内置候选] 去重 */
  const modelOptions =
    models && models.length
      ? [form.model, ...models].filter((m, i, arr) => Boolean(m) && arr.indexOf(m) === i)
      : [form.model, ...MODEL_SUGGESTIONS].filter((m, i, arr) => Boolean(m) && arr.indexOf(m) === i);

  /** 保存校验:API Key 必填;锁定格式强制固定 Base URL */
  function handleSaveClick() {
    if (!form.apiKey.trim()) {
      setSaveErr("API Key 是必填项");
      return;
    }
    onSave(lockedBase ? { ...form, baseUrl: lockedBase } : form);
  }

  return (
    <div className="rb-svc-form-overlay" onClick={onCancel}>
      <div className="rb-svc-form" onClick={(e) => e.stopPropagation()}>
        <div className="rb-svc-form-hd">
          <div className="flex ac g9">
            <span className="svc-mark pri rb-svc-form-mark">
              {markFor(form.name || fmt.name)}
            </span>
            <div>
              <div style={{ fontWeight: 500, fontSize: "var(--rb-text-sm)" }}>
                {isNew ? "新增服务" : "编辑服务"}
              </div>
              <div className="muted rb-svc-form-hint">选择格式后填写字段，修改时也可重新选择格式</div>
            </div>
          </div>
          <button className="iconbtn" onClick={onCancel}>
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="rb-svc-form-body">
          {/* 格式:新增/编辑均可下拉选择,选格式同时切换默认模型 */}
          <div className="set-row">
            <div className="set-row-label">
              <div>格式</div>
              <div className="muted rb-setting-hint">官方 API 或兼容网关类型</div>
            </div>
            <div className="rb-svc-drop">
              <div
                className="set-pick rb-svc-drop-trigger"
                style={{ maxWidth: 300, width: "100%", justifyContent: "space-between", cursor: "pointer" }}
                onClick={() => setFmtOpen((v) => !v)}
              >
                <span>{fmt.name}</span>
                <Icon name="chevronDown" size={14} style={{ color: "var(--rb-text-tertiary)" }} />
              </div>
              {fmtOpen ? (
                <div className="rb-svc-drop-menu">
                  {(Object.keys(FORMAT_META) as ProviderType[]).map((p) => (
                    <div
                      key={p}
                      className={`svc-mi${p === form.protocol ? " on" : ""}`}
                      onClick={() => {
                        // 切换格式:仅更新协议,模型保持空白(由用户手动输入或从接口拉取);
                        // deepseek 官方格式锁定 Base URL
                        set({ protocol: p, model: "", ...(LOCKED_BASE_URL[p] ? { baseUrl: LOCKED_BASE_URL[p] } : {}) });
                        setFmtOpen(false);
                      }}
                    >
                      <Icon name="globe" size={14} className="svc-mi-icon" />
                      <div className="grow">
                        <div className="svc-mi-t">{FORMAT_META[p].name}</div>
                        <div className="svc-mi-d">{FORMAT_META[p].desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="set-row">
            <div className="set-row-label">
              <div>显示名称</div>
              <div className="muted rb-setting-hint">列表里怎么称呼它</div>
            </div>
            <input
              className="inp rb-svc-input"
              value={form.name ?? ""}
              onChange={(e) => set({ name: e.currentTarget.value })}
              placeholder={fmt.name}
            />
          </div>

          <div className="set-row">
            <div className="set-row-label">
              <div>API Base URL</div>
              <div className="muted rb-setting-hint">兼容网关填自定义地址</div>
            </div>
            <input
              className="inp mono rb-svc-input"
              value={lockedBase ?? form.baseUrl}
              disabled={Boolean(lockedBase)}
              title={lockedBase ? "DeepSeek 官方格式固定使用该地址" : undefined}
              onChange={(e) => set({ baseUrl: e.currentTarget.value })}
              placeholder={form.protocol === "openai" ? "https://api.openai.com/v1" : form.protocol === "claude" ? "https://api.anthropic.com" : form.protocol === "deepseek" ? "https://api.deepseek.com" : "https://generativelanguage.googleapis.com"}
            />
          </div>

          <div className="set-row">
            <div className="set-row-label">
              <div>API Key</div>
              <div className="muted rb-setting-hint">存于本机 config.json</div>
            </div>
            <div className="rb-key-input rb-svc-key">
              <input
                className="inp mono rb-svc-input"
                type={showKey ? "text" : "password"}
                autoComplete="off"
                value={form.apiKey}
                onChange={(e) => {
                  set({ apiKey: e.currentTarget.value });
                  setSaveErr(null);
                }}
                placeholder={form.protocol === "openai" ? "sk-..." : form.protocol === "claude" ? "sk-ant-..." : "AIza..."}
              />
              <button className="iconbtn rb-key-toggle" onClick={() => setShowKey((v) => !v)}>
                <Icon name="eye" size={14} />
              </button>
            </div>
          </div>

          {/* 模型:组合框(可手输 + 下拉调接口拉取) */}
          <div className="set-row">
            <div className="set-row-label">
              <div>模型</div>
              <div className="muted rb-setting-hint">点右侧图标从接口拉取，也可手输</div>
            </div>
            <div className="rb-svc-model" ref={modelInputRef}>
              <input
                className="inp mono rb-svc-model-input"
                value={form.model}
                onChange={(e) => {
                  set({ model: e.currentTarget.value });
                  setSaveErr(null);
                }}
                placeholder={t("settings.modelPlaceholder")}
              />
              <button className="iconbtn rb-svc-model-caret" title="拉取模型列表" onClick={() => void openModelPicker()}>
                <Icon name="chevronDown" size={14} />
              </button>
            </div>
            {/* 模型下拉:portal 到 body + fixed 定位,脱离表单滚动容器裁剪;最多 6 项内部滚动 */}
            {modelOpen && modelMenuPos
              ? createPortal(
                  <div
                    ref={modelMenuRef}
                    className={`rb-svc-model-menu rb-svc-model-menu-fixed${
                      loadingModels ? " rb-svc-model-menu-loading" : ""
                    }`}
                    style={{ top: modelMenuPos.top, left: modelMenuPos.left, width: modelMenuPos.width }}
                  >
                    {loadingModels ? (
                      <div className="rb-svc-model-loading" style={{ cursor: "default", color: "var(--rb-text-tertiary)" }}>
                        加载中…
                      </div>
                    ) : (
                      <>
                        {modelOptions.map((m) => (
                          <div
                            key={m}
                            className={`rb-svc-model-item${m === form.model ? " on" : ""}`}
                            onClick={() => {
                              set({ model: m });
                              setModelOpen(false);
                            }}
                          >
                            <span className="mono">{m}</span>
                            {m === form.model ? <Icon name="check" size={12} /> : null}
                          </div>
                        ))}
                        {modelErr ? (
                          <div className="rb-svc-model-item" style={{ cursor: "default", color: "var(--rb-warning)" }}>
                            {modelErr}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>,
                  document.body,
                )
              : null}
          </div>

          <div className="set-row">
            <div className="set-row-label">
              <div>流式输出</div>
              <div className="muted rb-setting-hint">逐字显示总结</div>
            </div>
            <div className={`sw${form.stream ? " on" : ""}`} onClick={() => set({ stream: !form.stream })} />
          </div>
        </div>

        <div className="rb-svc-form-foot">
          <button className="btn btn-secondary btn-sm" onClick={() => void handleTestClick()} disabled={!form.apiKey || testing}>
            <Icon name="refresh" size={14} className={testing ? "rb-spin" : ""} />
            测试连接
          </button>
          {latency ? (
            latency.ok ? (
              <span className="tag tag-ok">响应 {latency.ms}ms</span>
            ) : (
              <span className="tag rb-tag-err">连接失败</span>
            )
          ) : null}
          {saveErr ? <span className="rb-svc-save-err">{saveErr}</span> : null}
          <div style={{ marginLeft: "auto" }} className="flex g8">
            <button className="btn btn-ghost btn-sm" onClick={onCancel}>
              取消
            </button>
            <button className="btn btn-primary btn-sm" onClick={handleSaveClick}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
