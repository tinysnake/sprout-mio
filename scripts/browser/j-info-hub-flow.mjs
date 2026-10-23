// 真实 Chromium 走完 Info Hub 的 Project → Agents 视角与 Chat → 自身与成员视角，
// 断言 run 视角渲染为真实运行事实、Machine（P4）视角仍为显式不可用文案，每步打印 PASS/FAIL。
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  chatInspectorPath,
  createProject,
  navigate,
  openProjectInfoHub,
  waitForChats,
} from "./ui-navigation.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EVIDENCE = process.env.SPROUT_UI_EVIDENCE_DIR
  ? `${process.env.SPROUT_UI_EVIDENCE_DIR.replace(/\/+$/, "")}/`
  : new URL("../../.verify/j-info-hub/evidence/", import.meta.url).pathname;
const STATE_FILE = process.env.INFO_HUB_STATE_FILE ?? "/tmp/p2-d-info-hub-state.json";

const results = [];
const consoleErrors = [];

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}

async function check(name, fn) {
  if (
    results.some(
      (result) =>
        !result.passed &&
        [
          "register_sets_session",
          "register_and_create_project",
          "create_project_switches_to_new_chats",
        ].includes(result.name),
    )
  ) {
    console.log(`SKIP ${name}: setup failed`);
    return;
  }
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
const password = "test-pass-p2-d-info-hub";
const projectName = `P2-J 验收 ${stamp}`;
const joinedName = `P2-J Agent ${stamp}`;
const outsiderName = `P2-J Outsider ${stamp}`;
const joinedPersona = "已加入的分身人设：负责这个 Project 的验收";
const firstMessage = "第一条消息：Info Hub 验收";
const secondMessage = "第二条消息：消息统计取我";
const pathOf = () => new URL(page.url()).pathname;
let project = {};
let projectPath = "";
let chatPath = "";
let chatId = "";
let instanceId = "";
let joinedId = "";

async function createProfile(name, persona) {
  await page.click('[data-testid="new-agent-trigger"]');
  await page.fill('[data-testid="agent-name-input"]', name);
  await page.fill('[data-testid="agent-persona-input"]', persona);
  await page.click('[data-testid="agent-submit"]');
  // 注册已播种一个默认 profile，等本次新建的出现在列表里。
  await page.waitForFunction(
    (target) =>
      [...document.querySelectorAll('[data-testid="agent-item-name"]')].some(
        (node) => node.textContent === target,
      ),
    name,
    { timeout: 20000 },
  );
  await page.click(`[data-testid="agent-item-name"] >> text=${name}`);
  await page.waitForSelector('[data-testid="agent-detail-id"]', { timeout: 20000 });
  const id = (await page.textContent('[data-testid="agent-detail-id"]'))?.trim() ?? "";
  await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="new-agent-trigger"]', { timeout: 20000 });
  return id;
}

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[name="email"]', { timeout: 20000 });

await check("register_and_create_project", async () => {
  await page.getByTestId("register-tab").click();
  await page.fill('input[name="name"]', "P2-J 验收");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await waitForChats(page);
  project = await createProject(page, { name: projectName, description: "P2 Info Hub 验收" });
  projectPath = project.path;
  record(
    "register_and_create_project",
    pathOf() === `${projectPath}/chats`,
    `注册登录并创建 ${projectName}，落到 ${pathOf()}`,
  );
});

