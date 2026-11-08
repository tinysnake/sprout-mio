import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { once } from "node:events";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { startModelFixture } from "../../scripts/verify/lib/model-fixture.mjs";

const directory = resolve(
  process.env.SPROUT_WEBHOOK_EVIDENCE_DIR ?? `.verify/webhook-${Date.now()}`,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
console.log(`EVIDENCE ${directory}`);
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const base = `http://127.0.0.1:${port}`;
const database = join(directory, "private.sqlite");
const startRequire = createRequire(import.meta.resolve("@tanstack/react-start"));
const clientRequire = createRequire(
  startRequire.resolve("@tanstack/start-client-core/package.json"),
);
const { fromCrossJSON, toCrossJSON } = clientRequire("seroval");
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
const source = files(".output/server")
  .filter((path) => path.endsWith(".mjs"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const ids = Object.fromEntries(
  [...source.matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)].map((m) => [m[2], m[1]]),
);
const fixture = await startModelFixture({ privateDir: join(directory, "model-fixture") });
const env = {
  ...process.env,
  DATABASE_URL: database,
  APP_ORIGIN: base,
  PORT: String(port),
  NITRO_PORT: String(port),
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  SPROUT_PI_ENABLED: "true",
  PI_CODING_AGENT_DIR: fixture.agentDir,
  SPROUT_PI_DATA_DIR: join(directory, "pi"),
  SPROUT_REPO_DIR: join(directory, "repos"),
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
};
delete env.SPROUT_PI_RUNNER;
const fd = openSync(join(directory, "server.log"), "w", 0o600);
const server = spawn(process.execPath, [".output/server/index.mjs"], {
  env,
  stdio: ["ignore", fd, fd],
  detached: true,
});
closeSync(fd);
assert.ok(server.pid, "production server spawned");
const serverPid = server.pid;
const deadline = setTimeout(() => {
  process.kill(-serverPid, "SIGKILL");
  process.exitCode = 1;
}, 180000);
let browser;
let page;
const errors = [];
let db;
let cookie = "";
let humanId;
const checks = [];
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
async function until(check, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
async function callResult(name, data, session = cookie) {
  assert(ids[name], `missing built server function ${name}`);
  const response = await fetch(`${base}/_serverFn/${ids[name]}`, {
    method: "POST",
    headers: {
      Origin: base,
      Cookie: session,
      "content-type": "application/json",
      "x-tsr-serverfn": "true",
      accept: "application/json",
    },
    body: JSON.stringify({ t: toCrossJSON({ data }), f: 127, m: [] }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(
    response.status,
    200,
    `${name}: HTTP ${response.status} ${await response.clone().text()}`,
  );
  return fromCrossJSON(await response.json(), { refs: new Map() }).result;
}
async function call(name, data) {
  const result = await callResult(name, data);
  assert(result.ok, `${name}: ${JSON.stringify(result)}`);
  return result.data;
}
async function signup() {
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({
      email: `webhook-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Webhook Human",
    }),
  });
  assert.equal(response.status, 200);
  humanId ??= (await response.json()).user.id;
  return response.headers
    .getSetCookie()
    .find((value) => value.includes("session_token="))
    .split(";")[0];
}
try {
  await until(async () => {
    try {
      return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, "production server health");
  cookie = await signup();
  const project = await call("createProjectFn", { name: "Webhook verification" });
  const alpha = await call("createAgentProfileFn", {
    name: "HookAlpha",
    persona: "Reply briefly. Do not use tools.",
    model: fixture.model("chatOwner"),
    effort: "off",
  });
  const beta = await call("createAgentProfileFn", {
    name: "HookBeta",
    persona: "Reply briefly. Do not use tools.",
    model: fixture.model("chatMentioned"),
    effort: "off",
  });
  const foreign = await call("createAgentProfileFn", { name: "OutsideProject", persona: "" });
  for (const agent of [alpha, beta])
    await call("addProjectMemberFn", { projectId: project.id, agentProfileId: agent.id });
  const dm = await call("createDirectChatFn", { projectId: project.id, agentProfileId: alpha.id });
  const group = await call("createGroupChatFn", {
    projectId: project.id,
    title: "Webhook group",
    wakePolicy: "mention_only",
    initialOwner: { kind: "agent", id: alpha.id },
    members: [
      { kind: "human", id: humanId },
      { kind: "agent", id: alpha.id },
      { kind: "agent", id: beta.id },
    ],
  });
  db = new Database(database, { readonly: true });
  db.pragma("busy_timeout = 5000");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [name, ...value] = cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: base }]);
  page = await context.newPage();
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("PAGE ERROR", error.message);
  });
  await page.goto(`${base}/projects/${project.id}/settings`, { waitUntil: "networkidle" });
  const ui = page.getByTestId("webhook-settings");
  const agentSelect = ui.getByRole("combobox", { name: /^Agent/ });
  await ui.waitFor();
  await ui.getByLabel("名称", { exact: true }).fill("Browser hook");
  await ui.getByLabel("目标类型").selectOption("dm_agent");
  await ui.getByLabel("Project Chat").selectOption(dm.chat.id);
  await until(
    async () => (await agentSelect.locator("option").count()) === 2,
    "DM selector filters effective members",
    10000,
  );
  assert(!(await agentSelect.textContent()).includes(beta.name));
  assert(!(await agentSelect.textContent()).includes(foreign.name));
  await agentSelect.selectOption(alpha.id);
  await ui
    .getByLabel("Instruction")
    .fill("WEBHOOK_BROWSER_LIVE: process the external payload, use no tools.");
  await ui.getByRole("button", { name: "保存", exact: true }).click();
  await ui.getByText("Secret 仅显示一次，请立即复制。", { exact: true }).waitFor();
  const secret = await ui.locator("code").first().textContent();
  const rules = await call("listWebhookRulesFn", { projectId: project.id });
  const rule = rules.find((item) => item.name === "Browser hook");
  assert(rule);
  const post = (eventId, payload, token = secret) =>
    fetch(rule.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-sprout-event-id": eventId,
      },
      body: JSON.stringify(payload),
    });
  assert.equal((await post("bad", {}, "bad")).status, 401);
  fixture.arm("chatOwner", { expectedUserPrefix: "{", steps: [], reply: "WEBHOOK_BROWSER_RESULT" });
  const received = await post("browser-live", { build: 1, targetChatId: "cannot-retarget" });
  assert.equal(received.status, 200);
  const receipt = await received.json();
  assert.equal(receipt.decision, "accepted");
  await until(
    () =>
      db
        .prepare(
          "SELECT 1 FROM agent_run_input x JOIN agent_run r ON r.id=x.run_id WHERE x.message_id=? AND r.status='completed'",
        )
        .get(receipt.messageId),
    "real Pi runner completes webhook turn",
  );
  const message = db.prepare("SELECT * FROM message WHERE id=?").get(receipt.messageId);
  assert.equal(message.sender_kind, "automation");
  assert.equal(message.chat_id, dm.chat.id);
  assert(message.body.includes("WEBHOOK_BROWSER_LIVE"));
  assert(message.body.includes("cannot-retarget"));
  const replay = await post("browser-live", { targetChatId: "cannot-retarget", build: 1 });
  assert.deepEqual(await replay.json(), receipt);
  assert.equal((await post("browser-live", { build: 2 })).status, 409);
  pass("browser-create-authenticated-http-source-message-real-run-result-dedup");
  await ui.getByRole("button", { name: "Browser hook · 启用", exact: true }).click();
  await ui.getByText("browser-live", { exact: false }).first().waitFor();
  assert.equal(await ui.getByText("Secret 仅显示一次，请立即复制。", { exact: true }).count(), 0);
  fixture.arm("chatOwner", { expectedUserPrefix: "{", steps: [], reply: "WEBHOOK_TRIAL_RESULT" });
  await ui.getByRole("button", { name: "提交真实 Trial", exact: true }).click();
  await until(
    () =>
      db
        .prepare(
          "SELECT 1 FROM webhook_trigger t JOIN agent_run_input x ON x.message_id=t.message_id JOIN agent_run r ON r.id=x.run_id WHERE t.rule_id=? AND t.mode='trial' AND r.status='completed'",
        )
        .get(rule.id),
    "UI trial completed",
  );
  pass("browser-trial-separate-from-live");
  await ui.getByLabel("启用", { exact: true }).uncheck();
  await ui.getByRole("button", { name: "保存", exact: true }).click();
  await ui.getByRole("button", { name: "Browser hook · 停用", exact: true }).waitFor();
  assert.deepEqual((await (await post("disabled", {})).json()).decision, "skipped");
  const foreignCookie = await signup();
  /** @type {Array<[string, Record<string, unknown>]>} */
  const invalidTargets = [
    ["listWebhookRulesFn", { projectId: project.id }],
    ["webhookHistoryFn", { ruleId: rule.id }],
    ["trialWebhookFn", { ruleId: rule.id, eventId: "forbidden", payload: {} }],
    [
      "createWebhookRuleFn",
      {
        projectId: project.id,
        name: "Foreign",
        instruction: "no",
        enabled: true,
        action: rule.action,
      },
    ],
    [
      "updateWebhookRuleFn",
      {
        projectId: project.id,
        name: rule.name,
        instruction: rule.instruction,
        enabled: true,
        action: rule.action,
        ruleId: rule.id,
        expectedRevision: rule.revision,
      },
    ],
  ];
  for (const [fn, input] of invalidTargets) {
    assert.equal(
      (await callResult(fn, input, foreignCookie)).ok,
      false,
      `${fn} must reject foreign Human`,
    );
    assert.equal((await callResult(fn, input, "")).ok, false, `${fn} must require session`);
  }
  pass("real-human-session-management-boundaries");
  const groupRule = await call("createWebhookRuleFn", {
    projectId: project.id,
    name: "Group explicit",
    instruction: "Group event",
    enabled: true,
    action: { kind: "group_agent", chatId: group.id, agentProfileId: beta.id },
  });
  fixture.arm("chatMentioned", {
    expectedUserPrefix: "{",
    steps: [],
    reply: "WEBHOOK_GROUP_RESULT",
  });
  const groupResponse = await fetch(groupRule.rule.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${groupRule.secret}`,
      "content-type": "application/json",
      "x-sprout-event-id": "group-explicit",
    },
    body: "{}",
  });
  const groupReceipt = await groupResponse.json();
  assert.equal(groupReceipt.decision, "accepted");
  await until(
    () =>
      db
        .prepare(
          "SELECT 1 FROM agent_run_input x JOIN agent_run r ON r.id=x.run_id WHERE x.message_id=? AND r.status='completed'",
        )
        .get(groupReceipt.messageId),
    "explicit Group Agent completed",
  );
  const ownerRule = await call("createWebhookRuleFn", {
    projectId: project.id,
    name: "Owner",
    instruction: "Owner event",
    enabled: true,
    action: { kind: "group_owner", chatId: group.id },
  });
  await call("setChatOwnerFn", {
    chatId: group.id,
    owner: { kind: "human", id: humanId },
    expectedRevision: group.governanceRevision,
  });
  const skipped = await call("trialWebhookFn", {
    ruleId: ownerRule.rule.id,
    eventId: "invalid-owner",
    payload: {},
  });
  assert.equal(skipped.decision, "skipped");
  pass("group-explicit-agent-and-invalid-owner-skip");
  const alternate = await call("createWebhookRuleFn", {
    projectId: project.id,
    name: "Race B",
    instruction: "B instruction",
    enabled: false,
    action: { kind: "group_agent", chatId: group.id, agentProfileId: beta.id },
  });
  await page.reload({ waitUntil: "networkidle" });
  await ui.getByRole("button", { name: "Browser hook · 停用", exact: true }).click();
  await ui.getByLabel("Instruction").fill("Saved A instruction");
  const saveGate = Promise.withResolvers();
  const saveReceived = Promise.withResolvers();
  const updateUrl = `**/_serverFn/${ids.updateWebhookRuleFn}`;
  await page.route(updateUrl, async (route) => {
    const response = await route.fetch();
    saveReceived.resolve(undefined);
    await saveGate.promise;
    await route.fulfill({ response });
  });
  await ui.getByRole("button", { name: "保存", exact: true }).click();
  await saveReceived.promise;
  try {
    assert(
      await ui.getByRole("button", { name: "Race B · 停用", exact: true }).isDisabled(),
      "cannot switch rules while save response is pending",
    );
    assert(
      await ui.getByRole("button", { name: "新建", exact: true }).isDisabled(),
      "cannot start another draft while save response is pending",
    );
    assert(
      await ui.getByRole("button", { name: "保存", exact: true }).isDisabled(),
      "cannot submit a second save while response is pending",
    );
  } finally {
    saveGate.resolve(undefined);
  }
  await until(
    () => ui.getByRole("button", { name: "保存", exact: true }).isEnabled(),
    "saved editor unlocked",
  );
  await page.unroute(updateUrl);
  await ui.getByRole("button", { name: "Race B · 停用", exact: true }).click();
  await ui.getByLabel("名称", { exact: true }).fill("Race B edited");
  await ui.getByRole("button", { name: "保存", exact: true }).click();
  await ui.getByRole("button", { name: "Race B edited · 停用", exact: true }).waitFor();
  const afterRace = await call("listWebhookRulesFn", { projectId: project.id });
  const savedA = afterRace.find((item) => item.id === rule.id);
  const savedB = afterRace.find((item) => item.id === alternate.rule.id);
  assert.equal(savedA.name, "Browser hook");
  assert.equal(savedA.instruction, "Saved A instruction");
  assert.deepEqual(savedA.action, rule.action);
  assert.equal(savedB.name, "Race B edited");
  assert.equal(savedB.instruction, "B instruction");
  assert.deepEqual(savedB.action, alternate.rule.action);
  pass("browser-delayed-save-keeps-rule-identity");
  await ui.getByRole("button", { name: "Browser hook · 停用", exact: true }).click();
  await ui.getByText("disabled", { exact: false }).first().waitFor();
  await page.screenshot({ path: join(directory, "settings-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "mobile page must not overflow horizontally",
  );
  await page.screenshot({ path: join(directory, "settings-mobile.png"), fullPage: true });
  await page.goto(`${base}/projects/${project.id}/chats/${dm.chat.id}`, {
    waitUntil: "networkidle",
  });
  await page.getByText("WEBHOOK_BROWSER_RESULT", { exact: false }).first().waitFor();
  await page.getByText("WEBHOOK_TRIAL_RESULT", { exact: false }).first().waitFor();
  await page.screenshot({ path: join(directory, "source-chat.png"), fullPage: true });
  assert.deepEqual(errors, []);
  fixture.assertHealthy();
  fixture.assertDrained();
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify(
      { mode: "model-fixture", checks, model: fixture.metadata(), paidModelCalls: 0 },
      null,
      2,
    ),
  );
  console.log("PASS webhook production HTTP/browser/real Pi runner; paid-model-calls=0");
} catch (error) {
  if (page) {
    writeFileSync(
      join(directory, "failure.txt"),
      `${error instanceof Error ? error.stack : String(error)}\n${await page.locator("body").innerText()}\n${JSON.stringify(errors)}`,
    );
    await page.screenshot({ path: join(directory, "failure.png"), fullPage: true });
  }
  throw error;
} finally {
  clearTimeout(deadline);
  await browser?.close();
  db?.close();
  if (server.exitCode === null && server.signalCode === null) {
    process.kill(-serverPid, "SIGTERM");
    await Promise.race([
      once(server, "exit"),
      new Promise((done) =>
        setTimeout(() => {
          try {
            process.kill(-serverPid, "SIGKILL");
          } catch {}
          done();
        }, 10000).unref(),
      ),
    ]);
  }
  await fixture.close();
}
