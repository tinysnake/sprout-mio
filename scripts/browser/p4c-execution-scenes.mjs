import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

// 长命令演示场景的浏览器核对：只连本机 dev server，不连业务服务，不产生远端执行。
const base = process.env.SPROUT_EXECUTION_SCENES_URL ?? "http://127.0.0.1:3098/__dev/ui/";
const evidence = resolve(process.env.SPROUT_EXECUTION_SCENES_EVIDENCE ?? ".verify/p4c-ui/evidence");
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
  url.searchParams.set("scene", "machines");
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  return { context, page, errors };
}

const shoot = (page, name) =>
  page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true, animations: "disabled" });

async function shootAt(page, locator, name) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(120);
  await shoot(page, name);
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 真实命令正文与路径不得出现在界面上（standing order #14 同样适用于截图）。 */
const secrets = [
  "pnpm build",
  "tail -f app.log",
  "/Users/linche/workspace",
  "secret-stack-detail",
  "DEMO_LOG_NETWORK_FAILURE",
];

async function gotoExecutions(page) {
  await page.getByTestId("machine-executions-link").click();
  await page.getByTestId("executions-scene").waitFor();
}

/** 断言：卡片正文不含真实命令、路径、抛错细节。 */
async function assertNoSecrets(scope, label) {
  const texts = await scope.allInnerTexts();
  for (const demo of secrets) {
    for (const text of texts) {
      assert.doesNotMatch(text, new RegExp(escapeRegExp(demo)), `${label} 回显了 ${demo}`);
    }
  }
}

