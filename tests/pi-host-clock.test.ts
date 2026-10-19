import { Cause, Clock, Deferred, Effect, Exit, Fiber, ManagedRuntime, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { expect, it } from "vite-plus/test";
import { makePiHostLayer, PiHost, startPiHost, stopPiHost } from "../src/server/pi-host/host";

it("100ms 轮询与 2500ms 停止截止都在 TestClock 上", async () => {
  const startedAt = performance.now();
  const trace = { dispatches: 0, starts: 0, interrupts: 0, closes: 0, aborts: 0 };
  const runtime = ManagedRuntime.make(
    makePiHostLayer({
      loadWork: () => {
        trace.dispatches += 1;
        return [{ instanceId: "inst_clock_test" }];
      },
      prepareRun: () => {
        trace.starts += 1;
        return {
          runId: "run_clock_test",
          pid: 4242,
          abort: () => {
            trace.aborts += 1;
          },
          close: () => {
            trace.closes += 1;
            return new Promise<void>(() => {});
          },
          body: Effect.never,
        };
      },
      interruptActiveRuns: () => {
        trace.interrupts += 1;
      },
      reportFailure: () => {},
    }),
  );

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const host = yield* PiHost;
        expect(host.abort("missing")).toBe(false);
        expect(host.abort("run_clock_test")).toBe(false);
        yield* startPiHost;
        yield* startPiHost;

        yield* TestClock.adjust(99);
        expect(trace.dispatches).toBe(0);
        yield* TestClock.adjust(1);
        expect(yield* Clock.currentTimeMillis).toBe(100);
        expect(trace.dispatches).toBe(1);
        expect(host.snapshot()).toEqual({
          stopping: false,
          active: [{ instanceId: "inst_clock_test", pid: 4242 }],
        });
        expect(host.abort("missing")).toBe(false);
        expect(host.abort("run_clock_test")).toBe(true);
        expect(trace.aborts).toBe(1);
        yield* TestClock.adjust(300);
        expect(yield* Clock.currentTimeMillis).toBe(400);
        expect(trace.dispatches).toBe(4);
        expect(trace.starts).toBe(1);

        const stopStartedAt = yield* Clock.currentTimeMillis;
        const outcome = yield* Ref.make(Option.none<Exit.Exit<void, Error>>());
        const stopping = yield* Effect.forkChild(
          stopPiHost.pipe(
            Effect.exit,
            Effect.flatMap((exit) => Ref.set(outcome, Option.some(exit))),
          ),
        );
        yield* TestClock.adjust(2499);
        expect(Option.isNone(yield* Ref.get(outcome))).toBe(true);
        expect(trace.closes).toBe(1);
        yield* TestClock.adjust(1);
        yield* Fiber.await(stopping);
        expect((yield* Clock.currentTimeMillis) - stopStartedAt).toBe(2500);
        const settled = Option.getOrThrow(yield* Ref.get(outcome));
        expect(Exit.isFailure(settled)).toBe(true);
        if (!Exit.isFailure(settled)) throw new Error("stop unexpectedly succeeded");
        const failure = Option.getOrThrow(Cause.findErrorOption(settled.cause));
        expect(failure.message).toBe("Pi 关闭超时 (2500ms)");

        const second = yield* Effect.exit(stopPiHost);
        expect(Exit.isFailure(second)).toBe(true);
        if (!Exit.isFailure(second)) throw new Error("cached stop unexpectedly succeeded");
        expect(Option.getOrThrow(Cause.findErrorOption(second.cause))).toBe(failure);
        expect((yield* Clock.currentTimeMillis) - stopStartedAt).toBe(2500);
        expect(trace.interrupts).toBe(1);
        expect(trace.closes).toBe(1);
        yield* startPiHost;
        yield* TestClock.adjust(100);
        expect(trace.dispatches).toBe(4);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    await runtime.dispose();
  }
  const wallMs = performance.now() - startedAt;
  // The exact timing invariant is carried by the Clock.currentTimeMillis asserts above.
  // This only separates the virtual-clock regime from the real-timer one, which costs 2500ms,
  // so the threshold stays loose enough that CI scheduling jitter cannot fake a regression.
  expect(wallMs).toBeLessThan(1000);
  console.log(
    `pi-host clock test body including setup and dispose, excluding module import: ${wallMs.toFixed(2)}ms; the real-timer alternative is measured by experiments/effect-clock-spike/verify.sh at about 2500ms`,
  );
});

