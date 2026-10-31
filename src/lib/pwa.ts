import { getTheme, subscribeTheme, type Theme } from "./theme";

/**
 * Browser chrome colors. Manifest colors are fixed at install time, so they repeat the
 * light literal from `theme.css` (--bg); the document itself follows the stored theme.
 */
export const THEME_COLOR: Record<Theme, string> = {
  light: "#f2f1ed",
  dark: "#26251e",
};

export function applyThemeColor(theme: Theme): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLOR[theme];
}

/** Keep the head meta in step with the applied theme; the server renders the light default. */
export function watchThemeColor(): () => void {
  applyThemeColor(getTheme());
  return subscribeTheme(() => applyThemeColor(getTheme()));
}

/** 身份变更后旧的只读缓存不能再拿来离线展示：请 service worker 清掉它。 */
export function clearOfflineReads(): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage({ type: "clear-reads" }))
    .catch(() => undefined);
}
