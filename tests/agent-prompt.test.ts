import { describe, expect, it } from "vite-plus/test";

const { composeSystemPrompt } = await import("../src/extension/agent-prompt");
const { situationSchema } = await import("../src/contracts/prompt");

const persona = "说话直接，先给结论。";
const htmlGuide = "消息里的 HTML 代码块会在沙箱里渲染成页面；图片用 data URI。";

const crewLeadPrompt = composeSystemPrompt({
  situation: situationSchema.parse({ kind: "crew_lead", crewName: "阿尔法小队" }),
  persona,
  htmlGuide,
});
const delegationWorkerPrompt = composeSystemPrompt({
  situation: situationSchema.parse({
    kind: "delegation_worker",
    delegationId: "dlg_0123456789",
    leadName: "Lead",
  }),
  persona,
  htmlGuide,
});

/**
 * 这里只验证 composer 返回的文本；真实 runner 发给 provider 的内容由
 * agent-prompt-runner.test.ts 单独验证。
 */
describe("crew lead 的 system prompt", () => {
  it("写到情境、成员选择、边界与等待规则", () => {
    expect(crewLeadPrompt).toContain("阿尔法小队");
    expect(crewLeadPrompt).toContain("sprout_info_hub_get");
    expect(crewLeadPrompt).toContain("sprout_delegation_start");
    expect(crewLeadPrompt).toContain("sprout_delegation_input");
    expect(crewLeadPrompt).toContain("sprout_delegation_cancel");
    expect(crewLeadPrompt).toContain("sprout_delegation_list");
    expect(crewLeadPrompt).toContain("clientRequestId");
    expect(crewLeadPrompt).toContain("sleep");
    for (const rule of [
      "按名字与工作描述挑人，勿凭职级或习惯",
      "结束这一轮就是等待，sleep 后查或循环调用 sprout_delegation_list 都是错的",
      "重试同次派发保持成员与 request 文本不变",
    ])
      expect(crewLeadPrompt).toContain(rule);
    expect(crewLeadPrompt).toContain("更多工具用tool_search找");
    expect(crewLeadPrompt).toContain("只承诺");
    expect(crewLeadPrompt).toContain(persona);
    expect(crewLeadPrompt).toContain(htmlGuide);
  });

  it("不混入 delegation worker 的上报工具", () => {
    expect(crewLeadPrompt).not.toContain("sprout_delegation_complete");
    expect(crewLeadPrompt).not.toContain("sprout_delegation_block");
  });

  it("遵守段落预算", () => {
    const parts = crewLeadPrompt.split("\n\n");
    expect(parts[0]!.length).toBeLessThanOrEqual(350);
    const roleTotal = parts.slice(1, 6).reduce((total, part) => total + part.length, 0);
    expect(roleTotal).toBeLessThanOrEqual(1000);
    expect(crewLeadPrompt.length).toBeLessThanOrEqual(4000);
  });

  it("Crew 名缺省时归一到占位名", () => {
    const prompt = composeSystemPrompt({
      situation: situationSchema.parse({ kind: "crew_lead", crewName: "   " }),
      persona: "",
      htmlGuide: "",
    });
    expect(prompt).toContain("当前 Crew");
  });
});

describe("delegation worker 的 system prompt", () => {
  it("写到身份、完成上报、阻塞上报与结果回流", () => {
    expect(delegationWorkerPrompt).toContain("dlg_0123456789");
    expect(delegationWorkerPrompt).toContain("Lead");
    expect(delegationWorkerPrompt).toContain("sprout_delegation_complete");
    expect(delegationWorkerPrompt).toContain("delegationId");
    expect(delegationWorkerPrompt).toContain("200");
    expect(delegationWorkerPrompt).toContain("sprout_delegation_block");
    expect(delegationWorkerPrompt).toContain("Human 或 Crew lead");
    for (const reason of ["needs_input", "resource_unavailable", "out_of_scope", "failed"])
      expect(delegationWorkerPrompt).toContain(reason);
    expect(delegationWorkerPrompt).toContain("更多工具用tool_search找");
    expect(delegationWorkerPrompt).toContain(persona);
    expect(delegationWorkerPrompt).toContain(htmlGuide);
  });

  it("不混入 crew lead 的派发工具", () => {
    expect(delegationWorkerPrompt).not.toContain("sprout_delegation_start");
    expect(delegationWorkerPrompt).not.toContain("sprout_delegation_cancel");
  });

  it("遵守段落预算", () => {
    const parts = delegationWorkerPrompt.split("\n\n");
    expect(parts[0]!.length).toBeLessThanOrEqual(350);
    const roleTotal = parts.slice(1, 6).reduce((total, part) => total + part.length, 0);
    expect(roleTotal).toBeLessThanOrEqual(1000);
    expect(delegationWorkerPrompt.length).toBeLessThanOrEqual(4000);
  });
});

