import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

// 挂靠事实的演示场景核对：只连本机 dev server，用演示数据，不连业务服务。
// v2 起挂靠没有人类入口：界面只把挂靠投影成租约行上的一条事实，因此这里断言的是事实与缺席。
const base = process.env.SPROUT_P8A_ESCROW_URL ?? "http://127.0.0.1:3099/__dev/ui/";
const evidence = resolve(process.env.SPROUT_P8A_ESCROW_EVIDENCE ?? ".verify/p8a-ui/evidence");
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

/** 演示控制收在 details 里：先展开，打开「两台已挂靠的 Machine」，再收回，避免遮挡截图。 */
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

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** Chat 侧（真实 inspector 与演示 Info Hub 快照）的共同断言：只剩既有租约状态。 */
async function assertOnlyLeaseFacts(page, name) {
  const facts = page.getByTestId("chat-machine-facts").first();
  await facts.waitFor();
  const leases = page.getByTestId("chat-leases").first();
  await leases.waitFor();
  const text = await facts.innerText();
  // 挂靠只投影成租约行上的一条事实：状态位「挂靠中」+ 目标 + 发起者。
  assert.match(text, /挂靠中/);
  assert.match(text, /发布公告频道/);
  assert.match(text, /指定 Agent 文档 Agent/);
  assert.match(text, /由 重构搭档 发起/);
  // 代次不呈现，说明文案、远端操作表格与柱状汇总都不在 inspector 里。
  assert.doesNotMatch(text, /代次/);
  assert.doesNotMatch(text, /远端操作/);
  assert.equal(await page.getByTestId("chat-leases-dense-note").count(), 0);
  assert.equal(await page.getByTestId("chat-execution-targets").count(), 0);
  assert.equal(await page.getByTestId("chat-executions").count(), 0);
  // 挂靠没有人类入口：没有待领取、领取、撤销或收据。
  assert.equal(await page.locator('[data-testid^="chat-lease-escrow"]').count(), 0);
  await shootAt(page, "chat-machine-facts", name);
}

await check("挂靠中的租约在 Machine 租约页只呈现一行事实（light 1440px）", async () => {
  const { context, page, errors } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await enableEscrowScene(page);
    await openLease(page, "工作室 Mac mini");

    const row = page.locator('[data-testid^="lease-row-"]').filter({ hasText: "工作室 Mac mini" });
    await row.waitFor();
    // 状态位互斥：挂靠中替代持有中，不再并列「持有中 · 代次 N」。
    assert.equal((await row.getByTestId("lease-state").innerText()).trim(), "挂靠中");

    const fact = row.locator('[data-testid^="lease-escrow-"]');
    assert.equal(await fact.count(), 1);
    assert.equal(await fact.getAttribute("data-escrow-state"), "escrowed");
    const factText = await fact.innerText();
    assert.match(factText, /挂靠中/);
    assert.match(factText, /Public Channel/);
    assert.match(factText, /指定 Agent 文档 Agent/);
    assert.match(factText, /由 重构搭档 发起/);

    // 整页租约小节：不出现「代次」，也没有挂靠表单、按钮与收据。
    const section = await page.getByTestId("machine-lease-detail").innerText();
    assert.doesNotMatch(section, /代次/);
    assert.doesNotMatch(section, /挂靠租约|撤销挂靠|挂靠代次|挂靠收据/);
    assert.equal(await page.locator('[data-testid^="dev-lease-escrow"]').count(), 0);
    assert.equal(await page.getByRole("button", { name: "挂靠租约" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "撤销挂靠" }).count(), 0);

    await shootAt(page, "machine-lease-detail", "lease-escrow-fact-light-1440");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await check("Chat inspector 只呈现既有租约状态（light 1440px）", async () => {
  const { context, page, errors } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "light",
    scene: "chat",
  });
  try {
    // 演示场景的初始地址就带 ?info=1，inspector 默认打开。
    assert.equal(await page.getByTestId("toggle-inspector").getAttribute("aria-expanded"), "true");
    await assertOnlyLeaseFacts(page, "chat-inspector-leases-light-1440");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await check("演示 Info Hub 快照同样只剩租约状态（dark 1200px）", async () => {
  const { context, page, errors } = await open({
    width: 1200,
    height: 1000,
    colorScheme: "dark",
    scene: "chat-inspector",
  });
  try {
    await assertOnlyLeaseFacts(page, "info-hub-lease-facts-dark-1200");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await check("窄屏下租约事实没有横向溢出（light 390px）", async () => {
  const { context, page, errors } = await open({
    width: 390,
    height: 900,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await enableEscrowScene(page);
    await openLease(page, "工作室 Mac mini");
    const fact = page.locator('[data-testid^="lease-escrow-"]').first();
    await fact.waitFor();
    assert.ok((await overflow(page)) <= 1, `横向溢出 ${await overflow(page)}px`);
    await shootAt(page, "machine-lease-detail", "lease-escrow-fact-light-390");

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
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
