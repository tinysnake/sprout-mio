import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createProject, openProjectInfoHub, waitForChats } from "./ui-navigation.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3144";
function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name))
      : entry.name.endsWith(".mjs")
        ? [readFileSync(join(directory, entry.name), "utf8")]
        : [],
  );
}
const source = sources(".output/server").join("\n");
const id = source.match(/id: "([0-9a-f]{64})",\s*\n\s*name: "refreshInfoHubFn"/)?.[1];
assert(id, "refreshInfoHubFn must be present in the production build");
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.clock.install();
  await page.route("**/api/events**", (route) => route.abort());
  await page.goto(`${base}/login`);
  await page.getByTestId("register-tab").click();
  await page.locator('input[name="name"]').fill("Hub resume regression");
  await page.locator('input[name="email"]').fill(`hub-resume-${Date.now()}@example.test`);
  await page.locator('input[name="password"]').fill("Hub-resume-test-password-42");
  await page.locator('button[type="submit"]').click();
  await waitForChats(page);
  const project = await createProject(page, { name: "Hub resume regression" });
  const isRefresh = (response) => response.url().includes(`/_serverFn/${id}`);
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes(`/_serverFn/${id}`)) requests += 1;
  });
  await page.goto(`${base}${project.path}/settings`);
  const initial = page.waitForResponse(isRefresh);
  await openProjectInfoHub(page);
  await (await initial).finished();
  await page.clock.pauseAt(new Date());
  const resumed = page.waitForResponse(isRefresh);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await (await resumed).finished();
  await page.waitForFunction(
    () =>
      !document.querySelector('[data-testid="info-hub-polling-state"][data-state="refreshing"]'),
  );
  await page.clock.runFor(100);
  const afterResume = requests;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
  });
  assert.equal(requests, afterResume, "duplicate resume must not issue another full refresh");
  const next = page.waitForResponse(isRefresh, { timeout: 5000 });
  await page.clock.runFor(3500);
  await (await next).finished();
  assert(
    requests > afterResume,
    "visible Info Hub must continue polling after a deduplicated resume",
  );
  console.log("PASS Info Hub hidden→visible inside resume window preserves subsequent polling");
} finally {
  await browser.close();
}
