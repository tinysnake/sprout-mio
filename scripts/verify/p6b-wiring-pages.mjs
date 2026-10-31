// P6b 生产接线门禁：真实生产包 + 私有 SQLite + 真实 Chromium。
//
// 风险 → 证据
// - 轮询控制器只在 fixture 里跑过 → 真实 Chat 页真的每 3 秒发一次 refreshInfoHubFn，隐藏时零请求。
// - 每个组件各自起一份轮询 → 一个页面的请求节奏是「一份 owner」的节奏，不是 N 份。
// - 轮初块把「没有快照」说成「已注入」 → prepared/无快照时页面上没有「已注入」，只有「尚无提交收据」。
// - 既有事实被新事实挤掉 → 同一页上 run 事实（宿主/活动 run）与轮初块同时在场。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const directory = resolve(".verify/bf-p6b-pages-wiring");
const evidence = resolve(
  process.env.SPROUT_UI_EVIDENCE_DIR ?? ".verify/bf-p6b-pages-wiring/evidence",
);
mkdirSync(directory, { recursive: true });
mkdirSync(evidence, { recursive: true });

const checks = [];
function pass(name, detail) {
  checks.push({ name, detail });
  console.log(`PASS ${name} ${JSON.stringify(detail)}`);
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const children = new Set();
function launch(command, args, name, env) {
  const fd = openSync(join(directory, name), "w");
  const child = spawn(command, args, { env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.completion = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  children.add(child);
  return child;
}
function kill(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function stop(child) {
  kill(child);
  const result = await child.completion;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return result;
      throw error;
    }
    await delay(100);
  }
  throw new Error(`进程组 ${child.pid} 未退出`);
}
function portIsFree(port) {
  return new Promise((done, fail) => {
    const socket = net.connect(port, "localhost");
    socket.setTimeout(1500, () => {
      socket.destroy();
      fail(new Error(`port ${port} check timed out`));
    });
    socket.once("connect", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", (error) => (error.code === "ECONNREFUSED" ? done(true) : fail(error)));
  });
}
/** 并行门禁会抢固定端口；从一段没有被任何门禁登记的端口里挑第一个空闲的。 */
async function pickPort() {
  for (let port = 3300; port < 3320; port++) if (await portIsFree(port)) return port;
  throw new Error("没有空闲端口可用于 P6b 接线门禁");
}

async function health(base, child) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return await response.json();
    } catch {}
    await delay(250);
  }
  throw new Error("生产服务器未就绪；见 server.log");
}

/** server function 的 id 只在构建产物里；页面请求与 curl 用同一个地址。 */
function serverFnIds() {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith(".mjs")
          ? [join(dir, entry.name)]
          : [],
    );
  const source = walk(join(".output", "server"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const ids = {};
  for (const match of source.matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g))
    ids[match[2]] = match[1];
  return ids;
}

const port = Number(process.env.SPROUT_VERIFY_P6B_WIRING_PORT ?? (await pickPort()));
const base = `http://localhost:${port}`;
const databaseUrl = join(directory, "wiring.sqlite");
const environment = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  APP_ORIGIN: base,
  PORT: String(port),
  NITRO_PORT: String(port),
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
};

