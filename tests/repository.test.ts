import { describe, expect, it, vi } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT = 120000;
vi.setConfig({ testTimeout: TIMEOUT, hookTimeout: TIMEOUT });

function scenario(body: string, overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sprout-repository-"));
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
      import http from 'node:http';
      import { execFileSync } from 'node:child_process';
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const { migrateDatabase } = await import('./src/db/migrate.ts');
      migrateDatabase();
      const { sqlite } = await import('./src/db/index.ts');
      const { createProject } = await import('./src/domain/project.ts');
      const agents = await import('./src/domain/agent.ts');
      const dm = await import('./src/domain/conversation.ts');
      const runs = await import('./src/domain/agent-run.ts');
      const repo = await import('./src/domain/repository.ts');
      const { updateProjectProfile } = await import('./src/domain/project-config.ts');
      const { toDomainAppError } = await import('./src/server/functions/domain-errors.ts');
      const ctx = { userId: 'repo-owner', requestId: 'req_repository_test' };
      sqlite.prepare('INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)').run(ctx.userId, ctx.userId, ctx.userId + '@example.test');
      const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '', SSH_ASKPASS: '' };
      const git = args => execFileSync('git', args, { encoding: 'utf8', env: gitEnv, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
      const workdir = process.env.SPROUT_TEST_WORKDIR;
      function seedRemote(name, files) {
        const root = join(workdir, name);
        const seed = join(root, 'seed');
        mkdirSync(seed, { recursive: true });
        git(['init', '-q', '-b', 'main', seed]);
        git(['-C', seed, 'config', 'user.email', 'seed@example.test']);
        git(['-C', seed, 'config', 'user.name', 'seed']);
        for (const [file, content] of Object.entries(files)) {
          mkdirSync(join(seed, file, '..'), { recursive: true });
          writeFileSync(join(seed, file), content);
        }
        git(['-C', seed, 'add', '.']);
        git(['-C', seed, 'commit', '-qm', 'seed']);
        git(['clone', '-q', '--bare', seed, join(root, 'remote.git')]);
        return { seed, remote: join(root, 'remote.git') };
      }
      function advance(source, file, content) {
        mkdirSync(join(source.seed, file, '..'), { recursive: true });
        writeFileSync(join(source.seed, file), content);
        git(['-C', source.seed, 'add', '.']);
        git(['-C', source.seed, 'commit', '-qm', 'advance']);
        git(['-C', source.seed, 'push', '-q', source.remote, 'main']);
        return git(['-C', source.seed, 'rev-parse', 'HEAD']).trim();
      }
      function setup(name) {
        const project = createProject({ name }, ctx);
        const profile = agents.createAgentProfile({ name: name + ' agent', persona: 'persona', harness: 'pi', model: 'test/model', effort: 'off' }, ctx);
        agents.addProjectMember(project.id, profile.id, ctx);
        const direct = dm.createDirectConversation(project.id, profile.id, ctx);
        dm.sendMessage(direct.conversation.id, { senderKind: 'human', senderId: ctx.userId, body: 'analyze the repository' }, ctx);
        const run = runs.listAgentRuns(direct.conversation.id, ctx)[0];
        return { project, run, profileId: profile.id };
      }
      const checkoutRow = projectId => sqlite.prepare('SELECT * FROM repo_checkout WHERE project_id=?').get(projectId);
      const provenanceRow = runId => sqlite.prepare('SELECT * FROM repo_provenance WHERE run_id=?').get(runId);
      const delay = ms => new Promise(done => setTimeout(done, ms));
      async function until(probe, label, ms = 15000) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const value = await probe();
          if (value) return value;
          await delay(50);
        }
        throw new Error(label + ' timed out');
      }
      async function rejectsCode(promise, code) {
        try { await promise; } catch (error) {
          assert.equal(error.code, code, 'expected ' + code + ' but got ' + error.code + ': ' + error.message);
          assert(error.message && error.message.trim(), 'error message must be non-empty');
          return error;
        }
        assert.fail('expected rejection with ' + code);
      }
      ${body}
      sqlite.close();
      console.log('PASS repository behavior');
    `,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "repository.sqlite"),
          NODE_ENV: "test",
          SPROUT_REPO_DIR: join(directory, "repos"),
          SPROUT_TEST_WORKDIR: directory,
          ...overrides,
        },
        encoding: "utf8",
        timeout: 120000,
      },
    );
    expect(output).toContain("PASS repository behavior");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("宿主仓库入口", () => {
  it("复用已存在的本地副本，provenance 与 git 实值一致且不假装取到新提交", () => {
    scenario(`
      const source = seedRemote('bound', { 'NOTES.md': 'MARKER_BOUND_v1' });
      mkdirSync(process.env.SPROUT_REPO_DIR, { recursive: true });
      git(['clone', '-q', source.remote, join(process.env.SPROUT_REPO_DIR, 'bound')]);
      const { project, run } = setup('Bound project');
      updateProjectProfile(project.id, { gitRemote: 'file://' + source.remote, defaultBranch: 'main', workDirectory: 'bound' }, ctx);
      const prepared = await repo.prepareRunRepo(run.id, ctx);
      assert.equal(prepared.sourceKind, 'bound_copy');
      assert.equal(prepared.fresh, false);
      const copyHead = git(['-C', join(process.env.SPROUT_REPO_DIR, 'bound'), 'rev-parse', 'HEAD']).trim();
      assert.equal(prepared.commit, copyHead);
      assert.equal(prepared.path, join(process.env.SPROUT_REPO_DIR, 'bound'));
      assert(prepared.fetchedAt, 'bound copy with remote records the fetch time');
      const advanced = advance(source, 'NOTES.md', 'MARKER_BOUND_v2');
      const again = await repo.prepareRunRepo(run.id, ctx);
      assert.equal(again.commit, copyHead, 'bound copy working tree is never rewritten by the host');
      assert.notEqual(again.commit, advanced);
      const basis = repo.recordRunRepoBasis(run.id, again, ctx);
      const row = provenanceRow(run.id);
      assert.equal(row.commit, copyHead);
      assert.equal(row.fresh, 0);
      assert.equal(row.path, again.path);
      assert.equal(row.source, 'file://' + source.remote);
      assert.equal(row.ref, 'main');
      assert(row.recorded_at, 'provenance records the acquisition time');
      const query = repo.getRunRepoBasis(run.id, ctx);
      assert.equal(query.commit, copyHead);
      let denied;
      try { repo.getRunRepoBasis(run.id, { userId: 'stranger', requestId: 'req_stranger' }); } catch (error) { denied = error; }
      assert.equal(denied?.code, 'not_found');
      const state = repo.getProjectRepoState(project.id, ctx);
      assert.equal(state.checkout.status, 'ready');
      assert.equal(state.checkout.commit, copyHead);
      assert.equal(state.checkout.sourceKind, 'bound_copy');
      assert.equal(basis.provenanceId, row.id);
    `);
  });

  it("没有 workDirectory 时按需克隆到宿主目录并随远端更新", () => {
    scenario(`
      const source = seedRemote('managed', { 'src/app.ts': 'export const MARKER_MANAGED = 1;' });
      const { project, run, profileId } = setup('Managed project');
      updateProjectProfile(project.id, { gitRemote: 'file://' + source.remote, defaultBranch: 'main' }, ctx);
      const prepared = await repo.prepareRunRepo(run.id, ctx);
      assert.equal(prepared.sourceKind, 'managed_clone');
      assert.equal(prepared.fresh, true);
      assert.equal(prepared.path, join(process.env.SPROUT_REPO_DIR, project.id));
      const remoteHead = git(['-C', source.seed, 'rev-parse', 'HEAD']).trim();
      assert.equal(prepared.commit, remoteHead);
      assert(existsSync(join(prepared.path, 'src', 'app.ts')), 'cloned working copy carries repository files');
      repo.recordRunRepoBasis(run.id, prepared, ctx);
      const advanced = advance(source, 'src/app.ts', 'export const MARKER_MANAGED = 2;');
      const second = dm.createDirectConversation(project.id, profileId, ctx);
      dm.sendMessage(second.conversation.id, { senderKind: 'human', senderId: ctx.userId, body: 'again' }, ctx);
      const run2 = runs.listAgentRuns(second.conversation.id, ctx)[0];
      const updated = await repo.prepareRunRepo(run2.id, ctx);
      assert.equal(updated.commit, advanced, 'second preparation picks up the advanced remote HEAD');
      assert.equal(updated.fresh, true);
      const row = checkoutRow(project.id);
      assert.equal(row.status, 'ready');
      assert.equal(row.commit, advanced);
      assert.equal(row.source, 'file://' + source.remote);
      const state = repo.getProjectRepoState(project.id, ctx);
      assert.equal(state.checkout.commit, advanced);
      assert.equal(state.managedRoot, process.env.SPROUT_REPO_DIR);
    `);
  });

  it("workDirectory 不存在时显式失败且不写副本状态", () => {
    scenario(`
      const { project, run } = setup('Missing copy project');
      updateProjectProfile(project.id, { defaultBranch: 'main', workDirectory: 'ghost' }, ctx);
      await rejectsCode(repo.prepareRunRepo(run.id, ctx), 'repo_workdir_missing');
      assert.equal(checkoutRow(project.id), undefined, 'no checkout state may be invented for a missing copy');
      assert.equal(provenanceRow(run.id), undefined);
    `);
  });

  it("远端不存在、ref 不存在、认证失败各自归类为可读错误", () => {
    scenario(`
      const source = seedRemote('classified', { 'FILE.md': 'content' });
      const missing = setup('Missing remote project');
      updateProjectProfile(missing.project.id, { gitRemote: 'file://' + join(workdir, 'classified', 'no-such.git'), defaultBranch: 'main' }, ctx);
      await rejectsCode(repo.prepareRunRepo(missing.run.id, ctx), 'repo_remote_not_found');
      const badRef = setup('Bad ref project');
      updateProjectProfile(badRef.project.id, { gitRemote: 'file://' + source.remote, defaultBranch: 'no-such-branch' }, ctx);
      await rejectsCode(repo.prepareRunRepo(badRef.run.id, ctx), 'repo_ref_not_found');
      const auth = setup('Auth project');
      const server = http.createServer((request, response) => {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
        response.end('auth required');
      });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      const port = server.address().port;
      try {
        updateProjectProfile(auth.project.id, { gitRemote: 'http://127.0.0.1:' + port + '/repo.git', defaultBranch: 'main' }, ctx);
        await rejectsCode(repo.prepareRunRepo(auth.run.id, ctx), 'repo_auth_failed');
      } finally { server.close(); }
      assert.equal(checkoutRow(missing.project.id), undefined);
      assert.equal(checkoutRow(badRef.project.id), undefined);
      assert.equal(checkoutRow(auth.project.id), undefined);
    `);
  });

  it("磁盘超限拒绝并清理托管半成品", () => {
    scenario(
      `
      const source = seedRemote('bulky', { 'BIG.bin': Buffer.alloc(16384, 7) });
      const { project, run } = setup('Bulky project');
      updateProjectProfile(project.id, { gitRemote: 'file://' + source.remote, defaultBranch: 'main' }, ctx);
      const error = await rejectsCode(repo.prepareRunRepo(run.id, ctx), 'repo_disk_limit');
      assert(error.message.includes('已清理'), 'disk limit failure reports the cleanup');
      assert(!existsSync(join(process.env.SPROUT_REPO_DIR, project.id)), 'half-done managed clone is removed');
      assert.equal(checkoutRow(project.id), undefined);
      assert.equal(provenanceRow(run.id), undefined);
    `,
      { SPROUT_REPO_MAX_BYTES: "4096" },
    );
  });

  it("同一 Project 的并发准备串行执行，工作副本不被交错修改", () => {
    scenario(`
      const source = seedRemote('serial', { 'FILE.md': 'v1' });
      const { project, run } = setup('Serial project');
      updateProjectProfile(project.id, { gitRemote: 'file://' + source.remote, defaultBranch: 'main' }, ctx);
      const log = [];
      const hooksA = {
        beforeGitOp: async op => { log.push('A:start:' + op); await delay(120); },
        afterGitOp: op => log.push('A:end:' + op),
      };
      const hooksB = {
        beforeGitOp: op => log.push('B:start:' + op),
        afterGitOp: op => log.push('B:end:' + op),
      };
      const first = repo.prepareProjectRepo(project.id, ctx, hooksA);
      const second = repo.prepareRunRepo(run.id, ctx, hooksB);
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.path, b.path);
      for (let index = 0; index < log.length; index += 2) {
        assert(log[index].includes(':start:') && log[index + 1].includes(':end:'), 'every git op must complete before the next begins: ' + log.join(','));
        assert.equal(log[index].split(':')[2], log[index + 1].split(':')[2]);
      }
      const firstB = log.findIndex(entry => entry.startsWith('B:'));
      assert(firstB > 0, 'the second preparation must wait for the first: ' + log.join(','));
      assert(log.slice(0, firstB).every(entry => entry.startsWith('A:')));
      assert(log.slice(firstB).every(entry => entry.startsWith('B:')));
      assert.equal(checkoutRow(project.id).status, 'ready');
      assert(log.filter(entry => entry.startsWith('A:') && entry.includes(':start:')).length >= 2, 'both preparations ran real git ops');
    `);
  });

  it("不同 Project 的准备互不阻塞", () => {
    scenario(`
      const sourceA = seedRemote('independent-a', { 'A.md': 'a' });
      const sourceB = seedRemote('independent-b', { 'B.md': 'b' });
      const a = setup('Independent A');
      const b = setup('Independent B');
      updateProjectProfile(a.project.id, { gitRemote: 'file://' + sourceA.remote, defaultBranch: 'main' }, ctx);
      updateProjectProfile(b.project.id, { gitRemote: 'file://' + sourceB.remote, defaultBranch: 'main' }, ctx);
      let release;
      const gate = new Promise(done => { release = done; });
      let held;
      const holding = repo.prepareProjectRepo(a.project.id, ctx, { beforeGitOp: async () => { held = true; await gate; } });
      await until(() => held, 'project A holds its git op open');
      const independent = await Promise.race([
        repo.prepareProjectRepo(b.project.id, ctx),
        delay(8000).then(() => { throw new Error('project B was blocked by project A'); }),
      ]);
      assert.equal(independent.sourceKind, 'managed_clone');
      release();
      const resolved = await holding;
      assert.equal(resolved.path, join(process.env.SPROUT_REPO_DIR, a.project.id));
    `);
  });

  it("provenance 与 checkout 的 CHECK 约束经直接 SQL 反证", () => {
    scenario(`
      const source = seedRemote('checks', { 'FILE.md': 'v1' });
      const { project, run } = setup('Checks project');
      updateProjectProfile(project.id, { gitRemote: 'file://' + source.remote, defaultBranch: 'main' }, ctx);
      const prepared = await repo.prepareRunRepo(run.id, ctx);
      repo.recordRunRepoBasis(run.id, prepared, ctx);
      const row = provenanceRow(run.id);
      const insert = (id, fresh, commit) => sqlite.prepare("INSERT INTO repo_provenance (id,run_id,project_id,checkout_id,path,source,source_kind,ref,\\"commit\\",fresh,size_bytes,recorded_at) VALUES (?,?,'" + row.project_id + "','" + row.checkout_id + "','" + row.path + "','" + row.source + "','managed_clone','main','" + commit + "',?,0,unixepoch())").run(id, 'run_other_' + id, fresh);
      const expectThrows = (label, fn, pattern) => { try { fn(); } catch (error) { assert(pattern.test(error.message), label + ' wrong error: ' + error.message); return; } assert.fail('missing exception: ' + label) };
      expectThrows('bad-fresh', () => insert('repop_bad_fresh', 2, row.commit), /CHECK constraint/);
      expectThrows('bad-commit', () => insert('repop_bad_commit', 1, ''), /CHECK constraint/);
      expectThrows('bogus-status', () => sqlite.prepare("INSERT INTO repo_checkout (id,project_id,path,source_kind,source,ref,\\"commit\\",resolved_at,size_bytes,status) VALUES ('repoc_bad','prj_bad','/tmp/x','managed_clone','http://x','main','abc',unixepoch(),0,'bogus')").run(), /CHECK constraint/);
      expectThrows('ready-empty', () => sqlite.prepare("INSERT INTO repo_checkout (id,project_id,path,source_kind,source,ref,\\"commit\\",resolved_at,size_bytes,status) VALUES ('repoc_bad2','prj_bad2','','managed_clone','','','','abc',0,'ready')").run(), /CHECK constraint|NOT NULL constraint/);
      expectThrows('dup-run', () => sqlite.prepare("INSERT INTO repo_provenance (id,run_id,project_id,checkout_id,path,source,source_kind,ref,\\"commit\\",fresh,size_bytes,recorded_at) VALUES ('repop_dup',?,'" + row.project_id + "','" + row.checkout_id + "','" + row.path + "','" + row.source + "','managed_clone','main','" + row.commit + "',1,0,unixepoch())").run(row.run_id), /UNIQUE constraint/);
    `);
  });

  it("RepositoryError 经共享错误表降为 conflict 并保留分类消息", () => {
    scenario(`
      const mapped = await toDomainAppError(new repo.RepositoryError('repo_auth_failed', 'Git 认证失败：401'), 'req_mapping');
      assert.deepEqual(mapped, { code: 'conflict', message: 'Git 认证失败：401', requestId: 'req_mapping' });
      const { ProjectAccessError } = await import('./src/domain/access.ts');
      const access = await toDomainAppError(new ProjectAccessError(), 'req_mapping');
      assert.equal(access.code, 'not_found');
    `);
  });
});
