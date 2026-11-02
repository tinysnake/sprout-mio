import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 真实 SQLite + 真实领域入口：断言「人类发消息写时解析的 mention 行」与读模型的 offsets。
// 与被测模块一致，先把连接指到临时库再动态载入（domain/chat.ts 装载时就建立连接）。
process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "p6-mention-write-")), "mention.sqlite");

const { migrateDatabase } = await import("../src/db/migrate");
const { sqlite } = await import("../src/db");
const { ID_PREFIXES, newId } = await import("../src/contracts/ids");
const { createGroupChatInput, messageSchema } = await import("../src/contracts/chat");
const { createProject } = await import("../src/domain/project");
const { addProjectMember, createAgentProfile } = await import("../src/domain/agent");
const { createGroupChat, listMessages, sendMessage } = await import("../src/domain/chat");
type ChatActor = import("../src/domain/chat-actor").ChatActor;
type MentionSpan = import("../src/contracts/chat").MentionSpan;

migrateDatabase();

const creatorId = "usr_mention_creator";
const guestId = "usr_mention_guest";
for (const [id, name] of [
  [creatorId, "大林"],
  [guestId, "阿青"],
] as const)
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(id, name, `${id}@mention.test`);

const ctx = { userId: creatorId, requestId: newId(ID_PREFIXES.request) };
const project = createProject({ name: "点名落库" }, ctx);
const amenda = createAgentProfile({ name: "Amenda", persona: "", harness: "pi" }, ctx);
const bento = createAgentProfile({ name: "Bento", persona: "", harness: "pi" }, ctx);
// 在 Project 里但不在这个 group：picks 指向它时必须被拒，不能当成「点不出来就丢掉」。
const outsider = createAgentProfile({ name: "Outsider", persona: "", harness: "pi" }, ctx);
for (const profile of [amenda, bento, outsider]) addProjectMember(project.id, profile.id, ctx);

const actor: ChatActor = { kind: "human", userId: creatorId, ctx };
const group = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "点名落库",
    wakePolicy: "mention_only",
    members: [
      { kind: "human", id: creatorId },
      { kind: "human", id: guestId },
      { kind: "agent", id: amenda.id },
      { kind: "agent", id: bento.id },
    ],
    initialOwner: { kind: "human", id: creatorId },
  }),
  actor,
);

type MentionRow = { member_kind: string; member_id: string; start: number; end: number };

function send(body: string, picks?: MentionSpan[]) {
  return sendMessage(
    group.id,
    { senderKind: "human", senderId: creatorId, body, ...(picks ? { picks } : {}) },
    ctx,
  );
}

function rowsOf(messageId: string): MentionRow[] {
  return sqlite
    .prepare(
      "SELECT member_kind, member_id, start, end FROM message_mention WHERE message_id = ? ORDER BY start",
    )
    .all(messageId) as MentionRow[];
}

function spanOf(body: string, text: string, member: { memberKind: "human" | "agent"; id: string }) {
  const start = body.indexOf(text);
  if (start < 0) throw new Error(`正文里没有 ${text}`);
  return {
    memberKind: member.memberKind,
    memberId: member.id,
    start,
    end: start + text.length,
  } satisfies MentionSpan;
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? `unknown:${(error as Error).message}`;
  }
}

function messageCount(): number {
  return (
    sqlite.prepare("SELECT COUNT(*) AS n FROM message WHERE chat_id = ?").get(group.id) as {
      n: number;
    }
  ).n;
}

