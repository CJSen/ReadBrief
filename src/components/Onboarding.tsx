import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppConfig, ApiConfig, ProviderType } from "../lib/config/types";
import { testConnection, listModels } from "../lib/ai/provider";
import { t } from "../lib/i18n";
import { Icon, type IconName } from "./Icon";
import { resolveShortcutKey, keySymbol } from "../lib/shortcutKey";
import { isMac } from "../lib/platform";
import "./Onboarding.css";

/* ═══ 步骤定义 ═══ */
const STEPS: Array<{ key: string; name: string; icon: IconName }> = [
  { key: "welcome", name: "欢迎", icon: "summarize" },
  { key: "ai", name: "配置 AI 服务", icon: "zap" },
  { key: "perms", name: "开启权限", icon: "shield" },
  { key: "shortcut", name: "自定义快捷键", icon: "keyboard" },
  { key: "overview", name: "概览", icon: "check" },
];

/** 概览页「已配置的服务」格式展示名(对齐设计稿 OpenAI 兼容 等) */
const FORMAT_COMPAT: Record<ProviderType, string> = {
  openai: "OpenAI 兼容",
  claude: "Claude 兼容",
  gemini: "Gemini 兼容",
  deepseek: "DeepSeek 官方",
};

/* 与 AiServicesPage 一致的服务商默认(官方 Base URL / 默认模型) */
const FORMAT_META: Record<ProviderType, { name: string; official: string; defaultModel: string }> = {
  openai: { name: "OpenAI 格式", official: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  claude: { name: "Claude 格式", official: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-20250514" },
  gemini: { name: "Gemini 格式", official: "https://generativelanguage.googleapis.com", defaultModel: "gemini-2.0-flash" },
  deepseek: { name: "DeepSeek 官方", official: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
};
const FORMAT_ORDER: ProviderType[] = ["openai", "claude", "gemini", "deepseek"];

/** 模型下拉候选(组合框:可手输,打开态供选择);与 AiServicesPage 一致 */
const MODEL_SUGGESTIONS: string[] = ["deepseek-chat", "deepseek-reasoner", "gpt-4o-mini"];

/* ═══ 快捷键录制(复用 ShortcutsPage 范式,仅绑定 summarize) ═══ */
const MODIFIER_KEYS = new Set(["CONTROL", "SHIFT", "ALT", "META"]);
const IGNORE_KEYS = new Set(["CAPSLOCK", "FN", "FUNCTION", "NUMLOCK"]);
const SYSTEM_SHORTCUTS = ["Cmd+Space", "Cmd+Tab", "Ctrl+Space"];
/* 系统快捷键友好名(冲突说明用,复用 ShortcutsPage 的 i18n key) */
const SYSTEM_SHORTCUT_NAMES: Record<string, string> = {
  "Cmd+Space": "shortcuts.sysFocusSearch",
  "Cmd+Tab": "shortcuts.sysAppSwitch",
  "Ctrl+Space": "shortcuts.sysImeSwitch",
};

/** 将 "Cmd+Shift+Z" 之类的快捷键串渲染为 <kbd> 元素序列 */
function accelKbds(accel: string): React.ReactNode {
  return accel.split("+").map((k, i) => (
    <span className="kbd" key={`${k}-${i}`}>
      {keySymbol(k)}
    </span>
  ));
}

interface OnboardingProps {
  cfg: AppConfig;
  /** 持久化并同步父组件配置(不负责关闭覆盖层) */
  onUpdate: (next: AppConfig) => void;
  /** 显式关闭覆盖层(仅完成/跳过时调用) */
  onClose: () => void;
}

export function Onboarding({ cfg, onUpdate, onClose }: OnboardingProps) {
  // 从持久化步骤恢复:中途重启软件后引导从该步继续,而非从头再来
  const [step, setStep] = useState(() => cfg.onboardingStep ?? 0);

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
          model: "",
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
        extraParams: form.extraParams ?? null,
      });
      setLatency({ ok: r.ok, ms: r.latencyMs ?? 0 });
    } finally {
      setTesting(false);
    }
  }

  /** 离开步骤1:有 API Key 则落库;编辑既有服务时就地更新,避免重复新建。
   *  返回落库后的完整配置(供步骤持久化复用),无实际写入时返回 null。 */
  async function commitServiceIfNeeded(): Promise<AppConfig | null> {
    if (aiSaved) return null;
    const key = form.apiKey.trim();
    // 零配置可继续:无任何用户输入时不落库(避免写入一个与默认空 api 重复的空服务)。
    // 但只要填了 Base URL / 名称 / Key 任一,即视为有意配置,即便缺 Key 也保留输入(到设置里再补 Key)。
    const hasInput = Boolean(key || form.baseUrl.trim() || form.name?.trim());
    if (!hasInput) {
      if (editingId) setAiSaved(true);
      return null;
    }
    const svc: ApiConfig = {
      id: editingId ?? `svc_ob_${Date.now()}`,
      name: form.name?.trim() || FORMAT_META[form.protocol as ProviderType].name,
      protocol: form.protocol,
      apiKey: key,
      // deepseek 官方格式锁定 Base URL(UI 已禁用,此处保存兜底)
      baseUrl: form.protocol === "deepseek" ? FORMAT_META.deepseek.official : form.baseUrl.trim(),
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
    return next;
  }

  /** 持久化当前引导步骤:重启软件后可从该步继续 */
  async function persistStep(nextStep: number, base: AppConfig = cfg) {
    const next: AppConfig = { ...base, onboardingStep: nextStep };
    await invoke("config_save", { cfg: next }).catch(() => {});
    onUpdate(next);
  }

  /* ═══ 步骤2:权限 ═══ */
  const [accessibility, setAccessibility] = useState<boolean | null>(null);
  const [authing, setAuthing] = useState(false);
  const [screenRecording, setScreenRecording] = useState<boolean | null>(null);
  const [screenAuthing, setScreenAuthing] = useState(false);
  /** 已点击过屏幕录制授权(用于提示"需重启生效"),避免首次未授权时误提示 */
  const [screenAttempted, setScreenAttempted] = useState(false);

  /* 开机启动:默认开(与设置中心一致),联动系统 LaunchAgent */
  const [launchOnStart, setLaunchOnStart] = useState<boolean>(cfg.launchOnStart ?? true);

  /** 未授权辅助功能时点「下一步」的二次确认弹窗 */
  const [showPermConfirm, setShowPermConfirm] = useState(false);

  useEffect(() => {
    if (step !== 2) return;
    // 统一检测:读取两项权限状态
    const check = () => {
      invoke<boolean>("accessibility_status")
        .then(setAccessibility)
        .catch(() => setAccessibility(null));
      invoke<boolean>("screen_recording_status")
        .then(setScreenRecording)
        .catch(() => setScreenRecording(null));
    };
    check();
    // 轮询兜底:macOS 在「系统设置」授权后,窗口焦点事件不一定可靠触发,
    // 持续检测保证返回软件后授权状态能即时刷新(仅在权限步骤期间运行)。
    const timer = window.setInterval(check, 1000);
    // 窗口重新聚焦时也立即检测一次
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        check();
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, [step]);

  async function requestAccessibility() {
    setAuthing(true);
    try {
      await invoke("request_accessibility");
      let ok = false;
      for (let i = 0; i < 4; i++) {
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
    setScreenAttempted(true);
    setScreenAuthing(true);
    try {
      await invoke("request_screen_recording");
      let ok = false;
      for (let i = 0; i < 4; i++) {
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

  async function toggleLaunchOnStart(enabled: boolean) {
    setLaunchOnStart(enabled);
    // 写入系统 LaunchAgent(登录时自启);失败则回滚开关
    try {
      await invoke("autostart_set", { enabled });
    } catch {
      setLaunchOnStart(!enabled);
      return;
    }
    const next: AppConfig = { ...cfg, launchOnStart: enabled };
    await invoke("config_save", { cfg: next }).catch(() => {});
    onUpdate(next);
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
    // 实体键:Option 下 e.key 被合成死键字符(å/ø/∆),改用 e.code 还原字母/数字
    const physKey = resolveShortcutKey(e);
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
    if (!MODIFIER_KEYS.has(physKey)) parts.push(physKey);
    const live = parts.join("+");
    setDraft(live);
    if (MODIFIER_KEYS.has(physKey)) return;
    setRecording(false);
    setDraft("");
    if (SYSTEM_SHORTCUTS.includes(live)) {
      const sysName = t(SYSTEM_SHORTCUT_NAMES[live] ?? "shortcuts.sysOther");
      setConflict(t("shortcuts.conflictSystem", { name: sysName }));
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
    // 收尾前补存 AI 服务:覆盖「第二步填完直接点跳过」「未走 commitServiceIfNeeded」等路径,
    // 确保引导填写的 AI 配置(含未填 Key 的输入)最终落库,而非仅依赖「下一步」离开第二步。
    let base: AppConfig = cfg;
    if (!aiSaved) {
      const saved = await commitServiceIfNeeded();
      if (saved) base = saved;
    }
    const next: AppConfig = {
      ...base,
      onboardingDone: true,
      onboardingStep: undefined,
      launchOnStart,
    };
    // 同步开机启动到系统 LaunchAgent:仅当系统真实状态与目标不一致时才写。
    // 此前无条件写入,看似幂等,但 OS 层面重复 enable 会重新 load LaunchAgent,
    // 触发 macOS「登录项」通知;且同一次引导内若拨过开关(toggle 已写过一次)会重复弹。
    // 比对「系统真实状态」而非 cfg:保证「引导显示开但系统未注册」时仍会写入,已一致则跳过。
    const sysEnabled = await invoke<boolean>("autostart_status").catch(() => launchOnStart);
    if (sysEnabled !== launchOnStart) {
      await invoke("autostart_set", { enabled: launchOnStart }).catch(() => {});
    }
    // 步骤3 快捷键若已改则落库
    if (shortcutAccel !== defaultAccel) {
      const shortcuts = (base.shortcuts ?? []).map((s) =>
        s.id === "summarize" ? { ...s, accelerator: shortcutAccel } : s,
      );
      next.shortcuts = shortcuts;
    }
    await invoke("config_save", { cfg: next });
    onUpdate(next);
    onClose();
  }

  /** 离开权限步骤(第3步):进入快捷键步骤(第4步) */
  async function proceedFromPerms() {
    const nextStep = 3;
    setStep(nextStep);
    await persistStep(nextStep);
  }

  /** 返回上一步(第1步欢迎页无前序,不显示该按钮) */
  async function goPrev() {
    if (step <= 0) return;
    const nextStep = step - 1;
    setStep(nextStep);
    await persistStep(nextStep);
  }

  async function goNext() {
    if (step === 0) {
      const nextStep = 1;
      setStep(nextStep);
      await persistStep(nextStep);
    } else if (step === 1) {
      const saved = await commitServiceIfNeeded();
      const nextStep = 2;
      setStep(nextStep);
      await persistStep(nextStep, saved ?? cfg);
    } else if (step === 2) {
      // 权限步骤:辅助功能明确未授权时,弹二次确认拦截,避免用户裸奔划词
      if (accessibility === false) {
        setShowPermConfirm(true);
        return;
      }
      await proceedFromPerms();
    } else if (step === 3) {
      const nextStep = 4;
      setStep(nextStep);
      await persistStep(nextStep);
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

          {step === 4 ? (
            <div className="rb-ob-overview">
              {/* 第5步 · 概览:已配置服务 + 快捷键双栏 */}
              <div className="flex ac g8 rb-ob-ov-head">
                <span className="rb-ob-ov-check">
                  <Icon name="check" size={15} />
                </span>
                <div className="rb-ob-ov-title">{t("onboarding.overviewTitle")}</div>
              </div>
              <div className="muted rb-ob-ov-sub">{t("onboarding.overviewDesc")}</div>
              <div className="flex rb-ob-ov-grid">
                <div className="rb-ob-ov-col rb-ob-ov-col-shortcuts">
                  <div className="rb-ob-ov-label">{t("onboarding.overviewShortcuts")}</div>
                  <div className="rb-ob-ov-list">
                    {[
                      { label: t("onboarding.shortcutLabel"), accel: shortcutAccel },
                      { label: t("onboarding.shortcutCopy"), accel: isMac() ? "Cmd+C" : "Ctrl+C" },
                      { label: t("onboarding.shortcutRegenerate"), accel: isMac() ? "Cmd+R" : "Ctrl+R" },
                      { label: t("onboarding.shortcutPin"), accel: isMac() ? "Cmd+P" : "Ctrl+P" },
                    ].map((s) => (
                      <div className="flex ac jb" key={s.label}>
                        <span className="rb-ob-ov-name">{s.label}</span>
                        <span className="flex g4">{accelKbds(s.accel)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rb-ob-ov-col rb-ob-ov-col-svc">
                  <div className="rb-ob-ov-label">{t("onboarding.overviewServices")}</div>
                  <div className="rb-ob-ov-svc">
                    <div className="rb-ob-ov-svc-row">
                      <span className="muted">{t("onboarding.format")}</span>
                      <span className="rb-ob-ov-svc-val">{FORMAT_COMPAT[form.protocol as ProviderType]}</span>
                    </div>
                    <div className="rb-ob-ov-svc-row">
                      <span className="muted">{t("settings.baseUrl")}</span>
                      <span className="rb-ob-ov-svc-val">
                        {form.baseUrl.trim()
                          ? form.baseUrl.trim().replace(/^https?:\/\//, "")
                          : t("onboarding.baseUrlFallbackDefault")}
                      </span>
                    </div>
                    <div className="rb-ob-ov-svc-row">
                      <span className="muted">{t("settings.model")}</span>
                      <span className="rb-ob-ov-svc-val mono">
                        {form.model.trim() || FORMAT_META[form.protocol as ProviderType].defaultModel}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
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
                  {isMac() && (<div className={`rb-ob-perm${accessibility === false ? " rb-ob-perm-error" : ""}`}>
                    <div className="flex ac g8">
                      <span className={`rb-ob-perm-ic${accessibility === false ? " rb-ob-perm-ic-error" : ""}`}>
                        <Icon name="shield" size={14} />
                      </span>
                      <div>
                        <div className="rb-ob-perm-name">
                          {t("onboarding.accessibility")}
                          {accessibility === false ? (
                            <span className="rb-ob-perm-badge">{t("onboarding.permsNotGranted")}</span>
                          ) : null}
                        </div>
                        {accessibility === false ? (
                          <div className="rb-ob-perm-err-desc">{t("onboarding.permsNotAuth")}</div>
                        ) : (
                          <div className="muted rb-ob-perm-desc">{t("onboarding.accessibilityDesc")}</div>
                        )}
                      </div>
                    </div>
                    {accessibility === true ? (
                      <span className="tag tag-ok">
                        <Icon name="check" size={11} />
                        {t("onboarding.granted")}
                      </span>
                    ) : accessibility === false ? (
                      <button className="btn btn-sm rb-ob-perm-grant" onClick={() => void requestAccessibility()} disabled={authing}>
                        {t("onboarding.grant")}
                      </button>
                    ) : (
                      <span className="tag tag-gray">{t("onboarding.detecting")}</span>
                    )}
                  </div>)}

                  {isMac() && (<div className="rb-ob-perm">
                    <div className="flex ac g8">
                      <span className="rb-ob-perm-ic rb-ob-perm-ic-pro">
                        <Icon name="screen" size={14} />
                      </span>
                      <div>
                        <div className="flex ac g6">
                          <span className="rb-ob-perm-name">{t("onboarding.screen")}</span>
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
                    {/* 已申请屏幕录制授权但状态未变:macOS 需重启生效,提示用户且引导可继续 */}
                    {screenAttempted && screenRecording !== true ? (
                      <div className="muted rb-ob-perm-hint">
                        {t("onboarding.screenRestartHint")}
                      </div>
                    ) : null}
                  </div>)}

                  <div className="rb-ob-perm">
                    <div className="flex ac g8">
                      <span className="rb-ob-perm-ic">
                        <Icon name="power" size={14} />
                      </span>
                      <div>
                        <div className="rb-ob-perm-name">{t("onboarding.launchOnStart")}</div>
                        <div className="muted rb-ob-perm-desc">{t("onboarding.launchOnStartDesc")}</div>
                      </div>
                    </div>
                    <div
                      className={`sw${launchOnStart ? " on" : ""}`}
                      role="switch"
                      aria-checked={launchOnStart}
                      onClick={() => void toggleLaunchOnStart(!launchOnStart)}
                    />
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
                    title={shortcutAccel ? t("shortcuts.reopenRecord") : t("shortcuts.clickRecord")}
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
                          {t("shortcuts.clickRecord")}
                        </>
                      )}
                    </span>
                    {recording ? (
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
                    ) : shortcutAccel ? (
                      <span
                        className="rb-recorder-hint"
                        title={t("shortcuts.clear")}
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
          )}

          {/* 底部:跳过 / 上一步 + 下一步(末步为完成) */}
          <div className="rb-ob-foot">
            <button className="btn btn-ghost rb-ob-skip" onClick={() => void finish()}>
              {t("onboarding.skip")}
            </button>
            <div className="rb-ob-foot-right">
              {step > 0 ? (
                <button className="btn btn-ghost rb-ob-prev" onClick={() => void goPrev()}>
                  {t("onboarding.prev")}
                </button>
              ) : null}
              <button className="btn btn-primary rb-ob-next" onClick={() => void goNext()}>
                {isLast ? t("onboarding.done") : t("onboarding.next")}
              </button>
            </div>
          </div>
        </div>

        {/* 未授权点「下一步」的二次确认弹窗(覆盖整个引导窗口) */}
        {showPermConfirm ? (
          <div className="rb-ob-confirm-overlay">
            <div className="rb-ob-confirm">
              <div className="rb-ob-confirm-body">
                <div className="flex ac g8" style={{ marginBottom: 9 }}>
                  <span className="rb-ob-confirm-ic">
                    <Icon name="alert" size={15} />
                  </span>
                  <span className="rb-ob-confirm-title">{t("onboarding.confirmTitle")}</span>
                </div>
                <div className="rb-ob-confirm-desc">{t("onboarding.confirmDesc")}</div>
              </div>
              <div className="rb-ob-confirm-foot">
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => {
                    void requestAccessibility();
                    setShowPermConfirm(false);
                  }}
                >
                  {t("onboarding.grant")}
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    setShowPermConfirm(false);
                    void proceedFromPerms();
                  }}
                >
                  {t("onboarding.confirmContinue")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
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

  /* ═══ 模型组合框(与 AiServicesPage 一致:可手输 + 下拉调接口拉取) ═══ */
  const modelInputRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelMenuPos, setModelMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelErr, setModelErr] = useState<string | null>(null);

  /** 打开模型下拉:记录触发器位置(portal 用 fixed 定位)并用表单实时值调接口拉取 */
  async function openModelPicker() {
    const el = modelInputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 越界保护:底部空间不足(菜单高 196px)时向上展开
    const MENU_MAX_H = 196;
    let top = rect.bottom + 4;
    if (top + MENU_MAX_H > window.innerHeight) {
      top = Math.max(4, rect.top - MENU_MAX_H - 4);
    }
    setModelMenuPos({ top, left: rect.left, width: rect.width });
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

  /** 模型候选:接口结果优先;失败/为空回退 [当前值 + 内置候选] 去重 */
  const modelOptions =
    models && models.length
      ? [form.model, ...models].filter((m, i, arr) => Boolean(m) && arr.indexOf(m) === i)
      : [form.model, ...MODEL_SUGGESTIONS].filter((m, i, arr) => Boolean(m) && arr.indexOf(m) === i);

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
                      // deepseek 官方格式锁定 Base URL(与 AiServicesPage 一致)
                      set({ protocol: p, model: "", ...(p === "deepseek" ? { baseUrl: FORMAT_META[p].official } : {}) });
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
          value={form.protocol === "deepseek" ? FORMAT_META.deepseek.official : form.baseUrl}
          disabled={form.protocol === "deepseek"}
          title={form.protocol === "deepseek" ? "DeepSeek 官方格式固定使用该地址" : undefined}
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

      <div className="rb-ob-row rb-ob-row-model">
        <div className="rb-ob-field">
          <div className="rb-ob-field-label">{t("settings.model")}</div>
          {/* 模型:组合框(可手输 + 下拉调接口拉取),与 AiServicesPage 一致 */}
          <div className="rb-svc-model" ref={modelInputRef}>
            <input
              className="inp mono rb-svc-model-input"
              value={form.model}
              onChange={(e) => set({ model: e.currentTarget.value })}
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
