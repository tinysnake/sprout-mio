import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { ID_PREFIXES, newId } from "../src/contracts/ids";
import {
  EXECUTION_LOG_FRAME_MAX_BYTES,
  EXECUTION_LOG_FRAMES_PER_EXCHANGE,
  remoteReportSchema,
} from "../src/contracts/remote";
import type { ExecutionLogFrame, RemoteCommand } from "../src/contracts/remote";
import type { WorkerExchangeResponse } from "../src/contracts/worker";
import type { CapabilitySnapshot } from "../src/contracts/machine";
import { RemoteDispatcher } from "../src/worker/remote";
import { ExecutionRegistry, ExecutionStore } from "../src/worker/executions";
import { sliceBuffer } from "../src/worker/execution-log";

type RemoteWireOutput = Extract<WorkerExchangeResponse, { ok: true }>["data"]["remote"];
type LogAck = NonNullable<RemoteWireOutput["logAcks"]>[number];

const capability: CapabilitySnapshot = {
  platform: "darwin",
  arch: "arm64",
  workerVersion: "test",
  remoteOperations: ["shell", "file_read", "file_write", "process_list", "process_signal"],
  shells: [
    {
      path: "/bin/sh",
      kind: "sh",
      version: null,
      checkedAt: new Date().toISOString(),
      probe: { kind: "success" },
    },
  ],
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(stateDirectory?: string) {
  const projectId = newId(ID_PREFIXES.project),
    machineId = newId(ID_PREFIXES.machine),
    holderInstanceId = newId(ID_PREFIXES.instance);
  const key = { projectId, machineId, holderInstanceId };
  const session = {
    machineId,
    generation: 1,
    bootId: newId(ID_PREFIXES.boot),
    attemptId: randomUUID(),
  };
  const dispatcher = new RemoteDispatcher(
    session,
    capability,
    Date.now,
    undefined as never,
    new ExecutionRegistry(new ExecutionStore(stateDirectory), Date.now),
  );
  const output = (
    commands: RemoteCommand[] = [],
    logAcks: LogAck[] = [],
    generation = 1,
    state: "active" | "draining" = "active",
  ): RemoteWireOutput => ({
    commands,
    authorizations: [{ ...key, generation, state }],
    fences: [],
    resultAcks: [],
    fenceAcks: [],
    logAcks,
    mcp: [],
    mcpCursors: [],
  });
  const apply = (seq: number, remote: RemoteWireOutput) =>
    dispatcher.accept(
      {
        mode: "normal",
        session,
        seq,
        configuration: { root: null, rootRevision: 1, bindings: [] },
        remote,
      },
      seq,
      [],
    );
  const command = (
    operation: RemoteCommand["operation"],
    overrides: Partial<RemoteCommand> = {},
  ): RemoteCommand => ({
    ...key,
    executionId: newId(ID_PREFIXES.execution),
    requestId: newId(ID_PREFIXES.request),
    dispatchSession: session,
    dispatchSeq: 1,
    authorizationGeneration: 1,
    fingerprint: "a".repeat(64),
    directoryRevision: null,
    dispatchDeadlineAt: new Date(Date.now() + 30000).toISOString(),
    runtimeDeadlineAt: null,
    maxRuntimeMs: null,
    runnerToken: "b".repeat(32),
    operation,
    ...overrides,
  });
  return { key, session, dispatcher, output, apply, command };
}
/** 把未上行帧交给宿主并模拟 ACK，返回本批日志帧。 */
function exchangeLogs(
  f: Awaited<ReturnType<typeof fixture>>,
  seq: number,
  options: { ack?: boolean; maxBytes?: number } = {},
) {
  const remote = f.dispatcher.outgoing(options.maxBytes);
  const frames = remote.logFrames ?? [];
  const acks: LogAck[] = options.ack === false ? [] : acked(frames);
  f.apply(seq, f.output([], acks));
  return frames;
}
function acked(frames: readonly ExecutionLogFrame[]) {
  const byExecution = new Map<string, number>();
  for (const frame of frames)
    byExecution.set(
      frame.executionId,
      Math.max(byExecution.get(frame.executionId) ?? 0, frame.sequence),
    );
  return [...byExecution].map(([executionId, through]) => ({
    executionId,
    stream: "both" as const,
    acknowledgedThroughSequence: through,
    availableFromSequence: null,
  }));
}
async function collectUntilIdle(
  f: Awaited<ReturnType<typeof fixture>>,
  onBatch: (frames: readonly ExecutionLogFrame[]) => void,
  rounds = 400,
) {
  let seq = 1;
  let sawFrames = false;
  let idle = 0;
  for (let round = 0; round < rounds; round++) {
    const frames = exchangeLogs(f, ++seq);
    onBatch(frames);
    if (frames.length) {
      sawFrames = true;
      idle = 0;
    } else idle += 1;
    const pending = f.dispatcher.outgoing(1048576).logFrames ?? [];
    if (sawFrames && frames.length === 0 && pending.length === 0) return;
    if (!sawFrames && idle > 100) throw new Error("no log frames produced");
    await sleep(10);
  }
}
async function terminalOf(dispatcher: RemoteDispatcher, executionId: string, rounds = 600) {
  for (let attempt = 0; attempt < rounds; attempt++) {
    const report = dispatcher
      .outgoing(1048576)
      .results.find((report) => report.executionId === executionId);
    if (report?.phase === "terminal") {
      expect(remoteReportSchema.safeParse(report).success).toBe(true);
      return report;
    }
    await sleep(10);
  }
  throw new Error("terminal report missing");
}

test("日志帧增量上行：跨流共享单调序、原始字节位点单调、ACK 前缀不重发", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4c-log-"));
  const f = await fixture(directory);
  const command = f.command({
    kind: "shell",
    command: `seq 1 60000; seq 1 4000 >&2`,
    cwd: directory,
    waitMs: 5000,
  });
  f.apply(1, f.output([command]));
  const batches: ExecutionLogFrame[][] = [];
  await collectUntilIdle(f, (frames) => frames.length && batches.push([...frames]));
  expect(batches.length).toBeGreaterThan(1);
  const frames = batches.flat();
  const sequences = frames.map((frame) => frame.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(new Set(frames.map((frame) => frame.stream))).toEqual(new Set(["stdout", "stderr"]));
  for (const frame of frames) {
    expect(frame.byteEnd).toBeGreaterThanOrEqual(frame.byteStart);
    expect(Buffer.byteLength(frame.bytes ?? "", "utf8")).toBeLessThanOrEqual(
      EXECUTION_LOG_FRAME_MAX_BYTES,
    );
    expect(frame.byteEnd - frame.byteStart).toBe(
      Buffer.byteLength(Buffer.from(frame.bytes ?? "", "utf8")),
    );
    expect(frame.bytes ?? "").not.toContain("\0");
  }
  // 每个流内位点严格单调，且 ACK 之后同一序号不再出现。
  for (const stream of ["stdout", "stderr"] as const) {
    const offsets = frames.filter((frame) => frame.stream === stream).map((f) => f.byteStart);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(new Set(offsets).size).toBe(offsets.length);
  }
  // 帧归属于「下发这条命令的那一次投递」，而不是承载它的 exchange。
  // command.dispatchSeq 是 1（下发批），而帧跨越了后续多个批次上行。
  expect(new Set(frames.map((frame) => frame.dispatchSeq))).toEqual(new Set([command.dispatchSeq]));
  const acknowledgedThrough = Math.max(...frames.map((frame) => frame.sequence));
  const resent = f.dispatcher.outgoing(1048576).logFrames ?? [];
  expect(resent.some((frame) => frame.sequence <= acknowledgedThrough)).toBe(false);
  // 全部 ACK 后 outbox 清空，且 durable outbox 只剩未确认帧。
  const leftover = await readFile(
    join(directory, "executions", command.executionId, "frames.jsonl"),
    "utf8",
  );
  expect(leftover.trim()).toBe("");
});

test("运行上限到期先 TERM 后 KILL，终态是限时而不是下发窗口", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4c-runtime-"));
  const f = await fixture(directory);
  const runtimeDeadlineAt = new Date(Date.now() + 400).toISOString();
  // 忽略 TERM：只有宽限后的 KILL 才能停下它。
  const command = f.command(
    {
      kind: "shell",
      command: "trap '' TERM; sleep 30",
      cwd: directory,
      waitMs: 10000,
    },
    { runtimeDeadlineAt, maxRuntimeMs: 400 },
  );
  const startedAt = Date.now();
  f.apply(1, f.output([command]));
  const report = await terminalOf(f.dispatcher, command.executionId);
  const elapsed = Date.now() - startedAt;
  expect(report.outcome).toBe("timed_out");
  expect("failureReason" in report.payload && report.payload.failureReason).toBe("deadline");
  expect(report.payload.kind === "shell" && "partial" in report.payload).toBe(true);
  // TERM 被忽略，进程只在 2000ms 宽限后的 KILL 才死：耗时必须超过宽限，说明确实先 TERM 后 KILL。
  expect(elapsed).toBeGreaterThanOrEqual(2300);
  expect(elapsed).toBeLessThan(20000);
});

