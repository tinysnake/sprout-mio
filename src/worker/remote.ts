import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import type { CapabilitySnapshot, DirectoryObservation } from "../contracts/machine";
import { EXECUTION_LOG_FRAMES_PER_EXCHANGE, remoteReportSchema } from "../contracts/remote";
import type {
  ExecutionLogFrame,
  RemoteCommand,
  RemoteExchangeInput,
  RemoteExchangeOutput,
  RemoteFenceAck,
  ExecutionRecovery,
  RemoteReport,
  RemoteResultPayload,
} from "../contracts/remote";
import { McpRuntime } from "./mcp";
import { ExecutionRegistry, ExecutionStore, type Run } from "./executions";
import type { WorkerSession } from "../contracts/worker-session";
import type { WorkerExchangeRemoteInput, WorkerExchangeResponse } from "../contracts/worker";

type Frame = Extract<WorkerExchangeResponse, { ok: true }>["data"];
type Outcome = Extract<RemoteReport, { phase: "terminal" }>["outcome"];
type Entry = {
  command: RemoteCommand;
  controller: AbortController;
  report: RemoteReport;
  done: boolean;
  /** 不可逆动作已经开始：下发窗口只约束准入，此后不再参与任何判定。 */
  started: boolean;
  /** waitMs 快照已被服务端收下：不再重发同一快照，等真实退出后覆盖为终态。 */
  snapshotAcked?: boolean;
};
const reportIdentity = (command: RemoteCommand) => {
  const {
    requestId: _requestId,
    operation: _operation,
    directoryRevision: _revision,
    dispatchDeadlineAt: _deadline,
    runtimeDeadlineAt: _runtimeDeadline,
    maxRuntimeMs: _maxRuntime,
    runnerToken: _runnerToken,
    ...identity
  } = command;
  return identity;
};
const sameSession = (a: WorkerSession, b: WorkerSession) =>
  a.machineId === b.machineId &&
  a.generation === b.generation &&
  a.bootId === b.bootId &&
  a.attemptId === b.attemptId;
