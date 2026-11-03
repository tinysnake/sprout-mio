import { describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function scenario(body: string) {
  const directory = mkdtempSync(join(tmpdir(), "sprout-agent-run-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      const { migrateDatabase } = await import('./src/db/migrate.ts');
      migrateDatabase();
      const { sqlite } = await import('./src/db/index.ts');
      const { createProject } = await import('./src/domain/project.ts');
      const agents = await import('./src/domain/agent.ts');
      const dm = await import('./src/domain/chat.ts');
      const runs = await import('./src/domain/agent-run.ts');
      const ctx = { userId: 'run-owner', requestId: 'req_agent_run_test' };
      const other = { userId: 'other-owner', requestId: 'req_other_test' };
      for (const userId of [ctx.userId, other.userId]) sqlite.prepare('INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)').run(userId,userId,userId+'@example.test');
      const project = createProject({ name: 'Run Project' }, ctx);
      const otherProject = createProject({ name: 'Other Project' }, other);
      const profile = agents.createAgentProfile({ name: 'Run Agent', persona: 'Original persona', harness: 'pi', model: 'test/model', effort: 'off' }, ctx);
      agents.addProjectMember(project.id, profile.id, ctx);
      const direct = dm.createDirectChat(project.id, profile.id, ctx);
      const send = (body) => dm.sendMessage(direct.chat.id, { senderKind: 'human', senderId: ctx.userId, body }, ctx);
      const first = send('first input');
      const run = runs.listAgentRuns(direct.chat.id, ctx)[0];
      const snapshot = { provider:'test', model:'model', thinking:'off', tools:['read'], extensions:['sprout-extension'], sessionId:run.sessionId, sessionFile:'/tmp/test-session.jsonl', cwd:'/tmp', sdkVersion:'protocol-stub', profile:{ id:profile.id, name:profile.name, persona:profile.persona, harness:'pi', model:profile.model, effort:profile.effort, updatedAt:profile.updatedAt } };
      const count = (table) => sqlite.prepare('SELECT count(*) AS n FROM '+table).get().n;
      ${body}
      sqlite.close();
      console.log('PASS agent-run behavior');
    `,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "run.sqlite"),
          BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
          NODE_ENV: "test",
        },
        encoding: "utf8",
        timeout: 60000,
      },
    );
    expect(output).toContain("PASS agent-run behavior");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Agent run 持久不变量", () => {
  it("每条 human 输入恰好一行并追加到当前 run，数据库拒绝第二个活跃 run", () => {
    scenario(`
      send('second input');
      assert.equal(count('agent_run'),1);
      assert.equal(count('agent_run_input'),2);
      assert.equal(count('message'),2);
      assert.deepEqual(runs.listAgentRunInputs(run.id,ctx).map(x=>x.disposition),['pending','pending']);
      assert.throws(()=>sqlite.prepare("INSERT INTO agent_run (id,instance_id,chat_id,project_id,request_id,status,session_id) VALUES ('duplicate',?,?,?,?,'queued',?)").run(run.instanceId,run.chatId,run.projectId,run.requestId,run.sessionId),/UNIQUE constraint/);
      assert.throws(()=>sqlite.prepare('INSERT INTO agent_run_input (message_id,run_id) VALUES (?,?)').run(first.id,run.id),/UNIQUE constraint/);
    `);
  });

  it("诊断失败回滚 human 消息与 run 输入，已存在消息不会被删除", () => {
    scenario(`
      sqlite.exec("CREATE TRIGGER reject_run_input BEFORE INSERT ON agent_run_input BEGIN SELECT RAISE(ABORT,'input unavailable'); END");
      assert.throws(()=>send('must roll back'),/input unavailable/);
      assert.equal(count('message'),1);
      assert.equal(count('agent_run_input'),1);
      sqlite.exec('DROP TRIGGER reject_run_input');
      sqlite.exec("CREATE TRIGGER reject_diagnostic BEFORE INSERT ON diagnostic_event BEGIN SELECT RAISE(ABORT,'diagnostic unavailable'); END");
      assert.throws(()=>runs.transitionAgentRun(run.id,'running',{configSnapshot:snapshot},ctx),/diagnostic unavailable/);
      assert.equal(runs.getAgentRun(run.id,ctx).status,'queued');
    `);
  });

  it("合法迁移保存实际快照，非法迁移及 stopReason error 被拒绝且不产生 agent 消息", () => {
    scenario(`
      assert.throws(()=>runs.transitionAgentRun(run.id,'completed',{},ctx),e=>e.code==='conflict');
      runs.transitionAgentRun(run.id,'running',{configSnapshot:snapshot},ctx);
      runs.markRunInputDelivered(run.id,first.id,ctx);
      const nullStopInsert = "INSERT INTO agent_run (id,instance_id,chat_id,project_id,request_id,status,queued_at,started_at,settled_at,stop_reason,session_id,config_snapshot,assistant_message_id) SELECT 'invalid-null-stop',instance_id,chat_id,project_id,request_id,'completed',queued_at,started_at,unixepoch(),NULL,session_id,config_snapshot,? FROM agent_run WHERE id=?";
      assert.throws(()=>sqlite.prepare(nullStopInsert).run(first.id,run.id),/CHECK constraint/);
      agents.updateAgentProfile(profile.id,{persona:'Changed later',model:'other/model'},ctx);
      assert.equal(runs.getAgentRun(run.id,ctx).configSnapshot.profile.persona,'Original persona');
      assert.throws(()=>runs.completeAgentRun(run.id,'false success','error',ctx),e=>e.code==='conflict');
      assert.equal(count('message'),1);
      const done = runs.completeAgentRun(run.id,'Real result through sendMessage','stop',ctx);
      const reply = dm.listMessages(run.chatId,ctx)[1];
      assert.equal(done.status,'completed');
      assert.equal(done.assistantMessageId,reply.id);
      assert.equal(reply.senderId,profile.id);
      assert.equal(reply.senderKind,'agent');
      assert.throws(()=>runs.transitionAgentRun(run.id,'running',{configSnapshot:snapshot},ctx),e=>e.code==='conflict');
    `);
  });

  it("回复仍经过 sendMessage 成员与 instance 校验，失败不会留下部分完成状态", () => {
    scenario(`
      runs.transitionAgentRun(run.id,'running',{configSnapshot:snapshot},ctx);
      sqlite.prepare("DELETE FROM chat_member WHERE chat_id=? AND member_kind='agent'").run(run.chatId);
      assert.throws(()=>runs.completeAgentRun(run.id,'must reject','stop',ctx),e=>e.code==='not_found');
      assert.equal(count('message'),1);
      assert.equal(runs.getAgentRun(run.id,ctx).status,'running');
    `);
  });

  it("查询隔离 Project，run 归属取 chat 而非损坏的 instance.projectId", () => {
    scenario(`
      for (const action of [()=>runs.getAgentRun(run.id,other),()=>runs.listAgentRunInputs(run.id,other),()=>runs.listAgentRuns(run.chatId,other)]) assert.throws(action,e=>e.code==='not_found');
      sqlite.prepare('UPDATE agent_instance SET project_id=? WHERE id=?').run(otherProject.id,run.instanceId);
      runs.transitionAgentRun(run.id,'interrupted',{errorCode:'test'},ctx);
      send('new input');
      const next = runs.listAgentRuns(run.chatId,ctx)[1];
      assert.equal(next.projectId,project.id);
      assert.equal(runs.queuedRunWork()[0].ownerId,ctx.userId);
      assert.throws(()=>runs.getAgentRun(next.id,other),e=>e.code==='not_found');
    `);
  });

  it("恢复 queued 与 running 为 interrupted，保留 completed，诊断失败回滚且恢复幂等", () => {
    scenario(`
      runs.transitionAgentRun(run.id,'running',{configSnapshot:snapshot},ctx);
      runs.completeAgentRun(run.id,'finished','stop',ctx);
      send('abandoned');
      const queued = runs.listAgentRuns(run.chatId,ctx)[1];
      sqlite.exec("CREATE TRIGGER reject_recovery BEFORE INSERT ON diagnostic_event WHEN NEW.event='agent_run.interrupted' BEGIN SELECT RAISE(ABORT,'recovery unavailable'); END");
      assert.throws(()=>runs.recoverAgentRuns(),/recovery unavailable/);
      assert.equal(runs.getAgentRun(queued.id,ctx).status,'queued');
      sqlite.exec('DROP TRIGGER reject_recovery');
      runs.recoverAgentRuns();
      send('running abandoned');
      const active = runs.listAgentRuns(run.chatId,ctx)[2];
      runs.transitionAgentRun(active.id,'running',{configSnapshot:snapshot},ctx);
      runs.recoverAgentRuns();
      runs.recoverAgentRuns();
      assert.deepEqual(runs.listAgentRuns(run.chatId,ctx).map(x=>x.status),['completed','interrupted','interrupted']);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM diagnostic_event WHERE event='agent_run.interrupted'").get().n,2);
    `);
  });

  it("活跃查询只回在跑的 run，最近一条回最新 run", () => {
    scenario(`
      const settle = (body) => {
        const current = runs.listActiveAgentRuns(direct.chat.id,ctx)[0];
        runs.transitionAgentRun(current.id,'running',{configSnapshot:snapshot},ctx);
        for (const input of runs.listAgentRunInputs(current.id,ctx)) runs.markRunInputDelivered(current.id,input.messageId,ctx);
        runs.completeAgentRun(current.id,body,'stop',ctx);
      };
      settle('one'); send('two');
      settle('two'); send('three');
      settle('three'); send('four');
      const running = runs.listActiveAgentRuns(direct.chat.id,ctx)[0];
      runs.transitionAgentRun(running.id,'running',{configSnapshot:snapshot},ctx);
      assert.deepEqual(runs.listAgentRuns(direct.chat.id,ctx).map(x=>x.status),['completed','completed','completed','running']);
      assert.deepEqual(runs.listActiveAgentRuns(direct.chat.id,ctx).map(x=>x.id),[running.id]);
      assert.equal(runs.latestAgentRun(direct.chat.id,ctx).id,running.id);
    `);
  });

  it("run 收尾后活跃查询变空，最近一条仍是它", () => {
    scenario(`
      runs.transitionAgentRun(run.id,'running',{configSnapshot:snapshot},ctx);
      assert.deepEqual(runs.listActiveAgentRuns(direct.chat.id,ctx).map(x=>x.id),[run.id]);
      for (const input of runs.listAgentRunInputs(run.id,ctx)) runs.markRunInputDelivered(run.id,input.messageId,ctx);
      runs.completeAgentRun(run.id,'done','stop',ctx);
      assert.deepEqual(runs.listActiveAgentRuns(direct.chat.id,ctx),[]);
      assert.equal(runs.latestAgentRun(direct.chat.id,ctx).id,run.id);
    `);
  });

  it("两个窄查询同样按 Project 隔离", () => {
    scenario(`
      for (const action of [()=>runs.listActiveAgentRuns(direct.chat.id,other),()=>runs.latestAgentRun(direct.chat.id,other)]) assert.throws(action,e=>e.code==='not_found');
    `);
  });

  it("非 owner Agent 的显式 @ 唤醒目标，普通汇报不级联", () => {
    scenario(`
      const amenda = agents.createAgentProfile({ name: 'Amenda', persona: '', harness: 'pi' }, ctx);
      agents.addProjectMember(project.id, amenda.id, ctx);
      const actor = { kind: 'human', userId: ctx.userId, ctx };
      const group = dm.createGroupChat(project.id, {
        projectId: project.id,
        title: 'Relay group',
        wakePolicy: 'mention_only',
        members: [
          { kind: 'human', id: ctx.userId },
          { kind: 'agent', id: profile.id },
          { kind: 'agent', id: amenda.id },
        ],
        initialOwner: { kind: 'human', id: ctx.userId },
      }, actor);
      const sender = dm.ensureInstance(group.id, profile.id, ctx);
      const target = dm.ensureInstance(group.id, amenda.id, ctx);
      sqlite.prepare("INSERT INTO agent_run (id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES ('run_relay_sender',?,?,?,?,'running',unixepoch(),?)").run(sender.id, group.id, project.id, 'req_relay', 'session_relay_sender');
      const agentCtx = { ...ctx, agent: { agentProfileId: profile.id, instanceId: sender.id, runId: 'run_relay_sender' } };
      dm.sendMessage(group.id, { senderKind: 'agent', senderId: profile.id, body: '@Amenda 接力一下' }, agentCtx);
      const targetRuns = sqlite.prepare('SELECT id,status FROM agent_run WHERE instance_id=?').all(target.id);
      assert.equal(targetRuns.length, 1);
      assert.equal(targetRuns[0].status, 'queued');
      const relayMessage = sqlite.prepare("SELECT id FROM message WHERE chat_id=? AND sender_kind='agent' AND body LIKE '@Amenda%'").get(group.id);
      assert.equal(count('agent_run_input'), 2);
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM agent_run_input WHERE message_id=?').get(relayMessage.id).n, 1);
      dm.sendMessage(group.id, { senderKind: 'agent', senderId: profile.id, body: '普通汇报，不点名' }, agentCtx);
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM agent_run WHERE instance_id=?').get(target.id).n, 1);
      assert.equal(count('agent_run_input'), 2);
    `);
  });

  it("对话页 run 视角去掉整段配置快照，只把 sessionFile 提到顶层", () => {
    scenario(`
      const { auth } = await import('./src/lib/auth.ts');
      const boundary = await import('./src/server/functions/agent-run.ts');
      const projects = await import('./src/server/functions/project.ts');
      const agentFns = await import('./src/server/functions/agent.ts');
      const chatFns = await import('./src/server/functions/chat.ts');
      const signed = await auth.api.signUpEmail({ body: { email: 'state-'+Date.now()+'@example.test', password: 'test-pass-p3-d-info-hub', name: 'state-owner' }, returnHeaders: true });
      const headers = new Headers({ cookie: signed.headers.get('set-cookie').split(';')[0] });
      const owner = { userId: signed.response.user.id, requestId: 'req_state_owner' };
      const stateProject = (await projects.createProjectBoundary({ name: 'State Project' }, headers, 'req_st1')).data;
      const stateProfile = (await agentFns.createAgentProfileBoundary({ name: 'State Agent', persona: 'persona-token', harness: 'pi', model: 'test/model', effort: 'off' }, headers, 'req_st2')).data;
      await agentFns.addProjectMemberBoundary({ projectId: stateProject.id, agentProfileId: stateProfile.id }, headers, 'req_st3');
      const chatId = (await chatFns.createDirectChatBoundary({ projectId: stateProject.id, agentProfileId: stateProfile.id }, headers, 'req_st4')).data.chat.id;
      await chatFns.sendMessageBoundary({ chatId, body: 'first' }, headers, 'req_st5');
      const read = async () => { const state = await boundary.getChatRunStateBoundary({ chatId }, headers, 'req_st6'); assert.equal(state.ok, true); return state.data; };
      const bare = await read();
      assert.equal(bare.latest.status, 'queued');
      assert.deepEqual(bare.active.map((row) => row.id), [bare.latest.id]);
      for (const row of [bare.latest, ...bare.active]) assert.equal('configSnapshot' in row, false);
      assert.equal(bare.latest.sessionFile, undefined);
      const snapshotFor = (sessionId, sessionFile) => ({ provider: 'test', model: 'model', thinking: 'off', tools: ['read'], extensions: ['sprout-extension'], sessionId, sessionFile, cwd: '/tmp', sdkVersion: 'protocol-stub', profile: { id: stateProfile.id, name: stateProfile.name, persona: 'persona-token', harness: 'pi', updatedAt: stateProfile.updatedAt } });
      runs.transitionAgentRun(bare.latest.id, 'running', { configSnapshot: snapshotFor(bare.latest.sessionId, '/tmp/state-session.jsonl') }, owner);
      const withSnapshot = await read();
      assert.equal(withSnapshot.latest.status, 'running');
      assert.equal(withSnapshot.latest.sessionFile, '/tmp/state-session.jsonl');
      assert.deepEqual(withSnapshot.active, [{ id: withSnapshot.latest.id, instanceId: withSnapshot.latest.instanceId, status: 'running' }]);
      assert.equal('configSnapshot' in withSnapshot.latest, false);
      assert.equal(JSON.stringify(withSnapshot).includes('persona-token'), false);
      assert.equal(JSON.stringify(withSnapshot).includes('protocol-stub'), false);
    `);
  });
});
