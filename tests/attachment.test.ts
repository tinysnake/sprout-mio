import { afterAll, expect, it } from "vite-plus/test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "chat-attachment-"));
process.env.DATABASE_URL = join(directory, "test.sqlite");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
const { startRuntime, shutdownRuntime } = await import("../src/server/runtime");
await startRuntime();
const { sqlite } = await import("../src/db");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const attachments = await import("../src/domain/attachment");
const { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_PER_MESSAGE, attachmentToken, scanAttachmentTokens } =
  await import("../src/contracts/attachment");
type NewAttachment = import("../src/contracts/attachment").NewAttachment;

const owner = { userId: "attachment-owner", requestId: "req_attachment" };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(owner.userId, "Human", "attachments@test.local");
const project = createProject({ name: "Attachments" }, owner);
const profile = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, owner);
addProjectMember(project.id, profile.id, owner);
const direct = chats.createDirectChat(project.id, profile.id, owner);
const strangerOwner = { userId: "attachment-stranger", requestId: "req_stranger" };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(strangerOwner.userId, "Stranger", "stranger@example.com");
const strangerContext = { userId: strangerOwner.userId, requestId: strangerOwner.requestId };

afterAll(async () => {
  await shutdownRuntime("attachment-test");
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

const file = (
  localId: string,
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): NewAttachment => ({
  localId,
  filename,
  mimeType,
  bytes,
});
const send = (body: string, list: readonly NewAttachment[] = []) =>
  chats.sendMessage(
    direct.chat.id,
    { senderKind: "human", senderId: owner.userId, body },
    owner,
    {},
    list,
  );
const count = (table: string) =>
  (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const storedBytes = () =>
  existsSync(attachments.attachmentRoot()) ? readdirSync(attachments.attachmentRoot()).sort() : [];

const png = Buffer.from(`PNG-BYTES-${"x".repeat(48)}`);
const note = Buffer.from("attachment note body");

it("发送时一次提交：元数据进库、字节落盘、引用 span 落在最终正文上", () => {
  const body = `看看 ${attachmentToken("local-png")} 这张图，还有 ${attachmentToken("local-note")}`;
  const saved = send(body, [
    file("local-png", "设计稿.png", "image/png", new Uint8Array(png)),
    file("local-note", "说明.txt", "text/plain", new Uint8Array(note)),
  ]);

  expect(saved.attachments.map((item) => item.filename)).toEqual(["设计稿.png", "说明.txt"]);
  expect(saved.attachments.map((item) => item.byteSize)).toEqual([png.byteLength, note.byteLength]);
  expect(saved.attachmentSpans).toHaveLength(2);
  expect(saved.body).not.toContain("local-png");
  expect(saved.body).not.toContain("local-note");
  expect(scanAttachmentTokens(saved.body).map((hit) => hit.localId)).toEqual(
    saved.attachments.map((item) => item.id),
  );
  for (const span of saved.attachmentSpans) {
    expect(saved.body.slice(span.start, span.end)).toBe(attachmentToken(span.attachmentId));
  }
  for (const item of saved.attachments) {
    const path = attachments.attachmentPath(item.id);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toEqual(item.filename === "设计稿.png" ? png : note);
  }
});

it("库与正文里只有元数据，字节不落进任何列", () => {
  const body = `图 ${attachmentToken("local-png")}`;
  const saved = send(body, [file("local-png", "设计稿.png", "image/png", new Uint8Array(png))]);
  const encoded = png.toString("base64");
  const row = sqlite.prepare("SELECT * FROM message WHERE id = ?").get(saved.id);
  expect(JSON.stringify(row)).not.toContain(encoded);
  const rows = sqlite.prepare("SELECT * FROM attachment WHERE message_id = ?").all(saved.id);
  expect(JSON.stringify(rows)).not.toContain(encoded);
  expect((rows[0] as { byte_size: number }).byte_size).toBe(png.byteLength);
});

it("没被正文引用的附件照样落库，只是没有 span", () => {
  const saved = send("这图没插引用", [
    file("local-png", "设计稿.png", "image/png", new Uint8Array(png)),
  ]);
  expect(saved.attachments).toHaveLength(1);
  expect(saved.attachmentSpans).toEqual([]);
});

it("引用本地占位符、技能与点名共存时下标都落在最终正文上", () => {
  const body = `@Alpha 看 ${attachmentToken("local-note")} 📖missing`;
  const saved = send(body, [file("local-note", "说明.txt", "text/plain", new Uint8Array(note))]);
  expect(saved.body.slice(0, 6)).toBe("@Alpha");
  expect(saved.mentions).toHaveLength(1);
  expect(saved.skills.map((span) => saved.body.slice(span.start, span.end))).toEqual(["📖missing"]);
  const span = saved.attachmentSpans[0]!;
  expect(saved.body.slice(span.start, span.end)).toBe(attachmentToken(span.attachmentId));
});

it("正文引用了这次没提交的附件时整体拒绝，库里与磁盘上都不留痕", () => {
  const before = { rows: count("attachment"), files: storedBytes() };
  let failure: unknown;
  try {
    send(`看 ${attachmentToken("ghost")}`);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(attachments.AttachmentError);
  expect((failure as InstanceType<typeof attachments.AttachmentError>).code).toBe(
    "validation_failed",
  );
  expect(count("attachment")).toBe(before.rows);
  expect(storedBytes()).toEqual(before.files);
});

it("超限与空的附件在写盘之前就被拒", () => {
  const cases: (readonly NewAttachment[])[] = [
    [file("a", "big.bin", "application/octet-stream", new Uint8Array(ATTACHMENT_MAX_BYTES + 1))],
    Array.from({ length: ATTACHMENT_MAX_PER_MESSAGE + 1 }, (_, index) =>
      file(`f${index}`, `f${index}.txt`, "text/plain", new Uint8Array(4)),
    ),
    [file("a", "空.txt", "text/plain", new Uint8Array(0))],
  ];
  const nine = new Uint8Array(9 * 1024 * 1024);
  cases.push([
    file("a", "a.bin", "application/octet-stream", nine),
    file("b", "b.bin", "application/octet-stream", nine),
    file("c", "c.bin", "application/octet-stream", nine),
  ]);
  const before = { rows: count("attachment"), files: storedBytes() };
  for (const list of cases) {
    expect(() => send("带附件", list)).toThrow(attachments.AttachmentError);
  }
  expect(count("attachment")).toBe(before.rows);
  expect(storedBytes()).toEqual(before.files);
});

it("别的 Project 的上下文读不到附件", () => {
  const saved = send(`图 ${attachmentToken("local-png")}`, [
    file("local-png", "设计稿.png", "image/png", new Uint8Array(png)),
  ]);
  const id = saved.attachments[0]!.id;
  expect(() => attachments.readAttachmentForRequest(id, strangerContext)).toThrow();
  expect(() => attachments.readAttachmentForRequest(id, owner)).not.toThrow();
});

it("磁盘文件被删后读取给出明确错误", () => {
  const saved = send(`图 ${attachmentToken("local-png")}`, [
    file("local-png", "设计稿.png", "image/png", new Uint8Array(png)),
  ]);
  const path = attachments.attachmentPath(saved.attachments[0]!.id);
  unlinkSync(path);
  let failure: unknown;
  try {
    attachments.readAttachmentBytes(path);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(attachments.AttachmentError);
  expect((failure as InstanceType<typeof attachments.AttachmentError>).code).toBe("not_found");
  expect((failure as Error).message).toContain("磁盘");
});
