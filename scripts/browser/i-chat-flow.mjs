// 真实 Chromium 走完 P2 的 DM 建立、消息持久、人设编辑与分身身份，每步打印 PASS/FAIL。
// CHAT_VERIFY=1 时进入第二次会话模式：读取状态文件，用于服务重启后的持久性断言。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createProject, waitForChats } from "./ui-navigation.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EVIDENCE = new URL("../../docs/p1/evidence/", import.meta.url).pathname;
const STATE_FILE = process.env.CHAT_STATE_FILE ?? "/tmp/p2-c-chat-state.json";

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

async function verifyRestartedSession() {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: state.storage });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(`${BASE}${state.chatPath}`, { waitUntil: "domcontentloaded" });

  await check("restart_chat_renders_same_instance", async () => {
    await page.waitForSelector('[data-testid="chat-instance-id"]', { timeout: 20000 });
    const actual = await page.evaluate(() => ({
      chatId: document.querySelector('[data-testid="chat-id"]')?.textContent,
      instanceId: document.querySelector('[data-testid="chat-instance-id"]')?.textContent,
      persona: document.querySelector('[data-testid="chat-agent-persona"]')?.textContent,
      agentName: document.querySelector('[data-testid="chat-agent-name"]')?.textContent,
    }));
    record(
      "restart_chat_renders_same_instance",
      actual.chatId === state.chatId &&
        actual.instanceId === state.instanceId &&
        actual.persona === state.persona &&
        actual.agentName === state.agentName,
      `重启后 ${JSON.stringify(actual)}`,
    );
  });

  await check("restart_messages_retained_in_order", async () => {
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20000 });
    const bodies = await page.$$eval('[data-testid="message-body"]', (nodes) =>
      nodes.map((node) => node.textContent),
    );
    const kinds = await page.$$eval('[data-testid="message-item"]', (nodes) =>
      nodes.map((node) => node.getAttribute("data-sender-kind")),
    );
    await shot(page, "p2-i-chat-after-restart");
    record(
      "restart_messages_retained_in_order",
      JSON.stringify(bodies) === JSON.stringify(state.messages) &&
        JSON.stringify(kinds) === JSON.stringify(["human", "human"]),
      `重启后消息 ${JSON.stringify(bodies)}，sender ${JSON.stringify(kinds)}`,
    );
  });

  await check("restart_list_shows_single_chat", async () => {
    await page.goto(`${BASE}${state.projectPath}/chats`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="dm-member-list"]', { timeout: 20000 });
    const items = await page.$$eval('[data-testid="chat-item"]', (nodes) =>
      nodes.map((node) => node.getAttribute("data-chat-id")),
    );
    record(
      "restart_list_shows_single_chat",
      JSON.stringify(items) === JSON.stringify([state.chatId]),
      `重启后列表 ${JSON.stringify(items)}`,
    );
  });

  record(
    "no_console_errors_restarted_session",
    consoleErrors.length === 0,
    consoleErrors.length === 0 ? "无 console.error 与未捕获异常" : consoleErrors.join(" | "),
  );

  await browser.close();
  process.exit(finish());
}

