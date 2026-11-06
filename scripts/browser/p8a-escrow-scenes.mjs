import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

// 挂靠与领取的演示场景核对：只连本机 dev server，用演示数据，不连业务服务。
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

/** 演示控制收在 details 里：先展开，再开挂靠场景，最后收回，避免遮挡截图。 */
async function enableEscrowScene(page, outcome = "success") {
  const controls = page.getByTestId("machine-scene-controls");
  await controls.locator("summary").click();
  await page.getByTestId("machine-demo-escrow-scene").check();
  if (outcome !== "success") await page.getByTestId("machine-demo-escrow").selectOption(outcome);
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

await check("挂靠中的租约在 Machine 租约页可见并可撤销（light 1440px）", async () => {
  const { context, page, errors } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await enableEscrowScene(page);
    await openLease(page, "工作室 Mac mini");

    const entry = page.getByTestId("dev-lease-escrow");
    await entry.waitFor();
    assert.equal(await entry.getAttribute("data-escrow-state"), "escrowed");
    const entryText = await entry.innerText();
    assert.match(entryText, /挂靠中/);
    assert.match(entryText, /Public Channel/);
    assert.match(entryText, /文档 Agent/);
    assert.match(entryText, /撤销挂靠/);

    // 同一份挂靠事实也出现在只读的租约总览里。
    const overviewRow = page.locator('[data-testid^="lease-escrow-"]');
    assert.equal(await overviewRow.count(), 1);
    assert.equal(await overviewRow.first().getAttribute("data-escrow-state"), "escrowed");
    assert.match(await overviewRow.first().innerText(), /挂靠中/);
    await shootAt(page, "dev-lease-escrow", "lease-escrow-live-light-1440");

    await page.getByTestId("dev-lease-escrow-cancel").click();
    await page.waitForSelector(
      '[data-testid="dev-lease-escrow-receipt"][data-receipt-state="cancelled"]',
    );
    assert.equal(await entry.getAttribute("data-escrow-state"), "none");
    await page.getByTestId("dev-lease-escrow-form").waitFor();
    assert.equal(await page.locator('[data-testid^="lease-escrow-"]').count(), 0);
    await shootAt(page, "dev-lease-escrow", "lease-escrow-cancelled-light-1440");

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await check("持有者可以把租约挂靠给 Group（light 1440px）", async () => {
  const { context, page, errors } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await enableEscrowScene(page);
    await openLease(page, "刚唤醒的 Mac Studio");

    await page.getByTestId("dev-lease-escrow-form").waitFor();
    const chat = page.getByTestId("dev-lease-escrow-chat");
    // fixture：demoEscrowTargets.group（cnv_55555555 / 发布协作组）
    await chat.selectOption("cnv_55555555");
    assert.match(await page.getByTestId("dev-lease-escrow-holder-chat").innerText(), /发布协作组/);
    await page.getByTestId("dev-lease-escrow-submit").click();
    await page.waitForSelector(
      '[data-testid="dev-lease-escrow-receipt"][data-receipt-state="escrowed"]',
    );
    const entry = page.getByTestId("dev-lease-escrow");
    assert.equal(await entry.getAttribute("data-escrow-state"), "escrowed");
    assert.match(await entry.innerText(), /挂靠中/);
    await shootAt(page, "dev-lease-escrow", "lease-escrow-created-light-1440");

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await check("挂靠被服务端拒绝时保留用户选定的目标（dark 1440px）", async () => {
  const { context, page, errors } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "dark",
    scene: "machines",
  });
  try {
    await enableEscrowScene(page, "conflict");
    await openLease(page, "刚唤醒的 Mac Studio");

    const chat = page.getByTestId("dev-lease-escrow-chat");
    // fixture：demoEscrowTargets.group（cnv_55555555 / 发布协作组）
    await chat.selectOption("cnv_55555555");
    await page.getByTestId("dev-lease-escrow-submit").click();
    await page.getByTestId("dev-lease-escrow-error").waitFor();
    assert.equal(await chat.inputValue(), "cnv_55555555");
    assert.equal(
      await page.getByTestId("dev-lease-escrow").getAttribute("data-escrow-state"),
      "none",
    );
    await shootAt(page, "dev-lease-escrow", "lease-escrow-conflict-dark-1440");

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await check("窄屏下挂靠区块没有横向溢出（light 390px）", async () => {
  const { context, page, errors } = await open({
    width: 390,
    height: 900,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await enableEscrowScene(page);
    await openLease(page, "工作室 Mac mini");
    await page.getByTestId("dev-lease-escrow").waitFor();
    await page.getByTestId("dev-lease-escrow-live").waitFor();
    assert.ok((await overflow(page)) <= 1, `横向溢出 ${await overflow(page)}px`);
    await shootAt(page, "dev-lease-escrow", "lease-escrow-live-light-390");

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await check("Chat 里领取挂靠：DM 说明、待领取、领取收据（light 1440px）", async () => {
  const { context, page, errors } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "light",
    scene: "chat",
  });
  try {
    // 演示场景的初始地址就带 ?info=1，inspector 默认打开。
    assert.equal(await page.getByTestId("toggle-inspector").getAttribute("aria-expanded"), "true");
    await page.getByTestId("chat-lease-escrow-dm-note").waitFor();
    assert.equal(await page.getByTestId("chat-lease-escrow").getAttribute("data-inbound"), "0");
    await shootAt(page, "chat-lease-escrow", "chat-claim-dm-note-light-1440");

    await page.locator('[data-chat-id="cnv_55555555"]').click();
    const inbound = page.locator('[data-testid^="chat-lease-escrow-inbound-"]');
    await inbound.first().waitFor();
    assert.equal(await page.getByTestId("chat-lease-escrow").getAttribute("data-inbound"), "1");
    assert.match(await inbound.first().innerText(), /待领取/);
    assert.match(await inbound.first().innerText(), /发布协作组/);
    await shootAt(page, "chat-lease-escrow", "chat-claim-inbound-light-1440");

    await page.locator('[data-testid^="chat-lease-escrow-claim-"]').first().click();
    const settled = page.locator('[data-testid^="chat-lease-escrow-settled-"]');
    await settled.first().waitFor();
    assert.equal(await settled.first().getAttribute("data-receipt-state"), "claimed");
    assert.match(await settled.first().innerText(), /挂靠收据/);
    assert.equal(await page.getByTestId("chat-lease-escrow").getAttribute("data-inbound"), "0");
    await shootAt(page, "chat-lease-escrow", "chat-claim-settled-light-1440");

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
