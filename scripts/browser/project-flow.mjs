// 真实 Chromium 走完 Project 的分发、创建、刷新、历史导航、Settings 事实、错误态与登出重定向，每步打印 PASS/FAIL。
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import {
  createProject,
  currentProjectName,
  navigate,
  openCreateDialog,
  readProjectFacts,
  sessionEmail,
  signOut,
  waitForChats,
} from "./ui-navigation.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EVIDENCE = process.env.SPROUT_UI_EVIDENCE_DIR
  ? `${process.env.SPROUT_UI_EVIDENCE_DIR.replace(/\/+$/, "")}/`
  : new URL("../../docs/p1/evidence/", import.meta.url).pathname;

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
const page = await browser.newPage();

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

const stamp = Date.now();
const email = `project-flow-${stamp}@example.test`;
const password = "{{SECRET_project-flow-pass}}";
const projectName = `验收样例 ${stamp}`;
const projectDescription = "浏览器验收创建的分层样例";
const detailPath = () => new URL(page.url()).pathname;
const seededName = "我的项目";
let project = {};

async function login() {
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
}

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[name="email"]', { timeout: 20000 });

await check("register_sets_session", async () => {
  await page.click("text=没有账号？注册");
  await page.fill('input[name="name"]', "Project 验收");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  // 注册播种「我的项目」，所以 `/` → `/projects` → 该 Project 的 Chats 三级分发后必然直达对话列表。
  const seeded = await waitForChats(page);
  record(
    "register_sets_session",
    seeded.chatsPath === detailPath(),
    `注册后分发到 ${detailPath()}`,
  );
});

await check("sign_out_returns_to_login", async () => {
  const shown = await sessionEmail(page);
  await signOut(page);
  record(
    "sign_out_returns_to_login",
    shown === email && detailPath() === "/login",
    `账号菜单里的身份 ${JSON.stringify(shown)}，登出后落到 ${detailPath()}`,
  );
});

await check("login_opens_protected_area", async () => {
  await login();
  await waitForChats(page);
  const selected = await currentProjectName(page);
  record(
    "login_opens_protected_area",
    selected === seededName,
    `登录后落到 ${detailPath()}，Project 选择器为 ${JSON.stringify(selected)}`,
  );
});

await check("create_project_switches_to_new_chats", async () => {
  project = await createProject(page, { name: projectName, description: projectDescription });
  const selected = await currentProjectName(page);
  await shot(page, "project-created");
  record(
    "create_project_switches_to_new_chats",
    detailPath() === `${project.path}/chats` && selected === projectName,
    `创建后落到 ${detailPath()}，选择器切到 ${JSON.stringify(selected)}`,
  );
});

await check("project_list_shows_both_projects", async () => {
  // 两个 Project 时 `/projects` 才渲染列表，单 Project 会被直接分发。
  await navigate(page, "/projects");
  await page.waitForSelector('[data-testid="project-list"]', { timeout: 20000 });
  const names = await page.$$eval('[data-testid="project-item-name"]', (nodes) =>
    nodes.map((node) => node.textContent),
  );
  record(
    "project_list_shows_both_projects",
    names.length === 2 && names.includes(seededName) && names.includes(projectName),
    `${detailPath()} 的列表为 ${JSON.stringify(names)}`,
  );
});

await check("settings_shows_fields_and_request_id", async () => {
  await navigate(page, `${project.path}/settings`);
  const facts = await readProjectFacts(page);
  const requestId = /req_[0-9a-f-]{36}/.exec(facts.requestId ?? "")?.[0];
  await shot(page, "project-settings-facts");
  record(
    "settings_shows_fields_and_request_id",
    (facts.id ?? "").includes(project.id) &&
      facts.name === projectName &&
      facts.description === projectDescription &&
      /\d{4}-\d{2}-\d{2}T/.test(facts.createdAt ?? "") &&
      requestId !== undefined &&
      detailPath() === `${project.path}/settings`,
    `Settings 事实 ${JSON.stringify(facts)}`,
  );
});

const settingsUrl = page.url();

await check("reload_keeps_same_project", async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="project-edit-name"]', { timeout: 20000 });
  const name = await page.inputValue('[data-testid="project-edit-name"]');
  record(
    "reload_keeps_same_project",
    name === projectName && page.url() === settingsUrl,
    `刷新后仍是 ${JSON.stringify(name)}，URL ${page.url()}`,
  );
});

