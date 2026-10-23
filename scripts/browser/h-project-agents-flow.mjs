// 真实 Chromium 走完 P2 的 Project 配置、Agent profile 与成员管理，每步打印 PASS/FAIL。
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import {
  createProject,
  currentProjectName,
  navigate,
  readProjectFacts,
  waitForChats,
} from "./ui-navigation.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EVIDENCE = process.env.SPROUT_UI_EVIDENCE_DIR
  ? `${process.env.SPROUT_UI_EVIDENCE_DIR.replace(/\/+$/, "")}/`
  : new URL("../../.verify/h-project-agents/evidence/", import.meta.url).pathname;

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

mkdirSync(EVIDENCE, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
page.on("dialog", (dialog) => dialog.accept());

const stamp = Date.now();
const email = `h-project-agents-${stamp}@example.test`;
const password = "test-pass-h-project-agents";
const projectName = `P2-H 验收 ${stamp}`;
const agentName = `P2-H Agent ${stamp}`;
const initialPersona = "初始人设：谨慎的验收员";
const updatedPersona = "新人设：编辑后的验收员";
const gitRemote = "https://example.test/acme/repo.git";
const defaultBranch = "develop";
const workDirectory = "workspaces/acme";
const pathOf = () => new URL(page.url()).pathname;
let project = {};

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[name="email"]', { timeout: 20000 });

await check("register_and_create_project", async () => {
  await page.getByTestId("register-tab").click();
  await page.fill('input[name="name"]', "P2-H 验收");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await waitForChats(page);
  project = await createProject(page, {
    name: projectName,
    description: "P2 Project 配置与 Agent 成员验收",
  });
  record(
    "register_and_create_project",
    pathOf() === `${project.path}/chats`,
    `注册登录并创建 ${projectName}，落到 ${pathOf()}`,
  );
});

await check("project_root_enters_chats", async () => {
  await navigate(page, project.path);
  const landed = await waitForChats(page);
  const selected = await currentProjectName(page);
  await shot(page, "p2-h-project-chats");
  record(
    "project_root_enters_chats",
    landed.id === project.id && selected === projectName,
    `Project 根落到 ${pathOf()}，选择器为 ${JSON.stringify(selected)}`,
  );
});

const projectPath = project.path;

await check("settings_save_and_reload_persist", async () => {
  await page.click('[data-testid="tab-settings"]');
  await page.waitForSelector('[data-testid="config-git-remote"]', { timeout: 20000 });
  await page.fill('[data-testid="config-git-remote"]', gitRemote);
  await page.fill('[data-testid="config-default-branch"]', defaultBranch);
  await page.fill('[data-testid="config-work-directory"]', workDirectory);
  await page.click('[data-testid="config-save"]');
  await page.waitForSelector('[data-testid="config-saved"]', { timeout: 20000 });
  await shot(page, "p2-h-project-settings");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="config-git-remote"]', { timeout: 20000 });
  const values = await page.evaluate(() => ({
    gitRemote: document.querySelector('[data-testid="config-git-remote"]')?.value,
    branch: document.querySelector('[data-testid="config-default-branch"]')?.value,
    workDirectory: document.querySelector('[data-testid="config-work-directory"]')?.value,
    path: location.pathname,
  }));
  await shot(page, "p2-h-project-settings-reload");
  record(
    "settings_save_and_reload_persist",
    values.gitRemote === gitRemote &&
      values.branch === defaultBranch &&
      values.workDirectory === workDirectory &&
      values.path === `${projectPath}/settings`,
    `刷新后 ${JSON.stringify(values)}`,
  );
});

await check("create_agent_profile_appears_in_list", async () => {
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
  const names = await page.$$eval('[data-testid="agent-item-name"]', (nodes) =>
    nodes.map((node) => node.textContent),
  );
  await shot(page, "p2-h-agents-list");
  record(
    "create_agent_profile_appears_in_list",
    names.includes(agentName),
    `列表包含 ${JSON.stringify(names)}`,
  );
});

let agentPath = "";
let agentId = "";

