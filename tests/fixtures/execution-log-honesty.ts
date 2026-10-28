// 真实生产包 + 真实服务 + 私有 SQLite + 真实 Chromium + 真实 Worker 登记表/outbox + 真实子进程。
// 证明三件事：Worker 还有未确认产出时日志不是 `full`；补送完成后按预算得到 `truncated` 或 `full`；
// `full` 只在 Worker 声明 `sealed` 且已确认前缀覆盖全部产出时出现，伪造事实越不过服务端归约。
// 会话 secret、runner token、命令正文、日志正文与截图只留在临时证据目录，不写进标准输出。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { WorkerSession } from "../../src/contracts/worker-session";
import { sqlite } from "../../src/db";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { isIncompleteLogState } from "../../src/components/machine/presentation";
import { acquireLease } from "../../src/server/lease";
import { getExecution, readExecutionLog, requestExecution } from "../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { ExecutionRegistry, ExecutionStore } from "../../src/worker/executions";
import { RemoteDispatcher } from "../../src/worker/remote";
import { seedRemoteActor } from "./remote-actors";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3152";
const port = new URL(base).port;
const evidence = process.env.SPROUT_LOG_HONESTY_EVIDENCE ?? ".verify/p4c-log-honesty";
const database = process.env.DATABASE_URL;
assert(database, "DATABASE_URL 必须由 gate 传入私有库路径");
mkdirSync(evidence, { recursive: true });

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(check: () => Promise<boolean> | boolean, label: string, attempts = 900) {
  for (let n = 0; n < attempts; n++) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`timeout ${label}`);
}
const more = async (check: () => Promise<boolean> | boolean, label: string, attempts = 900) => {
  for (let n = 0; n < attempts; n++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error(`timeout ${label}`);
};

const passes: string[] = [];
const facts: Record<string, unknown> = {};
const check = (label: string) => {
  passes.push(label);
  console.log(`PASS ${label}`);
};
let page: import("playwright").Page;
let browser: import("playwright").Browser | undefined;
let server: ReturnType<typeof spawn> | undefined;
const stateDirectory = mkdtempSync(join(tmpdir(), "p4c-log-honesty-state-"));
const executionFiles = (executionId: string) => {
  const directory = join(stateDirectory, "executions", executionId);
  if (!existsSync(directory)) return [] as string[];
  return ([] as string[]).concat(
    ...["claim.json", "frames.jsonl", "result.json"].filter((name) =>
      existsSync(join(directory, name)),
    ),
  );
};

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

  const email = `log-honesty-${randomBytes(6).toString("hex")}@example.test`;
  await page.goto(`${base}/login`);
  await page.getByTestId("register-tab").click();
  await page.locator('input[name="name"]').fill("Log Honesty");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[type="password"]').fill(randomBytes(24).toString("base64url"));
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => /^\/projects\/prj_[0-9a-f-]{36}\/chats$/.test(url.pathname));
  await page.waitForSelector('[data-testid="chat-list-content"]');

  await page.click('[data-testid="project-selector"]');
  await page.click('[data-testid="new-project-trigger"]');
  await page.waitForSelector('[data-testid="project-name-input"]');
  const previousProjectId = new URL(page.url()).pathname.split("/")[2];
  await page.fill(
    '[data-testid="project-name-input"]',
    `Log Honesty ${randomBytes(3).toString("hex")}`,
  );
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
  const boot = sqlite
    .prepare("SELECT id FROM runtime_boot WHERE phase = 'ready' ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string } | undefined;
  assert(boot, "服务端 boot 行必须存在");
  const bootId = boot.id;
  const req = () => newId(ID_PREFIXES.request);
  const actor = seedRemoteActor(sqlite, owner.id, projectId, bootId);
  const machine = createMachine(
    { name: `Log Honesty Mac ${randomBytes(3).toString("hex")}` },
    { userId: owner.id, requestId: req(), bootId, now: new Date() },
  );
  const machineId = machine.detail.machine.id;
  saveProjectMachineBinding(
    { machineId, projectId, description: "execution log honesty gate", expectedRevision: null },
    { userId: owner.id, requestId: req(), bootId, now: new Date() },
  );
  acquireLease(
    { projectId, machineId, action: "acquire", requestId: req(), expectedGeneration: 0 },
    actor,
  );
  const key = { projectId, machineId };
  const secret = randomBytes(32).toString("base64url");
  const wire = { machineId, secret, version: 3 as const, requestId: req() };
  enrollWorker({ ...wire, ticket: machine.ticket }, { bootId, now: new Date() });
  let session: WorkerSession = openWorker(
    { ...wire, attemptId: randomUUID() },
    { bootId, now: new Date() },
  ).session;
  let seq = 0;
  const capability = {
    platform: "darwin" as const,
    arch: "arm64" as const,
    workerVersion: "log-honesty",
    shells: [
      {
        path: "/bin/sh",
        kind: "sh" as const,
        version: null,
        checkedAt: new Date().toISOString(),
        probe: { kind: "success" as const },
      },
    ],
    remoteOperations: ["shell" as const],
  };
  const exchange = (remote: Record<string, unknown> = {}) => {
    const used = ++seq;
    const response = exchangeWorker(
      {
        version: 3,
        requestId: wire.requestId,
        secret,
        session,
        seq: used,
        mode: "normal",
        capability,
        observations: [],
        remote: { results: [], fenceAcks: [], mcp: [], mcpCursors: [], ...remote } as never,
      },
      { bootId, now: new Date() },
    );
    return { used, response };
  };
  exchange();
  const worker = new RemoteDispatcher(
    session,
    capability as never,
    Date.now,
    undefined as never,
    new ExecutionRegistry(new ExecutionStore(stateDirectory), Date.now),
  );
  const round = () => {
    const outgoing = worker.outgoing(1048576);
    const { used, response } = exchange(outgoing as never);
    worker.accept(response, used, []);
  };
  const submit = (command: string, waitMs = 1000) =>
    requestExecution(
      {
        ...key,
        requestId: req(),
        authorizationGeneration: 1,
        operation: { kind: "shell", command, cwd: "/tmp", waitMs },
      },
      actor,
    );
  const view = (executionId: string) => getExecution({ ...key, executionId }, actor);
  const logOf = (
    executionId: string,
    cursor: { executionId: string; nextSequence: number } | null,
  ) => readExecutionLog({ ...key, executionId, cursor, limitBytes: 65536 }, actor);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const card = (executionId: string) =>
    page.locator(`[data-execution-id="${executionId}"]`).getByTestId(/item-log$/);
  const openCardLog = async (executionId: string) => {
    await page.goto(`${base}/machines/${machineId}/lease?projectId=${projectId}`);
    await page.getByTestId("machine-executions-list").waitFor();
    await card(executionId).getByTestId("machine-executions-item-log-load").click();
  };

  // ── 场景 1：大输出后冻结 Worker，宿主只收到一部分帧 ─────────────────────────
  const burst = submit("head -c 1900000 /dev/zero | tr '\\0' 'x'", 1000);
  await more(() => {
    round();
    const current = view(burst.executionId);
    return (
      current.terminalAt !== null && worker.registry.runs.get(burst.executionId)?.settled === true
    );
  }, "burst terminal ack");
  // 冻结 Worker：不再 exchange，outbox 与 durable claim 留在磁盘上。
  const paused = view(burst.executionId);
  const pausedLog = logOf(burst.executionId, null);
  assert.notEqual(paused.terminalAt, null, "1.9 MB 输出必须收敛到终态");
  assert.equal(paused.state, "succeeded");
  assert.ok(
    (paused.acknowledgedThroughSequence ?? 0) < (paused.producedThroughSequence ?? 0),
    "终态 ACK 时宿主只收到一部分帧：已确认前缀必须小于 Worker 声明的产出位点",
  );
  assert.notEqual(paused.logState, "full", "还有未确认产出时 API 不得宣称日志完整");
  assert.equal(isIncompleteLogState(pausedLog.logState), true, "读取视图必须如实说不完整");
  assert.ok(
    executionFiles(burst.executionId).includes("claim.json") &&
      executionFiles(burst.executionId).includes("frames.jsonl"),
    "冻结现场必须保留 durable outbox，补送才有依据",
  );
  const pausedClaim = JSON.parse(
    readFileSync(join(stateDirectory, "executions", burst.executionId, "claim.json"), "utf8"),
  ) as { producedThroughSequence: number | null };
  assert.ok(
    (pausedClaim.producedThroughSequence ?? 0) > (paused.acknowledgedThroughSequence ?? 0),
    "Worker durable claim 的产出位点必须高于宿主已确认前缀",
  );
  facts.scenario1 = {
    executionId: burst.executionId,
    logState: paused.logState,
    produced: paused.producedThroughSequence,
    acknowledged: paused.acknowledgedThroughSequence,
    availableFrom: paused.availableFromSequence,
    workerProduced: pausedClaim.producedThroughSequence,
  };
  check("场景①：大输出后冻结 Worker，API 读取不是 full 且 durable outbox 仍在");

  // 真实 Chromium：同一现场，页面必须显示不完整，不得写「日志完整」。
  await openCardLog(burst.executionId);
  await page.getByTestId("machine-executions-item-log-incomplete").waitFor();
  const pausedStateText = await card(burst.executionId)
    .getByTestId("machine-executions-item-log-state")
    .innerText();
  assert.match(pausedStateText, /不完整/);
  assert.equal(/日志完整/.test(pausedStateText), false);
  await page.screenshot({ path: join(evidence, "paused-incomplete.png"), fullPage: true });
  check("场景①：真实 Chromium 页面显示不完整，不显示日志完整");

  // ── 场景 2：恢复 Worker 补送，最终按预算 truncated ─────────────────────────
  await more(() => {
    round();
    return !executionFiles(burst.executionId).includes("claim.json");
  }, "burst backfill");
  const burstFinal = view(burst.executionId);
  const burstFinalLog = logOf(burst.executionId, {
    executionId: burst.executionId,
    nextSequence: (burstFinal.availableFromSequence ?? 1) - 1,
  });
  assert.equal(burstFinalLog.logState, "truncated", "1.9 MB 超出 1 MiB 预算，最终必须是 truncated");
  assert.ok((burstFinal.availableFromSequence ?? 1) > 1, "裁剪必须推进可读起点");
  assert.equal(
    burstFinal.acknowledgedThroughSequence,
    burstFinal.producedThroughSequence,
    "补送完成后已确认前缀覆盖全部产出",
  );
  assert.equal(
    executionFiles(burst.executionId).includes("claim.json"),
    false,
    "封口事实与日志 ACK 都到位后 outbox 才清理",
  );
  facts.scenario2 = {
    logState: burstFinal.logState,
    produced: burstFinal.producedThroughSequence,
    acknowledged: burstFinal.acknowledgedThroughSequence,
    availableFrom: burstFinal.availableFromSequence,
  };
  check("场景②：恢复补送后按默认预算得到 truncated，且 ACK 覆盖全部产出");

  // ── 场景 3：小输出、Worker 已封口、全部 ACK → full ─────────────────────────
  const full = submit("printf 'small-full-log\\n'", 1000);
  await more(() => {
    round();
    return (
      view(full.executionId).terminalAt !== null &&
      !executionFiles(full.executionId).includes("claim.json")
    );
  }, "small full");
  const fullView = view(full.executionId);
  const fullLog = logOf(full.executionId, null);
  assert.equal(fullView.logState, "full", "Worker 已封口且全部 ACK 时才允许 full");
  assert.equal(fullLog.logState, "full");
  assert.equal(
    fullView.acknowledgedThroughSequence,
    fullView.producedThroughSequence,
    "full 的前提是已确认前缀覆盖全部产出",
  );
  await openCardLog(full.executionId);
  await page.getByTestId("machine-executions-item-log-frame").first().waitFor();
  const fullStateText = await card(full.executionId)
    .getByTestId("machine-executions-item-log-state")
    .innerText();
  assert.match(fullStateText, /日志完整/);
  await page.screenshot({ path: join(evidence, "sealed-full.png"), fullPage: true });
  facts.scenario3 = {
    executionId: full.executionId,
    logState: fullView.logState,
    produced: fullView.producedThroughSequence,
    acknowledged: fullView.acknowledgedThroughSequence,
  };
  check("场景③：sealed 且全部 ACK 时 API 与真实页面才是日志完整");

  // ── 场景 4：伪造 sealed 但 produced > acked 时不得判 full ──────────────────
  const forged = submit("printf 'forged-sealed\\n'", 1000);
  const command = exchange().response.remote.commands.find(
    (item: { executionId: string }) => item.executionId === forged.executionId,
  ) as { dispatchSession: WorkerSession; dispatchSeq: number; fingerprint: string } | undefined;
  assert(command, "伪造场景需要一个真实下发");
  const frame = (sequence: number, text: string) => ({
    ...key,
    executionId: forged.executionId,
    authorizationGeneration: forged.authorizationGeneration,
    holderInstanceId: forged.holderInstanceId,
    dispatchSession: command.dispatchSession,
    dispatchSeq: command.dispatchSeq,
    sequence,
    stream: "stdout" as const,
    byteStart: 0,
    byteEnd: bytes(text),
    checksum: digest(text),
    bytes: text,
  });
  const fact = (producedThroughSequence: number, sealed: boolean) => ({
    ...key,
    executionId: forged.executionId,
    authorizationGeneration: forged.authorizationGeneration,
    holderInstanceId: forged.holderInstanceId,
    producedThroughSequence,
    sealed,
  });
  exchange({ logFrames: [frame(1, "forged-1\n"), frame(2, "forged-2\n")] });
  exchange({ logFacts: [fact(5, true)] });
  const forgedGap = view(forged.executionId);
  assert.equal(forgedGap.logState, "partial", "sealed 不能越过「已确认前缀 < 产出位点」");
  assert.equal(forgedGap.acknowledgedThroughSequence, 2);
  assert.equal(forgedGap.producedThroughSequence, 5);
  exchange({ logFrames: [frame(3, "forged-3\n"), frame(4, "forged-4\n")] });
  assert.notEqual(view(forged.executionId).logState, "full", "仍缺 5 号帧，不得提前判 full");
  exchange({ logFrames: [frame(5, "forged-5\n")] });
  const forgedFull = view(forged.executionId);
  assert.equal(forgedFull.logState, "full", "帧补齐且 sealed 后才是 full");
  exchange({ logFacts: [fact(6, false)] });
  assert.equal(
    view(forged.executionId).logState,
    "partial",
    "收到「还有产出」的事实后 full 必须回退为 partial",
  );
  exchange({ logFacts: [fact(6, true)] });
  assert.equal(view(forged.executionId).logState, "partial", "sealed 但仍有未送达帧时仍是 partial");
  exchange({ logFrames: [frame(6, "forged-6\n")] });
  assert.equal(view(forged.executionId).logState, "full");
  facts.scenario4 = {
    executionId: forged.executionId,
    forgedSealed: "produced=5 ack=2 → partial",
    regression: "full → partial on sealed=false fact",
    refilled: "frame 6 + sealed → full",
  };
  check("场景④：伪造 sealed 但 produced > acked 不得判 full；full 可回退并再次成立");

  // 反证：事实不能描述别的 holder 的执行。
  assert.throws(
    () =>
      exchange({
        logFacts: [{ ...fact(7, true), holderInstanceId: newId(ID_PREFIXES.instance) }],
      }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "not_found",
  );
  check("场景④反证：跨 holder 的日志位点事实被拒绝，不能借新连接伪造封口");

  writeFileSync(
    join(evidence, "results.json"),
    `${JSON.stringify({ base, projectId, machineId, passes, facts }, null, 2)}\n`,
  );
  console.log(`PASS execution log honesty evidence ${evidence}`);
} finally {
  await browser?.close().catch(() => {});
  if (server && !server.killed) server.kill("SIGTERM");
}
