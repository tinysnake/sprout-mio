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
  // 空 catalog 不是失败：没有可装的东西，但也不是 ok。
  expect(await extension.refresh()).toMatchObject({ outcome: "ok", tools: [] });
  target = { machineId, generation: 4 };
  await extension.refresh();
  target = null;
  // 未持租约是 idle，不是失败，也不发请求。
  expect(await extension.refresh()).toEqual({
    outcome: "idle",
    reason: "未持有可用的 Machine 租约代次",
  });
  expect(requests).toEqual([
    { machineId, generation: 3 },
    { machineId, generation: 4 },
  ]);
  expect(extension.tools).toEqual([]);
  await events.get("session_shutdown")!();
});

test("目录查询失败时 refresh 报 failed，并且默认 onError 写入诊断而不是静默 ok", async () => {
  const projectId = newId(ID_PREFIXES.project);
  const machineId = newId(ID_PREFIXES.machine);
  const events = new Map<string, () => void | Promise<void>>();
  const remote: RemoteToolClient = {
    projectId,
    async request() {
      return {
        outcome: "response",
        result: {
          ok: false as const,
          error: {
            code: "machine_unavailable" as const,
            message: "机器不可用",
            requestId: newId(ID_PREFIXES.request),
          },
          requestId: newId(ID_PREFIXES.request),
        },
      };
    },
  };
  const extension = await registerSproutMcp(
    {
      registerTool() {
        throw new Error("a failing catalog must not register tools");
      },
      on(event, handler) {
        events.set(event, handler);
      },
    },
    {
      remote,
      machineId,
      authorizationGeneration: () => 1,
      piMcp: {} as PiMcpModule,
    },
  );
  const result = await extension.refresh();
  expect(result.outcome).toBe("failed");
  expect(result.outcome === "failed" && result.error.message).toContain("machine_unavailable");
  // 诊断槽必须留住这条失败：这是「不静默 return ok」的可观测证据。
  expect(extension.lastError).toContain("machine_unavailable");
  await events.get("session_shutdown")!();
});
