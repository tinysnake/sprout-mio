import { describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CrewDelegationCard, CrewDelegationRail } from "../src/contracts/delegation";
import { crewRailExpanded, crewRailStorageKey } from "../src/components/chat/crew-rail-state";
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
  needsYou: [],
  completed: [],
  counts: { active: 1, needsYou: 0, completed: 0 },
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
        needsYou: [],
        completed: [],
        counts: { active: 0, needsYou: 0, completed: 0 },
      }),
    ).toBe("");
  });
  it("空段隐藏，卡片有文字状态、计数和折叠语义", () => {
    const html = render("crew");
    expect(html).toContain('aria-label="委派"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("进行中 1");
    expect(html).toContain('data-testid="crew-card-status">进行中');
    expect(html).not.toContain('aria-label="需要你"');
    expect(html).not.toContain('aria-label="已完成"');
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
