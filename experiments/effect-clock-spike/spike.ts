/**
 * Throwaway instrument. Question it exists to answer:
 * which real-clock costs in this repo can Effect's TestClock actually compress,
 * and what does it buy over the injected-clock pattern already in the repo?
 *
 * Run: npx tsx experiments/effect-clock-spike/spike.ts
 */
import { spawn } from "node:child_process";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

const wall = () => performance.now();
const ms = (n: number) => `${Math.round(n)}ms`;

// ---------------------------------------------------------------------------
// A. Baseline: the shape pi-host/index.ts actually has today.
//    dispatch poll (setInterval 100ms) + shutdown deadline (setTimeout 2500ms).
//    A test that exercises "shutdown times out with work still active" pays
//    the deadline in real time.
// ---------------------------------------------------------------------------
async function baselineShutdownTimeout(): Promise<number> {
  const start = wall();
  await new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Pi 关闭超时 (2500ms)")), 2500);
    void timer;
  }).catch(() => {});
  return wall() - start;
}

// ---------------------------------------------------------------------------
// B. Same shape as an Effect program, run under TestClock.
// ---------------------------------------------------------------------------
const effectShutdownTimeout = Effect.gen(function* () {
  const fiber = yield* Effect.gen(function* () {
    yield* Effect.sleep("10 seconds");
    return "settled";
  }).pipe(Effect.timeout("2500 millis"), Effect.forkChild);
  yield* TestClock.adjust("2500 millis");
  const exit = yield* Fiber.await(fiber);
  // The wall clock the program sees is the TestClock's, not the machine's.
  const seenNow = yield* Effect.sync(() => Date.now());
  return { timedOut: Exit.isFailure(exit), seenNow };
});

async function testClockShutdownTimeout(): Promise<{ elapsed: number; timedOut: boolean }> {
  const start = wall();
  const result = await Effect.runPromise(Effect.provide(effectShutdownTimeout, TestClock.layer()));
  return { elapsed: wall() - start, timedOut: result.timedOut };
}

// ---------------------------------------------------------------------------
// C. Plain DI on the same shape. Inject `now`, keep the real timer.
//    Shows the existing repo pattern (rate-limit) only compresses *decisions*,
//    not *scheduling*: the delay still comes from setTimeout/sleep.
// ---------------------------------------------------------------------------
async function injectedClockShutdownTimeout(now: () => number): Promise<number> {
  const deadline = now() + 2500;
  const start = wall();
  await new Promise<never>((_, reject) => {
    const tick = () => {
      if (now() >= deadline) reject(new Error("Pi 关闭超时 (2500ms)"));
      else setTimeout(tick, 100);
    };
    tick();
  }).catch(() => {});
  return wall() - start;
}

// ---------------------------------------------------------------------------
// D. Does TestClock compress real external work? Spawn a real child that needs
//    500ms and give it a 10ms Effect timeout under TestClock.
// ---------------------------------------------------------------------------
async function realChildUnderTestClock(): Promise<{ timeoutFiredAfterMs: number; childExitedAfterMs: number }> {
  const childStart = wall();
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 500)"]);
  const exited = new Promise<number>((resolve) => {
    child.on("exit", () => resolve(wall() - childStart));
  });

  const program = Effect.gen(function* () {
    const fiber = yield* Effect.gen(function* () {
      yield* Effect.callback<void>((resume) => {
        child.on("exit", () => resume(Effect.void));
      });
    }).pipe(Effect.timeout("10 millis"), Effect.forkChild);
    const start = wall();
    yield* TestClock.adjust("10 millis");
    const exit = yield* Fiber.await(fiber);
    return { timeoutFiredAfterMs: wall() - start, timedOut: Exit.isFailure(exit) };
  });

  const result = await Effect.runPromise(Effect.provide(program, TestClock.layer()));
  return { ...result, childExitedAfterMs: await exited };
}

// ---------------------------------------------------------------------------
async function main() {
  const baseline = await baselineShutdownTimeout();
  console.log(`A. baseline setInterval/setTimeout shape      real wall ${ms(baseline)}`);

  const tc = await testClockShutdownTimeout();
  console.log(
    `B. same shape under TestClock(adjust 2500ms)  real wall ${ms(tc.elapsed)}  timeoutFired=${tc.timedOut}`,
  );

  const di = await injectedClockShutdownTimeout(() => Date.now());
  console.log(`C. plain injected clock, real timer           real wall ${ms(di)}`);

  const virtualTime = 1_700_000_000_000;
  const seen = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* TestClock.setTime(virtualTime);
        return yield* Effect.sync(() => Date.now());
      }),
      TestClock.layer(),
    ),
  );
  const dateNowRedirected = seen === virtualTime;
  console.log(
    `C'. Date.now() under TestClock                 = ${seen}, virtual time = ${virtualTime}, redirected = ${dateNowRedirected}`,
  );

  const d = await realChildUnderTestClock();
  console.log(
    `D. real 500ms child, 10ms Effect timeout       timeout fired after ${ms(d.timeoutFiredAfterMs)}, child really exited after ${ms(d.childExitedAfterMs)}`,
  );

  // Machine-readable line for verify.sh. Every field is a wall-clock duration in
  // milliseconds except the booleans.
  console.log(
    `SPIKE_JSON ${JSON.stringify({
      baselineRealTimerMs: Math.round(baseline),
      testClockMs: Math.round(tc.elapsed),
      testClockTimedOut: tc.timedOut,
      injectedClockRealTimerMs: Math.round(di),
      dateNowRedirected,
      testClockTimeoutDecisionMs: Math.round(d.timeoutFiredAfterMs),
      realChildExitMs: Math.round(d.childExitedAfterMs),
    })}`,
  );
}

void main();
