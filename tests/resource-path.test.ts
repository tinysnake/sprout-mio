import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { createRemoteClient } from "../src/extension/remote-client";
import { registerRemoteTools } from "../src/extension/remote-tools";
import type { SproutExtensionAPI } from "../src/extension/types";

type Tool = Parameters<SproutExtensionAPI["registerTool"]>[0];
const projectId = "prj_00000000";
const calls = [
  {
    name: "sprout_resource_request",
    input: {
      crewChatId: "cnv_00000000",
      crewEpoch: 0,
      subjectKind: "delegation",
      delegationId: "dlg_00000000",
      attempt: 1,
      runId: "run_00000000",
      machineId: "mch_00000000",
      membershipEpoch: 1,
      directoryRealPath: "/workspace",
      directoryRevision: 1,
      operations: ["shell"],
      clientRequestId: "resource-request",
    },
  },
  {
    name: "sprout_lease_acquire",
    input: { machineId: "mch_00000000", requestId: "req_00000000", expectedGeneration: 0 },
  },
  {
    name: "sprout_remote_shell",
    input: {
      machineId: "mch_00000000",
      requestId: "req_00000000",
      authorizationGeneration: 1,
      command: "pwd",
      blockMs: 0,
    },
  },
];

async function withTools(
  status: number,
  body: string,
  check: (tools: Map<string, Tool>) => Promise<void>,
) {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const tools = new Map<string, Tool>();
    registerRemoteTools(
      {
        registerTool: (tool) => {
          tools.set(tool.name, tool);
        },
      },
      createRemoteClient({
        endpoint: `http://127.0.0.1:${port}/api/remote/agent`,
        secret: "a".repeat(43),
        projectId,
        expiresAt: "2026-10-24T00:15:00.000Z",
      }),
    );
    await check(tools);
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("Crew resource path model-visible errors", () => {
  it.each(calls)("preserves a coded 403 in $name without retrying", async ({ name, input }) => {
    const error = { code: "forbidden", message: "crew_epoch_changed", requestId: "server-denied" };
    await withTools(
      403,
      JSON.stringify({ ok: false, error, requestId: error.requestId }),
      async (tools) => {
        const result = await tools.get(name)!.execute("resource-path", input);
        const expected = { outcome: "rejected", status: 403, error, requestId: error.requestId };
        expect(result.isError).toBe(true);
        expect(result.details).toEqual(expected);
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
      },
    );
  });

  for (const body of [
    "not JSON",
    JSON.stringify({ ok: false, error: { code: "forbidden", message: 42 }, requestId: "bad" }),
  ]) {
    it.each(calls)(
      `keeps an unparseable or invalid envelope unknown in $name (${body})`,
      async ({ name, input }) => {
        await withTools(403, body, async (tools) => {
          const result = await tools.get(name)!.execute("resource-path", input);
          expect(result.isError).toBe(true);
          expect(result.details).toMatchObject({ outcome: "unknown", reason: "invalid_response" });
          const content = result.content[0]!;
          expect(content.type).toBe("text");
          if (content.type === "text") expect(JSON.parse(content.text)).toEqual(result.details);
        });
      },
    );
  }
});
