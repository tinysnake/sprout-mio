// 真实 Chromium 走查：右栏文件树 → 中栏预览 → 新标签页。每步打印 PASS/FAIL。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";
import { PROJECT_CHATS, createProject } from "./ui-navigation.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3113";
const PI_DIR = process.env.SPROUT_PI_DATA_DIR;
const EVIDENCE = process.env.EVIDENCE_DIR ?? "/tmp/sprout-workspace-evidence";
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
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
const badResponses = [];
page.on("response", (response) => {
  if (response.status() >= 400)
    badResponses.push(
      `${response.status()} ${response.url().slice(0, 140)} range=${response.request().headers()["range"] ?? "-"}`,
    );
});

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.getByTestId("dev-login").click();
await page.waitForTimeout(2500);
const projectPath = PROJECT_CHATS.test(new URL(page.url()).pathname)
  ? new URL(page.url()).pathname.replace(/\/chats$/, "")
  : (await createProject(page, { name: `Files ${Date.now()}` })).path;

const agentName = `文件 Agent ${Date.now()}`;
await page.click('[data-testid="nav-agents"]');
await page.waitForURL((url) => url.pathname === "/agents", { timeout: 20000 });
await page.click('[data-testid="new-agent-trigger"]');
await page.fill('[data-testid="agent-name-input"]', agentName);
await page.fill('[data-testid="agent-persona-input"]', "只读文件走查");
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
const chatId = chatPath.split("/").pop() ?? "";

