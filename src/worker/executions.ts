import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { ExecutionRecovery, RemoteCommand } from "../contracts/remote";
import type { WorkerSession } from "../contracts/worker-session";
import { ExecutionLog, type LogFrameDraft } from "./execution-log";

/** 一次执行的 durable claim。进程重启后，只有这里的事实可以用来报告恢复状态。 */
export type DurableClaim = {
  executionId: string;
  projectId: string;
  machineId: string;
  authorizationGeneration: number;
  holderInstanceId: string;
  fingerprint: string;
  runnerToken: string | null;
  /** 0 表示从未真正 spawn 出子进程；此时恢复只能报 unknown。 */
  pid: number;
  claimedAt: number;
  exitedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  producedThroughSequence: number | null;
};
export type Run = {
  claim: DurableClaim;
  log: ExecutionLog;
  controller: AbortController;
  started: boolean;
  /** 本次生命周期内的执行逻辑已收敛；不代表宿主已确认终态。 */
  done: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  exitedAt: number | null;
  /** 运行上限、撤权、fence 或取消触发过信号：不伪装成自然退出。 */
  terminated: boolean;
  /** 本会话已报过的恢复事实签名，避免每帧重复上报。 */
  reported: Map<string, string>;
  /** 还在为本次执行产新帧；终态确立后停止采集，但队列里未确认的帧仍要上行。 */
  collecting: boolean;
  /** 已上行但尚未被 ACK 的序号，重发前不选第二次。 */
  inflight: Set<number>;
  /** 下发该执行的会话 attemptId；null 表示上次进程遗留。 */
  owningAttempt: string | null;
  /** 轮转顺序，保证多执行之间不互相饿死。 */
  order: number;
};
const claimLine = (claim: DurableClaim) => JSON.stringify(claim);
const frameLine = (executionId: string, frame: LogFrameDraft) =>
  `${JSON.stringify({ executionId, ...frame })}\n`;
function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
function writePrivate(path: string, content: string) {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}
function remove(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // 不存在即目标状态。
  }
}
/**
 * Worker 侧 outbox：claim 与日志帧都落盘，宿主 ACK 前不删。
 * 它不做裁剪决策；可读起点 `availableFromSequence` 只由宿主给。
 */
export class ExecutionStore {
  constructor(private readonly directory?: string) {}
  private executionDirectory(executionId: string) {
    const path = join(this.directory!, "executions", executionId);
    privateDirectory(path);
    return path;
  }
  claims(): DurableClaim[] {
    if (!this.directory) return [];
    const root = join(this.directory, "executions");
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((executionId) => {
      const path = join(root, executionId, "claim.json");
      if (!existsSync(path)) return [];
      try {
        return [JSON.parse(readFileSync(path, "utf8")) as DurableClaim];
      } catch {
        return [];
      }
    });
  }
  frames(executionId: string): LogFrameDraft[] {
    if (!this.directory) return [];
    const path = join(this.directory, "executions", executionId, "frames.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const parsed = JSON.parse(line) as LogFrameDraft & { executionId: string };
          const { executionId: _ignored, ...frame } = parsed;
          return [frame];
        } catch {
          return [];
        }
      });
  }
  saveClaim(claim: DurableClaim) {
    if (!this.directory) return;
    const directory = this.executionDirectory(claim.executionId);
    const temporary = join(directory, "claim.tmp");
    writePrivate(temporary, claimLine(claim));
    renameSync(temporary, join(directory, "claim.json"));
  }
  deleteClaim(executionId: string) {
    if (!this.directory) return;
    const directory = join(this.directory, "executions", executionId);
    remove(join(directory, "claim.json"));
    remove(join(directory, "frames.jsonl"));
  }
  appendFrame(executionId: string, frame: LogFrameDraft) {
    if (!this.directory) return;
    const path = join(this.executionDirectory(executionId), "frames.jsonl");
    if (!existsSync(path)) writePrivate(path, "");
    const handle = openSync(path, "a", 0o600);
    try {
      writeSync(handle, frameLine(executionId, frame));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  }
  /** 只按宿主已确认前缀清理；`availableFrom` 之前的帧宿主已裁剪，不再重发。 */
  prune(executionId: string, acknowledgedThrough: number, availableFrom: number | null) {
    if (!this.directory) return;
    const directory = join(this.directory, "executions", executionId);
    const path = join(directory, "frames.jsonl");
    if (!existsSync(path)) return;
    const kept = this.frames(executionId).filter(
      (frame) =>
        frame.sequence > acknowledgedThrough &&
        (availableFrom === null || frame.sequence >= availableFrom),
    );
    const temporary = join(directory, "frames.tmp");
    writePrivate(
      temporary,
      kept.map((frame) => frameLine(executionId, frame)).join(""),
    );
    renameSync(temporary, path);
  }
}
/** 只报真实观测：进程不存在但本机没有退出事实时是 unknown，不是 exited。 */
const observed = (run: Run): ExecutionRecovery["observedState"] => {
  if (run.exited) return "exited";
  if (run.claim.pid === 0) return "unknown";
  try {
    process.kill(run.claim.pid, 0);
    return "running";
  } catch {
    return "unknown";
  }
};
const commandFor = (claim: DurableClaim, session: WorkerSession): RemoteCommand => ({
  executionId: claim.executionId,
  projectId: claim.projectId,
  machineId: claim.machineId,
  authorizationGeneration: claim.authorizationGeneration,
  holderInstanceId: claim.holderInstanceId,
  requestId: claim.executionId,
  fingerprint: claim.fingerprint,
  dispatchSession: session,
  dispatchSeq: 1,
  operation: { kind: "shell", command: "", cwd: "/", waitMs: 0 },
  directoryRevision: null,
  dispatchDeadlineAt: new Date(0).toISOString(),
  runtimeDeadlineAt: null,
  maxRuntimeMs: null,
  runnerToken: claim.runnerToken,
});
/** 上次进程留下的 claim 形状的只读视图，用于登记遗留执行而不重跑。 */
export const restoredCommand = commandFor;
/**
 * 进程级执行登记表。执行与租约、会话、连接代次都独立：换会话不影响子进程，
 * 新会话只能通过带 token 的恢复事实与日志帧描述遗留执行。
 */
