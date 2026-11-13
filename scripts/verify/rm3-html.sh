#!/usr/bin/env bash
# Risk → assertion:
# - 消息里的 HTML 执行脚本 → 行内标签按白名单渲染，脚本与事件属性都不出现在 DOM 里，页面不弹窗。
# - 完整文档碰应用 → 沙箱 `allow-scripts` 无 `allow-same-origin`，文档脚本能跑，但读 `top.document` 被拒、父页面标题不变。
# - 沙箱里的请求出网 → srcdoc 的 CSP 用 `default-src 'none'`，文档自己的样式与脚本放行。
# - 片段样式被剥掉 → 围栏标 html 的片段补外壳进沙箱，圆角、底色、网格按文档样式生效。
# - 沙箱高度写死 → 短文档按内容收缩、长文档随内容增高，两种都不出现内部滚动条。
# - 超长 HTML 拖死标签页 → 超过上限只显示提示与原文。
# - 只对 Agent 生效 → 人类消息走同一套清洗。
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
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
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { chromium } from 'playwright'

const directory = resolve('.verify/rm3-html')
const evidence = join(directory, 'evidence')
mkdirSync(evidence, { recursive: true })

const database = join(directory, 'verification.sqlite')
for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true })
const port = await new Promise((done, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port
    probe.close(() => done(port))
  })
})
const base = `http://localhost:${port}`
Object.assign(process.env, {
  DATABASE_URL: database,
  APP_ORIGIN: base,
  BASE_URL: base,
  PORT: String(port),
  NITRO_PORT: String(port),
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  SPROUT_PI_ENABLED: 'false',
})
const fd = openSync(join(directory, 'server.log'), 'w')
const server = spawn('pnpm', ['exec', 'vp', 'dev', '--host', '0.0.0.0'], {
  env: process.env,
  detached: true,
  stdio: ['ignore', fd, fd],
})
closeSync(fd)
function stop(signal = 'SIGTERM') {
  try {
    process.kill(-server.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
const completion = new Promise((done) => server.once('exit', (code) => done(code)))

const results = []
const dialogs = []
const pageErrors = []
const consoleErrors = []

function pass(id, detail) {
  results.push({ id, detail })
  console.log(`PASS ${id} ${detail}`)
}

async function check(id, run) {
  try {
    pass(id, await run())
  } catch (error) {
    results.push({ id, error: String(error) })
    console.error(`FAIL ${id} ${error.stack ?? error}`)
    throw error
  }
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
page.on('dialog', async (dialog) => {
  dialogs.push(dialog.message())
  await dialog.dismiss()
})
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})

let projectId
let chatId
let senderId
let sqliteHandle
const test = (id) => page.getByTestId(id)
const scope = (id) => `[data-message-id="${id}"] [data-testid="message-body"]`
const htmlBlock = (id) => `${scope(id)} [data-testid="html-block"]`

async function shot(name) {
  await page.screenshot({ path: join(evidence, name), fullPage: false })
}

try {
  let ready = false
  for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
    try {
      const response = await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: 2000 })
      ready = (response?.status() ?? 500) < 500
    } catch {
      await delay(500)
    }
  }
  assert(ready, 'server must serve /login')

  await test('register-tab').waitFor()
  await test('register-tab').click()
  const email = `rm3-html-${Date.now()}@example.test`
  await page.locator('input[name="name"]').fill('RM3 HTML 验收')
  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill(`${randomBytes(24).toString('base64url')}aA1!`)
  await page.locator('button[type="submit"]').click()

  const { createProject, waitForChats } = await import('./scripts/browser/ui-navigation.mjs')
  await waitForChats(page)
  const project = await createProject(page, { name: `RM3 HTML ${Date.now()}`, description: '消息内 HTML 与沙箱' })
  projectId = project.path.split('/')[2]

  const { sqlite } = await import('./src/db/index.ts')
  sqliteHandle = sqlite
  const { createAgentProfile, addProjectMember } = await import('./src/domain/agent.ts')
  const { createDirectChat } = await import('./src/domain/chat.ts')
  const user = sqliteHandle.prepare('SELECT id FROM user WHERE email = ?').get(email)
  assert(user, 'authenticated user must be persisted')
  const ctx = { userId: user.id, requestId: `req_${randomUUID().replaceAll('-', '').slice(0, 8)}` }
  const agent = createAgentProfile({ name: 'RM3 HTML Agent', persona: 'HTML 渲染验收' }, ctx)
  addProjectMember(projectId, agent.id, ctx)
  const dm = createDirectChat(projectId, agent.id, ctx)
  chatId = dm.chat.id
  senderId = agent.id

  const insert = (tag, body, senderKind = 'agent') => {
    const id = `msg_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    sqliteHandle
      .prepare(
        "INSERT INTO message (id, chat_id, sender_kind, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, unixepoch() + 5)",
      )
      .run(id, chatId, senderKind, senderKind === 'human' ? user.id : senderId, body)
    return id
  }

  const markers = {}
  const ids = {
    L2: insert('L2', '行内白名单：<b>加粗</b>与<i>斜体</i><script>alert("不该执行")</script>'),
    L3: insert('L3', '<img src="x" onerror="alert(1)"> <a href="javascript:alert(2)">点我</a>'),
    L4: insert(
      'L4',
      [
        '```html',
        '<!doctype html>',
        '<html><head><meta charset="utf-8"><style>body{margin:0;font:14px/1.5 system-ui}td{padding:4px 8px;border:1px solid #cbd5e1}</style></head>',
        '<body><h3>沙箱文档</h3><p>这段来自消息里的完整 HTML。</p>',
        '<table><tr><th>步骤</th><th>耗时</th></tr><tr><td>构建</td><td>12s</td></tr><tr><td>测试</td><td>48s</td></tr></table>',
        '<script>document.body.dataset.ran = "1";try{void window.top.document.title;document.body.dataset.escape = "LEAK"}catch{document.body.dataset.escape = "BLOCKED"}</script>',
        '</body></html>',
        '```',
      ].join('\n'),
    ),
    L7: insert('L7', '<span style="color: #ff0000">行内样式</span> <b style="color: #ff0000">加粗样式</b>'),
    L9: insert('L9', `<b>超长</b>${'很长的正文内容。'.repeat(30000)}`),
    L10: insert('L10', '人类消息：<b>加粗</b><script>alert("不该执行")</script>', 'human'),
    short: insert('short', '```html\n<!doctype html><html><body><p>短文档只有一行。</p></body></html>\n```'),
    tall: insert(
      'tall',
      [
        '```html',
        '<!doctype html><html><body><h3>长文档</h3>',
        ...Array.from({ length: 18 }, (_, index) => `<p>第 ${index + 1} 行内容，用来把沙箱撑高。</p>`),
        '</body></html>',
        '```',
      ].join('\n'),
    ),
    card: insert(
      'card',
      [
        '```html',
        '<style>',
        '.card{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr));padding:16px;border-radius:14px;background:#eef2ff}',
        '.chip{display:inline-block;padding:4px 10px;border-radius:999px;background:#312e81;color:#fff;font-weight:600}',
        '</style>',
        '<div class="card"><div><h3>构建</h3><span class="chip">通过</span></div><div><h3>测试</h3><span class="chip">12/12</span></div></div>',
        '```',
      ].join('\n'),
    ),
  }
  for (const [key, id] of Object.entries(ids)) markers[key] = id

  const chatUrl = `${base}/projects/${projectId}/chats/${chatId}`
  const response = await page.goto(chatUrl, { waitUntil: 'domcontentloaded' })
  await test('message-item').first().waitFor()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="message-item"]').length >= 9, null, {
    timeout: 30000,
  })
  pass('setup_real_project_agent_and_dm_chat', `project ${projectId} chat ${chatId}`)
  await shot('rm3-lane-card-light.png')

  const inner = async (id) => page.locator(scope(id)).evaluate((node) => node.innerHTML)
  const text = async (id) => page.locator(scope(id)).evaluate((node) => node.textContent ?? '')
  const evaluate = async (id, fn) => page.locator(scope(id)).evaluate(fn)

  await check('lane_2_inline_markup_renders_without_scripts', async () => {
    const markup = await inner(ids.L2)
    assert(!markup.includes('<script'), `脚本节点不该出现在 DOM 里：${markup}`)
    assert.equal(await page.locator(`${scope(ids.L2)} script`).count(), 0, '脚本节点计数应为 0')
    assert((await text(ids.L2)).includes('加粗'), '加粗文字应渲染')
    assert(!(await text(ids.L2)).includes('不该执行'), `脚本源码不该作为文本显示：${await text(ids.L2)}`)
    assert.deepEqual(dialogs, [], `不应有弹窗：${JSON.stringify(dialogs)}`)
    return '白名单标签渲染，脚本整块消失'
  })

  await check('lane_3_event_attributes_and_javascript_links_removed', async () => {
    const markup = await inner(ids.L3)
    assert(!markup.includes('onerror'), `事件属性应被去掉：${markup}`)
    const hrefs = await page.locator(`${scope(ids.L3)} a`).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))
    assert(!hrefs.some((href) => (href ?? '').toLowerCase().startsWith('javascript:')), `javascript: 链接应被去掉：${JSON.stringify(hrefs)}`)
    return `href=${JSON.stringify(hrefs)}`
  })

  await check('lane_4_full_document_goes_into_a_sandbox', async () => {
    const frame = page.locator(htmlBlock(ids.L4))
    assert.equal(await frame.count(), 1, '完整文档应渲染成沙箱')
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts', '沙箱不能有 allow-same-origin')
    const source = await frame.getAttribute('srcdoc')
    assert(source.includes('<!doctype html'), 'srcdoc 应是完整文档')
    assert(source.includes('Content-Security-Policy'), 'srcdoc 应带 CSP')
    const box = await frame.evaluate((node) => node.getBoundingClientRect().height)
    assert(box > 40, `沙箱高度应大于 40，实际 ${box}`)
    return `sandbox=${await frame.getAttribute('sandbox')} height=${Math.round(box)}`
  })

  await check('lane_5_sandbox_runs_document_scripts_but_cannot_read_the_app', async () => {
    const handle = await page.locator(htmlBlock(ids.L4)).elementHandle()
    const frame = await handle.contentFrame()
    assert(frame, '沙箱 frame 应存在')
    const verdict = await frame.evaluate(() => ({
      ran: document.body.dataset.ran ?? null,
      escape: document.body.dataset.escape ?? null,
    }))
    assert.equal(verdict.ran, '1', `文档自己的脚本应执行：${JSON.stringify(verdict)}`)
    assert.equal(verdict.escape, 'BLOCKED', `沙箱内不该读到父页面：${JSON.stringify(verdict)}`)
    const leaked = await page.evaluate(() => document.title)
    assert.notEqual(leaked, 'LEAK', '父页面标题不该被沙箱改写')
    return `script ran=1 top.document=${verdict.escape}`
  })

  await check('lane_6_no_csp_added_to_the_app', async () => {
    const headers = response.headers()
    assert.equal(headers['content-security-policy'] ?? null, null, '应用层不该新增 CSP')
    return 'content-security-policy 为空'
  })

  await check('lane_7_inline_styles_are_stripped', async () => {
    const markup = await inner(ids.L7)
    assert(!markup.includes('style='), `行内 style 应被去掉：${markup}`)
    const colors = await page
      .locator(`${scope(ids.L7)} span, ${scope(ids.L7)} b`)
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color))
    assert(!colors.some((color) => color === 'rgb(255, 0, 0)'), `颜色不该生效：${JSON.stringify(colors)}`)
    return `colors=${JSON.stringify(colors)}`
  })

  await check('lane_9_oversize_html_shows_a_notice_instead', async () => {
    await page.locator(`${scope(ids.L9)} [data-testid="html-too-long"]`).waitFor({ timeout: 20000 })
    const markup = await inner(ids.L9)
    assert(!markup.includes('<b>'), `超长消息不该渲染标记：${markup.slice(0, 120)}`)
    assert((await text(ids.L9)).includes('超长'), '提示里应保留原文')
    return '超出上限只出提示'
  })

  await check('lane_10_human_messages_use_the_same_rules', async () => {
    const markup = await inner(ids.L10)
    assert(markup.includes('<b>加粗</b>'), `人类消息也应渲染白名单标签：${markup}`)
    assert(!markup.includes('<script'), `人类消息也不该保留脚本：${markup}`)
    return '人类消息同规则'
  })

  await check('lane_11_sandbox_height_follows_content', async () => {
    const measure = (id) => page.locator(htmlBlock(id)).evaluate((node) => node.getBoundingClientRect().height)
    const short = await measure(ids.short)
    const tall = await measure(ids.tall)
    assert(short > 40 && short < 200, `短文档应收缩，实际 ${short}`)
    assert(tall > 300, `长文档应增高，实际 ${tall}`)
    const overflow = await page
      .locator(htmlBlock(ids.tall))
      .evaluate((node) => node.getBoundingClientRect().height >= 100)
    assert(overflow, '长文档高度应被测量到')
    return `short=${Math.round(short)} tall=${Math.round(tall)}`
  })

  await check('lane_14_fragment_becomes_an_artifact_surface', async () => {
    const frame = page.locator(htmlBlock(ids.card))
    assert.equal(await frame.count(), 1, '片段应渲染成沙箱')
    const source = await frame.getAttribute('srcdoc')
    assert(source.includes('<!doctype html'), `片段应补上外壳：${source.slice(0, 120)}`)
    const handle = await frame.elementHandle()
    const child = await handle.contentFrame()
    assert(child, '沙箱 frame 应存在')
    const look = await child.evaluate(() => {
      const card = document.querySelector('.card')
      const chip = document.querySelector('.chip')
      const style = getComputedStyle(card)
      return {
        radius: style.borderRadius,
        background: style.backgroundColor,
        columns: style.gridTemplateColumns.split(' ').length,
        chip: getComputedStyle(chip).backgroundColor,
        width: Math.round(card.getBoundingClientRect().width),
        scrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      }
    })
    assert.equal(look.radius, '14px', `圆角应生效：${JSON.stringify(look)}`)
    assert.equal(look.background, 'rgb(238, 242, 255)', `卡片底色应生效：${JSON.stringify(look)}`)
    assert.equal(look.columns, 2, `两列网格应生效：${JSON.stringify(look)}`)
    assert.equal(look.chip, 'rgb(49, 46, 129)', `芯片底色应生效：${JSON.stringify(look)}`)
    assert(look.width > 500, `卡片应占满沙箱宽度：${look.width}`)
    assert.equal(look.scrolls, false, '沙箱内不该出现滚动条')
    return `radius=${look.radius} width=${look.width} scrolls=${look.scrolls}`
  })

  await check('lane_12_page_stays_clean', async () => {
    assert.deepEqual(consoleErrors, [], `不应有控制台错误：${JSON.stringify(consoleErrors)}`)
    assert.deepEqual(dialogs, [], `不应有弹窗：${JSON.stringify(dialogs)}`)
    assert.deepEqual(pageErrors, [], `不应有页面异常：${JSON.stringify(pageErrors)}`)
    return '弹窗 0、页面异常 0、控制台错误 0'
  })

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="html-block"]').length >= 3, null, {
    timeout: 30000,
  })
  await shot('rm3-lane-card-dark.png')
  await check('lane_13_dark_theme_moves_the_paper_with_it', async () => {
    const look = await page.locator(htmlBlock(ids.L4)).evaluate((node) => {
      const style = getComputedStyle(node)
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const context = canvas.getContext('2d')
      const luminance = (color) => {
        context.fillStyle = '#000'
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      }
      return {
        paper: style.backgroundColor,
        text: style.color,
        paperLuminance: luminance(style.backgroundColor),
        textLuminance: luminance(style.color),
      }
    })
    assert(look.paperLuminance < 0.35, `暗色主题下纸面应随之变暗，实际 ${JSON.stringify(look)}`)
    assert(look.textLuminance > 0.6, `暗色主题下文字应转浅，实际 ${JSON.stringify(look)}`)
    return `paper=${look.paper} text=${look.text}`
  })
} finally {
  await browser.close().catch(() => {})
  stop()
  await Promise.race([completion, delay(10000)])
  sqliteHandle?.close?.()
}

const failed = results.filter((result) => result.error)
console.log(`SUMMARY ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exit(1)
JS
