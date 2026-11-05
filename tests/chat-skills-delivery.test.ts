import { afterAll, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import type { PiHostCommand, PiHostEvent } from "../src/server/pi-host/protocol";

const directory = mkdtempSync(join(tmpdir(), "skill-delivery-"));
process.env.DATABASE_URL = join(directory, "test.sqlite");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
process.env.SKILL_WIRE_CAPTURE = join(directory, "wire.jsonl");
const { startRuntime, shutdownRuntime } = await import("../src/server/runtime");
await startRuntime();
const { sqlite } = await import("../src/db");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const runs = await import("../src/domain/agent-run");
const { resolveSkillScope, prepareInheritedResources } =
  await import("../src/server/pi-host/skills");
const { preparePiMessage } = await import("../src/server/message-skills");
const { PiSessionProcess } = await import("../src/server/pi-host/process");
const { executeRun } = await import("../src/server/pi-host/run");
const ctx = { userId: "delivery-owner", requestId: "req_skill_delivery" };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, "Human", "delivery@skill.test");
const project = createProject({ name: "Delivery" }, ctx);
const agent = createAgentProfile({ name: "Alpha", harness: "pi", persona: "" }, ctx);
addProjectMember(project.id, agent.id, ctx);
const direct = chats.createDirectChat(project.id, agent.id, ctx);
const scope = resolveSkillScope(project.id, ctx);
mkdirSync(join(scope.resourceCwd, ".git"), { recursive: true });
const skill = (name: string, body: string) => {
  const path = join(scope.resourceCwd, ".pi/skills", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: delivery fixture\n---\n${body}\n`,
  );
};
const send = (body: string) =>
  chats.sendMessage(direct.chat.id, { senderKind: "human", senderId: ctx.userId, body }, ctx);
const runner = resolve("tests/fixtures/skill-capture-runner.mjs");
const readWire = (): (
  | PiHostCommand
  | PiHostEvent
  | { type: "sdk_prompt"; id?: string; text: string }
)[] =>
  readFileSync(process.env.SKILL_WIRE_CAPTURE!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
afterAll(async () => {
  await shutdownRuntime("skill-delivery-test");
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

it("real process prompt and steer expand fresh skill blocks without changing stored text or turn-context hash/receipt", async () => {
  skill("skill-proof-one", "ORIGINAL_BODY");
  skill("skill-proof-two", "SECOND_BODY");
  const body =
    "😀 【技能:skill-proof-one】 @Alpha 【技能:skill-proof-two】 【技能:skill-proof-one】 【技能:unknown-proof】";
  const first = send(body);
  let secondId = "";
  class CaptureProcess extends PiSessionProcess {
    override async open(config: Parameters<InstanceType<typeof PiSessionProcess>["open"]>[0]) {
      const snapshot = await super.open(config);
      skill("skill-proof-one", "PROMPT_LATEST_BODY with nested 【技能:skill-proof-two】");
      return snapshot;
    }
    override prompt(prepared: Parameters<InstanceType<typeof PiSessionProcess>["prompt"]>[0]) {
      const promise = super.prompt(prepared);
      secondId = send(body).id;
      skill("skill-proof-one", "STEER_LATEST_BODY with nested 【技能:skill-proof-two】");
      return promise;
    }
  }
  const work = runs.queuedRunWork().find((work) => work.run.chatId === direct.chat.id)!;
  await Effect.runPromise(
    executeRun(work, new CaptureProcess(work.run.id, runner), { isStopping: () => false }),
  );
  const wire = readWire();
  const prompt = wire.find((c) => c.type === "prompt")!;
  const steer = wire.find((c) => c.type === "steer")!;
  expect(prompt.text).toContain("PROMPT_LATEST_BODY");
  expect(prompt.text).not.toContain("ORIGINAL_BODY");
  expect(steer.text).toContain("STEER_LATEST_BODY");
  for (const command of [prompt, steer]) {
    expect(command.text.match(/<skill name="skill-proof-one"/g)).toHaveLength(2);
    expect(command.text.match(/<skill name="skill-proof-two"/g)).toHaveLength(1);
    expect(command.text).toContain("References are relative to");
    expect(command.text).toContain("@Alpha");
    expect(command.text).toContain("nested 【技能:skill-proof-two】");
    expect(command.text).toContain("【技能:unknown-proof】");
    expect(command.text.startsWith("/skill:")).toBe(false);
  }
  expect(wire.find((c) => c.type === "sdk_prompt")?.text).toBe(
    `${prompt.turnContext.serializedText}\n\n${prompt.text}`,
  );
  expect(wire.find((c) => c.type === "turn_context_submitted")?.contentHash).toBe(
    prompt.turnContext.contentHash,
  );
  expect(
    runs
      .listAgentRunInputs(work.run.id, ctx)
      .filter((input) => [first.id, secondId].includes(input.messageId))
      .map((input) => input.disposition),
  ).toEqual(["delivered", "delivered"]);
  for (const messageId of [first.id, secondId])
    expect(
      chats.listMessages(direct.chat.id, ctx).find((message) => message.id === messageId)?.body,
    ).toBe(body);
  const warnings = sqlite
    .prepare("SELECT data FROM diagnostic_event WHERE run_id=? AND event='pi.skill_unavailable'")
    .all(work.run.id) as { data: string }[];
  expect(warnings.map((row) => JSON.parse(row.data))).toEqual([
    { messageId: first.id, name: "unknown-proof", reason: "unknown_skill" },
    { messageId: secondId, name: "unknown-proof", reason: "unknown_skill" },
  ]);
  console.log(
    "PASS delivery prompt+steer: fresh bodies, exact raw persistence, no nested rescan, unknown warnings, original turn-context helper/hash/receipt",
  );
});

it("disabled, missing, unavailable and over-limit preparation never forge delivery or rewrite persisted spans", async () => {
  const saved = send("【技能:skill-proof-one】 【技能:unknown-proof】");
  const opened = await prepareInheritedResources(project.id, ctx);
  process.env.SPROUT_PI_INHERIT_HOST_RESOURCES = "0";
  const disabled = await preparePiMessage(
    { projectId: project.id, chatId: direct.chat.id, messageId: saved.id },
    opened,
    ctx,
  );
  expect(disabled.text).toBe(saved.body);
  expect(disabled.warnings.map((w) => w.reason)).toEqual([
    "inheritance_disabled",
    "inheritance_disabled",
  ]);
  delete process.env.SPROUT_PI_INHERIT_HOST_RESOURCES;
  rmSync(join(scope.resourceCwd, ".pi/skills/skill-proof-one"), { recursive: true });
  const removed = await preparePiMessage(
    { projectId: project.id, chatId: direct.chat.id, messageId: saved.id },
    opened,
    ctx,
  );
  expect(removed.text).toBe(saved.body);
  expect(removed.warnings.map((w) => w.reason)).toEqual(["unknown_skill", "unknown_skill"]);
  const plain = send("ordinary message without skill spans");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "missing-sdk");
  try {
    expect(
      (
        await preparePiMessage(
          { projectId: project.id, chatId: direct.chat.id, messageId: plain.id },
          opened,
          ctx,
        )
      ).text,
    ).toBe(plain.body);
    await expect(
      preparePiMessage(
        { projectId: project.id, chatId: direct.chat.id, messageId: saved.id },
        opened,
        ctx,
      ),
    ).rejects.toThrow("skill_catalog_unavailable");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  expect(
    chats.listMessages(direct.chat.id, ctx).find((message) => message.id === saved.id)?.skills,
  ).toEqual(saved.skills);
  runs.abortAgentRun(
    runs.listAgentRuns(direct.chat.id, ctx).find((run) => run.status === "queued")!.id,
    ctx,
  );
  skill("huge-proof", "你".repeat(100000));
  const huge = send("【技能:huge-proof】");
  const work = runs.queuedRunWork().find((work) => work.run.chatId === direct.chat.id)!;
  await Effect.runPromise(
    executeRun(work, new PiSessionProcess(work.run.id, runner), { isStopping: () => false }),
  );
  expect(runs.getAgentRun(work.run.id, ctx).errorCode).toBe("skill_prompt_too_large");
  expect(
    readWire().filter(
      (c) =>
        c.id === work.run.id && ["prompt", "steer", "input_delivered"].includes(String(c.type)),
    ),
  ).toEqual([]);
  const input = runs
    .listAgentRunInputs(work.run.id, ctx)
    .find((input) => input.messageId === huge.id);
  expect(input).toMatchObject({ messageId: huge.id, disposition: "pending" });
  expect(input?.deliveredAt).toBeUndefined();
  console.log(
    "PASS delivery failures: off=0, deleted/unknown skill, catalog failure, ordinary no-scan path, 256KiB rejection without prompt or receipt",
  );
});