export class ExecutionRegistry {
  readonly runs = new Map<string, Run>();
  private rotation = 0;
  constructor(
    readonly store: ExecutionStore,
    private readonly now: () => number,
  ) {}
  /** 把上次进程留下的 claim 与未确认帧装回来。 */
  restore() {
    for (const claim of this.store.claims()) {
      if (this.runs.has(claim.executionId)) continue;
      const log = new ExecutionLog();
      log.restore(this.store.frames(claim.executionId));
      this.runs.set(claim.executionId, {
        claim,
        log,
        controller: new AbortController(),
        started: claim.pid !== 0,
        done: claim.exitedAt !== null,
        exited: claim.exitedAt !== null,
        exitCode: claim.exitCode,
        signal: claim.signal,
        exitedAt: claim.exitedAt,
        terminated: false,
        collecting: false,
        reported: new Map(),
        inflight: new Set(),
        owningAttempt: null,
        order: this.runs.size,
      });
    }
  }
  create(command: RemoteCommand): Run {
    const existing = this.runs.get(command.executionId);
    if (existing) return existing;
    const claim: DurableClaim = {
      executionId: command.executionId,
      projectId: command.projectId,
      machineId: command.machineId,
      authorizationGeneration: command.authorizationGeneration,
      holderInstanceId: command.holderInstanceId,
      fingerprint: command.fingerprint,
      runnerToken: command.runnerToken,
      pid: 0,
      claimedAt: this.now(),
      exitedAt: null,
      exitCode: null,
      signal: null,
      producedThroughSequence: null,
    };
    this.store.saveClaim(claim);
    const run: Run = {
      claim,
      log: new ExecutionLog((frame) => this.store.appendFrame(command.executionId, frame)),
      controller: new AbortController(),
      started: false,
      done: false,
      exited: false,
      exitCode: null,
      signal: null,
      exitedAt: null,
      terminated: false,
      collecting: true,
      reported: new Map(),
      inflight: new Set(),
      owningAttempt: command.dispatchSession.attemptId,
      order: this.runs.size,
    };
    this.runs.set(command.executionId, run);
    return run;
  }
  /** 子进程真实存在之后才写 pid：此前恢复只能报 unknown，不能猜。 */
  markSpawned(run: Run, pid: number) {
    run.started = true;
    run.claim.pid = pid;
    this.store.saveClaim(run.claim);
  }
  markExit(run: Run, code: number | null, signal: string | null) {
    if (this.runs.get(run.claim.executionId) !== run) return; // 已被宿主确认终态，不要再复活 claim。
    run.exited = true;
    run.exitCode = code;
    run.signal = signal;
    run.exitedAt = this.now();
    run.claim.exitCode = code;
    run.claim.signal = signal;
    run.claim.exitedAt = run.exitedAt;
    this.saveProgress(run);
  }
  finish(run: Run) {
    if (this.runs.get(run.claim.executionId) !== run) return;
    run.done = true;
    this.saveProgress(run);
  }
  private saveProgress(run: Run) {
    run.claim.producedThroughSequence = run.log.producedThrough > 0 ? run.log.producedThrough : null;
    this.store.saveClaim(run.claim);
  }
  /** 宿主 ACK 只推进已落盘前缀：确认的帧删除，在途未确认的帧下一轮重发。 */
  acknowledge(executionId: string, through: number, availableFrom: number | null) {
    const run = this.runs.get(executionId);
    if (!run) return;
    run.log.acknowledge(through, availableFrom);
    for (const sequence of [...run.inflight]) if (sequence <= through) run.inflight.delete(sequence);
    this.store.prune(executionId, through, availableFrom);
  }
  /** 恢复事实真正随 exchange 出去之后才记签名：没送到的下一轮必须重报。 */
  markRecovered(session: WorkerSession, facts: readonly ExecutionRecovery[]) {
    for (const fact of facts) {
      const run = this.runs.get(fact.executionId);
      if (!run) continue;
      run.reported.set(
        session.attemptId,
        `${fact.observedState}:${run.exitedAt ?? ""}:${run.log.producedThrough}`,
      );
    }
  }
  markInflight(executionId: string, sequences: readonly number[]) {
    const run = this.runs.get(executionId);
    if (!run) return;
    for (const sequence of sequences) run.inflight.add(sequence);
  }
  /** 送达或拒收后，本批帧回到「可再发」状态；只有 ACK 才从队列里删除。 */
  releaseAllInflight() {
    for (const run of this.runs.values()) run.inflight.clear();
  }
  /** 上行被拒时清掉本会话的上报签名，让恢复事实在下一轮重报。 */
  forgetReported(attemptId: string) {
    for (const run of this.runs.values()) run.reported.delete(attemptId);
  }
  /** 宿主确认终态后 claim 才算处理完；进程本身可能仍在运行，不动它。 */
  settle(executionId: string) {
    this.runs.delete(executionId);
    this.store.deleteClaim(executionId);
  }
  /** 只读：本会话还要交代哪些遗留执行。标记已上报由 `markRecovered` 在真正上行后做。 */
  pendingRecoveries(session: WorkerSession, limit: number): ExecutionRecovery[] {
    const facts: ExecutionRecovery[] = [];
    for (const run of this.runs.values()) {
      if (facts.length === limit) break;
      // 本会话下发的执行有在途条目自己报终态；只有上一会话或上次进程遗留的才需恢复事实。
      if (run.owningAttempt === session.attemptId) continue;
      // token 只能来自宿主随命令下发的值；没有 token 就不报，避免伪造恢复事实。
      if (run.claim.runnerToken === null) continue;
      if (run.claim.claimedAt === 0) continue;
      const state = observed(run);
      const stamp = `${state}:${run.exitedAt ?? ""}:${run.log.producedThrough}`;
      if (run.reported.get(session.attemptId) === stamp) continue;
      facts.push({
        executionId: run.claim.executionId,
        projectId: run.claim.projectId,
        machineId: run.claim.machineId,
        authorizationGeneration: run.claim.authorizationGeneration,
        holderInstanceId: run.claim.holderInstanceId,
        runnerToken: run.claim.runnerToken,
        observedState: state,
        exitCode: run.exited ? run.exitCode : null,
        signal: run.exited ? run.signal : null,
        observedExitedAt: run.exitedAt === null ? null : new Date(run.exitedAt).toISOString(),
        producedThroughSequence: run.log.producedThrough > 0 ? run.log.producedThrough : null,
        claimEvidenceAt: new Date(run.claim.claimedAt).toISOString(),
      });
    }
    return facts;
  }
  /** 按 execution 轮转取未确认且未在途的帧，单个执行不得独占用全部名额。 */
  rotate(limit: number): { run: Run; frame: LogFrameDraft }[] {
    const picked: { run: Run; frame: LogFrameDraft }[] = [];
    const queues = [...this.runs.values()]
      .sort((a, b) => a.order - b.order)
      .map((run) => ({
        run,
        frames: run.log.frames.filter((frame) => !run.inflight.has(frame.sequence)),
      }))
      .filter((queue) => queue.frames.length > 0);
    if (queues.length === 0) return picked;
    const taken = new Map<Run, number>();
    let index = this.rotation % queues.length;
    while (picked.length < limit) {
      const queue = queues[index];
      if (!queue) break;
      const offset = taken.get(queue.run) ?? 0;
      const frame = queue.frames[offset];
      if (!frame) {
        queues.splice(index, 1);
        if (queues.length === 0) break;
        index %= queues.length;
        continue;
      }
      taken.set(queue.run, offset + 1);
      picked.push({ run: queue.run, frame });
      index = (index + 1) % queues.length;
    }
    this.rotation = queues.length === 0 ? 0 : index % queues.length;
    return picked;
  }
  shutdown() {
    for (const run of this.runs.values()) if (!run.done) run.controller.abort();
  }
}
