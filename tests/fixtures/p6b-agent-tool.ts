import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { p6bFixture } from "./p6b-support";
import { registerInfoHubTools } from "../../src/extension/info-hub-tools";
import { readInfoHubResponse, type RemoteToolResponse } from "../../src/extension/remote-client";
import type { SproutExtensionAPI, SproutToolResult } from "../../src/extension/types";
import { INFO_HUB_CAPABILITIES } from "../../src/contracts/info-hub-capabilities";
const f = await p6bFixture("agent-tool");
const { PiSessionProcess } = await import("../../src/server/pi-host/process");
const { issueRemoteToolGrant, revokeRemoteToolGrant, remoteAgentResponse } =
  await import("../../src/server/remote-agent-gateway");
const { InfoHubHintChannel } = await import("../../src/domain/info-hub-hint");
const processHandle = new PiSessionProcess(
  f.runA,
  resolve("tests/fixtures/p6a-continuation-runner.mjs"),
);
try {
  const grant = issueRemoteToolGrant(f.runA, processHandle, f.ctx);
  let wireCalls = 0;
  const call = async (raw: unknown, secret = grant.secret) => {
    wireCalls++;
    const response = await remoteAgentResponse(
      new Request(grant.endpoint, {
        method: "POST",
        headers: {
          "x-sprout-request-id": f.ctx.requestId,
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(raw),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const tools: Parameters<SproutExtensionAPI["registerTool"]>[0][] = [];
  const valueOf = (result: SproutToolResult) => {
    const block = result.content[0];
    if (block?.type !== "text") throw new Error("missing tool text");
    return JSON.parse(block.text);
  };
  registerInfoHubTools(
    {
      registerTool: (tool) => {
        tools.push(tool);
      },
    },
    {
      projectId: grant.projectId,
      async request(request): Promise<RemoteToolResponse> {
        const { body } = await call(request);
        return !body.ok
          ? { outcome: "response", result: body }
          : (readInfoHubResponse(body, request) ?? {
              outcome: "unknown",
              reason: "invalid_response",
            });
      },
    },
  );
  f.equal(
    tools.map((tool) => tool.name),
    ["sprout_info_hub_get"],
  );
  const tool = tools[0]!;
  const result = await tool.execute("call-real-grant", {
    view: "agent",
    agentProfileId: f.a.id,
    section: "runs",
  });
  const value = valueOf(result);
  f.check(
    value.ok && value.data.data.some((run: { runId: string }) => run.runId === f.runNeighbor),
    `production tool reaches authenticated Project facts across Chats: ${JSON.stringify(value)}`,
  );
  f.equal(wireCalls, 1);
  f.check(!JSON.stringify(result).includes("SECRET"), "tool response contains no bodies");
  for (const identity of [
    { runId: f.runB },
    { instanceId: f.instanceB.id },
    { projectId: f.p.id },
    { actor: { runId: f.runB } },
    { userId: f.ctx.userId },
  ]) {
    const invalid = await tool.execute("forged", {
      view: "project",
      section: "agents",
      ...identity,
    });
    f.equal(valueOf(invalid).error.code, "validation_failed");
  }
  f.equal(wireCalls, 1, "identity forgery is rejected before transport");
  const forged = await call({
    version: 2,
    call: {
      type: "info_hub_get",
      input: { projectId: f.p.id, view: "project", section: "agents", runId: f.runB },
    },
  });
  f.equal(forged.body.error.code, "validation_failed");
  const target = await call({
    version: 2,
    call: {
      type: "info_hub_get",
      input: { projectId: f.p.id, view: "machine", machineId: f.machineB },
    },
  });
  f.check(
    target.body.ok && target.body.data.data.lease.holder.instanceId === f.instanceB.id,
    "target holder identity is a fact, never the acting identity",
  );
  const foreign = f.project.createProject({ name: "Foreign" }, f.ctx);
  const cross = await call({
    version: 2,
    call: {
      type: "info_hub_get",
      input: { projectId: foreign.id, view: "project", section: "agents" },
    },
  });
  f.equal(cross.body.error.code, "not_found");
  for (const type of ["hint.deliver", "hint_deliver", "turn_context_capture", "capture"]) {
    const denied = await call({
      version: 2,
      call: { type, input: { projectId: f.p.id, runId: f.runA } },
    });
    f.equal(denied.body.error.code, "validation_failed");
  }
  f.equal(INFO_HUB_CAPABILITIES["hint.deliver"].agent, "never");
  f.equal(INFO_HUB_CAPABILITIES["turn_snapshot.capture"].agent, "never");
  f.throws(
    () => f.turns.captureTurnContext({ projectId: f.p.id, runId: f.runA }, f.agentCtx),
    "forbidden",
  );
  f.throws(() => new InfoHubHintChannel(f.runA, f.agentCtx, () => {}), "forbidden");
  const invalid = await call(
    {
      version: 2,
      call: {
        type: "info_hub_get",
        input: { projectId: f.p.id, view: "project", section: "agents" },
      },
    },
    "x".repeat(43),
  );
  f.equal(invalid.status, 401);
  const source = readFileSync("scripts/pi-host-runner.mjs", "utf8");
  f.check(
    source.includes("registerInfoHubTools(pi, remote)") &&
      source.includes("...Object.keys(infoHubToolInputSchemas)"),
    "runner registers tool and exposes it through allowlist",
  );
  revokeRemoteToolGrant(f.runA, { ...f.ctx, now: new Date() });
  const revoked = await tool.execute("revoked", { view: "project", section: "agents" });
  f.equal(valueOf(revoked).error.code, "remote_grant_invalid");
  await processHandle.close();
  await f.runtime!.shutdownRuntime("p6b-agent-tool-gate");
  f.finish();
} catch (error) {
  console.error(error);
  await processHandle.close();
  await f.runtime?.shutdownRuntime("p6b-agent-tool-failure");
  process.exitCode = 1;
}
