// Probe 8: does a resident Effect fiber keep the Node event loop alive the way
// setInterval(...).unref() does not? Today the host unrefs its poll timer.
import { spawn } from "node:child_process";

const wall = () => performance.now();

const innerUnref = `
import { setInterval } from "node:timers";
setInterval(() => {}, 100).unref();
console.log("unref interval armed");
`;

const innerEffectNoDispose = `
import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect";
class Poll extends Context.Service()("probe/Poll") {}
const layer = Layer.effect(Poll, Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  yield* Effect.gen(function* () {
    while (true) { yield* Effect.sleep("100 millis"); }
  }).pipe(Effect.forkIn(scope));
  return "polling";
}));
const runtime = ManagedRuntime.make(layer);
await runtime.runPromise(Poll);
console.log("resident poll fiber armed");
`;

const innerEffectDispose = innerEffectNoDispose.replace(
  'console.log("resident poll fiber armed");',
  'console.log("resident poll fiber armed");\nawait runtime.dispose();\nconsole.log("disposed");',
);

async function measure(label, code, killAfterMs) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const startedAt = wall();
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, killAfterMs);
  const code_ = await new Promise((resolve) => child.on("exit", (value) => resolve(value)));
  clearTimeout(timer);
  const elapsed = Math.round(wall() - startedAt);
  console.log(
    label +
      ": exit=" +
      code_ +
      " wall=" +
      elapsed +
      "ms" +
      (killed ? " (killed after " + killAfterMs + "ms, the loop was held open)" : ""),
  );
}

await measure("A setInterval().unref()        ", innerUnref, 1500);
await measure("B Effect poll, no dispose     ", innerEffectNoDispose, 1500);
await measure("C Effect poll + dispose       ", innerEffectDispose, 1500);
