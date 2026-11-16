import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(
  mkdtempSync(join(tmpdir(), "situation-resolver-")),
  "situation.sqlite",
);
process.env.SPROUT_PI_ENABLED = "false";

const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../src/db");
const { ID_PREFIXES, newId } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { addProjectMember, createAgentProfile } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const runs = await import("../src/domain/agent-run");
const { dispatchDelegation } = await import("../src/domain/delegation");
const { createCrewChat, crewInput } = await import("./fixtures/crew-chat");
const { resolveRunSituation } = await import("../src/server/pi-host/run");
type ProjectContext = import("../src/domain/access").ProjectContext;

const userId = "usr_situation_owner";
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(userId, "Owner", "situation@test.example");
const human: ProjectContext = { userId, requestId: newId(ID_PREFIXES.request) };
const project = createProject({ name: "Situation" }, human);
const lead = createAgentProfile({ name: "Lead", persona: "", harness: "pi" }, human);
const worker = createAgentProfile({ name: "Worker", persona: "", harness: "pi" }, human);
const other = createAgentProfile({ name: "Other", persona: "", harness: "pi" }, human);
for (const agent of [lead, worker, other]) addProjectMember(project.id, agent.id, human);

function queuedRun(chatId: string) {
  const run = runs.listAgentRuns(chatId, human).find((entry) => entry.status === "queued");
  if (!run) throw new Error(`chat ${chatId} 没有排队的 run`);
  return run;
}

function runContext(
  agentProfileId: string,
  run: { id: string; instanceId: string },
): ProjectContext {
  return {
    userId,
    requestId: newId(ID_PREFIXES.request),
    agent: { agentProfileId, instanceId: run.instanceId, runId: run.id },
  };
}

/**
 * 处境只在 open 边界从 run 自身的记录认定：chat 的 kind、crew 的当前 lead、
 * delegation 行三者对上才算数，对不上宁可失败也不降级。
 */
describe("resolveRunSituation", () => {
  it("DM 里的 worker run 认定成 dm_worker", () => {
    const direct = chats.createDirectChat(project.id, worker.id, human);
    chats.sendMessage(
      direct.chat.id,
      { senderKind: "human", senderId: userId, body: "直接任务" },
      human,
    );
    const run = queuedRun(direct.chat.id);
    expect(
      resolveRunSituation(run.id, runContext(worker.id, run), {
        id: worker.id,
        name: worker.name,
        purpose: "worker",
      }),
    ).toEqual({ kind: "dm_worker" });
  });

  it("crew 里对得上 lead 的 run 认定成 crew_lead，并带展示名", () => {
    const crew = createCrewChat(
      project.id,
      crewInput({
        projectId: project.id,
        title: "阿尔法小队",
        members: [
          { kind: "human", id: userId },
          { kind: "agent", id: lead.id },
          { kind: "agent", id: worker.id },
          { kind: "agent", id: other.id },
        ],
        initialOwner: { kind: "agent", id: lead.id },
      }),
      { kind: "human", userId, ctx: human },
    );
    chats.sendMessage(crew.id, { senderKind: "human", senderId: userId, body: "目标" }, human);
    const run = queuedRun(crew.id);
    expect(
      resolveRunSituation(run.id, runContext(lead.id, run), {
        id: lead.id,
        name: lead.name,
        purpose: "worker",
      }),
    ).toEqual({ kind: "crew_lead", crewName: "阿尔法小队" });
  });

  it("crew 里对不上当前 lead 的运行拒绝打开，不降级成 dm_worker", () => {
    const crew = createCrewChat(
      project.id,
      crewInput({
        projectId: project.id,
        title: "贝塔小队",
        members: [
          { kind: "human", id: userId },
          { kind: "agent", id: lead.id },
          { kind: "agent", id: worker.id },
        ],
        initialOwner: { kind: "agent", id: lead.id },
      }),
      { kind: "human", userId, ctx: human },
    );
    chats.sendMessage(
      crew.id,
      { senderKind: "human", senderId: userId, body: "再来一个目标" },
      human,
    );
    const run = queuedRun(crew.id);
    expect(() =>
      resolveRunSituation(run.id, runContext(lead.id, run), {
        id: other.id,
        name: other.name,
        purpose: "worker",
      }),
    ).toThrow();
  });

  it("delegation 子对话的 run 靠 delegation 行认定，并带 delegationId", () => {
    const crew = createCrewChat(
      project.id,
      crewInput({
        projectId: project.id,
        title: "委派小队",
        members: [
          { kind: "human", id: userId },
          { kind: "agent", id: lead.id },
          { kind: "agent", id: worker.id },
        ],
        initialOwner: { kind: "agent", id: lead.id },
      }),
      { kind: "human", userId, ctx: human },
    );
    const dispatched = dispatchDelegation(
      {
        chatId: crew.id,
        workerProfileId: worker.id,
        request: "检查登录页",
        clientRequestId: "crq_situation_resolver",
      },
      human,
    );
    const run = queuedRun(dispatched.childChatId);
    expect(
      resolveRunSituation(run.id, runContext(worker.id, run), {
        id: worker.id,
        name: worker.name,
        purpose: "worker",
      }),
    ).toEqual({
      kind: "delegation_worker",
      delegationId: dispatched.delegationId,
      leadName: "Lead",
    });
  });
});
