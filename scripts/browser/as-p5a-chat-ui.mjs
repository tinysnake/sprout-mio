// P5a 多人 Chat 正式页面：三栏、详情三段、群创建、频道只读、治理可见性与窄屏。
// 业务数据只经真实页面登录与领域 server function 写入，不直接改 SQLite。
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createProject, waitForChats } from "./ui-navigation.mjs";
import { governanceAvailability } from "../../src/components/chat/chat-governance.ts";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EVIDENCE = process.env.SPROUT_UI_EVIDENCE_DIR
  ? `${process.env.SPROUT_UI_EVIDENCE_DIR.replace(/\/+$/, "")}/`
  : new URL("../../.verify/as-p5a-chat-ui/evidence/", import.meta.url).pathname;

const results = [];

function record(id, passed, detail) {
  results.push({ id, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${id} :: ${detail}`);
}

async function shot(page, name) {
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
}

async function register(page, tag) {
  const stamp = Date.now();
  const email = `${tag}-${stamp}@example.test`;
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="email"]', { timeout: 20000 });
  await page.getByTestId("register-tab").click();
  await page.fill('input[name="name"]', "P5a UI 验收");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', `${randomBytes(24).toString("base64url")}aA1!`);
  await page.click('button[type="submit"]');
  await waitForChats(page);
  return email;
}

async function readResults(page, id) {
  return page.$$eval(`[data-testid="${id}"]`, (nodes) =>
    nodes.map((node) => ({
      text: node.textContent?.trim(),
      open: node instanceof HTMLDetailsElement ? node.open : undefined,
    })),
  );
}

mkdirSync(EVIDENCE, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

let projectPath = "";
let agentName = "";
let groupPath = "";
const groupTitle = `P5a 发布协作 ${Date.now()}`;
const message = "群里的第一条 Human 消息";

try {
  const stamp = Date.now();
  agentName = `P5a Agent ${stamp}`;
  await register(page, "as-p5a-chat");
  record("browser_session_registered", true, "注册并进入默认 Chats");

  const project = await createProject(page, {
    name: `P5a UI ${stamp}`,
    description: "P5a 多人 Chat 页面验收",
  });
  projectPath = project.path;
  record("project_created_to_chats", true, projectPath);

  const channel = await page.$('[data-testid="chat-item"][data-chat-kind="public_channel"]');
  record(
    "public_channel_present_in_list",
    Boolean(channel),
    channel ? "列表含自动创建的公共频道" : "缺少频道",
  );

  await page.click('[data-testid="nav-agents"]');
  await page.waitForURL((url) => url.pathname === "/agents", { timeout: 20000 });
  await page.click('[data-testid="new-agent-trigger"]');
  await page.fill('[data-testid="agent-name-input"]', agentName);
  await page.fill('[data-testid="agent-persona-input"]', "P5a 群聊验收分身");
  await page.click('[data-testid="agent-submit"]');
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[data-testid="agent-item-name"]')].some(
        (node) => node.textContent === name,
      ),
    agentName,
    { timeout: 20000 },
  );
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
  record("agent_member_created", true, agentName);

  await page.goto(`${BASE}${projectPath}/chats`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="chat-item"][data-chat-kind="public_channel"]', {
    timeout: 20000,
  });
  await page.click('[data-testid="chat-item"][data-chat-kind="public_channel"]');
  await page.waitForSelector('[data-testid="chat-details"]', { timeout: 20000 });
  const boxes = await page.evaluate(() => {
    const box = (id) => {
      const element = document.querySelector(`[data-testid="${id}"]`);
      const rect = element?.getBoundingClientRect();
      return rect && rect.width > 0 ? { x: rect.x, width: rect.width } : null;
    };
    return {
      list: box("chat-list-panel"),
      detail: box("chat-detail-panel"),
      aside: box("chat-inspector"),
      selectedKind: document
        .querySelector('[data-testid="chat-item"][aria-current="page"]')
        ?.getAttribute("data-chat-kind"),
    };
  });
  record(
    "three_columns_visible",
    Boolean(boxes.list && boxes.detail && boxes.aside) &&
      boxes.list.x < boxes.detail.x &&
      boxes.detail.x < boxes.aside.x,
    JSON.stringify(boxes),
  );

  const sections = await readResults(page, "chat-details-members");
  const ownerSections = await readResults(page, "chat-details-owner");
  const activitySections = await readResults(page, "chat-details-activity");
  record(
    "details_sections_default_open",
    sections[0]?.open === true &&
      ownerSections[0]?.open === true &&
      activitySections[0]?.open === true,
    JSON.stringify({
      members: sections[0]?.open,
      owner: ownerSections[0]?.open,
      activity: activitySections[0]?.open,
    }),
  );

  const channelText = (await page.textContent('[data-testid="channel-members-readonly"]'))?.trim();
  const governanceOnChannel = await page.locator("[data-governance-action]").count();
  record(
    "channel_membership_readonly_copy",
    Boolean(
      channelText?.includes("公共频道成员跟随项目自动同步，不可独立修改。") &&
      channelText?.includes("Project Members"),
    ) && governanceOnChannel === 0,
    `文案 ${JSON.stringify(channelText)}，治理按钮 ${governanceOnChannel}`,
  );
  await shot(page, "p5a-public-channel");

  const agentGovernance = governanceAvailability({
    kind: "group",
    ownerKind: "human",
    ownerId: "human-owner",
    actorKind: "agent",
    actorId: "agent-actor",
  });
  record(
    "agent_governance_never_rendered",
    Object.values(agentGovernance).every((value) => value === false),
    JSON.stringify(agentGovernance),
  );

  await page.click('[data-testid="new-chat"]');
  await page.waitForSelector('[data-testid="new-chat-dialog"]', { timeout: 20000 });
  await page.getByTestId("new-chat-mode-group").click();
  await page.waitForSelector('[data-testid="group-create-form"]', { timeout: 20000 });
  const defaultOwner = (await page.textContent('[data-testid="group-owner-default"]'))?.trim();
  const defaultPolicy = await page.inputValue('[data-testid="group-wake-policy"]');
  record(
    "group_defaults_human_owner_and_owner_led",
    Boolean(defaultOwner?.includes("Human")) && defaultPolicy === "owner_led",
    `owner ${JSON.stringify(defaultOwner)}，policy ${defaultPolicy}`,
  );

  await page.click('[data-testid="group-submit"]');
  await page.waitForSelector('[data-testid="group-error"]', { timeout: 20000 });
  const validation = (await page.textContent('[data-testid="group-error"]'))?.trim();
  record(
    "group_validation_requires_agent",
    Boolean(validation?.includes("至少选择 1 位 Agent")),
    JSON.stringify(validation),
  );

  // Esc 关闭对话框并把焦点还给触发按钮。
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="new-chat-dialog"]', {
    state: "detached",
    timeout: 20000,
  });
  const focusReturned = await page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") === "new-chat",
  );
  record(
    "group_dialog_escape_returns_focus",
    focusReturned,
    `focus ${await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))}`,
  );

  await page.click('[data-testid="new-chat"]');
  await page.getByTestId("new-chat-mode-group").click();
  await page.fill('[data-testid="group-title-input"]', groupTitle);
  await page.locator('[data-testid="group-member-checkbox"]').first().check();
  await page.click('[data-testid="group-submit"]');
  await page.waitForURL((url) => /\/chats\/cnv_[0-9a-f-]{36}$/.test(url.pathname), {
    timeout: 30000,
  });
  groupPath = new URL(page.url()).pathname;
  await page.waitForSelector('[data-testid="chat-details"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="new-chat-dialog"]', {
    state: "detached",
    timeout: 20000,
  });
  const groupOwner = (await page.textContent('[data-testid="chat-owner-name"]'))?.trim();
  const groupPolicy = (await page.textContent('[data-testid="chat-wake-policy"]'))?.trim();
  const groupGovernance = await page.locator("[data-governance-action]").count();
  record(
    "group_created_with_human_owner_and_governance",
    Boolean(groupOwner?.includes("Human")) &&
      Boolean(groupPolicy?.includes("owner_led")) &&
      groupGovernance >= 2,
    `url ${groupPath}，owner ${JSON.stringify(groupOwner)}，policy ${JSON.stringify(groupPolicy)}，按钮 ${groupGovernance}`,
  );

  await page.fill('[data-testid="message-input"]', message);
  await page.click('[data-testid="message-send"]');
  await page.waitForFunction(
    (body) =>
      [...document.querySelectorAll('[data-testid="message-body"]')].some(
        (node) => node.textContent === body,
      ),
    message,
    { timeout: 20000 },
  );
  const senderKind = await page.getAttribute('[data-testid="message-item"]', "data-sender-kind");
  record("group_message_sent_by_actual_sender", senderKind === "human", `senderKind ${senderKind}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (body) =>
      [...document.querySelectorAll('[data-testid="message-body"]')].some(
        (node) => node.textContent === body,
      ),
    message,
    { timeout: 20000 },
  );
  record("group_message_persisted_after_reload", true, "刷新后消息仍在");
  await shot(page, "p5a-group-details");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}${groupPath}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="chat-title"]', { timeout: 20000 });
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    inspector: Boolean(
      document.querySelector('[data-testid="chat-inspector"]')?.getClientRects().length,
    ),
    detail: Boolean(
      document.querySelector('[data-testid="chat-detail-panel"]')?.getClientRects().length,
    ),
  }));
  record(
    "mobile_390_no_horizontal_overflow",
    mobile.overflow === false && mobile.detail === true && mobile.inspector === false,
    JSON.stringify(mobile),
  );
  await page.click('[data-testid="toggle-inspector"]');
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector('[data-testid="chat-inspector"]')?.getClientRects().length),
    null,
    { timeout: 20000 },
  );
  const mobileDetails = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    width: Math.round(
      document.querySelector('[data-testid="chat-inspector"]')?.getBoundingClientRect().width ?? 0,
    ),
    sections: document.querySelectorAll(
      '[data-testid="chat-details-members"], [data-testid="chat-details-owner"], [data-testid="chat-details-activity"]',
    ).length,
  }));
  record(
    "mobile_details_screen_full_width_no_overflow",
    mobileDetails.overflow === false && mobileDetails.width === 390 && mobileDetails.sections === 3,
    JSON.stringify(mobileDetails),
  );
  await shot(page, "p5a-mobile-details");

  record(
    "no_console_errors",
    consoleErrors.length === 0,
    consoleErrors.length === 0 ? "无 console.error 与未捕获异常" : consoleErrors.join(" | "),
  );
} catch (error) {
  record("flow_exception", false, error instanceof Error ? error.message : String(error));
  await shot(page, "p5a-failure").catch(() => {});
} finally {
  writeFileSync(
    `${EVIDENCE}results.json`,
    JSON.stringify({ base: BASE, projectPath, agentName, groupPath, results }, null, 2) + "\n",
  );
  await browser.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`PASS/FAIL checks: ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
