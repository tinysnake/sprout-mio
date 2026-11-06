import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

// 强制移除界面的浏览器核对：只连本机 dev server 的演示场景，不连业务服务，不产生远端执行。
// 演示数据从服务端契约 schema 解析，但页面本身不读数据库，所以这里只验证呈现与交互。
const base = process.env.SPROUT_P8C_UI_URL ?? "http://127.0.0.1:3199/__dev/ui/";
const evidence = resolve(process.env.SPROUT_P8C_UI_EVIDENCE ?? ".verify/p8c-ui/evidence");
mkdirSync(evidence, { recursive: true });

const AGENT_ID = "agp_33333333";
const memberRow = `[data-testid="member-item"][data-agent-profile-id="${AGENT_ID}"]`;
const memberRemove = `${memberRow} [data-testid="member-remove"]`;

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

async function open({ width, height, colorScheme }) {
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
  url.searchParams.set("scene", "members");
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.getByTestId("member-list").waitFor();
  return { context, page, errors };
}

const shoot = (page, name, fullPage = true) =>
  page.screenshot({ path: join(evidence, `${name}.png`), fullPage, animations: "disabled" });

/** 打开常规移除确认框（阻塞开关关闭时）。 */
async function openConfirm(page) {
  await page.locator(memberRemove).click();
  await page.getByTestId("confirm-member-mutation").waitFor();
}

/** 打开被阻塞的确认框：先开演示开关，再点移除并提交一次，服务端拒绝后进入阻塞态。 */
async function openBlocked(page) {
  await page.getByTestId("scene-blocked").check();
  await page.locator(memberRemove).click();
  await page.getByTestId("confirm-member-mutation").click();
  await page.getByTestId("member-removal-blockers").waitFor();
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert.ok(overflow <= 1, `${label} 无横向溢出（超出 ${overflow}px）`);
}

/** 主操作必须在首次打开时就落在视口内：长清单不能把按钮推到看不见的地方。 */
async function assertActionVisible(page, testId, label) {
  const viewport = page.viewportSize();
  const box = await page.getByTestId(testId).boundingBox();
  assert.ok(box, `${label} 可见`);
  assert.ok(
    box.y >= 0 && box.y + box.height <= viewport.height,
    `${label} 在视口内（y=${box.y} h=${box.height} viewport=${viewport.height}）`,
  );
}

for (const colorScheme of ["dark", "light"]) {
  await check(`常规确认框只给一次确认（${colorScheme}）`, async () => {
    const { context, page, errors } = await open({ width: 1280, height: 800, colorScheme });
    try {
      await openConfirm(page);
      assert.equal(await page.getByTestId("member-removal-blockers").count(), 0);
      assert.equal(await page.getByTestId("force-remove-member").count(), 0);
      await shoot(page, `p8c-confirm-${colorScheme}`, false);
      await page.getByTestId("cancel-member-mutation").click();
      assert.equal(await page.locator(memberRow).count(), 1, "取消后成员仍在");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  await check(`阻塞确认框给出前置说明与一次确认入口（${colorScheme}）`, async () => {
    const { context, page, errors } = await open({ width: 1280, height: 800, colorScheme });
    try {
      await openBlocked(page);
      for (const kind of ["active_runs", "leases", "owner_duties", "dm_assigned_tasks"]) {
        assert.equal(await page.getByTestId(`member-blocker-${kind}`).count(), 1, kind);
      }
      assert.equal(
        await page.locator('[data-testid="member-removal-blockers"][data-mode="force"]').count(),
        1,
      );
      // 阻塞态保留原有的「确认移除」重试入口（p6c 门禁依赖它可见），
      // 并在它右侧追加一次确认的强制入口；两条路径标签不同，语义可分。
      assert.equal(await page.getByTestId("confirm-member-mutation").count(), 1);
      assert.equal(await page.getByTestId("force-remove-member").count(), 1);
      await assertActionVisible(page, "force-remove-member", "强制移除按钮");
      await assertActionVisible(page, "confirm-member-mutation", "确认移除按钮");
      await assertNoHorizontalOverflow(page, "阻塞确认框");
      await shoot(page, `p8c-blocked-${colorScheme}`, false);
      await page.getByTestId("cancel-member-mutation").click();
      assert.equal(await page.locator(memberRow).count(), 1, "取消后成员仍在");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  await check(`强制移除后呈现善后结果与占用待处理（${colorScheme}）`, async () => {
    const { context, page, errors } = await open({ width: 1280, height: 800, colorScheme });
    try {
      await openBlocked(page);
      await page.getByTestId("force-remove-member").click();
      await page.getByTestId("member-removal-outcome").waitFor();
      assert.equal(await page.locator(memberRow).count(), 0, "成员行已移除");
      assert.equal(await page.getByTestId("member-removal-aborted-runs").count(), 1);
      assert.equal(await page.getByTestId("member-removal-transferred-chats").count(), 1);
      assert.equal(await page.getByTestId("member-removal-unassigned-tasks").count(), 1);
      assert.equal(await page.getByTestId("member-removal-released-leases").count(), 1);
      const retained = page.locator(
        '[data-testid="member-removal-lease"][data-lease-outcome="retained"]',
      );
      const untouched = page.locator(
        '[data-testid="member-removal-lease"][data-lease-outcome="untouched"]',
      );
      assert.equal(await retained.count(), 1, "retained 租约");
      assert.equal(await untouched.count(), 1, "未处理租约");
      const retainedText = (await retained.innerText()).replace(/\s+/g, "");
      assert.ok(retainedText.includes("等待Worker确认"), `retained 文案：${retainedText}`);
      assert.ok(retainedText.includes("不等于空闲"), `retained 文案：${retainedText}`);
      const untouchedText = (await untouched.innerText()).replace(/\s+/g, "");
      assert.ok(untouchedText.includes("本次未处理"), `untouched 文案：${untouchedText}`);
      await assertNoHorizontalOverflow(page, "善后结果");
      await shoot(page, `p8c-outcome-${colorScheme}`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

await check("窄屏（390px）阻塞确认框与善后结果不横向溢出", async () => {
  const { context, page, errors } = await open({
    width: 390,
    height: 844,
    colorScheme: "dark",
  });
  try {
    await openBlocked(page);
    await assertActionVisible(page, "force-remove-member", "窄屏强制移除按钮");
    await assertNoHorizontalOverflow(page, "窄屏阻塞确认框");
    await shoot(page, "p8c-blocked-mobile", false);
    await page.getByTestId("force-remove-member").click();
    await page.getByTestId("member-removal-outcome").waitFor();
    await assertNoHorizontalOverflow(page, "窄屏善后结果");
    await shoot(page, "p8c-outcome-mobile");
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
