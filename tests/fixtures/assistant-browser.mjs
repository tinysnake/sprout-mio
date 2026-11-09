import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
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
            agentProfileId: alpha.id,
          },
          body: `Hi ${alpha.name}，这是 Human 的请求。\n\n请回复一句 hi。\n\n补充信息：Chat ID ${dm.id}，Project ID ${project.id}。`,
        },
      },
      {
        name: "sprout_assistant_watch",
        arguments: { targetProjectId: project.id, chatId: dm.id, intervalSeconds: 120 },
      },
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
  assert.equal(proposal.target_chat_id, dm.id, "Agent-only proposal resolves the canonical DM");
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
  assert.equal(
    db
      .prepare(
        "SELECT interval_seconds FROM assistant_watch WHERE assistant_chat_id=? AND revoked_at IS NULL",
      )
      .get(source.id).interval_seconds,
    120,
  );
  await page.getByTestId("assistant-watch-menu").click();
  await page
    .getByTestId("assistant-watch-list")
    .getByText("每 2 分钟汇报一次", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("通知间隔", { exact: true }).count(), 0);
  assert.equal(await page.getByTestId("assistant-watch-list").getByRole("combobox").count(), 0);
  await page.getByTestId("assistant-watch-menu").click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="assistant-watch-list"]') === null,
  );
  pass(
    "tool-requested per-watch interval survives Human activation, lives in the header watch menu, and global interval editor is absent",
  );
  assert.equal(
    await page.getByTestId("assistant-proposal-summary").first().innerText(),
    "请回复一句 hi。",
  );
  const placement = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="assistant-composer-panel"]');
    const history = document.querySelector('[data-testid="message-history"]');
    const composer = document.querySelector("textarea")?.closest("form");
    const top = panel?.getBoundingClientRect().top;
    if (history) history.scrollTop = 0;
    return {
      separate: !history?.contains(panel),
      top,
      after: panel?.getBoundingClientRect().top,
      bottom: panel?.getBoundingClientRect().bottom,
      composerTop: composer?.getBoundingClientRect().top,
    };
  });
  assert(placement.separate, "proposal controls are outside message scrolling");
  assert.equal(placement.top, placement.after, "scrolling history leaves controls in place");
  assert(placement.bottom <= placement.composerTop, "proposal controls sit above composer");
  await page.screenshot({ path: join(directory, "assistant-pending-desktop.png"), fullPage: true });
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="assistant-composer-panel"]') !== null &&
      document.querySelector("textarea") !== null,
  );
  const mobilePlacement = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="assistant-composer-panel"]');
    const composer = document.querySelector("textarea");
    return {
      panelBottom: panel ? panel.getBoundingClientRect().bottom : null,
      composerTop: composer ? composer.getBoundingClientRect().top : null,
      composerBottom: composer ? composer.getBoundingClientRect().bottom : null,
    };
  });
  assert(
    mobilePlacement.panelBottom !== null && mobilePlacement.composerTop !== null,
    "mobile pending panel and composer are both present",
  );
  assert(
    mobilePlacement.panelBottom <= mobilePlacement.composerTop,
    "proposal controls sit above composer on mobile",
  );
  assert(
    mobilePlacement.composerBottom !== null && mobilePlacement.composerBottom < 844,
    "pending proposal leaves mobile composer visible",
  );
  await page.screenshot({ path: join(directory, "assistant-pending-mobile.png"), fullPage: true });
  await page.setViewportSize(desktopViewport);
  fixture.arm("chatOwner", {
    expectedUserPrefix: "[Human-confirmed assistant proposal",
    steps: [],
    reply: "Native worker completed the concrete confirmed work.",
    delayMs: 1200,
  });
  await page.getByRole("button", { name: "确认并提交工作" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="assistant-composer-panel"]') === null,
  );
  assert.equal(
    await page.getByTestId("assistant-composer-panel").count(),
    0,
    "confirming the only pending proposal removes the composer-adjacent panel entirely",
  );
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
  fixture.arm("status", {
    expectedUserPrefix: "Keep the assistant talking while watched work finishes",
    expectedTools: assistantTools,
    steps: [],
    reply: "The assistant stayed available while the worker finished.",
    delayMs: 5000,
  });
  await call("sendMessageFn", {
    projectId: project.id,
    chatId: source.id,
    body: "Keep the assistant talking while watched work finishes",
  });
  const liveAssistant = await until(
    () =>
      db
        .prepare(
          "SELECT r.* FROM agent_run r JOIN turn_context c ON c.run_id=r.id WHERE r.chat_id=? AND r.status='running' AND c.submitted_at IS NOT NULL",
        )
        .get(source.id),
    "assistant initial context submitted while streaming",
  );
  const frozenContext = db
    .prepare("SELECT serialized_text,content_hash FROM turn_context WHERE run_id=?")
    .get(liveAssistant.id);
  fixture.arm("chatOwner", {
    expectedUserPrefix: "Finish watched work during the assistant turn",
    steps: [],
    reply: "Fresh watched work finished during the assistant turn.",
  });
  await call("sendMessageFn", {
    projectId: project.id,
    chatId: dm.id,
    body: "Finish watched work during the assistant turn",
  });
  const freshFact = await until(
    () =>
      db
        .prepare(
          "SELECT e.* FROM assistant_event e JOIN agent_run r ON r.id=json_extract(e.fact,'$.runId') JOIN message m ON m.id=r.assistant_message_id WHERE e.assistant_chat_id=? AND json_extract(e.fact,'$.kind')='completed' AND m.body LIKE '%Fresh watched work finished%' AND e.message_id IS NOT NULL",
        )
        .get(source.id),
    "fresh native completion during active assistant run",
  );
  assert(
    !frozenContext.serialized_text.includes(freshFact.id),
    "new fact was absent from the immutable initial context",
  );
  fixture.arm("status", {
    expectedUserPrefix: '{"channel":"sprout_assistant_native"',
    expectedContextIds: [freshFact.id, freshFact.message_id],
    expectedTools: assistantTools,
    steps: [],
    reply: "The new native fact was included in this assistant steer.",
    queued: true,
  });
  const liveHumanInput = await call("sendMessageFn", {
    projectId: project.id,
    chatId: source.id,
    body: "Read the newly completed watched work now",
  });
  const liveSteerInput = await until(
    () =>
      db
        .prepare("SELECT * FROM agent_run_input WHERE message_id=? AND disposition='delivered'")
        .get(liveHumanInput.id),
    "assistant Human steer acknowledged",
  );
  assert.equal(
    liveSteerInput.run_id,
    liveAssistant.id,
    "Human steer stays in the active assistant run",
  );
  assert(
    liveSteerInput.assistant_context,
    "assistant Human steer must persist its fresh native context",
  );
  const steerContext = JSON.parse(liveSteerInput.assistant_context);
  assert(steerContext.serializedText.includes(freshFact.id));
  assert(steerContext.serializedText.includes(freshFact.message_id));
  assert(
    liveSteerInput.assistant_context_submitted_at,
    "fresh context has its own matching runner acknowledgement",
  );
  assert.deepEqual(
    db
      .prepare("SELECT serialized_text,content_hash FROM turn_context WHERE run_id=?")
      .get(liveAssistant.id),
    frozenContext,
    "initial context stays immutable",
  );
  const liveSteered = await until(
    () =>
      db.prepare("SELECT * FROM agent_run WHERE id=? AND status='completed'").get(liveAssistant.id),
    "actual model consumes fresh assistant steer context",
  );
  assert(
    db
      .prepare("SELECT body FROM message WHERE id=?")
      .get(liveSteered.assistant_message_id)
      .body.includes("new native fact"),
  );
  pass(
    "active assistant Human steer carries newly arrived native facts into actual model context with a per-input receipt and immutable initial snapshot",
  );
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(
    await page.getByTestId("assistant-composer-panel").count(),
    0,
    "resolved proposal and handled watch decision leave no placeholder above the composer",
  );
  assert.equal(
    await page.getByText("Assistant 工作与关注", { exact: true }).count(),
    0,
    "history cards are removed from the composer area instead of collapsed",
  );
  await page.locator(`[data-testid="assistant-run-link"][href*="${run.id}"]`).waitFor();
  await page.getByTestId("assistant-watch-menu").waitFor();
  await page.screenshot({ path: join(directory, "assistant-desktop.png"), fullPage: true });
  await page.getByTestId("assistant-watch-menu").click();
  await page.getByTestId("assistant-watch-list").waitFor();
  await page.screenshot({
    path: join(directory, "assistant-desktop-controls.png"),
    fullPage: true,
  });
  await page.getByTestId("chat-title").click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="assistant-watch-list"]') === null,
  );
  await page.getByTestId("assistant-watch-menu").click();
  await page.getByTestId("assistant-watch-list").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="assistant-watch-list"]') === null,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("assistant-watch-menu").click();
  await page.getByTestId("assistant-watch-list").waitFor();
  await page.screenshot({ path: join(directory, "assistant-mobile.png"), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByTestId("assistant-watch-cancel").first().click();
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
  assert.equal(
    await page.getByTestId("assistant-watch-menu").count(),
    0,
    "cancelled watch leaves no header entry",
  );
  assert.equal(
    await page.getByRole("button", { name: /确认持续关注/ }).count(),
    0,
    "cancelled watch must not revive its old confirmation request",
  );
  assert.equal(
    await page.getByTestId("assistant-composer-panel").count(),
    0,
    "resolved proposals stay out of the composer area after a reload",
  );
  await page.locator(`[data-testid="assistant-run-link"][href*="${run.id}"]`).waitFor();
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
      () => document.querySelector('[data-testid="assistant-composer-panel"]') === null,
      undefined,
      { timeout: 5000 },
    );
    release.resolve();
    await delivered.promise;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(
      await page.getByTestId("assistant-composer-panel").count(),
      0,
      "late panel response from another DM must not expose its pending items in the current DM",
    );
  } finally {
    release.resolve();
    if (intercepted) await delivered.promise;
    await page.unroute("**/_serverFn/**", delayPanel);
  }
  await page.locator(`a[href$="/chats/${source.id}"]`).first().click();
  await page.waitForURL(`**/chats/${source.id}`);
  await page.locator(`[data-testid="assistant-run-link"][href*="${run.id}"]`).waitFor();
  pass("delayed assistant panel responses remain scoped to their original DM");
  // 传进来的 db 是只读句柄；下面两个断言需要直接落库，另开一个可写连接指向同一个 fixture 私有库。
  const writable = new Database(join(directory, "private.sqlite"));
  writable.pragma("busy_timeout = 5000");
  // 关注对象名必须来自频道的展示名。公共频道没有 title，也不能回落到成员名。
  // 期望值等于 contracts 里的 PUBLIC_CHANNEL_DISPLAY_TITLE；此处不导入 TS 以保持纯 .mjs。
  const publicChannel = db
    .prepare("SELECT id FROM chat WHERE project_id=? AND kind='public_channel'")
    .get(project.id);
  assert(publicChannel, "project has a public channel");
  writable
    .prepare(
      "INSERT INTO assistant_watch (id,assistant_chat_id,target_project_id,target_chat_id,consented_by,interval_seconds,consented_at) VALUES (?,?,?,?,?,?,?)",
    ).run(
    "watch-public-fixture",
    source.id,
    project.id,
    publicChannel.id,
    proposal.human_id,
    60,
    Date.now(),
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("assistant-watch-menu").click();
  await page
    .getByTestId("assistant-watch-list")
    .getByText("公共频道（Project 范围）", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByTestId("assistant-watch-list").getByText("Amenda", { exact: true }).count(),
    0,
    "a titleless public channel watch must not fall back to a member name",
  );
  await page.keyboard.press("Escape");
  pass("public channel watch shows the channel display name, not a member name");
  // 取消后重新发起：新的 watch 请求（新的决策 id）必须仍可确认，说明 UI 没有把请求永久压住。
  writable
    .prepare(
      "INSERT INTO assistant_event (id,assistant_chat_id,event_key,fact,created_at,attempts) VALUES (?,?,?,?,?,0)",
    ).run(
    "event-watch-reissue-fixture",
    source.id,
    "watch-reissue-fixture",
    JSON.stringify({
      kind: "decision",
      targetProjectId: project.id,
      targetChatId: dm.id,
      body: "重新请求关注这个对话。",
      sampledAt: new Date().toISOString(),
      watchIntent: true,
      intervalSeconds: 300,
    }),
    Date.now(),
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: /确认持续关注/ }).click();
  await until(
    () =>
      db
        .prepare(
          "SELECT * FROM assistant_watch WHERE assistant_chat_id=? AND target_chat_id=? AND revoked_at IS NULL",
        )
        .get(source.id, dm.id),
    "re-issued watch request can be confirmed",
  );
  pass("a freshly issued watch request still confirms after an earlier cancellation");
  writable.close();
  const link = page.locator(`[data-testid="assistant-run-link"][href*="${run.id}"]`);
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
