import { describe, expect, it } from "vite-plus/test";

const { situationSchema } = await import("../src/contracts/prompt");

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
