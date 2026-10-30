import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { McpCatalogView, McpSession, WorkerMcpItem } from "../../src/contracts/mcp";
import type { WorkerSession } from "../../src/contracts/worker-session";
import type { WorkerExchangeInput } from "../../src/contracts/worker";
import type { MachineContext } from "../../src/domain/machine";
import { applyMcpExchange } from "../../src/domain/mcp/exchange";
import { mcpBound, mcpPayloadHash } from "../../src/domain/mcp/protocol";
import { sqlite } from "../../src/db";
import type { RemoteToolClient } from "../../src/extension/remote-client";
import type { AgentRemoteContext } from "../../src/server/lease";
import { mcpSessionExchange } from "../../src/server/mcp-relay";
import { exchangeWorker } from "../../src/server/worker-gateway";
import { emptyWorkerRemote } from "../../src/worker/remote";
import { readResponseForProbe } from "./mcp-extension-probe";

type Registration = McpCatalogView["registrations"][number];
type Options = {
  remote: RemoteToolClient;
  runtime: { bootId: string };
  projectId: string;
  machineId: string;
  chatId: string;
  instanceId: string;
  runId: string;
  grantId: string;
  worker: WorkerSession;
  workerContext: MachineContext;
  capability: Extract<WorkerExchangeInput, { mode: "normal" }>["capability"];
  wire: { machineId: string; secret: string; version: 3; requestId: string };
  nextSeq(): number;
  registration: Registration;
  process: Registration["processes"][number];
};

/** Control frames are labelled synthetic. They test hold timing, not MCP protocol success. */
export async function measureWakeControls(o: Options) {
  const opened = (await readResponseForProbe(o.remote, {
    version: 2,
    call: {
      type: "mcp_session_open",
      input: {
        projectId: o.projectId,
        machineId: o.machineId,
        authorizationGeneration: 1,
        requestId: newId(ID_PREFIXES.request),
        registrationId: o.registration.registrationId,
        registrationRevision: o.registration.registrationRevision,
        processId: o.process.processId,
        expectedWorkerIncarnationId: o.process.workerIncarnationId,
      },
    },
  })) as { session: McpSession };
  const session = opened.session;
  const ctx = {
    ...o.runtime,
    userId: "owner",
    now: new Date(),
    projectId: o.projectId,
    chatId: o.chatId,
    instanceId: o.instanceId,
    runId: o.runId,
    grantId: o.grantId,
    requestId: newId(ID_PREFIXES.request),
  } as AgentRemoteContext;
  const holdMs = 2000;
  const trials: { mode: string; elapsedMs: number; frames: number }[] = [];
  let ack = 0;
  for (const mode of ["without_remote_wake", "with_remote_wake", "outer_rollback"] as const) {
    const bytes = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/sprout-control" }),
    );
    const frame: WorkerMcpItem = {
      type: "frame",
      direction: "server_to_client",
      ...mcpBound(session),
      frameId: newId(ID_PREFIXES.mcpFrame),
      seq: ack + 1,
      payloadBase64: bytes.toString("base64"),
      payloadBytes: bytes.length,
      payloadHash: mcpPayloadHash(bytes),
      expiresAt: Date.now() + 30000,
    };
    const start = performance.now();
    const held = mcpSessionExchange(
      {
        projectId: o.projectId,
        machineId: o.machineId,
        authorizationGeneration: 1,
        sessionId: session.id,
        frames: [],
        ackServerSeq: ack,
        cancelClientSeqs: [],
        protocolVersion: null,
        confirmInitialized: false,
        holdMs,
      },
      ctx,
    );
    const remote = { ...emptyWorkerRemote(), mcp: [frame] };
    o.workerContext.now = new Date();
    if (mode === "without_remote_wake") {
      // Same production frame persistence; intentionally omit the remote.ts post-commit notifier.
      sqlite.transaction(() =>
        applyMcpExchange(remote, {
          session: o.worker,
          mode: "normal",
          seq: 1,
          now: o.workerContext.now,
          bootId: o.runtime.bootId,
        }),
      )();
    } else {
      const deliver = () =>
        exchangeWorker(
          {
            ...o.wire,
            session: o.worker,
            seq: o.nextSeq(),
            mode: "normal",
            capability: o.capability,
            observations: [],
            remote,
          },
          o.workerContext,
        );
      if (mode === "outer_rollback") {
        assert.throws(
          () =>
            sqlite.transaction(() => {
              deliver();
              assert(sqlite.inTransaction);
              throw new Error("intentional outer rollback");
            })(),
          /intentional outer rollback/,
        );
      } else {
        deliver();
        assert.equal(sqlite.inTransaction, false);
      }
    }
    const result = await held;
    const elapsedMs = performance.now() - start;
    trials.push({ mode, elapsedMs, frames: result.frames.length });
    if (mode === "with_remote_wake") {
      assert(
        elapsedMs < holdMs,
        `wake must return before the ${holdMs}ms hold expires: ${elapsedMs}`,
      );
      assert.equal(result.frames.length, 1);
    } else {
      assert(elapsedMs >= holdMs - 200, `${mode} must wait for hold timeout: ${elapsedMs}`);
      assert.equal(result.frames.length, mode === "outer_rollback" ? 0 : 1);
    }
    if (result.frames.length) ack = result.frames[0]!.seq;
  }
  await readResponseForProbe(o.remote, {
    version: 2,
    call: {
      type: "mcp_session_close",
      input: {
        projectId: o.projectId,
        machineId: o.machineId,
        authorizationGeneration: 1,
        sessionId: session.id,
        requestId: newId(ID_PREFIXES.request),
        reason: "client_closed",
      },
    },
  });
  return { holdMs, payloadSource: "synthetic notification for timing controls only", trials };
}
