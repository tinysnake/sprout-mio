import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";
import { infoHubRefreshInputSchema } from "../../src/contracts/info-hub-query";
import { projectFixture } from "../../src/dev/scenes/info-hub/fixtures";

// Shared product components, frozen read fixtures, real stylesheet and browser/CDP.
// This does not claim a production server refresh or Agent route integration.
const started = performance.now();
const evidence = resolve(process.env.SPROUT_P6B_EVIDENCE ?? "/tmp/sprout-p6b-pages-evidence");
await mkdir(evidence, { recursive: true });
const requests: { at: number; input: ReturnType<typeof infoHubRefreshInputSchema.parse> }[] = [];
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { tsconfigPaths: true },
  cacheDir: "node_modules/.vite-p6b-pages",
  optimizeDeps: { entries: ["src/dev/scenes/info-hub/index.tsx"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    tailwindcss(),
    react(),
    {
      name: "p6b-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use(async (request, response, next) => {
          try {
            if (request.url === "/__fixture/refresh" && request.method === "POST") {
              let body = "";
              for await (const chunk of request) body += String(chunk);
              const input = infoHubRefreshInputSchema.parse(JSON.parse(body));
              requests.push({ at: Math.round(performance.now() - started), input });
              response.setHeader("Content-Type", "application/json");
              response.end(
                JSON.stringify(
                  input.knownRevision === "fixture-1"
                    ? {
                        kind: "unchanged",
                        projectId: input.projectId,
                        query: input.query,
                        revision: "fixture-1",
                        asOf: "2026-06-18T02:28:00.000Z",
                      }
                    : {
                        kind: "changed",
                        view: {
                          projectId: input.projectId,
                          view: "project",
                          section: "agents",
                          data: projectFixture.agents.agents,
                          page: { total: 1, nextCursor: null },
                          revision: "fixture-1",
                          asOf: "2026-06-18T02:28:00.000Z",
                        },
                      },
                ),
              );
              return;
            }
            if (request.url !== "/") return next();
            const html = await dev.transformIndexHtml(
              "/",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>P6b component browser gate</title><link rel="stylesheet" href="/src/styles.css"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/src/dev/scenes/info-hub/index.tsx"></script></body></html>',
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
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Runtime.enable");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "networkidle" });
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByTestId("fixture-case").selectOption("prepared");
    for (const view of ["project", "chat", "agent", "machine"]) {
      const section = page.getByTestId(`perspective-${view}`);
      assert(await section.getByTestId("info-agent-status").first().isVisible());
      assert((await section.innerText()).includes("Agent status：运行中"));
      assert((await section.innerText()).includes("当前没有排队中或运行中的 run。"));
      assert(await section.getByTestId("info-lease-fact").first().isVisible());
      pass(`${width}_${view}_independent_status_run_lease`);
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    pass(`${width}_no_horizontal_scroll`);
    const context = page.getByTestId("info-turn-context");
    assert((await context.innerText()).includes("已准备，待提交"));
    assert(!(await context.innerText()).includes("已注入"));
    assert((await page.getByTestId("info-turn-bytes").innerText()).includes("15 bytes"));
    assert((await page.getByTestId("info-turn-submitted-at").innerText()).includes("尚无提交收据"));
    pass(`${width}_prepared_has_no_injection_claim`);
    await page.screenshot({ path: resolve(evidence, `${width}-prepared.png`), fullPage: true });
    await page.getByTestId("fixture-case").selectOption("submitted");
    assert((await context.innerText()).includes("已注入"));
    assert((await page.getByTestId("info-turn-submitted-at").innerText()).includes("2026-06-18"));
    pass(`${width}_submitted_has_receipt`);
    await page.getByTestId("fixture-case").selectOption("empty");
    assert(
      (await page.getByTestId("perspective-project").innerText()).includes("还没有 Agent 成员"),
    );
    assert(
      (await page.getByTestId("perspective-chat").innerText()).includes("本 Chat 没有 Agent 成员"),
    );
    assert(
      (await page.getByTestId("perspective-agent").innerText()).includes("还没有此 Agent 的分身"),
    );
    assert(
      (await page.getByTestId("perspective-machine").innerText()).includes("没有关联的 Machine"),
    );
    assert(await page.getByTestId("info-turn-context-empty").isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    pass(`${width}_readable_empty_states`);
    await page.screenshot({ path: resolve(evidence, `${width}-empty.png`), fullPage: true });
  }
  await cdp.send("Runtime.evaluate", {
    expression:
      'Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange"))',
  });
  const beforeHidden = requests.length;
  await page.waitForTimeout(5100); // Actual time-behavior assertion, not process polling.
  assert.equal(requests.length, beforeHidden);
  pass("hidden_5100ms_zero_new_requests");
  const restoredAt = performance.now();
  await cdp.send("Runtime.evaluate", {
    expression:
      'Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange"))',
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="polling-state"]')?.textContent === "current",
  );
  assert.equal(requests.length, beforeHidden + 1);
  assert.equal(requests.at(-1)!.input.knownRevision, undefined);
  assert(!("cursor" in requests.at(-1)!.input.query));
  console.log(
    `TIMING restore full refresh ${Math.round(performance.now() - restoredAt)}ms; requests=${JSON.stringify(requests)}`,
  );
  pass("visible_immediate_single_full_request");
  assert.deepEqual(errors, []);
  pass("pageerror_and_console_error_zero");
  console.log(
    `P6b pages: ${checks} assertion groups passed; runner ${Math.round(performance.now() - started)}ms; evidence ${evidence}`,
  );
} finally {
  clearTimeout(timer);
  await browser.close();
  await server.close();
}