await check("edit_persona_persists_with_same_id", async () => {
  await page.click(`[data-testid="agent-item-name"] >> text=${agentName}`);
  await page.waitForSelector('[data-testid="agent-detail-name"]', { timeout: 20000 });
  agentPath = pathOf();
  agentId = (await page.textContent('[data-testid="agent-detail-id"]')) ?? "";
  const note = await page.textContent('[data-testid="agent-edit-note"]');
  await page.fill('[data-testid="agent-edit-persona"]', updatedPersona);
  await page.click('[data-testid="agent-edit-save"]');
  await page.waitForSelector('[data-testid="agent-edit-saved"]', { timeout: 20000 });
  const afterSave = await page.evaluate(() => ({
    id: document.querySelector('[data-testid="agent-detail-id"]')?.textContent,
    path: location.pathname,
  }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="agent-edit-persona"]', { timeout: 20000 });
  const afterReload = await page.evaluate(() => ({
    persona: document.querySelector('[data-testid="agent-edit-persona"]')?.value,
    id: document.querySelector('[data-testid="agent-detail-id"]')?.textContent,
    path: location.pathname,
  }));
  await shot(page, "p2-h-agent-detail");
  record(
    "edit_persona_persists_with_same_id",
    /下一轮运行生效/.test(note ?? "") &&
      afterSave.id === agentId &&
      afterSave.path === agentPath &&
      afterReload.persona === updatedPersona &&
      afterReload.id === agentId &&
      afterReload.path === agentPath &&
      /^agp_[0-9a-f-]{36}$/.test(agentId),
    `id ${agentId} 未变，URL ${afterReload.path}，人设 ${JSON.stringify(afterReload.persona)}`,
  );
});

await check("add_and_remove_member_roundtrip", async () => {
  await page.goto(`${BASE}${projectPath}/members`, { waitUntil: "domcontentloaded" });
  // 注册播种的默认 Agent 已经是成员，所以这里等的是新 profile 进入可选列表，而非空成员。
  // 添加入口改为按钮加弹窗：等按钮出现（出现即表示有可添加的 profile），再在弹窗里选人。
  await page.waitForSelector('[data-testid="add-member-trigger"]', { timeout: 20000 });
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
  await shot(page, "p2-h-project-members");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('[data-testid="member-item-name"]')].some(
        (node) => node.textContent === name,
      ),
    agentName,
    { timeout: 20000 },
  );
  const afterReload = await page.evaluate(
    (name) =>
      [...document.querySelectorAll('[data-testid="member-item-name"]')].some(
        (node) => node.textContent === name,
      ),
    agentName,
  );
  // 只移除本次验收加入的 profile，默认成员保留。
  await page.click(`[data-testid="member-remove"][data-agent-profile-id="${agentId}"]`);
  await page.getByTestId("cancel-member-mutation").click();
  const afterCancel = await page
    .locator(`[data-testid="member-item"][data-agent-profile-id="${agentId}"]`)
    .isVisible();
  await page.click(`[data-testid="member-remove"][data-agent-profile-id="${agentId}"]`);
  await page.getByTestId("confirm-member-mutation").click();
  await page.waitForFunction(
    (name) =>
      ![...document.querySelectorAll('[data-testid="member-item-name"]')].some(
        (node) => node.textContent === name,
      ),
    agentName,
    { timeout: 20000 },
  );
  await shot(page, "p2-h-project-members-empty");
  record(
    "add_and_remove_member_roundtrip",
    afterReload && afterCancel && pathOf() === `${projectPath}/members`,
    `加入并刷新后仍有 ${agentName}，取消移除后保留，确认移除后不再在名单里`,
  );
});

await check("deep_link_settings_renders", async () => {
  await page.goto(`${BASE}${projectPath}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="config-git-remote"]', { timeout: 20000 });
  const remote = await page.inputValue('[data-testid="config-git-remote"]');
  const facts = await readProjectFacts(page);
  await shot(page, "p2-h-deep-settings");
  record(
    "deep_link_settings_renders",
    remote === gitRemote &&
      (facts.id ?? "").includes(project.id) &&
      pathOf() === `${projectPath}/settings`,
    `深链直达配置页，git remote ${JSON.stringify(remote)}，Project 事实 ${JSON.stringify(facts)}`,
  );
});

await check("deep_link_agent_renders", async () => {
  await page.goto(`${BASE}/agents/${agentId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="agent-edit-persona"]', { timeout: 20000 });
  const persona = await page.inputValue('[data-testid="agent-edit-persona"]');
  await shot(page, "p2-h-deep-agent");
  record(
    "deep_link_agent_renders",
    persona === updatedPersona && pathOf() === `/agents/${agentId}`,
    `深链直达 profile ${agentId}`,
  );
});

await check("back_forward_keep_target_and_project_context", async () => {
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="config-git-remote"]', { timeout: 20000 });
  const backPath = pathOf();
  await page.goForward({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="agent-edit-persona"]', { timeout: 20000 });
  await navigate(page, `${projectPath}/chats`);
  await page.waitForSelector('[data-testid="chats-title"]', { timeout: 20000 });
  await page.click('[data-testid="tab-agents"]');
  await page.waitForSelector('[data-testid="member-list"], [data-testid="members-empty"]', {
    timeout: 20000,
  });
  const membersPath = pathOf();
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="chats-title"]', { timeout: 20000 });
  const chatsPath = pathOf();
  await page.goForward({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="member-list"], [data-testid="members-empty"]', {
    timeout: 20000,
  });
  record(
    "back_forward_keep_target_and_project_context",
    backPath === `${projectPath}/settings` &&
      membersPath === `${projectPath}/members` &&
      chatsPath === `${projectPath}/chats` &&
      pathOf() === `${projectPath}/members`,
    `后退到 ${backPath}，前进与项目内前进后退经 ${chatsPath} 回到 ${pathOf()}`,
  );
});

await check("missing_project_settings_shows_not_found", async () => {
  await page.goto(`${BASE}/projects/prj_00000000-0000-4000-8000-000000000000/settings`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector('[data-testid="project-error"]', { timeout: 20000 });
  const meta = await page.textContent('[data-testid="project-error-meta"]');
  await shot(page, "p2-h-settings-not-found");
  record(
    "missing_project_settings_shows_not_found",
    /not_found/.test(meta ?? "") && /req_[0-9a-f-]{36}/.test(meta ?? ""),
    `不存在的 projectId 子页显示 ${JSON.stringify(meta)}`,
  );
});

await check("missing_agent_profile_shows_not_found", async () => {
  await page.goto(`${BASE}/agents/agp_00000000-0000-4000-8000-000000000000`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector('[data-testid="agent-error"]', { timeout: 20000 });
  const meta = await page.textContent('[data-testid="agent-error-meta"]');
  await shot(page, "p2-h-agent-not-found");
  record(
    "missing_agent_profile_shows_not_found",
    /not_found/.test(meta ?? "") && /req_[0-9a-f-]{36}/.test(meta ?? ""),
    `不存在的 profileId 显示 ${JSON.stringify(meta)}`,
  );
});

record(
  "no_console_errors",
  consoleErrors.length === 0,
  consoleErrors.length === 0 ? "无 console.error 与未捕获异常" : consoleErrors.join(" | "),
);

await browser.close();

const failed = results.filter((result) => !result.passed);
console.log(`browser checks: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
