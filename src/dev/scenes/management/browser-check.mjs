// 管理页场景的浏览器核对：浅暗主题、390 / 1440 宽度、真实交互与错误状态。
// 运行：先起 dev server，再
//   SCENE_URL=http://localhost:3061/__dev/ui/ node src/dev/scenes/management/browser-check.mjs
// 默认指向统一 gallery 宿主（`src/dev/ui/`，按 `?scene=` 选择场景）。
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.SCENE_URL ?? "http://localhost:3061/__dev/ui/";
const EVIDENCE = process.env.SCENE_EVIDENCE ?? "/tmp/ui-migrate-management/";
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

async function open({ scene, width = 1440, height = 900, colorScheme = "light" }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme,
  });
  const page = await context.newPage();
  if (colorScheme === "dark")
    await page.addInitScript(() => {
      try {
        localStorage.setItem("sprout:theme", "dark");
      } catch {
        /* Storage is optional. */
      }
    });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  const url = new URL(BASE);
  url.searchParams.set("scene", scene);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  return { context, page, errors };
}

async function shot(page, name) {
  // 对话框和遮罩有进入动画；截图前等动画结束，避免把半透明中间帧当成最终外观。
  await page.waitForTimeout(240);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: false });
}

const test = (page, id) => page.locator(`[data-testid="${id}"]`);

await check("login_light_desktop", async () => {
  const { context, page, errors } = await open({ scene: "login" });
  await test(page, "auth-title").waitFor();
  await shot(page, "light-1440-login");
  const inputs = await page.locator("form input").count();
  record(
    "login_light_desktop",
    inputs === 2 && errors.length === 0,
    `${inputs} 个输入，${errors.length} 条控制台错误`,
  );
  await context.close();
});

await check("login_register_mode_and_error", async () => {
  const { context, page } = await open({ scene: "login", width: 390, height: 844 });
  await test(page, "register-tab").click();
  await page.locator("#name").waitFor();
  await page.locator("#name").fill("林澈");
  await page.locator("#email").fill("lin@example.com");
  await page.locator("#password").fill("SproutMio2026");
  await shot(page, "light-390-login-register");
  await test(page, "scene-fail").check();
  await test(page, "auth-submit").click();
  await test(page, "auth-error").waitFor({ timeout: 5000 });
  const text = await test(page, "auth-error").innerText();
  await shot(page, "light-390-login-error");
  record(
    "login_register_mode_and_error",
    /邮箱或密码不正确/.test(text) && /req_/.test(text),
    "注册模式渲染姓名输入，失败展示错误与 requestId",
  );
  await context.close();
});

await check("agents_list_and_create", async () => {
  const { context, page, errors } = await open({ scene: "agents" });
  await test(page, "agent-list").waitFor();
  const count = await page.locator('[data-testid="agent-item"]').count();
  await shot(page, "light-1440-agents");
  await test(page, "new-agent-trigger").click();
  await test(page, "agent-name-input").fill("验收助手");
  await test(page, "agent-job-title-input").fill("只做验收");
  await test(page, "agent-persona-input").fill("先给结论，再给证据。");
  await shot(page, "light-1440-agents-create-dialog");
  await test(page, "agent-submit").click();
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="agent-name-input"]'),
    undefined,
    { timeout: 8000 },
  );
  const after = await page.locator('[data-testid="agent-item"]').count();
  record(
    "agents_list_and_create",
    count === 3 && after === 4 && errors.length === 0,
    `列表 ${count} 条，创建后 ${after} 条`,
  );
  await context.close();
});

await check("agent_persona_dirty_and_failure_keeps_input", async () => {
  const { context, page } = await open({ scene: "agent-detail" });
  await test(page, "agent-edit-persona").waitFor();
  const disabledBefore = await test(page, "agent-edit-save").isDisabled();
  await test(page, "agent-edit-persona").fill("新的验收人设");
  const disabledAfter = await test(page, "agent-edit-save").isDisabled();
  await test(page, "scene-fail").check();
  await test(page, "agent-edit-save").click();
  await test(page, "agent-edit-error").waitFor({ timeout: 8000 });
  const kept = await test(page, "agent-edit-persona").inputValue();
  await shot(page, "light-1440-agent-detail-failure");
  await test(page, "scene-fail").uncheck();
  await test(page, "agent-edit-save").click();
  await test(page, "agent-edit-saved").waitFor({ timeout: 8000 });
  const savedText = await test(page, "agent-edit-saved").innerText();
  await shot(page, "light-1440-agent-detail-saved");
  record(
    "agent_persona_dirty_and_failure_keeps_input",
    disabledBefore && !disabledAfter && kept === "新的验收人设" && /下一轮生效/.test(savedText),
    `无改动禁用=${disabledBefore}，改动后可保存=${!disabledAfter}，失败保留输入，成功提示「${savedText}」`,
  );
  await context.close();
});

