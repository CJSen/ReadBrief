import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppConfig } from "../lib/config/types";
import { getLanguage, setLanguage, t, useLanguage, type Language } from "../lib/i18n";
import { applyPreference, applyFontScale, type ThemePreference } from "../lib/theme";
import { Icon } from "./Icon";
import { LogoMark } from "./LogoMark";
import { ShortcutsPage } from "./ShortcutsPage";
import { PromptManager } from "./PromptManager";
import { AiServicesPage } from "./AiServicesPage";
import { Onboarding } from "./Onboarding";
import { SUMMARY_LANGUAGES, normalizeSummaryLang } from "../lib/prompts/languages";
import { checkUpdate, RELEASE_PAGE, type UpdateInfo } from "../lib/update/checkUpdate";
import { renderMarkdown, archLabel } from "../lib/update/markdown";

type SettingsSection =
  | "general"
  | "ai"
  | "shortcuts"
  | "prompts"
  | "appearance"
  | "privacy"
  | "subscription"
  | "about";

/** 字体大小五档(设置中心「外观与语言」) */
const FONT_SCALES = [0.8, 0.9, 1.0, 1.1, 1.2];

const NAV_ITEMS: Array<{ id: SettingsSection; icon: string; pro?: boolean }> = [
  { id: "general", icon: "tag" },
  { id: "ai", icon: "globe" },
  { id: "prompts", icon: "list" },
  { id: "shortcuts", icon: "prompts" },
  { id: "appearance", icon: "settings" },
  { id: "privacy", icon: "shield" },
  { id: "about", icon: "question" },
];

