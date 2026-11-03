import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "change-endpoint-"));
process.env.DATABASE_URL = join(directory, "endpoint.sqlite");
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.NODE_ENV = "test";

const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { auth } = await import("../src/lib/auth");
const { createProject } = await import("../src/domain/project");
const { addProjectMember, createAgentProfile } = await import("../src/domain/agent");
const { createDirectChat, updateChatTitle } = await import("../src/domain/chat");
const { changeFeedSnapshot, publishProjectChange } = await import("../src/domain/change-feed");
const { eventsResponse } = await import("../src/server/change-endpoint");
const { chatTopic, projectTopic } = await import("../src/contracts/change-stream");

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function signUp(tag: string) {
  const result = await auth.api.signUpEmail({
    body: {
      email: `${tag}-${Date.now()}@example.test`,
      password: "change-endpoint-test",
      name: tag,
    },
    returnHeaders: true,
  });
  const cookie = result.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, userId: result.response.user.id };
}

function eventsRequest(query: string, cookie?: string) {
  return new Request(`http://localhost:3000/api/events?${query}`, {
    headers: cookie ? { cookie } : {},
  });
}

/** 读到出现目标文本为止；超时只回已读到的内容，让断言自己失败。 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 3_000,
) {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (!buffer.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
    ]);
    if (chunk === null || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  return buffer;
}

describe("推送端点", () => {
  it("没有会话时回 401，不建立长连接", async () => {
    const response = await eventsResponse(eventsRequest("topics=project:prj_none0001"));
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("订阅别人的 Project 是 403", async () => {
    const owner = await signUp("endpoint-owner");
    const other = await signUp("endpoint-other");
    const project = createProject(
      { name: "别的 Project" },
      { userId: other.userId, requestId: "req_endpoint_other" },
    );
    const response = await eventsResponse(
      eventsRequest(`topics=${projectTopic(project.id)}`, owner.cookie),
    );
    expect(response.status).toBe(403);
  });

  it("连上先收到 ready，写入之后同一连接收到 change", async () => {
    const owner = await signUp("endpoint-stream");
    const project = createProject(
      { name: "推送 Project" },
      { userId: owner.userId, requestId: "req_endpoint_stream" },
    );
    const topic = projectTopic(project.id);
    const response = await eventsResponse(eventsRequest(`topics=${topic}`, owner.cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const reader = response.body!.getReader();
    try {
      const ready = await readUntil(reader, "event: ready");
      expect(ready).toContain("retry: 3000");
      expect(ready).toContain(topic);

      publishProjectChange(project.id);
      const change = await readUntil(reader, "event: change");
      expect(change).toContain(`"topic":"${topic}"`);
    } finally {
      await reader.cancel();
    }
  });

  it("慢消费者积压超过上限就被断开，不无限攒帧", async () => {
    const owner = await signUp("endpoint-backpressure");
    const project = createProject(
      { name: "慢消费者" },
      { userId: owner.userId, requestId: "req_endpoint_backpressure" },
    );
    vi.useFakeTimers();
    const response = await eventsResponse(
      eventsRequest(`topics=${projectTopic(project.id)}`, owner.cookie),
    );
    const reader = response.body!.getReader();
    // 心跳照常打，但读端一直不拉：积压超上限后服务端应主动关流。
    for (let beat = 0; beat < 70; beat += 1) vi.advanceTimersByTime(20_000);
    vi.useRealTimers();

    let frames = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      frames += 1;
    }
    expect(frames).toBeLessThan(70);
    expect(changeFeedSnapshot().subscribers).toBe(0);
  });

  it("读端取消之后订阅者归零，心跳不再留着", async () => {
    const owner = await signUp("endpoint-cancel");
    const project = createProject(
      { name: "取消订阅" },
      { userId: owner.userId, requestId: "req_endpoint_cancel" },
    );
    const response = await eventsResponse(
      eventsRequest(`topics=${projectTopic(project.id)}`, owner.cookie),
    );
    const reader = response.body!.getReader();
    expect(await readUntil(reader, "event: ready")).toContain("event: ready");
    expect(changeFeedSnapshot().subscribers).toBeGreaterThan(0);
    await reader.cancel();
    expect(changeFeedSnapshot().subscribers).toBe(0);
  });

  it("会话校验期间就被取消的请求不建立订阅", async () => {
    const owner = await signUp("endpoint-abort");
    const project = createProject(
      { name: "提前取消" },
      { userId: owner.userId, requestId: "req_endpoint_abort" },
    );
    const request = new Request(
      `http://localhost:3000/api/events?topics=${projectTopic(project.id)}`,
      { headers: { cookie: owner.cookie }, signal: AbortSignal.abort() },
    );
    const before = changeFeedSnapshot().subscribers;
    const response = await eventsResponse(request);
    expect(response.status).toBe(200);
    expect(changeFeedSnapshot().subscribers).toBe(before);
  });

  it("403 载荷带顶层 requestId", async () => {
    const owner = await signUp("endpoint-forbidden-shape");
    const other = await signUp("endpoint-forbidden-owner");
    const project = createProject(
      { name: "无权订阅" },
      { userId: other.userId, requestId: "req_endpoint_forbidden" },
    );
    const response = await eventsResponse(
      eventsRequest(`topics=${projectTopic(project.id)}`, owner.cookie),
    );
    const payload = (await response.json()) as { ok: boolean; requestId?: string };
    expect(payload.ok).toBe(false);
    expect(typeof payload.requestId).toBe("string");
  });

  it("主题 id 不符合共享 id 契约时直接丢掉", async () => {
    const owner = await signUp("endpoint-topic-shape");
    const response = await eventsResponse(
      eventsRequest("topics=project:prj_NOT_HEX,chat:cnv_12", owner.cookie),
    );
    expect(response.status).toBe(403);
  });

  it("订阅会话之后，改标题顺着订阅到达 Project 与 Chat 两个主题", async () => {
    const owner = await signUp("endpoint-chat");
    const ctx = { userId: owner.userId, requestId: "req_endpoint_chat" };
    const project = createProject({ name: "推送会话" }, ctx);
    const agent = createAgentProfile({ name: "推送分身", persona: "测试人设", harness: "pi" }, ctx);
    addProjectMember(project.id, agent.id, ctx);
    const chat = createDirectChat(project.id, agent.id, ctx).chat.id;
    const topics = [projectTopic(project.id), chatTopic(chat)];

    const response = await eventsResponse(
      eventsRequest(`topics=${topics.join(",")}`, owner.cookie),
    );
    const reader = response.body!.getReader();
    try {
      expect(await readUntil(reader, "event: ready")).toContain(chatTopic(chat));
      updateChatTitle(chat, "改过的标题", { kind: "human", userId: owner.userId, ctx });
      const first = await readUntil(reader, "event: change");
      const second = await readUntil(
        reader,
        '"topic":"' +
          (first.includes(projectTopic(project.id)) ? chatTopic(chat) : projectTopic(project.id)) +
          '"',
      );
      expect(first + second).toContain(projectTopic(project.id));
      expect(first + second).toContain(chatTopic(chat));
    } finally {
      await reader.cancel();
    }
  });
});
