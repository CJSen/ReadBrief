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