type BoundedText = { text: string; truncated: boolean };
const MAX_EXCHANGE_BYTES = 1048576;
/** 中止路径的 TERM 宽限；到点仍未退出才 KILL。 */
const SIGNAL_GRACE_MS = 2000;
/** 中止后等待真实退出事件的上限；到点只报运行态，不伪造终态。 */
const EXIT_OBSERVATION_MS = 5000;
export const emptyWorkerRemote = (): WorkerExchangeRemoteInput => ({
  results: [],
  fenceAcks: [],
  mcp: [],
  mcpCursors: [],
});
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
// Decoding invalid input can expand it; bound the encoded text as well as the raw input.
function boundedText(buffer: Buffer, limit: number): BoundedText {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const decoded = decoder.decode(buffer.subarray(0, limit), { stream: true });
  const incomplete = decoder.decode().length > 0;
  const encoded = Buffer.from(decoded.replaceAll("\0", ""), "utf8");
  return {
    text: new TextDecoder().decode(encoded.subarray(0, limit), { stream: true }),
    truncated:
      buffer.length > limit || encoded.length > limit || incomplete || decoded.includes("\0"),
  };
}
function degradedReport(
  report: Extract<RemoteReport, { phase: "terminal" }>,
  minimal = false,
): RemoteReport {
  const original = "failureReason" in report.payload ? report.payload.partial : report.payload;
  let partial = original;
  if (original?.kind === "shell") {
    partial = {
      ...original,
      stdout: minimal ? "" : boundedText(Buffer.from(original.stdout), 65536).text,
      stderr: minimal ? "" : boundedText(Buffer.from(original.stderr), 8192).text,
      truncated: true,
    };
  } else if (original?.kind === "file_read") {
    // Leave room for worst-case JSON escaping and the rest of the exchange envelope.
    partial = {
      ...original,
      content: minimal ? "" : boundedText(Buffer.from(original.content), 65536).text,
      truncated: true,
    };
  } else if (original?.kind === "process_list") {
    partial = {
      ...original,
      items: minimal
        ? []
        : original.items.slice(0, 200).map((item) => ({
            ...item,
            command: boundedText(Buffer.from(item.command), 256).text,
          })),
      truncated: true,
    };
  }
  const failure = {
    ...report,
    outcome: "failed" as const,
    payload: {
      kind: report.payload.kind,
      failureReason: "executor_error" as const,
      ...(partial ? { partial } : {}),
    },
  };
  return remoteReportSchema.safeParse(failure).success
    ? failure
    : { ...failure, payload: { kind: report.payload.kind, failureReason: "executor_error" } };
}
class AdmissionError extends Error {
  constructor(
    readonly reason:
      | "stale_generation"
      | "authorization_revoked"
      | "deadline"
      | "directory_unavailable"
      | "capability_unavailable",
  ) {
    super(reason);
  }
}
type SignalOutcome = "term_delivered" | "kill_delivered" | "none";
/** 先 TERM 整个进程组，宽限后 KILL；只报告 OS 是否接受信号调用。 */
function terminateGroup(pid: number, policy: "term_then_kill" | "kill", graceMs: number) {
  if (policy === "kill") {
    try {
      process.kill(-pid, "SIGKILL");
      return "kill_delivered" as SignalOutcome;
    } catch {
      return "none" as SignalOutcome;
    }
  }
  let outcome: SignalOutcome = "none";
  try {
    process.kill(-pid, "SIGTERM");
    outcome = "term_delivered";
  } catch {
    return outcome;
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // 进程组已经消失：TERM 够用，不补 KILL。
    }
  }, graceMs).unref();
  return outcome;
}
/**
 * One dispatcher per connection; a closed session can drain but never regain admission.
 * 执行与连接代次、租约、会话都独立：断联只解除本会话的投递，不终止子进程。
 * 只有运行上限、撤权、fence 与显式取消会发信号。
 */
