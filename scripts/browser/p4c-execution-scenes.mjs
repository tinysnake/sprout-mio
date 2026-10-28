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

// 演示 fixture 的固定事实。断言直接写用户看到的名字与计数，不反过来从 DOM 推期望值。
const machines = {
  studio: "mch_11111111-1111-4111-8111-111111111111",
  wake: "mch_33333333-3333-4333-8333-333333333333",
  old: "mch_44444444-4444-4444-8444-444444444444",
};

const executionIds = {
  long: "exe_55555555-5555-4555-8555-555555555555",
  truncated: "exe_66666666-6666-4666-8666-666666666666",
  gap: "exe_77777777-7777-4777-8777-777777777777",
  timedOut: "exe_33333333-3333-4333-8333-333333333333",
  unknown: "exe_44444444-4444-4444-8444-444444444444",
};

const summaryFixtures = [
  {
    machineId: machines.studio,
    name: "工作室 Mac mini",
    total: 6,
    segments: [
      { state: "running", label: "运行中", count: 2 },
      { state: "succeeded", label: "成功", count: 2 },
      { state: "timed_out", label: "超时", count: 1 },
      { state: "unknown", label: "结果未知", count: 1 },
    ],
  },
  {
    machineId: machines.wake,
    name: "刚唤醒的 Mac Studio",
    total: 2,
    segments: [
      { state: "failed", label: "失败", count: 1 },
      { state: "unknown", label: "结果未知", count: 1 },
    ],
  },
  {
    machineId: machines.old,
    name: "断线的旧代次 MacBook Pro",
    total: 1,
    segments: [{ state: "running", label: "运行中", count: 1 }],
  },
];

async function gotoExecutions(page) {
  await page.getByTestId("machine-executions-link").click();
  await page.getByTestId("executions-scene").waitFor();
}

/** 断言：给定范围正文不含真实命令、路径、抛错细节。 */
async function assertNoSecrets(scope, label) {
  const texts = await scope.allInnerTexts();
  for (const demo of secrets) {
    for (const text of texts) {
      assert.doesNotMatch(text, new RegExp(escapeRegExp(demo)), `${label} 回显了 ${demo}`);
    }
  }
}

function summaryBlock(page, machineId) {
  return page.locator(`[data-testid="executions-demo-summary"][data-machine-id="${machineId}"]`);
}

function attentionItem(page, reason) {
  return page.locator(
    `[data-testid="executions-demo-attention"] [data-attention-reason="${reason}"]`,
  );
}

function debugButton(page, machineId) {
  return page.getByTestId(`executions-demo-debug-${machineId}-open`);
}

function debugDialog(page, machineId) {
  return page.getByTestId(`executions-demo-debug-${machineId}-dialog`);
}

async function openDebug(page, machineId) {
  await debugButton(page, machineId).click();
  const dialog = debugDialog(page, machineId);
  await dialog.waitFor();
  return dialog;
}

async function closeDebug(page, dialog) {
  await dialog.getByRole("button", { name: "关闭对话框" }).click();
  await dialog.waitFor({ state: "detached" });
}

function debugCard(dialog, machineId, executionId) {
  return dialog.locator(
    `[data-testid="executions-demo-debug-${machineId}-item"][data-execution-id="${executionId}"]`,
  );
}

