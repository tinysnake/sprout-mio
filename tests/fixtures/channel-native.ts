import type { VerifiedFeishuIdentity } from "../../src/contracts/feishu";
import { feishuNativeFixture } from "./feishu-native";

export async function channelNativeFixture() {
  const fixture = await feishuNativeFixture();
  const feishu = await import("../../src/domain/feishu");
  const delivery = await import("../../src/domain/feishu-delivery");
  const channel = await import("../../src/domain/channel-delivery");
  const assistant = await import("../../src/domain/assistant");
  const runs = await import("../../src/domain/agent-run");
  let sequence = 0;
  function scenario() {
    const { sqlite, projects, agents, chats } = fixture;
    const humanId = `channel-human-${++sequence}`;
    sqlite
      .prepare(
        "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
      )
      .run(humanId, humanId, `${humanId}@example.test`);
    const ctx = { userId: humanId, requestId: `req_channel_${sequence}` };
    const project = projects.createProject({ name: "Channel project" }, ctx);
    const helper = agents.createAgentProfile({ name: "Helper", purpose: "assistant" }, ctx);
    const worker = agents.createAgentProfile({ name: "Worker" }, ctx);
    agents.addProjectMember(project.id, helper.id, ctx);
    agents.addProjectMember(project.id, worker.id, ctx);
    const dm = chats.createDirectChat(project.id, helper.id, ctx).chat;
    const work = chats.createDirectChat(project.id, worker.id, ctx).chat;
    const identity = {
      appId: `app-${sequence}`,
      tenantKey: "tenant",
      openId: `open-${sequence}`,
    } as VerifiedFeishuIdentity;
    const now = new Date();
    const lifecycle = feishu.createFeishuConnectionLifecycle(identity.appId, ctx.requestId, now);
    let epoch = lifecycle.ready(now);
    function bind() {
      const challenge = feishu.startFeishuChallenge(
        { projectId: project.id, chatId: dm.id },
        ctx,
        now,
      );
      const binding = feishu.finishFeishuChallenge(
        challenge.challenge,
        identity,
        ctx.requestId,
        now,
      );
      return { binding, scope: feishu.captureFeishuAdmissionScope(identity, epoch)! };
    }
    function principal() {
      const existing = runs
        .listAgentRuns(dm.id, ctx)
        .find((run) => run.status === "queued" || run.status === "running");
      if (!existing)
        chats.sendMessage(
          dm.id,
          { senderKind: "human", senderId: ctx.userId, body: "Please help" },
          ctx,
        );
      const run =
        existing ?? runs.listAgentRuns(dm.id, ctx).find((run) => run.status === "queued")!;
      if (run.status === "queued")
        runs.transitionAgentRun(
          run.id,
          "running",
          {
            configSnapshot: {
              provider: "test",
              model: "model",
              thinking: "off",
              tools: [],
              extensions: [],
              sessionId: run.sessionId,
              sessionFile: "/tmp/channel-test-session.jsonl",
              cwd: "/tmp",
              sdkVersion: "protocol-stub",
              profile: {
                id: helper.id,
                name: helper.name,
                persona: helper.persona,
                harness: "pi",
                model: helper.model,
                effort: helper.effort,
                updatedAt: helper.updatedAt,
              },
            },
          },
          ctx,
        );
      for (const input of runs.listAgentRunInputs(run.id, ctx)) {
        if (input.disposition === "pending") {
          const context = assistant.prepareAssistantSteerContext(run.id, input.messageId, ctx, now);
          runs.markRunInputDelivered(run.id, input.messageId, ctx, context.contentHash);
        }
      }
      return assistant.assistantPrincipal(run.id, ctx.userId, ctx.requestId);
    }
    function reply(
      body = "Complete persisted answer",
      status: "completed" | "aborted" = "completed",
    ) {
      const source = principal();
      const result =
        status === "completed"
          ? runs.settleAgentRun(source.run.id, { status, stopReason: "stop", reply: body }, ctx)
          : runs.settleAgentRun(source.run.id, { status, reply: body }, ctx);
      return result.assistantMessageId!;
    }
    function reconnect() {
      epoch = lifecycle.reconnected(new Date());
      return epoch;
    }
    return {
      ctx,
      project,
      helper,
      worker,
      dm,
      work,
      identity,
      now,
      lifecycle,
      get epoch() {
        return epoch;
      },
      bind,
      principal,
      reply,
      reconnect,
    };
  }
  return { ...fixture, feishu, delivery, channel, assistant, runs, scenario };
}
