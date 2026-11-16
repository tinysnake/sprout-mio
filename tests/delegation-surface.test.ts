import { describe, expect, it } from "vite-plus/test";

const { delegationToolNames } = await import("../src/extension/delegation-surface");
const { situationSchema } = await import("../src/contracts/prompt");

const crewLead = situationSchema.parse({ kind: "crew_lead", crewName: "阿尔法小队" });
const delegationWorker = situationSchema.parse({
  kind: "delegation_worker",
  delegationId: "dlg_0123456789",
  leadName: "Lead",
});

/**
 * delegation 工具注册了但没进 allowlist 时，模型看不到它们。这里按处境锁住声明给
 * 模型的名单：处境是唯一判别式，角色之外的运行（含没有 situation 的）一个也不声明。
 */
describe("delegation 工具面按处境声明", () => {
  it("crew lead 声明四个 crew 工具", () => {
    expect(delegationToolNames(crewLead)).toEqual([
      "sprout_delegation_start",
      "sprout_delegation_input",
      "sprout_delegation_cancel",
      "sprout_delegation_list",
    ]);
  });

  it("delegation worker 声明两个上报工具", () => {
    expect(delegationToolNames(delegationWorker)).toEqual([
      "sprout_delegation_complete",
      "sprout_delegation_block",
    ]);
  });

  it("assistant 与 dm_worker 不声明 delegation 工具", () => {
    expect(delegationToolNames(situationSchema.parse({ kind: "assistant" }))).toEqual([]);
    expect(delegationToolNames(situationSchema.parse({ kind: "dm_worker" }))).toEqual([]);
  });

  it("没有 situation 的运行不声明 delegation 工具", () => {
    expect(delegationToolNames(undefined)).toEqual([]);
  });
});
