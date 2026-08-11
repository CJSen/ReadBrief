export type Theme = "light" | "dark";
export type ThemePreference = "light" | "dark" | "system";

const THEME_KEY = "readbrief-theme";

export function getStoredTheme(): Theme | null {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : null;
}

export function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") {
    root.setAttribute("data-theme", "dark");
  } else {
    root.removeAttribute("data-theme");
  }
}

export function initTheme(): void {
  applyTheme(getStoredTheme() ?? getSystemTheme());
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (getStoredTheme() === null) {
        applyTheme(getSystemTheme());
      }
    });
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

export function resolveTheme(pref: ThemePreference): Theme {
  return pref === "system" ? getSystemTheme() : pref;
}

export function applyPreference(pref: ThemePreference): void {
  if (pref === "system") {
    localStorage.removeItem(THEME_KEY);
    applyTheme(getSystemTheme());
  } else {
    setTheme(pref);
  }
}

const FONT_SCALE_KEY = "readbrief-font-scale";

/** 字体缩放档位:0.9 / 1.0 / 1.1(通过根节点 class 覆盖字号 token) */
export function applyFontScale(scale: number): void {
  const root = document.documentElement;
  root.classList.remove("font-sm", "font-lg");
  if (scale <= 0.9) {
    root.classList.add("font-sm");
  } else if (scale >= 1.1) {
    root.classList.add("font-lg");
  }
  localStorage.setItem(FONT_SCALE_KEY, String(scale));
}
