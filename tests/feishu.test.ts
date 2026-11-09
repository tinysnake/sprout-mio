import { afterAll, expect, it } from "vite-plus/test";
import type {
  FeishuTarget,
  VerifiedFeishuEvent,
  VerifiedFeishuIdentity,
} from "../src/contracts/feishu";
import { feishuNativeFixture } from "./fixtures/feishu-native";

const fixture = await feishuNativeFixture();
const { sqlite, chats, agents, projects } = fixture;
const feishu = await import("../src/domain/feishu");
const at = new Date("2026-11-09T12:00:00Z");
let sequence = 0;
const verified = (appId: string, openId = "open", tenantKey = "tenant") =>
  ({ appId, tenantKey, openId }) as VerifiedFeishuIdentity;
const text = (
  identity: VerifiedFeishuIdentity,
  messageId = "platform-message",
  extra: Partial<VerifiedFeishuEvent> = {},
) =>
  ({
    identity,
    messageId,
    chatType: "p2p",
    messageType: "text",
    body: "Hello native assistant",
    createdAtMs: at.getTime() + 1,
    ...extra,
  }) as VerifiedFeishuEvent;

function scenario(identity = verified(`app-${++sequence}`)) {
  const userId = `human-${++sequence}`;
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(userId, userId, `${userId}@example.test`);
  const ctx = { userId, requestId: `req_${sequence}` };
  const project = projects.createProject({ name: "Feishu" }, ctx);
  const helper = agents.createAgentProfile({ name: "Assistant", purpose: "assistant" }, ctx);
  agents.addProjectMember(project.id, helper.id, ctx);
  const dm = chats.createDirectChat(project.id, helper.id, ctx).chat;
  const target = { projectId: project.id, chatId: dm.id };
  const lifecycle = feishu.createFeishuConnectionLifecycle(identity.appId, ctx.requestId, at);
  const epoch = lifecycle.ready(at);
  function bind() {
    const { challenge } = feishu.startFeishuChallenge(target, ctx, at);
    const binding = feishu.finishFeishuChallenge(challenge, identity, ctx.requestId, at);
    const scope = feishu.captureFeishuAdmissionScope(identity, epoch);
    expect(scope).toBeDefined();
    return { binding, scope: scope! };
  }
  return { identity, ctx, project, helper, dm, target, lifecycle, epoch, bind };
}
function counts() {
  return ["message", "agent_run_input", "agent_run", "feishu_inbound_receipt"].map(
    (table) => (sqlite.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n,
  );
}
function bindingError(work: () => unknown, code: string) {
  expect(work).toThrow(`Feishu binding: ${code}`);
}
afterAll(() => fixture.close());

it("one platform identity cannot race two Humans; one Human cannot replace a bound identity", () => {
  const shared = verified("conflict-app");
  const first = scenario(shared);
  const second = scenario(shared);
  const a = feishu.startFeishuChallenge(first.target, first.ctx, at);
  const b = feishu.startFeishuChallenge(second.target, second.ctx, at);
  feishu.finishFeishuChallenge(a.challenge, shared, first.ctx.requestId, at);
  bindingError(
    () => feishu.finishFeishuChallenge(b.challenge, shared, second.ctx.requestId, at),
    "identity_conflict",
  );
  expect(feishu.getFeishuBinding(second.ctx).bound).toBe(false);
  bindingError(() => feishu.startFeishuChallenge(first.target, first.ctx, at), "already_bound");
  expect(
    sqlite
      .prepare(
        "SELECT count(*) n FROM feishu_identity_slot WHERE app_id=? AND tenant_key=? AND open_id=?",
      )
      .get(shared.appId, shared.tenantKey, shared.openId),
  ).toEqual({ n: 1 });
  const other = verified(shared.appId, "different-open");
  feishu.finishFeishuChallenge(b.challenge, other, second.ctx.requestId, at);
  expect(feishu.getFeishuBinding(second.ctx).bound).toBe(true);
});

it("challenge stores only a digest, expires at ten minutes, and reissue/replay cannot bind", () => {
  const s = scenario();
  const old = feishu.startFeishuChallenge(s.target, s.ctx, at);
  const current = feishu.startFeishuChallenge(s.target, s.ctx, at);
  expect(current.expiresAtMs - at.getTime()).toBe(600000);
  expect(JSON.stringify(sqlite.prepare("SELECT * FROM feishu_challenge").all())).not.toContain(
    current.challenge,
  );
  bindingError(
    () => feishu.finishFeishuChallenge(old.challenge, s.identity, s.ctx.requestId, at),
    "invalid_challenge",
  );
  bindingError(
    () =>
      feishu.finishFeishuChallenge(
        current.challenge,
        s.identity,
        s.ctx.requestId,
        new Date(current.expiresAtMs),
      ),
    "invalid_challenge",
  );
  feishu.finishFeishuChallenge(current.challenge, s.identity, s.ctx.requestId, at);
  bindingError(
    () => feishu.finishFeishuChallenge(current.challenge, s.identity, s.ctx.requestId, at),
    "invalid_challenge",
  );
});

it("challenge code stays hand-typeable in the Feishu DM and accepts case or separator variants", () => {
  const s = scenario();
  const first = feishu.startFeishuChallenge(s.target, s.ctx, at);
  expect(first.challenge).toMatch(/^[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}$/);
  expect(feishu.isFeishuChallengeCode(first.challenge)).toBe(true);
  expect(feishu.isFeishuChallengeCode(first.challenge.toLowerCase().replace("-", " "))).toBe(true);
  expect(feishu.isFeishuChallengeCode("帮我看一下这个问题")).toBe(false);
  expect(feishu.isFeishuChallengeCode("1234-567")).toBe(false);
  expect(feishu.isFeishuChallengeCode("IIII-LLLL")).toBe(false);
  const typed = ` ${first.challenge.replace("-", "").toLowerCase()} `;
  expect(feishu.finishFeishuChallenge(typed, s.identity, s.ctx.requestId, at).bound).toBe(true);
});

it("failed binding audit hook rolls back identity, route and consumed challenge; retry remains authorized", () => {
  const s = scenario();
  const { challenge } = feishu.startFeishuChallenge(s.target, s.ctx, at);
  expect(() =>
    feishu.finishFeishuChallenge(challenge, s.identity, s.ctx.requestId, at, {
      afterWrite: () => {
        throw new Error("binding hook failed");
      },
    }),
  ).toThrow("binding hook failed");
  expect(feishu.getFeishuBinding(s.ctx).bound).toBe(false);
  expect(feishu.captureFeishuAdmissionScope(s.identity, s.epoch)).toBeUndefined();
  expect(feishu.finishFeishuChallenge(challenge, s.identity, s.ctx.requestId, at).bound).toBe(true);
});

it("binding rejects worker, archived, unauthorized and cross-Project targets; finish rechecks permission", () => {
  const s = scenario();
  const worker = agents.createAgentProfile({ name: "Worker" }, s.ctx);
  agents.addProjectMember(s.project.id, worker.id, s.ctx);
  const work = chats.createDirectChat(s.project.id, worker.id, s.ctx).chat;
  const unrelated = projects.createProject({ name: "Other project" }, s.ctx);
  const stranger = scenario();
  const invalid: FeishuTarget[] = [
    { projectId: s.project.id, chatId: work.id },
    { projectId: unrelated.id, chatId: s.dm.id },
    stranger.target,
  ];
  for (const target of invalid)
    bindingError(() => feishu.startFeishuChallenge(target, s.ctx, at), "target_unavailable");
  sqlite.prepare("UPDATE chat SET archived_at=1 WHERE id=?").run(s.dm.id);
  bindingError(() => feishu.startFeishuChallenge(s.target, s.ctx, at), "target_unavailable");
  sqlite.prepare("UPDATE chat SET archived_at=NULL WHERE id=?").run(s.dm.id);
  const pending = feishu.startFeishuChallenge(s.target, s.ctx, at);
  agents.removeProjectMember(s.project.id, s.helper.id, s.ctx);
  bindingError(
    () => feishu.finishFeishuChallenge(pending.challenge, s.identity, s.ctx.requestId, at),
    "target_unavailable",
  );
  expect(feishu.getFeishuBinding(s.ctx).bound).toBe(false);
});

for (const change of ["binding", "switch"] as const) {
  it(`rejects unseen text from before the current ${change}, even within the live epoch`, () => {
    const s = scenario();
    const activation = new Date(at.getTime() + 20_000);
    if (change === "binding") {
      const { challenge } = feishu.startFeishuChallenge(s.target, s.ctx, at);
      feishu.finishFeishuChallenge(challenge, s.identity, s.ctx.requestId, activation);
    } else {
      const { binding } = s.bind();
      const helper = agents.createAgentProfile({ name: "Next", purpose: "assistant" }, s.ctx);
      agents.addProjectMember(s.project.id, helper.id, s.ctx);
      const dm = chats.createDirectChat(s.project.id, helper.id, s.ctx).chat;
      feishu.switchFeishuTarget(
        { projectId: s.project.id, chatId: dm.id },
        binding.revision,
        s.ctx,
        activation,
      );
    }
    const scope = feishu.captureFeishuAdmissionScope(s.identity, s.epoch)!;
    const before = counts();
    expect(
      feishu.admitFeishuText(
        text(s.identity, "unseen-delayed", { createdAtMs: at.getTime() + 10_000 }),
        scope,
        s.ctx.requestId,
      ),
    ).toMatchObject({ status: "rejected", reason: "pre_route_message" });
    expect(counts()).toEqual(before);
    expect(
      feishu.admitFeishuText(
        text(s.identity, "fresh", { createdAtMs: activation.getTime() + 1 }),
        scope,
        s.ctx.requestId,
      ),
    ).toMatchObject({ status: "accepted", duplicate: false });
    expect(counts()).toEqual(before.map((n) => n + 1));
  });
}

it("text stays in the existing DM with Human sender, and duplicate app+message yields one native input/run lineage", () => {
  const s = scenario();
  const { scope } = s.bind();
  const before = counts();
  const event = text(s.identity);
  const first = feishu.admitFeishuText(event, scope, s.ctx.requestId);
  expect(first).toMatchObject({ status: "accepted", duplicate: false });
  if (first.status !== "accepted") throw new Error("admission failed");
  expect(feishu.admitFeishuText(event, scope, "req_retry")).toEqual({ ...first, duplicate: true });
  expect(counts()).toEqual(before.map((n) => n + 1));
  expect(chats.listMessages(s.dm.id, s.ctx)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: first.messageId,
        senderKind: "human",
        senderId: s.ctx.userId,
        body: event.body,
      }),
    ]),
  );
  expect(
    sqlite
      .prepare("SELECT count(*) n FROM agent_run_input WHERE message_id=?")
      .get(first.messageId),
  ).toEqual({ n: 1 });
  expect(
    sqlite
      .prepare("SELECT route_id,epoch_id,message_id FROM feishu_inbound_receipt WHERE app_id=?")
      .get(s.identity.appId),
  ).toEqual({ route_id: scope.routeId, epoch_id: s.epoch.id, message_id: first.messageId });
  const differentApp = scenario();
  const differentScope = differentApp.bind().scope;
  expect(
    feishu.admitFeishuText(text(differentApp.identity), differentScope, differentApp.ctx.requestId),
  ).toMatchObject({ status: "accepted", duplicate: false });
});

