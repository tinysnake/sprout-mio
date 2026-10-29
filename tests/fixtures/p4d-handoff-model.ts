// I-P4d live handoff through a real model: the real Pi agent (configured model,
// real credentials, Sprout extension) dispatches the long command, acquires the
// lease and performs the handoff. The new holder is a fixture-seeded agent and
// reads the same execution/log over the real Agent HTTP boundary. If no real Pi
// credentials exist this script prints SKIP and exits 2; it never turns a
// missing model into a pass. The model-free path is ap-p4d-handoff-worker.sh.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ExecutionLogReadView, ExecutionView, RemoteToolGrant } from "../../src/contracts/remote";
import type { LeaseView } from "../../src/contracts/lease";
import type { AppResult } from "../../src/contracts/result";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
if (!existsSync(join(agentDir, "auth.json"))) {
  console.error("SKIPPED real Pi credentials missing; live model handoff is not PASS");
  process.exit(2);
}
assert.equal(process.platform, "darwin", "real macOS Worker required");
assert(
  existsSync(".output/server/index.mjs") && existsSync("dist/worker/main.js"),
  "run scripts/verify-live/p4d-handoff.sh to prepare current app and Worker artifacts",
);
mkdirSync(".verify", { recursive: true });
const directory = resolve(".verify/p4d-handoff-model");
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until<T>(
  check: () => T | Promise<T>,
  message: string,
  ms = 60000,
): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    await sleep(200);
  }
  throw new Error(`Timeout: ${message}`);
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((res) => server.close(() => res()));
  assert.notEqual(port, 3000);
  return port;
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const model = process.env.SPROUT_VERIFY_PI_MODEL ?? "deepseek/deepseek-flash";
const environment = {
  ...process.env,
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  DATABASE_URL: join(directory, "private.sqlite"),
  APP_ORIGIN: base,
  PORT: String(port),
  NITRO_PORT: String(port),
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  SPROUT_PI_ENABLED: "true",
  SPROUT_PI_DATA_DIR: join(directory, "private-pi"),
  SPROUT_REPO_DIR: join(directory, "private-repos"),
};
delete (environment as Record<string, string | undefined>).SPROUT_PI_RUNNER;
const children: ReturnType<typeof spawn>[] = [];
function launch(args: string[], name: string, ipc = false) {
  const fd = openSync(join(directory, name), "w", 0o600);
  const child = spawn(process.execPath, args, {
    env: environment,
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
    15000,
  );
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function writeTimes(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value));
}
function maxGapMs(times: number[]): number {
  let gap = 0;
  for (let index = 1; index < times.length; index += 1)
    gap = Math.max(gap, (times[index]! - times[index - 1]!) / 1e6);
  return Math.round(gap);
}
const startRequire = createRequire(import.meta.resolve("@tanstack/react-start"));
const clientRequire = createRequire(startRequire.resolve("@tanstack/start-client-core/package.json"));
const { fromCrossJSON, toCrossJSON } = clientRequire("seroval") as {
  fromCrossJSON: (value: unknown, options: { refs: Map<unknown, unknown> }) => unknown;
  toCrossJSON: (value: unknown) => unknown;
};
function serverFnIds() {
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(path, entry.name))
        : entry.name.endsWith(".mjs")
          ? [join(path, entry.name)]
          : [],
    );
  const source = walk(".output/server")
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  return Object.fromEntries(
    [...source.matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)].map((match) => [
      match[2],
      match[1],
    ]),
  ) as Record<string, string>;
}
let server: ReturnType<typeof spawn> | undefined;
let worker: ReturnType<typeof spawn> | undefined;
let sqlite: import("better-sqlite3").Database | undefined;
const checks: string[] = [];
const facts: Record<string, unknown> = {};
function pass(name: string, output: Record<string, unknown> = {}) {
  checks.push(name);
  facts[name] = output;
  console.log(`PASS LIVE ${name} ${JSON.stringify(output)}`);
}
async function control(action: "issue" | "cleanup", runId?: string): Promise<RemoteToolGrant | undefined> {
  assert(server?.connected);
  const id = randomUUID();
  return new Promise((done, reject) => {
    const timer = setTimeout(() => {
      server!.off("message", receive);
      reject(new Error("grant control timeout"));
    }, 10000);
    const receive = (message: { id: string; ok: boolean; grant?: RemoteToolGrant }) => {
      if (message.id !== id) return;
      clearTimeout(timer);
      server!.off("message", receive);
      if (message.ok) done(message.grant);
      else reject(new Error("private grant control failed"));
    };
    server!.on("message", receive);
    server!.send({ id, action, runId });
  });
}
try {
  server = launch(["--import", "tsx", "tests/fixtures/worker-remote-service.ts"], "service.log", true);
  await until(async () => {
    try {
      return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, "production health");
  const signup = await fetch(base + "/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({
      email: `handoff-model-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Handoff model verifier",
    }),
  });
  assert.equal(signup.status, 200);
  const cookie = signup.headers
    .getSetCookie()
    .find((value) => value.includes("session_token="))!
    .split(";")[0]!;
  const account = (await signup.json()) as { user: { id: string } };
  const ids = serverFnIds();
  async function call<T>(name: string, data: unknown): Promise<T> {
    assert(ids[name], `built ${name} missing`);
    const response = await fetch(`${base}/_serverFn/${ids[name]}`, {
      method: "POST",
      headers: {
        Origin: base,
        Cookie: cookie,
        "content-type": "application/json",
        "x-tsr-serverfn": "true",
        accept: "application/json",
      },
      body: JSON.stringify({ t: toCrossJSON({ data }), f: 127, m: [] }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, `${name} HTTP ${response.status}: ${body.slice(0, 300)}`);
    const { result } = fromCrossJSON(JSON.parse(body), { refs: new Map() }) as {
      result: AppResult<T>;
    };
    assert(result.ok, `${name} rejected ${JSON.stringify(result)}`);
    return result.data;
  }
  const projectId = (await call<{ id: string }>("createProjectFn", { name: "P4d handoff model" })).id;
  const profile = await call<{ id: string }>("createAgentProfileFn", {
    name: "Live handoff operator",
    persona:
      "Call exactly the Sprout remote tools requested with the exact arguments given. Never use host bash, edit or read. Never retry or change a generation.",
    model,
    effort: "off",
  });
  await call("addProjectMemberFn", { projectId, agentProfileId: profile.id });
  const chat = await call<{ chat?: { id: string }; id?: string; instance?: { id: string } }>(
    "createDirectChatFn",
    { projectId, agentProfileId: profile.id },
  );
  const chatId = chat.chat?.id ?? chat.id!;
  const enrollment = await call<{
    ticket: string;
    detail: { machine: { id: string; rootRevision: number } };
  }>("createMachineFn", { name: "P4d handoff model macOS" });
  const machineId = enrollment.detail.machine.id;
  const root = join(directory, "machine-root");
  mkdirSync(join(root, projectId), { recursive: true });
  await call("saveMachineRootDirectoryFn", {
    machineId,
    directory: root,
    expectedRevision: enrollment.detail.machine.rootRevision,
  });
  await call("saveProjectMachineBindingFn", {
    machineId,
    projectId,
    description: "model handoff",
    expectedRevision: null,
  });
  const ticketFile = join(directory, "private-ticket");
  writeFileSync(ticketFile, enrollment.ticket, { mode: 0o600 });
  const stateDir = join(directory, "private-state");
  const init = launch(
    [
      "dist/worker/main.js",
      "init",
      "--server",
      base,
      "--machine",
      machineId,
      "--state-dir",
      stateDir,
      "--ticket-file",
      ticketFile,
      "--allow-http",
      base,
    ],
    "init.log",
  );
  await until(() => init.exitCode !== null, "Worker enrollment");
  assert.equal(init.exitCode, 0);
  worker = launch(["dist/worker/main.js", "run", "--state-dir", stateDir], "worker.log");
  await until(
    async () => (await call<{ connection: { kind: string } }>("getMachineFn", { machineId })).connection.kind === "online",
    "Worker online",
    60000,
  );
  await until(async () => {
    const machine = await call<{
      bindings: { observation?: { fact?: { result?: { kind?: string } } } }[];
    }>("getMachineFn", { machineId, projectId });
    return machine.bindings[0]?.observation?.fact?.result?.kind === "accessible";
  }, "directory ready", 60000);
  pass("real macOS Worker online and directory confirmed for the model path", { model });

  Object.assign(process.env, {
    DATABASE_URL: environment.DATABASE_URL,
    APP_ORIGIN: base,
    SPROUT_PI_ENABLED: "true",
  });
  const dbModule = await import("../../src/db");
  sqlite = dbModule.sqlite;
  const db = sqlite as import("better-sqlite3").Database;
  const { seedRemoteActor } = await import("./remote-actors");
  const bootId = (
    db.prepare("SELECT id FROM runtime_boot ORDER BY started_at DESC LIMIT 1").get() as {
      id: string;
    }
  ).id;
  const actorB = seedRemoteActor(db, account.user.id, projectId, bootId, false);
  const grantB = (await control("issue", actorB.runId))!;
  const req = () => newId(ID_PREFIXES.request);
  const pidFile = join(root, "pid");
  const writes = join(root, "writes");
  const stopFile = join(root, "stop");
  const command = `echo $$ > '${pidFile}'; while [ ! -f '${stopFile}' ]; do printf 'tick %s\\n' "$(date +%s%N)"; printf '%s\\n' "$(date +%s%N)" >> '${writes}'; sleep 0.2; done`;
  const acquireRequest = req();
  const shellRequest = req();
  const handoffRequest = req();
  const body = [
    "You are the current lease operator. Call these three Sprout tools exactly once each, in this order, with exactly these arguments. Do not use any other tool, do not retry, do not change values, and do not stop to ask.",
    `1) sprout_lease_acquire with ${JSON.stringify({ machineId, expectedGeneration: 0, requestId: acquireRequest })}`,
    `2) sprout_remote_shell with ${JSON.stringify({ machineId, authorizationGeneration: 1, requestId: shellRequest, command, cwd: root, waitMs: 1000 })}`,
    `3) sprout_lease_handoff with ${JSON.stringify({ machineId, expectedGeneration: 1, targetInstanceId: actorB.instanceId, requestId: handoffRequest })}`,
    "After the calls, reply with one short line naming the returned states. Do not release the lease.",
  ].join("\n");
  await call("sendMessageFn", { chatId, body });
  const lease = () =>
    call<{ lease: LeaseView }>("getLeaseFn", { projectId, machineId });
  let holderA = "";
  await until(async () => {
    const current = (await lease()).lease;
    if (current.state !== "held") return false;
    holderA = current.holderInstanceId!;
    return true;
  }, "model acquires lease", 180000);
  assert(holderA, "model lease holder");
  const execution = await until(() => {
    const row = db
      .prepare(
        "SELECT id, state, authorization_generation FROM remote_execution WHERE project_id=? AND request_id=?",
      )
      .get(projectId, shellRequest) as
      | { id: string; state: string; authorization_generation: number }
      | undefined;
    return row;
  }, "model dispatches remote shell", 180000);
  assert.equal(execution.authorization_generation, 1);
  await until(() => writeTimes(writes).length >= 3, "model command periodic writes", 60000);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await until(
    async () => {
      const current = (await lease()).lease;
      return current.generation === 2 && current.holderInstanceId === actorB.instanceId;
    },
    "model handoff completes to g+1/B",
    180000,
  );
  const framesAtHandoff = (
    db
      .prepare("SELECT MAX(sequence) AS max FROM execution_log_frame WHERE execution_id=?")
      .get(execution.id) as { max: number | null }
  ).max ?? 0;
  assert(framesAtHandoff > 0, "log frames must exist before the handoff completes");
  pass("real model acquired g/A, dispatched the long command and handed off to g+1/B", {
    acquireRequest,
    shellRequest,
    handoffRequest,
    framesAtHandoff,
    model,
  });

  async function good<T>(
    type: string,
    input: unknown,
    credential: RemoteToolGrant,
  ): Promise<T> {
    const response = await fetch(base + "/api/remote/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential.secret}`,
      },
      body: JSON.stringify({ version: 2, call: { type, input } }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as AppResult<T>;
    if (!result.ok) throw new Error(`${type} rejected ${result.error.code}`);
    return result.data;
  }
  const inherited = await good<ExecutionView>(
    "execution_get",
    { projectId, machineId, executionId: execution.id },
    grantB,
  );
  assert.equal(inherited.executionId, execution.id);
  assert.equal(inherited.authority, "inherited");
  assert.equal(inherited.authorizationGeneration, 1);
  assert.equal(inherited.currentAuthorizationGeneration, 2);
  assert.equal(inherited.holderInstanceId, holderA);
  const logB = await good<ExecutionLogReadView>(
    "execution_log_read",
    { projectId, machineId, executionId: execution.id, cursor: null, limitBytes: 65536 },
    grantB,
  );
  assert(
    Math.max(...logB.frames.map((frame) => frame.sequence)) >= framesAtHandoff,
    "B must read frames that existed before the handoff",
  );
  await until(() => writeTimes(writes).length > 0 && alive(pid), "model command still alive");
  await sleep(2000);
  const writesAfter = writeTimes(writes);
  assert(alive(pid), "handoff must not kill the model-dispatched command");
  assert(maxGapMs(writesAfter) < 3000, `write gap ${maxGapMs(writesAfter)}ms`);
  pass("B reads the same model-dispatched execution and frames; process/writes survive handoff", {
    executionId: execution.id,
    framesAtHandoff,
    framesSeenByB: Math.max(...logB.frames.map((frame) => frame.sequence)),
    stateAfterHandoff: inherited.state,
    failureReasonAfterHandoff: inherited.failureReason ?? null,
    pidAlive: alive(pid),
    maxGapMs: maxGapMs(writesAfter),
  });

  const run = db
    .prepare("SELECT id, status, config_snapshot FROM agent_run WHERE chat_id=? ORDER BY rowid DESC LIMIT 1")
    .get(chatId) as
    | { id: string; status: string; config_snapshot: string | null }
    | undefined;
  await until(() => {
    const row = db
      .prepare("SELECT status FROM agent_run WHERE chat_id=? ORDER BY rowid DESC LIMIT 1")
      .get(chatId) as { status: string } | undefined;
    return row && !["queued", "running"].includes(row.status);
  }, "real model run settles", 180000);
  const settled = db
    .prepare("SELECT id, status, config_snapshot FROM agent_run WHERE chat_id=? ORDER BY rowid DESC LIMIT 1")
    .get(chatId) as { id: string; status: string; config_snapshot: string | null };
  const snapshot = settled.config_snapshot
    ? (JSON.parse(settled.config_snapshot) as { provider: string; model: string; sessionFile: string })
    : undefined;
  const toolCalls: string[] = [];
  if (snapshot?.sessionFile && existsSync(snapshot.sessionFile)) {
    for (const line of readFileSync(snapshot.sessionFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as {
          message?: { role?: string; content?: { type?: string; name?: string }[] };
        };
        if (entry.message?.role !== "assistant") continue;
        for (const part of entry.message.content ?? [])
          if (part.type === "toolCall" && part.name) toolCalls.push(part.name);
      } catch {
        /* session line not JSON */
      }
    }
  }
  assert.equal(settled.status, "completed", `real model run status ${settled.status}`);
  assert(snapshot, "run config snapshot");
  assert(snapshot && `${snapshot.provider}/${snapshot.model}` === model, "real model snapshot");
  for (const name of ["sprout_lease_acquire", "sprout_remote_shell", "sprout_lease_handoff"])
    assert(toolCalls.includes(name), `real model did not call ${name}: ${JSON.stringify(toolCalls)}`);
  pass("real Pi transcript proves the model itself called acquire, shell and handoff", {
    runId: settled.id,
    status: settled.status,
    provider: snapshot.provider,
    model: snapshot.model,
    toolCalls,
    runObservedBeforeSettle: run?.status ?? null,
  });

  writeFileSync(stopFile, "stop");
  await until(() => !alive(pid), "model command exits on its own", 30000);
  const evidence = {
    mode: "real-model-real-worker",
    platform: process.platform,
    model,
    checks,
    facts,
    workerAlive: worker?.exitCode === null,
    privateDirectory: directory,
  };
  writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`PASS LIVE p4d model handoff evidence ${join(directory, "evidence.json")}`);
} catch (error) {
  writeFileSync(
    join(directory, "failure.json"),
    JSON.stringify({ checks, facts, error: String(error) }, null, 2) + "\n",
  );
  throw error;
} finally {
  try {
    if (existsSync(join(directory, "machine-root", "pid"))) {
      const pid = Number(readFileSync(join(directory, "machine-root", "pid"), "utf8"));
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  } catch {
    /* already gone */
  }
  if (server?.connected) await control("cleanup").catch(() => {});
  for (const child of [...children].reverse()) await stop(child);
  sqlite?.close();
}
