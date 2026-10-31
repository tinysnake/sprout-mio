import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  chatInspectorPath,
  createProject,
  openProjectInfoHub,
  readProjectFacts,
  waitForChats,
} from "./ui-navigation.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3145";
const directory = resolve(process.env.ACCEPTANCE_DIRECTORY ?? ".verify/k-acceptance");
const screenshots = resolve(process.env.SPROUT_UI_EVIDENCE_DIR ?? ".verify/k-acceptance/evidence");
const mode = process.argv[2] ?? "before";
assert(["before", "after", "host-disabled"].includes(mode));
mkdirSync(directory, { recursive: true });
mkdirSync(screenshots, { recursive: true });
const results = [];
const errors = [];
const ids = JSON.parse(readFileSync(join(directory, "server-functions.json"), "utf8"));
const startRequire = createRequire(import.meta.resolve("@tanstack/react-start"));
const clientRequire = createRequire(
  startRequire.resolve("@tanstack/start-client-core/package.json"),
);
const { fromCrossJSON } = clientRequire("seroval");
const browser = await chromium.launch();

function save(name, value) {
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n");
}
async function check(name, page, action) {
  try {
    const detail = await action();
    results.push({ name, passed: true, detail });
    console.log(`PASS ${name} ${JSON.stringify(detail ?? {})}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack ?? String(error) });
    console.log(`FAIL ${name} ${error.stack ?? error}`);
    await page
      ?.screenshot({ path: join(screenshots, `p2-k-fail-${name}.png`), fullPage: true })
      .catch(() => {});
  }
  save(`browser-${mode}.json`, results);
}
async function newPage(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(20000);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push({ url: page.url(), message: message.text() });
  });
  page.on("pageerror", (error) => errors.push({ url: page.url(), message: String(error) }));
  return page;
}
const test = (page, id) => page.getByTestId(id);
async function goto(page, path) {
  const response = await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  assert.equal(response.status(), 200, `deep link ${path} HTTP status`);
}
async function shot(page, name) {
  await page.screenshot({ path: join(screenshots, `p2-k-${name}.png`), fullPage: true });
}
async function sameText(page, id, expected) {
  await test(page, id).waitFor();
  assert.equal(await test(page, id).textContent(), expected, id);
}
async function sameInput(page, id, expected) {
  await test(page, id).waitFor();
  assert.equal(await test(page, id).inputValue(), expected, id);
}
// 宿主状态的文案来自 src/components/info-hub/run-facts.tsx：`活动 run` 标题与宿主状态同排给出。
const HOST_ENABLED = "宿主已启用";
const HOST_DISABLED = "宿主未启用";
// 期望值来自服务进程真实的 SPROUT_PI_ENABLED（脚本通过 EXPECTED_HOST_ENABLED 传入），
// 页面只要与之不一致就是缺陷，两个取值都不许被写死成唯一正确。
const EXPECTED_HOST_STATE =
  process.env.EXPECTED_HOST_ENABLED === "false" ? HOST_DISABLED : HOST_ENABLED;
// Chat 运行状态行的标签来自 src/components/chat/run-status.tsx 的 RUN_STATUS_LABELS（含无 run 时的「尚未运行」）。
const RUN_STATUS_LABELS = /^(尚未运行|排队中|运行中|已完成|失败|已停止|已中断)$/;
const flat = (text) => text.replace(/\s+/g, " ").trim();
// 消息项自带 data-sender-kind 与正文：按既有字段区分人类与 Agent，不靠正文内容猜。
async function messageItems(page) {
  // 新 Chat 可能还没有消息：等消息列表或空态出现，再读现有条目（可能为空）。
  await page
    .locator('[data-testid="message-list"], [data-testid="messages-empty"]')
    .first()
    .waitFor();
  const items = await test(page, "message-item").evaluateAll((nodes) =>
    nodes.map((node) => ({
      senderKind: node.dataset.senderKind,
      body: node.querySelector('[data-testid="message-body"]')?.textContent ?? null,
    })),
  );
  assert(
    items.every((item) => typeof item.body === "string" && item.body.length > 0),
    `每条消息都必须有正文 ${JSON.stringify(items)}`,
  );
  return items;
}
function humanBodies(items) {
  return items.filter((item) => item.senderKind === "human").map((item) => item.body);
}
async function agentBodies(page) {
  return (await messageItems(page))
    .filter((item) => item.senderKind === "agent")
    .map((item) => item.body);
}
/**
 * 人类发言必须以同样的正文、同样的顺序出现，且不存在第三个人类发言。
 * Agent 的真实回执是 run 追加的事实，条数随宿主执行增长，因此只断言人类发言的投影，
 * 不要求整张列表只有两条，也不允许用「包含某子串」代替逐条比对。
 */
async function assertHumanMessages(page, expected) {
  const items = await messageItems(page);
  assert(
    items.every((item) => item.senderKind === "human" || item.senderKind === "agent"),
    `未知的发送者种类 ${JSON.stringify(items.map((item) => item.senderKind))}`,
  );
  assert.deepEqual(
    humanBodies(items),
    expected,
    "人类发言的正文与顺序必须逐条一致，且不存在第三个人类发言",
  );
  return { total: items.length, human: expected.length, agent: items.length - expected.length };
}
/**
 * 注入事实必须与同一面板上的持久化收据一致（文案与状态均来自 src/components/info-hub/run-facts.tsx）：
 * 只有 submitted 收据能把上下文读作已注入，prepared/failed/没有快照都只能读作未注入。
 */
async function assertTurnPromptInjectionHonest(page) {
  const injection = await test(page, "info-turn-prompt-injection").textContent();
  const delivered =
    (await test(page, "info-turn-delivery-state").count()) > 0
      ? await test(page, "info-turn-delivery-state").getAttribute("data-state")
      : null;
  if (delivered === "submitted") {
    assert.equal(
      injection,
      "已注入；本次上下文已跨过 SDK 提交边界，收据只确认提交，不表示模型已理解。",
      "submitted 收据必须读作已注入",
    );
    assert.notEqual(await test(page, "info-turn-submitted-at").textContent(), "尚无提交收据");
  } else {
    assert.equal(
      injection,
      "注入模型 prompt：否 · 本次上下文尚无提交收据。",
      `${delivered ?? "没有快照"} 时只能读作未注入`,
    );
  }
  return { delivered, injection };
}
async function assertHostState(page, runFacts, expected) {
  await test(page, `${runFacts}-host-status`).waitFor();
  assert.equal(
    await test(page, `${runFacts}-host-status`).textContent(),
    expected,
    `${runFacts}-host-status`,
  );
  const heading = flat(await test(page, runFacts).innerText());
  assert.match(
    heading,
    new RegExp(`^活动 run\\s*${expected}`),
    `${runFacts} 必须把「活动 run」标题与宿主状态一起给出`,
  );
  return { runFacts, hostStatus: expected, heading };
}
/**
 * Info Hub 的消息数必须等于渲染出的消息条数。回执由 run 追加，读取会撞上中间态，
 * 所以最多等两秒收敛；事实与渲染真正不一致时永远收敛不了，照样变红。
 */
async function assertMessageCountMatchesRendered(page) {
  let last = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    last = {
      fact: Number(await test(page, "info-message-count").textContent()),
      rendered: await test(page, "message-item").count(),
    };
    if (last.fact === last.rendered) return last;
    await page.waitForTimeout(100);
  }
  assert.fail(`Info Hub 消息数 ${last.fact} 与渲染的 ${last.rendered} 条消息不一致`);
}
async function registerProject(page, role) {
  await goto(page, "/login");
  await page.getByTestId("register-tab").click();
  await page.locator('input[name="name"]').fill(`P2-K 用户 ${role}`);
  await page
    .locator('input[name="email"]')
    .fill(`k-${role}-${randomBytes(8).toString("hex")}@example.test`);
  await page.locator('input[name="password"]').fill(randomBytes(24).toString("base64url"));
  await page.locator('button[type="submit"]').click();
  // 注册播种的 Project 让 `/` 分发到它的 Chats；验收对象是随后真实创建的那个 Project。
  await waitForChats(page);
  const name = `P2-K Project ${role}`;
  const project = await createProject(page, { name, description: `独立验收 ${role}` });
  await sameText(page, "project-selector", name);
  return { name, id: project.id, path: project.path };
}
async function config(page) {
  return {
    gitRemote: await test(page, "config-git-remote").inputValue(),
    defaultBranch: await test(page, "config-default-branch").inputValue(),
    workDirectory: await test(page, "config-work-directory").inputValue(),
  };
}
async function chat(page) {
  await test(page, "chat-pane").waitFor();
  // 身份事实现在只在 inspector 里展示：打开 `?info=1` 后从 Info Hub 读同一份数据。
  if (
    !(await test(page, "info-chat-instance-id")
      .isVisible()
      .catch(() => false))
  ) {
    await test(page, "toggle-inspector").click();
  }
  await test(page, "info-chat-instance-id").waitFor();
  return {
    chatId: await test(page, "inspector-copy-chat-id").getAttribute("data-chat-id"),
    instanceId: await test(page, "inspector-instance-id").textContent(),
    messages: humanBodies(await messageItems(page)),
    persona: await test(page, "inspector-agent-persona").textContent(),
  };
}
function cross(value, state) {
  if (typeof value === "string") return { t: 1, s: value };
  const i = state.next++;
  const k = Object.keys(value);
  return { t: 10, i, p: { k, v: k.map((key) => cross(value[key], state)) }, o: 0 };
}
async function call(context, name, input, label, method = "POST") {
  assert(ids[name], `built server function ${name} missing`);
  const response = await context.request.fetch(`${base}/_serverFn/${ids[name]}`, {
    method,
    headers: {
      Origin: base,
      "content-type": "application/json",
      "x-tsr-serverfn": "true",
      accept: "application/json",
    },
    ...(method === "POST"
      ? { data: JSON.stringify({ t: cross({ data: input }, { next: 0 }), f: 127, m: [] }) }
      : {}),
    timeout: 20000,
  });
  const body = await response.text();
  writeFileSync(join(directory, `${label}.body`), body);
  save(`${label}.headers.json`, { status: response.status(), headers: response.headers() });
  assert.equal(response.status(), 200, body);
  const { result: value } = fromCrossJSON(JSON.parse(body), { refs: new Map() });
  assert.equal(value.requestId, response.headers()["x-sprout-request-id"]);
  assert.match(value.requestId, /^req_[0-9a-f-]{36}$/);
  return { value, body };
}
function noLeaks(body, tokens) {
  const leaked = tokens.filter((token) => body.includes(token));
  assert.deepEqual(leaked, [], `isolated data leaked ${JSON.stringify(leaked)}`);
  return leaked;
}
async function unavailable(page, target, expectedHumanMessages) {
  // Project Info Hub 在 Settings 的折叠区，只有该目标承载项目面板与 run / Machine 视角。
  if (target.key === "settings") await openProjectInfoHub(page);
  let summary = null;
  const body = await page.locator("body").innerText();
  assert(!/0 个活动 run|无活动 run|无 Machine/.test(body));
  if (target.key === "settings") {
    // P4b 之后租约区投影真实事实：这里没有租约，渲染明确空态；管理动作改在 Machine 详情页，
    // Project settings 只给摘要与可跳转入口。原断言保护的真实集合、空值文案与宿主状态全部保留。
    await assertHostState(page, "info-hub-project-runs", EXPECTED_HOST_STATE);
    await test(page, "info-hub-project-runs-active").waitFor();
    await test(page, "info-hub-leases").waitFor();
    await test(page, "info-hub-leases-empty").waitFor();
    assert.match(await test(page, "info-hub-leases-empty").textContent(), /还没有租约记录/);
    assert.equal(
      await test(page, "info-hub-leases-mutation").count(),
      0,
      "project settings 不再渲染租约表单",
    );
    assert.equal(await test(page, "info-hub-leases-notice-badge").count(), 0);
    const infoHubBody = await test(page, "info-hub-project-machines").innerText();
    assert.doesNotMatch(infoHubBody, /未实现|租约尚未实现/);
    assert.match(
      await test(page, "info-hub-leases-dense-note").textContent(),
      /在对应 Machine 详情的租约区块进行/,
    );
  }
  if (target.key === "chat") {
    await assertHostState(page, "info-chat-runs", EXPECTED_HOST_STATE);
    // run 事实与轮初快照是两件事：快照是否存在由交付状态决定，注入文案必须与之一致。
    await assertTurnPromptInjectionHonest(page);
    await test(page, "pi-host-status").waitFor();
    if (EXPECTED_HOST_STATE === HOST_ENABLED) {
      // 宿主已启用：运行状态行给出真实 run 标签，不再声称「宿主未启用」。
      assert.match(
        (await test(page, "pi-host-status").textContent()) ?? "",
        RUN_STATUS_LABELS,
        "pi-host-status",
      );
      assert.match(flat(await test(page, "run-status").innerText()), /^分身运行状态：/);
    } else {
      await sameText(page, "pi-host-status", HOST_DISABLED);
      assert.match(flat(await test(page, "run-status").innerText()), /^分身运行状态：宿主未启用/);
    }
    summary = await assertHumanMessages(page, expectedHumanMessages);
  }
  return {
    path: target.path,
    messages: summary,
    P3: target.key === "settings",
    P4: target.key === "settings",
  };
}
async function before() {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const page = await newPage(contextA);
  const other = await newPage(contextB);
  const project = await registerProject(page, "A");
  const own = await registerProject(other, "B");
  await check("two_authenticated_contexts_two_projects", page, async () => {
    assert.notEqual(project.id, own.id);
    return { project, own };
  });
  await goto(page, "/agents");
  await test(page, "new-agent-trigger").click();
  const agentName = "P2-K Agent A";
  const initialPersona = "谨慎记录身份的验收员";
  const persona = "编辑后的人设，保留身份与历史。";
  await test(page, "agent-name-input").fill(agentName);
  await test(page, "agent-persona-input").fill(initialPersona);
  await test(page, "agent-submit").click();
  await test(page, "agent-item-name").getByText(agentName, { exact: true }).click();
  await test(page, "agent-detail-id").waitFor();
  const agentProfileId = await test(page, "agent-detail-id").textContent();
  await goto(page, `${project.path}/members`);
  await test(page, "add-member-trigger").click();
  await test(page, "add-member-select").selectOption({ label: agentName });
  await test(page, "add-member-submit").click();
  await sameText(page, "member-item-name", agentName);
  await goto(page, `${project.path}/chats`);
  await test(page, "dm-start").click();
  await test(page, "chat-pane").waitFor();
  const chatPath = new URL(page.url()).pathname;
  const original = await chat(page);
  const messages = ["第一条独立验收消息。", "第二条消息，字面量与顺序都必须保留。"];
  for (let index = 0; index < messages.length; index++) {
    await test(page, "message-input").fill(messages[index]);
    await test(page, "message-send").click();
    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-testid="message-item"]').length === count,
      index + 1,
    );
  }
  await goto(page, `/agents/${agentProfileId}`);
  await test(page, "agent-edit-persona").fill(persona);
  await test(page, "agent-edit-save").click();
  await test(page, "agent-edit-saved").waitFor();
  const configuration = {
    gitRemote: "https://example.test/acceptance/a.git",
    defaultBranch: "acceptance-main",
    workDirectory: "workspaces/acceptance-a",
  };
  await goto(page, `${project.path}/settings`);
  await test(page, "config-git-remote").fill(configuration.gitRemote);
  await test(page, "config-default-branch").fill(configuration.defaultBranch);
  await test(page, "config-work-directory").fill(configuration.workDirectory);
  await test(page, "config-save").click();
  await test(page, "config-saved").waitFor();
  await page.reload({ waitUntil: "networkidle" });
  const observedConfig = await config(page);
  await goto(page, chatPath);
  const observed = await chat(page);
  const snapshot = { ...observed, ...observedConfig };
  save("before.json", snapshot);
  const session = await (await contextA.request.get(`${base}/api/auth/get-session`)).json();
  const messageIds = await test(page, "message-item").evaluateAll((nodes) =>
    nodes.map((node) => node.dataset.messageId),
  );
  const tokens = [
    project.id,
    project.name,
    agentProfileId,
    agentName,
    observed.chatId,
    observed.instanceId,
    session.user.id,
    session.user.name,
    ...messageIds,
    ...messages,
    persona,
    ...Object.values(configuration),
  ];
  assert(tokens.every((token) => typeof token === "string" && token.length > 0));
  save("state.json", {
    project,
    own,
    agentProfileId,
    agentName,
    chatPath,
    tokens,
    storageA: await contextA.storageState(),
    storageB: await contextB.storageState(),
  });
  await check("profile_edit_and_configuration_keep_identity_history", page, async () => {
    assert.deepEqual(snapshot, {
      chatId: original.chatId,
      instanceId: original.instanceId,
      messages,
      persona,
      ...configuration,
    });
    await shot(page, "before-chat");
    return snapshot;
  });
  await check("repeat_DM_keeps_chat_and_instance", page, async () => {
    await goto(page, `${project.path}/chats`);
    await test(page, "dm-start").click();
    assert.deepEqual(await chat(page), observed);
    return { chatId: observed.chatId, instanceId: observed.instanceId };
  });
  await check("project_root_redirects_to_chats", page, async () => {
    await goto(page, project.path);
    await page.waitForURL((url) => url.pathname === `${project.path}/chats`, { timeout: 20000 });
    await test(page, "chats-title").waitFor();
    return { entered: project.path, landed: new URL(page.url()).pathname };
  });
  const targets = [
    {
      key: "project",
      path: `${project.path}/chats`,
      assert: async () => {
        await test(page, "chats-title").waitFor();
      },
    },
    {
      key: "settings",
      path: `${project.path}/settings`,
      assert: async () => {
        await test(page, "config-git-remote").waitFor();
        assert.deepEqual(await config(page), configuration);
        // Project 基本事实已并入 Settings，Project Info Hub 面板也在这里的折叠区。
        const facts = await readProjectFacts(page);
        assert((facts.id ?? "").includes(project.id), `settings must show ${project.id}`);
        assert.equal(facts.name, project.name);
        await openProjectInfoHub(page);
        await sameText(page, "info-agent-name", agentName);
        assert.equal(await test(page, "info-agent-dm-link").getAttribute("href"), chatPath);
      },
    },
    {
      key: "members",
      path: `${project.path}/members`,
      assert: () => sameText(page, "member-item-name", agentName),
    },
    {
      key: "chats",
      path: `${project.path}/chats`,
      assert: async () => {
        await test(page, "chat-item").first().waitFor();
        const listed = await test(page, "chat-item").evaluateAll((nodes) =>
          nodes.map((node) => node.dataset.chatId),
        );
        // Project 出生即带唯一公共频道（I-P5a 频道单元）：列表恒为「最新更新的 DM + 频道」。
        assert.equal(listed.length, 2);
        assert.equal(listed[0], observed.chatId);
      },
    },
    {
      key: "chat",
      // Chat 视角的 Info Hub 在 inspector 里，由 `?info=1` 恢复后才渲染。
      entry: chatInspectorPath(chatPath),
      path: chatPath,
      assert: async () => {
        assert.deepEqual(await chat(page), observed);
        await sameText(page, "info-chat-instance-id", observed.instanceId);
        await assertHumanMessages(page, messages);
        await assertMessageCountMatchesRendered(page);
        assert.deepEqual(
          await test(page, "info-member-item").evaluateAll((nodes) =>
            nodes.map((node) => node.dataset.memberKind),
          ),
          ["human", "agent"],
        );
      },
    },
    {
      key: "agents",
      path: "/agents",
      assert: async () => {
        // 注册已播种一个默认 Agent profile，列表不止一个，按名称定位本次新建的那一个。
        await page.getByTestId("agent-item-name").getByText(agentName, { exact: true }).waitFor();
        const ids = await test(page, "agent-item").evaluateAll((nodes) =>
          nodes.map((node) => node.dataset.agentProfileId),
        );
        assert(ids.includes(agentProfileId), `agents list must include ${agentProfileId}`);
      },
    },
    {
      key: "agent",
      path: `/agents/${agentProfileId}`,
      assert: async () => {
        await sameText(page, "agent-detail-id", agentProfileId);
        await sameInput(page, "agent-edit-persona", persona);
      },
    },
  ];
  async function targetMatches(target) {
    await page.waitForURL((url) => url.pathname === target.path, { timeout: 20000 });
    await target.assert();
    if (target.path.startsWith("/projects/")) {
      await sameText(page, "project-selector", project.name);
      assert.equal(await test(page, "tab-chats").getAttribute("href"), `${project.path}/chats`);
      assert.equal(await test(page, "tab-agents").getAttribute("href"), `${project.path}/members`);
      assert.equal(
        await test(page, "tab-settings").getAttribute("href"),
        `${project.path}/settings`,
      );
    }
    return {
      path: target.path,
      projectId: target.path.startsWith("/projects/") ? project.id : null,
    };
  }
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const next = targets[(index + 1) % targets.length];
    await check(`deep_${target.key}`, page, async () => {
      await goto(page, target.entry ?? target.path);
      return targetMatches(target);
    });
    await check(`reload_${target.key}`, page, async () => {
      await page.reload({ waitUntil: "networkidle" });
      return targetMatches(target);
    });
    await check(`unavailable_${target.key}`, page, () => unavailable(page, target, messages));
    await shot(page, `deep-${target.key}`);
    await check(`back_${target.key}`, page, async () => {
      await goto(page, next.entry ?? next.path);
      await targetMatches(next);
      await page.goBack({ waitUntil: "networkidle" });
      return targetMatches(target);
    });
    await check(`forward_${target.key}`, page, async () => {
      await page.goForward({ waitUntil: "networkidle" });
      return targetMatches(next);
    });
  }
  for (const [label, path] of [
    ["project", project.path],
    ["settings", `${project.path}/settings`],
    ["members", `${project.path}/members`],
    ["chats", `${project.path}/chats`],
    ["chat", chatPath],
    ["agent", `/agents/${agentProfileId}`],
  ]) {
    await check(`isolation_page_${label}`, other, async () => {
      await goto(other, path);
      const meta = test(other, label === "agent" ? "agent-error-meta" : "project-error-meta");
      await meta.waitFor();
      const text = await meta.textContent();
      assert.match(text, /not_found/);
      assert.match(text, /req_[0-9a-f-]{36}/);
      const body = await other.locator("body").innerText();
      writeFileSync(join(directory, `isolation-page-${label}.txt`), body);
      const leaked = noLeaks(body, tokens);
      await shot(other, `isolation-${label}`);
      return { path, error: text, leaked };
    });
  }
  const projectInput = { projectId: project.id };
  const chatInput = { chatId: observed.chatId };
  const agentInput = { agentProfileId };
  const calls = {
    getProjectFn: projectInput,
    getProjectProfileFn: projectInput,
    updateProjectProfileFn: { ...projectInput, defaultBranch: "forbidden-write" },
    listProjectMembersFn: projectInput,
    addProjectMemberFn: { ...projectInput, agentProfileId },
    removeProjectMemberFn: { ...projectInput, agentProfileId },
    getAgentProfileFn: agentInput,
    updateAgentProfileFn: { ...agentInput, persona: "forbidden-persona" },
    listChatsFn: projectInput,
    createDirectChatFn: { ...projectInput, agentProfileId },
    getChatFn: chatInput,
    listChatMembersFn: chatInput,
    listInstancesForChatFn: chatInput,
    listMessagesFn: chatInput,
    sendMessageFn: { ...chatInput, body: "forbidden-message" },
    getProjectInfoHubFn: projectInput,
    getChatInfoFn: chatInput,
  };
  for (const [name, input] of Object.entries(calls)) {
    await check(`isolation_RPC_${name}`, other, async () => {
      const { value, body } = await call(contextB, name, input, `isolation-${name}`);
      assert.equal(value.ok, false);
      assert.equal(value.error.code, "not_found");
      assert.equal(value.error.requestId, value.requestId);
      return {
        status: 200,
        code: value.error.code,
        requestId: value.requestId,
        leaked: noLeaks(body, tokens),
      };
    });
  }
  for (const name of ["listProjectsFn", "listAgentProfilesFn"]) {
    await check(`isolation_list_${name}`, other, async () => {
      const { value, body } = await call(contextB, name, {}, `isolation-${name}`, "GET");
      assert.equal(value.ok, true);
      assert(Array.isArray(value.data));
      if (name === "listProjectsFn")
        // B 注册时拿到一个默认 Project，所以列表含它自己建的那个和默认项，但不含 A 的。
        assert(
          value.data.some((item) => item.id === own.id),
          "B must see its own project",
        );
      return { leaked: noLeaks(body, tokens), count: value.data.length };
    });
  }
  await check("B_own_Project_still_works_after_denials", other, async () => {
    await goto(other, `${own.path}/settings`);
    const facts = await readProjectFacts(other);
    assert.equal(facts.name, own.name);
    assert((facts.id ?? "").includes(own.id), `B settings must show ${own.id}`);
    await test(other, "config-default-branch").fill("b-control");
    await test(other, "config-save").click();
    await test(other, "config-saved").waitFor();
    await other.reload({ waitUntil: "networkidle" });
    await sameInput(other, "config-default-branch", "b-control");
    const { value } = await call(
      contextB,
      "getProjectInfoHubFn",
      { projectId: own.id },
      "B-own-hub",
    );
    assert.equal(value.ok, true);
    assert.equal(value.data.projectId, own.id);
    await shot(other, "B-control");
    return { projectId: own.id, name: own.name, defaultBranch: "b-control", hubOk: value.ok };
  });
}
async function after() {
  const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
  const before = JSON.parse(readFileSync(join(directory, "before.json"), "utf8"));
  const context = await browser.newContext({ storageState: state.storageA });
  const page = await newPage(context);
  await goto(page, state.chatPath);
  const actual = await chat(page);
  // 重启前库里已提交的 Agent 回执，必须在重启后的页面上逐字按原序渲染。
  const persistedReceipts = JSON.parse(readFileSync(join(directory, "receipts.json"), "utf8"));
  await check("restart_agent_receipts_preserved", page, async () => {
    const receipts = await agentBodies(page);
    assert.deepEqual(
      receipts.slice(0, persistedReceipts.length),
      persistedReceipts,
      "重启前已提交的 Agent 回执必须逐字保留",
    );
    return { persisted: persistedReceipts.length, rendered: receipts.length };
  });
  await shot(page, "after-chat");
  await goto(page, `${state.project.path}/settings`);
  await test(page, "config-git-remote").waitFor();
  Object.assign(actual, await config(page));
  save("after.json", actual);
  for (const field of [
    "chatId",
    "instanceId",
    "messages",
    "gitRemote",
    "defaultBranch",
    "workDirectory",
    "persona",
  ]) {
    await check(`restart_literal_${field}`, page, async () => {
      assert.deepEqual(actual[field], before[field]);
      return { before: before[field], after: actual[field], equal: true };
    });
  }
  for (let index = 0; index < 2; index++) {
    await check(`restart_literal_message_${index + 1}`, page, async () => {
      assert.equal(actual.messages[index], before.messages[index]);
      return { before: before.messages[index], after: actual.messages[index], equal: true };
    });
  }
  await shot(page, "after-settings");
  await check("restart_profile_persona_literal", page, async () => {
    await goto(page, `/agents/${state.agentProfileId}`);
    await sameText(page, "agent-detail-id", state.agentProfileId);
    await sameInput(page, "agent-edit-persona", before.persona);
    return { before: before.persona, after: await test(page, "agent-edit-persona").inputValue() };
  });
  await check("restart_dm_and_channel_literal", page, async () => {
    await goto(page, `${state.project.path}/chats`);
    await test(page, "chat-item").first().waitFor();
    const list = await test(page, "chat-item").evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.chatId),
    );
    assert.equal(list.length, 2);
    assert.equal(list[0], before.chatId);
    return { before: [before.chatId], after: list };
  });
}
/**
 * 宿主关闭时的诚实表达：`SPROUT_PI_ENABLED=false` 的服务实例必须让页面说「宿主未启用」，
 * 并给出与「活动 run」标题同排的状态，不伪造运行中的 run。默认启用态由 deep_* / unavailable_* 证明。
 */
async function hostDisabled() {
  const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
  const before = JSON.parse(readFileSync(join(directory, "before.json"), "utf8"));
  const context = await browser.newContext({ storageState: state.storageA });
  const page = await newPage(context);
  await check("host_disabled_settings_says_host_off", page, async () => {
    await goto(page, `${state.project.path}/settings`);
    await test(page, "config-git-remote").waitFor();
    await openProjectInfoHub(page);
    const facts = await assertHostState(page, "info-hub-project-runs", HOST_DISABLED);
    await test(page, "info-hub-project-runs-active").waitFor();
    await test(page, "info-hub-project-runs-recent").waitFor();
    await shot(page, "host-disabled-settings");
    return facts;
  });
  await check("host_disabled_chat_says_host_off", page, async () => {
    await goto(page, chatInspectorPath(state.chatPath));
    await sameText(page, "pi-host-status", HOST_DISABLED);
    assert.match(flat(await test(page, "run-status").innerText()), /^分身运行状态：宿主未启用/);
    const facts = await assertHostState(page, "info-chat-runs", HOST_DISABLED);
    await assertHumanMessages(page, before.messages);
    await shot(page, "host-disabled-chat");
    return facts;
  });
}
try {
  if (mode === "before") await before();
  else if (mode === "host-disabled") await hostDisabled();
  else await after();
} catch (error) {
  await check(`setup_${mode}`, null, () => {
    throw error;
  });
} finally {
  await check(`zero_console_errors_${mode}`, null, () => {
    assert.deepEqual(errors, []);
    return { errors };
  });
  await browser.close();
}
const failed = results.filter((result) => !result.passed);
console.log(`browser ${mode} checks=${results.length} failed=${failed.length}`);
process.exitCode = failed.length ? 1 : 0;