for (const failure of ["native", "hook", "receipt"] as const) {
  it(`${failure} failure rolls back receipt, message, run and input; later authorized retry succeeds`, () => {
    const s = scenario();
    const { scope } = s.bind();
    const before = counts();
    const event = text(s.identity);
    const failingTable = failure === "native" ? "agent_run_input" : "feishu_inbound_receipt";
    if (failure !== "hook")
      sqlite.exec(
        `CREATE TEMP TRIGGER fail_admission BEFORE INSERT ON ${failingTable} BEGIN SELECT RAISE(ABORT,'injected native boundary failure'); END`,
      );
    try {
      expect(() =>
        feishu.admitFeishuText(
          event,
          scope,
          s.ctx.requestId,
          failure === "hook"
            ? {
                afterWrite: () => {
                  throw new Error("injected native boundary failure");
                },
              }
            : {},
        ),
      ).toThrow("injected native boundary failure");
    } finally {
      if (failure !== "hook") sqlite.exec("DROP TRIGGER fail_admission");
    }
    expect(counts()).toEqual(before);
    expect(feishu.admitFeishuText(event, scope, s.ctx.requestId)).toMatchObject({
      status: "accepted",
      duplicate: false,
    });
    expect(counts()).toEqual(before.map((n) => n + 1));
  });
}

