// Browser checks for the SPA deep link, session lifecycle, protected server function,
// and the shadcn + Base UI components. Prints one PASS/FAIL line per check.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

const results = []
const consoleErrors = []

function record(name, passed, detail) {
  results.push({ name, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name} :: ${detail}`)
}

async function check(name, fn) {
  try {
    await fn()
  } catch (error) {
    record(name, false, `threw ${error.message}`)
  }
}

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()

page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(String(error)))

const email = `probe-${Date.now()}@example.com`
const password = 'probe-password-123'

await check('deep_link_http_status', async () => {
  const response = await page.goto(`${BASE}/second`, { waitUntil: 'domcontentloaded' })
  const status = response?.status()
  const body = (await response?.text()) ?? ''
  const shellOnly = !body.includes('Second page')
  record(
    'deep_link_http_status',
    status === 200 && shellOnly,
    `GET /second -> ${status}, client-only markup (no SSR body): ${shellOnly}`,
  )
})

await check('deep_link_client_render', async () => {
  await page.waitForSelector('[data-testid="second-marker"]', { timeout: 15000 })
  const text = await page.textContent('[data-testid="second-marker"]')
  record(
    'deep_link_client_render',
    text?.trim() === 'deep-link-target',
    `/second rendered marker "${text?.trim()}"`,
  )
})

await check('shadcn_button_styled', async () => {
  const style = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="styled-button"]')
    if (!button) return null
    const computed = getComputedStyle(button)
    return {
      background: computed.backgroundColor,
      radius: computed.borderRadius,
      height: computed.height,
      dataSlot: button.getAttribute('data-slot'),
    }
  })
  const themed =
    style !== null &&
    style.background !== 'rgba(0, 0, 0, 0)' &&
    style.height !== 'auto'
  record(
    'shadcn_button_styled',
    themed,
    `button computed styles ${JSON.stringify(style)}`,
  )
})

await check('base_ui_dialog_open', async () => {
  await page.click('[data-testid="dialog-trigger"]')
  await page.waitForSelector('[data-testid="dialog-marker"]', { timeout: 10000 })
  const text = await page.textContent('[data-testid="dialog-marker"]')
  record(
    'base_ui_dialog_open',
    text?.trim() === 'dialog-rendered',
    `dialog content visible with "${text?.trim()}"`,
  )
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="dialog-marker"]', {
    state: 'detached',
    timeout: 10000,
  })
})

await check('sign_up_sets_session', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.fill('[data-testid="email-input"]', email)
  await page.fill('[data-testid="password-input"]', password)
  await page.click('[data-testid="sign-up"]')
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="session-email"]')?.textContent === expected,
    email,
    { timeout: 15000 },
  )
  record('sign_up_sets_session', true, `session-email === ${email}`)
})

await check('session_survives_reload', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="session-email"]')?.textContent === expected,
    email,
    { timeout: 15000 },
  )
  record('session_survives_reload', true, 'session cookie read on a fresh document load')
})

await check('protected_call_allowed_with_session', async () => {
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes('/_serverFn/'),
  )
  await page.click('[data-testid="call-protected"]')
  const response = await responsePromise
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="protected-result"]')
        ?.textContent?.startsWith('ok:'),
    undefined,
    { timeout: 15000 },
  )
  const text = await page.textContent('[data-testid="protected-result"]')
  record(
    'protected_call_allowed_with_session',
    response.status() === 200 && text?.startsWith('ok:') === true,
    `server fn ${response.status()} -> "${text?.trim()}"`,
  )
})

await check('sign_out_clears_session', async () => {
  await page.click('[data-testid="sign-out"]')
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="session-email"]')?.textContent ===
      'no-session',
    undefined,
    { timeout: 15000 },
  )
  record('sign_out_clears_session', true, 'session-email === no-session')
})

await check('protected_call_rejected_without_session', async () => {
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes('/_serverFn/'),
  )
  await page.click('[data-testid="call-protected"]')
  const response = await responsePromise
  const body = await response.text()
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="protected-result"]')
        ?.textContent?.startsWith('rejected:'),
    undefined,
    { timeout: 15000 },
  )
  const text = await page.textContent('[data-testid="protected-result"]')
  const errorInPayload = body.includes('Unauthorized')
  record(
    'protected_call_rejected_without_session',
    text?.startsWith('rejected:') === true && errorInPayload,
    `server fn HTTP ${response.status()} carries the error in the payload (${errorInPayload}) -> "${text?.trim()}"`,
  )
})

record(
  'no_console_errors',
  consoleErrors.length === 0,
  consoleErrors.length === 0
    ? 'no console.error or uncaught page errors'
    : consoleErrors.join(' | '),
)

await browser.close()

const failed = results.filter((result) => !result.passed)
console.log(`browser checks: ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