export function AppSettings() {
  // 订阅语言变更,切语言时即时重渲染(设置窗常驻,需跟随界面语言切换)
  useLanguage();
  const [section, setSection] = useState<SettingsSection>("general");
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [lang, setLang] = useState<Language>(() => getLanguage());
  const [theme, setThemeState] = useState<ThemePreference>("system");
  /** 设置内「打开引导」:渲染首启引导覆盖层(复用现有 cfg,预填已有数据) */
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    invoke<AppConfig>("config_get")
      .then((c) => {
        setCfg(c);
        // 从配置恢复语言:同步到 i18n(否则重启后界面文案仍是默认语言)
        if (c.language === "en" || c.language === "zh") setLanguage(c.language);
        setLang(getLanguage());
        if (c.theme === "dark" || c.theme === "light") setThemeState(c.theme);
      })
      .catch(() => setCfg(null));
  }, []);

  // 配置变更(其它窗口/首启引导/引导覆盖层写入)时同步到本窗口 cfg。
  // settings 窗口在应用启动即创建且常驻(hidden),若仅依赖挂载时的一次 config_get,
  // 首启引导在主窗口完成后本窗口仍显示启动时的空配置(「AI 服务」数据为空)。
  useEffect(() => {
    const un = listen<AppConfig>("config-changed", (e) => {
      setCfg(e.payload);
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  // 状态栏「关于ReadBrief」等入口:打开设置并跳转到指定分区
  useEffect(() => {
    const un = listen<string>("navigate-settings", (e) => {
      const target = e.payload as SettingsSection;
      setSection(target);
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  // 状态栏划词监听开关与设置-通用「启用划词监听」双向联动
  useEffect(() => {
    const un = listen<boolean>("selection-state-changed", (e) => {
      const v = e.payload;
      setCfg((prev) => (prev ? { ...prev, selectionOn: v } : prev));
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  async function saveConfig(next: AppConfig) {
    await invoke("config_save", { cfg: next });
    setCfg(next);
  }

  function handleLanguageChange(next: Language) {
    setLang(next);
    setLanguage(next);
    if (cfg) void saveConfig({ ...cfg, language: next });
  }

  function handleThemeChange(next: ThemePreference) {
    setThemeState(next);
    applyPreference(next);
    if (cfg) void saveConfig({ ...cfg, theme: next });
  }

  return (
    <div className="rb-settings-layout">
      {/* 左侧分类导航 180px */}
      <aside className="rb-settings-nav">
        {NAV_ITEMS.map((item) => (
          <div
            key={item.id}
            className={`rb-settings-nav-item${section === item.id ? " active" : ""}`}
            onClick={() => setSection(item.id)}
          >
            <Icon name={item.icon} size={14} />
            {t(`settings.nav.${item.id}`)}
          </div>
        ))}
      </aside>

      {/* 右侧内容 */}
      <div className="rb-settings-content">
        {section === "general" && cfg ? (
          <GeneralPage cfg={cfg} onConfigChange={setCfg} onOpenOnboarding={() => setShowOnboarding(true)} />
        ) : null}
        {section === "ai" && cfg ? (
          <AiServicesPage cfg={cfg} onConfigChange={setCfg} />
        ) : null}
        {section === "prompts" && cfg ? (
          <PromptManager cfg={cfg} onConfigChange={setCfg} />
        ) : null}
        {section === "shortcuts" && cfg ? (
          <ShortcutsPage cfg={cfg} onConfigChange={setCfg} />
        ) : null}
        {section === "appearance" && cfg ? (
          <AppearancePage
            theme={theme}
            lang={lang}
            cfg={cfg}
            onTheme={handleThemeChange}
            onLang={handleLanguageChange}
            onSummaryLang={(s) => void saveConfig({ ...cfg, summaryLanguage: s })}
            onFontScale={(s) => {
              applyFontScale(s);
              void saveConfig({ ...cfg, fontScale: s });
            }}
          />
        ) : null}
        {section === "privacy" && cfg ? <PrivacyPage cfg={cfg} onConfigChange={setCfg} /> : null}
        {section === "about" ? <AboutPage /> : null}
      </div>

      {/* 设置内「打开引导」:全窗口覆盖层,复用现有 cfg 预填已有数据 */}
      {showOnboarding && cfg ? (
        <Onboarding
          cfg={cfg}
          onUpdate={(next) => setCfg(next)}
          onClose={() => setShowOnboarding(false)}
        />
      ) : null}
    </div>
  );
}

/* ═══ 通用 ═══ */
function GeneralPage({
  cfg,
  onConfigChange,
  onOpenOnboarding,
}: {
  cfg: AppConfig;
  onConfigChange: (c: AppConfig) => void;
  onOpenOnboarding: () => void;
}) {
  const [launchOnStart, setLaunchOnStart] = useState(cfg.launchOnStart ?? true);
  const [escClose, setEscClose] = useState(cfg.escClose ?? true);
  const [clickOutside, setClickOutside] = useState(cfg.clickOutside ?? false);
  // 辅助功能(Accessibility)授权状态:true=已授权 / false=未授权 / null=检测中
  const [accessibility, setAccessibility] = useState<boolean | null>(null);
  const [authing, setAuthing] = useState(false);
  // 屏幕录制(Screen Recording)授权状态:true=已授权 / false=未授权 / null=检测中
  const [screenRecording, setScreenRecording] = useState<boolean | null>(null);
  const [screenAuthing, setScreenAuthing] = useState(false);

  // 开机启动读取系统真实状态(LaunchAgent 是否已注册)
  useEffect(() => {
    invoke<boolean>("autostart_status")
      .then(setLaunchOnStart)
      .catch(() => {});
    invoke<boolean>("accessibility_status")
      .then(setAccessibility)
      .catch(() => setAccessibility(null));
    invoke<boolean>("screen_recording_status")
      .then(setScreenRecording)
      .catch(() => setScreenRecording(null));
  }, []);

  // 其它窗口(如主窗口引导)改动了开机启动后,经 config-changed 同步到本页开关,
  // 避免仅依赖挂载时的一次读取导致开关状态陈旧(引导里关了/开了,设置里不变)。
  useEffect(() => {
    setLaunchOnStart(cfg.launchOnStart ?? true);
  }, [cfg.launchOnStart]);

  // 窗口重新聚焦(重新打开设置 / 从系统设置返回)时再检测一次,避免授权状态陈旧
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        // 开机启动同样随窗口聚焦刷新:覆盖「设置窗在启动时已挂载、引导随后才改系统 LaunchAgent」的场景
        invoke<boolean>("autostart_status")
          .then(setLaunchOnStart)
          .catch(() => {});
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
  }, []);

  /** 持久化通用设置(部分开关同时联动系统能力) */
  async function persist(patch: Partial<AppConfig>) {
    const next = { ...cfg, ...patch };
    await invoke("config_save", { cfg: next });
    onConfigChange(next);
  }

  async function toggleLaunch(v: boolean) {
    setLaunchOnStart(v);
    // 写入系统 LaunchAgent(登录时自启);失败则回滚开关
    try {
      await invoke("autostart_set", { enabled: v });
    } catch {
      setLaunchOnStart(!v);
      return;
    }
    await persist({ launchOnStart: v });
  }

  async function toggleSelection(v: boolean) {
    // 划词监听开关 ↔ Rust 暂停标志(快捷键总结 / 托盘状态同步)
    await invoke("set_capture_paused", { paused: !v });
    await persist({ selectionOn: v });
  }

  /** 去授权:先弹系统原生辅助功能授权窗(仅首次出现);后端返回弹窗后真实状态,已授权即结束,否则打开系统设置引导手动开启 */
  async function requestAuth() {
    setAuthing(true);
    try {
      const granted = await invoke<boolean>("request_accessibility");
      setAccessibility(granted);
      if (granted) return;
      // 未授权:原生弹窗已出现过/被拒,给极短宽限捕获用户刚点的「允许」,随后直接打开系统设置
      let ok = false;
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 600));
        ok = await invoke<boolean>("accessibility_status").catch(() => false);
        setAccessibility(ok);
        if (ok) break;
      }
      if (!ok) await invoke("open_privacy_settings", { kind: "accessibility" });
    } catch {
      setAccessibility(false);
      await invoke("open_privacy_settings", { kind: "accessibility" }).catch(() => {});
    } finally {
      setAuthing(false);
    }
  }

  /** 去授权:先弹系统原生屏幕录制授权窗(仅首次出现);后端返回弹窗后真实状态,已授权即结束,否则打开系统设置引导手动开启 */
  async function requestScreenRecording() {
    setScreenAuthing(true);
    try {
      const granted = await invoke<boolean>("request_screen_recording");
      setScreenRecording(granted);
      if (granted) return;
      // 未授权:原生弹窗已出现过/被拒,给极短宽限捕获用户刚点的「允许」,随后直接打开系统设置
      let ok = false;
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 600));
        ok = await invoke<boolean>("screen_recording_status").catch(() => false);
        setScreenRecording(ok);
        if (ok) break;
      }
      if (!ok) await invoke("open_privacy_settings", { kind: "screen" });
    } catch {
      setScreenRecording(false);
      await invoke("open_privacy_settings", { kind: "screen" }).catch(() => {});
    } finally {
      setScreenAuthing(false);
    }
  }

  return (
    <div>
      <div className="flex ac jb g16" style={{ marginBottom: 14 }}>
        <span style={{ fontSize: "var(--rb-text-2xl)", fontWeight: 600 }}>{t("settings.nav.general")}</span>
        <button className="btn btn-secondary btn-sm" onClick={onOpenOnboarding}>
          <Icon name="sparkles" size={14} />
          {t("settings.openOnboarding")}
        </button>
      </div>

      <div className="set-card-hd">{t("settings.cardGeneral")}</div>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.launchOnStart")}</div>
            <div className="set-row-d">{t("settings.launchOnStartDesc")}</div>
          </div>
          <div
            className={`sw${launchOnStart ? " on" : ""}`}
            onClick={() => void toggleLaunch(!launchOnStart)}
          />
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.enableSelection")}</div>
            <div className="set-row-d">{t("settings.enableSelectionDesc")}</div>
          </div>
          <div className={`sw${cfg.selectionOn ? " on" : ""}`} onClick={() => void toggleSelection(!cfg.selectionOn)} />
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.accessibilityAuth")}</div>
            <div className="set-row-d">{t("settings.accessibilityAuthDesc")}</div>
          </div>
          {accessibility === true ? (
            <span className="tag tag-ok">
              <Icon name="check" size={11} />
              {t("settings.authorized")}
            </span>
          ) : accessibility === false ? (
            <button className="btn btn-sm btn-primary" onClick={() => void requestAuth()} disabled={authing}>
              <Icon name="shield" size={14} />
              {authing ? t("float.detecting") : t("float.grant")}
            </button>
          ) : (
            <span className="tag tag-gray">{t("float.detecting")}</span>
          )}
        </div>
        {accessibility === false ? (
          <div className="rb-byok-note" style={{ marginTop: 8 }}>
            <Icon name="alert" style={{ color: "var(--rb-warning)", marginTop: 1, flexShrink: 0 }} />
            <div>
              {t("settings.grantNoteAccessibility")}
            </div>
          </div>
        ) : null}
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.screenAuth")}</div>
            <div className="set-row-d">{t("settings.screenAuthDesc")}</div>
          </div>
          {screenRecording === true ? (
            <span className="tag tag-ok">
              <Icon name="check" size={11} />
              {t("settings.authorized")}
            </span>
          ) : screenRecording === false ? (
            <button className="btn btn-sm btn-primary" onClick={() => void requestScreenRecording()} disabled={screenAuthing}>
              <Icon name="screen" size={14} />
              {screenAuthing ? t("float.detecting") : t("float.grant")}
            </button>
          ) : (
            <span className="tag tag-gray">{t("float.detecting")}</span>
          )}
        </div>
        {screenRecording === false ? (
          <div className="rb-byok-note" style={{ marginTop: 8 }}>
            <Icon name="alert" style={{ color: "var(--rb-warning)", marginTop: 1, flexShrink: 0 }} />
            <div>
              {t("settings.grantNoteScreen")}
            </div>
          </div>
        ) : null}
      </div>

      <div className="set-card-hd">{t("settings.float")}</div>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.escCloseFloat")}</div>
            <div className="set-row-d">{t("settings.escCloseFloatDesc")}</div>
          </div>
          <div
            className={`sw${escClose ? " on" : ""}`}
            onClick={() => {
              const v = !escClose;
              setEscClose(v);
              void persist({ escClose: v });
            }}
          />
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.clickOutsideClose")}</div>
            <div className="set-row-d">{t("settings.clickOutsideCloseDesc")}</div>
          </div>
          <div
            className={`sw${clickOutside ? " on" : ""}`}
            onClick={() => {
              const v = !clickOutside;
              setClickOutside(v);
              void persist({ clickOutside: v });
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* ═══ 外观与语言 ═══ */

interface AppearancePageProps {
  theme: ThemePreference;
  lang: Language;
  cfg: AppConfig;
  onTheme: (t: ThemePreference) => void;
  onLang: (l: Language) => void;
  onSummaryLang: (s: string) => void;
  onFontScale: (s: number) => void;
}

function AppearancePage({
  theme,
  lang,
  cfg,
  onTheme,
  onLang,
  onSummaryLang,
  onFontScale,
}: AppearancePageProps) {
  const scale = cfg.fontScale ?? 1.0;
  const summaryLang = normalizeSummaryLang(cfg.summaryLanguage);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);

  // 输出语言下拉:点击外部 / Esc 关闭
  useEffect(() => {
    if (!langMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setLangMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLangMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [langMenuOpen]);

  return (
    <div>
      <div style={{ fontSize: "var(--rb-text-2xl)", fontWeight: 600, marginBottom: 14 }}>{t("settings.nav.appearance")}</div>

      <div className="set-card-hd">{t("settings.cardAppearance")}</div>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.theme")}</div>
            <div className="set-row-d">{t("settings.themeDesc")}</div>
          </div>
          <div className="seg">
            <span className={theme === "light" ? "on" : ""} onClick={() => onTheme("light")}>
              {t("settings.light")}
            </span>
            <span className={theme === "dark" ? "on" : ""} onClick={() => onTheme("dark")}>
              {t("settings.dark")}
            </span>
            <span className={theme === "system" ? "on" : ""} onClick={() => onTheme("system")}>
              {t("settings.system")}
            </span>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.fontSize")}</div>
            <div className="set-row-d">{t("settings.fontSizeDesc")}</div>
          </div>
          <div className="seg">
            {FONT_SCALES.map((s) => (
              <span key={s} className={scale === s ? "on" : ""} onClick={() => onFontScale(s)}>
                {Math.round(s * 100)}%
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="set-card-hd">{t("settings.cardLanguage")}</div>
      <div className="set-card set-card--lang">
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.uiLanguage")}</div>
            <div className="set-row-d">{t("settings.uiLanguageDesc")}</div>
          </div>
          <div className="seg">
            <span className={lang === "zh" ? "on" : ""} onClick={() => onLang("zh")}>
              中文
            </span>
            <span className={lang === "en" ? "on" : ""} onClick={() => onLang("en")}>
              English
            </span>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.summaryLanguage")}</div>
            <div className="set-row-d">{t("settings.summaryLanguageDesc")}</div>
          </div>
          <div className="rb-lang-select-wrap" ref={langMenuRef}>
            <button
              className="rb-lang-select"
              onClick={() => setLangMenuOpen((v) => !v)}
              title={t("settings.selectSummaryLang")}
            >
              <span>{SUMMARY_LANGUAGES.find((l) => l.code === summaryLang)?.label ?? SUMMARY_LANGUAGES[0]?.label ?? "简体中文"}</span>
              <Icon name="chevronDown" size={14} className="rb-lang-caret" />
            </button>
            {langMenuOpen ? (
              <div className="rb-lang-menu">
                {SUMMARY_LANGUAGES.map((l) => (
                  <div
                    key={l.code}
                    className={`rb-lang-option${l.code === summaryLang ? " on" : ""}`}
                    onClick={() => {
                      onSummaryLang(l.code);
                      setLangMenuOpen(false);
                    }}
                  >
                    <span className="grow">{l.label}</span>
                    {l.code === summaryLang ? <Icon name="check" size={13} /> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══ 隐私与数据 ═══ */
function PrivacyPage({
  cfg,
  onConfigChange,
}: {
  cfg: AppConfig;
  onConfigChange: (c: AppConfig) => void;
}) {
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [diagnostics, setDiagnostics] = useState(cfg.diagnostics ?? false);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function toggleDiagnostics(v: boolean) {
    setDiagnostics(v);
    const next = { ...cfg, diagnostics: v };
    await invoke("config_save", { cfg: next });
    onConfigChange(next);
  }

  async function handleExport() {
    try {
      const path = await invoke<string>("export_data");
      setToast({ text: t("settings.exportDone", { path }), ok: true });
    } catch {
      setToast({ text: t("settings.exportFail"), ok: false });
    }
  }

  async function handleExportLogs() {
    try {
      const path = await invoke<string>("export_logs");
      setToast({ text: t("settings.exportDone", { path }), ok: true });
      // 打开时机在通知浮窗消失后(与 toast 同为 4s)
      setTimeout(() => {
        void invoke("reveal_path", { path }).catch(() => {});
      }, 4000);
    } catch {
      setToast({ text: t("settings.exportFail"), ok: false });
    }
  }

  async function handleClearHistory() {
    const ok = window.confirm(t("settings.clearConfirm"));
    if (!ok) return;
    try {
      await invoke("history_clear");
      await invoke("tray_refresh");
      setToast({ text: t("settings.clearDone"), ok: true });
    } catch {
      setToast({ text: t("settings.clearFail"), ok: false });
    }
  }

  return (
    <div>
      <div style={{ fontSize: "var(--rb-text-2xl)", fontWeight: 600, marginBottom: 14 }}>{t("settings.nav.privacy")}</div>

      <div className="set-card-hd">{t("settings.cardData")}</div>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.dataStore")}</div>
            <div className="set-row-d">{t("settings.dataStoreDesc")}</div>
          </div>
          <span className="set-link" onClick={() => void invoke("open_data_dir")}>
            {t("settings.openDataDir")}
          </span>
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.exportAll")}</div>
            <div className="set-row-d">{t("settings.exportAllDesc")}</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => void handleExport()}>
            {t("settings.exportAll")}
          </button>
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.clearHistory")}</div>
            <div className="set-row-d">{t("settings.clearHistoryDesc")}</div>
          </div>
          <button className="set-danger" onClick={() => void handleClearHistory()}>
            <Icon name="trash" size={14} />
            {t("settings.clearHistory")}
          </button>
        </div>
      </div>

      <div className="set-card-hd">{t("settings.cardPrivacy")}</div>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.diagnostics")}</div>
            <div className="set-row-d">{t("settings.diagnosticsDesc")}</div>
          </div>
          <div
            className={`sw${diagnostics ? " on" : ""}`}
            onClick={() => void toggleDiagnostics(!diagnostics)}
          />
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.exportLogs")}</div>
            <div className="set-row-d">{t("settings.exportLogsDesc")}</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => void handleExportLogs()}>
            {t("settings.exportLogs")}
          </button>
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.keyStore")}</div>
            <div className="set-row-d">{t("settings.keyStoreDesc")}</div>
          </div>
          <span className="tag tag-ok">
            <Icon name="check" size={11} />
            {t("settings.stored")}
          </span>
        </div>
      </div>

      {toast ? (
        <div className="rb-toast rb-toast-static">
          <Icon
            className={`rb-toast-icon rb-toast-icon--${toast.ok ? "ok" : "err"}`}
            name={toast.ok ? "check" : "alert"}
            size={15}
          />
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}


/* ═══ 关于 ═══ */
function AboutPage() {
  const [version, setVersion] = useState<string>("");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRelease, setShowRelease] = useState(false);

  useEffect(() => {
    let alive = true;
    getVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {});
    checkUpdate()
      .then((info) => {
        if (alive) {
          setUpdate(info);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function handleCheck() {
    setLoading(true);
    try {
      setUpdate(await checkUpdate({ force: true }));
    } finally {
      setLoading(false);
    }
  }

  function openDownload() {
    if (update?.releaseUrl) void openUrl(update.releaseUrl);
  }

  const hasUpdate = update?.hasUpdate ?? false;


  return (
    <div>
      <div style={{ textAlign: "center", padding: "22px 0 16px" }}>
        <div className="rb-logo-mark rb-about-logo">
          <LogoMark size={48} className="rb-logo-icon" />
        </div>
        <div style={{ fontSize: "var(--rb-text-lg)", fontWeight: 600 }}>ReadBrief</div>
        <div className="muted" style={{ fontSize: "var(--rb-text-xs)", marginTop: 3 }}>
          {t("settings.aboutVersion", { version: version || "—" })}
        </div>
      </div>

      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">{t("settings.checkUpdate")}</div>
            <div className="set-row-d">
              {loading
                ? t("settings.checking")
                : hasUpdate
                ? t("settings.updateFound", { latest: update?.latestVersion ?? "", current: update?.currentVersion ?? "" })
                : update?.error
                ? t("settings.checkFail", { error: update.error })
                : t("settings.updateLatest")}
              {!loading && update?.hint ? <div className="set-row-hint">{update.hint}</div> : null}
              {!loading && update?.error ? (
                <div className="set-row-hint">
                  <span className="rb-link" onClick={() => void openUrl(RELEASE_PAGE)}>
                    {t("settings.releaseHint")}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          {hasUpdate ? (
            <span className="tag tag-go" style={{ cursor: "pointer" }} onClick={() => setShowRelease(true)}>
              {t("settings.tagUpdate")}
            </span>
          ) : loading ? (
            <span className="tag">{t("settings.tagChecking")}</span>
          ) : update?.error ? (
            <span className="tag tag-go" style={{ cursor: "pointer" }} onClick={() => void handleCheck()}>
              {t("settings.tagRetry")}
            </span>
          ) : (
            <span className="tag tag-ok">
              <Icon name="check" size={11} />
              {t("settings.tagLatest")}
            </span>
          )}
        </div>
        <div
          className="set-row"
          style={{ cursor: "pointer" }}
          onClick={() => void openUrl("https://readbrief.936668.xyz")}
        >
          <div>
            <div className="set-row-t">{t("settings.officialSite")}</div>
            <div className="set-row-d">readbrief.936668.xyz</div>
          </div>
          <Icon name="logout" size={14} className="rb-row-link-icon" />
        </div>
        <div
          className="set-row"
          style={{ cursor: "pointer" }}
          onClick={() => void openUrl("https://github.com/CJSen/ReadBrief")}
        >
          <div>
            <div className="set-row-t">{t("settings.sourceCode")}</div>
            <div className="set-row-d">github.com/CJSen/ReadBrief</div>
          </div>
          <Icon name="logout" size={14} className="rb-row-link-icon" />
        </div>
        <div
          className="set-row"
          style={{ cursor: "pointer" }}
          onClick={() => void openUrl("https://github.com/CJSen/ReadBrief/blob/main/LICENSE")}
        >
          <div>
            <div className="set-row-t">{t("settings.credits")}</div>
            <div className="set-row-d">MIT License · 第三方组件清单</div>
          </div>
          <Icon name="logout" size={14} className="rb-row-link-icon" />
        </div>
      </div>
      <div style={{ textAlign: "center", fontSize: 11, color: "var(--rb-text-tertiary)", paddingTop: 6 }}>
        {t("settings.copyright")}
      </div>

      {/* 更新内容模态框：查看更新说明 + 右下角前往下载（含架构兜底入口） */}
      {showRelease && update ? (
        <div className="rb-modal-mask" onClick={() => setShowRelease(false)}>
          <div className="rb-release-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <button className="rb-modal-close" onClick={() => setShowRelease(false)} aria-label="关闭">
              <Icon name="close" size={14} />
            </button>
              <div className="rb-release-modal-head">
              <div className="rb-release-modal-title">{t("settings.viewUpdateTitle", { version: update.latestVersion ?? "" })}</div>
              <div className="rb-release-modal-sub">{t("settings.viewUpdateCurrent", { version: update.currentVersion })}</div>
            </div>
            <div
              className="rb-release-modal-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(update.releaseNotes ?? t("settings.noReleaseNotes")) }}
            />
            <div className="rb-release-modal-foot">
              {update.dmgAssets.length > 1 ? (
                <div className="rb-release-links">
                  <span className="rb-release-links-label">{t("settings.otherVersions")}</span>
                  {update.dmgAssets.map((d) => (
                    <button key={d.url} className="rb-release-link" onClick={() => void openUrl(d.url)}>
                      {archLabel(d.name)} {t("settings.download")}
                    </button>
                  ))}
                </div>
              ) : (
                <span />
              )}
              <button className="rb-update-popup-btn" onClick={() => void openDownload()}>
                {t("settings.download")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