/** 默认层：每台机器一行摘要，卡片与日志都收进「调试详情」。 */
async function assertDefaultLayer(page) {
  assert.equal(
    await page.getByTestId("executions-demo-item").count(),
    0,
    "默认层不应再平铺执行卡片",
  );
  assert.equal(await page.getByTestId("executions-demo-summary").count(), summaryFixtures.length);

  for (const fixture of summaryFixtures) {
    const block = summaryBlock(page, fixture.machineId);
    await block.waitFor();
    assert.equal(
      await block.getByTestId("executions-demo-summary-machine").innerText(),
      fixture.name,
    );
    assert.equal(await block.getAttribute("data-total"), String(fixture.total));
    assert.equal(
      await block.getByTestId("executions-demo-summary-total").innerText(),
      String(fixture.total),
    );
    assert.match(await block.innerText(), new RegExp(`共\\s*${fixture.total}\\s*次`));

    const segments = block.getByTestId("executions-demo-summary-bar").locator("[data-state]");
    assert.equal(await segments.count(), fixture.segments.length, `${fixture.name} 的分段数`);
    const shownStates = await segments.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-state")),
    );
    // 零值状态不出现：顺序与集合都必须和 fixture 的非零状态一致。
    assert.deepEqual(
      shownStates,
      fixture.segments.map((segment) => segment.state),
    );
    assert.deepEqual(
      await segments.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-count"))),
      fixture.segments.map((segment) => String(segment.count)),
    );

    // 分段宽度与计数成比例；零值状态没有分段，自然也没有宽度。
    const widths = await segments.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().width),
    );
    const unit = widths[0] / fixture.segments[0].count;
    for (const [index, segment] of fixture.segments.entries()) {
      assert.ok(
        Math.abs(widths[index] / segment.count - unit) <= 1.5,
        `${fixture.name} 的 ${segment.state} 段宽度 ${widths[index]} 不按 ${segment.count} 计数分配`,
      );
    }
    const aria = await block.getByTestId("executions-demo-summary-bar").getAttribute("aria-label");
    for (const segment of fixture.segments)
      assert.match(aria, new RegExp(`${segment.label} ${segment.count} 次`));

    const legend = block.getByTestId("executions-demo-summary-legend").locator("li");
    assert.equal(await legend.count(), fixture.segments.length);
    const legendTexts = await legend.allInnerTexts();
    for (const [index, segment] of fixture.segments.entries())
      assert.match(
        legendTexts[index],
        new RegExp(`${escapeRegExp(segment.label)}[\\s\\S]*${segment.count}`),
      );
  }
}

/** 只有真值得打断人的挂起执行出现在「需要处理」，且只有它能带取消按钮。 */
async function assertAttention(page) {
  const section = page.getByTestId("executions-demo-attention");
  await section.waitFor();
  assert.match(await section.innerText(), /需要处理/);
  assert.match(await section.innerText(), /3 条/);

  // 仍占着租约、跑了很久的执行：一条决策项，只有一个取消按钮。
  const longRunning = attentionItem(page, "running_too_long");
  assert.equal(await longRunning.count(), 1);
  assert.equal(await longRunning.getAttribute("data-attention-kind"), "decision");
  const longText = await longRunning.innerText();
  assert.match(longText, /长时间占用机器/);
  assert.match(longText, /运行中/);
  assert.match(longText, new RegExp(escapeRegExp(summaryFixtures[0].name)));
  assert.match(longText, /仍占着这台机器/);
  const longButtons = longRunning.getByRole("button");
  assert.equal(await longButtons.count(), 1, "长时间占用机器只给一个取消入口");
  assert.equal(await longButtons.first().innerText(), "取消这次执行");

  // 租约已不归它：只写事实与后果，不给取消。
  const released = attentionItem(page, "lease_released");
  assert.equal(await released.count(), 1);
  assert.equal(await released.getAttribute("data-attention-kind"), "pending");
  const releasedText = await released.innerText();
  assert.match(releasedText, /租约已释放/);
  assert.match(releasedText, new RegExp(escapeRegExp(summaryFixtures[2].name)));
  assert.match(releasedText, /取消此刻不会送到 Worker/);
  assert.equal(await released.getByRole("button").count(), 0, "租约已释放不应出现取消按钮");

  // 取消停在请求态超过窗口：可以重试取消，但不显示成已停止。
  const unconfirmed = attentionItem(page, "cancellation_unconfirmed");
  assert.equal(await unconfirmed.count(), 1);
  assert.equal(await unconfirmed.getAttribute("data-attention-kind"), "pending");
  assert.match(await unconfirmed.innerText(), /取消未确认/);
  const retry = unconfirmed.getByRole("button");
  assert.equal(await retry.count(), 1);
  assert.equal(await retry.first().innerText(), "重试取消");
}