await check("agent_option_fields_configurable", async () => {
  const { context, page } = await open({ scene: "agent-detail" });
  await test(page, "agent-edit-job-title").waitFor();

  // 空配置：从「使用默认」切到「自定义」后必须能输入新值，不被固定候选项挡住。
  const modeBefore = await test(page, "agent-edit-model").inputValue();
  await test(page, "agent-edit-model").selectOption("custom");
  await test(page, "agent-edit-model-custom").fill("demo-model-x");
  const disabledAfterTyping = await test(page, "agent-edit-save").isDisabled();

  // 失败保留输入：错误后自定义值仍在。
  await test(page, "scene-fail").check();
  await test(page, "agent-edit-save").click();
  await test(page, "agent-edit-error").waitFor({ timeout: 8000 });
  const keptAfterFailure = await test(page, "agent-edit-model-custom").inputValue();
  await test(page, "scene-fail").uncheck();
  await test(page, "agent-edit-save").click();
  await test(page, "agent-edit-saved").waitFor({ timeout: 8000 });
  const savedModel = await test(page, "agent-edit-model-custom").inputValue();

  // 换到已有配置的 profile：草稿必须是该对象自己的值，不是上一个对象的残留。
  await test(page, "scene-profile-select").selectOption("2");
  await test(page, "agent-edit-effort-custom").waitFor();
  const effortMode = await test(page, "agent-edit-effort").inputValue();
  const effortValue = await test(page, "agent-edit-effort-custom").inputValue();
  const otherModel = await test(page, "agent-edit-model-custom").inputValue();
  const cleanStart = await test(page, "agent-edit-save").isDisabled();

  // 已存值可以继续改，也可以清空回默认。
  await test(page, "agent-edit-effort").selectOption("default");
  const effortCleared = await test(page, "agent-edit-effort-custom").count();
  const disabledAfterClear = await test(page, "agent-edit-save").isDisabled();
  await shot(page, "light-1440-agent-options");
  record(
    "agent_option_fields_configurable",
    modeBefore === "default" &&
      !disabledAfterTyping &&
      keptAfterFailure === "demo-model-x" &&
      savedModel === "demo-model-x" &&
      effortMode === "custom" &&
      effortValue === "high" &&
      otherModel === "claude-sonnet" &&
      cleanStart &&
      effortCleared === 0 &&
      !disabledAfterClear,
    `空值→自定义 ${savedModel} 保存成功；切到另一 profile 得到其自身 ${otherModel}/${effortValue}，可清空回默认`,
  );
  await context.close();
});

await check("members_add_and_remove", async () => {
  const { context, page, errors } = await open({ scene: "members" });
  await test(page, "member-list").waitFor();
  const before = await page.locator('[data-testid="member-item"]').count();
  await test(page, "add-member-submit").click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="member-item"]').length === n + 1,
    before,
    { timeout: 8000 },
  );
  const feedback = await test(page, "members-feedback").innerText();
  await shot(page, "light-1440-members");
  await page.locator('[data-testid="member-remove"]').first().click();
  await test(page, "confirm-member-mutation").waitFor();
  await shot(page, "light-1440-members-remove-dialog");
  await test(page, "confirm-member-mutation").click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="member-item"]').length === n,
    before,
    { timeout: 8000 },
  );
  record(
    "members_add_and_remove",
    /已添加/.test(feedback) && errors.length === 0,
    `成员 ${before} → ${before + 1} → ${before}，提示「${feedback}」`,
  );
  await context.close();
});

await check("members_failure_keeps_member", async () => {
  const { context, page } = await open({ scene: "members", width: 390, height: 844 });
  await test(page, "member-list").waitFor();
  await shot(page, "light-390-members");
  const before = await page.locator('[data-testid="member-item"]').count();
  await test(page, "scene-fail").check();
  await page.locator('[data-testid="member-remove"]').first().click();
  await test(page, "confirm-member-mutation").click();
  await test(page, "members-error").first().waitFor({ timeout: 8000 });
  const after = await page.locator('[data-testid="member-item"]').count();
  await shot(page, "light-390-members-remove-error");
  record(
    "members_failure_keeps_member",
    before === after,
    `移除失败后成员仍为 ${after} 条，错误按 code + requestId 呈现`,
  );
  await context.close();
});

