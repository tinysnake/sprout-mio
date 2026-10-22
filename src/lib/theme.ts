import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

/** 界面偏好键，只在 localStorage 里保存这一项，不承载任何业务状态。 */
export const THEME_STORAGE_KEY = "sprout:theme";

/**
 * 在首屏样式生效前恢复主题的内联脚本。字符串由本文件的键名生成，
 * 避免根路由里再写一份键名或判断分支。
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="dark")document.documentElement.classList.add("dark");}catch(e){}`;

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
/** applyTheme 只 touching classList，测试与 SSR 都能传入最小实现。 */
type ThemeRoot = { classList: { toggle(token: string, force?: boolean): boolean } };

const listeners = new Set<() => void>();
let current: Theme = "light";
let initialized = false;

function browserStorage(): ThemeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function parseTheme(value: unknown): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

/** 缺失、损坏或不可读的偏好都退回浅色，不让坏值把页面留在一个未知主题里。 */
export function readStoredTheme(storage: Pick<Storage, "getItem"> | null | undefined): Theme {
  try {
    return parseTheme(storage?.getItem(THEME_STORAGE_KEY)) ?? "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme, root: ThemeRoot): Theme {
  root.classList.toggle("dark", theme === "dark");
  return theme;
}

export function initTheme(): Theme {
  if (typeof document === "undefined") return current;
  current = applyTheme(readStoredTheme(browserStorage()), document.documentElement);
  initialized = true;
  return current;
}

export function getTheme(): Theme {
  return initialized ? current : initTheme();
}

/** 单一状态源：同一次点击后，页面上的每个 ThemeToggle 都读到同一个主题。 */
export function setTheme(next: Theme): void {
  if (initialized && next === current) return;
  current = next;
  initialized = true;
  if (typeof document !== "undefined") applyTheme(next, document.documentElement);
  try {
    browserStorage()?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // 存储被禁用时仍然切换当前会话的主题。
  }
  for (const listener of listeners) listener();
}

export function toggleTheme(): void {
  setTheme(getTheme() === "dark" ? "light" : "dark");
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTheme(): {
  theme: Theme;
  setTheme: typeof setTheme;
  toggle: typeof toggleTheme;
} {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => "light" as const);
  return { theme, setTheme, toggle: toggleTheme };
}
