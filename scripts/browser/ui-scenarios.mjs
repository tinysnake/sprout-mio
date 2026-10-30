import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.SPROUT_UI_SCENES_URL ?? "http://127.0.0.1:3000/__dev/ui/";
const evidence = process.env.SPROUT_UI_SCENES_EVIDENCE ?? ".verify/ui-scenes";
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
const applicationRequests = [];
const checks = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("request", (request) => {
  const path = new URL(request.url()).pathname;
  if (path.startsWith("/api/") || path.startsWith("/_server")) applicationRequests.push(path);
});
const test = (id) => page.getByTestId(id);
async function open(scene) {
  const url = new URL(base);
  url.searchParams.set("scene", scene);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
}
async function check(name, run) {
  try {
    await run();
    checks.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, passed: false, error: String(error) });
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}

try {
  await check("workspace_routes_isolate_drafts_and_echo_real_message_rows", async () => {
    await open("chat");
    await test("chat-inspector").waitFor({ state: "visible" });
    const rows = test("chat-item");
    assert.equal(await rows.count(), 2);
    const firstId = await rows.nth(0).getAttribute("data-chat-id");
    const secondId = await rows.nth(1).getAttribute("data-chat-id");
    const firstInstance = (await test("inspector-instance-id").textContent()).trim();
    const firstMessages = await test("message-item").count();
    await test("message-input").fill("第一条 Chat 的未发送草稿");
    await page.locator(`[data-testid="chat-item"][data-chat-id="${secondId}"]`).click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector('[data-testid="inspector-copy-chat-id"]')
          ?.getAttribute("data-chat-id") === id,
      secondId,
    );
    assert.equal(await test("message-input").inputValue(), "");
    assert.notEqual((await test("inspector-instance-id").textContent()).trim(), firstInstance);
    assert.equal(await test("inspector-copy-chat-id").getAttribute("data-chat-id"), secondId);
    assert.equal(await test("message-item").count(), 0);
    await test("message-input").fill("第二条 Chat 的本地回显");
    await test("message-send").click();
    await test("message-body").filter({ hasText: "第二条 Chat 的本地回显" }).waitFor();
    assert.equal(await test("message-input").inputValue(), "");
    if (!(await test("info-message-count").isVisible())) {
      await test("chat-inspector").getByText("Chat 事实与成员", { exact: true }).click();
    }
    await test("info-message-count").waitFor({ state: "visible" });
    assert.equal(Number((await test("info-message-count").textContent()).trim()), 1);
    await page.locator(`[data-testid="chat-item"][data-chat-id="${firstId}"]`).click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector('[data-testid="inspector-copy-chat-id"]')
          ?.getAttribute("data-chat-id") === id,
      firstId,
    );
    assert.equal(await test("message-input").inputValue(), "第一条 Chat 的未发送草稿");
    assert.equal(await test("message-item").count(), firstMessages);
    await test("chat-search").fill("仓库首页");
    assert.equal(await rows.count(), 1);
    await test("chat-search").fill("");
    await page.screenshot({ path: join(evidence, "dev-workspace-1440.png") });
  });

  await check("management_links_select_the_profile_in_the_route", async () => {
    await open("agents");
    const row = test("agent-item").nth(1);
    const name = (await row.getByTestId("agent-item-name").textContent()).trim();
    await row.click();
    await test("agent-edit-name").waitFor();
    assert.equal(await test("agent-edit-name").inputValue(), name);
    await test("agent-edit-persona").fill("这段草稿不能进入另一个 profile");
    await test("scene-profile-select").selectOption("0");
    await page.waitForFunction(
      (previous) => document.querySelector('[data-testid="agent-edit-name"]')?.value !== previous,
      name,
    );
    assert.notEqual(
      await test("agent-edit-persona").inputValue(),
      "这段草稿不能进入另一个 profile",
    );
  });

  await check("message_scene_appends_rows_and_stops_the_simulated_run", async () => {
    await open("chat-messages");
    await test("message-input").fill("独立消息场景的本地回显");
    await test("message-send").click();
    await test("message-body").filter({ hasText: "独立消息场景的本地回显" }).waitFor();
    await test("run-stop").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="pi-host-status"]')?.textContent === "已停止",
    );
    assert.equal(await test("message-input").inputValue(), "");
  });

  await check("shared_project_creation_survives_resize_and_restores_focus", async () => {
    await open("chat");
    await test("project-selector").click();
    await test("new-project-trigger").click();
    await test("project-name-input").fill("开发场景跨断点草稿");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await test("project-name-input").inputValue(), "开发场景跨断点草稿");
    await page.keyboard.press("Escape");
    await test("project-name-input").waitFor({ state: "detached" });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-testid") === "mobile-projects",
    );
  });

  await check("chat_scenes_render_in_both_themes_and_mobile_has_full_width", async () => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => localStorage.setItem("sprout:theme", value), theme);
        for (const scene of ["chat", "chat-messages", "chat-states", "chat-inspector"]) {
          await open(scene);
          await page
            .locator(
              scene === "chat" ? '[data-testid="chat-workspace"]' : '[data-testid="chat-scene"]',
            )
            .waitFor();
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          if (scene === "chat") {
            if (width === 390) {
              await test("back-to-chat").click();
              await test("back-to-chats").click();
              await test("chat-list-panel").waitFor({ state: "visible" });
              assert.equal(Math.round((await test("chat-list-panel").boundingBox()).width), width);
            }
            await page.screenshot({ path: join(evidence, `dev-chat-${width}-${theme}.png`) });
          }
        }
      }
    }
  });
  await check("fixtures_make_no_application_requests_and_have_no_console_errors", async () => {
    assert.deepEqual(applicationRequests, []);
    assert.deepEqual(errors, []);
  });
} finally {
  writeFileSync(
    join(evidence, "scenarios-verification.json"),
    JSON.stringify({ base, checks, errors, applicationRequests }, null, 2) + "\n",
  );
  await browser.close();
}
if (checks.some((check) => !check.passed)) process.exitCode = 1;
