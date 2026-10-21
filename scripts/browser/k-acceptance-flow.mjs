import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3145";
const directory = resolve(process.env.ACCEPTANCE_DIRECTORY ?? ".verify/k-acceptance");
const screenshots = resolve("docs/p1/evidence");
const mode = process.argv[2] ?? "before";
assert(["before", "after"].includes(mode));
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
async function registerProject(page, role) {
  await goto(page, "/login");
  await page.getByText("没有账号？注册", { exact: true }).click();
  await page.locator('input[name="name"]').fill(`P2-K 用户 ${role}`);
  await page
    .locator('input[name="email"]')
    .fill(`k-${role}-${randomBytes(8).toString("hex")}@example.test`);
  await page.locator('input[name="password"]').fill(randomBytes(24).toString("base64url"));
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/");
  await test(page, "open-projects").click();
  await test(page, "new-project-trigger").click();
  const name = `P2-K Project ${role}`;
  await test(page, "project-name-input").fill(name);
  await test(page, "project-description-input").fill(`独立验收 ${role}`);
  await test(page, "project-submit").click();
  await test(page, "project-item-name").getByText(name, { exact: true }).click();
  await sameText(page, "project-detail-name", name);
  return {
    name,
    id: new URL(page.url()).pathname.split("/").pop(),
    path: new URL(page.url()).pathname,
  };
}
async function config(page) {
  return {
    gitRemote: await test(page, "config-git-remote").inputValue(),
    defaultBranch: await test(page, "config-default-branch").inputValue(),
    workDirectory: await test(page, "config-work-directory").inputValue(),
  };
}
async function conversation(page) {
  await test(page, "conversation-instance-id").waitFor();
  return {
    conversationId: await test(page, "conversation-id").textContent(),
    instanceId: await test(page, "conversation-instance-id").textContent(),
    messages: await test(page, "message-body").allTextContents(),
    persona: await test(page, "conversation-agent-persona").textContent(),
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
async function unavailable(page, target) {
  const body = await page.locator("body").innerText();
  assert(!/0 个活动 run|无活动 run|无 Machine/.test(body));
  if (target.path.startsWith("/projects/")) {
    await sameText(page, "info-hub-project-runs-host-status", "宿主未启用");
    await test(page, "info-hub-project-runs-active").waitFor();
    await sameText(page, "info-hub-machines-notice-badge", "未实现");
    assert.match(await test(page, "info-hub-machines-notice-reason").textContent(), /P4/);
  }
  if (target.key === "conversation") {
    await sameText(page, "info-conversation-runs-host-status", "宿主未启用");
    assert.match(
      await test(page, "info-turn-prompt-injection").textContent(),
      /注入模型 prompt：否/,
    );
    await sameText(page, "pi-host-status", "宿主未启用");
    assert.deepEqual(
      await test(page, "message-item").evaluateAll((nodes) =>
        nodes.map((node) => node.dataset.senderKind),
      ),
      ["human", "human"],
    );
  }
  return {
    path: target.path,
    P3: target.path.startsWith("/projects/"),
    P4: target.path.startsWith("/projects/"),
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
  await goto(page, `${project.path}/agents`);
  await test(page, "add-member-select").selectOption({ label: agentName });
  await test(page, "add-member-submit").click();
  await sameText(page, "member-item-name", agentName);
  await goto(page, `${project.path}/conversations`);
  await test(page, "dm-start").click();
  await test(page, "conversation-instance-id").waitFor();
  const conversationPath = new URL(page.url()).pathname;
  const original = await conversation(page);
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
  await goto(page, conversationPath);
  const observed = await conversation(page);
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
    observed.conversationId,
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
    conversationPath,
    tokens,
    storageA: await contextA.storageState(),
    storageB: await contextB.storageState(),
  });
  await check("profile_edit_and_configuration_keep_identity_history", page, async () => {
    assert.deepEqual(snapshot, {
      conversationId: original.conversationId,
      instanceId: original.instanceId,
      messages,
      persona,
      ...configuration,
    });
    await shot(page, "before-conversation");
    return snapshot;
  });
  await check("repeat_DM_keeps_conversation_and_instance", page, async () => {
    await goto(page, `${project.path}/conversations`);
    await test(page, "dm-start").click();
    assert.deepEqual(await conversation(page), observed);
    return { conversationId: observed.conversationId, instanceId: observed.instanceId };
  });
  const targets = [
    {
      key: "project",
      path: project.path,
      assert: () => sameText(page, "project-detail-name", project.name),
    },
    {
      key: "settings",
      path: `${project.path}/settings`,
      assert: async () => {
        await test(page, "config-git-remote").waitFor();
        assert.deepEqual(await config(page), configuration);
      },
    },
    {
      key: "members",
      path: `${project.path}/agents`,
      assert: () => sameText(page, "member-item-name", agentName),
    },
    {
      key: "conversations",
      path: `${project.path}/conversations`,
      assert: async () => {
        await test(page, "conversation-item").waitFor();
        assert.deepEqual(
          await test(page, "conversation-item").evaluateAll((nodes) =>
            nodes.map((node) => node.dataset.conversationId),
          ),
          [observed.conversationId],
        );
      },
    },
    {
      key: "conversation",
      path: conversationPath,
      assert: async () => {
        assert.deepEqual(await conversation(page), observed);
        await sameText(page, "info-conversation-instance-id", observed.instanceId);
        await sameText(page, "info-message-count", "2");
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
    assert.equal(new URL(page.url()).pathname, target.path);
    await target.assert();
    if (target.path.startsWith("/projects/")) {
      await sameText(page, "project-detail-name", project.name);
      assert.equal(
        await test(page, "tab-settings").getAttribute("href"),
        `${project.path}/settings`,
      );
      await sameText(page, "info-agent-name", agentName);
      assert.equal(await test(page, "info-agent-dm-link").getAttribute("href"), conversationPath);
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
      await goto(page, target.path);
      return targetMatches(target);
    });
    await check(`reload_${target.key}`, page, async () => {
      await page.reload({ waitUntil: "networkidle" });
      return targetMatches(target);
    });
    await check(`unavailable_${target.key}`, page, () => unavailable(page, target));
    await shot(page, `deep-${target.key}`);
    await check(`back_${target.key}`, page, async () => {
      await goto(page, next.path);
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
    ["members", `${project.path}/agents`],
    ["conversations", `${project.path}/conversations`],
    ["conversation", conversationPath],
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
  const conversationInput = { conversationId: observed.conversationId };
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
    listConversationsFn: projectInput,
    createDirectConversationFn: { ...projectInput, agentProfileId },
    getConversationFn: conversationInput,
    listConversationMembersFn: conversationInput,
    listInstancesForConversationFn: conversationInput,
    listMessagesFn: conversationInput,
    sendMessageFn: { ...conversationInput, body: "forbidden-message" },
    getProjectInfoHubFn: projectInput,
    getConversationInfoFn: conversationInput,
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
    await sameText(other, "project-detail-name", own.name);
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
  await goto(page, state.conversationPath);
  const actual = await conversation(page);
  await shot(page, "after-conversation");
  await goto(page, `${state.project.path}/settings`);
  await test(page, "config-git-remote").waitFor();
  Object.assign(actual, await config(page));
  save("after.json", actual);
  for (const field of [
    "conversationId",
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
  await check("restart_single_conversation_literal", page, async () => {
    await goto(page, `${state.project.path}/conversations`);
    await test(page, "conversation-item").waitFor();
    const list = await test(page, "conversation-item").evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.conversationId),
    );
    assert.deepEqual(list, [before.conversationId]);
    return { before: [before.conversationId], after: list };
  });
}
try {
  if (mode === "before") await before();
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
