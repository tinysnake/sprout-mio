import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const base = process.env.SPROUT_MACHINE_SCENES_URL ?? "http://127.0.0.1:3077/__dev/ui/";
const evidence = resolve(
  process.env.SPROUT_MACHINE_SCENES_EVIDENCE ?? ".verify/p4a-machine-scenes",
);
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

async function openControls(page) {
  const summary = page.getByTestId("machine-scene-controls").locator("summary");
  if (!(await page.getByTestId("machine-fail-create").isVisible())) await summary.click();
}

async function closeControls(page) {
  const summary = page.getByTestId("machine-scene-controls").locator("summary");
  if (await page.getByTestId("machine-fail-create").isVisible()) await summary.click();
}

async function open({ width, height, colorScheme, scene = "machines", hasTouch = false }) {
  const context = await browser.newContext({
    hasTouch,
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

const shoots = (page, name) =>
  page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true, animations: "disabled" });

const presentationEvidence = [];
async function scrollDetailToTop(page) {
  await page.getByTestId("machine-detail-page").evaluate((element) => {
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      ancestor.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  });
}
async function assertPresentation(page, status) {
  await scrollDetailToTop(page);
  const facts = await page.evaluate(() => {
    const section = document.querySelector('[data-testid="machine-enrollment-section"]');
    const connection = document.querySelector('[data-testid="machine-connection-section"]');
    const pairing = document.querySelector('[data-testid="machine-pairing"]');
    const install = document.querySelector('[data-testid="machine-install"]');
    const box = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      section: box(section),
      connection: box(connection),
      pairing: box(pairing),
      install: box(install),
      enrollmentFirst: Boolean(
        section.compareDocumentPosition(connection) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      pairingBeforeInstall: Boolean(
        pairing.compareDocumentPosition(install) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.equal(facts.enrollmentFirst, status === "pending", `${status}: 配对区的 DOM 优先级`);
  assert.equal(facts.pairingBeforeInstall, true, "配对区应在安装区之前");
  assert.ok(facts.overflow <= 1, `横向溢出 ${facts.overflow}px`);
  if (status === "pending") {
    assert.ok(
      facts.section.y + facts.section.height <= facts.connection.y + 1,
      "待配对区整体位于详情事实之前",
    );
    assert.ok(facts.pairing.y <= facts.install.y, "配对操作不晚于安装说明");
  }
  const init = page.getByTestId("machine-command-init");
  const run = await page.getByTestId("machine-command-run").innerText();
  assert.doesNotMatch(run, /--allow-http|--ticket/);
  assert.match(run, /run --state-dir/);
  if (status === "pending") {
    const command = await init.innerText();
    assert.ok(
      command.includes("--server http://192.168.1.10:3210 --allow-http http://192.168.1.10:3210"),
    );
    assert.match(command, /--machine mch_/);
    assert.match(command, /--state-dir/);
    assert.doesNotMatch(command, /--ticket/);
    if (page.viewportSize().width === 390) {
      const scrollable = await init.evaluate((element) => {
        const overflows = element.scrollWidth > element.clientWidth;
        element.scrollLeft = element.scrollWidth;
        const reachedEnd = element.scrollLeft + element.clientWidth >= element.scrollWidth - 1;
        element.scrollLeft = 0;
        return overflows && reachedEnd;
      });
      assert.equal(scrollable, true, "带授权的长 init 命令可滚动至末尾");
    }
  } else assert.equal(await init.count(), 0, "已配对仅显示 run，不再显示 init 授权示例");
  const note = page.getByTestId("machine-http-note");
  assert.equal(await note.isVisible(), false, "协议尾注默认收起");
  await page.getByTestId("machine-http-help").click();
  await note.waitFor({ state: "visible" });
  const text = await note.innerText();
  assert.match(text, /默认只接受 loopback HTTP/);
  assert.match(text, /HTTPS 无需开关/);
  assert.match(text, /--server.*http:\/\/127\.0\.0\.1:3330/);
  assert.match(text, /init 时显式添加 --allow-http <完整 origin>/);
  assert.match(text, /只对该完整 origin（含端口）生效/);
  assert.match(text, /不放开同网段其他地址/);
  assert.match(text, /身份文件/);
  assert.doesNotMatch(text, /HTTP\s*开箱可用|http\s*开箱可用|没有 --allow-http|不支持通过配置放开/);
  if (status === "pending" && [1440, 390].includes(page.viewportSize().width)) {
    const theme = await page.evaluate(() => localStorage.getItem("sprout:theme"));
    await shoots(page, `http-help-${page.viewportSize().width}-${theme}`);
  }
  await page.getByRole("button", { name: "关闭对话框" }).click();
  await note.waitFor({ state: "hidden" });
  await scrollDetailToTop(page);
  return facts;
}

async function assertPresentationMatrix() {
  for (const colorScheme of ["light", "dark"]) {
    const matrix = await open({ width: 1440, height: 900, colorScheme });
    for (const width of [1440, 1200, 1199, 900, 899, 390]) {
      await matrix.page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const status of ["pending", "active"]) {
        await matrix.page.getByTestId("machine-list").waitFor();
        const id =
          status === "pending"
            ? "mch_22222222-2222-4222-8222-222222222222"
            : "mch_11111111-1111-4111-8111-111111111111";
        await matrix.page.locator(`[data-machine-id="${id}"]`).click();
        await matrix.page.getByTestId("machine-detail-page").waitFor();
        const facts = await assertPresentation(matrix.page, status);
        presentationEvidence.push({ width, colorScheme, status, ...facts });
        if (width === 1440 || width === 390) {
          await shoots(matrix.page, `priority-${status}-${width}-${colorScheme}`);
        }
        await matrix.page.getByTestId("machine-detail-back").click();
      }
    }
    assert.deepEqual(matrix.errors, []);
    await matrix.context.close();
  }
  writeFileSync(
    join(evidence, "priority-positions.json"),
    JSON.stringify(presentationEvidence, null, 2),
  );
}

try {
  const shellEvidence = [];
  for (const width of [1440, 390]) {
    for (const colorScheme of ["light", "dark"]) {
      const sample = await open({ width, height: 900, colorScheme });
      const p = sample.page;
      const test = (id) => p.getByTestId(id);
      await check(`shell_summary_${width}_${colorScheme}_interaction_and_layout`, async () => {
        await test("machine-item").first().click();
        const summary = test("machine-shell-summary");
        const details = test("machine-shell-details");
        assert.equal(await summary.getAttribute("aria-expanded"), "false");
        assert.equal(await details.isVisible(), false);
        assert.match(await summary.innerText(), /✓ zsh.*·.*✓ bash.*·.*✓ sh/s);
        assert.ok(!(await summary.innerText()).includes("/bin/"));
        await summary.scrollIntoViewIfNeeded();
        const lines = await summary.evaluate((element) => {
          const items = [...element.querySelectorAll('[data-testid="machine-shell-summary-item"]')];
          return items.map((item) => item.getBoundingClientRect().top);
        });
        assert.equal(new Set(lines).size, 1, "三个 shell 在一行");
        await p.screenshot({ path: join(evidence, `shell-summary-${width}-${colorScheme}.png`) });
        await summary.hover();
        await details.waitFor({ state: "visible" });
        assert.equal(await summary.getAttribute("aria-expanded"), "true");
        assert.match(await details.innerText(), /\/bin\/zsh/);
        assert.match(await details.innerText(), /zsh 5\.9/);
        assert.match(await details.innerText(), /检查时间/);
        const bounds = await details.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 901);
        await p.screenshot({ path: join(evidence, `shell-details-${width}-${colorScheme}.png`) });
        await summary.click();
        await details.waitFor({ state: "hidden" });
        assert.equal(await summary.getAttribute("aria-expanded"), "false");
        await summary.click();
        await details.waitFor({ state: "visible" });
        assert.equal(await summary.getAttribute("aria-expanded"), "true");
        await p.keyboard.press("Escape");
        await details.waitFor({ state: "hidden" });
        await p.mouse.move(0, 0);
        await summary.blur();
        await p.keyboard.press("Tab");
        await summary.focus();
        await details.waitFor({ state: "visible" });
        assert.equal(await summary.getAttribute("aria-expanded"), "true", "键盘聚焦展开");
        await p.keyboard.press("Escape");
        await details.waitFor({ state: "hidden" });
        await summary.press("Enter");
        await details.waitFor({ state: "visible" });
        assert.equal(await summary.getAttribute("aria-expanded"), "true");
        await p.keyboard.press("Escape");
        await details.waitFor({ state: "hidden" });
        assert.equal(await summary.getAttribute("aria-expanded"), "false");
        await summary.press("Space");
        await details.waitFor({ state: "visible" });
        await p.keyboard.press("Tab");
        await details.waitFor({ state: "hidden" });
        assert.ok(
          await p.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          ),
        );
        shellEvidence.push({
          width,
          colorScheme,
          initial: "false",
          hover: "true",
          click: ["false", "true"],
          enter: "true",
          escape: "false",
          space: "true",
          focusOut: "false",
          bounds,
        });
      });
      if (width === 1440 && colorScheme === "light") {
        for (const scenario of ["partial", "failed", "unknown", "missing", "empty"]) {
          await check(`shell_summary_state_${scenario}`, async () => {
            await openControls(p);
            await test("machine-demo-shells").selectOption(scenario);
            await closeControls(p);
            const summary = test("machine-shell-summary");
            const text = await summary.innerText();
            if (scenario === "partial") {
              assert.match(text, /✓ zsh.*✓ bash.*✗ sh/s);
            } else if (scenario === "failed") {
              assert.match(text, /✗ zsh.*✗ bash.*✗ sh/s);
              assert.ok(!text.includes("✓"));
            } else if (scenario === "unknown") {
              assert.match(text, /\? unknown/);
              assert.ok(!text.includes("✓"));
            } else {
              assert.match(text, scenario === "missing" ? /尚未探测/ : /未报告 shell/);
              assert.ok(!text.includes("✓"));
            }
            await summary.hover();
            const details = test("machine-shell-details");
            await details.waitFor({ state: "visible" });
            const detailText = await details.innerText();
            if (["partial", "failed"].includes(scenario))
              assert.match(detailText, /自检失败：failed/);
            if (scenario === "unknown") assert.match(detailText, /未知 shell，不猜调用语法/);
            if (scenario === "missing") assert.match(detailText, /尚无能力快照/);
            await p.screenshot({ path: join(evidence, `shell-state-${scenario}.png`) });
            shellEvidence.push({ scenario, summary: text, details: detailText });
            await p.keyboard.press("Escape");
            await details.waitFor({ state: "hidden" });
          });
        }
        await test("machine-detail-back").click();
        await p.locator('[data-machine-id="mch_44444444-4444-4444-8444-444444444444"]').click();
        await check("shell_summary_stale_snapshot_remains_explicit", async () => {
          assert.match(await test("machine-shell-summary").innerText(), /旧代次/);
          assert.equal(await test("machine-detail-stale-capability").count(), 1);
          await test("machine-shell-summary").hover();
          await test("machine-shell-stale").waitFor({ state: "visible" });
          assert.match(await test("machine-shell-stale").innerText(), /不能当作现在可用/);
          await p.screenshot({ path: join(evidence, "shell-state-stale.png") });
          shellEvidence.push({
            scenario: "stale",
            summary: await test("machine-shell-summary").innerText(),
            details: await test("machine-shell-stale").innerText(),
          });
        });
      }
      assert.deepEqual(sample.errors, []);
      await sample.context.close();
    }
  }
  const touch = await open({ width: 390, height: 844, colorScheme: "light", hasTouch: true });
  await check("shell_summary_touch_tap_toggles_without_hover", async () => {
    const p = touch.page;
    await p.getByTestId("machine-item").first().tap();
    const summary = p.getByTestId("machine-shell-summary");
    const details = p.getByTestId("machine-shell-details");
    assert.equal(await summary.getAttribute("aria-expanded"), "false");
    await summary.tap();
    await details.waitFor({ state: "visible" });
    assert.equal(await summary.getAttribute("aria-expanded"), "true");
    await summary.tap();
    await details.waitFor({ state: "hidden" });
    assert.equal(await summary.getAttribute("aria-expanded"), "false");
    shellEvidence.push({ touch: true, tap: ["false", "true", "false"] });
  });
  assert.deepEqual(touch.errors, []);
  await touch.context.close();
  writeFileSync(
    join(evidence, "shell-summary-evidence.json"),
    JSON.stringify(shellEvidence, null, 2),
  );
  const desktop = await open({ width: 1440, height: 900, colorScheme: "light" });
  const page = desktop.page;
  const test = (id) => page.getByTestId(id);

  await check("list_renders_mixed_pairing_and_connection_states", async () => {
    await test("machine-list").waitFor();
    assert.equal(await test("machine-item").count(), 5);
    const text = await test("machine-list").innerText();
    for (const value of ["已配对", "待配对", "在线", "连接中", "断线", "心跳超时"])
      assert.ok(text.includes(value), `缺少 ${value}`);
    assert.ok(!/空闲|已释放/.test(text), "断线不能写成空闲或已释放");
    await shoots(page, "machines-list-1440-light");
  });

  await check("detail_shows_separate_facts_and_install_commands_without_ticket", async () => {
    await test("machine-item").first().click();
    await test("machine-detail-page").waitFor();
    assert.match(page.url(), /scene=machines/);
    assert.equal((await test("machine-detail-enrollment").innerText()).includes("已配对"), true);
    assert.equal((await test("machine-detail-connection").innerText()).includes("在线"), true);
    const shellSummary = test("machine-shell-summary");
    assert.equal(await shellSummary.getAttribute("aria-expanded"), "false");
    assert.equal(await test("machine-shell-details").isVisible(), false);
    await shellSummary.hover();
    await test("machine-shell-details").waitFor({ state: "visible" });
    assert.ok((await test("machine-shell-item").count()) >= 2);
    await page.keyboard.press("Escape");
    assert.equal(await test("machine-command-init").count(), 0);
    const run = await test("machine-command-run").innerText();
    assert.ok(run.includes("--state-dir"));
    assert.ok(!run.includes("--ticket"), "票据不能出现在命令里");
    assert.ok(!run.includes("--allow-http"), "授权只出现在 init");
    assert.ok(!(await test("machine-enrollment-panel").innerText()).includes("AAAAAAAA"));
    await assertPresentation(page, "active");
    await shoots(page, "machine-detail-1440-light");
  });

  await check(
    "binding_form_saves_and_reports_revision_without_claiming_remote_validation",
    async () => {
      await test("machine-root-directory").fill("/Users/linche/workspace/demo-target");
      await test("machine-root-submit").click();
      await test("machine-root-success").waitFor();
      assert.ok((await test("machine-root-success").innerText()).includes("等待 Worker 观察"));
      await test("machine-binding-description").fill("");
      await test("machine-binding-submit").click();
      await test("machine-binding-success").waitFor();
      const message = await test("machine-binding-success").innerText();
      assert.ok(message.includes("revision 3"), message);
      assert.ok(message.includes("已保存到"), message);
      const item = await test("machine-binding-item").first().innerText();
      assert.ok(item.includes("revision 3"), item);
      assert.ok(item.includes("（无说明）"), "空说明可保存，列表显示无说明");
      const bindings = await test("machine-bindings").innerText();
      assert.ok(!bindings.includes("当前可达"), "旧观察不能继续冒充当前可达");
      assert.ok(bindings.includes("旧观察"), bindings);
      assert.equal(await test("machine-binding-description").inputValue(), "");
    },
  );

  await check(
    "root_failure_preserves_draft_and_retry_uses_refreshed_conflict_revision",
    async () => {
      await openControls(page);
      await test("machine-fail-root").check();
      await test("machine-root-directory").fill("/Users/linche/draft-root");
      await test("machine-root-submit").click();
      assert.equal(await test("machine-root-submit").isDisabled(), true);
      await test("machine-root-error").waitFor();
      assert.equal(await test("machine-root-directory").inputValue(), "/Users/linche/draft-root");
      await test("machine-fail-root").uncheck();
      await test("machine-conflict-root").check();
      await test("machine-root-submit").click();
      await test("machine-root-error").filter({ hasText: "conflict" }).waitFor();
      assert.ok((await test("machine-root-current").innerText()).includes("/Users/other/root"));
      assert.equal(await test("machine-root-directory").inputValue(), "/Users/linche/draft-root");
      await test("machine-root-submit").click();
      await test("machine-root-success").waitFor();
      assert.ok(
        (await test("machine-root-current").innerText()).includes("/Users/linche/draft-root"),
      );
      await closeControls(page);
      await shoots(page, "machine-root-retry-1440-light");
    },
  );

  await check("root_clear_disables_paths_and_two_projects_derive_distinct_paths", async () => {
    await test("machine-detail-back").click();
    await page.locator('[data-machine-id="mch_44444444-4444-4444-8444-444444444444"]').click();
    await test("machine-root-directory").fill("/Users/linche/draft-root");
    await test("machine-root-submit").click();
    await test("machine-root-success").waitFor();
    const paths = await test("machine-binding-path").allTextContents();
    assert.equal(paths.length, 2);
    assert.notEqual(paths[0], paths[1]);
    assert.ok(paths.every((path) => path.includes("/Users/linche/draft-root/prj_")));
    await test("machine-root-directory").fill("");
    await test("machine-root-submit").click();
    await test("machine-root-success").waitFor();
    assert.ok((await test("machine-root-current").innerText()).includes("未设置"));
    assert.ok(
      (await test("machine-binding-path").allTextContents()).every((path) =>
        path.includes("无法探测路径"),
      ),
    );
    await test("machine-detail-back").click();
    await page.locator('[data-machine-id="mch_11111111-1111-4111-8111-111111111111"]').click();
  });

  await check("binding_failure_keeps_input_and_shows_error", async () => {
    await openControls(page);
    await test("machine-fail-save").check();
    await test("machine-binding-description").fill("演示：失败后仍保留");
    await test("machine-binding-submit").click();
    await test("machine-binding-error").waitFor();
    assert.equal(await test("machine-binding-description").inputValue(), "演示：失败后仍保留");
    assert.equal(await test("machine-binding-submit").isDisabled(), false);
    await test("machine-fail-save").uncheck();
    await closeControls(page);
    await shoots(page, "machine-binding-error-1440-light");
  });

  await check("back_returns_to_list_and_stale_observation_is_labelled", async () => {
    await test("machine-detail-back").click();
    await test("machine-list").waitFor();
    await page.locator('[data-machine-id="mch_44444444-4444-4444-8444-444444444444"]').click();
    await test("machine-detail-page").waitFor();
    const text = await test("machine-bindings").innerText();
    assert.ok(text.includes("旧观察"), text);
    assert.ok((await test("machine-detail-connection").innerText()).includes("断线"));
    assert.ok((await test("machine-detail-enrollment").innerText()).includes("已配对"));
    assert.ok((await test("machine-detail-stale-capability").count()) === 1);
    await shoots(page, "machine-detail-offline-1440-light");
  });

  await check("pending_machine_renews_ticket_and_hides_it_by_default", async () => {
    await test("machine-detail-back").click();
    await test("machine-list").waitFor();
    await page.locator('[data-machine-id="mch_22222222-2222-4222-8222-222222222222"]').click();
    await test("machine-enrollment-status").waitFor();
    assert.ok((await test("machine-enrollment-panel").innerText()).includes("待配对"));
    assert.equal(await test("machine-ticket-value").count(), 0);
    await assertPresentation(page, "pending");
    await test("machine-renew").click();
    await test("machine-ticket-hidden").waitFor();
    await test("machine-ticket-toggle").click();
    await test("machine-ticket-value").waitFor();
    const ticket = (await test("machine-ticket-value").innerText()).trim();
    assert.equal(ticket.length, 43);
    await test("machine-ticket-toggle").click();
    await test("machine-ticket-hidden").waitFor();
  });

  await check("active_machine_has_no_renew_button_and_shows_pending_state", async () => {
    await test("machine-detail-back").click();
    await test("machine-list").waitFor();
    await page.locator('[data-machine-id="mch_33333333-3333-4333-8333-333333333333"]').click();
    await test("machine-enrollment-status").waitFor();
    assert.equal(await test("machine-renew").count(), 0, "active 不显示续签");
    assert.ok((await test("machine-enrollment-panel").innerText()).includes("已配对"));
    assert.ok((await test("machine-detail-connection").innerText()).includes("连接中"));
  });

  await check("renew_failure_shows_safe_error_and_keeps_retry", async () => {
    await test("machine-detail-back").click();
    await test("machine-list").waitFor();
    await page.locator('[data-machine-id="mch_55555555-5555-4555-8555-555555555555"]').click();
    await test("machine-enrollment-status").waitFor();
    await openControls(page);
    await test("machine-throw-renew").check();
    await closeControls(page);
    await test("machine-renew").click();
    await test("machine-renew-error").waitFor();
    const text = await test("machine-renew-error").innerText();
    assert.ok(text.includes("内部错误"), text);
    assert.ok(!text.includes("REVIEW_NETWORK_FAILURE"), "异常内部细节不能呈现");
    assert.equal(await test("machine-renew").isDisabled(), false, "失败后 pending 恢复可重试");
    assert.equal(await test("machine-ticket-hidden").count(), 0, "失败不凭空产生票据");
    await openControls(page);
    await test("machine-throw-renew").uncheck();
    await closeControls(page);
    await test("machine-renew").click();
    await test("machine-ticket-hidden").waitFor();
    assert.deepEqual(desktop.errors, []);
  });

  await check("renew_race_does_not_leak_ticket_to_next_machine", async () => {
    await test("machine-detail-back").click();
    await test("machine-list").waitFor();
    await page.locator('[data-machine-id="mch_55555555-5555-4555-8555-555555555555"]').click();
    await test("machine-renew").click();
    await openControls(page);
    await test("machine-demo-switch").selectOption({ label: "刚唤醒的 Mac Studio" });
    await closeControls(page);
    await test("machine-enrollment-status").waitFor();
    await page.waitForTimeout(900);
    assert.equal(await test("machine-ticket-toggle").count(), 0, "A 的迟到票据不能出现在 B");
    assert.equal(await test("machine-ticket-hidden").count(), 0);
    assert.ok((await test("machine-enrollment-panel").innerText()).includes("已配对"));
    assert.deepEqual(desktop.errors, []);
  });

  await check("pending_to_active_clears_ticket_without_navigation", async () => {
    await test("machine-detail-back").click();
    await test("machine-list").waitFor();
    await page.locator('[data-machine-id="mch_22222222-2222-4222-8222-222222222222"]').click();
    await test("machine-ticket-toggle").waitFor();
    await openControls(page);
    await test("machine-demo-activate").click();
    await closeControls(page);
    await test("machine-enrollment-status").waitFor();
    assert.ok((await test("machine-enrollment-status").innerText()).includes("已配对"));
    assert.equal(await test("machine-ticket-toggle").count(), 0, "已配对后旧票据不再显示");
    assert.equal(await test("machine-renew").count(), 0);
    assert.ok((await test("machine-enrollment-expires").innerText()).includes("没有待使用的票据"));
  });

  await check("create_flow_adds_pending_machine_and_opens_detail", async () => {
    await test("machine-detail-back").click();
    await test("machine-list").waitFor();
    await test("new-machine-trigger").click();
    await test("machine-name-input").fill("演示新机器");
    await test("machine-create-submit").click();
    await test("machine-detail-page").waitFor();
    assert.equal((await test("machine-detail-name").innerText()).trim(), "演示新机器");
    assert.ok((await test("machine-enrollment-panel").innerText()).includes("待配对"));
    assert.ok((await test("machine-detail-description").innerText()).includes("从未连接"));
  });

  await check("create_failure_keeps_name_input", async () => {
    await test("machine-detail-back").click();
    await test("machine-list").waitFor();
    await openControls(page);
    await test("machine-fail-create").check();
    await test("new-machine-trigger").click();
    await test("machine-name-input").fill("演示建不出来的机器");
    await test("machine-create-submit").click();
    await test("machine-create-error").waitFor();
    assert.equal(await test("machine-name-input").inputValue(), "演示建不出来的机器");
    await shoots(page, "machine-create-error-1440-light");
    await page.getByRole("button", { name: "取消" }).click();
    await test("machine-name-input").waitFor({ state: "detached" });
    await test("machine-fail-create").uncheck();
    await closeControls(page);
    await test("machine-list").waitFor();
  });

  await check("project_switch_changes_binding_form_target", async () => {
    await page.locator('[data-machine-id="mch_11111111-1111-4111-8111-111111111111"]').click();
    await test("machine-detail-page").waitFor();
    assert.equal(
      await test("machine-binding-submit").innerText(),
      "保存绑定",
      "已绑定 Project 显示保存",
    );
    await openControls(page);
    await test("machine-demo-project").selectOption({ label: "第二个 Project" });
    await closeControls(page);
    await test("machine-binding-submit").waitFor();
    assert.equal(await test("machine-binding-description").inputValue(), "");
    assert.ok((await test("machine-binding-submit").innerText()).includes("第二个 Project"));
  });

  const lifecycleA = "mch_11111111-1111-4111-8111-111111111111";
  const lifecycleB = "mch_22222222-2222-4222-8222-222222222222";
  const probe = (run, arg) => page.evaluate(run, arg);
  const pendingRequests = () => probe(() => window.__machineLifecycle.pending());
  const settle = (index, kind) =>
    probe(([i, k]) => window.__machineLifecycle.settle(i, k), [index, kind]);
  const show = async (machineId, mode = "empty") => {
    await probe(([id, m]) => window.__machineLifecycle.show(id, m), [machineId, mode]);
    await page.waitForFunction(
      (id) => window.__machineLifecycle.commits().at(-1)?.machineId === id,
      machineId,
    );
  };
  const visit = async (machineId) => {
    await probe((id) => window.__machineLifecycle.visit(id), machineId);
    await page.waitForFunction(
      (id) => window.__machineLifecycle.commits().at(-1)?.machineId === id,
      machineId,
    );
  };
  const renewAvailable = () =>
    page.waitForFunction(
      () => {
        const element = document.querySelector('[data-testid="machine-renew"]');
        return element !== null && !element.disabled;
      },
      undefined,
      { timeout: 500 },
    );
  const openLifecycleProbe = async () => {
    await test("machine-detail-back").click();
    await test("machine-list").waitFor();
    await test("machine-lifecycle-link").click();
    await test("machine-lifecycle-probe").waitFor();
    await probe(() => window.__machineLifecycle.show("mch_11111111-1111-4111-8111-111111111111"));
    await test("machine-renew").waitFor();
  };

  await check("switch_to_pending_machine_keeps_renew_available_and_isolates_results", async () => {
    await openLifecycleProbe();
    await test("machine-renew").click();
    assert.equal(await test("machine-renew").isDisabled(), true, "A 请求进行中");
    await show(lifecycleB);
    await test("machine-renew").waitFor();
    assert.deepEqual(await pendingRequests(), [lifecycleA]);
    await renewAvailable();
    assert.equal(await test("machine-renew").isDisabled(), false, "切到 B 后 B 立即可续签");
    await test("machine-renew").click();
    assert.deepEqual(await pendingRequests(), [lifecycleA, lifecycleB]);
    assert.equal(await test("machine-renew").isDisabled(), true, "B 自己的请求防重复");
    await settle(1, "success");
    await test("machine-ticket-toggle").waitFor();
    await test("machine-ticket-toggle").click();
    await test("machine-ticket-value").waitFor();
    const bTicket = (await test("machine-ticket-value").innerText()).trim();
    assert.ok(bTicket.startsWith("22222222"), "B 票据归属正确");
    await settle(0, "failure");
    await page.waitForTimeout(150);
    assert.equal(await test("machine-renew-error").count(), 0, "A 的失败不能落到 B");
    assert.equal(await test("machine-ticket-toggle").count(), 1, "A 的失败不能清掉 B 票据");
    assert.ok(
      (await test("machine-ticket-value").innerText()).trim() === bTicket,
      "A 失败后 B 票据保持",
    );
    await test("machine-ticket-toggle").click();
    await test("machine-ticket-hidden").waitFor();
    await shoots(page, "machine-lifecycle-switch-1440-light");
  });

  await check("aba_return_to_same_machine_ignores_stale_renewal", async () => {
    await show(lifecycleA);
    await test("machine-renew").click();
    await show(lifecycleB);
    await renewAvailable();
    await show(lifecycleA);
    await renewAvailable();
    await test("machine-renew").click();
    assert.deepEqual(await pendingRequests(), [lifecycleA, lifecycleA], "旧 A 与新 A 是两次操作");
    await settle(0, "success");
    await page.waitForTimeout(150);
    assert.equal(await test("machine-ticket-toggle").count(), 0, "旧 A 的结果不能给新 A 发票据");
    assert.equal(await test("machine-renew").isDisabled(), true, "旧 A 不能清掉新 A 的 pending");
    await settle(0, "success");
    await test("machine-ticket-toggle").waitFor();
    await test("machine-ticket-toggle").click();
    const abaTicket = (await test("machine-ticket-value").innerText()).trim();
    assert.ok(abaTicket.startsWith("11111111"), "新 A 票据归属正确");
  });

  await check("unmounted_panel_drops_late_renewal_result", async () => {
    await show(lifecycleA);
    await test("machine-renew").click();
    await probe(() => window.__machineLifecycle.unmount());
    await test("machine-enrollment-panel").waitFor({ state: "detached" });
    await settle(0, "success");
    await show(lifecycleA);
    await test("machine-renew").waitFor();
    await page.waitForTimeout(150);
    assert.equal(await test("machine-ticket-toggle").count(), 0, "卸载后的旧结果不能污染新组件");
    assert.equal(await test("machine-renew-error").count(), 0);
    await renewAvailable();
  });

  await check("same_identity_prop_refresh_keeps_ticket_and_in_flight_request", async () => {
    await show(lifecycleA, "ticket");
    await test("machine-ticket-toggle").waitFor();
    await test("machine-renew").click();
    await settle(0, "success");
    await test("machine-ticket-toggle").waitFor();
    await test("machine-ticket-toggle").click();
    await test("machine-ticket-value").waitFor();
    const revealedTicket = (await test("machine-ticket-value").innerText()).trim();
    await probe(() => window.__machineLifecycle.refresh());
    await page.waitForTimeout(150);
    assert.ok(
      (await test("machine-ticket-value").innerText()).trim() === revealedTicket,
      "等价刷新保留票据",
    );
    await test("machine-renew").click();
    await probe(() => window.__machineLifecycle.refresh());
    await page.waitForTimeout(150);
    assert.deepEqual(await pendingRequests(), [lifecycleA], "等价刷新不能打断进行中的请求");
    assert.equal(await test("machine-renew").isDisabled(), true);
    await settle(0, "throw");
    await test("machine-renew-error").waitFor();
    const text = await test("machine-renew-error").innerText();
    assert.ok(!text.includes("LIFECYCLE_PROBE_THROW"), "异常内部细节不能呈现");
    await renewAvailable();
  });

  await check("every_identity_switch_commit_excludes_previous_ticket", async () => {
    await show(lifecycleB);
    await renewAvailable();
    await show(lifecycleA, "ticket");
    await test("machine-ticket-toggle").click();
    await test("machine-ticket-value").waitFor();
    const start = await probe(() => window.__machineLifecycle.commits().length);
    await show(lifecycleB);
    await renewAvailable();
    const commits = await probe(
      (offset) => window.__machineLifecycle.commits().slice(offset),
      start,
    );
    assert.ok(commits.some((commit) => commit.machineId === lifecycleB));
    assert.ok(
      commits.every((commit) => commit.owned),
      "每次 DOM 提交只能包含当前 Machine 的票据",
    );
    assert.ok(
      commits
        .filter((commit) => commit.machineId === lifecycleB)
        .every((commit) => !commit.exposed),
    );
  });

  await check("mismatched_enrollment_is_hidden_and_owned_ticket_can_toggle", async () => {
    await probe(
      ([id, owner]) => window.__machineLifecycle.show(id, "ticket", owner),
      [lifecycleB, lifecycleA],
    );
    await page.waitForTimeout(150);
    assert.equal(await test("machine-ticket-toggle").count(), 0);
    assert.equal(await test("machine-ticket-value").count(), 0);
    await show(lifecycleB, "ticket");
    await test("machine-ticket-toggle").click();
    await test("machine-ticket-value").waitFor();
    assert.equal(
      await test("machine-ticket-value").evaluate((element) => element.textContent.length),
      43,
    );
    await test("machine-ticket-toggle").click();
    await test("machine-ticket-hidden").waitFor();
    const commits = await probe(() => window.__machineLifecycle.commits());
    assert.ok(
      commits.every((commit) => commit.owned),
      "错配 prop 的任何提交均不能展示其他 Machine 的票据",
    );
  });

  await check(
    "late_renewal_from_previous_machine_does_not_replace_current_parent_ticket",
    async () => {
      await show(lifecycleB, "ticket");
      await test("machine-ticket-toggle").waitFor();
      await visit(lifecycleA);
      await test("machine-renew").click();
      assert.deepEqual(await pendingRequests(), [lifecycleA], "A 的续签在途");
      await visit(lifecycleB);
      await test("machine-ticket-toggle").waitFor();
      await settle(0, "success");
      await page.waitForTimeout(150);
      assert.deepEqual(await pendingRequests(), [], "A 的迟到结果已落地");
      assert.equal(
        await probe(() => window.__machineLifecycle.parent()),
        lifecycleB,
        "A 的迟到结果不能写进父级槽位",
      );
      await test("machine-ticket-toggle").click();
      await test("machine-ticket-value").waitFor();
      const kept = (await test("machine-ticket-value").innerText()).trim();
      assert.ok(kept.startsWith("22222222"), "B 的创建票据保持可见");
      await test("machine-ticket-toggle").click();
      await test("machine-ticket-hidden").waitFor();
      assert.deepEqual(desktop.errors, []);
    },
  );

  await check("abandoned_in_flight_renewal_revokes_the_same_machine_parent_slot", async () => {
    await show(lifecycleA, "ticket");
    await test("machine-ticket-toggle").click();
    await test("machine-ticket-value").waitFor();
    const creation = (await test("machine-ticket-value").innerText()).trim();
    await test("machine-ticket-toggle").click();
    await test("machine-ticket-hidden").waitFor();
    await test("machine-renew").click();
    assert.deepEqual(await pendingRequests(), [lifecycleA], "当前 Machine 的续签在途");
    await visit(lifecycleB);
    await renewAvailable();
    assert.equal(
      await probe(() => window.__machineLifecycle.parent()),
      null,
      "切走后同一 Machine 的父级槽位被撤销",
    );
    await settle(0, "success");
    await visit(lifecycleA);
    await renewAvailable();
    assert.equal(await test("machine-ticket-toggle").count(), 0, "重开时没有旧票据");
    assert.ok(
      (await test("machine-enrollment-expires").innerText()).includes("没有待使用的票据"),
      "面板呈现没有待使用的票据",
    );
    assert.equal(
      await probe(() => window.__machineLifecycle.parent()),
      null,
      "已交付的成功结果也不能让旧创建票据复活",
    );
    await probe(() => window.__machineLifecycle.unmount());
    await test("machine-enrollment-panel").waitFor({ state: "detached" });
    await show(lifecycleA, "ticket");
    await test("machine-ticket-toggle").waitFor();
    await test("machine-renew").click();
    assert.deepEqual(await pendingRequests(), [lifecycleA], "重开后的续签在途");
    await probe(() => window.__machineLifecycle.unmount());
    await test("machine-enrollment-panel").waitFor({ state: "detached" });
    assert.equal(await probe(() => window.__machineLifecycle.parent()), null, "卸载也撤销在途槽位");
    await settle(0, "success");
    await visit(lifecycleA);
    await renewAvailable();
    assert.equal(await test("machine-ticket-toggle").count(), 0, "卸载后的重开没有旧票据");
    assert.ok(creation.startsWith("11111111"));
  });

  await check("no_business_requests_from_dev_scenes", async () => {
    assert.deepEqual(applicationRequests, []);
  });

  await check("no_console_errors", async () => {
    assert.deepEqual(desktop.errors, []);
  });

  await desktop.context.close();

  const narrow = await open({ width: 390, height: 844, colorScheme: "light" });
  await check("390_light_list_and_detail_scroll_binding_and_install", async () => {
    await narrow.page.getByTestId("machine-list").waitFor();
    await shoots(narrow.page, "machines-list-390-light");
    await narrow.page
      .locator('[data-machine-id="mch_44444444-4444-4444-8444-444444444444"]')
      .click();
    await narrow.page.getByTestId("machine-detail-page").waitFor();
    const overflow = await narrow.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 1, `横向溢出 ${overflow}px`);
    const controlsPosition = await narrow.page
      .getByTestId("machine-scene-controls")
      .evaluate((element) => getComputedStyle(element).position);
    assert.notEqual(controlsPosition, "fixed", "演示控制不能固定覆盖手机底栏");
    await narrow.page.screenshot({
      path: join(evidence, "machine-detail-390-light.png"),
    });
    await narrow.page.getByTestId("machine-binding-form").scrollIntoViewIfNeeded();
    await narrow.page.screenshot({
      path: join(evidence, "machine-detail-390-light-binding.png"),
    });
    await narrow.page.getByTestId("machine-install").scrollIntoViewIfNeeded();
    await narrow.page.screenshot({
      path: join(evidence, "machine-detail-390-light-install.png"),
    });
    const command = await narrow.page.getByTestId("machine-command-run").evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      text: element.textContent ?? "",
    }));
    assert.ok(command.scrollWidth > command.clientWidth, "长命令不能只靠页面溢出展示");
    assert.ok(command.text.includes('--state-dir "$HOME/.local/share/sprout-worker/identity"'));
    assert.ok(!command.text.includes("--ticket"));
    const reachedEnd = await narrow.page.getByTestId("machine-command-run").evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft + element.clientWidth >= element.scrollWidth - 1;
    });
    assert.ok(reachedEnd, "长命令可滚动到末尾");
    assert.deepEqual(narrow.errors, []);
  });
  await narrow.context.close();

  const darkNarrow = await open({ width: 390, height: 844, colorScheme: "dark" });
  await check("390_dark_list_and_detail_scroll_binding_and_install", async () => {
    await darkNarrow.page.getByTestId("machine-list").waitFor();
    await shoots(darkNarrow.page, "machines-list-390-dark");
    await darkNarrow.page
      .locator('[data-machine-id="mch_44444444-4444-4444-8444-444444444444"]')
      .click();
    await darkNarrow.page.getByTestId("machine-detail-page").waitFor();
    await darkNarrow.page.screenshot({
      path: join(evidence, "machine-detail-390-dark.png"),
    });
    await darkNarrow.page.getByTestId("machine-binding-form").scrollIntoViewIfNeeded();
    await darkNarrow.page.screenshot({
      path: join(evidence, "machine-detail-390-dark-binding.png"),
    });
    await darkNarrow.page.getByTestId("machine-install").scrollIntoViewIfNeeded();
    await darkNarrow.page.screenshot({
      path: join(evidence, "machine-detail-390-dark-install.png"),
    });
    assert.deepEqual(darkNarrow.errors, []);
  });
  await darkNarrow.context.close();

  const dark = await open({ width: 1440, height: 900, colorScheme: "dark" });
  await check("dark_theme_list_and_detail", async () => {
    await assertPresentationMatrix();
    await dark.page.getByTestId("machine-list").waitFor();
    await shoots(dark.page, "machines-list-1440-dark");
    await dark.page.locator('[data-machine-id="mch_11111111-1111-4111-8111-111111111111"]').click();
    await dark.page.getByTestId("machine-detail-page").waitFor();
    await shoots(dark.page, "machine-detail-1440-dark");
    assert.deepEqual(dark.errors, []);
  });
  await dark.context.close();

  const existing = await open({ width: 1440, height: 900, colorScheme: "light", scene: "agents" });
  await check("existing_agents_scene_still_works", async () => {
    await existing.page.getByTestId("agent-list").waitFor();
    assert.ok((await existing.page.getByTestId("agent-item").count()) > 0);
    assert.deepEqual(existing.errors, []);
  });
  await existing.context.close();
} finally {
  await browser.close();
}

const failed = results.filter((item) => !item.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
