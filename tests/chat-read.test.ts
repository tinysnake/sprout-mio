import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 真实 SQLite + 真实领域入口：先指连接再动态载入被测模块（装载时就建立连接）。
const directory = mkdtempSync(join(tmpdir(), "chat-read-"));
process.env.DATABASE_URL = join(directory, "chat-read.sqlite");

const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../src/db");
const { ID_PREFIXES, newId } = await import("../src/contracts/ids");
const { chatMessagePreview } = await import("../src/contracts/chat-read");
const { createProject } = await import("../src/domain/project");
const { addProjectMember, createAgentProfile } = await import("../src/domain/agent");
const { createDirectChat } = await import("../src/domain/chat");
const { listChatUnread, markChatRead, senderLabelFor } = await import("../src/domain/chat-read");
import type { ProjectContext } from "../src/domain/access";

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

const userA = "usr_read_a";
const userB = "usr_read_b";
for (const [id, name] of [
  [userA, "Ada"],
  [userB, "Bo"],
] as const)
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(id, name, `${id}@chat-read.test`);

const ctxA: ProjectContext = { userId: userA, requestId: newId(ID_PREFIXES.request) };
const ctxB: ProjectContext = { userId: userB, requestId: newId(ID_PREFIXES.request) };

const projectA = createProject({ name: "读标记 A" }, ctxA);
createProject({ name: "读标记 B" }, ctxB);
const agentA = createAgentProfile({ name: "Amenda", persona: "", harness: "pi" }, ctxA);
const agentA2 = createAgentProfile({ name: "Boris", persona: "", harness: "pi" }, ctxA);
addProjectMember(projectA.id, agentA.id, ctxA);
addProjectMember(projectA.id, agentA2.id, ctxA);
const chatB = createDirectChat(projectA.id, agentA2.id, ctxA).chat;

let seconds = 1_800_000_000;
function insertMessage(
  chatId: string,
  senderKind: "human" | "agent",
  senderId: string,
  body: string,
): string {
  const id = newId(ID_PREFIXES.message);
  sqlite
    .prepare(
      "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(id, chatId, senderKind, senderId, body, (seconds += 1));
  return id;
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? `unknown:${(error as Error).message}`;
  }
}

/** 每条用例用自己的对话：DM 会被 createDirectChat 去重，所以按需新建 profile。 */
function freshChat(label: string) {
  const profile = createAgentProfile({ name: label, persona: "", harness: "pi" }, ctxA);
  addProjectMember(projectA.id, profile.id, ctxA);
  return createDirectChat(projectA.id, profile.id, ctxA).chat;
}

describe("已读游标与未读数", () => {
  it("未读不含本人消息，lastMessage 取最新一条他人消息", () => {
    const chat = freshChat("Carol");
    insertMessage(chat.id, "human", userA, "我自己发的");
    insertMessage(chat.id, "agent", agentA.id, "来自 Agent 的第一条");
    const items = listChatUnread(projectA.id, ctxA);
    const item = items.find((entry) => entry.chatId === chat.id);
    expect(item).toBeDefined();
    expect(item?.unreadCount).toBe(1);
    expect(item?.lastMessage?.senderLabel).toBe("Amenda");
    expect(item?.lastMessage?.preview).toBe("来自 Agent 的第一条");
  });

  it("markChatRead 只前进不后退，且重复调用幂等", () => {
    const chat = freshChat("Dana");
    const first = insertMessage(chat.id, "agent", agentA.id, "第一条");
    const second = insertMessage(chat.id, "agent", agentA.id, "第二条");

    expect(markChatRead(chat.id, first, ctxA)).toEqual({ chatId: chat.id, unreadCount: 1 });
    expect(listChatUnread(projectA.id, ctxA).some((entry) => entry.chatId === chat.id)).toBe(true);

    // 报一条更旧的消息不能让游标后退。
    expect(markChatRead(chat.id, first, ctxA)).toEqual({ chatId: chat.id, unreadCount: 1 });
    // 前进到最新后归零，重复调用仍归零。
    expect(markChatRead(chat.id, second, ctxA)).toEqual({ chatId: chat.id, unreadCount: 0 });
    expect(markChatRead(chat.id, second, ctxA)).toEqual({ chatId: chat.id, unreadCount: 0 });
    expect(listChatUnread(projectA.id, ctxA).some((entry) => entry.chatId === chat.id)).toBe(false);

    const marker = sqlite
      .prepare("SELECT message_id FROM chat_read_marker WHERE chat_id=? AND user_id=?")
      .get(chat.id, userA) as { message_id: string } | undefined;
    expect(marker?.message_id).toBe(second);
  });

  it("跨 Project 的读与写都被拒（不暴露存在性）", () => {
    expect(codeOf(() => listChatUnread(projectA.id, ctxB))).toBe("not_found");
    const anyMessage = insertMessage(chatB.id, "agent", agentA2.id, "别人的对话");
    expect(codeOf(() => markChatRead(chatB.id, anyMessage, ctxB))).toBe("not_found");
  });

  it("游标消息不属于该对话时被拒", () => {
    const chat = freshChat("Erin");
    const foreign = insertMessage(chatB.id, "agent", agentA2.id, "不在这个对话");
    expect(codeOf(() => markChatRead(chat.id, foreign, ctxA))).toBe("not_found");
  });

  it("预览折叠空白并截断，发送者文案按来源类别固定", () => {
    expect(chatMessagePreview("  第一行\n\n\t第二行  ")).toBe("第一行 第二行");
    const long = "字".repeat(200);
    const preview = chatMessagePreview(long);
    expect(preview.length).toBe(81);
    expect(preview.endsWith("…")).toBe(true);
    expect(chatMessagePreview("短")).toBe("短");

    expect(senderLabelFor("human", userA)).toBe("Ada");
    expect(senderLabelFor("agent", agentA.id)).toBe("Amenda");
    expect(senderLabelFor("automation", "trg_x")).toBe("自动化");
    expect(senderLabelFor("assistant_event", "ae_x")).toBe("助手");
    expect(senderLabelFor("assistant_work", "ap_x")).toBe("助手");
    expect(senderLabelFor("delegation_event", "dlg_x")).toBe("委派");
  });
});
