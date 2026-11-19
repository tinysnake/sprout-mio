import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { readDraft } from "./ui-navigation.mjs";

const base = process.env.SPROUT_UI_SCENES_URL ?? "http://127.0.0.1:3000/__dev/ui/";
const evidence = process.env.SPROUT_UI_SCENES_EVIDENCE ?? ".verify/ui-scenes";
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ["notifications"],
});
// 系统通知没有可读回执，换成可记录的构造器，才能断言「当前对话不弹浏览器通知」。
await context.addInitScript(() => {
  window.__chatNotifications = [];
  class RecordingNotification {
    static permission = "granted";
    static requestPermission = () => Promise.resolve("granted");
    constructor(title, options) {
      window.__chatNotifications.push({ title, options });
    }
    close() {}
  }
  window.Notification = RecordingNotification;
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
const dialogs = [];
const applicationRequests = [];
const checks = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("dialog", async (dialog) => {
  dialogs.push(dialog.message());
  await dialog.dismiss();
});
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("request", (request) => {
  const path = new URL(request.url()).pathname;
  if (path.startsWith("/api/") || path.startsWith("/_server")) applicationRequests.push(path);
});
const test = (id) => page.getByTestId(id);
const ACTIVE_CHAT_ID = "cnv_44444444";
const UNREAD_CHAT_ID = "cnv_55555555";
const activeItem = () =>
  page.locator(`[data-testid="chat-item"][data-chat-id="${ACTIVE_CHAT_ID}"]`);
const activeBadge = () => activeItem().locator('[data-testid="chat-unread-badge"]');
// HTML 沙箱 iframe 的高度是异步上报的，等它落定再滚，否则滚动位置会被后续增长推离底部。
const waitForSettledHtmlBlock = () =>
  page.waitForFunction(() => {
    const frame = document.querySelector('[data-testid="html-block"]');
    return frame !== null && frame.getBoundingClientRect().height > 240;
  });
const waitForThreadAtBottom = () =>
  page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="message-history"]');
    return element.scrollHeight - element.scrollTop - element.clientHeight < 4;
  });
// 只靠程序化设 scrollTop，容器的 onScroll 还没跑完就按下模拟按钮，会读到过期的置底状态；
// 用真实滚轮触发滚动，再多等两帧让 React 把 atBottom 提交完。
const settleFrames = () =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
      ),
  );