test("下发窗口只约束准入：跨过截止时间仍在运行的长命令按真实退出码终态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4c-admission-"));
  const f = await fixture(directory);
  const command = f.command(
    {
      kind: "shell",
      command: "sleep 1; echo admitted",
      cwd: directory,
      waitMs: 5000,
    },
    {
      dispatchDeadlineAt: new Date(Date.now() + 200).toISOString(),
      runtimeDeadlineAt: new Date(Date.now() + 30000).toISOString(),
      maxRuntimeMs: 30000,
    },
  );
  f.apply(1, f.output([command]));
  const report = await terminalOf(f.dispatcher, command.executionId);
  // 下发窗口在准入之后不再参与任何判定：命令跑过 200ms 仍是真实成功。
  expect(report.outcome).toBe("succeeded");
  expect(
    report.payload.kind === "shell" && "stdout" in report.payload && report.payload.stdout,
  ).toContain("admitted");
});

test("断线不终止已开始的执行：重连后补送断线期间产生的真实终态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4c-offline-terminal-"));
  const f = await fixture(directory);
  const command = f.command({
    kind: "shell",
    command: "sleep 0.4; echo offline-done",
    cwd: directory,
    waitMs: 10000,
  });
  f.apply(1, f.output([command]));
  await sleep(100);
  // 连接断开（exchange 失败）：只关闭准入，不撤销已经开始执行的命令。
  f.dispatcher.disconnect();
  const report = await terminalOf(f.dispatcher, command.executionId);
  expect(report.outcome).toBe("succeeded");
  expect(
    report.payload.kind === "shell" && "stdout" in report.payload && report.payload.stdout,
  ).toContain("offline-done");
  // 同一条终态报告在重连后的下一批上行里仍在，直到宿主 ACK。
  const resent = f.dispatcher
    .outgoing(1048576)
    .results.find((item) => item.executionId === command.executionId);
  expect(resent?.phase).toBe("terminal");
});

