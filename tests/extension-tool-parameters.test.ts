import { describe, expect, it } from "vite-plus/test";
import { registerInfoHubTools } from "../src/extension/info-hub-tools";
import { registerRemoteTools } from "../src/extension/remote-tools";
import { registerTaskTools } from "../src/extension/task-tools";
import type { RemoteToolClient, RemoteToolResponse } from "../src/extension/remote-client";
import type { SproutExtensionAPI } from "../src/extension/types";

type RegisterTool = SproutExtensionAPI["registerTool"];
type ToolParameters = Parameters<RegisterTool>[0]["parameters"];
type Registrar = (pi: Pick<SproutExtensionAPI, "registerTool">, client: RemoteToolClient) => void;

const projectId = "prj_00000000";
const client: RemoteToolClient = {
  projectId,
  request: async (): Promise<RemoteToolResponse> => ({
    outcome: "unknown",
    reason: "transport_error",
  }),
};

function parameters(register: Registrar): Map<string, ToolParameters> {
  const tools = new Map<string, ToolParameters>();
  register(
    {
      registerTool: (tool) => {
        tools.set(tool.name, tool.parameters);
      },
    },
    client,
  );
  return tools;
}

const sets = {
  remote: parameters(registerRemoteTools),
  task: parameters(registerTaskTools),
  infoHub: parameters(registerInfoHubTools),
};
const all = new Map([...sets.remote, ...sets.task, ...sets.infoHub]);

describe("extension tool parameters", () => {
  it("每个工具的 parameters 根都是 object", () => {
    expect(all.size).toBeGreaterThan(0);
    for (const [name, parameters] of all) {
      expect({ name, type: parameters.type }).toEqual({ name, type: "object" });
    }
  });

  it("info hub 的 view 联合保留每个分支的 strict object 约束", () => {
    const parameters = sets.infoHub.get("sprout_info_hub_get");
    expect(parameters?.oneOf).toEqual(expect.any(Array));
    const branches = parameters?.oneOf as Array<{
      additionalProperties: unknown;
      properties: { view: { const: string } };
    }>;
    expect(branches).toHaveLength(4);
    expect(branches.map((branch) => branch.properties.view.const)).toEqual([
      "project",
      "chat",
      "agent",
      "machine",
    ]);
    for (const branch of branches) expect(branch.additionalProperties).toBe(false);
  });
});
