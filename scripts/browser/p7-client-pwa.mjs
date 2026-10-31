import { readFileSync } from "node:fs";
import { runProduction, pass, assert } from "./p7-client-harness.mjs";
await runProduction(async ({ page, context, base, directory, seeded: s }) => {
  const manifest = await (await fetch(base + "/manifest.webmanifest")).json();
  assert.equal(manifest.display, "standalone");
  for (const field of [
    "name",
    "short_name",
    "start_url",
    "scope",
    "theme_color",
    "background_color",
  ])
    assert.ok(manifest[field], field);
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((icon) => icon.sizes === `${size}x${size}`);
    assert.ok(icon, `icon ${size}`);
    const bytes = Buffer.from(await (await fetch(base + icon.src)).arrayBuffer());
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  assert.equal(
    await page.locator('link[rel="manifest"]').getAttribute("href"),
    "/manifest.webmanifest",
  );
  assert.ok(await page.locator('meta[name="theme-color"]').getAttribute("content"));
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("management-page").waitFor();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="service-version"]')?.textContent !== "读取中…",
  );
  const assets = await (await fetch(base + "/pwa-assets.json")).json();
  assert.ok(assets.some((name) => name.endsWith(".js")));
  assert.ok(assets.some((name) => name.endsWith(".css")));
  assert.equal(
    await page.evaluate(async (assets) => {
      const cache = await caches.open("sprout-shell-v1");
      return (await Promise.all(assets.map((url) => cache.match(url)))).every(Boolean);
    }, assets),
    true,
  );
  pass("installable_manifest_icons_root_links_and_precache", { assets: assets.length });
  const readFunctions = await (await fetch(base + "/pwa-reads.json")).json();
  assert.ok(Object.values(readFunctions).includes("getChatSessionFn"));
  assert.equal(Object.values(readFunctions).includes("sendMessageFn"), false);
  const chatPath = `/projects/${s.projectId}/chats/${s.dmId}?info=1`;
  await page.goto(base + chatPath, { waitUntil: "domcontentloaded" });
  await page.getByTestId("message-input").waitFor();
  await page.getByTestId("info-hub-polling-state").waitFor();
  await page.goto(base + "/management", { waitUntil: "domcontentloaded" });
  await page.getByTestId("management-page").waitFor();
  let writes = 0;
  page.on("request", (request) => {
    const id = new URL(request.url()).pathname.split("/_serverFn/")[1];
    if (request.method() === "POST" && (!id || !readFunctions[id])) writes++;
  });
  await context.setOffline(true);
  await page.getByTestId("connectivity-status").waitFor();
  assert.match(await page.getByTestId("connectivity-status").innerText(), /离线 · 最后更新/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("management-page").waitFor();
  await page.getByTestId("connectivity-status").waitFor();
  const oldVersion = await page.getByTestId("service-version").innerText();
  assert.notEqual(oldVersion, "读取中…");
  assert.match(await page.getByTestId("connectivity-status").innerText(), /离线 · 最后更新/);
  await page.goto(base + chatPath, { waitUntil: "domcontentloaded" });
  await page.getByTestId("message-input").waitFor();
  await page.getByTestId("connectivity-status").waitFor();
  assert.match(await page.getByTestId("connectivity-status").innerText(), /离线 · 最后更新/);
  await page.getByTestId("message-input").fill("offline message stays local");
  await page.getByTestId("message-send").click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="send-outcome"]')?.getAttribute("data-state") ===
      "failure",
  );
  assert.equal(await page.getByTestId("message-input").inputValue(), "offline message stays local");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("message-input").waitFor();
  pass("offline_chat_deep_link_refresh_uses_audited_post_reads", { chatPath });
  await page.goto(base + "/agents/agp_00000000-0000-4000-8000-000000000000", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "当前页面没有可用的离线副本" }).waitFor();
  await page.getByTestId("connectivity-status").waitFor();
  pass("uncached_offline_target_is_explained");
  await page.goto(base + "/management", { waitUntil: "domcontentloaded" });
  await page.getByTestId("management-page").waitFor();
  await page
    .getByTestId("management-page")
    .getByRole("button", { name: "登出", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: /离线，登出未提交/ })
    .waitFor();
  assert.equal(writes, 0, "offline mutations must not reach the network");
  assert.equal(
    await page.evaluate(async () => {
      const cache = await caches.open("sprout-reads-v1");
      return (await cache.keys()).every((request) => request.method === "GET");
    }),
    true,
  );
  await page.screenshot({ path: `${directory}/offline.png` });
  pass("offline_refresh_reads_cached_facts_and_rejects_writes", { version: oldVersion, writes });
  await context.setOffline(false);
  await page.getByTestId("connectivity-status").waitFor({ state: "hidden" });
  assert.equal(writes, 0, "reconnection must not replay writes");
  pass("reconnect_refetches_without_write_replay");
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const media = original(query);
      if (query === "(display-mode: standalone)")
        Object.defineProperty(media, "matches", { value: true });
      return media;
    };
  });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(base + "/management");
  await page.getByTestId("management-page").waitFor();
  pass("standalone_start_restores_last_authenticated_target");
  // Worker implementation has no background-sync handler or persistent write store.
  const sw = readFileSync("public/sw.js", "utf8");
  assert.equal(/addEventListener\(["']sync|indexedDB/.test(sw), false);
});
