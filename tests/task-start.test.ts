import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { ProjectContext } from "../src/domain/access";
import type { TaskDetail } from "../src/contracts/task";

// Risk -> assertion: explicit start never enters @ routing; admission is a persisted
// send attempt, ACK is separate; only valid unattempted inputs survive normal handoff;
// owner collaboration has depth one, with unchanged Human P5a routing.
const directory = mkdtempSync(join(tmpdir(), "p5b-task-start-"));
process.env.DATABASE_URL = join(directory, "start.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { db, sqlite } = await import("../src/db");
const { agentRunInput } = await import("../src/db/schema");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const runs = await import("../src/domain/agent-run");
const tasks = await import("../src/domain/task");
const inputs = await import("../src/domain/task-input");
const { messageSchema } = await import("../src/contracts/chat");
const { ensureProjectChannel } = await import("../src/domain/channel");
const { actorFromContext } = await import("../src/domain/chat-actor");
const ctx: ProjectContext = { userId: "task-start-human", requestId: newId(ID_PREFIXES.request) };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, ctx.userId, "start@test.example");
const project = createProject({ name: "Task starts" }, ctx);
const alpha = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, ctx);
const beta = createAgentProfile({ name: "Beta", persona: "", harness: "pi" }, ctx);
for (const profile of [alpha, beta]) addProjectMember(project.id, profile.id, ctx);
const human = { kind: "human" as const, userId: ctx.userId, ctx };
function group(
  owner: "agent" | "human" = "agent",
  wakePolicy: "owner_led" | "mention_only" = "owner_led",
) {
  return chats.createGroupChat(
    project.id,
    {
      projectId: project.id,
      title: "@Beta group",
      wakePolicy,
      initialOwner: { kind: owner, id: owner === "agent" ? alpha.id : ctx.userId },
      members: [
        { kind: "human", id: ctx.userId },
        { kind: "agent", id: alpha.id },
        { kind: "agent", id: beta.id },
      ],
    },
    human,
  );
}
function create() {
  return tasks.createTask(
    {
      projectId: project.id,
      title: "@Beta must not redirect",
      description: `@${beta.id}`,
      checklist: ["verify"],
    },
    ctx,
  ).detail;
}
const command = (d: TaskDetail) => ({ taskId: d.task.id, expectedRevision: d.task.revision });
function start(chatId = group().id) {
  const result = tasks.assignTask(
    { ...command(create()), targetChatId: chatId, startNow: true },
    ctx,
  );
  if (!result.startDelivery?.runId) throw new Error("Agent start expected");
  return {
    detail: result.detail,
    runId: result.startDelivery.runId,
    messageId: result.startDelivery.messageId,
  };
}
function row(runId: string, messageId: string) {
  return db
    .select()
    .from(agentRunInput)
    .where(and(eq(agentRunInput.runId, runId), eq(agentRunInput.messageId, messageId)))
    .get()!;
}
function running(runId: string) {
  const run = runs.getAgentRun(runId, ctx);
  return runs.transitionAgentRun(
    runId,
    "running",
    {
      configSnapshot: {
        provider: "transport-test",
        model: "none",
        thinking: "off",
        tools: [],
        extensions: [],
        sessionId: run.sessionId,
        sessionFile: "/tmp/task-start-session.jsonl",
        cwd: directory,
        sdkVersion: "transport-test",
        profile: {
          id: alpha.id,
          name: alpha.name,
          persona: "",
          harness: "pi",
          updatedAt: alpha.updatedAt,
        },
      },
    },
    ctx,
  );
}
function agentContext(runId: string): ProjectContext {
  const run = runs.getAgentRun(runId, ctx);
  const instance = chats.getInstance(run.instanceId, ctx);
  return {
    ...ctx,
    agent: { runId, instanceId: run.instanceId, agentProfileId: instance.agentProfileId },
  };
}
function count(table: string) {
  return (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
const counts = () => ["agent_run", "message", "agent_run_input", "run_resource_notice"].map(count);
const send = (chatId: string, body: string, context = ctx) =>
  chats.sendMessage(
    chatId,
    {
      senderKind: context.agent ? "agent" : "human",
      senderId: context.agent?.agentProfileId ?? context.userId,
      body,
    },
    context,
  );
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("explicit Task start and collaboration", () => {
  // Four frozen §6.1 responsibility shapes, each with startNow false/true.
  for (const shape of ["dm", "agent_group", "human_group", "channel"] as const) {
    for (const startNow of [false, true])
      it(`${shape}, startNow=${startNow}: exact run/message/input/notice delta`, () => {
        const targetId =
          shape === "dm"
            ? chats.createDirectChat(project.id, alpha.id, ctx).chat.id
            : shape === "channel"
              ? ensureProjectChannel(project.id)
              : group(shape === "agent_group" ? "agent" : "human", "mention_only").id;
        // A previous DM test may leave an active run; exercise both new and reused runs explicitly below.
        const previousActive = runs
          .listAgentRuns(targetId, ctx)
          .some((r) => ["queued", "running"].includes(r.status));
        const detail = create();
        const before = counts();
        const result = tasks.assignTask(
          { ...command(detail), targetChatId: targetId, startNow },
          ctx,
        );
        const isAgent = shape === "dm" || shape === "agent_group";
        expect(counts().map((n, i) => n - before[i]!)).toEqual([
          startNow && isAgent && !previousActive ? 1 : 0,
          startNow ? 1 : 0,
          startNow && isAgent ? 1 : 0,
          0,
        ]);
        if (!startNow) {
          expect(result.startDelivery).toBeUndefined();
          return;
        }
        expect(result.startDelivery).toMatchObject({
          recipientKind: isAgent ? "agent" : "human",
          recipientId: isAgent ? alpha.id : ctx.userId,
        });
        const saved = chats
          .listMessages(targetId, ctx)
          .find((m) => m.id === result.startDelivery!.messageId)!;
        expect(saved.taskRecord).toMatchObject({ taskId: detail.task.id, kind: "start", seq: 1 });
        expect(messageSchema.safeParse(saved).success).toBe(true);
        if (result.startDelivery?.runId) {
          const context = agentContext(result.startDelivery.runId);
          expect(context.agent?.agentProfileId).toBe(alpha.id);
          expect(row(result.startDelivery.runId, saved.id)).toMatchObject({
            disposition: "pending",
            admittedAt: null,
          });
        }
      });
  }
  it("appends repeated explicit starts to the active owner run even under mention_only", () => {
    const s = start(group("agent", "mention_only").id);
    const before = counts();
    const again = tasks.startTask(command(s.detail), ctx);
    expect(again.startDelivery?.runId).toBe(s.runId);
    expect(counts().map((n, i) => n - before[i]!)).toEqual([0, 1, 1, 0]);
  });
  it("requires explicit @ for owner collaboration and never wakes from member replies", () => {
    const target = group();
    const s = start(target.id);
    const owner = agentContext(s.runId);
    const before = count("agent_run_input");
    send(target.id, "Beta naked name", owner);
    send(target.id, "@Beta_suffix is a different name", owner);
    expect(count("agent_run_input")).toBe(before);
    const wake = send(target.id, "@Beta help", owner);
    expect(count("agent_run_input")).toBe(before + 1);
    const memberRun = runs
      .listAgentRuns(target.id, ctx)
      .find((r) => r.instanceId !== owner.agent!.instanceId)!;
    const member = agentContext(memberRun.id);
    expect(runs.listAgentRunInputs(memberRun.id, ctx)).toMatchObject([{ messageId: wake.id }]);
    expect(actorFromContext(member)).toMatchObject({
      kind: "agent",
      agentProfileId: beta.id,
      instanceId: memberRun.instanceId,
      runId: memberRun.id,
    });
    expect(chats.getInstance(memberRun.instanceId, ctx)).toMatchObject({
      agentProfileId: beta.id,
      chatId: target.id,
    });
    const afterWake = count("agent_run_input");
    send(target.id, `@Alpha @${alpha.id}`, member);
    expect(count("agent_run_input")).toBe(afterWake);
    send(target.id, `@${beta.id} by id`, owner);
    expect(count("agent_run_input")).toBe(afterWake + 1);
    // Nonowner Agent in a Human-owned group cannot wake anyone.
    const humanOwned = group("human");
    send(humanOwned.id, "@Beta", ctx);
    const nonownerRun = runs.listAgentRuns(humanOwned.id, ctx)[0]!;
    const beforeNonowner = count("agent_run_input");
    send(humanOwned.id, "@Alpha", agentContext(nonownerRun.id));
    expect(count("agent_run_input")).toBe(beforeNonowner);
  });
  it.each(["mention_only", "owner_led"] as const)(
    "preserves Human P5a %s routing including bare names",
    (policy) => {
      const target = group("agent", policy);
      send(target.id, "ordinary message");
      expect(runs.listAgentRuns(target.id, ctx)).toHaveLength(policy === "owner_led" ? 1 : 0);
      const named = send(target.id, "Beta bare name");
      const recipient = runs
        .listAgentRuns(target.id, ctx)
        .find((r) => chats.getInstance(r.instanceId, ctx).agentProfileId === beta.id)!;
      expect(runs.listAgentRunInputs(recipient.id, ctx)).toMatchObject([{ messageId: named.id }]);
    },
  );
});

describe("Task input attempt, ACK and handoff boundaries", () => {
  it.each(["ack", "no_ack", "sync_throw", "async_reject"] as const)(
    "persists one attempted send across %s and never offers it again",
    async (mode) => {
      const s = start();
      running(s.runId);
      expect(row(s.runId, s.messageId)).toMatchObject({
        disposition: "pending",
        admittedAt: null,
        deliveredAt: null,
      });
      let attempts = 0;
      const send = () => {
        attempts++;
        expect(row(s.runId, s.messageId).admittedAt).toBeInstanceOf(Date);
        if (mode === "sync_throw") throw new Error("broken pipe");
        if (mode === "async_reject") return Promise.reject(new Error("lost ACK"));
        return Promise.resolve();
      };
      if (mode === "sync_throw")
        expect(() => inputs.admitTaskStartInput(s.runId, s.messageId, send)).toThrow("broken pipe");
      else if (mode === "async_reject")
        await expect(inputs.admitTaskStartInput(s.runId, s.messageId, send)).rejects.toThrow(
          "lost ACK",
        );
      else await inputs.admitTaskStartInput(s.runId, s.messageId, send);
      expect(inputs.admitTaskStartInput(s.runId, s.messageId, send)).toBeUndefined();
      expect(runs.firstPendingRunInput(s.runId, ctx)).toBeUndefined();
      expect(runs.pendingRunInputs(s.runId, ctx)).toEqual([]);
      expect(attempts).toBe(1);
      const admittedAt = row(s.runId, s.messageId).admittedAt;
      if (mode === "ack") {
        runs.markRunInputDelivered(s.runId, s.messageId, ctx);
        expect(row(s.runId, s.messageId)).toMatchObject({
          disposition: "delivered",
          admittedAt,
          deliveredAt: expect.any(Date),
        });
      } else {
        tasks.cancelTask(command(s.detail), ctx);
        expect(row(s.runId, s.messageId)).toMatchObject({
          disposition: "pending",
          admittedAt,
          deliveredAt: null,
        });
      }
      runs.completeAgentRun(s.runId, "transport boundary only", "stop", ctx);
      expect(row(s.runId, s.messageId).admittedAt).toEqual(admittedAt);
      expect(runs.listAgentRuns(s.detail.chat!.id, ctx)).toHaveLength(1);
      if (mode !== "ack")
        expect(
          sqlite
            .prepare(
              "SELECT count(*) AS n FROM diagnostic_event WHERE run_id=? AND event='agent_run.task_delivery_unconfirmed'",
            )
            .get(s.runId),
        ).toEqual({ n: 1 });
    },
  );
  it("hands off valid unattempted Task and ordinary pending inputs while retaining attempted Task inputs", () => {
    const s = start();
    running(s.runId);
    inputs.admitTaskStartInput(s.runId, s.messageId, () => undefined);
    const next = tasks.startTask(command(s.detail), ctx);
    const ordinary = send(s.detail.chat!.id, "ordinary pending");
    runs.completeAgentRun(s.runId, "normal finish", "stop", ctx);
    const queued = runs.listAgentRuns(s.detail.chat!.id, ctx).find((r) => r.status === "queued")!;
    expect(queued).toBeDefined();
    expect(runs.listAgentRunInputs(queued.id, ctx).map((i) => i.messageId)).toEqual([
      next.startDelivery!.messageId,
      ordinary.id,
    ]);
    expect(row(queued.id, next.startDelivery!.messageId)).toMatchObject({
      admittedAt: null,
      disposition: "pending",
    });
    expect(row(s.runId, s.messageId)).toMatchObject({
      admittedAt: expect.any(Date),
      disposition: "pending",
    });
  });
  it.each(["complete", "cancel", "reassign", "governance"] as const)(
    "withdraws an unattempted start after %s and selects an ordinary input instead",
    (change) => {
      const s = start();
      const ordinary = send(s.detail.chat!.id, "ordinary still valid");
      if (change === "complete")
        tasks.completeTask({ ...command(s.detail), appendRecord: { body: "finished" } }, ctx);
      if (change === "cancel") tasks.cancelTask(command(s.detail), ctx);
      if (change === "reassign")
        tasks.reassignTask({ ...command(s.detail), targetChatId: group().id }, ctx);
      if (change === "governance")
        chats.setChatOwner(
          s.detail.chat!.id,
          { kind: "human", id: ctx.userId },
          chats.getChat(s.detail.chat!.id, ctx).governanceRevision,
          human,
        );
      expect(runs.firstPendingRunInput(s.runId, ctx)?.message.id).toBe(ordinary.id);
      expect(row(s.runId, s.messageId)).toMatchObject({
        disposition: "cancelled",
        cancelReason: "task_context_changed",
        admittedAt: null,
      });
      let attempted = false;
      inputs.admitTaskStartInput(s.runId, s.messageId, () => {
        attempted = true;
      });
      expect(attempted).toBe(false);
    },
  );
  it("does not revive an attempted Task after Human stop or accept its late ACK", () => {
    const s = start();
    running(s.runId);
    inputs.admitTaskStartInput(s.runId, s.messageId, () => undefined);
    runs.abortAgentRun(s.runId, ctx);
    const stopped = row(s.runId, s.messageId);
    expect(stopped.admittedAt).toBeInstanceOf(Date);
    expect(() => runs.markRunInputDelivered(s.runId, s.messageId, ctx)).toThrow();
    let sent = false;
    inputs.admitTaskStartInput(s.runId, s.messageId, () => {
      sent = true;
    });
    expect(sent).toBe(false);
    expect(runs.firstPendingRunInput(s.runId, ctx)).toBeUndefined();
    expect(runs.listAgentRuns(s.detail.chat!.id, ctx)).toHaveLength(1);
    expect(row(s.runId, s.messageId).admittedAt).toEqual(stopped.admittedAt);
  });
  it("cancels obsolete unattempted starts before normal completion handoff while carrying ordinary input", () => {
    const s = start();
    running(s.runId);
    const ordinary = send(s.detail.chat!.id, "carry ordinary after governance change");
    const current = chats.getChat(s.detail.chat!.id, ctx);
    chats.setChatOwner(
      current.id,
      { kind: "human", id: ctx.userId },
      current.governanceRevision,
      human,
    );
    runs.completeAgentRun(s.runId, "normal completed round", "stop", ctx);
    const queued = runs.listAgentRuns(current.id, ctx).find((r) => r.status === "queued")!;
    expect(runs.listAgentRunInputs(queued.id, ctx).map((input) => input.messageId)).toEqual([
      ordinary.id,
    ]);
    expect(row(s.runId, s.messageId)).toMatchObject({
      admittedAt: null,
      disposition: "cancelled",
      cancelReason: "task_context_changed",
    });
  });
  it.each(["aborted", "failed", "interrupted"] as const)(
    "does not resurrect pending Task inputs after %s",
    (terminal) => {
      const s = start();
      if (terminal !== "aborted") running(s.runId);
      runs.transitionAgentRun(
        s.runId,
        terminal,
        terminal === "failed"
          ? { errorCode: "transport", errorMessage: "failure", stopReason: "error" }
          : { stopReason: terminal },
        ctx,
      );
      let attempts = 0;
      inputs.admitTaskStartInput(s.runId, s.messageId, () => attempts++);
      expect(attempts).toBe(0);
      expect(runs.firstPendingRunInput(s.runId, ctx)).toBeUndefined();
      expect(runs.listAgentRuns(s.detail.chat!.id, ctx)).toHaveLength(1);
      expect(row(s.runId, s.messageId).admittedAt).toBeNull();
    },
  );
});

it("reselects after session preparation, aborts empty queued work, and admits the actual prompt/steer transport", async () => {
  const { startRuntime, shutdownRuntime } = await import("../src/server/runtime");
  const { PiSessionProcess } = await import("../src/server/pi-host/process");
  const { executeRun } = await import("../src/server/pi-host/run");
  await startRuntime();
  const trace = join(directory, "host-transport.jsonl");
  const runnerPath = join(directory, "host-transport.mjs");
  // Wire-only child: no SDK/model. It exposes the real prompt/steer write and ACK
  // boundary; its settled text is used solely to exercise host lifecycle cleanup.
  writeFileSync(
    runnerPath,
    `
    import {createInterface} from 'node:readline';
    import {appendFileSync} from 'node:fs';
    const out = (event) => process.stdout.write(JSON.stringify(event)+'\\n');
    createInterface({input:process.stdin}).on('line', line => {
      const c = JSON.parse(line);
      if (c.type === 'close') process.exit(0);
      if (c.type === 'open') out({type:'ready',id:c.id,snapshot:{provider:'transport-test',model:'none',thinking:'off',tools:[],extensions:[],sessionId:c.sessionId,sessionFile:c.sessionDirectory+'/transport.jsonl',cwd:c.cwd,sdkVersion:'wire-test',profile:c.profile}});
      if (c.type === 'prompt' || c.type === 'steer') {
        appendFileSync(${JSON.stringify(trace)},JSON.stringify(c)+'\\n');
        out({type:'input_delivered',id:c.id,messageId:c.messageId});
        if(c.type==='steer' || !c.text.startsWith('已分配并请求立即开始')) out({type:'settled',id:c.id,text:'Transport lifecycle result',stopReason:'stop'});
      }
    });
  `,
  );
  const traceSchema = z.array(
    z.object({
      type: z.enum(["prompt", "steer"]),
      id: z.string(),
      messageId: z.string(),
      text: z.string(),
    }),
  );
  const observed = () =>
    traceSchema.parse(
      existsSync(trace)
        ? readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    );
  try {
    for (const mode of [
      "empty_before_prepare",
      "empty_after_prepare",
      "ordinary_fallback",
      "task_prompt_and_steer",
    ] as const) {
      const s = start();
      let extraMessageId: string | undefined;
      class Transport extends PiSessionProcess {
        override async open(config: Parameters<InstanceType<typeof PiSessionProcess>["open"]>[0]) {
          const snapshot = await super.open(config);
          if (mode === "empty_after_prepare" || mode === "ordinary_fallback")
            tasks.cancelTask(command(s.detail), ctx);
          if (mode === "ordinary_fallback")
            extraMessageId = send(s.detail.chat!.id, "fresh ordinary input").id;
          return snapshot;
        }
        override prompt(messageId: string, text: string) {
          expect(messageId).toBe(mode === "ordinary_fallback" ? extraMessageId : s.messageId);
          if (mode === "task_prompt_and_steer")
            expect(row(s.runId, messageId).admittedAt).toBeInstanceOf(Date);
          const task = super.prompt(messageId, text);
          if (mode === "task_prompt_and_steer") {
            const extra = tasks.startTask(command(s.detail), ctx);
            extraMessageId = extra.startDelivery!.messageId;
          }
          return task;
        }
        override steer(messageId: string, text: string) {
          expect(row(s.runId, messageId).admittedAt).toBeInstanceOf(Date);
          super.steer(messageId, text);
        }
      }
      const work = runs.queuedRunWork().find((entry) => entry.run.id === s.runId)!;
      if (mode === "empty_before_prepare") tasks.cancelTask(command(s.detail), ctx);
      const transport = new Transport(s.runId, runnerPath);
      try {
        await Effect.runPromise(executeRun(work, transport, { isStopping: () => false }));
      } finally {
        await transport.close();
      }
      const delivered = observed().filter((entry) => entry.id === s.runId);
      if (mode === "empty_before_prepare" || mode === "empty_after_prepare") {
        expect(delivered).toEqual([]);
        expect(runs.getAgentRun(s.runId, ctx).status).toBe("aborted");
        expect(runs.listAgentRuns(s.detail.chat!.id, ctx)).toHaveLength(1);
      } else if (mode === "ordinary_fallback") {
        expect(delivered.map((entry) => entry.messageId)).toEqual([extraMessageId]);
        expect(row(s.runId, s.messageId)).toMatchObject({
          admittedAt: null,
          disposition: "cancelled",
        });
      } else {
        expect(delivered.map((entry) => [entry.type, entry.messageId])).toEqual([
          ["prompt", s.messageId],
          ["steer", extraMessageId],
        ]);
        for (const messageId of [s.messageId, extraMessageId!])
          expect(row(s.runId, messageId)).toMatchObject({
            admittedAt: expect.any(Date),
            deliveredAt: expect.any(Date),
            disposition: "delivered",
          });
        expect(runs.getAgentRun(s.runId, ctx).status).toBe("completed");
      }
    }
  } finally {
    await shutdownRuntime("task-start-host-done");
  }
});
