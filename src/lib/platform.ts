/**
 * 前端平台判断（零依赖）。
 *
 * 仅用于 UI 文案/图标区分（如 macOS 用 Cmd、Windows 用 Ctrl；权限步骤门控）。
 * 基于 WebView 内可用的 navigator 信息，不引入额外依赖。
 */

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { platform?: string }).platform || "";
  const ua = navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(ua);
}

export function isWin(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { platform?: string }).platform || "";
  return /Win/.test(platform);
}
