import { useEffect, useState } from "react";
import "./App.css";
import { AppMain } from "./components/AppMain";
import { AppSettings } from "./components/AppSettings";
import { AppFloat } from "./components/AppFloat";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { applyFontScale, applyPreference, type ThemePreference } from "./lib/theme";
import { setLanguage, useLanguage } from "./lib/i18n";
import type { AppConfig } from "./lib/config/types";

type WinLabel = "main" | "settings" | "float";

function getWindowLabel(): WinLabel {
  try {
    const label = getCurrentWindow().label;
    if (label === "settings" || label === "float") {
      return label;
    }
  } catch {
    // 浏览器调试环境
  }
  return "main";
}

function App() {
  const [winLabel] = useState<WinLabel>(() => getWindowLabel());
  // 订阅语言变化:设置窗口切换语言后,本窗口立即以新语言重渲染
  useLanguage();

  useEffect(() => {
    if (winLabel === "float") {
      document.body.style.background = "transparent";
      document.body.style.backgroundColor = "transparent";
    } else {
      document.body.style.background = "";
      document.body.style.backgroundColor = "";
    }
  }, [winLabel]);

  // 各窗口启动时应用字体缩放与语言配置
  useEffect(() => {
    invoke<{ fontScale?: number; language?: string; theme?: string }>("config_get")
      .then((c) => {
        applyFontScale(c.fontScale ?? 1.0);
        if (c.language === "zh" || c.language === "en") setLanguage(c.language);
        applyThemePreference(c.theme);
      })
      .catch(() => {});
  }, []);

  // 监听配置变更:语言/主题/字体变更向所有已打开窗口传播(P1-5)
  useEffect(() => {
    const unlisten = listen<AppConfig>("config-changed", (event) => {
      const c = event.payload;
      if (c.language === "zh" || c.language === "en") setLanguage(c.language);
      applyFontScale(c.fontScale ?? 1.0);
      applyThemePreference(c.theme);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // 启动默认后台、不弹主窗口:主窗口保持 tauri.conf.json 的 visible:false(后台常驻),
  // 用户通过状态栏/Dock/快捷键的 show_main 主动唤起。
  // 仅「首次未完成初始化引导(onboardingDone=false)」时仍自动显示主窗口,
  // 让 AppMain 内的 Onboarding 覆盖层可见;完成引导后启动才真正后台不弹。
  // 重新唤起(托盘/Dock/快捷键)由 Rust 侧 show_main 直接显示(窗口内容已存在,亦无白屏)。
  // 关键:ReadBrief 是 macOS Accessory 应用,从 JS 回调直接 window.show() 无法激活 App,
  // 窗口会停在其它应用后方/根本不显示,因此显示动作必须在 Rust 主线程执行(与浮窗一致)。
  useEffect(() => {
    if (winLabel !== "main") return;
    const reveal = () =>
      invoke("reveal_main_window").catch(() => {
        // 兜底:命令不可用时退回前端 show(极端情况,正常不应触发)
        const w = getCurrentWindow();
        void w.show().catch(() => {});
        void w.setFocus().catch(() => {});
      });
    // 读配置判断是否为首次未完成引导:是则弹窗跑引导,否则保持后台不弹。
    // config 读取失败(极端)退回原行为,显示主窗口以保证可用。
    invoke<{ onboardingDone?: boolean }>("config_get")
      .then((c) => {
        if (c.onboardingDone === false) reveal();
      })
      .catch(() => reveal());
  }, [winLabel]);

  if (winLabel === "float") {
    return <AppFloat />;
  }

  if (winLabel === "settings") {
    return <AppSettings />;
  }

  return <AppMain />;
}

function applyThemePreference(theme?: string): void {
  if (theme === "light" || theme === "dark" || theme === "system") {
    applyPreference(theme as ThemePreference);
  }
}

export default App;