it("停止并发排空全部 run，排空失败优先于恢复失败", async () => {
  const recoveryFailure = new Error("recovery failed");
  const closeFailure = new Error("close failed");
  const closed: string[] = [];
  const signalsAtClose: boolean[] = [];
  let finishClose: (() => void) | undefined;
  const completed = Effect.runSync(Deferred.make<void>());
  const runtime = ManagedRuntime.make(
    makePiHostLayer({
      loadWork: () => [{ instanceId: "first" }, { instanceId: "second" }],
      prepareRun: (work, signals) => ({
        runId: work.instanceId,
        pid: undefined,
        abort: () => {},
        close: async () => {
          signalsAtClose.push(signals.isStopping());
          if (work.instanceId === "first") throw closeFailure;
          await new Promise<void>((resolve) => {
            finishClose = resolve;
          });
          closed.push(work.instanceId);
          Effect.runSync(Deferred.succeed(completed, undefined));
        },
        body: Deferred.await(completed),
      }),
      interruptActiveRuns: () => {
        throw recoveryFailure;
      },
      reportFailure: () => {},
    }),
  );

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* startPiHost;
        yield* TestClock.adjust(100);
        const outcome = yield* Ref.make(Option.none<Exit.Exit<void, Error>>());
        const stopping = yield* Effect.forkChild(
          stopPiHost.pipe(
            Effect.exit,
            Effect.tap((exit) => Ref.set(outcome, Option.some(exit))),
          ),
        );
        yield* TestClock.adjust(0);
        expect(signalsAtClose).toEqual([true, true]);
        expect(Option.isNone(yield* Ref.get(outcome))).toBe(true);
        if (!finishClose) throw new Error("second close was not requested");
        finishClose();
        const result = yield* Fiber.join(stopping);
        expect(closed).toEqual(["second"]);
        expect(Exit.isFailure(result)).toBe(true);
        if (!Exit.isFailure(result)) throw new Error("stop unexpectedly succeeded");
        expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toBe(closeFailure);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    await runtime.dispose();
  }
});

it("run 完成后释放实例，停止成功可重复调用", async () => {
  let starts = 0;
  let interrupts = 0;
  let finishRun = () => {};
  const runtime = ManagedRuntime.make(
    makePiHostLayer({
      loadWork: () => [{ instanceId: "inst_complete" }],
      prepareRun: () => {
        starts += 1;
        const completed = Effect.runSync(Deferred.make<void>());
        finishRun = () => {
          Effect.runSync(Deferred.succeed(completed, undefined));
        };
        return {
          runId: `run_${starts}`,
          pid: 4242,
          abort: () => {},
          close: async () => finishRun(),
          body: Deferred.await(completed),
        };
      },
      interruptActiveRuns: () => {
        interrupts += 1;
      },
      reportFailure: () => {},
    }),
  );

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const host = yield* PiHost;
        expect(host.snapshot()).toEqual({ stopping: false, active: [] });
        yield* startPiHost;
        yield* TestClock.adjust(100);
        expect(starts).toBe(1);
        expect(host.snapshot()).toEqual({
          stopping: false,
          active: [{ instanceId: "inst_complete", pid: 4242 }],
        });
        finishRun();
        yield* TestClock.adjust(0);
        expect(host.abort("run_1")).toBe(false);
        expect(host.snapshot().active).toEqual([]);
        yield* TestClock.adjust(100);
        expect(starts).toBe(2);
        yield* stopPiHost;
        expect(host.snapshot()).toEqual({ stopping: true, active: [] });
        yield* stopPiHost;
        yield* startPiHost;
        yield* TestClock.adjust(100);
        expect(starts).toBe(2);
        expect(interrupts).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    await runtime.dispose();
  }
});
