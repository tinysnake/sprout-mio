import type { FeishuConnectionSnapshot } from "../../contracts/feishu-channel";
import type { FeishuEpoch } from "../../contracts/feishu";
import { CARD_ACK } from "./ingress";

const CARD_EVENT = "card.action.trigger";

/** 旧代号收到的点击：不落库，但也不能让点按钮的人以为点空了。 */
function staleReply(key: string) {
  return key === CARD_EVENT ? CARD_ACK.expired : {};
}

/** SDK WS 回调的精简形状：只声明本模块用到的部分。 */
export type FeishuConnectionCallbacks = Readonly<{
  onReady: () => void;
  onReconnecting: () => void;
  onReconnected: () => void;
  onError: (error: unknown) => void;
}>;

export type FeishuDispatcherHandlers = Readonly<Record<string, (payload: unknown) => unknown>>;

export type FeishuEventDispatcherLike = Readonly<{
  register(handlers: FeishuDispatcherHandlers): unknown;
}>;

export type FeishuWsClientLike = Readonly<{
  start(params: { eventDispatcher: FeishuEventDispatcherLike }): unknown;
  close(params?: { force?: boolean }): void;
  getConnectionStatus?(): { state: string };
}>;

export type FeishuClientFactory = (callbacks: FeishuConnectionCallbacks) => FeishuWsClientLike;
export type FeishuDispatcherFactory = (
  handlers: FeishuDispatcherHandlers,
) => FeishuEventDispatcherLike;

/** F1 的连接生命周期：每次 ready/reconnected 关闭旧 epoch 并打开新的。 */
export type FeishuEpochLifecycle = Readonly<{
  ready(at?: Date): FeishuEpoch;
  reconnected(at?: Date): FeishuEpoch;
  disconnected(epoch: FeishuEpoch, at?: Date): void;
}>;

export type FeishuOwnerDependencies = Readonly<{
  appId: string;
  lifecycle: FeishuEpochLifecycle;
  createClient: FeishuClientFactory;
  createDispatcher: FeishuDispatcherFactory;
  /** 处理器在 owner 内部包上代数围栏；它们能看到当前 epoch，但改不了它。 */
  createHandlers: (
    context: Readonly<{ currentEpoch: () => FeishuEpoch | null }>,
  ) => FeishuDispatcherHandlers;
  now?: () => Date;
  onError?: (error: unknown) => void;
}>;

export type FeishuConnectionOwner = Readonly<{
  start(): FeishuConnectionSnapshot;
  stop(): FeishuConnectionSnapshot;
  snapshot(): FeishuConnectionSnapshot;
  /** 入站路径只读：没有开着的 epoch 就一律拒绝，绝不回放。 */
  currentEpoch(): FeishuEpoch | null;
}>;

/**
 * 进程内同一 app 只允许一个活着的 client。新 owner start 会先停掉旧的，
 * 所以「打开连接」永远从新的应用代号和新的 epoch 开始。
 */
const activeStops = new Map<string, () => void>();

/** 错误只留安全码：不带 token、不带响应正文、不带请求头。 */
function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" || typeof code === "string") return `code_${String(code)}`;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0 && name !== "Error") return name;
  }
  return "start_failed";
}

