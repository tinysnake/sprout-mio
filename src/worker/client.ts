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
import type { RemoteExchangeInput } from "../contracts/remote";
import type { Identity } from "./identity";
import { probeCapability, probeDirectory } from "./probes";

/** 执行器与报告提交属于 worker/tools 单元；本客户端只发送空入站批次。 */
const EMPTY_REMOTE: RemoteExchangeInput = { results: [], fenceAcks: [] };

export class ClientError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ClientError";
  }
}
function post<S extends z.ZodType>(identity: Identity, path: string, payload: object, schema: S) {
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
        throw new ClientError(response.status >= 500 ? "network" : "invalid_response");
      }
      return result;
    },
    catch: (error) => (error instanceof ClientError ? error : new ClientError("network")),
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
) {
  return post(identity, path, payload, schema).pipe(
    Effect.flatMap((result) => {
      const response = result as { ok: boolean; error?: { code: string } };
      return response.ok
        ? Effect.succeed(result)
        : Effect.fail(new ClientError(response.error?.code ?? "invalid_response"));
    }),
    Effect.retry({
      schedule: backoff,
      while: (error) =>
        error.code === "network" || error.code === "internal" || error.code === "stopping",
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
export function workerProgram(identity: Identity) {
  return Effect.scoped(
    Effect.gen(function* () {
      let session: WorkerSession | undefined;
      yield* Effect.addFinalizer(() =>
        session
          ? post(identity, "close", { session }, workerCloseResponseSchema).pipe(
              Effect.timeout("2 seconds"),
              Effect.ignore,
            )
          : Effect.void,
      );
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
        let configuration:
          | Extract<WorkerExchangeResponse, { ok: true }>["data"]["configuration"]
          | undefined;
        let seq = 1;
        while (true) {
          const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          const observations = yield* Effect.tryPromise({
            try: () => {
              if (!configuration || configuration.root === null) return Promise.resolve([]);
              const { root, rootRevision, bindings } = configuration;
              return Promise.all(
                bindings.map((binding) =>
                  probeDirectory(root, binding.projectId, rootRevision, session!, seq, checkedAt),
                ),
              );
            },
            catch: () => new ClientError("probe_failed"),
          });
          const exchanged = yield* request(
            identity,
            "exchange",
            {
              mode: "normal",
              session,
              seq,
              capability,
              observations,
              remote: EMPTY_REMOTE,
            },
            workerExchangeResponseSchema,
          ).pipe(Effect.result);
          if (exchanged._tag === "Failure") {
            if (exchanged.failure.code === "stale") {
              // 旧连接不得重新获得 normal 执行权：先用原 session 走一次 drain，再重新 open。
              // 本单元的 Worker 尚未接收任何 delivery，drain 的入站批次为空。
              configuration = undefined;
              yield* request(
                identity,
                "exchange",
                { mode: "drain", session, seq, remote: EMPTY_REMOTE },
                workerExchangeResponseSchema,
              ).pipe(Effect.timeout("2 seconds"), Effect.ignore);
              session = undefined;
              break;
            }
            if (exchanged.failure.code === "conflict") configuration = undefined;
            else return yield* Effect.fail(exchanged.failure);
          } else {
            if (!exchanged.success.ok)
              return yield* Effect.fail(new ClientError("invalid_response"));
            if (exchanged.success.data.mode !== "normal") {
              configuration = undefined;
              session = undefined;
              break;
            }
            configuration = exchanged.success.data.configuration;
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
export async function runWorker(identity: Identity) {
  const fiber = Effect.runFork(workerProgram(identity));
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
