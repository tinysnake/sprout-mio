// 真实 Chromium 走查：Chat 租约行 → 机器文件树 → 回到本机工作区。每步打印 PASS/FAIL。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { PROJECT_CHATS, createProject } from "./ui-navigation.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3113";
const PI_DIR = process.env.SPROUT_PI_DATA_DIR ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const EVIDENCE = process.env.EVIDENCE_DIR ?? "/tmp/sprout-machine-evidence";
mkdirSync(EVIDENCE, { recursive: true });
console.log("evidence:", EVIDENCE);

const results = [];
const record = (name, passed, detail) => {
  results.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"} ${name} :: ${detail}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
// 机器离线是走查里刻意制造的状态：409 会出现在控制台，但它不是页面崩溃。
const machineStatuses = [];
page.on("response", (response) => {
  if (new URL(response.url()).pathname.startsWith("/api/machine/"))
    machineStatuses.push(response.status());
});

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.getByTestId("dev-login").click();
await page.waitForTimeout(2500);
const projectPath = PROJECT_CHATS.test(new URL(page.url()).pathname)
  ? new URL(page.url()).pathname.replace(/\/chats$/, "")
  : (await createProject(page, { name: `Machine ${Date.now()}` })).path;

const agentName = `机器 Agent ${Date.now()}`;
await page.click('[data-testid="nav-agents"]');
await page.waitForURL((url) => url.pathname === "/agents", { timeout: 20000 });
await page.click('[data-testid="new-agent-trigger"]');
await page.fill('[data-testid="agent-name-input"]', agentName);
await page.fill('[data-testid="agent-persona-input"]', "只读机器文件走查");
await page.click('[data-testid="agent-submit"]');
await page.waitForFunction(
  (name) =>
    [...document.querySelectorAll('[data-testid="agent-item-name"]')].some(
      (node) => node.textContent === name,
    ),
  agentName,
  { timeout: 20000 },
);
await page.click(`[data-testid="agent-item-name"] >> text=${agentName}`);
await page.waitForSelector('[data-testid="agent-detail-id"]', { timeout: 20000 });
const agentId = (await page.textContent('[data-testid="agent-detail-id"]')) ?? "";
await page.goto(`${BASE}${projectPath}/members`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="add-member-trigger"]', { timeout: 20000 });
await page.click('[data-testid="add-member-trigger"]');
await page.waitForFunction(
  (name) =>
    [...document.querySelectorAll('[data-testid="add-member-select"] option')].some(
      (option) => option.textContent === name,
    ),
  agentName,
  { timeout: 20000 },
);
await page.selectOption('[data-testid="add-member-select"]', { label: agentName });
await page.click('[data-testid="add-member-submit"]');
await page.waitForFunction(
  (name) =>
    [...document.querySelectorAll('[data-testid="member-item-name"]')].some(
      (node) => node.textContent === name,
    ),
  agentName,
  { timeout: 20000 },
);
await page.goto(`${BASE}${projectPath}/chats`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(`[data-testid="dm-start"][data-agent-profile-id="${agentId}"]`, {
  timeout: 20000,
});
await page.click(`[data-testid="dm-start"][data-agent-profile-id="${agentId}"]`);
await page.waitForURL((url) => /\/chats\/cnv_[0-9a-z]{8,32}$/.test(url.pathname), {
  timeout: 20000,
});
const chatPath = new URL(page.url()).pathname;
const projectId = chatPath.split("/")[2] ?? "";

// 机器不建连接：这台机器就是离线的，浏览要么给出明确错误，要么等超时，不能假装有内容。
const machineId = `mch_${Date.now().toString(16).padStart(8, "0").slice(-8)}`;
const machineName = `远端机器 ${Date.now()}`;
const db = new DatabaseSync(DATABASE_URL);
const userId = db.prepare("SELECT id FROM user LIMIT 1").get()?.id;
const now = Date.now();
db.prepare(
  "INSERT INTO machine(id,name,root_directory,root_revision,created_by,created_at,updated_at) VALUES (?,?,?,1,?,?,?)",
).run(machineId, machineName, "/tmp/machine-root", userId, now, now);
db.prepare(
  "INSERT INTO project_machine(project_id,machine_id,created_by,description,revision,created_at,updated_at) VALUES (?,?,?,?,1,?,?)",
).run(projectId, machineId, userId, "", now, now);
db.prepare(
  "INSERT INTO project_machine_membership(project_id,machine_id,epoch,state,joined_at) VALUES (?,?,1,'active',?)",
).run(projectId, machineId, now);
db.prepare(
  "INSERT INTO machine_lease(project_id,machine_id,generation,state,changed_at) VALUES (?,?,0,'free',?)",
).run(projectId, machineId, now);
db.close();

// 本机工作区先放一个文件：回到工作区那一步要有东西可列。
await page.goto(`${BASE}${chatPath}?info=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="inspector-instance-id"]', { timeout: 20000 });
const instanceId = (await page.textContent('[data-testid="inspector-instance-id"]'))?.trim() ?? "";
const workspace = `${PI_DIR}/${instanceId}/workspace`;
mkdirSync(workspace, { recursive: true });
writeFileSync(`${workspace}/README.md`, "# 本机工作区\n\n回到本机时看到的文件。\n");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(`[data-testid="lease-browse-${machineId}"]`, { timeout: 40000 });
record("lease_row_offers_browse", true, machineName);

await page.click(`[data-testid="lease-browse-${machineId}"]`);
await page.waitForFunction(
  (id) => new URL(location.href).searchParams.get("machine") === id,
  machineId,
  { timeout: 20000 },
);
const afterClick = new URL(page.url());
record(
  "browse_switches_to_machine_source",
  afterClick.searchParams.get("pane") === "files",
  afterClick.search,
);

await page.waitForSelector(
  '[data-testid="workspace-tree-entry"], [data-testid="workspace-tree-error"]',
  {
    timeout: 20000,
  },
);
const header = (await page.textContent('[data-testid="chat-inspector"]')) ?? "";
record("tree_header_names_machine", header.includes(`机器：${machineName}`), header.slice(0, 80));
// 机器没有连接：树必须给明确原因，不能显示空目录冒充「这台机器上没有东西」。
record("offline_machine_explains_itself", header.includes("机器不在线"), header.slice(0, 120));

await page.screenshot({ path: join(EVIDENCE, "machine-tree.png"), animations: "disabled" });

await page.click('[data-testid="workspace-source-clear"]');
await page.waitForFunction(() => !new URL(location.href).searchParams.get("machine"), undefined, {
  timeout: 20000,
});
await page.waitForSelector('[data-testid="workspace-tree-entry"]', { timeout: 20000 });
const backHeader = (await page.textContent('[data-testid="chat-inspector"]')) ?? "";
record(
  "clearing_returns_to_workspace_source",
  !backHeader.includes("机器："),
  backHeader.slice(0, 80),
);

record(
  "offline_tree_answers_with_conflict",
  machineStatuses.includes(409),
  machineStatuses.join(","),
);
record("no_page_errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
