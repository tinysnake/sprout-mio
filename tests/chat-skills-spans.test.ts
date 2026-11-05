import { afterAll, expect, it } from "vite-plus/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageList } from "../src/components/chat/message-list";

const directory = mkdtempSync(join(tmpdir(), "chat-skill-spans-"));
process.env.DATABASE_URL = join(directory, "test.sqlite");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
const { startRuntime, shutdownRuntime, machineRuntimeContext } =
  await import("../src/server/runtime");
await startRuntime();
const { sqlite } = await import("../src/db");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const runs = await import("../src/domain/agent-run");
const { PiSessionProcess } = await import("../src/server/pi-host/process");
const { issueRemoteToolGrant, revokeRemoteToolGrant, remoteAgentResponse } =
  await import("../src/server/remote-agent-gateway");
const { initializeRequestContext } = await import("../src/server/request-context");
const ctx = { userId: "skill-owner", requestId: "req_skill_spans" };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, "Human", "skills@span.test");
const project = createProject({ name: "Skill spans" }, ctx);
const profile = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, ctx);
addProjectMember(project.id, profile.id, ctx);
const direct = chats.createDirectChat(project.id, profile.id, ctx);
let transport: InstanceType<typeof PiSessionProcess> | undefined;
afterAll(async () => {
  await transport?.close();
  await shutdownRuntime("skill-spans-test");
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});
const send = (body: string) =>
  chats.sendMessage(direct.chat.id, { senderKind: "human", senderId: ctx.userId, body }, ctx);
const count = (table: string) =>
  (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

it("syntax spans freeze for human, authenticated remote sender and settled Agent replies, atomically and without catalog", async () => {
  const { resolveSkillScope, readSkillCatalog } = await import("../src/server/pi-host/skills");
  const scope = resolveSkillScope(project.id, ctx);
  const skillDir = join(scope.resourceCwd, ".pi/skills/missing");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  writeFileSync(skillFile, "---\nname: missing\ndescription: frozen fixture\n---\nold body");
  expect((await readSkillCatalog(scope, "fresh")).byName.has("missing")).toBe(true);
  const body = "😀 【技能:missing】 【技能:@Alpha】 @Alpha";
  const saved = send(body);
  expect(saved.skills.map((span) => body.slice(span.start, span.end))).toEqual([
    "【技能:missing】",
    "【技能:@Alpha】",
  ]);
  expect(saved.mentions.map((span) => body.slice(span.start, span.end))).toEqual(["@Alpha"]);
  expect(
    sqlite
      .prepare("SELECT name,start,end FROM message_skill WHERE message_id=? ORDER BY start")
      .all(saved.id),
  ).toEqual(saved.skills);
  const read = () =>
    chats.listMessages(direct.chat.id, ctx).find((message) => message.id === saved.id)!;
  const html = () =>
    renderToStaticMarkup(
      createElement(MessageList, { messages: [read()], profile: null, humanName: "Human" }),
    );
  const before = html();
  expect(before.match(/data-testid="message-skill"/g)).toHaveLength(2);
  expect(before).toContain("【技能:missing】");
  writeFileSync(skillFile, "---\nname: renamed\ndescription: changed\n---\nnew body");
  expect((await readSkillCatalog(scope, "fresh")).byName.has("missing")).toBe(false);
  expect(html()).toBe(before);
  rmSync(skillDir, { recursive: true });
  expect((await readSkillCatalog(scope, "fresh")).byName.has("renamed")).toBe(false);
  process.env.SPROUT_PI_INHERIT_HOST_RESOURCES = "false";
  expect(read().skills).toEqual(saved.skills);
  expect(html()).toBe(before);
  delete process.env.SPROUT_PI_INHERIT_HOST_RESOURCES;

  const rows = [
    count("message"),
    count("message_skill"),
    count("agent_run_input"),
    count("diagnostic_event"),
  ];
  expect(() =>
    chats.sendMessage(
      direct.chat.id,
      { senderKind: "human", senderId: ctx.userId, body: "【技能:rollback】" },
      ctx,
      {
        afterWrite() {
          throw new Error("injected skill rollback");
        },
      },
    ),
  ).toThrow("injected skill rollback");
  expect([
    count("message"),
    count("message_skill"),
    count("agent_run_input"),
    count("diagnostic_event"),
  ]).toEqual(rows);

  const run = runs.listAgentRuns(direct.chat.id, ctx)[0]!;
  const runner = join(directory, "grant-transport.mjs");
  writeFileSync(
    runner,
    `import {createInterface} from 'node:readline'; createInterface({input:process.stdin}).on('line', line => {if(JSON.parse(line).type==='close')process.exit(0)});`,
  );
  transport = new PiSessionProcess(run.id, runner);
  const runtime = { ...(await machineRuntimeContext()), requestId: ctx.requestId };
  const grant = issueRemoteToolGrant(run.id, transport, runtime);
  runs.transitionAgentRun(
    run.id,
    "running",
    {
      configSnapshot: {
        provider: "fixture",
        model: "none",
        thinking: "off",
        tools: [],
        extensions: [],
        sessionId: run.sessionId,
        sessionFile: join(directory, "session.jsonl"),
        cwd: directory,
        sdkVersion: "fixture",
        profile: {
          id: profile.id,
          name: profile.name,
          persona: "",
          harness: "pi",
          updatedAt: profile.updatedAt,
        },
      },
    },
    ctx,
  );
  const request = new Request(grant.endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${grant.secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      version: 2,
      call: {
        type: "chat_send",
        input: { projectId: project.id, body: "remote 【技能:remote-unknown】" },
      },
    }),
  });
  initializeRequestContext(request);
  const response = await remoteAgentResponse(request);
  const result = await response.json();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.data.message.skills).toEqual([{ name: "remote-unknown", start: 7, end: 26 }]);
  expect(
    chats.listMessages(direct.chat.id, ctx).find((message) => message.id === result.data.message.id)
      ?.skills,
  ).toEqual(result.data.message.skills);
  revokeRemoteToolGrant(run.id, runtime);

  const final = runs.completeAgentRun(run.id, "reply 【技能:reply-unknown】", "stop", ctx);
  const reply = chats
    .listMessages(direct.chat.id, ctx)
    .find((message) => message.id === final.assistantMessageId)!;
  expect(reply.senderKind).toBe("agent");
  expect(reply.skills.map((span) => reply.body.slice(span.start, span.end))).toEqual([
    "【技能:reply-unknown】",
  ]);
  const { writeMessageSkills } = await import("../src/domain/message-skill");
  sqlite
    .prepare("INSERT INTO message(id,chat_id,sender_kind,sender_id,body) VALUES (?,?,?,?,?)")
    .run("msg_skill_cascade", direct.chat.id, "human", ctx.userId, body);
  writeMessageSkills(direct.chat.id, "msg_skill_cascade", saved.skills);
  sqlite.prepare("DELETE FROM message WHERE id=?").run("msg_skill_cascade");
  expect(
    sqlite.prepare("SELECT * FROM message_skill WHERE message_id=?").all("msg_skill_cascade"),
  ).toEqual([]);
  console.log(
    "PASS spans: human + authenticated remote + real Agent settlement, unknown namespace, rollback, cascade, frozen render",
  );
});
