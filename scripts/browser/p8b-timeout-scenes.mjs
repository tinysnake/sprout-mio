import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

// 挂靠超时的演示场景核对：只连本机 dev server，用演示数据，不连业务服务。
// 这里断言四件事：超时只加只读标记（绝不显示成空闲）、升级与暂停自动尝试说得清、
// 没有活跃挂靠就没有超时事实、提醒在 Chat 里是一条消息（不触发唤醒）。
const base = process.env.SPROUT_P8B_TIMEOUT_URL ?? "http://127.0.0.1:3099/__dev/ui/";
const evidence = resolve(process.env.SPROUT_P8B_TIMEOUT_EVIDENCE ?? ".verify/p8b-ui/evidence");
mkdirSync(evidence, { recursive: true });

const browser = await chromium.launch();
const results = [];
const applicationRequests = [];

function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function check(name, run) {
  try {
    await run();
    record(name, true);
  } catch (error) {
    record(name, false, String(error?.message ?? error));
    throw error;
  }
}

async function open({ width, height, colorScheme, scene }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme,
    deviceScaleFactor: 1,
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("sprout:theme", theme);
  }, colorScheme);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/") || path.startsWith("/_server")) applicationRequests.push(path);
  });
  const url = new URL(base);
  url.searchParams.set("scene", scene);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  return { context, page, errors };
}

const shoot = (page, name) =>
  page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true, animations: "disabled" });

/** 内层滚动容器里的区块要滚到可见处再截图，否则证据里看不到该区块。 */
async function shootAt(page, testId, name) {
  await page.getByTestId(testId).scrollIntoViewIfNeeded();
  await page.waitForTimeout(120);
  await shoot(page, name);
}

/** 演示控制收在 details 里：先展开，打开「挂靠超时」场景，再收回，避免遮挡截图。 */
async function enableTimeoutScene(page) {
  const controls = page.getByTestId("machine-scene-controls");
  await controls.locator("summary").click();
  await page.getByTestId("machine-demo-timeout-scene").check();
  await controls.locator("summary").click();
}

/** 对照场景：这里只放既有挂靠，没有超时写死的事实。 */
async function enableEscrowScene(page) {
  const controls = page.getByTestId("machine-scene-controls");
  await controls.locator("summary").click();
  await page.getByTestId("machine-demo-escrow-scene").check();
  await controls.locator("summary").click();
}

/** 从 Machine 列表进到某台 Machine 的租约页：列表项整体是链接，详情页里再点租约入口。 */
async function openLease(page, machineName) {
  await page.getByTestId("machine-item").filter({ hasText: machineName }).click();
  await page.getByTestId("machine-lease-link").first().click();
  await page.getByTestId("machine-lease-detail").waitFor();
  await page.getByTestId("machine-lease-page").waitFor();
}

function leaseRow(page, machineName) {
  return page.locator('[data-testid^="lease-row-"]').filter({ hasText: machineName });
}

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/**
 * 内容列溢出的两个量：页面滚动区的横向滚动量，和超时事实自身的墨迹有没有超过内容列右缘。
 * 只量 `documentElement` 会漏掉内层滚动容器里的溢出——视觉核查就是这样量到 131px 溢出的。
 */
async function contentColumnOverflow(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="machine-lease-page"]');
    const fact = document.querySelector("[data-timeout-phase]");
    const factRight = fact.getBoundingClientRect().right;
    const widest = [...fact.querySelectorAll("*")].reduce(
      (max, node) => Math.max(max, node.getBoundingClientRect().right),
      factRight,
    );
    return {
      scroll: scroller.scrollWidth - scroller.clientWidth,
      ink: Math.round(widest - factRight),
    };
  });
}

/**
 * 超时事实的排版量：状态标签有没有被拆词、有没有超出事实块、左右留白是否对称。
 * 视觉核查在 390px 下量到过「标签拆成两行 + 右留白 2px」，这两条现在都用数字守住。
 * 留白的参照系用行本身：`lease-row-*` 的左缘对 `[data-timeout-phase]` 的右缘。
 */
