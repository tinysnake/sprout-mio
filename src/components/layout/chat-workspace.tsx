import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { cn } from "cn";
import { useAppShell } from "./app-shell";
import {
  CHAT_LAYOUT,
  chatWorkspaceLayout,
  readStoredInspectorWidth,
  INSPECTOR_WIDTH_STORAGE_KEY,
} from "./chat-workspace-layout";
import "./chat-workspace.css";

/**
 * 三栏工作区：列表、Chat 与 inspector 的列宽、断点与拖拽边界都收在这里，
 * 路由只提供三块内容。宽度规则见 chat-workspace-layout.ts，纯计算与
 * 单元测试共用同一份定义。
 */
function useViewportWidth() {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return width;
}

function useInspectorWidth() {
  const [preferred, setPreferred] = useState(() =>
    typeof window === "undefined"
      ? CHAT_LAYOUT.inspector.preferred
      : readStoredInspectorWidth(window.localStorage),
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(preferred));
    } catch {
      // 存储不可用时只影响下次进入的默认宽度。
    }
  }, [preferred]);
  return [preferred, setPreferred] as const;
}

/**
 * 分隔条：拖动、双击复位与方向键调整。指针捕获失败时仍按指针位置继续拖动，
 * 键盘焦点留在分隔条上，Escape 之外不需要额外快捷键。
 */
function InspectorResizeHandle({
  width,
  max,
  onResize,
}: {
  width: number;
  max: number;
  onResize: (next: number) => void;
}) {
  const cleanup = useRef<() => void>(() => {});

  useEffect(() => () => cleanup.current(), []);

  function stop() {
    cleanup.current();
  }

  function start(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    cleanup.current();
    const origin = event.clientX;
    const initial = width;
    const pointer = event.pointerId;
    const handle = event.currentTarget;
    handle.focus({ preventScroll: true });
    try {
      handle.setPointerCapture(pointer);
    } catch {
      // 捕获不可用时仍按指针位置拖动。
    }
    document.body.classList.add("resizing-chat-inspector");
    function move(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointer) return;
      onResize(initial + origin - moveEvent.clientX);
    }
    function end(endEvent: PointerEvent) {
      if (endEvent.pointerId !== pointer) return;
      stop();
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", stop);
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", stop);
      document.body.classList.remove("resizing-chat-inspector");
      try {
        if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      } catch {
        // 指针已释放时无需再释放。
      }
      cleanup.current = () => {};
    };
  }

  function keydown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 16;
    const next = {
      ArrowLeft: width + step,
      ArrowRight: width - step,
      Home: CHAT_LAYOUT.inspector.min,
      End: max,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onResize(next);
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      data-testid="inspector-resize-handle"
      aria-label="调整 Info Hub 宽度"
      aria-orientation="vertical"
      aria-controls="info-hub"
      aria-valuemin={CHAT_LAYOUT.inspector.min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} 像素`}
      title="拖动调整宽度，双击恢复默认；方向键微调"
      className="chat-inspector-resize"
      onPointerDown={start}
      onLostPointerCapture={stop}
      onDoubleClick={() => onResize(CHAT_LAYOUT.inspector.preferred)}
      onKeyDown={keydown}
    />
  );
}

/**
 * 列宽由布局拥有，列表只读取「现在是不是窄列」这一个结果，不自己算断点。
 * 窄列隐藏类型行是纯呈现变化：类型条件本来就没有生效，所以不会留下
 * 用户看不见也解不开的筛选。
 */
const WorkspaceContext = createContext<{ listWidth: number; split: boolean }>({
  listWidth: 272,
  split: false,
});

export function useChatWorkspace() {
  return useContext(WorkspaceContext);
}

/** 列表列窄到放不下三个类型标签时隐藏该行。 */
export function isNarrowList(listWidth: number) {
  return listWidth < 200;
}

type ChatWorkspaceProps = {
  /** 左栏：Chat 列表，桌面始终可见，窄屏只在未选中对话时显示。 */
  list: ReactNode;
  /** 中栏：当前对话或列表页的空态。 */
  chat: ReactNode;
  /** 右栏：Info Hub。为空表示 inspector 关闭。 */
  inspector?: ReactNode;
  /** 是否选中了具体对话，决定窄屏显示列表还是对话。 */
  selected: boolean;
  /** 桌面常驻详情栏：窄屏仍由 ?info=1 打开独立详情屏。 */
  inspectorPersistent?: boolean;
  /** 详情屏开关；缺省按 inspector 是否提供判断，兼容开发 fixture。 */
  inspectorOpen?: boolean;
  testId?: string;
};

export function ChatWorkspace({
  list,
  chat,
  inspector,
  selected,
  inspectorPersistent = false,
  inspectorOpen: inspectorOpenProp,
  testId = "chat-workspace",
}: ChatWorkspaceProps) {
  const viewport = useViewportWidth();
  const { sidebarWidth } = useAppShell();
  const [preferred, setPreferred] = useInspectorWidth();
  const requested = inspector !== undefined && inspector !== null;
  const requestedOpen = inspectorOpenProp ?? requested;
  const desktop = viewport >= CHAT_LAYOUT.desktopMinWidth;
  const effectiveOpen =
    requested && (desktop ? inspectorPersistent || requestedOpen : requestedOpen);
  const layout = chatWorkspaceLayout({
    viewport,
    sidebarWidth,
    inspectorOpen: effectiveOpen,
    inspectorPreferred: preferred,
  });
  const showInspector = effectiveOpen;
  const style = {
    "--chat-list-width": `${layout.listWidth}px`,
    "--chat-inspector-width": `${layout.inspectorWidth ?? 0}px`,
  } as CSSProperties;

  return (
    <WorkspaceContext.Provider value={{ listWidth: layout.listWidth, split: layout.split }}>
      <div
        data-testid={testId}
        data-layout={layout.split ? "split" : "columns"}
        data-inspector-open={effectiveOpen || undefined}
        style={style}
        className={cn(
          "flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background",
          !layout.split && "grid",
          !layout.split &&
            (effectiveOpen
              ? "grid-cols-[var(--chat-list-width)_minmax(0,1fr)_var(--chat-inspector-width)]"
              : "grid-cols-[var(--chat-list-width)_minmax(0,1fr)]"),
        )}
      >
        <section
          data-testid="chat-list-panel"
          aria-label="Chat 列表"
          className={cn(
            "flex min-h-0 min-w-0 flex-col border-border bg-secondary max-desktop:flex-1 desktop:border-r",
            selected && "max-desktop:hidden",
          )}
        >
          {list}
        </section>
        <div
          data-testid="chat-detail-panel"
          className={cn(
            "flex min-h-0 min-w-0 flex-col max-desktop:flex-1",
            !selected && "max-desktop:hidden",
            effectiveOpen && "max-desktop:hidden",
          )}
        >
          {chat}
        </div>
        {showInspector && (
          <aside
            id="info-hub"
            data-testid="chat-inspector"
            aria-label="会话详情"
            className="relative flex min-h-0 min-w-0 flex-col border-border bg-secondary max-desktop:flex-1 desktop:border-l"
          >
            {!layout.split && layout.inspectorWidth !== null && (
              <InspectorResizeHandle
                width={layout.inspectorWidth}
                max={layout.inspectorMax}
                onResize={setPreferred}
              />
            )}
            {inspector}
          </aside>
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}
