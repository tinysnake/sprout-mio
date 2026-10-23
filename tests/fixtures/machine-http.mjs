import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { chromium } from "playwright";

const startRequire = createRequire(import.meta.resolve("@tanstack/react-start"));
const clientRequire = createRequire(
  startRequire.resolve("@tanstack/start-client-core/package.json"),
);
const { fromCrossJSON, toJSON } = clientRequire("seroval");
mkdirSync(resolve(".verify"), { recursive: true });
const evidenceDir = mkdtempSync(resolve(".verify") + "/t-machine-worker-");
const artifactDir = mkdtempSync(join(tmpdir(), "sprout-worker-standalone-"));
copyFileSync("dist/worker/main.js", join(artifactDir, "main.mjs"));
const port = await new Promise((done, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => done(port));
  });
});
const base = `http://127.0.0.1:${port}`;
assert(port >= 3340);
const database = join(evidenceDir, "machine.sqlite");
const env = {
  ...process.env,
  DATABASE_URL: database,
  APP_ORIGIN: base,
  PORT: String(port),
  NITRO_PORT: String(port),
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  SPROUT_PI_ENABLED: "false",
};
const children = new Set();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function launch(command, args, log, options = {}) {
  const fd = openSync(join(evidenceDir, log), "w", 0o600);
  const child = spawn(command, args, {
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
    ...options,
  });
  closeSync(fd);
  child.completion = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  children.add(child);
  return child;
}
function kill(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function complete(child, milliseconds = 15000) {
  const timer = setTimeout(() => kill(child, "SIGKILL"), milliseconds);
  try {
    const result = await child.completion;
    children.delete(child);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
async function stop(child) {
  kill(child);
  const result = await complete(child);
  assert.equal(result.code, 0, "owned process exits cleanly");
}
async function waitFor(check, label, attempts = 160) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`Timeout ${label}`);
}
const evidence = [];
function pass(check, facts = {}) {
  evidence.push({ check, ...facts });
  writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`PASS ${check} ${JSON.stringify(facts)}`);
}
async function json(path, body, headers = {}) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  return { response, value: await response.json() };
}
function ids() {
  const walk = (path) =>
    readdirSync(path, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(path, e.name))
        : e.name.endsWith(".mjs")
          ? [readFileSync(join(path, e.name), "utf8")]
          : [],
    );
  const result = {};
  for (const match of walk(".output/server")
    .join("\n")
    .matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g))
    result[match[2]] = match[1];
  return result;
}
let cookie;
let server;
let worker;
let sqlite;
let fnIds;
async function rpc(name, data, actorCookie = cookie) {
  assert(fnIds[name], `Missing server function ${name}`);
  const response = await fetch(`${base}/_serverFn/${fnIds[name]}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tsr-serverfn": "true",
      origin: base,
      ...(actorCookie ? { cookie: actorCookie } : {}),
    },
    body: JSON.stringify(toJSON({ data })),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `RPC ${name} HTTP status`);
  const parsed = JSON.parse(text);
  const decoded = parsed.t ? fromCrossJSON(parsed, { refs: new Map() }) : parsed;
  const result = decoded.result ?? decoded;
  assert.equal(
    result.requestId,
    response.headers.get("x-sprout-request-id"),
    "request correlation",
  );
  return result;
}
function wire(extra) {
  return { version: 1, requestId: `req_${randomUUID()}`, ...extra };
}
async function hiddenInit(args, ticketPath) {
  const child = launch(
    "python3",
    [resolve("tests/fixtures/machine-tty.py"), ticketPath, process.execPath, ...args],
    "tty.log",
    { cwd: artifactDir },
  );
  assert.equal((await complete(child, 25000)).code, 0, "hidden ticket init succeeds");
}
try {
  const version = launch(
    process.execPath,
    [join(artifactDir, "main.mjs"), "version"],
    "worker-version.log",
    { cwd: artifactDir },
  );
  assert.equal((await complete(version)).code, 0);
  assert(readFileSync(join(evidenceDir, "worker-version.log"), "utf8").includes("protocol=1"));
  pass("independent bundled Worker starts outside every project lookup chain", {
    artifactDir,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });
  server = launch(process.execPath, [".output/server/index.mjs"], "production.log");
  await waitFor(async () => {
    try {
      return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, "production health");
  sqlite = new Database(database);
  fnIds = ids();
  assert(fnIds.createMachineFn, "Machine RPC must be emitted in production");
  const signup = await json(
    "/api/auth/sign-up/email",
    {
      email: `machine-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Machine verifier",
    },
    { origin: base },
  );
  assert.equal(signup.response.status, 200, "real HTTP signup");
  cookie = signup.response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert(cookie);
  assert.equal((await rpc("createMachineFn", { name: "anon" }, "")).error.code, "unauthorized");
  assert.equal((await rpc("createMachineFn", { name: " " })).error.code, "validation_failed");
  const created = await rpc("createMachineFn", { name: "Real macOS" });
  assert(created.ok);
  const machineId = created.data.detail.machine.id;
  const ticketFile = join(evidenceDir, "ticket");
  writeFileSync(ticketFile, created.data.ticket, { mode: 0o600 });
  const stateDir = join(evidenceDir, "state");
  const initArgs = [
    join(artifactDir, "main.mjs"),
    "init",
    "--server",
    base,
    "--machine",
    machineId,
    "--state-dir",
    stateDir,
    "--ticket-file",
    ticketFile,
  ];
  assert.equal(
    (await complete(launch(process.execPath, initArgs, "init.log", { cwd: artifactDir }))).code,
    0,
  );
  assert.equal(
    (await complete(launch(process.execPath, initArgs, "init-retry.log", { cwd: artifactDir })))
      .code,
    0,
  );
  await hiddenInit(initArgs.slice(0, -2), ticketFile);
  pass("TTY ticket input remains hidden");
  unlinkSync(ticketFile);
  assert.equal((await rpc("renewMachineEnrollmentFn", { machineId })).error.code, "conflict");
  pass("authenticated create, private init, enrollment retry and active-only refusal", {
    machineId,
  });
  worker = launch(
    process.execPath,
    [join(artifactDir, "main.mjs"), "run", "--state-dir", stateDir],
    "worker.log",
    { cwd: artifactDir },
  );
  await waitFor(
    () =>
      sqlite
        .prepare("SELECT seq FROM machine_connection WHERE machine_id=? ORDER BY generation DESC")
        .get(machineId)?.seq > 0,
    "first exchange",
  );
  const initial = sqlite
    .prepare(
      "SELECT generation,boot_id,capability FROM machine_connection WHERE machine_id=? ORDER BY generation DESC",
    )
    .get(machineId);
  const detail = await rpc("getMachineFn", { machineId });
  assert(detail.ok);
  assert.equal(detail.data.connection.kind, "online");
  assert(detail.data.capability.snapshot.shells.some((s) => s.probe.kind === "success"));
  const createdProject = await rpc("createProjectFn", { name: "Machine project" });
  assert(createdProject.ok);
  const projectId = createdProject.data.id;
  const binding = {
    machineId,
    projectId,
    description: "real directory",
    expectedRevision: null,
  };
  assert.equal((await rpc("saveProjectMachineBindingFn", binding)).data.revision, 1);
  assert.equal((await rpc("getMachineFn", { machineId })).data.machine.rootDirectory, null);
  const unconfiguredSeq = sqlite
    .prepare("SELECT seq FROM machine_connection WHERE machine_id=? AND generation=?")
    .get(machineId, initial.generation).seq;
  await waitFor(
    () =>
      sqlite
        .prepare("SELECT seq FROM machine_connection WHERE machine_id=? AND generation=?")
        .get(machineId, initial.generation).seq >=
      unconfiguredSeq + 2,
    "bound Worker polls without root",
  );
  assert.equal(
    sqlite
      .prepare("SELECT count(*) AS n FROM directory_observation WHERE machine_id=?")
      .get(machineId).n,
    0,
  );
  mkdirSync(join(artifactDir, projectId));
  const savedRoot = await rpc("saveMachineRootDirectoryFn", {
    machineId,
    directory: artifactDir,
    expectedRevision: 1,
  });
  assert(savedRoot.ok);
  assert.equal(savedRoot.data.revision, 2);
  await waitFor(
    () =>
      sqlite
        .prepare("SELECT count(*) AS n FROM directory_observation WHERE machine_id=?")
        .get(machineId).n > 0,
    "real directory observation",
  );
  const bound = await rpc("getMachineFn", { machineId, projectId });
  assert.equal(bound.data.bindings[0].observation.current, true);
  assert.equal(bound.data.bindings[0].observation.fact.result.kind, "accessible");
  assert.equal(bound.data.bindings[0].observation.fact.revision, 2);
  assert(bound.data.bindings[0].observation.fact.result.realPath.endsWith(`/${projectId}`));
  pass("real macOS shell and directory facts through authenticated HTTP", {
    machineId,
    projectId,
    generation: initial.generation,
    bootId: initial.boot_id,
  });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addCookies(
      cookie.split("; ").map((part) => {
        const index = part.indexOf("=");
        return {
          name: part.slice(0, index),
          value: part.slice(index + 1),
          url: base,
          httpOnly: true,
          sameSite: "Lax",
        };
      }),
    );
    const page = await context.newPage();
    let pageErrors = 0;
    page.on("pageerror", (error) => {
      pageErrors += 1;
      writeFileSync(join(evidenceDir, "browser-error.log"), String(error));
    });
    await page.goto(base + "/projects");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(evidenceDir, "browser-initial.png"), fullPage: true });
    assert.equal(pageErrors, 0, "authenticated page has no runtime errors");
    await page.getByRole("link", { name: /Machine project 打开 Project 的 Chats/ }).click();
    await page.waitForURL(/\/projects\//);
    await page.getByText("Machine project", { exact: true }).first().waitFor();
    const result = await page.evaluate(
      async ({ url, body }) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-tsr-serverfn": "true" },
          body,
        });
        return response.json();
      },
      {
        url: `${base}/_serverFn/${fnIds.getMachineFn}`,
        body: JSON.stringify(toJSON({ data: { machineId } })),
      },
    );
    const projected = result.t ? fromCrossJSON(result, { refs: new Map() }) : result;
    assert.equal(projected.result.data.connection.kind, "online");
    assert.equal(pageErrors, 0, "existing authenticated UI hydrates");
    await page.screenshot({ path: join(evidenceDir, "authenticated-project.png"), fullPage: true });
    pass("real Chromium authenticated Project and Machine RPC", {
      screenshot: "authenticated-project.png",
      pageErrors,
    });
  } finally {
    await browser.close();
  }
  kill(server, "SIGSTOP");
  await delay(16000);
  kill(server, "SIGCONT");
  await waitFor(
    () =>
      sqlite
        .prepare("SELECT high_water FROM machine_connection_counter WHERE machine_id=?")
        .get(machineId).high_water > initial.generation,
    "live reconnect after heartbeat expiry",
  );
  await waitFor(
    () =>
      sqlite
        .prepare("SELECT seq FROM machine_connection WHERE machine_id=? ORDER BY generation DESC")
        .get(machineId).seq > 0,
    "reconnected exchange",
  );
  pass("same Worker reconnects after real temporary service interruption", {
    machineId,
    generation: sqlite
      .prepare("SELECT high_water FROM machine_connection_counter WHERE machine_id=?")
      .get(machineId).high_water,
  });
  const signupOther = await json(
    "/api/auth/sign-up/email",
    {
      email: `other-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Other",
    },
    { origin: base },
  );
  const otherCookie = signupOther.response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.equal((await rpc("getMachineFn", { machineId }, otherCookie)).error.code, "not_found");
  const rootWrite = { machineId, directory: artifactDir, expectedRevision: 2 };
  assert.equal(
    (await rpc("saveMachineRootDirectoryFn", rootWrite, otherCookie)).error.code,
    "not_found",
  );
  assert.equal((await rpc("saveMachineRootDirectoryFn", rootWrite, "")).error.code, "unauthorized");
  for (const directory of ["relative", "~/work", "/ok\0bad"])
    assert.equal(
      (await rpc("saveMachineRootDirectoryFn", { ...rootWrite, directory })).error.code,
      "validation_failed",
    );
  assert.equal(
    (await rpc("saveProjectMachineBindingFn", binding, otherCookie)).error.code,
    "not_found",
  );
  assert.equal(
    (await rpc("listProjectMachinesFn", { projectId }, otherCookie)).error.code,
    "not_found",
  );
  const identity = JSON.parse(readFileSync(join(stateDir, "identity.json"), "utf8"));
  assert.equal(
    (
      await json(
        "/api/worker/open",
        wire({ machineId, secret: "x".repeat(43), attemptId: randomUUID() }),
      )
    ).value.error.code,
    "unauthorized",
  );
  assert.equal(
    (
      await json(
        "/api/worker/open",
        wire({ machineId, secret: identity.secret, attemptId: randomUUID() }),
        { origin: base },
      )
    ).value.error.code,
    "unauthorized",
  );
  assert.equal(
    (await json("/api/worker/open", { version: 2 })).value.error.code,
    "unsupported_version",
  );
  assert.equal(
    (await json("/api/worker/open", { junk: "x".repeat(2 * 1024 * 1024) })).value.error.code,
    "validation_failed",
  );
  await stop(worker);
  worker = undefined;
  const opened = await json(
    "/api/worker/open",
    wire({ machineId, secret: identity.secret, attemptId: randomUUID() }),
  );
  assert(opened.value.ok);
  const session = opened.value.data.session;
  const cap = JSON.parse(initial.capability);
  const payload = { secret: identity.secret, session, seq: 1, capability: cap, observations: [] };
  assert((await json("/api/worker/exchange", wire(payload))).value.ok);
  const lastSeen = sqlite
    .prepare("SELECT last_seen_at FROM machine_connection WHERE machine_id=? AND generation=?")
    .get(machineId, session.generation).last_seen_at;
  assert((await json("/api/worker/exchange", wire(payload))).value.ok);
  assert.equal(
    sqlite
      .prepare("SELECT last_seen_at FROM machine_connection WHERE machine_id=? AND generation=?")
      .get(machineId, session.generation).last_seen_at,
    lastSeen,
  );
  assert.equal(
    (
      await json(
        "/api/worker/exchange",
        wire({ ...payload, capability: { ...cap, workerVersion: "changed" } }),
      )
    ).value.error.code,
    "conflict",
  );
  assert.equal(
    (
      await json(
        "/api/worker/close",
        wire({ secret: identity.secret, session: { ...session, generation: initial.generation } }),
      )
    ).value.error.code,
    "superseded",
  );
  pass(
    "HTTP refuses cross-owner, bad credentials, Origin, body overflow and stale/changed payload",
    { generation: session.generation },
  );
  assert(
    (
      await rpc("saveProjectMachineBindingFn", {
        ...binding,
        description: "new revision",
        expectedRevision: 1,
      })
    ).ok,
  );
  assert(
    (
      await rpc("saveMachineRootDirectoryFn", {
        machineId,
        directory: join(artifactDir, "changed"),
        expectedRevision: 2,
      })
    ).ok,
  );
  assert.equal(
    (
      await json(
        "/api/worker/exchange",
        wire({
          ...payload,
          seq: 2,
          observations: [
            {
              machineId,
              projectId,
              generation: session.generation,
              revision: 2,
              seq: 2,
              checkedAt: new Date().toISOString(),
              result: { kind: "accessible", realPath: artifactDir },
            },
          ],
        }),
      )
    ).value.error.code,
    "conflict",
  );
  assert((await json("/api/worker/exchange", wire({ ...payload, seq: 2 }))).value.ok);
  assert.equal((await json("/api/worker/exchange", wire(payload))).value.error.code, "conflict");
  pass("HTTP rejects old root revision and lower seq", { generation: session.generation });
  const highWater = session.generation;
  await stop(server);
  server = undefined;
  server = launch(process.execPath, [".output/server/index.mjs"], "production-restart.log");
  await waitFor(async () => {
    try {
      return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, "production restart");
  const restarted = await rpc("getMachineFn", { machineId });
  assert.equal(restarted.data.connection.reason, "host_restarted");
  assert.equal(restarted.data.capability.current, false);
  assert.equal((await json("/api/worker/exchange", wire(payload))).value.error.code, "superseded");
  worker = launch(
    process.execPath,
    [join(artifactDir, "main.mjs"), "run", "--state-dir", stateDir],
    "worker-restart.log",
    { cwd: artifactDir },
  );
  await waitFor(
    () =>
      sqlite
        .prepare("SELECT high_water FROM machine_connection_counter WHERE machine_id=?")
        .get(machineId).high_water > highWater,
    "persisted high-water",
  );
  await waitFor(
    () =>
      sqlite
        .prepare("SELECT seq FROM machine_connection WHERE machine_id=? ORDER BY generation DESC")
        .get(machineId).seq > 0,
    "restart exchange",
  );
  await stop(server);
  server = undefined;
  await delay(5500);
  await stop(worker);
  worker = undefined;
  pass("production SIGTERM, host restart, monotonic generation and interruptible network backoff", {
    machineId,
    priorGeneration: highWater,
  });
  if (process.env.SPROUT_VERIFY_DEV !== "0") {
    server = launch(
      "pnpm",
      ["exec", "vp", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      "dev.log",
      { env: { ...env, NODE_ENV: "development" } },
    );
    await waitFor(
      async () => {
        try {
          return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
          return false;
        }
      },
      "dev health",
      240,
    );
    worker = launch(
      process.execPath,
      [join(artifactDir, "main.mjs"), "run", "--state-dir", stateDir],
      "worker-dev.log",
      { cwd: artifactDir },
    );
    await waitFor(
      () =>
        existsSync(join(evidenceDir, "worker-dev.log")) &&
        readFileSync(join(evidenceDir, "worker-dev.log"), "utf8").includes("worker.exchange"),
      "dev real Worker",
    );
    await stop(worker);
    worker = undefined;
    kill(server);
    await complete(server);
    server = undefined;
    pass("dev service accepts the same independent Worker identity");
  }
  pass("evidence retained without secrets", { evidenceDir, artifactDir });
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : "verification failure"}`);
  process.exitCode = 1;
} finally {
  for (const child of children) kill(child, "SIGKILL");
  await Promise.allSettled([...children].map((child) => complete(child, 1000)));
  sqlite?.close();
  console.log(`Evidence ${evidenceDir}`);
}