async function timeoutFactLayout(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid^="lease-row-"]');
    const fact = document.querySelector("[data-timeout-phase]");
    const state = document.querySelector('[data-testid^="lease-timeout-"][data-testid$="-state"]');
    // StatusLine 里第一个带 aria-hidden 的是状态点，紧随其后的那个 span 才是标签本体。
    const label = state.querySelector("span[aria-hidden]")?.nextElementSibling ?? state;
    // selectNodeContents 是 void 方法，不能链式调用。
    const range = document.createRange();
    range.selectNodeContents(label);
    const stateRect = state.getBoundingClientRect();
    const factRect = fact.getBoundingClientRect();
    return {
      text: state.innerText.trim(),
      labelLines: range.getClientRects().length,
      stateScroll: state.scrollWidth - state.clientWidth,
      stateOverflow: Math.round(stateRect.right - factRect.right),
      leftGutter: Math.round(row.getBoundingClientRect().left),
      rightGutter: Math.round(window.innerWidth - factRect.right),
    };
  });
}

await check("超时未处理的挂靠绝不显示成空闲（light 1440px）", async () => {
  const { context, page, errors } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await enableTimeoutScene(page);
    await openLease(page, "工作室 Mac mini");

    const row = leaseRow(page, "工作室 Mac mini");
    await row.waitFor();
    // 状态位互斥：超时并进状态位，而不是让挂靠行看起来照旧、或干脆显示成空闲。
    const state = (await row.getByTestId("lease-state").innerText()).trim();
    assert.equal(state, "挂靠中 · 超时未处理");
    // 状态位本身就替掉了空闲，不再并列「空闲」这种读法。
    assert.notEqual(state, "空闲");

    const fact = row.locator("[data-timeout-phase]");
    assert.equal(await fact.count(), 1);
    assert.equal(await fact.getAttribute("data-timeout-phase"), "awaiting");
    const factText = await fact.innerText();
    assert.match(factText, /超时未处理/);
    assert.match(factText, /挂靠时限 30 分钟/);
    assert.match(factText, /提醒已发送/);
    // T11：等待中的申请方拿到的是「保留原因」，不是「空闲」。
    assert.match(factText, /挂靠超时未处理，租约仍被占用/);
    // 两种时限必须在同一屏里说清不是同一个倒计时。
    assert.match(factText, /建议 5 分钟、上限 1 小时/);
    assert.match(factText, /不是同一个倒计时/);

    // 反证清单第 6/8 条在界面上的对应：整行都不许出现「空闲」这种读法。
    assert.doesNotMatch(await row.innerText(), /空闲/);

    const overflowed = await contentColumnOverflow(page);
    assert.ok(overflowed.scroll <= 1, `租约页横向滚动 ${overflowed.scroll}px`);
    assert.ok(overflowed.ink <= 1, `超时事实溢出内容列 ${overflowed.ink}px`);

    // I-P8a 的取舍不能回退：这条路径上没有任何人类可直接执行的挂靠入口。
    for (const forbidden of ["领取挂靠", "认领挂靠", "新增挂靠", "撤销挂靠"]) {
      assert.equal(await page.getByRole("button", { name: forbidden }).count(), 0);
    }

    await shootAt(page, "machine-lease-detail", "lease-timeout-facts-light-1440");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await check("已升级的挂靠说清升级事实与暂停自动尝试（light 1440px）", async () => {
  const { context, page, errors } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await enableTimeoutScene(page);
    await openLease(page, "刚唤醒的 Mac Studio");

    const row = leaseRow(page, "刚唤醒的 Mac Studio");
    assert.equal(
      (await row.getByTestId("lease-state").innerText()).trim(),
      "挂靠中 · 已升级给人类",
    );
    const fact = row.locator("[data-timeout-phase]");
    assert.equal(await fact.getAttribute("data-timeout-phase"), "escalated");
    const factText = await fact.innerText();
    assert.match(factText, /已升级给人类/);
    assert.match(factText, /升级时限 2 小时/);
    assert.match(factText, /自动尝试已暂停/);
    // 人类入口只有既有的两个：这条路径上不出现新的可执行按钮。
    assert.match(factText, /强制收回/);
    assert.match(factText, /撤销挂靠/);
    assert.equal(await fact.locator("button").count(), 0);

    const section = await page.getByTestId("machine-lease-detail").innerText();
    for (const forbidden of ["挂靠租约", "领取挂靠", "认领挂靠", "新增挂靠"]) {
      assert.equal(await page.getByRole("button", { name: forbidden }).count(), 0);
      assert.doesNotMatch(section, new RegExp(forbidden));
    }
    assert.equal(await page.locator('[data-testid^="lease-timeout-"] button').count(), 0);

    await shootAt(page, "machine-lease-detail", "lease-timeout-escalated-light-1440");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await check("未到时限的挂靠不带超时标记，只给保留原因（light 1440px）", async () => {
  const { context, page, errors } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await enableTimeoutScene(page);
    await openLease(page, "已断线的旧款 MacBook Pro");

    const pending = leaseRow(page, "已断线的旧款 MacBook Pro");
    assert.equal((await pending.getByTestId("lease-state").innerText()).trim(), "挂靠中");
    assert.equal(
      await pending.locator("[data-timeout-phase]").getAttribute("data-timeout-phase"),
      "none",
    );
    assert.match(await pending.innerText(), /挂靠待处理，租约仍被占用/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// 领取之后挂靠关闭：契约只把活跃挂靠留在 `LeaseView.escrow` 上（`claimed` 是终端状态），
// 所以「领取后不再超时」在界面上的形态就是「没有挂靠行、也没有超时事实」。
// 演示数据里只有三台 Machine 有 binding（[0] 工作室 Mac mini / [2] 刚唤醒的 Mac Studio /
// [3] 已断线的旧款 MacBook Pro），租约页只能逐台打开，这里用 [2] 这条没有活跃挂靠的租约做对照。
await check("没有活跃挂靠的租约不呈现挂靠行与超时事实（light 1440px）", async () => {
  const { context, page, errors } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await enableEscrowScene(page);
    await openLease(page, "刚唤醒的 Mac Studio");

    const held = leaseRow(page, "刚唤醒的 Mac Studio");
    await held.waitFor();
    assert.equal((await held.getByTestId("lease-state").innerText()).trim(), "持有中");
    assert.equal(await held.locator("[data-timeout-phase]").count(), 0);
    assert.equal(await held.locator('[data-testid^="lease-escrow-"]').count(), 0);
    assert.doesNotMatch(await held.innerText(), /超时/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await check("挂靠超时提醒在 Chat 里是一条消息，不像按钮（light 1440px）", async () => {
  const { context, page, errors } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "light",
    scene: "chat-messages",
  });
  try {
    const notice = page.locator('[data-testid="message-item"]').filter({ hasText: "【挂靠超时】" });
    await notice.waitFor();
    // 提醒不是成员：靠保留 sender id 显示成「挂靠超时提醒」，而不是通用 Agent 名。
    assert.equal((await notice.getByTestId("message-sender").innerText()).trim(), "挂靠超时提醒");
    const text = await notice.innerText();
    assert.match(text, /已经超过 30 分钟/);
    // 「不触发唤醒」只来自域层正文（人类 owner 的那版），不是界面另加的声明。
    assert.match(text, /不触发唤醒/);
    assert.match(text, /不触发自动接续/);
    // T4：它是一条消息，不是「点了会发生什么」；也不该显示成没有运行关联的异常。
    assert.equal(await notice.locator("a").count(), 0);
    assert.equal(await notice.locator("button").count(), 0);
    assert.equal(await notice.getByTestId("message-notice").count(), 0);
    assert.equal(await notice.getByTestId("message-run-links").count(), 0);
    // 不是历史发送者：它就在这场对话里，不该挂「已移出 · 历史发送者」。
    assert.equal(await notice.locator('[data-testid="message-history-badge"]').count(), 0);

    await notice.scrollIntoViewIfNeeded();
    await shoot(page, "chat-timeout-message-light-1440");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await check("窄屏下超时事实不溢出、状态标签不拆词（light 390px）", async () => {
  const { context, page, errors } = await open({
    width: 390,
    height: 900,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await enableTimeoutScene(page);
    await openLease(page, "工作室 Mac mini");
    await page.locator('[data-testid^="lease-timeout-"]').first().waitFor();
    const over = await overflow(page);
    assert.ok(over <= 1, `横向溢出 ${over}px`);
    // 窄屏下超时事实要能换行，不能撑破内容列（视觉核查在这里量到过 131px）。
    const overflowed = await contentColumnOverflow(page);
    assert.ok(overflowed.scroll <= 1, `租约页横向滚动 ${overflowed.scroll}px`);
    assert.ok(overflowed.ink <= 1, `超时事实溢出内容列 ${overflowed.ink}px`);
    // 截图里必须是对应的那个相位：上一版视觉核查在这两张图上看到的是「已升级」。
    const layout = await timeoutFactLayout(page);
    assert.ok(layout.text.startsWith("超时未处理"), `相位行是「${layout.text.split("\n")[0]}」`);
    assert.equal(layout.labelLines, 1, `状态标签被折成 ${layout.labelLines} 行`);
    assert.ok(layout.stateScroll <= 1, `状态位横向溢出 ${layout.stateScroll}px`);
    assert.ok(layout.stateOverflow <= 1, `状态位超出事实块 ${layout.stateOverflow}px`);
    assert.ok(
      Math.abs(layout.leftGutter - layout.rightGutter) <= 2,
      `左右留白不对称（左 ${layout.leftGutter}px，右 ${layout.rightGutter}px）`,
    );
    await shootAt(page, "machine-lease-detail", "lease-timeout-facts-light-390");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }

  // 升级态的标签最长（「已升级给人类」），窄屏拆词就是在这条上出的；单独留一张图。
  const escalated = await open({
    width: 390,
    height: 900,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await enableTimeoutScene(escalated.page);
    await openLease(escalated.page, "刚唤醒的 Mac Studio");
    await escalated.page.locator('[data-testid^="lease-timeout-"]').first().waitFor();
    const layout = await timeoutFactLayout(escalated.page);
    assert.ok(layout.text.startsWith("已升级给人类"), `相位行是「${layout.text.split("\n")[0]}」`);
    assert.equal(layout.labelLines, 1, `状态标签被折成 ${layout.labelLines} 行`);
    assert.ok(layout.stateScroll <= 1, `状态位横向溢出 ${layout.stateScroll}px`);
    const overflowed = await contentColumnOverflow(escalated.page);
    assert.ok(overflowed.scroll <= 1, `租约页横向滚动 ${overflowed.scroll}px`);
    assert.ok(overflowed.ink <= 1, `超时事实溢出内容列 ${overflowed.ink}px`);
    await shootAt(escalated.page, "machine-lease-detail", "lease-timeout-escalated-light-390");
    assert.deepEqual(escalated.errors, []);
  } finally {
    await escalated.context.close();
  }
});

await check("深色主题下超时事实与提醒都可读（dark 1200px）", async () => {
  const machine = await open({
    width: 1200,
    height: 1000,
    colorScheme: "dark",
    scene: "machines",
  });
  try {
    await enableTimeoutScene(machine.page);
    await openLease(machine.page, "工作室 Mac mini");
    // 深色图也必须是「超时未处理」那个相位：上一版就是这张图悄悄渲染成了「已升级」。
    const darkLayout = await timeoutFactLayout(machine.page);
    assert.ok(
      darkLayout.text.startsWith("超时未处理"),
      `深色图的相位行是「${darkLayout.text.split("\n")[0]}」`,
    );
    await shootAt(machine.page, "machine-lease-detail", "lease-timeout-facts-dark-1200");
    assert.deepEqual(machine.errors, []);
  } finally {
    await machine.context.close();
  }

  const chat = await open({
    width: 1200,
    height: 1000,
    colorScheme: "dark",
    scene: "chat-messages",
  });
  try {
    const notice = chat.page
      .locator('[data-testid="message-item"]')
      .filter({ hasText: "【挂靠超时】" });
    await notice.scrollIntoViewIfNeeded();
    await shoot(chat.page, "chat-timeout-message-dark-1200");
    assert.deepEqual(chat.errors, []);
  } finally {
    await chat.context.close();
  }
});

await check("演示场景不向业务接口发请求", async () => {
  assert.deepEqual(applicationRequests, []);
});

await browser.close();

const failed = results.filter((result) => !result.passed);
console.log(`\nresults: ${results.length} checks, ${failed.length} failed`);
console.log(`evidence: ${evidence}`);
process.exit(failed.length === 0 ? 0 : 1);
