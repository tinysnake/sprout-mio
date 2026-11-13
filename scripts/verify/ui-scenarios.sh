#!/usr/bin/env bash
# Risk → assertion:
# - dev 场景页随 UI 漂移、却没人发现 → 这条 gate 起一个真实 dev server 跑完 `scripts/browser/ui-scenarios.mjs`，
#   场景里失效的等待会直接红，而不是等到下一次有人手动跑才发现。
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
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'

const directory = resolve('.verify/ui-scenarios')
mkdirSync(directory, { recursive: true })
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
const base = `http://127.0.0.1:${port}`
Object.assign(process.env, {
  DATABASE_URL: database,
  APP_ORIGIN: base,
  BASE_URL: base,
  PORT: String(port),
  NITRO_PORT: String(port),
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  SPROUT_PI_ENABLED: 'false',
  SPROUT_UI_SCENES_URL: `${base}/__dev/ui/`,
  SPROUT_UI_SCENES_EVIDENCE: join(directory, 'evidence'),
})
const fd = openSync(join(directory, 'server.log'), 'w')
const server = spawn('pnpm', ['exec', 'vp', 'dev', '--host', '127.0.0.1'], {
  env: process.env,
  detached: true,
  stdio: ['ignore', fd, fd],
})
closeSync(fd)
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
function stop(signal = 'SIGTERM') {
  try {
    process.kill(-server.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
const completion = new Promise((done) => server.once('exit', (code) => done(code)))

try {
  let ready = false
  for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
    try {
      const response = await fetch(`${base}/__dev/ui/`, { signal: AbortSignal.timeout(2000) })
      ready = response.status < 500
    } catch {
      await delay(500)
    }
  }
  assert(ready, 'dev server 没有在 60 秒内就绪，看 .verify/ui-scenarios/server.log')
  const run = spawn('node', ['scripts/browser/ui-scenarios.mjs'], { env: process.env, stdio: 'inherit' })
  const code = await new Promise((done) => run.once('exit', done))
  assert.equal(code, 0, `ui-scenarios 退出码 ${code}`)
} finally {
  stop()
  await Promise.race([completion, delay(10000)])
}
JS