await check("create_two_profiles_join_one", async () => {
  await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="new-agent-trigger"]', { timeout: 20000 });
  await createProfile(joinedName, joinedPersona);
  const outsiderId = await createProfile(
    outsiderName,
    "未加入的分身人设：不应出现在 Info Hub 聚合里",
  );
  await page.goto(`${BASE}${projectPath}/members`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="add-member-trigger"]', { timeout: 20000 });
  await page.click('[data-testid="add-member-trigger"]');
  await page.waitForSelector('[data-testid="add-member-select"]', { timeout: 20000 });
  await page.selectOption('[data-testid="add-member-select"]', { label: joinedName });
  await page.click('[data-testid="add-member-submit"]');
  // 注册播种的默认 Agent 已是成员，等本次加入的那个出现即可。
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[data-testid="member-item-name"]')].some(
        (node) => node.textContent?.trim() === name,
      ),
    joinedName,
    { timeout: 20000 },
  );
  const members = await page.$$eval('[data-testid="member-item"]', (nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute("data-agent-profile-id"),
      name: node.querySelector('[data-testid="member-item-name"]')?.textContent?.trim(),
    })),
  );
  joinedId = members.find((member) => member.name === joinedName)?.id ?? "";
  record(
    "create_two_profiles_join_one",
    Boolean(joinedId) &&
      !members.some((member) => member.id === outsiderId) &&
      /^agp_[0-9a-f-]{36}$/.test(outsiderId),
    `成员 ${JSON.stringify(members)}，${outsiderName}（${outsiderId}）未加入`,
  );
});

await check("start_dm_and_send_two_messages", async () => {
  await page.goto(`${BASE}${projectPath}/chats`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="dm-member-item"]', { timeout: 20000 });
  // 成员里还有默认 Agent，按本次加入的 profile id 点它的「发起对话」。
  await page.click(`[data-testid="dm-start"][data-agent-profile-id="${joinedId}"]`);
  await page.waitForURL((url) => /\/chats\/cnv_[0-9a-f-]{36}$/.test(url.pathname), {
    timeout: 20000,
  });
  chatPath = pathOf();
  chatId = chatPath.split("/").pop() ?? "";
  // 身份事实只在 Info Hub 里展示，打开 `?info=1` 后从 inspector 读取同一份 Instance。
  await navigate(page, chatInspectorPath(chatPath));
  await page.waitForSelector('[data-testid="info-chat-instance-id"]', { timeout: 20000 });
  instanceId = (await page.textContent('[data-testid="info-chat-instance-id"]'))?.trim() ?? "";
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
    /^cnv_[0-9a-f-]{36}$/.test(chatId) && /^ins_[0-9a-f-]{36}$/.test(instanceId),
    `对话 ${chatId}，分身 ${instanceId}，两条消息已保存`,
  );
});

await check("hub_agents_panel_lists_only_member_with_dm_link", async () => {
  await page.goto(`${BASE}${projectPath}/settings`, { waitUntil: "domcontentloaded" });
  await openProjectInfoHub(page);
  const panel = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="info-hub-project-agents"]');
    // 面板里可能有多位成员，按名字定位本次加入的那一项再取它的人设。
    const items = [...document.querySelectorAll('[data-testid="info-agent-item"]')];
    return {
      text: root?.textContent ?? "",
      names: [...document.querySelectorAll('[data-testid="info-agent-name"]')].map((node) =>
        node.textContent?.trim(),
      ),
      dmLink: document.querySelector('[data-testid="info-agent-dm-link"]')?.getAttribute("href"),
      dmChatId: document
        .querySelector('[data-testid="info-agent-dm-link"]')
        ?.getAttribute("data-chat-id"),
      people: items.map((item) => ({
        name: item.querySelector('[data-testid="info-agent-name"]')?.textContent?.trim(),
        persona: item.querySelector('[data-testid="info-agent-persona-summary"]')?.textContent,
        dmChatId: item
          .querySelector('[data-testid="info-agent-dm-link"]')
          ?.getAttribute("data-chat-id"),
      })),
    };
  });
  await shot(page, "p2-j-info-hub-project-agents");
  const joined = panel.people.find((person) => person.name === joinedName);
  record(
    "hub_agents_panel_lists_only_member_with_dm_link",
    // 面板列出 Project 成员（含播种的默认 Agent），但不含未加入的那个。
    panel.names.includes(joinedName) &&
      !panel.names.includes(outsiderName) &&
      !panel.text.includes(outsiderName) &&
      joined?.dmChatId === chatId &&
      joined?.persona === joinedPersona,
    `面板成员 ${JSON.stringify(panel.names)}，不含 ${outsiderName}，${joinedName} 的 DM 链接 ${joined?.dmChatId}`,
  );
});