// 浅暗主题 × 四个宽度：900px / 1200px 边界两侧都要呈现。
for (const colorScheme of ["light", "dark"]) {
  for (const width of [390, 900, 901, 1200, 1440]) {
    await check(`长命令场景 ${colorScheme} ${width}px 呈现`, async () => {
      const { context, page, errors } = await open({ width, height: 1000, colorScheme });
      try {
        await gotoExecutions(page);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        assert.ok(overflow <= 1, `主体横向溢出 ${overflow}px`);

        // 稳定定位：执行 id 与下发会话/序号是两个不同的事实，都可见。
        const first = page.getByTestId("executions-demo-item").first();
        const identity = await first.getByTestId("executions-demo-item-identity").innerText();
        assert.match(identity, /执行 exe_/);
        assert.match(identity, /下发会话 代次 7 序号 12/);
        assert.doesNotMatch(identity, /run_/);

        // 下发窗口与运行上限分开列，值不同。
        const dispatch = await first
          .getByTestId("executions-demo-item-deadline-dispatch")
          .getAttribute("data-deadline-at");
        const runtime = await first
          .getByTestId("executions-demo-item-deadline-runtime")
          .getAttribute("data-deadline-at");
        assert.ok(dispatch, "下发窗口必须有值");
        assert.notEqual(dispatch, runtime, "两个截止时间不能是同一个值");

        // 未知与超时都不写成功。
        const states = await page
          .locator('[data-testid="executions-demo-item"]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-execution-state")));
        for (const state of ["succeeded", "timed_out", "unknown"])
          assert.ok(states.includes(state));

        // 不提供隐式重跑：页面上没有重跑按钮。
        assert.equal(
          await page.getByRole("button", { name: /重跑|重试|再执行/ }).count(),
          0,
          "不得提供会隐式重跑原命令的操作",
        );

        await assertNoSecrets(page.getByTestId("executions-demo-item"), "执行卡片");
        assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
        await shoot(page, `executions-${colorScheme}-${width}`);
      } finally {
        await context.close();
      }
    });
  }
}

// 日志不完整态：`partial` 与三个位点必须同时可见，且不写成「没有输出」。
await check("日志不完整态显示为不完整，并给三个位点", async () => {
  const { context, page } = await open({ width: 1200, height: 1000, colorScheme: "light" });
  try {
    await gotoExecutions(page);
    const long = page.locator('[data-testid="executions-demo-item"]', {
      hasText: "exe_55555555",
    });
    const log = long.getByTestId("executions-demo-item-log");
    assert.match(await log.getByTestId("executions-demo-item-log-state").innerText(), /日志不完整/);
    assert.match(
      await log.getByTestId("executions-demo-item-log-incomplete").innerText(),
      /不完整/,
    );
    const cursors = await log.getByTestId("executions-demo-item-log-cursors").innerText();
    assert.match(cursors, /已产出到 #24/);
    assert.match(cursors, /Worker 已确认到 #18/);
    assert.match(cursors, /可读起点 #1/);

    await log.getByTestId("executions-demo-item-log-load").click();
    await log.getByTestId("executions-demo-item-log-rows").waitFor();
    assert.ok((await log.getByTestId("executions-demo-item-log-frame").count()) >= 6);
    // 一页有正文时也不能把「已确认到 #18」显示成读完了。
    assert.match(await log.getByTestId("executions-demo-item-log-state").innerText(), /不完整/);
    await shootAt(page, log, "log-partial");

    // 续读到产出位点后明确说明没有更多区段。
    await log.getByTestId("executions-demo-item-log-resume").click();
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="executions-demo-item-log-next-cursor"]');
      return node && node.textContent.includes("没有更多可读区段");
    });
    assert.match(
      await log.getByTestId("executions-demo-item-log-next-cursor").innerText(),
      /没有更多可读区段/,
    );
    await shootAt(page, log, "log-resumed");
  } finally {
    await context.close();
  }
});

// 裁剪态与缺口态：两条路径都不能写成成功或空。
await check("裁剪与缺口各自有明确文案", async () => {
  const { context, page } = await open({ width: 1200, height: 1000, colorScheme: "dark" });
  try {
    await gotoExecutions(page);
    const truncated = page.locator('[data-testid="executions-demo-item"]', {
      hasText: "exe_66666666",
    });
    const truncatedLog = truncated.getByTestId("executions-demo-item-log");
    assert.match(
      await truncatedLog.getByTestId("executions-demo-item-log-state").innerText(),
      /日志已裁剪/,
    );
    await truncatedLog.getByTestId("executions-demo-item-log-load").click();
    await truncatedLog.getByTestId("executions-demo-item-log-rows").waitFor();
    assert.match(
      await truncatedLog.getByTestId("executions-demo-item-log-cursors").innerText(),
      /可读起点 #31/,
    );
    await shootAt(page, truncatedLog, "log-truncated");

    const gap = page.locator('[data-testid="executions-demo-item"]', { hasText: "exe_77777777" });
    const gapLog = gap.getByTestId("executions-demo-item-log");
    assert.match(
      await gapLog.getByTestId("executions-demo-item-log-state").innerText(),
      /日志存在缺口/,
    );
    await gapLog.getByTestId("executions-demo-item-log-load").click();
    const gapRow = gapLog.getByTestId("executions-demo-item-log-gap");
    await gapRow.waitFor();
    assert.match(await gapRow.innerText(), /行缺失，内容未知/);
    // 缺口行不是空输出：它点名缺了哪些序号。
    assert.match(await gapRow.getAttribute("data-gap-from"), /52/);
    await shootAt(page, gapLog, "log-gap");

    // 缺口日志拒绝：游标早于可读起点时明确要求从新起点重读。
    await page.getByTestId("executions-demo-log-failure").selectOption("gap");
    await gapLog.getByTestId("executions-demo-item-log-load").click();
    const error = gapLog.getByTestId("executions-demo-item-log-error");
    await error.waitFor();
    assert.match(await error.innerText(), /新的可读起点/);
    await shootAt(page, gapLog, "log-cursor-rejected");
  } finally {
    await context.close();
  }
});

// 取消：送达不等于已停止；六态都有对应展示。
await check("取消六态都有展示，delivered 不写成已停止", async () => {
  const { context, page } = await open({ width: 1200, height: 1000, colorScheme: "light" });
  try {
    await gotoExecutions(page);
    const long = page.locator('[data-testid="executions-demo-item"]', {
      hasText: "exe_55555555",
    });
    const cancel = long.getByTestId("executions-demo-item-cancel");
    // 已成功的执行也有取消事实：送达中，没有观察到退出。
    const delivered = cancel.getByTestId("executions-demo-item-cancel-state");
    await delivered.waitFor();
    assert.equal(await delivered.getAttribute("data-cancellation-state"), "delivered");
    assert.equal(await delivered.getAttribute("data-stopped"), "false");
    assert.match(
      await cancel.getByTestId("executions-demo-item-cancel-state-label").innerText(),
      /取消已送达/,
    );
    // 状态标签不能写成「已停止」；正文只允许用「送达不等于已停止」解释它。
    assert.notEqual(
      await cancel.getByTestId("executions-demo-item-cancel-state-label").innerText(),
      "已停止",
    );
    assert.match(await delivered.innerText(), /送达不等于已停止/);
    await shootAt(page, cancel, "cancel-delivered");

    for (const state of ["requested", "exited_observed", "already_exited", "failed", "unknown"]) {
      await page.getByTestId("executions-demo-cancel-state").selectOption(state);
      // 用仍在运行的执行发一次取消，避免终态执行禁用按钮。
      const target = page.locator('[data-testid="executions-demo-item"]', {
        hasText: "exe_66666666",
      });
      const control = target.getByTestId("executions-demo-item-cancel");
      await control.getByTestId("executions-demo-item-cancel-request").click();
      await page.waitForFunction((expected) => {
        const node = document.querySelector(
          '[data-testid="executions-demo-item"][data-execution-id="exe_66666666-6666-4666-8666-666666666666"] [data-testid="executions-demo-item-cancel-state"]',
        );
        return node && node.getAttribute("data-cancellation-state") === expected;
      }, state);
      const shown = control.getByTestId("executions-demo-item-cancel-state");
      assert.equal(await shown.getAttribute("data-cancellation-state"), state);
      const stopped = await shown.getAttribute("data-stopped");
      assert.equal(
        stopped,
        state === "exited_observed" || state === "already_exited" ? "true" : "false",
        `${state} 的停止语义`,
      );
      if (state !== "exited_observed" && state !== "already_exited") {
        const label = await control
          .getByTestId("executions-demo-item-cancel-state-label")
          .innerText();
        assert.notEqual(label, "已停止", `${state} 不能显示为已停止`);
      }
      if (state === "failed") assert.match(await shown.innerText(), /取消失败/);
      await shootAt(page, control, `cancel-${state}`);
    }
  } finally {
    await context.close();
  }
});

// 未知结果：不显示成功，也没有重跑入口。
await check("未知结果不显示为成功，也不提供隐式重跑", async () => {
  const { context, page } = await open({ width: 1200, height: 1000, colorScheme: "light" });
  try {
    await gotoExecutions(page);
    const unknown = page.locator('[data-testid="executions-demo-item"]', {
      hasText: "exe_77777777",
    });
    assert.match(await unknown.getByTestId("executions-demo-item-state").innerText(), /结果未知/);
    const uncertain = await unknown.getByTestId("executions-demo-item-uncertain").innerText();
    assert.match(uncertain, /结果未知/);
    assert.match(uncertain, /不会在这里重发原命令/);
    assert.doesNotMatch(uncertain, /成功/);
    assert.match(
      await unknown.getByTestId("executions-demo-item-no-rerun").innerText(),
      /不提供重跑/,
    );
    await shootAt(page, unknown, "result-unknown");

    // 超时同样只说超时，并点名来源。
    const timedOut = page.locator('[data-testid="executions-demo-item"]', {
      hasText: "exe_33333333",
    });
    assert.match(await timedOut.getByTestId("executions-demo-item-state").innerText(), /超时/);
    assert.doesNotMatch(
      await timedOut.getByTestId("executions-demo-item-state").innerText(),
      /成功/,
    );
    await shootAt(page, timedOut, "result-timed-out");
  } finally {
    await context.close();
  }
});

// 断线与重连：断线时说明信息完整性，重连后仍是同一条执行。
await check("断线说明信息完整性，重连后继续查看同一执行", async () => {
  const { context, page } = await open({ width: 1200, height: 1000, colorScheme: "light" });
  try {
    await gotoExecutions(page);
    const gap = page.locator('[data-testid="executions-demo-item"]', { hasText: "exe_77777777" });
    const gapLog = gap.getByTestId("executions-demo-item-log");
    await gapLog.getByTestId("executions-demo-item-log-load").click();
    await gapLog.getByTestId("executions-demo-item-log-rows").waitFor();
    const before = await gapLog.getByTestId("executions-demo-item-log-cursors").innerText();

    await page.getByTestId("executions-demo-go-offline").click();
    await page.getByTestId("executions-demo-connection").waitFor();
    assert.match(await page.getByTestId("executions-demo-connection").innerText(), /断线/);
    const offline = page.getByTestId("executions-demo-offline");
    await offline.waitFor();
    const offlineText = await offline.innerText();
    assert.match(offlineText, /连接已断开/);
    assert.match(offlineText, /不能当作当前状态/);
    // 断线不清空已读到的日志：位点与行都还在。
    assert.equal(await gapLog.getByTestId("executions-demo-item-log-cursors").innerText(), before);
    assert.ok((await gapLog.getByTestId("executions-demo-item-log-frame").count()) >= 2);
    assert.match(
      await gapLog.getByTestId("executions-demo-item-log-offline").innerText(),
      /连接已断开/,
    );
    await shootAt(page, offline, "connection-offline");
    await shootAt(page, gapLog, "log-offline");

    await page.getByTestId("executions-demo-go-online").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="executions-demo-connection"]')
          ?.textContent?.includes("在线") === true,
    );
    // 重连后仍是同一条执行，位点还是同一个已知值。
    assert.equal(
      await gap.getByTestId("executions-demo-item-execution").getAttribute("title"),
      "exe_77777777-7777-4777-8777-777777777777",
    );
    assert.equal(await gapLog.getByTestId("executions-demo-item-log-cursors").innerText(), before);
    await shootAt(page, gap, "connection-reconnected");
  } finally {
    await context.close();
  }
});

// 900px / 1200px 边界：执行卡片在边界两侧都完整可读，不横向溢出。
await check("900px 与 1200px 边界两侧不横向溢出且日志可读", async () => {
  for (const width of [900, 901, 1199, 1200]) {
    const { context, page } = await open({ width, height: 1000, colorScheme: "dark" });
    try {
      await gotoExecutions(page);
      const gap = page.locator('[data-testid="executions-demo-item"]', { hasText: "exe_77777777" });
      const gapLog = gap.getByTestId("executions-demo-item-log");
      await gapLog.getByTestId("executions-demo-item-log-load").click();
      await gapLog.getByTestId("executions-demo-item-log-rows").waitFor();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      assert.ok(overflow <= 1, `${width}px 横向溢出 ${overflow}px`);
      await shootAt(page, gapLog, `boundary-${width}`);
    } finally {
      await context.close();
    }
  }
});

await check("演示场景不向业务接口发请求", async () => {
  assert.deepEqual(applicationRequests, []);
});

await browser.close();

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} 检查通过；证据目录 ${evidence}`);
if (failed.length > 0) {
  for (const result of failed) console.log(`FAILED ${result.name} :: ${result.detail}`);
  process.exit(1);
}