const scrollThreadTo = async (where) => {
  await test("message-history").hover();
  await page.mouse.wheel(0, where === "top" ? -200000 : 200000);
  await page.waitForFunction((target) => {
    const element = document.querySelector('[data-testid="message-history"]');
    return target === "top"
      ? element.scrollTop < 1
      : element.scrollHeight - element.scrollTop - element.clientHeight < 4;
  }, where);
  await settleFrames();
};
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
        document.querySelector('[data-testid="inspector-chat-id"]')?.textContent?.trim() === id,
      secondId,
    );
    assert.equal(await readDraft(page), "");
    assert.notEqual((await test("inspector-instance-id").textContent()).trim(), firstInstance);
    assert.equal((await test("inspector-chat-id").textContent()).trim(), secondId);
    assert.equal(await test("message-item").count(), 0);
    await test("message-input").fill("第二条 Chat 的本地回显");
    await test("message-send").click();
    await test("message-body").filter({ hasText: "第二条 Chat 的本地回显" }).waitFor();
    assert.equal(await readDraft(page), "");
    if (!(await test("info-message-count").isVisible())) {
      await test("chat-inspector").getByText("Chat 事实与成员", { exact: true }).click();
    }
    await test("info-message-count").waitFor({ state: "visible" });
    assert.equal(Number((await test("info-message-count").textContent()).trim()), 1);
    await page.locator(`[data-testid="chat-item"][data-chat-id="${firstId}"]`).click();
    await page.waitForFunction(
      (id) =>
        document.querySelector('[data-testid="inspector-chat-id"]')?.textContent?.trim() === id,
      firstId,
    );
    assert.equal(await readDraft(page), "第一条 Chat 的未发送草稿");
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
    assert.equal(await readDraft(page), "");
  });

  await check("html_messages_sanitize_inline_markup_and_sandbox_full_documents", async () => {
    await open("chat");
    await test("message-item").first().waitFor();
    const items = test("message-item");
    assert.equal(await items.locator("script").count(), 0);
    assert.equal(await items.locator("[onerror]").count(), 0);
    assert.deepEqual(dialogs, []);
    const block = test("html-block");
    await block.waitFor();
    assert.equal(await block.getAttribute("sandbox"), "allow-scripts");
    const source = (await block.getAttribute("srcdoc")) ?? "";
    assert(source.includes("<!doctype html>"));
    assert(source.includes("Content-Security-Policy"));
    assert(source.includes('id="sprout-artifact-theme"'));
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-testid="html-block"]');
      return frame !== null && frame.getBoundingClientRect().height > 240;
    });
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
  await check("chat_unread_badge_and_new_message_toast_can_be_dismissed", async () => {
    // 上一条 check 会把视口留在 390px；窄屏下选中对话时列表是隐藏的，先回到桌面宽度。
    await page.setViewportSize({ width: 1440, height: 900 });
    await open("chat");
    await test("chat-list").waitFor({ state: "visible" });
    const badge = test("chat-unread-badge");
    await badge.first().waitFor({ state: "visible" });
    assert.equal(await badge.first().getAttribute("data-unread-count"), "2");

    await test("dev-simulate-message").click();
    const toast = test("chat-toast");
    await toast.first().waitFor({ state: "visible" });
    assert.match((await toast.first().textContent()) ?? "", /模拟的新消息/);
    await page.screenshot({ path: join(evidence, "chat-unread-toast.png") });

    const counts = await badge.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-unread-count")),
    );
    assert.ok(counts.includes("3"), `expected an unread count of 3, got ${counts.join(",")}`);

    await test("chat-toast-close").first().click();
    await toast.first().waitFor({ state: "detached" });
    // 其他对话来新消息仍然发浏览器通知。
    assert.equal(await page.evaluate(() => window.__chatNotifications.length), 1);
  });

  await check("chat_at_bottom_marks_new_message_read_without_hint_or_toast", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open("chat");
    await test("chat-list").waitFor({ state: "visible" });
    await waitForSettledHtmlBlock();
    await test("dev-fill-thread").click();
    await test("message-item").last().waitFor();
    await scrollThreadTo("bottom");
    await test("dev-simulate-active-message").click();
    // 贴底时新消息可见：自动滚到底，不出现提示，角标清掉，也不弹提醒。
    await waitForThreadAtBottom();
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="message-history"]');
      const items = element.querySelectorAll('[data-testid="message-item"]');
      const last = items[items.length - 1];
      return last.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1;
    });
    assert.equal(await test("new-messages-jump").count(), 0);
    await page.waitForFunction(
      (id) =>
        document.querySelector(
          `[data-testid="chat-item"][data-chat-id="${id}"] [data-testid="chat-unread-badge"]`,
        ) === null,
      ACTIVE_CHAT_ID,
    );
    assert.equal(await test("chat-toast").count(), 0);
    assert.equal(await page.evaluate(() => window.__chatNotifications.length), 0);
    await page.screenshot({ path: join(evidence, "chat-unread-at-bottom.png") });
  });

  await check("chat_scrolled_up_shows_hint_and_badge_but_no_toast_for_active_chat", async () => {
    await open("chat");
    await test("chat-list").waitFor({ state: "visible" });
    await waitForSettledHtmlBlock();
    await test("dev-fill-thread").click();
    await test("message-item").last().waitFor();
    await scrollThreadTo("top");
    await test("dev-simulate-active-message").click();
    // 离开底部后当前对话来新消息：只出现页面内提示与角标，不弹 toast / 浏览器通知。
    const jump = test("new-messages-jump");
    await jump.waitFor({ state: "visible" });
    assert.equal((await jump.textContent()).trim(), "有新消息 · 回到最新");
    await activeBadge().waitFor({ state: "visible" });
    assert.equal(await test("chat-toast").count(), 0);
    assert.equal(await page.evaluate(() => window.__chatNotifications.length), 0);
    await page.screenshot({ path: join(evidence, "chat-unread-scrolled-up.png") });
    // 点提示回到底部：角标清零、提示消失。
    await jump.click();
    await waitForThreadAtBottom();
    await jump.waitFor({ state: "detached" });
    await activeBadge().waitFor({ state: "detached" });
  });

  await check("chat_scrolled_up_without_unread_shows_no_hint", async () => {
    await open("chat");
    await test("chat-list").waitFor({ state: "visible" });
    await waitForSettledHtmlBlock();
    await test("dev-fill-thread").click();
    await test("message-item").last().waitFor();
    await scrollThreadTo("top");
    assert.equal(await test("new-messages-jump").count(), 0);
  });
  await check("chat_list_hint_appears_for_unread_outside_the_list_viewport", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open("chat");
    await test("chat-list").waitFor({ state: "visible" });
    const hint = test("chat-list-unread-hint");
    // 列表短时未读项就在可见区内：没有总体提示。
    assert.equal(await hint.count(), 0);
    assert.equal(await test("chat-unread-badge").count(), 1);

    await test("dev-fill-chat-list").click();
    assert.equal(await test("chat-item").count(), 22);
    const scroll = test("chat-list-scroll");
    const scrollToBottom = async () => {
      await scroll.hover();
      await page.mouse.wheel(0, 200000);
      await page.waitForFunction(() => {
        const element = document.querySelector('[data-testid="chat-list-scroll"]');
        return element.scrollHeight - element.scrollTop - element.clientHeight < 4;
      });
    };
    await scrollToBottom();
    // 未读项滚出可见框：出现总体提示，文案只有「有新消息」，不带数量。
    await hint.waitFor({ state: "visible" });
    assert.equal((await hint.textContent()).trim(), "有新消息");
    await page.screenshot({ path: join(evidence, "chat-list-unread-hint.png") });

    // 可见框外的未读集合变化后提示仍然成立。
    await test("dev-simulate-message").click();
    await hint.waitFor({ state: "visible" });

    // 点提示滚到最近活动的不可见未读项；它进入可见框后提示自然消失。
    await hint.click();
    await page.waitForFunction((id) => {
      const view = document
        .querySelector('[data-testid="chat-list-scroll"]')
        .getBoundingClientRect();
      const item = document
        .querySelector(`[data-testid="chat-item"][data-chat-id="${id}"]`)
        .getBoundingClientRect();
      return item.top >= view.top - 1 && item.bottom <= view.bottom + 1;
    }, UNREAD_CHAT_ID);
    await hint.waitFor({ state: "detached" });
    await page.screenshot({ path: join(evidence, "chat-list-unread-hint-jumped.png") });

    await scrollToBottom();
    await hint.waitFor({ state: "visible" });
  });
  await check("chat_list_hint_stays_inside_a_narrow_list_column", async () => {
    // 列表列宽 < 200（类型筛选行隐藏）时提示占类型行那一档并居中，不挤掉搜索行里的铃铛与新建。
    // 1000 宽带 inspector 时列表列宽 180：只覆盖这条窄布局分支。
    await page.setViewportSize({ width: 1000, height: 900 });
    await open("chat");
    await test("chat-list").waitFor({ state: "visible" });
    assert.equal(await test("chat-type-filters").isVisible(), false);
    const panel = await test("chat-list-content").boundingBox();
    assert.ok(panel.width < 200);

    await test("dev-fill-chat-list").click();
    const hint = test("chat-list-unread-hint");
    const scroll = test("chat-list-scroll");
    await scroll.hover();
    await page.mouse.wheel(0, 200000);
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="chat-list-scroll"]');
      return element.scrollHeight - element.scrollTop - element.clientHeight < 4;
    });
    await hint.waitFor({ state: "visible" });
    assert.equal(await hint.count(), 1);
    const box = await hint.boundingBox();
    assert.ok(box.x >= panel.x && box.x + box.width <= panel.x + panel.width);
    await page.screenshot({ path: join(evidence, "chat-list-unread-hint-narrow.png") });

    await hint.click();
    await page.waitForFunction((id) => {
      const view = document
        .querySelector('[data-testid="chat-list-scroll"]')
        .getBoundingClientRect();
      const item = document
        .querySelector(`[data-testid="chat-item"][data-chat-id="${id}"]`)
        .getBoundingClientRect();
      return item.top >= view.top - 1 && item.bottom <= view.bottom + 1;
    }, UNREAD_CHAT_ID);
    await hint.waitFor({ state: "detached" });
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