it("switch requires current revision and access, freezes the previous route, and rejects callbacks captured before switch", () => {
  const s = scenario();
  const { scope, binding } = s.bind();
  const event = text(s.identity);
  const first = feishu.admitFeishuText(event, scope, s.ctx.requestId);
  const otherHelper = agents.createAgentProfile(
    { name: "Second assistant", purpose: "assistant" },
    s.ctx,
  );
  agents.addProjectMember(s.project.id, otherHelper.id, s.ctx);
  const next = chats.createDirectChat(s.project.id, otherHelper.id, s.ctx).chat;
  const target = { projectId: s.project.id, chatId: next.id };
  bindingError(
    () => feishu.switchFeishuTarget(target, binding.revision - 1, s.ctx, at),
    "revision_conflict",
  );
  bindingError(
    () => feishu.switchFeishuTarget(scenario().target, binding.revision, s.ctx, at),
    "target_unavailable",
  );
  const current = feishu.switchFeishuTarget(target, binding.revision, s.ctx, at);
  expect(current.route?.id).not.toBe(binding.route?.id);
  expect(() =>
    sqlite.prepare("UPDATE feishu_route SET chat_id=? WHERE id=?").run(next.id, scope.routeId),
  ).toThrow("feishu route is immutable");
  expect(() =>
    sqlite.prepare("UPDATE feishu_route SET closed_at_ms=NULL WHERE id=?").run(scope.routeId),
  ).toThrow("feishu route is immutable");
  expect(
    sqlite
      .prepare("SELECT chat_id,revision,closed_at_ms FROM feishu_route WHERE id=?")
      .get(scope.routeId),
  ).toEqual({ chat_id: s.dm.id, revision: binding.revision, closed_at_ms: at.getTime() });
  expect(feishu.admitFeishuText(text(s.identity, "late-original"), scope, s.ctx.requestId)).toEqual(
    { status: "rejected", reason: "inactive_route" },
  );
  const nextScope = feishu.captureFeishuAdmissionScope(s.identity, s.epoch)!;
  expect(feishu.admitFeishuText(event, nextScope, s.ctx.requestId)).toEqual({
    status: "rejected",
    reason: "receipt_scope_mismatch",
  });
  expect(
    feishu.admitFeishuText(text(s.identity, "new-target"), nextScope, s.ctx.requestId),
  ).toMatchObject({ status: "accepted" });
  expect(first.status).toBe("accepted");
  expect(chats.listMessages(s.dm.id, s.ctx)).toHaveLength(1);
  expect(chats.listMessages(next.id, s.ctx)).toHaveLength(1);
});

