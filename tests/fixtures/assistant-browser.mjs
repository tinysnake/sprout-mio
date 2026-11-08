import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
export async function verifyAssistantBrowser({
  page,
  db,
  fixture,
  project,
  alpha,
  dm,
  base,
  directory,
  call,
  callResult,
  until,
  pass,
}) {
  const helper = await call("createAgentProfileFn", {
    name: "NativeAssistant",
    purpose: "assistant",
    persona: "Only observe, propose, and request watch consent. Never execute work.",
    model: fixture.model("status"),
    effort: "off",
  });
  await call("addProjectMemberFn", { projectId: project.id, agentProfileId: helper.id });
  const source = (
    await call("createDirectChatFn", { projectId: project.id, agentProfileId: helper.id })
  ).chat;
  const assistantTools = [
    "sprout_status",
    "sprout_assistant_observe",
    "sprout_assistant_propose",
    "sprout_assistant_watch",
  ];
  fixture.arm("status", {
    expectedUserText: "Observe then propose concrete native work and ask to watch it",
    expectedTools: assistantTools,
    steps: [
      { name: "sprout_status", arguments: {} },
      {
        name: "sprout_assistant_observe",
        arguments: { targetProjectId: project.id, chatId: dm.id, offset: 0, limit: 20 },
      },
      {
        name: "sprout_assistant_propose",
        arguments: {
          target: {
            kind: "dm_agent",
            projectId: project.id,
            chatId: dm.id,
            agentProfileId: alpha.id,
          },
          body: "Native confirmed fixture work",
        },
      },
      { name: "sprout_assistant_watch", arguments: { targetProjectId: project.id, chatId: dm.id } },
    ],
    reply: "A concrete proposal and watch request are ready for Human confirmation.",
  });
  await page.goto(`${base}/projects/${project.id}/chats/${source.id}`, {
    waitUntil: "networkidle",
  });
  await call("sendMessageFn", {
    projectId: project.id,
    chatId: source.id,
    body: "Observe then propose concrete native work and ask to watch it",
  });
  const first = await until(
    () =>
      db.prepare("SELECT * FROM agent_run WHERE chat_id=? AND status='completed'").get(source.id),
    "assistant actual Pi observation/proposal turn",
  );
  const snapshot = JSON.parse(first.config_snapshot);
  assert.equal(snapshot.purpose, "assistant");
  assert.deepEqual(snapshot.tools, [...assistantTools].sort());
  assert.deepEqual(snapshot.registeredTools, [...assistantTools].sort());
  assert.equal(snapshot.resources.inheritHostResources, false);
  assert.deepEqual(snapshot.resources.skills, []);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM repo_provenance WHERE run_id=?").get(first.id).n,
    0,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM remote_execution WHERE run_id=?").get(first.id).n,
    0,
  );
  pass(
    "installed Pi assistant exposes only status+three assistant tools and prepares no checkout/execution",
  );
  const proposal = db
    .prepare("SELECT * FROM assistant_proposal WHERE assistant_chat_id=?")
    .get(source.id);
  assert(proposal);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM agent_run WHERE chat_id=?").get(dm.id).n,
    0,
    "proposing cannot wake worker",
  );
  await page.getByRole("button", { name: /确认持续关注/ }).click();
  await until(
    () =>
      db
        .prepare("SELECT * FROM assistant_watch WHERE assistant_chat_id=? AND revoked_at IS NULL")
        .get(source.id),
    "Human activates persistent watch",
  );
  fixture.arm("chatOwner", {
    expectedUserPrefix: "[Human-confirmed assistant proposal",
    steps: [],
    reply: "Native worker completed the concrete confirmed work.",
    delayMs: 1200,
  });
  await page.getByRole("button", { name: "确认并提交工作" }).click();
  const receipt = await call("assistantActionFn", {
    action: "confirm",
    chatId: source.id,
    proposalId: proposal.id,
  });
  assert.equal(
    receipt.messageId,
    db.prepare("SELECT work_message_id AS id FROM assistant_proposal WHERE id=?").get(proposal.id)
      .id,
  );
  const run = await until(
    () =>
      db
        .prepare(
          "SELECT r.* FROM agent_run r JOIN agent_run_input i ON i.run_id=r.id WHERE i.message_id=? AND r.status='completed'",
        )
        .get(receipt.messageId),
    "independent worker completes",
  );
  const event = await until(
    () =>
      db
        .prepare(
          "SELECT * FROM assistant_event WHERE assistant_chat_id=? AND event_key=? AND message_id IS NOT NULL",
        )
        .get(source.id, `${run.id}:terminal`),
    "completion native notification",
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM assistant_event WHERE assistant_chat_id=? AND event_key=?",
      )
      .get(source.id, `${run.id}:terminal`).n,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM assistant_interest WHERE assistant_chat_id=? AND run_id=?",
      )
      .get(source.id, run.id).n,
    2,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM agent_run WHERE chat_id=?").get(source.id).n,
    1,
    "observer does not auto-wake assistant",
  );
  const firstContext = db.prepare("SELECT * FROM turn_context WHERE run_id=?").get(first.id);
  assert(
    !firstContext.serialized_text.includes(event.message_id),
    "notification happened after original context capture",
  );
  const nativeIds = db
    .prepare(
      "SELECT id FROM message WHERE chat_id=? AND sender_kind='assistant_event' ORDER BY created_at,id",
    )
    .all(source.id)
    .map((row) => row.id);
  fixture.arm("status", {
    expectedUserText: "Read the confirmed work notification from your native context",
    expectedTools: assistantTools,
    expectedContextIds: nativeIds,
    steps: [{ name: "sprout_status", arguments: {} }],
    reply: "The native completion notification is present in my actual captured context.",
  });
  await call("sendMessageFn", {
    projectId: project.id,
    chatId: source.id,
    body: "Read the confirmed work notification from your native context",
  });
  const next = await until(
    () =>
      db
        .prepare("SELECT * FROM agent_run WHERE chat_id=? AND status='completed' AND id != ?")
        .get(source.id, first.id),
    "next actual assistant model turn consumes native context",
  );
  const context = db.prepare("SELECT * FROM turn_context WHERE run_id=?").get(next.id);
  assert.equal(context.delivery_state, "submitted");
  assert(context.submitted_at >= context.captured_at);
  assert(context.serialized_text.includes(event.message_id));
  assert.equal(
    db.prepare("SELECT serialized_text FROM turn_context WHERE run_id=?").get(first.id)
      .serialized_text,
    firstContext.serialized_text,
  );
  const denied = await callResult("assistantActionFn", { action: "panel", chatId: source.id }, "");
  assert.equal(denied.ok, false);
  pass(
    "Human single confirmation -> independent worker -> overlap-deduplicated native completion -> actual next Pi context with submitted receipt",
  );
  fixture.arm("status", {
    expectedUserText: "Propose one more exact input while the worker is already running",
    expectedTools: assistantTools,
    steps: [
      {
        name: "sprout_assistant_propose",
        arguments: {
          target: {
            kind: "dm_agent",
            projectId: project.id,
            chatId: dm.id,
            agentProfileId: alpha.id,
          },
          body: "Native confirmed steer fixture input",
        },
      },
    ],
    reply: "A second concrete input is ready for confirmation.",
  });
  await call("sendMessageFn", {
    projectId: project.id,
    chatId: source.id,
    body: "Propose one more exact input while the worker is already running",
  });
  const steerProposal = await until(
    () =>
      db
        .prepare("SELECT * FROM assistant_proposal WHERE assistant_chat_id=? AND body=?")
        .get(source.id, "Native confirmed steer fixture input"),
    "second actual proposal",
  );
  await until(
    () =>
      db
        .prepare("SELECT * FROM agent_run WHERE id=? AND status='completed'")
        .get(steerProposal.source_run_id),
    "proposal turn settled",
  );
  fixture.arm("chatOwner", {
    expectedUserPrefix: "Hold worker while Human confirms a steer",
    steps: [],
    reply: "The initial work step completed.",
    delayMs: 2500,
  });
  fixture.arm("chatOwner", {
    expectedUserPrefix: "[Human-confirmed assistant proposal",
    steps: [],
    reply: "The confirmed steer input was received in this same worker run.",
    queued: true,
  });
  await call("sendMessageFn", {
    projectId: project.id,
    chatId: dm.id,
    body: "Hold worker while Human confirms a steer",
  });
  const steeringRun = await until(
    () =>
      db
        .prepare(
          "SELECT r.* FROM agent_run r JOIN agent_run_input i ON i.run_id=r.id JOIN message m ON m.id=i.message_id WHERE r.chat_id=? AND r.status='running' AND i.disposition='delivered' AND m.body=?",
        )
        .get(dm.id, "Hold worker while Human confirms a steer"),
    "worker accepts original input",
  );
  const steerReceipt = await call("assistantActionFn", {
    action: "confirm",
    chatId: source.id,
    proposalId: steerProposal.id,
  });
  const steeringInput = await until(
    () =>
      db
        .prepare(
          "SELECT * FROM agent_run_input WHERE message_id=? AND disposition='delivered' AND admitted_at IS NOT NULL",
        )
        .get(steerReceipt.messageId),
    "real Pi steer admission and receipt",
  );
  assert.equal(steeringInput.run_id, steeringRun.id);
  const steered = await until(
    () =>
      db.prepare("SELECT * FROM agent_run WHERE id=? AND status='completed'").get(steeringRun.id),
    "same run consumes confirmed steer",
  );
  assert(
    db
      .prepare("SELECT body FROM message WHERE id=?")
      .get(steered.assistant_message_id)
      .body.includes("confirmed steer input"),
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM assistant_interest WHERE assistant_chat_id=? AND run_id=?",
      )
      .get(source.id, steered.id).n,
    2,
  );
  pass(
    "actual installed Pi handles Human-confirmed input as steer in the already running worker, with exact lineage and one admission",
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Assistant 工作与关注", { exact: true }).waitFor();
  await page.getByTestId("assistant-run-link").filter({ hasText: run.id }).waitFor();
  await page.screenshot({ path: join(directory, "assistant-desktop.png"), fullPage: true });
  await page.getByText("Assistant 工作与关注", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(directory, "assistant-desktop-controls.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText("Assistant 工作与关注", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, "assistant-mobile.png"), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("button", { name: "取消关注" }).click();
  await until(
    () =>
      db.prepare("SELECT revoked_at FROM assistant_watch WHERE assistant_chat_id=?").get(source.id)
        ?.revoked_at,
    "stop watch control",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const otherHelper = await call("createAgentProfileFn", {
    name: "OtherNativeAssistant",
    purpose: "assistant",
    model: fixture.model("status"),
    effort: "off",
  });
  await call("addProjectMemberFn", { projectId: project.id, agentProfileId: otherHelper.id });
  const otherSource = (
    await call("createDirectChatFn", { projectId: project.id, agentProfileId: otherHelper.id })
  ).chat;
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("assistant-panel").getByText(proposal.body, { exact: true }).waitFor();
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  let intercepted = false;
  const delayPanel = async (route) => {
    const body = route.request().postData() ?? "";
    if (intercepted || !body.includes(source.id) || !body.includes("panel")) {
      await route.continue();
      return;
    }
    intercepted = true;
    const response = await route.fetch();
    held.resolve();
    await release.promise;
    await route.fulfill({ response });
    delivered.resolve();
  };
  await page.route("**/_serverFn/**", delayPanel);
  try {
    await held.promise;
    await page.locator(`a[href$="/chats/${otherSource.id}"]`).first().click();
    await page.waitForURL(`**/chats/${otherSource.id}`);
    await page.getByTestId("chat-title").filter({ hasText: otherHelper.name }).waitFor();
    await page.waitForFunction(
      (text) =>
        !document.querySelector('[data-testid="assistant-panel"]')?.textContent?.includes(text),
      proposal.body,
    );
    release.resolve();
    await delivered.promise;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert(
      !(await page.getByTestId("assistant-panel").innerText()).includes(proposal.body),
      "late panel response from another DM must not expose its proposal in the current DM",
    );
  } finally {
    release.resolve();
    if (intercepted) await delivered.promise;
    await page.unroute("**/_serverFn/**", delayPanel);
  }
  await page.locator(`a[href$="/chats/${source.id}"]`).first().click();
  await page.waitForURL(`**/chats/${source.id}`);
  await page.getByTestId("assistant-run-link").filter({ hasText: run.id }).waitFor();
  pass("delayed assistant panel responses remain scoped to their original DM");
  const link = page.getByTestId("assistant-run-link").filter({ hasText: run.id });
  await link.click();
  await page.waitForURL(`**/chats/${dm.id}?run=${run.id}#selected-run-${run.id}`);
  await page.getByTestId("chat-title").filter({ hasText: "HookAlpha" }).waitFor();
  const selectedRun = page.getByTestId("selected-run");
  await selectedRun.waitFor();
  assert(
    (await selectedRun.innerText()).includes(run.id),
    "actual selected historical run must render after navigation",
  );
  await page.screenshot({ path: join(directory, "assistant-work-run.png"), fullPage: true });
  pass("native desktop/mobile watch controls and actual target Run link");
  writeFileSync(
    join(directory, "assistant-evidence.json"),
    JSON.stringify(
      {
        sourceChatId: source.id,
        proposalId: proposal.id,
        workMessageId: receipt.messageId,
        workerRunId: run.id,
        eventId: event.id,
        firstRunId: first.id,
        nextRunId: next.id,
        contentHash: context.content_hash,
        capturedAt: context.captured_at,
        submittedAt: context.submitted_at,
        assistantTools,
        steeringRunId: steered.id,
        steeringMessageId: steerReceipt.messageId,
      },
      null,
      2,
    ),
  );
}
