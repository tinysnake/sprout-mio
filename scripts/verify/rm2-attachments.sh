#!/usr/bin/env bash
# Risk → assertion:
# - 附件与消息不同步 → 每条消息里的附件都能在 message_attachment 里找到同一 span，失败时库里与磁盘上都不留痕。
# - 引用只按文件名反查 → 同名与缺失附件只认 id，芯片显示的是被引用那一个。
# - 输入侧装饰推移文字 → 镜像层与纯文本逐字符比较，最大偏移不超过 1px。
# - 上传绕开 Project 边界 → 匿名 401、第二个账号 403/404，且响应体里没有字节。
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
# 前置不满足时打 [skip: …] 并退出 77（runner 记为 SKIPPED），不要假失败也不要假通过。
if ! pnpm exec vp --version >/dev/null 2>&1; then
  echo "[skip: pnpm exec vp 不可用，起不了真实 dev server]" >&2
  exit 77
fi
if ! node -e "const { chromium } = require('playwright'); process.exit(require('node:fs').existsSync(chromium.executablePath()) ? 0 : 1)" >/dev/null 2>&1; then
  echo "[skip: playwright chromium 未下载（pnpm exec playwright install chromium）]" >&2
  exit 77
fi
node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, openSync, closeSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'

const directory = resolve('.verify/rm2-attachments')
const evidence = join(directory, 'evidence')
mkdirSync(evidence, { recursive: true })
for (const file of [
  'src/contracts/attachment.ts',
  'src/domain/attachment.ts',
  'src/domain/message-attachment.ts',
  'src/components/chat/attachment-bar.tsx',
  'src/components/chat/composer-markdown.ts',
]) assert(existsSync(file), `BLOCKED: 缺少 ${file}，先合入 RM2`)

