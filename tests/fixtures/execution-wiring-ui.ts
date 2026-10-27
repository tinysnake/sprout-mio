// 真实服务 + 真实 SQLite + 真实 Chromium：正式页面的日志读取与取消确实打到服务端入口。
// 执行记录、日志帧与取消记录都由领域调用写入（requestExecution / exchangeWorker / cancelExecutionFn），
// 不直接 INSERT。命令正文、日志正文、cookie 与会话 secret 都不写进证据文件。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium } from "playwright";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ExecutionView } from "../../src/contracts/remote";
import type { WorkerSession } from "../../src/contracts/worker-session";
import { sqlite } from "../../src/db";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { acquireLease } from "../../src/server/lease";
import { requestExecution } from "../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { seedRemoteActor } from "./remote-actors";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3141";
const port = new URL(base).port;
const evidence = process.env.SPROUT_WIRING_EVIDENCE ?? ".verify/p4c-wiring";
const database = process.env.DATABASE_URL;
assert(database, "DATABASE_URL 必须由 gate 传入私有库路径");
mkdirSync(evidence, { recursive: true });

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(check: () => Promise<boolean>, label: string, attempts = 100) {
  for (let n = 0; n < attempts; n++) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`timeout ${label}`);
}

const results: Record<string, unknown> = {};
const passes: string[] = [];
let page: import("playwright").Page;
async function check(label: string, run: () => Promise<void> | void) {
  try {
    await run();
  } catch (error) {
    if (page) {
      await page
        .screenshot({ path: join(evidence, `failure-${label}.png`), fullPage: true })
        .catch(() => {});
    }
    throw error;
  }
  passes.push(label);
  console.log(`PASS ${label}`);
}

/** `.output` 里编译后的 serverFn 名称 → 请求 id，用来证明浏览器请求真的到了服务端。 */
const clientReq = createRequire(
  createRequire(import.meta.resolve("@tanstack/react-start")).resolve(
    "@tanstack/start-client-core/package.json",
  ),
);
const { fromCrossJSON, toJSON } = clientReq("seroval") as {
  fromCrossJSON: (value: unknown, options: { refs: Map<unknown, unknown> }) => unknown;
  toJSON: (value: unknown) => unknown;
};

