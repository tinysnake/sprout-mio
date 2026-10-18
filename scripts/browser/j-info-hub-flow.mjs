// 真实 Chromium 走完 Info Hub 的 Project → Agents 视角与 Conversation → 自身与成员视角，
// 断言 run 视角渲染为真实运行事实、Machine（P4）视角仍为显式不可用文案，每步打印 PASS/FAIL。
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EVIDENCE = new URL("../../docs/p1/evidence/", import.meta.url).pathname;
const STATE_FILE = process.env.INFO_HUB_STATE_FILE ?? "/tmp/p2-d-info-hub-state.json";

const results = [];
const consoleErrors = [];

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}

async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    record(name, false, `threw ${error.message}`);
  }
}

async function shot(page, name) {
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  console.log(`browser checks: ${results.length - failed.length}/${results.length} passed`);
  return failed.length === 0 ? 0 : 1;
}

mkdirSync(EVIDENCE, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

const stamp = Date.now();
const email = `j-info-hub-${stamp}@example.test`;
const password = "{{SECRET_p2-d-info-hub-pass}}";
const projectName = `P2-J 验收 ${stamp}`;
const joinedName = `P2-J Agent ${stamp}`;
const outsiderName = `P2-J Outsider ${stamp}`;
const joinedPersona = "已加入的分身人设：负责这个 Project 的验收";
const firstMessage = "第一条消息：Info Hub 验收";
const secondMessage = "第二条消息：消息统计取我";
const pathOf = () => new URL(page.url()).pathname;
let projectPath = "";
let conversationPath = "";
let conversationId = "";
let instanceId = "";

async function createProfile(name, persona) {
  await page.click('[data-testid="new-agent-trigger"]');
  await page.fill('[data-testid="agent-name-input"]', name);
  await page.fill('[data-testid="agent-persona-input"]', persona);
  await page.click('[data-testid="agent-submit"]');
  await page.waitForSelector('[data-testid="agent-item"]', { timeout: 20000 });
}

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[name="email"]', { timeout: 20000 });

await check("register_and_create_project", async () => {
  await page.click("text=没有账号？注册");
  await page.fill('input[name="name"]', "P2-J 验收");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.pathname === "/", { timeout: 20000 });
  await page.click('[data-testid="open-projects"]');
  await page.waitForURL((url) => url.pathname === "/projects", { timeout: 20000 });
  await page.click('[data-testid="new-project-trigger"]');
  await page.fill('[data-testid="project-name-input"]', projectName);
  await page.fill('[data-testid="project-description-input"]', "P2 Info Hub 验收");
  await page.click('[data-testid="project-submit"]');
  await page.waitForSelector('[data-testid="project-item"]', { timeout: 20000 });
  await page.click('[data-testid="project-item-name"]');
  await page.waitForSelector('[data-testid="project-detail-name"]', { timeout: 20000 });
  projectPath = pathOf();
  record("register_and_create_project", true, `注册登录并创建 ${projectName}，hub ${projectPath}`);
});

