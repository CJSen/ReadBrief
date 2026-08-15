import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppConfig } from "../lib/config/types";
import { getLanguage, setLanguage, t, type Language } from "../lib/i18n";
import { applyPreference, applyFontScale, type ThemePreference } from "../lib/theme";
import { Icon } from "./Icon";
import { ShortcutsPage } from "./ShortcutsPage";
import { PromptManager } from "./PromptManager";
import { AiServicesPage } from "./AiServicesPage";
import { Onboarding } from "./Onboarding";

type SettingsSection =
  | "general"
  | "ai"
  | "shortcuts"
  | "prompts"
  | "appearance"
  | "privacy"
  | "subscription"
  | "about";

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

  // 窗口重新聚焦(重新打开设置 / 从系统设置返回)时再检测一次,避免授权状态陈旧
  useEffect(() => {
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

      <div className="set-card-hd">常规</div>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">开机启动</div>
            <div className="set-row-d">登录系统后自动在后台运行</div>
          </div>
          <div
            className={`sw${launchOnStart ? " on" : ""}`}
            onClick={() => void toggleLaunch(!launchOnStart)}
          />
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">启用划词监听</div>
            <div className="set-row-d">选中文本后弹出总结按钮</div>
          </div>
          <div className={`sw${cfg.selectionOn ? " on" : ""}`} onClick={() => void toggleSelection(!cfg.selectionOn)} />
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">辅助功能授权</div>
            <div className="set-row-d">划词总结需读取选中文本，请授予「辅助功能」权限</div>
          </div>
          {accessibility === true ? (
            <span className="tag tag-ok">
              <Icon name="check" size={11} />
              已授权
            </span>
          ) : accessibility === false ? (
            <button className="btn btn-sm btn-primary" onClick={() => void requestAuth()} disabled={authing}>
              <Icon name="shield" size={14} />
              {authing ? "检测中…" : "去授权"}
            </button>
          ) : (
            <span className="tag tag-gray">检测中…</span>
          )}
        </div>
        {accessibility === false ? (
          <div className="rb-byok-note" style={{ marginTop: 8 }}>
            <Icon name="alert" style={{ color: "var(--rb-warning)", marginTop: 1, flexShrink: 0 }} />
            <div>
              未获得辅助功能授权时，划词总结无法读取选中文本。点击「去授权」后在弹窗中勾选 ReadBrief，授权即时生效、无需重启。
            </div>
          </div>
        ) : null}
        <div className="set-row">
          <div>
            <div className="set-row-t">屏幕录制授权</div>
            <div className="set-row-d">截图 OCR 总结需读取屏幕内容，请授予「屏幕录制」权限</div>
          </div>
          {screenRecording === true ? (
            <span className="tag tag-ok">
              <Icon name="check" size={11} />
              已授权
            </span>
          ) : screenRecording === false ? (
            <button className="btn btn-sm btn-primary" onClick={() => void requestScreenRecording()} disabled={screenAuthing}>
              <Icon name="screen" size={14} />
              {screenAuthing ? "检测中…" : "去授权"}
            </button>
          ) : (
            <span className="tag tag-gray">检测中…</span>
          )}
        </div>
        {screenRecording === false ? (
          <div className="rb-byok-note" style={{ marginTop: 8 }}>
            <Icon name="alert" style={{ color: "var(--rb-warning)", marginTop: 1, flexShrink: 0 }} />
            <div>
              未获得屏幕录制授权时，截图 OCR 总结无法读取屏幕内容。点击「去授权」后在弹窗中勾选 ReadBrief；授权后需重启应用才能生效（系统限制）。
            </div>
          </div>
        ) : null}
      </div>

      <div className="set-card-hd">悬浮窗</div>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">Esc 关闭悬浮窗</div>
            <div className="set-row-d">固定状态下不响应，避免误触丢失内容</div>
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
            <div className="set-row-t">点击窗口外关闭</div>
            <div className="set-row-d">仅对"生成中"以外状态的窗口生效</div>
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

/** 输出语言可选项(与系统提示词中的语言指令一一对应) */
const SUMMARY_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "ru", label: "Русский" },
  { code: "pt", label: "Português" },
];
const DEFAULT_SUMMARY_LANG = "zh-CN";
/** 旧版单值(system/zh/en)迁移到新多语言码,保证升级后选中态不丢失 */
const LEGACY_LANG_MAP: Record<string, string> = { system: "zh-CN", zh: "zh-CN", en: "en" };
function normalizeSummaryLang(v: string | undefined): string {
  if (v && SUMMARY_LANGUAGES.some((l) => l.code === v)) return v;
  return LEGACY_LANG_MAP[v ?? ""] ?? DEFAULT_SUMMARY_LANG;
}

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
  const pct = Math.round(scale * 100);
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

  function shiftFont(delta: number) {
    const next = Math.min(1.2, Math.max(0.9, Math.round((scale + delta) * 10) / 10));
    onFontScale(next);
  }

  return (
    <div>
      <div style={{ fontSize: "var(--rb-text-2xl)", fontWeight: 600, marginBottom: 14 }}>{t("settings.nav.appearance")}</div>

      <div className="set-card-hd">外观</div>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">主题</div>
            <div className="set-row-d">跟随系统时随 macOS 深浅色自动切换</div>
          </div>
          <div className="seg">
            <span className={theme === "light" ? "on" : ""} onClick={() => onTheme("light")}>
              亮色
            </span>
            <span className={theme === "dark" ? "on" : ""} onClick={() => onTheme("dark")}>
              暗色
            </span>
            <span className={theme === "system" ? "on" : ""} onClick={() => onTheme("system")}>
              跟随系统
            </span>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">字体大小</div>
            <div className="set-row-d">调整界面与总结浮窗的文字大小</div>
          </div>
          <div className="flex ac g8">
            <button className="iconbtn" onClick={() => shiftFont(-0.1)} disabled={scale <= 0.9}>
              <Icon name="minus" size={14} />
            </button>
            <span className="mono rb-font-pct">{pct}%</span>
            <button className="iconbtn" onClick={() => shiftFont(0.1)} disabled={scale >= 1.2}>
              <Icon name="plus" size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className="set-card-hd">语言</div>
      <div className="set-card set-card--lang">
        <div className="set-row">
          <div>
            <div className="set-row-t">界面语言</div>
            <div className="set-row-d">设置窗口与菜单的显示语言</div>
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
            <div className="set-row-t">输出语言</div>
            <div className="set-row-d">AI 输出默认使用的语言，可被提示词覆盖</div>
          </div>
          <div className="rb-lang-select-wrap" ref={langMenuRef}>
            <button
              className="rb-lang-select"
              onClick={() => setLangMenuOpen((v) => !v)}
              title="选择 AI 输出语言"
            >
              <span>{SUMMARY_LANGUAGES.find((l) => l.code === summaryLang)?.label ?? "简体中文"}</span>
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
  const [toast, setToast] = useState<string | null>(null);
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
      setToast(`已导出到 ${path}`);
    } catch {
      setToast("导出失败，请重试");
    }
  }

  async function handleClearHistory() {
    const ok = window.confirm("确定清空全部历史记录吗？此操作不可恢复。");
    if (!ok) return;
    try {
      await invoke("history_clear");
      await invoke("tray_refresh");
      setToast("历史记录已清空");
    } catch {
      setToast("清空失败，请重试");
    }
  }

  return (
    <div>
      <div style={{ fontSize: "var(--rb-text-2xl)", fontWeight: 600, marginBottom: 14 }}>{t("settings.nav.privacy")}</div>

      <div className="set-card-hd">数据</div>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">数据存储</div>
            <div className="set-row-d">全部数据保存在本机 SQLite，无账号体系</div>
          </div>
          <span className="set-link" onClick={() => void invoke("open_data_dir")}>
            打开数据文件夹
          </span>
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">导出全部数据</div>
            <div className="set-row-d">导出为 JSON，可随时迁移到其他设备</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => void handleExport()}>
            导出
          </button>
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">清空历史记录</div>
            <div className="set-row-d">删除全部总结记录与缓存，不可恢复</div>
          </div>
          <button className="set-danger" onClick={() => void handleClearHistory()}>
            <Icon name="trash" size={14} />
            清空
          </button>
        </div>
      </div>

      <div className="set-card-hd">隐私</div>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">匿名诊断数据</div>
            <div className="set-row-d">仅上报崩溃与性能指标，不含任何文本内容</div>
          </div>
          <div
            className={`sw${diagnostics ? " on" : ""}`}
            onClick={() => void toggleDiagnostics(!diagnostics)}
          />
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">密钥存储</div>
            <div className="set-row-d">明文存储于本机 config.json，代码不打印 key</div>
          </div>
          <span className="tag tag-ok">
            <Icon name="check" size={11} />
            已存储
          </span>
        </div>
      </div>

      {toast ? <div className="rb-toast rb-toast-static">{toast}</div> : null}
    </div>
  );
}


