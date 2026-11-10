import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  FeishuInitiatedEmission,
  FeishuPreparedEmission,
  FeishuTransportConfig,
} from "../../contracts/feishu-channel";
import type {
  ChannelEmissionPort,
  ChannelEnvelope,
  ChannelOutcome,
  ChannelRequest,
} from "../../contracts/channel";

/**
 * 一次已经同步发起的 HTTP 交换。`response` 只描述传输层结果：HTTP 状态与正文。
 * 判定「平台是否接受」是调用方的事，传输层不猜。
 */
export type FeishuHttpExchange = Readonly<{
  initiated: true;
  response: Promise<Readonly<{ status: number; body: string }>>;
  abort: () => void;
}>;

export type FeishuHttpTransport = (input: {
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
}) => FeishuHttpExchange;

/** 分类过的传输失败：只有超时被当作 `timeout`，其余一律按「可能已发出」处理。 */
export class FeishuHttpFailure extends Error {
  constructor(readonly code: "timeout" | "socket") {
    super(`feishu_http_${code}`);
  }
}

export class FeishuEmissionError extends Error {
  constructor(
    readonly code: "token_unavailable" | "invalid_destination" | "invalid_envelope" | "disabled",
  ) {
    super(`feishu_emission_${code}`);
  }
}

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * 默认传输实现：调用即构造请求并写出正文，返回时 I/O 已经发起（不等任何 await）。
 * 这是 F2a「短事务内同步 begin」的前提；包装成 async 函数会破坏它。
 */
export const nodeHttpsTransport: FeishuHttpTransport = (input) => {
  const url = new URL(input.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FeishuHttpFailure("socket");
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  let settleReject!: (error: FeishuHttpFailure) => void;
  let settled = false;
  let abort: () => void = () => {};
  const response = new Promise<Readonly<{ status: number; body: string }>>((resolve, reject) => {
    settleReject = reject;
    const request = send(
      input.url,
      {
        method: input.method,
        headers: { ...input.headers, "content-length": String(Buffer.byteLength(input.body)) },
      },
      (reply) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        reply.on("data", (chunk: Buffer) => {
          if (bytes >= MAX_RESPONSE_BYTES) return;
          bytes += chunk.length;
          chunks.push(chunk);
        });
        reply.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status: reply.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
        reply.on("error", () => {
          if (settled) return;
          settled = true;
          reject(new FeishuHttpFailure("socket"));
        });
      },
    );
    request.setTimeout(input.timeoutMs, () => request.destroy(new FeishuHttpFailure("timeout")));
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof FeishuHttpFailure ? error : new FeishuHttpFailure("socket"));
    });
    request.end(input.body);
    abort = () => request.destroy(new FeishuHttpFailure("socket"));
  });
  return {
    initiated: true,
    response,
    abort: () => {
      if (settled) return;
      settled = true;
      settleReject(new FeishuHttpFailure("socket"));
      abort();
    },
  };
};

export type FeishuTokenSource = Readonly<{
  get(): Promise<string>;
}>;

const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const TOKEN_MIN_LIFETIME_MS = 60_000;
/** 单次换 token 的硬超时。F2a 不等待 prepare，所以必须由适配器自己封顶。 */
export const TOKEN_REQUEST_TIMEOUT_MS = 5_000;
/** 换 token 遇到传输失败时的尝试次数（含首次）。 */
const TOKEN_ATTEMPTS = 2;
/** 传输层超时之外再留一点余量，兜住没有按时销毁 socket 的实现。 */
const DEADLINE_SLACK_MS = 500;

/**
 * tenant_access_token 缓存。并发 prepare 共享同一次换取；失败不缓存，
 * 所以 prepare 失败后下一个投递会重新试，而不是拿着坏 token 继续。
 */