await page.goto(`${BASE}${chatPath}?info=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="inspector-instance-id"]', { timeout: 20000 });
const instanceId = (await page.textContent('[data-testid="inspector-instance-id"]'))?.trim();
const workspace = `${PI_DIR}/${instanceId}/workspace`;
mkdirSync(`${workspace}/src`, { recursive: true });
mkdirSync(`${workspace}/docs`, { recursive: true });
writeFileSync(
  `${workspace}/README.md`,
  "# 工作区说明\n\n| 入口 | 说明 |\n| --- | --- |\n| src | 源码 |\n\n```ts\nconst answer: number = 42;\n```\n",
);
writeFileSync(`${workspace}/docs/data.csv`, 'name,count,note\nalpha,3,首个\nbeta,12,第二个,"x"\n');
writeFileSync(
  `${workspace}/src/index.ts`,
  "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n",
);
writeFileSync(
  `${workspace}/src/page.html`,
  '<!doctype html><h1 data-probe="html-file">minimal page</h1>',
);
writeFileSync(`${workspace}/notes.txt`, "plain text preview\n");
writeFileSync(`${workspace}/pixel.png`, png(64, 40));

function png(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const crc32 = (buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit += 1)
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = 40 + x * 3;
      raw[row + 2 + x * 3] = 90 + y * 4;
      raw[row + 3 + x * 3] = 200;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await page.goto(`${BASE}${chatPath}?info=1&pane=files`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="workspace-panel"]', { timeout: 20000 });

const rows = () =>
  page.$$eval('[data-testid="workspace-tree-entry"]', (nodes) =>
    nodes.map((node) => node.getAttribute("data-workspace-path")),
  );
const openFile = async (path) => {
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const parent = segments.slice(0, index).join("/");
    if (!(await page.$(`[data-workspace-path="${parent}"][data-state="open"]`))) {
      await page.click(`[data-workspace-path="${parent}"]`);
    }
  }
  await page.click(`[data-workspace-path="${path}"]`);
  await page.waitForFunction(
    ([selector, expected]) =>
      [...document.querySelectorAll(`${selector} .truncate`)].some(
        (node) => node.textContent === expected,
      ),
    [`[data-testid="workspace-preview-pane"]`, path],
    { timeout: 20000 },
  );
};
const preview = '[data-testid="workspace-preview-pane"]';

await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="workspace-tree-entry"]').length > 0,
  null,
  { timeout: 20000 },
);
const rootRows = await rows();
record(
  "tree_lists_workspace_root",
  rootRows.includes("README.md") && rootRows.includes("docs") && !rootRows.includes(".git"),
  `根条目 ${JSON.stringify(rootRows)}`,
);

await openFile("README.md");
await page.waitForSelector(`${preview} h1`, { timeout: 20000 });
record(
  "markdown_renders_inline",
  ((await page.textContent(preview)) ?? "").includes("工作区说明"),
  "README.md 标题与表格渲染",
);
await page.screenshot({ path: join(EVIDENCE, "markdown.png") });

await openFile("docs/data.csv");
await page.waitForSelector(`${preview} table tbody tr`, { timeout: 20000 });
const csvRows = await page.$$eval(`${preview} table tbody tr`, (rows) =>
  rows.map((row) => row.textContent),
);
record("csv_renders_table", csvRows.length === 2, `数据行 ${JSON.stringify(csvRows)}`);

await openFile("src/index.ts");
await page.waitForSelector(`${preview} .workspace-code .shiki`, { timeout: 20000 });
record("code_is_highlighted", true, "shiki 产物出现");
await page.screenshot({ path: join(EVIDENCE, "code.png") });

await openFile("src/page.html");
await page.waitForSelector(`iframe[title="HTML 预览"]`, { timeout: 20000 });
const frameProbe = await page
  .frameLocator(`iframe[title="HTML 预览"]`)
  .locator("[data-probe=html-file]")
  .textContent();
record("html_preview_is_sandboxed_iframe", frameProbe === "minimal page", `内部标题 ${frameProbe}`);

await openFile("pixel.png");
const image = await page.waitForSelector(`${preview} img`, { state: "attached", timeout: 20000 });
const imageSrc = (await image.getAttribute("src")) ?? "";
const decoded = await page
  .waitForFunction(
    (selector) => {
      const node = document.querySelector(selector);
      return node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0;
    },
    `${preview} img`,
    { timeout: 20000 },
  )
  .then(() => true)
  .catch(() => false);
record(
  "image_renders",
  decoded && imageSrc.startsWith("blob:"),
  `src=${imageSrc.slice(0, 12)}… decoded=${decoded}`,
);

await openFile("notes.txt");
await page.waitForFunction(
  (selector) => document.querySelector(selector)?.textContent?.includes("plain text preview"),
  preview,
  { timeout: 20000 },
);
record("text_renders", true, "txt 纯文本");

await openFile("README.md");

const fileTabs = () =>
  page.$$eval('[data-testid="center-tab-file"]', (nodes) =>
    nodes.map((node) => node.getAttribute("data-workspace-path")),
  );
const tabPaths = await fileTabs();
record(
  "opened_files_keep_their_own_tab",
  ["README.md", "docs/data.csv", "src/index.ts", "src/page.html", "pixel.png", "notes.txt"].every(
    (path) => tabPaths.includes(path),
  ),
  `页签 ${JSON.stringify(tabPaths)}`,
);

await openFile("notes.txt");
record(
  "reopening_a_file_reuses_its_tab",
  (await fileTabs()).length === tabPaths.length,
  `页签数 ${tabPaths.length} → ${(await fileTabs()).length}`,
);

await openFile("README.md");
await page.click('[data-testid="center-tab-chat"]');
await page.waitForSelector('[data-testid="chat-pane"]', { timeout: 20000 });
record(
  "chat_tab_keeps_file_tabs",
  (await fileTabs()).length === tabPaths.length,
  `回到聊天后页签 ${JSON.stringify(await fileTabs())}`,
);
await page.click('[data-workspace-path="docs/data.csv"]');
await page.waitForSelector(`${preview} table tbody tr`, { timeout: 20000 });
record("file_tab_restores_preview", true, "点数据页签回到 csv 预览");

await page.click('[data-testid="side-pane-tab-info"]');
await page.waitForSelector('[data-testid="chat-details"]', { timeout: 20000 });
record(
  "info_tab_keeps_the_files_tab",
  (await page.$('[data-testid="side-pane-tab-files"]')) !== null,
  "信息页里「文件」页签仍在",
);
await page.click('[data-testid="side-pane-tab-files"]');
await page.waitForSelector('[data-testid="workspace-panel"]', { timeout: 20000 });
record("files_tab_returns_to_the_tree", true, "从信息页点回文件页签");

// 预览占着中栏时聊天标题栏不在，入口在预览页签栏上。
await page.click('[data-testid="toggle-workspace-files"]');
await page.waitForSelector('[data-testid="chat-details"]', { timeout: 20000 });
record(
  "header_button_toggles_the_files_pane",
  (await page.$('[data-testid="workspace-panel"]')) === null,
  "文件按钮在已打开时切回信息",
);
await page.click('[data-testid="toggle-workspace-files"]');
await page.waitForSelector('[data-testid="workspace-panel"]', { timeout: 20000 });
record("header_button_reopens_files", true, "再点一次回到文件树");

// 页签多了要能横着滚，而且右侧按钮不跟着滚走。
const allFiles = [
  "README.md",
  "docs/data.csv",
  "src/index.ts",
  "src/page.html",
  "pixel.png",
  "notes.txt",
];
const allFilesParam = allFiles.map((path) => encodeURIComponent(path)).join(",");
await page.setViewportSize({ width: 1000, height: 800 });
await page.goto(`${BASE}${chatPath}?info=1&pane=files&files=${allFilesParam}&file=README.md`, {
  waitUntil: "domcontentloaded",
});
await page.waitForSelector('[data-testid="center-tab-list"]', { timeout: 20000 });
const strip = await page.$eval('[data-testid="center-tab-list"]', (node) => ({
  scrollWidth: node.scrollWidth,
  clientWidth: node.clientWidth,
  scrollLeft: node.scrollLeft,
}));
record(
  "tab_list_scrolls_when_files_outgrow_the_strip",
  strip.scrollWidth > strip.clientWidth,
  `scrollWidth ${strip.scrollWidth} > clientWidth ${strip.clientWidth} @1000`,
);

await page.click('[data-testid="center-tab-file"][data-workspace-path="notes.txt"]');
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-testid="center-tab-list"]')
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("data-workspace-path") === "notes.txt",
  null,
  { timeout: 20000 },
);
const scrolled = await page.$eval('[data-testid="center-tab-list"]', (node) => node.scrollLeft);
record("active_tab_scrolls_into_view", scrolled > 0, `scrollLeft ${scrolled}`);

const newTabButton = await page.$eval('[data-testid="preview-open-new-tab"]', (node) => {
  const box = node.getBoundingClientRect();
  return { text: node.textContent?.trim() ?? "", right: box.right, size: box.width };
});
const filesButton = await page.$eval(
  '[data-testid="toggle-workspace-files"]',
  (node) => node.getBoundingClientRect().left,
);
record(
  "new_tab_button_is_an_icon_left_of_the_icon_group",
  newTabButton.text === "" && newTabButton.right <= filesButton + 1,
  `文本「${newTabButton.text}」宽 ${Math.round(newTabButton.size)}，右缘 ${Math.round(newTabButton.right)} ≤ 文件按钮左缘 ${Math.round(filesButton)}`,
);
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(
  `${BASE}${chatPath}?info=1&pane=files&files=${allFilesParam}&file=docs%2Fdata.csv`,
  {
    waitUntil: "domcontentloaded",
  },
);
await page.waitForSelector('[data-testid="workspace-preview-pane"] table tbody tr', {
  timeout: 20000,
});

const newTabHref = await page.getAttribute('[data-testid="preview-open-new-tab"]', "href");
await page.goto(`${BASE}${newTabHref}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="workspace-file-page"]', { timeout: 20000 });
const pageText = (await page.textContent('[data-testid="workspace-file-page"]')) ?? "";
const rawHref = await page.getAttribute(
  '[data-testid="workspace-file-page"] a[href^="/api/workspace/file"]',
  "href",
);
const rawResponse = await page.request.get(`${BASE}${rawHref}`);
record(
  "new_tab_opens_the_viewer_not_the_raw_bytes",
  new URL(page.url()).pathname === `/projects/${projectId}/files` &&
    pageText.includes("alpha") &&
    !pageText.includes("name,count,note") &&
    rawResponse.status() === 200,
  `${newTabHref} → ${new URL(page.url()).pathname}；原文 ${rawResponse.headers()["content-type"]}`,
);
await page.goto(`${BASE}${chatPath}?info=1&pane=files&file=README.md`, {
  waitUntil: "domcontentloaded",
});

const query = new URLSearchParams({ projectId, chatId, path: "../../etc/passwd" });
const traversal = await page.request.get(`${BASE}/api/workspace/file?${query}`);
record(
  "traversal_rejected",
  traversal.status() === 400,
  `../.. → ${traversal.status()} ${(await traversal.text()).slice(0, 80)}`,
);

await page.goto(`${BASE}${chatPath}?info=1&pane=files`, { waitUntil: "domcontentloaded" });
await page.click('[data-testid="side-pane-tab-info"]');
await page.waitForSelector('[data-testid="chat-inspector"]', { timeout: 20000 });
record("pane_switch_keeps_chat", new URL(page.url()).pathname === chatPath, "回到 Info 页签");

record(
  "no_console_errors",
  consoleErrors.length === 0,
  `${consoleErrors.join(" | ").slice(0, 200)} :: 4xx ${badResponses.join(" | ").slice(0, 200)}`,
);
await browser.close();
const failed = results.filter((passed) => !passed).length;
console.log(`workspace checks: ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
