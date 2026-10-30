// I-P4d 页面门禁：真实生产包 + 真实 SQLite + 真实 Chromium。
// 关系、待处理、移出、强制收回、重新加入与历史全部由领域调用写入（saveProjectMachineBinding /
// acquireLease / reclaimLease / releaseLease / detachMachine / rejoinProjectMachine），
// 不直接 INSERT 业务行。断言只读正式页面的 data-testid 与可见文本，不用文案全文当主选择器。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { LeaseKey } from "../../src/contracts/lease";
import type { ExecutionView } from "../../src/contracts/remote";
import { db, sqlite } from "../../src/db";
import { leaseMutation, machineLease, projectMachine, remoteExecution } from "../../src/db/schema";
import type { MachineContext } from "../../src/domain/machine";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import {
  acquireLease,
  reclaimLease,
  releaseLease,
  type AgentRemoteContext,
} from "../../src/server/lease";
import {
  detachMachine,
  latestMembership,
  membershipViewFor,
  rejoinProjectMachine,
} from "../../src/server/membership";
import { requestExecution } from "../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { seedRemoteActor } from "./remote-actors";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3142";
const port = new URL(base).port;
const evidence = process.env.SPROUT_PAGES_EVIDENCE ?? ".verify/p4d-pages";
const database = process.env.DATABASE_URL;
assert(database, "DATABASE_URL 必须由 gate 传入私有库路径");
mkdirSync(evidence, { recursive: true });

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(check: () => Promise<boolean> | boolean, label: string, attempts = 120) {
  for (let n = 0; n < attempts; n++) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`timeout ${label}`);
}

const results: Record<string, unknown> = {};
const passes: string[] = [];
const screenshots: Record<string, string> = {};
let activePage: Page | undefined;
let currentLabel = "setup";
async function shoot(name: string) {
  if (!activePage) return;
  const path = join(evidence, `${name}.png`);
  await activePage.screenshot({ path, fullPage: true }).catch(() => {});
  screenshots[currentLabel] = path;
}
async function check(label: string, run: () => Promise<void> | void) {
  currentLabel = label;
  const slug = label.replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 60);
  try {
    await run();
  } catch (error) {
    await shoot(`failure-${slug}`);
    throw error;
  }
  passes.push(label);
  await shoot(slug);
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

type RelationSnapshot = { url: string; contentType: string; body: Buffer; text: string };
const relationSnapshots = new WeakMap<Page, RelationSnapshot>();
const serverFnCalls = new Map<string, number>();
function watchPage(page: Page) {
  page.on("request", (request) => {
    const match = /\/_serverFn\/([0-9a-f]{64})$/.exec(request.url());
    if (!match) return;
    const id = match[1]!;
    const name = Object.keys(serverFnNames).find((key) => serverFnNames[key] === id) ?? id;
    serverFnCalls.set(name, (serverFnCalls.get(name) ?? 0) + 1);
  });
  const relationsId = serverFnNames.projectMachineRelationsFn;
  if (!relationsId) return;
  page.on("response", (response) => {
    void (async () => {
      try {
        if (!response.url().endsWith(`/_serverFn/${relationsId}`)) return;
        if (response.request().method() !== "POST") return;
        const body = await response.body();
        relationSnapshots.set(page, {
          url: response.url(),
          contentType: response.headers()["content-type"] ?? "application/json",
          body,
          text: body.toString("utf8"),
        });
      } catch {
        // 响应体读不到就不当快照用；调用方会等下一次刷新。
      }
    })();
  });
}
function fnCalls(name: string) {
  return serverFnCalls.get(name) ?? 0;
}

