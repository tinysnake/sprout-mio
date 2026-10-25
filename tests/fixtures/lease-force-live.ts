import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ExecutionView, RemoteToolGrant } from "../../src/contracts/remote";
import type { LeaseMutationView, LeaseView } from "../../src/contracts/lease";
import type { AppResult } from "../../src/contracts/result";

assert.equal(process.platform, "darwin", "real macOS Worker required");
assert(
  existsSync(".output/server/index.mjs") && existsSync("dist/worker/main.js"),
  "build app and Worker first",
);
mkdirSync(".verify/p4b-fence-force", { recursive: true });
const directory = mkdtempSync(resolve(".verify/p4b-fence-force/private-"));
const children: ReturnType<typeof spawn>[] = [],
  logs: string[] = [],
  checks: string[] = [];
const facts: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timeout: ${message}`);
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.notEqual(port, 3000);
  return port;
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  DATABASE_URL: join(directory, "private.sqlite"),
  APP_ORIGIN: base,
  PORT: String(port),
  NITRO_PORT: String(port),
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  SPROUT_PI_ENABLED: "false",
  SPROUT_PI_DATA_DIR: join(directory, "private-pi"),
};
function launch(args: string[], name: string, ipc = false) {
  const log = join(directory, name);
  logs.push(log);
  const fd = openSync(log, "w", 0o600);
  const child = spawn(process.execPath, args, {
    env,
    stdio: ipc ? ["ignore", fd, fd, "ipc"] : ["ignore", fd, fd],
  });
  closeSync(fd);
  children.push(child);
  return child;
}
async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    "owned process stop",
    10000,
  );
}
function pass(name: string) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof spawn> | undefined;
let ownedProcessPid: number | undefined;
async function control(
  action: "issue" | "revoke" | "cleanup",
  runId?: string,
): Promise<RemoteToolGrant | undefined> {
  assert(server?.connected);
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server!.off("message", receive);
      reject(new Error("grant control timeout"));
    }, 10000);
    const receive = (message: { id: string; ok: boolean; grant?: RemoteToolGrant }) => {
      if (message.id !== id) return;
      clearTimeout(timeout);
      server!.off("message", receive);
      if (message.ok) resolve(message.grant);
      else reject(new Error("private grant control failed"));
    };
    server!.on("message", receive);
    server!.send({ id, action, runId });
  });
}
try {
  server = launch(
    ["--import", "tsx", "tests/fixtures/lease-force-service.ts"],
    "service.log",
    true,
  );
  await until(async () => {
    try {
      return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, "production health");
  browser = await chromium.launch();
  const context = await browser.newContext();
  const signup = await context.request.post(base + "/api/auth/sign-up/email", {
    headers: { origin: base },
    data: {
      email: `remote-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Remote verifier",
    },
  });
  assert.equal(signup.status(), 200, "new account signup");
  const account = await signup.json();
  const page = await context.newPage();
  await page.goto(base);
  assert.equal(page.url().startsWith(base), true);
  pass("real production service, Chromium, isolated SQLite and new account");
  Object.assign(process.env, {
    DATABASE_URL: env.DATABASE_URL,
    APP_ORIGIN: base,
    SPROUT_PI_ENABLED: "false",
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
  });
  const { sqlite } = await import("../../src/db");
  const { createMachine, saveProjectMachineBinding } = await import("../../src/domain/machine");
  const { seedRemoteActor } = await import("./remote-actors");
  const bootId = (
    sqlite.prepare("SELECT id FROM runtime_boot ORDER BY started_at DESC LIMIT 1").get() as {
      id: string;
    }
  ).id;
  const projectId = newId(ID_PREFIXES.project),
    projectB = newId(ID_PREFIXES.project);
  for (const project of [projectId, projectB])
    sqlite
      .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Worker remote acceptance',?)")
      .run(project, account.user.id);
  const actor = seedRemoteActor(sqlite, account.user.id, projectId, bootId, false);
  const actorB = seedRemoteActor(sqlite, account.user.id, projectB, bootId, false);
  const nonHolder = seedRemoteActor(sqlite, account.user.id, projectId, bootId, false);
  const otherContext = await browser.newContext();
  const otherSignup = await otherContext.request.post(base + "/api/auth/sign-up/email", {
    headers: { origin: base },
    data: {
      email: `other-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Other remote verifier",
    },
  });
  assert.equal(otherSignup.status(), 200);
  const otherAccount = await otherSignup.json(),
    otherProject = newId(ID_PREFIXES.project);
  sqlite
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Other owner',?)")
    .run(otherProject, otherAccount.user.id);
  const otherActor = seedRemoteActor(sqlite, otherAccount.user.id, otherProject, bootId, false);
  const now = () => ({ ...actor, now: new Date(), requestId: newId(ID_PREFIXES.request) });
  const machine = createMachine({ name: "Live macOS remote" }, now());
  const machineId = machine.detail.machine.id,
    key = { projectId, machineId };
  saveProjectMachineBinding({ ...key, description: "acceptance", expectedRevision: null }, now());
  saveProjectMachineBinding(
    { projectId: projectB, machineId, description: "independent lease", expectedRevision: null },
    now(),
  );
  const machineB = createMachine({ name: "Project B only" }, now()).detail.machine.id;
  saveProjectMachineBinding(
    { projectId: projectB, machineId: machineB, description: "B only", expectedRevision: null },
    now(),
  );
  sqlite
    .prepare("UPDATE agent_run SET status='queued',started_at=NULL WHERE id=?")
    .run(actor.runId);
  const grant = (await control("issue", actor.runId))!;
  const grantB = (await control("issue", actorB.runId))!;
  const nonHolderGrant = (await control("issue", nonHolder.runId))!;
  const otherGrant = (await control("issue", otherActor.runId))!;
  const req = () => newId(ID_PREFIXES.request);
  async function call<T>(
    type: string,
    input: unknown,
    credential: RemoteToolGrant | null = grant,
    extra: Record<string, string> = {},
  ) {
    const response = await fetch(base + "/api/remote/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential.secret}` } : {}),
        ...extra,
      },
      body: JSON.stringify({ version: 1, call: { type, input } }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, result: (await response.json()) as AppResult<T> };
  }
  async function good<T>(type: string, input: unknown, credential = grant): Promise<T> {
    const { status, result } = await call<T>(type, input, credential);
    assert.equal(status, 200);
    if (!result.ok) throw new Error(`HTTP operation rejected: ${result.error.code}`);
    return result.data;
  }
  async function rejected(
    type: string,
    input: unknown,
    code: string,
    credential: RemoteToolGrant | null = grant,
    status = 200,
    headers = {},
  ) {
    const response = await call(type, input, credential, headers);
    assert.equal(response.status, status);
    assert.equal(response.result.ok, false);
    assert.equal(response.result.error?.code, code);
  }
  await rejected("lease_get", key, "remote_run_inactive", grant, 401);
  sqlite
    .prepare("UPDATE agent_run SET status='running',started_at=? WHERE id=?")
    .run(Math.floor(Date.now() / 1000), actor.runId);
  await rejected("lease_get", key, "remote_grant_invalid", null, 401);
  await rejected("lease_get", key, "forbidden", grant, 403, { origin: base });
  await rejected("lease_get", { projectId: projectB, machineId }, "not_found");
  pass(
    "Agent HTTP requires live running grant, rejects cookie-less missing credentials and every Origin",
  );
  const ticket = join(directory, "private-ticket");
  writeFileSync(ticket, machine.ticket, { mode: 0o600 });
  const state = join(directory, "private-state");
  const init = launch(
    [
      "dist/worker/main.js",
      "init",
      "--server",
      base,
      "--machine",
      machineId,
      "--state-dir",
      state,
      "--ticket-file",
      ticket,
    ],
    "init.log",
  );
  await until(() => init.exitCode !== null, "Worker enrollment");
  assert.equal(init.exitCode, 0);
  let worker = launch(["dist/worker/main.js", "run", "--state-dir", state], "worker.log");
  await until(
    () =>
      ((
        sqlite
          .prepare("SELECT seq FROM machine_connection WHERE machine_id=? ORDER BY generation DESC")
          .get(machineId) as { seq: number } | undefined
      )?.seq ?? 0) >= 1,
    "Worker heartbeat",
  );
  await good("lease_mutate", {
    ...key,
    action: "acquire",
    requestId: req(),
    expectedGeneration: 0,
  });
  await good(
    "lease_mutate",
    { projectId: projectB, machineId, action: "acquire", requestId: req(), expectedGeneration: 0 },
    grantB,
  );

  const survivor = join(directory, "preserved-file");
  const pidPath = join(directory, "survivor-pid");
  const late = join(directory, "late-side-effect");
  const sentinel = join(directory, "old-generation-must-not-execute");
  const submit = (input: unknown) => good<ExecutionView>("execution_submit", input);
  const execution = await submit({
    ...key,
    requestId: req(),
    authorizationGeneration: 1,
    operation: {
      kind: "shell",
      cwd: directory,
      waitMs: 10000,
      command: `printf '%s' "$$" > '${pidPath}'; printf x > '${survivor}'; sleep 25; printf x > '${late}'; sleep 300`,
    },
  });
  await until(() => existsSync(pidPath) && existsSync(survivor), "real shell started before kill");
  const survivorPid = Number(readFileSync(pidPath, "utf8"));
  assert(Number.isSafeInteger(survivorPid) && survivorPid > 1);
  process.kill(survivorPid, 0);
  ownedProcessPid = survivorPid;
  worker.kill("SIGKILL");
  await until(() => worker.signalCode === "SIGKILL", "real Worker SIGKILL");
  const pending = await good<LeaseMutationView>("lease_mutate", {
    ...key,
    action: "release",
    expectedGeneration: 1,
    requestId: req(),
  });
  assert.equal(pending.state, "pending");
  const force = {
    ...key,
    action: "force_reclaim",
    mutationId: pending.mutationId,
    expectedGeneration: 1,
    confirm: true,
  };
  const before = sqlite
    .prepare("SELECT state,terminal_at,drained_at FROM remote_execution WHERE id=?")
    .get(execution.executionId);
  for (const credential of [grant, nonHolderGrant, grantB, otherGrant]) {
    for (const type of ["lease_force_reclaim", "lease_mutate"]) {
      const response = await call(type, force, credential);
      assert.equal(response.result.ok, false, "Agent HTTP cannot expose force");
      assert.equal(response.status, 200);
      if (!response.result.ok) assert.equal(response.result.error.code, "validation_failed");
    }
  }
  assert.deepEqual(
    sqlite
      .prepare("SELECT state,terminal_at,drained_at FROM remote_execution WHERE id=?")
      .get(execution.executionId),
    before,
  );
  assert.equal((await good<{ lease: LeaseView }>("lease_get", key)).lease.state, "fencing");
  pass(
    "Agent HTTP including non-holder and cross-Project grants cannot force or rewrite executions",
  );
  async function forceBoundary(input: unknown, headers: Record<string, string>) {
    const id = randomUUID();
    return new Promise<AppResult<LeaseMutationView>>((resolve, reject) => {
      const timer = setTimeout(() => {
        server!.off("message", receive);
        reject(new Error("force boundary timeout"));
      }, 10000);
      const receive = (message: {
        id: string;
        ok: boolean;
        result: AppResult<LeaseMutationView>;
      }) => {
        if (message.id !== id) return;
        clearTimeout(timer);
        server!.off("message", receive);
        if (message.ok) resolve(message.result);
        else reject(new Error("force boundary harness failure"));
      };
      server!.on("message", receive);
      server!.send({ id, action: "force_boundary", input, headers });
    });
  }
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const otherCookie = (await otherContext.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  for (const [input, headers, code] of [
    [force, {}, "unauthorized"],
    [force, { authorization: `Bearer ${grant.secret}` }, "unauthorized"],
    [force, { cookie: otherCookie }, "not_found"],
    [{ ...force, projectId: otherProject }, { cookie }, "not_found"],
    [{ ...force, projectId: projectB }, { cookie }, "conflict"],
    [{ ...force, confirm: false }, { cookie }, "validation_failed"],
  ] as const) {
    const result = await forceBoundary(input, headers);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, code);
  }
  assert.equal((await good<{ lease: LeaseView }>("lease_get", key)).lease.generation, 1);
  assert.deepEqual(
    sqlite
      .prepare("SELECT state,terminal_at,drained_at FROM remote_execution WHERE id=?")
      .get(execution.executionId),
    before,
  );
  pass(
    "real Human Fn rejects anonymous, bearer-only, cross-user, cross-Project and missing confirmation without mutation",
  );
  for (const input of [
    { ...key, action: "release", expectedGeneration: 1, requestId: req() },
    {
      ...key,
      action: "handoff",
      expectedGeneration: 1,
      requestId: req(),
      targetInstanceId: nonHolder.instanceId,
    },
  ])
    await rejected("lease_mutate", input, "lease_fencing", grant, 200);
  pass("ordinary release and handoff still return lease_fencing without Human override");
  await page.goto(`${base}/machines/${machineId}?projectId=${projectId}`);
  const widget = page.getByTestId("lease-fencing-facts").first();
  await widget.waitFor();
  await page.setViewportSize({ width: 1200, height: 1000 });
  await widget.getByTestId("lease-fencing-details-trigger").click();
  const details = page.getByTestId("lease-fencing-details");
  const button = details.getByTestId("lease-force-reclaim");
  assert.equal(await details.getByTestId("lease-force-reclaim-confirm").isChecked(), false);
  assert.equal(await button.isDisabled(), true);
  assert.match(await details.innerText(), /旧副作用可能仍在落地/);
  await details.screenshot({ path: resolve(".verify/p4b-fence-force/before-force-light.png") });
  await page.keyboard.press("Escape");
  await page
    .getByTestId(`lease-row-${machineId}`)
    .first()
    .screenshot({
      path: resolve(".verify/p4b-fence-force/before-force-row-light.png"),
    });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => localStorage.setItem("sprout:theme", "dark"));
  await page.reload();
  await widget.getByTestId("lease-fencing-details-trigger").click();
  await details.screenshot({ path: resolve(".verify/p4b-fence-force/before-force-dark-390.png") });
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.evaluate(() => localStorage.setItem("sprout:theme", "light"));
  await page.reload();
  await widget.getByTestId("lease-fencing-details-trigger").click();
  assert(!existsSync(late), "late side effect has not occurred before force");
  await details.getByTestId("lease-force-reclaim-confirm").check();
  await button.click();
  await until(
    () =>
      (
        sqlite
          .prepare("SELECT state FROM machine_lease WHERE project_id=? AND machine_id=?")
          .get(projectId, machineId) as { state: string }
      ).state === "free",
    "Human UI force commits",
  );
  assert.equal(
    (
      sqlite
        .prepare("SELECT generation FROM machine_lease WHERE project_id=? AND machine_id=?")
        .get(projectId, machineId) as { generation: number }
    ).generation,
    2,
  );
  const receipt = await forceBoundary(force, { cookie });
  assert(receipt.ok);
  assert.equal(receipt.data.completedGeneration, 2);
  assert.equal(receipt.data.forcedReclaim?.supersededMutationId, pending.mutationId);
  const duplicateBeforeAcquire = await forceBoundary(force, { cookie });
  assert(duplicateBeforeAcquire.ok);
  assert.deepEqual(duplicateBeforeAcquire.data, receipt.data);
  assert.deepEqual(
    sqlite
      .prepare("SELECT state,failure_reason,drained_at FROM remote_execution WHERE id=?")
      .get(execution.executionId),
    { state: "unknown", failure_reason: "worker_lost", drained_at: null },
  );
  assert.equal(
    (await good<ExecutionView>("execution_get", { ...key, executionId: execution.executionId }))
      .state,
    "unknown",
  );
  pass(
    "real Chromium Human confirmation advances exactly once; unknown worker_lost retains NULL drained_at",
  );
  const acquired = await good<LeaseMutationView>(
    "lease_mutate",
    { ...key, action: "acquire", expectedGeneration: 2, requestId: req() },
    nonHolderGrant,
  );
  assert.equal(acquired.completedGeneration, 3);
  assert(!existsSync(late), "new holder acquired while old side effect was still pending");
  await rejected(
    "execution_submit",
    {
      ...key,
      requestId: req(),
      authorizationGeneration: 1,
      operation: {
        kind: "file_write",
        path: sentinel,
        content: "must not execute",
        mode: "overwrite",
      },
    },
    "lease_stale_generation",
    grant,
    200,
  );
  assert(!existsSync(sentinel));
  assert.equal(
    (await good<{ lease: LeaseView }>("lease_get", { projectId: projectB, machineId }, grantB))
      .lease.generation,
    1,
  );
  process.kill(survivorPid, 0);
  assert.equal(statSync(survivor).size, 1);
  await until(
    () => existsSync(late),
    "old shell continues its side effect after Worker SIGKILL",
    30000,
  );
  process.kill(survivorPid, 0);
  assert.equal(statSync(late).size, 1);
  pass(
    "new holder acquires immediately; old-generation sentinel absent; original process and files survive",
  );
  const duplicate = await forceBoundary(force, { cookie });
  assert(duplicate.ok);
  assert.deepEqual(duplicate.data, receipt.data);
  assert.equal((await good<{ lease: LeaseView }>("lease_get", key)).lease.generation, 3);
  assert(!existsSync(sentinel));
  assert.deepEqual(
    sqlite
      .prepare("SELECT state,failure_reason,drained_at FROM remote_execution WHERE id=?")
      .get(execution.executionId),
    { state: "unknown", failure_reason: "worker_lost", drained_at: null },
  );
  await page.reload();
  await page.getByTestId(`lease-row-${machineId}`).first().waitFor();
  assert.equal(await page.getByTestId("lease-force-reclaim").count(), 0);
  await page
    .getByTestId(`lease-row-${machineId}`)
    .first()
    .screenshot({ path: resolve(".verify/p4b-fence-force/after-force-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => localStorage.setItem("sprout:theme", "dark"));
  await page.reload();
  await page
    .getByTestId(`lease-row-${machineId}`)
    .first()
    .screenshot({ path: resolve(".verify/p4b-fence-force/after-force-dark.png") });
  process.kill(-survivorPid, "SIGTERM");
  ownedProcessPid = undefined;
  facts.force = {
    workerSigkill: true,
    oldGeneration: 1,
    forcedGeneration: 2,
    newHolderGeneration: 3,
    unknown: true,
    drainedAt: null,
    sentinelAbsent: true,
    processAndFilesPreserved: true,
    newHolderAcquiredBeforeLateSideEffect: true,
    lateSideEffectObservedAfterForce: true,
    port,
  };
  writeFileSync(
    resolve(".verify/p4b-fence-force/evidence.json"),
    JSON.stringify(
      {
        checks,
        facts,
        privateDataExcluded: true,
        limitations: [
          "Cross-machine network and physical soft keyboard not tested.",
          "Grant issuance uses private IPC harness; all Agent requests use real HTTP and force uses real Human Fn/UI.",
        ],
      },
      null,
      2,
    ),
  );
  console.log("PASS force real environment evidence .verify/p4b-fence-force/evidence.json");
} finally {
  if (ownedProcessPid) {
    try {
      process.kill(-ownedProcessPid, "SIGTERM");
    } catch {
      /* Already exited. */
    }
  }
  if (server?.connected) await control("cleanup").catch(() => {});
  for (const child of children.reverse()) await stop(child);
  await browser?.close();
}