export function createFeishuConnectionOwner(deps: FeishuOwnerDependencies): FeishuConnectionOwner {
  const now = deps.now ?? (() => new Date());
  let generation = 0;
  let phase: FeishuConnectionSnapshot["phase"] = "stopped";
  let error: string | null = null;
  let changedAtMs = now().getTime();
  let epoch: FeishuEpoch | null = null;
  let client: FeishuWsClientLike | null = null;
  let running = false;

  const snapshot = (): FeishuConnectionSnapshot => ({
    appId: deps.appId,
    phase,
    generation,
    epochId: epoch?.id ?? null,
    error,
    changedAtMs,
  });
  const transition = (next: FeishuConnectionSnapshot["phase"], nextError: string | null) => {
    phase = next;
    error = nextError;
    changedAtMs = now().getTime();
  };
  const report = (cause: unknown) => {
    try {
      deps.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    } catch {
      // 诊断回调自己抛错不影响连接状态。
    }
  };

  const ownStop = () => owner.stop();
  const owner: FeishuConnectionOwner = {
    currentEpoch: () => epoch,
    snapshot,
    start() {
      if (running) return snapshot();
      // 另一个 owner 持有同一 app 时先把它停掉：进程内只留一个 client。
      activeStops.get(deps.appId)?.();
      running = true;
      generation += 1;
      const gen = generation;
      epoch = null;
      transition("starting", null);
      const live = () => running && generation === gen;

      const closeEpoch = () => {
        const closing = epoch;
        epoch = null;
        if (!closing) return;
        try {
          deps.lifecycle.disconnected(closing, now());
        } catch (cause) {
          report(cause);
        }
      };
      const openEpoch = (openedBy: "ready" | "reconnected") => {
        try {
          const next =
            openedBy === "ready" ? deps.lifecycle.ready(now()) : deps.lifecycle.reconnected(now());
          if (!live()) {
            // 打开期间被替换：新 epoch 不属于这一代，立刻关掉。
            deps.lifecycle.disconnected(next, now());
            return;
          }
          epoch = next;
          transition("connected", null);
        } catch (cause) {
          closeEpoch();
          transition("failed", safeErrorCode(cause));
          report(cause);
        }
      };
      const callbacks: FeishuConnectionCallbacks = {
        onReady: () => {
          if (!live()) return;
          openEpoch("ready");
        },
        onReconnecting: () => {
          if (!live()) return;
          // 旧连接已不可用：先关 epoch，再等 reconnected 打开新的。
          closeEpoch();
          transition("reconnecting", null);
        },
        onReconnected: () => {
          if (!live()) return;
          // epoch 边界就是这次回调本身；此时 getConnectionStatus() 仍可能报
          // "reconnecting"，不能用状态快照拦截新 epoch。
          openEpoch("reconnected");
        },
        onError: (cause) => {
          if (!live()) return;
          closeEpoch();
          transition("failed", safeErrorCode(cause));
          report(cause);
        },
      };

      const handlers = deps.createHandlers({ currentEpoch: () => epoch });
      // 围栏在读 payload 之前：旧代号连解析都不做，更不会落库。
      const fenced = Object.fromEntries(
        Object.entries(handlers).map(([key, handle]) => [
          key,
          (payload: unknown) => {
            if (!live()) return staleReply(key);
            try {
              return handle(payload);
            } catch (cause) {
              report(cause);
              return {};
            }
          },
        ]),
      ) as FeishuDispatcherHandlers;

      let next: FeishuWsClientLike;
      try {
        next = deps.createClient(callbacks);
        client = next;
        const started: unknown = next.start({ eventDispatcher: deps.createDispatcher(fenced) });
        if (started && typeof (started as PromiseLike<unknown>).then === "function")
          void (started as Promise<unknown>).then(undefined, (cause: unknown) => {
            if (!live()) return;
            closeEpoch();
            transition("failed", safeErrorCode(cause));
            report(cause);
          });
      } catch (cause) {
        client = null;
        closeEpoch();
        transition("failed", safeErrorCode(cause));
        report(cause);
      }
      activeStops.set(deps.appId, ownStop);
      return snapshot();
    },
    stop() {
      if (!running && phase === "stopped") return snapshot();
      running = false;
      // 先作废旧代号：SDK 之后任何一次回调都进不了 handler。
      generation += 1;
      const closing = client;
      client = null;
      const open = epoch;
      epoch = null;
      if (open) {
        try {
          deps.lifecycle.disconnected(open, now());
        } catch (cause) {
          report(cause);
        }
      }
      if (closing) {
        try {
          closing.close({ force: true });
        } catch {
          // 关闭失败没有可执行动作：进程退出会回收 socket。
        }
      }
      if (activeStops.get(deps.appId) === ownStop) activeStops.delete(deps.appId);
      transition("stopped", null);
      return snapshot();
    },
  };
  return owner;
}
