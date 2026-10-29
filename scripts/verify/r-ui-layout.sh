#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, openSync, closeSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'

const directory = resolve('.verify/r-ui-layout')
mkdirSync(directory, { recursive: true })
const port = Number(process.env.SPROUT_VERIFY_UI_LAYOUT_PORT ?? 3154)
const base = `http://localhost:${port}`
const database = join(directory, 'verification.sqlite')
const env = { ...process.env, PORT: String(port), NITRO_PORT: String(port), APP_ORIGIN: base,
  DATABASE_URL: database, BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  SPROUT_PI_ENABLED: 'false', NODE_ENV: 'production', BASE_URL: base, UI_LAYOUT_DIRECTORY: directory }
let server
function stop(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function launch(command, args, name) {
  const descriptor = openSync(join(directory, name), 'w')
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', descriptor, descriptor] })
  closeSync(descriptor)
  child.completion = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  return child
}
async function command(command, args, name, timeout = 300000) {
  const child = launch(command, args, name)
  const timer = setTimeout(() => stop(child, 'SIGKILL'), timeout)
  try {
    const result = await child.completion
    assert.equal(result.code, 0, `${command} ${args.join(' ')} failed; see ${join(directory, name)}`)
  } finally { clearTimeout(timer) }
}
try {
  await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(port, 'localhost', () => probe.close(resolve))
  })
  for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true })
  await command('node', ['scripts/verify/prepare.mjs', 'server'], 'build.log')
  server = launch(process.execPath, ['.output/server/index.mjs'], 'server.log')
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) break
    try { ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })).ok } catch {}
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert(ready, `production server not ready; see ${join(directory, 'server.log')}`)
  await command(process.execPath, ['scripts/browser/ui-layout-flow.mjs'], 'browser.log')
  console.log(`PASS UI layout, navigation and production dev boundary; evidence ${directory}/browser.json`)
} finally {
  stop(server)
  if (server) {
    const deadline = setTimeout(() => stop(server, 'SIGKILL'), 10000)
    await server.completion.catch(() => {})
    clearTimeout(deadline)
  }
}
JS
