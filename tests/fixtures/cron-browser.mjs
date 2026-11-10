import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  verifyAutomationTargetPicker,
  verifyAutomationUnknownRoute,
} from "./automation-browser.mjs";

async function verifyFixedTimezones({ page, base, project, alpha, call, until, pass }) {
  const browser = page.context().browser();
  const storageState = await page.context().storageState();
  for (const [timezoneId, winterOffset, expected] of [
    ["Asia/Kathmandu", "+05:45", "+05:45"],
    ["America/St_Johns", "-03:30", "-02:30"],
  ]) {
    const context = await browser.newContext({ storageState, timezoneId });
    try {
      const tab = await context.newPage();
      const errors = [];
      tab.on("pageerror", (error) => errors.push(error.message));
      await tab.goto(`${base}/projects/${project.id}/settings/cron/new`, {
        waitUntil: "networkidle",
      });
      const editor = tab.getByTestId("cron-editor-page");
      const timezone = editor.getByLabel("时区", { exact: true });
      await until(() => timezone.isEnabled(), `${timezoneId} editor ready`);
      assert.equal(await timezone.inputValue(), "current");
      // St John's observes DST: pin the browser clock to winter for this assertion.
      await tab.clock.install({ time: new Date("2026-01-15T12:00:00Z") });
      await tab.reload({ waitUntil: "networkidle" });
      await until(() => timezone.isEnabled(), `${timezoneId} winter editor ready`);
      assert.equal(
        await timezone.locator('option[value="current"]').innerText(),
        `当前时区（UTC${winterOffset}）`,
      );
      await tab.clock.setFixedTime(new Date("2026-07-15T12:00:00Z"));
      assert.equal(
        await timezone.inputValue(),
        "current",
        "clock change does not replace current selection",
      );
      await editor.getByLabel("规则名称", { exact: true }).fill(`Frozen ${timezoneId}`);
      await editor.getByLabel("指令", { exact: true }).fill("Timezone fixture");
      await editor.getByLabel("目标 Agent", { exact: true }).selectOption(alpha.id);
      await editor.getByLabel("Cron 表达式").fill("0 0 29 2 *");
      await editor.getByLabel("启用定时规则", { exact: true }).check();
      await editor.getByRole("button", { name: "保存定时规则", exact: true }).click();
      const saved = await until(
        async () =>
          (await call("listCronRulesFn", { projectId: project.id })).find(
            (r) => r.name === `Frozen ${timezoneId}`,
          ),
        `${timezoneId} saved`,
      );
      assert.equal(
        saved.timezone,
        expected,
        "save takes the current minute offset, not the mount-time offset or IANA name",
      );
      assert(saved.nextAt);
      await until(
        () => editor.getByRole("button", { name: "Trial 定时规则", exact: true }).isEnabled(),
        "fractional save settled",
      );
      assert.equal(await timezone.inputValue(), expected);
      assert((await editor.getByTestId("cron-next").innerText()).includes(`UTC${expected}`));
      const changedContext = await browser.newContext({
        storageState,
        timezoneId: "Pacific/Auckland",
      });
      try {
        const changedTab = await changedContext.newPage();
        changedTab.on("pageerror", (error) => errors.push(error.message));
        await changedTab.goto(`${base}/projects/${project.id}/settings/cron/${saved.id}`, {
          waitUntil: "networkidle",
        });
        const changedEditor = changedTab.getByTestId("cron-editor-page");
        await changedTab.reload({ waitUntil: "networkidle" });
        await until(
          () =>
            changedEditor.getByRole("button", { name: "Trial 定时规则", exact: true }).isEnabled(),
          "reloaded in different browser timezone stays clean",
        );
        assert.equal(
          await changedEditor.getByLabel("时区", { exact: true }).inputValue(),
          expected,
        );
        await changedEditor.getByLabel("规则名称", { exact: true }).fill(`Edited ${timezoneId}`);
        await changedEditor.getByRole("button", { name: "保存定时规则", exact: true }).click();
        const edited = await until(
          async () =>
            (await call("listCronRulesFn", { projectId: project.id })).find(
              (r) => r.id === saved.id && r.name === `Edited ${timezoneId}`,
            ),
          "edit retained frozen timezone",
        );
        assert.equal(edited.timezone, expected);
      } finally {
        await changedContext.close();
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  pass(
    "current browser timezone defaults, fractional offsets freeze on save and survive browser timezone changes/reload/unrelated edits",
  );

  for (const savedTimezone of ["America/New_York", "Etc/GMT-8", "UTC"]) {
    const saved = await call("createCronRuleFn", {
      projectId: project.id,
      name: `Legacy ${savedTimezone}`,
      instruction: "Legacy fixture",
      enabled: false,
      expression: "0 9 * * *",
      timezone: savedTimezone,
      action: { kind: "dm_agent", agentProfileId: alpha.id },
    });
    await page.goto(`${base}/projects/${project.id}/settings/cron/${saved.id}`, {
      waitUntil: "networkidle",
    });
    const editor = page.getByTestId("cron-editor-page");
    const timezone = editor.getByLabel("时区", { exact: true });
    await until(
      () => editor.getByRole("button", { name: "Trial 定时规则", exact: true }).isEnabled(),
      "legacy edit clean",
    );
    assert.equal(await timezone.inputValue(), savedTimezone);
    assert.equal(
      await timezone.locator(`option[value="${savedTimezone}"]`).innerText(),
      `${savedTimezone}（已保存）`,
    );
    assert.equal(
      await timezone.locator('option[value*="/"]').count(),
      savedTimezone.includes("/") ? 1 : 0,
    );
    await editor.getByLabel("规则名称", { exact: true }).fill(`Retained ${savedTimezone}`);
    await editor.getByRole("button", { name: "保存定时规则", exact: true }).click();
    const retained = await until(
      async () =>
        (await call("listCronRulesFn", { projectId: project.id })).find(
          (r) => r.id === saved.id && r.name === `Retained ${savedTimezone}`,
        ),
      "legacy timezone retained on unrelated save",
    );
    assert.equal(retained.timezone, savedTimezone);
    await until(
      () => editor.getByRole("button", { name: "Trial 定时规则", exact: true }).isEnabled(),
      "legacy save settled",
    );
    const replacement = savedTimezone === "UTC" ? "current" : "+05:30";
    const expected =
      replacement === "current"
        ? await page.evaluate(() => {
            const minutes = -new Date().getTimezoneOffset();
            return `${minutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
          })
        : replacement;
    await timezone.selectOption(replacement);
    await editor.getByRole("button", { name: "保存定时规则", exact: true }).click();
    await until(
      async () =>
        (await call("listCronRulesFn", { projectId: project.id })).find((r) => r.id === saved.id)
          ?.timezone === expected,
      "explicit current/fixed offset replacement",
    );
  }
  pass(
    "saved IANA/Etc/UTC values remain a single saved option and persist unchanged until explicit fixed-offset selection",
  );
}

export async function verifyCronBrowser({
  page,
  db,
  fixture,
  project,
  alpha,
  beta,
  foreign,
  dm,
  group,
  humanId,
  base,
  directory,
  ids,
  call,
  callResult,
  until,
  pass,
}) {
  await page
    .getByRole("navigation", { name: "Project 设置分类" })
    .getByRole("link", { name: "定时任务", exact: true })
    .click();
  assert(new URL(page.url()).searchParams.get("tab") === "cron");
  assert.equal(await page.getByLabel("规则名称", { exact: true }).count(), 0);
  await page.getByRole("link", { name: "新建定时规则", exact: true }).click();
  const ui = page.getByTestId("cron-editor-page");
  await ui.waitFor();
  assert(new URL(page.url()).pathname.endsWith("/settings/cron/new"));
  await until(() => ui.getByLabel("规则名称", { exact: true }).isEnabled(), "cron editor ready");
  await verifyAutomationTargetPicker({ ui, page, project, beta, call, until });
  await ui.getByLabel("规则名称", { exact: true }).fill("Browser cron");
  await ui.getByLabel("Cron 表达式").fill("0 0 29 2 *");
  const zone = ui.getByLabel("时区", { exact: true });
  const browserTimezone = await page.evaluate(() => {
    const minutes = -new Date().getTimezoneOffset();
    return `${minutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
  });
  assert.equal(await zone.inputValue(), "current");
  assert.equal(
    await zone.locator('option[value="current"]').innerText(),
    `当前时区（UTC${browserTimezone}）`,
  );
  for (const value of ["-12:00", "+14:00", "+05:30", "+05:45", "-03:30"])
    assert.equal(await zone.locator(`option[value="${value}"]`).innerText(), `UTC${value}`);
  assert.equal(await zone.locator('optgroup[label*="地区"]').count(), 0);
  assert.equal(await zone.locator('option[value*="/"]').count(), 0);
  const helpBounds = await ui.getByLabel("Cron 语法帮助").boundingBox();
  const expressionBounds = await ui.getByLabel("Cron 表达式").boundingBox();
  assert(helpBounds && expressionBounds);
  assert(
    Math.abs(
      helpBounds.y + helpBounds.height / 2 - (expressionBounds.y + expressionBounds.height / 2),
    ) <= 2,
    "cron help button is vertically centred with the expression field",
  );
  assert(
    helpBounds.x >= expressionBounds.x + expressionBounds.width,
    "cron help button sits after the expression field, not inside it",
  );
  assert.equal((await ui.getByLabel("Cron 语法帮助").innerText()).trim(), "");
  await ui.getByLabel("Cron 语法帮助").click();
  await page.getByTestId("cron-help").waitFor();
  assert((await page.getByTestId("cron-help").innerText()).includes("OR"));
  await ui.getByLabel("规则名称", { exact: true }).click();
  await page.getByTestId("cron-help").waitFor({ state: "hidden" });
  await ui.getByLabel("Cron 语法帮助").click();
  await page.getByTestId("cron-help").waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("cron-help").waitFor({ state: "hidden" });
  await ui
    .getByLabel("指令", { exact: true })
    .fill("CRON_BROWSER @HookAlpha /skill:danger. Reply briefly.");
  await ui.getByLabel("动作", { exact: true }).selectOption("dm_agent");
  assert.equal(await ui.getByLabel("目标 Chat", { exact: true }).count(), 0);
  await until(
    async () =>
      (
        await ui.getByLabel("目标 Agent", { exact: true }).locator("option").allTextContents()
      ).includes(alpha.name),
    "current effective members",
  );
  const options = await ui
    .getByLabel("目标 Agent", { exact: true })
    .locator("option")
    .allTextContents();
  assert(options.includes(beta.name) && !options.includes(foreign.name));
  await ui.getByLabel("目标 Agent", { exact: true }).selectOption(alpha.id);
  await ui.getByLabel("启用定时规则", { exact: true }).check();
  await ui.getByRole("button", { name: "保存定时规则", exact: true }).click();
  await until(
    async () => (await call("listCronRulesFn", { projectId: project.id })).length === 1,
    "browser created cron",
  );
  await until(
    () => ui.getByRole("button", { name: "Trial 定时规则", exact: true }).isEnabled(),
    "saved rule selected",
  );
  let rule = (await call("listCronRulesFn", { projectId: project.id }))[0];
  assert.equal(rule.timezone, browserTimezone);
  assert(rule.nextAt && !Object.hasOwn(rule, "endpoint") && !Object.hasOwn(rule, "secret"));
  assert((await page.getByTestId("cron-next").innerText()).includes(`UTC${browserTimezone}`));
  await page.reload({ waitUntil: "networkidle" });
  await until(
    () => ui.getByRole("button", { name: "Trial 定时规则", exact: true }).isEnabled(),
    "reloaded fixed timezone is clean",
  );
  assert.equal(await zone.inputValue(), browserTimezone);
  pass(
    "browser standalone editor: tabs, fixed-offset timezone select, cron help, DM Project workers without Chat picker, nextAt and no webhook credentials",
  );

  const apiDraft = {
    projectId: project.id,
    name: "API cron",
    instruction: "Reply briefly",
    enabled: true,
    expression: "0 0 29 2 *",
    timezone: "UTC",
    action: { kind: "group_agent", chatId: group.id, agentProfileId: beta.id },
  };
  const unauthenticated = await callResult("listCronRulesFn", { projectId: project.id }, "");
  assert.equal(unauthenticated.ok, false);
  const invalid = await callResult("createCronRuleFn", { ...apiDraft, expression: "0 * * * * *" });
  assert.equal(invalid.ok, false);
  const badZone = await callResult("createCronRuleFn", { ...apiDraft, timezone: "+14:01" });
  assert.equal(badZone.ok, false);
  const credential = await fetch(`${base}/api/webhooks/${rule.id}`, {
    method: "POST",
    headers: {
      authorization: "Bearer invalid",
      "content-type": "application/json",
      "Idempotency-Key": "cron-credential",
    },
    body: "{}",
  });
  assert.equal(credential.status, 401);
  assert.equal(
    (await callResult("trialWebhookFn", { ruleId: rule.id, eventId: "wrong-source", payload: {} }))
      .ok,
    false,
  );
  pass(
    "production session/parser/source-specific server boundaries reject invalid or webhook-shaped cron use",
  );

  fixture.arm("chatOwner", {
    expectedUserPrefix: "{",
    steps: [],
    reply: "CRON_TRIAL_REPLY",
    delayMs: 500,
  });
  let release;
  const barrier = new Promise((done) => {
    release = done;
  });
  let reached;
  const responsePending = new Promise((done) => {
    reached = done;
  });
  let handled;
  const routeHandled = new Promise((done) => {
    handled = done;
  });
  const trialRoute = `**/_serverFn/${ids.trialCronFn}`;
  await page.route(trialRoute, async (route) => {
    const response = await route.fetch();
    reached();
    await barrier;
    await route.fulfill({ response });
    handled();
  });
  try {
    await ui.getByRole("button", { name: "Trial 定时规则", exact: true }).click();
    await responsePending;
    assert.equal(await page.getByTestId("cron-settings").getAttribute("disabled"), "");
    assert(await ui.getByLabel("规则名称", { exact: true }).isDisabled());
    assert(await ui.getByRole("button", { name: "Trial 定时规则", exact: true }).isDisabled());
  } finally {
    release();
    await routeHandled;
    await page.unroute(trialRoute);
  }
  await until(
    () => db.prepare("SELECT id FROM message WHERE body='CRON_TRIAL_REPLY'").get(),
    "real Pi Trial reply",
  );
  await until(
    () => ui.getByRole("button", { name: "Trial 定时规则", exact: true }).isEnabled(),
    "trial response settled",
  );
  const firstHistory = await call("cronHistoryFn", { ruleId: rule.id });
  const trial = firstHistory.find((item) => item.mode === "trial");
  assert.equal(trial.decision, "accepted");
  assert.equal(trial.scheduledAt, null);
  assert.equal((await call("listCronRulesFn", { projectId: project.id }))[0].nextAt, rule.nextAt);
  pass(
    "real Trial uses Pi loopback model, leaves cursor unchanged, locks editor while response is pending",
  );

  fixture.arm("chatOwner", {
    expectedUserPrefix: "{",
    steps: [],
    reply: "CRON_SCHEDULE_REPLY",
    delayMs: 4000,
  });
  await ui.getByLabel("Cron 表达式").fill("* * * * *");
  await ui.getByRole("button", { name: "保存定时规则", exact: true }).click();
  rule = await until(async () => {
    const current = (await call("listCronRulesFn", { projectId: project.id }))[0];
    return current.expression === "* * * * *" && current;
  }, "minute schedule persisted");
  const expectedInstant = rule.nextAt;
  console.log(`WAIT wall-clock cron due ${expectedInstant}`);
  const live = await until(
    () =>
      db
        .prepare("SELECT * FROM webhook_trigger WHERE rule_id=? AND mode='live' AND event_id=?")
        .get(rule.id, expectedInstant),
    "real runtime wall-clock due admission",
    75000,
  );
  assert.equal(live.decision, "accepted");
  assert(Date.now() >= new Date(expectedInstant).getTime());
  const overlap = await call("trialCronFn", { ruleId: rule.id, eventId: "overlap-live" });
  assert.equal(overlap.decision, "skipped");
  assert.equal(overlap.reason, "rule_overlap");
  await until(
    () => db.prepare("SELECT id FROM message WHERE body='CRON_SCHEDULE_REPLY'").get(),
    "real scheduled Pi reply",
  );
  const liveHistory = (await call("cronHistoryFn", { ruleId: rule.id })).find(
    (item) => item.id === live.id,
  );
  assert.equal(liveHistory.scheduledAt, expectedInstant);
  assert.equal(liveHistory.runStatus, "completed");
  assert.equal(liveHistory.inputDisposition, "delivered");
  const sourceBefore = (await call("listMessagesFn", { chatId: dm.id })).messages.find(
    (message) => message.id === live.message_id,
  );
  assert.deepEqual(sourceBefore.mentions, []);
  assert.deepEqual(sourceBefore.skills, []);
  assert.equal(sourceBefore.senderKind, "automation");
  assert.deepEqual(sourceBefore.automationSource, {
    kind: "project_cron",
    triggerId: live.id,
    ruleId: rule.id,
    expression: "* * * * *",
    timezone: browserTimezone,
    instruction: "CRON_BROWSER @HookAlpha /skill:danger. Reply briefly.",
    scheduledAt: expectedInstant,
    mode: "live",
  });
  pass(
    "actual 1s production runtime scheduler fired at wall-clock minute, shared overlap skipped Trial, real Pi completed delivered Source input",
  );

  await ui.getByLabel("启用定时规则", { exact: true }).uncheck();
  await ui.getByLabel("指令", { exact: true }).fill("Edited instruction after receipt");
  await ui.getByRole("button", { name: "保存定时规则", exact: true }).click();
  rule = await until(async () => {
    const current = (await call("listCronRulesFn", { projectId: project.id }))[0];
    return (
      !current.enabled && current.instruction === "Edited instruction after receipt" && current
    );
  }, "disable+edit committed");
  assert.equal(rule.nextAt, null);
  assert.deepEqual(
    (await call("listMessagesFn", { chatId: dm.id })).messages.find((m) => m.id === live.message_id)
      .automationSource,
    sourceBefore.automationSource,
  );
  const disabled = await call("trialCronFn", { ruleId: rule.id, eventId: "disabled" });
  assert.equal(disabled.reason, "rule_disabled");
  const conflict = await callResult("updateCronRuleFn", {
    ...apiDraft,
    ruleId: rule.id,
    expectedRevision: 0,
  });
  assert.equal(conflict.ok, false);
  await until(
    () => ui.getByRole("button", { name: "保存定时规则", exact: true }).isEnabled(),
    "save response settled",
  );
  await ui.getByRole("button", { name: "刷新历史", exact: true }).click();
  await until(
    async () => (await ui.getByTestId("cron-history").innerText()).includes("rule_disabled"),
    "history current input/run facts",
  );
  assert(
    await ui.getByTestId("cron-history").getByRole("link", { name: /^Run / }).first().isVisible(),
  );
  await ui.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await ui.scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    false,
  );
  await page.screenshot({ path: join(directory, "mobile.png"), fullPage: true });
  await ui.getByTestId("cron-history").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, "mobile-history.png"), fullPage: true });
  pass(
    "settings history includes real Trial/Schedule, immutable snapshots, CAS edit, disabled nextAt and Chat/run links; desktop/mobile evidence",
  );

  await page.goto(`${base}/projects/${project.id}/chats/${dm.id}`);
  const source = page
    .locator('[data-sender-kind="automation"]')
    .filter({ hasText: "CRON_BROWSER" });
  await source.first().waitFor();
  assert((await source.first().innerText()).includes("Project cron"));
  assert((await source.first().innerText()).includes("Source"));
  assert.equal(
    await source
      .locator(
        '[data-testid="message-mention"],[data-testid="message-skill"],[data-testid="message-persona"],[data-testid="message-run-activity"]',
      )
      .count(),
    0,
  );
  assert((await page.getByTestId("message-list").innerText()).includes("CRON_SCHEDULE_REPLY"));
  await page.screenshot({ path: join(directory, "source-chat.png"), fullPage: true });
  pass(
    "Source Chat shows Project cron label and sealed text without Agent persona, mention/skill spans or runactivity fallback",
  );

  const ownerRule = await call("createCronRuleFn", {
    ...apiDraft,
    name: "Owner cron",
    action: { kind: "group_owner", chatId: group.id },
  });
  await call("setChatOwnerFn", {
    chatId: group.id,
    owner: { kind: "human", id: humanId },
    expectedRevision: group.governanceRevision,
  });
  assert.equal(
    (await call("trialCronFn", { ruleId: ownerRule.id, eventId: "human-owner" })).reason,
    "owner_is_not_agent",
  );
  const explicitRule = await call("createCronRuleFn", apiDraft);
  fixture.arm("chatMentioned", {
    expectedUserPrefix: "{",
    steps: [],
    reply: "CRON_EXPLICIT_HUMAN_OWNER_REPLY",
  });
  const explicit = await call("trialCronFn", {
    ruleId: explicitRule.id,
    eventId: "explicit-human-owner",
  });
  assert.equal(explicit.decision, "accepted");
  await until(
    () => db.prepare("SELECT id FROM message WHERE body='CRON_EXPLICIT_HUMAN_OWNER_REPLY'").get(),
    "explicit group Agent Pi reply under Human owner",
  );
  pass("owner Human skips only owner action; explicit Group Agent still uses actual Pi runner");
  const original = db.prepare("SELECT * FROM agent_run WHERE id=?").get(trial.runId);
  assert(original && typeof original.id === "string");
  const historicalRunId = `${original.id.slice(0, -1)}${original.id.endsWith("0") ? "1" : "0"}`;
  const historical = {
    ...original,
    id: historicalRunId,
    status: "failed",
    assistant_message_id: null,
    error_code: "fixture_historical_failure",
    error_message: "Historical run failed before producing a reply",
    stop_reason: null,
  };
  const columns = Object.keys(historical);
  const seed = new Database(db.name, { fileMustExist: true });
  try {
    seed.transaction(() => {
      seed
        .prepare(
          `INSERT INTO agent_run (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .run(...Object.values(historical));
      seed
        .prepare("UPDATE agent_run_input SET run_id=? WHERE message_id=?")
        .run(historicalRunId, trial.messageId);
    })();
  } finally {
    seed.close();
  }
  await verifyAutomationUnknownRoute({ page, base, project, kind: "cron" });
  await page.goto(`${base}/projects/${project.id}/settings?tab=cron`);
  const row = page.getByTestId("cron-list").locator(`[data-rule-id="${rule.id}"]`);
  assert((await row.innerText()).includes("停用"));
  assert((await row.innerText()).includes(browserTimezone));
  await row.getByRole("link").click();
  const historicalLink = ui.getByRole("link", { name: `Run ${historicalRunId}`, exact: true });
  await historicalLink.waitFor();
  await historicalLink.click();
  const targetId = decodeURIComponent(new URL(page.url()).hash.slice(1));
  assert(targetId, "historical Run link has an explicit destination");
  await until(
    () => page.locator(`[id="${targetId}"]`).count(),
    "historical terminal Run link resolves even without an assistant message",
    10000,
  );
  const selected = page.locator(`[id="${targetId}"]`);
  assert((await selected.innerText()).includes(historicalRunId));
  assert((await selected.innerText()).includes("Historical run failed before producing a reply"));
  const historicalRead = await call("getChatRunFn", { chatId: dm.id, runId: historicalRunId });
  assert.equal(historicalRead.id, historicalRunId);
  assert.equal(historicalRead.status, "failed");
  assert.equal(Object.hasOwn(historicalRead, "configSnapshot"), false);
  assert.equal(
    (await call("getChatRunStateFn", { chatId: dm.id })).latest.id === historicalRunId,
    false,
  );
  assert.equal(
    (await callResult("getChatRunFn", { chatId: group.id, runId: historicalRunId })).ok,
    false,
  );
  assert.equal(
    (await callResult("getChatRunFn", { chatId: dm.id, runId: historicalRunId }, "")).ok,
    false,
  );
  await page.screenshot({ path: join(directory, "historical-run.png"), fullPage: true });
  pass("historical failed Run without reply has a working link to its own status and error");
  await verifyFixedTimezones({ page, base, project, alpha, call, until, pass });
  fixture.assertHealthy();
  assert(fixture.metadata().requestCount >= 3);
  writeFileSync(
    join(directory, "cron-receipts.json"),
    JSON.stringify(
      {
        expectedInstant,
        rules: await call("listCronRulesFn", { projectId: project.id }),
        history: await call("cronHistoryFn", { ruleId: rule.id }),
        source: sourceBefore,
      },
      null,
      2,
    ),
  );
}
