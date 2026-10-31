import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

export const mode = process.argv[2];
const directory = resolve(`.verify/p7-client-${mode}-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const results = [];
export function pass(name, detail = {}) {
  results.push({ name, ...detail });
  console.log(`PASS ${name} ${JSON.stringify(detail)}`);
}
function launch(command, args, environment, log) {
  const fd = openSync(join(directory, log), "w");
  const child = spawn(command, args, { env: environment, stdio: ["ignore", fd, fd] });
  child.done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return child;
}
async function port() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const value = server.address().port;
  await new Promise((r) => server.close(r));
  return value;
}
async function ready(base, child) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}; ${directory}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`server health timeout: ${directory}`);
}
async function login(page, email, password) {
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== "/login", { timeout: 30000 });
}
export async function runProduction(check) {
  const value = await port();
  const base = `http://localhost:${value}`;
  const email = `p7-${randomUUID()}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const env = {
    ...process.env,
    DATABASE_URL: join(directory, "client.sqlite"),
    PORT: String(value),
    NITRO_PORT: String(value),
    APP_ORIGIN: base,
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    P7_EMAIL: email,
  };
  const build = launch(
    process.execPath,
    ["scripts/verify/prepare.mjs", "server"],
    env,
    "build.log",
  );
  assert.equal((await build.done).code, 0, `production build: ${directory}/build.log`);
  const server = launch(process.execPath, [".output/server/index.mjs"], env, "server.log");
  let browser;
  try {
    await ready(base, server);
    assert.equal((await fetch(base + "/api/diagnostics?summary=1")).status, 401);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "allow",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`${base}/login?next=%2Fmanagement`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("register-tab").click();
    await page.locator('input[name="name"]').fill("P7 Client Human");
    await login(page, email, password);
    await page.getByTestId("management-page").waitFor();
    assert.equal(new URL(page.url()).pathname, "/management");
    pass("register_restores_management");
    const seed = launch(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/p7-client-seed.ts"],
      env,
      "seed.log",
    );
    assert.equal((await seed.done).code, 0, `seed: ${directory}/seed.log`);
    const seeded = JSON.parse(
      readFileSync(join(directory, "seed.log"), "utf8").trim().split("\n").at(-1),
    );
    const diagnostics = await context.request.get(base + "/api/diagnostics?summary=1");
    assert.equal(diagnostics.status(), 200);
    const summary = (await diagnostics.json()).data;
    assert.equal(summary.migration.hash, seeded.migration.hash);
    assert.equal(summary.migration.id, seeded.migration.id);
    assert.equal(summary.pendingResourceNotices, 0);
    assert.equal(summary.pendingContinuations, 0);
    assert.deepEqual(summary.mcpFrames, []);
    assert.equal((await context.request.get(base + "/api/diagnostics")).status(), 400);
    const events = await context.request.get(
      base + "/api/diagnostics?requestId=req_p7-client-seed",
    );
    assert.equal(events.status(), 200);
    assert.ok(Array.isArray((await events.json()).data));
    pass("management_summary_auth_migration_queues_preserves_event_query");
    await check({
      page,
      context,
      base,
      seeded,
      login: () => login(page, email, password),
      directory,
    });
  } finally {
    await browser?.close();
    if (server.exitCode === null) server.kill("SIGTERM");
    const stopped = await Promise.race([server.done, delay(10000).then(() => null)]);
    if (!stopped && server.exitCode === null) server.kill("SIGKILL");
    await server.done;
    writeFileSync(join(directory, "assertions.json"), JSON.stringify(results, null, 2));
    console.log(`EVIDENCE ${directory}`);
  }
}

export { assert, delay };
