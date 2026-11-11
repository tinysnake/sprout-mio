import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
/** 用户偏好：显式选一套主题，或者跟随系统。 */
export type ThemePreference = Theme | "system";

/** 界面偏好键，只在 localStorage 里保存这一项，不承载任何业务状态。 */
export const THEME_STORAGE_KEY = "sprout:theme";
/** 系统主题查询表达式，首屏脚本与运行时订阅共用同一份。 */
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * 在首屏样式生效前决定主题的内联脚本。没有显式偏好时按系统解析，
 * 避免浅色闪一下再变暗；同时把 color-scheme 声明落成实际生效的主题。
 */
export const THEME_INIT_SCRIPT = `try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=p==="dark"||(p!=="light"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);var r=document.documentElement;r.classList.toggle("dark",d);var m=document.querySelector('meta[name="color-scheme"]');if(m)m.setAttribute("content",d?"dark":"light");}catch(e){}`;

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
/** applyTheme 只 touching classList，测试与 SSR 都能传入最小实现。 */
type ThemeRoot = { classList: { toggle(token: string, force?: boolean): boolean } };

const listeners = new Set<() => void>();
let current: Theme = "light";
let preference: ThemePreference = "system";
let initialized = false;
let watching = false;

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

export function parseThemePreference(value: unknown): ThemePreference | null {
  return value === "system" ? "system" : parseTheme(value);
}

/** 缺失、损坏或不可读的偏好都退回跟随系统，不让坏值把页面钉在某个主题里。 */
export function readStoredPreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY)) ?? "system";
  } catch {
    return "system";
  }
}

/** 跟随系统时取系统结果，显式偏好时原样返回。 */
export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): Theme {
  return pref === "system" ? (systemPrefersDark ? "dark" : "light") : pref;
}

export function applyTheme(theme: Theme, root: ThemeRoot): Theme {
  root.classList.toggle("dark", theme === "dark");
  return theme;
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * 对外声明本站当前使用的配色方案。暗色时 Dark Reader 一类扩展据此判定
 * 页面已自带暗色主题，不再叠一层反色。
 */
function syncColorSchemeMeta(theme: Theme): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) meta.content = theme;
}

function apply(theme: Theme): void {
  current = theme;
  if (typeof document !== "undefined") {
    applyTheme(theme, document.documentElement);
    syncColorSchemeMeta(theme);
  }
  for (const listener of listeners) listener();
}

/** 系统主题变化只在跟随系统时生效；显式偏好不被系统改写。 */
function watchSystem(): void {
  if (watching || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  watching = true;
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", (event) => {
    if (preference === "system") apply(resolveTheme("system", event.matches));
  });
}

export function initTheme(): Theme {
  if (typeof document === "undefined") return current;
  preference = readStoredPreference(browserStorage());
  initialized = true;
  apply(resolveTheme(preference, systemPrefersDark()));
  watchSystem();
  return current;
}

export function getTheme(): Theme {
  return initialized ? current : initTheme();
}

/** 显式选一套主题：此后不再跟随系统。 */
export function setTheme(next: Theme): void {
  setPreference(next);
}

export function setPreference(next: ThemePreference): void {
  if (initialized && next === preference) return;
  preference = next;
  initialized = true;
  try {
    browserStorage()?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // 存储被禁用时仍然切换当前会话的主题。
  }
  apply(resolveTheme(next, systemPrefersDark()));
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
  preference: ThemePreference;
  setTheme: typeof setTheme;
  setPreference: typeof setPreference;
  toggle: typeof toggleTheme;
} {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => "light" as const);
  return { theme, preference, setTheme, setPreference, toggle: toggleTheme };
}