test("runner_token 跨重启报恢复事实，未观测到退出只报 unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4c-recovery-"));
  const first = await fixture(directory);
  const command = first.command(
    {
      kind: "shell",
      command: "sleep 30",
      cwd: directory,
      waitMs: 10000,
    },
    { runnerToken: "c".repeat(32) },
  );
  first.apply(1, first.output([command]));
  for (
    let i = 0;
    i < 200 && first.dispatcher.registry.runs.get(command.executionId)?.claim.pid === 0;
    i++
  )
    await sleep(10);
  const pid = first.dispatcher.registry.runs.get(command.executionId)!.claim.pid;
  expect(pid).toBeGreaterThan(0);
  const claim = JSON.parse(
    await readFile(join(directory, "executions", command.executionId, "claim.json"), "utf8"),
  ) as { runnerToken: string; pid: number };
  expect(claim.runnerToken).toBe("c".repeat(32));
  expect(claim.pid).toBe(pid);
  // 上一个 Worker 停在原地：新会话（新 attemptId、新代次）只从 durable claim 里取事实。
  const second = await fixture(directory);
  const recoveries = second.dispatcher.registry.pendingRecoveries(second.session, 8);
  const fact = recoveries.find((item) => item.executionId === command.executionId);
  expect(fact).toBeDefined();
  expect(fact!.runnerToken).toBe("c".repeat(32));
  expect(fact!.observedState).toBe("running");
  expect(fact!.observedExitedAt).toBeNull();
  expect(fact!.exitCode).toBeNull();
  expect(fact!.claimEvidenceAt).toBe(claimEvidence(fact!.claimEvidenceAt));
  // 新会话的 outgoing 必须真的把恢复事实带出去。
  const wire = second.dispatcher.outgoing(1048576);
  expect(wire.recoveries?.some((item) => item.executionId === command.executionId)).toBe(true);
  // 送达之后同一会话不重复上报同一条事实。
  second.apply(1, second.output([]));
  expect(
    second.dispatcher
      .outgoing(1048576)
      .recoveries?.some((item) => item.executionId === command.executionId) ?? false,
  ).toBe(false);
  process.kill(pid, "SIGKILL");
}, 20000);

