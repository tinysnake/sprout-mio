import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunConfigSnapshot } from "../../contracts/agent-run";
import type { OpenSession, PiHostCommand, PiHostEvent } from "./protocol";
import { config } from "../../lib/config";
import { piHostEvent } from "./protocol";

export class PiHostFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stopReason?: string,
  ) {
    super(message);
    this.name = "PiHostFailure";
  }
}

type Waiter = {
  type: PiHostEvent["type"];
  resolve: (event: PiHostEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PiSessionProcess {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private waiters = new Set<Waiter>();
  private fatal: Error | undefined;
  private exiting = false;
  private closing: Promise<void> | undefined;
  private exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  onDelivered: ((messageId: string) => void) | undefined;

  constructor(
    readonly id: string,
    runnerPath = config.SPROUT_PI_RUNNER ?? resolve("scripts/pi-host-runner.mjs"),
  ) {
    this.child = spawn(process.execPath, [runnerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, PI_TELEMETRY: "0" },
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk.toString()));
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () =>
      this.fail(new PiHostFailure("runner_pipe_failed", "Pi runner 通信失败")),
    );
    this.exit = new Promise((done) => {
      this.child.once("error", () => {
        this.fail(new PiHostFailure("runner_spawn_failed", "Pi runner 无法启动"));
        done({ code: 1, signal: null });
      });
      this.child.once("exit", (code, signal) => {
        if (!this.exiting || code !== 0 || signal)
          this.fail(new PiHostFailure("runner_crashed", "Pi runner 异常退出"));
        done({ code, signal });
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private fail(error: Error): void {
    this.fatal ??= error;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(this.fatal);
    }
    this.waiters.clear();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) {
      this.fail(new PiHostFailure("runner_protocol_limit", "Pi runner 输出超过协议限制"));
      return;
    }
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
      if (event.type === "failure") {
        this.fail(new PiHostFailure(event.code, event.message, event.stopReason));
        continue;
      }
      if (event.type === "input_delivered") {
        try {
          this.onDelivered?.(event.messageId);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error("Pi 输入投递状态保存失败"));
        }
      }
      for (const waiter of this.waiters) {
        if (waiter.type !== event.type) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  }

  private wait(type: PiHostEvent["type"], timeoutMs: number): Promise<PiHostEvent> {
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise((done, reject) => {
      const waiter: Waiter = {
        type,
        resolve: done,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          const error = new PiHostFailure("runner_timeout", "Pi runner 等待超时");
          this.fail(error);
          reject(error);
        }, timeoutMs),
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
    const ready = this.wait("ready", 30000);
    try {
      this.send(config);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Pi runner 通信失败"));
    }
    const event = await ready;
    if (event.type !== "ready" || event.snapshot.sessionId !== config.sessionId)
      throw new PiHostFailure("session_mismatch", "Pi session 身份不匹配");
    return event.snapshot;
  }

  async prompt(messageId: string, text: string): Promise<{ text: string; stopReason: string }> {
    const settled = this.wait("settled", 600000);
    try {
      this.send({ type: "prompt", id: this.id, messageId, text });
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

  close(): Promise<void> {
    return (this.closing ??= this.closeProcess());
  }

  private async closeProcess(): Promise<void> {
    this.exiting = true;
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
    }, 1500);
    try {
      const result = await this.exit;
      this.fail(new PiHostFailure("runner_closed", "Pi runner 已关闭"));
      if (forced || result.code !== 0 || result.signal)
        throw new PiHostFailure("runner_shutdown_failed", "Pi runner 未正常关闭");
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