let browser: import("playwright").Browser | undefined;
let server: ReturnType<typeof spawn> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
try {
  const log = openSync(join(evidence, "production.log"), "w", 0o600);
  server = spawn(process.execPath, [".output/server/index.mjs"], {
    env: { ...process.env, DATABASE_URL: database, APP_ORIGIN: base, PORT: port, NITRO_PORT: port },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  await until(async () => {
    try {
      return (await fetch(`${base}/api/health`)).ok;
    } catch {
      return false;
    }
  }, "production server health");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  const serverFns: string[] = [];
  page.on("request", (request) => {
    const match = /\/_serverFn\/([0-9a-f]{64})$/.exec(request.url());
    if (!match) return;
    serverFns.push(match[1]!);
  });

  const email = `wiring-owner-${randomBytes(6).toString("hex")}@example.test`;
  await page.goto(`${base}/login`);
  await page.getByTestId("register-tab").click();
  await page.locator('input[name="name"]').fill("Wiring Owner");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[type="password"]').fill(randomBytes(24).toString("base64url"));
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => /^\/projects\/prj_[0-9a-f-]{36}\/chats$/.test(url.pathname));
  await page.waitForSelector('[data-testid="chat-list-content"]');

  // 真实 UI 建 Project：Project 身份来自页面，不由 fixture 猜。
  await page.click('[data-testid="project-selector"]');
  await page.click('[data-testid="new-project-trigger"]');
  await page.waitForSelector('[data-testid="project-name-input"]');
  const projectName = `Wiring ${randomBytes(3).toString("hex")}`;
  await page.fill('[data-testid="project-name-input"]', projectName);
  const previousProjectId = new URL(page.url()).pathname.split("/")[2];
  await page.click('[data-testid="project-submit"]');
  await page.waitForURL((url) => {
    const match = /^\/projects\/(prj_[0-9a-f-]{36})\/chats$/.exec(url.pathname);
    return match !== null && match[1] !== previousProjectId;
  });
  const projectId = new URL(page.url()).pathname.split("/")[2]!;
  await page.keyboard.press("Escape");

  const owner = sqlite.prepare("SELECT id FROM user WHERE email = ?").get(email) as
    | { id: string }
    | undefined;
  assert(owner, "注册账号必须落库");

  // ── 领域调用写入执行、日志与心跳：不直接 INSERT ─────────────────────────────
  const boot = sqlite
    .prepare("SELECT id FROM runtime_boot WHERE phase = 'ready' ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string } | undefined;
  assert(boot, "服务端 boot 行必须存在");
  const bootId = boot.id;
  const req = () => newId(ID_PREFIXES.request);
  const machine = createMachine(
    { name: `Wiring Mac ${randomBytes(3).toString("hex")}` },
    { userId: owner.id, requestId: req(), bootId, now: new Date() },
  );
  const machineId = machine.detail.machine.id;
  saveProjectMachineBinding(
    { machineId, projectId, description: "execution wiring gate", expectedRevision: null },
    { userId: owner.id, requestId: req(), bootId, now: new Date() },
  );
  const actor = seedRemoteActor(sqlite, owner.id, projectId, bootId);
  acquireLease(
    { projectId, machineId, action: "acquire", requestId: req(), expectedGeneration: 0 },
    actor,
  );
  const secret = randomBytes(32).toString("base64url");
  const wire = { machineId, secret, version: 3 as const, requestId: req() };
  enrollWorker({ ...wire, ticket: machine.ticket }, { bootId, now: new Date() });
  let session = openWorker(
    { ...wire, attemptId: randomUUID() },
    { bootId, now: new Date() },
  ).session;
  let seq = 0;
  type Command = {
    executionId: string;
    dispatchSession: WorkerSession;
    dispatchSeq: number;
    fingerprint: string;
  };
  const exchange = (remote: Record<string, unknown> = {}) =>
    exchangeWorker(
      {
        version: 3,
        requestId: wire.requestId,
        secret,
        session,
        seq: ++seq,
        mode: "normal",
        capability: {
          platform: "darwin",
          arch: "arm64",
          workerVersion: "wiring-fixture",
          shells: [
            {
              path: "/bin/sh",
              kind: "sh",
              version: null,
              checkedAt: new Date().toISOString(),
              probe: { kind: "success" },
            },
          ],
          remoteOperations: ["shell"],
        },
        observations: [],
        remote: {
          results: [],
          fenceAcks: [],
          logFrames: [],
          mcp: [],
          mcpCursors: [],
          ...remote,
        },
      },
      { bootId, now: new Date() },
    );
  const submit = () =>
    requestExecution(
      {
        projectId,
        machineId,
        requestId: req(),
        authorizationGeneration: 1,
        operation: { kind: "shell", command: "printf wiring", cwd: "/tmp", waitMs: 1000 },
      },
      actor,
    );
  const dispatch = (execution: ExecutionView) => {
    const command = exchange().remote.commands.find(
      (item: { executionId: string }) => item.executionId === execution.executionId,
    ) as Command | undefined;
    assert(command, "执行必须在本轮下发");
    return command;
  };
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const frame = (
    execution: ExecutionView,
    command: Command,
    sequence: number,
    text: string,
    stream: "stdout" | "stderr" = "stdout",
  ) => ({
    executionId: execution.executionId,
    projectId,
    machineId,
    authorizationGeneration: execution.authorizationGeneration,
    holderInstanceId: execution.holderInstanceId,
    dispatchSession: command.dispatchSession,
    dispatchSeq: command.dispatchSeq,
    sequence,
    stream,
    byteStart: 0,
    byteEnd: bytes(text),
    checksum: digest(text),
    bytes: text,
  });
  const gapFrame = (
    execution: ExecutionView,
    command: Command,
    sequence: number,
    gapTo: number,
  ) => ({
    executionId: execution.executionId,
    projectId,
    machineId,
    authorizationGeneration: execution.authorizationGeneration,
    holderInstanceId: execution.holderInstanceId,
    dispatchSession: command.dispatchSession,
    dispatchSeq: command.dispatchSeq,
    sequence,
    stream: "stdout" as const,
    byteStart: 0,
    byteEnd: 0,
    checksum: digest(""),
    gapTo,
  });
  const finish = (execution: ExecutionView, command: Command) => {
    exchange({
      results: [
        {
          executionId: execution.executionId,
          projectId,
          machineId,
          authorizationGeneration: execution.authorizationGeneration,
          holderInstanceId: execution.holderInstanceId,
          dispatchSession: command.dispatchSession,
          dispatchSeq: command.dispatchSeq,
          fingerprint: command.fingerprint,
          phase: "terminal",
          drained: true,
          outcome: "succeeded",
          payload: {
            kind: "shell",
            pid: 4812,
            exited: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            truncated: false,
          },
        },
      ],
    });
  };

  // 连接的能力快照由一次真实 exchange 落盘；没有它就 requestExecution 会判 machine_unavailable。
  exchange();

  // A：三帧、每帧超过一页预算的一半，第一页读不完，续读位点会推进。
  const full = submit();
  const fullCommand = dispatch(full);
  const longLine = (index: number) => `line-${String(index).padStart(4, "0")} ${"x".repeat(15980)}`;
  exchange({
    logFrames: [frame(full, fullCommand, 1, longLine(1)), frame(full, fullCommand, 2, longLine(2))],
  });
  exchange({ logFrames: [frame(full, fullCommand, 3, longLine(3))] });
  finish(full, fullCommand);

  // B：缺一帧的部分日志（1、2 已确认，4 已产出）→ partial，不是「没有输出」。
  const partial = submit();
  const partialCommand = dispatch(partial);
  // 同一轮里缺 3 号帧：ACK 只能到连续前缀 2，produced 已经是 4，所以是 partial 而不是 full。
  exchange({
    logFrames: [
      frame(partial, partialCommand, 1, "partial-1\n"),
      frame(partial, partialCommand, 2, "partial-2\n"),
      frame(partial, partialCommand, 4, "partial-4\n"),
    ],
  });
  finish(partial, partialCommand);

  // C：真正的缺口（1 号帧声明覆盖到 3）→ gap，界面必须点名缺口。
  const gap = submit();
  const gapCommand = dispatch(gap);
  exchange({
    logFrames: [gapFrame(gap, gapCommand, 1, 3), frame(gap, gapCommand, 4, "after-gap\n")],
  });
  finish(gap, gapCommand);

  // X：在旧连接上派出、永不结束；下一代会话接手后它只能是 unknown，页面不得提供重跑。
  const lost = submit();
  const lostCommand = dispatch(lost);
  assert(lostCommand);
  session = openWorker({ ...wire, attemptId: randomUUID() }, { bootId, now: new Date() }).session;
  // 每代连接的 seq 各自从 1 开始；新会话不能沿用旧连接的序号。
  seq = 0;
  exchange();

  // D：当前连接上派出的长命令，用于人类取消；心跳让连接保持在线，命令保持未终止。
  const running = submit();
  const runningCommand = dispatch(running);
  assert(runningCommand);
  heartbeat = setInterval(() => {
    try {
      exchange();
    } catch {
      // 心跳失败不改页面事实：连接会由服务端判为失联，这里不伪造在线。
    }
  }, 4000);

  results.executions = {
    full: full.executionId,
    partial: partial.executionId,
    gap: gap.executionId,
    unknown: lost.executionId,
    running: running.executionId,
  };

  const leaseUrl = `${base}/machines/${machineId}/lease?projectId=${projectId}`;
  const card = (executionId: string) => page.locator(`[data-execution-id="${executionId}"]`);
  const logOf = (executionId: string) => card(executionId).getByTestId(/item-log$/);
  const reload = async () => {
    await page.reload();
    await page.getByTestId("machine-executions-list").waitFor();
  };

  await check("Machine 详情页出现真实 executionId（来自服务端执行视图）", async () => {
    await page.goto(leaseUrl);
    await page.getByTestId("machine-executions-list").waitFor();
    const listed = await page.$$eval('[data-testid="machine-executions-item"]', (nodes) =>
      nodes.map((node) => node.getAttribute("data-execution-id") ?? ""),
    );
    const sorted = [...listed].sort((left, right) => left.localeCompare(right));
    assert.deepEqual(
      sorted,
      Object.values(results.executions as Record<string, string>).sort((left, right) =>
        left.localeCompare(right),
      ),
      "列表必须只包含这台 Machine 的真实执行",
    );
    await page.screenshot({ path: join(evidence, "machine-list.png"), fullPage: true });
  });

  await check("读取日志真的到服务端：第一页 2 帧、续读后位点推进到 #3", async () => {
    const target = logOf(full.executionId);
    await target.getByTestId("machine-executions-item-log-load").click();
    await target.getByTestId("machine-executions-item-log-frame").first().waitFor();
    assert.equal(await target.getByTestId("machine-executions-item-log-frame").count(), 2);
    assert.match(
      await target.getByTestId("machine-executions-item-log-next-cursor").innerText(),
      /#2/,
    );
    await target.getByTestId("machine-executions-item-log-resume").click();
    // 续读显示的是下一段（一页一页读），不是把旧页拼起来。
    await until(
      async () =>
        (await target.getByTestId("machine-executions-item-log-frame").count()) === 1 &&
        /已产出到 #3/.test(
          await target.getByTestId("machine-executions-item-log-cursors").innerText(),
        ),
      "resume frames",
    );
    assert.match(
      await target.getByTestId("machine-executions-item-log-frame").first().innerText(),
      /#3 out line-0003/,
    );
    assert.match(
      await target.getByTestId("machine-executions-item-log-next-cursor").innerText(),
      /#3/,
    );
    assert.match(await target.getByTestId("machine-executions-item-log-state").innerText(), /完整/);
    await page.screenshot({ path: join(evidence, "machine-log-pages.png"), fullPage: true });
  });

  await check("反证：partial 与 gap 都显示为不完整，缺口单独点名且不当作空输出", async () => {
    const partialLog = logOf(partial.executionId);
    await partialLog.getByTestId("machine-executions-item-log-load").click();
    // 先等这一页真的读回来，再断言呈现；不完整提示在读取前就已经存在，不能拿它当读取完成的信号。
    await partialLog.getByTestId("machine-executions-item-log-frame").first().waitFor();
    await partialLog.getByTestId("machine-executions-item-log-incomplete").waitFor();
    assert.match(
      await partialLog.getByTestId("machine-executions-item-log-state").innerText(),
      /不完整/,
    );
    assert.equal(
      await partialLog.getByTestId("machine-executions-item-log-gap").count(),
      0,
      "partial 不得凭空造出缺口",
    );
    assert.equal(await partialLog.getByTestId("machine-executions-item-log-frame").count(), 3);
    const gapLog = logOf(gap.executionId);
    await gapLog.getByTestId("machine-executions-item-log-load").click();
    await gapLog.getByTestId("machine-executions-item-log-gap").waitFor();
    assert.match(await gapLog.getByTestId("machine-executions-item-log-state").innerText(), /缺口/);
    assert.match(
      await gapLog.getByTestId("machine-executions-item-log-gap").innerText(),
      /缺失.*内容未知/,
    );
    await page.screenshot({ path: join(evidence, "machine-log-incomplete.png"), fullPage: true });
  });

  await check("尚无日志的执行显示「尚无日志」，不写成功也不写空", async () => {
    const target = logOf(running.executionId);
    assert.equal(
      (await target.getByTestId("machine-executions-item-log-state").innerText()).trim(),
      "尚无日志",
    );
    assert.equal(await target.getByTestId("machine-executions-item-log-incomplete").count(), 0);
    assert.equal(await target.getByTestId("machine-executions-item-log-empty-range").count(), 0);
  });

  await check("取消是显式动作：显示请求事实，执行终态不被改写为已停止", async () => {
    const target = card(running.executionId);
    assert.equal(await target.getAttribute("data-execution-state"), "dispatched");
    await target.getByTestId("machine-executions-item-cancel-request").click();
    const state = target.getByTestId("machine-executions-item-cancel-state");
    await state.waitFor();
    const cancellationState = await state.getAttribute("data-cancellation-state");
    assert.ok(
      cancellationState === "requested" || cancellationState === "delivered",
      `取消状态是显式事实，实际 ${cancellationState}`,
    );
    assert.equal(await state.getAttribute("data-stopped"), "false");
    assert.equal(await target.getAttribute("data-execution-state"), "dispatched");
    await page.screenshot({ path: join(evidence, "machine-cancel.png"), fullPage: true });
  });

  await check("刷新后取消事实仍在（来自 executionView.cancellation），不显示为已停止", async () => {
    await reload();
    const state = card(running.executionId).getByTestId("machine-executions-item-cancel-state");
    await state.waitFor();
    const cancellationState = await state.getAttribute("data-cancellation-state");
    // 心跳可能把 requested 推进到 delivered；15 秒内没有 durable result 则记 delivery_unconfirmed。
    // 三种都是取消事实，唯一的反证是它不能被写成「已停止」。
    assert.ok(
      cancellationState === "requested" ||
        cancellationState === "delivered" ||
        cancellationState === "failed",
      `刷新后的取消状态 ${cancellationState}`,
    );
    assert.equal(await state.getAttribute("data-stopped"), "false");
    results.cancellationAfterReload = cancellationState;
  });

  await check("unknown 执行没有重跑入口，也不伪装成已知结果", async () => {
    const target = card(lost.executionId);
    assert.equal(await target.getAttribute("data-execution-state"), "unknown");
    await target.getByTestId("machine-executions-item-no-rerun").waitFor();
    assert.equal(
      await target.getByRole("button", { name: /重跑|重新运行/ }).count(),
      0,
      "unknown 上不得出现重跑入口",
    );
  });

  await check("断线时明说不完整，读取失败不推进位点", async () => {
    const target = logOf(full.executionId);
    await target.getByTestId("machine-executions-item-log-load").click();
    await until(
      async () => (await target.getByTestId("machine-executions-item-log-frame").count()) === 2,
      "online page read",
    );
    const before = await target.getByTestId("machine-executions-item-log-cursors").innerText();
    const beforeCursor = await target
      .getByTestId("machine-executions-item-log-next-cursor")
      .innerText();
    await context.setOffline(true);
    await page.getByTestId("machine-executions-offline").waitFor();
    await target.getByTestId("machine-executions-item-log-offline").waitFor();
    await target.getByTestId("machine-executions-item-log-load").click();
    await target.getByTestId("machine-executions-item-log-error").waitFor();
    assert.equal(
      await target.getByTestId("machine-executions-item-log-cursors").innerText(),
      before,
      "断线不得让位点前进",
    );
    assert.equal(
      await target.getByTestId("machine-executions-item-log-next-cursor").innerText(),
      beforeCursor,
    );
    await page.screenshot({ path: join(evidence, "machine-offline.png"), fullPage: true });
    await context.setOffline(false);
  });

  await check("Project settings 用同一服务端入口读取日志", async () => {
    await page.goto(`${base}/projects/${projectId}/settings`);
    await page.getByTestId("settings-executions-list").waitFor();
    const target = card(full.executionId);
    await target.getByTestId("settings-executions-item-log-load").click();
    await target.getByTestId("settings-executions-item-log-frame").first().waitFor();
    assert.equal(await target.getByTestId("settings-executions-item-log-frame").count(), 2);
    assert.match(
      await target.getByTestId("settings-executions-item-log-state").innerText(),
      /完整/,
    );
    await page.screenshot({ path: join(evidence, "settings-log.png"), fullPage: true });
  });

  await check("Chat inspector 只读掠影，并写明读取与取消在 Machine 详情页", async () => {
    await page.goto(`${base}/projects/${projectId}/chats/${actor.chatId}?info=1`);
    await page.getByTestId("chat-executions").waitFor();
    const note = page.getByTestId("chat-executions-read-only");
    await note.waitFor();
    const text = (await note.innerText()).trim();
    assert.match(text, /只读/);
    assert.match(text, /Machine 详情页/);
    assert.equal(await page.getByTestId("chat-executions-item-log-load").count(), 0);
    assert.equal(await page.getByTestId("chat-executions-item-cancel-request").count(), 0);
    assert.equal(await page.getByTestId("chat-executions-not-wired").count(), 0);
    await page.screenshot({ path: join(evidence, "inspector-read-only.png"), fullPage: true });
  });

  const serverFnNames = (() => {
    try {
      const walk = (path: string): string[] =>
        readdirSync(path, { withFileTypes: true }).flatMap((item) =>
          item.isDirectory()
            ? walk(join(path, item.name))
            : item.name.endsWith(".mjs")
              ? [readFileSync(join(path, item.name), "utf8")]
              : [],
        );
      return Object.fromEntries(
        [
          ...walk(".output/server")
            .join("\n")
            .matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g),
        ].map((match) => [match[2]!, match[1]!]),
      ) as Record<string, string>;
    } catch {
      return {};
    }
  })();

  await check("浏览器请求确实打到 readExecutionLogFn / cancelExecutionFn", () => {
    const readId = serverFnNames.readExecutionLogFn;
    const cancelId = serverFnNames.cancelExecutionFn;
    assert.ok(readId && cancelId, "生产包必须注册两个 serverFn");
    const readCalls = serverFns.filter((id) => id === readId).length;
    const cancelCalls = serverFns.filter((id) => id === cancelId).length;
    assert.ok(readCalls >= 4, `日志读取必须真的到服务端，实际 ${readCalls} 次`);
    assert.equal(cancelCalls, 1, "取消只发一次");
    results.serverFnCalls = { readExecutionLogFn: readCalls, cancelExecutionFn: cancelCalls };
  });

  await check("反证：另一个用户读日志与取消都被拒绝，页面显示错误而不是空或成功", async () => {
    const strangerContext = await browser!.newContext({ viewport: { width: 1440, height: 1000 } });
    const stranger = await strangerContext.newPage();
    stranger.setDefaultTimeout(20000);
    const strangerEmail = `wiring-stranger-${randomBytes(6).toString("hex")}@example.test`;
    await stranger.goto(`${base}/login`);
    await stranger.getByTestId("register-tab").click();
    await stranger.locator('input[name="name"]').fill("Wiring Stranger");
    await stranger.locator('input[name="email"]').fill(strangerEmail);
    await stranger.locator('input[type="password"]').fill(randomBytes(24).toString("base64url"));
    await stranger.locator('button[type="submit"]').click();
    await stranger.waitForURL((url) => /^\/projects\/prj_[0-9a-f-]{36}\/chats$/.test(url.pathname));

    const rpc = async (name: string, data: unknown) => {
      const id = serverFnNames[name];
      assert.ok(id, `生产包必须注册 ${name}`);
      const response = await strangerContext.request.post(`${base}/_serverFn/${id}`, {
        headers: { "content-type": "application/json", "x-tsr-serverfn": "true", origin: base },
        data: JSON.stringify(toJSON({ data })),
      });
      assert.equal(response.status(), 200);
      const encoded = (await response.json()) as { t?: unknown };
      const decoded = (encoded.t ? fromCrossJSON(encoded, { refs: new Map() }) : encoded) as {
        result?: unknown;
      };
      return decoded.result ?? decoded;
    };
    const foreignRead = await rpc("readExecutionLogFn", {
      projectId,
      machineId,
      executionId: full.executionId,
      cursor: null,
      limitBytes: 32768,
    });
    assert.deepEqual(
      (foreignRead as { ok: boolean; error?: { code: string } }).ok,
      false,
      "非成员读日志必须被拒绝",
    );
    assert.equal((foreignRead as { error?: { code: string } }).error?.code, "not_found");
    const foreignCancel = await rpc("cancelExecutionFn", {
      executionId: running.executionId,
      requestId: newId(ID_PREFIXES.request),
    });
    assert.equal((foreignCancel as { ok: boolean }).ok, false);
    assert.equal((foreignCancel as { error?: { code: string } }).error?.code, "not_found");

    await stranger.goto(leaseUrl);
    await stranger.getByTestId("result-error").waitFor();
    const text = await stranger.getByTestId("result-error").innerText();
    assert.match(text, /not_found/);
    assert.ok(!(await stranger.getByTestId("machine-executions-list").count()));
    await stranger.screenshot({ path: join(evidence, "stranger-refused.png"), fullPage: true });
    await strangerContext.close();
  });

  writeFileSync(
    join(evidence, "results.json"),
    `${JSON.stringify({ base, projectId, machineId, passes, ...results }, null, 2)}\n`,
  );
  console.log(`PASS execution wiring evidence ${evidence}`);
} finally {
  if (heartbeat) clearInterval(heartbeat);
  await browser?.close().catch(() => {});
  if (server && !server.killed) server.kill("SIGTERM");
}
