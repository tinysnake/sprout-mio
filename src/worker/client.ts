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
import type { Identity } from "./identity";
import { RemoteDispatcher } from "./remote";
import { probeCapability, probeDirectory } from "./probes";

export class ClientError extends Error {
  constructor(readonly code: string) {
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
        throw new ClientError(response.status >= 500 ? "network" : "invalid_response");
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
      let dispatcher: RemoteDispatcher | undefined;
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
        dispatcher = new RemoteDispatcher(session, capability, () =>
          Effect.runSync(Clock.currentTimeMillis),
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
                  probeDirectory(root, binding.projectId, rootRevision, session!, seq, checkedAt),
                ),
              );
            },
            catch: () => new ClientError("probe_failed"),
          });
          const exchanged = yield* request(
            identity,
            "exchange",
            draining
              ? { mode: "drain", session, seq, remote: dispatcher.outgoing() }
              : {
                  mode: "normal",
                  session,
                  seq,
                  capability,
                  observations,
                  remote: dispatcher.outgoing(),
                },
            workerExchangeResponseSchema,
            () => dispatcher?.disconnect(),
          ).pipe(Effect.result);
          if (exchanged._tag === "Failure") {
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