it("unbind preserves accepted history/work and invalidates old scopes and pending challenges", () => {
  const s = scenario();
  const { scope, binding } = s.bind();
  feishu.admitFeishuText(text(s.identity), scope, s.ctx.requestId);
  const before = counts();
  bindingError(
    () => feishu.unbindFeishuIdentity(binding.revision - 1, s.ctx, at),
    "revision_conflict",
  );
  const unbound = feishu.unbindFeishuIdentity(binding.revision, s.ctx, at);
  expect(unbound.bound).toBe(false);
  expect(feishu.captureFeishuAdmissionScope(s.identity, s.epoch)).toBeUndefined();
  expect(feishu.admitFeishuText(text(s.identity, "after-unbind"), scope, s.ctx.requestId)).toEqual({
    status: "rejected",
    reason: "identity_mismatch",
  });
  expect(counts()).toEqual(before);
  expect(sqlite.prepare("SELECT status FROM agent_run WHERE chat_id=?").get(s.dm.id)).toEqual({
    status: "queued",
  });
  const pending = feishu.startFeishuChallenge(s.target, s.ctx, at);
  feishu.unbindFeishuIdentity(pending.revision, s.ctx, at);
  bindingError(
    () => feishu.finishFeishuChallenge(pending.challenge, s.identity, s.ctx.requestId, at),
    "invalid_challenge",
  );
  expect(chats.listMessages(s.dm.id, s.ctx)).toHaveLength(1);
});