await check("create_two_profiles_join_one", async () => {
  await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="new-agent-trigger"]', { timeout: 20000 });
  await createProfile(joinedName, joinedPersona);
  await createProfile(outsiderName, "未加入的分身人设：不应出现在 Info Hub 聚合里");
  await page.goto(`${BASE}${projectPath}/agents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="add-member-select"]', { timeout: 20000 });
  await page.selectOption('[data-testid="add-member-select"]', { label: joinedName });
  await page.click('[data-testid="add-member-submit"]');
  await page.waitForSelector('[data-testid="member-item"]', { timeout: 20000 });
  const members = await page.$$eval('[data-testid="member-item-name"]', (nodes) =>
    nodes.map((node) => node.textContent?.trim()),
  );
  record(
    "create_two_profiles_join_one",
    JSON.stringify(members) === JSON.stringify([joinedName]),
    `成员列表 ${JSON.stringify(members)}，${outsiderName} 未加入`,
  );
});

await check("start_dm_and_send_two_messages", async () => {
  await page.goto(`${BASE}${projectPath}/conversations`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="dm-start"]', { timeout: 20000 });
  await page.click('[data-testid="dm-start"]');
  await page.waitForURL((url) => /\/conversations\/cnv_[0-9a-f-]{36}$/.test(url.pathname), {
    timeout: 20000,
  });
  conversationPath = pathOf();
  conversationId = conversationPath.split("/").pop() ?? "";
  instanceId = (await page.textContent('[data-testid="conversation-instance-id"]'))?.trim() ?? "";
  await page.fill('[data-testid="message-input"]', firstMessage);
  await page.click('[data-testid="message-send"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="message-item"]').length === 1,
    null,
    { timeout: 20000 },
  );
  await page.fill('[data-testid="message-input"]', secondMessage);
  await page.click('[data-testid="message-send"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="message-item"]').length === 2,
    null,
    { timeout: 20000 },
  );
  record(
    "start_dm_and_send_two_messages",
    /^cnv_[0-9a-f-]{36}$/.test(conversationId) && /^ins_[0-9a-f-]{36}$/.test(instanceId),
    `对话 ${conversationId}，分身 ${instanceId}，两条消息已保存`,
  );
});

await check("hub_agents_panel_lists_only_member_with_dm_link", async () => {
  await page.goto(`${BASE}${projectPath}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="info-hub-project-agents"]', { timeout: 20000 });
  const panel = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="info-hub-project-agents"]');
    return {
      text: root?.textContent ?? "",
      names: [...document.querySelectorAll('[data-testid="info-agent-name"]')].map((node) =>
        node.textContent?.trim(),
      ),
      dmLink: document.querySelector('[data-testid="info-agent-dm-link"]')?.getAttribute("href"),
      dmConversationId: document
        .querySelector('[data-testid="info-agent-dm-link"]')
        ?.getAttribute("data-conversation-id"),
      persona: document.querySelector('[data-testid="info-agent-persona-summary"]')?.textContent,
    };
  });
  await shot(page, "p2-j-info-hub-project-agents");
  record(
    "hub_agents_panel_lists_only_member_with_dm_link",
    JSON.stringify(panel.names) === JSON.stringify([joinedName]) &&
      !panel.text.includes(outsiderName) &&
      panel.dmConversationId === conversationId &&
      panel.persona === joinedPersona,
    `面板成员 ${JSON.stringify(panel.names)}，不含 ${outsiderName}，DM 链接 ${panel.dmConversationId}`,
  );
});

await check("unavailable_notices_render_explicitly", async () => {
  const notices = await page.evaluate(() => ({
    machinesReason: document.querySelector('[data-testid="info-hub-machines-notice-reason"]')
      ?.textContent,
    runsHostStatus: document.querySelector('[data-testid="info-hub-project-runs-host-status"]')
      ?.textContent,
    runsActive: document.querySelector('[data-testid="info-hub-project-runs-active"]')?.textContent,
    badges: [...document.querySelectorAll('[data-testid="info-hub-machines-notice-badge"]')].map(
      (node) => node.textContent?.trim(),
    ),
    body: document.body.innerText,
  }));
  record(
    "unavailable_notices_render_explicitly",
    /P4/.test(notices.machinesReason ?? "") &&
      notices.badges.length === 1 &&
      notices.badges[0] === "未实现" &&
      /宿主(已|未)启用/.test(notices.runsHostStatus ?? "") &&
      (notices.runsActive ?? "").includes("没有排队中或运行中的 run") &&
      !notices.body.includes("0 个活动 run") &&
      !notices.body.includes("无活动 run") &&
      !notices.body.includes("无 Machine"),
    `runs 视角为真实运行事实（宿主 ${notices.runsHostStatus}），machines 仍为未实现；reason ${JSON.stringify(notices.machinesReason)}`,
  );
});

await check("hub_dm_link_opens_conversation", async () => {
  await page.click('[data-testid="info-agent-dm-link"]');
  await page.waitForURL((url) => url.pathname === conversationPath, { timeout: 20000 });
  await page.waitForSelector('[data-testid="info-hub-conversation"]', { timeout: 20000 });
  record(
    "hub_dm_link_opens_conversation",
    pathOf() === conversationPath,
    `面板 DM 链接跳转到 ${pathOf()}`,
  );
});

