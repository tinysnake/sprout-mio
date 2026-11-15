import { describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CrewDelegationCard, CrewDelegationRail } from "../src/contracts/delegation";
import {
  crewRailExpanded,
  crewRailStorageKey,
  crewVisibleInactiveCount,
} from "../src/components/chat/crew-rail-state";
import { CrewRail } from "../src/components/chat/crew-rail";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    ...props
  }: {
    children: React.ReactNode;
    className?: string;
    "data-testid"?: string;
  }) => createElement("a", { className, "data-testid": props["data-testid"] }, children),
}));
const card: CrewDelegationCard = {
  delegationId: "del_one",
  childChatId: "cnv_child",
  workerProfileName: "Researcher",
  title: "检查接口",
  status: "running",
  updatedAt: "2026-11-15T00:00:00.000Z",
  elapsedMs: 3000,
  summary: null,
  attentionReason: null,
};
const data: CrewDelegationRail = {
  active: [card],
  inactive: [],
  counts: { active: 1, inactive: 0, needsYou: 0 },
};
function render(kind: "crew" | "dm" | "delegation", value = data) {
  return renderToStaticMarkup(
    createElement(CrewRail, {
      projectId: "prj_one",
      session: { kind: kind === "dm" ? "dm" : "crew", chat: { id: "cnv_crew", kind } },
      data: value,
    }),
  );
}
describe("Crew rail 的显示与偏好", () => {
  it("只展示 Crew 主对话；无委派不占空栏", () => {
    expect(render("dm")).toBe("");
    expect(render("delegation")).toBe("");
    expect(
      render("crew", {
        active: [],
        inactive: [],
        counts: { active: 0, inactive: 0, needsYou: 0 },
      }),
    ).toBe("");
  });
  it("状态有色、运行中有动效，历史按空位折叠", () => {
    const inactive = (id: string, status: CrewDelegationCard["status"]): CrewDelegationCard => ({
      ...card,
      delegationId: id,
      childChatId: `chat-${id}`,
      title: id,
      status,
    });
    const html = render("crew", {
      active: [card, inactive("queued", "queued")],
      inactive: [
        inactive("failed", "failed"),
        inactive("done", "completed"),
        inactive("canceled", "canceled"),
        inactive("blocked", "blocked"),
      ],
      counts: { active: 2, inactive: 4, needsYou: 2 },
    });
    expect(html).toContain('aria-label="进行中的委派"');
    expect(html).toContain('aria-label="非进行中的委派"');
    expect(html).toContain("进行中的委派 2");
    expect(html).toContain("非进行中的委派 4");
    expect(html).toContain("需处理 2");
    expect(html).toMatch(/data-status="running"[^>]*text-status-success/);
    expect(html).toMatch(/data-status="queued"[^>]*text-status-warning/);
    expect(html).toMatch(/data-status="failed"[^>]*text-status-failed/);
    expect(html).toMatch(/data-status="completed"[^>]*text-status-success/);
    expect(html).toContain('data-testid="crew-card-pulse"');
    expect(html).toContain('data-testid="crew-history-toggle"');
    expect(html).toContain("历史委派");
    expect(html).toContain('aria-label="历史委派" hidden');
    expect(html).not.toContain('aria-label="需要你"');
  });
  it("进行中占用预览位，非进行中最多显示 3 个", () => {
    expect(crewVisibleInactiveCount(0, 10)).toBe(3);
    expect(crewVisibleInactiveCount(1, 10)).toBe(2);
    expect(crewVisibleInactiveCount(2, 10)).toBe(1);
    expect(crewVisibleInactiveCount(3, 10)).toBe(0);
    expect(crewVisibleInactiveCount(5, 10)).toBe(0);
    expect(crewVisibleInactiveCount(0, 1)).toBe(1);
    expect(crewVisibleInactiveCount(0, 0)).toBe(0);
  });
  it("窄屏默认折叠，显式偏好跨宽度保留并按 Project 分离", () => {
    expect(crewRailExpanded(null, 1023)).toBe(false);
    expect(crewRailExpanded(null, 1024)).toBe(true);
    expect(crewRailExpanded("expanded", 390)).toBe(true);
    expect(crewRailExpanded("collapsed", 1600)).toBe(false);
    expect(crewRailExpanded("garbage", 390)).toBe(false);
    expect(crewRailStorageKey("prj_one")).not.toBe(crewRailStorageKey("prj_two"));
  });
});