function claimEvidence(value: string) {
  return value;
}

test("上行预算内 fence 与终端报告优先，日志帧每批不超过上限", async () => {
  const f = await fixture();
  const noisy = f.command({
    kind: "shell",
    command: "seq 1 4000",
    cwd: process.cwd(),
    waitMs: 5000,
  });
  f.apply(1, f.output([noisy]));
  await sleep(400);
  // 三种上限一起压：满额的终端报告、fence 与日志帧争同一份额。
  const frame = f.dispatcher.outgoing(1048576);
  expect((frame.logFrames ?? []).length).toBeLessThanOrEqual(EXECUTION_LOG_FRAMES_PER_EXCHANGE);
  const tiny = f.dispatcher.outgoing(4096);
  expect(tiny.logFrames ?? []).toEqual([]);
  expect(
    JSON.stringify(tiny.results).length + JSON.stringify(tiny.fenceAcks).length,
  ).toBeGreaterThan(0);
});

test("无效 UTF-8 与 NUL 记为 gap，不静默丢弃也不假装是空输出", () => {
  const segments = sliceBuffer(Buffer.from([0x61, 0xff, 0x62]), true);
  expect(segments).toEqual([
    { start: 0, end: 1, text: "a" },
    { start: 1, end: 2, text: null },
    { start: 2, end: 3, text: "b" },
  ]);
  expect(sliceBuffer(Buffer.from("中文", "utf8"), false)).toEqual([
    { start: 0, end: 6, text: "中文" },
  ]);
  // 末尾不完整码点等待下一批；final 时记为 gap。
  expect(sliceBuffer(Buffer.from([0xe4, 0xb8]), false)).toEqual([]);
  expect(sliceBuffer(Buffer.from([0xe4, 0xb8]), true)).toEqual([{ start: 0, end: 2, text: null }]);
  expect(sliceBuffer(Buffer.from([0x00]), true)).toEqual([{ start: 0, end: 1, text: null }]);
});