/* ═══ 关于 ═══ */
function AboutPage() {
  return (
    <div>
      <div style={{ textAlign: "center", padding: "22px 0 16px" }}>
        <div className="rb-logo-mark rb-about-logo">
          <Icon name="summarize" size={26} className="rb-logo-icon" />
        </div>
        <div style={{ fontSize: "var(--rb-text-lg)", fontWeight: 600 }}>ReadBrief</div>
        <div className="muted" style={{ fontSize: "var(--rb-text-xs)", marginTop: 3 }}>
          版本 0.1.0 · Tauri
        </div>
      </div>

      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="set-row-t">检查更新</div>
            <div className="set-row-d">当前已是最新版本</div>
          </div>
          <span className="tag tag-ok">
            <Icon name="check" size={11} />
            已是最新
          </span>
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">官方网站</div>
            <div className="set-row-d">readbrief.app</div>
          </div>
          <Icon name="logout" size={14} className="rb-row-link-icon" />
        </div>
        <div className="set-row">
          <div>
            <div className="set-row-t">开源许可与致谢</div>
            <div className="set-row-d">MIT License · 第三方组件清单</div>
          </div>
          <Icon name="logout" size={14} className="rb-row-link-icon" />
        </div>
      </div>
      <div style={{ textAlign: "center", fontSize: 11, color: "var(--rb-text-tertiary)", paddingTop: 6 }}>
        © 2026 ReadBrief
      </div>
    </div>
  );
}
