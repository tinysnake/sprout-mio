import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3146";
const directory = resolve(process.env.K2_DIRECTORY ?? ".verify/k2-cross-family-isolation");
const screenshots = resolve("docs/p1/evidence");
mkdirSync(directory, { recursive: true });
mkdirSync(screenshots, { recursive: true });
const state = JSON.parse(readFileSync(join(directory, "k2-state.json"), "utf8"));
const results = [];
const errors = [];

function save() {
  writeFileSync(join(directory, "browser.json"), JSON.stringify(results, null, 2) + "\n");
}
async function check(name, action) {
  try {
    const detail = await action();
    results.push({ name, passed: true, detail });
    console.log(`PASS ${name} ${JSON.stringify(detail ?? {})}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack ?? String(error) });
    console.log(`FAIL ${name} ${error.stack ?? error}`);
  }
  save();
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.addCookies([
    { name: state.cookie.name, value: state.cookie.value, domain: "localhost", path: "/" },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(20000);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push({ url: page.url(), message: message.text() });
  });
  page.on("pageerror", (error) => errors.push({ url: page.url(), message: String(error) }));

  for (const target of state.pages) {
    await check(`page_${target.key}_renders_not_found`, async () => {
      const response = await page.goto(`${base}${target.path}`, { waitUntil: "networkidle" });
      assert.equal(response.status(), 200, `${target.path} HTTP status`);
      const meta = page.getByTestId("project-error-meta").or(page.getByTestId("agent-error-meta"));
      await meta.first().waitFor();
      const text = await meta.first().textContent();
      assert.match(text, /not_found/, `${target.path} error code`);
      assert.match(text, /req_[0-9a-f-]{36}/, `${target.path} error requestId`);
      const body = await page.locator("body").innerText();
      writeFileSync(join(directory, `isolation-page-${target.key}.txt`), body);
      const leaked = state.tokens.filter((token) => body.includes(token));
      assert.deepEqual(leaked, [], `${target.path} leaked A data`);
      await page.screenshot({
        path: join(screenshots, `p2-k2-isolation-${target.key}.png`),
        fullPage: true,
      });
      return { path: target.path, error: text, leaked };
    });
  }
  await check("zero_console_errors", () => {
    assert.deepEqual(errors, []);
    return { errors };
  });
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`k2 browser checks=${results.length} failed=${failed.length}`);
process.exitCode = failed.length ? 1 : 0;
