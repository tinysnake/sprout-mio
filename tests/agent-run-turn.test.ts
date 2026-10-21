import { describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function scenario(body: string) {
  const directory = mkdtempSync(join(tmpdir(), "sprout-agent-run-turn-"));
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
      const ctx = { userId: 'run-owner', requestId: 'req_agent_run_turn_test' };
      const other = { userId: 'other-owner', requestId: 'req_other_turn_test' };
      for (const userId of [ctx.userId, other.userId]) sqlite.prepare('INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)').run(userId,userId,userId+'@example.test');
      const project = createProject({ name: 'Turn Project' }, ctx);
      const profile = agents.createAgentProfile({ name: 'Turn Agent', persona: 'Original persona', harness: 'pi', model: 'test/model', effort: 'off' }, ctx);
      agents.addProjectMember(project.id, profile.id, ctx);
      const direct = dm.createDirectChat(project.id, profile.id, ctx);
      const send = (body) => dm.sendMessage(direct.chat.id, { senderKind: 'human', senderId: ctx.userId, body }, ctx);
      const first = send('first input');
      const run = runs.listAgentRuns(direct.chat.id, ctx)[0];
      const snapshot = { provider:'test', model:'model', thinking:'off', tools:['read'], extensions:['sprout-extension'], sessionId:run.sessionId, sessionFile:'/tmp/test-session.jsonl', cwd:'/tmp', sdkVersion:'protocol-stub', profile:{ id:profile.id, name:profile.name, persona:profile.persona, harness:'pi', model:profile.model, effort:profile.effort, updatedAt:profile.updatedAt } };
      const count = (table) => sqlite.prepare('SELECT count(*) AS n FROM '+table).get().n;
      ${body}
      sqlite.close();
      console.log('PASS agent-run turn behavior');
    `,
      ],
      {
        env: { ...process.env, DATABASE_URL: join(directory, "turn.sqlite"), NODE_ENV: "test" },
        encoding: "utf8",
        timeout: 60000,
      },
    );
    expect(output).toContain("PASS agent-run turn behavior");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Agent run 轮次语义", () => {
  it("停止 queued run 得 aborted，不写回复，后续消息进入新 run", () => {
    scenario(`
      const stopped = runs.abortAgentRun(run.id, ctx);
      assert.equal(stopped.status,'aborted');
      assert.equal(stopped.stopReason,'aborted');
      assert.equal(stopped.assistantMessageId,undefined);
      assert.equal(count('message'),1);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM diagnostic_event WHERE run_id=? AND event='agent_run.aborted'").get(run.id).n,1);
      send('next input');
      const next = runs.listAgentRuns(direct.chat.id, ctx)[1];
      assert.notEqual(next.id,run.id);
      assert.equal(next.status,'queued');
    `);
  });

  it("停止 running run 得 aborted，之后不写回复且不能再次停止", () => {
    scenario(`
      runs.transitionAgentRun(run.id,'running',{configSnapshot:snapshot},ctx);
      runs.markRunInputDelivered(run.id,first.id,ctx);
      const second = send('steered input');
      assert.deepEqual(runs.pendingRunInputs(run.id,ctx).map(x=>x.messageId),[second.id]);
      const stopped = runs.abortAgentRun(run.id, ctx);
      assert.equal(stopped.status,'aborted');
      assert.equal(stopped.stopReason,'aborted');
      assert.throws(()=>runs.completeAgentRun(run.id,'late reply','stop',ctx),e=>e.code==='conflict');
      assert.throws(()=>runs.abortAgentRun(run.id, ctx),e=>e.code==='conflict');
      assert.equal(count('message'),2);
      assert.equal(runs.getAgentRun(run.id,ctx).assistantMessageId,undefined);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM message WHERE sender_kind='agent'").get().n,0);
    `);
  });

  it("failed 必须带 errorCode 与非空 errorMessage，数据库 CHECK 直接反证", () => {
    scenario(`
      assert.throws(()=>runs.transitionAgentRun(run.id,'failed',{errorMessage:'only message'},ctx),e=>e.code==='conflict');
      assert.throws(()=>runs.transitionAgentRun(run.id,'failed',{errorCode:'model_error'},ctx),e=>e.code==='conflict');
      assert.throws(()=>runs.transitionAgentRun(run.id,'failed',{errorCode:'model_error',errorMessage:'   '},ctx),e=>e.code==='conflict');
      assert.equal(runs.getAgentRun(run.id,ctx).status,'queued');
      const failed = runs.transitionAgentRun(run.id,'failed',{errorCode:'model_error',errorMessage:'Pi 模型未正常完成本轮',stopReason:'error'},ctx);
      assert.equal(failed.status,'failed');
      assert.equal(failed.errorCode,'model_error');
      assert.throws(()=>{
        sqlite.prepare("INSERT INTO agent_run (id,instance_id,chat_id,project_id,request_id,status,session_id,settled_at,error_code,error_message) SELECT 'invalid-failed-no-code',instance_id,chat_id,project_id,request_id,'failed',session_id,unixepoch(),NULL,'message without code' FROM agent_run WHERE id=?").run(run.id);
      },/CHECK constraint/);
      assert.throws(()=>{
        sqlite.prepare("INSERT INTO agent_run (id,instance_id,chat_id,project_id,request_id,status,session_id,settled_at,error_code,error_message) SELECT 'invalid-failed-empty-message',instance_id,chat_id,project_id,request_id,'failed',session_id,unixepoch(),'model_error','' FROM agent_run WHERE id=?").run(run.id);
      },/CHECK constraint/);
      sqlite.prepare("INSERT INTO agent_run (id,instance_id,chat_id,project_id,request_id,status,session_id,settled_at,error_code,error_message) SELECT 'valid-failed',instance_id,chat_id,project_id,request_id,'failed',session_id,unixepoch(),'model_error','readable reason' FROM agent_run WHERE id=?").run(run.id);
      assert.equal(sqlite.prepare("SELECT error_message AS m FROM agent_run WHERE id='valid-failed'").get().m,'readable reason');
    `);
  });

  it("投递失败诊断可读且保持 pending，查询隔离 Project", () => {
    scenario(`
      runs.transitionAgentRun(run.id,'running',{configSnapshot:snapshot},ctx);
      runs.markRunInputDelivered(run.id,first.id,ctx);
      const second = send('undelivered input');
      runs.recordRunInputDeliveryFailure(run.id,second.id,'Pi 会话拒绝了该消息',ctx);
      const diagnostic = sqlite.prepare("SELECT level,message FROM diagnostic_event WHERE run_id=? AND event='agent_run.input_delivery_failed'").get(run.id);
      assert.equal(diagnostic.level,'warn');
      assert.match(diagnostic.message,/Pi 会话拒绝了该消息/);
      assert.deepEqual(runs.listAgentRunInputs(run.id,ctx).map(x=>x.disposition),['delivered','pending']);
      assert.deepEqual(runs.pendingRunInputs(run.id,ctx).map(x=>x.text),['undelivered input']);
      assert.throws(()=>runs.abortAgentRun(run.id,other),e=>e.code==='not_found');
      assert.throws(()=>runs.recordRunInputDeliveryFailure(run.id,second.id,'x',other),e=>e.code==='not_found');
      assert.equal(runs.getAgentRun(run.id,ctx).status,'running');
    `);
  });
});