export function createFeishuTokenSource(options: {
  config: Pick<FeishuTransportConfig, "origin" | "appId" | "appSecret">;
  transport: FeishuHttpTransport;
  now?: () => number;
  /** 换 token 的硬超时；默认 TOKEN_REQUEST_TIMEOUT_MS，测试可以调小。 */
  timeoutMs?: number;
}): FeishuTokenSource {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  let cached: Readonly<{ token: string; refreshAtMs: number }> | null = null;
  let inflight: Promise<string> | null = null;

  const exchangeOnce = async (): Promise<string> => {
    const exchange = options.transport({
      method: "POST",
      url: `${options.config.origin}/open-apis/auth/v3/tenant_access_token/internal`,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: options.config.appId,
        app_secret: options.config.appSecret,
      }),
      timeoutMs,
    });
    const { status, body } = await withDeadline(
      exchange.response,
      timeoutMs + DEADLINE_SLACK_MS,
      exchange.abort,
    );
    const parsed = parseJsonObject(body);
    const token = parsed?.tenant_access_token;
    const expire = parsed?.expire;
    if (
      status !== 200 ||
      parsed?.code !== 0 ||
      typeof token !== "string" ||
      token.length === 0 ||
      typeof expire !== "number"
    )
      throw new FeishuEmissionError("token_unavailable");
    const lifetime = Math.max(expire * 1000 - TOKEN_REFRESH_MARGIN_MS, TOKEN_MIN_LIFETIME_MS);
    cached = { token, refreshAtMs: now() + lifetime };
    return token;
  };

  return {
    get() {
      if (cached && now() < cached.refreshAtMs) return Promise.resolve(cached.token);
      if (inflight) return inflight;
      // 传输层失败可以重试；平台明确回绝（非 0 code）不重试，直接算换 token 失败。
      inflight = (async () => {
        for (let attempt = 1; ; attempt += 1) {
          try {
            return await exchangeOnce();
          } catch (error) {
            if (!(error instanceof FeishuHttpFailure) || attempt >= TOKEN_ATTEMPTS)
              throw new FeishuEmissionError("token_unavailable");
          }
        }
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

/**
 * prepare 期间适配器自己的硬上限：即使传输层没有按时销毁 socket，
 * 换 token 也不会把一次投递无限挂住。
 */
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new FeishuHttpFailure("timeout"));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/**
 * 平台结果判定白名单。只有本地有证据的「未接受」码才允许重试：
 * 230020 是限流（SDK 源码与官方文档一致）。其余非零码、5xx、超时、200 但缺
 * message_id、正文不可解析一律 uncertain——可能已经送达，绝不自动重发。
 */
export function classifyFeishuResponse(input: { status: number; body: string }): ChannelOutcome {
  const parsed = parseJsonObject(input.body);
  if (input.status !== 200 || !parsed) return { kind: "uncertain", code: "ambiguous" };
  const code = parsed.code;
  if (code === 230020) return { kind: "not_accepted", code: "rate_limited" };
  if (code !== 0) return { kind: "uncertain", code: "ambiguous" };
  const data = parsed.data;
  const messageId =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).message_id
      : undefined;
  if (typeof messageId !== "string" || messageId.length === 0)
    return { kind: "uncertain", code: "ambiguous" };
  return { kind: "accepted", messageId };
}

const CARD_TOKEN_KEY = "token";

/** 卡片只带不透明 token；正文与结论都留在原生对话里。 */
function cardContent(envelope: Extract<ChannelEnvelope, { kind: "card" }>): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: envelope.text } },
      {
        tag: "action",
        actions: envelope.actions.map((action, index) => ({
          tag: "button",
          type: index === 0 ? "primary" : "default",
          text: { tag: "plain_text", content: action.label },
          value: { [CARD_TOKEN_KEY]: action.token },
        })),
      },
    ],
  });
}

function messageBody(request: ChannelRequest): Readonly<{
  msgType: "text" | "interactive";
  content: string;
}> {
  if (request.envelope.kind === "text")
    return { msgType: "text", content: JSON.stringify({ text: request.envelope.text }) };
  if (request.envelope.actions.length === 0) throw new FeishuEmissionError("invalid_envelope");
  return { msgType: "interactive", content: cardContent(request.envelope) };
}

export type FeishuEmissionPortDependencies = Readonly<{
  config: FeishuTransportConfig;
  transport: FeishuHttpTransport;
  tokens: FeishuTokenSource;
  now?: () => number;
}>;

/**
 * F2a 的 egress 适配器。prepare 允许 await（换 token），begin 只做同步发起。
 */
export function createFeishuEmissionPort(
  deps: FeishuEmissionPortDependencies,
): ChannelEmissionPort<FeishuPreparedEmission> {
  if (!deps.config.enabled) {
    const disabled = async (): Promise<never> => {
      throw new FeishuEmissionError("disabled");
    };
    return {
      prepare: disabled,
      begin() {
        throw new FeishuEmissionError("disabled");
      },
    };
  }
  return {
    async prepare(request) {
      const receiveId = request.route.destination.openId;
      if (typeof receiveId !== "string" || receiveId.length === 0)
        throw new FeishuEmissionError("invalid_destination");
      const token = await deps.tokens.get();
      const { msgType, content } = messageBody(request);
      return {
        deliveryId: request.deliveryId,
        requestTag: request.deliveryId,
        request: {
          url: `${deps.config.origin}/open-apis/im/v1/messages?receive_id_type=open_id`,
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            receive_id: receiveId,
            msg_type: msgType,
            content,
            uuid: request.uuid,
          }),
          // 必须短于 F2a 的等待窗口，这样本层先给出分类。
          timeoutMs: 10_000,
        },
      };
    },
    begin(prepared): FeishuInitiatedEmission {
      const exchange = deps.transport({
        method: "POST",
        url: prepared.request.url,
        headers: prepared.request.headers,
        body: prepared.request.body,
        timeoutMs: prepared.request.timeoutMs,
      });
      return {
        initiated: true,
        completion: exchange.response.then(
          (response) => classifyFeishuResponse(response),
          (error: unknown) => ({
            kind: "uncertain" as const,
            code:
              error instanceof FeishuHttpFailure && error.code === "timeout"
                ? ("timeout" as const)
                : ("ack_lost" as const),
          }),
        ),
      };
    },
  };
}