it("a newly bound identity cannot retrieve an old accepted receipt or choose its Human/route", () => {
  const s = scenario();
  const { scope, binding } = s.bind();
  const event = text(s.identity);
  feishu.admitFeishuText(event, scope, s.ctx.requestId);
  feishu.unbindFeishuIdentity(binding.revision, s.ctx, at);
  const nextIdentity = verified(s.identity.appId, "replacement");
  const challenge = feishu.startFeishuChallenge(s.target, s.ctx, at);
  feishu.finishFeishuChallenge(challenge.challenge, nextIdentity, s.ctx.requestId, at);
  const current = feishu.captureFeishuAdmissionScope(nextIdentity, s.epoch)!;
  expect(feishu.admitFeishuText(text(nextIdentity), current, s.ctx.requestId)).toEqual({
    status: "rejected",
    reason: "receipt_scope_mismatch",
  });
  expect(feishu.admitFeishuText(event, current, s.ctx.requestId)).toEqual({
    status: "rejected",
    reason: "identity_mismatch",
  });
  const nextHuman = scenario(s.identity);
  const nextHumanScope = nextHuman.bind().scope;
  expect(feishu.admitFeishuText(event, nextHumanScope, nextHuman.ctx.requestId)).toEqual({
    status: "rejected",
    reason: "receipt_scope_mismatch",
  });
  expect(chats.listMessages(nextHuman.dm.id, nextHuman.ctx)).toEqual([]);
  expect(chats.listMessages(s.dm.id, s.ctx)).toHaveLength(1);
  const outsider = scenario();
  const outsiderScope = outsider.bind().scope;
  expect(
    feishu.admitFeishuText(text(nextIdentity, "forged-scope"), outsiderScope, s.ctx.requestId),
  ).toEqual({ status: "rejected", reason: "inactive_epoch" });
  const injected = {
    ...s.target,
    humanId: outsider.ctx.userId,
    revision: 500,
    appId: "forged",
    id: "forged",
  };
  const changed = feishu.switchFeishuTarget(
    injected,
    feishu.getFeishuBinding(s.ctx).revision,
    s.ctx,
    at,
  );
  expect(
    sqlite.prepare("SELECT human_id,app_id FROM feishu_route WHERE id=?").get(changed.route!.id),
  ).toEqual({ human_id: s.ctx.userId, app_id: nextIdentity.appId });
});