const database = join(directory, 'verification.sqlite')
for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true })
const port = await new Promise((done, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => done(port)) })
})
const base = `http://localhost:${port}`
Object.assign(process.env, {
  DATABASE_URL: database, APP_ORIGIN: base, BASE_URL: base,
  PORT: String(port), NITRO_PORT: String(port),
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'), SPROUT_PI_ENABLED: 'false',
})
const fd = openSync(join(directory, 'server.log'), 'w')
const server = spawn('pnpm', ['exec', 'vp', 'dev', '--host', '0.0.0.0'], {
  env: process.env, detached: true, stdio: ['ignore', fd, fd],
})
closeSync(fd)
function stop(signal = 'SIGTERM') { try { process.kill(-server.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } }
const completion = new Promise(resolve => server.once('exit', (code, signal) => resolve({ code, signal })))

let browser
let page
const results = []
const pageErrors = []
const consoleErrors = []
let attachmentMisses = 0
let failures = 0
function pass(id, detail) {
  results.push({ id, passed: true, detail })
  writeFileSync(join(evidence, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  console.log(`PASS ${id} :: ${detail}`)
}
async function check(id, run) {
  try {
    const detail = await run()
    pass(id, detail ?? '')
  } catch (error) {
    failures += 1
    results.push({ id, passed: false, detail: error.message })
    writeFileSync(join(evidence, 'results.json'), JSON.stringify(results, null, 2) + '\n')
    console.log(`FAIL ${id} :: ${error.message}`)
  }
}
function tail() {
  try { return readFileSync(join(directory, 'server.log'), 'utf8').trim().split('\n').slice(-4).join(' | ') } catch { return '(server.log unreadable)' }
}
const delay = ms => new Promise(done => setTimeout(done, ms))
async function until(probe, label, timeout = 45000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await probe()) return
    if (server.exitCode !== null) throw new Error(`dev server exited; ${tail()}`)
    await delay(200)
  }
  throw new Error(`timeout: ${label}; server.log says ${tail()}`)
}
async function overlayText() {
  return page.evaluate(() => {
    const overlay = document.querySelector('vite-error-overlay')
    if (!overlay) return null
    const source = overlay.shadowRoot ?? overlay
    return (source.textContent ?? '').trim().slice(0, 2000) || '(empty overlay)'
  })
}
async function shot(name) {
  const overlay = await overlayText()
  assert.equal(overlay, null, `dev server error overlay before ${name}: ${overlay}`)
  await page.screenshot({ path: join(evidence, name), fullPage: true })
}
const composer = () => page.getByTestId('message-input')
const test = id => page.getByTestId(id)
let sqliteHandle

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
function crc32(buffer) {
  let c = -1
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
// 随机像素让 deflate 压不动，这样「200 KB」与「1.6 MB」是真实的字节量，不是压出来的假数字。
function png(width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < width * 3; x++) raw[y * stride + 1 + x] = Math.floor(Math.random() * 256)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function pdf() {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    'latin1',
  )
}

async function clearComposer() {
  while ((await test('attachment-remove').count()) > 0) await test('attachment-remove').first().click()
  await composer().fill('')
}
async function filePayloads(files) {
  return files.map(file => ({ name: file.name, type: file.type, base64: file.buffer.toString('base64') }))
}
async function inject(kind, files) {
  const payload = await filePayloads(files)
  await page.evaluate(
    ({ kind, payload }) => {
      const transfer = new DataTransfer()
      for (const item of payload) {
        const bytes = Uint8Array.from(atob(item.base64), character => character.charCodeAt(0))
        transfer.items.add(new File([bytes], item.name, { type: item.type }))
      }
      const target = document.querySelector('[data-testid="message-input"]')
      const event = new Event(kind, { bubbles: true, cancelable: true })
      Object.defineProperty(event, kind === 'paste' ? 'clipboardData' : 'dataTransfer', { value: transfer })
      target.dispatchEvent(event)
    },
    { kind, payload },
  )
}
async function upload(files) {
  await test('attachment-input').setInputFiles(
    files.map(file => ({ name: file.name, mimeType: file.type, buffer: file.buffer })),
  )
}
async function sendWithReference(text) {
  await composer().fill(text)
  await test('attachment-tag').first().click()
  const before = await test('message-item').count()
  await test('message-send').click()
  await until(async () => (await test('message-item').count()) > before, 'message sent')
  return before
}
async function drift(expected) {
  return page.evaluate(text => {
    const layer = document.querySelector('[data-testid="message-input-highlight"]')
    const decorated = layer.cloneNode(true)
    for (const chip of decorated.querySelectorAll('.composer-ref-chip')) chip.remove()
    const plain = layer.cloneNode(true)
    plain.textContent = text
    for (const node of [decorated, plain]) {
      node.style.position = 'absolute'
      node.style.left = '0px'
      node.style.top = '0px'
      node.style.visibility = 'hidden'
      node.style.width = `${layer.getBoundingClientRect().width}px`
      document.body.appendChild(node)
    }
    const boxes = root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      const origin = root.getBoundingClientRect()
      const list = []
      let node
      while ((node = walker.nextNode())) {
        for (let index = 0; index < node.data.length; index++) {
          range.setStart(node, index)
          range.setEnd(node, index + 1)
          const rect = range.getBoundingClientRect()
          list.push({ x: rect.left - origin.left, y: rect.top - origin.top, text: node.data[index] })
        }
      }
      return list
    }
    const left = boxes(decorated)
    const right = boxes(plain)
    const count = Math.min(left.length, right.length)
    let max = 0
    let at = -1
    for (let index = 0; index < count; index++) {
      const delta = Math.max(Math.abs(left[index].x - right[index].x), Math.abs(left[index].y - right[index].y))
      if (delta > max) { max = delta; at = index }
    }
    for (const node of [decorated, plain]) node.remove()
    return {
      decorated: left.length,
      plain: right.length,
      expected: text.length,
      max,
      at,
      flow: left.map(item => item.text).join(''),
    }
  }, expected)
}
async function overflow() {
  return page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    images: [...document.querySelectorAll('[data-testid="message-attachment-figure"] img')].map(image => {
      const rect = image.getBoundingClientRect()
      return {
        name: image.getAttribute('alt') ?? '',
        width: rect.width,
        height: rect.height,
        natural: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        container: image.closest('[data-testid="message-attachment-figure"]').getBoundingClientRect().width,
        viewport: window.innerHeight,
      }
    }),
  }))
}
function count(table) {
  return sqliteHandle.prepare(`SELECT count(*) AS n FROM ${table}`).get().n
}
function countDiskFiles() {
  try {
    return readdirSync(directory + '/attachments').length
  } catch {
    return 0
  }
}
function seedAgentMessage({ chatId, projectId, body, attachment, spans }) {
  const now = Math.floor(Date.now() / 1000)
  const instance = sqliteHandle
    .prepare('SELECT id FROM agent_instance WHERE chat_id = ? AND project_id = ?')
    .get(chatId, projectId)
  const sender = instance?.id ?? agentId
  const messageId = `msg_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  sqliteHandle
    .prepare("INSERT INTO message (id, chat_id, sender_kind, sender_id, body, created_at) VALUES (?, ?, 'agent', ?, ?, ?)")
    .run(messageId, chatId, sender, body, now)
  sqliteHandle
    .prepare('INSERT INTO attachment (id, chat_id, message_id, filename, mime_type, byte_size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(attachment.id, chatId, messageId, attachment.filename, attachment.mimeType, attachment.bytes.length, sender, now)
  mkdirSync(join(directory, 'attachments'), { recursive: true })
  writeFileSync(join(directory, 'attachments', attachment.id), attachment.bytes)
  for (const span of spans) {
    sqliteHandle
      .prepare('INSERT INTO message_attachment (chat_id, message_id, attachment_id, start, end) VALUES (?, ?, ?, ?, ?)')
      .run(chatId, messageId, attachment.id, span.start, span.end)
  }
  return messageId
}

let chatId
let projectId
let agentId
let attachmentDirectory
let payloadPeak = 0

try {
  await until(async () => {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      const body = await response.json()
      return response.status === 200 && body.ok
    } catch { return false }
  }, 'dev server ready')
  assert(existsSync(database), 'real SQLite must be created by server')
  attachmentDirectory = join(directory, 'attachments')

  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (text.includes('Failed to load resource')) return
    consoleErrors.push(text)
  })
  const attachmentFailures = []
  const attachmentReads = []
  page.on('response', async response => {
    const url = response.url()
    if (!url.includes('/api/attachments') && !url.includes('/_server')) return
    if (url.includes('/api/attachments') && response.status() >= 400) {
      if (response.status() === 404) attachmentMisses += 1
      let body = ''
      let headers = {}
      try {
        body = (await response.text()).slice(0, 160).replace(/\s+/g, ' ')
        headers = await response.request().allHeaders()
      } catch {
        body = '<unreadable>'
      }
      attachmentFailures.push(
        `${response.status()} ${url.replace(base, '')} accept=${headers['accept'] ?? ''} dest=${headers['sec-fetch-dest'] ?? ''} body=${body}`,
      )
      return
    }
    if (url.includes('/api/attachments') && response.status() === 200) {
      attachmentReads.push({ url: url.replace(base, ''), length: Number(response.headers()['content-length'] ?? 0) })
      return
    }
    if (!url.includes('/_server')) return
    let length = Number(response.headers()['content-length'] ?? 0)
    if (length === 0) {
      try { length = (await response.body()).length } catch { length = 0 }
    }
    if (length > payloadPeak) payloadPeak = length
  })
  const origin = `${base}/login`
  await page.goto(origin)
  await test('register-tab').waitFor()
  await test('register-tab').click()
  const email = `rm2-attach-${Date.now()}@example.test`
  await page.locator('input[name="name"]').fill('RM2 附件验收')
  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill(`${randomBytes(24).toString('base64url')}aA1!`)
  await page.locator('button[type="submit"]').click()
  const { createProject, waitForChats } = await import('./scripts/browser/ui-navigation.mjs')
  await waitForChats(page)
  const project = await createProject(page, { name: `RM2 附件 ${Date.now()}`, description: '真实附件与引用门禁' })
  projectId = project.path.split('/')[2]
  const { sqlite } = await import('./src/db/index.ts')
  sqliteHandle = sqlite
  const { createAgentProfile, addProjectMember } = await import('./src/domain/agent.ts')
  const { createDirectChat } = await import('./src/domain/chat.ts')
  const user = sqliteHandle.prepare('SELECT id FROM user WHERE email = ?').get(email)
  assert(user, 'authenticated user must be persisted')
  const ctx = { userId: user.id, requestId: `req_${randomUUID().replaceAll('-', '').slice(0, 8)}` }
  const agent = createAgentProfile({ name: 'RM2 附件 Agent', persona: '附件验收' }, ctx)
  agentId = agent.id
  addProjectMember(projectId, agent.id, ctx)
  const dm = createDirectChat(projectId, agent.id, ctx)
  chatId = dm.chat.id
  await page.goto(`${base}/projects/${projectId}/chats/${chatId}`)
  await test('message-input').waitFor()
  pass('setup_real_project_agent_and_dm_chat', `project ${projectId} chat ${chatId}`)

  await check('lane_1_no_attachment_message_still_renders', async () => {
    await composer().fill('**粗体** 与列表 1. 项')
    await test('message-send').click()
    await until(async () => (await composer().inputValue()) === '', 'composer clears after send')
    await until(async () => {
      const bodies = await test('message-body').allTextContents()
      return bodies.some(body => body.includes('粗体') && body.includes('1. 项'))
    }, 'message rendered')
    const body = (await test('message-body').allTextContents()).at(-1)
    assert.ok(body.includes('粗体'), `应渲染成粗体文字：${body}`)
    assert.ok(!body.includes('**'), `纯文本消息不应出现字面标记：${body}`)
    await shot('rm2-lane1-trunk-vs-head.png')
    return `渲染为 ${JSON.stringify(body)}`
  })

  await check('lane_2_three_attachment_entry_paths', async () => {
    await clearComposer()
    await inject('paste', [{ name: '粘贴的 240 图.png', type: 'image/png', buffer: png(240, 240) }])
    await until(async () => (await test('attachment-item').count()) === 1, 'paste adds one attachment')
    await upload([{ name: '选择的需求.pdf', type: 'application/pdf', buffer: pdf() }])
    await until(async () => (await test('attachment-item').count()) === 2, 'file input adds one attachment')
    await inject('drop', [{ name: '拖入的说明.txt', type: 'text/plain', buffer: Buffer.from('拖放进来的说明\n') }])
    await until(async () => (await test('attachment-item').count()) === 3, 'drop adds one attachment')
    const bar = await test('attachment-bar').boundingBox()
    const field = await composer().boundingBox()
    assert.ok(bar && field && bar.y + bar.height <= field.y + 2, `附件栏应在输入框上方：${JSON.stringify({ bar, field })}`)
    await shot('rm2-lane2-intake.png')
    return '粘贴 1 项，再加选择与拖入共 3 项'
  })

  await check('lane_3_live_markdown_and_caret', async () => {
    await clearComposer()
    const draft = '**粗体** *斜体* `代码` 一行'
    await composer().fill(draft)
    await until(async () => {
      const text = await test('message-input-highlight').textContent()
      return (text ?? '').trim() === draft
    }, 'mirror layer carries the draft')
    const measured = await drift(draft)
    assert.equal(measured.decorated, measured.expected, `装饰层字符数应与草稿一致：${JSON.stringify(measured)}`)
    assert.equal(measured.flow, draft, `装饰层文本应与草稿逐字一致：${JSON.stringify(measured.flow)}`)
    assert.ok(measured.max <= 1, `装饰不得推移文字：最大偏移 ${measured.max}px @${measured.at}`)
    await composer().press('End')
    let caret = (await composer().evaluate(node => node.selectionStart)) ?? 0
    assert.equal(caret, draft.length, 'End 应把光标放到行尾')
    for (let step = 0; step < 5; step++) {
      await composer().press('ArrowLeft')
      const next = (await composer().evaluate(node => node.selectionStart)) ?? -1
      assert.equal(next, caret - 1, `第 ${step + 1} 次左移应恰好退一格`)
      caret = next
    }
    await shot('rm2-lane3-live-md.png')
    return `${measured.expected} 个字符最大偏移 ${measured.max.toFixed(2)}px`
  })

  await check('lane_4_remove_and_reference_token', async () => {
    await clearComposer()
    await inject('paste', [{ name: '引用目标.png', type: 'image/png', buffer: png(64, 64) }])
    await until(async () => (await test('attachment-item').count()) === 1, 'one attachment for reference')
    const localId = await test('attachment-item').first().getAttribute('data-local-id')
    assert.ok(localId, '附件项应带 data-local-id')
    await composer().fill('看看 ')
    await composer().press('End')
    await test('attachment-tag').first().click()
    const withToken = await composer().inputValue()
    assert.equal(withToken, `看看 [[att:${localId}]]`, `标签应在光标处插入引用 token：${withToken}`)
    await until(async () => (await page.locator('.composer-ref-chip').count()) >= 1, 'reference chip rendered')
    await test('attachment-remove').first().click()
    await until(async () => (await test('attachment-item').count()) === 0, 'attachment removed')
    const afterRemove = await composer().inputValue()
    assert.ok(!afterRemove.includes(`[[att:${localId}]]`), `移除附件应一并删掉 token：${afterRemove}`)
    await shot('rm2-lane4-remove-tag.png')
    return `插入 ${JSON.stringify(withToken)} 后移除又复原`
  })

  await check('lane_5_paste_png_send_and_narrow_width', async () => {
    await clearComposer()
    await inject('paste', [{ name: '粘贴的 240 图.png', type: 'image/png', buffer: png(240, 240) }])
    await until(async () => (await test('attachment-item').count()) === 1, 'one attachment before send')
    const size = await page.evaluate(() => {
      const node = document.querySelector('[data-testid="attachment-item"]')
      return node ? node.textContent : ''
    })
    assert.ok(size, 'attachment bar should describe the file')
    await sendWithReference('看图 ')
    await until(async () => {
      const items = await test('message-item').count()
      if (items === 0) return false
      return page.evaluate(() => {
        const list = document.querySelectorAll('[data-testid="message-item"]')
        const image = list[list.length - 1]?.querySelector('[data-testid="message-attachment-figure"] img')
        return image ? image.complete && image.naturalWidth > 0 : false
      })
    }, 'image decodes in the sent message')
    const image = await page.evaluate(() => {
      const list = document.querySelectorAll('[data-testid="message-item"]')
      const node = list[list.length - 1].querySelector('[data-testid="message-attachment-figure"] img')
      return { width: node.naturalWidth, height: node.naturalHeight, src: node.getAttribute('src') ?? '' }
    })
    assert.equal(image.width, 240, `图片应真的是 240 宽：${JSON.stringify(image)}`)
    assert.equal(image.height, 240, '方图应保持宽高比')
    assert.ok(image.src.startsWith('blob:'), `图片字节应先经鉴权读取路由再转 object URL：${image.src}`)
    const read = attachmentReads.find(item => item.url.includes(`/api/attachments/`))
    assert.ok(read, `应有对读取路由的请求：${JSON.stringify(attachmentReads)}`)
    assert.ok((await test('message-attachment-ref').count()) >= 1, '引用应渲染成芯片')
    await page.setViewportSize({ width: 390, height: 844 })
    await delay(300)
    const narrow = await overflow()
    assert.equal(narrow.document, 0, `390 宽度下不应横向溢出：${JSON.stringify(narrow)}`)
    for (const item of narrow.images) {
      assert.ok(item.width <= item.container + 1, `图片不得超出容器：${JSON.stringify(item)}`)
      assert.ok(item.width <= item.natural * 2 + 1, `小图最多放大到 200%：${JSON.stringify(item)}`)
      // 量到的矩形含 1px 边框，比例要拿图片内容比。
      const contentWidth = item.width - 2
      const contentHeight = item.height - 2
      const expected = contentWidth * (item.naturalHeight / item.natural)
      assert.ok(Math.abs(contentHeight - expected) <= 1.5, `图片必须按原始比例：${JSON.stringify(item)}`)
      assert.ok(contentHeight <= item.viewport * 0.6 + 2, `高图不得超过视口高度上限：${JSON.stringify(item)}`)
    }
    await shot('rm2-lane5-paste-390.png')
    await page.setViewportSize({ width: 1280, height: 900 })
    return `解码 ${image.width}x${image.height}，390 宽无溢出`
  })

  await check('probe_attachment_read_route', async () => {
    const row = sqliteHandle
      .prepare('SELECT id, filename, mime_type, byte_size FROM attachment WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(chatId)
    assert.ok(row, '应已有入库的附件')
    const response = await page.request.get(`${base}/api/attachments/${row.id}`)
    const type = response.headers()['content-type'] ?? ''
    const text = type.includes('json') ? (await response.text()).slice(0, 200) : `<${type} ${(await response.body()).length} bytes>`
    return `${row.id} ${row.filename} ${row.mime_type} ${row.byte_size}B → ${response.status()} ${text} | 页面内失败 ${JSON.stringify(attachmentFailures.slice(0, 4))}`
  })

  await check('lane_6_agent_image_message_renders', async () => {
    const bytes = png(96, 96)
    const attachmentId = `att_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const body = `夹具图 [[att:${attachmentId}]]`
    seedAgentMessage({
      chatId, projectId, body,
      attachment: { id: attachmentId, filename: '夹具图.png', mimeType: 'image/png', bytes },
      spans: [{ start: body.indexOf('[[att:'), end: body.indexOf(']]') + 2 }],
    })
    await page.reload({ waitUntil: 'networkidle' })
    await test('message-input').waitFor()
    await until(async () => (await test('message-attachment-image').count()) > 0, 'agent image rendered')
    const alt = await test('message-attachment-image').last().getAttribute('alt')
    assert.equal(alt, '夹具图.png', `替代文本应是文件名：${alt}`)
    const loaded = await test('message-attachment-image').last().evaluate(node => node.complete && node.naturalWidth > 0)
    assert.ok(loaded, 'agent 消息里的图片也必须真的加载')
    await shot('rm2-lane6-agent-image.png')
    return `agent 消息内联图片 alt=${alt}`
  })

  await check('lane_7_large_image_is_lazy', async () => {
    const bytes = png(700, 700)
    const attachmentId = `att_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const body = `大图 [[att:${attachmentId}]]`
    payloadPeak = 0
    seedAgentMessage({
      chatId, projectId, body,
      attachment: { id: attachmentId, filename: '大图.png', mimeType: 'image/png', bytes },
      spans: [{ start: body.indexOf('[[att:'), end: body.indexOf(']]') + 2 }],
    })
    await page.reload({ waitUntil: 'networkidle' })
    await test('message-input').waitFor()
    await until(async () => (await test('message-attachment-image').count()) >= 2, 'large image rendered')
    const lazy = await page.evaluate(() => {
      const list = document.querySelectorAll('[data-testid="message-attachment-image"]')
      return list[list.length - 1]?.getAttribute('loading') ?? ''
    })
    assert.equal(lazy, 'lazy', '大图应延迟加载')
    assert.ok(payloadPeak > 0 && payloadPeak < bytes.length / 20, `列表载荷不得随图片字节增长：peak=${payloadPeak} bytes=${bytes.length}`)
    const read = attachmentReads.find(item => item.length > bytes.length / 2)
    assert.ok(read, `图片字节应经单独读取请求取得：${JSON.stringify(attachmentReads)}`)
    await shot('rm2-lane7-large.png')
    return `大图 ${bytes.length} 字节，单次服务端载荷峰值 ${payloadPeak} 字节`
  })

  await check('lane_8_pdf_file_chip', async () => {
    await clearComposer()
    const bytes = pdf()
    await upload([{ name: '需求说明.pdf', type: 'application/pdf', buffer: bytes }])
    await until(async () => (await test('attachment-item').count()) === 1, 'pdf attached')
    await sendWithReference('看这份文档 ')
    await until(async () => (await test('message-attachment-file').count()) > 0, 'pdf chip rendered')
    const chip = await test('message-attachment-file').last().textContent()
    assert.ok((chip ?? '').includes('需求说明.pdf'), `芯片应显示文件名：${chip}`)
    assert.ok((chip ?? '').includes('B'), `芯片应显示大小：${chip}`)
    const broken = await page.evaluate(() => {
      const list = document.querySelectorAll('[data-testid="message-item"]')
      return list[list.length - 1]?.querySelectorAll('[data-testid="message-attachment-image-broken"]').length ?? 0
    })
    assert.equal(broken, 0, 'PDF 不应出现坏图占位')
    await shot('rm2-lane8-pdf.png')
    return `芯片 ${(chip ?? '').replace(/\s+/g, '')}`
  })

  await check('lane_9_missing_attachment_placeholders', async () => {
    const missing = await page.request.get(`${base}/api/attachments/att_00000000`)
    assert.equal(missing.status(), 404, `不存在的附件应返回 404 而不是 500：${missing.status()}`)
    const body = await missing.json()
    assert.equal(body.error?.code, 'not_found', `错误码应是 not_found：${JSON.stringify(body)}`)
    const bytes = png(64, 64)
    const attachmentId = `att_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const text = `缺图 [[att:${attachmentId}]]`
    seedAgentMessage({
      chatId, projectId, body: text,
      attachment: { id: attachmentId, filename: '缺图.png', mimeType: 'image/png', bytes },
      spans: [{ start: text.indexOf('[[att:'), end: text.indexOf(']]') + 2 }],
    })
    unlinkSync(join(attachmentDirectory, attachmentId))
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.clearBrowserCache')
    await page.reload({ waitUntil: 'networkidle' })
    await test('message-input').waitFor()
    await until(async () => (await test('message-item').count()) > 0 && page.evaluate(() => {
      const list = document.querySelectorAll('[data-testid="message-item"]')
      return Boolean(list[list.length - 1]?.querySelector('[data-testid="message-attachment-image-broken"]'))
    }), 'broken figure after file deletion')
    const notice = await page.evaluate(() => {
      const list = document.querySelectorAll('[data-testid="message-item"]')
      return list[list.length - 1].querySelector('[data-testid="message-attachment-image-broken"]')?.textContent ?? ''
    })
    assert.ok(notice.includes('磁盘'), `占位应说明磁盘上已缺失：${notice}`)
    await shot('rm2-lane9-missing.png')
    return `404 回 not_found；磁盘缺失占位 ${JSON.stringify(notice.trim())}`
  })

  await check('lane_10_read_guard_and_failed_send_atomicity', async () => {
    const anonymous = await browser.newContext()
    const target = sqliteHandle
      .prepare('SELECT id FROM attachment WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(chatId)
    assert.ok(target, '应有一条已入库的附件')
    const guarded = await anonymous.request.get(`${base}/api/attachments/${target.id}`)
    assert.equal(guarded.status(), 401, `匿名读取应被拒：${guarded.status()}`)
    const bytes = await guarded.body()
    assert.ok(bytes.length < 500, `拒绝响应里不应有图片字节：${bytes.length}`)
    await anonymous.close()

    const stranger = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const other = await stranger.newPage()
    await other.goto(`${base}/login`)
    await other.getByTestId('register-tab').click()
    await other.locator('input[name="name"]').fill('RM2 路人')
    await other.locator('input[name="email"]').fill(`rm2-stranger-${Date.now()}@example.test`)
    await other.locator('input[name="password"]').fill(`${randomBytes(24).toString('base64url')}aA1!`)
    await other.locator('button[type="submit"]').click()
    await other.getByTestId('chat-list-content').waitFor()
    const cross = await stranger.request.get(`${base}/api/attachments/${target.id}`)
    assert.ok([403, 404].includes(cross.status()), `跨 Project 读取应被拒：${cross.status()}`)
    assert.ok((await cross.body()).length < 500, '跨 Project 的拒绝响应里不应有字节')
    await stranger.close()

    const attachments = count('attachment')
    const files = countDiskFiles()
    await composer().fill('这条会被拒')
    const cookie = (await context.cookies()).map(item => `${item.name}=${item.value}`).join('; ')
    const form = new FormData()
    form.append('chatId', chatId)
    form.append('body', '这条会被拒')
    form.append('localIds', 'huge')
    form.append('files', new File([Buffer.alloc(11 * 1024 * 1024, 1)], '太大.bin', { type: 'application/octet-stream' }))
    const rejected = await fetch(`${base}/api/attachments`, {
      method: 'POST', body: form, headers: { cookie, origin: base },
    })
    const payload = await rejected.json()
    assert.equal(payload.ok, false, `超限上传应失败：${JSON.stringify(payload)}`)
    assert.equal(payload.error?.code, 'validation_failed', `错误码应是 validation_failed：${JSON.stringify(payload)}`)
    assert.equal(count('attachment'), attachments, '失败的上传不得写入附件行')
    assert.equal(countDiskFiles(), files, '失败的上传不得写盘')
    assert.equal(await composer().inputValue(), '这条会被拒', '失败后输入框内容必须保留')
    await shot('rm2-lane10-cross-project.png')
    return `匿名 ${guarded.status()} 无字节；跨 Project ${cross.status()} 无字节；超限 ${payload.error.code} 且库与盘无新增`
  })

  await check('lane_11_image_viewer_zoom', async () => {
    const open = page.locator('[data-testid="message-attachment-open"]').first()
    await open.scrollIntoViewIfNeeded()
    await open.click()
    await page.waitForSelector('[data-testid="message-viewer-stage"]', { timeout: 15000 })
    const stage = await page.locator('[data-testid="message-viewer-stage"]').boundingBox()
    assert.ok(stage, '大图窗口应有可交互的画布')
    const before = Number(await page.getAttribute('[data-testid="message-viewer-stage"]', 'data-scale'))
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
    await page.mouse.wheel(0, -400)
    await delay(250)
    const zoomed = Number(await page.getAttribute('[data-testid="message-viewer-stage"]', 'data-scale'))
    assert.ok(zoomed > before, `滚轮向上应放大：${before} -> ${zoomed}`)
    await shot('rm2-lane11-viewer.png')
    await page.mouse.wheel(0, 900)
    await delay(250)
    const back = Number(await page.getAttribute('[data-testid="message-viewer-stage"]', 'data-scale'))
    assert.ok(back < zoomed, `滚轮向下应缩小：${zoomed} -> ${back}`)
    assert.ok(back >= 1, `缩小不应小于原始比例：${back}`)
    await page.keyboard.press('Escape')
    await delay(300)
    assert.equal(
      await page.locator('[data-testid="message-viewer-stage"]').count(),
      0,
      'Escape 应关闭大图窗口',
    )
    return `点图打开窗口，滚轮 ${before} -> ${zoomed} -> ${back}，Escape 关闭`
  })

  await check('console_clean_and_404_probes', async () => {
    await page.reload({ waitUntil: 'networkidle' })
    await delay(300)
    assert.deepEqual(pageErrors, [], `不应有未捕获的页面错误：${JSON.stringify(pageErrors)}`)
    assert.deepEqual(consoleErrors, [], `不应有未捕获的控制台错误：${JSON.stringify(consoleErrors)}`)
    assert.ok(attachmentMisses >= 1, `故意的缺失附件 404 探针应真的发生过：${attachmentMisses}`)
    return `页面错误 0 条，控制台错误 0 条，故意的附件 404 探针 ${attachmentMisses} 次`
  })
} catch (error) {
  failures += 1
  console.log(`FAIL rm2_attachments_runner :: ${error.message}`)
  console.log(error.stack ?? '')
} finally {
  await browser?.close().catch(() => undefined)
  stop()
  const killed = setTimeout(() => stop('SIGKILL'), 10000)
  await completion
  clearTimeout(killed)
}
const total = results.length
console.log(`SUMMARY rm2-attachments checks=${total} failed=${failures}`)
process.exitCode = failures > 0 ? 1 : 0
JS
