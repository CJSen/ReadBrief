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

  // 主窗口显示:统一交由 Rust(reveal_main_window)在主线程 show + set_focus。
  // 初始:本 effect 在 React 首帧提交后触发,此时页面已渲染,无白屏;
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
    reveal();
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
