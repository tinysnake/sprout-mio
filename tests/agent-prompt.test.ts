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
