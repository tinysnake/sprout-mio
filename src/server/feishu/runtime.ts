import { EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { newId, ID_PREFIXES } from "../../contracts/ids";
import type {
  FeishuConnectionSnapshot,
  FeishuTransportConfig,
} from "../../contracts/feishu-channel";
import {
  captureFeishuAdmissionScope,
  admitFeishuText,
  createFeishuConnectionLifecycle,
  finishFeishuChallenge,
  isFeishuChallengeCode,
} from "../../domain/feishu";
import { recoverChannelDeliveries } from "../../domain/channel-delivery";
import {
  consumeFeishuAction,
  emitNextFeishuDelivery,
  setFeishuDeliveryWake,
} from "../../domain/feishu-delivery";
import { recordDiagnostic } from "../diagnostics";
import { createFeishuDeliveryLoop, type FeishuDeliveryLoop } from "./delivery-loop";
import {
  createFeishuEmissionPort,
  createFeishuTokenSource,
  nodeHttpsTransport,
  type FeishuHttpTransport,
} from "./emission";
import { createFeishuIngressHandlers } from "./ingress";
import { createFeishuLease, type FeishuLease } from "./lease";
import {
  createFeishuConnectionOwner,
  type FeishuClientFactory,
  type FeishuConnectionOwner,
  type FeishuWsClientLike,
  type FeishuDispatcherFactory,
  type FeishuEpochLifecycle,
} from "./owner";

export type FeishuChannelSettings = Readonly<FeishuTransportConfig>;

export function feishuTransportConfig(settings: FeishuChannelSettings): FeishuTransportConfig {
  return Object.freeze({ ...settings });
}

export type FeishuRuntime = Readonly<{
  start(): void;
  stop(): void;
  wake(): void;
  isRunning(): boolean;
  snapshot(): FeishuConnectionSnapshot;
}>;

export type FeishuRuntimeDependencies = Readonly<{
  projectId: string;
  config: FeishuTransportConfig;
  transport?: FeishuHttpTransport;
  createClient?: FeishuClientFactory;
  createDispatcher?: FeishuDispatcherFactory;
  lifecycle?: () => FeishuEpochLifecycle;
  now?: () => Date;
  requestId?: () => string;
  deliveryTimeoutMs?: number;
  leaseTtlMs?: number;
  createLease?: (input: { appId: string; now: () => Date; ttlMs: number }) => FeishuLease;
  onError?: (error: unknown) => void;
}>;

function disabledSnapshot(): FeishuConnectionSnapshot {
  return {
    appId: null,
    phase: "disabled",
    generation: 0,
    epochId: null,
    error: null,
    changedAtMs: 0,
  };
}

function failedSnapshot(
  appId: string,
  error: string,
  changedAtMs: number,
): FeishuConnectionSnapshot {
  return {
    appId,
    phase: "failed",
    generation: 0,
    epochId: null,
    error,
    changedAtMs,
  };
}

const DEFAULT_LEASE_TTL_MS = 20_000;

export function createFeishuRuntime(deps: FeishuRuntimeDependencies): FeishuRuntime {
  const config = deps.config;
  const now = deps.now ?? (() => new Date());
  const requestId = deps.requestId ?? (() => newId(ID_PREFIXES.request));
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  let started = false;
  let failed = false;
  let failure: string | null = null;
  let owner: FeishuConnectionOwner | null = null;
  let loop: FeishuDeliveryLoop | null = null;
  let lease: FeishuLease | null = null;
  let heartbeat: ReturnType<typeof setTimeout> | null = null;

  const report = (error: unknown) => {
    if (deps.onError) deps.onError(error);
    else console.error("[feishu]", error instanceof Error ? error.message : "未知错误");
  };
  const diagnostic = (input: { event: string; code: string }) => {
    recordDiagnostic({
      level: input.code.startsWith("unsupported_message") ? "debug" : "info",
      event: input.event,
      message: input.event,
      requestId: requestId(),
      data: { code: input.code, appId: config.appId },
    });
  };

  const stopHeartbeat = () => {
    if (heartbeat) clearTimeout(heartbeat);
    heartbeat = null;
  };
  const scheduleHeartbeat = () => {
    heartbeat = setTimeout(tickLease, Math.max(1_000, Math.floor(leaseTtlMs / 4)));
    heartbeat.unref?.();
  };
  const tickLease = () => {
    heartbeat = null;
    if (!started || !lease) return;
    let renewed = true;
    try {
      renewed = lease.renew();
    } catch (error) {
      // 写不进去就先不结论：下一轮若能写入，租约本来就没丢。
      report(error);
    }
    if (!renewed) {
      // 别的实例已经接管这个 app，继续收消息会造成两个实例同时处理同一批事件。
      diagnostic({ event: "feishu.lease_lost", code: "lease_lost" });
      try {
        teardown();
      } catch (cleanup) {
        report(cleanup);
      }
      failed = true;
      failure = "lease_lost";
      return;
    }
    scheduleHeartbeat();
  };

  const teardown = () => {
    started = false;
    failed = false;
    failure = null;
    stopHeartbeat();
    setFeishuDeliveryWake(deps.projectId, null);
    loop?.stop();
    loop = null;
    owner?.stop();
    owner = null;
    const held = lease;
    lease = null;
    try {
      held?.release();
    } catch (error) {
      report(error);
    }
  };

  return {
    isRunning: () => started && owner !== null,
    // 装配在 owner 之前就失败时，不能对外声称「未启用」。
    snapshot: () =>
      owner?.snapshot() ??
      ((started || failed) && config.enabled
        ? failedSnapshot(config.appId, failure ?? "start_failed", now().getTime())
        : disabledSnapshot()),
    start() {
      if (started) return;
      started = true;
      failed = false;
      failure = null;
      if (!config.enabled) return;
      try {
        const claimLease = deps.createLease ?? createFeishuLease;
        const candidate = claimLease({ appId: config.appId, now, ttlMs: leaseTtlMs });
        if (candidate.claim() === "held") {
          // 同一 app 只能有一个实例收事件；抢不到就如实报失败，不去开第二个长连接。
          // 不留下 started，这样对方退出后显式 start() 还能接回来。
          started = false;
          failed = true;
          failure = "lease_held";
          return;
        }
        lease = candidate;
        // 启动时只做一次恢复：armed 说明请求可能已经到达平台，标成 uncertain 不重发。
        recoverChannelDeliveries("feishu", deps.projectId);
        const transport = deps.transport ?? nodeHttpsTransport;
        const tokens = createFeishuTokenSource({ config, transport, now: () => now().getTime() });
        const port = createFeishuEmissionPort({ config, transport, tokens });
        loop = createFeishuDeliveryLoop({
          emit: () =>
            emitNextFeishuDelivery(port, {
              projectId: deps.projectId,
              now,
              ...(deps.deliveryTimeoutMs === undefined
                ? {}
                : { timeoutMs: deps.deliveryTimeoutMs }),
            }).then((id) => id ?? null),
          onError: report,
        });
        const lifecycle = deps.lifecycle
          ? deps.lifecycle()
          : createFeishuConnectionLifecycle(config.appId, requestId());
        owner = createFeishuConnectionOwner({
          appId: config.appId,
          lifecycle,
          // 默认实现直接用 SDK；测试注入回环假平台。
          createClient:
            deps.createClient ??
            ((callbacks) =>
              new WSClient({
                appId: config.appId,
                appSecret: config.appSecret,
                autoReconnect: true,
                onReady: callbacks.onReady,
                onError: callbacks.onError,
                onReconnecting: callbacks.onReconnecting,
                onReconnected: callbacks.onReconnected,
              }) as unknown as FeishuWsClientLike),
          createDispatcher:
            deps.createDispatcher ??
            ((handlers) => {
              const dispatcher = new EventDispatcher({});
              dispatcher.register(handlers);
              return dispatcher;
            }),
          createHandlers: ({ currentEpoch }) =>
            createFeishuIngressHandlers({
              appId: config.appId,
              currentEpoch,
              captureScope: (identity, epoch) =>
                captureFeishuAdmissionScope(deps.projectId, identity, epoch),
              admitText: (event, scope, id) => admitFeishuText(event, scope, id),
              finishChallenge: (opaque, identity, id) =>
                finishFeishuChallenge(deps.projectId, opaque, identity, id),
              isChallengeCode: isFeishuChallengeCode,
              consumeAction: (identity, scope, token, at) =>
                consumeFeishuAction(identity, scope, token, at),
              now,
              requestId,
              onDiagnostic: diagnostic,
            }),
          now,
          onError: report,
        });
        loop.start();
        // 新投递提交后叫醒循环，不用等下一轮空闲轮询。
        setFeishuDeliveryWake(deps.projectId, () => loop?.wake());
        owner.start();
        scheduleHeartbeat();
      } catch (error) {
        report(error);
        // 拆掉装配到一半的残留，让下一次 start() 能真正重来，而不是带着半个运行时。
        try {
          teardown();
        } catch (cleanup) {
          report(cleanup);
        }
        failed = true;
      }
    },
    stop() {
      teardown();
    },
    wake() {
      loop?.wake();
    },
  };
}