/** 调试详情里保留旧卡片的全部事实。 */
async function assertDebugFacts(page, machineId) {
  const dialog = await openDebug(page, machineId);
  try {
    const prefix = `executions-demo-debug-${machineId}-item`;
    const cards = dialog.locator(`[data-testid="${prefix}"]`);
    assert.equal(await cards.count(), summaryFixtures[0].total);

    const first = cards.first();
    const identity = await first.getByTestId(`${prefix}-identity`).innerText();
    assert.match(identity, /执行 exe_/);
    assert.match(identity, /下发会话 代次 7 序号 12/);
    assert.doesNotMatch(identity, /run_/);

    const dispatch = await first
      .getByTestId(`${prefix}-deadline-dispatch`)
      .getAttribute("data-deadline-at");
    const runtime = await first
      .getByTestId(`${prefix}-deadline-runtime`)
      .getAttribute("data-deadline-at");
    assert.ok(dispatch, "下发窗口必须有值");
    assert.notEqual(dispatch, runtime, "两个截止时间不能是同一个值");

    const states = await cards.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-execution-state")),
    );
    for (const state of ["succeeded", "timed_out", "unknown", "running"])
      assert.ok(states.includes(state), `调试详情里应仍能看到 ${state}`);

    // 退出结果、保留限制、恢复原因都还在抽屉里。
    const longCard = debugCard(dialog, machineId, executionIds.long);
    assert.match(await longCard.getByTestId(`${prefix}-result`).innerText(), /退出码 0/);

    const truncatedCard = debugCard(dialog, machineId, executionIds.truncated);
    assert.match(
      await truncatedCard.getByTestId(`${prefix}-log-state-detail`).innerText(),
      /保留限制/,
    );

    return { dialog, longCard, truncatedCard };
  } catch (error) {
    await closeDebug(page, dialog);
    throw error;
  }
}

// 浅暗主题 × 五个宽度：900px / 1200px 边界两侧都要呈现。
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

        await assertDefaultLayer(page);
        await assertAttention(page);

        // 不提供隐式重跑：重试取消是重发取消，不是重跑原命令。
        assert.equal(
          await page.getByRole("button", { name: /重跑|再执行|重试原命令/ }).count(),
          0,
          "不得提供会隐式重跑原命令的操作",
        );

        await assertNoSecrets(page.getByTestId("executions-scene"), "执行场景");

        const dialog = await openDebug(page, machines.studio);
        const dialogOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        assert.ok(dialogOverflow <= 1, `调试详情横向溢出 ${dialogOverflow}px`);
        assert.match(await dialog.innerText(), /调试详情/);
        assert.match(await dialog.innerText(), /今天的执行卡片/);
        await assertNoSecrets(dialog, "执行卡片");
        await closeDebug(page, dialog);

        assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
        await shoot(page, `executions-${colorScheme}-${width}`);
      } finally {
        await context.close();
      }
    });
  }
}

