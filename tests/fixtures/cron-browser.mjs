import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

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
  const ui = page.getByTestId("cron-settings");
  await ui.waitFor();
  await until(() => ui.getByLabel("规则名称", { exact: true }).isEnabled(), "cron editor ready");
  await ui.getByLabel("规则名称", { exact: true }).fill("Browser cron");
  await ui.getByLabel("Cron 表达式").fill("0 0 29 2 *");
  await ui.getByLabel("时区（IANA）").fill("Asia/Shanghai");
  await ui
    .getByLabel("指令", { exact: true })
    .fill("CRON_BROWSER @HookAlpha /skill:danger. Reply briefly.");
  await ui.getByLabel("动作", { exact: true }).selectOption("dm_agent");
  await ui.getByLabel("目标 Chat", { exact: true }).selectOption(dm.id);
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
  assert(!options.includes(beta.name) && !options.includes(foreign.name));
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
  assert.equal(rule.timezone, "Asia/Shanghai");
  assert(rule.nextAt && !Object.hasOwn(rule, "endpoint") && !Object.hasOwn(rule, "secret"));
  assert((await page.getByTestId("cron-next").innerText()).includes("Asia/Shanghai"));
  pass(
    "browser native editor: explicit timezone/nextAt, effective Project+Chat Agent filter, no webhook credentials",
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
  const badZone = await callResult("createCronRuleFn", { ...apiDraft, timezone: "+08:00" });
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
    assert.equal(await ui.getAttribute("disabled"), "");
    assert(await ui.getByLabel("规则名称", { exact: true }).isDisabled());
    assert(await ui.getByRole("button", { name: "新建定时规则", exact: true }).isDisabled());
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
    expression: "* * * * *",
    timezone: "Asia/Shanghai",
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
