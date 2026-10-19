import { Cause, Context, Effect, Exit, Fiber, Layer, Scope } from "effect";

export const POLL_INTERVAL = "100 millis";
export const STOP_DEADLINE = "2500 millis";

export type PiHostWorkItem = { readonly instanceId: string };
export type PiHostRun = {
  readonly runId: string;
  readonly pid: number | undefined;
  readonly abort: () => void;
  readonly close: () => Promise<void>;
  readonly body: Effect.Effect<void>;
};
export type PiHostSignals = { readonly isStopping: () => boolean };
export type PiHostFailureReport = {
  readonly event: string;
  readonly message: string;
  readonly cause: Cause.Cause<unknown>;
};
export type PiHostDeps<W extends PiHostWorkItem> = {
  readonly loadWork: () => readonly W[];
  readonly prepareRun: (work: W, signals: PiHostSignals) => PiHostRun;
  readonly interruptActiveRuns: () => void;
  readonly reportFailure: (failure: PiHostFailureReport) => void;
};
export type PiHostSnapshot = {
  readonly stopping: boolean;
  readonly active: ReadonlyArray<{
    readonly instanceId: string;
    readonly pid: number | undefined;
  }>;
};
export type PiHostShape = {
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void, Error>;
  readonly abort: (runId: string) => boolean;
  readonly snapshot: () => PiHostSnapshot;
};

export class PiHost extends Context.Service<PiHost, PiHostShape>()("sprout/PiHost") {}

type ActiveRun = { readonly run: PiHostRun; readonly fiber: Fiber.Fiber<void> };
type HostPhase =
  | { readonly _tag: "Dormant" }
  | { readonly _tag: "Running"; readonly poll: Fiber.Fiber<void> }
  | { readonly _tag: "Stopping" };

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export const makePiHostLayer = <W extends PiHostWorkItem>(
  deps: PiHostDeps<W>,
): Layer.Layer<PiHost> =>
  Layer.effect(
    PiHost,
    Effect.gen(function* () {
      const ownerScope = yield* Scope.Scope;
      const registry = new Map<string, ActiveRun>();
      let phase: HostPhase = { _tag: "Dormant" };
      const signals: PiHostSignals = { isStopping: () => phase._tag === "Stopping" };

      const dispatch = Effect.gen(function* () {
        if (signals.isStopping()) return;
        for (const work of deps.loadWork()) {
          if (registry.has(work.instanceId)) continue;
          const run = deps.prepareRun(work, signals);
          const fiber = yield* run.body.pipe(
            Effect.ensuring(Effect.sync(() => registry.delete(work.instanceId))),
            Effect.forkIn(ownerScope),
          );
          registry.set(work.instanceId, { run, fiber });
        }
      }).pipe(
        // prepareRun starts a child. Interruption before registration would leave it unowned and skip close at stop.
        Effect.uninterruptible,
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            deps.reportFailure({
              event: "pi_host.dispatch_failed",
              message: "Pi host 调度失败",
              cause,
            }),
          ),
        ),
      );

      const poll = Effect.gen(function* () {
        while (!signals.isStopping()) {
          yield* Effect.sleep(POLL_INTERVAL);
          yield* dispatch;
        }
      });

      const start = Effect.suspend(() => {
        if (phase._tag !== "Dormant") return Effect.void;
        return poll.pipe(
          Effect.forkIn(ownerScope),
          Effect.map((fiber) => {
            phase = { _tag: "Running", poll: fiber };
          }),
        );
      }).pipe(Effect.uninterruptible);

      const stop = yield* Effect.cached(
        Effect.gen(function* () {
          const pollFiber = phase._tag === "Running" ? phase.poll : undefined;
          phase = { _tag: "Stopping" };
          if (pollFiber) yield* Fiber.interrupt(pollFiber);
          const recovery = yield* Effect.exit(
            Effect.try({ try: () => deps.interruptActiveRuns(), catch: toError }),
          );
          const [, failed] = yield* Effect.partition(
            [...registry.values()],
            ({ run, fiber }) =>
              Effect.gen(function* () {
                yield* Effect.tryPromise({ try: () => run.close(), catch: toError });
                yield* Fiber.join(fiber);
              }),
            { concurrency: "unbounded" },
          );
          if (failed.length > 0) return yield* Effect.fail(failed[0]);
          if (Exit.isFailure(recovery)) return yield* Effect.failCause(recovery.cause);
        }).pipe(
          Effect.timeoutOrElse({
            duration: STOP_DEADLINE,
            orElse: () => Effect.fail(new Error("Pi 关闭超时 (2500ms)")),
          }),
        ),
      );

      return {
        start,
        stop,
        snapshot: () => ({
          stopping: signals.isStopping(),
          active: [...registry].map(([instanceId, { run }]) => ({ instanceId, pid: run.pid })),
        }),
        abort: (runId) => {
          for (const { run } of registry.values()) {
            if (run.runId !== runId) continue;
            run.abort();
            return true;
          }
          return false;
        },
      };
    }),
  );

export const startPiHost: Effect.Effect<void, never, PiHost> = Effect.gen(function* () {
  const host = yield* PiHost;
  yield* host.start;
});

export const stopPiHost: Effect.Effect<void, Error, PiHost> = Effect.gen(function* () {
  const host = yield* PiHost;
  yield* host.stop;
});
