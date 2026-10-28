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
/** Runner 起命令前写的 fence 记录：执行端自己的 pid 与 token，不依赖宿主内存。 */
export type RunnerClaim = {
  executionId: string;
  pid: number;
  childPid: number | null;
  token: string;
  startedAt: string;
};
/** Runner 在子进程退出后写的唯一结果。它存在就意味着这次执行有确定终态。 */
export type RunnerResult = {
  executionId: string;
  exitCode: number | null;
  signal: string | null;
  exitedAt: string;
};
/** 恢复归约的结论：只消费磁盘事实，不把「查不到」当成没跑过。 */
export type ObservedRun = {
  state: ExecutionRecovery["observedState"];
  reason: NonNullable<ExecutionRecovery["observedReason"]> | null;
};
function readable<T>(path: string, accept: (value: T) => boolean): T | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as T;
    return accept(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
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
  /** 发信号时声明的 TERM 宽限（毫秒）。退出观测要等足它，不能按固定窗口提前放弃。 */
  signalGraceMs: number;
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
  /** runner 进程需要真实路径：它就是要把 claim 与 result 写进这个目录。 */
  get stateDirectory() {
    return this.directory ?? null;
  }
  private executionDirectory(executionId: string) {
    const path = join(this.directory!, "executions", executionId);
    privateDirectory(path);
    return path;
  }
  runnerClaim(executionId: string): RunnerClaim | null {
    if (!this.directory) return null;
    const path = join(this.directory, "executions", executionId, "runner.json");
    return readable<RunnerClaim>(
      path,
      (value) => value.executionId === executionId && Number.isSafeInteger(value.pid),
    );
  }
  runnerResult(executionId: string): RunnerResult | null {
    if (!this.directory) return null;
    const path = join(this.directory, "executions", executionId, "result.json");
    return readable<RunnerResult>(
      path,
      (value) =>
        value.executionId === executionId &&
        (value.exitCode === null || Number.isInteger(value.exitCode)) &&
        typeof value.exitedAt === "string" &&
        Number.isFinite(Date.parse(value.exitedAt)),
    );
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
    remove(join(directory, "runner.json"));
    remove(join(directory, "result.json"));
  }
  appendFrame(executionId: string, frame: LogFrameDraft) {
    if (!this.directory) return;
    // 宿主确认终态后 claim 已被清理：不再为已结算的执行重建 outbox 目录。
    const directory = join(this.directory, "executions", executionId);
    if (!existsSync(join(directory, "claim.json"))) return;
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
    writePrivate(temporary, kept.map((frame) => frameLine(executionId, frame)).join(""));
    renameSync(temporary, path);
  }
}
/** 归约顺序就是 P0 的承诺：result 存在才是 exited；pid 活着才是 running；否则 unknown 带原因。 */
const observed = (run: Run, runnerClaim: RunnerClaim | null): ObservedRun => {
  if (run.exited) return { state: "exited", reason: null };
  // pid 0 表示宿主连 spawn 都没兑现：没有 fence 记录，这不是「跑了但不知道结果」。
  if (run.claim.pid === 0) return { state: "unknown", reason: "no-fence-record" };
  // token 对不上说明这条 pid 事实不是我们发的那次执行产生的，不能拿来认领。
  if (runnerClaim && run.claim.runnerToken && runnerClaim.token !== run.claim.runnerToken)
    return { state: "unknown", reason: "no-fence-record" };
  try {
    process.kill(run.claim.pid, 0);
    return { state: "running", reason: null };
  } catch {
    return { state: "unknown", reason: "child-exited-without-result" };
  }
};
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
        signalGraceMs: 0,
        collecting: false,
        reported: new Map(),
        inflight: new Set(),
        owningAttempt: null,
        order: this.runs.size,
      });
      this.adoptResult(this.runs.get(claim.executionId)!);
    }
  }
  /**
   * 第三层归约：runner 的 result 文件是终态的唯一依据。上一代进程死在交报告之前也没关系，
   * 只要命令真的退出了，磁盘上就有结果；没有结果就不猜。每次交代前重读，不缓存。
   */
  adoptResult(run: Run): boolean {
    if (run.exited) return true;
    const result = this.store.runnerResult(run.claim.executionId);
    if (!result) return false;
    const claim = this.store.runnerClaim(run.claim.executionId);
    if (claim && run.claim.runnerToken && claim.token !== run.claim.runnerToken) return false;
    const exitedAt = Date.parse(result.exitedAt);
    if (!Number.isFinite(exitedAt) || exitedAt < run.claim.claimedAt) return false;
    run.exited = true;
    run.exitCode = result.exitCode;
    run.signal = result.signal;
    run.exitedAt = exitedAt;
    run.done = true;
    run.claim.exitCode = result.exitCode;
    run.claim.signal = result.signal;
    run.claim.exitedAt = exitedAt;
    this.store.saveClaim(run.claim);
    return true;
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
      signalGraceMs: 0,
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
    run.claim.producedThroughSequence =
      run.log.producedThrough > 0 ? run.log.producedThrough : null;
    this.store.saveClaim(run.claim);
  }
  /** 宿主 ACK 只推进已落盘前缀：确认的帧删除，在途未确认的帧下一轮重发。 */
  acknowledge(executionId: string, through: number, availableFrom: number | null) {
    const run = this.runs.get(executionId);
    if (!run) return;
    run.log.acknowledge(through, availableFrom);
    for (const sequence of [...run.inflight])
      if (sequence <= through) run.inflight.delete(sequence);
    this.store.prune(executionId, through, availableFrom);
  }
  /** 恢复事实真正随 exchange 出去之后才记签名：没送到的下一轮必须重报。 */
  markRecovered(session: WorkerSession, facts: readonly ExecutionRecovery[]) {
    for (const fact of facts) {
      const run = this.runs.get(fact.executionId);
      if (!run) continue;
      run.reported.set(
        session.attemptId,
        `${fact.observedState}:${fact.observedReason ?? ""}:${run.exitedAt ?? ""}:${run.log.producedThrough}`,
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
      // 在每次交代前重读磁盘：孤儿进程可能在两次 exchange 之间才退出并落盘结果。
      this.adoptResult(run);
      const seen = observed(run, this.store.runnerClaim(run.claim.executionId));
      const state = seen.state;
      const stamp = `${state}:${seen.reason ?? ""}:${run.exitedAt ?? ""}:${run.log.producedThrough}`;
      if (run.reported.get(session.attemptId) === stamp) continue;
      facts.push({
        executionId: run.claim.executionId,
        projectId: run.claim.projectId,
        machineId: run.claim.machineId,
        authorizationGeneration: run.claim.authorizationGeneration,
        holderInstanceId: run.claim.holderInstanceId,
        runnerToken: run.claim.runnerToken,
        observedState: state,
        observedReason: seen.reason,
        pid: run.exited ? (this.store.runnerClaim(run.claim.executionId)?.childPid ?? null) : null,
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
  /**
   * 只轮转本会话本次下发的执行：上次进程或上一会话遗留的执行没有本批归属，
   * 其事实由恢复事实交代，不冒充本次下发。
   */
  rotate(session: WorkerSession, limit: number): { run: Run; frame: LogFrameDraft }[] {
    const picked: { run: Run; frame: LogFrameDraft }[] = [];
    const queues = [...this.runs.values()]
      .filter((run) => run.owningAttempt === session.attemptId)
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