it("disconnect/startup/reconnect end old epochs; stale close cannot close the new epoch; unseen pre-epoch messages fail", () => {
  const s = scenario();
  const { scope } = s.bind();
  s.lifecycle.disconnected(s.epoch, at);
  expect(feishu.admitFeishuText(text(s.identity), scope, s.ctx.requestId)).toEqual({
    status: "rejected",
    reason: "inactive_epoch",
  });
  const later = new Date(at.getTime() + 1000);
  const currentEpoch = s.lifecycle.reconnected(later);
  s.lifecycle.disconnected(s.epoch, later);
  const current = feishu.captureFeishuAdmissionScope(s.identity, currentEpoch)!;
  expect(current).toBeDefined();
  const before = counts();
  expect(
    feishu.admitFeishuText(text(s.identity, "unseen-offline-message"), current, s.ctx.requestId),
  ).toEqual({ status: "rejected", reason: "pre_epoch_message" });
  expect(counts()).toEqual(before);
  expect(
    feishu.admitFeishuText(
      text(s.identity, "fresh-after-reconnect", { createdAtMs: later.getTime() }),
      current,
      s.ctx.requestId,
    ),
  ).toMatchObject({ status: "accepted" });
  const restarted = feishu.createFeishuConnectionLifecycle(s.identity.appId, "req_restart", later);
  expect(feishu.captureFeishuAdmissionScope(s.identity, currentEpoch)).toBeUndefined();
  const newEpoch = restarted.ready(later);
  s.lifecycle.disconnected(currentEpoch, later);
  expect(feishu.captureFeishuAdmissionScope(s.identity, newEpoch)).toBeDefined();
});

it("unsupported inputs and missing/invalid platform timestamps never create native work", () => {
  const s = scenario();
  const { scope } = s.bind();
  const before = counts();
  const invalid: [Partial<VerifiedFeishuEvent>, string][] = [
    [{ chatType: "group" }, "unsupported_input"],
    [{ messageType: "image" }, "unsupported_input"],
    [{ body: " " }, "unsupported_input"],
    [{ messageId: "" }, "unsupported_input"],
    [{ createdAtMs: undefined }, "untrusted_timestamp"],
    [{ createdAtMs: NaN }, "untrusted_timestamp"],
    [{ createdAtMs: 123.5 }, "untrusted_timestamp"],
  ];
  for (const [extra, reason] of invalid)
    expect(
      feishu.admitFeishuText(text(s.identity, "invalid", extra), scope, s.ctx.requestId),
    ).toEqual({ status: "rejected", reason });
  expect(counts()).toEqual(before);
});

for (const loss of ["membership", "archive", "project-access"] as const) {
  it(`current ${loss} loss prevents new admission and old receipt lookup without cancelling accepted work`, () => {
    const s = scenario();
    const { scope } = s.bind();
    const event = text(s.identity);
    feishu.admitFeishuText(event, scope, s.ctx.requestId);
    const before = counts();
    if (loss === "membership")
      sqlite
        .prepare("DELETE FROM project_member WHERE project_id=? AND agent_profile_id=?")
        .run(s.project.id, s.helper.id);
    if (loss === "archive") sqlite.prepare("UPDATE chat SET archived_at=1 WHERE id=?").run(s.dm.id);
    if (loss === "project-access")
      sqlite.prepare("UPDATE project SET created_by=? WHERE id=?").run("other-human", s.project.id);
    expect(feishu.admitFeishuText(event, scope, s.ctx.requestId)).toEqual({
      status: "rejected",
      reason: "target_unavailable",
    });
    expect(
      feishu.admitFeishuText(text(s.identity, "new-after-loss"), scope, s.ctx.requestId),
    ).toEqual({ status: "rejected", reason: "target_unavailable" });
    expect(counts()).toEqual(before);
    expect(sqlite.prepare("SELECT status FROM agent_run WHERE chat_id=?").get(s.dm.id)).toEqual({
      status: "queued",
    });
  });
}
