import { createHash } from "node:crypto";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { MCP_MAX_MESSAGE_BYTES } from "../contracts/mcp";
import type { HostOutboundFrame, McpSession, ServerInboundFrame } from "../contracts/mcp";
import type { RemoteAgentRequest } from "../contracts/remote";
import type { RemoteToolClient, RemoteToolResponse } from "./remote-client";
import type { JsonRpcMessage, McpTransport } from "./mcp-pi-types";

/**
 * 有界 hold 的默认值，与 `design-selection.md` §6.1 冻结的 `holdMs ≤ 2000` 一致。
 *
 * 为什么不是候选 A 原始的 250 ms 空闲轮询：每次 exchange 都是一次独立的
 * `immediate()` 认证事务（`remoteAgentResponse` 里做两遍 authenticate），250 ms 轮询
 * 会让一个空闲 session 每分钟白打 240 次认证事务。改成「有帧立即发、无帧单次有界等待
 * ≤2000 ms」后，空闲期每分钟只有 30 次请求，且每次都在服务端被挂起到有帧或超时。
 * 服务端 `drain.wait(8000)` 大于 2000，所以这个 hold 不会单独把排空拖过 8 s。
 */
export const SPROUT_MCP_HOLD_MS = 2000;
/** attach 的总预算（跨多次 exchange），单次调用仍受 `createRemoteClient` 的 15 s 限制。 */
export const SPROUT_MCP_ATTACH_TIMEOUT_MS = 30_000;
/** 一帧排队有效期的上限；真实值取 requestTimeoutMs 与此值的较小者。 */
const MAX_FRAME_LIFETIME_MS = 120_000;
const MAX_OUTBOUND_PER_EXCHANGE = 2;
const MAX_QUEUED_CLIENT_FRAMES = 32;

export interface SproutRelayBinding {
  /** 既有受认证客户端；transport 不自建 HTTP 层。 */
  remote: RemoteToolClient;
  machineId: string;
  authorizationGeneration: number;
  registrationId: string;
  registrationRevision: number;
  processId: string;
  expectedWorkerIncarnationId: string;
  /** registration.requestTimeoutMs，默认 120000。 */
  requestTimeoutMs: number;
  holdMs?: number;
  attachTimeoutMs?: number;
  now?: () => number;
}

type ExchangeResult = {
  session: McpSession;
  acceptedClientSeq: number;
  frames: ServerInboundFrame[];
  hasMore: boolean;
};

function payloadHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `McpTransport` 的 Sprout 实现：把 Pi 原生 MCP 客户端的每一帧交给已认证的 Worker 通道。
 *
 * 六方法照冻结形状实现：`start` 发 `mcp_session_open` 并等到 Worker 确认 attached；
 * `send` 编码一次、检查 128 KiB、分配稳定 frameId/seq 后单串行上传；
 * `close` 只 detach（绝不 stop 服务进程）；`onMessage/onError/onClose` 有界；
 * `setProtocolVersion` 只缓存并排队，后续帧等它被持久确认后才放行。
 */
export class SproutRelayTransport implements McpTransport {
  private readonly binding: SproutRelayBinding;
  private readonly now: () => number;
  private readonly holdMs: number;
  private readonly attachTimeoutMs: number;
  private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private outbox: HostOutboundFrame[] = [];
  private session: McpSession | null = null;
  private nextSeq = 1;
  private acceptedClientSeq = 0;
  private emittedServerSeq = 0;
  private protocolVersion: string | null = null;
  private protocolPendingSince: number | null = null;
  /**
   * `McpClient` 只在 `initialize` 结果通过校验后调用 `transport.setProtocolVersion(v)`
   * （pi-mcp `client.js:141`），所以这个标志就是「原生 connect 已成功」的可靠信号 ——
   * 它不是 tools/list 成功，也不需要宿主解析任何 MCP method。
   */
  private initialized = false;
  private attachWaiter: (() => void) | null = null;
  private inflight: AbortController | null = null;
  private started = false;
  private closed = false;
  private closeEmitted = false;
  private pump: Promise<void> | null = null;
  /** 测试与报告用的实测计数，不参与协议判定。 */
  readonly counters = { exchanges: 0, emptyExchanges: 0, heldAborts: 0, acceptedFrames: 0 };

