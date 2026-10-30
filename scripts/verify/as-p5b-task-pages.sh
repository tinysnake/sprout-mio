#!/usr/bin/env bash
# Risk → assertion:
# - UI lifecycle can diverge from SQLite → every visible transition checks task row and revision.
# - Assignment can imply execution → unchecked startNow writes no start record/run; checked writes start.
# - Stale revisions can overwrite work → a concurrent domain write forces a visible conflict/reload path.
# - Completion can hide ongoing work → finished detail retains independent Chat run and Machine lease facts.
# - Agent ownership can leak authority → real member-scoped capabilities disable complete/cancel with exact codes.
# - Reopen can reuse stale results → sticky notice labels the prior record historical and chip says 重开.
# - Narrow screens / long titles can overflow → 768/390 document and content widths are asserted.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, openSync, closeSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import net from 'node:net'
import { chromium } from 'playwright'

const directory = resolve('.verify/as-p5b-task-pages')
const evidence = join(directory, 'evidence')
mkdirSync(evidence, { recursive: true })
assert(existsSync('src/server/functions/task.ts'), 'BLOCKED: integrate the actual Task server functions before this gate')
assert(existsSync('src/domain/task.ts'), 'BLOCKED: integrate Task domain before this gate')
const database = join(directory, 'verification.sqlite')
for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true })
const port = await new Promise((done, reject) => {
  const probe = net.createServer()
  probe.on('error', reject)
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => done(port)) })
})
const base = `http://localhost:${port}`
Object.assign(process.env, {
  DATABASE_URL: database, APP_ORIGIN: base, BASE_URL: base,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'), SPROUT_PI_ENABLED: 'false',
})
const fd = openSync(join(directory, 'server.log'), 'w')
const server = spawn('pnpm', ['exec', 'vp', 'dev', '--host', '0.0.0.0', '--port', String(port)], {
  env: process.env, detached: true, stdio: ['ignore', fd, fd],
})
closeSync(fd)
const completion = new Promise(resolve => server.once('exit', (code, signal) => resolve({ code, signal })))
function stop(signal = 'SIGTERM') { try { process.kill(-server.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } }
let browser
let page
const results = []
function pass(id, detail = '') { results.push({ id, detail }); console.log(`PASS ${id} :: ${detail}`) }
async function until(check, label, timeout = 45000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    if (server.exitCode !== null) throw new Error(`dev server exited; ${join(directory, 'server.log')}`)
    await new Promise(done => setTimeout(done, 200))
  }
  throw new Error(`timeout: ${label}`)
}
async function shot(name) { await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true }) }
const totalTimer = setTimeout(() => { stop('SIGKILL'); void browser?.close(); process.exitCode = 1 }, 300000)
try {
  await until(async () => { try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false } }, 'real dev server ready')
  assert(existsSync(database), 'real SQLite must be created by server')
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${base}/login`)
  await page.getByTestId('register-tab').click()
  const email = `p5b-ui-${Date.now()}@example.test`
  await page.locator('input[name="name"]').fill('P5b 页面验收')
  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill(`${randomBytes(24).toString('base64url')}aA1!`)
  await page.locator('button[type="submit"]').click()
  const { createProject, waitForChats } = await import('./scripts/browser/ui-navigation.mjs')
  await waitForChats(page)
  const project = await createProject(page, { name: `Task UI ${Date.now()}`, description: '真实 Task 页面门禁' })
  const projectId = project.path.split('/')[2]
  const { sqlite } = await import('./src/db/index.ts')
  const { ID_PREFIXES, newId } = await import('./src/contracts/ids.ts')
  const { createAgentProfile, addProjectMember } = await import('./src/domain/agent.ts')
  const { createDirectChat, createGroupChat, ensureInstance } = await import('./src/domain/chat.ts')
  const domain = await import('./src/domain/task.ts')
  const user = sqlite.prepare('select id from user where email = ?').get(email)
  assert(user, 'authenticated user must be persisted')
  const ctx = { userId: user.id, requestId: `req_${randomUUID()}` }
  const agent = createAgentProfile({ name: 'Task UI Agent', persona: '施工记录验收' }, ctx)
  addProjectMember(projectId, agent.id, ctx)
  const dm = createDirectChat(projectId, agent.id, ctx)
  const row = id => sqlite.prepare('select * from task where id = ?').get(id)
  const records = id => sqlite.prepare('select * from message where task_id = ? order by task_record_seq').all(id)
  const runCount = () => sqlite.prepare('select count(*) n from agent_run').get().n
  const overview = `${base}/projects/${projectId}/tasks`
  await page.goto(overview)
  await page.getByTestId('task-board').waitFor()
  assert.equal(await page.locator('[data-testid^="task-column-"]').count(), 4)
  assert.equal(await page.locator('[data-testid^="task-card-"]').count(), 0)
  await shot('empty-board-1280')
  pass('empty_columns_preserve_four_states')
  await page.getByRole('button', { name: '创建 Task', exact: true }).click()
  const form = page.getByTestId('task-create-form')
  await form.getByLabel('目标', { exact: true }).fill('核对 Task 页面生命周期')
  await form.getByLabel('说明', { exact: true }).fill('真实页面与 SQLite 一致')
  await form.getByLabel('约束', { exact: true }).fill('不推导 run 和租约')
  await form.getByLabel('完成要求', { exact: true }).fill('保留施工记录与历史结果')
  await form.getByLabel('清单', { exact: true }).fill('此项保持未勾选')
  await form.getByRole('button', { name: '创建 Task', exact: true }).click()
  await page.getByTestId('task-detail').waitFor()
  const taskId = new URL(page.url()).pathname.split('/').at(-1)
  assert.equal(row(taskId).status, 'proposed')
  pass('created_proposed_matches_sqlite')
  const beforeRuns = runCount()
  await page.getByLabel('承接 Chat', { exact: true }).selectOption(dm.chat.id)
  assert.equal(await page.getByLabel('立即开始', { exact: true }).isChecked(), false)
  await page.getByRole('button', { name: '仅保存分配', exact: true }).click()
  await until(async () => row(taskId).status === 'assigned', 'assigned row')
  assert.equal(records(taskId).length, 0)
  assert.equal(runCount(), beforeRuns)
  await page.getByText('尚无施工记录', { exact: true }).waitFor()
  assert.equal(await page.getByTestId('task-chat-run-facts-active-item').count(), 0)
  pass('assignment_without_start_has_no_record_or_run')
  await page.getByLabel('立即开始', { exact: true }).check()
  const snapshot = page.getByTestId('task-start-snapshot')
  for (const text of ['核对 Task 页面生命周期', '不推导 run 和租约', '保留施工记录与历史结果', '此项保持未勾选']) assert((await snapshot.innerText()).includes(text))
  pass('full_start_snapshot_visible')
  await page.getByRole('button', { name: '分配并请求立即开始', exact: true }).click()
  await page.getByTestId('task-record-1').waitFor()
  assert.equal(row(taskId).status, 'assigned')
  assert.equal(records(taskId)[0].task_record_kind, 'start')
  const run = sqlite.prepare('select id from agent_run where chat_id = ? and status in (\'queued\',\'running\')').get(dm.chat.id)
  assert(run, 'start request must create actual active run')
  pass('checked_start_has_visible_start_record_and_active_run')
  const agentCtx = { ...ctx, agent: { runId: run.id, instanceId: dm.instance.id, agentProfileId: agent.id } }
  const detail = domain.getTaskDetail(taskId, agentCtx)
  domain.appendTaskRecord({ taskId, expectedRevision: detail.task.revision, body: '成员 Agent 已追加 progress；未勾选清单保持原样。' }, agentCtx)
  await page.reload()
  await page.getByTestId('task-record-2').waitFor()
  assert.equal(records(taskId)[1].sender_kind, 'agent')
  pass('agent_progress_visible_matches_sqlite')
  const boot = sqlite.prepare("select id from runtime_boot where phase = 'ready' order by started_at desc limit 1").get()
  assert(boot, 'real runtime boot exists')
  const { createMachine, saveProjectMachineBinding, hashCredential } = await import('./src/domain/machine.ts')
  const { acquireLease } = await import('./src/server/lease.ts')
  const machineCtx = { ...ctx, bootId: boot.id, now: new Date() }
  const machine = createMachine({ name: 'Task lease facts' }, machineCtx)
  saveProjectMachineBinding({ machineId: machine.detail.machine.id, projectId, description: '独立事实', expectedRevision: null }, machineCtx)
  const grantId = newId(ID_PREFIXES.remoteToolGrant)
  sqlite.prepare('insert into remote_tool_grant(id,secret_hash,user_id,project_id,chat_id,instance_id,run_id,issued_at,expires_at) values (?,?,?,?,?,?,?,?,?)').run(grantId, hashCredential(randomBytes(32).toString('base64url')), ctx.userId, projectId, dm.chat.id, dm.instance.id, run.id, Date.now(), Date.now()+3600000)
  acquireLease({ projectId, machineId: machine.detail.machine.id, action: 'acquire', requestId: ctx.requestId, expectedGeneration: 0 }, { ...ctx, projectId, chatId: dm.chat.id, instanceId: dm.instance.id, runId: run.id, grantId, bootId: boot.id, now: new Date() })
  await page.getByRole('button', { name: '完成 Task', exact: true }).click()
  await until(async () => row(taskId).status === 'finished', 'finished row')
  await page.getByTestId('task-result-notice').getByText('当前完成结果 · 记录 #2 · 查看结果', { exact: true }).waitFor()
  await page.getByTestId('task-chat-runs').waitFor()
  await page.getByTestId('task-project-leases').waitFor()
  assert.equal(await page.getByTestId('task-chat-runs').locator(`[data-run-id="${run.id}"]`).count(), 1)
  assert((await page.getByTestId('task-project-leases').innerText()).includes('持有'))
  for (const id of ['task-chat-runs', 'task-project-leases']) assert(!/Task.*已完成|已完成.*Task/.test(await page.getByTestId(id).innerText()))
  await shot('finished-with-run-and-lease')
  pass('finished_retains_independent_run_and_lease')
  await page.getByRole('link', { name: /进入 Chat/ }).click()
  await page.waitForURL(url => url.pathname.endsWith(`/chats/${dm.chat.id}`))
  await page.goto(`${base}/projects/${projectId}/chats/${dm.chat.id}?info=1`)
  await page.getByTestId('inspector-tasks').getByRole('link', { name: '核对 Task 页面生命周期', exact: true }).waitFor()
  assert.equal(await page.getByTestId('task-associations').count(), 2)
  await page.getByTestId('inspector-tasks').getByRole('link', { name: '核对 Task 页面生命周期', exact: true }).click()
  await page.getByTestId('task-detail').waitFor()
  pass('chat_header_and_inspector_link_back_to_task')
  await page.getByRole('button', { name: 'Human 纠正', exact: true }).click()
  await page.getByLabel('追加纠正记录', { exact: true }).fill('Human 纠正后的完成结果。')
  await page.getByRole('button', { name: '保存纠正', exact: true }).click()
  await page.getByTestId('task-result-notice').getByText('当前完成结果 · 记录 #3 · 查看结果', { exact: true }).waitFor()
  assert.equal(records(taskId)[2].task_record_kind, 'correction')
  pass('human_correction_appends_new_result')
  await page.getByRole('button', { name: '重开 Task', exact: true }).click()
  await until(async () => row(taskId).status === 'assigned', 'reopened row')
  await page.getByTestId('task-result-notice').getByText('当前没有完成结果。历史结果 #3 保留', { exact: true }).waitFor()
  assert((await page.getByTestId('task-badge').first().innerText()).includes('重开'))
  await shot('reopened-history')
  pass('reopen_preserves_history_and_changes_chip')
  const staleRevision = row(taskId).revision
  domain.updateTask({ taskId, expectedRevision: staleRevision, description: '另一个写入者已修改' }, ctx)
  await page.getByRole('button', { name: '取消 Task', exact: true }).click()
  await page.getByTestId('task-write-error').getByText('conflict', { exact: true }).waitFor()
  assert.equal(row(taskId).status, 'assigned')
  await page.getByTestId('task-reload').click()
  await page.getByText('另一个写入者已修改', { exact: true }).waitFor()
  pass('stale_revision_exposes_reload_without_overwrite')
  await page.getByRole('button', { name: '取消 Task', exact: true }).click()
  await until(async () => row(taskId).status === 'canceled', 'canceled row')
  pass('cancel_matches_sqlite')
  await page.goto(overview)
  const long = domain.createTask({ projectId, title: '长标题布局验收'.repeat(16), description: '', constraints: '', completionRequirements: '' }, ctx).detail
  await page.reload()
  await page.getByTestId(`task-card-${long.task.id}`).waitFor()
  await page.getByTestId(`task-card-${long.task.id}`).click()
  await page.getByTestId('task-detail').waitFor()
  pass('overview_enters_detail')
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const path of [overview, `${overview}/${long.task.id}`]) {
      await page.goto(path)
      await page.getByTestId(path === overview ? 'task-board' : 'task-detail').waitFor()
      const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, client: document.scrollingElement.clientWidth }))
      assert(widths.scroll <= widths.client, `document horizontal overflow at ${width}: ${JSON.stringify(widths)}`)
      const overflow = await page.evaluate(() => [...document.querySelectorAll('[data-testid="task-board"], [data-testid="task-detail"]')].some(element => element.scrollWidth > element.clientWidth))
      assert(!overflow, 'Task content must not overflow its own container')
      await shot(`${path === overview ? 'board' : 'detail'}-${width}`)
    }
    pass(`responsive_${width}_no_horizontal_overflow`)
  }
  // Real Agent scope feeds the same view; browser authentication remains Human-only in P5b.
  const groupChat = createGroupChat(projectId, { projectId, title: '非 owner 成员', members: [{ kind: 'human', id: ctx.userId }, { kind: 'agent', id: agent.id }], initialOwner: { kind: 'human', id: ctx.userId }, wakePolicy: 'owner_led' }, { kind: 'human', userId: ctx.userId, ctx })
  const instance = ensureInstance(groupChat.id, agent.id, ctx)
  const groupRunId = `run_${randomUUID()}`
  sqlite.prepare("insert into agent_run(id,instance_id,chat_id,project_id,request_id,status,session_id) values (?,?,?,?,?,'queued',?)").run(groupRunId, instance.id, groupChat.id, projectId, ctx.requestId, instance.id)
  let memberTask = domain.createTask({ projectId, title: '非 owner 能力', description: '', constraints: '', completionRequirements: '' }, ctx).detail
  memberTask = domain.assignTask({ taskId: memberTask.task.id, expectedRevision: memberTask.task.revision, targetChatId: groupChat.id }, ctx).detail
  const scoped = domain.getTaskDetail(memberTask.task.id, { ...ctx, agent: { runId: groupRunId, instanceId: instance.id, agentProfileId: agent.id } })
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { TaskDetailView } = await import('./src/components/tasks/task-detail.tsx')
  await page.setContent(renderToStaticMarkup(createElement(TaskDetailView, { detail: scoped, onCommand: async () => {} })))
  for (const action of ['complete', 'cancel']) {
    const control = page.getByTestId(`task-action-${action}`)
    assert(await control.getByRole('button').isDisabled())
    assert((await control.innerText()).includes(scoped.capabilities.denials[action].code))
    assert((await control.innerText()).includes(scoped.capabilities.denials[action].reason))
  }
  pass('non_owner_agent_denials_are_real_capabilities')
  await shot('member-agent-denials')
  writeFileSync(join(evidence, 'results.json'), JSON.stringify({ base, database, results }, null, 2))
  assert(results.length >= 14, 'all lifecycle and responsive checks must execute')
  console.log(`PASS as-p5b-task-pages :: ${results.length} checks; ${evidence}`)
} catch (error) {
  if (page) await shot('failure').catch(() => {})
  throw error
} finally {
  clearTimeout(totalTimer)
  await browser?.close()
  stop()
  const killTimer = setTimeout(() => stop('SIGKILL'), 10000)
  await completion
  clearTimeout(killTimer)
}
JS
