import { describe, expect, it } from "vite-plus/test";
import {
  CHAT_LAYOUT,
  chatWorkspaceLayout,
  parseInspectorWidth,
  readStoredInspectorWidth,
} from "../src/components/layout/chat-workspace-layout";

const closed = { inspectorOpen: false, inspectorPreferred: CHAT_LAYOUT.inspector.preferred };

describe("Chat 工作区宽度分配", () => {
  // 归档原型的实测值：901/1024/1199 走 railHub，列表按 18% 压窄；
  // 1200 起回到常规列表，1440 起固定 272。
  it.each([
    { viewport: 901, sidebarWidth: 64, list: 162.18, inspector: 240 },
    { viewport: 1024, sidebarWidth: 64, list: 184.32, inspector: 315 },
    { viewport: 1199, sidebarWidth: 64, list: 215.82, inspector: 320 },
    { viewport: 1200, sidebarWidth: 200, list: 240, inspector: 240 },
    { viewport: 1440, sidebarWidth: 200, list: 272, inspector: 320 },
  ])("$viewport px 打开 inspector：列表与宽度与原型公式一致", (row) => {
    const layout = chatWorkspaceLayout({
      viewport: row.viewport,
      sidebarWidth: row.sidebarWidth,
      inspectorOpen: true,
      inspectorPreferred: 320,
    });
    expect(layout.split).toBe(false);
    expect(layout.listWidth).toBeCloseTo(row.list, 2);
    expect(layout.inspectorWidth).toBe(row.inspector);
  });

  it("901–1199px 打开 inspector 时列表在 160–220 之间且继续保留", () => {
    for (const viewport of [901, 1024, 1199]) {
      const layout = chatWorkspaceLayout({
        viewport,
        sidebarWidth: 64,
        inspectorOpen: true,
        inspectorPreferred: 320,
      });
      expect(layout.listWidth).toBeGreaterThanOrEqual(160);
      expect(layout.listWidth).toBeLessThanOrEqual(220);
    }
  });

  it("未打开 inspector 时列表按 220–272 分配，1360px 起固定 272", () => {
    expect(chatWorkspaceLayout({ ...closed, viewport: 901, sidebarWidth: 200 }).listWidth).toBe(
      220,
    );
    expect(chatWorkspaceLayout({ ...closed, viewport: 1200, sidebarWidth: 200 }).listWidth).toBe(
      240,
    );
    expect(chatWorkspaceLayout({ ...closed, viewport: 1359, sidebarWidth: 200 }).listWidth).toBe(
      271.8,
    );
    expect(chatWorkspaceLayout({ ...closed, viewport: 1360, sidebarWidth: 200 }).listWidth).toBe(
      272,
    );
  });

  it("1512px 打开 inspector 时按公式取 480 上限", () => {
    const layout = chatWorkspaceLayout({
      viewport: 1512,
      sidebarWidth: 200,
      inspectorOpen: true,
      inspectorPreferred: 480,
    });
    expect(layout.inspectorWidth).toBe(480);
    expect(layout.inspectorMax).toBe(480);
  });

  it("900px 及以下按栏切换，inspector 独占视口宽度", () => {
    const list = chatWorkspaceLayout({ ...closed, viewport: 390, sidebarWidth: 0 });
    expect(list.split).toBe(true);
    expect(list.inspectorWidth).toBeNull();
    const open = chatWorkspaceLayout({
      viewport: 390,
      sidebarWidth: 0,
      inspectorOpen: true,
      inspectorPreferred: 320,
    });
    expect(open.inspectorWidth).toBe(390);
  });

  it("拖拽宽度被限制在 240 与公式上限之间，不超过视口", () => {
    const tooWide = chatWorkspaceLayout({
      viewport: 1024,
      sidebarWidth: 64,
      inspectorOpen: true,
      inspectorPreferred: 2000,
    });
    const tooNarrow = chatWorkspaceLayout({
      viewport: 1024,
      sidebarWidth: 64,
      inspectorOpen: true,
      inspectorPreferred: 100,
    });
    expect(tooWide.inspectorWidth).toBe(tooWide.inspectorMax);
    expect(tooNarrow.inspectorWidth).toBe(240);
    for (const viewport of [901, 1024, 1199, 1200, 1440]) {
      const sidebarWidth = viewport < 1200 ? 64 : 200;
      const layout = chatWorkspaceLayout({
        viewport,
        sidebarWidth,
        inspectorOpen: true,
        inspectorPreferred: 2000,
      });
      expect(sidebarWidth + layout.listWidth + (layout.inspectorWidth ?? 0)).toBeLessThanOrEqual(
        viewport,
      );
    }
  });

  it("损坏或小于最小值的偏好退回默认宽度", () => {
    expect(parseInspectorWidth(null)).toBeNull();
    expect(parseInspectorWidth("abc")).toBeNull();
    expect(parseInspectorWidth("120")).toBeNull();
    expect(parseInspectorWidth(360)).toBe(360);
    const storage = (value: string | null): Pick<Storage, "getItem"> => ({ getItem: () => value });
    expect(readStoredInspectorWidth(storage("360"))).toBe(360);
    expect(readStoredInspectorWidth(storage("broken"))).toBe(320);
    expect(
      readStoredInspectorWidth({
        getItem: () => {
          throw new Error("storage disabled");
        },
      }),
    ).toBe(320);
  });
});
