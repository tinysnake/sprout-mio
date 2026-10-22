// UI review 反馈 7 的浏览器自证：从 chat inspector 的 profile 链接进入 agent 详情后，
// 「返回对话」必须回到同一个 chat（保留 chatId 与 inspector），直接打开 /agents/:id
// 时返回目标只能是 /agents 列表，不凭空造 chatId。
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { chatInspectorPath, createProject, waitForChats } from "./ui-navigation.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EVIDENCE = process.env.SPROUT_UI_EVIDENCE_DIR
  ? `${process.env.SPROUT_UI_EVIDENCE_DIR.replace(/\/+$/, "")}/`
  : new URL("../../docs/p3/evidence/", import.meta.url).pathname;

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

mkdirSync(EVIDENCE, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

const stamp = Date.now();
const email = `ui-fb-back-${stamp}@example.test`;
const password = "{{SECRET_ui-fb-back-pass}}";
const agentName = `UI-FB Back Agent ${stamp}`;
const pathOf = () => new URL(page.url()).pathname;
const searchOf = () => new URL(page.url()).search;
let project = {};
let projectPath = "";
let chatPath = "";
let profileId = "";

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[name="email"]', { timeout: 20000 });

await check("setup_chat_and_profile", async () => {
  await page.getByTestId("register-tab").click();
  await page.fill('input[name="name"]', "UI-FB Back");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await waitForChats(page);
  project = await createProject(page, { name: `UI-FB Back ${stamp}` });
  projectPath = project.path;

  await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="new-agent-trigger"]', { timeout: 20000 });
  await page.click('[data-testid="new-agent-trigger"]');
  await page.fill('[data-testid="agent-name-input"]', agentName);
  await page.fill('[data-testid="agent-persona-input"]', "验证 agent 详情返回对话");
  await page.click('[data-testid="agent-submit"]');
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[data-testid="agent-item-name"]')].some(
        (node) => node.textContent?.trim() === name,
      ),
    agentName,
    { timeout: 20000 },
  );
  await page.click(`[data-testid="agent-item-name"] >> text=${agentName}`);
  await page.waitForSelector('[data-testid="agent-detail-id"]', { timeout: 20000 });
  profileId = (await page.textContent('[data-testid="agent-detail-id"]'))?.trim() ?? "";

  await page.goto(`${BASE}${projectPath}/members`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="add-member-select"]', { timeout: 20000 });
  await page.selectOption('[data-testid="add-member-select"]', { label: agentName });
  await page.click('[data-testid="add-member-submit"]');
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[data-testid="member-item-name"]')].some(
        (node) => node.textContent?.trim() === name,
      ),
    agentName,
    { timeout: 20000 },
  );

  await page.goto(`${BASE}${projectPath}/chats`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`[data-testid="dm-start"][data-agent-profile-id="${profileId}"]`, {
    timeout: 20000,
  });
  await page.click(`[data-testid="dm-start"][data-agent-profile-id="${profileId}"]`);
  await page.waitForURL((url) => /\/chats\/cnv_[0-9a-f-]{36}$/.test(url.pathname), {
    timeout: 20000,
  });
  chatPath = pathOf();
  record(
    "setup_chat_and_profile",
    /^agp_[0-9a-f-]{36}$/.test(profileId) && /^cnv_[0-9a-f-]{36}$/.test(chatPath.split("/").pop()),
    `profile ${profileId}，对话 ${chatPath}`,
  );
});

await check("chat_profile_link_carries_source_and_back_returns", async () => {
  await page.goto(`${BASE}${chatInspectorPath(chatPath)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="chat-inspector"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="info-chat-runs-recent"]', { timeout: 20000 });
  await shot(page, "ui-fb-chat-inspector-runs");
  const link = page.locator('[data-testid="inspector-agent-profile-link"]');
  await link.waitFor({ timeout: 20000 });
  await link.click();
  await page.waitForURL((url) => url.pathname === `/agents/${profileId}`, { timeout: 20000 });
  const search = new URL(page.url()).searchParams;
  const back = page.locator('[data-testid="agent-detail-back-to-chat"]');
  await back.waitFor({ timeout: 20000 });
  const backText = (await back.textContent())?.trim();
  const backHref = await back.getAttribute("href");
  await shot(page, "ui-fb-agent-detail-from-chat");
  const carried =
    search.get("fromProjectId") === project.id &&
    search.get("fromChatId") === chatPath.split("/").pop();
  record(
    "chat_profile_link_carries_source_and_back_returns",
    carried && backText === "返回对话" && backHref === chatInspectorPath(chatPath),
    `profile URL ${pathOf()}${searchOf()}，返回入口 ${JSON.stringify(backText)} → ${backHref}`,
  );

  await back.click();
  await page.waitForURL((url) => url.pathname === chatPath, { timeout: 20000 });
  await page.waitForSelector('[data-testid="chat-inspector"]', { timeout: 20000 });
  const searchAfter = new URL(page.url()).searchParams.get("info");
  const instance = (await page.textContent('[data-testid="chat-instance-id"]'))?.trim();
  record(
    "back_returns_to_same_chat_with_inspector",
    pathOf() === chatPath && searchAfter === "1" && /^ins_[0-9a-f-]{36}$/.test(instance ?? ""),
    `返回到 ${pathOf()}${searchOf()}，分身 ${instance}`,
  );
});

await check("direct_open_without_source_returns_to_agents", async () => {
  await page.goto(`${BASE}/agents/${profileId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="agent-detail-id"]', { timeout: 20000 });
  const back = page.locator('[data-testid="agent-detail-back-to-agents"]');
  await back.waitFor({ timeout: 20000 });
  const backText = (await back.textContent())?.trim();
  const backHref = await back.getAttribute("href");
  const noSource = new URL(page.url()).search === "";
  await shot(page, "ui-fb-agent-detail-direct");
  await back.click();
  await page.waitForURL((url) => url.pathname === "/agents", { timeout: 20000 });
  record(
    "direct_open_without_source_returns_to_agents",
    noSource && backText === "返回 Agents" && backHref === "/agents" && pathOf() === "/agents",
    `直接打开无来源 ${noSource}，返回入口 ${JSON.stringify(backText)} → ${backHref}，落到 ${pathOf()}`,
  );
});

await check("no_console_errors", async () => {
  record("no_console_errors", consoleErrors.length === 0, JSON.stringify(consoleErrors));
});

await browser.close();
const failed = results.filter((result) => !result.passed);
console.log(`browser checks: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
