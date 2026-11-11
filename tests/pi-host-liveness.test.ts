import { Effect, ManagedRuntime } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vite-plus/test";
import { prepareSyntheticPiMessage } from "../src/server/message-skills";
import { PiSessionProcess } from "../src/server/pi-host/process";
import { makePiHostLayer, PiHost, startPiHost, STOP_DEADLINE_MS } from "../src/server/pi-host/host";

const directory = mkdtempSync(join(tmpdir(), "run-liveness-"));
const runner = join(directory, "runner.mjs");
writeFileSync(
  runner,
  `
import { createInterface } from 'node:readline';
let id;
const out = event => process.stdout.write(JSON.stringify({id, ...event}) + '\\n');
createInterface({input: process.stdin}).on('line', raw => {
  const command = JSON.parse(raw);
  id = command.id;
  if (command.type === 'open') out({type:'input_delivered', messageId:'open-probe'});
  if (command.type === 'prompt') {
    out({type:'input_delivered', messageId:command.messageId});
    if (id.includes('exits')) process.exit(17);
    if (id.includes('next')) out({type:'settled', stopReason:'stop', text:'next running'});
  }
  if (command.type === 'steer') {
    if (command.messageId === 'pulse') out({type:'progress',kind:'text_delta',text:'working'});
    else out({type:'settled', stopReason:'stop', text:'slow completed'});
  }
  if (command.type === 'close' && !id.includes('stuck')) {
    if (id === 'run_cooperative') out({type:'settled', stopReason:'stop', text:'late'});
    process.exit(0);
  }
});
`,
);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function prompt(transport: PiSessionProcess) {
  transport.turnContext = {
    runId: transport.id,
    contentHash: "a".repeat(64),
    serializedText: "context",
  };
  return transport.prompt(
    prepareSyntheticPiMessage({ kind: "resource_notice", messageId: "message-probe", text: "go" }),
  );
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["quiet", "progress"])(
  "慢 run（%s）越过 600000ms 与 1800000ms 仍等待 settled",
  async (mode) => {
    const transport = new PiSessionProcess("run_slow", runner);
    const delivered = latch();
    transport.onDelivered = delivered.resolve;
    let outcome = "running";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const settled = prompt(transport).then(
      (value) => {
        outcome = "completed";
        return value;
      },
      (error) => {
        outcome = "failed";
        throw error;
      },
    );
    // Attach immediately so a reintroduced watchdog reports an assertion failure, not an unhandled rejection.
    void settled.catch(() => {});
    try {
      await delivered.promise;
      await vi.advanceTimersByTimeAsync(600001);
      expect(outcome).toBe("running");
      for (let index = 0; index < 2; index += 1) {
        if (mode === "progress") {
          const progress = latch();
          transport.onProgress = progress.resolve;
          transport.steer(
            prepareSyntheticPiMessage({
              kind: "resource_notice",
              messageId: "pulse",
              text: "pulse",
            }),
          );
          await progress.promise;
        }
        await vi.advanceTimersByTimeAsync(600000);
        expect(outcome).toBe("running");
      }
      expect(() => process.kill(transport.pid!, 0)).not.toThrow();
      console.log(
        "EVIDENCE liveness",
        JSON.stringify({ mode, elapsedMs: 1800001, outcome, pid: transport.pid }),
      );
      transport.steer(
        prepareSyntheticPiMessage({
          kind: "resource_notice",
          messageId: "release",
          text: "release",
        }),
      );
      expect(await settled).toMatchObject({ text: "slow completed" });
    } finally {
      vi.useRealTimers();
      await transport.close();
    }
  },
);

