// 真实 Chromium 走完 Project 的创建、刷新、历史导航、错误态与登出重定向，每步打印 PASS/FAIL。
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EVIDENCE = new URL("../../docs/p1/evidence/", import.meta.url).pathname;

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
const detailPath = () => new URL(page.url()).pathname;

// 登录后先落到首页，再通过首页的入口进入受保护的 Project 列表。
async function enterProjects() {
  await page.waitForURL((url) => url.pathname === "/", { timeout: 20000 });
  await page.click('[data-testid="open-projects"]');
  await page.waitForURL((url) => url.pathname === "/projects", { timeout: 20000 });
}

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[name="email"]', { timeout: 20000 });

await check("register_sets_session", async () => {
  await page.click("text=没有账号？注册");
  await page.fill('input[name="name"]', "Project 验收");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await enterProjects();
  await page.waitForSelector('[data-testid="project-list"]', { timeout: 20000 });
  record("register_sets_session", true, `注册后经首页落到 ${detailPath()}`);
});

await check("sign_out_returns_to_login", async () => {
  await page.click('[data-testid="sign-out"]');
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 20000 });
  record("sign_out_returns_to_login", true, `登出后落到 ${detailPath()}`);
});

await check("login_opens_protected_area", async () => {
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await enterProjects();
  await page.waitForSelector('[data-testid="project-empty"]', { timeout: 20000 });
  record("login_opens_protected_area", true, `登录后经首页落到 ${detailPath()}，列表为空`);
});

await check("create_project_appears_in_list", async () => {
  await page.click('[data-testid="new-project-trigger"]');
  await page.fill('[data-testid="project-name-input"]', projectName);
  await page.fill('[data-testid="project-description-input"]', "浏览器验收创建的分层样例");
  await shot(page, "project-create-dialog");
  await page.click('[data-testid="project-submit"]');
  await page.waitForSelector('[data-testid="project-item"]', { timeout: 20000 });
  const names = await page.$$eval('[data-testid="project-item-name"]', (nodes) =>
    nodes.map((node) => node.textContent),
  );
  await shot(page, "project-created");
  record(
    "create_project_appears_in_list",
    names.includes(projectName),
    `列表包含 ${JSON.stringify(names)}`,
  );
});

await check("open_detail_shows_fields_and_request_id", async () => {
  await page.click('[data-testid="project-item-name"]');
  await page.waitForSelector('[data-testid="project-detail-name"]', { timeout: 20000 });
  const detail = await page.evaluate(() => ({
    name: document.querySelector('[data-testid="project-detail-name"]')?.textContent,
    description: document.querySelector('[data-testid="project-detail-description"]')?.textContent,
    createdAt: document.querySelector('[data-testid="project-detail-created-at"]')?.textContent,
    requestId: document.querySelector('[data-testid="project-detail-request-id"]')?.textContent,
    path: location.pathname,
  }));
  await shot(page, "project-detail");
  record(
    "open_detail_shows_fields_and_request_id",
    detail.name === projectName &&
      detail.description === "浏览器验收创建的分层样例" &&
      /^\d{4}-\d{2}-\d{2}T/.test(detail.createdAt ?? "") &&
      /^req_[0-9a-f-]{36}$/.test(detail.requestId ?? "") &&
      detail.path.startsWith("/projects/prj_"),
    `详情 ${JSON.stringify(detail)}`,
  );
});

const projectUrl = page.url();

await check("reload_keeps_same_project", async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="project-detail-name"]', { timeout: 20000 });
  const name = await page.textContent('[data-testid="project-detail-name"]');
  record(
    "reload_keeps_same_project",
    name?.trim() === projectName && page.url() === projectUrl,
    `刷新后仍是 ${name?.trim()}，URL ${page.url()}`,
  );
});

await check("history_back_and_forward_keep_target", async () => {
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="project-list"]', { timeout: 20000 });
  const listPath = detailPath();
  await page.goForward({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="project-detail-name"]', { timeout: 20000 });
  record(
    "history_back_and_forward_keep_target",
    listPath === "/projects" && page.url() === projectUrl,
    `后退到 ${listPath}，前进回 ${detailPath()}`,
  );
});

await check("empty_name_shows_field_error_and_request_id", async () => {
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="new-project-trigger"]', { timeout: 20000 });
  await page.click('[data-testid="new-project-trigger"]');
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
  await page.goto(`${BASE}/projects/prj_00000000-0000-4000-8000-000000000000`, {
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
  await page.click('[data-testid="sign-out"]');
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 20000 });
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
