// I-P4b chat 标题：真实 Chromium 验证默认兜底、重命名、恢复默认与跨账号隔离。
// 逐步打印 PASS/FAIL，截图保存到 .verify/i-chat-title/evidence/。
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createProject, waitForChats } from "./ui-navigation.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EVIDENCE = process.env.SPROUT_UI_EVIDENCE_DIR
  ? `${process.env.SPROUT_UI_EVIDENCE_DIR.replace(/\/+$/, "")}/`
  : new URL("../../.verify/i-chat-title/evidence/", import.meta.url).pathname;

const results = [];
const consoleErrors = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}

async function shot(page, name) {
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
}

async function check(name, run) {
  if (results.some((result) => !result.passed)) {
    console.log(`SKIP ${name}: earlier check failed`);
    return;
  }
  try {
    await run();
  } catch (error) {
    record(name, false, `threw ${error.message}`);
  }
}

async function register(page, tag) {
  const stamp = Date.now();
  const email = `${tag}-${stamp}@example.test`;
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="email"]', { timeout: 20000 });
  await page.getByTestId("register-tab").click();
  await page.fill('input[name="name"]', tag);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', `${randomBytes(24).toString("base64url")}aA1!`);
  await page.click('button[type="submit"]');
  await waitForChats(page);
  return email;
}

/** 读列表与详情里的人类可读文案，并同时收集裸 id 用于反证。 */
async function readChats(page) {
  await page.waitForSelector('[data-testid="chat-item"]', { timeout: 20000 });
  return page.$$eval('[data-testid="chat-item"]', (nodes) =>
    nodes.map((node) => ({
      chatId: node.getAttribute("data-chat-id"),
      name: node.querySelector('[data-testid="chat-item-name"]')?.textContent?.trim(),
      subtitle: node.querySelector('[data-testid="chat-item-id"]')?.textContent?.trim(),
      subtitleTitleAttr: node.querySelector('[data-testid="chat-item-id"]')?.getAttribute("title"),
    })),
  );
}