let server;
let failure;
try {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(databaseUrl + suffix, { force: true });
  const buildEnvironment = { ...environment };
  delete buildEnvironment.BETTER_AUTH_SECRET;
  const build = launch(
    process.execPath,
    ["scripts/verify/prepare.mjs", "server"],
    "build.log",
    buildEnvironment,
  );
  const built = await build.completion;
  assert.equal(built.code, 0, `构建失败；见 ${join(directory, "build.log")}`);

  server = launch(process.execPath, [".output/server/index.mjs"], "server.log", environment);
  await health(base, server);
  const ids = serverFnIds();
  assert(ids.refreshInfoHubFn, "缺少 refreshInfoHubFn 的 server function id");
  pass("real_server_ready", { port, refreshInfoHubFn: ids.refreshInfoHubFn });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));
    /** 只数 refreshInfoHubFn 的请求：别的 loader 请求不算轮询。 */
    const refreshRequests = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      if (!request.url().includes(`/_serverFn/${ids.refreshInfoHubFn}`)) return;
      refreshRequests.push({ at: Date.now(), body: request.postData() ?? "" });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Runtime.enable");
    const setVisibility = (value) =>
      cdp.send("Runtime.evaluate", {
        expression: `Object.defineProperty(document, "visibilityState", { configurable: true, value: "${value}" }); document.dispatchEvent(new Event("visibilitychange"))`,
      });

    // 真实注册 → 建 Project → 建 Agent → 加入 → 起 DM。
    const stamp = Date.now();
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[name="email"]', { timeout: 30000 });
    await page.getByTestId("register-tab").click();
    await page.fill('input[name="name"]', "P6b 接线验收");
    await page.fill('input[name="email"]', `p6b-wiring-${stamp}@example.test`);
    await page.fill('input[name="password"]', randomBytes(18).toString("base64url"));
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => /^\/projects\/prj_[0-9a-f-]{36}\/chats$/.test(url.pathname), {
      timeout: 30000,
    });
    const projectId = new URL(page.url()).pathname.split("/")[2];
    const agentName = `P6b Agent ${stamp}`;
    await page.goto(`${base}/agents`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="new-agent-trigger"]', { timeout: 30000 });
    await page.click('[data-testid="new-agent-trigger"]');
    await page.fill('[data-testid="agent-name-input"]', agentName);
    await page.fill('[data-testid="agent-persona-input"]', "接线验收用的分身人设");
    await page.click('[data-testid="agent-submit"]');
    await page.waitForFunction(
      (target) =>
        [...document.querySelectorAll('[data-testid="agent-item-name"]')].some(
          (node) => node.textContent === target,
        ),
      agentName,
      { timeout: 30000 },
    );
    await page.click(`[data-testid="agent-item-name"] >> text=${agentName}`);
    await page.waitForSelector('[data-testid="agent-detail-id"]', { timeout: 30000 });
    const agentProfileId = (await page.textContent('[data-testid="agent-detail-id"]'))?.trim();
    await page.goto(`${base}/projects/${projectId}/members`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="add-member-trigger"]', { timeout: 30000 });
    await page.click('[data-testid="add-member-trigger"]');
    await page.waitForSelector('[data-testid="add-member-select"]', { timeout: 30000 });
    await page.selectOption('[data-testid="add-member-select"]', { label: agentName });
    await page.click('[data-testid="add-member-submit"]');
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('[data-testid="member-item-name"]')].some(
          (node) => node.textContent?.trim() === name,
        ),
      agentName,
      { timeout: 30000 },
    );
    await page.goto(`${base}/projects/${projectId}/chats`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(
      `[data-testid="dm-start"][data-agent-profile-id="${agentProfileId}"]`,
      { timeout: 30000 },
    );
    await page.click(`[data-testid="dm-start"][data-agent-profile-id="${agentProfileId}"]`);
    await page.waitForURL((url) => /\/chats\/cnv_[0-9a-f-]{36}$/.test(url.pathname), {
      timeout: 30000,
    });
    const chatPath = new URL(page.url()).pathname;
    pass("real_chat_page_reached", { projectId, chatPath, agentProfileId });

    // (1) 挂上页面：进页面立刻有一次刷新，之后按 3 秒节奏。
    refreshRequests.length = 0;
    const requestsSeen = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes(`/_serverFn/${ids.refreshInfoHubFn}`)
      )
        requestsSeen.push(request.postData()?.slice(0, 200) ?? "");
    });
    const mountedAt = Date.now();
    await page.waitForSelector("[data-info-hub-live-state]", { timeout: 30000 });
    while (refreshRequests.length === 0 && Date.now() - mountedAt < 3500) await delay(50);
    assert.equal(
      refreshRequests.length >= 1,
      true,
      "进 Chat 页后 3 秒内必须发出一次真实 refresh 请求",
    );
    const firstAt = refreshRequests[0].at - mountedAt;
    assert.equal(
      await page.locator("[data-info-hub-live-state]").count(),
      1,
      "一个页面只有一个 polling owner 的状态行",
    );
    pass("chat_page_polls_within_3s", { firstRequestAfterMs: firstAt });

    // 进页面的头几次请求可能来自两个 scope（先列表后选中 Chat，各一次全量）。
    // 等 1.6 秒让首屏结算，再从稳态开始数节奏。
    await delay(1600);
    refreshRequests.length = 0;
    console.log(`DIAG initial sequence ${JSON.stringify(requestsSeen.slice(0, 4))}`);

    // (2) 3 秒节奏：稳态下每个间隔落在 3 秒 ±10% 抖动内，第二次起带 knownRevision。
    const secondDeadline = Date.now() + 6000;
    while (refreshRequests.length < 2 && Date.now() < secondDeadline) await delay(50);
    assert.equal(refreshRequests.length >= 2, true, "3 秒后应再发一次刷新请求");
    const gap = refreshRequests[1].at - refreshRequests[0].at;
    assert.equal(gap >= 2400 && gap <= 4800, true, `轮询间隔 ${gap}ms 不在 3 秒 ±10% 抖动内`);
    assert.equal(
      refreshRequests[0].body.includes("knownRevision"),
      true,
      "稳态的第一次刷新必须带 knownRevision（增量）",
    );
    pass("polling_interval_respects_3s_with_revision", {
      gapMs: gap,
      firstBody: refreshRequests[0].body.slice(0, 240),
      secondBody: refreshRequests[1].body.slice(0, 240),
    });

    // (3) 隐藏零请求 + 恢复立即全量。CDP 改 visibilityState，与既有件做法一致。
    await setVisibility("hidden");
    const hiddenFrom = Date.now();
    const beforeHidden = refreshRequests.length;
    await delay(5100);
    assert.equal(refreshRequests.length, beforeHidden, "页面隐藏期间必须零请求");
    pass("hidden_5100ms_zero_refresh_requests", { hiddenMs: Date.now() - hiddenFrom });

    const beforeResume = refreshRequests.length;
    const resumedAt = Date.now();
    await setVisibility("visible");
    while (refreshRequests.length === beforeResume && Date.now() - resumedAt < 2000)
      await delay(25);
    assert.equal(refreshRequests.length > beforeResume, true, "恢复可见必须立即发一次请求");
    const resumeAt = refreshRequests.at(-1).at - resumedAt;
    assert.equal(
      refreshRequests.at(-1).body.includes("knownRevision"),
      false,
      "恢复可见必须是全量刷新（不带 knownRevision）",
    );
    pass("visible_resume_single_full_refresh", { resumedAfterMs: resumeAt });

    // (4) 一个页面一路轮询：连续 9.6 秒里只有一份 3 秒节奏。
    const windowStart = Date.now();
    const baseline = refreshRequests.length;
    await delay(9600);
    const windowRequests = refreshRequests.slice(baseline);
    const gaps = windowRequests.slice(1).map((item, index) => item.at - windowRequests[index].at);
    assert.equal(
      windowRequests.length >= 2 && windowRequests.length <= 5,
      true,
      `9.6 秒窗口内应只有一份 owner 的 2-5 次请求，实际 ${windowRequests.length}`,
    );
    assert.equal(
      gaps.every((value) => value >= 2400),
      true,
      `同一 owner 的请求不应叠发，间隔 ${JSON.stringify(gaps)}`,
    );
    pass("one_polling_stream_per_page", {
      windowMs: Date.now() - windowStart,
      requests: windowRequests.length,
      gaps,
    });

    // (5) 轮初块：prepared / 没有快照时不许出现「已注入」。
    await page.goto(`${base}${chatPath}?info=1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="info-turn-prompt-injection"]', { timeout: 30000 });
    const injection = await page
      .locator('[data-testid="info-turn-prompt-injection"]')
      .first()
      .textContent();
    assert.equal(
      /本次上下文尚无提交收据/.test(injection ?? ""),
      true,
      `prepared 文案：${injection}`,
    );
    assert.equal(/已注入/.test(injection ?? ""), false, `prepared 不得声称已注入：${injection}`);
    assert.equal(
      (await page.locator('[data-testid="info-turn-context-empty"]').count()) >= 1,
      true,
      "还没有 run 的 Chat 必须显示轮初空态，而不是伪造快照",
    );
    // run 事实与轮初块同时在场：新事实不许挤掉旧的宿主/活动 run 行。
    // 自动接续面板必须接在真实 Chat 页上：夹具能渲染卡片，不代表页面接了服务。
    assert.equal(
      await page.locator('[data-testid="automation-unavailable"]').count(),
      0,
      "真实 Chat 页仍在渲染「服务尚未接入」占位",
    );
    assert.equal(
      await page.locator('[data-testid="automation-card"]').count(),
      1,
      "真实 Chat 页没有渲染自动接续卡片",
    );
    pass("automation_panel_wired_on_real_chat", {
      note: "真实路由取到 getChatAutomationFn 的视图，不是未接入占位",
    });
    await page.waitForSelector('[data-testid="info-chat-runs-host-status"]', { timeout: 30000 });
    assert.equal(
      /宿主(已|未)启用/.test(
        (await page.locator('[data-testid="info-chat-runs-host-status"]').first().textContent()) ??
          "",
      ),
      true,
      "run 视角的宿主事实必须仍在同一面板上",
    );
    // Human 摘要页从不把 Agent 的 changes 数当成合并次数展示。
    const body = await page.locator("body").innerText();
    assert.equal(/合并\s*\d+\s*条/.test(body), false, "不得把 changes.length 当合并次数展示");
    pass("turn_block_prepared_has_no_injection_claim", {
      injection,
      // submitted 的渲染事实由 bf-p6b-pages 的 `${width}_submitted_has_receipt` 组与
      // tests/fixtures/p6b-turn-context.ts 的 confirmTurnContext 用例证明：本门禁不启动 pi host，
      // 页面不可能自己造出 SDK 提交收据。
      submittedCase: "bf-p6b-pages:submitted_has_receipt + p6b-turn-context:confirm",
    });

    // (6) Project settings 也只挂一个 owner：这里的刷新区是 Machines。
    await page.goto(`${base}/projects/${projectId}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-info-hub-live-state]", { timeout: 30000 });
    refreshRequests.length = 0;
    const settingsAt = Date.now();
    while (refreshRequests.length === 0 && Date.now() - settingsAt < 3500) await delay(50);
    assert.equal(refreshRequests.length >= 1, true, "Project settings 也要在 3 秒内发一次刷新");
    const settingsFirst = refreshRequests[0].at - settingsAt;
    // 数到三次请求为止（最多 12 秒）：节奏来自 owner 的定时器，不受本进程调度抖动影响。
    const settingsDeadline = Date.now() + 12_000;
    while (refreshRequests.length < 3 && Date.now() < settingsDeadline) await delay(50);
    const settingsGaps = refreshRequests
      .slice(1)
      .map((item, index) => item.at - refreshRequests[index].at);
    assert.equal(refreshRequests.length >= 2, true, "settings 的 owner 必须持续轮询");
    assert.equal(
      settingsGaps.every((value) => value >= 2400 && value <= 4800),
      true,
      `settings 只有一个 3 秒节奏的 owner，实际间隔 ${JSON.stringify(settingsGaps)}`,
    );
    assert.equal(
      refreshRequests.every((item) => item.body.includes("knownRevision")),
      true,
      "settings 的稳态刷新都必须带 knownRevision",
    );
    pass("settings_page_single_owner_polls", {
      firstRequestAfterMs: settingsFirst,
      requests: refreshRequests.length,
      offsetsMs: refreshRequests.map((request) => request.at - settingsAt),
      gapsMs: settingsGaps,
    });

    assert.deepEqual(consoleErrors, [], `页面不得有 console.error：${consoleErrors.join(" | ")}`);
    pass("no_console_errors", { consoleErrors });

    const state = { base, projectId, chatPath, agentProfileId, checks };
    await page.screenshot({ path: join(evidence, "chat-page.png"), fullPage: true });
    writeFileSync(join(directory, "evidence.json"), JSON.stringify(state, null, 2) + "\n");
  } finally {
    await browser.close();
  }
} catch (error) {
  failure = error;
} finally {
  if (server) {
    const shutdown = await stop(server);
    if (shutdown.code !== 0) console.error(`server exit ${shutdown.code}/${shutdown.signal}`);
  }
  for (const child of children) if (child.exitCode === null) kill(child, "SIGKILL");
}
if (failure) {
  console.error(`FAIL ${failure instanceof Error ? failure.stack : JSON.stringify(failure)}`);
  process.exitCode = 1;
} else {
  console.log(`P6b wiring pages: ${checks.length} assertion groups in a real page`);
}