let browser: Browser | undefined;
let server: ReturnType<typeof spawn> | undefined;
const heartbeats: ReturnType<typeof setInterval>[] = [];
const startedAt = Date.now();

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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  watchPage(page);
  activePage = page;

  // ── 账号：真实注册路径；Project / Machine 由夹具用领域调用创建 ────────────────
  const email = `pages-owner-${randomBytes(6).toString("hex")}@example.test`;
  await page.goto(`${base}/login`);
  await page.getByTestId("register-tab").click();
  await page.locator('input[name="name"]').fill("Pages Owner");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[type="password"]').fill(randomBytes(24).toString("base64url"));
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => /^\/projects\/prj_[0-9a-f-]{36}\/chats$/.test(url.pathname));
  await page.keyboard.press("Escape");

  const owner = sqlite.prepare("SELECT id FROM user WHERE email = ?").get(email) as
    | { id: string }
    | undefined;
  assert(owner, "注册账号必须落库");
  const ownerId = owner.id;
  const boot = sqlite
    .prepare("SELECT id FROM runtime_boot WHERE phase = 'ready' ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string } | undefined;
  assert(boot, "服务端 boot 行必须存在");
  const bootId = boot.id;

  const req = () => newId(ID_PREFIXES.request);
  const human = (): MachineContext => ({
    userId: ownerId,
    requestId: req(),
    bootId,
    now: new Date(),
  });
  const createProject = (name: string) => {
    const projectId = newId(ID_PREFIXES.project);
    sqlite
      .prepare("INSERT INTO project(id,name,created_by) VALUES (?,?,?)")
      .run(projectId, name, ownerId);
    return projectId;
  };
  const p1 = createProject("P1 当前资源");
  const p2 = createProject("P2 移出流程");

  const revision = (projectId: string, machineId: string) =>
    db
      .select()
      .from(projectMachine)
      .where(and(eq(projectMachine.projectId, projectId), eq(projectMachine.machineId, machineId)))
      .get()?.revision ?? null;
  const leaseRow = (key: LeaseKey) =>
    db
      .select()
      .from(machineLease)
      .where(
        and(eq(machineLease.projectId, key.projectId), eq(machineLease.machineId, key.machineId)),
      )
      .get();
  const mutationRows = (key: LeaseKey) =>
    db
      .select()
      .from(leaseMutation)
      .where(
        and(eq(leaseMutation.projectId, key.projectId), eq(leaseMutation.machineId, key.machineId)),
      )
      .all();
  const stateOf = (key: LeaseKey) => latestMembership(key)?.state ?? "missing";
  const epochOf = (key: LeaseKey) => latestMembership(key)?.epoch ?? null;
  const createActor = (projectId: string) =>
    seedRemoteActor(sqlite, ownerId, projectId, bootId) satisfies AgentRemoteContext;

  let sequence = 0;
  function newMachine(projectId: string | null, label: string) {
    sequence += 1;
    const ctx = human();
    const settled = createMachine(
      { name: `P4D ${label} ${sequence}` },
      { ...ctx, now: new Date() },
    );
    const machineId = settled.detail.machine.id;
    if (projectId)
      saveProjectMachineBinding(
        { projectId, machineId, description: `p4d pages ${label}`, expectedRevision: null },
        ctx,
      );
    return { machineId, name: `P4D ${label} ${sequence}`, ticket: settled.ticket };
  }

  type Dispatched = { dispatchSession: unknown; dispatchSeq: number; fingerprint: string };
  type Wire = {
    exchange: (remote?: Record<string, unknown>) => ReturnType<typeof exchangeWorker>;
    submit: () => ExecutionView;
    finish: (execution: ExecutionView, outcome?: "succeeded" | "failed") => void;
  };
  /** 真实 Worker 网关：enroll + open + capability exchange；心跳只维持在线事实。 */
  function wire(
    projectId: string,
    machine: { machineId: string; ticket: string },
    actor: AgentRemoteContext,
  ): Wire {
    const secret = randomBytes(32).toString("base64url");
    const wireInput = {
      machineId: machine.machineId,
      secret,
      version: 3 as const,
      requestId: req(),
    };
    enrollWorker({ ...wireInput, ticket: machine.ticket }, { bootId, now: new Date() });
    const session = openWorker(
      { ...wireInput, attemptId: randomUUID() },
      { bootId, now: new Date() },
    ).session;
    let seq = 0;
    const dispatched = new Map<string, Dispatched>();
    const exchange = (remote: Record<string, unknown> = {}) =>
      exchangeWorker(
        {
          version: 3,
          requestId: wireInput.requestId,
          secret,
          session,
          seq: ++seq,
          mode: "normal",
          capability: {
            platform: "darwin",
            arch: "arm64",
            workerVersion: "pages-fixture",
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
    exchange();
    const submit = () => {
      const execution = requestExecution(
        {
          projectId,
          machineId: machine.machineId,
          requestId: req(),
          authorizationGeneration: 1,
          operation: { kind: "shell", command: "printf p4d-pages", cwd: "/tmp", waitMs: 1000 },
        },
        actor,
      );
      const found = (exchange().remote.commands as { executionId: string }[]).find(
        (item) => item.executionId === execution.executionId,
      ) as Dispatched | undefined;
      assert(found, "执行必须在本轮下发到 Worker");
      dispatched.set(execution.executionId, found);
      return execution;
    };
    const finish = (execution: ExecutionView, outcome: "succeeded" | "failed" = "succeeded") => {
      const command = dispatched.get(execution.executionId);
      assert(command, "只有已下发的执行才能上报终态");
      exchange({
        logFacts: [
          {
            executionId: execution.executionId,
            projectId,
            machineId: machine.machineId,
            authorizationGeneration: execution.authorizationGeneration,
            holderInstanceId: execution.holderInstanceId,
            producedThroughSequence: 1,
            sealed: true,
          },
        ],
        results: [
          {
            executionId: execution.executionId,
            projectId,
            machineId: machine.machineId,
            authorizationGeneration: execution.authorizationGeneration,
            holderInstanceId: execution.holderInstanceId,
            dispatchSession: command.dispatchSession,
            dispatchSeq: command.dispatchSeq,
            fingerprint: command.fingerprint,
            phase: "terminal",
            drained: true,
            outcome,
            payload: {
              kind: "shell",
              pid: 5100,
              exited: true,
              exitCode: outcome === "succeeded" ? 0 : 1,
              stdout: "",
              stderr: "",
              truncated: false,
            },
          },
        ],
      });
    };
    return { exchange, submit, finish };
  }
  function heartbeat(worker: Wire) {
    heartbeats.push(
      setInterval(() => {
        try {
          worker.exchange();
        } catch {
          // 心跳失败不改页面事实：连接会由服务端判为失联，这里不伪造在线。
        }
      }, 4000),
    );
  }

  // ── P1：active / active+fencing / detaching / removed / 未加入 / 未投递通知 ──
  const m1 = newMachine(p1, "当前可用");
  const m2 = newMachine(p1, "租约交接中");
  const m3 = newMachine(p1, "关系移出中");
  const m4 = newMachine(p1, "已移出历史");
  const m5 = newMachine(null, "从未加入");
  const m6 = newMachine(p1, "通知待投递");

  // M2：held 租约 + 在途执行 + Human 收回 → active + fencing（收据匹配，canForceReclaim=true）。
  const m2Actor = createActor(p1);
  acquireLease(
    {
      projectId: p1,
      machineId: m2.machineId,
      action: "acquire",
      requestId: req(),
      expectedGeneration: 0,
    },
    m2Actor,
  );
  const w2 = wire(p1, m2, m2Actor);
  const m2Execution = w2.submit();
  heartbeat(w2);
  reclaimLease(
    {
      projectId: p1,
      machineId: m2.machineId,
      action: "reclaim",
      requestId: req(),
      expectedGeneration: 1,
      confirm: true,
    },
    human(),
  );
  // M3：held 租约 + 在途执行 → 带租约移出，停在 detaching 并保留待处理。
  const m3Actor = createActor(p1);
  acquireLease(
    {
      projectId: p1,
      machineId: m3.machineId,
      action: "acquire",
      requestId: req(),
      expectedGeneration: 0,
    },
    m3Actor,
  );
  const w3 = wire(p1, m3, m3Actor);
  const m3Execution = w3.submit();
  heartbeat(w3);
  const m3Detach = detachMachine(
    {
      projectId: p1,
      machineId: m3.machineId,
      requestId: req(),
      expectedEpoch: 1,
      expectedRevision: revision(p1, m3.machineId)!,
      expectedGeneration: 1,
      confirm: true,
    },
    human(),
  );
  assert.equal(m3Detach.state, "detaching", "M3 必须停在 detaching 才能验待处理");
  // M4：acquire → 执行完成 → 释放 → 移出，成为带真实收据的 removed 历史。
  const m4Actor = createActor(p1);
  acquireLease(
    {
      projectId: p1,
      machineId: m4.machineId,
      action: "acquire",
      requestId: req(),
      expectedGeneration: 0,
    },
    m4Actor,
  );
  const w4 = wire(p1, m4, m4Actor);
  const m4Execution = w4.submit();
  w4.finish(m4Execution);
  releaseLease(
    {
      projectId: p1,
      machineId: m4.machineId,
      action: "release",
      requestId: req(),
      expectedGeneration: 1,
    },
    m4Actor,
  );
  const m4Detach = detachMachine(
    {
      projectId: p1,
      machineId: m4.machineId,
      requestId: req(),
      expectedEpoch: 1,
      expectedRevision: revision(p1, m4.machineId)!,
      expectedGeneration: 2,
      confirm: true,
    },
    human(),
  );
  assert.equal(m4Detach.state, "removed", "无任务在途的移出必须落到 removed");
  // M6：acquire → release → 通知未投递，且没有 Worker 连接（canForceReclaim=false、Worker 离线）。
  const m6Actor = createActor(p1);
  acquireLease(
    {
      projectId: p1,
      machineId: m6.machineId,
      action: "acquire",
      requestId: req(),
      expectedGeneration: 0,
    },
    m6Actor,
  );
  releaseLease(
    {
      projectId: p1,
      machineId: m6.machineId,
      action: "release",
      requestId: req(),
      expectedGeneration: 1,
    },
    m6Actor,
  );

  // ── P2：移出对话框流程 + 强制收回 + 历史 + 重新加入冲突 ─────────────────────
  const m7 = newMachine(p2, "移出对话框");
  const m7Actor = createActor(p2);
  acquireLease(
    {
      projectId: p2,
      machineId: m7.machineId,
      action: "acquire",
      requestId: req(),
      expectedGeneration: 0,
    },
    m7Actor,
  );
  const w7 = wire(p2, m7, m7Actor);
  const m7Execution = w7.submit();
  heartbeat(w7);
  results.fixtures = {
    p1: { m2: m2Execution.executionId, m3: m3Execution.executionId },
    p2: { m7: m7Execution.executionId },
  };

  const settings = (projectId: string) => `${base}/projects/${projectId}/settings`;
  const section = page.getByTestId("info-hub-project-machines");
  const current = page.getByTestId("info-hub-project-machines-current");
  const removedSection = page.getByTestId("info-hub-project-machines-removed");
  const pendingItem = (kind: string, name?: string) => {
    const locator = page.locator(
      `[data-testid="info-hub-project-machines-pending-item"][data-pending-kind="${kind}"]`,
    );
    return name === undefined ? locator : locator.filter({ hasText: name });
  };
  const currentRow = (machineId: string) =>
    current.locator(`[data-testid="machine-item"][data-machine-id="${machineId}"]`);
  const currentIds = async () =>
    (
      await current
        .locator('[data-testid="machine-item"][data-machine-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-machine-id") ?? ""))
    ).sort();
  const selectValues = async () =>
    (
      await page
        .getByTestId("project-machine-select")
        .locator("option")
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value))
    ).filter((value) => value.length > 0);
  /** 「撤权未确认」是唯一允许的「执行已停止」上下文；其余同义肯定句必须不存在。 */
  async function assertNoStoppedClaim(scope: Locator, where: string) {
    const text = await scope.innerText();
    const residual = text.split("无法确认远端执行已停止").join("");
    assert.ok(
      !residual.includes("执行已停止"),
      `${where} 不得出现「执行已停止」的肯定文案；实际可见文本：${text.slice(0, 400)}`,
    );
  }
  const rpc = async (
    target: BrowserContext,
    name: string,
    data: unknown,
  ): Promise<{ ok: boolean; error?: { code: string; message?: string }; data?: unknown }> => {
    const id = serverFnNames[name];
    assert.ok(id, `生产包必须注册 ${name}`);
    const response = await target.request.post(`${base}/_serverFn/${id}`, {
      headers: { "content-type": "application/json", "x-tsr-serverfn": "true", origin: base },
      data: JSON.stringify(toJSON({ data })),
    });
    assert.equal(response.status(), 200, `${name} 的 HTTP 状态必须是 200（业务结果在 body）`);
    const encoded = (await response.json()) as { t?: unknown };
    const decoded = (encoded.t ? fromCrossJSON(encoded, { refs: new Map() }) : encoded) as {
      result?: unknown;
    };
    return (decoded.result ?? decoded) as {
      ok: boolean;
      error?: { code: string; message?: string };
      data?: unknown;
    };
  };

  // ═══ 1. 当前资源区只显示 active ═════════════════════════════════════════════
  await check("当前资源区：只显示 active；active+fencing 留在当前区标「暂不可用」", async () => {
    await page.goto(settings(p1));
    await section.waitFor();
    await currentRow(m1.machineId).waitFor();
    const ids = await currentIds();
    assert.deepEqual(
      ids,
      [m1.machineId, m2.machineId, m6.machineId].sort(),
      `「当前资源」区只应出现 active 关系（M1/M2/M6）；detaching 的 M3、removed 的 M4、从未加入的 M5 都不得出现。实际：${ids.join(", ")}`,
    );
    const m1Text = await currentRow(m1.machineId).innerText();
    assert.match(
      m1Text,
      /项目资源 · 可使用/,
      `「当前资源」区的 M1（active，无租约）必须标「项目资源 · 可使用」；实际：${m1Text}`,
    );
    const m2Text = await currentRow(m2.machineId).innerText();
    assert.match(
      m2Text,
      /项目资源 · 暂不可用/,
      `「当前资源」区的 M2（active + fencing）必须留在当前区并标「项目资源 · 暂不可用」；实际：${m2Text}`,
    );
    assert.match(
      m2Text,
      /关系仍在项目中，当前不可新增使用/,
      `「当前资源」区的 M2 必须说明「关系仍在项目中，当前不可新增使用」；实际：${m2Text}`,
    );
    const body = await current.innerText();
    assert.ok(
      !body.includes(m4.name),
      `removed 的 M4（${m4.name}）不得出现在当前资源区；实际区文本：${body.slice(0, 300)}`,
    );
    assert.ok(!body.includes(m7.name), `跨 Project：P1 页面不得出现 P2 的 Machine（${m7.name}）`);
    results.currentIds = ids;
  });

  await check("待处理区：detaching 出现在待处理，removed 不在待处理", async () => {
    await pendingItem("membership_detaching").waitFor();
    const rows = await page
      .locator('[data-testid="info-hub-project-machines-pending-item"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          kind: node.getAttribute("data-pending-kind") ?? "",
          text: node.textContent ?? "",
        })),
      );
    const kinds = rows.map((row) => row.kind).sort();
    const ofKind = (kind: string) => rows.filter((row) => row.kind === kind);
    assert.equal(
      ofKind("membership_detaching").length,
      1,
      `「待处理」区必须恰好有一条 membership_detaching（M3）；实际待处理行：${kinds.join(", ")}`,
    );
    assert.equal(
      ofKind("lease_fencing").length,
      1,
      `「待处理」区必须恰好有一条 lease_fencing（M2 的租约交接）；实际待处理行：${kinds.join(", ")}`,
    );
    assert.ok(
      !rows.some((row) => row.kind === "membership_detaching" && row.text.includes(m4.name)),
      `removed 的 M4（${m4.name}）不得出现在 membership_detaching 待处理行里`,
    );
    assert.ok(
      ofKind("notice_undelivered").some((row) => row.text.includes(m6.name)),
      `M6 的未投递通知必须出现在 notice_undelivered 待处理行；实际待处理行：${kinds.join(", ")}`,
    );
    const detachingText = rows.find((row) => row.kind === "membership_detaching")!.text;
    assert.ok(
      detachingText.includes(m3.name),
      `「待处理」里的 membership_detaching 行必须是 M3（${m3.name}）；实际：${detachingText.slice(0, 200)}`,
    );
    assert.match(
      detachingText,
      /关系正在移出/,
      `M3 待处理摘要必须标「关系正在移出」；实际：${detachingText.slice(0, 200)}`,
    );
    assert.match(
      detachingText,
      /已停止新增使用，尚未完成移出/,
      `M3 待处理摘要必须说明「已停止新增使用，尚未完成移出」；实际：${detachingText.slice(0, 200)}`,
    );
    const firstKind = await page
      .locator('[data-testid="info-hub-project-machines-pending-item"]')
      .first()
      .getAttribute("data-pending-kind");
    assert.equal(
      firstKind,
      "membership_detaching",
      `「待处理」排序必须把 membership_detaching 放在最前；实际第一条是 ${firstKind}`,
    );
    results.pendingKinds = kinds;
  });

  await check("新增使用选择器：detaching 消失、removed 消失、从未加入的仍在", async () => {
    const values = await selectValues();
    assert.ok(
      values.includes(m5.machineId),
      `「新增使用」选择器必须保留从未加入过的 Machine（${m5.name}）；实际：${values.join(", ")}`,
    );
    assert.ok(
      values.includes(m1.machineId) &&
        values.includes(m2.machineId) &&
        values.includes(m6.machineId),
      "「新增使用」选择器必须保留 active 关系的 Machine",
    );
    assert.ok(
      !values.includes(m3.machineId),
      `detaching 的 M3（${m3.name}）必须从「新增使用」选择器消失；实际：${values.join(", ")}`,
    );
    assert.ok(
      !values.includes(m4.machineId),
      `removed 的 M4（${m4.name}）必须从「新增使用」选择器消失；实际：${values.join(", ")}`,
    );
    results.selectValues = values;
  });

  // ═══ 2. 待处理摘要收起 / 展开 ═════════════════════════════════════════════
  await check(
    "待处理摘要收起时可见状态、等待时长、Worker 在线与下一步；执行数与证据只在展开后",
    async () => {
      const item = pendingItem("membership_detaching");
      const detail = item.getByTestId("info-hub-project-machines-pending-detail");
      assert.equal(
        await detail.getAttribute("open"),
        null,
        "「待处理」细节必须默认收起（<details> 不能带 open）",
      );
      const age = await item.getByTestId("info-hub-project-machines-pending-age").innerText();
      assert.match(
        age,
        /已等 \d+ 小时 \d+ 分 \d+ 秒 · 自 \d{2}:\d{2}:\d{2}/,
        `「待处理」收起时必须显示等待时长与起点；实际：${age}`,
      );
      const worker = await item.getByTestId("info-hub-project-machines-pending-worker").innerText();
      assert.equal(
        worker,
        "Worker 在线",
        `「待处理」收起时必须显示 Worker 在线事实（M3 有真实心跳连接）；实际：${worker}`,
      );
      const collapsed = await item.innerText();
      assert.match(
        collapsed,
        /下一步：可确认强制收回，或继续等待。/,
        `「待处理」收起时必须给出下一步（canForceReclaim=true 时为可强制收回）；实际：${collapsed.slice(0, 300)}`,
      );
      assert.ok(
        !collapsed.includes("项已派发执行尚未排空"),
        `「待处理」收起时执行数必须不可见；实际可见文本：${collapsed.slice(0, 300)}`,
      );
      assert.ok(
        !collapsed.includes("等待 Worker 确认移出。"),
        `「待处理」收起时证据文案必须不可见；实际可见文本：${collapsed.slice(0, 300)}`,
      );
      const detailParagraphs = detail.locator("p");
      for (let index = 0; index < (await detailParagraphs.count()); index += 1)
        assert.equal(
          await detailParagraphs.nth(index).isVisible(),
          false,
          "「待处理」收起时细节段落不得渲染为可见",
        );
      await detail.locator("summary").click();
      await until(async () => {
        const text = await item.innerText();
        return text.includes("项已派发执行尚未排空") && text.includes("等待 Worker 确认移出。");
      }, "pending detail expanded");
      const expanded = await item.innerText();
      assert.match(
        expanded,
        /1 项已派发执行尚未排空/,
        `「待处理」展开后必须显示执行数（M3 恰有 1 项在途）；实际：${expanded.slice(0, 400)}`,
      );
      assert.ok(
        expanded.includes("等待 Worker 确认移出。"),
        `「待处理」展开后必须显示等待 Worker 确认的证据；实际：${expanded.slice(0, 400)}`,
      );
      results.pendingAge = age;
      results.pendingWorker = worker;
    },
  );

  // ═══ 4a. canForceReclaim=false 的待处理没有强制收回 ══════════════════════
  await check("强制收回入口只在 canForceReclaim 为真时出现", async () => {
    const notice = pendingItem("notice_undelivered", m6.name);
    await notice.waitFor();
    const noticeText = await notice.innerText();
    assert.match(
      noticeText,
      /通知待投递/,
      `M6 的待处理摘要必须是「通知待投递」；实际：${noticeText.slice(0, 200)}`,
    );
    assert.match(
      noticeText,
      /下一步：继续等待服务端事实推进。/,
      `canForceReclaim=false 的待处理必须只给「继续等待」；实际：${noticeText.slice(0, 200)}`,
    );
    assert.match(
      noticeText,
      /Worker 离线/,
      `M6 没有 Worker 连接，待处理摘要必须如实显示 Worker 离线；实际：${noticeText.slice(0, 200)}`,
    );
    assert.equal(
      await notice.getByTestId("membership-force-trigger").count(),
      0,
      "notice_undelivered 的 canForceReclaim=false，待处理行不得出现「强制收回」",
    );
    assert.equal(
      await pendingItem("lease_fencing").getByTestId("membership-force-trigger").count(),
      1,
      "lease_fencing 且收据匹配时，待处理行必须提供「强制收回」（canForceReclaim=true）",
    );
    assert.equal(
      await pendingItem("membership_detaching").getByTestId("membership-force-trigger").count(),
      1,
      "membership_detaching 且 removalMutationId 收据匹配时必须提供「强制收回」",
    );
    results.forceVisibility = { notice: 0, fencing: 1, detaching: 1 };
  });

  // ═══ 3. 移出流程：对话框、取消不写库、确认后停在待处理 ═════════════════════
  await check("移出对话框：取消不写库，页面不宣称已移出", async () => {
    await page.goto(settings(p2));
    await section.waitFor();
    await currentRow(m7.machineId).waitFor();
    await page.getByTestId("membership-detach-trigger").click();
    const dialog = page.getByTestId("membership-detach-dialog");
    await dialog.waitFor();
    assert.equal(
      await page.getByTestId("membership-detach-submit").isDisabled(),
      true,
      "未勾选确认时「确认移出」必须禁用",
    );
    const before = mutationRows({ projectId: p2, machineId: m7.machineId }).length;
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      stateOf({ projectId: p2, machineId: m7.machineId }),
      "active",
      "取消移出对话框不得写库：关系必须仍是 active",
    );
    assert.equal(
      mutationRows({ projectId: p2, machineId: m7.machineId }).length,
      before,
      "取消移出对话框不得新增任何租约收据",
    );
    assert.equal(
      await pendingItem("membership_detaching").count(),
      0,
      "取消后页面不得出现 membership_detaching 待处理行",
    );
    assert.equal(
      await page.getByTestId("info-hub-project-machines-removed-empty").count(),
      1,
      "取消后「已移出记录」必须仍为空",
    );
    results.cancelWrites = 0;
  });

  await check(
    "确认移出后服务端返回 detaching：页面保留该行并显示待处理，不显示已移出或空闲",
    async () => {
      await page.getByTestId("membership-detach-trigger").click();
      const dialog = page.getByTestId("membership-detach-dialog");
      await dialog.waitFor();
      await page.getByTestId("membership-detach-confirm").check();
      assert.equal(
        await page.getByTestId("membership-detach-submit").isDisabled(),
        false,
        "勾选确认后「确认移出」必须可用",
      );
      await page.getByTestId("membership-detach-submit").click();
      await dialog.waitFor({ state: "hidden" });
      const notice = page.getByTestId("info-hub-project-machines-notice");
      await notice.waitFor();
      const noticeText = await notice.innerText();
      assert.match(
        noticeText,
        /移出尚未完成/,
        `detaching 结果必须显示「移出尚未完成」；实际：${noticeText}`,
      );
      assert.match(
        noticeText,
        /等待 Worker 确认后才完成移出/,
        `detaching 结果必须说明等待 Worker 确认；实际：${noticeText}`,
      );
      await until(
        async () => (await pendingItem("membership_detaching").count()) === 1,
        "detaching pending row after detach",
      );
      const rowText = await pendingItem("membership_detaching").innerText();
      assert.ok(
        rowText.includes(m7.name),
        `移出中的关系必须保留行并进入待处理（期望 ${m7.name}）；实际：${rowText.slice(0, 200)}`,
      );
      assert.equal(
        await currentRow(m7.machineId).count(),
        0,
        "detaching 关系不得继续出现在「当前资源」区",
      );
      assert.match(
        await removedSection.innerText(),
        /还没有已移出的加入记录/,
        "detaching 期间「已移出记录」区必须为空，不能显示成已移出",
      );
      assert.ok(
        !(await section.innerText()).includes("空闲"),
        "页面不得把 detaching 关系显示成「空闲」",
      );
      assert.equal(
        stateOf({ projectId: p2, machineId: m7.machineId }),
        "detaching",
        "确认后服务端关系必须停在 detaching",
      );
      assert.equal(
        leaseRow({ projectId: p2, machineId: m7.machineId })?.state,
        "fencing",
        "停 detaching 时租约必须处于 fencing",
      );
      results.detachState = "detaching";
    },
  );

  // ═══ 4b. 强制收回：撤权未确认，不出现「执行已停止」 ══════════════════════
  await check("强制收回后显示「撤权未确认」，且不出现「执行已停止」这类肯定文案", async () => {
    const row = pendingItem("membership_detaching");
    await row.getByTestId("membership-force-trigger").click();
    const dialog = page.getByTestId("membership-force-dialog");
    await dialog.waitFor();
    await page.getByTestId("membership-force-confirm").check();
    await page.getByTestId("membership-force-submit").click();
    await dialog.waitFor({ state: "hidden" });
    await until(
      async () => (await page.getByTestId("info-hub-project-machines-removed-item").count()) === 1,
      "removed row after force reclaim",
    );
    const revocation = page.getByTestId("info-hub-project-machines-removed-revocation");
    await revocation.waitFor();
    const revocationText = await revocation.innerText();
    assert.match(
      revocationText,
      /撤权未确认/,
      `强制收回后已移出记录必须标「撤权未确认」；实际：${revocationText}`,
    );
    assert.match(
      revocationText,
      /无法确认远端执行已停止/,
      `强制收回后必须说明风险「无法确认远端执行已停止」；实际：${revocationText}`,
    );
    await assertNoStoppedClaim(section, "强制收回后的关系区");
    const view = membershipViewFor({ projectId: p2, machineId: m7.machineId }, new Date(), {
      canForceReclaim: true,
    });
    assert.equal(view?.state, "removed", "强制收回后关系必须落到 removed");
    assert.equal(view?.revocation, "unconfirmed", "强制收回后 revocation 必须是 unconfirmed");
    results.forceRevocation = view?.revocation;
  });

  // ═══ 6. Human 只读历史 ═══════════════════════════════════════════════════
  await check(
    "历史区能读到已移出关系的执行与租约收据，且没有「替 Agent 读日志」「标记已读」操作",
    async () => {
      const history = page.getByTestId("info-hub-project-machines-history");
      await history.waitFor();
      await page.getByTestId("info-hub-project-machines-history-entry").locator("summary").click();
      const receipts = page.getByTestId("info-hub-project-machines-history-receipts");
      await receipts.waitFor();
      const receiptsText = await receipts.innerText();
      const summaryMatch = /共 1 段加入记录、(\d+) 条租约收据/.exec(receiptsText);
      assert.ok(
        summaryMatch,
        `历史区必须显示加入记录与租约收据计数；实际：${receiptsText.slice(0, 200)}`,
      );
      const receiptCount = Number(summaryMatch![1]);
      assert.ok(
        receiptCount >= 2,
        `历史区必须读到这次移出产生的真实租约收据（acquire + reclaim/force），实际 ${receiptCount} 条`,
      );
      assert.match(
        receiptsText,
        /强制收回/,
        `历史区必须如实标出强制收回收据；实际：${receiptsText.slice(0, 400)}`,
      );
      const executions = page.getByTestId("info-hub-project-machines-history-executions");
      await executions.waitFor();
      const total = page
        .getByTestId("info-hub-project-machines-history-execution-list-summary")
        .first();
      await total.waitFor();
      const totalValue = Number(await total.getAttribute("data-total"));
      assert.ok(totalValue >= 1, `历史区必须读到该关系的历史执行，实际 data-total=${totalValue}`);
      const interactive = history.locator("button, a, [role=button]");
      const names: string[] = [];
      for (let index = 0; index < (await interactive.count()); index += 1) {
        const name = (await interactive.nth(index).innerText()).trim();
        if (name) names.push(name);
      }
      const banned = names.filter((name) =>
        /标记已读|标记通知完成|替 Agent 读日志|启动新 Run|取消/.test(name),
      );
      assert.deepEqual(
        banned,
        [],
        `历史区不得提供「标记已读 / 标记通知完成 / 替 Agent 读日志 / 启动新 Run / 取消」这类操作；实际按钮：${banned.join(" | ")}`,
      );
      assert.match(
        await history.innerText(),
        /没有“标记已读”或“替 Agent 读日志”/,
        "历史区必须写明不提供标记已读或替 Agent 读日志",
      );
      // 读取历史不产生投递事实：未投递通知与执行状态都不能被这次读取改写。
      const undelivered = () =>
        (
          sqlite
            .prepare(
              "SELECT COUNT(*) AS n FROM run_resource_notice WHERE project_id = ? AND machine_id = ? AND delivered_at IS NULL",
            )
            .get(p2, m7.machineId) as { n: number }
        ).n;
      const noticeBefore = undelivered();
      // 已移出关系上，Agent 读取入口本身会拒绝（membership_removed）；这里只核对 Human 历史读取
      // 不产生任何写入事实，所以直接读库里的原始行，不给页面额外授权。
      const executionState = () =>
        db
          .select({ state: remoteExecution.state, drainedAt: remoteExecution.drainedAt })
          .from(remoteExecution)
          .where(eq(remoteExecution.id, m7Execution.executionId))
          .get();
      const executionBefore = executionState();
      assert.ok(executionBefore, "夹具的执行行必须存在");
      const historyResponse = await rpc(context, "membershipHistoryFn", {
        projectId: p2,
        machineId: m7.machineId,
      });
      assert.equal(historyResponse.ok, true, "拥有资源的 Human 必须能读到已移出关系的历史");
      assert.equal(undelivered(), noticeBefore, "读取历史不得把未投递通知标成已读/已投递");
      assert.deepEqual(executionState(), executionBefore, "读取历史不得改写执行状态或排空位点");
      results.historyReceipts = receiptCount;
      results.historyExecutions = totalValue;
    },
  );

  // ═══ 5. 重新加入只对最新 removed 生效；旧页面冲突不覆盖新关系 ═══════════════
  await check("重新加入：旧页面持有过期 epoch 时显示冲突，且不覆盖新关系", async () => {
    relationSnapshots.delete(page);
    await page.reload();
    await page.getByTestId("info-hub-project-machines-removed-item").waitFor();
    await until(() => {
      const snapshot = relationSnapshots.get(page);
      return Boolean(snapshot && snapshot.text.includes("removed"));
    }, "relations snapshot with removed state");
    const snapshot = relationSnapshots.get(page)!;
    await page.route(snapshot.url, (route) =>
      route.fulfill({
        status: 200,
        contentType: snapshot.contentType,
        body: snapshot.body,
      }),
    );
    // 服务端事实前进两代：rejoin 产生 epoch 2，再移出产生 epoch 2 的 removed。
    const rejoined = rejoinProjectMachine(
      {
        projectId: p2,
        machineId: m7.machineId,
        requestId: req(),
        expectedEpoch: 1,
        expectedRevision: revision(p2, m7.machineId)!,
        confirm: true,
      },
      human(),
    );
    assert.equal(rejoined.state, "active", "领域重新加入必须成功");
    const afterRejoinLease = leaseRow({ projectId: p2, machineId: m7.machineId });
    const detachedAhead = detachMachine(
      {
        projectId: p2,
        machineId: m7.machineId,
        requestId: req(),
        expectedEpoch: 2,
        expectedRevision: revision(p2, m7.machineId)!,
        expectedGeneration: afterRejoinLease?.generation ?? 0,
        confirm: true,
      },
      human(),
    );
    assert.equal(detachedAhead.state, "removed", "服务端事实必须早于页面一代");
    assert.equal(epochOf({ projectId: p2, machineId: m7.machineId }), 2);
    await page.getByTestId("info-hub-project-machines-rejoin").click();
    const error = page.getByTestId("info-hub-project-machines-rejoin-error");
    await error.waitFor();
    const meta = await error.getByTestId("result-error-meta").innerText();
    assert.match(
      meta,
      /conflict/,
      `旧页面用过期 epoch 重新加入必须显示冲突（conflict）；实际：${meta}`,
    );
    assert.equal(
      await page.getByTestId("info-hub-project-machines-rejoin-notice").count(),
      0,
      "冲突时不得显示「已重新加入」",
    );
    assert.equal(
      epochOf({ projectId: p2, machineId: m7.machineId }),
      2,
      "冲突请求不得覆盖服务端已有更新的 epoch",
    );
    assert.equal(
      stateOf({ projectId: p2, machineId: m7.machineId }),
      "removed",
      "冲突请求不得把已移出的新关系改成 active",
    );
    results.rejoinConflict = meta;
    await page.unroute(snapshot.url);
  });

  await check("重新加入：最新 removed 时成功产生新的加入记录", async () => {
    await page.reload();
    await page.getByTestId("info-hub-project-machines-rejoin").waitFor();
    await page.getByTestId("info-hub-project-machines-rejoin").click();
    // 成功后 removed 行会被新的 active 关系顶替，行内 notice 随行卸载；关系区的 notice 才是留在页面上的结果。
    const notice = page.getByTestId("info-hub-project-machines-notice");
    await notice.waitFor();
    assert.match(
      await notice.innerText(),
      /已重新加入/,
      "最新 removed 的重新加入必须成功并给出新的加入记录说明",
    );
    await currentRow(m7.machineId).waitFor();
    assert.equal(
      epochOf({ projectId: p2, machineId: m7.machineId }),
      3,
      "重新加入必须产生 epoch 3 的新加入记录（旧 epoch 保留）",
    );
    assert.equal(await page.getByTestId("info-hub-project-machines-removed-item").count(), 0);
    results.rejoinEpoch = 3;
  });

  // ═══ 7. 五秒刷新：事实更新 / 失败保留上次事实并标未确认 ═══════════════════
  await check("五秒刷新：服务端事实变化后不刷新页面也能更新", async () => {
    await page.goto(settings(p1));
    await section.waitFor();
    await currentRow(m1.machineId).waitFor();
    await until(() => relationSnapshots.get(page) !== undefined, "p1 relations snapshot");
    assert.equal(
      await page.getByTestId("info-hub-project-machines-removed-item").count(),
      1,
      "刷新前 P1 应有一条已移出记录（M4）",
    );
    assert.equal(await currentRow(m4.machineId).count(), 0, "刷新前 M4 不得出现在当前资源区");
    const started = Date.now();
    rejoinProjectMachine(
      {
        projectId: p1,
        machineId: m4.machineId,
        requestId: req(),
        expectedEpoch: 1,
        expectedRevision: revision(p1, m4.machineId)!,
        confirm: true,
      },
      human(),
    );
    await until(
      async () =>
        (await currentRow(m4.machineId).count()) === 1 &&
        (await page.getByTestId("info-hub-project-machines-removed-item").count()) === 0,
      "page auto refresh picks up rejoin",
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 12000, `五秒刷新必须在一轮内把服务端事实带到页面；实际等待 ${elapsed}ms`);
    results.refreshUpdatedMs = elapsed;
  });

  await check("刷新失败：保留上次事实并标「当前状态未确认」，写入口暂停", async () => {
    const snapshot = relationSnapshots.get(page)!;
    const before = await currentIds();
    await page.route(snapshot.url, (route) => route.abort());
    const stale = page.getByTestId("info-hub-project-machines-stale");
    await stale.waitFor({ timeout: 15000 });
    const staleText = await stale.innerText();
    assert.match(
      staleText,
      /当前状态未确认/,
      `刷新失败必须标「当前状态未确认」；实际：${staleText.slice(0, 200)}`,
    );
    assert.match(
      staleText,
      /上次成功读取/,
      `刷新失败必须给出上次成功读取时间；实际：${staleText.slice(0, 200)}`,
    );
    assert.deepEqual(
      await currentIds(),
      before,
      "刷新失败必须保留上次成功事实，不得清空或改写当前资源区",
    );
    assert.equal(
      await page.getByTestId("membership-detach-trigger").first().isDisabled(),
      true,
      "刷新失败后必须暂停依赖新鲜事实的移出入口",
    );
    await page.unroute(snapshot.url);
    await stale.waitFor({ state: "hidden", timeout: 15000 });
    assert.deepEqual(await currentIds(), before, "恢复成功后仍应保留同一批事实");
    results.staleBanner = true;
  });

  await check("刷新失败：已打开的强制收回对话框也停止，并说明原因", async () => {
    const snapshot = relationSnapshots.get(page)!;
    await pendingItem("lease_fencing").getByTestId("membership-force-trigger").click();
    const dialog = page.getByTestId("membership-force-dialog");
    await dialog.waitFor();
    await page.getByTestId("membership-force-confirm").check();
    assert.equal(
      await page.getByTestId("membership-force-submit").isDisabled(),
      false,
      "刷新成功时，已勾选确认的强制收回提交必须可用",
    );
    const leaseBefore = leaseRow({ projectId: p1, machineId: m2.machineId })!.generation;
    await page.route(snapshot.url, (route) => route.abort());
    await page.getByTestId("info-hub-project-machines-stale").waitFor({ timeout: 15000 });
    assert.equal(
      await page.getByTestId("membership-force-submit").isDisabled(),
      true,
      "刷新失败后，已打开的强制收回对话框也不得提交",
    );
    assert.match(
      await page.getByTestId("membership-force-blocked").innerText(),
      /当前状态未确认/,
      "已打开的强制收回对话框必须说明为什么现在不能提交",
    );
    assert.equal(
      leaseRow({ projectId: p1, machineId: m2.machineId })!.generation,
      leaseBefore,
      "刷新失败不得让已打开的强制收回对话框写库",
    );
    await page.keyboard.press("Escape");
    await page.unroute(snapshot.url);
    await page
      .getByTestId("info-hub-project-machines-stale")
      .waitFor({ state: "hidden", timeout: 15000 });
    results.staleForceDialog = true;
  });

  // ═══ 8. 反证：缺 confirm 无写；跨 Project 不泄露 ══════════════════════════
  await check("反证：直接请求移出接口缺 confirm / confirm:false 一律无写", async () => {
    const key = { projectId: p1, machineId: m1.machineId };
    const before = {
      state: stateOf(key),
      epoch: epochOf(key),
      mutations: mutationRows(key).length,
    };
    const payload = {
      projectId: p1,
      machineId: m1.machineId,
      expectedEpoch: epochOf(key),
      expectedRevision: revision(p1, m1.machineId),
      expectedGeneration: leaseRow(key)?.generation ?? 0,
    };
    const missing = await rpc(context, "detachMachineFn", { ...payload, requestId: req() });
    assert.equal(missing.ok, false, "缺少 confirm 的移出请求必须被拒绝");
    assert.equal(
      missing.error?.code,
      "validation_failed",
      `缺少 confirm 必须是 validation_failed；实际：${JSON.stringify(missing.error)}`,
    );
    const rejected = await rpc(context, "detachMachineFn", {
      ...payload,
      requestId: req(),
      confirm: false,
    });
    assert.equal(rejected.ok, false, "confirm:false 的移出请求必须被拒绝");
    assert.equal(
      rejected.error?.code,
      "validation_failed",
      `confirm:false 必须是 validation_failed；实际：${JSON.stringify(rejected.error)}`,
    );
    assert.equal(stateOf(key), before.state, "被拒绝的移出请求不得改动关系状态");
    assert.equal(epochOf(key), before.epoch, "被拒绝的移出请求不得改动关系 epoch");
    assert.equal(mutationRows(key).length, before.mutations, "被拒绝的移出请求不得写任何租约收据");
    results.rejectedDetach = [missing.error?.code, rejected.error?.code];
  });

  await check("反证：跨 Project／跨用户的读取、历史与移出都不泄露", async () => {
    const strangerContext = await browser!.newContext({ viewport: { width: 1440, height: 1200 } });
    const stranger = await strangerContext.newPage();
    stranger.setDefaultTimeout(20000);
    watchPage(stranger);
    activePage = stranger;
    await stranger.goto(`${base}/login`);
    await stranger.getByTestId("register-tab").click();
    await stranger.locator('input[name="name"]').fill("Pages Stranger");
    await stranger
      .locator('input[name="email"]')
      .fill(`pages-stranger-${randomBytes(6).toString("hex")}@example.test`);
    await stranger.locator('input[type="password"]').fill(randomBytes(24).toString("base64url"));
    await stranger.locator('button[type="submit"]').click();
    await stranger.waitForURL((url) => /^\/projects\/prj_[0-9a-f-]{36}\/chats$/.test(url.pathname));
    await stranger.keyboard.press("Escape");

    const foreignRelations = await rpc(strangerContext, "projectMachineRelationsFn", {
      projectId: p1,
    });
    assert.equal(foreignRelations.ok, false, "非成员读取 Project 关系必须被拒绝");
    assert.equal(foreignRelations.error?.code, "not_found");
    const foreignHistory = await rpc(strangerContext, "membershipHistoryFn", {
      projectId: p1,
      machineId: m3.machineId,
    });
    assert.equal(foreignHistory.ok, false, "非成员读取关系历史必须被拒绝");
    assert.equal(foreignHistory.error?.code, "not_found");
    const foreignDetach = await rpc(strangerContext, "detachMachineFn", {
      projectId: p1,
      machineId: m1.machineId,
      requestId: req(),
      expectedEpoch: epochOf({ projectId: p1, machineId: m1.machineId }),
      expectedRevision: revision(p1, m1.machineId),
      expectedGeneration: 0,
      confirm: true,
    });
    assert.equal(foreignDetach.ok, false, "非成员移出他人关系必须被拒绝");
    assert.equal(foreignDetach.error?.code, "not_found");
    assert.equal(
      stateOf({ projectId: p1, machineId: m1.machineId }),
      "active",
      "被拒绝的跨用户移出不得改动关系",
    );

    await stranger.goto(settings(p1));
    // 页面只给「Project 不存在」的既有错误面；这里不假设具体 testId，按错误面本身定位。
    const refused = stranger.locator('[role="alert"]');
    await refused.first().waitFor();
    assert.match(
      await refused.first().innerText(),
      /not_found/,
      "非成员打开他人 Project settings 必须得到 not_found 错误面",
    );
    assert.equal(
      await stranger.getByTestId("info-hub-project-machines").count(),
      0,
      "非成员的 Project settings 不得渲染关系区",
    );
    const body = await stranger.locator("body").innerText();
    for (const name of [m1.name, m3.name, m4.name])
      assert.ok(!body.includes(name), `跨用户页面不得泄露 Machine 名称：${name}`);
    await shoot("stranger-refused");
    activePage = page;
    await strangerContext.close();
    results.crossUser = "not_found";
  });

  // ═══ 证据：浏览器请求确实打到这些 serverFn ═══════════════════════════════
  await check("浏览器请求确实打到关系、移出、强制收回与重新加入的服务端入口", () => {
    const expectations: [string, number][] = [
      ["projectMachineRelationsFn", 2],
      ["detachMachineFn", 1],
      ["forceReclaimLeaseFn", 1],
      ["rejoinProjectMachineFn", 2],
      ["membershipHistoryFn", 1],
    ];
    const observed: Record<string, number> = {};
    for (const [name, minimum] of expectations) {
      assert.ok(serverFnNames[name], `生产包必须注册 ${name}`);
      const calls = fnCalls(name);
      observed[name] = calls;
      assert.ok(
        calls >= minimum,
        `${name} 必须真的被页面调用（至少 ${minimum} 次），实际 ${calls} 次；否则断言证明的是夹具而不是页面`,
      );
    }
    results.serverFnCalls = observed;
  });

  results.durationMs = Date.now() - startedAt;
  writeFileSync(
    join(evidence, "results.json"),
    `${JSON.stringify(
      {
        base,
        projects: { p1, p2 },
        // 只记 id 与名字：machine ticket 是登记凭据，不写进证据文件。
        machines: Object.fromEntries(
          Object.entries({ m1, m2, m3, m4, m5, m6, m7 }).map(([key, value]) => [
            key,
            { machineId: value.machineId, name: value.name },
          ]),
        ),
        passes,
        screenshots,
        ...results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`PASS p4d pages evidence ${evidence}`);
} catch (error) {
  console.error("FAIL p4d pages", error);
  process.exitCode = 1;
  writeFileSync(
    join(evidence, "failure.json"),
    `${JSON.stringify(
      { passes, screenshots, error: error instanceof Error ? error.stack : JSON.stringify(error) },
      null,
      2,
    )}\n`,
  );
} finally {
  for (const timer of heartbeats) clearInterval(timer);
  await browser?.close().catch(() => {});
  if (server && !server.killed) server.kill("SIGTERM");
}
