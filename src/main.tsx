import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import { initTheme } from "./lib/theme";
import { getCurrentWindow } from "@tauri-apps/api/window";

initTheme();

// 浮窗窗口背景必须透明(transparent: true),否则显示不透明底色
try {
  const label = getCurrentWindow().label;
  if (label === "float") {
    document.body.style.background = "transparent";
    document.body.style.backgroundColor = "transparent";
  }
} catch {
  // 浏览器调试环境,无需处理
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
