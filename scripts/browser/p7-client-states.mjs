import { chromium } from "playwright";
import { createServer } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { resolve } from "node:path";
import { pass, assert } from "./p7-client-harness.mjs";
const server = await createServer({
  configFile: false,
  optimizeDeps: { entries: ["tests/fixtures/p7-client-states.html"] },
  resolve: { tsconfigPaths: true },
  plugins: [
    {
      name: "p7-test-action-boundary",
      enforce: "pre",
      resolveId(id) {
        if (/server\/functions\/(?:chat|agent-run|lease|remote)$/.test(id))
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
  for (const [action, button, outcome] of [
    ["send", "message-send", "send-outcome"],
    ["stop", "run-stop", "stop-outcome"],
    ["lease", "p7-lease-submit", "p7-lease-outcome"],
  ]) {
    for (const state of ["failure", "unknown", "success"]) {
      await page.goto(base + "tests/fixtures/p7-client-states.html");
      await page.getByTestId(button).waitFor();
      if (action === "send") await page.getByTestId("message-input").fill("retain this draft");
      await page.getByTestId(button).click();
      await page.waitForFunction(
        (id) =>
          document.querySelector('[data-testid="' + id + '"]')?.getAttribute("data-state") ===
          "processing",
        outcome,
      );
      assert.equal(await page.evaluate(() => window.__p7.calls), 1);
      assert.equal(await page.getByTestId(button).isDisabled(), true);
      await page.evaluate((state) => window.__p7.settle(state), state);
      await page.waitForFunction(
        ([id, state]) =>
          document.querySelector('[data-testid="' + id + '"]')?.getAttribute("data-state") ===
          state,
        [outcome, state],
      );
      if (state === "unknown") {
        assert.match(await page.getByTestId(outcome).innerText(), /未知/);
        assert.doesNotMatch(await page.getByTestId(outcome).innerText(), /成功/);
      }
      if (action === "send")
        assert.equal(
          await page.getByTestId("message-input").inputValue(),
          state === "success" ? "" : "retain this draft",
        );
      pass("action_processing_and_final_outcome", { action, state });
    }
    await page.goto(base + "tests/fixtures/p7-client-states.html");
    await page.getByTestId(button).waitFor();
    if (action === "send") await page.getByTestId("message-input").fill("offline draft");
    await context.setOffline(true);
    await page.getByTestId("connectivity-status").waitFor();
    assert.match(await page.getByTestId("connectivity-status").innerText(), /离线 · 最后更新/);
    await page.getByTestId(button).click();
    await page.waitForFunction(
      (id) =>
        document.querySelector('[data-testid="' + id + '"]')?.getAttribute("data-state") ===
        "failure",
      outcome,
    );
    assert.equal(await page.evaluate(() => window.__p7.calls), 0);
    await context.setOffline(false);
    pass("offline_action_fails_without_submission", { action });
  }
} finally {
  await browser.close();
  await server.close();
}
