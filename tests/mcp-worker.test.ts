import { describe, expect, test } from "vite-plus/test";
import { newId, ID_PREFIXES } from "../src/contracts/ids";
import { mcpBound } from "../src/domain/mcp/protocol";
import { workerExchangeInput, workerExchangeOutputRemoteSchema } from "../src/contracts/worker";
import { McpRuntime } from "../src/worker/mcp";
import { startHttpMcpServer } from "./fixtures/mcp-http-server";
import { RemoteDispatcher } from "../src/worker/remote";
import {
  attach,
  authorization,
  clientFrame,
  registration,
  serverFrames,
  sessionFor,
  setup,
  waitFor,
  workerSession,
} from "./fixtures/mcp-runtime";

const decoded = (frame: { payloadBase64: string }) =>
  JSON.parse(Buffer.from(frame.payloadBase64, "base64").toString());
describe("MCP Worker", () => {
  test("unknown and replayed detach leaves the configured service and its active session usable", async () => {
    const { runtime, session, process: service } = await setup();
    try {
      const detach = {
        type: "session_detach" as const,
        ...mcpBound({ ...session, id: newId(ID_PREFIXES.mcpSession) }),
        reason: "client_closed" as const,
      };
      for (let replay = 0; replay < 2; replay++) {
        expect(() => runtime.accept([detach], [], [authorization(session)])).not.toThrow();
        expect(() => process.kill(service.pid!, 0)).not.toThrow();
        expect(runtime.outgoing().mcp).not.toContainEqual(
          expect.objectContaining({ type: "process_fact" }),
        );
      }
      runtime.accept(
        [
          clientFrame(session, 1, {
            jsonrpc: "2.0",
            id: 1,
            method: "fixture/ping",
            params: { alive: true },
          }),
        ],
        [],
        [authorization(session)],
      );
      const reply = await waitFor(() =>
        serverFrames(runtime).find((frame) => decoded(frame).id === 1),
      );
      expect(decoded(reply).result).toEqual({ echo: { alive: true } });
      expect(() => process.kill(service.pid!, 0)).not.toThrow();
    } finally {
      await runtime.stop();
    }
  });
  test("detach rejects every mismatched bound on an existing session before closing it", async () => {
    const { runtime, session, process: service } = await setup();
    try {
      const bound = mcpBound(session);
      const mismatches: Partial<typeof bound>[] = [
        { projectId: newId(ID_PREFIXES.project) },
        { machineId: newId(ID_PREFIXES.machine) },
        { authorizationGeneration: bound.authorizationGeneration + 1 },
        { holderInstanceId: newId(ID_PREFIXES.instance) },
        { processId: newId(ID_PREFIXES.mcpProcess) },
        { workerSession: { ...bound.workerSession, machineId: newId(ID_PREFIXES.machine) } },
        {
          workerSession: { ...bound.workerSession, generation: bound.workerSession.generation + 1 },
        },
        { workerSession: { ...bound.workerSession, bootId: newId(ID_PREFIXES.boot) } },
        { workerSession: { ...bound.workerSession, attemptId: "other-attempt" } },
      ];
      for (const mismatch of mismatches) {
        expect(() =>
          runtime.accept(
            [{ type: "session_detach", ...bound, ...mismatch, reason: "client_closed" }],
            [],
            [authorization(session)],
          ),
        ).toThrow("MCP session identity rejected");
        expect(() =>
          runtime.accept(
            [
              {
                type: "session_reconcile",
                machineId: session.machineId,
                workerSession: bound.workerSession,
                closedHash: "0".repeat(64),
                sessions: [{ ...bound, ...mismatch }],
              },
            ],
            [],
            [authorization(session)],
          ),
        ).toThrow(/MCP reconciliation .*identity.*rejected/);
      }
      runtime.accept(
        [
          clientFrame(session, 1, {
            jsonrpc: "2.0",
            id: 1,
            method: "fixture/ping",
            params: { alive: true },
          }),
        ],
        [],
        [authorization(session)],
      );
      const reply = await waitFor(() =>
        serverFrames(runtime).find((frame) => decoded(frame).id === 1),
      );
      expect(decoded(reply).result).toEqual({ echo: { alive: true } });
      const detach = {
        type: "session_detach" as const,
        ...bound,
        reason: "client_closed" as const,
      };
      runtime.accept([detach], [], [authorization(session)]);
      expect(runtime.outgoing().mcp).toContainEqual(
        expect.objectContaining({ type: "session_fact", sessionId: session.id, state: "detached" }),
      );
      expect(() => runtime.accept([detach], [], [authorization(session)])).not.toThrow();
      expect(() => process.kill(service.pid!, 0)).not.toThrow();
    } finally {
      await runtime.stop();
    }
  });
  test("HTTP uses JSON, POST SSE and GET SSE; detach deletes only the attachment and permits reopen", async () => {
    const server = await startHttpMcpServer();
    const runtime = new McpRuntime([
      registration({
        transport: "streamableHttp",
        url: server.url,
        launch: "owner_managed",
        autostart: false,
        exposure: "wire",
        roots: [],
        exposeSampling: false,
        elicitation: "absent",
        requestTimeoutMs: 1000,
      }),
    ]);
    try {
      await runtime.start();
      runtime.bind(workerSession);
      const fact = runtime.outgoing().mcp.find((item) => item.type === "process_fact");
      if (fact?.type !== "process_fact") throw new Error("missing HTTP process");
      expect(fact.process).toMatchObject({ state: "running", pid: null, endpoint: server.url });
      const session = sessionFor(fact.process);
      runtime.accept([attach(session)], [], [authorization(session)]);
      expect(() =>
        runtime.accept([attach(sessionFor(fact.process))], [], [authorization(session)]),
      ).toThrow("exact process unavailable");
      let seq = 0;
      const send = async (method: string, params?: unknown) => {
        const id = ++seq;
        runtime.accept(
          [clientFrame(session, seq, { jsonrpc: "2.0", id, method, params })],
          [],
          [authorization(session)],
        );
        const frame = await waitFor(() =>
          serverFrames(runtime).find((frame) => decoded(frame).id === id),
        );
        return decoded(frame);
      };
      expect(
        (
          await send("initialize", {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          })
        ).result.protocolVersion,
      ).toBe("2025-03-26");
      runtime.accept(
        [clientFrame(session, ++seq, { jsonrpc: "2.0", method: "notifications/initialized" })],
        [],
        [authorization(session)],
      );
      await waitFor(() =>
        serverFrames(runtime).find(
          (frame) => decoded(frame).method === "notifications/tools/list_changed",
        ),
      );
      expect((await send("tools/list")).result.tools[0].name).toBe("wire_echo");
      expect(
        (await send("tools/call", { name: "wire_echo", arguments: { text: "HTTP 回流" } })).result,
      ).toEqual({
        content: [{ type: "text", text: "HTTP 回流" }],
        structuredContent: { delivered: true },
      });
      const callbackRequestId = ++seq;
      runtime.accept(
        [
          clientFrame(session, seq, {
            jsonrpc: "2.0",
            id: callbackRequestId,
            method: "fixture/callback",
          }),
        ],
        [],
        [authorization(session)],
      );
      const callback = await waitFor(() =>
        serverFrames(runtime).find((frame) => decoded(frame).method === "sampling/createMessage"),
      );
      runtime.accept(
        [
          clientFrame(session, ++seq, {
            jsonrpc: "2.0",
            id: decoded(callback).id,
            result: {
              model: "fixture",
              role: "assistant",
              content: { type: "text", text: "callback" },
            },
          }),
        ],
        [],
        [authorization(session)],
      );
      const callbackResult = await waitFor(() =>
        serverFrames(runtime).find((frame) => decoded(frame).id === callbackRequestId),
      );
      expect(decoded(callbackResult).result.callback.model).toBe("fixture");
      const deletes = server.stats.deletes;
      runtime.accept(
        [{ type: "session_detach", ...mcpBound(session), reason: "client_closed" }],
        [],
        [authorization(session)],
      );
      await waitFor(() => server.stats.deletes > deletes);
      const second = sessionFor(fact.process);
      runtime.accept([attach(second)], [], [authorization(second)]);
      runtime.accept(
        [
          clientFrame(second, 1, {
            jsonrpc: "2.0",
            id: 99,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "reopen", version: "1" },
            },
          }),
        ],
        [],
        [authorization(second)],
      );
      await waitFor(() => serverFrames(runtime).find((frame) => decoded(frame).id === 99));
      await runtime.stop();
      expect((await fetch(server.url.replace("/mcp", "/stats"))).ok).toBe(true);
      expect(server.stats).toMatchObject({ calls: 1, lists: 1, gets: 1, deletes: 3 });
    } finally {
      await runtime.stop();
      await server.close();
    }
  });
  test.each(["fixture/timeout", "fixture/malformed", "fixture/overflow"])(
    "HTTP %s fails the exact target without inventing a running state",
    async (method) => {
      const server = await startHttpMcpServer();
      const runtime = new McpRuntime([
        registration({
          transport: "streamableHttp",
          url: server.url,
          launch: "owner_managed",
          autostart: false,
          exposure: "wire",
          roots: [],
          exposeSampling: false,
          elicitation: "absent",
          requestTimeoutMs: 100,
        }),
      ]);
      try {
        await runtime.start();
        runtime.bind(workerSession);
        const fact = runtime.outgoing().mcp.find((item) => item.type === "process_fact");
        if (fact?.type !== "process_fact") throw new Error("missing process");
        const session = sessionFor(fact.process);
        runtime.accept(
          [
            attach(session),
            clientFrame(session, 1, {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "test", version: "1" },
              },
            }),
          ],
          [],
          [authorization(session)],
        );
        await waitFor(() => serverFrames(runtime)[0]);
        runtime.accept(
          [clientFrame(session, 2, { jsonrpc: "2.0", id: 2, method })],
          [],
          [authorization(session)],
        );
        const failed = await waitFor(() =>
          runtime
            .outgoing()
            .mcp.find((item) => item.type === "process_fact" && item.process.state === "failed"),
        );
        expect(failed).toMatchObject({
          type: "process_fact",
          process: { endReason: "unreachable" },
        });
        expect(runtime.outgoing().mcp).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "session_fact", state: "failed" }),
          ]),
        );
      } finally {
        await runtime.stop();
        await server.close();
      }
    },
  );
  test("one unreachable HTTP registration and one spawn failure do not suppress a healthy service", async () => {
    const config = registration().configJson;
    if (config.transport !== "stdio") throw new Error("expected stdio fixture");
    const runtime = new McpRuntime([
      registration({
        transport: "streamableHttp",
        url: "http://127.0.0.1:1/mcp",
        launch: "owner_managed",
        autostart: false,
        exposure: "wire",
        roots: [],
        exposeSampling: false,
        elicitation: "absent",
        requestTimeoutMs: 100,
      }),
      registration({ ...config, command: "/nonexistent-sprout-mcp-command" }),
      registration(),
    ]);
    try {
      await runtime.start();
      const facts = runtime
        .outgoing()
        .mcp.filter((item) => item.type === "process_fact")
        .map((item) => item.process);
      expect(facts).toHaveLength(3);
      expect(facts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: "failed", endReason: "spawn_failed" }),
          expect.objectContaining({ state: "failed", endReason: "unreachable" }),
          expect.objectContaining({ state: "running", endReason: null }),
        ]),
      );
    } finally {
      await runtime.stop();
    }
  });
  test("HTTP heartbeat rechecks reachability before refreshing the running process fact", async () => {
    const server = await startHttpMcpServer();
    let now = Date.now();
    let serverClosed = false;
    const runtime = new McpRuntime(
      [
        registration({
          transport: "streamableHttp",
          url: server.url,
          launch: "owner_managed",
          autostart: false,
          exposure: "wire",
          roots: [],
          exposeSampling: false,
          elicitation: "absent",
          requestTimeoutMs: 100,
        }),
      ],
      () => now,
    );
    try {
      await runtime.start();
      await server.close();
      serverClosed = true;
      now += 10001;
      runtime.outgoing();
      const fact = await waitFor(() =>
        runtime
          .outgoing()
          .mcp.find((item) => item.type === "process_fact" && item.process.state === "failed"),
      );
      expect(fact).toMatchObject({ process: { endReason: "unreachable", lastObservedAt: now } });
    } finally {
      await runtime.stop();
      if (!serverClosed) await server.close();
    }
  });
  test("starts a real pid and relays bytes; session detach leaves process alive", async () => {
    const { runtime, session, process: fact } = await setup();
    try {
      expect(fact.pid).toBeGreaterThan(0);
      expect(fact.processStartedAt).toBeGreaterThan(0);
      const request = clientFrame(session, 1, {
        jsonrpc: "2.0",
        id: 1,
        method: "fixture/echo",
        params: { text: "原帧" },
      });
      runtime.accept([request, request], [], [authorization(session)]);
      const frames = await waitFor(() =>
        serverFrames(runtime).length ? serverFrames(runtime) : undefined,
      );
      expect(frames).toHaveLength(1);
      expect(decoded(frames[0]!)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { echo: { text: "原帧" } },
      });
      expect(runtime.outgoing().mcpCursors[0]?.clientAcceptedThrough).toBe(1);
      runtime.accept(
        [{ type: "session_detach", ...mcpBound(session), reason: "client_closed" }],
        [],
        [authorization(session)],
      );
      expect(() => process.kill(fact.pid!, 0)).not.toThrow();
      expect(runtime.outgoing().mcp).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "session_fact", state: "detached" }),
        ]),
      );
      const next = sessionFor(fact);
      runtime.accept(
        [attach(next), clientFrame(next, 1, { jsonrpc: "2.0", id: 2, method: "fixture/echo" })],
        [],
        [authorization(next)],
      );
      const nextFrame = await waitFor(() =>
        serverFrames(runtime).find((frame) => decoded(frame).id === 2),
      );
      expect(nextFrame.sessionId).toBe(next.id);
      expect(nextFrame.processId).toBe(fact.id);
    } finally {
      await runtime.stop();
    }
  });
  test.each(["sampling", "elicitation"] as const)(
    "relays server-to-client %s and client fixture response without method branching",
    async (kind) => {
      const { runtime, session } = await setup();
      try {
        runtime.accept(
          [clientFrame(session, 1, { jsonrpc: "2.0", id: 1, method: `fixture/${kind}` })],
          [],
          [authorization(session)],
        );
        const callback = await waitFor(() => serverFrames(runtime)[0]);
        expect(decoded(callback).method).toBe(
          kind === "sampling" ? "sampling/createMessage" : "elicitation/create",
        );
        const result =
          kind === "sampling"
            ? {
                role: "assistant",
                content: { type: "text", text: "fixture" },
                model: "fixture",
                stopReason: "endTurn",
              }
            : { action: "cancel" };
        runtime.accept(
          [clientFrame(session, 2, { jsonrpc: "2.0", id: decoded(callback).id, result })],
          [],
          [authorization(session)],
        );
        const response = await waitFor(() =>
          serverFrames(runtime).find((f) => decoded(f).id === 1),
        );
        expect(decoded(response).result.callback).toEqual(result);
      } finally {
        await runtime.stop();
      }
    },
  );
  test("session fence acknowledges exact targets without killing the service", async () => {
    const { runtime, session, process: fact } = await setup();
    try {
      const fence = {
        type: "session_fence" as const,
        projectId: session.projectId,
        machineId: session.machineId,
        authorizationGeneration: session.authorizationGeneration,
        holderInstanceId: session.holderInstanceId,
        workerSession,
        mutationId: newId(ID_PREFIXES.leaseMutation),
        sessions: [{ sessionId: session.id, processId: session.processId }],
      };
      runtime.accept([fence], [], [authorization(session)]);
      expect(runtime.outgoing().mcp).toEqual(
        expect.arrayContaining([{ ...fence, type: "session_fence_ack", detached: true }]),
      );
      expect(() => process.kill(fact.pid!, 0)).not.toThrow();
      expect(() =>
        runtime.accept(
          [clientFrame(session, 1, { jsonrpc: "2.0", id: 1, method: "fixture/echo" })],
          [],
          [authorization(session)],
        ),
      ).toThrow();
    } finally {
      await runtime.stop();
    }
  });
  test("cancel tombstones advance delivery without executing the cancelled frame", async () => {
    const { runtime, session } = await setup();
    try {
      const cancelled = clientFrame(session, 1, { jsonrpc: "2.0", id: 1, method: "fixture/exit" });
      runtime.accept(
        [
          {
            type: "cancel_frames",
            ...mcpBound(session),
            tombstones: [
              { clientSeq: 1, frameId: cancelled.frameId, payloadHash: cancelled.payloadHash },
            ],
          },
          clientFrame(session, 2, { jsonrpc: "2.0", id: 2, method: "fixture/echo" }),
        ],
        [],
        [authorization(session)],
      );
      const reply = await waitFor(() => serverFrames(runtime)[0]);
      expect(decoded(reply).id).toBe(2);
      expect(runtime.outgoing().mcpCursors[0]?.clientAcceptedThrough).toBe(2);
    } finally {
      await runtime.stop();
    }
  });
  test("budget keeps unacknowledged frames and advertises cursor for the next batch", async () => {
    const { runtime, session } = await setup();
    try {
      runtime.accept(
        [clientFrame(session, 1, { jsonrpc: "2.0", id: 1, method: "fixture/burst" })],
        [],
        [authorization(session)],
      );
      await waitFor(() => (serverFrames(runtime).length >= 3 ? true : undefined));
      await waitFor(() => {
        const batch = runtime.outgoing();
        return batch.mcp.some((f) => f.type === "frame" && f.seq === 3) ? batch : undefined;
      });
      const first = runtime.outgoing();
      expect(first.mcp.filter((f) => f.type === "frame")).toHaveLength(3);
      expect(first.mcpCursors[0]?.clientAcceptedThrough).toBe(1);
      expect(first.mcpCursors[0]?.serverAcceptedThrough).toBe(0);
      const envelope = {
        version: 3,
        requestId: newId(ID_PREFIXES.request),
        secret: "w".repeat(43),
        mode: "normal",
        session: workerSession,
        seq: 1,
        capability: {
          platform: "darwin",
          arch: "arm64",
          workerVersion: "test",
          shells: [],
          remoteOperations: [],
        },
        observations: [],
        remote: { results: [], fenceAcks: [], ...first },
      };
      expect(workerExchangeInput.safeParse(envelope).success).toBe(true);
      expect(
        runtime
          .outgoing()
          .mcp.filter((f) => f.type === "frame")
          .map((f) => f.seq),
      ).toEqual([1, 2, 3]);
      runtime.accept(
        [],
        [{ ...mcpBound(session), clientAcceptedThrough: 1, serverAcceptedThrough: 3 }],
        [authorization(session)],
      );
      const second = await waitFor(() => {
        const batch = runtime.outgoing();
        return batch.mcp.filter((f) => f.type === "frame").length === 3 ? batch : undefined;
      });
      expect(second.mcp.filter((f) => f.type === "frame").map((f) => f.seq)).toEqual([4, 5, 6]);
    } finally {
      await runtime.stop();
    }
  });
  test("rejects cross Project attach even when the other Project has an active lease", async () => {
    const runtime = new McpRuntime([registration()]);
    await runtime.start();
    runtime.bind(workerSession);
    try {
      const processFact = runtime.outgoing().mcp.find((item) => item.type === "process_fact");
      if (processFact?.type !== "process_fact") throw new Error("missing process");
      const cross = sessionFor(processFact.process, workerSession, {
        projectId: newId(ID_PREFIXES.project),
      });
      expect(() => runtime.accept([attach(cross)], [], [authorization(cross)])).toThrow(
        "exact process unavailable",
      );
    } finally {
      await runtime.stop();
    }
  });
  test("rejects old authorization_generation frames and preserves the server process", async () => {
    const { runtime, session, process: fact } = await setup();
    try {
      const frame = clientFrame(session, 1, { jsonrpc: "2.0", id: 1, method: "fixture/echo" });
      expect(() =>
        runtime.accept([frame], [], [{ ...authorization(session), generation: 2 }]),
      ).toThrow();
      expect(serverFrames(runtime)).toHaveLength(0);
      expect(() => process.kill(fact.pid!, 0)).not.toThrow();
    } finally {
      await runtime.stop();
    }
  });
  test("lost target fails dependent session and never redirects to another running process", async () => {
    const runtime = new McpRuntime([registration(), { ...registration(), name: "other" }]);
    await runtime.start();
    runtime.bind(workerSession);
    try {
      const facts = runtime.outgoing().mcp.filter((f) => f.type === "process_fact");
      const session = sessionFor(facts[0]!.process);
      runtime.accept([attach(session)], [], [authorization(session)]);
      runtime.accept(
        [clientFrame(session, 1, { jsonrpc: "2.0", id: 1, method: "fixture/exit" })],
        [],
        [authorization(session)],
      );
      await waitFor(() =>
        runtime.outgoing().mcp.find((f) => f.type === "session_fact" && f.state === "failed"),
      );
      expect(() =>
        runtime.accept(
          [clientFrame(session, 2, { jsonrpc: "2.0", id: 2, method: "fixture/echo" })],
          [],
          [authorization(session)],
        ),
      ).toThrow();
      expect(() => process.kill(facts[1]!.process.pid!, 0)).not.toThrow();
      expect(serverFrames(runtime)).toHaveLength(0);
    } finally {
      await runtime.stop();
    }
  });
  test("RemoteDispatcher uses the authenticated frame, MCP fields and disconnect lifetime", async () => {
    const runtime = new McpRuntime([registration()]);
    await runtime.start();
    const capability = {
      platform: "darwin" as const,
      arch: "arm64" as const,
      workerVersion: "test",
      shells: [],
      remoteOperations: [],
    };
    const dispatcher = new RemoteDispatcher(workerSession, capability, Date.now, runtime);
    try {
      const fact = dispatcher.outgoing().mcp.find((f) => f.type === "process_fact");
      if (fact?.type !== "process_fact") throw new Error("missing process");
      const session = sessionFor(fact.process);
      const remote = {
        authorizations: [authorization(session)],
        commands: [],
        fences: [],
        resultAcks: [],
        fenceAcks: [],
        mcp: [attach(session)],
        mcpCursors: [],
      };
      expect(workerExchangeOutputRemoteSchema.safeParse(remote).success).toBe(true);
      dispatcher.accept(
        { session: workerSession, mode: "normal", seq: 1, configuration: null, remote },
        1,
        [],
      );
      expect(dispatcher.outgoing().mcp).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "session_fact", state: "attached" }),
        ]),
      );
      dispatcher.disconnect();
      expect(() => process.kill(fact.process.pid!, 0)).not.toThrow();
      expect(dispatcher.outgoing().mcp.some((f) => f.type === "process_fact")).toBe(false);
    } finally {
      await runtime.stop();
    }
  });
});
