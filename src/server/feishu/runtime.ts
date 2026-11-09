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
import {
  createFeishuConnectionOwner,
  type FeishuClientFactory,
  type FeishuConnectionOwner,
  type FeishuWsClientLike,
  type FeishuDispatcherFactory,
  type FeishuEpochLifecycle,
} from "./owner";

export type FeishuChannelSettings = Readonly<{
  FEISHU_CHANNEL_ENABLED: boolean;
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  FEISHU_ORIGIN: string;
}>;

/** 环境变量只在边界映射成传输配置；没配置时 enabled 为 false，进程行为不变。 */
export function feishuTransportConfig(settings: FeishuChannelSettings): FeishuTransportConfig {
  const configured =
    settings.FEISHU_CHANNEL_ENABLED &&
    settings.FEISHU_APP_ID.length > 0 &&
    settings.FEISHU_APP_SECRET.length > 0;
  return Object.freeze({
    appId: settings.FEISHU_APP_ID,
    appSecret: settings.FEISHU_APP_SECRET,
    origin: settings.FEISHU_ORIGIN.replace(/\/+$/, ""),
    enabled: configured,
  });
}

export type FeishuRuntime = Readonly<{
  start(): void;
  stop(): void;
  wake(): void;
  isRunning(): boolean;
  snapshot(): FeishuConnectionSnapshot;
}>;

export type FeishuRuntimeDependencies = Readonly<{
  config: FeishuTransportConfig;
  transport?: FeishuHttpTransport;
  createClient?: FeishuClientFactory;
  createDispatcher?: FeishuDispatcherFactory;
  lifecycle?: () => FeishuEpochLifecycle;
  now?: () => Date;
  requestId?: () => string;
  deliveryTimeoutMs?: number;
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

function failedSnapshot(appId: string, changedAtMs: number): FeishuConnectionSnapshot {
  return {
    appId,
    phase: "failed",
    generation: 0,
    epochId: null,
    error: "start_failed",
    changedAtMs,
  };
}

export function createFeishuRuntime(deps: FeishuRuntimeDependencies): FeishuRuntime {
  const config = deps.config;
  const now = deps.now ?? (() => new Date());
  const requestId = deps.requestId ?? (() => newId(ID_PREFIXES.request));
  let started = false;
  let owner: FeishuConnectionOwner | null = null;
  let loop: FeishuDeliveryLoop | null = null;

  const report = (error: unknown) => {
    if (deps.onError) deps.onError(error);
    else console.error("[feishu]", error instanceof Error ? error.message : "未知错误");
  };
  const diagnostic = (input: { event: string; code: string }) => {
    recordDiagnostic({
      level: input.code === "unsupported_message" ? "debug" : "info",
      event: input.event,
      message: input.event,
      requestId: requestId(),
      data: { code: input.code, appId: config.appId },
    });
  };

  return {
    isRunning: () => started && owner !== null,
    // 装配在 owner 之前就失败时，不能对外声称「未启用」。
    snapshot: () =>
      owner?.snapshot() ??
      (started && config.enabled
        ? failedSnapshot(config.appId, now().getTime())
        : disabledSnapshot()),
    start() {
      if (started) return;
      started = true;
      if (!config.enabled) return;
      try {
        // 启动时只做一次恢复：armed 说明请求可能已经到达平台，标成 uncertain 不重发。
        recoverChannelDeliveries("feishu");
        const transport = deps.transport ?? nodeHttpsTransport;
        const tokens = createFeishuTokenSource({ config, transport, now: () => now().getTime() });
        const port = createFeishuEmissionPort({ config, transport, tokens });
        loop = createFeishuDeliveryLoop({
          emit: () =>
            emitNextFeishuDelivery(port, {
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
              captureScope: captureFeishuAdmissionScope,
              admitText: (event, scope, id) => admitFeishuText(event, scope, id),
              finishChallenge: (opaque, identity, id) =>
                finishFeishuChallenge(opaque, identity, id),
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
        setFeishuDeliveryWake(() => loop?.wake());
        owner.start();
      } catch (error) {
        report(error);
      }
    },
    stop() {
      started = false;
      setFeishuDeliveryWake(null);
      loop?.stop();
      loop = null;
      owner?.stop();
      owner = null;
    },
    wake() {
      loop?.wake();
    },
  };
}
