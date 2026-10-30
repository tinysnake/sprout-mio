import { describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function scenario(name: string, body: string, reopen?: string): void {
  const directory = mkdtempSync(join(tmpdir(), "sprout-identity-"));
  const env = {
    ...process.env,
    DATABASE_URL: join(directory, "identity.sqlite"),
    NODE_ENV: "test",
  };
  const imports = `
    import assert from 'node:assert/strict';
    import { readdirSync } from 'node:fs';
    const { migrateDatabase } = await import('./src/db/migrate.ts');
    migrateDatabase();
    migrateDatabase();
    const { sqlite } = await import('./src/db/index.ts');
    const { newId, ID_PREFIXES } = await import('./src/contracts/ids.ts');
    const agent = await import('./src/domain/agent.ts');
    const config = await import('./src/domain/project-config.ts');
    const dm = await import('./src/domain/chat.ts');
    const contracts = await import('./src/contracts/index.ts');
    const { createProject } = await import('./src/domain/project.ts');
    const ctxA = { userId: 'identity-user-a', requestId: newId(ID_PREFIXES.request) };
    const ctxB = { userId: 'identity-user-b', requestId: newId(ID_PREFIXES.request) };
    const notFound = (fn) => assert.throws(fn, (error) => error.code === 'not_found');
    const count = (table) => sqlite.prepare('SELECT count(*) AS n FROM ' + table).get().n;
  `;
  const seed = `
    for (const [id, name] of [[ctxA.userId, 'A'], [ctxB.userId, 'B']]) {
      sqlite.prepare('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)').run(id, name, name + '@identity.test');
    }
    const projectA = createProject({ name: 'Project A' }, ctxA);
    const projectB = createProject({ name: 'Project B' }, ctxB);
    const profileA = agent.createAgentProfile(contracts.createAgentProfileInput.parse({ name: 'Agent A' }), ctxA);
    const profileB = agent.createAgentProfile(contracts.createAgentProfileInput.parse({ name: 'Agent B' }), ctxB);
  `;
  const execute = (source: string) =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      env,
      encoding: "utf8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const output = execute(
      `${imports}\n${seed}\n${body}\nsqlite.close();\nconsole.log(${JSON.stringify(`PASS ${name}`)});`,
    );
    expect(output).toContain(`PASS ${name}`);
    if (reopen) {
      const output = execute(`${imports}\n${reopen}\nsqlite.close();\nconsole.log('PASS reopen');`);
      expect(output).toContain("PASS reopen");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("P2 身份、Project 授权与持久对话", () => {
  it("从零迁移两次保留七张 P2 表、索引、复合主键、CHECK 和外键", () => {
    scenario(
      "schema constraints",
      `
      const expected = {
        agent_profile: ['id','name','persona','harness','model','effort','created_by','created_at','updated_at','job_title'],
        project_profile: ['project_id','git_remote','default_branch','work_directory','updated_at'],
        project_member: ['project_id','agent_profile_id','added_by','added_at'],
        chat: ['id','project_id','kind','title','archived_at','owner_kind','owner_id','wake_policy','governance_revision','created_by','created_at','updated_at'],
        chat_member: ['chat_id','member_kind','member_id','added_at'],
        agent_instance: ['id','agent_profile_id','chat_id','project_id','created_at','updated_at'],
        message: ['id','chat_id','sender_kind','sender_id','body','created_at'],
      };
      for (const [table, columns] of Object.entries(expected)) {
        assert.deepEqual(sqlite.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name), columns);
      }
      assert.equal(count('__drizzle_migrations'), readdirSync('drizzle').filter(file => file.endsWith('.sql')).length);
      assert.equal(sqlite.pragma('foreign_keys', { simple: true }), 1);
      for (const [table, columns] of Object.entries({ project_member: ['project_id','agent_profile_id'], chat_member: ['chat_id','member_kind','member_id'] })) {
        assert.deepEqual(sqlite.prepare('PRAGMA table_info(' + table + ')').all().filter(row => row.pk).sort((a,b) => a.pk-b.pk).map(row => row.name), columns);
      }
      assert.deepEqual(sqlite.prepare('PRAGMA index_info(agent_instance_profile_chat_unique)').all().map(row => row.name), ['agent_profile_id','chat_id']);
      assert.equal(sqlite.prepare('PRAGMA index_list(agent_instance)').all().find(row => row.name === 'agent_instance_profile_chat_unique').unique, 1);
      assert.deepEqual(sqlite.prepare('PRAGMA index_info(message_chat_created_at_idx)').all().map(row => row.name), ['chat_id','created_at']);
      // kind 仍是封闭集合，且 DM 的 owner 只能是创建者本身。
      assert.throws(() => sqlite.prepare("INSERT INTO chat (id,project_id,kind,owner_kind,owner_id,created_by) VALUES ('bad-kind',?,'channel','human',?,?)").run(projectA.id, ctxA.userId, ctxA.userId), /CHECK constraint failed: chat_kind_check/);
      assert.throws(() => sqlite.prepare("INSERT INTO chat (id,project_id,kind,owner_kind,owner_id,created_by) VALUES ('bad-owner',?,'dm','agent',?,?)").run(projectA.id, profileA.id, ctxA.userId), /CHECK constraint failed: chat_dm_owner_check/);
      assert.throws(() => sqlite.prepare("INSERT INTO project_profile (project_id) VALUES ('missing')").run(), /FOREIGN KEY constraint/);
      agent.addProjectMember(projectA.id, profileA.id, ctxA);
      const direct = dm.createDirectChat(projectA.id, profileA.id, ctxA);
      assert.throws(() => sqlite.prepare('INSERT INTO agent_instance (id,agent_profile_id,chat_id,project_id) VALUES (?,?,?,?)').run(newId(ID_PREFIXES.instance), profileA.id, direct.chat.id, projectA.id), /UNIQUE constraint/);
      assert.throws(() => sqlite.prepare("INSERT INTO chat_member (chat_id,member_kind,member_id) VALUES (?,'robot','bad')").run(direct.chat.id), /CHECK constraint/);
      assert.throws(() => sqlite.prepare("INSERT INTO message (id,chat_id,sender_kind,sender_id,body) VALUES ('bad',?,'robot','bad','bad')").run(direct.chat.id), /CHECK constraint/);
    `,
    );
  });

  it("重复添加成员返回 conflict，移除成员保留既有对话与分身", () => {
    scenario(
      "membership lifecycle",
      `
      const member = agent.addProjectMember(projectA.id, profileA.id, ctxA);
      contracts.projectMemberSchema.parse(member);
      assert.throws(() => agent.addProjectMember(projectA.id, profileA.id, ctxA), error => error.code === 'conflict');
      assert.equal(count('project_member'), 1);
      assert.deepEqual(agent.listProjectMembers(projectA.id, ctxA), [member]);
      const direct = dm.createDirectChat(projectA.id, profileA.id, ctxA);
      agent.removeProjectMember(projectA.id, profileA.id, ctxA);
      assert.deepEqual(agent.listProjectMembers(projectA.id, ctxA), []);
      assert.equal(dm.getInstance(direct.instance.id, ctxA).id, direct.instance.id);
      assert.equal(dm.getChat(direct.chat.id, ctxA).id, direct.chat.id);
      notFound(() => dm.createDirectChat(projectA.id, profileA.id, ctxA));
      agent.addProjectMember(projectA.id, profileA.id, ctxA);
      assert.deepEqual(dm.createDirectChat(projectA.id, profileA.id, ctxA), direct);
    `,
    );
  });

  it("同 Project 与 profile 重开 DM 复用身份，不同 Project 有不同身份", () => {
    scenario(
      "direct identity",
      `
      agent.addProjectMember(projectA.id, profileA.id, ctxA);
      const first = dm.createDirectChat(projectA.id, profileA.id, ctxA);
      const second = dm.createDirectChat(projectA.id, profileA.id, ctxA);
      assert.deepEqual(first, second);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM chat WHERE kind = 'dm'").get().n, 1);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM chat WHERE kind = 'public_channel'").get().n, 2);
      assert.equal(count('agent_instance'), 1);
      assert.equal(count('chat_member'), 2);
      const members = dm.listChatMembers(first.chat.id, ctxA);
      assert.deepEqual(members.map(({ memberKind, memberId }) => [memberKind, memberId]), [['human', ctxA.userId], ['agent', profileA.id]]);
      assert.deepEqual(dm.listInstancesForChat(first.chat.id, ctxA), [first.instance]);
      contracts.chatSchema.parse(first.chat);
      contracts.agentInstanceSchema.parse(first.instance);
      members.forEach(member => contracts.chatMemberSchema.parse(member));
      const another = createProject({ name: 'Another Project A' }, ctxA);
      agent.addProjectMember(another.id, profileA.id, ctxA);
      const other = dm.createDirectChat(another.id, profileA.id, ctxA);
      assert.notEqual(first.chat.id, other.chat.id);
      assert.notEqual(first.instance.id, other.instance.id);
      assert.deepEqual(dm.listChats(projectA.id, ctxA).filter((chat) => chat.kind === 'dm'), [first.chat]);
      const events = sqlite.prepare("SELECT * FROM diagnostic_event WHERE event='chat.created' AND project_id=?").all(projectA.id);
      assert.equal(events.length, 1);
      assert.equal(events[0].chat_id, first.chat.id);
      assert.equal(events[0].instance_id, first.instance.id);
      assert.equal(events[0].request_id, ctxA.requestId);
      assert.equal(events[0].run_id, null);
      assert.equal(events[0].execution_id, null);
    `,
    );
  });

  it("修改 profile 后重启进程，分身、消息与 Project 配置保留", () => {
    scenario(
      "profile updates persist identity",
      `
      agent.addProjectMember(projectA.id, profileA.id, ctxA);
      const direct = dm.createDirectChat(projectA.id, profileA.id, ctxA);
      const entry = dm.sendMessage(direct.chat.id, contracts.sendMessageInput.parse({ senderKind: 'human', senderId: ctxA.userId, body: '保留历史' }), ctxA);
      const changed = agent.updateAgentProfile(profileA.id, contracts.updateAgentProfileInput.parse({ persona: '新的人设', model: 'new-model' }), ctxA);
      assert.equal(changed.persona, '新的人设');
      assert.equal(changed.model, 'new-model');
      assert.equal(changed.id, profileA.id);
      assert.deepEqual(dm.getInstance(direct.instance.id, ctxA), direct.instance);
      assert.deepEqual(dm.listMessages(direct.chat.id, ctxA), [entry]);
      config.updateProjectProfile(projectA.id, contracts.updateProjectProfileInput.parse({ gitRemote: 'https://example.test/repo.git', defaultBranch: 'develop', workDirectory: 'packages/app' }), ctxA);
      sqlite.prepare('CREATE TABLE test_identity (chat_id TEXT, instance_id TEXT, profile_id TEXT, message_id TEXT, project_id TEXT)').run();
      sqlite.prepare('INSERT INTO test_identity VALUES (?,?,?,?,?)').run(direct.chat.id, direct.instance.id, profileA.id, entry.id, projectA.id);
    `,
      `
      const saved = sqlite.prepare('SELECT * FROM test_identity').get();
      const reopened = dm.createDirectChat(saved.project_id, saved.profile_id, ctxA);
      assert.equal(reopened.chat.id, saved.chat_id);
      assert.equal(reopened.instance.id, saved.instance_id);
      assert.equal(dm.listMessages(saved.chat_id, ctxA)[0].id, saved.message_id);
      assert.equal(dm.listMessages(saved.chat_id, ctxA)[0].body, '保留历史');
      assert.equal(agent.getAgentProfile(saved.profile_id, ctxA).persona, '新的人设');
      assert.equal(agent.getAgentProfile(saved.profile_id, ctxA).model, 'new-model');
      assert.equal(config.getProjectProfile(saved.project_id, ctxA).defaultBranch, 'develop');
      assert.equal(config.getProjectProfile(saved.project_id, ctxA).workDirectory, 'packages/app');
    `,
    );
  });

  it("越权与不存在均返回相同 not_found，所有 Project 读写入口拒绝另一用户", () => {
    scenario(
      "project authorization",
      `
      agent.addProjectMember(projectA.id, profileA.id, ctxA);
      agent.addProjectMember(projectB.id, profileB.id, ctxB);
      const direct = dm.createDirectChat(projectA.id, profileA.id, ctxA);
      const other = dm.createDirectChat(projectB.id, profileB.id, ctxB);
      dm.sendMessage(direct.chat.id, { senderKind: 'human', senderId: ctxA.userId, body: 'A private' }, ctxA);
      dm.sendMessage(other.chat.id, { senderKind: 'human', senderId: ctxB.userId, body: 'B private' }, ctxB);
      const { assertProjectAccess } = await import('./src/domain/access.ts');
      for (const denied of [
        () => assertProjectAccess(ctxB, projectA.id),
        () => config.getProjectProfile(projectA.id, ctxB),
        () => config.updateProjectProfile(projectA.id, { defaultBranch: 'stolen' }, ctxB),
        () => agent.listProjectMembers(projectA.id, ctxB),
        () => agent.addProjectMember(projectA.id, profileB.id, ctxB),
        () => agent.addProjectMember(projectB.id, profileA.id, ctxB),
        () => agent.removeProjectMember(projectA.id, profileA.id, ctxB),
        () => agent.getAgentProfile(profileA.id, ctxB),
        () => agent.updateAgentProfile(profileA.id, { persona: 'stolen' }, ctxB),
        () => dm.createDirectChat(projectA.id, profileA.id, ctxB),
        () => dm.listChats(projectA.id, ctxB),
        () => dm.getChat(direct.chat.id, ctxB),
        () => dm.listChatMembers(direct.chat.id, ctxB),
        () => dm.listInstancesForChat(direct.chat.id, ctxB),
        () => dm.getInstance(direct.instance.id, ctxB),
        () => dm.listMessages(direct.chat.id, ctxB),
        () => dm.sendMessage(direct.chat.id, { senderKind: 'human', senderId: ctxB.userId, body: 'stolen' }, ctxB),
      ]) notFound(denied);
      assert.deepEqual(agent.listAgentProfiles(ctxB).map(row => row.id), [profileB.id]);
      assert.deepEqual(dm.listChats(projectB.id, ctxB).filter((chat) => chat.kind === 'dm').map(row => row.id), [other.chat.id]);
      assert.deepEqual(dm.listMessages(other.chat.id, ctxB).map(row => row.body), ['B private']);
      const errorShape = (fn) => { try { fn(); assert.fail('must fail'); } catch (error) { return [error.code, error.message]; } };
      assert.deepEqual(errorShape(() => dm.getChat(direct.chat.id, ctxB)), errorShape(() => dm.getChat(newId(ID_PREFIXES.chat), ctxB)));
      assert.deepEqual(errorShape(() => config.getProjectProfile(projectA.id, ctxB)), errorShape(() => config.getProjectProfile(newId(ID_PREFIXES.project), ctxB)));
    `,
    );
  });

  it("消息按时间和写入顺序稳定排列，拒绝伪造或跨对话的 sender", () => {
    scenario(
      "messages and senders",
      `
      agent.addProjectMember(projectA.id, profileA.id, ctxA);
      const direct = dm.createDirectChat(projectA.id, profileA.id, ctxA);
      // N04：agent sender 必须带本次 run 的身份（直接写一条活跃 run 行，只验发言资格）。
      sqlite.prepare("INSERT INTO agent_run (id, instance_id, chat_id, project_id, request_id, status, started_at, session_id) VALUES (?,?,?,?,?,'running',unixepoch(),?)")
        .run('run_identity_agent', direct.instance.id, direct.chat.id, projectA.id, ctxA.requestId, direct.instance.id);
      const agentCtx = { ...ctxA, agent: { agentProfileId: profileA.id, instanceId: direct.instance.id, runId: 'run_identity_agent' } };
      const entries = [
        dm.sendMessage(direct.chat.id, contracts.sendMessageInput.parse({ senderKind: 'human', senderId: ctxA.userId, body: '  first  ' }), ctxA),
        dm.sendMessage(direct.chat.id, { senderKind: 'agent', senderId: profileA.id, body: 'second' }, agentCtx),
        dm.sendMessage(direct.chat.id, { senderKind: 'human', senderId: ctxA.userId, body: 'third' }, ctxA),
      ];
      entries.forEach(entry => contracts.messageSchema.parse(entry));
      sqlite.prepare('UPDATE message SET created_at=100 WHERE chat_id=?').run(direct.chat.id);
      assert.deepEqual(dm.listMessages(direct.chat.id, ctxA).map(row => row.id), entries.map(row => row.id));
      sqlite.prepare('UPDATE message SET created_at=99 WHERE id=?').run(entries[2].id);
      assert.deepEqual(dm.listMessages(direct.chat.id, ctxA).map(row => row.body), ['third', 'first', 'second']);
      assert.deepEqual(dm.listMessages(direct.chat.id, ctxA), dm.listMessages(direct.chat.id, ctxA));
      // 伪造的 Human sender 仍按参与权拒绝（not_found）；run 冒充别人则按身份拒绝（forbidden）。
      notFound(() => dm.sendMessage(direct.chat.id, { senderKind: 'human', senderId: ctxB.userId, body: 'forged' }, ctxA));
      for (const senderId of [profileB.id, direct.instance.id]) {
        assert.throws(
          () => dm.sendMessage(direct.chat.id, { senderKind: 'agent', senderId, body: 'forged' }, agentCtx),
          (error) => error.code === 'forbidden',
        );
      }
      assert.equal(count('message'), 3);
      const event = sqlite.prepare("SELECT * FROM diagnostic_event WHERE event='message.sent' AND instance_id IS NOT NULL").get();
      assert.equal(event.instance_id, direct.instance.id);
      assert.equal(event.chat_id, direct.chat.id);
      assert.equal(event.project_id, projectA.id);
      assert.equal(event.request_id, ctxA.requestId);
    `,
    );
  });

  it("所有写入口在 hook 或真实诊断 INSERT 失败时整体回滚", () => {
    scenario(
      "transaction rollback",
      `
      agent.addProjectMember(projectA.id, profileA.id, ctxA);
      const spare = agent.createAgentProfile(contracts.createAgentProfileInput.parse({ name: 'spare' }), ctxA);
      agent.addProjectMember(projectA.id, spare.id, ctxA);
      const direct = dm.createDirectChat(projectA.id, profileA.id, ctxA);
      config.updateProjectProfile(projectA.id, { defaultBranch: 'main' }, ctxA);
      const tables = ['agent_profile','project_profile','project_member','chat','chat_member','agent_instance','message','diagnostic_event'];
      const snapshot = () => tables.map(table => sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
      const failing = { afterWrite: () => { throw new Error('injected write failure'); } };
      const operations = [
        hooks => agent.createAgentProfile(contracts.createAgentProfileInput.parse({ name: 'rollback' }), ctxA, hooks),
        hooks => agent.updateAgentProfile(profileA.id, { persona: 'rollback' }, ctxA, hooks),
        hooks => config.updateProjectProfile(projectA.id, { defaultBranch: 'rollback' }, ctxA, hooks),
        hooks => agent.addProjectMember(projectB.id, profileB.id, ctxB, hooks),
        hooks => agent.removeProjectMember(projectA.id, spare.id, ctxA, hooks),
        hooks => dm.createDirectChat(projectA.id, spare.id, ctxA, hooks),
        hooks => dm.sendMessage(direct.chat.id, { senderKind: 'human', senderId: ctxA.userId, body: 'rollback' }, ctxA, hooks),
      ];
      for (const operation of operations) {
        const before = snapshot();
        assert.throws(() => operation(failing), /injected write failure/);
        assert.deepEqual(snapshot(), before);
      }
      sqlite.prepare("CREATE TRIGGER reject_diagnostic BEFORE INSERT ON diagnostic_event BEGIN SELECT RAISE(ABORT, 'diagnostic unavailable'); END").run();
      for (const operation of operations) {
        const before = snapshot();
        assert.throws(() => operation({}), /diagnostic unavailable/);
        assert.deepEqual(snapshot(), before);
      }
    `,
    );
  });

  it("配置默认值、局部更新与清空字段遵循边界契约", () => {
    scenario(
      "contract boundaries and defaults",
      `
      const defaults = config.getProjectProfile(projectA.id, ctxA);
      assert.deepEqual(defaults, { projectId: projectA.id, defaultBranch: 'main', updatedAt: projectA.updatedAt });
      assert.equal(count('project_profile'), 0);
      const saved = config.updateProjectProfile(projectA.id, contracts.updateProjectProfileInput.parse({ gitRemote: 'ssh://git@example.test/repo.git', workDirectory: 'packages/app' }), ctxA);
      contracts.projectProfileSchema.parse(saved);
      assert.equal(saved.defaultBranch, 'main');
      const patched = config.updateProjectProfile(projectA.id, { defaultBranch: 'develop' }, ctxA);
      assert.equal(patched.gitRemote, saved.gitRemote);
      assert.equal(patched.workDirectory, saved.workDirectory);
      const cleared = config.updateProjectProfile(projectA.id, { gitRemote: null, workDirectory: null }, ctxA);
      assert.equal(cleared.gitRemote, undefined);
      assert.equal(cleared.workDirectory, undefined);
      assert.equal(cleared.defaultBranch, 'develop');
      agent.updateAgentProfile(profileA.id, { model: 'model', effort: 'high' }, ctxA);
      const clearedAgent = agent.updateAgentProfile(profileA.id, { model: null, effort: null }, ctxA);
      assert.equal(clearedAgent.model, undefined);
      assert.equal(clearedAgent.effort, undefined);
      contracts.agentProfileSchema.parse(clearedAgent);
      assert.equal(contracts.createAgentProfileInput.parse({ name: ' A ' }).name, 'A');
      for (const workDirectory of ['/absolute','../outside','a/../outside','C:/outside',String.fromCharCode(92) + 'host','~/outside','a' + String.fromCharCode(0) + 'b']) {
        assert.equal(contracts.updateProjectProfileInput.safeParse({ workDirectory }).success, false);
      }
      assert.equal(contracts.updateProjectProfileInput.safeParse({ gitRemote: 'git@example.test:repo.git' }).success, false);
      assert.equal(contracts.createAgentProfileInput.safeParse({ name: ' ', persona: 'x'.repeat(2001) }).success, false);
      assert.equal(contracts.sendMessageInput.safeParse({ senderKind: 'human', senderId: ctxA.userId, body: ' ' }).success, false);
      assert.equal(contracts.sendMessageInput.safeParse({ senderKind: 'human', senderId: ctxA.userId, body: 'x'.repeat(8001) }).success, false);
    `,
    );
  });
});
