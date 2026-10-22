#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

const directory = resolve('.verify/k2-cross-family-isolation')
mkdirSync(directory, { recursive: true })
const port = Number(process.env.SPROUT_VERIFY_K2_PORT ?? 3146)
const base = `http://localhost:${port}`
const database = join(directory, 'k2.sqlite')
const environment = {
  ...process.env, DATABASE_URL: database, APP_ORIGIN: base, PORT: String(port),
  NITRO_PORT: String(port), NODE_ENV: 'production',
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
}
const results = []
const delay = ms => new Promise((resolve) => setTimeout(resolve, ms))
function record(name, passed, detail) {
  results.push({ name, passed, detail })
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(results, null, 2) + '\n')
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}
async function check(name, action) {
  try {
    const detail = await action()
    record(name, true, detail)
    return detail
  } catch (error) {
    record(name, false, { error: error.stack ?? String(error) })
    return null
  }
}
const children = new Set()
function kill(child, signal = 'SIGTERM') {
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function launch(command, args, log, env = environment) {
  const fd = openSync(join(directory, log), 'w')
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  child.completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  children.add(child)
  return child
}
async function bounded(child, ms) {
  let expired = false
  const timer = setTimeout(() => { expired = true; kill(child, 'SIGKILL') }, ms)
  try {
    const result = await child.completion
    children.delete(child)
    assert(!expired, `process ${child.pid} exceeded ${ms}ms`)
    return result
  } finally { clearTimeout(timer) }
}
async function health(child) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      const body = await response.json()
      if (response.status === 200 && body.ok) {
        writeFileSync(join(directory, 'health.json'), JSON.stringify(body, null, 2) + '\n')
        return body
      }
    } catch {}
    await delay(250)
  }
  throw new Error('production readiness failed; see server.log')
}
async function stop(child) {
  kill(child)
  const result = await bounded(child, 15000)
  assert.equal(result.code, 0, 'SIGTERM exit code')
  return result
}

const startRequire = createRequire(import.meta.resolve('@tanstack/react-start'))
const clientRequire = createRequire(startRequire.resolve('@tanstack/start-client-core/package.json'))
const { fromCrossJSON, toCrossJSON } = clientRequire('seroval')

let ids
async function signUp(label) {
  const email = `k2-${label}-${randomBytes(8).toString('hex')}@example.test`
  const password = randomBytes(24).toString('base64url')
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: `K2 ${label.toUpperCase()} 用户` }),
    signal: AbortSignal.timeout(20000),
  })
  assert.equal(response.status, 200, `sign-up ${label} status`)
  const sessionCookie = response.headers.getSetCookie().find((entry) => entry.includes('session_token='))
  assert(sessionCookie, `sign-up ${label} session cookie`)
  const cookie = sessionCookie.split(';')[0]
  const session = await fetch(`${base}/api/auth/get-session`, {
    headers: { Origin: base, Cookie: cookie },
    signal: AbortSignal.timeout(20000),
  })
  assert.equal(session.status, 200, `get-session ${label} status`)
  const body = await session.json()
  assert.equal(body.user.email, email, `get-session ${label} email`)
  return { cookie, user: { id: body.user.id, name: body.user.name, email: body.user.email } }
}
async function call(jar, name, input, label, method = 'POST') {
  assert(ids[name], `built server function ${name} missing`)
  const response = await fetch(`${base}/_serverFn/${ids[name]}`, {
    method,
    headers: {
      Origin: base,
      Cookie: jar.cookie,
      'content-type': 'application/json',
      'x-tsr-serverfn': 'true',
      accept: 'application/json',
    },
    ...(method === 'POST' ? { body: JSON.stringify({ t: toCrossJSON({ data: input }), f: 127, m: [] }) } : {}),
    signal: AbortSignal.timeout(20000),
  })
  const body = await response.text()
  writeFileSync(join(directory, `${label}.body`), body)
  writeFileSync(join(directory, `${label}.headers.json`), JSON.stringify({ status: response.status, requestId: response.headers.get('x-sprout-request-id') }, null, 2) + '\n')
  assert.equal(response.status, 200, `${name} HTTP status; see ${label}.body`)
  const { result: value } = fromCrossJSON(JSON.parse(body), { refs: new Map() })
  const requestId = response.headers.get('x-sprout-request-id')
  assert.equal(value.requestId, requestId, `${name} requestId equals response header`)
  return { value, body, requestId }
}
async function diagnosticQuery(jar, search, label) {
  const response = await fetch(`${base}/api/diagnostics?${search}`, {
    headers: { Origin: base, Cookie: jar.cookie },
    signal: AbortSignal.timeout(20000),
  })
  const body = await response.text()
  writeFileSync(join(directory, `${label}.body`), body)
  assert.equal(response.status, 200, `${label} HTTP status`)
  return { value: JSON.parse(body), body }
}

