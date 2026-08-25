import type React from "react";

/**
 * 解析快捷键录制时的「实体键」token。
 *
 * macOS 上按住 Option(Alt) 再按字母/数字时，KeyboardEvent.key 会被合成成
 * 死键字符(å/ø/∆/¡)，导致录制出 "Alt+Å" 这类无法触发的错误组合。
 * 因此 Alt 组合下改用 e.code(物理键，不受 Option 合成影响)还原：
 *   KeyA → A，Digit1 → 1；其余键沿用 e.key(保留 Space/Enter/符号键原行为)。
 */
export function resolveShortcutKey(e: React.KeyboardEvent): string {
  if (e.altKey) {
    if (e.code.startsWith("Key")) return e.code.slice(3);
    if (e.code.startsWith("Digit")) return e.code.slice(5);
  }
  return e.key.toUpperCase();
}

/**
 * 将快捷键 token（Cmd/Ctrl/Alt/Shift 或实体键）渲染为显示标签。
 *
 * 两端统一用文字（Cmd/Ctrl/Alt/Shift），不再使用 ⌘⌃⌥⇧ 符号，
 * 避免 Windows 用户不熟悉 ⌃ 代表的困惑，且 Mac/Win 视觉一致。
 * 加速器字符串本身已按平台携带 Cmd / Ctrl（见 config.rs 默认绑定），
 * 因此本函数无需再做平台分支。
 */
const MOD_LABELS: Record<string, string> = {
  CMD: "Cmd",
  CTRL: "Ctrl",
  ALT: "Alt",
  SHIFT: "Shift",
};

export function keySymbol(k: string): string {
  if (!k || k === " ") return "Space";
  return MOD_LABELS[k.toUpperCase()] ?? k;
}