// 调试详情：旧卡片事实（身份、状态、退出结果、日志正文与游标、保留限制、恢复原因）都还在。
await check("调试详情保留执行身份、状态、退出结果、保留限制与恢复原因", async () => {
  const { context, page } = await open({ width: 1200, height: 1000, colorScheme: "light" });
  try {
    await gotoExecutions(page);
    const opened = await assertDebugFacts(page, machines.studio);
    const { dialog, longCard, truncatedCard } = opened;

    // 日志正文与游标：点开后再读一页，正文与三个位点同时出现。
    const log = longCard.getByTestId(`executions-demo-debug-${machines.studio}-item-log`);
    await log.getByTestId(`executions-demo-debug-${machines.studio}-item-log-load`).click();
    await log.getByTestId(`executions-demo-debug-${machines.studio}-item-log-rows`).waitFor();
    assert.ok(
      (await log.getByTestId(`executions-demo-debug-${machines.studio}-item-log-frame`).count()) >=
        6,
    );
    const cursors = await log
      .getByTestId(`executions-demo-debug-${machines.studio}-item-log-cursors`)
      .innerText();
    assert.match(cursors, /已产出到 #24/);
    assert.match(cursors, /Worker 已确认到 #18/);
    assert.match(cursors, /可读起点 #1/);
    await shootAt(page, dialog, "debug-details-studio");

    // 裁剪态的保留限制已在 assertDebugFacts 断言，这里再确认可读起点。
    assert.match(
      await truncatedCard
        .getByTestId(`executions-demo-debug-${machines.studio}-item-log-cursors`)
        .innerText(),
      /可读起点 #31/,
    );
    await closeDebug(page, dialog);

    // 恢复原因与未知结果的原因分开显示，都不写成成功。
    const wakeDialog = await openDebug(page, machines.wake);
    try {
      const gapPrefix = `executions-demo-debug-${machines.wake}-item`;
      const gapCard = debugCard(wakeDialog, machines.wake, executionIds.gap);
      assert.match(
        await gapCard.getByTestId(`${gapPrefix}-recovery-reason`).innerText(),
        /子进程已退出，但没有留下结果文件/,
      );
      assert.match(await gapCard.getByTestId(`${gapPrefix}-state`).innerText(), /结果未知/);
      await shootAt(page, wakeDialog, "debug-details-wake");
    } finally {
      await closeDebug(page, wakeDialog);
    }
  } finally {
    await context.close();
  }
});

// 日志不完整态：`partial` 与三个位点必须同时可见，且不写成「没有输出」。
await check("日志不完整态显示为不完整，并给三个位点", async () => {
  const { context, page } = await open({ width: 1200, height: 1000, colorScheme: "light" });
  try {
    await gotoExecutions(page);
    const dialog = await openDebug(page, machines.studio);
    try {
      const long = debugCard(dialog, machines.studio, executionIds.long);
      const prefix = `executions-demo-debug-${machines.studio}-item-log`;
      const log = long.getByTestId(prefix);
      assert.match(await log.getByTestId(`${prefix}-state`).innerText(), /日志不完整/);
      assert.match(await log.getByTestId(`${prefix}-incomplete`).innerText(), /不完整/);
      const cursors = await log.getByTestId(`${prefix}-cursors`).innerText();
      assert.match(cursors, /已产出到 #24/);
      assert.match(cursors, /Worker 已确认到 #18/);
      assert.match(cursors, /可读起点 #1/);

      await log.getByTestId(`${prefix}-load`).click();
      await log.getByTestId(`${prefix}-rows`).waitFor();
      assert.ok((await log.getByTestId(`${prefix}-frame`).count()) >= 6);
      // 一页有正文时也不能把「已确认到 #18」显示成读完了。
      assert.match(await log.getByTestId(`${prefix}-state`).innerText(), /不完整/);
      await shootAt(page, dialog, "log-partial");

      // 续读到产出位点后明确说明没有更多区段。
      await log.getByTestId(`${prefix}-resume`).click();
      await page.waitForFunction((selector) => {
        const node = document.querySelector(selector);
        return node?.textContent?.includes("没有更多可读区段") === true;
      }, `[data-testid="${prefix}-next-cursor"]`);
      assert.match(await log.getByTestId(`${prefix}-next-cursor`).innerText(), /没有更多可读区段/);
      await shootAt(page, dialog, "log-resumed");
    } finally {
      await closeDebug(page, dialog);
    }
  } finally {
    await context.close();
  }
});

// 裁剪态与缺口态：两条路径都不能写成成功或空。
await check("裁剪与缺口各自有明确文案", async () => {
  const { context, page } = await open({ width: 1200, height: 1000, colorScheme: "dark" });
  try {
    await gotoExecutions(page);

    const studioDialog = await openDebug(page, machines.studio);
    try {
      const prefix = `executions-demo-debug-${machines.studio}-item-log`;
      const truncatedLog = debugCard(
        studioDialog,
        machines.studio,
        executionIds.truncated,
      ).getByTestId(prefix);
      assert.match(await truncatedLog.getByTestId(`${prefix}-state`).innerText(), /日志已裁剪/);
      await truncatedLog.getByTestId(`${prefix}-load`).click();
      await truncatedLog.getByTestId(`${prefix}-rows`).waitFor();
      assert.match(await truncatedLog.getByTestId(`${prefix}-cursors`).innerText(), /可读起点 #31/);
      await shootAt(page, studioDialog, "log-truncated");
    } finally {
      await closeDebug(page, studioDialog);
    }

    const wakeDialog = await openDebug(page, machines.wake);
    try {
      const prefix = `executions-demo-debug-${machines.wake}-item-log`;
      const gapLog = debugCard(wakeDialog, machines.wake, executionIds.gap).getByTestId(prefix);
      assert.match(await gapLog.getByTestId(`${prefix}-state`).innerText(), /日志存在缺口/);
      await gapLog.getByTestId(`${prefix}-load`).click();
      const gapRow = gapLog.getByTestId(`${prefix}-gap`);
      await gapRow.waitFor();
      assert.match(await gapRow.innerText(), /行缺失，内容未知/);
      // 缺口行不是空输出：它点名缺了哪些序号。
      assert.match(await gapRow.getAttribute("data-gap-from"), /52/);
      await shootAt(page, wakeDialog, "log-gap");

      // 缺口日志拒绝：游标早于可读起点时明确要求从新起点重读。
      await page.getByTestId("executions-demo-log-failure").selectOption("gap");
      await gapLog.getByTestId(`${prefix}-load`).click();
      const error = gapLog.getByTestId(`${prefix}-error`);
      await error.waitFor();
      assert.match(await error.innerText(), /新的可读起点/);
      await shootAt(page, wakeDialog, "log-cursor-rejected");
    } finally {
      await closeDebug(page, wakeDialog);
    }
  } finally {
    await context.close();
  }
});

// 取消：送达不等于已停止；六态都有对应展示。
await check("取消六态都有展示，delivered 不写成已停止", async () => {
  const { context, page } = await open({ width: 1200, height: 1000, colorScheme: "light" });
  try {
    await gotoExecutions(page);
    const dialog = await openDebug(page, machines.studio);
    try {
      const long = debugCard(dialog, machines.studio, executionIds.long);
      const cancel = long.getByTestId(`executions-demo-debug-${machines.studio}-item-cancel`);
      // 已成功的执行也有取消事实：送达中，没有观察到退出。
      const delivered = cancel.getByTestId(
        `executions-demo-debug-${machines.studio}-item-cancel-state`,
      );
      await delivered.waitFor();
      assert.equal(await delivered.getAttribute("data-cancellation-state"), "delivered");
      assert.equal(await delivered.getAttribute("data-stopped"), "false");
      assert.match(
        await cancel
          .getByTestId(`executions-demo-debug-${machines.studio}-item-cancel-state-label`)
          .innerText(),
        /取消已送达/,
      );
      // 状态标签不能写成「已停止」；正文只允许用「送达不等于已停止」解释它。
      assert.notEqual(
        await cancel
          .getByTestId(`executions-demo-debug-${machines.studio}-item-cancel-state-label`)
          .innerText(),
        "已停止",
      );
      assert.match(await delivered.innerText(), /送达不等于已停止/);
      await shootAt(page, dialog, "cancel-delivered");

      for (const state of ["requested", "exited_observed", "already_exited", "failed", "unknown"]) {
        await page.getByTestId("executions-demo-cancel-state").selectOption(state);
        // 用仍在运行的执行发一次取消，避免终态执行禁用按钮。
        const target = debugCard(dialog, machines.studio, executionIds.truncated);
        const control = target.getByTestId(`executions-demo-debug-${machines.studio}-item-cancel`);
        await control
          .getByTestId(`executions-demo-debug-${machines.studio}-item-cancel-request`)
          .click();
        await page.waitForFunction(
          ({ selector, expected }) => {
            const node = document.querySelector(selector);
            return node?.getAttribute("data-cancellation-state") === expected;
          },
          {
            selector: `[data-testid="executions-demo-debug-${machines.studio}-item"][data-execution-id="${executionIds.truncated}"] [data-testid="executions-demo-debug-${machines.studio}-item-cancel-state"]`,
            expected: state,
          },
        );
        const shown = control.getByTestId(
          `executions-demo-debug-${machines.studio}-item-cancel-state`,
        );
        assert.equal(await shown.getAttribute("data-cancellation-state"), state);
        const stopped = await shown.getAttribute("data-stopped");
        assert.equal(
          stopped,
          state === "exited_observed" || state === "already_exited" ? "true" : "false",
          `${state} 的停止语义`,
        );
        if (state !== "exited_observed" && state !== "already_exited") {
          const label = await control
            .getByTestId(`executions-demo-debug-${machines.studio}-item-cancel-state-label`)
            .innerText();
          assert.notEqual(label, "已停止", `${state} 不能显示为已停止`);
        }
        if (state === "failed") assert.match(await shown.innerText(), /取消失败/);
        await shootAt(page, dialog, `cancel-${state}`);
      }
    } finally {
      await closeDebug(page, dialog);
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
    const dialog = await openDebug(page, machines.studio);
    try {
      const prefix = `executions-demo-debug-${machines.studio}-item`;
      const unknown = debugCard(dialog, machines.studio, executionIds.unknown);
      assert.match(await unknown.getByTestId(`${prefix}-state`).innerText(), /结果未知/);
      const uncertain = await unknown.getByTestId(`${prefix}-uncertain`).innerText();
      assert.match(uncertain, /结果未知/);
      assert.match(uncertain, /不会在这里重发原命令/);
      assert.doesNotMatch(uncertain, /成功/);
      assert.match(await unknown.getByTestId(`${prefix}-no-rerun`).innerText(), /不提供重跑/);
      await shootAt(page, dialog, "result-unknown");

      // 超时同样只说超时，并点名来源。
      const timedOut = debugCard(dialog, machines.studio, executionIds.timedOut);
      assert.match(await timedOut.getByTestId(`${prefix}-state`).innerText(), /超时/);
      assert.doesNotMatch(await timedOut.getByTestId(`${prefix}-state`).innerText(), /成功/);
      await shootAt(page, dialog, "result-timed-out");
    } finally {
      await closeDebug(page, dialog);
    }
  } finally {
    await context.close();
  }
});

// 断线与重连：断线时说明信息完整性，重连后仍是同一条执行。
await check("断线说明信息完整性，重连后继续查看同一执行", async () => {
  const { context, page } = await open({ width: 1200, height: 1000, colorScheme: "light" });
  try {
    await gotoExecutions(page);
    const dialog = await openDebug(page, machines.wake);
    try {
      const prefix = `executions-demo-debug-${machines.wake}-item-log`;
      const gap = debugCard(dialog, machines.wake, executionIds.gap);
      const gapLog = gap.getByTestId(prefix);
      await gapLog.getByTestId(`${prefix}-load`).click();
      await gapLog.getByTestId(`${prefix}-rows`).waitFor();
      const before = await gapLog.getByTestId(`${prefix}-cursors`).innerText();

      // 抽屉是模态的，演示控件走同一套 React 点击处理器，不绕过状态。
      await page.getByTestId("executions-demo-go-offline").evaluate((node) => node.click());
      const offline = page.getByTestId("executions-demo-offline");
      await offline.waitFor();
      assert.match(await page.getByTestId("executions-demo-connection").innerText(), /断线/);
      const offlineText = await offline.innerText();
      assert.match(offlineText, /连接已断开/);
      assert.match(offlineText, /不能当作当前状态/);
      // 断线不清空已读到的日志：位点与行都还在。
      assert.equal(await gapLog.getByTestId(`${prefix}-cursors`).innerText(), before);
      assert.ok((await gapLog.getByTestId(`${prefix}-frame`).count()) >= 2);
      assert.match(await gapLog.getByTestId(`${prefix}-offline`).innerText(), /连接已断开/);
      await shootAt(page, dialog, "connection-offline");
      await shootAt(page, dialog, "log-offline");

      await page.getByTestId("executions-demo-go-online").evaluate((node) => node.click());
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="executions-demo-connection"]')
            ?.textContent?.includes("在线") === true,
      );
      // 重连后仍是同一条执行，位点还是同一个已知值。
      assert.equal(
        await gap
          .getByTestId(`executions-demo-debug-${machines.wake}-item-execution`)
          .getAttribute("title"),
        executionIds.gap,
      );
      assert.equal(await gapLog.getByTestId(`${prefix}-cursors`).innerText(), before);
      await shootAt(page, dialog, "connection-reconnected");
    } finally {
      await closeDebug(page, dialog);
    }
  } finally {
    await context.close();
  }
});

// 900px / 1200px 边界：调试详情里的日志在边界两侧都完整可读，不横向溢出。
await check("900px 与 1200px 边界两侧不横向溢出且日志可读", async () => {
  for (const width of [900, 901, 1199, 1200]) {
    const { context, page } = await open({ width, height: 1000, colorScheme: "dark" });
    try {
      await gotoExecutions(page);
      const dialog = await openDebug(page, machines.wake);
      try {
        const prefix = `executions-demo-debug-${machines.wake}-item-log`;
        const gapLog = debugCard(dialog, machines.wake, executionIds.gap).getByTestId(prefix);
        await gapLog.getByTestId(`${prefix}-load`).click();
        await gapLog.getByTestId(`${prefix}-rows`).waitFor();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        assert.ok(overflow <= 1, `${width}px 横向溢出 ${overflow}px`);
        await shootAt(page, dialog, `boundary-${width}`);
      } finally {
        await closeDebug(page, dialog);
      }
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
