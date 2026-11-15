import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { waitForChats } from "./ui-navigation.mjs";

const BASE = process.env.BASE_URL;
const database = process.env.DATABASE_URL;
assert(BASE && database, "Set BASE_URL and DATABASE_URL to the isolated test instance");
const evidence = resolve(process.env.SPROUT_UI_EVIDENCE_DIR ?? ".verify/crew-rail/evidence");
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: `${evidence}/video`, size: { width: 1440, height: 1000 } },
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const results = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
async function check(name, action) {
  await action();
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
try {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("register-tab").click();
  await page.locator('input[name="name"]').fill("Crew rail gate");
  await page.locator('input[name="email"]').fill(`crew-rail-${Date.now()}@example.test`);
  await page.locator('input[name="password"]').fill(`${randomBytes(18).toString("hex")}aA1!`);
  await page.locator('button[type="submit"]').click();
  const project = await waitForChats(page);
  const seeded = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/browser/crew-rail-seed.ts"],
    {
      env: { ...process.env, CREW_RAIL_PROJECT_ID: project.id },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(seeded.status, 0, seeded.stderr || String(seeded.error));
  const fixture = JSON.parse(seeded.stdout.trim().split("\n").at(-1));
  writeFileSync(`${evidence}/fixture.json`, JSON.stringify(fixture, null, 2));
  const parentPath = `/projects/${project.id}/chats/${fixture.crewChatId}`;
  const rail = page.getByTestId("crew-rail");
  const toggle = page.getByTestId("crew-rail-toggle");
  await page.goto(`${BASE}${parentPath}`, { waitUntil: "domcontentloaded" });
  await check("cards_counts_and_sections", async () => {
    await rail.waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="crew-rail-toggle"]')
          ?.getAttribute("aria-expanded") === "true",
    );
    assert.equal(await rail.locator('[data-testid="crew-card"]:visible').count(), 3);
    assert.match(await toggle.innerText(), /进行中 1/);
    assert.match(await toggle.innerText(), /需处理 2/);
    for (const label of ["进行中的委派", "非进行中的委派"])
      assert.equal(await rail.getByRole("region", { name: label, exact: true }).count(), 1);
    const initialStatuses = await rail
      .locator('[data-testid="crew-card-status"]:visible')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          text: node.textContent,
          status: node.getAttribute("data-status"),
          className: node.className,
        })),
      );
    assert.deepEqual(
      initialStatuses.map((item) => item.text).sort(),
      ["已完成", "需要你", "进行中"].sort(),
    );
    const running = initialStatuses.find((item) => item.status === "running");
    assert.match(running.className, /text-status-success/);
    assert.match(
      initialStatuses.find((item) => item.status === "completed").className,
      /text-status-success/,
    );
    assert.match(
      initialStatuses.find((item) => item.status === "blocked").className,
      /text-status-warning/,
    );
    assert.equal(await rail.getByTestId("crew-card-pulse").count(), 1);
    assert.equal(
      await page.locator('[data-testid="chat-list"] [data-chat-kind="delegation"]').count(),
      0,
    );
    assert.equal(await page.locator(`[data-chat-id="${fixture.childChatId}"]`).count(), 0);
    await page.screenshot({ path: `${evidence}/wide-expanded.png`, fullPage: true });
  });
  await check("history_collapses_by_active_slots", async () => {
    const history = page.getByTestId("crew-history-toggle");
    await history.waitFor();
    assert.match(await history.innerText(), /历史委派/);
    assert.match(await history.innerText(), /4/);
    assert.equal(await history.getAttribute("aria-expanded"), "false");
    await history.click();
    assert.equal(await history.getAttribute("aria-expanded"), "true");
    assert.match(await history.innerText(), /收起历史委派/);
    assert.equal(await rail.locator('[data-testid="crew-card"]:visible').count(), 7);
    const expandedStatuses = await rail
      .locator('[data-testid="crew-card-status"]:visible')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          status: node.getAttribute("data-status"),
          text: node.textContent,
          className: node.className,
        })),
      );
    const failed = expandedStatuses.find((item) => item.status === "failed");
    const canceled = expandedStatuses.find((item) => item.text === "已取消");
    assert.match(failed.className, /text-status-failed/);
    assert.match(canceled.className, /text-muted-foreground/);
    await page.screenshot({ path: `${evidence}/wide-history-expanded.png`, fullPage: true });
  });
  let anchor;
  await check("open_child_and_return_to_parent_anchor", async () => {
    // 200 条父消息（4 页），先把锚点滚到旧页，确保它不在返回时的首屏 50 条里。
    // 读满 4 页：目标放在最旧页，距最新页 3 页，超出窗口 2 页的保留半径。
    for (const target of [100, 150, 200]) {
      await page.getByTestId("message-history").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.waitForFunction(
        (count) => document.querySelectorAll("[data-message-id]").length >= count,
        target,
      );
    }
    await page.getByTestId("message-history").evaluate((element) => {
      const rows = [...element.querySelectorAll("[data-message-id]")];
      const row = rows[20];
      element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top;
    });
    await page.waitForTimeout(200);
    const saved = await page.getByTestId("message-history").evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const rows = [...element.querySelectorAll("[data-message-id]")];
      const row = rows.find((item) => item.getBoundingClientRect().bottom > top);
      return {
        anchor: { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top },
        recent: rows.slice(-50).map((item) => item.dataset.messageId),
      };
    });
    assert.equal(saved.recent.includes(saved.anchor.id), false);
    anchor = saved.anchor;
    await rail.getByTestId("crew-card-open").filter({ hasText: "整理验收记录" }).click();
    await page.waitForURL((url) => url.pathname.endsWith(`/chats/${fixture.childChatId}`));
    await page.getByTestId("delegation-parent-link").waitFor();
    await page.getByTestId("crew-rail").waitFor({ state: "detached" });
    assert.equal(await page.getByTestId("crew-rail").count(), 0);
    assert.equal(
      await page.locator('[data-testid="chat-list"] [data-chat-kind="delegation"]').count(),
      0,
    );
    await page.getByTestId("delegation-parent-link").click();
    await page.waitForURL((url) => url.pathname === parentPath);
    await page.waitForFunction((expected) => {
      const scroll = document.querySelector('[data-testid="message-history"]');
      const row = [...scroll.querySelectorAll("[data-message-id]")].find(
        (item) => item.dataset.messageId === expected.id,
      );
      return (
        row &&
        Math.abs(
          row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - expected.offset,
        ) < 4
      );
    }, anchor);
    // 恢复后再来一条 live 消息：窗口按恢复后的 anchor 收敛，不能把目标页裁掉。
    const appended = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/browser/crew-rail-append.ts"],
      {
        env: {
          ...process.env,
          CREW_RAIL_PROJECT_ID: project.id,
          CREW_RAIL_CREW_ID: fixture.crewChatId,
        },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.equal(appended.status, 0, appended.stderr || String(appended.error));
    // 进程内 change feed 收不到另一个进程写的消息，只能等安全轮询；上限 15s，留足请求耗时。
    // anchor 若仍停在最新页，这一轮 settle 会裁掉目标页。
    await page.waitForTimeout(22000);
    assert.equal(
      await page.evaluate(
        (expected) =>
          [...document.querySelectorAll("[data-message-id]")].some(
            (item) => item.dataset.messageId === expected.id,
          ),
        anchor,
      ),
      true,
    );
  });
  await check("collapse_survives_reload_and_width_change", async () => {
    await toggle.click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}${parentPath}?info=1`, { waitUntil: "domcontentloaded" });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await page.screenshot({ path: `${evidence}/narrow-collapsed.png`, fullPage: true });
  });
  await check("narrow_default_and_explicit_choice", async () => {
    await page.evaluate((id) => localStorage.removeItem(`sprout:crew-rail:${id}`), project.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await toggle.click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="crew-rail-toggle"]')
          ?.getAttribute("aria-expanded") === "true",
    );
  });
  await check("storage_failure_keeps_explicit_choice_on_resize", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${BASE}${parentPath}`, { waitUntil: "domcontentloaded" });
    await toggle.waitFor();
    await page.evaluate(() => {
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) {
        if (String(key).startsWith("sprout:crew-rail:"))
          throw new DOMException("denied", "SecurityError");
        return get.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (String(key).startsWith("sprout:crew-rail:"))
          throw new DOMException("denied", "SecurityError");
        return set.call(this, key, value);
      };
    });
    const before = await toggle.getAttribute("aria-expanded");
    await toggle.click();
    const chosen = await toggle.getAttribute("aria-expanded");
    assert.notEqual(chosen, before);
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.waitForTimeout(200);
    assert.equal(await toggle.getAttribute("aria-expanded"), chosen);
  });
  await check("storage_read_failure_uses_width_default", async () => {
    await page.addInitScript(() => {
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) {
        if (String(key).startsWith("sprout:crew-rail:"))
          throw new DOMException("denied", "SecurityError");
        return get.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (String(key).startsWith("sprout:crew-rail:"))
          throw new DOMException("denied", "SecurityError");
        return set.call(this, key, value);
      };
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${BASE}${parentPath}`, { waitUntil: "domcontentloaded" });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.waitForTimeout(200);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  });
  await check("dm_keeps_session_details_without_rail", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${BASE}/projects/${project.id}/chats/${fixture.dmChatId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("chat-details").waitFor();
    assert.equal(await page.getByTestId("crew-rail").count(), 0);
    assert.match(await page.getByTestId("chat-details").innerText(), /会话详情/);
  });
  assert.deepEqual(errors, [], "browser page errors");
} catch (error) {
  results.push({ name: "gate", passed: false, error: error.stack });
  console.error(error);
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(
    `${evidence}/results.json`,
    JSON.stringify({ results, pageErrors: errors }, null, 2),
  );
  await context.close();
  await browser.close();
}
