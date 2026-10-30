import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3154";
const directory = resolve(process.env.UI_LAYOUT_DIRECTORY ?? ".verify/ui-layout");
const evidence = resolve(process.env.SPROUT_UI_EVIDENCE_DIR ?? ".verify/r-ui-layout/evidence");
mkdirSync(directory, { recursive: true });
mkdirSync(evidence, { recursive: true });
const results = [];
const errors = [];
const requireStart = createRequire(import.meta.resolve("@tanstack/react-start"));
const { fromCrossJSON, toJSONAsync } = requireStart("seroval");
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
const serverCode = files(resolve(".output/server"))
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
function functionPath(name) {
  const match = serverCode.match(new RegExp(`id:\\s*"([a-f0-9]+)",\\s*name:\\s*"${name}"`));
  assert(match, `built server function ${name}`);
  return `/_serverFn/${match[1]}`;
}
async function call(context, name, data) {
  const method = data === undefined ? "GET" : "POST";
  const response = await context.request.fetch(base + functionPath(name), {
    method,
    headers: {
      Origin: base,
      "content-type": "application/json",
      "x-tsr-serverfn": "true",
      accept: "application/json",
    },
    ...(data === undefined ? {} : { data: JSON.stringify(await toJSONAsync({ data })) }),
  });
  assert.equal(response.status(), 200);
  const payload = fromCrossJSON(JSON.parse(await response.text()), { refs: new Map() }).result;
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.requestId, response.headers()["x-sprout-request-id"]);
  return payload.data;
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
  writeFileSync(join(directory, "browser.json"), JSON.stringify(results, null, 2) + "\n");
}
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await check("mobile_login_targets_and_heading_font", async () => {
    const anonymous = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const login = await anonymous.newPage();
      login.on("pageerror", (error) => errors.push(String(error)));
      login.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await login.goto(base + "/login", { waitUntil: "networkidle" });
      for (const id of ["login-tab", "register-tab", "auth-submit"]) {
        const box = await login.getByTestId(id).boundingBox();
        assert(box && box.width >= 43 && box.height >= 43, id + " has a 44px mobile touch target");
      }
      const font = await login.locator("h1").evaluate(async (heading) => {
        await document.fonts.ready;
        return getComputedStyle(heading).fontFamily;
      });
      assert(font.includes("Geist Variable"), "heading uses the installed Geist Variable family");
      await login.screenshot({ path: join(evidence, "login-mobile-390.png") });
      return { font };
    } finally {
      await anonymous.close();
    }
  });
  const signup = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { Origin: base },
    data: {
      name: "UI 迁移验收",
      email: `ui-layout-${randomBytes(8).toString("hex")}@example.test`,
      password: randomBytes(24).toString("base64url"),
    },
  });
  assert.equal(signup.status(), 200, await signup.text());
  const [projects, profiles] = await Promise.all([
    call(context, "listProjectsFn"),
    call(context, "listAgentProfilesFn"),
  ]);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, "我的项目");
  const agent = profiles.find((profile) => profile.name === "Amenda");
  assert(agent);
  const projectId = projects[0].id;
  const direct = await call(context, "createDirectChatFn", { projectId, agentProfileId: agent.id });
  const chatPath = `/projects/${projectId}/chats/${direct.chat.id}`;
  const listPath = `/projects/${projectId}/chats`;
  await call(context, "sendMessageFn", {
    chatId: direct.chat.id,
    body: "UI 迁移验收：这条真实消息应在刷新后保留。",
  });
  const test = (id) => page.getByTestId(id);
  const goto = (path) => page.goto(base + path, { waitUntil: "networkidle" });
  const geometry = () =>
    page.evaluate(() => {
      const box = (id) => {
        const element = document.querySelector(`[data-testid="${id}"]`);
        if (!element || !element.getClientRects().length) return null;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || getComputedStyle(element).visibility === "hidden")
          return null;
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      return {
        viewport: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        sidebar: box("app-sidebar"),
        list: box("chat-list-panel"),
        detail: box("chat-detail-panel"),
        inspector: box("chat-inspector"),
      };
    });
  await check("single_project_dispatch_and_root_target", async () => {
    await goto("/projects");
    await page.waitForURL((url) => url.pathname === listPath);
    assert.match(await test("project-selector").textContent(), /我的项目/);
    await goto(`/projects/${projectId}`);
    await page.waitForURL((url) => url.pathname === listPath);
    return { path: new URL(page.url()).pathname, projectId };
  });
  await check("removed_member_route_has_visible_not_found", async () => {
    try {
      await goto(`/projects/${projectId}/agents`);
      await page.getByRole("heading", { name: "页面不存在", exact: true }).waitFor();
      assert.equal(await test("member-list").count(), 0);
    } finally {
      await goto(listPath);
    }
  });
  await check("projects_toggle_preserves_url_and_current_page", async () => {
    const before = page.url();
    const toggle = test("nav-projects");
    const expanded = await toggle.getAttribute("aria-expanded");
    await toggle.click();
    assert.notEqual(await toggle.getAttribute("aria-expanded"), expanded);
    assert.equal(page.url(), before);
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), expanded);
    return { url: before };
  });
  await check("project_selector_has_no_list_navigation", async () => {
    await test("project-selector").click();
    assert.equal(await page.getByText("查看全部 Projects", { exact: true }).count(), 0);
    assert.equal(await page.locator('a[href="/projects"]').count(), 0);
    await test("new-project-trigger").waitFor();
    await page.keyboard.press("Escape");
  });
  await check("project_creation_draft_survives_mobile_breakpoint", async () => {
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await test("project-selector").click();
      await test("new-project-trigger").click();
      await test("project-name-input").fill("跨断点保留的 Project 草稿");
      await page.setViewportSize({ width: 390, height: 844 });
      await test("project-name-input").waitFor({ state: "visible" });
      assert.equal(await test("project-name-input").inputValue(), "跨断点保留的 Project 草稿");
      await page.keyboard.press("Escape");
      await test("project-name-input").waitFor({ state: "detached" });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("data-testid") === "mobile-projects",
      );
    } finally {
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1440, height: 900 });
      await goto(listPath);
    }
  });
  for (const width of [390, 899, 900, 901, 1024, 1199, 1200, 1201, 1440]) {
    for (const theme of ["light", "dark"]) {
      await check(`layout_${theme}_${width}`, async () => {
        await page.setViewportSize({ width, height: width <= 900 ? 844 : 900 });
        await page.evaluate((value) => localStorage.setItem("sprout:theme", value), theme);
        await goto(`${chatPath}?info=1`);
        await test("chat-workspace").waitFor();
        const boxes = await geometry();
        assert.equal(boxes.overflow, false, "whole page horizontal overflow");
        assert(boxes.inspector, "opened inspector is reachable");
        await page.screenshot({ path: join(evidence, `layout-${theme}-${width}.png`) });
        if (width > 900) {
          assert(boxes.list, "desktop list remains visible with inspector");
          assert(boxes.detail, "desktop detail remains visible with inspector");
          assert.equal(Math.round(boxes.sidebar?.width ?? 0), width < 1200 ? 64 : 200);
          assert(boxes.list.width >= 159, "narrow list still usable");
          assert(boxes.inspector.width >= 239, "inspector minimum width");
          if (width === 901)
            assert(boxes.list.width <= 181, "901px list contracts toward 160–180px");
        } else {
          assert.equal(boxes.sidebar, null);
          assert(
            Math.abs(boxes.inspector.width - width) < 1,
            "mobile inspector fills available width",
          );
          assert.equal(boxes.list, null, "mobile info view does not compete with list");
          await test("back-to-chat").click();
          await test("message-input").waitFor();
          const backTarget = await test("back-to-chats").boundingBox();
          assert(
            backTarget && backTarget.width >= 43 && backTarget.height >= 43,
            "mobile back target is at least 44px",
          );
          await test("back-to-chats").click();
          await page.waitForURL((url) => url.pathname === listPath);
          await test("chat-list-panel").waitFor({ state: "visible" });
          const returned = await geometry();
          assert(returned.list, "mobile return reveals list");
          assert(Math.abs(returned.list.width - width) < 1, "mobile list fills available width");
          const searchTarget = await test("chat-search").boundingBox();
          assert(
            searchTarget && searchTarget.height >= 43,
            "mobile search target is at least 44px",
          );
          const newChatTarget = await test("new-chat").boundingBox();
          assert(
            newChatTarget && newChatTarget.width >= 43 && newChatTarget.height >= 43,
            "mobile new Chat target is at least 44px",
          );
          // 底栏五项等宽：此前用 justify-around 时各项宽度不同，视觉间隔不齐。
          const nav = await page.evaluate(() => {
            const items = [
              ...document.querySelector('[data-testid="mobile-primary-nav"]').children,
            ];
            const rects = items.map((item) => {
              const box = item.getBoundingClientRect();
              const icon = item.querySelector("svg");
              return {
                width: Math.round(box.width),
                iconTop: icon ? Math.round(icon.getBoundingClientRect().top) : null,
              };
            });
            return rects;
          });
          assert.equal(nav.length, 5, "mobile nav keeps five entries");
          assert.equal(
            new Set(nav.map((item) => item.width)).size,
            1,
            `mobile nav columns share one width: ${nav.map((item) => item.width).join("/")}`,
          );
          const iconTops = nav.map((item) => item.iconTop).filter((top) => top !== null);
          assert(
            new Set(iconTops).size === 1,
            `mobile nav icons share one baseline: ${iconTops.join("/")}`,
          );
          await page.screenshot({ path: join(evidence, `list-${theme}-${width}.png`) });
        }
        return boxes;
      });
    }
  }
  await check("inspector_keyboard_resize_and_draft_survive", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(`${chatPath}?info=1`);
    await test("message-input").fill("调整栏宽后仍保留的草稿");
    const handle = test("inspector-resize-handle");
    await handle.focus();
    const before = await handle.getAttribute("aria-valuenow");
    await page.keyboard.press("ArrowLeft");
    const after = await handle.getAttribute("aria-valuenow");
    assert.notEqual(after, before);
    assert.equal(await test("message-input").inputValue(), "调整栏宽后仍保留的草稿");
    return { before, after };
  });
  await check("inspector_pointer_resize_releases_and_preserves_draft", async () => {
    const handle = test("inspector-resize-handle");
    await handle.focus();
    await page.keyboard.press("Home");
    const before = Number(await handle.getAttribute("aria-valuenow"));
    const box = await handle.boundingBox();
    assert(box);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 48, y, { steps: 6 });
    await page.mouse.up();
    const after = Number(await handle.getAttribute("aria-valuenow"));
    assert(Math.abs(after - before - 48) <= 2, `pointer resize ${before} -> ${after}`);
    await page.mouse.move(x - 96, y);
    assert.equal(
      Number(await handle.getAttribute("aria-valuenow")),
      after,
      "released drag has no remaining movement listener",
    );
    assert.equal(await test("message-input").inputValue(), "调整栏宽后仍保留的草稿");
    return { before, after };
  });
  await check("zero_project_onboarding_creates_and_enters_chats", async () => {
    const zeroContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const signup = await zeroContext.request.post(`${base}/api/auth/sign-up/email`, {
        headers: { Origin: base },
        data: {
          name: "零 Project 验收",
          email: `ui-zero-${randomBytes(8).toString("hex")}@example.test`,
          password: randomBytes(24).toString("base64url"),
        },
      });
      assert.equal(signup.status(), 200, await signup.text());
      const owned = await call(zeroContext, "listProjectsFn");
      assert.equal(owned.length, 1);
      assert(
        process.env.DATABASE_URL,
        "zero-Project fixture requires the isolated runner database",
      );
      const database = new DatabaseSync(process.env.DATABASE_URL);
      try {
        database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN");
        // Project 出生即带唯一的公共频道（I-P5a 频道单元）：删 Project 之前先删它的频道行，
        // 否则 chat.project_id 的外键会挡住 teardown。
        assert.deepEqual(
          database
            .prepare("SELECT kind FROM chat WHERE project_id = ?")
            .all(owned[0].id)
            .map((row) => row.kind),
          ["public_channel"],
        );
        database.prepare("DELETE FROM chat WHERE project_id = ?").run(owned[0].id);
        database.prepare("DELETE FROM project_member WHERE project_id = ?").run(owned[0].id);
        database.prepare("DELETE FROM project_profile WHERE project_id = ?").run(owned[0].id);
        database.prepare("DELETE FROM diagnostic_event WHERE project_id = ?").run(owned[0].id);
        database.prepare("DELETE FROM project WHERE id = ?").run(owned[0].id);
        assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
        database.exec("COMMIT");
      } finally {
        database.close();
      }
      const zeroPage = await zeroContext.newPage();
      zeroPage.on("pageerror", (error) => errors.push(String(error)));
      zeroPage.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await zeroPage.goto(`${base}/projects`, { waitUntil: "networkidle" });
      await zeroPage.getByTestId("project-empty").waitFor();
      await zeroPage.getByTestId("first-project-trigger").click();
      await zeroPage.getByTestId("project-name-input").fill("零 Project 入口恢复");
      await zeroPage.getByTestId("project-submit").click();
      await zeroPage.waitForURL((url) =>
        /^\/projects\/prj_[0-9a-f-]{36}\/chats$/.test(url.pathname),
      );
      await zeroPage.getByTestId("chats-title").waitFor();
      assert.match(
        await zeroPage.getByTestId("project-selector").textContent(),
        /零 Project 入口恢复/,
      );
      const fresh = await call(zeroContext, "listProjectsFn");
      assert.equal(fresh.length, 1);
      assert.equal(fresh[0].name, "零 Project 入口恢复");
      // 新 Project 也自带频道，空列表状态只能靠删掉频道行构造；本检查守的是空列表布局本身。
      const freshDatabase = new DatabaseSync(process.env.DATABASE_URL);
      try {
        freshDatabase.exec("PRAGMA busy_timeout = 5000");
        freshDatabase
          .prepare("DELETE FROM chat WHERE project_id = ? AND kind = 'public_channel'")
          .run(fresh[0].id);
      } finally {
        freshDatabase.close();
      }
      await zeroPage.reload({ waitUntil: "networkidle" });
      await zeroPage.setViewportSize({ width: 390, height: 844 });
      await zeroPage
        .locator('[data-testid="chat-workspace"][data-layout="split"]')
        .waitFor({ state: "visible" });
      await zeroPage.getByTestId("chats-empty").waitFor({ state: "visible" });
      const emptyList = await zeroPage.getByTestId("chat-list-panel").boundingBox();
      assert(
        emptyList && Math.abs(emptyList.width - 390) < 1,
        "mobile empty list fills available width",
      );
      return { path: new URL(zeroPage.url()).pathname, emptyListWidth: emptyList.width };
    } finally {
      await zeroContext.close();
    }
  });
  await check("production_does_not_expose_development_gallery", async () => {
    const response = await context.request.get(`${base}/__dev/ui/`);
    const html = await response.text();
    assert(!html.includes("/src/dev/"));
    assert(!html.includes("gallery-dialog"));
    const clientFiles = files(resolve(".output/public")).filter((file) =>
      /\.(?:js|html)$/.test(file),
    );
    const leaks = clientFiles.filter((file) =>
      /gallery-dialog|ManagementScenes|ChatScenes/.test(readFileSync(file, "utf8")),
    );
    assert.deepEqual(leaks, []);
    return { status: response.status(), clientFiles: clientFiles.length };
  });
  await check("zero_console_and_page_errors", () => {
    assert.deepEqual(errors, []);
    return { errors };
  });
} finally {
  await browser.close();
}
const failed = results.filter((result) => !result.passed);
console.log(`UI layout checks=${results.length} failed=${failed.length}`);
process.exitCode = failed.length ? 1 : 0;