if (process.env.CHAT_VERIFY === "1") {
  await verifyRestartedSession();
} else {
  mkdirSync(EVIDENCE, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  const stamp = Date.now();
  const email = `i-chat-${stamp}@example.test`;
  const password = "{{SECRET_p2-c-chat-pass}}";
  const projectName = `P2-I 验收 ${stamp}`;
  const agentName = `P2-I Agent ${stamp}`;
  const initialPersona = "初始人设：谨慎的对话对象";
  const updatedPersona = "新人设：编辑后的对话对象";
  const firstMessage = "第一条消息：你好";
  const secondMessage = "第二条消息：确认持久";
  const pathOf = () => new URL(page.url()).pathname;
  let project = {};
  let projectPath = "";
  let agentId = "";
  let chatId = "";
  let chatPath = "";
  let instanceId = "";

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="email"]', { timeout: 20000 });

  await check("register_and_create_project", async () => {
    await page.click("text=没有账号？注册");
    await page.fill('input[name="name"]', "P2-I 验收");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await waitForChats(page);
    project = await createProject(page, { name: projectName, description: "P2 Chat/DM 验收" });
    projectPath = project.path;
    record(
      "register_and_create_project",
      pathOf() === `${projectPath}/chats`,
      `注册登录并创建 ${projectName}，落到 ${pathOf()}`,
    );
  });

  await check("create_agent_profile_and_member", async () => {
    await page.click('[data-testid="nav-agents"]');
    await page.waitForURL((url) => url.pathname === "/agents", { timeout: 20000 });
    await page.click('[data-testid="new-agent-trigger"]');
    await page.fill('[data-testid="agent-name-input"]', agentName);
    await page.fill('[data-testid="agent-persona-input"]', initialPersona);
    await page.click('[data-testid="agent-submit"]');
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('[data-testid="agent-item-name"]')].some(
          (node) => node.textContent === name,
        ),
      agentName,
      { timeout: 20000 },
    );
    await page.click(`[data-testid="agent-item-name"] >> text=${agentName}`);
    await page.waitForSelector('[data-testid="agent-detail-id"]', { timeout: 20000 });
    agentId = (await page.textContent('[data-testid="agent-detail-id"]')) ?? "";
    await page.goto(`${BASE}${projectPath}/members`, { waitUntil: "domcontentloaded" });
    // 默认 Agent 已是成员，等新 profile 出现在可选列表。
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('[data-testid="add-member-select"] option')].some(
          (option) => option.textContent === name,
        ),
      agentName,
      { timeout: 20000 },
    );
    await page.selectOption('[data-testid="add-member-select"]', { label: agentName });
    await page.click('[data-testid="add-member-submit"]');
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('[data-testid="member-item-name"]')].some(
          (node) => node.textContent === name,
        ),
      agentName,
      { timeout: 20000 },
    );
    record(
      "create_agent_profile_and_member",
      /^agp_[0-9a-f-]{36}$/.test(agentId),
      `profile ${agentId} 已加入 Project 成员`,
    );
  });

  await check("start_dm_navigates_to_chat", async () => {
    await page.goto(`${BASE}${projectPath}/chats`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="dm-member-item"]', { timeout: 20000 });
    // 成员里还有默认 Agent，按本次新建的 profile id 点它的「发起对话」。
    await page.click(`[data-testid="dm-start"][data-agent-profile-id="${agentId}"]`);
    await page.waitForURL((url) => /\/chats\/cnv_[0-9a-f-]{36}$/.test(url.pathname), {
      timeout: 20000,
    });
    await page.waitForSelector('[data-testid="chat-instance-id"]', { timeout: 20000 });
    chatPath = pathOf();
    chatId = chatPath.split("/").pop() ?? "";
    instanceId = (await page.textContent('[data-testid="chat-instance-id"]')) ?? "";
    const agentShown = await page.textContent('[data-testid="chat-agent-name"]');
    await shot(page, "p2-i-chat-started");
    record(
      "start_dm_navigates_to_chat",
      /^cnv_[0-9a-f-]{36}$/.test(chatId) &&
        /^ins_[0-9a-f-]{36}$/.test(instanceId) &&
        agentShown?.trim() === agentName,
      `URL ${chatPath}，instance ${instanceId}，Agent ${JSON.stringify(agentShown?.trim())}`,
    );
  });

  await check("send_two_messages_survive_reload_in_order", async () => {
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
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20000 });
    const bodies = await page.$$eval('[data-testid="message-body"]', (nodes) =>
      nodes.map((node) => node.textContent),
    );
    const kinds = await page.$$eval('[data-testid="message-item"]', (nodes) =>
      nodes.map((node) => node.getAttribute("data-sender-kind")),
    );
    const afterReloadInstance = await page.textContent('[data-testid="chat-instance-id"]');
    await shot(page, "p2-i-chat-messages");
    record(
      "send_two_messages_survive_reload_in_order",
      JSON.stringify(bodies) === JSON.stringify([firstMessage, secondMessage]) &&
        JSON.stringify(kinds) === JSON.stringify(["human", "human"]) &&
        afterReloadInstance?.trim() === instanceId,
      `刷新后消息 ${JSON.stringify(bodies)}，sender ${JSON.stringify(kinds)}`,
    );
  });

  await check("persona_edit_keeps_instance_and_history", async () => {
    await page.goto(`${BASE}/agents/${agentId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="agent-edit-persona"]', { timeout: 20000 });
    await page.fill('[data-testid="agent-edit-persona"]', updatedPersona);
    await page.click('[data-testid="agent-edit-save"]');
    await page.waitForSelector('[data-testid="agent-edit-saved"]', { timeout: 20000 });
    await page.goto(`${BASE}${chatPath}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="chat-instance-id"]', { timeout: 20000 });
    const state = await page.evaluate(() => ({
      instanceId: document.querySelector('[data-testid="chat-instance-id"]')?.textContent,
      persona: document.querySelector('[data-testid="chat-agent-persona"]')?.textContent,
      bodies: [...document.querySelectorAll('[data-testid="message-body"]')].map(
        (node) => node.textContent,
      ),
    }));
    await shot(page, "p2-i-chat-after-persona-edit");
    record(
      "persona_edit_keeps_instance_and_history",
      state.instanceId?.trim() === instanceId &&
        state.persona === updatedPersona &&
        JSON.stringify(state.bodies) === JSON.stringify([firstMessage, secondMessage]),
      `instance ${state.instanceId?.trim()} 未变，人设 ${JSON.stringify(state.persona)}，消息 ${state.bodies?.length} 条`,
    );
  });

  await check("repeat_start_opens_same_chat", async () => {
    await page.goto(`${BASE}${projectPath}/chats`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="chat-item"]', { timeout: 20000 });
    const items = await page.$$eval('[data-testid="chat-item"]', (nodes) =>
      nodes.map((node) => node.getAttribute("data-chat-id")),
    );
    await page.click(`[data-testid="dm-start"][data-agent-profile-id="${agentId}"]`);
    await page.waitForURL((url) => url.pathname === chatPath, { timeout: 20000 });
    await shot(page, "p2-i-chats-list");
    record(
      "repeat_start_opens_same_chat",
      JSON.stringify(items) === JSON.stringify([chatId]) && pathOf() === chatPath,
      `列表 ${JSON.stringify(items)}，再次发起后 URL ${pathOf()}`,
    );
  });

  await check("deep_link_chat_renders", async () => {
    await page.goto(`${BASE}${chatPath}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="chat-instance-id"]', { timeout: 20000 });
    const id = await page.textContent('[data-testid="chat-id"]');
    record("deep_link_chat_renders", id?.trim() === chatId, `深链直达对话页 ${chatPath}`);
  });

  await check("missing_chat_shows_not_found", async () => {
    await page.goto(`${BASE}${projectPath}/chats/cnv_00000000-0000-4000-8000-000000000000`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector('[data-testid="chat-error"]', { timeout: 20000 });
    const meta = await page.textContent('[data-testid="chat-error-meta"]');
    await shot(page, "p2-i-chat-not-found");
    record(
      "missing_chat_shows_not_found",
      /not_found/.test(meta ?? "") && /req_[0-9a-f-]{36}/.test(meta ?? ""),
      `不存在的 chatId 显示 ${JSON.stringify(meta)}`,
    );
  });

  record(
    "no_console_errors",
    consoleErrors.length === 0,
    consoleErrors.length === 0 ? "无 console.error 与未捕获异常" : consoleErrors.join(" | "),
  );

  const storage = await context.storageState();
  const failed = results.filter((result) => !result.passed);
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
        agentProfileId: agentId,
        agentName,
        persona: updatedPersona,
        messages: [firstMessage, secondMessage],
        storage,
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  console.log(
    `browser checks: ${results.length - failed.length}/${results.length} passed; state ${STATE_FILE}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}
