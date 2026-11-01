// Probe 9: interruption hazard in dispatch. prepareRun spawns a real child
// synchronously; if the poll fiber is interrupted between prepare and the
// active.set, nothing owns the child. Does Effect.uninterruptible close the hole?
import { Context, Effect, Fiber, Layer, ManagedRuntime, Scope } from "effect";
import { TestClock } from "effect/testing";

class Host extends Context.Service()("probe/Host") {}

const make = (uninterruptibleDispatch) => {
  const trace = { prepares: 0, closes: 0, active: 0 };
  const layer = Layer.effect(
    Host,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const state = { stopping: false, poll: undefined, active: new Set() };
      const dispatch = Effect.gen(function* () {
        if (state.stopping) return;
        trace.prepares += 1;
        // suspension point between the spawn-equivalent and the registry write
        yield* Effect.sleep("500 millis");
        state.active.add("inst_1");
        trace.active = state.active.size;
      });
      const body = uninterruptibleDispatch ? dispatch.pipe(Effect.uninterruptible) : dispatch;
      const poll = Effect.gen(function* () {
        while (!state.stopping) {
          yield* Effect.sleep("100 millis");
          yield* body;
        }
      });
      const start = poll.pipe(
        Effect.forkIn(scope),
        Effect.map((fiber) => {
          state.poll = fiber;
        }),
      );
      const stop = Effect.gen(function* () {
        state.stopping = true;
        if (state.poll) yield* Fiber.interrupt(state.poll);
        trace.closes += state.active.size;
      });
      return { start, stop, trace };
    }),
  );
  return { layer, trace };
};

async function run(label, uninterruptibleDispatch) {
  const { layer, trace } = make(uninterruptibleDispatch);
  const runtime = ManagedRuntime.make(layer);
  const program = Effect.gen(function* () {
    const host = yield* Host;
    yield* host.start;
    yield* TestClock.adjust("100 millis"); // dispatch begins, then suspends
    yield* TestClock.adjust("50 millis");
    const stopping = yield* Effect.forkChild(host.stop.pipe(Effect.exit));
    yield* TestClock.adjust("600 millis"); // let any uninterruptible dispatch finish
    const stopExit = yield* Fiber.await(stopping);
    return { ...trace, stopFailed: stopExit._tag === "Failure" };
  });
  const result = await runtime.runPromise(Effect.provide(program, TestClock.layer()));
  await runtime.dispose();
  console.log(
    label +
      ": prepares=" +
      result.prepares +
      " trackedActive=" +
      result.active +
      " closesAtStop=" +
      result.closes +
      " stopFailed=" +
      result.stopFailed,
  );
}

await run("interruptible dispatch    ", false);
await run("uninterruptible dispatch  ", true);
