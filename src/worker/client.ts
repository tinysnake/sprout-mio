import { Clock, Duration, Effect, Fiber, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  workerCloseResponseSchema,
  workerEnrollResponseSchema,
  workerExchangeResponseSchema,
  workerOpenResponseSchema,
  WORKER_PROTOCOL_VERSION,
} from "../contracts/worker";
import type { WorkerExchangeResponse } from "../contracts/worker";
import type { WorkerSession } from "../contracts/worker-session";
import { McpRuntime } from "./mcp";
import type { McpServerRegistration } from "../contracts/mcp";
import type { Identity } from "./identity";
import { emptyWorkerRemote, RemoteDispatcher } from "./remote";
import { ExecutionRegistry, ExecutionStore } from "./executions";
import { probeCapability, probeDirectory } from "./probes";

export class ClientError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
    this.name = "ClientError";
  }
}
function post<S extends z.ZodType>(
  identity: Identity,
  path: string,
  payload: object,
  schema: S,
  onDisconnect?: () => void,
) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${identity.server}/api/worker/${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: WORKER_PROTOCOL_VERSION,
          requestId: newId(ID_PREFIXES.request),
          secret: identity.secret,
          ...payload,
        }),
      });
      let result: z.output<S>;
      try {
        result = schema.parse(await response.json());
      } catch {
        throw new ClientError(
          response.status >= 500 ? "network" : "invalid_response",
          response.status,
        );
      }
      return result;
    },
    catch: (error) => {
      onDisconnect?.();
      return error instanceof ClientError ? error : new ClientError("network");
    },
  });
}
const backoff = Schedule.exponential("500 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.sync(() => {
      const waitMs = Math.min(Duration.toMillis(duration), 10000);
      console.log(JSON.stringify({ event: "worker.retry", waitMs }));
      return waitMs;
    }),
  ),
);
function request<S extends z.ZodType>(
  identity: Identity,
  path: string,
  payload: object,
  schema: S,
  onDisconnect?: () => void,
) {
  return post(identity, path, payload, schema, onDisconnect).pipe(
    Effect.flatMap((result) => {
      const response = result as { ok: boolean; error?: { code: string } };
      return response.ok
        ? Effect.succeed(result)
        : Effect.fail(new ClientError(response.error?.code ?? "invalid_response"));
    }),
    Effect.retry({
      schedule: backoff,
      while: (error) =>
        error.code === "network" ||
        error.code === "internal" ||
        error.code === "stopping" ||
        (path === "exchange" &&
          error.code === "invalid_response" &&
          (error.status === undefined || error.status < 400)),
    }),
  );
}
export function enroll(identity: Identity, ticket: string) {
  return request(
    identity,
    "enroll",
    { machineId: identity.machineId, ticket },
    workerEnrollResponseSchema,
  );
}
export function workerProgram(
  identity: Identity,
  mcpRegistrations: McpServerRegistration[] = [],
  stateDirectory?: string,
  now: () => number = () => Effect.runSync(Clock.currentTimeMillis),
) {
  // 执行与日志的 durable outbox 在 state-dir 下：进程重启后靠它报恢复事实。
  // 时钟走 Effect 的 Clock，不就地读墙钟，见 docs/architecture-direction.md。
  const registry = new ExecutionRegistry(new ExecutionStore(stateDirectory), now);
  return Effect.scoped(
    Effect.gen(function* () {
      let session: WorkerSession | undefined;
      let dispatcher: RemoteDispatcher | undefined;
      const mcp = new McpRuntime(mcpRegistrations);
      yield* Effect.addFinalizer(() => Effect.promise(() => mcp.stop()));
      yield* Effect.tryPromise({
        try: () => mcp.start(),
        catch: () => new ClientError("mcp_start_failed"),
      });
      yield* Effect.addFinalizer(() => {
        dispatcher?.disconnect();
        return session
          ? post(identity, "close", { session }, workerCloseResponseSchema).pipe(
              Effect.timeout("2 seconds"),
              Effect.ignore,
            )
          : Effect.void;
      });
      while (true) {
        const attemptId = randomUUID();
        const opened = yield* request(
          identity,
          "open",
          { machineId: identity.machineId, attemptId },
          workerOpenResponseSchema,
        ).pipe(Effect.result);
        if (opened._tag === "Failure") {
          if (opened.failure.code === "stale") continue;
          return yield* Effect.fail(opened.failure);
        }
        if (!opened.success.ok) return yield* Effect.fail(new ClientError("invalid_response"));
        session = opened.success.data.session;
        console.log(
          JSON.stringify({
            event: "worker.open",
            machineId: session.machineId,
            generation: session.generation,
            bootId: session.bootId,
          }),
        );
        const capabilityCheckedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        const capability = yield* Effect.tryPromise({
          try: () => probeCapability(capabilityCheckedAt),
          catch: () => new ClientError("probe_failed"),
        });
        dispatcher = new RemoteDispatcher(
          session,
          capability,
          () => Effect.runSync(Clock.currentTimeMillis),
          mcp,
          registry,
        );
        let configuration:
          | Extract<WorkerExchangeResponse, { ok: true }>["data"]["configuration"]
          | undefined;
        let seq = 1;
        let draining = false;
        let drainAdvanced = false;
        while (true) {
          const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          const observations = yield* Effect.tryPromise({
            try: () => {
              if (draining || !configuration || configuration.root === null)
                return Promise.resolve([]);
              const { root, rootRevision, bindings } = configuration;
              return Promise.all(
                bindings.map((binding) =>
                  probeDirectory(
                    root,
                    binding.projectId,
                    rootRevision,
                    binding.revision,
                    session!,
                    seq,
                    checkedAt,
                  ),
                ),
              );
            },
            catch: () => new ClientError("probe_failed"),
          });
          const exchange = draining
            ? { mode: "drain" as const, session, seq }
            : { mode: "normal" as const, session, seq, capability, observations };
          const emptyRemote = emptyWorkerRemote();
          const envelopeBytes = Buffer.byteLength(
            JSON.stringify({
              version: WORKER_PROTOCOL_VERSION,
              requestId: newId(ID_PREFIXES.request),
              secret: identity.secret,
              ...exchange,
              remote: emptyRemote,
            }),
          );
          const remote = dispatcher.outgoing(
            1048576 - envelopeBytes + Buffer.byteLength(JSON.stringify(emptyRemote)),
          );
          const exchanged = yield* request(
            identity,
            "exchange",
            { ...exchange, remote },
            workerExchangeResponseSchema,
            () => dispatcher?.disconnect(),
          ).pipe(Effect.result);
          if (exchanged._tag === "Failure") {
            if (
              ["validation_failed", "invalid_response", "remote_limit", "remote_conflict"].includes(
                exchanged.failure.code,
              )
            ) {
              // Rejection is not an execution failure of the Worker. Close admission,
              // keep delivery identities, and drain explicit degraded results at this seq.
              dispatcher.rejectReports(remote);
              dispatcher.disconnect();
              configuration = undefined;
              draining = true;
              yield* Effect.sleep(opened.success.data.pollIntervalMs);
              continue;
            }
            // A lost normal response may already occupy this seq. Drain skips that
            // committed frame once; it never retries a command under a new identity.
            if (draining && exchanged.failure.code === "conflict" && !drainAdvanced) {
              drainAdvanced = true;
              seq += 1;
              continue;
            }
            if (
              !draining &&
              (exchanged.failure.code === "stale" ||
                exchanged.failure.code === "superseded" ||
                exchanged.failure.code === "conflict")
            ) {
              dispatcher.disconnect();
              configuration = undefined;
              draining = true;
              continue; // A changed root/configuration also requires a fresh normal session.
            }
            dispatcher.disconnect();
            return yield* Effect.fail(exchanged.failure);
          } else {
            if (!exchanged.success.ok)
              return yield* Effect.fail(new ClientError("invalid_response"));
            const data = exchanged.success.data;
            yield* Effect.try({
              try: () => dispatcher!.accept(data, seq, observations),
              catch: () => new ClientError("invalid_response"),
            });
            configuration = exchanged.success.data.configuration;
            if (draining && dispatcher.drained) {
              session = undefined;
              break;
            }
            if (dispatcher.admissionClosed) draining = true;
            console.log(
              JSON.stringify({
                event: "worker.exchange",
                machineId: session.machineId,
                generation: session.generation,
                seq,
                observations: observations.length,
              }),
            );
          }
          if (seq >= Number.MAX_SAFE_INTEGER)
            return yield* Effect.fail(new ClientError("sequence_exhausted"));
          seq += 1;
          yield* Effect.sleep(opened.success.data.pollIntervalMs);
        }
      }
    }),
  );
}
export async function runWorker(
  identity: Identity,
  mcpRegistrations: McpServerRegistration[] = [],
  stateDirectory?: string,
) {
  const fiber = Effect.runFork(workerProgram(identity, mcpRegistrations, stateDirectory));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void Effect.runPromise(Fiber.interrupt(fiber));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await Effect.runPromise(Fiber.join(fiber));
  } catch {
    if (!stopping) throw new Error("Worker stopped after protocol or authentication failure");
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
