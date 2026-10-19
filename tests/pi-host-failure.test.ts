import { Clock, Effect, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { expect, it } from "vite-plus/test";
import { makePiHostLayer, PiHost, startPiHost } from "../src/server/pi-host/host";

// 调度失败原本只落一行 console.error，既不进 diagnostic_event 也不进 health。
// 常驻服务自己的失败必须可查，否则运维只能看见它活着还是死了。
it("调度失败经由 reportFailure 上报，且轮询不被失败终止", async () => {
  const failures: string[] = [];
  let dispatches = 0;
  let broken = true;
  const runtime = ManagedRuntime.make(
    makePiHostLayer({
      loadWork: () => {
        dispatches += 1;
        if (broken) throw new Error("工作队列不可读");
        return [];
      },
      prepareRun: () => {
        throw new Error("不应到达");
      },
      interruptActiveRuns: () => {},
      reportFailure: (failure) => {
        failures.push(`${failure.event}:${failure.message}`);
      },
    }),
  );

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* startPiHost;
        yield* TestClock.adjust(100);
        expect(failures).toEqual(["pi_host.dispatch_failed:Pi host 调度失败"]);
        expect(dispatches).toBe(1);

        // 失败不结束轮询：修好之后下一轮仍然调度。
        broken = false;
        yield* TestClock.adjust(100);
        yield* Clock.currentTimeMillis;
        expect(dispatches).toBe(2);
        expect(failures).toHaveLength(1);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    await runtime.dispose();
  }
});

it("prepareRun 抛出时同样上报，不留无人认领的子进程", async () => {
  const failures: string[] = [];
  const runtime = ManagedRuntime.make(
    makePiHostLayer({
      loadWork: () => [{ instanceId: "inst_prepare_fails" }],
      prepareRun: () => {
        throw new Error("子进程启动失败");
      },
      interruptActiveRuns: () => {},
      reportFailure: (failure) => {
        failures.push(failure.event);
      },
    }),
  );

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const host = yield* PiHost;
        yield* startPiHost;
        yield* TestClock.adjust(100);
        expect(failures).toEqual(["pi_host.dispatch_failed"]);
        expect(host.snapshot()).toEqual({ stopping: false, active: [] });
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    await runtime.dispose();
  }
});
