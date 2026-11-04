import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";
import { p6aCases } from "./p6a-pages";

const evidence = resolve(process.env.SPROUT_P6A_EVIDENCE ?? "/tmp/sprout-p6a-pages-evidence");
await mkdir(evidence, { recursive: true });
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { tsconfigPaths: true },
  cacheDir: "node_modules/.vite-p6a-pages",
  optimizeDeps: { entries: ["tests/fixtures/p6a-pages-client.tsx"] },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    tailwindcss(),
    react(),
    {
      name: "p6a-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use(async (request, response, next) => {
          if (!request.url || !(request.url === "/" || request.url.startsWith("/projects/")))
            return next();
          try {
            const html = await dev.transformIndexHtml(
              "/",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>P6b pages gate</title><link rel="stylesheet" href="/src/styles.css"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/p6a-pages-client.tsx"></script></body></html>',
            );
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          } catch (cause) {
            next(cause);
          }
        });
      },
    },
  ],
});
let checks = 0;
const pass = (name: string) => {
  checks++;
  console.log(`PASS ${name}`);
};
const browser = await chromium.launch();
const timer = setTimeout(() => {
  console.error("P6b browser gate exceeded 120s");
  process.exit(1);
}, 120_000);
try {
  await server.listen();
  const address = server.httpServer!.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const page = await browser.newPage();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const pageErrors: string[] = [],
    consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const noOverflow = async (label: string) => {
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    pass(`${label}_no_horizontal_scroll`);
  };
  const copyLinkButton = page.getByRole("button", {
    name: "复制此页链接",
    exact: true,
    includeHidden: true,
  });
  const checkRoundLinks = async (label: string, latestHref: string, reload: boolean) => {
    // 当前轮次的标记由 TanStack Router 的 Link 活动态给出（aria-current="page"，
    // 样式按 [aria-current] 选择），不再由组件手写 aria-current。
    const rail = page.getByRole("navigation", { name: "最近 5 轮" });
    const historyHref = latestHref.replace(/evaluation-(current|failure)/, "evaluation-history");
    assert.equal(await rail.getByRole("link").count(), 2);
    assert.equal(await rail.getByRole("link", { name: /#2/ }).getAttribute("href"), latestHref);
    assert.equal(await rail.getByRole("link", { name: /#1/ }).getAttribute("href"), historyHref);
    assert.equal(await rail.locator('[aria-current="page"]').getAttribute("href"), latestHref);
    pass(`${label}_rail_each_round_has_own_evaluation_link`);
    await rail.getByRole("link", { name: /#1/ }).click();
    await page.getByRole("heading", { name: "检查轮次 #1", exact: true }).waitFor();
    assert.equal(page.url(), base + historyHref);
    assert.equal(await rail.locator('[aria-current="page"]').getAttribute("href"), historyHref);
    assert((await rail.getByRole("link", { name: /#1/ }).innerText()).includes("当前查看 ↓"));
    assert(await copyLinkButton.isEnabled());
    assert(
      !(await page.getByTestId("continuation-diagnostic").innerText()).includes(
        "不能作为本轮的独立链接",
      ),
    );
    pass(`${label}_historical_link_changes_url_body_current_step_and_copy`);
    await noOverflow(`${label}_history`);
    if (reload) {
      await page.reload();
      await page.getByRole("heading", { name: "检查轮次 #1", exact: true }).waitFor();
      assert.equal(page.url(), base + historyHref);
      pass(`${label}_historical_deep_link_survives_reload`);
      if (await copyLinkButton.isVisible()) {
        await copyLinkButton.click();
        await page.getByRole("status").filter({ hasText: "链接已复制" }).waitFor();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), base + historyHref);
        pass(`${label}_copy_writes_historical_deep_link`);
      }
      await rail.getByRole("link", { name: /#2/ }).focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      assert(
        await rail.getByRole("link", { name: /#2/ }).evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            element.matches(":focus-visible") &&
            style.outlineStyle === "solid" &&
            parseFloat(style.outlineWidth) >= 2
          );
        }),
      );
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "检查轮次 #2", exact: true }).waitFor();
      assert.equal(page.url(), base + latestHref);
      pass(`${label}_rail_keyboard_focus_and_navigation`);
    }
    await rail.getByRole("link", { name: /#2/ }).click();
    await page.getByRole("heading", { name: "检查轮次 #2", exact: true }).waitFor();
    assert.equal(page.url(), base + latestHref);
    assert(await copyLinkButton.isEnabled());
    pass(`${label}_latest_round_return_link_and_copy`);
  };
  for (const width of [1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of p6aCases) {
      await page.goto(base);
      await page.getByTestId("fixture-case").selectOption(name);
      const hub = page.getByTestId("continuation-panel");
      assert.equal(await hub.locator("a").count(), 2);
      assert.equal(await hub.locator("details,button").count(), 0);
      const wakeHref = await hub.getByRole("link", { name: /唤醒判定/ }).getAttribute("href");
      const continuationHref = await hub
        .getByRole("link", { name: /对话接续/ })
        .getAttribute("href");
      assert(
        wakeHref &&
          continuationHref &&
          wakeHref.replace(/wake$/, "continuation") === continuationHref,
      );
      pass(`${width}_${name}_hub_two_latest_links_no_expansion`);
      await noOverflow(`${width}_${name}_hub`);
      await hub.getByRole("link", { name: /唤醒判定/ }).click();
      const wake = page.getByTestId("wake-diagnostic");
      await wake.waitFor();
      assert(page.url().endsWith(wakeHref));
      assert.equal(await page.getByRole("tab").count(), 0);
      assert.equal(await page.getByTestId("continuation-card").count(), 0);
      assert(!(await wake.innerText()).includes("查看最近五轮"));
      assert(
        (
          await page.getByRole("heading", { name: "检查轮次 #2", exact: true }).innerText()
        ).includes("#2"),
      );
      pass(`${width}_${name}_wake_url_body_no_tabs_or_bottom_link`);
      await noOverflow(`${width}_${name}_wake`);
      if (name === "failure") {
        const failure = page.getByTestId("continuation-failure");
        assert.equal(await failure.getAttribute("data-error-code"), "provider_timeout");
        assert((await failure.innerText()).includes("判定服务没有及时回应"));
        assert((await page.getByTestId("continuation-backoff").innerText()).includes("失败退避"));
        await page.getByRole("button", { name: "重试检查", exact: true }).click();
        const retry = JSON.parse(await page.getByTestId("last-command").innerText());
        assert.equal(retry.action, "retry");
        assert.equal(retry.evaluationId, "evaluation-failure");
        pass(`${width}_failure_backoff_retry_contract`);
      }
      if (name === "running") {
        assert((await page.getByTestId("wake-elapsed").innerText()).includes("已等待"));
        pass(`${width}_running_has_elapsed`);
      }
      await page.screenshot({
        path: resolve(evidence, `${width}-${name}-wake.png`),
        fullPage: true,
      });
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await noOverflow(`${width}_${name}_wake_dark`);
      await page.screenshot({
        path: resolve(evidence, `${width}-${name}-wake-dark.png`),
        fullPage: true,
      });
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      await checkRoundLinks(`${width}_${name}_wake`, wakeHref, name === "idle");
      await page.goto(base + continuationHref);
      const card = page.getByTestId("continuation-card");
      await card.waitFor();
      assert.equal(await page.getByTestId("wake-diagnostic").count(), 0);
      assert.equal(await page.getByRole("tab").count(), 0);
      pass(`${width}_${name}_continuation_url_body_no_tabs`);
      await checkRoundLinks(`${width}_${name}_continuation`, continuationHref, name === "idle");
      await noOverflow(`${width}_${name}_continuation`);
      const scopeBox = await page.getByTestId("continuation-scope").boundingBox(),
        cardBox = await card.boundingBox();
      assert(scopeBox && cardBox && scopeBox.width >= cardBox.width - 50);
      pass(`${width}_${name}_scope_occupies_own_row`);
      assert.equal(await page.getByRole("button", { name: "保存判定器", exact: true }).count(), 0);
      assert((await page.getByTestId("wake-provider-unwired").innerText()).includes("暂不能更改"));
      pass(`${width}_${name}_provider_unwired_copy`);
      if (name === "off") {
        assert((await card.innerText()).includes("对话接续不会来"));
        assert(await page.getByRole("button", { name: "重新启用", exact: true }).isEnabled());
        pass(`${width}_${name}_human_can_enable`);
        assert(
          await page
            .getByTestId("continuation-mode")
            .evaluate(
              (element) =>
                getComputedStyle(element).color ===
                getComputedStyle(document.querySelector('[data-testid="continuation-card"]')!)
                  .color,
            ),
        );
        pass(`${width}_${name}_human_control_uses_neutral_color`);
      }
      if (name === "idle") {
        assert((await card.innerText()).includes("当前无活动 run"));
        assert((await card.innerText()).includes("当前没有安排下次自动检查"));
        assert.equal(
          await page.getByRole("button", { name: "只停止此 run", exact: true }).count(),
          0,
        );
        pass(`${width}_three_independent_facts_no_fake_run_stop`);
      }
      if (name === "human") {
        assert.equal(await page.getByTestId("continuation-run-facts").count(), 0);
        assert((await card.innerText()).includes("已展示接续提醒"));
        pass(`${width}_human_without_run_bar`);
      }
      if (name === "denied") {
        assert.equal(
          await page.getByRole("button", { name: "暂停对话接续", exact: true }).count(),
          0,
        );
        assert(!(await card.innerText()).includes("forbidden"));
        pass(`${width}_denied_action_hidden`);
      }
      if (name === "unknown") {
        assert((await card.innerText()).includes("不会自动重投"));
        await page.getByRole("button", { name: "只停止此 run", exact: true }).click();
        const single = JSON.parse(await page.getByTestId("last-command").innerText());
        assert.equal(single.action, "abort");
        assert.equal(single.runId, "run_aaaaaaaa");
        assert((await page.getByTestId("continuation-mode").innerText()).includes("已启用"));
        pass(`${width}_single_run_abort_preserves_policy`);
        await page.getByRole("button", { name: "人工补发…", exact: true }).click();
        assert((await page.getByRole("dialog").innerText()).includes("可能造成重复处理"));
        assert.equal(
          JSON.parse(await page.getByTestId("last-command").innerText()).action,
          "abort",
        );
        await page.getByRole("button", { name: "确认补发", exact: true }).click();
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        await page.locator('[data-testid="continuation-card"][aria-busy="false"]').waitFor();
        assert(await page.getByRole("button", { name: "暂停对话接续", exact: true }).isEnabled());
        const command = JSON.parse(await page.getByTestId("last-command").innerText());
        assert.equal(command.action, "reissue");
        assert.equal(command.confirmedUnknown, true);
        pass(`${width}_unknown_requires_explicit_confirmation`);
      }
      await page.screenshot({
        path: resolve(evidence, `${width}-${name}-continuation.png`),
        fullPage: true,
      });
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await noOverflow(`${width}_${name}_dark`);
      const contrast = await card.evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(document.body).backgroundColor,
      }));
      assert.notEqual(contrast.foreground, contrast.background);
      await page.screenshot({
        path: resolve(evidence, `${width}-${name}-dark.png`),
        fullPage: true,
      });
    }
    await page.getByTestId("fixture-case").selectOption("idle");
    await page.getByRole("button", { name: "暂停对话接续", exact: true }).click();
    await page.getByText("对话接续已关闭", { exact: true }).waitFor();
    assert(
      (await page.getByTestId("continuation-expectation").innerText()).includes("对话接续不会来"),
    );
    assert.equal(JSON.parse(await page.getByTestId("last-command").innerText()).action, "disable");
    pass(`${width}_disable_contract_and_read_response`);
    await page.getByRole("button", { name: "重新启用", exact: true }).click();
    await page.getByText("对话接续已启用", { exact: true }).waitFor();
    assert(
      (await page.getByTestId("continuation-expectation").innerText()).includes(
        "已安排下次自动检查",
      ),
    );
    assert.equal(JSON.parse(await page.getByTestId("last-command").innerText()).action, "enable");
    pass(`${width}_enable_contract_and_read_response`);
    await page.getByRole("button", { name: "全部停止", exact: true }).click();
    assert.equal(JSON.parse(await page.getByTestId("last-command").innerText()).action, "enable");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert((await page.getByTestId("continuation-mode").innerText()).includes("已启用"));
    pass(`${width}_abort_can_cancel_without_write`);
    await page.getByRole("button", { name: "全部停止", exact: true }).click();
    await page.getByRole("button", { name: "确认全部停止", exact: true }).click();
    await page.getByText("对话接续已关闭", { exact: true }).waitFor();
    const abort = JSON.parse(await page.getByTestId("last-command").innerText());
    assert.equal(abort.action, "abort");
    assert.equal("runId" in abort, false);
    pass(`${width}_abort_without_run_id_closes_the_chat`);
    await page.getByTestId("fixture-case").selectOption("scheduled");
    await page.getByLabel("模拟写入冲突").check();
    await page.getByRole("button", { name: "暂停对话接续", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("alert").getAttribute("data-error-code"), "conflict");
    assert.equal(/conflict/.test(await page.getByRole("alert").innerText()), false);
    assert((await page.getByTestId("continuation-mode").innerText()).includes("已启用"));
    pass(`${width}_conflict_does_not_pretend_disabled`);
    await page.goto(base + "/projects/prj_aaaaaaaa/chats/cnv_aaaaaaaa/checks/expired/wake");
    await page.getByTestId("diagnostic-round-missing").waitFor();
    assert(
      (await page.getByTestId("diagnostic-round-missing").innerText()).includes(
        "这一轮不在最近 5 轮里",
      ),
    );
    assert(await copyLinkButton.isDisabled());
    assert.equal(
      await page.getByRole("navigation", { name: "最近 5 轮" }).getByRole("link").count(),
      2,
    );
    assert.equal(await page.getByTestId("wake-diagnostic").count(), 0);
    pass(`${width}_unknown_round_has_explicit_state`);
  }
  assert.deepEqual(pageErrors, []);
  pass("pageerror_zero");
  assert.deepEqual(consoleErrors, []);
  pass("console_error_zero");
  console.log(`P6b pages: ${checks} assertion groups passed. Evidence: ${evidence}`);
} finally {
  clearTimeout(timer);
  await browser.close();
  await server.close();
}
