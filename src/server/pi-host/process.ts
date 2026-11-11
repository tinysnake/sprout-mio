import { spawn } from "node:child_process";
import { assertPreparedPiMessage, type PreparedPiMessage } from "../message-skills";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunConfigSnapshot } from "../../contracts/agent-run";
import type { OpenSession, PiHostCommand, PiHostEvent, PiHostProgress } from "./protocol";
import { config } from "../../lib/config";
import type {
  TurnContextPromptInput,
  TurnContextSubmissionReceipt,
} from "../../contracts/turn-context";
import type { InfoHubHint } from "../../contracts/info-hub-hint";
import { piHostEvent } from "./protocol";

// 关闭请求发出后到强杀之间的宽限。宿主整体关机必须在 9 秒内给出结论，
// 所以这个预算不能放大：真挂住的 runner 由这里强制结束并报错。
const RUNNER_ABORT_GRACE_MS = 2_000;
const RUNNER_CLOSE_GRACE_MS = 1_500;

export class PiHostFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stopReason?: string,
    readonly text?: string,
  ) {
    super(message);
    this.name = "PiHostFailure";
  }
}

type Waiter = {
  type: PiHostEvent["type"];
  resolve: (event: PiHostEvent) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export class PiSessionProcess {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderrTail = "";
  private waiters = new Set<Waiter>();
  private fatal: Error | undefined;
  private exiting = false;
  private awaitingSettled = false;
  private abortTimer?: ReturnType<typeof setTimeout>;
  private closing: Promise<void> | undefined;
  private exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private disposed = false;
  private disposeCallbacks = new Set<() => void>();
  turnContext: TurnContextPromptInput | undefined;
  onTurnContextSubmitted: ((receipt: TurnContextSubmissionReceipt) => void) | undefined;
  onDelivered: ((messageId: string, assistantContextHash?: string) => void) | undefined;
  onRejected: ((messageId: string, reason: string) => void) | undefined;
  onProgress: ((event: PiHostProgress) => void) | undefined;

  constructor(
    readonly id: string,
    runnerPath = config.SPROUT_PI_RUNNER ?? resolve("scripts/pi-host-runner.mjs"),
  ) {
    this.child = spawn(process.execPath, [runnerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, PI_TELEMETRY: "0" },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    // 子进程退出码说明不了原因，把它的最后几行留下来。
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-2000);
    });
    this.child.stdin.on("error", () =>
      this.fail(new PiHostFailure("runner_pipe_failed", "Pi runner 通信失败")),
    );
    this.exit = new Promise((done) => {
      this.child.once("error", () => {
        this.fail(new PiHostFailure("runner_spawn_failed", "Pi runner 无法启动"));
        done({ code: 1, signal: null });
      });
      this.child.once("exit", (code, signal) => {
        this.dispose();
        if (!this.exiting || code !== 0 || signal)
          this.fail(new PiHostFailure("runner_crashed", "Pi runner 异常退出"));
        done({ code, signal });
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  onDispose(callback: () => void): void {
    if (this.disposed) callback();
    else this.disposeCallbacks.add(callback);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const callback of this.disposeCallbacks) {
      try {
        callback();
      } catch {
        this.fail(new PiHostFailure("grant_revoke_failed", "远端工具授权撤销失败"));
      }
    }
    this.disposeCallbacks.clear();
  }

  private fail(error: Error): void {
    this.clearAbortTimer();
    this.awaitingSettled = false;
    this.dispose();
    this.fatal ??= error;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(this.fatal);
    }
    this.waiters.clear();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (
      let newline = this.buffer.indexOf("\n");
      newline >= 0;
      newline = this.buffer.indexOf("\n")
    ) {
      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      const parsed = piHostEvent.safeParse(value);
      if (!parsed.success || parsed.data.id !== this.id) continue;
      const event = parsed.data;
      if (event.type === "settled") {
        this.awaitingSettled = false;
        this.clearAbortTimer();
      }
      if (event.type === "progress") {
        // 活动摘要是展示层附加事实：记录失败不能让 run 失败。
        try {
          this.onProgress?.(event);
        } catch {
          // 忽略并继续接收后续事件。
        }
        continue;
      }
      if (event.type === "failure") {
        this.fail(new PiHostFailure(event.code, event.message, event.stopReason, event.text));
        continue;
      }
      if (event.type === "turn_context_submitted") {
        try {
          const { type: _type, id: _id, ...receipt } = event;
          this.onTurnContextSubmitted?.(receipt);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error("Turn context receipt failed"));
        }
        continue;
      }
      if (event.type === "input_delivered") {
        try {
          this.onDelivered?.(event.messageId, event.assistantContextHash);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error("Pi 输入投递状态保存失败"));
        }
      }
      if (event.type === "input_rejected") {
        this.onRejected?.(event.messageId, event.reason);
        continue;
      }
      for (const waiter of this.waiters) {
        if (waiter.type !== event.type) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  }

  private wait(type: PiHostEvent["type"], timeoutMs?: number): Promise<PiHostEvent> {
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise((done, reject) => {
      const waiter: Waiter = {
        type,
        resolve: done,
        reject,
        ...(timeoutMs === undefined
          ? {}
          : {
              timer: setTimeout(() => {
                this.waiters.delete(waiter);
                const error = new PiHostFailure("runner_timeout", "Pi runner 等待超时");
                this.fail(error);
                reject(error);
              }, timeoutMs),
            }),
      };
      this.waiters.add(waiter);
    });
  }

  private send(command: PiHostCommand): void {
    if (this.fatal) throw this.fatal;
    if (this.child.exitCode !== null || this.child.signalCode !== null)
      throw new PiHostFailure("runner_crashed", "Pi runner 已退出");
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async open(config: OpenSession): Promise<RunConfigSnapshot> {
    this.awaitingSettled = true;
    const ready = this.wait("ready", 30000);
    try {
      this.send(config);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Pi runner 通信失败"));
    }
    const event = await ready;
    if (event.type !== "ready" || event.snapshot.sessionId !== config.sessionId) {
      const error = new PiHostFailure("session_mismatch", "Pi session 身份不匹配");
      this.fail(error);
      throw error;
    }
    return event.snapshot;
  }

  async prompt(prepared: PreparedPiMessage): Promise<{ text: string; stopReason: string }> {
    assertPreparedPiMessage(prepared);
    const { messageId, text } = prepared;
    const turnContext = this.turnContext;
    if (!turnContext || turnContext.runId !== this.id)
      throw new PiHostFailure("turn_context_unavailable", "轮初上下文尚未准备");
    this.awaitingSettled = true;
    const settled = this.wait("settled");
    try {
      this.send({ type: "prompt", id: this.id, messageId, text, turnContext });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Pi runner 通信失败"));
    }
    const event = await settled;
    if (event.type !== "settled" || event.stopReason !== "stop")
      throw new PiHostFailure(
        "model_error",
        "Pi 模型未正常完成本轮",
        event.type === "settled" ? event.stopReason : undefined,
      );
    return event;
  }

  infoHubHint(hint: InfoHubHint): void {
    if (hint.runId !== this.id)
      throw new PiHostFailure("turn_context_unavailable", "提示身份不匹配");
    this.send({ type: "info_hub_hint", id: this.id, hint });
  }

  steer(prepared: PreparedPiMessage): void {
    assertPreparedPiMessage(prepared);
    const { messageId, text } = prepared;
    this.send({
      type: "steer",
      id: this.id,
      messageId,
      text,
      ...(prepared.assistantContext ? { assistantContext: prepared.assistantContext } : {}),
    });
  }

  private clearAbortTimer(): void {
    clearTimeout(this.abortTimer);
    this.abortTimer = undefined;
  }

  abortSession(): void {
    this.dispose();
    try {
      this.send({ type: "abort", id: this.id });
    } catch {
      // 子进程已退出时停止动作仍以 run 状态机的结果为准。
    }
    if (this.exiting || this.abortTimer || !this.awaitingSettled) return;
    this.abortTimer = setTimeout(() => {
      this.abortTimer = undefined;
      void this.close().catch((error) => {
        console.error(`[pi-host] 中断后关闭 Pi runner 失败 id=${this.id}`, error);
      });
    }, RUNNER_ABORT_GRACE_MS);
  }

  close(): Promise<void> {
    return (this.closing ??= this.closeProcess());
  }

  private async closeProcess(): Promise<void> {
    this.exiting = true;
    this.clearAbortTimer();
    this.fail(new PiHostFailure("runner_closed", "Pi runner 已关闭"));
    if (this.child.exitCode === null && this.child.signalCode === null) {
      // 故障发生后也要发送 close，不能让 fatal 阻断清理。
      this.child.stdin.write(`${JSON.stringify({ type: "close", id: this.id })}\n`);
    }
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      if (this.child.pid) {
        try {
          process.kill(-this.child.pid, "SIGKILL");
        } catch {
          this.child.kill("SIGKILL");
        }
      }
    }, RUNNER_CLOSE_GRACE_MS);
    try {
      const result = await this.exit;
      this.fail(new PiHostFailure("runner_closed", "Pi runner 已关闭"));
      if (forced || result.code !== 0 || result.signal)
        throw new PiHostFailure(
          "runner_shutdown_failed",
          `Pi runner 未正常关闭（code=${result.code} signal=${result.signal} forced=${forced}）${
            this.stderrTail ? ` stderr=${JSON.stringify(this.stderrTail)}` : ""
          }`,
        );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function piInstancePaths(instanceId: string) {
  const directory = join(config.SPROUT_PI_DATA_DIR, instanceId);
  const cwd = join(directory, "workspace");
  const sessionDirectory = join(directory, "sessions");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  return { cwd, sessionDirectory };
}