describe("项目与工作描述", () => {
  it.each(["crew_lead", "delegation_worker"] as const)(
    "%s 把自身描述和项目预设放在职责之后",
    (kind) => {
      const prompt = composeSystemPrompt({
        situation: { kind },
        profile: { description: "只负责代码评审" },
        projectContext: { kind: "coding" },
        persona,
        htmlGuide,
      });
      expect(prompt).toContain("## 工作描述\n只负责代码评审");
      expect(prompt).toContain("## 项目背景\n编程项目。");
      expect(prompt).toContain("读约定/实现");
      expect(prompt).toContain("相称验证");
      expect(prompt).toContain("可核代码/证据");
      expect(prompt).toContain("补充要求优先于本节");
      expect(prompt.indexOf("## 工作描述")).toBeGreaterThan(prompt.indexOf("## 职责"));
      expect(prompt.indexOf("## 项目背景")).toBeGreaterThan(prompt.indexOf("## 工作描述"));
      expect(prompt.indexOf("## 说话风格")).toBeGreaterThan(prompt.indexOf("## 项目背景"));
      expect(prompt).not.toContain("## 项目补充要求");
      expect(prompt).not.toContain("成员名册");
    },
  );
  it("custom 与缺省项目不注入预设，work 有自己的文本", () => {
    for (const projectContext of [undefined, { kind: "custom" as const }]) {
      expect(
        composeSystemPrompt({
          situation: { kind: "crew_lead" },
          projectContext,
          profile: { description: "  " },
          persona: "",
          htmlGuide: "",
        }),
      ).not.toMatch(/## 项目背景|## 工作描述/);
    }
    expect(
      composeSystemPrompt({
        situation: { kind: "crew_lead" },
        projectContext: { kind: "work" },
        persona: "",
        htmlGuide: "",
      }),
    ).toContain(
      "工作项目。明确目标、依据与交付标准，整理信息并推进执行；结论注明证据、责任人与未决事项。",
    );
  });
  it.each(["crew_lead", "delegation_worker"] as const)("%s 满字段仍满足分段和总预算", (kind) => {
    const prompt = composeSystemPrompt({
      situation: {
        kind,
        crewName: "队".repeat(80),
        leadName: "名".repeat(80),
        delegationId: "dlg_12345678",
      },
      profile: { description: "职".repeat(500) },
      projectContext: { kind: "coding" },
      persona: "人".repeat(2000),
      htmlGuide: "页".repeat(600),
    });
    const parts = prompt.split("\n\n");
    expect(parts[0]!.length).toBeLessThanOrEqual(350);
    expect(parts.slice(1, 6).join("").length).toBeLessThanOrEqual(1000);
    expect(parts.find((p) => p.startsWith("## 工作描述"))!.length).toBeLessThanOrEqual(600);
    expect(parts.find((p) => p.startsWith("## 项目背景"))!.length).toBeLessThanOrEqual(600);
    expect(parts.find((p) => p.startsWith("## HTML"))!.length).toBeLessThanOrEqual(600);
    expect(prompt.length).toBeLessThanOrEqual(4000);
  });
});

describe("situationSchema 往返", () => {
  it("保留全部字段", () => {
    const value = {
      kind: "delegation_worker",
      delegationId: "dlg_0123456789",
      leadName: "Lead",
      crewName: "Crew",
    };
    expect(situationSchema.parse(value)).toEqual(value);
  });

  it("剥掉未知字段，不把项目信息带进 prompt", () => {
    expect(situationSchema.parse({ kind: "dm_worker", projectName: "secret" })).toEqual({
      kind: "dm_worker",
    });
  });
});
