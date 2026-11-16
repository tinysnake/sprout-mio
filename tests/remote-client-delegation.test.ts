import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vite-plus/test";
import { createRemoteClient } from "../src/extension/remote-client";
import { registerRemoteTools } from "../src/extension/remote-tools";
import { registerDelegationTools } from "../src/extension/delegation-tools";
import type { RemoteAgentRequest } from "../src/contracts/remote";
import type { SproutExtensionAPI } from "../src/extension/types";

const projectId = "prj_00000000";
const delegationId = "dlg_00000000";
const data = { projectId, chatId: "cnv_00000000", delegationId, status: "completed" };
const complete: RemoteAgentRequest = {
  version: 2,
  call: {
    type: "delegation_mutate",
    input: { projectId, action: "complete", delegationId, summary: "Worker result" },
  },
};

async function withResponse(
  status: number,
  body: unknown,
  check: (client: ReturnType<typeof createRemoteClient>) => Promise<void>,
) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    await check(
      createRemoteClient({
        endpoint: `http://127.0.0.1:${port}/api/remote/agent`,
        secret: "a".repeat(43),
        projectId,
        expiresAt: "2026-10-24T00:15:00.000Z",
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function tools(client: ReturnType<typeof createRemoteClient>) {
  const registered = new Map<string, Parameters<SproutExtensionAPI["registerTool"]>[0]>();
  const api = {
    registerTool: (tool: Parameters<SproutExtensionAPI["registerTool"]>[0]) => {
      registered.set(tool.name, tool);
    },
  };
  registerRemoteTools(api, client);
  registerDelegationTools(api, client);
  return registered;
}

describe("remote server rejection and delegation success", () => {
  it.each([200, 400, 401, 403, 404, 409, 429, 500])(
    "surfaces HTTP %s business rejection through the tool",
    async (status) => {
      const error = {
        code: "lease_not_holder",
        message: "Crew scope was not allocated; do not repeat acquisition.",
        requestId: "server-rejection",
      };
      await withResponse(
        status,
        { ok: false, error, requestId: error.requestId },
        async (client) => {
          const response = await tools(client).get("sprout_lease_acquire")!.execute("acquire", {
            machineId: "mch_00000000",
            requestId: "req_00000000",
            expectedGeneration: 0,
          });
          expect(response.isError).toBe(true);
          expect(response.details).toEqual({
            outcome: "rejected",
            status,
            error,
            requestId: error.requestId,
          });
          const block = response.content[0]!;
          expect(block.type).toBe("text");
          if (block.type === "text") expect(JSON.parse(block.text)).toEqual(response.details);
        },
      );
    },
  );

  it.each([
    { action: "complete", status: "completed" },
    { action: "block", status: "blocked" },
  ] as const)(
    "accepts a validated $action success through the tool",
    async ({ action, status }) => {
      const result = { ok: true, data: { ...data, status }, requestId: "server-success" };
      await withResponse(200, result, async (client) => {
        const response = await tools(client)
          .get(`sprout_delegation_${action}`)!
          .execute("mutation", {
            delegationId,
            summary: "Worker result",
            ...(action === "block" ? { reason: "resource_unavailable" } : {}),
          });
        expect(response.isError).toBe(false);
        expect(response.details).toEqual(result);
      });
    },
  );

  it.each([
    {
      status: 403,
      body: { ok: false, error: { code: "lease_not_holder", message: 42 }, requestId: "bad" },
    },
    { status: 500, body: "not JSON" },
    ...[
      { ...data, projectId: "prj_11111111" },
      { ...data, delegationId: "dlg_11111111" },
      { ...data, status: "invented" },
      { ...data, untrusted: true },
    ].map((value) => ({ status: 200, body: { ok: true, data: value, requestId: "bad" } })),
    { status: 403, body: { ok: true, data, requestId: "bad" } },
  ])(
    "keeps malformed, mismatched, or contradictory payloads unknown ($status)",
    async ({ status, body }) => {
      await withResponse(status, body, async (client) => {
        expect(await client.request(complete)).toEqual({
          outcome: "unknown",
          reason: "invalid_response",
        });
      });
    },
  );
});