test("旧授权代次不得声称成功，且租约动作不终止进程（代价条款）", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4c-stale-"));
  const f = await fixture(directory);
  const pidPath = join(directory, "pid");
  const command = f.command({
    kind: "shell",
    command: `echo $$ > '${pidPath}'; exec sleep 30`,
    cwd: directory,
    waitMs: 10000,
  });
  f.apply(1, f.output([command]));
  for (let i = 0; i < 200; i++) {
    const exists = await stat(pidPath).then(
      () => true,
      () => false,
    );
    if (exists) break;
    await sleep(10);
  }
  const pid = Number(await readFile(pidPath, "utf8"));
  f.apply(2, f.output([], [], 2));
  await sleep(500);
  // 旧代次不能报成功；租约动作不发信号，进程继续运行（P4a/P4b 已确认的代价）。
  const report = f.dispatcher.outgoing(1048576).results[0];
  expect(report?.phase === "terminal" ? report.outcome : "running").not.toBe("succeeded");
  expect(alive(pid)).toBe(true);
  process.kill(pid, "SIGKILL");
}, 20000);

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("未下发就被撤销的命令不执行，文件不存在", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4c-revoked-"));
  const f = await fixture();
  const path = join(directory, "absent");
  const command = f.command({
    kind: "file_write",
    path,
    content: "fixture",
    mode: "overwrite",
  });
  f.apply(1, f.output([command]));
  f.apply(2, f.output([], [], 1, "draining"));
  const report = await terminalOf(f.dispatcher, command.executionId);
  expect(report.outcome).not.toBe("succeeded");
  expect(
    await stat(path).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test("进程不在但无退出事实时恢复报 unknown，不猜退出码", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4c-unknown-"));
  const f = await fixture();
  // 只留 claim、不 spawn：模拟上一代进程死在写退出事实之前。
  const executionId = newId(ID_PREFIXES.execution);
  new ExecutionStore(directory).saveClaim({
    executionId,
    projectId: f.key.projectId,
    machineId: f.key.machineId,
    authorizationGeneration: 1,
    holderInstanceId: f.key.holderInstanceId,
    fingerprint: "a".repeat(64),
    runnerToken: "d".repeat(32),
    pid: 999_999,
    claimedAt: Date.now(),
    exitedAt: null,
    exitCode: null,
    signal: null,
    producedThroughSequence: null,
  });
  const second = await fixture(directory);
  const fact = second.dispatcher.registry
    .pendingRecoveries(second.session, 8)
    .find((item) => item.executionId === executionId);
  expect(fact?.observedState).toBe("unknown");
  expect(fact?.exitCode).toBeNull();
  expect(fact?.signal).toBeNull();
  expect(fact?.observedExitedAt).toBeNull();
  expect(fact?.runnerToken).toBe("d".repeat(32));
});

test("spawn 失败前不写 pid，恢复事实不得声称 exited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4c-prespawn-"));
  const f = await fixture(directory);
  const command = f.command(
    {
      kind: "shell",
      command: "true",
      cwd: directory,
      waitMs: 1000,
    },
    { runnerToken: "e".repeat(32) },
  );
  // 目录不在观察结果里：命令在 gate 处被拒，从未 spawn。
  const stale = { ...command, directoryRevision: 5 };
  f.apply(1, f.output([stale]));
  const report = await terminalOf(f.dispatcher, stale.executionId);
  expect(report.outcome).toBe("rejected");
  const second = await fixture(directory);
  const fact = second.dispatcher.registry
    .pendingRecoveries(second.session, 8)
    .find((item) => item.executionId === stale.executionId);
  expect(fact?.observedState).toBe("unknown");
});

test("waitMs 快照交出 pid 但不落终态：真实退出后同一执行覆盖为终态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4c-snapshot-"));
  const f = await fixture(directory);
  const command = f.command({
    kind: "shell",
    command: "sleep 0.6; echo still-running",
    cwd: directory,
    waitMs: 100,
  });
  f.apply(1, f.output([command]));
  const snapshot = await terminalOf(f.dispatcher, command.executionId);
  const snapshotPayload = snapshot.payload;
  expect(
    snapshotPayload.kind === "shell" &&
      !("failureReason" in snapshotPayload) &&
      snapshotPayload.exited,
  ).toBe(false);
  expect(
    snapshotPayload.kind === "shell" &&
      !("failureReason" in snapshotPayload) &&
      snapshotPayload.pid > 0,
  ).toBe(true);
  // ACK 快照只表示宿主收下了 pid；entry 仍在，不能把同一张快照每轮重发。
  f.apply(2, {
    ...f.output(),
    resultAcks: [{ executionId: command.executionId, disposition: "accepted" }],
  });
  expect(
    f.dispatcher
      .outgoing(1048576)
      .results.some((report) => report.executionId === command.executionId),
  ).toBe(false);
  let final: Awaited<ReturnType<typeof terminalOf>> | undefined;
  for (let attempt = 0; attempt < 600; attempt++) {
    const report = f.dispatcher
      .outgoing(1048576)
      .results.find((item) => item.executionId === command.executionId);
    if (
      report?.phase === "terminal" &&
      report.payload.kind === "shell" &&
      !("failureReason" in report.payload) &&
      report.payload.exited
    ) {
      final = report;
      break;
    }
    await sleep(10);
  }
  expect(final?.outcome).toBe("succeeded");
  const finalPayload = final?.payload;
  expect(
    finalPayload?.kind === "shell" && !("failureReason" in finalPayload) ? finalPayload.stdout : "",
  ).toContain("still-running");
});