export class RemoteDispatcher {
  private highWater = 0;
  private closed = false;
  private authorizations = new Map<string, RemoteExchangeOutput["authorizations"][number]>();
  private entries = new Map<string, Entry>();
  private seen = new Map<string, RemoteCommand>();
  private fences = new Map<string, RemoteFenceAck>();
  private configuration: Frame["configuration"] = null;
  private observations: DirectoryObservation[] = [];
  private frames: ExecutionLogFrame[] = [];
  private pendingRecoveries: ExecutionRecovery[] = [];
  readonly registry: ExecutionRegistry;
  constructor(
    readonly session: WorkerSession,
    private capability: CapabilitySnapshot,
    private now: () => number,
    private mcp: McpRuntime = new McpRuntime(),
    registry?: ExecutionRegistry,
  ) {
    // 时钟只有一个来源：注入的 `now`。不在这里就地读墙钟，见 docs/architecture-direction.md。
    this.registry = registry ?? new ExecutionRegistry(new ExecutionStore(), () => this.now());
    this.mcp.bind(session);
    // 进程重启后的遗留执行：装回 claim 与未确认帧，再由恢复事实与日志帧交代。
    this.registry.restore();
  }
  get admissionClosed() {
    return this.closed;
  }
  get drained() {
    return (
      [...this.entries.values()].every((entry) => entry.done) &&
      this.fences.size === 0 &&
      this.entries.size === 0 &&
      this.mcp.drained
    );
  }
  disconnect() {
    this.closed = true;
    this.mcp.disconnect();
    // 断联只关闭准入：已经开始执行的命令继续运行并保留终态报告，重连后由 durable 上行补送。
    // 只有尚未开始的准入被撤销；子进程本身从不因断联收到信号。
    for (const entry of this.entries.values())
      if (!entry.done && !entry.started) entry.controller.abort();
  }
  rejectReports(batch: RemoteExchangeInput) {
    for (const report of batch.results) {
      const entry = this.entries.get(report.executionId);
      if (entry?.report.phase === "terminal") entry.report = degradedReport(entry.report, true);
    }
    this.registry.releaseAllInflight();
    this.frames = [];
    // 被拒的 exchange 没有送到宿主：恢复事实与日志帧都要在下一轮重报。
    this.registry.forgetReported(this.session.attemptId);
    this.pendingRecoveries = [];
  }
  /**
   * `maxBytes` 是本批上行体积上限。日志帧不要求等于本批序号：帧的 `dispatchSeq` 是该执行的
   * **命令下发序号**，归属由服务端 `applyLogFrames` 按 `row.dispatchSeq` 权威核对。
   */
  outgoing(maxBytes = MAX_EXCHANGE_BYTES): WorkerExchangeRemoteInput {
    const batch = emptyWorkerRemote();
    const mcp = this.mcp.outgoing(Math.min(maxBytes, this.highWater % 2 ? 65536 : 655360));
    batch.mcp = mcp.mcp;
    batch.mcpCursors = mcp.mcpCursors;
    let used = jsonBytes(batch);
    const entries = [...this.entries.values()].sort(
      (a, b) =>
        a.command.dispatchSeq - b.command.dispatchSeq ||
        (a.command.executionId < b.command.executionId
          ? -1
          : a.command.executionId === b.command.executionId
            ? 0
            : 1),
    );
    for (const entry of entries) {
      if (batch.results.length === 64) break;
      // 快照已经确认：它只用于让工具面看到 pid，终态报告在真实退出后单独发。
      if (entry.snapshotAcked && !entry.done) continue;
      if (
        entry.report.phase === "terminal" &&
        (!remoteReportSchema.safeParse(entry.report).success ||
          jsonBytes(entry.report) + jsonBytes({ results: [], fenceAcks: [] }) > maxBytes)
      )
        entry.report = degradedReport(entry.report);
      if (
        entry.report.phase === "terminal" &&
        jsonBytes(entry.report) + jsonBytes({ results: [], fenceAcks: [] }) > maxBytes
      )
        entry.report = degradedReport(entry.report, true);
      const cost = jsonBytes(entry.report) + (batch.results.length ? 1 : 0);
      if (used + cost > maxBytes) break;
      batch.results.push(entry.report);
      used += cost;
    }
    const fences = [...this.fences.values()].sort((a, b) =>
      a.mutationId < b.mutationId ? -1 : a.mutationId === b.mutationId ? 0 : 1,
    );
    for (const ack of fences) {
      if (batch.fenceAcks.length === 64) break;
      if (!ack.executionIds.every((id) => !this.entries.has(id) || this.entries.get(id)!.done))
        continue;
      const ordered = { ...ack, executionIds: [...ack.executionIds].sort() };
      const cost = jsonBytes(ordered) + (batch.fenceAcks.length ? 1 : 0);
      if (used + cost > maxBytes) break;
      batch.fenceAcks.push(ordered);
      used += cost;
    }
    // 恢复事实只带宿主认可过的 token，体积小且不可延后；放在 fence 与终端报告之后。
    const recoveries = [];
    for (const recovery of this.registry.pendingRecoveries(this.session, 8)) {
      const cost = jsonBytes(recovery) + (recoveries.length ? 1 : 0);
      if (used + cost > maxBytes) break;
      recoveries.push(recovery);
      used += cost;
    }
    if (recoveries.length) {
      batch.recoveries = recoveries;
      this.pendingRecoveries = recoveries;
    }
    // 日志帧最后使用剩余预算：fence、终端报告与恢复事实先占位，日志不得饿死它们。
    this.frames = [];
    for (const { run, frame } of this.registry.rotate(
      this.session,
      EXECUTION_LOG_FRAMES_PER_EXCHANGE,
    )) {
      if (this.frames.length === EXECUTION_LOG_FRAMES_PER_EXCHANGE) break;
      // 帧归属于「宿主下发这条命令的那一次投递」，不是承载本批的 exchange。
      // 没有对应 entry 就没有可信的下发序号，不发帧，由恢复事实交代。
      const dispatchSeq = this.entries.get(run.claim.executionId)?.command.dispatchSeq;
      if (dispatchSeq === undefined) continue;
      const wire: ExecutionLogFrame = {
        executionId: run.claim.executionId,
        projectId: run.claim.projectId,
        machineId: run.claim.machineId,
        authorizationGeneration: run.claim.authorizationGeneration,
        holderInstanceId: run.claim.holderInstanceId,
        dispatchSession: this.session,
        dispatchSeq,
        sequence: frame.sequence,
        stream: frame.stream,
        byteStart: frame.byteStart,
        byteEnd: frame.byteEnd,
        checksum: frame.checksum,
        ...(frame.bytes === undefined ? { gapTo: frame.gapTo } : { bytes: frame.bytes }),
      };
      const cost = jsonBytes(wire) + (this.frames.length ? 1 : 0);
      if (used + cost > maxBytes) break;
      this.frames.push(wire);
      used += cost;
    }
    if (this.frames.length) batch.logFrames = [...this.frames];
    return batch;
  }
  accept(frame: Frame, expectedSeq: number, observations: DirectoryObservation[]) {
    if (
      !sameSession(frame.session, this.session) ||
      frame.seq !== expectedSeq ||
      frame.seq < this.highWater
    )
      throw new AdmissionError("stale_generation");
    if (frame.seq === this.highWater) return; // Original-frame retry is acknowledgement only.
    this.highWater = frame.seq;
    // 上一批已经随 exchange 送到宿主：恢复事实与日志帧的签名此刻才生效。
    this.registry.markRecovered(this.session, this.pendingRecoveries);
    this.pendingRecoveries = [];
    // 送达即解除在途标记：未 ACK 的帧仍留在队列里，下一轮重发。
    this.registry.releaseAllInflight();
    this.frames = [];
    for (const fence of frame.remote.fences) {
      if (fence.machineId !== this.session.machineId) throw new AdmissionError("stale_generation");
      const old = this.authorizations.get(fence.projectId);
      if (old && old.generation === fence.authorizationGeneration)
        this.authorizations.set(fence.projectId, { ...old, state: "draining" });
      const current = this.fences.get(fence.mutationId);
      this.fences.set(fence.mutationId, {
        ...fence,
        executionIds: [...new Set([...(current?.executionIds ?? []), ...fence.executionIds])],
        dispatchSession: this.session,
      });
      for (const entry of this.entries.values())
        if (
          entry.command.projectId === fence.projectId &&
          entry.command.authorizationGeneration <= fence.authorizationGeneration &&
          !entry.done
        )
          // 租约动作不终止进程、不删文件：只让旧代次不能声称成功。
          // 进程存活是 P4a/P4b 已确认的代价条款，P4c 不回退。
          entry.controller.abort();
    }
    for (const auth of frame.remote.authorizations) {
      if (auth.machineId !== this.session.machineId) throw new AdmissionError("stale_generation");
      const old = this.authorizations.get(auth.projectId);
      if (
        old &&
        (auth.generation < old.generation ||
          (auth.generation === old.generation &&
            old.state === "draining" &&
            auth.state === "active"))
      )
        continue;
      this.authorizations.set(auth.projectId, auth);
      for (const entry of this.entries.values())
        if (
          !entry.done &&
          entry.command.projectId === auth.projectId &&
          (auth.generation !== entry.command.authorizationGeneration ||
            auth.state !== "active" ||
            auth.holderInstanceId !== entry.command.holderInstanceId)
        )
          // 撤权同样不终止进程，也不删文件；只是让本次投递不能声称成功。
          entry.controller.abort();
    }
    for (const ack of frame.remote.resultAcks) {
      const entry = this.entries.get(ack.executionId);
      if (
        entry &&
        !entry.done &&
        entry.report.phase === "terminal" &&
        !("failureReason" in entry.report.payload) &&
        entry.report.payload.kind === "shell" &&
        !entry.report.payload.exited
      ) {
        entry.snapshotAcked = true;
        continue;
      }
      this.entries.delete(ack.executionId);
      this.registry.settle(ack.executionId);
    }
    for (const ack of frame.remote.fenceAcks) {
      const pending = this.fences.get(ack.mutationId);
      if (pending) {
        pending.executionIds = pending.executionIds.filter((id) => !ack.executionIds.includes(id));
        if (pending.executionIds.length === 0) this.fences.delete(ack.mutationId);
      }
    }
    for (const ack of frame.remote.logAcks ?? [])
      this.registry.acknowledge(
        ack.executionId,
        ack.acknowledgedThroughSequence,
        ack.availableFromSequence,
      );
    for (const cancellation of frame.remote.cancellations ?? []) {
      if (
        this.registry.runs.get(cancellation.executionId)?.claim.runnerToken !==
        cancellation.runnerToken
      )
        continue;
      this.entries.get(cancellation.executionId)?.controller.abort();
      this.signal(cancellation.executionId, cancellation.policy, cancellation.termWaitMs);
    }
    this.mcp.accept(frame.remote.mcp, frame.remote.mcpCursors, frame.remote.authorizations);
    if (frame.mode === "drain") {
      this.disconnect();
      return;
    }
    this.configuration = frame.configuration;
    this.observations = observations;
    for (const command of frame.remote.commands) {
      if (
        command.machineId !== this.session.machineId ||
        !sameSession(command.dispatchSession, this.session) ||
        command.dispatchSeq !== frame.seq
      )
        throw new AdmissionError("stale_generation");
      const seen = this.seen.get(command.executionId);
      if (seen) {
        if (JSON.stringify(seen) !== JSON.stringify(command))
          throw new AdmissionError("stale_generation");
        continue;
      }
      this.seen.set(command.executionId, command);
      const run = this.registry.create(command);
      const {
        requestId: _requestId,
        operation: _operation,
        directoryRevision: _revision,
        dispatchDeadlineAt: _deadline,
        runtimeDeadlineAt: _runtimeDeadline,
        maxRuntimeMs: _maxRuntime,
        runnerToken: _runnerToken,
        ...identity
      } = command;
      if (run.done || run.started) {
        // 上次进程已经跑过这条执行：不重跑，交给恢复事实交代。
        continue;
      }
      const entry: Entry = {
        command,
        controller: run.controller,
        done: false,
        started: false,
        report: { ...identity, phase: "running", drained: false },
      };
      this.entries.set(command.executionId, entry);
      // Registration is synchronous; side effects begin after the entire frame has closed gates.
      void Promise.resolve().then(() => this.execute(entry, run));
    }
  }
  /** 只在中止路径上发信号：命令由信号而停，取消或撤权不伪装成自然退出。 */
  private signal(executionId: string, policy: "term_then_kill" | "kill", graceMs: number) {
    const run = this.registry.runs.get(executionId);
    if (!run || run.claim.pid === 0 || run.exited) return "none" as SignalOutcome;
    run.terminated = true;
    return terminateGroup(run.claim.pid, policy, graceMs);
  }
  private gate(entry: Entry) {
    const command = entry.command;
    // 断联只关闭准入：已开始的执行仍可交出真实终态，授权由服务端边界再核对。
    if (entry.controller.signal.aborted || (this.closed && !entry.started))
      throw new AdmissionError("authorization_revoked");
    const auth = this.authorizations.get(command.projectId);
    if (
      command.machineId !== this.session.machineId ||
      !sameSession(command.dispatchSession, this.session) ||
      command.dispatchSeq > this.highWater ||
      !auth ||
      auth.generation !== command.authorizationGeneration
    )
      throw new AdmissionError("stale_generation");
    if (auth.state !== "active" || auth.holderInstanceId !== command.holderInstanceId)
      throw new AdmissionError("authorization_revoked");
    if (Date.parse(command.dispatchDeadlineAt) <= this.now() && !entry.started)
      throw new AdmissionError("deadline");
    if (!this.capability.remoteOperations.includes(command.operation.kind))
      throw new AdmissionError("capability_unavailable");
    if (
      command.directoryRevision !== null &&
      (this.configuration?.rootRevision !== command.directoryRevision ||
        !this.observations.some(
          (observation) =>
            observation.projectId === command.projectId &&
            observation.revision === command.directoryRevision &&
            observation.result.kind === "accessible" &&
            command.operation.kind === "shell" &&
            observation.result.realPath === command.operation.cwd,
        ))
    )
      throw new AdmissionError("directory_unavailable");
  }
  private async execute(entry: Entry, run: Run) {
    let outcome: Outcome = "succeeded";
    let payload: RemoteResultPayload | undefined;
    const operation = entry.command.operation;
    // 下发窗口只约束「能否开始执行」：准入兑现后立即解除，运行寿命只看运行上限与显式取消。
    const admission = setTimeout(
      () => {
        if (!entry.started) entry.controller.abort();
      },
      Math.max(0, Date.parse(entry.command.dispatchDeadlineAt) - this.now()),
    );
    let runtimeLimit: ReturnType<typeof setTimeout> | undefined;
    try {
      this.gate(entry);
      if (operation.kind === "shell") {
        const shell = this.capability.shells.find((shell) => shell.probe.kind === "success");
        if (!shell) throw new AdmissionError("capability_unavailable");
        this.gate(entry);
        const child = spawn(shell.path, ["-lc", operation.command], {
          cwd: operation.cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        entry.started = true;
        clearTimeout(admission);
        child.unref();
        let exitCode: number | null = null,
          exitSignal: string | null = null,
          exited = false,
          truncated = false,
          stdout = Buffer.alloc(0),
          stderr = Buffer.alloc(0);
        const retain = (chunk: Buffer, stream: "stdout" | "stderr") => {
          const cap = stream === "stdout" ? 65536 : 8192;
          const old = stream === "stdout" ? stdout : stderr;
          if (old.length + chunk.length > cap) truncated = true;
          const next = Buffer.concat([old, chunk.subarray(0, Math.max(0, cap - old.length))]);
          if (stream === "stdout") stdout = next;
          else stderr = next;
        };
        // 终态确立后仍继续消费管道（不关闭、不发信号），但不再产新帧。
        child.stdout.on("data", (chunk: Buffer) => {
          retain(chunk, "stdout");
          if (run.collecting) run.log.append("stdout", chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          retain(chunk, "stderr");
          if (run.collecting) run.log.append("stderr", chunk);
        });
        run.log.bind({ stdout: child.stdout, stderr: child.stderr });
        // 子进程管道不保持 Worker 存活：Worker 退出后命令继续跑，帧留给 durable outbox 与恢复事实。
        for (const pipe of [child.stdout, child.stderr])
          (pipe as unknown as { unref?: () => void }).unref?.();
        const exitedEvent = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => {
            exited = true;
            exitCode = code;
            exitSignal = signal;
            this.registry.markExit(run, code, signal);
            resolve();
          });
        });
        if (child.pid !== undefined) this.registry.markSpawned(run, child.pid);
        // 运行上限只对「已开始执行」生效；null 表示没有运行上限，寿命由退出或显式取消决定。
        const runtimeDeadline =
          entry.command.runtimeDeadlineAt === null
            ? null
            : Date.parse(entry.command.runtimeDeadlineAt);
        if (runtimeDeadline !== null)
          runtimeLimit = setTimeout(
            () => {
              if (run.exited) return;
              run.terminated = true;
              if (run.claim.pid !== 0)
                terminateGroup(run.claim.pid, "term_then_kill", SIGNAL_GRACE_MS);
            },
            Math.max(0, runtimeDeadline - this.now()),
          );
        const aborted = new Promise<"aborted">((resolve) => {
          if (entry.controller.signal.aborted) resolve("aborted");
          else
            entry.controller.signal.addEventListener("abort", () => resolve("aborted"), {
              once: true,
            });
        });
        // waitMs 只决定何时交出一次「仍在运行」的观察，不决定终态：短操作在窗口内退出时
        // 行为不变；超过窗口仍在运行的命令继续采集日志并保持 running，直到退出、运行上限或取消。
        const waitWindow = new Promise<"waited">((resolve) =>
          setTimeout(() => resolve("waited"), Math.max(0, operation.waitMs)),
        );
        const firstSignal = await Promise.race([
          exitedEvent.then(() => "exited" as const),
          aborted,
          waitWindow,
        ]);
        // 窗口到点交一张「已启动」快照：pid 与当前输出给工具面，但执行不落终态、
        // 采集不停止；真实退出后同一 entry 的报告覆盖为终态。
        if (firstSignal === "waited") {
          run.log.flush();
          entry.report = {
            ...reportIdentity(entry.command),
            phase: "terminal",
            drained: true,
            outcome: "succeeded",
            payload: {
              kind: "shell",
              pid: child.pid!,
              exited: false,
              exitCode: null,
              stdout: boundedText(stdout, 65536).text,
              stderr: boundedText(stderr, 8192).text,
              truncated,
            },
          };
        }
        // 已经退出时走终态推导；仍在运行就继续等真实退出或中止。
        const waited =
          firstSignal === "waited"
            ? await Promise.race([exitedEvent.then(() => "exited" as const), aborted])
            : firstSignal;
        if (exited) run.log.flush();
        else if (waited === "aborted") {
          // 只有运行上限与显式取消会发信号；租约、fence 与断联只撤销本次投递，不杀进程，
          // 也不删除文件。被信号中止后必须等真实退出事件才算停止。
          if (!run.terminated) throw new AdmissionError("authorization_revoked");
          await Promise.race([
            exitedEvent.catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, EXIT_OBSERVATION_MS)),
          ]);
          if (!exited) {
            // 信号已发出但没有观测到退出：不写终态，留给恢复事实与日志读取交代。
            const {
              requestId: _requestId,
              operation: _operation,
              directoryRevision: _revision,
              dispatchDeadlineAt: _deadline,
              runtimeDeadlineAt: _runtimeDeadline,
              maxRuntimeMs: _maxRuntime,
              runnerToken: _runnerToken,
              ...identity
            } = entry.command;
            run.collecting = false;
            entry.report = { ...identity, phase: "running", drained: false };
            return;
          }
          run.log.flush();
        }
        if (exited) {
          const output = boundedText(stdout, 65536);
          const errorOutput = boundedText(stderr, 8192);
          payload = {
            kind: "shell",
            pid: child.pid!,
            exited: true,
            exitCode: exitCode ?? (exitSignal ? 128 : 1),
            stdout: output.text,
            stderr: errorOutput.text,
            truncated: truncated || output.truncated || errorOutput.truncated,
          };
          const overRuntime =
            runtimeDeadline !== null &&
            run.terminated &&
            this.now() >= runtimeDeadline - SIGNAL_GRACE_MS;
          if (overRuntime) {
            // 运行上限到期：终态是限时，不是下发窗口到期。
            outcome = "timed_out";
            payload = { kind: "shell", failureReason: "deadline", partial: payload };
          } else if (run.terminated || entry.controller.signal.aborted) {
            outcome = "unknown";
            payload = { kind: "shell", failureReason: "authorization_revoked", partial: payload };
          } else if (exitCode !== 0) {
            outcome = "failed";
            payload = { kind: "shell", failureReason: "executor_error", partial: payload };
          }
        }
      } else if (operation.kind === "file_read") {
        this.gate(entry);
        const file = await open(operation.path, "r");
        entry.started = true;
        clearTimeout(admission);
        try {
          this.gate(entry);
          const buffer = Buffer.alloc(operation.maxBytes + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const content = boundedText(buffer.subarray(0, bytesRead), operation.maxBytes);
          payload = {
            kind: "file_read",
            content: content.text,
            truncated: content.truncated,
          };
        } finally {
          await file.close();
        }
      } else if (operation.kind === "file_write") {
        this.gate(entry);
        const file = await open(operation.path, operation.mode === "append" ? "a" : "w");
        entry.started = true;
        clearTimeout(admission);
        try {
          this.gate(entry);
          await file.writeFile(operation.content, "utf8");
          payload = { kind: "file_write", bytesWritten: Buffer.byteLength(operation.content) };
        } finally {
          await file.close();
        }
      } else if (operation.kind === "process_signal") {
        this.gate(entry);
        process.kill(operation.pid, `SIG${operation.signal}`);
        entry.started = true;
        clearTimeout(admission);
        payload = { ...operation, delivered: true };
      } else {
        this.gate(entry);
        const child = spawn("/bin/ps", ["-axo", "pid=,comm="], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        entry.started = true;
        clearTimeout(admission);
        let buffer = Buffer.alloc(0),
          truncated = false;
        child.stdout.on("data", (chunk: Buffer) => {
          if (buffer.length + chunk.length > 262144) truncated = true;
          buffer = Buffer.concat([buffer, chunk.subarray(0, Math.max(0, 262144 - buffer.length))]);
        });
        child.stderr.resume();
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve() : reject(new Error("executor_error")),
          );
        });
        const items = buffer
          .toString("utf8")
          .split("\n")
          .flatMap((line) => {
            const match = /^\s*(\d+)\s+(.+)$/.exec(line);
            if (!match) return [];
            const command = boundedText(Buffer.from(match[2]), 1024);
            truncated ||= command.truncated;
            return [{ pid: Number(match[1]), command: command.text }];
          });
        payload = {
          kind: "process_list",
          items: items.slice(0, operation.limit),
          truncated: truncated || items.length > operation.limit,
        };
      }
      this.gate(entry); // No success can escape a revoked gate, even after an irreversible OS call.
    } catch (error) {
      const reason =
        error instanceof AdmissionError
          ? error.reason
          : entry.controller.signal.aborted
            ? "authorization_revoked"
            : "executor_error";
      const admissionExpired =
        !entry.started && this.now() >= Date.parse(entry.command.dispatchDeadlineAt);
      const runtimeExpired =
        entry.command.runtimeDeadlineAt !== null &&
        this.now() >= Date.parse(entry.command.runtimeDeadlineAt);
      outcome = admissionExpired
        ? "timed_out"
        : runtimeExpired
          ? entry.started
            ? "timed_out"
            : "rejected"
          : reason === "executor_error"
            ? "failed"
            : entry.started && reason === "authorization_revoked"
              ? "unknown"
              : "rejected";
      payload = {
        kind: operation.kind,
        failureReason: admissionExpired || runtimeExpired ? "deadline" : reason,
      };
    } finally {
      clearTimeout(admission);
      if (runtimeLimit) clearTimeout(runtimeLimit);
    }
    if (payload === undefined) {
      // 任何走到终态的路径都必须有结果载荷；没有就是执行器错误，不是成功。
      outcome = "failed";
      payload = { kind: operation.kind, failureReason: "executor_error" };
    }
    entry.done = true;
    entry.snapshotAcked = false;
    run.collecting = false;
    entry.report = {
      ...reportIdentity(entry.command),
      phase: "terminal",
      drained: true,
      outcome,
      payload,
    };
    this.registry.finish(run);
  }
}