let server
try {
  await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(port, () => probe.close(resolve))
  })
  for (const name of readdirSync(directory))
    if (/^k2\.sqlite|^evidence\.json$|^k2-state\.json$|^a-snapshot\.json$|^(isolation|deny|sub|enum|diagnostics|A-seed|B-seed|A-snapshot|A-unchanged|B-own)-/.test(name))
      rmSync(join(directory, name), { force: true })
  const buildEnv = { ...environment }
  delete buildEnv.BETTER_AUTH_SECRET
  const build = await bounded(launch('pnpm', ['build'], 'build.log', buildEnv), 300000)
  assert.equal(build.code, 0, 'pnpm build failed; see build.log')
  const walk = path => readdirSync(path, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : entry.name.endsWith('.mjs') ? [join(path, entry.name)] : [])
  const source = walk('.output/server').map(path => readFileSync(path, 'utf8')).join('\n')
  ids = Object.fromEntries([...source.matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)].map(match => [match[2], match[1]]))
  writeFileSync(join(directory, 'server-functions.json'), JSON.stringify(ids, null, 2) + '\n')
  record('production_build_current', true, { code: build.code, functions: Object.keys(ids).length })

  server = launch('pnpm', ['start'], 'server.log')
  const ready = await health(server)
  assert.match(ready.bootId, /^boot_/)
  record('production_server_ready', true, { bootId: ready.bootId })

  const A = await signUp('a')
  const B = await signUp('b')
  record('two_real_accounts_two_sessions', true, { A: A.user.id, B: B.user.id })

  const aName = `K2-A Project ${randomBytes(4).toString('hex')}`
  const aDescription = `K2 越权隔离 A ${randomBytes(4).toString('hex')}`
  const aProfileName = `K2-A Agent ${randomBytes(4).toString('hex')}`
  const aPersona = 'K2-A 人设，任何 B 侧响应都不得出现这段文字。'
  const aPersonaEdited = 'K2-A 编辑后的人设，越权更新不得覆盖。'
  const aMessages = ['K2-A 第一条消息，越权发送不得插入或改写。', 'K2-A 第二条消息，顺序与正文必须保留。']
  const aConfiguration = {
    gitRemote: 'https://example.test/k2/a.git',
    defaultBranch: 'k2-acceptance-main',
    workDirectory: 'workspaces/k2-a',
  }
  const aProject = (await call(A, 'createProjectFn', { name: aName, description: aDescription }, 'A-seed-create-project')).value
  assert.equal(aProject.ok, true, 'A seed project created')
  assert.equal(aProject.data.name, aName)
  const aProfile = (await call(A, 'createAgentProfileFn', { name: aProfileName, persona: aPersona }, 'A-seed-create-profile')).value
  assert.equal(aProfile.ok, true, 'A seed profile created')
  const aMember = (await call(A, 'addProjectMemberFn', { projectId: aProject.data.id, agentProfileId: aProfile.data.id }, 'A-seed-add-member')).value
  assert.equal(aMember.ok, true, 'A seed member added')
  const aDm = (await call(A, 'createDirectChatFn', { projectId: aProject.data.id, agentProfileId: aProfile.data.id }, 'A-seed-create-DM')).value
  assert.equal(aDm.ok, true, 'A seed DM created')
  assert.equal(aDm.data.chat.kind, 'dm')
  const aSent = []
  for (let index = 0; index < aMessages.length; index++) {
    const sent = (await call(A, 'sendMessageFn', { chatId: aDm.data.chat.id, senderKind: 'human', senderId: A.user.id, body: aMessages[index] }, `A-seed-message-${index + 1}`)).value
    assert.equal(sent.ok, true, `A seed message ${index + 1} saved`)
    aSent.push(sent.data)
  }
  const aPersonaEdit = (await call(A, 'updateAgentProfileFn', { agentProfileId: aProfile.data.id, persona: aPersonaEdited }, 'A-seed-edit-persona')).value
  assert.equal(aPersonaEdit.ok, true, 'A seed persona edited')
  assert.equal(aPersonaEdit.data.persona, aPersonaEdited)
  const aConfigWrite = (await call(A, 'updateProjectProfileFn', { ...aConfiguration, projectId: aProject.data.id }, 'A-seed-configuration')).value
  assert.equal(aConfigWrite.ok, true, 'A seed configuration saved')
  record('A_seed_objects_ready', true, {
    projectId: aProject.data.id, agentProfileId: aProfile.data.id,
    chatId: aDm.data.chat.id, instanceId: aDm.data.instance.id,
    messages: aSent.map((entry) => entry.id),
  })

  const bProject = (await call(B, 'createProjectFn', { name: 'K2-B Project', description: 'K2 正对照 B' }, 'B-seed-create-project')).value
  assert.equal(bProject.ok, true, 'B seed project created')
  const bProfile = (await call(B, 'createAgentProfileFn', { name: 'K2-B Agent', persona: 'K2-B 人设' }, 'B-seed-create-profile')).value
  assert.equal(bProfile.ok, true, 'B seed profile created')
  const bMember = (await call(B, 'addProjectMemberFn', { projectId: bProject.data.id, agentProfileId: bProfile.data.id }, 'B-seed-add-member')).value
  assert.equal(bMember.ok, true, 'B seed member added')
  const bDm = (await call(B, 'createDirectChatFn', { projectId: bProject.data.id, agentProfileId: bProfile.data.id }, 'B-seed-create-DM')).value
  assert.equal(bDm.ok, true, 'B seed DM created')
  record('B_seed_objects_ready', true, { projectId: bProject.data.id, chatId: bDm.data.chat.id })

  const aTokens = [
    aProject.data.id, aName, aDescription, aProfile.data.id, aProfileName,
    aDm.data.chat.id, aDm.data.instance.id,
    ...aSent.map((entry) => entry.id), ...aMessages, aPersonaEdited,
    ...Object.values(aConfiguration), A.user.id, A.user.name, A.user.email,
  ]
  assert(aTokens.every((token) => typeof token === 'string' && token.length > 0))

  const aSnapshot = {}
  for (const [label, name, input] of [
    ['project', 'getProjectFn', { projectId: aProject.data.id }],
    ['profile', 'getAgentProfileFn', { agentProfileId: aProfile.data.id }],
    ['members', 'listProjectMembersFn', { projectId: aProject.data.id }],
    ['chats', 'listChatsFn', { projectId: aProject.data.id }],
    ['chat', 'getChatFn', { chatId: aDm.data.chat.id }],
    ['instances', 'listInstancesForChatFn', { chatId: aDm.data.chat.id }],
    ['messages', 'listMessagesFn', { chatId: aDm.data.chat.id }],
    ['config', 'getProjectProfileFn', { projectId: aProject.data.id }],
  ]) {
    const { value } = await call(A, name, input, `A-snapshot-${label}`)
    assert.equal(value.ok, true, `A snapshot ${label} readable`)
    aSnapshot[label] = value.data
  }
  writeFileSync(join(directory, 'a-snapshot.json'), JSON.stringify(aSnapshot, null, 2) + '\n')
  assert.deepEqual(aSnapshot.members.map((entry) => entry.agentProfileId), [aProfile.data.id])
  assert.deepEqual(aSnapshot.messages.map((entry) => entry.body), aMessages)
  assert.deepEqual(aSnapshot.config, { projectId: aProject.data.id, ...aConfiguration, updatedAt: aSnapshot.config.updatedAt })
  assert.equal(aSnapshot.profile.persona, aPersonaEdited)
  record('A_snapshot_matches_seed', true, {
    members: aSnapshot.members.length, messages: aSnapshot.messages.length, config: aSnapshot.config,
  })

  const expectDenied = (name, fn, input, label) => check(name, async () => {
    const { value, body, requestId } = await call(B, fn, input, label)
    assert.equal(value.ok, false, `${fn} must fail for B`)
    assert.equal(value.error.code, 'not_found', `${fn} error code`)
    assert.equal(value.error.requestId, requestId, `${fn} error requestId matches header`)
    assert.match(value.requestId, /^req_[0-9a-f-]{36}$/)
    const leaked = aTokens.filter((token) => body.includes(token))
    assert.deepEqual(leaked, [], `${fn} response leaked A data`)
    return { fn, code: value.error.code, requestId, leaked }
  })

  await expectDenied('deny_B_getProject_A', 'getProjectFn', { projectId: aProject.data.id }, 'deny-getProject')
  await expectDenied('deny_B_getProjectProfile_A', 'getProjectProfileFn', { projectId: aProject.data.id }, 'deny-getProjectProfile')
  await expectDenied('deny_B_updateProjectProfile_A', 'updateProjectProfileFn', { projectId: aProject.data.id, defaultBranch: 'k2-forbidden-branch' }, 'deny-updateProjectProfile')
  await expectDenied('deny_B_listProjectMembers_A', 'listProjectMembersFn', { projectId: aProject.data.id }, 'deny-listProjectMembers')
  await expectDenied('deny_B_addProjectMember_A', 'addProjectMemberFn', { projectId: aProject.data.id, agentProfileId: aProfile.data.id }, 'deny-addProjectMember')
  await expectDenied('deny_B_removeProjectMember_A', 'removeProjectMemberFn', { projectId: aProject.data.id, agentProfileId: aProfile.data.id }, 'deny-removeProjectMember')
  await expectDenied('deny_B_listChats_A', 'listChatsFn', { projectId: aProject.data.id }, 'deny-listChats')
  await expectDenied('deny_B_createDirectChat_A_project_A_profile', 'createDirectChatFn', { projectId: aProject.data.id, agentProfileId: aProfile.data.id }, 'deny-createDirectChat')
  await expectDenied('deny_B_getProjectInfoHub_A', 'getProjectInfoHubFn', { projectId: aProject.data.id }, 'deny-getProjectInfoHub')
  await expectDenied('deny_B_getChat_A', 'getChatFn', { chatId: aDm.data.chat.id }, 'deny-getChat')
  await expectDenied('deny_B_listChatMembers_A', 'listChatMembersFn', { chatId: aDm.data.chat.id }, 'deny-listChatMembers')
  await expectDenied('deny_B_listInstancesForChat_A', 'listInstancesForChatFn', { chatId: aDm.data.chat.id }, 'deny-listInstances')
  await expectDenied('deny_B_listMessages_A', 'listMessagesFn', { chatId: aDm.data.chat.id }, 'deny-listMessages')
  await expectDenied('deny_B_sendMessage_agent_identity_A', 'sendMessageFn', { chatId: aDm.data.chat.id, senderKind: 'agent', senderId: aProfile.data.id, body: 'K2-forbidden-agent-message' }, 'deny-sendMessage-agent')
  await expectDenied('deny_B_getChatInfo_A', 'getChatInfoFn', { chatId: aDm.data.chat.id }, 'deny-getChatInfo')
  await expectDenied('deny_B_getAgentProfile_A', 'getAgentProfileFn', { agentProfileId: aProfile.data.id }, 'deny-getAgentProfile')
  await expectDenied('deny_B_updateAgentProfile_A', 'updateAgentProfileFn', { agentProfileId: aProfile.data.id, persona: 'K2-forbidden-persona' }, 'deny-updateAgentProfile')

  const subCrossDm = await check('sub_B_ownProject_A_profile_createDM_rejected_without_leak', async () => {
    const { value, body, requestId } = await call(B, 'createDirectChatFn', { projectId: bProject.data.id, agentProfileId: aProfile.data.id }, 'sub-ownProject-A-profile-DM')
    assert.equal(value.ok, false, 'cross-profile DM must be rejected')
    assert.equal(value.error.code, 'not_found', 'own-project cross-profile DM must map to not_found')
    assert.equal(value.error.requestId, requestId)
    const leaked = aTokens.filter((token) => body.includes(token))
    assert.deepEqual(leaked, [])
    return { code: value.error.code, requestId, leaked }
  })
  await check('sub_profile_reference_indistinguishable_from_nonexistent', async () => {
    const ghost = 'agp_00000000-0000-4000-8000-000000000000'
    const { value } = await call(B, 'createDirectChatFn', { projectId: bProject.data.id, agentProfileId: ghost }, 'sub-nonexistent-profile')
    assert.equal(value.ok, false, 'nonexistent profile DM must be rejected')
    assert.equal(value.error.code, subCrossDm?.code, 'no existence oracle between unauthorized and nonexistent profile')
    return { code: value.error.code, sameAs: 'sub_B_ownProject_A_profile_createDM_rejected_without_leak' }
  })
  await expectDenied('sub_B_ownProject_A_profile_addMember', 'addProjectMemberFn', { projectId: bProject.data.id, agentProfileId: aProfile.data.id }, 'sub-ownProject-A-profile-member')
  await expectDenied('sub_B_sendMessage_A_chat_forged_identity', 'sendMessageFn', { chatId: aDm.data.chat.id, senderKind: 'human', senderId: A.user.id, body: 'K2-forbidden-impersonation' }, 'sub-impersonate-A')
  await check('sub_forged_sender_is_rewritten_to_session_human', async () => {
    const { value } = await call(B, 'sendMessageFn', { chatId: bDm.data.chat.id, senderKind: 'agent', senderId: aProfile.data.id, body: 'K2-B 伪造身份输入被边界改写。' }, 'sub-forged-sender')
    assert.equal(value.ok, true)
    assert.equal(value.data.senderKind, 'human')
    assert.equal(value.data.senderId, B.user.id)
    assert.equal(value.data.chatId, bDm.data.chat.id)
    return { senderKind: value.data.senderKind, senderId: value.data.senderId }
  })

  await check('enum_list_denials_are_errors_not_empty_arrays', async () => {
    for (const label of ['deny-listProjectMembers', 'deny-listChats']) {
      const { result: value } = fromCrossJSON(JSON.parse(readFileSync(join(directory, `${label}.body`), 'utf8')), { refs: new Map() })
      assert.equal(value.ok, false, `${label} must be an error`)
      assert.equal(value.error.code, 'not_found')
    }
    return { verified: ['listProjectMembersFn', 'listChatsFn'] }
  })
  await check('enum_listProjects_returns_only_B', async () => {
    const { value, body } = await call(B, 'listProjectsFn', {}, 'enum-listProjects', 'GET')
    assert.equal(value.ok, true)
    // B 注册时拿到一个默认 Project，所以列表含它自己建的那个和默认项，但不含 A 的。
    const ids = value.data.map((entry) => entry.id)
    assert(ids.includes(bProject.data.id), 'B must see its own project')
    assert(!ids.includes(aProject.data.id), 'B must not see A project')
    const leaked = aTokens.filter((token) => body.includes(token))
    assert.deepEqual(leaked, [])
    return { projects: value.data.length, leaked }
  })
  await check('enum_listAgentProfiles_excludes_A', async () => {
    const { value, body } = await call(B, 'listAgentProfilesFn', {}, 'enum-listAgentProfiles', 'GET')
    assert.equal(value.ok, true)
    assert(!value.data.some((entry) => entry.id === aProfile.data.id))
    const leaked = aTokens.filter((token) => body.includes(token))
    assert.deepEqual(leaked, [])
    return { profiles: value.data.length, leaked }
  })

  await check('diagnostics_B_query_A_projectId_empty', async () => {
    const { value, body } = await diagnosticQuery(B, `projectId=${encodeURIComponent(aProject.data.id)}`, 'diagnostics-A-projectId')
    assert.equal(value.ok, true)
    assert.deepEqual(value.data, [])
    const leaked = aTokens.filter((token) => body.includes(token))
    assert.deepEqual(leaked, [])
    return { data: value.data.length, leaked }
  })
  await check('diagnostics_B_query_A_requestId_has_no_project_data', async () => {
    const { value, body } = await diagnosticQuery(B, `requestId=${encodeURIComponent(aConfigWrite.requestId)}`, 'diagnostics-A-requestId')
    assert.equal(value.ok, true)
    assert(value.data.every((entry) => entry.projectId === undefined), 'no project-scoped diagnostic for A requestId')
    const leaked = aTokens.filter((token) => body.includes(token))
    assert.deepEqual(leaked, [])
    return { requestId: aConfigWrite.requestId, events: value.data.map((entry) => entry.event), leaked }
  })

  await check('B_own_project_full_read_set_ok_after_denials', async () => {
    const inputs = [
      ['getProjectFn', { projectId: bProject.data.id }],
      ['getProjectProfileFn', { projectId: bProject.data.id }],
      ['listProjectMembersFn', { projectId: bProject.data.id }],
      ['getAgentProfileFn', { agentProfileId: bProfile.data.id }],
      ['listChatsFn', { projectId: bProject.data.id }],
      ['getChatFn', { chatId: bDm.data.chat.id }],
      ['listChatMembersFn', { chatId: bDm.data.chat.id }],
      ['listInstancesForChatFn', { chatId: bDm.data.chat.id }],
      ['listMessagesFn', { chatId: bDm.data.chat.id }],
      ['getProjectInfoHubFn', { projectId: bProject.data.id }],
      ['getChatInfoFn', { chatId: bDm.data.chat.id }],
    ]
    for (const [name, input] of inputs) {
      const { value } = await call(B, name, input, `B-own-${name}`)
      assert.equal(value.ok, true, `${name} must succeed for B`)
    }
    return { reads: inputs.length }
  })
  await check('B_own_configuration_write_then_reread', async () => {
    const write = (await call(B, 'updateProjectProfileFn', { projectId: bProject.data.id, defaultBranch: 'k2-b-control' }, 'B-own-updateProjectProfile')).value
    assert.equal(write.ok, true)
    assert.equal(write.data.defaultBranch, 'k2-b-control')
    const reread = (await call(B, 'getProjectProfileFn', { projectId: bProject.data.id }, 'B-own-rereadProjectProfile')).value
    assert.equal(reread.ok, true)
    assert.equal(reread.data.defaultBranch, 'k2-b-control')
    return { defaultBranch: reread.data.defaultBranch }
  })
  await check('B_own_sendMessage_grows_own_chat', async () => {
    const before = (await call(B, 'listMessagesFn', { chatId: bDm.data.chat.id }, 'B-own-messages-before')).value
    const sent = (await call(B, 'sendMessageFn', { chatId: bDm.data.chat.id, senderKind: 'human', senderId: B.user.id, body: 'K2-B 正对照消息。' }, 'B-own-sendMessage')).value
    assert.equal(sent.ok, true)
    const after = (await call(B, 'listMessagesFn', { chatId: bDm.data.chat.id }, 'B-own-messages-after')).value
    assert.equal(after.data.length, before.data.length + 1)
    assert.equal(after.data.at(-1).body, 'K2-B 正对照消息。')
    return { before: before.data.length, after: after.data.length }
  })
  await check('B_own_DM_idempotent_same_instance', async () => {
    const first = (await call(B, 'createDirectChatFn', { projectId: bProject.data.id, agentProfileId: bProfile.data.id }, 'B-own-DM-first')).value
    const second = (await call(B, 'createDirectChatFn', { projectId: bProject.data.id, agentProfileId: bProfile.data.id }, 'B-own-DM-second')).value
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.deepEqual(
      { chatId: second.data.chat.id, instanceId: second.data.instance.id },
      { chatId: first.data.chat.id, instanceId: first.data.instance.id },
    )
    return { chatId: first.data.chat.id }
  })

  const aAfter = {}
  for (const [label, name, input] of [
    ['members', 'listProjectMembersFn', { projectId: aProject.data.id }],
    ['messages', 'listMessagesFn', { chatId: aDm.data.chat.id }],
    ['profile', 'getAgentProfileFn', { agentProfileId: aProfile.data.id }],
    ['config', 'getProjectProfileFn', { projectId: aProject.data.id }],
    ['chats', 'listChatsFn', { projectId: aProject.data.id }],
  ]) {
    const { value } = await call(A, name, input, `A-unchanged-${label}`)
    assert.equal(value.ok, true, `A ${label} still readable after attacks`)
    aAfter[label] = value.data
  }
  await check('A_members_unchanged_after_attacks', async () => {
    assert.deepEqual(aAfter.members, aSnapshot.members)
    return { members: aAfter.members.length }
  })
  await check('A_messages_unchanged_after_attacks', async () => {
    assert.deepEqual(aAfter.messages, aSnapshot.messages)
    return { messages: aAfter.messages.length, bodies: aAfter.messages.map((entry) => entry.body) }
  })
  await check('A_persona_unchanged_after_attacks', async () => {
    assert.deepEqual(aAfter.profile, aSnapshot.profile)
    return { persona: aAfter.profile.persona }
  })
  await check('A_configuration_unchanged_after_attacks', async () => {
    assert.deepEqual(aAfter.config, aSnapshot.config)
    return { config: aConfiguration }
  })
  await check('A_chats_unchanged_after_attacks', async () => {
    assert.deepEqual(aAfter.chats.map((entry) => entry.id), [aDm.data.chat.id])
    return { chats: aAfter.chats.length }
  })

  writeFileSync(join(directory, 'k2-state.json'), JSON.stringify({
    cookie: { name: B.cookie.slice(0, B.cookie.indexOf('=')), value: B.cookie.slice(B.cookie.indexOf('=') + 1) },
    tokens: aTokens,
    pages: [
      { key: 'project', path: `/projects/${aProject.data.id}` },
      { key: 'settings', path: `/projects/${aProject.data.id}/settings` },
      { key: 'members', path: `/projects/${aProject.data.id}/members` },
      { key: 'chat', path: `/projects/${aProject.data.id}/chats/${aDm.data.chat.id}` },
      { key: 'agent', path: `/agents/${aProfile.data.id}` },
    ],
  }, null, 2) + '\n')
  const browser = await bounded(launch(process.execPath, ['scripts/browser/k2-isolation-flow.mjs'], 'browser.log', { ...environment, BASE_URL: base, K2_DIRECTORY: directory }), 300000)
  record('real_Chromium_k2_isolation_flow', browser.code === 0, { ...browser, log: 'browser.log' })

  const shutdown = await stop(server)
  server = null
  record('production_SIGTERM_exit_0', true, shutdown)

  const probe = new Database(database)
  try {
    const count = (sql, ...args) => probe.prepare(sql).get(...args).count
    assert.equal(count('SELECT count(*) AS count FROM agent_instance WHERE agent_profile_id = ? AND project_id = ?', aProfile.data.id, bProject.data.id), 0)
    assert.equal(count('SELECT count(*) AS count FROM project_member WHERE project_id = ? AND agent_profile_id = ?', bProject.data.id, aProfile.data.id), 0)
    assert.equal(count('SELECT count(*) AS count FROM chat WHERE project_id = ?', bProject.data.id), 1)
    assert.equal(count('SELECT count(*) AS count FROM message WHERE chat_id = ?', aDm.data.chat.id), aMessages.length)
    assert.equal(count("SELECT count(*) AS count FROM message WHERE body LIKE '%K2-forbidden%' AND chat_id = ?", aDm.data.chat.id), 0)
    assert.equal(count("SELECT count(*) AS count FROM project_profile WHERE default_branch LIKE 'k2-forbidden%'"), 0)
    assert.equal(count("SELECT count(*) AS count FROM agent_profile WHERE persona LIKE '%K2-forbidden%' AND id = ?", aProfile.data.id), 0)
    assert.equal(probe.prepare('SELECT persona FROM agent_profile WHERE id = ?').get(aProfile.data.id).persona, aPersonaEdited)
    const aSenders = probe.prepare('SELECT sender_kind AS kind, sender_id AS id FROM message WHERE chat_id = ? ORDER BY rowid').all(aDm.data.chat.id)
    assert.deepEqual(aSenders, aMessages.map(() => ({ kind: 'human', id: A.user.id })))
    record('sqlite_probe_no_cross_rows_and_A_intact', true, {
      crossInstances: 0, crossMembers: 0, aChatMessages: aMessages.length,
      aSenders: aSenders.length, persona: aPersonaEdited,
    })
  } finally { probe.close() }
} catch (error) {
  record('k2_runner', false, { error: error.stack ?? String(error) })
} finally {
  for (const child of children) kill(child, 'SIGKILL')
}
const failed = results.filter((result) => !result.passed)
console.log(`k2 runner checks=${results.length} failed=${failed.length}`)
process.exitCode = failed.length ? 1 : 0
JS