it("卡死 session 取消在 5 秒内收口，同一 instance 下一条排队 run 被宿主拾起", async () => {
  const delivered = latch();
  const nextStarted = latch();
  const trace: {
    waiterMs?: number;
    closedMs?: number;
    nextMs?: number;
    rejection?: string;
    closeError?: string;
  } = {};
  let count = 0;
  let disposed = 0;
  let cancelAt = 0;
  const runtime = ManagedRuntime.make(
    makePiHostLayer({
      loadWork: () => (count < 2 ? [{ instanceId: "inst_liveness" }] : []),
      prepareRun: () => {
        count += 1;
        const first = count === 1;
        const transport = new PiSessionProcess(first ? "run_stuck" : "run_next", runner);
        if (first) {
          transport.onDelivered = delivered.resolve;
          transport.onDispose(() => {
            disposed += 1;
          });
        } else {
          trace.nextMs = performance.now() - cancelAt;
          nextStarted.resolve();
        }
        const close = async () => {
          try {
            await transport.close();
          } catch (error) {
            trace.closeError = (error as Error).message;
          }
          if (first) trace.closedMs = performance.now() - cancelAt;
        };
        return {
          runId: transport.id,
          pid: transport.pid,
          abort: () => transport.abortSession(),
          close,
          body: Effect.promise(async () => {
            try {
              await prompt(transport);
            } catch (error) {
              if (first) {
                trace.waiterMs = performance.now() - cancelAt;
                trace.rejection = (error as Error).message;
              } else throw error;
            } finally {
              await close();
            }
          }),
        };
      },
      interruptActiveRuns: () => {},
      reportFailure: () => {},
    }),
  );
  try {
    await runtime.runPromise(startPiHost);
    await delivered.promise;
    cancelAt = performance.now();
    expect(await runtime.runPromise(Effect.map(PiHost, (host) => host.abort("run_stuck")))).toBe(
      true,
    );
    await nextStarted.promise;
    expect(trace.rejection).toBe("Pi runner 已关闭");
    expect(trace.waiterMs).toBeGreaterThanOrEqual(1900);
    expect(trace.closedMs).toBeGreaterThanOrEqual(3400);
    expect(trace.nextMs).toBeLessThan(STOP_DEADLINE_MS);
    expect(trace.closeError).toContain("forced=true");
    expect(count).toBe(2);
    expect(disposed).toBe(1);
    console.log("EVIDENCE cancellation", JSON.stringify(trace));
  } finally {
    await runtime.dispose();
  }
}, 10000);

function open(transport: PiSessionProcess) {
  return transport.open({
    type: "open",
    id: transport.id,
    instanceId: "ain_probe",
    sessionId: "session-probe",
    sessionDirectory: directory,
    cwd: directory,
    agentDir: directory,
    extensionPath: "fixture-extension",
    resources: { kind: "disabled" },
    purpose: "worker",
    profile: {
      id: "agt_probe",
      name: "fixture",
      persona: "fixture",
      harness: "pi",
      updatedAt: "2026-11-11T00:00:00Z",
    },
    remote: {
      endpoint: "http://127.0.0.1:1/api/remote/agent",
      secret: "q".repeat(64),
      expiresAt: "2026-11-12T00:00:00Z",
      projectId: "prj_probe",
    },
  });
}

it.each(["timeout", "abort"])("初始化不响应时保留协议超时并接受显式取消（%s）", async (action) => {
  const transport = new PiSessionProcess("run_open", runner);
  const delivered = latch();
  transport.onDelivered = delivered.resolve;
  let failure: unknown;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = open(transport).catch((error: unknown) => {
    failure = error;
  });
  try {
    await delivered.promise;
    if (action === "abort") transport.abortSession();
    await vi.advanceTimersByTimeAsync(action === "abort" ? 2000 : 30000);
    expect(failure).toMatchObject({
      code: action === "abort" ? "runner_closed" : "runner_timeout",
    });
    await pending;
  } finally {
    vi.useRealTimers();
    await transport.close();
  }
});

it("自然退出拒绝仍在等待的 prompt 且清理只执行一次", async () => {
  const transport = new PiSessionProcess("run_exits", runner);
  let disposed = 0;
  transport.onDispose(() => disposed++);
  try {
    await expect(prompt(transport)).rejects.toMatchObject({ code: "runner_crashed" });
    await expect(transport.close()).rejects.toMatchObject({ code: "runner_shutdown_failed" });
    expect(disposed).toBe(1);
  } finally {
    await transport.close().catch(() => {});
  }
});

it("主动 close 拒绝 waiter 并接收迟到 settled，合作 settled 撤销 abort grace", async () => {
  const transport = new PiSessionProcess("run_cooperative", runner);
  const delivered = latch();
  transport.onDelivered = delivered.resolve;
  const pending = prompt(transport);
  const rejected = expect(pending).rejects.toMatchObject({ code: "runner_closed" });
  try {
    await delivered.promise;
    const closing = transport.close();
    await rejected;
    await closing;
  } finally {
    await transport.close();
  }

  const cooperative = new PiSessionProcess("run_settled", runner);
  const accepted = latch();
  cooperative.onDelivered = accepted.resolve;
  const settled = prompt(cooperative);
  try {
    await accepted.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cooperative.abortSession();
    cooperative.steer(
      prepareSyntheticPiMessage({ kind: "resource_notice", messageId: "release", text: "release" }),
    );
    await settled;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(() => process.kill(cooperative.pid!, 0)).not.toThrow();
  } finally {
    vi.useRealTimers();
    await cooperative.close();
  }
});
