// P5a 多人 Chat 正式页面：三栏、详情三段、群创建、频道只读、治理可见性与窄屏。
// 业务数据只经真实页面登录与领域 server function 写入，不直接改 SQLite。
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
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

/** 真实 SQLite 计数：空名称提交不建群不能只看页面，要看库里 chat 行有没有增加。 */
function chatRowCount() {
  const file = process.env.DATABASE_URL;
  if (!file) return { count: null, error: "DATABASE_URL 缺失" };
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return { count: db.prepare("select count(*) as count from chat").get().count, error: null };
    } finally {
      db.close();
    }
  } catch (error) {
    return { count: null, error: error instanceof Error ? error.message : String(error) };
  }
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
let dmPath = "";
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

  // V5：Chat 页面任何位置都不显示 requestId（此处群校验错误横幅正显示着）。
  const requestIdOnPage = await page.evaluate(() => ({
    literal: document.body.innerText.includes("requestId"),
    bare: /req_[0-9a-f-]{36}/.test(document.body.innerText),
  }));
  record(
    "chat_page_hides_request_id",
    requestIdOnPage.literal === false && requestIdOnPage.bare === false,
    JSON.stringify(requestIdOnPage),
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

  // R2-UI01：名称为空时在输入旁给出可读校验，不发请求（真实 SQLite chat 行不增加）。
  const chatsBeforeBlank = chatRowCount();
  await page.click('[data-testid="new-chat"]');
  await page.waitForSelector('[data-testid="new-chat-dialog"]', { timeout: 20000 });
  await page.getByTestId("new-chat-mode-group").click();
  await page.locator('[data-testid="group-member-checkbox"]').first().check();
  await page.fill('[data-testid="group-title-input"]', "   ");
  await page.click('[data-testid="group-submit"]');
  await page.waitForTimeout(800);
  const blankTitleError = (
    await page
      .locator('[data-testid="group-title-error"]')
      .first()
      .textContent()
      .catch(() => "")
  )?.trim();
  const blankDialogOpen = await page.locator('[data-testid="new-chat-dialog"]').count();
  const chatsAfterBlank = chatRowCount();
  record(
    "group_blank_title_blocks_create",
    Boolean(blankTitleError?.includes("群名称不能为空")) &&
      blankDialogOpen === 1 &&
      chatsBeforeBlank.count !== null &&
      chatsAfterBlank.count === chatsBeforeBlank.count,
    `错误 ${JSON.stringify(blankTitleError)}，对话框 ${blankDialogOpen}，chat 行 ${chatsBeforeBlank.count}→${chatsAfterBlank.count}`,
  );
  await shot(page, "p5a-group-blank-title-error");
  // 红态下这一步会真的建群并跳转：先恢复现场，后面的用例仍要在同一 Project 上跑。
  if (blankDialogOpen === 1) {
    await page.keyboard.press("Escape");
    await page
      .waitForSelector('[data-testid="new-chat-dialog"]', { state: "detached", timeout: 20000 })
      .catch(() => {});
  } else {
    await page.goto(`${BASE}${projectPath}/chats`, { waitUntil: "domcontentloaded" });
  }
  await page.waitForSelector('[data-testid="new-chat"]', { timeout: 20000 });

  await page.click('[data-testid="new-chat"]');
  await page.getByTestId("new-chat-mode-group").click();
  await page.fill('[data-testid="group-title-input"]', groupTitle);
  await page.locator('[data-testid="group-member-checkbox"]').first().check();
  const pathBeforeCreate = new URL(page.url()).pathname;
  await page.click('[data-testid="group-submit"]');
  // /chats 可能先停在已有对话上，必须等到地址真的变化，否则会拿到上一条对话的 URL。
  await page.waitForFunction((before) => location.pathname !== before, pathBeforeCreate, {
    timeout: 30000,
  });
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
  const groupRailTitle = (
    await page
      .textContent('[data-testid="chat-details-title"]', { timeout: 3000 })
      .catch(() => null)
  )?.trim();
  const groupGovernance = await page.locator("[data-governance-action]").count();
  record(
    "group_created_with_human_owner_and_governance",
    Boolean(groupOwner?.includes("Human")) &&
      Boolean(groupPolicy?.includes("owner_led")) &&
      groupGovernance >= 2 &&
      groupRailTitle === groupTitle,
    `url ${groupPath}，owner ${JSON.stringify(groupOwner)}，policy ${JSON.stringify(groupPolicy)}，按钮 ${groupGovernance}，右栏标题 ${JSON.stringify(groupRailTitle)}`,
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

  // R2-UI02：标题治理在右栏治理段，消息头部没有治理动作；改完头部标题同步。
  const headerGovernance = await page
    .locator('[data-testid="chat-pane"] [data-governance-action]')
    .count();
  const railTitleEdit = page.locator(
    '[data-testid="chat-inspector"] [data-testid="chat-title-edit"]',
  );
  const railTitleEditCount = await railTitleEdit.count();
  const renamedTitle = `${groupTitle} 改名`;
  let railRenameDetail = "右栏没有唯一的重命名入口";
  if (railTitleEditCount === 1) {
    await railTitleEdit.click();
    await page.waitForSelector('[data-testid="chat-title-dialog"]', {
      state: "visible",
      timeout: 20000,
    });
    await page.fill('[data-testid="chat-title-input"]', renamedTitle);
    await page.click('[data-testid="chat-title-save"]');
    await page
      .waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="chat-title"]')?.textContent?.trim() === expected,
        renamedTitle,
        { timeout: 20000 },
      )
      .catch(() => {});
    const heading = (await page.textContent('[data-testid="chat-title"]'))?.trim();
    const railTitle = (await page.textContent('[data-testid="chat-details-title"]'))?.trim();
    railRenameDetail = `头部标题 ${JSON.stringify(heading)}，右栏标题 ${JSON.stringify(railTitle)}`;
    record(
      "group_title_edited_from_details_rail",
      headerGovernance === 0 && heading === renamedTitle && railTitle === renamedTitle,
      `消息头治理按钮 ${headerGovernance}，右栏入口 ${railTitleEditCount}，${railRenameDetail}`,
    );
  } else {
    record(
      "group_title_edited_from_details_rail",
      false,
      `消息头治理按钮 ${headerGovernance}，右栏入口 ${railTitleEditCount}，${railRenameDetail}`,
    );
  }

  // V1 / V2：治理提示只一处且在治理段；成员名单只在成员段，事实行不重复名单。
  const duplicates = await page.evaluate(() => {
    const count = (id) => document.querySelectorAll(`[data-testid="${id}"]`).length;
    const note = document.querySelector('[data-testid="chat-governance-note"]');
    const memberList = document.querySelector('[data-testid="inspector-member-list"]');
    const facts = document.querySelector('[data-testid="inspector-chat-id"]')?.closest("dl");
    const memberSection = document.querySelector('[data-testid="chat-details-members"]');
    return {
      governanceNote: count("chat-governance-note"),
      memberNote: count("chat-member-note"),
      titleEdit: count("chat-title-edit"),
      memberList: count("inspector-member-list"),
      chatId: count("inspector-chat-id"),
      instanceId: count("inspector-instance-id"),
      messageCount: count("inspector-message-count"),
      memberSelect: count("chat-member-select"),
      noteInGovernanceSection: Boolean(note && note.closest('[data-testid="chat-details-owner"]')),
      memberListInMemberSection: Boolean(
        memberList && memberList.closest('[data-testid="chat-details-members"]'),
      ),
      memberSectionText: memberSection?.textContent ?? "",
      factsText: facts?.textContent ?? "",
    };
  });
  record(
    "group_governance_note_and_testids_once",
    duplicates.governanceNote === 1 &&
      duplicates.noteInGovernanceSection &&
      !duplicates.memberSectionText.includes("仅当前 Human owner 可修改") &&
      !duplicates.memberSectionText.includes("Agent 不参与治理") &&
      duplicates.titleEdit === 1 &&
      duplicates.memberList === 1 &&
      duplicates.chatId === 1 &&
      duplicates.messageCount === 1 &&
      duplicates.instanceId === 0,
    JSON.stringify({
      governanceNote: duplicates.governanceNote,
      memberNote: duplicates.memberNote,
      titleEdit: duplicates.titleEdit,
      memberList: duplicates.memberList,
      noteInGovernanceSection: duplicates.noteInGovernanceSection,
      memberSectionMentionsOwnerGovernance: duplicates.memberSectionText.includes(
        "仅当前 Human owner 可修改",
      ),
    }),
  );
  record(
    "group_details_drop_instance_row",
    duplicates.instanceId === 0 &&
      !duplicates.factsText.includes("Instance ID") &&
      duplicates.factsText.includes("Chat ID") &&
      duplicates.factsText.includes("消息数"),
    `Instance 行 ${duplicates.instanceId}，事实行 ${JSON.stringify(duplicates.factsText)}`,
  );
  record(
    "group_member_list_only_in_member_section",
    duplicates.memberListInMemberSection &&
      !duplicates.factsText.includes(agentName) &&
      duplicates.factsText.includes("消息数"),
    `成员段内的名单 ${duplicates.memberListInMemberSection}，事实行 ${JSON.stringify(duplicates.factsText)}`,
  );
  // 弹层退场动画结束再截图，否则会截到仍未绘制的遮罩。
  if ((await page.locator('[data-testid="chat-title-dialog"]').count()) > 0) {
    await page.keyboard.press("Escape");
    await page
      .waitForSelector('[data-testid="chat-title-dialog"]', { state: "detached", timeout: 20000 })
      .catch(() => {});
  }
  await shot(page, "p5a-group-details-fixed-1440");

  // V6：默认不选中成员，因此没有资料块；点第二个 Agent 成员后展示这一位的资料。
  const agent2Name = `P5a Agent B ${stamp}`;
  const agent2Persona = "第二个分身，用于选中态";
  await page.click('[data-testid="nav-agents"]');
  await page.waitForURL((url) => url.pathname === "/agents", { timeout: 20000 });
  await page.click('[data-testid="new-agent-trigger"]');
  await page.fill('[data-testid="agent-name-input"]', agent2Name);
  await page.fill('[data-testid="agent-persona-input"]', agent2Persona);
  await page.click('[data-testid="agent-submit"]');
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[data-testid="agent-item-name"]')].some(
        (node) => node.textContent === name,
      ),
    agent2Name,
    { timeout: 20000 },
  );
  await page.goto(`${BASE}${projectPath}/members`, { waitUntil: "domcontentloaded" });
  await page.click('[data-testid="add-member-trigger"]');
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[data-testid="add-member-select"] option')].some(
        (option) => option.textContent === name,
      ),
    agent2Name,
    { timeout: 20000 },
  );
  await page.selectOption('[data-testid="add-member-select"]', { label: agent2Name });
  await page.click('[data-testid="add-member-submit"]');
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[data-testid="member-item-name"]')].some(
        (node) => node.textContent === name,
      ),
    agent2Name,
    { timeout: 20000 },
  );
  await page.goto(`${BASE}${groupPath}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="chat-details"]', { timeout: 20000 });
  const profileDefault = await page.locator('[data-testid="chat-inspector-identity"]').count();
  await page.click('[data-testid="chat-member-add"]');
  await page.waitForSelector('[data-testid="chat-member-add-dialog"]', {
    state: "visible",
    timeout: 20000,
  });
  const agent2Value = await page
    .locator('[data-testid="chat-member-add-select"] option', { hasText: agent2Name })
    .first()
    .getAttribute("value");
  await page.selectOption('[data-testid="chat-member-add-select"]', agent2Value ?? "");
  await page.click('[data-testid="chat-member-add-submit"]');
  await page
    .waitForFunction(
      (name) =>
        [...document.querySelectorAll('[data-testid="chat-member-select"]')].some((node) =>
          node.textContent?.includes(name),
        ),
      agent2Name,
      { timeout: 20000 },
    )
    .catch(() => {});
  const memberSelectCount = await page.locator('[data-testid="chat-member-select"]').count();
  if (memberSelectCount > 0) {
    await page
      .locator('[data-testid="chat-member-select"]', { hasText: agent2Name })
      .first()
      .click({ timeout: 20000 })
      .catch(() => {});
  }
  const picked = await page.evaluate(() => ({
    name: document.querySelector('[data-testid="inspector-agent-name"]')?.textContent?.trim(),
    jobTitle: document
      .querySelector('[data-testid="inspector-agent-job-title"]')
      ?.textContent?.trim(),
    persona: document.querySelector('[data-testid="inspector-agent-persona"]')?.textContent?.trim(),
  }));
  record(
    "member_row_selects_profile",
    profileDefault === 0 &&
      memberSelectCount >= 2 &&
      picked.name === agent2Name &&
      picked.jobTitle === "未设置职位" &&
      picked.persona === agent2Persona,
    `默认资料块 ${profileDefault}，可选成员行 ${memberSelectCount}，选中 ${JSON.stringify(picked)}`,
  );
  // 本轮修复后的 1440px 证据：成员段、单一治理提示、右栏标题、选中成员资料块。
  await shot(page, "p5a-group-details-1440");

  // R2-UI02 只读分支：把 Owner 交给 Agent 后，右栏只剩只读标题与一处治理提示。
  await page.click('[data-testid="chat-owner-edit"]');
  await page.waitForSelector('[data-testid="chat-owner-dialog"]', {
    state: "visible",
    timeout: 20000,
  });
  const agentOwnerValue = await page
    .locator('[data-testid="chat-owner-select"] option', { hasText: "（Agent）" })
    .first()
    .getAttribute("value");
  await page.selectOption('[data-testid="chat-owner-select"]', agentOwnerValue ?? "");
  await page.click('[data-testid="chat-owner-submit"]');
  await page
    .waitForFunction(
      () =>
        !document.querySelector('[data-testid="chat-owner-dialog"]') &&
        document.querySelector('[data-testid="chat-owner-name"]')?.textContent?.includes("Agent"),
      null,
      { timeout: 20000 },
    )
    .catch(() => {});
  const agentOwner = await page.evaluate(() => ({
    owner: document.querySelector('[data-testid="chat-owner-name"]')?.textContent?.trim(),
    titleEdit: document.querySelectorAll('[data-testid="chat-title-edit"]').length,
    note: document.querySelector('[data-testid="chat-governance-note"]')?.textContent?.trim(),
    title: document.querySelector('[data-testid="chat-details-title"]')?.textContent?.trim(),
  }));
  record(
    "agent_owner_group_keeps_title_entry",
    Boolean(agentOwner.owner?.includes("Agent")) &&
      agentOwner.titleEdit === 1 &&
      Boolean(agentOwner.note?.includes("Agent 不参与治理")) &&
      !agentOwner.note?.includes("只有 owner") &&
      agentOwner.title === renamedTitle,
    JSON.stringify(agentOwner),
  );
  await shot(page, "p5a-group-agent-owner-1440");

  // V3：DM 保持 P4b 形状，只有成员段与活动段，没有治理段与治理提示。
  await page.goto(`${BASE}${projectPath}/chats`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="new-chat"]', { timeout: 20000 });
  await page.click('[data-testid="new-chat"]');
  await page.waitForSelector('[data-testid="new-chat-dialog"]', { timeout: 20000 });
  await page.getByTestId("new-chat-mode-dm").click();
  await page.waitForSelector('[data-testid="dm-start"]', { timeout: 20000 });
  await page.locator('[data-testid="new-chat-dialog"] [data-testid="dm-start"]').first().click();
  await page.waitForURL((url) => /\/chats\/cnv_[0-9a-f-]{36}$/.test(url.pathname), {
    timeout: 30000,
  });
  dmPath = new URL(page.url()).pathname;
  await page.waitForSelector('[data-testid="chat-details"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="new-chat-dialog"]', {
    state: "detached",
    timeout: 20000,
  });
  const dm = await page.evaluate(() => {
    const count = (id) => document.querySelectorAll(`[data-testid="${id}"]`).length;
    const details = document.querySelector('[data-testid="chat-details"]');
    return {
      owner: count("chat-details-owner"),
      governanceNote: count("chat-governance-note"),
      revision: count("chat-governance-revision"),
      policy: count("chat-wake-policy"),
      members: count("chat-details-members"),
      activity: count("chat-details-activity"),
      memberList: count("inspector-member-list"),
      messageCount: count("inspector-message-count"),
      governanceCopy: details?.textContent?.includes("仅当前 Human owner 可修改") ?? false,
    };
  });
  record(
    "dm_keeps_members_and_activity_only",
    dm.owner === 0 &&
      dm.governanceNote === 0 &&
      dm.revision === 0 &&
      dm.policy === 0 &&
      dm.members === 1 &&
      dm.activity === 1 &&
      dm.memberList === 1 &&
      dm.messageCount === 1 &&
      dm.governanceCopy === false,
    JSON.stringify(dm),
  );
  await shot(page, "p5a-dm-details-1440");

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
    JSON.stringify({ base: BASE, projectPath, agentName, groupPath, dmPath, results }, null, 2) +
      "\n",
  );
  await browser.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`PASS/FAIL checks: ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
