// P6b 生产接线门禁：真实生产包 + 私有 SQLite + 真实 Chromium。
//
// 风险 → 证据
// - 轮询控制器只在 fixture 里跑过 → 真实 Chat 页在推送连着时按提示的 revision 重读，隐藏时零请求；
//   3 秒节拍只在推送断开时兜底，安全间隔内不轮询。
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
    await page.waitForURL((url) => /^\/projects\/prj_[0-9a-f]{8,16}\/chats$/.test(url.pathname), {
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
    await page.waitForURL((url) => /\/chats\/cnv_[0-9a-f]{8,16}$/.test(url.pathname), {
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
    await delay(9600);
    assert.equal(
      refreshRequests.length,
      0,
      `推送连着时不应每 3 秒轮询，实际 ${refreshRequests.length} 次`,
    );
    pass("no_interval_poll_while_push_connected", { windowMs: 9600 });

    // (3) 推送契约：真实写入（改对话标题）提交后，页面在 3 秒内按 revision 重读。
    const writeStarted = Date.now();
    const beforePush = refreshRequests.length;
    await page.locator('[data-testid="chat-title-edit"]').first().click();
    await page.locator('[data-testid="chat-title-input"]').fill(`P6b wiring ${writeStarted}`);
    await page.locator('[data-testid="chat-title-save"]').click();
    const pushDeadline = writeStarted + 3000;
    while (refreshRequests.length === beforePush && Date.now() < pushDeadline) await delay(25);
    assert.equal(refreshRequests.length > beforePush, true, "推送到达后 3 秒内必须重读一次");
    const pushed = refreshRequests.slice(beforePush);
    assert.equal(
      pushed.some((item) => item.body.includes("knownRevision")),
      true,
      "推送触发的重读必须带 knownRevision",
    );
    assert.equal(pushed.length <= 3, true, `一次提示的重读次数 ${pushed.length} 次过多`);
    pass("push_triggers_revision_read", {
      latencyMs: pushed[0].at - writeStarted,
      bodies: pushed.map((item) => item.body.slice(0, 240)),
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
    const firstResume = refreshRequests[beforeResume];
    const resumeAt = firstResume.at - resumedAt;
    // 重连后的 ready 会再补一次提醒（change-stream 的 notifyAll），第二次带 knownRevision 是设计；
    // 这里断言的是恢复后的**首个**读是全量。
    assert.equal(
      firstResume.body.includes("knownRevision"),
      false,
      "恢复可见必须是全量刷新（不带 knownRevision）",
    );
    pass("visible_resume_single_full_refresh", { resumedAfterMs: resumeAt });

    // (5) 一个页面一路轮询：恢复后的 9.6 秒里没有第二份定时读。
    const windowStart = Date.now();
    const baseline = refreshRequests.length;
    await delay(9600);
    const windowRequests = refreshRequests.slice(baseline);
    assert.equal(
      windowRequests.length <= 1,
      true,
      `恢复后的 9.6 秒内至多一次由提示触发的重读，实际 ${windowRequests.length}`,
    );
    pass("one_polling_stream_per_page", {
      windowMs: Date.now() - windowStart,
      requests: windowRequests.length,
    });

    // (5) 轮初块：prepared / 没有快照时不许出现「已注入」。
    await page.goto(`${base}${chatPath}?info=1`, { waitUntil: "domcontentloaded" });
    // 轮初快照与注入收据 2026-11-11 起收在「本轮上下文与注入诊断」折叠块里：先展开再读。
    await page.waitForSelector('[data-testid="chat-turn-context-diagnostics"]', { timeout: 30000, state: "attached" });
    await page.evaluate(() => {
      // 右栏「活动」段默认收起，诊断块在它里面：先展开外层，再展开诊断本身。
      for (const id of ["chat-details-activity", "chat-turn-context-diagnostics"]) {
        const details = document.querySelector(`[data-testid="${id}"]`);
        if (details instanceof HTMLDetailsElement && !details.open) details.open = true;
      }
    });
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
    // 对话接续面板必须接在真实 Chat 页上：夹具能渲染卡片，不代表页面接了服务。
    assert.equal(
      await page.locator('[data-testid="continuation-unavailable"]').count(),
      0,
      "真实 Chat 页仍在渲染「服务尚未接入」占位",
    );
    // 诊断内容已按定稿形状移到独立诊断页，DM 右栏只留一个接续入口：
    // 夹具能渲染入口不代表页面接了服务，所以这里核对真实路由的 href。
    assert.equal(
      await page.locator('[data-testid="continuation-panel"]').count(),
      1,
      "真实 Chat 页没有渲染对话自动化入口",
    );
    const chatId = chatPath.split("/").pop();
    const entryHrefs = await page
      .locator('[data-testid="continuation-panel"] a')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") ?? ""));
    assert.equal(entryHrefs.length, 1, `DM 右栏应只有一个接续入口，实际 ${entryHrefs.join(", ")}`);
    assert.equal(
      entryHrefs.some((href) => href.endsWith(`/chats/${chatId}/checks/latest/continuation`)),
      true,
      `DM 入口必须指向 latest 接续诊断页，实际 ${entryHrefs.join(", ")}`,
    );
    assert.equal(
      entryHrefs.some((href) => href.endsWith("/wake")),
      false,
      `DM 不应出现唤醒判定入口，实际 ${entryHrefs.join(", ")}`,
    );
    assert.equal(
      await page.locator('[data-testid="continuation-card"]').count(),
      0,
      "诊断内容不应再渲染在 Chat 右栏",
    );
    pass("continuation_panel_wired_on_real_chat", {
      note: "真实路由取到 getChatContinuationFn 的视图，DM 右栏只留指向 latest 接续诊断页的一个入口",
      entryHrefs,
    });
    // 轮询正常态不许进视野：内部 state 与 asOf 只留在 data-* 上。
    const liveState = await page
      .locator("[data-info-hub-live-state]")
      .first()
      .getAttribute("data-info-hub-live-state");
    assert.equal(
      ["current", "refreshing", "hidden"].includes(liveState ?? ""),
      true,
      `本轮轮询状态应为安静态，实际 ${liveState}`,
    );
    assert.equal(
      await page.locator('[data-testid="info-hub-polling-state"]').count(),
      0,
      "轮询正常态不得渲染状态行",
    );
    const quietBody = await page.locator("body").innerText();
    assert.equal(
      /事实时间\s*\d{4}-\d{2}-\d{2}T/.test(quietBody),
      false,
      "正常态不得把 ISO 时间戳给人看",
    );
    assert.equal(/已是最新/.test(quietBody), false, "正常态不得告诉人类「已是最新」");
    pass("info_hub_polling_line_stays_quiet", { liveState });
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

    // (6) Project settings 也只挂一个 owner：首读之后，推送连着的安全间隔内不再轮询。
    // reset 放在 goto 之前：挂载时的首个全量读可能抢在 waitForSelector 之前到达。
    refreshRequests.length = 0;
    const settingsNavigatedAt = Date.now();
    await page.goto(`${base}/projects/${projectId}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-info-hub-live-state]", { timeout: 30000 });
    while (refreshRequests.length === 0 && Date.now() - settingsNavigatedAt < 3500) await delay(25);
    assert.equal(refreshRequests.length >= 1, true, "Project settings 首读必须在 3.5 秒内发生");
    const settingsFirst = refreshRequests[0].at - settingsNavigatedAt;
    // 首屏结算后再数 9.6 秒：project 的安全间隔是 30 秒，窗口内不应有定时读。
    await delay(1600);
    const settingsBaseline = refreshRequests.length;
    await delay(9600);
    assert.equal(
      refreshRequests.length,
      settingsBaseline,
      `settings 推送连着时不应每 3 秒轮询，新增 ${refreshRequests.length - settingsBaseline} 次`,
    );
    pass("settings_page_single_owner_no_interval_poll", {
      firstRequestAfterMs: settingsFirst,
      requests: refreshRequests.length,
      offsetsMs: refreshRequests.map((request) => request.at - settingsNavigatedAt),
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
