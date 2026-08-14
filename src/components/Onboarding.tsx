import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppConfig, ApiConfig, ProviderType } from "../lib/config/types";
import { testConnection } from "../lib/ai/provider";
import { t } from "../lib/i18n";
import { Icon, type IconName } from "./Icon";
import "./Onboarding.css";

/* ═══ 步骤定义 ═══ */
const STEPS: Array<{ key: string; name: string; icon: IconName }> = [
  { key: "welcome", name: "欢迎", icon: "summarize" },
  { key: "ai", name: "配置 AI 服务", icon: "zap" },
  { key: "perms", name: "开启权限", icon: "shield" },
  { key: "shortcut", name: "自定义快捷键", icon: "keyboard" },
];

/* 与 AiServicesPage 一致的服务商默认(官方 Base URL / 默认模型) */
const FORMAT_META: Record<ProviderType, { name: string; official: string; defaultModel: string }> = {
  openai: { name: "OpenAI 格式", official: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  claude: { name: "Claude 格式", official: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-20250514" },
  gemini: { name: "Gemini 格式", official: "https://generativelanguage.googleapis.com", defaultModel: "gemini-2.0-flash" },
};
const FORMAT_ORDER: ProviderType[] = ["openai", "claude", "gemini"];

/* ═══ 快捷键录制(复用 ShortcutsPage 范式,仅绑定 summarize) ═══ */
const MODIFIER_KEYS = new Set(["CONTROL", "SHIFT", "ALT", "META"]);
const IGNORE_KEYS = new Set(["CAPSLOCK", "FN", "FUNCTION", "NUMLOCK"]);
const SYSTEM_SHORTCUTS = ["Cmd+Space", "Cmd+Tab", "Ctrl+Space"];
const SYSTEM_SHORTCUT_NAMES: Record<string, string> = {
  "Cmd+Space": "系统聚焦搜索",
  "Cmd+Tab": "系统应用切换",
  "Ctrl+Space": "系统输入法切换",
};
const MOD_SYMBOLS: Record<string, string> = { CMD: "⌘", CTRL: "⌃", ALT: "⌥", SHIFT: "⇧" };
function keySymbol(k: string): string {
  if (!k || k === " ") return "Space";
  return MOD_SYMBOLS[k.toUpperCase()] ?? k;
}

interface OnboardingProps {
  cfg: AppConfig;
  /** 持久化并同步父组件配置(不负责关闭覆盖层) */
  onUpdate: (next: AppConfig) => void;
  /** 显式关闭覆盖层(仅完成/跳过时调用) */
  onClose: () => void;
}

export function Onboarding({ cfg, onUpdate, onClose }: OnboardingProps) {
  const [step, setStep] = useState(0);

  /* ═══ 步骤1:AI 服务表单(零配置可跳过) ═══ */
  /* 预填:若已有默认/首个服务,则使用其数据(再次打开引导时不丢配置、不重复新建) */
  const initialService: ApiConfig | null =
    cfg.api ?? cfg.services?.find((s) => s.apiKey) ?? cfg.services?.[0] ?? null;

  const [form, setForm] = useState<ApiConfig>(() =>
    initialService
      ? { ...initialService, name: initialService.name ?? "" }
      : {
          id: `svc_ob_${Date.now()}`,
          name: "",
          protocol: "openai",
          apiKey: "",
          baseUrl: "",
          model: FORMAT_META.openai.defaultModel,
          isDefault: (cfg.services?.length ?? 0) === 0,
          stream: true,
        },
  );
  /** 正在编辑的既有服务 id(预填时为该服务 id;新建时为 null) */
  const [editingId] = useState<string | null>(initialService?.id ?? null);
  const [fmtOpen, setFmtOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [latency, setLatency] = useState<{ ok: boolean; ms: number } | null>(null);
  const [aiSaved, setAiSaved] = useState(false);

  const set = (patch: Partial<ApiConfig>) => setForm((f) => ({ ...f, ...patch }));

  async function handleTest() {
    if (!form.apiKey.trim()) return;
    setTesting(true);
    try {
      const r = await testConnection({
        type: form.protocol as ProviderType,
        apiKey: form.apiKey.trim(),
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim() || FORMAT_META[form.protocol as ProviderType].defaultModel,
      });
      setLatency({ ok: r.ok, ms: r.latencyMs ?? 0 });
    } finally {
      setTesting(false);
    }
  }

  /** 离开步骤1:有 API Key 则落库;编辑既有服务时就地更新,避免重复新建 */
  async function commitServiceIfNeeded() {
    if (aiSaved) return;
    const key = form.apiKey.trim();
    // 无密钥:若原本就有服务则保留(标记已处理),否则不落库(零配置可继续)
    if (!key) {
      if (editingId) setAiSaved(true);
      return;
    }
    const svc: ApiConfig = {
      id: editingId ?? `svc_ob_${Date.now()}`,
      name: form.name?.trim() || FORMAT_META[form.protocol as ProviderType].name,
      protocol: form.protocol,
      apiKey: key,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim() || FORMAT_META[form.protocol as ProviderType].defaultModel,
      isDefault: editingId
        ? Boolean(cfg.services?.find((s) => s.id === editingId)?.isDefault)
        : (cfg.services?.length ?? 0) === 0,
      stream: form.stream,
    };
    const base = cfg.services ?? [];
    const exists = editingId ? base.some((s) => s.id === editingId) : false;
    const services = exists
      ? base.map((s) => (s.id === editingId ? { ...s, ...svc, id: editingId } : s))
      : [...base, svc];
    // api 指向默认服务(优先默认态,否则回退首个),保持与列表一致
    const api = services.find((s) => s.isDefault) ?? services[0] ?? svc;
    const next: AppConfig = { ...cfg, services, api };
    await invoke("config_save", { cfg: next });
    onUpdate(next);
    setAiSaved(true);
  }

  /* ═══ 步骤2:权限 ═══ */
  const [accessibility, setAccessibility] = useState<boolean | null>(null);
  const [authing, setAuthing] = useState(false);
  const [screenRecording, setScreenRecording] = useState<boolean | null>(null);
  const [screenAuthing, setScreenAuthing] = useState(false);

  useEffect(() => {
    if (step !== 2) return;
    invoke<boolean>("accessibility_status")
      .then(setAccessibility)
      .catch(() => setAccessibility(null));
    invoke<boolean>("screen_recording_status")
      .then(setScreenRecording)
      .catch(() => setScreenRecording(null));

    // 步骤2 聚焦时(从系统设置返回)再检测一次,保证授权状态最新
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        invoke<boolean>("accessibility_status")
          .then(setAccessibility)
          .catch(() => setAccessibility(null));
        invoke<boolean>("screen_recording_status")
          .then(setScreenRecording)
          .catch(() => setScreenRecording(null));
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [step]);

  async function requestAccessibility() {
    setAuthing(true);
    try {
      await invoke("request_accessibility");
      let ok = false;
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 500));
        ok = await invoke<boolean>("accessibility_status").catch(() => false);
        setAccessibility(ok);
        if (ok) break;
      }
      // 原生弹窗仅出现一次;未授权(用户取消/曾拒绝)后不再弹,改打开系统设置
      if (!ok) await invoke("open_privacy_settings", { kind: "accessibility" });
    } catch {
      setAccessibility(false);
      await invoke("open_privacy_settings", { kind: "accessibility" }).catch(() => {});
    }
    setAuthing(false);
  }

  async function requestScreenRecording() {
    setScreenAuthing(true);
    try {
      await invoke("request_screen_recording");
      let ok = false;
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 500));
        ok = await invoke<boolean>("screen_recording_status").catch(() => false);
        setScreenRecording(ok);
        if (ok) break;
      }
      // 原生弹窗仅出现一次;未授权(用户取消/曾拒绝)后不再弹,改打开系统设置
      if (!ok) await invoke("open_privacy_settings", { kind: "screen" });
    } catch {
      setScreenRecording(false);
      await invoke("open_privacy_settings", { kind: "screen" }).catch(() => {});
    }
    setScreenAuthing(false);
  }

  /* ═══ 步骤3:快捷键录制(summarize) ═══ */
  const defaultAccel = (cfg.shortcuts ?? []).find((s) => s.id === "summarize")?.accelerator ?? "";
  const [shortcutAccel, setShortcutAccel] = useState(defaultAccel);
  const [recording, setRecording] = useState(false);
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const recRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (recording) recRef.current?.focus();
  }, [recording]);

  function startRecord() {
    setRecording(true);
    setDraft("");
    setConflict(null);
  }
  function cancelRecord() {
    setRecording(false);
    setDraft("");
  }
  function clearShortcut() {
    setRecording(false);
    setDraft("");
    setConflict(null);
    setShortcutAccel("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!recording) return;
    const key = e.key.toUpperCase();
    if (key === "TAB") return;
    if ((e.metaKey || e.ctrlKey) && (key === "W" || key === "Q")) {
      cancelRecord();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (key === "ESCAPE") {
      cancelRecord();
      return;
    }
    if ((key === "DELETE" || key === "BACKSPACE") && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      clearShortcut();
      return;
    }
    if (IGNORE_KEYS.has(key)) return;
    const parts: string[] = [];
    if (e.metaKey) parts.push("Cmd");
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (!MODIFIER_KEYS.has(key)) parts.push(key);
    const live = parts.join("+");
    setDraft(live);
    if (MODIFIER_KEYS.has(key)) return;
    setRecording(false);
    setDraft("");
    if (SYSTEM_SHORTCUTS.includes(live)) {
      setConflict(`与「${SYSTEM_SHORTCUT_NAMES[live] ?? "系统"}」冲突，请改用其他组合`);
      return;
    }
    const other = (cfg.shortcuts ?? []).find((s) => s.id !== "summarize" && s.accelerator === live);
    if (other) {
      setConflict(`与「${other.name ?? other.id}」快捷键冲突，请改用其他组合`);
      return;
    }
    setConflict(null);
    setShortcutAccel(live);
  }
  function handleKeyUp(e: React.KeyboardEvent) {
    if (!recording) return;
    if (e.key.toUpperCase() === "TAB") return;
    e.preventDefault();
    e.stopPropagation();
    const parts: string[] = [];
    if (e.metaKey) parts.push("Cmd");
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    setDraft(parts.join("+"));
  }

  /* ═══ 完成 / 跳过(统一持久化) ═══ */
  async function finish() {
    const next: AppConfig = { ...cfg, onboardingDone: true };
    // 步骤3 快捷键若已改则落库
    if (shortcutAccel !== defaultAccel) {
      const shortcuts = (cfg.shortcuts ?? []).map((s) =>
        s.id === "summarize" ? { ...s, accelerator: shortcutAccel } : s,
      );
      next.shortcuts = shortcuts;
    }
    await invoke("config_save", { cfg: next });
    onUpdate(next);
    onClose();
  }

  async function goNext() {
    if (step === 0) {
      setStep(1);
    } else if (step === 1) {
      await commitServiceIfNeeded();
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    } else {
      await finish();
    }
  }

  const isLast = step === STEPS.length - 1;
  const stepMeta = STEPS[step];

  return (
    <div className="rb-ob-overlay">
      <div className="rb-float win rb-ob-win">
        <div className="tbar">
          <div className="traffic">
            <i style={{ background: "#FF5F57" }} />
            <i style={{ background: "#FEBC2E" }} />
            <i style={{ background: "#28C840" }} />
          </div>
        </div>

        <div className="rb-ob-body">
          {/* 进度点 */}
          <div className="rb-ob-dots">
            {STEPS.map((_, i) => (
              <span key={i} className={`rb-ob-dot${i <= step ? " on" : ""}`} />
            ))}
          </div>

          <div className="flex g18 rb-ob-grid">
            {/* 左栏:图标 + 标题 + 说明 */}
            <div className="rb-ob-aside">
              <div className="rb-ob-mark">
                <Icon name={stepMeta.icon} size={20} />
              </div>
              {step === 0 ? (
                <>
                  <div className="rb-ob-title">{t("onboarding.welcomeTitle")}</div>
                  <div className="muted rb-ob-desc">{t("onboarding.welcomeDesc")}</div>
                  <div className="rb-ob-checklist">
                    <div className="flex ac g8">
                      <span className="rb-ob-num">1</span>
                      <span>{t("onboarding.welcome1")}</span>
                    </div>
                    <div className="flex ac g8">
                      <span className="rb-ob-num">2</span>
                      <span>{t("onboarding.welcome2")}</span>
                    </div>
                    <div className="flex ac g8">
                      <span className="rb-ob-num">3</span>
                      <span>{t("onboarding.welcome3")}</span>
                    </div>
                  </div>
                </>
              ) : step === 1 ? (
                <>
                  <div className="rb-ob-title">{t("onboarding.aiTitle")}</div>
                  <div className="muted rb-ob-desc">{t("onboarding.aiDesc")}</div>
                </>
              ) : step === 2 ? (
                <>
                  <div className="rb-ob-title">{t("onboarding.permsTitle")}</div>
                  <div className="muted rb-ob-desc">{t("onboarding.permsDesc")}</div>
                </>
              ) : (
                <>
                  <div className="rb-ob-title">{t("onboarding.shortcutTitle")}</div>
                  <div className="muted rb-ob-desc">{t("onboarding.shortcutDesc")}</div>
                </>
              )}
            </div>

            {/* 右栏:表单 */}
            <div className="rb-ob-main">
              {step === 1 ? (
                <ServiceFields
                  form={form}
                  set={set}
                  fmtOpen={fmtOpen}
                  setFmtOpen={setFmtOpen}
                  showKey={showKey}
                  setShowKey={setShowKey}
                  testing={testing}
                  latency={latency}
                  onTest={handleTest}
                  aiSaved={aiSaved}
                />
              ) : null}

              {step === 2 ? (
                <div className="rb-ob-perms">
                  <div className="rb-ob-perm">
                    <div className="flex ac g8">
                      <span className="rb-ob-perm-ic">
                        <Icon name="shield" size={14} />
                      </span>
                      <div>
                        <div className="rb-ob-perm-name">{t("onboarding.accessibility")}</div>
                        <div className="muted rb-ob-perm-desc">{t("onboarding.accessibilityDesc")}</div>
                      </div>
                    </div>
                    {accessibility === true ? (
                      <span className="tag tag-ok">
                        <Icon name="check" size={11} />
                        {t("onboarding.granted")}
                      </span>
                    ) : accessibility === false ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => void requestAccessibility()} disabled={authing}>
                        {t("onboarding.grant")}
                      </button>
                    ) : (
                      <span className="tag tag-gray">{t("onboarding.detecting")}</span>
                    )}
                  </div>

                  <div className="rb-ob-perm">
                    <div className="flex ac g8">
                      <span className="rb-ob-perm-ic rb-ob-perm-ic-pro">
                        <Icon name="screen" size={14} />
                      </span>
                      <div>
                        <div className="flex ac g6">
                          <span className="rb-ob-perm-name">{t("onboarding.screen")}</span>
                          <span className="tag tag-pro">PRO</span>
                        </div>
                        <div className="muted rb-ob-perm-desc">{t("onboarding.screenDesc")}</div>
                      </div>
                    </div>
                    {screenRecording === true ? (
                      <span className="tag tag-ok">
                        <Icon name="check" size={11} />
                        {t("onboarding.granted")}
                      </span>
                    ) : screenRecording === false ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => void requestScreenRecording()} disabled={screenAuthing}>
                        {t("onboarding.grant")}
                      </button>
                    ) : (
                      <span className="tag tag-gray">{t("onboarding.detecting")}</span>
                    )}
                  </div>
                </div>
              ) : null}

              {step === 3 ? (
                <div className="rb-ob-shortcut">
                  <div className="rb-ob-field-label">{t("onboarding.shortcutLabel")}</div>
                  <div
                    ref={recRef}
                    className={`rb-recorder${
                      recording
                        ? " rb-recorder--recording"
                        : shortcutAccel
                          ? " rb-recorder--bound"
                          : " rb-recorder--empty"
                    }${conflict ? " rb-recorder--conflict" : ""}`}
                    tabIndex={0}
                    role="button"
                    title={shortcutAccel ? "点击重新录制" : "点击录制"}
                    onClick={() => {
                      if (!recording) startRecord();
                    }}
                    onKeyDown={handleKeyDown}
                    onKeyUp={handleKeyUp}
                    onBlur={cancelRecord}
                  >
                    <span className="rb-recorder-main">
                      {recording ? (
                        <>
                          <span className="rb-recorder-dot" />
                          {draft ? (
                            <span className="rb-recorder-combo">
                              {draft.split("+").map(keySymbol).join("")}
                            </span>
                          ) : (
                            <span className="rb-recorder-wait">{t("onboarding.recording")}</span>
                          )}
                        </>
                      ) : shortcutAccel ? (
                        shortcutAccel.split("+").map((k) => (
                          <span className="kbd" key={k}>
                            {keySymbol(k)}
                          </span>
                        ))
                      ) : (
                        <>
                          <Icon name="plus" size={13} />
                          点击录制
                        </>
                      )}
                    </span>
                    {recording ? (
                      <span
                        className="rb-recorder-hint"
                        title="取消录制 (Esc)"
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelRecord();
                        }}
                      >
                        Esc
                      </span>
                    ) : shortcutAccel ? (
                      <span
                        className="rb-recorder-hint"
                        title="清除快捷键"
                        onClick={(e) => {
                          e.stopPropagation();
                          clearShortcut();
                        }}
                      >
                        <Icon name="close" size={12} />
                      </span>
                    ) : null}
                  </div>
                  {conflict ? (
                    <div className="rb-ob-conflict">{conflict}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {/* 底部:跳过 / 下一步 */}
          <div className="rb-ob-foot">
            <button className="btn btn-ghost rb-ob-skip" onClick={() => void finish()}>
              {t("onboarding.skip")}
            </button>
            <button className="btn btn-primary rb-ob-next" onClick={() => void goNext()}>
              {isLast ? t("onboarding.done") : t("onboarding.next")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══ 步骤1 内联服务表单(字段与设置中心新增服务弹窗一致) ═══ */
interface ServiceFieldsProps {
  form: ApiConfig;
  set: (patch: Partial<ApiConfig>) => void;
  fmtOpen: boolean;
  setFmtOpen: (v: boolean) => void;
  showKey: boolean;
  setShowKey: (v: boolean) => void;
  testing: boolean;
  latency: { ok: boolean; ms: number } | null;
  onTest: () => void;
  aiSaved: boolean;
}

function ServiceFields({
  form,
  set,
  fmtOpen,
  setFmtOpen,
  showKey,
  setShowKey,
  testing,
  latency,
  onTest,
  aiSaved,
}: ServiceFieldsProps) {
  const fmt = FORMAT_META[form.protocol as ProviderType];
  return (
    <div className="rb-ob-form">
      <div className="rb-ob-row">
        <div className="rb-ob-field">
          <div className="rb-ob-field-label">{t("onboarding.format")}</div>
          <div className="rb-svc-drop">
            <div
              className="set-pick rb-ob-pick"
              style={{ justifyContent: "space-between", cursor: "pointer" }}
              onClick={() => setFmtOpen(!fmtOpen)}
            >
              <span>{fmt.name}</span>
              <Icon name="chevronDown" size={14} style={{ color: "var(--rb-text-tertiary)" }} />
            </div>
            {fmtOpen ? (
              <div className="rb-svc-drop-menu rb-ob-fmt-menu">
                {FORMAT_ORDER.map((p) => (
                  <div
                    key={p}
                    className={`svc-mi${p === form.protocol ? " on" : ""}`}
                    onClick={() => {
                      set({ protocol: p, model: FORMAT_META[p].defaultModel });
                      setFmtOpen(false);
                    }}
                  >
                    <Icon name="globe" size={14} className="svc-mi-icon" />
                    <div className="grow">
                      <div className="svc-mi-t">{FORMAT_META[p].name}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="rb-ob-field">
          <div className="rb-ob-field-label">{t("onboarding.name")}</div>
          <input
            className="inp"
            value={form.name ?? ""}
            onChange={(e) => set({ name: e.currentTarget.value })}
            placeholder={fmt.name}
          />
        </div>
      </div>

      <div className="rb-ob-field">
        <div className="rb-ob-field-label">{t("settings.baseUrl")}</div>
        <input
          className="inp mono"
          value={form.baseUrl}
          onChange={(e) => set({ baseUrl: e.currentTarget.value })}
          placeholder={fmt.official}
        />
      </div>

      <div className="rb-ob-field">
        <div className="rb-ob-field-label">{t("settings.apiKey")}</div>
        <div className="rb-key-input">
          <input
            className="inp mono"
            type={showKey ? "text" : "password"}
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => set({ apiKey: e.currentTarget.value })}
            placeholder={form.protocol === "openai" ? "sk-..." : form.protocol === "claude" ? "sk-ant-..." : "AIza..."}
          />
          <button className="iconbtn rb-key-toggle" onClick={() => setShowKey(!showKey)}>
            <Icon name="eye" size={14} />
          </button>
        </div>
      </div>

      <div className="rb-ob-row">
        <div className="rb-ob-field">
          <div className="rb-ob-field-label">{t("settings.model")}</div>
          <input
            className="inp mono"
            value={form.model}
            onChange={(e) => set({ model: e.currentTarget.value })}
            placeholder={fmt.defaultModel}
          />
        </div>
        <div className="rb-ob-field rb-ob-field-switch">
          <div className="rb-ob-field-label">{t("onboarding.stream")}</div>
          <div className={`sw${form.stream ? " on" : ""}`} onClick={() => set({ stream: !form.stream })} />
        </div>
      </div>

      <div className="rb-ob-test">
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => void onTest()}
          disabled={!form.apiKey.trim() || testing}
        >
          <Icon name="refresh" size={14} className={testing ? "rb-spin" : ""} />
          {t("onboarding.test")}
        </button>
        {latency ? latency.ok ? (
          <span className="tag tag-ok">响应 {latency.ms}ms</span>
        ) : (
          <span className="tag rb-tag-err">{t("onboarding.connectFailed")}</span>
        ) : null}
        {aiSaved ? (
          <span className="tag tag-gray">已保存</span>
        ) : null}
      </div>

      <div className="muted rb-ob-hint">{t("onboarding.baseUrlFallback")}</div>
    </div>
  );
}
