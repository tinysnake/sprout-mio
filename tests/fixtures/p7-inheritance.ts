/**
 * p7-inheritance 夹具：Pi 分身的资源继承边界（F9c）。
 *
 * 目的不是再证明一次「Sprout extension + 四个基础工具可用」（P3/n-pi-session/x3 已有），
 * 而是把「谁被加载、谁没被加载」变成可重跑的实测清单：
 *
 *   - 默认关闭：宿主 skills / prompts / themes / AGENTS.md / extensions 与 cwd 的 `.pi/*`
 *     都不进 loader；工具面等于四个基础工具 + Sprout 工具，且不含 codemode / tool_search /
 *     mcp__ 前缀工具。
 *   - 打开 `inheritHostResources`：只有宿主 skills 与 prompt templates 进入 loader，
 *     extensions / themes / context files 仍然关闭，工具面不变。
 *   - 隔离：两个 Project 的分身各自在自己的受控目录里装载，宿主 agentDir 前后逐字节不变。
 *
 * 全部用真实已安装 Pi SDK（托管 `bin/pi` / `install/releases`）的 model-fixture 目录，
 * 走生产 runner `scripts/pi-host-runner.mjs` 的 open 协议，不调用任何付费模型。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startModelFixture } from "../../scripts/verify/lib/model-fixture.mjs";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { APP_VERSION, CONTRACT_VERSION } from "../../src/contracts/version";
import { infoHubToolInputSchemas } from "../../src/contracts/info-hub-query";
import { remoteToolInputSchemas } from "../../src/contracts/remote";
import { taskToolInputSchemas } from "../../src/contracts/task";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const directory = process.env.P7_DIR ?? mkdtempSync(join(tmpdir(), "p7-inheritance-"));
const evidencePath = process.env.P7_EVIDENCE ?? join(directory, "evidence.json");
mkdirSync(directory, { recursive: true });

const pass = (name: string) => console.log(`PASS ${name}`);

/** 标记名：写进宿主/cwd，用来证明它们没有被 loader 读到。 */
const markers = {
  hostSkill: "p7-host-skill",
  hostPrompt: "p7-host-prompt",
  hostTheme: "p7-host-theme",
  hostContextFile: "AGENTS.md",
  hostExtension: "p7-host-extension",
  hostExtensionTool: "p7_host_marker_tool",
  projectA: "p7-project-a-skill",
  projectB: "p7-project-b-skill",
} as const;

function writeSkill(root: string, name: string) {
  const skillDir = join(root, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: p7 继承边界标记，只用于证明未被加载。\n---\n\n标记正文。\n`,
  );
}

/**
 * 宿主 Pi 配置目录：模型 fixture 生成的凭据与模型目录 + 五类代表性宿主资源。
 * 真实用户目录只被 fixture 读取 SDK 安装位置，不被写入。
 */
function seedHostResources(hostAgentDir: string) {
  writeSkill(hostAgentDir, markers.hostSkill);
  mkdirSync(join(hostAgentDir, "prompts"), { recursive: true });
  writeFileSync(
    join(hostAgentDir, "prompts", `${markers.hostPrompt}.md`),
    `---\ndescription: p7 继承边界标记 prompt\n---\n\n标记 prompt 正文。\n`,
  );
  mkdirSync(join(hostAgentDir, "themes"), { recursive: true });
  writeFileSync(
    join(hostAgentDir, "themes", `${markers.hostTheme}.json`),
    `${JSON.stringify({ name: markers.hostTheme, colors: {} }, null, 2)}\n`,
  );
  writeFileSync(join(hostAgentDir, markers.hostContextFile), "# p7 宿主 context file 标记\n");
  const extensionDir = join(hostAgentDir, "extensions", markers.hostExtension);
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(
    join(extensionDir, "package.json"),
    `${JSON.stringify({ name: markers.hostExtension, version: "0.0.0", main: "index.js" }, null, 2)}\n`,
  );
  writeFileSync(
    join(extensionDir, "index.js"),
    `export default function marker(pi) { pi.registerTool({ name: ${JSON.stringify(markers.hostExtensionTool)}, description: "marker", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "marker" }] }) }); }\n`,
  );
}

/** cwd 自己的 project 资源：`.pi/skills` 与 `AGENTS.md` 是 loader 默认会扫的两处。 */
function seedProjectResources(cwd: string, skill: string) {
  writeSkill(join(cwd, ".pi"), skill);
  writeFileSync(join(cwd, "AGENTS.md"), `# ${skill} project context 标记\n`);
}

