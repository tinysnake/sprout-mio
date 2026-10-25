import { describe, expect, test } from "vite-plus/test";
import { newId, ID_PREFIXES } from "../src/contracts/ids";
import { mcpBound } from "../src/domain/mcp/protocol";
import { workerExchangeInput, workerExchangeOutputRemoteSchema } from "../src/contracts/worker";
import { McpRuntime } from "../src/worker/mcp";
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
