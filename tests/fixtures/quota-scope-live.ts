// Real HTTP + macOS Worker regression for F-3. Operation bodies and credentials stay private.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { LeaseMutationView } from "../../src/contracts/lease";
import type { ExecutionView, RemoteToolGrant } from "../../src/contracts/remote";
import type { AppResult } from "../../src/contracts/result";

assert.equal(process.platform, "darwin", "real macOS Worker required");
assert(existsSync(".output/server/index.mjs") && existsSync("dist/worker/main.js"));
const directory = mkdtempSync(join(tmpdir(), "p4b-quota-live-"));
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const address = socket.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
assert.notEqual(address.port, 3000);
await new Promise<void>((resolve) => socket.close(() => resolve()));
// Keep the real Worker/server protocol; shorten polling so the separate 8-command
// batch/deadline limit does not hide the quota admission regression.
const proxy = createHttpServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const upstream = await fetch(base + request.url, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(10000),
    });
    const body = await upstream.json();
    if (request.url === "/api/worker/open" && body.ok) body.data.pollIntervalMs = 50;
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  } catch {
    response.writeHead(502);
    response.end();
  }
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyAddress = proxy.address();
assert(proxyAddress && typeof proxyAddress !== "string");
const workerBase = `http://127.0.0.1:${proxyAddress.port}`;
const env = {
  ...process.env,
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  DATABASE_URL: join(directory, "private.sqlite"),
  APP_ORIGIN: base,
  PORT: String(address.port),
  NITRO_PORT: String(address.port),
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  SPROUT_PI_ENABLED: "false",
  SPROUT_PI_DATA_DIR: join(directory, "pi"),
};
const children: ReturnType<typeof spawn>[] = [];
function launch(args: string[], ipc = false) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ipc ? ["ignore", "ignore", "ignore", "ipc"] : "ignore",
  });
  children.push(child);
  return child;
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
const service = launch(["--import", "tsx", "tests/fixtures/worker-remote-service.ts"], true);
async function issue(runId: string): Promise<RemoteToolGrant> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.off("message", receive);
      reject(new Error("Grant issuance timeout"));
    }, 10000);
    function receive(message: { id: string; ok: boolean; grant: RemoteToolGrant }) {
      if (message.id !== id) return;
      clearTimeout(timer);
      service.off("message", receive);
      if (message.ok) resolve(message.grant);
      else reject(new Error("Grant issuance failed"));
    }
    service.on("message", receive);
    service.send({ id, action: "issue", runId });
  });
}
let worker: ReturnType<typeof spawn> | undefined;
let paused = false;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch();
  await until(async () => {
    try {
      return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, "production service health");
  const context = await browser.newContext();
  const signup = await context.request.post(base + "/api/auth/sign-up/email", {
    headers: { origin: base },
    data: {
      name: "Quota verifier",
      email: `quota-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
    },
  });
  assert.equal(signup.status(), 200);
  const account = await signup.json();
  const page = await context.newPage();
  await page.goto(base);
  Object.assign(process.env, {
    DATABASE_URL: env.DATABASE_URL,
    APP_ORIGIN: base,
    SPROUT_PI_ENABLED: "false",
  });
  const { sqlite } = await import("../../src/db");
  const { createMachine, saveProjectMachineBinding } = await import("../../src/domain/machine");
  const { seedRemoteActor } = await import("./remote-actors");
  const bootId = (
    sqlite.prepare("SELECT id FROM runtime_boot ORDER BY started_at DESC LIMIT 1").get() as {
      id: string;
    }
  ).id;
  const projects = [newId(ID_PREFIXES.project), newId(ID_PREFIXES.project)];
  for (const project of projects)
    sqlite
      .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Quota live',?)")
      .run(project, account.user.id);
  const actors = projects.map((project) =>
    seedRemoteActor(sqlite, account.user.id, project, bootId, false),
  );
  const [a, b] = actors;
  assert(a && b);
  const machine = createMachine({ name: "Quota shared Mac" }, a);
  const machineId = machine.detail.machine.id;
  for (const actor of actors)
    saveProjectMachineBinding(
      {
        projectId: actor.projectId,
        machineId,
        description: "independent quota",
        expectedRevision: null,
      },
      actor,
    );
  const grantA = await issue(a.runId),
    grantB = await issue(b.runId);
  console.log(
    "PASS quota live setup: production service, Chromium, new account and server-issued grants",
  );
  async function call<T>(
    type: string,
    input: unknown,
    grant: RemoteToolGrant,
  ): Promise<AppResult<T>> {
    const response = await fetch(base + "/api/remote/agent", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${grant.secret}` },
      body: JSON.stringify({ version: 1, call: { type, input } }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as AppResult<T>;
  }
  async function good<T>(type: string, input: unknown, grant: RemoteToolGrant): Promise<T> {
    const result = await call<T>(type, input, grant);
    if (!result.ok) throw new Error(`HTTP request rejected: ${result.error.code}`);
    return result.data;
  }
  const req = () => newId(ID_PREFIXES.request);
  const keyA = { projectId: a.projectId, machineId },
    keyB = { projectId: b.projectId, machineId };
  const generationA = (
    await good<LeaseMutationView>(
      "lease_mutate",
      { ...keyA, action: "acquire", expectedGeneration: 0, requestId: req() },
      grantA,
    )
  ).completedGeneration;
  const generationB = (
    await good<LeaseMutationView>(
      "lease_mutate",
      { ...keyB, action: "acquire", expectedGeneration: 0, requestId: req() },
      grantB,
    )
  ).completedGeneration;
  const ticket = join(directory, "ticket");
  writeFileSync(ticket, machine.ticket, { mode: 0o600 });
  const state = join(directory, "state");
  const init = launch([
    "dist/worker/main.js",
    "init",
    "--server",
    workerBase,
    "--machine",
    machineId,
    "--state-dir",
    state,
    "--ticket-file",
    ticket,
    "--allow-http",
    workerBase,
  ]);
  await until(() => init.exitCode !== null, "Worker enrollment");
  assert.equal(init.exitCode, 0);
  rmSync(ticket);
  worker = launch(["dist/worker/main.js", "run", "--state-dir", state]);
  await until(
    () =>
      !!sqlite
        .prepare(
          "SELECT 1 FROM machine_connection WHERE machine_id=? AND status='open' AND capability IS NOT NULL",
        )
        .get(machineId),
    "real Worker capability",
  );
  worker.kill("SIGSTOP");
  paused = true;
  console.log("PASS quota live setup: enrolled macOS Worker paused before execution delivery");
  const source = join(directory, "source");
  writeFileSync(source, "quota-fixture", { mode: 0o600 });
  const inputA = () => ({
    ...keyA,
    requestId: req(),
    authorizationGeneration: generationA,
    operation: { kind: "file_read", path: source, maxBytes: 64 },
  });
  for (let i = 0; i < 64; i++) await good<ExecutionView>("execution_submit", inputA(), grantA);
  const capped = await call<ExecutionView>("execution_submit", inputA(), grantA);
  assert(!capped.ok && capped.error.code === "too_many_requests");
  const marker = join(directory, "b-executed");
  const inputB = {
    ...keyB,
    requestId: req(),
    authorizationGeneration: generationB,
    operation: { kind: "file_write", path: marker, content: "quota-success", mode: "overwrite" },
  };
  const crossProject = await call<ExecutionView>("execution_submit", inputB, grantA);
  assert(!crossProject.ok && crossProject.error.code === "not_found");
  const stale = await call<ExecutionView>(
    "execution_submit",
    { ...inputB, authorizationGeneration: generationB! + 1 },
    grantB,
  );
  assert(!stale.ok && stale.error.code === "lease_stale_generation");
  assert(!existsSync(marker));
  const executionB = await good<ExecutionView>("execution_submit", inputB, grantB);
  const pendingA = sqlite
    .prepare(
      "SELECT count(*) AS n FROM remote_execution WHERE project_id=? AND machine_id=? AND terminal_at IS NULL",
    )
    .get(a.projectId, machineId) as { n: number };
  assert.equal(pendingA.n, 64);
  assert.equal(executionB.state, "queued");
  console.log("PASS quota live admission: A=64, A65 rejected, B independently queued");
  worker.kill("SIGCONT");
  paused = false;
  await until(() => existsSync(marker), "B executes while A had a full independent queue");
  assert.equal(readFileSync(marker, "utf8"), "quota-success");
  await until(
    async () =>
      (
        await good<ExecutionView>(
          "execution_get",
          { ...keyB, executionId: executionB.executionId },
          grantB,
        )
      ).state === "succeeded",
    "B terminal report",
  );
  console.log(
    "PASS quota live: A=64, A65=too_many_requests, independent B admitted and executed by real macOS Worker",
  );
  console.log(
    "PASS quota live: cross-Project and wrong-generation HTTP requests rejected without file effects; Chromium/new account/private SQLite",
  );
  sqlite.close();
} finally {
  if (paused) worker?.kill("SIGCONT");
  await browser?.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  for (const child of children.reverse())
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await until(
    () => children.every((child) => child.exitCode !== null || child.signalCode !== null),
    "owned process cleanup",
    10000,
  ).catch(() => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  rmSync(directory, { recursive: true, force: true });
}