  constructor(binding: SproutRelayBinding, now = Date.now) {
    this.binding = binding;
    this.now = binding.now ?? now;
    this.holdMs = Math.min(SPROUT_MCP_HOLD_MS, Math.max(0, binding.holdMs ?? SPROUT_MCP_HOLD_MS));
    this.attachTimeoutMs = binding.attachTimeoutMs ?? SPROUT_MCP_ATTACH_TIMEOUT_MS;
  }

  get sessionId(): string | null {
    return this.session?.id ?? null;
  }

  private base() {
    return {
      projectId: this.binding.remote.projectId,
      machineId: this.binding.machineId,
      authorizationGeneration: this.binding.authorizationGeneration,
    };
  }

  private send_<C extends RemoteAgentRequest["call"]>(
    call: C,
    signal: AbortSignal,
  ): Promise<RemoteToolResponse> {
    return this.binding.remote.request({ version: 2, call } as RemoteAgentRequest, signal);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Sprout relay transport 只能 start 一次");
    this.started = true;
    const controller = new AbortController();
    const response = await this.send_(
      {
        type: "mcp_session_open",
        input: {
          ...this.base(),
          requestId: newId(ID_PREFIXES.request),
          registrationId: this.binding.registrationId,
          registrationRevision: this.binding.registrationRevision,
          processId: this.binding.processId,
          expectedWorkerIncarnationId: this.binding.expectedWorkerIncarnationId,
        },
      },
      controller.signal,
    );
    const session = this.sessionOf(response);
    this.session = session;
    this.acceptedClientSeq = session.workerAckClientSeq;
    this.nextSeq = session.clientHighWater + 1;
    this.emittedServerSeq = session.hostAckServerSeq;
    this.pump = this.run();
    await this.waitAttached();
  }
  private sessionOf(response: RemoteToolResponse): McpSession {
    if (response.outcome !== "response") throw new Error(`Sprout 通道不可用：${response.reason}`);
    if (!response.result.ok)
      throw new Error(`Sprout 拒绝 MCP session：${response.result.error.code}`);
    const data = response.result.data as { session?: McpSession };
    if (!data.session) throw new Error("Sprout 未返回 MCP session");
    return data.session;
  }