async function messageBodies(page) {
  return page.$$eval('[data-testid="message-body"]', (nodes) =>
    nodes.map((node) => node.textContent),
  );
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
const agentName = `标题 Agent ${stamp}`;
const projectName = `I-P4b 标题验收 ${stamp}`;
const customTitle = "仓库首页架构评审";
const firstMessage = "第一条消息：标题验收";
let projectPath = "";
let agentId = "";
let chatPath = "";
let chatId = "";

await register(page, "i-chat-title");

await check("create_project_and_agent_member", async () => {
  const project = await createProject(page, {
    name: projectName,
    description: "I-P4b 对话标题验收",
  });
  projectPath = project.path;
  await page.click('[data-testid="nav-agents"]');
  await page.waitForURL((url) => url.pathname === "/agents", { timeout: 20000 });
  await page.click('[data-testid="new-agent-trigger"]');
  await page.fill('[data-testid="agent-name-input"]', agentName);
  await page.fill('[data-testid="agent-persona-input"]', "标题验收用的分身");
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
  agentId = ((await page.textContent('[data-testid="agent-detail-id"]')) ?? "").trim();
  await page.goto(`${BASE}${projectPath}/members`, { waitUntil: "domcontentloaded" });
  await page.click('[data-testid="add-member-trigger"]');
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
  record("create_project_and_agent_member", true, `Project ${projectName} 与成员 ${agentName}`);
});

await check("untitled_chat_falls_back_to_agent_name", async () => {
  await page.goto(`${BASE}${projectPath}/chats`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="dm-member-item"]', { timeout: 20000 });
  await page.click(`[data-testid="dm-start"][data-agent-profile-id="${agentId}"]`);
  await page.waitForURL((url) => /\/chats\/cnv_[0-9a-f-]{36}$/.test(url.pathname), {
    timeout: 20000,
  });
  chatPath = new URL(page.url()).pathname;
  chatId = chatPath.split("/").pop() ?? "";
  await page.waitForSelector('[data-testid="chat-title"]', { timeout: 20000 });
  const heading = (await page.textContent('[data-testid="chat-title"]'))?.trim();
  await shot(page, "p4b-chat-title-default");
  // 未命名时标题栏与列表都显示参与分身名，不显示裸 cnv_ / agp_ id。
  const listed = await readChats(page);
  const row = listed.find((entry) => entry.chatId === chatId);
  record(
    "untitled_chat_falls_back_to_agent_name",
    Boolean(heading) &&
      !heading?.startsWith("cnv_") &&
      !heading?.startsWith("agp_") &&
      heading !== chatId &&
      row?.name === heading &&
      row?.subtitle === "DM" &&
      row?.subtitleTitleAttr === chatId,
    `标题栏 ${JSON.stringify(heading)}，列表行 ${JSON.stringify(row)}`,
  );
});

await check("rename_persists_and_shows_in_list_and_heading", async () => {
  await page.click('[data-testid="chat-title-edit"]');
  await page.waitForSelector('[data-testid="chat-title-dialog"]', {
    state: "visible",
    timeout: 20000,
  });
  await page.fill('[data-testid="chat-title-input"]', `  ${customTitle}  `);
  // 弹层走 portal + 进出场动画：等动画结束再截图，否则截到的是未绘制的帧。
  await page.waitForFunction(
    (title) => {
      const dialog = document.querySelector('[data-testid="chat-title-dialog"]');
      const input = document.querySelector('[data-testid="chat-title-input"]');
      return Boolean(dialog) && input instanceof HTMLInputElement && input.value.trim() === title;
    },
    customTitle,
    { timeout: 20000 },
  );
  // 进出场动画 100ms：先让出两帧，再截视口，避免截到透明帧。
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${EVIDENCE}p4b-chat-title-dialog.png` });
  await page.click('[data-testid="chat-title-save"]');
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="chat-title"]')?.textContent?.trim() === expected,
    customTitle,
    { timeout: 20000 },
  );
  const heading = (await page.textContent('[data-testid="chat-title"]'))?.trim();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="chat-title"]', { timeout: 20000 });
  const afterReload = (await page.textContent('[data-testid="chat-title"]'))?.trim();
  const listed = await readChats(page);
  const row = listed.find((entry) => entry.chatId === chatId);
  await shot(page, "p4b-chat-title-renamed");
  record(
    "rename_persists_and_shows_in_list_and_heading",
    heading === customTitle &&
      afterReload === customTitle &&
      row?.name === customTitle &&
      row?.subtitle === agentName,
    `重命名后标题 ${JSON.stringify(heading)}，刷新后 ${JSON.stringify(afterReload)}，列表行 ${JSON.stringify(row)}`,
  );
});

await check("rename_keeps_messages_and_instance", async () => {
  await page.fill('[data-testid="message-input"]', firstMessage);
  await page.click('[data-testid="message-send"]');
  await page.waitForFunction(
    (body) =>
      [...document.querySelectorAll('[data-testid="message-body"]')].some(
        (node) => node.textContent === body,
      ),
    firstMessage,
    { timeout: 20000 },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="message-body"]', { timeout: 20000 });
  const bodies = await messageBodies(page);
  const heading = (await page.textContent('[data-testid="chat-title"]'))?.trim();
  record(
    "rename_keeps_messages_and_instance",
    JSON.stringify(bodies) === JSON.stringify([firstMessage]) && heading === customTitle,
    `消息 ${JSON.stringify(bodies)}，标题 ${JSON.stringify(heading)}`,
  );
});

await check("restore_default_clears_title", async () => {
  await page.click('[data-testid="chat-title-edit"]');
  await page.waitForSelector('[data-testid="chat-title-restore"]', { timeout: 20000 });
  await page.click('[data-testid="chat-title-restore"]');
  await page.waitForFunction(
    (name) => document.querySelector('[data-testid="chat-title"]')?.textContent?.trim() === name,
    agentName,
    { timeout: 20000 },
  );
  const heading = (await page.textContent('[data-testid="chat-title"]'))?.trim();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="chat-title"]', { timeout: 20000 });
  const afterReload = (await page.textContent('[data-testid="chat-title"]'))?.trim();
  const listed = await readChats(page);
  const row = listed.find((entry) => entry.chatId === chatId);
  await shot(page, "p4b-chat-title-restored");
  record(
    "restore_default_clears_title",
    heading === agentName && afterReload === agentName && row?.name === agentName,
    `恢复默认后标题 ${JSON.stringify(heading)}，刷新后 ${JSON.stringify(afterReload)}`,
  );
});

await check("narrow_viewport_keeps_title_and_rename_reachable", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}${chatPath}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="chat-title"]', { timeout: 20000 });
  const heading = (await page.textContent('[data-testid="chat-title"]'))?.trim();
  const box = await page.locator('[data-testid="chat-title-edit"]').boundingBox();
  await page.screenshot({ path: `${EVIDENCE}p4b-chat-title-narrow.png`, fullPage: true });
  record(
    "narrow_viewport_keeps_title_and_rename_reachable",
    heading === agentName && box !== null && box.width >= 44 && box.height >= 44,
    `窄屏标题 ${JSON.stringify(heading)}，重命名入口 ${JSON.stringify(box)}`,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
});

await check("search_still_finds_chat_by_title_and_by_id", async () => {
  await page.goto(`${BASE}${projectPath}/chats`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="chat-item"]', { timeout: 20000 });
  await page.click(`[data-testid="chat-item"][data-chat-id="${chatId}"]`);
  await page.waitForSelector('[data-testid="chat-title-edit"]', { timeout: 20000 });
  await page.click('[data-testid="chat-title-edit"]');
  await page.waitForSelector('[data-testid="chat-title-dialog"]', {
    state: "visible",
    timeout: 20000,
  });
  await page.fill('[data-testid="chat-title-input"]', customTitle);
  await page.click('[data-testid="chat-title-save"]');
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="chat-title"]')?.textContent?.trim() === expected,
    customTitle,
    { timeout: 20000 },
  );
  await page.fill('[data-testid="chat-search"]', "架构评审");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="chat-item"]').length === 1,
    null,
    { timeout: 20000 },
  );
  const byTitle = await page.$$eval('[data-testid="chat-item-name"]', (nodes) =>
    nodes.map((node) => node.textContent?.trim()),
  );
  await page.fill('[data-testid="chat-search"]', chatId);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="chat-item"]').length === 1,
    null,
    { timeout: 20000 },
  );
  record(
    "search_still_finds_chat_by_title_and_by_id",
    JSON.stringify(byTitle) === JSON.stringify([customTitle]),
    `按标题搜索得到 ${JSON.stringify(byTitle)}，按 id 粘贴同样能定位到这条对话`,
  );
});

await check("second_human_cannot_see_or_rename_the_chat", async () => {
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  try {
    const email = await register(otherPage, "i-chat-title-other");
    await otherPage.goto(`${BASE}${chatPath}`, { waitUntil: "domcontentloaded" });
    // 他人的 Project 在父级 loader 就被拒，子级 chat loader 不会被调用；
    // 两个错误测试位任一出现都说明越权被挡住。
    await otherPage.waitForSelector('[data-testid="project-error"], [data-testid="chat-error"]', {
      timeout: 20000,
    });
    const meta = (
      await otherPage.textContent(
        '[data-testid="project-error-meta"], [data-testid="chat-error-meta"]',
      )
    )?.trim();
    const body = await otherPage.evaluate(() => document.body.innerText);
    await otherPage.screenshot({
      path: `${EVIDENCE}p4b-chat-title-cross-user.png`,
      fullPage: true,
    });
    record(
      "second_human_cannot_see_or_rename_the_chat",
      /not_found/.test(meta ?? "") &&
        /req_[0-9a-f-]{36}/.test(meta ?? "") &&
        !body.includes(agentName) &&
        !body.includes(customTitle),
      `第二账号 ${email} 直连对话得到 ${JSON.stringify(meta)}，页面未出现该对话的分身名或标题`,
    );
  } finally {
    await other.close();
  }
});

record(
  "no_console_errors",
  consoleErrors.length === 0,
  consoleErrors.length === 0 ? "无 console.error 与未捕获异常" : consoleErrors.join(" | "),
);

writeFileSync(
  `${EVIDENCE}results.json`,
  JSON.stringify({ baseUrl: BASE, projectPath, chatPath, chatId, results }, null, 2) + "\n",
);

await browser.close();
const failed = results.filter((result) => !result.passed);
console.log(`browser checks: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