/** 宿主目录的逐文件哈希（路径 + 内容），用于「不被写入」的前后比对。 */
function treeDigest(root: string) {
  const entries: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      entries.push(
        `${relative(root, path)}\0${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
      );
    }
  };
  walk(root);
  return {
    files: entries.length,
    digest: createHash("sha256").update(entries.join("\n")).digest("hex"),
  };
}

type Snapshot = {
  provider: string;
  model: string;
  thinking: string;
  tools: string[];
  registeredTools?: string[];
  extensions: string[];
  sessionId: string;
  sessionFile: string;
  cwd: string;
  sdkVersion: string;
  resources?: {
    inheritHostResources: boolean;
    agentDir: string;
    hostAgentDir: string;
    skillPaths: string[];
    promptPaths: string[];
    skills: string[];
    prompts: string[];
    themes: string[];
    contextFiles: string[];
    systemPromptChars: number;
  };
};

type OpenResult = {
  snapshot: Snapshot;
  runId: string;
  readyMs: number;
  turn?: { text: string; stopReason: string; turnMs: number };
};

/** 只做 open 并量到 ready 的墙钟（可选：再做一轮 model-fixture 对话，证明它是真会话）。 */
function openSession(options: {
  label: string;
  cwd: string;
  sessionDirectory: string;
  hostAgentDir: string;
  inheritHostResources: boolean;
  projectId: string;
  model: string;
  turn?: { text: string; readPath: string; reply: string };
}): Promise<OpenResult> {
  return new Promise((done, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PI_TELEMETRY: "0" };
    // runner 只认 open 命令里的开关；外层环境里残留的同名变量不能影响本次场景。
    delete env.SPROUT_PI_INHERIT_HOST_RESOURCES;
    const child = spawn(process.execPath, [join(repoRoot, "scripts/pi-host-runner.mjs")], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const id = newId(ID_PREFIXES.run);
    const started = performance.now();
    let buffer = "";
    let stderr = "";
    let finished = false;
    let readyAt = 0;
    let turnResult: OpenResult["turn"];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(`${options.label}: ${error.message}`));
    };
    timer = setTimeout(
      () => fail(new Error(`等待 ready 超过 60s；stderr=${stderr.slice(-400)}`)),
      60_000,
    );
    const finish = (snapshot: Snapshot) => {
      finished = true;
      clearTimeout(timer);
      // close 之后等进程自己退出，避免把「open 成功、关闭失败」记成成功。
      const exit = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      child.stdin.write(`${JSON.stringify({ type: "close", id })}\n`);
      void exit.then(() =>
        done({
          runId: id,
          snapshot,
          readyMs: readyAt - started,
          ...(turnResult ? { turn: turnResult } : {}),
        }),
      );
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event: {
          type?: string;
          code?: string;
          message?: string;
          text?: string;
          stopReason?: string;
          snapshot?: Snapshot;
        };
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }
        if (event.type === "failure") {
          fail(new Error(`runner 报错 ${event.code}: ${event.message}`));
          return;
        }
        if (event.type === "settled") {
          if (!options.turn) {
            fail(new Error("没有安排对话的一轮却收到 settled"));
            return;
          }
          turnResult = {
            text: event.text ?? "",
            stopReason: event.stopReason ?? "",
            turnMs: performance.now() - readyAt,
          };
          finish(readySnapshot!);
          return;
        }
        if (event.type !== "ready" || !event.snapshot) continue;
        readyAt = performance.now();
        readySnapshot = event.snapshot;
        if (!options.turn) {
          finish(event.snapshot);
          return;
        }
        // 真实一轮：读一个真实文件，证明工具面在会话里可执行、session 文件真的落盘。
        const serializedText = JSON.stringify({ channel: "sprout_turn_context", probe: true });
        child.stdin.write(
          `${JSON.stringify({
            type: "prompt",
            id,
            messageId: newId(ID_PREFIXES.message),
            text: options.turn.text,
            turnContext: {
              runId: id,
              contentHash: createHash("sha256").update(serializedText).digest("hex"),
              serializedText,
            },
          })}\n`,
        );
        clearTimeout(timer);
        timer = setTimeout(
          () => fail(new Error(`等待 settled 超过 60s；stderr=${stderr.slice(-400)}`)),
          60_000,
        );
      }
    });
    let readySnapshot: Snapshot | undefined;
    child.on("error", (error) => fail(error));
    child.on("exit", (code) => {
      if (!finished)
        fail(new Error(`runner 在结束之前退出 code=${code}；stderr=${stderr.slice(-400)}`));
    });
    child.stdin.write(
      `${JSON.stringify({
        type: "open",
        id,
        instanceId: newId(ID_PREFIXES.instance),
        sessionId: newId(ID_PREFIXES.instance),
        sessionDirectory: options.sessionDirectory,
        cwd: options.cwd,
        agentDir: options.hostAgentDir,
        extensionPath: resolve(repoRoot, "pi/sprout-extension.ts"),
        inheritHostResources: options.inheritHostResources,
        profile: {
          id: newId(ID_PREFIXES.agentProfile),
          name: options.label,
          persona: "p7 inheritance boundary persona",
          harness: "pi",
          model: options.model,
          updatedAt: new Date(0).toISOString(),
        },
        remote: {
          // 未持租约时 extension 不会发出远端请求；这里只满足 grant 结构校验。
          endpoint: "http://127.0.0.1:1/api/remote/agent",
          secret: "s".repeat(43),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          projectId: options.projectId,
        },
      })}\n`,
    );
  });
}

/** 契约里声明的 Sprout 工具名 + 四个基础工具 + 诊断入口 = 默认工具面的完整允许集合。 */
const expectedTools = [
  "bash",
  "edit",
  "read",
  "sprout_status",
  "write",
  ...Object.keys(remoteToolInputSchemas),
  ...Object.keys(taskToolInputSchemas),
  ...Object.keys(infoHubToolInputSchemas),
].sort();

/**
 * registry 必须与工具面逐条相等：注册了却不在 allowlist 里就是被 Pi 丢掉（对模型不存在）。
 * 这里不再留例外——`sprout_status` 已经从「被丢掉的观察项」变成「工具面的正式成员」。
 */
const allowedAnywhere = new Set(expectedTools);

/**
 * 从真实 session 文件里取出 `sprout_status` 的那条 `toolResult`。
 *
 * 证据链要求：模型发了一次工具调用 → Pi 记下结果 → 我们从文件里读回来解析。
 * 不读 runner 自己报的字段，不让 runner 自己证明自己。
 */
function readSproutStatusCall(sessionFile: string, label: string) {
  assert(sessionFile && existsSync(sessionFile), `${label}: session 文件必须存在`);
  const entries = readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { message?: Record<string, any> });
  const calls = entries.flatMap((entry) =>
    Array.isArray(entry.message?.content)
      ? entry.message.content.filter((part: any) => part.type === "toolCall")
      : [],
  );
  const results = entries.filter(
    (entry) => entry.message?.role === "toolResult" && entry.message.toolName === "sprout_status",
  );
  assert.equal(
    calls.filter((part: any) => part.name === "sprout_status").length,
    1,
    `${label}: 模型必须刚好发一次 sprout_status 调用`,
  );
  assert.equal(results.length, 1, `${label}: sprout_status 必须刚好有一条 toolResult`);
  const content = results[0]!.message!.content;
  const text = (Array.isArray(content) ? content : []).find((part: any) => part.type === "text");
  assert(text?.text, `${label}: sprout_status 结果必须是 text 块`);
  return {
    toolName: "sprout_status",
    isError: results[0]!.message!.isError === true,
    payload: JSON.parse(text.text) as Record<string, unknown>,
    rawText: text.text as string,
  };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
};

const fixture = await startModelFixture({ privateDir: join(directory, "model-fixture") });
const hostAgentDir = fixture.agentDir;
seedHostResources(hostAgentDir);
const sessionDirectory = join(directory, "sessions");
mkdirSync(sessionDirectory, { recursive: true });

const projects = {
  a: { name: "project-a", projectId: newId(ID_PREFIXES.project) },
  b: { name: "project-b", projectId: newId(ID_PREFIXES.project) },
};
for (const [key, project] of Object.entries(projects)) {
  const cwd = join(directory, project.name);
  mkdirSync(cwd, { recursive: true });
  seedProjectResources(cwd, markers[key === "a" ? "projectA" : "projectB"]);
}
const hostBefore = treeDigest(hostAgentDir);

const runs: Array<{
  label: string;
  project: "a" | "b";
  inheritHostResources: boolean;
  readyMs: number;
  tools: string[];
  registeredTools: string[];
  sproutStatus: { declared: boolean; registered: boolean };
  /** 真实调用 `sprout_status` 拿到的载荷，没安排调用时为 null。 */
  sproutStatusCall: {
    toolName: string;
    isError: boolean;
    payload: Record<string, unknown>;
    /** 同一 session 文件里的 toolResult 原文，用来证明载荷来自这条真实调用。 */
    rawText: string;
  } | null;
  runId: string;
  provider: string;
  model: string;
  thinking: string;
  extensions: string[];
  sdkVersion: string;
  sessionFile: string;
  sessionFileExists: boolean;
  sessionFileUnderSessionDirectory: boolean;
  turn: { text: string; stopReason: string; turnMs: number } | null;
  systemPromptChars: number;
  resources: {
    inheritHostResources: boolean;
    agentDirRelative: string;
    agentDirName: string;
    agentDirUnderRunCwd: boolean;
    agentDirEqualsHostAgentDir: boolean;
    agentDirUnderHostAgentDir: boolean;
    hostAgentDir: string;
    hostAgentDirRelative: string;
    skillPaths: string[];
    promptPaths: string[];
    skills: string[];
    prompts: string[];
    themes: string[];
    contextFiles: string[];
  };
}> = [];

async function run(options: {
  label: string;
  project: "a" | "b";
  inheritHostResources: boolean;
  withTurn?: boolean;
}) {
  const project = projects[options.project];
  const cwd = join(directory, project.name);
  let turn: { text: string; readPath: string; reply: string } | undefined;
  if (options.withTurn) {
    // 一轮真实对话：先用基础工具（read）证明工具面在会话里真的可执行，再调一次
    // `sprout_status`。前者是旧证据，后者是本单元的新事实：诊断入口不仅声明了，
    // 还真的能被模型敲一次并返回真实数据。同一轮里两个步骤，模型夹具按顺序发两次工具调用。
    const target = join(directory, `probe-target-${options.label}.txt`);
    writeFileSync(target, "p7 inheritance probe target\n");
    const text = "p7 inheritance probe turn";
    const reply = "p7 inheritance probe reply";
    fixture.arm("status", {
      expectedUserText: text,
      steps: [
        { name: "read", arguments: { path: target } },
        { name: "sprout_status", arguments: {} },
      ],
      reply,
    });
    turn = { text, readPath: target, reply };
  }
  const {
    snapshot,
    runId,
    readyMs,
    turn: turnResult,
  } = await openSession({
    label: options.label,
    cwd,
    sessionDirectory,
    hostAgentDir,
    inheritHostResources: options.inheritHostResources,
    projectId: project.projectId,
    model: fixture.model("status"),
    ...(turn ? { turn } : {}),
  });
  const resources = snapshot.resources;
  assert(resources, `${options.label}: ready 快照必须带 resources 段（继承边界证据）`);
  // 真实调用的证据来自 session 文件本身：模型发一次 `sprout_status` 工具调用，Pi 把结果
  // 写成 `role: "toolResult"` 的那条 entry。不读 runner 自己报的字段，避免自己证明自己。
  const sproutStatusCall = turnResult
    ? readSproutStatusCall(snapshot.sessionFile, options.label)
    : null;
  const relativeTo = (path: string) =>
    relative(directory, path).split("\\").join("/") || basename(path);
  runs.push({
    label: options.label,
    project: options.project,
    inheritHostResources: options.inheritHostResources,
    readyMs,
    tools: snapshot.tools,
    registeredTools: snapshot.registeredTools ?? [],
    sproutStatus: {
      declared: snapshot.tools.includes("sprout_status"),
      registered: (snapshot.registeredTools ?? []).includes("sprout_status"),
    },
    sproutStatusCall,
    runId,
    provider: snapshot.provider,
    model: snapshot.model,
    thinking: snapshot.thinking,
    extensions: snapshot.extensions,
    sdkVersion: snapshot.sdkVersion,
    sessionFile: relativeTo(snapshot.sessionFile),
    sessionFileExists: existsSync(snapshot.sessionFile),
    sessionFileUnderSessionDirectory: !relative(sessionDirectory, snapshot.sessionFile).startsWith(
      "..",
    ),
    turn: turnResult
      ? {
          text: turnResult.text,
          stopReason: turnResult.stopReason,
          turnMs: Math.round(turnResult.turnMs),
        }
      : null,
    systemPromptChars: resources.systemPromptChars,
    resources: {
      inheritHostResources: resources.inheritHostResources,
      agentDirRelative: relativeTo(resources.agentDir),
      agentDirName: basename(resources.agentDir),
      agentDirUnderRunCwd: !relative(cwd, resources.agentDir).startsWith(".."),
      agentDirEqualsHostAgentDir: resources.agentDir === resources.hostAgentDir,
      agentDirUnderHostAgentDir: !relative(resources.hostAgentDir, resources.agentDir).startsWith(
        "..",
      ),
      hostAgentDir: relativeTo(resources.hostAgentDir),
      hostAgentDirRelative: relativeTo(resources.hostAgentDir),
      skillPaths: resources.skillPaths.map((path) => relativeTo(path)),
      promptPaths: resources.promptPaths.map((path) => relativeTo(path)),
      skills: resources.skills,
      prompts: resources.prompts,
      themes: resources.themes,
      contextFiles: resources.contextFiles.map((path) => basename(path)),
    },
  });
  return { snapshot, runId, resources, readyMs, turn: turnResult };
}
// ---------------------------------------------------------------- 默认关闭：a 三次（第一次带一轮真实对话）
for (const repeat of [1, 2, 3])
  await run({
    label: `off-a-${repeat}`,
    project: "a",
    inheritHostResources: false,
    ...(repeat === 1 ? { withTurn: true } : {}),
  });
// ---------------------------------------------------------------- 默认关闭：b 一次（隔离）
await run({ label: "off-b-1", project: "b", inheritHostResources: false });
// ---------------------------------------------------------------- 打开开关：a 三次
for (const repeat of [1, 2, 3])
  await run({ label: `on-a-${repeat}`, project: "a", inheritHostResources: true });

const hostAfter = treeDigest(hostAgentDir);
const offRuns = runs.filter((entry) => !entry.inheritHostResources);
const onRuns = runs.filter((entry) => entry.inheritHostResources);
const latency = {
  offMs: offRuns.map((entry) => Math.round(entry.readyMs)),
  onMs: onRuns.map((entry) => Math.round(entry.readyMs)),
  offMedianMs: median(offRuns.map((entry) => entry.readyMs)),
  onMedianMs: median(onRuns.map((entry) => entry.readyMs)),
};

// ---------------------------------------------------------------- 断言：工具面
for (const entry of runs) {
  assert.deepEqual(
    entry.tools,
    expectedTools,
    `${entry.label}: 工具面必须正好是四个基础工具 + Sprout 工具`,
  );
  assert(
    entry.registeredTools.every((name) => allowedAnywhere.has(name)),
    `${entry.label}: registry 里只有 Sprout 工具与四个基础工具，没有宿主工具`,
  );
  // 注册了就必须声明给模型：两张表逐条相等，没有「注册了但被 allowlist 丢掉」的余量。
  assert.deepEqual(
    entry.registeredTools,
    entry.tools,
    `${entry.label}: registry 与工具面逐条相等（没有注册了却被 allowlist 丢掉的工具）`,
  );
  assert(entry.sproutStatus.declared, `${entry.label}: sprout_status 在工具面`);
  assert(entry.sproutStatus.registered, `${entry.label}: sprout_status 在 registry`);
  for (const forbidden of ["codemode", "tool_search", markers.hostExtensionTool]) {
    assert(!entry.tools.includes(forbidden), `${entry.label}: 工具面不含 ${forbidden}`);
    assert(
      !entry.registeredTools.includes(forbidden),
      `${entry.label}: registry 不含 ${forbidden}`,
    );
  }
  assert(
    entry.tools.every((name) => !name.startsWith("mcp__")) &&
      entry.registeredTools.every((name) => !name.startsWith("mcp__")),
    `${entry.label}: 没有 MCP extension 工具（未持租约时一个也没有）`,
  );
  assert.deepEqual(
    entry.extensions,
    ["sprout-extension"],
    `${entry.label}: 只加载 Sprout extension`,
  );
  assert(entry.sessionFileUnderSessionDirectory, `${entry.label}: session 文件落在本次会话目录`);
  if (entry.turn) assert(entry.sessionFileExists, `${entry.label}: 跑过一轮后 session 文件已落盘`);
}
pass(
  `工具面 ${runs.length} 次均为 ${expectedTools.length} 个工具（${expectedTools.join(", ")}），且每次 registry 与工具面逐条相等；宿主工具/mcp__/codemode/tool_search 均未出现`,
);

// ---------------------------------------------------------------- 断言：默认不继承
for (const entry of offRuns) {
  assert.equal(entry.resources.inheritHostResources, false, `${entry.label}: 开关记录为关闭`);
  assert.deepEqual(entry.resources.skills, [], `${entry.label}: 不加载任何技能`);
  assert.deepEqual(entry.resources.prompts, [], `${entry.label}: 不加载任何 prompt template`);
  assert.deepEqual(entry.resources.themes, [], `${entry.label}: 不加载任何主题`);
  assert.deepEqual(entry.resources.contextFiles, [], `${entry.label}: 不加载任何 context file`);
  assert.deepEqual(entry.resources.skillPaths, [], `${entry.label}: 没有额外技能路径`);
  assert.deepEqual(entry.resources.promptPaths, [], `${entry.label}: 没有额外 prompt 路径`);
  assert.equal(entry.resources.agentDirName, ".sprout-pi", `${entry.label}: loader 用受控目录`);
  assert(entry.resources.agentDirUnderRunCwd, `${entry.label}: 受控目录在分身 cwd 内`);
  assert(!entry.resources.agentDirEqualsHostAgentDir, `${entry.label}: 受控目录不是宿主目录`);
  assert(!entry.resources.agentDirUnderHostAgentDir, `${entry.label}: 受控目录不在宿主目录下`);
}
pass(
  `默认关闭：宿主 ${markers.hostSkill}/${markers.hostPrompt}/${markers.hostTheme}/${markers.hostContextFile}/${markers.hostExtension} 与 cwd .pi/${markers.projectA} 全部未加载`,
);

// ---------------------------------------------------------------- 断言：隔离
const [offA, offB] = [
  offRuns.find((entry) => entry.project === "a")!,
  offRuns.find((entry) => entry.project === "b")!,
];
assert.notEqual(
  offA.resources.agentDirRelative,
  offB.resources.agentDirRelative,
  "两个 Project 的分身各有自己的受控目录",
);
assert(
  offA.resources.agentDirRelative.startsWith("project-a/") &&
    offB.resources.agentDirRelative.startsWith("project-b/"),
  "受控目录归属各自的 Project cwd",
);
assert.deepEqual(offA.tools, offB.tools, "两个 Project 的默认工具面相同，没有互相串入资源");
assert.deepEqual(offA.resources.contextFiles, [], "Project A 的 AGENTS.md 未进入 loader");
assert.deepEqual(offB.resources.contextFiles, [], "Project B 的 AGENTS.md 未进入 loader");
assert.deepEqual(offA.resources.skills, [], "Project A 的 .pi/skills 未进入 loader");
assert.deepEqual(offB.resources.skills, [], "Project B 的 .pi/skills 未进入 loader");
// 同一个人设、不同的 cwd：模型实际看到的系统提示必须一样长，否则说明 cwd 内容进了提示。
assert.equal(
  offA.systemPromptChars,
  offB.systemPromptChars,
  "两个 Project 的系统提示长度相同，cwd 内容没有进提示",
);
pass(
  `隔离：A/B 受控目录 ${offA.resources.agentDirRelative} 与 ${offB.resources.agentDirRelative}，两个 AGENTS.md 与 .pi/skills 均未加载`,
);

// ---------------------------------------------------------------- 断言：真实一轮
const turnRun = runs.find((entry) => entry.label === "off-a-1")!;
assert(turnRun.turn, "off-a-1 应该跑过一轮真实对话");
assert.equal(turnRun.turn.stopReason, "stop", "真实一轮正常结束");
assert.equal(turnRun.turn.text, "p7 inheritance probe reply", "真实一轮回复来自 fixture 模型");
assert(turnRun.sessionFileExists, "真实一轮后 session 文件已落盘");
pass(
  `真实一轮（read 工具）：stop_reason=${turnRun.turn.stopReason}，${turnRun.turn.turnMs}ms，session 文件 ${turnRun.sessionFileExists ? "已落盘" : "缺失"}`,
);

// ---------------------------------------------------------------- 断言：真的调用了一次 sprout_status
const statusCall = turnRun.sproutStatusCall;
assert(statusCall, "off-a-1 这一轮里应该调过一次 sprout_status");
assert.equal(statusCall.isError, false, "sprout_status 调用不是错误结果");
const payload = statusCall.payload as {
  app?: string;
  version?: string;
  contractVersion?: number;
  host?: {
    source?: string;
    runtime?: { node?: string; pi?: string };
    host?: { inheritHostResources?: boolean; extensions?: string[] };
    session?: { model?: string; thinking?: string; activeTools?: number; registeredTools?: number };
    run?: { id?: string };
  };
  mcpSurfaceError?: string;
};
// 载荷必须是真事实，不是常量：每一条都能拿本夹具独立知道的东西对账。
assert.equal(payload.app, "sprout-mio", "载荷里的 app 是 Sprout");
assert.equal(payload.version, APP_VERSION, "载荷里的版本等于构建时注入的 APP_VERSION");
assert.equal(payload.contractVersion, CONTRACT_VERSION, "载荷里的契约版本等于 CONTRACT_VERSION");
assert(payload.host, "载荷必须带宿主实况（版本之外的运行时/开关/会话事实）");
assert.equal(payload.host!.source, "pi-host-runner", "宿主实况标明来源进程");
assert.equal(payload.host!.runtime!.node, process.versions.node, "运行时 node 版本是真实进程的");
assert(payload.host!.runtime!.pi, "运行时带 Pi SDK 版本");
assert.equal(
  payload.host!.host!.inheritHostResources,
  turnRun.resources.inheritHostResources,
  "载荷里的宿主开关等于这一轮真的用的开关",
);
assert.deepEqual(
  payload.host!.host!.extensions,
  turnRun.extensions,
  "载荷里的 extension 清单等于 ready 快照里真的加载的那份",
);
assert.equal(
  payload.host!.session!.model,
  `${turnRun.provider}/${turnRun.model}`,
  "载荷里的模型等于这一轮真的在跑的模型",
);
assert.equal(
  payload.host!.session!.thinking,
  turnRun.thinking,
  "载荷里的 thinking 等于 ready 快照里真的在用的那一档",
);
assert.equal(
  payload.host!.session!.activeTools,
  turnRun.tools.length,
  "载荷里的工具面长度等于 ready 快照的工具面长度",
);
assert.equal(
  payload.host!.session!.registeredTools,
  turnRun.registeredTools.length,
  "载荷里的 registry 长度等于 ready 快照的 registry 长度",
);
assert.equal(
  payload.host!.run!.id,
  turnRun.runId,
  "载荷里的 run id 等于这次 open 真的生成的 run id（唯一，只能是实时值）",
);
// 诊断槽的诚实性：这一轮没有任何 MCP 失败，所以不能凭空多一条错误文本；
// 真的失败时文本随工具返回的路径由 `tests/pi-host-inheritance.test.ts` 盯。
assert.equal(payload.mcpSurfaceError, undefined, "没发生 MCP 失败时 sprout_status 不得凭空报错");
pass(
  `真实调用 sprout_status：返回 ${Object.keys(payload).join("/")}，host.run.id=${payload.host!.run!.id}，工具面 ${payload.host!.session!.activeTools} 个，无凭空诊断`,
);

// ---------------------------------------------------------------- 断言：开关打开只搬 skills/prompts
for (const entry of onRuns) {
  assert.equal(entry.resources.inheritHostResources, true, `${entry.label}: 开关记录为打开`);
  // 先做「不包含 cwd 技能」：`assert.deepEqual` 会把 skills 窄化成字面量元组，之后的 includes 会报类型错。
  assert(!entry.resources.skills.includes(markers.projectA), `${entry.label}: cwd 技能不进入`);
  assert.deepEqual(entry.resources.skills, [markers.hostSkill], `${entry.label}: 宿主技能进入`);
  assert.deepEqual(
    entry.resources.prompts,
    [markers.hostPrompt],
    `${entry.label}: 宿主 prompt 进入`,
  );
  assert.deepEqual(entry.resources.themes, [], `${entry.label}: 主题仍不加载`);
  assert.deepEqual(entry.resources.contextFiles, [], `${entry.label}: context file 仍不加载`);
  assert.equal(entry.resources.agentDirName, ".sprout-pi", `${entry.label}: 仍用受控目录`);
  // 开关只多接两个宿主目录，不把 cwd 的 `.pi/*`、settings/packages 声明的技能包或别的根拉进来。
  const relativeToHost = (suffix: string) =>
    relative(directory, join(hostAgentDir, suffix)).split("\\").join("/");
  assert.deepEqual(
    entry.resources.skillPaths,
    [relativeToHost("skills")],
    `${entry.label}: 技能只来自宿主 skills 目录`,
  );
  assert.deepEqual(
    entry.resources.promptPaths,
    [relativeToHost("prompts")],
    `${entry.label}: prompt 只来自宿主 prompts 目录`,
  );
  const off = offRuns.find(
    (candidate) => candidate.project === entry.project && candidate.label.startsWith("off"),
  )!;
  assert(
    entry.systemPromptChars > off.systemPromptChars,
    `${entry.label}: 技能文本进入系统提示（${off.systemPromptChars}→${entry.systemPromptChars} 字符）`,
  );
}
pass(
  `开关打开：skills=[${markers.hostSkill}]、prompts=[${markers.hostPrompt}]，themes/contextFiles 仍为空，系统提示 ${offRuns[0]!.systemPromptChars}→${onRuns[0]!.systemPromptChars} 字符，工具面不变`,
);

// ---------------------------------------------------------------- 断言：宿主目录不被写入
assert.equal(hostAfter.digest, hostBefore.digest, "宿主 agentDir 内容前后一致，未被写入");
assert.equal(hostAfter.files, hostBefore.files, "宿主 agentDir 文件数前后一致");
for (const entry of runs)
  assert(
    !entry.resources.hostAgentDirRelative.startsWith(".."),
    `${entry.label}: 宿主目录是本夹具的私有目录，不是用户全局配置`,
  );
pass(`宿主 agentDir ${hostBefore.files} 个文件前后哈希一致，没有被 loader 或 runner 写入`);

const metadata = fixture.metadata();
fixture.assertDrained();
assert.equal(metadata.paidModelCalls, 0, "没有付费模型调用");
await fixture.close();

const evidence = {
  purpose: "Pi 分身资源继承边界：谁被加载、谁没被加载",
  sdkVersion: runs[0]!.sdkVersion,
  markers,
  expectedTools,
  // 不是「观察值」：工具面成员资格与「真的能调」都是硬断言，失败会在夹具层先红。
  sproutStatus: {
    declared: runs.every((entry) => entry.sproutStatus.declared),
    registered: runs.every((entry) => entry.sproutStatus.registered),
    call: {
      toolName: statusCall.toolName,
      isError: statusCall.isError,
      payload,
      runId: turnRun.runId,
      sessionFile: turnRun.sessionFile,
      source: "session 文件里的 toolResult entry（模型发起 → Pi 落盘 → 夹具读回解析）",
    },
  },
  runs: runs.map((entry) => ({ ...entry, readyMs: Math.round(entry.readyMs) })),
  latency: {
    offMs: latency.offMs,
    onMs: latency.onMs,
    offMedianMs: Math.round(latency.offMedianMs),
    onMedianMs: Math.round(latency.onMedianMs),
    definition: "父进程写入 open 到收到 ready 的墙钟毫秒；每次都是全新 runner 子进程",
  },
  hostTree: {
    before: hostBefore,
    after: hostAfter,
    unchanged: hostAfter.digest === hostBefore.digest,
  },
  metadata,
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
pass(
  `首轮 open→ready 中位数：关闭 ${Math.round(latency.offMedianMs)}ms，打开 ${Math.round(latency.onMedianMs)}ms（各 ${offRuns.length}/${onRuns.length} 次）`,
);
console.log(`evidence ${evidencePath}`);
