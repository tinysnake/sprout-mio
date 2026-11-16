import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { AgentProfile } from "../src/contracts/agent";
import type { Project } from "../src/contracts/project";
import { fail } from "../src/contracts/result";
import { AgentProfileEditor, draftFromProfile } from "../src/components/agent/agent-profile-editor";
import { ProjectBasicInfoForm } from "../src/components/project/project-basic-info-form";

const project: Project = {
  kind: "work",
  id: "prj_11111111",
  name: "Sprout 重构",
  description: "把协作工作台推进到可交付的一期产品。",
  agentPrompt: "遵守 docs/frontend-conventions.md，不要改动 A/B 冻结臂。",
  createdAt: "2026-10-01T02:30:00.000Z",
  updatedAt: "2026-10-18T07:12:00.000Z",
};

const profile: AgentProfile = {
  id: "agp_33333333",
  name: "Repo 分析员",
  jobTitle: "只读分析",
  description: "只读仓库与 git 历史，回答依赖关系、变更范围与风险点。",
  persona: "按 commit 与文件路径说明结论。",
  harness: "pi",
  purpose: "worker",
  createdBy: "demo-human",
  createdAt: "2026-09-28T01:00:00.000Z",
  updatedAt: "2026-10-16T03:20:00.000Z",
};

it("Project 基本信息表单能编辑项目类型与自写项目提示词", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectBasicInfoForm, {
      project,
      submit: () =>
        Promise.resolve(fail({ code: "internal", message: "演示失败", requestId: "req_test" })),
      onSaved: () => undefined,
    }),
  );
  // kind 是互斥的连体选项组：三个选项都在，当前值所在格标记为选中。
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('data-testid="project-edit-kind-coding"');
  expect(html).toContain('data-testid="project-edit-kind-work"');
  expect(html).toContain('data-testid="project-edit-kind-custom"');
  expect(html).toContain('data-testid="project-edit-kind-work" data-checked="true"');
  expect(html).toContain('data-testid="project-edit-kind-coding" data-checked="false"');
  // 自写提示词：上限、当前字数与「下一轮生效」都要可见，草稿回灌当前值。
  expect(html).toContain('data-testid="project-edit-agent-prompt"');
  expect(html).toContain('maxLength="2000"');
  expect(html).toContain("下一轮运行生效");
  expect(html).toContain(project.agentPrompt!);
});

it("Project 基本信息表单在未设置提示词时草稿为空且计数归零", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectBasicInfoForm, {
      project: { ...project, kind: "custom", agentPrompt: null },
      submit: () =>
        Promise.resolve(fail({ code: "internal", message: "演示失败", requestId: "req_test" })),
      onSaved: () => undefined,
    }),
  );
  expect(html).toContain('data-testid="project-edit-kind-custom" data-checked="true"');
  expect(html).toContain("0 / 2000");
});

it("Agent 编辑表单能编辑工作描述，draft 保留 description", () => {
  expect(draftFromProfile(profile).description).toBe(profile.description);
  expect(draftFromProfile({ ...profile, description: undefined }).description).toBe("");
  const html = renderToStaticMarkup(
    createElement(AgentProfileEditor, {
      profile,
      submit: () =>
        Promise.resolve(fail({ code: "internal", message: "演示失败", requestId: "req_test" })),
      onSaved: () => undefined,
    }),
  );
  expect(html).toContain('data-testid="agent-edit-description"');
  expect(html).toContain('maxLength="500"');
  expect(html).toContain(profile.description!);
  expect(html).toContain("/ 500");
});