await check("members_without_profiles_still_removable", async () => {
  const { context, page } = await open({ scene: "members" });
  await test(page, "member-list").waitFor();
  await test(page, "scene-profiles-missing").check();
  await test(page, "add-member-select").isDisabled();
  await page.locator('[data-testid="member-remove"]').first().click();
  await test(page, "confirm-member-mutation").waitFor();
  const dialogText = await page.locator('[data-slot="dialog-content"]').innerText();
  await shot(page, "light-1440-members-without-profiles");
  await test(page, "cancel-member-mutation").click();
  record(
    "members_without_profiles_still_removable",
    /agp_/.test(dialogText),
    `profile 查询失败时移除仍有确认对象，确认框回退显示 profile ID`,
  );
  await context.close();
});

await check("members_remove_error_renders_once", async () => {
  const { context, page } = await open({ scene: "members" });
  await test(page, "member-list").waitFor();
  await test(page, "scene-fail").check();
  await page.locator('[data-testid="member-remove"]').first().click();
  await test(page, "confirm-member-mutation").click();
  await test(page, "members-error").first().waitFor({ timeout: 8000 });
  const count = await page.locator('[data-testid="members-error"]').count();
  record(
    "members_remove_error_renders_once",
    count === 1,
    `移除失败时 members-error 节点数=${count}（只在确认框内）`,
  );
  await test(page, "cancel-member-mutation").click();
  await context.close();
});

await check("settings_facts_and_sections", async () => {
  const { context, page, errors } = await open({ scene: "settings" });
  await test(page, "project-settings-id").waitFor();
  const id = await test(page, "project-settings-id").innerText();
  const createdAt = await test(page, "project-settings-created-at").innerText();
  const requestId = await test(page, "project-settings-request-id").innerText();
  const iso = await page
    .locator('[data-testid="project-settings-created-at"] time')
    .getAttribute("dateTime");
  await shot(page, "light-1440-settings");
  await test(page, "settings-info-hub").click();
  await test(page, "info-hub-project-agents").waitFor();
  await test(page, "info-hub-machines-notice").waitFor();
  await shot(page, "light-1440-settings-info-hub");
  record(
    "settings_facts_and_sections",
    id.startsWith("prj_") &&
      iso?.endsWith("Z") === true &&
      requestId.startsWith("req_") &&
      errors.length === 0,
    `ID=${id}，创建时间文本「${createdAt}」保留 ISO ${iso}，requestId=${requestId}`,
  );
  await context.close();
});

await check("settings_save_disabled_until_dirty", async () => {
  const { context, page } = await open({ scene: "settings" });
  await test(page, "project-edit-name").waitFor();
  const beforeDisabled = await test(page, "project-edit-save").isDisabled();
  await test(page, "project-edit-name").fill("Sprout 重构 2");
  const afterDisabled = await test(page, "project-edit-save").isDisabled();
  await test(page, "project-edit-save").click();
  await test(page, "project-edit-saved").waitFor({ timeout: 8000 });
  record(
    "settings_save_disabled_until_dirty",
    beforeDisabled && !afterDisabled,
    `无改动禁用=${beforeDisabled}，改动后可保存=${!afterDisabled}`,
  );
  await context.close();
});

await check("settings_dark_wide", async () => {
  const { context, page } = await open({
    scene: "settings",
    width: 1440,
    height: 900,
    colorScheme: "dark",
  });
  await test(page, "project-settings-id").waitFor();
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  await shot(page, "dark-1440-settings");
  record("settings_dark_wide", dark, `暗色类=${dark}`);
  await context.close();
});

await check("agents_dark_mobile", async () => {
  const { context, page } = await open({
    scene: "agents",
    width: 390,
    height: 844,
    colorScheme: "dark",
  });
  await test(page, "agent-list").waitFor();
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  await shot(page, "dark-390-agents");
  record("agents_dark_mobile", dark && overflow <= 1, `暗色=${dark}，横向溢出=${overflow}px`);
  await context.close();
});

await check("login_dark_mobile", async () => {
  const { context, page } = await open({
    scene: "login",
    width: 390,
    height: 844,
    colorScheme: "dark",
  });
  await test(page, "auth-title").waitFor();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  await shot(page, "dark-390-login");
  record("login_dark_mobile", overflow <= 1, `横向溢出=${overflow}px`);
  await context.close();
});

await browser.close();
const failed = results.filter((item) => !item.passed);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
