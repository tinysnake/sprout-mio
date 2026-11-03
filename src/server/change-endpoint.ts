import { and, eq } from "drizzle-orm";
import { CHANGE_STREAM, parseChangeTopics, topicKind } from "../contracts/change-stream";
import { fail } from "../contracts/result";
import { initializeRequestContext, REQUEST_ID_HEADER } from "./request-context";

/** 主题只说明是哪一类对象；归属仍从数据库读，不信任主题里自带的 id。 */
async function authorizeTopic(userId: string, topic: string): Promise<boolean> {
  const parsed = topicKind(topic);
  if (!parsed) return false;
  const [{ db }, { chat, project }] = await Promise.all([import("../db"), import("../db/schema")]);
  const projectId =
    parsed.kind === "project"
      ? parsed.id
      : db.select({ projectId: chat.projectId }).from(chat).where(eq(chat.id, parsed.id)).get()
          ?.projectId;
  if (!projectId) return false;
  return Boolean(
    db
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.id, projectId), eq(project.createdBy, userId)))
      .get(),
  );
}

/**
 * 页面只订阅自己有权读的主题：建连时按会话身份过一遍，订阅之外的主题永远收不到。
 * 后续每次刷新都重新过边界，所以这里不再为每个事件重复判权。
 */
export async function authorizeTopics(
  userId: string,
  topics: readonly string[],
): Promise<string[]> {
  const allowed: string[] = [];
  for (const topic of topics) if (await authorizeTopic(userId, topic)) allowed.push(topic);
  return allowed;
}

/**
 * 长连接的响应体在请求返回之后才写，只能自己拼：首帧报可订阅主题，
 * 之后每个心跳与变更都是一条完整 SSE 帧。断开、排空与写失败走同一段清理。
 */
export async function eventsResponse(
  request: Request,
  now: () => number = Date.now,
): Promise<Response> {
  const requestId =
    request.headers.get(REQUEST_ID_HEADER) ?? initializeRequestContext(request).requestId;
  const { requireSession } = await import("./session");
  const session = await requireSession(request.headers, requestId);
  if (!session.ok) return Response.json(session, { status: 401 });

  const url = new URL(request.url);
  const topics = await authorizeTopics(
    session.data.userId,
    parseChangeTopics(url.searchParams.get("topics")),
  );
  if (topics.length === 0)
    return Response.json(fail({ code: "forbidden", message: "没有可订阅的主题", requestId }), {
      status: 403,
    });

  const { subscribeChanges } = await import("../domain/change-feed");
  const encoder = new TextEncoder();
  let close = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let writable = true;
      let released = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const release = () => {
        if (released) return;
        released = true;
        writable = false;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        request.signal.removeEventListener("abort", release);
        try {
          controller.close();
        } catch {
          // 服务端排空已经关掉底层响应时，关流是幂等的。
        }
      };
      close = release;
      const write = (frame: string) => {
        if (!writable) return;
        // 慢消费者不攒队：积压超过上限就断开，客户端重连后按 revision 自愈。
        const backlog = controller.desiredSize;
        if (backlog !== null && backlog < -CHANGE_STREAM.maxQueuedFrames) {
          release();
          return;
        }
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // 写失败说明底层已经断开：继续留着订阅与心跳只会泄漏。
          release();
        }
      };
      unsubscribe = subscribeChanges({
        topics,
        send: (event) =>
          write(`id: ${event.id}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`),
      });
      // 20s 心跳让代理与客户端都能区分「没有变化」和「连接已死」。
      heartbeat = setInterval(
        () => write(`event: ping\ndata: {"at":${now()}}\n\n`),
        CHANGE_STREAM.heartbeatMs,
      );
      heartbeat.unref?.();
      write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ topics })}\n\n`);
      request.signal.addEventListener("abort", release, { once: true });
      // 会话校验期间就被取消的请求不会再来 abort 事件，这里补一次。
      if (request.signal.aborted) release();
    },
    cancel: () => close(),
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      // 让 Caddy 与 nginx 不要攒包：否则推送会退化成「攒满一次再给」。
      "x-accel-buffering": "no",
    },
  });
}