await check("unavailable_notices_render_explicitly", async () => {
  await openProjectInfoHub(page);
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
      /排队中|运行中/.test(notices.runsActive ?? "") &&
      (notices.runsActive ?? "").includes("未投递") &&
      !notices.body.includes("0 个活动 run") &&
      !notices.body.includes("无活动 run") &&
      !notices.body.includes("无 Machine"),
    `runs 视角为真实运行事实（宿主 ${notices.runsHostStatus}），machines 仍为未实现；reason ${JSON.stringify(notices.machinesReason)}`,
  );
});

await check("hub_dm_link_opens_chat", async () => {
  await page.click('[data-testid="info-agent-dm-link"]');
  await page.waitForURL((url) => url.pathname === chatPath, { timeout: 20000 });
  // Chat 视角的 Info Hub 在 inspector 里，打开它才能断言面板；URL 只多了恢复用的浏览参数。
  await navigate(page, chatInspectorPath(chatPath));
  await page.waitForSelector('[data-testid="info-hub-chat"]', { timeout: 20000 });
  record("hub_dm_link_opens_chat", pathOf() === chatPath, `面板 DM 链接跳转到 ${pathOf()}`);
});

await check("chat_info_panel_matches_page", async () => {
  await page.waitForSelector('[data-testid="info-chat-instance-id"]', { timeout: 20000 });
  const state = await page.evaluate(() => ({
    panelInstance: document
      .querySelector('[data-testid="info-chat-instance-id"]')
      ?.textContent?.trim(),
    pageInstance: document
      .querySelector('[data-testid="inspector-instance-id"]')
      ?.textContent?.trim(),
    kinds: [...document.querySelectorAll('[data-testid="info-member-item"]')].map((node) =>
      node.getAttribute("data-member-kind"),
    ),
    kind: document.querySelector('[data-testid="info-chat-kind"]')?.textContent?.trim(),
    archived: document.querySelector('[data-testid="info-chat-archived"]')?.textContent?.trim(),
    count: document.querySelector('[data-testid="info-message-count"]')?.textContent?.trim(),
    latestAt: document.querySelector('[data-testid="info-message-latest-at"]')?.textContent,
    runsHostStatus: document.querySelector('[data-testid="info-chat-runs-host-status"]')
      ?.textContent,
    turnInjection: document.querySelector('[data-testid="info-turn-prompt-injection"]')
      ?.textContent,
    body: document.body.innerText,
  }));
  await shot(page, "p2-j-chat-info");
  record(
    "chat_info_panel_matches_page",
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
    `panel 分身 ${state.panelInstance} 与 inspector 身份一致，成员 ${JSON.stringify(state.kinds)}，消息 ${state.count} 条，run 视角宿主 ${state.runsHostStatus}`,
  );
});

await check("deep_link_and_reload_keep_values", async () => {
  await page.goto(`${BASE}${projectPath}/settings`, { waitUntil: "domcontentloaded" });
  await openProjectInfoHub(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openProjectInfoHub(page);
  const hubReload = await page.evaluate(() => ({
    names: [...document.querySelectorAll('[data-testid="info-agent-name"]')].map((node) =>
      node.textContent?.trim(),
    ),
    dmChatId: document
      .querySelector('[data-testid="info-agent-dm-link"]')
      ?.getAttribute("data-chat-id"),
  }));
  await shot(page, "p2-j-info-hub-deep-reload");
  await navigate(page, chatInspectorPath(chatPath));
  await page.waitForSelector('[data-testid="info-hub-chat"]', { timeout: 20000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="info-hub-chat"]', { timeout: 20000 });
  const chatReload = await page.evaluate(() => ({
    panelInstance: document
      .querySelector('[data-testid="info-chat-instance-id"]')
      ?.textContent?.trim(),
    count: document.querySelector('[data-testid="info-message-count"]')?.textContent?.trim(),
  }));
  record(
    "deep_link_and_reload_keep_values",
    hubReload.names.includes(joinedName) &&
      hubReload.dmChatId === chatId &&
      chatReload.panelInstance === instanceId &&
      chatReload.count === "2",
    `深链刷新后 hub ${JSON.stringify(hubReload)}，对话页 ${JSON.stringify(chatReload)}`,
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
      projectId: project.id,
      projectPath,
      chatPath,
      chatId,
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
