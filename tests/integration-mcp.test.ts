import { expect, test } from "vite-plus/test";
import { ID_PREFIXES, newId } from "../src/contracts/ids";
import { registerSproutMcp } from "../src/extension/mcp-extension";
import type { PiMcpModule } from "../src/extension/mcp-pi-types";
import type { RemoteToolClient } from "../src/extension/remote-client";

test("MCP registration waits for an explicit lease target and uses its exact generation on refresh", async () => {
  const projectId = newId(ID_PREFIXES.project);
  const machineId = newId(ID_PREFIXES.machine);
  let target: { machineId: string; generation: number } | null = null;
  const requests: { machineId: string; generation: number }[] = [];
  const events = new Map<string, () => void | Promise<void>>();
  const remote: RemoteToolClient = {
    projectId,
    async request({ call }) {
      if (call.type !== "mcp_catalog_get") throw new Error("unexpected non-catalog request");
      requests.push({
        machineId: call.input.machineId,
        generation: call.input.authorizationGeneration,
      });
      return {
        outcome: "response",
        result: { ok: true, data: { registrations: [] }, requestId: newId(ID_PREFIXES.request) },
      };
    },
  };
  const extension = await registerSproutMcp(
    {
      registerTool() {
        throw new Error("empty catalog must not register tools");
      },
      on(event, handler) {
        events.set(event, handler);
      },
    },
    {
      remote,
      machineId: () => target?.machineId ?? null,
      authorizationGeneration: () => target?.generation ?? null,
      // No MCP protocol is exercised: an empty catalog cannot instantiate a client.
      piMcp: {} as PiMcpModule,
    },
  );
  await events.get("session_start")!();
  expect(requests).toEqual([]);
  target = { machineId, generation: 3 };
  await extension.refresh();
  target = { machineId, generation: 4 };
  await extension.refresh();
  target = null;
  await extension.refresh();
  expect(requests).toEqual([
    { machineId, generation: 3 },
    { machineId, generation: 4 },
  ]);
  expect(extension.tools).toEqual([]);
  await events.get("session_shutdown")!();
});