await check("project_root_redirects_to_chats", async () => {
  await navigate(page, project.path);
  const landed = await waitForChats(page);
  await shot(page, "project-dispatch-chats");
  record(
    "project_root_redirects_to_chats",
    landed.id === project.id && detailPath() === `${project.path}/chats`,
    `${project.path} 落到 ${detailPath()}`,
  );
});

await check("history_back_and_forward_keep_target", async () => {
  await navigate(page, "/projects");
  await page.waitForSelector('[data-testid="project-list"]', { timeout: 20000 });
  await navigate(page, `${project.path}/settings`);
  await page.waitForSelector('[data-testid="project-settings-id"]', { timeout: 20000 });
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="project-list"]', { timeout: 20000 });
  const listPath = detailPath();
  await page.goForward({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="project-settings-id"]', { timeout: 20000 });
  record(
    "history_back_and_forward_keep_target",
    listPath === "/projects" && page.url() === `${BASE}${project.path}/settings`,
    `后退到 ${listPath}，前进回 ${detailPath()}`,
  );
});

await check("empty_name_shows_field_error_and_request_id", async () => {
  await openCreateDialog(page);
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/_serverFn/"),
  );
  await page.click('[data-testid="project-submit"]');
  const response = await responsePromise;
  await page.waitForSelector('[data-testid="field-error-name"]', { timeout: 20000 });
  const state = await page.evaluate(() => ({
    field: document.querySelector('[data-testid="field-error-name"]')?.textContent,
    error: document.querySelector('[data-testid="project-form-error"]')?.textContent,
    meta: document.querySelector('[data-testid="project-form-error-meta"]')?.textContent,
  }));
  const pageRequestId = state.meta?.match(/req_[0-9a-f-]{36}/)?.[0];
  const headerRequestId = response.headers()["x-sprout-request-id"];
  const diagnostics = await page.evaluate(
    async (requestId) => (await fetch(`/api/diagnostics?requestId=${requestId}`)).json(),
    pageRequestId,
  );
  const diagnosed = diagnostics.data?.some((row) => row.requestId === pageRequestId);
  await shot(page, "project-error");
  record(
    "empty_name_shows_field_error_and_request_id",
    /名称不能为空/.test(state.field ?? "") &&
      /validation_failed/.test(state.meta ?? "") &&
      pageRequestId !== undefined &&
      pageRequestId === headerRequestId &&
      diagnosed === true,
    `字段错误 ${JSON.stringify(state.field)}，页面 requestId ${pageRequestId}、响应头 ${headerRequestId} 与诊断行一致`,
  );
});

await check("long_description_shows_field_error", async () => {
  await page.fill('[data-testid="project-name-input"]', "超长描述样例");
  await page.fill('[data-testid="project-description-input"]', "a".repeat(501));
  await page.click('[data-testid="project-submit"]');
  await page.waitForSelector('[data-testid="field-error-description"]', { timeout: 20000 });
  const field = await page.textContent('[data-testid="field-error-description"]');
  record(
    "long_description_shows_field_error",
    /描述最多 500 字/.test(field ?? ""),
    `描述字段错误 ${JSON.stringify(field)}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="project-form-error"]', {
    state: "detached",
    timeout: 20000,
  });
});

await check("missing_project_shows_not_found", async () => {
  await page.goto(`${BASE}/projects/prj_00000000-0000-4000-8000-000000000000/chats`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector('[data-testid="project-error"]', { timeout: 20000 });
  const state = await page.evaluate(() => ({
    message: document.querySelector('[data-testid="project-error"] p')?.textContent,
    meta: document.querySelector('[data-testid="project-error-meta"]')?.textContent,
  }));
  await shot(page, "project-not-found");
  record(
    "missing_project_shows_not_found",
    /not_found/.test(state.meta ?? "") && /req_[0-9a-f-]{36}/.test(state.meta ?? ""),
    `不存在的 id 显示 ${JSON.stringify(state)}`,
  );
});

await check("signed_out_visit_redirects_to_login", async () => {
  await signOut(page);
  await page.goto(`${BASE}/projects`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 20000 });
  await page.waitForSelector('input[name="email"]', { timeout: 20000 });
  record("signed_out_visit_redirects_to_login", true, `/projects 落到 ${detailPath()}`);
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
