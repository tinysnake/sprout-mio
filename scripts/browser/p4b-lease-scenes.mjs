import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

// 演示场景的浏览器核对：只连本机 dev server，不连业务服务，不产生远端执行。
const base = process.env.SPROUT_LEASE_SCENES_URL ?? "http://127.0.0.1:3088/__dev/ui/";
const evidence = resolve(process.env.SPROUT_LEASE_SCENES_EVIDENCE ?? ".verify/p4b-ui/evidence");
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

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 演示 fixture 里的 shell 命令正文与文件路径：这些内容一律不得出现在界面上。 */
const demoCommands = [
  "pnpm test tests/lease.test.ts",
  "/Users/linche/workspace/prj-demo/package.json",
];

async function gotoLeases(page) {
  await page.getByTestId("machine-leases-link").click();
  await page.getByTestId("lease-scene").waitFor();
}

async function bodyBackground(page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return style.backgroundColor;
  });
}

// 浅暗主题 × 五个宽度：租约、多机持有与远端操作都在同一处可见。
for (const colorScheme of ["light", "dark"]) {
  for (const width of [390, 901, 1199, 1200, 1440]) {
    await check(`租约场景 ${colorScheme} ${width}px 呈现`, async () => {
      const { context, page, errors } = await open({
        width,
        height: 900,
        colorScheme,
        scene: "machines",
      });
      try {
        await gotoLeases(page);
        // 主体不与视口横向溢出。
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
        const background = await bodyBackground(page);
        assert.ok(background && background !== "rgba(0, 0, 0, 0)", "background token applied");
        // 冗余的「分身与它持有的 Machine」聚合框已删除，改为 holder 行上的台数标记。
        assert.equal(await page.getByTestId("lease-scene-overview-holders").count(), 0);
        assert.equal(
          await page.getByText("分身与它持有的 Machine").count(),
          0,
          "聚合框文案不得再出现",
        );
        const counts = await page.getByTestId("lease-holder-count").allTextContents();
        assert.ok(
          counts.some((text) => text.includes("持有 2 台")),
          `台数标记: ${counts.join(" | ")}`,
        );
        // 状态、holder、Machine 名称齐全。
        assert.ok((await page.getByTestId("lease-state").count()) >= 3);
        assert.ok((await page.getByTestId("lease-holder-instance").count()) >= 2);
        // 远端操作目标明确写出远端 Worker，且结果状态覆盖成功/失败/超时/未知。
        assert.ok(
          (await page
            .locator('[data-testid="remote-executions"] [data-testid$="-target"]')
            .count()) >= 4,
        );
        const states = await page
          .locator('[data-testid="remote-executions-item"]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-execution-state")));
        for (const state of ["succeeded", "failed", "timed_out", "unknown"])
          assert.ok(states.includes(state), `missing state ${state}`);
        // 命令正文不进界面：shell 命令与目标路径（含绝对路径）都不得出现在远端操作卡片里。
        const cards = page.locator('[data-testid="remote-executions-item"]');
        const cardsText = await cards.allInnerTexts();
        for (const demo of demoCommands) {
          for (const text of cardsText) {
            assert.doesNotMatch(text, new RegExp(escapeRegExp(demo)), `卡片回显了命令正文 ${demo}`);
          }
        }
        for (const text of cardsText) {
          assert.doesNotMatch(text, /\/Users\/linche\/workspace/, "卡片回显了绝对路径");
          assert.doesNotMatch(text, /holder ins_|run run_/, "卡片回了裸 id 标签");
        }
        // 人类可决策的事实仍在，且 holder 显示分身名称而不是 instance id。
        const firstAuthorization = await cards
          .first()
          .getByTestId("remote-executions-item-authorization")
          .innerText();
        assert.match(firstAuthorization, /授权代次 4/);
        assert.match(firstAuthorization, /持有者 重构搭档/);
        assert.doesNotMatch(firstAuthorization, /ins_aaaaaaaa/);
        assert.match(firstAuthorization, /由该分身的一次运行发起/);
        assert.match(firstAuthorization, /run_12345678/);
        assert.equal(
          await cards.first().getByTestId("remote-executions-item-run").getAttribute("title"),
          "run_12345678-1234-4234-8234-1234567890ab",
        );
        assert.equal(
          await cards.first().getByTestId("remote-executions-item-operation").count(),
          0,
          "不再渲染操作正文段落",
        );
        assert.ok(
          (await cards.first().getByTestId("remote-executions-item-result").innerText()).length > 0,
        );
        assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
        await shoot(page, `leases-${colorScheme}-${width}`);
        const fencing = page.locator('[data-lease-state="fencing"]');
        assert.equal(await fencing.count(), 1);
        // 卡片正文只留一句可决策的简介。
        const summary = await fencing.getByTestId("lease-fencing-summary").innerText();
        assert.match(summary, /等待 Worker 确认旧授权已关闸/);
        assert.match(summary, /期间不接受新的远端操作/);
        assert.doesNotMatch(summary, /无法保证|副作用|已等待|最多 100 条/);
        // 完整事实只在问号按钮的 Dialog 里；正文不得平铺长说明。
        const collapsed = await fencing.innerText();
        assert.doesNotMatch(collapsed, /重连本身不代表已确认/);
        assert.doesNotMatch(collapsed, /已启动的进程仍可能继续产生副作用/);
        assert.doesNotMatch(collapsed, /最多 100 条/);
        assert.doesNotMatch(collapsed, /永远无法结束|没有强制推进入口|不提供强制推进/);
        const help = fencing.getByTestId("lease-fencing-details-trigger");
        assert.equal(await help.getAttribute("aria-label"), "回收中状态的完整事实");
        await help.click();
        const details = page.getByTestId("lease-fencing-details");
        await details.waitFor();
        const text = await details.innerText();
        assert.match(text, /无法保证等待会结束/);
        assert.match(text, /已启动的进程仍可能继续产生副作用/);
        assert.match(text, /重连本身不代表已确认/);
        assert.match(text, /需要 Human\s*介入才能继续/);
        assert.match(text, /自 .* 起/);
        assert.match(text, /已等待|无法计算等待时长/);
        assert.match(text, /动作与收据代次尚未读取确认/);
        assert.match(text, /当前租约代次 7/);
        assert.match(text, /结果未知或因 Worker 失联 \/ 截止时间结束的记录：0 条/);
        assert.match(text, /现有执行记录未提供 Worker/);
        assert.match(text, /最多 100 条/);
        // 不伪造成功态：只是否定式的「不构成…断言」，没有任何一次完成声明。
        assert.doesNotMatch(text, /已全部排空。|收回已完成|释放已确认|执行成功。/);
        assert.equal(await fencing.getAttribute("data-lease-state"), "fencing");
        await shoot(page, `fencing-details-${colorScheme}-${width}`);
        await page.keyboard.press("Escape");
        await details.waitFor({ state: "detached" });
        assert.equal(
          await fencing.getAttribute("data-holder-instance"),
          "ins_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        );
        const state = await fencing.getByTestId("lease-state").innerText();
        assert.doesNotMatch(state, /空闲|已释放|已收回|成功/);
        assert.equal(
          await fencing.getByTestId("lease-fencing-reclaim").count(),
          1,
          "只保留普通收回请求，不提供别的推进按钮",
        );
        assert.doesNotMatch(await fencing.innerText(), /永远无法结束|没有强制推进入口/);
        const reclaim = fencing.getByTestId("lease-fencing-reclaim");
        assert.equal(await reclaim.isDisabled(), true);
        await fencing.getByTestId("lease-fencing-reclaim-confirm").check();
        await reclaim.click();
        const error = fencing.getByTestId("lease-fencing-reclaim-error");
        await error.waitFor();
        assert.match(await error.innerText(), /lease_fencing/);
        assert.match(await error.innerText(), /等待 Worker 确认后才能完成收回/);
        assert.equal(await fencing.getAttribute("data-lease-state"), "fencing");
        assert.equal(await fencing.getByTestId("lease-fencing-reclaim-receipt").count(), 0);
        await shootAt(page, "lease-fencing-facts", `fencing-${colorScheme}-${width}`);
        await fencing.screenshot({
          path: join(evidence, `fencing-row-${colorScheme}-${width}.png`),
          animations: "disabled",
        });
        assert.ok(
          await fencing.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
          "fencing 文本不横向溢出",
        );
      } finally {
        await context.close();
      }
    });
  }
}

// 不同 Project 的租约互不可见：本 Project 视图不出现其他 Project 的持有者。
await check("Project 隔离：当前 Project 看不到另一个 Project 的租约", async () => {
  const { context, page } = await open({
    width: 1200,
    height: 900,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await gotoLeases(page);
    const current = page.getByTestId("lease-scene-overview");
    assert.equal(
      await current
        .locator('[data-holder-instance="ins_cccccccc-cccc-4ccc-8ccc-cccccccccccc"]')
        .count(),
      0,
    );
    // 另一个 Project 的面板里能看到它自己的租约，说明在同一台物理 Machine 上独立成立。
    const other = page.getByTestId("lease-scene-other-project");
    assert.equal(
      await other
        .locator('[data-holder-instance="ins_cccccccc-cccc-4ccc-8ccc-cccccccccccc"]')
        .count(),
      1,
    );
    assert.match(await other.innerText(), /其他 Project 的分身/);
    record("同一台物理 Machine 上两个 Project 的租约独立成立", true);
    await shoot(page, "project-isolation-dark-free");
  } finally {
    await context.close();
  }
});

// 申请成功：pending 在等待期间可见，写回后状态变为持有中，并带上新的代次。
await check("申请租约：pending 与成功反馈", async () => {
  const { context, page } = await open({
    width: 1200,
    height: 1000,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await gotoLeases(page);
    await page.getByTestId("lease-demo-outcome").selectOption("hold");
    const form = page.getByTestId("lease-scene-overview-mutation");
    await form.getByTestId("lease-scene-overview-mutation-machine").selectOption({ index: 1 });
    await form.getByTestId("lease-scene-overview-mutation-submit").click();
    await form.getByTestId("lease-scene-overview-mutation-pending").waitFor();
    // 未结算前不出现成功收据。
    assert.equal(await form.getByTestId("lease-scene-overview-mutation-receipt").count(), 0);
    await shootAt(page, "lease-scene-overview-mutation", "mutation-pending");
    await page.getByTestId("lease-demo-settle-success-0").click();
    await form.getByTestId("lease-scene-overview-mutation-success").waitFor();
    await form.getByTestId("lease-scene-overview-mutation-receipt").waitFor();
    // 写回后该 Machine 变为持有中。
    const row = page.locator('[data-testid^="lease-row-"]').filter({ hasText: "待配对的 MacBook" });
    assert.equal(await row.getAttribute("data-lease-state"), "held");
    await shootAt(page, "lease-scene-overview-mutation", "mutation-success");
  } finally {
    await context.close();
  }
});

// 失败：保留目标选择与动作，显示错误码与 requestId，不写回租约。
await check("申请失败：保留目标并显示原因（旧授权代次）", async () => {
  const { context, page } = await open({
    width: 1200,
    height: 1000,
    colorScheme: "dark",
    scene: "machines",
  });
  try {
    await gotoLeases(page);
    await page.getByTestId("lease-demo-outcome").selectOption("stale");
    const form = page.getByTestId("lease-scene-overview-mutation");
    await form.getByTestId("lease-scene-overview-mutation-machine").selectOption({ index: 1 });
    await form.getByTestId("lease-scene-overview-mutation-submit").click();
    const error = form.getByTestId("lease-scene-overview-mutation-error");
    await error.waitFor();
    assert.match((await error.textContent()) ?? "", /lease_stale_generation/);
    assert.equal(
      await form.getByTestId("lease-scene-overview-mutation-receipt").count(),
      0,
      "失败不得显示成功收据",
    );
    const row = page.locator('[data-testid^="lease-row-"]').filter({ hasText: "待配对的 MacBook" });
    assert.notEqual(await row.getAttribute("data-lease-state"), "held");
    await shootAt(page, "lease-scene-overview-mutation", "mutation-failure-stale-generation");
  } finally {
    await context.close();
  }
});

// 跨 run 持有：run 已结束，租约仍显示持有。
await check("run 结束后租约仍显示持有", async () => {
  const { context, page } = await open({
    width: 1200,
    height: 1000,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await gotoLeases(page);
    const relation = page.getByTestId("lease-scene-run-relation");
    const held = await relation
      .locator('[data-held="true"]')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent));
    assert.ok(held.length >= 2, `expected held leases, got ${held.length}`);
    for (const note of held) assert.match(note ?? "", /仍由该分身持有|与所在 run 并行存在/);
    const free = await relation.locator('[data-held="false"]').count();
    assert.equal(free, 1, "只有 free 的租约不算持有");
    // 页面上没有把 run 结束写成已释放。
    const text = await page.getByTestId("lease-scene").innerText();
    assert.doesNotMatch(text, /run 结束.*已释放/);
    await shootAt(page, "lease-scene-run-relation", "run-ended-still-held");
  } finally {
    await context.close();
  }
});

// Chat inspector 与 Project settings 使用同一套租约与操作呈现组件。
await check("Chat inspector 与 Project settings 呈现同一租约事实", async () => {
  const { context, page } = await open({
    width: 1440,
    height: 1000,
    colorScheme: "light",
    scene: "chat-inspector",
  });
  try {
    await page.getByTestId("chat-leases").waitFor();
    const chatLeaseStates = await page
      .locator('[data-testid="chat-leases"] [data-testid="lease-row-" ]')
      .count();
    assert.ok(chatLeaseStates >= 0);
    const chatHeld = await page
      .locator('[data-testid="chat-leases"] [data-lease-state="held"]')
      .count();
    assert.ok(chatHeld >= 2, `chat inspector held leases ${chatHeld}`);
    assert.ok((await page.getByTestId("chat-executions").count()) === 1);
    assert.ok((await page.getByTestId("chat-execution-targets").count()) === 1);
    await shootAt(page, "chat-leases", "chat-inspector-leases");
    await shootAt(page, "chat-executions", "chat-inspector-executions");
  } finally {
    await context.close();
  }

  const settings = await open({
    width: 1440,
    height: 1200,
    colorScheme: "dark",
    scene: "settings",
  });
  try {
    const page = settings.page;
    if (await page.getByTestId("settings-info-hub").isVisible()) {
      const open = await page.getByTestId("settings-info-hub").evaluate((node) => node.open);
      if (!open) await page.getByTestId("project-info-hub-toggle").click();
    }
    await page.getByTestId("info-hub-leases").waitFor();
    const held = await page
      .locator('[data-testid="info-hub-leases"] [data-lease-state="held"]')
      .count();
    assert.ok(held >= 2, `settings held leases ${held}`);
    assert.equal(await page.getByTestId("info-hub-leases-notice").count(), 0);
    await shootAt(page, "info-hub-leases", "settings-info-hub-leases");
  } finally {
    await settings.context.close();
  }
});

// Machine 详情：租约、holder、远端操作目标在同一台 Machine 上对齐。
await check("Machine 详情显示租约与远端操作目标", async () => {
  const { context, page } = await open({
    width: 1200,
    height: 1000,
    colorScheme: "light",
    scene: "machines",
  });
  try {
    await page.getByTestId("machines-page").waitFor();
    await page
      .locator('[data-machine-id="mch_11111111-1111-4111-8111-111111111111"]')
      .first()
      .click();
    await page.getByTestId("machine-lease-detail").waitFor();
    const section = page.getByTestId("machine-lease-detail");
    assert.ok((await section.getByTestId("lease-state").count()) === 1);
    assert.match(
      (await section.getByTestId("lease-holder-instance").textContent()) ?? "",
      /ins_aaaaaaaa/,
    );
    const executions = page.getByTestId("machine-executions");
    assert.ok((await executions.locator('[data-testid$="-item"]').count()) >= 2);
    const targets = await executions
      .locator('[data-testid$="-target"]')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent));
    for (const target of targets) assert.match(target ?? "", /远端 Worker/);
    assert.ok(
      (await page.getByTestId("machine-detail-remote-operations").textContent()) !== "未实现，P4b",
    );
    // 第 6 条：Machine 详情页不再要求重选目标，目标就是当前这台；表单仍要求代次匹配。
    const form = page.getByTestId("machine-lease-section-overview-mutation");
    await form.waitFor();
    assert.equal(
      await form.getByTestId("machine-lease-section-overview-mutation-machine").count(),
      0,
      "no target picker when the page is already a single Machine",
    );
    assert.match(
      await form.getByTestId("machine-lease-section-overview-mutation-target").innerText(),
      /工作室 Mac mini/,
    );
    assert.doesNotMatch(await form.innerText(), /必须显式选择；没有默认目标/);
    assert.match(
      await form.getByTestId("machine-lease-section-overview-mutation-target-hint").innerText(),
      /目标就是你当前所在的这台 Machine/,
    );
    // 下拉框与按钮同一行基线；窄屏换行但不塌。
    const aligned = await form.evaluate((node) => {
      const target = node.querySelector(
        '[data-testid="machine-lease-section-overview-mutation-target"]',
      );
      const submit = node.querySelector(
        '[data-testid="machine-lease-section-overview-mutation-submit"]',
      );
      const a = target.getBoundingClientRect();
      const b = submit.getBoundingClientRect();
      return {
        sameRow: Math.abs(a.bottom - b.bottom) <= 8,
        targetRight: a.right,
        submitLeft: b.left,
      };
    });
    assert.ok(aligned.sameRow, `表单控件与按钮同一基线: ${JSON.stringify(aligned)}`);
    assert.ok(aligned.submitLeft >= aligned.targetRight - 1, "按钮在目标之后，不重叠");
    assert.match(
      await page.getByTestId("machine-lease-detail").innerText(),
      /租约单位是 Project × Machine/,
    );
    // 第 5 条：配置类区块仍在同一页，只是排在租约与远端操作之后。
    const order = await page.evaluate(() => {
      const order = [
        "machine-lease-detail",
        "machine-remote-executions",
        "machine-connection-section",
        "machine-shells",
        "machine-root-section",
        "machine-bindings",
        "machine-restart-section",
      ];
      return order.map((id) => {
        const node = document.querySelector(`[data-testid="${id}"]`);
        return {
          id,
          present: Boolean(node),
          y: node ? node.getBoundingClientRect().top + window.scrollY : -1,
        };
      });
    });
    for (const entry of order) assert.ok(entry.present, `缺少区块 ${entry.id}`);
    for (let index = 1; index < order.length; index += 1)
      assert.ok(
        order[index].y > order[index - 1].y,
        `${order[index].id} 应排在 ${order[index - 1].id} 之后`,
      );
    assert.equal(
      await page.getByTestId("machine-settings-group").count(),
      1,
      "配置区块归入设置分组",
    );
    // 第 4 条：页头的租约入口是按钮而不是文字链接，点击后落到本页租约区块并给出可见焦点。
    const jump = page.getByTestId("machine-lease-jump");
    await jump.waitFor();
    assert.equal(await jump.getAttribute("role"), null);
    const jumpStyle = await jump.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        border: parseFloat(style.borderTopWidth),
        underline: style.textDecorationLine,
        height: node.getBoundingClientRect().height,
      };
    });
    assert.ok(
      jumpStyle.border >= 1 && jumpStyle.height >= 28,
      `按钮形态: ${JSON.stringify(jumpStyle)}`,
    );
    assert.notEqual(jumpStyle.underline, "underline", "不再是下划线文字链");
    await jump.click();
    await page.waitForFunction(
      () => document.activeElement?.closest('[data-testid="machine-lease-detail"]') !== null,
    );
    await shootAt(page, "machine-lease-detail", "machine-detail-lease");
    await shootAt(page, "machine-executions", "machine-detail-executions");
    for (const colorScheme of ["light", "dark"]) {
      for (const width of [390, 901, 1199, 1200, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme });
        await page.evaluate((theme) => localStorage.setItem("sprout:theme", theme), colorScheme);
        await page.getByTestId("machine-detail-page").waitFor();
        await page.getByTestId("machine-lease-detail").waitFor();
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          `${colorScheme} ${width}px 无横向溢出`,
        );
        await shootAt(page, "machine-lease-detail", `machine-lease-${colorScheme}-${width}`);
        await shootAt(
          page,
          "machine-remote-executions",
          `machine-executions-${colorScheme}-${width}`,
        );
      }
    }
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