  private async waitAttached(): Promise<void> {
    const deadline = this.now() + this.attachTimeoutMs;
    while (!this.closed && this.session?.attachedAt == null) {
      if (this.session && ["failed", "closed", "disconnected"].includes(this.session.state))
        throw new Error(
          `Sprout MCP session 在 attach 前终止：${this.session.endReason ?? this.session.state}`,
        );
      if (this.now() >= deadline) throw new Error("Sprout MCP session 30 s 内未确认 attached");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.attachWaiter = () => {
          clearTimeout(timer);
          this.attachWaiter = null;
          resolve();
        };
      });
    }
  }

  public wake(): void {
    this.attachWaiter?.();
    // 有帧要发时立即发：中止正在 hold 的 exchange，下一轮带上新帧。
    if (this.inflight && this.outbox.length > 0) {
      this.counters.heldAborts += 1;
      this.inflight.abort();
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("Sprout relay transport 已关闭");
    const bytes = new TextEncoder().encode(JSON.stringify(message));
    if (bytes.byteLength > MCP_MAX_MESSAGE_BYTES)
      throw new Error(`MCP 帧超过 ${MCP_MAX_MESSAGE_BYTES} 字节上限`);
    if (this.outbox.length >= MAX_QUEUED_CLIENT_FRAMES)
      throw new Error("MCP 客户端出站队列已满（32 帧）");
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const frame: HostOutboundFrame = {
      frameId: newId(ID_PREFIXES.mcpFrame),
      seq,
      payloadBase64: Buffer.from(bytes).toString("base64"),
      payloadBytes: bytes.byteLength,
      payloadHash: payloadHash(bytes),
      expiresAt:
        this.now() + Math.min(MAX_FRAME_LIFETIME_MS, Math.max(1, this.binding.requestTimeoutMs)),
    };
    this.outbox.push(frame);
    const accepted = new Promise<void>((resolve, reject) =>
      this.pending.set(seq, { resolve, reject }),
    );
    this.wake();
    await accepted;
  }

  setProtocolVersion(version: string): void {
    this.initialized = true;
    this.protocolVersion = version;
    this.protocolPendingSince = this.session?.protocolVersion === version ? null : this.now();
    this.wake();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.inflight?.abort();
    for (const [, entry] of this.pending) entry.reject(new Error("Sprout relay transport 已关闭"));
    this.pending.clear();
    this.outbox = [];
    this.attachWaiter?.();
    const session = this.session;
    if (session) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        await this.send_(
          {
            type: "mcp_session_close",
            input: {
              ...this.base(),
              sessionId: session.id,
              requestId: newId(ID_PREFIXES.request),
              reason: "client_closed",
            },
          },
          controller.signal,
        );
      } catch {
        // 本地关闭不被远端失败阻塞；服务端 sweep 收敛。
      } finally {
        clearTimeout(timer);
      }
    }
    this.emitClose();
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of new Set(this.closeListeners)) listener();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.inflight?.abort();
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
    this.outbox = [];
    this.attachWaiter?.();
    for (const listener of new Set(this.errorListeners)) listener(error);
    // 绝不创建同名新 transport 接替，只发出一次 close。
    this.emitClose();
  }

  private exchangeInput(frames: HostOutboundFrame[], holdMs: number) {
    return {
      ...this.base(),
      sessionId: this.session!.id,
      frames,
      ackServerSeq: this.emittedServerSeq,
      cancelClientSeqs: [] as number[],
      protocolVersion: this.protocolVersion,
      confirmInitialized: this.initialized,
      holdMs,
    };
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      const protocolPending =
        this.protocolVersion !== null &&
        this.protocolPendingSince !== null &&
        this.session?.protocolVersion !== this.protocolVersion;
      if (protocolPending && this.now() - this.protocolPendingSince! > this.attachTimeoutMs) {
        this.fail(new Error("MCP 协议版本在 30 s 内未被持久确认"));
        return;
      }
      // 协议版本未确认前不放行后续帧（design §6.3）。
      const batch = protocolPending ? [] : this.outbox.slice(0, MAX_OUTBOUND_PER_EXCHANGE);
      const holdMs = batch.length > 0 ? 0 : this.holdMs;
      const controller = new AbortController();
      this.inflight = controller;
      this.counters.exchanges += 1;
      if (batch.length === 0) this.counters.emptyExchanges += 1;
      let response: RemoteToolResponse;
      try {
        response = await this.send_(
          { type: "mcp_session_exchange", input: this.exchangeInput(batch, holdMs) },
          controller.signal,
        );
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Sprout 通道请求失败"));
        return;
      } finally {
        if (this.inflight === controller) this.inflight = null;
      }
      if (this.closed) return;
      if (response.outcome === "unknown" && response.reason === "cancelled") continue;
      if (response.outcome !== "response") {
        this.fail(new Error(`Sprout MCP exchange 结果未知：${response.reason}`));
        return;
      }
      if (!response.result.ok) {
        this.fail(new Error(`Sprout 拒绝 MCP exchange：${response.result.error.code}`));
        return;
      }
      this.accept(response.result.data as ExchangeResult);
    }
  }

  private accept(result: ExchangeResult): void {
    this.session = result.session;
    const accepted = result.acceptedClientSeq;
    if (accepted < this.acceptedClientSeq) {
      this.fail(new Error("Sprout 已接受序号回退"));
      return;
    }
    for (const [seq, entry] of this.pending) {
      if (seq > accepted) continue;
      entry.resolve();
      this.pending.delete(seq);
    }
    this.counters.acceptedFrames += accepted - this.acceptedClientSeq;
    this.acceptedClientSeq = accepted;
    this.outbox = this.outbox.filter((frame) => frame.seq > accepted);
    for (const frame of result.frames) {
      // 同 seq 重复帧直接确认、不重复 emit；后一 seq 才 emit。
      if (frame.seq <= this.emittedServerSeq) continue;
      if (frame.seq !== this.emittedServerSeq + 1) {
        this.fail(new Error("Sprout 服务端帧序号出现缺口"));
        return;
      }
      this.emittedServerSeq = frame.seq;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(
          Buffer.from(frame.payloadBase64, "base64").toString("utf8"),
        ) as JsonRpcMessage;
      } catch {
        this.fail(new Error("Sprout 服务端帧不是合法 JSON"));
        return;
      }
      for (const listener of new Set(this.messageListeners)) listener(message);
    }
    if (this.session.protocolVersion === this.protocolVersion) this.protocolPendingSince = null;
    if (this.session.attachedAt != null) this.attachWaiter?.();
  }

  /** 只给测试与关闭路径用：等待 pump 自然结束。 */
  async settled(): Promise<void> {
    await this.pump;
  }
}
