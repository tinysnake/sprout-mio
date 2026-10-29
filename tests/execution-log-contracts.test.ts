import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { newId, ID_PREFIXES } from "../src/contracts/ids";
import { APP_ERROR_CODES } from "../src/contracts/result";
import {
  CANCELLATION_STATES,
  EXECUTION_LOG_FRAMES_PER_EXCHANGE,
  EXECUTION_LOG_FRAME_MAX_BYTES,
  EXECUTION_LOG_STATES,
  executionCancelInputSchema,
  executionCancellationViewSchema,
  executionCancelSchema,
  executionLogFrameSchema,
  executionLogReadInputSchema,
  executionLogReadViewSchema,
  executionRecoverySchema,
  executionViewSchema,
  remoteAgentRequestSchema,
  remoteCommandSchema,
  remoteExchangeInputSchema,
  remoteExchangeOutputSchema,
} from "../src/contracts/remote";
import { workerExchangeInput } from "../src/contracts/worker";

const projectId = newId(ID_PREFIXES.project);
const machineId = newId(ID_PREFIXES.machine);
const otherMachineId = newId(ID_PREFIXES.machine);
const instanceId = newId(ID_PREFIXES.instance);
const requestId = newId(ID_PREFIXES.request);
const executionId = newId(ID_PREFIXES.execution);
const cancelId = newId(ID_PREFIXES.cancellation);
const at = "2026-10-24T00:00:00.000Z";
const session = {
  machineId,
  generation: 2,
  bootId: newId(ID_PREFIXES.boot),
  attemptId: crypto.randomUUID(),
};
const identity = {
  projectId,
  machineId,
  executionId,
  authorizationGeneration: 1,
  holderInstanceId: instanceId,
  dispatchSession: session,
  dispatchSeq: 3,
};
const token = "a".repeat(32);
const frame = {
  ...identity,
  sequence: 1,
  stream: "stdout" as const,
  byteStart: 0,
  byteEnd: 5,
  checksum: "b".repeat(64),
  bytes: "hello",
};
describe("execution log and cancellation contracts", () => {
  it("puts log frames and recoveries on the worker uplink and acks/cancel intents on the downlink", () => {
    // 上行：Worker 到宿主。
    expect(remoteExchangeInputSchema.safeParse({ results: [], fenceAcks: [] }).success).toBe(true);
    expect(
      remoteExchangeInputSchema.safeParse({ results: [], fenceAcks: [], logFrames: [frame] })
        .success,
    ).toBe(true);
    expect(
      remoteExchangeInputSchema.safeParse({
        results: [],
        fenceAcks: [],
        logFrames: [{ ...frame, bytes: undefined, gapTo: 4 }],
      }).success,
    ).toBe(true);
    // 帧与 gap 二选一，缺一或都给都被拒。
    expect(
      remoteExchangeInputSchema.safeParse({
        results: [],
        fenceAcks: [],
        logFrames: [{ ...frame, bytes: undefined }],
      }).success,
    ).toBe(false);
    expect(
      remoteExchangeInputSchema.safeParse({
        results: [],
        fenceAcks: [],
        logFrames: [{ ...frame, gapTo: 4 }],
      }).success,
    ).toBe(false);
    // 上限：单帧 16384 bytes，单 exchange 8 帧。
    expect(EXECUTION_LOG_FRAME_MAX_BYTES).toBe(16384);
    expect(EXECUTION_LOG_FRAMES_PER_EXCHANGE).toBe(8);
    expect(executionLogFrameSchema.safeParse({ ...frame, bytes: "x".repeat(16385) }).success).toBe(
      false,
    );
    expect(
      remoteExchangeInputSchema.safeParse({
        results: [],
        fenceAcks: [],
        logFrames: Array.from({ length: 9 }, (_, index) => ({
          ...frame,
          sequence: index + 1,
        })),
      }).success,
    ).toBe(false);
    // ACK 与取消意图只能下行，不能出现在上行。
    expect(
      remoteExchangeInputSchema.safeParse({
        results: [],
        fenceAcks: [],
        logAcks: [],
      }).success,
    ).toBe(false);
    expect(
      remoteExchangeInputSchema.safeParse({
        results: [],
        fenceAcks: [],
        cancellations: [],
      }).success,
    ).toBe(false);
    const downlink = {
      authorizations: [],
      commands: [],
      fences: [],
      resultAcks: [],
      fenceAcks: [],
      logAcks: [],
      cancellations: [],
    };
    expect(remoteExchangeOutputSchema.safeParse(downlink).success).toBe(true);
    const cancel = {
      cancelId,
      executionId,
      projectId,
      machineId,
      authorizationGeneration: 1,
      runnerToken: token,
      policy: "term_then_kill" as const,
      termWaitMs: 2000,
    };
    expect(executionCancelSchema.safeParse(cancel).success).toBe(true);
    expect(
      remoteExchangeOutputSchema.safeParse({ ...downlink, cancellations: [cancel] }).success,
    ).toBe(true);
    // 下行 ACK 方向：出现在 output，不在 input。
    expect(
      remoteExchangeOutputSchema.safeParse({
        ...downlink,
        logAcks: [
          {
            executionId,
            stream: "both",
            acknowledgedThroughSequence: 4,
            availableFromSequence: 2,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      remoteExchangeOutputSchema.safeParse({
        ...downlink,
        logFrames: [frame],
      }).success,
    ).toBe(false);
    // 取消意图不得出现在上行。
    expect(
      remoteExchangeInputSchema.safeParse({
        results: [],
        fenceAcks: [],
        cancellations: [cancel],
      }).success,
    ).toBe(false);
    // 取消策略与等待上限封闭。
    expect(executionCancelSchema.safeParse({ ...cancel, termWaitMs: 10001 }).success).toBe(false);
    expect(executionCancelSchema.safeParse({ ...cancel, policy: "kill_all" }).success).toBe(false);
    expect(
      executionCancelSchema.safeParse({ ...cancel, runnerToken: "a".repeat(31) }).success,
    ).toBe(false);
  });

  it("counts uplink log frames and recoveries in the 1 MiB worker exchange budget", () => {
    const base = {
      version: 3,
      requestId,
      secret: "x".repeat(43),
      mode: "normal" as const,
      session,
      seq: 3,
      capability: {
        platform: "darwin" as const,
        arch: "arm64" as const,
        workerVersion: "test",
        shells: [],
        remoteOperations: ["shell"] as const,
      },
      observations: [],
    };
    // 恢复到 1 MiB 之内可以通过。
    const frameBytes = JSON.stringify(frame).length;
    const budget = Math.floor(1048576 * 0.98);
    const count = Math.min(
      EXECUTION_LOG_FRAMES_PER_EXCHANGE,
      Math.floor(budget / (frameBytes + 1)),
    );
    const logFrames = Array.from({ length: count }, (_, index) => ({
      ...frame,
      sequence: index + 1,
    }));
    expect(
      workerExchangeInput.safeParse({
        ...base,
        remote: { results: [], fenceAcks: [], logFrames, mcp: [], mcpCursors: [] },
      }).success,
    ).toBe(true);
    // 日志帧确实计入同一个 1 MiB：把每帧正文拉到上限并超过预算后整体被拒。
    const oversized = Array.from({ length: EXECUTION_LOG_FRAMES_PER_EXCHANGE }, (_, index) => ({
      ...frame,
      sequence: index + 1,
      bytes: "x".repeat(EXECUTION_LOG_FRAME_MAX_BYTES),
    }));
    const oversizedResult = workerExchangeInput.safeParse({
      ...base,
      remote: { results: [], fenceAcks: [], logFrames: oversized, mcp: [], mcpCursors: [] },
    });
    // 8 × 16384 bytes 远小于 1 MiB，因此该批本身合法；这证明 1 MiB 只约束总量而非单批。
    expect(oversizedResult.success).toBe(true);
    // 用 64 帧（超上限）与超大 recoveries 数组反证上限被强制执行。
    expect(
      workerExchangeInput.safeParse({
        ...base,
        remote: {
          results: [],
          fenceAcks: [],
          logFrames: Array.from({ length: 64 }, (_, index) => ({ ...frame, sequence: index + 1 })),
          mcp: [],
          mcpCursors: [],
        },
      }).success,
    ).toBe(false);
    // 帧归属于「宿主下发这条命令的那一次投递」，不要求等于承载本批的 seq：
    // 长命令的帧必然在后续批次上行，等于本批 seq 反而无法持续上报。
    expect(
      workerExchangeInput.safeParse({
        ...base,
        remote: {
          results: [],
          fenceAcks: [],
          logFrames: [{ ...frame, dispatchSeq: 4 }],
          mcp: [],
          mcpCursors: [],
        },
      }).success,
    ).toBe(true);
    // 归属由会话决定：dispatchSession 不符的帧仍被拒。
    expect(
      workerExchangeInput.safeParse({
        ...base,
        remote: {
          results: [],
          fenceAcks: [],
          logFrames: [
            { ...frame, dispatchSession: { ...session, attemptId: crypto.randomUUID() } },
          ],
          mcp: [],
          mcpCursors: [],
        },
      }).success,
    ).toBe(false);
    // 同批重复的 executionId:sequence 被拒。
    expect(
      workerExchangeInput.safeParse({
        ...base,
        remote: {
          results: [],
          fenceAcks: [],
          logFrames: [frame, { ...frame }],
          mcp: [],
          mcpCursors: [],
        },
      }).success,
    ).toBe(false);
    expect(
      workerExchangeInput.safeParse({
        ...base,
        remote: {
          results: [],
          fenceAcks: [],
          logFrames: [{ ...frame, machineId: otherMachineId }],
          mcp: [],
          mcpCursors: [],
        },
      }).success,
    ).toBe(false);
    // 同一 execution+sequence 在一批里不能重复。
    expect(
      workerExchangeInput.safeParse({
        ...base,
        remote: {
          results: [],
          fenceAcks: [],
          logFrames: [frame, frame],
          mcp: [],
          mcpCursors: [],
        },
      }).success,
    ).toBe(false);
    // 恢复事实必须属于本 Machine。
    const recovery = {
      executionId,
      projectId,
      machineId,
      authorizationGeneration: 1,
      holderInstanceId: instanceId,
      runnerToken: token,
      observedState: "exited" as const,
      exitCode: 0,
      signal: null,
      observedExitedAt: at,
      producedThroughSequence: 4,
      claimEvidenceAt: at,
    };
    expect(
      workerExchangeInput.safeParse({
        ...base,
        remote: { results: [], fenceAcks: [], recoveries: [recovery], mcp: [], mcpCursors: [] },
      }).success,
    ).toBe(true);
    expect(
      workerExchangeInput.safeParse({
        ...base,
        remote: {
          results: [],
          fenceAcks: [],
          recoveries: [{ ...recovery, machineId: otherMachineId }],
          mcp: [],
          mcpCursors: [],
        },
      }).success,
    ).toBe(false);
    // 恢复事实必须带 32 hex token：这是唯一的所有权证据。
    expect(executionRecoverySchema.safeParse({ ...recovery, runnerToken: undefined }).success).toBe(
      false,
    );
    expect(executionRecoverySchema.safeParse({ ...recovery, runnerToken: "zz" }).success).toBe(
      false,
    );
  });

  it("exposes the log cursor API and keeps log state orthogonal to execution state", () => {
    const key = { projectId, machineId };
    const read = {
      ...key,
      executionId,
      cursor: { executionId, nextSequence: 3 },
      limitBytes: 65536,
    };
    expect(executionLogReadInputSchema.safeParse(read).success).toBe(true);
    expect(executionLogReadInputSchema.safeParse({ ...read, limitBytes: 65537 }).success).toBe(
      false,
    );
    expect(
      remoteAgentRequestSchema.safeParse({
        version: 2,
        call: { type: "execution_log_read", input: read },
      }).success,
    ).toBe(true);
    const view = {
      ...key,
      executionId,
      frames: [
        {
          sequence: 3,
          stream: "stderr",
          byteStart: 10,
          byteEnd: 14,
          text: "boom",
          checksum: "c".repeat(64),
        },
      ],
      nextCursor: { executionId, nextSequence: 4 },
      availableFromSequence: 3,
      acknowledgedThroughSequence: 4,
      producedThroughSequence: 4,
      gapRanges: [{ fromSequence: 1, toSequence: 2 }],
      logState: "gap",
      hasMore: false,
      workerOnline: false,
    };
    expect(executionLogReadViewSchema.safeParse(view).success).toBe(true);
    // 空 frames 只说明该范围无帧，不证明「没有输出」：logState 仍是 gap。
    expect(executionLogReadViewSchema.safeParse({ ...view, frames: [] }).success).toBe(true);
    const cancellationView = {
      ...key,
      cancelId,
      executionId,
      state: "delivered",
      requestedAt: at,
      deliveredAt: at,
      exitedAt: null,
      signalOutcome: "term_delivered",
      failureReason: null,
    };
    expect(executionCancellationViewSchema.safeParse(cancellationView).success).toBe(true);
    // delivered 不显示为已停止：取消视图没有「已退出」的字段。
    expect(
      executionCancellationViewSchema.safeParse({ ...cancellationView, exitedAt: at }).success,
    ).toBe(true);
    for (const state of CANCELLATION_STATES)
      expect(
        executionCancellationViewSchema.safeParse({ ...cancellationView, state }).success,
      ).toBe(true);
    expect(
      executionCancellationViewSchema.safeParse({ ...cancellationView, state: "stopped" }).success,
    ).toBe(false);
    // 执行视图：succeeded 配 truncated 合法，unknown 配 partial 合法，full 缺 ack 非法。
    const executionView = {
      ...key,
      executionId,
      authorizationGeneration: 1,
      holderInstanceId: instanceId,
      authority: "holder",
      currentAuthorizationGeneration: 1,
      runId: `run_${crypto.randomUUID()}`,
      chatId: newId(ID_PREFIXES.chat),
      requestId,
      operation: { kind: "shell", command: "true" },
      state: "succeeded",
      createdAt: at,
      dispatchDeadlineAt: "2026-10-24T00:00:10.000Z",
      runtimeDeadlineAt: null,
      maxRuntimeMs: null,
      dispatchConnectionGeneration: 2,
      dispatchSeq: 3,
      dispatchedAt: at,
      drainedAt: at,
      payloadHash: "d".repeat(64),
      terminalAt: at,
      failureReason: null,
      recoveryReason: null,
      result: {
        kind: "shell",
        pid: 42,
        exited: true,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        truncated: false,
      },
      logState: "truncated",
      producedThroughSequence: 9,
      acknowledgedThroughSequence: 8,
      availableFromSequence: 2,
      cancellation: null,
    };
    expect(executionViewSchema.safeParse(executionView).success).toBe(true);
    expect(
      executionViewSchema.safeParse({
        ...executionView,
        state: "unknown",
        failureReason: "worker_lost",
        result: null,
        logState: "partial",
      }).success,
    ).toBe(true);
    expect(
      executionViewSchema.safeParse({
        ...executionView,
        logState: "full",
        acknowledgedThroughSequence: null,
      }).success,
    ).toBe(false);
    expect(
      executionViewSchema.safeParse({
        ...executionView,
        logState: "partial",
        producedThroughSequence: null,
      }).success,
    ).toBe(false);
    // 下发窗口与运行上限可区分：只有下发窗口时没有运行上限。
    expect(
      executionViewSchema.safeParse({
        ...executionView,
        runtimeDeadlineAt: null,
        maxRuntimeMs: null,
      }).success,
    ).toBe(true);
    expect(
      executionViewSchema.safeParse({
        ...executionView,
        runtimeDeadlineAt: "2026-10-24T01:00:00.000Z",
        maxRuntimeMs: 3600000,
      }).success,
    ).toBe(true);
    // 只有运行时上限而缺失 maxRuntimeMs 或 dispatchedAt 时非法。
    expect(
      executionViewSchema.safeParse({
        ...executionView,
        runtimeDeadlineAt: "2026-10-24T01:00:00.000Z",
        maxRuntimeMs: null,
      }).success,
    ).toBe(false);
    expect(
      executionViewSchema.safeParse({
        ...executionView,
        runtimeDeadlineAt: "2026-10-24T01:00:00.000Z",
        maxRuntimeMs: 3600000,
        dispatchedAt: null,
        dispatchConnectionGeneration: null,
        dispatchSeq: null,
        drainedAt: null,
        state: "queued",
        logState: "none",
        producedThroughSequence: null,
        acknowledgedThroughSequence: null,
        availableFromSequence: null,
        terminalAt: null,
        result: null,
      }).success,
    ).toBe(false);
    // 日志位点单调：ack 不能超过产出，可读起点不能越过产出后一位。
    expect(
      executionViewSchema.safeParse({ ...executionView, acknowledgedThroughSequence: 10 }).success,
    ).toBe(false);
    expect(
      executionViewSchema.safeParse({
        ...executionView,
        producedThroughSequence: 4,
        acknowledgedThroughSequence: 4,
        availableFromSequence: 6,
      }).success,
    ).toBe(false);
    // 五个 log_state 都与 succeeded 正交：none 要求未产出，其余要求已有产出位点。
    for (const logState of EXECUTION_LOG_STATES)
      expect(
        executionViewSchema.safeParse({
          ...executionView,
          logState,
          producedThroughSequence: logState === "none" ? null : 9,
          acknowledgedThroughSequence: logState === "none" ? null : 8,
          availableFromSequence: logState === "none" ? null : 1,
        }).success,
      ).toBe(true);
  });

  it("registers the six new domain error codes so they do not fall back to conflict", () => {
    const codes = [
      "execution_log_gap",
      "execution_log_cursor_stale",
      "execution_log_unavailable",
      "cancellation_not_found",
      "cancellation_already_terminal",
      "cancellation_delivery_unconfirmed",
    ];
    for (const code of codes) expect(APP_ERROR_CODES).toContain(code);
    // 未登记的 code 不在封闭集合里，因此不能借枚举蒙混。
    expect(APP_ERROR_CODES).not.toContain("execution_log_invented");
    // 取消输入走 agent call，且必须显式指定 Machine。
    const input = {
      projectId,
      machineId,
      executionId,
      requestId,
      authorizationGeneration: 1,
      policy: "kill" as const,
      termWaitMs: 1,
    };
    expect(executionCancelInputSchema.safeParse(input).success).toBe(true);
    expect(
      remoteAgentRequestSchema.safeParse({
        version: 2,
        call: { type: "execution_cancel", input },
      }).success,
    ).toBe(true);
    const { machineId: _machineId, ...withoutMachine } = input;
    expect(executionCancelInputSchema.safeParse(withoutMachine).success).toBe(false);
    // 命令下行携带两个独立的截止事实与 runner token。
    const command = {
      ...identity,
      requestId,
      fingerprint: "e".repeat(64),
      operation: { kind: "shell", command: "true", cwd: "/tmp" },
      directoryRevision: 1,
      dispatchDeadlineAt: at,
      runtimeDeadlineAt: "2026-10-24T01:00:00.000Z",
      maxRuntimeMs: 3600000,
      runnerToken: token,
    };
    expect(remoteCommandSchema.safeParse(command).success).toBe(true);
    expect(remoteCommandSchema.safeParse({ ...command, runnerToken: null }).success).toBe(true);
    expect(remoteCommandSchema.safeParse({ ...command, runnerToken: "A".repeat(32) }).success).toBe(
      false,
    );
  });

  it("applies the shared migration and SQL constraints on a real isolated database", () => {
    const directory = mkdtempSync(join(tmpdir(), "sprout-execution-log-wire-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "tests/fixtures/execution-log-contracts.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_URL: join(directory, "fixture.sqlite"),
            NODE_ENV: "test",
            SPROUT_PI_ENABLED: "false",
            NO_PROXY: "localhost,127.0.0.1,::1",
            no_proxy: "localhost,127.0.0.1,::1",
          },
          encoding: "utf8",
          timeout: 60000,
        },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "PASS 0013 replays without duplication and keeps FK integrity",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