await check("conversation_info_panel_matches_page", async () => {
  await page.waitForSelector('[data-testid="conversation-instance-id"]', { timeout: 20000 });
  const state = await page.evaluate(() => ({
    panelInstance: document
      .querySelector('[data-testid="info-conversation-instance-id"]')
      ?.textContent?.trim(),
    pageInstance: document
      .querySelector('[data-testid="conversation-instance-id"]')
      ?.textContent?.trim(),
    kinds: [...document.querySelectorAll('[data-testid="info-member-item"]')].map((node) =>
      node.getAttribute("data-member-kind"),
    ),
    kind: document.querySelector('[data-testid="info-conversation-kind"]')?.textContent?.trim(),
    archived: document
      .querySelector('[data-testid="info-conversation-archived"]')
      ?.textContent?.trim(),
    count: document.querySelector('[data-testid="info-message-count"]')?.textContent?.trim(),
    latestAt: document.querySelector('[data-testid="info-message-latest-at"]')?.textContent,
    runsHostStatus: document.querySelector('[data-testid="info-conversation-runs-host-status"]')
      ?.textContent,
    turnInjection: document.querySelector('[data-testid="info-turn-prompt-injection"]')
      ?.textContent,
    body: document.body.innerText,
  }));
  await shot(page, "p2-j-conversation-info");
  record(
    "conversation_info_panel_matches_page",
    state.panelInstance === state.pageInstance &&
      state.panelInstance === instanceId &&
      JSON.stringify(state.kinds) === JSON.stringify(["human", "agent"]) &&
      state.kind === "DM（一对一）" &&
      state.archived === "未归档" &&
      state.count === "2" &&
      /^20\d{2}-\d{2}-\d{2}T/.test(state.latestAt ?? "") &&
      /宿主(已|未)启用/.test(state.runsHostStatus ?? "") &&
      /注入模型 prompt：否/.test(state.turnInjection ?? "") &&
      !state.body.includes("0 个活动 run") &&
      !state.body.includes("无活动 run"),
    `panel 分身 ${state.panelInstance} 与页面一致，成员 ${JSON.stringify(state.kinds)}，消息 ${state.count} 条，run 视角宿主 ${state.runsHostStatus}`,
  );
});

await check("deep_link_and_reload_keep_values", async () => {
  await page.goto(`${BASE}${projectPath}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="info-hub-project-agents"]', { timeout: 20000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="info-hub-project-agents"]', { timeout: 20000 });
  const hubReload = await page.evaluate(() => ({
    names: [...document.querySelectorAll('[data-testid="info-agent-name"]')].map((node) =>
      node.textContent?.trim(),
    ),
    dmConversationId: document
      .querySelector('[data-testid="info-agent-dm-link"]')
      ?.getAttribute("data-conversation-id"),
  }));
  await shot(page, "p2-j-info-hub-deep-reload");
  await page.goto(`${BASE}${conversationPath}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="info-hub-conversation"]', { timeout: 20000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="info-hub-conversation"]', { timeout: 20000 });
  const conversationReload = await page.evaluate(() => ({
    panelInstance: document
      .querySelector('[data-testid="info-conversation-instance-id"]')
      ?.textContent?.trim(),
    count: document.querySelector('[data-testid="info-message-count"]')?.textContent?.trim(),
  }));
  record(
    "deep_link_and_reload_keep_values",
    JSON.stringify(hubReload.names) === JSON.stringify([joinedName]) &&
      hubReload.dmConversationId === conversationId &&
      conversationReload.panelInstance === instanceId &&
      conversationReload.count === "2",
    `深链刷新后 hub ${JSON.stringify(hubReload)}，对话页 ${JSON.stringify(conversationReload)}`,
  );
});

record(
  "no_console_errors",
  consoleErrors.length === 0,
  consoleErrors.length === 0 ? "无 console.error 与未捕获异常" : consoleErrors.join(" | "),
);

writeFileSync(
  STATE_FILE,
  JSON.stringify(
    {
      baseUrl: BASE,
      projectId: projectPath.split("/").pop(),
      projectPath,
      conversationPath,
      conversationId,
      instanceId,
      agentName: joinedName,
      outsiderName,
    },
    null,
    2,
  ) + "\n",
);

await browser.close();
console.log(`browser checks state ${STATE_FILE}`);
process.exit(finish());
