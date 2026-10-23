import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
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

async function open({ width, height, colorScheme, scene = "machines" }) {
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

const shoots = (page, name) =>
  page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });

try {
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
    assert.ok((await test("machine-shell-item").count()) >= 2);
    const init = await test("machine-command-init").innerText();
    assert.ok(init.includes("--machine mch_"));
    assert.ok(init.includes("--state-dir"));
    assert.ok(!init.includes("--ticket"), "票据不能出现在命令里");
    assert.ok(!(await test("machine-enrollment-panel").innerText()).includes("AAAAAAAA"));
    await shoots(page, "machine-detail-1440-light");
  });

  await check(
    "binding_form_saves_and_reports_revision_without_claiming_remote_validation",
    async () => {
      await test("machine-binding-description").fill("");
      await test("machine-binding-directory").fill("/Users/linche/workspace/demo-target");
      await test("machine-binding-submit").click();
      await test("machine-binding-success").waitFor();
      const message = await test("machine-binding-success").innerText();
      assert.ok(message.includes("revision 3"), message);
      assert.ok(message.includes("不代表 Worker 已验证该目录可达"), message);
      const item = await test("machine-binding-item").first().innerText();
      assert.ok(item.includes("revision 3"), item);
      assert.ok(item.includes("（无说明）"), "空说明可保存，列表显示无说明");
      const bindings = await test("machine-bindings").innerText();
      assert.ok(!bindings.includes("当前可达"), "旧观察不能继续冒充当前可达");
      assert.ok(bindings.includes("未验证"), bindings);
      assert.equal(await test("machine-binding-description").inputValue(), "");
    },
  );

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
  const show = (machineId, mode = "empty") =>
    probe(([id, m]) => window.__machineLifecycle.show(id, m), [machineId, mode]);
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
    assert.ok(bTicket.startsWith("22222222"), bTicket);
    await settle(0, "failure");
    await page.waitForTimeout(150);
    assert.equal(await test("machine-renew-error").count(), 0, "A 的失败不能落到 B");
    assert.equal(await test("machine-ticket-toggle").count(), 1, "A 的失败不能清掉 B 票据");
    assert.equal((await test("machine-ticket-value").innerText()).trim(), bTicket);
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
    assert.ok(abaTicket.startsWith("11111111"), abaTicket);
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
    assert.equal((await test("machine-ticket-value").innerText()).trim(), revealedTicket);
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
    const command = await narrow.page.getByTestId("machine-command-init").evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      text: element.textContent ?? "",
    }));
    assert.ok(command.scrollWidth > command.clientWidth, "长命令不能只靠页面溢出展示");
    assert.ok(command.text.includes("--state-dir <dir>"));
    assert.ok(!command.text.includes("--ticket"));
    const reachedEnd = await narrow.page.getByTestId("machine-command-init").evaluate((element) => {
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
