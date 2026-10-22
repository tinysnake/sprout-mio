// 真实接入核对：在真实 dev server + 真实 SQLite 上走登录、Agent、Members、Settings。
// 运行：先起 dev server（真实数据库），再
//   APP_URL=http://localhost:3061 node src/dev/scenes/management/real-flow-check.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.APP_URL ?? "http://localhost:3061";
const EVIDENCE = process.env.APP_EVIDENCE ?? "/tmp/ui-migrate-management/real/";
const stamp = Date.now().toString(36);
const email = `u3-${stamp}@example.com`;
const password = "SproutMio2026";
const results = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}

async function check(name, run) {
  try {
    await run();
  } catch (error) {
    record(name, false, `threw ${error.message}`);
  }
}

mkdirSync(EVIDENCE, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

const test = (id) => page.locator(`[data-testid="${id}"]`);
// 对话框和遮罩有进入动画；截图前等动画结束，避免把半透明中间帧当成最终外观。
const shot = async (name) => {
  await page.waitForTimeout(240);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
};

let projectId = "";
await check("register_and_land_on_project", async () => {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await test("auth-title").waitFor();
  await test("register-tab").click();
  await page.locator("#name").fill("UI 迁移验收");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await shot("01-login-register");
  await test("auth-submit").click();
  // 注册会播种一个 Project，因此 /projects 直接分发到它的 Chats；只等最终地址，
  // 不等中间的 /projects，否则会在分发完成前取不到 projectId。
  await page.waitForURL((url) => /^\/projects\/[^/]+\/chats/.test(url.pathname), {
    timeout: 20000,
  });
  await test("app-shell").waitFor();
  // 侧栏会记住最近打开的 Project；URL 与这条偏好必须指向同一个对象。
  await page.waitForFunction(() => location.pathname.startsWith("/projects/"), undefined, {
    timeout: 20000,
  });
  projectId = await page.evaluate(() => {
    const fromPath = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
    return fromPath ?? localStorage.getItem("sprout:last-project") ?? "";
  });
  if (!projectId) throw new Error(`无法确定 Project：${page.url()}`);
  await shot("02-registered-project-chats");
  record(
    "register_and_land_on_project",
    projectId.startsWith("prj_"),
    `注册后落到 ${new URL(page.url()).pathname}`,
  );
});

await check("seeded_project_agents", async () => {
  await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded" });
  await test("agent-list").waitFor();
  const names = await page.locator('[data-testid="agent-item-name"]').allInnerTexts();
  await shot("03-agents-list");
  record(
    "seeded_project_agents",
    names.includes("Amenda"),
    `Project ${projectId}，Agent ${JSON.stringify(names)}`,
  );
});

await check("create_agent_and_open_detail", async () => {
  const name = `验收 Agent ${stamp}`;
  await test("new-agent-trigger").click();
  await test("agent-name-input").fill(name);
  await test("agent-job-title-input").fill("只做验收");
  await test("agent-persona-input").fill("先给结论，再给依据。");
  await shot("04-agents-create");
  await test("agent-submit").click();
  await page.waitForFunction(
    (value) =>
      [...document.querySelectorAll('[data-testid="agent-item-name"]')].some(
        (node) => node.textContent === value,
      ),
    name,
    { timeout: 20000 },
  );
  await page.click(`[data-testid="agent-item-name"] >> text=${name}`);
  await test("agent-detail-name").waitFor();
  await test("agent-detail-id").waitFor();
  const id = (await test("agent-detail-id").innerText()).trim();
  const disabledBefore = await test("agent-edit-save").isDisabled();
  const note = await test("agent-edit-note").innerText();
  await test("agent-edit-persona").fill("验收后的人设，下一轮生效。");
  const disabledAfter = await test("agent-edit-save").isDisabled();
  await test("agent-edit-save").click();
  await test("agent-edit-saved").waitFor({ timeout: 20000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await test("agent-edit-persona").waitFor();
  const afterReload = await test("agent-edit-persona").inputValue();
  await shot("05-agent-detail-reloaded");
  record(
    "create_agent_and_open_detail",
    id.startsWith("agp_") &&
      disabledBefore &&
      !disabledAfter &&
      /下一轮运行生效/.test(note) &&
      afterReload === "验收后的人设，下一轮生效。" &&
      (await test("agent-detail-id").innerText()).trim() === id,
    `profile ${id}，刷新后人设与 ID 保持一致`,
  );
  page.agentProfileId = id;
  page.agentName = name;
});

await check("profile_options_configurable_and_object_isolated", async () => {
  const firstId = page.agentProfileId;
  // 空配置 → 自定义 model → 保存 → 再清空，全部走真实 updateAgentProfile。
  await page.goto(`${BASE}/agents/${firstId}`, { waitUntil: "domcontentloaded" });
  await test("agent-edit-model").waitFor();
  const modeBefore = await test("agent-edit-model").inputValue();
  await test("agent-edit-model").selectOption("custom");
  await test("agent-edit-model-custom").fill("demo-model-z");
  await test("agent-edit-save").click();
  await test("agent-edit-saved").waitFor({ timeout: 20000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await test("agent-edit-model-custom").waitFor({ timeout: 20000 });
  const persisted = await test("agent-edit-model-custom").inputValue();
  await test("agent-edit-model").selectOption("default");
  await test("agent-edit-save").click();
  await test("agent-edit-saved").waitFor({ timeout: 20000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await test("agent-edit-model").waitFor({ timeout: 20000 });
  const cleared = await test("agent-edit-model").inputValue();
  const clearedInput = await test("agent-edit-model-custom").count();
  await shot("06-agent-options-cleared");

  // 对象隔离：在第一个 profile 留下草稿，切到另一个 profile，草稿必须换成对方的。
  await test("agent-edit-persona").fill("不应带到别的 profile");
  await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded" });
  await test("agent-list").waitFor();
  const otherLabel = await page.locator('[data-testid="agent-item-name"]').nth(0).innerText();
  await page.click(`[data-testid="agent-item-name"] >> text=${otherLabel}`);
  await test("agent-edit-persona").waitFor();
  const secondId = (await test("agent-detail-id").innerText()).trim();
  const secondPersona = await test("agent-edit-persona").inputValue();
  await page.goto(`${BASE}/agents/${firstId}`, { waitUntil: "domcontentloaded" });
  await test("agent-edit-persona").waitFor();
  const backToFirst = await test("agent-edit-persona").inputValue();
  record(
    "profile_options_configurable_and_object_isolated",
    modeBefore === "default" &&
      persisted === "demo-model-z" &&
      cleared === "default" &&
      clearedInput === 0 &&
      secondId !== firstId &&
      secondPersona !== "不应带到别的 profile" &&
      backToFirst === "验收后的人设，下一轮生效。",
    `自定义 model 持久化=${persisted}，已清空回默认；切到 ${secondId} 得到其自身草稿，返回 ${firstId} 恢复自身值`,
  );
});

await check("profile_server_validation_is_reachable", async () => {
  // 走服务端边界：清空名称后提交，服务端应返回字段错误而不是本地静默拦截。
  await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded" });
  await test("new-agent-trigger").click();
  await test("agent-name-input").fill("   ");
  await test("agent-job-title-input").fill("x".repeat(41));
  await test("agent-submit").click();
  await test("agent-form-error").waitFor({ timeout: 20000 });
  const meta = await test("agent-form-error-meta").innerText();
  // Field 把字段错误渲染成与控件关联的 role="alert"，这里按文案断言而不是内部 id。
  const nameError = await page
    .locator('[data-slot="dialog-content"] [role="alert"]')
    .first()
    .innerText();
  await shot("07-agent-server-validation");
  record(
    "profile_server_validation_is_reachable",
    /validation_failed/.test(meta) && /名称不能为空/.test(nameError),
    `服务端字段校验可达：${nameError} / ${meta}`,
  );
  await page.locator('[data-slot="dialog-close"]').first().click();
});

await check("members_add_open_agent_and_remove", async () => {
  await page.goto(`${BASE}/projects/${projectId}/members`, { waitUntil: "domcontentloaded" });
  await test("member-list").waitFor();
  const agentName = page.agentName;
  await test("add-member-trigger").click();
  await test("add-member-select").selectOption({ label: agentName });
  await test("add-member-submit").click();
  await page.waitForFunction(
    (value) =>
      [...document.querySelectorAll('[data-testid="member-item-name"]')].some(
        (node) => node.textContent === value,
      ),
    agentName,
    { timeout: 20000 },
  );
  await shot("08-members-with-agent");
  await page.reload({ waitUntil: "domcontentloaded" });
  await test("member-list").waitFor();
  const persisted = await page.evaluate(
    (value) =>
      [...document.querySelectorAll('[data-testid="member-item-name"]')].some(
        (node) => node.textContent === value,
      ),
    agentName,
  );
  await page.click(`[data-testid="member-item-name"] >> text=${agentName}`);
  await test("agent-detail-id").waitFor();
  const openedId = (await test("agent-detail-id").innerText()).trim();
  await page.goBack({ waitUntil: "domcontentloaded" });
  await test("member-list").waitFor();
  await page.click(`[data-testid="member-remove"][data-agent-profile-id="${page.agentProfileId}"]`);
  await test("confirm-member-mutation").waitFor();
  await shot("09-members-remove-confirm");
  await test("confirm-member-mutation").click();
  await page.waitForFunction(
    (value) =>
      ![...document.querySelectorAll('[data-testid="member-item-name"]')].some(
        (node) => node.textContent === value,
      ),
    agentName,
    { timeout: 20000 },
  );
  const feedback = await test("members-feedback").innerText();
  record(
    "members_add_open_agent_and_remove",
    persisted && openedId === page.agentProfileId && /已从 Project 移除/.test(feedback),
    `加入后刷新仍在，成员行打开 ${openedId}，移除提示「${feedback}」`,
  );
});

await check("settings_real_facts_and_save", async () => {
  await page.goto(`${BASE}/projects/${projectId}/settings`, { waitUntil: "domcontentloaded" });
  await test("project-settings-id").waitFor();
  const id = (await test("project-settings-id").innerText()).trim();
  const iso = await page
    .locator('[data-testid="project-settings-created-at"] time')
    .getAttribute("dateTime");
  const requestId = (await test("project-settings-request-id").innerText()).trim();
  await shot("10-settings-facts");
  await test("project-info-hub-toggle").click();
  await test("info-hub-project-agents").waitFor();
  const infoVisible = await test("info-hub-project-agents").isVisible();
  await test("info-hub-machines-notice").waitFor();
  await shot("11-settings-info-hub-expanded");
  const newName = `验收改名 ${stamp}`;
  const disabledBefore = await test("project-edit-save").isDisabled();
  await test("project-edit-name").fill(newName);
  await test("project-edit-save").click();
  await test("project-edit-saved").waitFor({ timeout: 20000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await test("project-edit-name").waitFor();
  const reloadedName = await test("project-edit-name").inputValue();
  const selectorName = await test("project-selector").innerText();
  await shot("12-settings-after-rename");
  record(
    "settings_real_facts_and_save",
    id === projectId &&
      /^\d{4}-\d{2}-\d{2}T/.test(iso ?? "") &&
      requestId.startsWith("req_") &&
      infoVisible &&
      disabledBefore &&
      reloadedName === newName &&
      selectorName.includes(newName),
    `ID 一致，ISO ${iso}，requestId ${requestId}，Info Hub 实际展开=${infoVisible}，改名后刷新与选择器同步`,
  );
});

await check("create_project_server_validation_is_reachable", async () => {
  await page.goto(`${BASE}/projects`, { waitUntil: "domcontentloaded" });
  await test("app-shell").waitFor();
  // 恰好一个 Project 时 /projects 分发到 Chats，此时从 Project 选择器里创建。
  if (new URL(page.url()).pathname !== "/projects") {
    await test("project-selector").click();
  }
  await test("new-project-trigger").click();
  await test("project-name-input").fill("   ");
  await test("project-submit").click();
  await test("project-form-error").waitFor({ timeout: 20000 });
  const meta = await test("project-form-error-meta").innerText();
  const fieldError = await page
    .locator('[data-slot="dialog-content"] [role="alert"]')
    .first()
    .innerText();
  // 超长描述同样必须真的请求到服务端，由 500 字规则拒绝。
  await test("project-name-input").fill(`超长描述校验 ${stamp}`);
  await test("project-description-input").fill("长".repeat(501));
  await test("project-submit").click();
  await test("project-form-error").waitFor({ timeout: 20000 });
  const descriptionError = await page
    .locator('[data-slot="dialog-content"] [role="alert"]')
    .first()
    .innerText();
  await shot("13-project-server-validation");
  record(
    "create_project_server_validation_is_reachable",
    /validation_failed/.test(meta) &&
      /名称不能为空/.test(fieldError) &&
      /描述最多 500 字/.test(descriptionError),
    `空名称 → ${fieldError}；501 字描述 → ${descriptionError}（码 ${meta}）`,
  );
  await page.locator('[data-slot="dialog-close"]').first().click();
});

await check("settings_page_has_no_global_header", async () => {
  const header = await page.locator("body > header").count();
  record("settings_page_has_no_global_header", header === 0, `body 直属 header 数=${header}`);
});

await check("no_console_errors", async () => {
  record("no_console_errors", errors.length === 0, `${errors.length} 条控制台/页面错误`);
});

await browser.close();
const failed = results.filter((item) => !item.passed);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
