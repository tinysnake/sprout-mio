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
          if (request.url !== "/") return next();
          try {
            const html = await dev.transformIndexHtml(
              "/",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>P6a pages gate</title><link rel="stylesheet" href="/src/styles.css"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/p6a-pages-client.tsx"></script></body></html>',
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
  console.error("P6a browser gate exceeded 120s");
  process.exit(1);
}, 120_000);
try {
  await server.listen();
  const address = server.httpServer!.address();
  assert(address && typeof address !== "string");
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "networkidle" });
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of p6aCases) {
      await page.getByTestId("fixture-case").selectOption(name);
      const card = page.getByTestId("automation-card");
      await card.waitFor();
      assert((await card.innerText()).includes("自动接续"));
      pass(`${width}_${name}_copy`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      pass(`${width}_${name}_no_horizontal_scroll`);
      const scopeBox = await page.getByTestId("automation-scope").boundingBox();
      const cardBox = await card.boundingBox();
      assert(scopeBox && cardBox && scopeBox.width >= cardBox.width - 40);
      pass(`${width}_${name}_scope_occupies_own_row`);
      assert(await page.getByRole("button", { name: "保存判定器", exact: true }).isDisabled());
      pass(`${width}_${name}_provider_disabled`);
      if (name === "off") {
        assert((await card.innerText()).includes("自动接续不会来"));
        assert(await page.getByRole("button", { name: "开启自动接续", exact: true }).isEnabled());
        pass(`${width}_${name}_human_can_enable`);
        assert(
          await page
            .getByTestId("automation-mode")
            .evaluate(
              (element) =>
                getComputedStyle(element).color ===
                getComputedStyle(document.querySelector('[data-testid="automation-scope"]')!).color,
            ),
        );
        pass(`${width}_${name}_human_control_uses_neutral_color`);
      }
      if (name === "idle") {
        assert((await card.innerText()).includes("当前无活动 run"));
        assert((await card.innerText()).includes("当前没有安排下次自动检查"));
        pass(`${width}_three_independent_facts`);
        const stopRun = page.getByRole("button", { name: "停止这个运行", exact: true });
        assert(await stopRun.isDisabled());
        assert(await stopRun.evaluate((button) => Number(getComputedStyle(button).opacity) >= 0.6));
        assert(
          await stopRun.evaluate(
            (button) =>
              getComputedStyle(button).color ===
              getComputedStyle(document.querySelector('[data-testid="automation-mode"]')!).color,
          ),
        );
        pass(`${width}_disabled_stop_run_readable`);
      }
      if (name === "failure") {
        assert(
          (await page.getByTestId("automation-failure").innerText()).includes("provider_timeout"),
        );
        assert((await page.getByTestId("automation-backoff").innerText()).includes("失败退避"));
        pass(`${width}_failure_and_backoff`);
      }
      if (name === "human") {
        assert.equal(await page.getByTestId("automation-run-facts").count(), 0);
        assert((await card.innerText()).includes("已展示接续提醒"));
        pass(`${width}_human_without_run_bar`);
      }
      if (name === "denied") {
        assert(await page.getByRole("button", { name: "暂停自动接续", exact: true }).isDisabled());
        assert(
          (await page.getByTestId("automation-disable-denial").innerText()).includes(
            "当前身份无权关闭此 Chat 的自动接续",
          ),
        );
        assert(
          (await page.getByTestId("automation-disable-denial").innerText()).includes("forbidden"),
        );
        pass(`${width}_denial_reason_and_code`);
      }
      if (name === "unknown") {
        assert((await card.innerText()).includes("不会自动重投"));
        await page.getByRole("button", { name: "人工补发…", exact: true }).click();
        assert((await card.innerText()).includes("可能造成重复处理"));
        assert.equal(await page.getByTestId("last-command").innerText(), "");
        await page.getByRole("button", { name: "确认补发", exact: true }).click();
        await page.getByRole("group", { name: "确认自动接续操作" }).waitFor({ state: "hidden" });
        const command = JSON.parse(await page.getByTestId("last-command").innerText());
        assert.equal(command.action, "reissue");
        assert.equal(command.confirmedUnknown, true);
        pass(`${width}_unknown_requires_explicit_confirmation`);
      }
      await page.screenshot({ path: resolve(evidence, `${width}-${name}.png`), fullPage: true });
    }
    await page.getByTestId("fixture-case").selectOption("idle");
    await page.getByRole("button", { name: "暂停自动接续", exact: true }).click();
    await page.getByText("自动接续已关闭", { exact: true }).waitFor();
    assert(
      (await page.getByTestId("automation-expectation").innerText()).includes("自动接续不会来"),
    );
    assert.equal(JSON.parse(await page.getByTestId("last-command").innerText()).action, "disable");
    pass(`${width}_disable_contract_and_read_response`);
    await page.getByRole("button", { name: "开启自动接续", exact: true }).click();
    await page.getByText("自动接续已启用", { exact: true }).waitFor();
    assert(
      (await page.getByTestId("automation-expectation").innerText()).includes("已安排下次自动检查"),
    );
    assert.equal(JSON.parse(await page.getByTestId("last-command").innerText()).action, "enable");
    pass(`${width}_enable_contract_and_read_response`);
    await page.getByRole("button", { name: "全部停止", exact: true }).click();
    assert.equal(JSON.parse(await page.getByTestId("last-command").innerText()).action, "enable");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert((await page.getByTestId("automation-mode").innerText()).includes("已启用"));
    pass(`${width}_abort_can_cancel_without_write`);
    await page.getByRole("button", { name: "全部停止", exact: true }).click();
    await page.getByRole("button", { name: "确认全部停止", exact: true }).click();
    await page.getByText("自动接续已关闭", { exact: true }).waitFor();
    const abort = JSON.parse(await page.getByTestId("last-command").innerText());
    assert.equal(abort.action, "abort");
    assert.equal("runId" in abort, false);
    pass(`${width}_abort_without_run_id_closes_the_chat`);
    await page.getByTestId("fixture-case").selectOption("scheduled");
    await page.getByLabel("模拟写入冲突").check();
    await page.getByRole("button", { name: "暂停自动接续", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert((await page.getByRole("alert").innerText()).includes("conflict"));
    assert((await page.getByTestId("automation-mode").innerText()).includes("已启用"));
    pass(`${width}_conflict_does_not_pretend_disabled`);
  }
  assert.deepEqual(pageErrors, []);
  pass("pageerror_zero");
  assert.deepEqual(consoleErrors, []);
  pass("console_error_zero");
  console.log(`P6a pages: ${checks} assertion groups passed. Evidence: ${evidence}`);
} finally {
  clearTimeout(timer);
  await browser.close();
  await server.close();
}
