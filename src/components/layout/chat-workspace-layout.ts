/**
 * Chat 工作区的纯布局计算：列宽、断点与 inspector 的拖拽边界。
 * 这里不依赖 React 或路由，浏览器与单元测试读同一份规则。
 *
 * 公式取自归档原型的实测几何（design/archive/opendesign-p1p2 的
 * useInfoHubWidth），不另立「最小聊天宽度」之类的任意数字：
 *
 *   railHub 时列表 = clamp(viewport * 0.18, 160, 220)
 *   常规列表      = viewport >= 1360 ? 272 : clamp(viewport * 0.2, 220, 272)
 *   chatFloor     = viewport >= 1200 ? 560 : 460
 *   hubMax        = max(240, min(480, floor(viewport - sidebarWidth - list - chatFloor)))
 *   hub           = clamp(preferred(默认 320), 240, hubMax)
 *
 * 断点与 docs/frontend-design.md 的已确认行为同值，也与 theme.css 的
 * desktop(901px) / wide(1200px) 一致。窄桌面打开 inspector 时侧栏先让位
 * 成 64px 图标栏（AppShell 完成），列表继续保留并压到 160–220px。
 */
export const CHAT_LAYOUT = {
  desktopMinWidth: 901,
  wideMinWidth: 1200,
  listWideMinWidth: 1360,
  list: { min: 220, max: 272, ratio: 0.2 },
  railList: { min: 160, max: 220, ratio: 0.18 },
  inspector: { min: 240, max: 480, preferred: 320 },
  chatFloor: { wide: 560, desktop: 460 },
} as const;

/** 界面偏好键：只保存 inspector 的拖拽宽度，不承载业务状态。 */
export const INSPECTOR_WIDTH_STORAGE_KEY = "sprout:chat-inspector-width";

export type ChatWorkspaceLayout = {
  /** 窄屏一次只显示一栏，此时列宽不参与布局。 */
  split: boolean;
  listWidth: number;
  inspectorWidth: number | null;
  inspectorMax: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** 视口、侧栏宽度与 inspector 状态决定三栏宽度。 */
export function chatWorkspaceLayout({
  viewport,
  sidebarWidth,
  inspectorOpen,
  inspectorPreferred,
}: {
  viewport: number;
  sidebarWidth: number;
  inspectorOpen: boolean;
  inspectorPreferred: number;
}): ChatWorkspaceLayout {
  const { list, railList, inspector, chatFloor, desktopMinWidth, wideMinWidth, listWideMinWidth } =
    CHAT_LAYOUT;
  if (viewport < desktopMinWidth) {
    return {
      split: true,
      listWidth: viewport,
      inspectorWidth: inspectorOpen ? viewport : null,
      inspectorMax: viewport,
    };
  }
  const rail = inspectorOpen && viewport < wideMinWidth;
  const listWidth = rail
    ? clamp(viewport * railList.ratio, railList.min, railList.max)
    : viewport >= listWideMinWidth
      ? list.max
      : clamp(viewport * list.ratio, list.min, list.max);
  const floor = viewport >= wideMinWidth ? chatFloor.wide : chatFloor.desktop;
  const inspectorMax = Math.max(
    inspector.min,
    Math.min(inspector.max, Math.floor(viewport - sidebarWidth - listWidth - floor)),
  );
  return {
    split: false,
    listWidth,
    inspectorWidth: inspectorOpen
      ? Math.round(clamp(inspectorPreferred, inspector.min, inspectorMax))
      : null,
    inspectorMax,
  };
}

/** 缺失、损坏或小于最小值的偏好都退回默认宽度。 */
export function parseInspectorWidth(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < CHAT_LAYOUT.inspector.min) return null;
  return Math.round(parsed);
}

export function readStoredInspectorWidth(
  storage: Pick<Storage, "getItem"> | null | undefined,
): number {
  try {
    return (
      parseInspectorWidth(storage?.getItem(INSPECTOR_WIDTH_STORAGE_KEY)) ??
      CHAT_LAYOUT.inspector.preferred
    );
  } catch {
    return CHAT_LAYOUT.inspector.preferred;
  }
}
