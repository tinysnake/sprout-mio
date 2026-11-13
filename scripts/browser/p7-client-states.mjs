import { chromium } from "playwright";
import { createServer } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { resolve } from "node:path";
import { pass, assert } from "./p7-client-harness.mjs";
import { readDraft } from "./ui-navigation.mjs";
const server = await createServer({
  configFile: false,
  optimizeDeps: { entries: ["tests/fixtures/p7-client-states.html"] },
  resolve: { tsconfigPaths: true },
  plugins: [
    {
      name: "p7-test-action-boundary",
      enforce: "pre",
      resolveId(id) {
        if (/server\/functions\/(?:chat|agent-run|lease|remote|assistant)$/.test(id))
          return resolve("tests/fixtures/p7-client-actions.ts");
      },
    },
    tailwind(),
    react(),
  ],
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 980, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  for (const [action, button] of [
    ["send", "message-send"],
    // 257a222 起群组的停止入口在 RunStatus 的每个 Agent 行上（`agent-run-stop`），
    // composer 的 `run-stop` 只留给 DM；夹具是 group，所以按群组入口验证动作边界。
    ["stop", "agent-run-stop"],
  ]) {
    const pendingLabel = action === "send" ? "发送中" : "停止中…";
    for (const state of ["failure", "unknown", "success"]) {
      await page.goto(base + "tests/fixtures/p7-client-states.html");
      await page.getByTestId(button).waitFor();
      if (action === "send") await page.getByTestId("message-input").fill("retain this draft");
      await page.getByTestId(button).click();
      // 动作不再有独立结果提示条：进行中是按钮自己的字，成功由页面事实表达（消息入列、草稿清空、
      // run 状态刷新），服务端拒绝由 composer 的错误行表达，结果未确认保持沉默。
      assert.equal(await page.getByTestId("send-outcome").count(), 0);
      assert.equal(await page.getByTestId("stop-outcome").count(), 0);
      assert.equal(await page.evaluate(() => window.__p7.calls), 1);
      assert.equal(await page.getByTestId(button).isDisabled(), true);
      assert.equal(
        action === "send"
          ? await page.getByTestId(button).getAttribute("aria-label")
          : (await page.getByTestId(button).innerText()).trim(),
        pendingLabel,
      );
      await page.evaluate((state) => window.__p7.settle(state), state);
      await page.waitForFunction(
        ([label, testId]) => {
          const el = document.querySelector('[data-testid="' + testId + '"]');
          if (!el) return false;
          return testId === "message-send"
            ? el.getAttribute("aria-label") !== label
            : (el.textContent ?? "").trim() !== label;
        },
        [pendingLabel, button],
      );
      if (action === "send") {
        if (state === "success") {
          await page.waitForFunction(
            () =>
              (document.querySelector('[data-testid="message-input"]')?.textContent ?? "") === "",
          );
        } else {
          assert.equal(await readDraft(page), "retain this draft");
          if (state === "failure") await page.getByTestId("message-error").waitFor();
          else assert.equal(await page.getByTestId("message-error").count(), 0);
        }
      } else if (state === "failure") {
        await page.getByTestId("run-stop-error").waitFor();
      } else {
        assert.equal(await page.getByTestId("run-stop-error").count(), 0);
      }
      pass("action_pending_and_outcome_without_notice_row", { action, state });
    }
    await page.goto(base + "tests/fixtures/p7-client-states.html");
    await page.getByTestId(button).waitFor();
    if (action === "send") await page.getByTestId("message-input").fill("offline draft");
    await context.setOffline(true);
    await page.getByTestId("connectivity-status").waitFor();
    assert.match(await page.getByTestId("connectivity-status").innerText(), /离线 · 最后更新/);
    await page.getByTestId(button).click();
    assert.equal(await page.evaluate(() => window.__p7.calls), 0);
    assert.equal(await page.getByTestId("send-outcome").count(), 0);
    assert.equal(await page.getByTestId("stop-outcome").count(), 0);
    if (action === "send") assert.equal(await readDraft(page), "offline draft");
    await context.setOffline(false);
    pass("offline_action_fails_without_submission", { action });
  }
} finally {
  await browser.close();
  await server.close();
}