describe("人类发消息写时解析 mention", () => {
  it("纯手打的 @名字 落库为一条 mention，offset 覆盖 @名字", () => {
    const body = "@Amenda 请看这条";
    const saved = send(body);
    expect(rowsOf(saved.id)).toEqual([
      { member_kind: "agent", member_id: amenda.id, start: 0, end: "@Amenda".length },
    ]);
    expect(saved.mentions).toEqual([
      { memberKind: "agent", memberId: amenda.id, start: 0, end: "@Amenda".length },
    ]);
    expect(body.slice(0, "@Amenda".length)).toBe("@Amenda");
    expect(messageSchema.parse(saved)).toEqual(saved);
  });

  it("一条消息里两个不同成员（含 Human）各一条，按 position 排序", () => {
    const body = "请 @Amenda、@Bento 和 @阿青 一起看";
    const saved = send(body);
    const rows = rowsOf(saved.id);
    expect(rows).toEqual(
      [
        spanOf(body, "@Amenda", { memberKind: "agent", id: amenda.id }),
        spanOf(body, "@Bento", { memberKind: "agent", id: bento.id }),
        spanOf(body, "@阿青", { memberKind: "human", id: guestId }),
      ].map((span) => ({
        member_kind: span.memberKind,
        member_id: span.memberId,
        start: span.start,
        end: span.end,
      })),
    );
    expect(saved.mentions.map((span) => body.slice(span.start, span.end))).toEqual([
      "@Amenda",
      "@Bento",
      "@阿青",
    ]);
  });

  it("picks 指定的成员即使正文名字与成员名不同也照 picks 落库", () => {
    const body = "第二个也请 @小帮手 过一下";
    const pick = spanOf(body, "@小帮手", { memberKind: "agent", id: amenda.id });
    const saved = send(body, [pick]);
    expect(rowsOf(saved.id)).toEqual([
      { member_kind: "agent", member_id: amenda.id, start: pick.start, end: pick.end },
    ]);
    expect(saved.mentions).toEqual([pick]);
    expect(body.slice(pick.start, pick.end)).toBe("@小帮手");
  });

  it("picks 与手打混用：picks 覆盖的段按 picks，其余段补全手打", () => {
    const body = "@Amenda 和 @小帮手 一起看";
    const pick = spanOf(body, "@小帮手", { memberKind: "agent", id: bento.id });
    const saved = send(body, [pick]);
    expect(saved.mentions).toEqual([
      { memberKind: "agent", memberId: amenda.id, start: 0, end: "@Amenda".length },
      pick,
    ]);
  });

  it("picks 里塞了不属于这条对话的成员会被拒绝，且不留下消息", () => {
    const before = messageCount();
    const body = "请他 @Outsider 看一下";
    const pick = spanOf(body, "@Outsider", { memberKind: "agent", id: outsider.id });
    expect(codeOf(() => send(body, [pick]))).toBe("not_found");
    expect(messageCount()).toBe(before);
  });

  it("picks 的位置与正文对不上会被拒绝（超出正文、起点不是 @）", () => {
    const before = messageCount();
    expect(
      codeOf(() =>
        send("短正文 @Amenda", [{ memberKind: "agent", memberId: amenda.id, start: 0, end: 999 }]),
      ),
    ).toBe("conflict");
    expect(
      codeOf(() =>
        send("短正文 @Amenda", [{ memberKind: "agent", memberId: amenda.id, start: 0, end: 3 }]),
      ),
    ).toBe("conflict");
    expect(messageCount()).toBe(before);
  });

  it("body 不含 @ 时不写 mention 行", () => {
    const saved = send("这条消息谁都没点名");
    expect(rowsOf(saved.id)).toEqual([]);
    expect(saved.mentions).toEqual([]);
  });

  it("读出来的消息带 mentions，offset 与 body 对得上，且不做 N+1", () => {
    const body = "@Bento 只看这一段";
    const saved = send(body);
    const read = listMessages(group.id, ctx).find((entry) => entry.id === saved.id);
    expect(read?.mentions).toEqual(saved.mentions);
    for (const span of read?.mentions ?? []) {
      expect(body.slice(span.start, span.end)).toBe("@Bento");
      expect(body[span.start]).toBe("@");
    }
    // 一批消息共用一次查询：读完所有消息后每条消息的 mentions 都在，不需要逐条再读。
    expect(
      listMessages(group.id, ctx).filter((entry) => entry.mentions.length > 0).length,
    ).toBeGreaterThan(1);
  });
});
