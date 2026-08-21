import { error as logError } from "@tauri-apps/plugin-log";

/** 非 Tauri 环境(浏览器调试/vitest)跳过 */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 未捕获错误桥接到后端日志(error 级别始终落盘,不受诊断开关影响)。
 * main.tsx 入口调用一次,覆盖全部窗口(main/settings/float)。
 */
export function initErrorLogging(): void {
  if (!inTauri()) return;
  window.addEventListener("error", (e) => {
    void logError(`[webview] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`).catch(
      () => {},
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason =
      e.reason instanceof Error
        ? `${e.reason.message}\n${e.reason.stack ?? ""}`
        : String(e.reason);
    void logError(`[webview] unhandled rejection: ${reason}`).catch(() => {});
  });
}
