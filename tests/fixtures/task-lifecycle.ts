// Production HTTP + private SQLite + the installed Pi SDK/runner + a real Worker.
// The observer only delays original bytes. It never synthesizes runner events or domain results.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { startModelFixture } from "../../scripts/verify/lib/model-fixture.mjs";

const mode = process.env.SPROUT_VERIFY_CHAT_MODE ?? "model-fixture";
assert(["model-fixture", "live"].includes(mode));
const liveModel = process.env.SPROUT_VERIFY_PI_MODEL;
assert(mode !== "live" || liveModel, "live requires SPROUT_VERIFY_PI_MODEL");
const directory = resolve(
  process.env.SPROUT_TASK_EVIDENCE_DIR ?? `.verify/task-lifecycle-${Date.now()}`,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
console.log(`EVIDENCE ${directory}`);
const children: ChildProcess[] = [];
let db: Database.Database | undefined;
let modelFixture: Awaited<ReturnType<typeof startModelFixture>> | undefined;
let cookie = "";
let failure: unknown;
const checks: unknown[] = [];
const startedAt = Date.now();
const facts: Record<string, any> = {
  mode,
  directory,
  startedAt: new Date(startedAt).toISOString(),
};
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until<T>(
  check: () => T | Promise<T>,
  label: string,
  timeout = 60000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    await pause(50);
  }
  throw new Error(`Timeout: ${label}`);
}
function pass(name: string, detail: unknown = {}) {
  checks.push({ name, detail, at: Date.now() });
  console.log(`PASS ${name} ${JSON.stringify(detail)}`);
}
function jsonLines(path: string): any[] {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
const rows = (sql: string, ...params: unknown[]): any[] => db!.prepare(sql).all(...params);
const allRuns = () =>
  rows(
    "SELECT r.*, i.agent_profile_id FROM agent_run r JOIN agent_instance i ON i.id=r.instance_id ORDER BY r.rowid",
  );
const runs = (chatId: string) => allRuns().filter((row) => row.chat_id === chatId);
const inputs = () => rows("SELECT * FROM agent_run_input ORDER BY rowid");
const trace = join(directory, "runner-wire.jsonl");
const network = join(directory, "model-requests.jsonl");
const controls = join(directory, "controls.json");
let control: Record<string, any> = {};
function configure(update: Record<string, any>) {
  control = { ...control, ...update };
  writeFileSync(controls, JSON.stringify(control), { mode: 0o600 });
}
const release = (tag: string) => writeFileSync(join(directory, `release-${tag}`), "release\n");
const wire = () => jsonLines(trace);
const sent = () =>
  wire().filter(
    (entry) => entry.direction === "command" && ["prompt", "steer"].includes(entry.value.type),
  );
const modelRequests = () => jsonLines(network);
function textOf(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  return value?.text ?? textOf(value?.content ?? value?.parts ?? "");
}
async function settled(chatId: string) {
  return until(() => {
    const current = runs(chatId);
    return (
      current.length > 0 &&
      current.every((run) => !["queued", "running"].includes(run.status)) &&
      current
    );
  }, `all runs settled in ${chatId}`);
}
const listener = createServer();
await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
const address = listener.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
await new Promise<void>((done) => listener.close(() => done()));
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  DATABASE_URL: join(directory, "private.sqlite"),
  APP_ORIGIN: base,
  PORT: String(address.port),
  NITRO_PORT: String(address.port),
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  SPROUT_PI_ENABLED: "true",
  SPROUT_PI_DATA_DIR: join(directory, "private-pi"),
  SPROUT_REPO_DIR: join(directory, "private-repos"),
};
delete environment.SPROUT_PI_RUNNER;
function launch(args: string[], log: string) {
  const fd = openSync(join(directory, log), "w", 0o600);
  const child = spawn(process.execPath, args, { env: environment, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.on("error", (error) => {
    facts[`${log}SpawnError`] = String(error);
  });
  children.push(child);
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      "child termination",
      10000,
    );
  } catch {
    child.kill("SIGKILL");
    await until(() => child.exitCode !== null || child.signalCode !== null, "child kill", 5000);
  }
}
const startRequire = createRequire(import.meta.resolve("@tanstack/react-start"));
const clientRequire = createRequire(
  startRequire.resolve("@tanstack/start-client-core/package.json"),
);
const { fromCrossJSON, toCrossJSON } = clientRequire("seroval");
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
const source = files(".output/server")
  .filter((path) => path.endsWith(".mjs"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const ids = Object.fromEntries(
  [...source.matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)].map((m) => [m[2], m[1]]),
);
const getFunctions = new Set(["getTaskDetailFn", "getProjectTasksFn"]);
async function rawCall(name: string, data: unknown): Promise<any> {
  assert(ids[name], `production HTTP server function missing: ${name}`);
  const payload = JSON.stringify({ t: toCrossJSON({ data }), f: 127, m: [] });
  const method = getFunctions.has(name) ? "GET" : "POST";
  const url = `${base}/_serverFn/${ids[name]}${method === "GET" ? `?payload=${encodeURIComponent(payload)}` : ""}`;
  const response = await fetch(url, {
    method,
    headers: {
      Origin: base,
      Cookie: cookie,
      "content-type": "application/json",
      "x-tsr-serverfn": "true",
      accept: "application/json",
    },
    ...(method === "POST" ? { body: payload } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.text();
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}: ${body.slice(0, 500)}`);
  const { result } = fromCrossJSON(JSON.parse(body), { refs: new Map() });
  return result;
}
async function call(name: string, data: unknown): Promise<any> {
  const result = await rawCall(name, data);
  assert(result.ok, `${name}: ${JSON.stringify(result)}`);
  return result.data;
}
const detail = (taskId: string) => call("getTaskDetailFn", { taskId });
const command = (current: any) => ({
  taskId: current.task.id,
  expectedRevision: current.task.revision,
});
async function mutate(name: string, current: any, extra: Record<string, any> = {}) {
  return call(name, { ...command(current), ...extra });
}
const unwrap = (value: any) => value.detail ?? value;
async function change(name: string, current: any, extra: Record<string, any> = {}) {
  return unwrap(await mutate(name, current, extra));
}

// NODE_OPTIONS observes the actual SDK fetch. A gate holds the request before it
// reaches the model, so the test can arm deterministic tools after reading HTTP results.
const preload = join(directory, "observe-fetch.mjs");
writeFileSync(
  preload,
  `
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const config = () => JSON.parse(readFileSync(${JSON.stringify(controls)}, 'utf8'));
const original = globalThis.fetch;
globalThis.fetch = async function(url, options) {
  if (typeof options?.body === 'string' && !String(url).includes('/api/remote/agent')) {
    let input;
    try { input = JSON.parse(options.body); } catch { return original.call(this, url, options); }
    appendFileSync(${JSON.stringify(network)}, JSON.stringify({at: Date.now(), input}) + '\\n');
    const c = config();
    if (c.modelGate && JSON.stringify(input).includes(c.modelGate.text)) {
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({direction:'model-held', tag:c.modelGate.tag, at:Date.now()}) + '\\n');
      while (!existsSync(${JSON.stringify(directory)} + '/release-' + c.modelGate.tag)) await new Promise(done => setTimeout(done, 20));
    }
    if (c.modelError && JSON.stringify(input).includes(c.modelError)) return new Response(JSON.stringify({error:{message:'intentional lifecycle model_error fixture'}}), {status:400, headers:{'content-type':'application/json'}});
  }
  return original.call(this, url, options);
};
`,
  { mode: 0o600 },
);
const observer = join(directory, "runner-observer.mjs");
writeFileSync(
  observer,
  `
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const config = () => JSON.parse(readFileSync(${JSON.stringify(controls)}, 'utf8'));
const record = (direction, value, extra={}) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({at:Date.now(), pid:process.pid, direction, value, ...extra}) + '\\n');
const child = spawn(process.execPath, [${JSON.stringify(resolve("scripts/pi-host-runner.mjs"))}], {env:{...process.env, NODE_OPTIONS:(process.env.NODE_OPTIONS ?? '') + ' --import ' + ${JSON.stringify(preload)}}, stdio:['pipe','pipe','inherit']});
let readyTag; const ackTags = new Map();
const input = createInterface({input:process.stdin});
input.on('line', raw => {
  const value = JSON.parse(raw), c = config();
  if (value.type === 'open') readyTag = c.readyTag;
  if (['prompt','steer'].includes(value.type) && c.ackGate && value.text.includes(c.ackGate.text)) ackTags.set(value.messageId, c.ackGate.tag);
  record('command', value);
  child.stdin.write(raw + '\\n');
}).on('close', () => child.stdin.end());
let received = 0, forwarded = 0, childClosed = false, observerError;
let forwarding = Promise.resolve();
const pending = new Map();
function fail(error) {
  if (observerError) return;
  observerError = String(error);
  record('observer-error', {error:observerError, received, forwarded, pending:[...pending.keys()]});
  child.kill('SIGTERM');
}
createInterface({input:child.stdout}).on('line', raw => {
  const value = JSON.parse(raw);
  const tag = value.type === 'ready' ? readyTag : value.type === 'input_delivered' ? ackTags.get(value.messageId) : undefined;
  const sequence = ++received;
  pending.set(sequence, {value, tag});
  record(tag ? 'held' : 'event', value, {sequence, ...(tag ? {tag} : {})});
  // Capture arrival synchronously; one queue owns every stdout write on this connection.
  forwarding = forwarding.then(async () => {
    while (tag && !existsSync(${JSON.stringify(directory)} + '/release-' + tag)) {
      if (childClosed) throw new Error('runner closed with unreleased held frame ' + sequence + ' (' + tag + ')');
      await new Promise(done => setTimeout(done, 20));
    }
    if (sequence !== forwarded + 1) throw new Error('runner frame forwarded out of arrival order: ' + sequence + ' after ' + forwarded);
    await new Promise((done, reject) => process.stdout.write(raw + '\\n', error => error ? reject(error) : done()));
    forwarded = sequence;
    pending.delete(sequence);
    record('forwarded', value, {sequence, ...(tag ? {tag} : {})});
    if (tag) record('released', value, {tag, sequence});
  });
  void forwarding.catch(fail);
});
// close waits for the child's stdout to end; exit alone can precede its last lines.
child.on('close', async (code, signal) => {
  childClosed = true;
  for (const [sequence, frame] of pending) {
    if (frame.tag && !existsSync(${JSON.stringify(directory)} + '/release-' + frame.tag)) {
      fail(new Error('runner closed with unreleased held frame ' + sequence + ' (' + frame.tag + ')'));
    }
  }
  try {
    await forwarding;
    if (pending.size || forwarded !== received) throw new Error('runner closed with unforwarded frames');
  } catch (error) { fail(error); }
  record('observer-exit', {code, signal, received, forwarded, pending:[...pending.keys()], error:observerError ?? null});
  input.close();
  process.stdout.end(() => process.exit(observerError ? 1 : code ?? 1));
});
child.on('error', fail);
child.stdin.on('error', fail);
process.stdout.on('error', fail);
process.on('SIGTERM', () => child.kill('SIGTERM'));
`,
  { mode: 0o700 },
);
environment.SPROUT_PI_RUNNER = observer;
configure({});
function arm(
  role: Parameters<NonNullable<typeof modelFixture>["arm"]>[0],
  text: string,
  steps: any[],
  reply = "LIFECYCLE_DONE",
) {
  modelFixture?.arm(role, { expectedUserPrefix: text, steps, reply });
}
const taskPrefix = (id: string) => `已分配并请求立即开始\nTask：${id}\n`;
async function modelHeld(tag: string) {
  await until(
    () => wire().some((row) => row.direction === "model-held" && row.tag === tag),
    `model barrier ${tag}`,
  );
}
async function releaseForwarded(tag: string) {
  const held = wire().find((row) => row.direction === "held" && row.tag === tag);
  assert(held, `runner frame held for ${tag}`);
  release(tag);
  await until(() => {
    const observed = wire();
    const error = observed.find(
      (row) => row.pid === held.pid && row.direction === "observer-error",
    );
    assert(!error, `runner observer failed: ${JSON.stringify(error)}`);
    return observed.some(
      (row) =>
        row.pid === held.pid && row.direction === "forwarded" && row.sequence === held.sequence,
    );
  }, `runner frame forwarded for ${tag}`);
}
function grantFor(runId: string) {
  const opened = wire().find(
    (entry) =>
      entry.direction === "command" && entry.value.type === "open" && entry.value.id === runId,
  );
  assert(opened, `real runner open for ${runId}`);
  return opened.value.remote;
}
async function remote(runId: string, type: string, input: Record<string, any>) {
  const grant = grantFor(runId);
  const response = await fetch(grant.endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${grant.secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      version: 2,
      call: { type, input: { ...input, projectId: grant.projectId } },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const result = (await response.json()) as any;
  facts.remoteReceipts ??= [];
  facts.remoteReceipts.push({ runId, type, input, status: response.status, result });
  return result;
}
let finishing = false;
async function finish() {
  if (finishing) return;
  finishing = true;
  clearTimeout(totalTimer);
  facts.checks = checks;
  // Release held bytes before stopping processes, including assertion failure paths.
  for (const row of wire()) if (row.tag) release(row.tag);
  configure({ readyTag: null, modelGate: null, ackGate: null });
  for (const child of [...children].reverse()) await stop(child);
  try {
    const pids = [
      ...new Set(
        wire()
          .filter((row) => row.direction === "command")
          .map((row) => row.pid),
      ),
    ];
    await until(
      () =>
        pids.every((pid) =>
          wire().some((row) => row.pid === pid && row.direction === "observer-exit"),
        ),
      "all runner observers flushed before exit",
      10000,
    );
    for (const pid of pids) {
      const observed = wire().filter((row) => row.pid === pid);
      assert(!observed.some((row) => row.direction === "observer-error"), `observer ${pid} failed`);
      const arrivals = observed.filter((row) => ["held", "event"].includes(row.direction));
      const forwards = observed.filter((row) => row.direction === "forwarded");
      assert.deepEqual(
        forwards.map((row) => ({ sequence: row.sequence, value: row.value })),
        arrivals.map((row) => ({ sequence: row.sequence, value: row.value })),
        `observer ${pid} must forward every original frame exactly once in arrival order`,
      );
      const exit = observed.find((row) => row.direction === "observer-exit").value;
      assert.equal(exit.error, null, `observer ${pid} exit error`);
      assert.deepEqual(exit.pending, [], `observer ${pid} left held/unforwarded frames`);
      assert.equal(exit.forwarded, exit.received, `observer ${pid} did not flush`);
    }
    facts.observers = { connections: pids.length, flushed: true };
  } catch (error) {
    failure ??= error;
    console.error(error);
  }
  facts.error =
    failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure;
  facts.elapsedMs = Date.now() - startedAt;
  if (db) {
    for (const table of [
      "task",
      "task_event",
      "task_checklist_item",
      "agent_run_input",
      "machine",
      "machine_lease",
      "message",
    ])
      facts[table] = rows(`SELECT * FROM ${table}`);
    facts.runs = allRuns();
    facts.transcripts = allRuns().flatMap((run) => {
      const path = run.config_snapshot && JSON.parse(run.config_snapshot).sessionFile;
      return path && existsSync(path) ? [{ runId: run.id, entries: jsonLines(path) }] : [];
    });
    await db.backup(join(directory, "snapshot.sqlite"));
    db.close();
  }
  facts.model = modelFixture?.metadata() ?? { mode, model: liveModel };
  writeFileSync(join(directory, "result.json"), JSON.stringify(facts, null, 2), { mode: 0o600 });
  await modelFixture?.close();
  console.log(`${failure ? "FAIL" : "PASS"} bs-p5b-lifecycle; evidence ${directory}`);
  process.exitCode = failure ? 1 : 0;
}
const totalTimer = setTimeout(() => {
  failure = new Error("lifecycle total timeout (600s)");
  void finish();
}, 600000);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    failure = new Error(signal);
    void finish();
  });

try {
  assert.equal(process.platform, "darwin", "real macOS Worker required");
  if (mode === "model-fixture") {
    modelFixture = await startModelFixture({ privateDir: join(directory, "model-fixture") });
    environment.PI_CODING_AGENT_DIR = modelFixture.agentDir;
  }
  launch([".output/server/index.mjs"], "service.log");
  await until(async () => {
    try {
      return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, "production HTTP health");
  const signup = await fetch(base + "/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({
      email: `lifecycle-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Lifecycle Human",
    }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(signup.status, 200);
  cookie = signup.headers
    .getSetCookie()
    .find((value) => value.includes("session_token="))!
    .split(";")[0]!;
  const account = (await signup.json()) as any;
  const project = await call("createProjectFn", { name: "P5b hermetic lifecycle" });
  facts.projectId = project.id;
  db = new Database(environment.DATABASE_URL!, { readonly: true });
  db.pragma("busy_timeout = 5000");
  async function agent(
    name: string,
    role: Parameters<NonNullable<typeof modelFixture>["model"]>[0],
  ) {
    const value = await call("createAgentProfileFn", {
      name,
      model: modelFixture ? modelFixture.model(role) : liveModel,
      effort: "off",
      persona:
        "Follow Task instructions exactly. Use named Sprout tools with the supplied arguments; do not invent extra tools or change Task status. Reply briefly.",
    });
    await call("addProjectMemberFn", { projectId: project.id, agentProfileId: value.id });
    return value;
  }
  const owner = await agent("LifecycleOwner", "chatOwner");
  const member = await agent("LifecycleMember", "chatMentioned");
  const idle = await agent("LifecycleIdle", "status");
  const oldAgent = await agent("LifecycleOld", "chatUnmentioned");
  const newAgent = await agent("LifecycleNew", "operator");
  const errorAgent = await agent("LifecycleError", "nonHolder");
  async function group(title: string, lead = owner, others: any[] = []) {
    return call("createGroupChatFn", {
      projectId: project.id,
      title,
      members: [
        { kind: "human", id: account.user.id },
        ...[lead, ...others].map((a) => ({ kind: "agent", id: a.id })),
      ],
      initialOwner: { kind: "agent", id: lead.id },
      wakePolicy: "owner_led",
    });
  }
  async function create(title: string, extra: Record<string, any> = {}) {
    return unwrap(
      await call("createTaskFn", { projectId: project.id, title, checklist: [], ...extra }),
    );
  }
  const chat = await group("Continuous lifecycle", owner, [member, idle]);
  facts.chatId = chat.id;

  // Real Worker and a held lease let completion independence compare actual execution state.
  const enrollment = await call("createMachineFn", { name: "Lifecycle macOS" });
  const machineId = enrollment.detail.machine.id;
  const root = join(directory, "machine-root");
  mkdirSync(join(root, project.id), { recursive: true });
  await call("saveMachineRootDirectoryFn", {
    machineId,
    directory: root,
    expectedRevision: enrollment.detail.machine.rootRevision,
  });
  await call("saveProjectMachineBindingFn", {
    machineId,
    projectId: project.id,
    description: "Lifecycle lease independence",
    expectedRevision: null,
  });
  const ticket = join(directory, "private-ticket");
  writeFileSync(ticket, enrollment.ticket, { mode: 0o600 });
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
      ticket,
      "--allow-http",
      base,
    ],
    "worker-init.log",
  );
  await until(() => init.exitCode !== null, "Worker enrollment");
  assert.equal(init.exitCode, 0);
  launch(["dist/worker/main.js", "run", "--state-dir", stateDir], "worker.log");
  await until(
    async () =>
      (await call("getMachineFn", { machineId, projectId: project.id })).bindings[0]?.observation
        ?.fact?.result?.kind === "accessible",
    "Worker online and accessible",
  );

  let current = await create("Lifecycle task", { checklist: ["first check", "second check"] });
  assert.equal(current.task.status, "proposed");
  const taskId = current.task.id;
  facts.lifecycleTaskId = taskId;
  const baseline = { runs: allRuns().length, inputs: inputs().length };
  current = await change("assignTaskFn", current, { targetChatId: chat.id, startNow: false });
  assert.equal(current.task.status, "assigned");
  assert.equal(allRuns().length, baseline.runs);
  assert.equal(inputs().length, baseline.inputs);
  assert.equal(current.chat.id, chat.id);
  assert(
    current.events.some((event: any) => event.action === "assign" && event.toChatId === chat.id),
  );
  pass(
    "assignment without immediate start creates zero runs and inputs, records Group assignment",
    { taskId, chatId: chat.id },
  );

  let revision = current.task.revision + 2; // metadata update, then reassign/start
  const memberSteps = [
    {
      name: "sprout_task_record_append",
      arguments: { taskId, expectedRevision: revision++, body: "member progress" },
    },
    { name: "sprout_chat_send", arguments: { body: `@LifecycleOwner depth-one return ${taskId}` } },
    ...current.checklist.map((item: any) => ({
      name: "sprout_task_checklist_update",
      arguments: { taskId, expectedRevision: revision++, itemId: item.id, checked: true },
    })),
    {
      name: "sprout_task_record_append",
      arguments: { taskId, expectedRevision: revision++, body: "member final result" },
    },
  ];
  const instructions = (steps: any[]) =>
    `Call these tools once each, in this order, with exactly these arguments: ${steps.map((step) => `${step.name} ${JSON.stringify(step.arguments)}`).join("; ")}. Then reply LIFECYCLE_DONE. Do not call other tools or change Task status.`;
  const memberMessage = `@LifecycleMember collaborate on ${taskId}. ${instructions(memberSteps)}`;
  const ownerSteps = [
    {
      name: "sprout_lease_acquire",
      arguments: { machineId, expectedGeneration: 0, requestId: `req_${randomUUID()}` },
    },
    { name: "sprout_chat_send", arguments: { body: memberMessage } },
  ];
  current = await change("updateTaskFn", current, { description: instructions(ownerSteps) });
  configure({ modelGate: { text: taskId, tag: "lifecycle-owner" } });
  const started = await mutate("reassignTaskFn", current, {
    targetChatId: chat.id,
    startNow: true,
  });
  current = unwrap(started);
  const delivery = started.startDelivery;
  assert(delivery, "start delivery returned");
  await modelHeld("lifecycle-owner");
  const ownerRun = runs(chat.id)[0];
  assert.equal(runs(chat.id).length, 1);
  assert.equal(ownerRun.agent_profile_id, owner.id);
  const delivered = await until(
    () =>
      inputs().find(
        (input) => input.message_id === delivery.messageId && input.disposition === "delivered",
      ),
    "owner start ACK",
  );
  assert.equal(delivered.run_id, ownerRun.id);
  const startCommand = sent().filter((row) => row.value.messageId === delivery.messageId);
  assert.equal(startCommand.length, 1);
  assert.equal(
    startCommand[0].value.text,
    current.lastRecord.body,
    "runner consumes the original HTTP-visible start message",
  );
  const sessionFile = JSON.parse(ownerRun.config_snapshot).sessionFile;
  await until(
    () =>
      jsonLines(sessionFile).some(
        (entry) =>
          entry.message?.role === "user" &&
          textOf(entry.message.content).includes(startCommand[0].value.text),
      ),
    "original start reaches real SDK session",
  );
  assert(
    modelRequests().some(({ input }) =>
      (input.messages ?? input.input ?? input.contents ?? []).some(
        (message: any) =>
          message.role === "user" &&
          textOf(message.content ?? message.parts).includes(startCommand[0].value.text),
      ),
    ),
  );
  facts.ownerPromptEvidence = {
    runId: ownerRun.id,
    messageId: delivery.messageId,
    sessionFile,
    text: startCommand[0].value.text,
  };
  assert.equal(current.task.revision, memberSteps[0].arguments.expectedRevision);
  // Both modes receive identical instructions; only model responses differ.
  arm("chatOwner", taskPrefix(taskId), ownerSteps);
  arm("chatMentioned", memberMessage, memberSteps);
  configure({ modelGate: null });
  release("lifecycle-owner");
  await until(() => runs(chat.id).length === 2, "explicit owner mention starts member");
  await settled(chat.id);
  modelFixture?.assertHealthy();
  current = await detail(taskId);
  assert.equal(current.task.status, "assigned", "normal run settlement does not finish Task");
  assert.equal(runs(chat.id).length, 2, "member @owner cannot recurse beyond depth one");
  assert(runs(chat.id).every((run) => run.status === "completed"));
  assert.equal(current.lastRecord.body, "member final result");
  assert.equal(current.lastRecord.senderId, member.id);
  assert(current.checklist.every((item: any) => item.checked));
  assert(
    current.records.some(
      (record: any) => record.body === "member progress" && record.senderId === member.id,
    ),
  );
  pass(
    "real owner prompt, explicit member run and progress, depth-one return, checklist final record",
    {
      ownerRun: ownerRun.id,
      memberRun: runs(chat.id)[1].id,
      messageId: delivery.messageId,
      taskStatus: current.task.status,
    },
  );
  const leaseBefore = rows("SELECT * FROM machine_lease WHERE machine_id=?", machineId);
  assert(leaseBefore.length > 0 && leaseBefore[0].holder_instance_id, "real Agent acquired lease");
  const machineBefore = rows("SELECT * FROM machine WHERE id=?", machineId);
  current = await change("completeTaskFn", current);
  assert.equal(current.task.status, "finished");
  assert.equal(current.completionRecord.body, "member final result");
  assert.equal(current.completionRecord.seq, Math.max(...current.records.map((r: any) => r.seq)));
  assert.deepEqual(rows("SELECT * FROM machine_lease WHERE machine_id=?", machineId), leaseBefore);
  assert.deepEqual(rows("SELECT * FROM machine WHERE id=?", machineId), machineBefore);
  const firstComplete = rows(
    "SELECT * FROM task_event WHERE task_id=? AND action='complete'",
    taskId,
  );
  assert.equal(firstComplete.length, 1);
  assert.equal(firstComplete[0].record_seq_at_event, current.completionRecord.seq);
  pass("Human completion uses final record, preserves real lease and Machine rows", {
    resultSeq: current.completionRecord.seq,
    completionEvent: firstComplete[0],
  });
  current = await change("correctTaskFn", current, {
    record: { body: "Human corrected final result" },
  });
  assert.equal(current.completionRecord.body, "Human corrected final result");
  assert.equal(current.completionRecord.seq, current.lastRecord.seq);
  assert.equal(
    rows(
      "SELECT record_seq_at_event FROM task_event WHERE task_id=? AND action='correct'",
      taskId,
    )[0].record_seq_at_event,
    current.lastRecord.seq,
  );
  assert.deepEqual(rows("SELECT * FROM task_event WHERE id=?", firstComplete[0].id), firstComplete);
  const corrected = current.completionRecord;
  const history = current.records;
  current = await change("reopenTaskFn", current);
  assert.equal(current.task.status, "assigned");
  assert.equal(current.task.chatId, chat.id);
  assert.equal(current.completionRecord, null);
  assert.deepEqual(current.previousCompletionRecord, corrected);
  assert.deepEqual(current.records, history);
  current = await change("cancelTaskFn", current);
  assert.equal(current.task.status, "canceled");
  current = await change("reopenTaskFn", current);
  assert.equal(current.task.status, "assigned");
  assert.equal(current.task.id, taskId);
  assert.equal(current.task.chatId, chat.id);
  assert.deepEqual(current.records, history);
  pass(
    "correction moves result boundary without rewriting old event; reopen/cancel/reopen preserve identity and history",
    { taskId, previousResultSeq: corrected.seq },
  );

  // Each stale start opens the real SDK session, holds its genuine ready response,
  // changes responsibility via HTTP, then releases ready into final admission.
  for (const variant of ["reassign", "cancel", "member-remove"]) {
    const staleChat = await group(`Stale ${variant}`, owner, [idle]);
    const destination = await group(`Destination ${variant}`, newAgent);
    let stale = await create(`Stale ${variant}`);
    const tag = `stale-${variant}`;
    configure({ readyTag: tag });
    const start = await mutate("assignTaskFn", stale, {
      targetChatId: staleChat.id,
      startNow: true,
    });
    stale = unwrap(start);
    await until(
      () =>
        wire().some(
          (row) => row.direction === "held" && row.tag === tag && row.value.type === "ready",
        ),
      `${tag} session.open barrier`,
    );
    const inputBefore = inputs().find(
      (input) => input.message_id === start.startDelivery.messageId,
    );
    assert(
      inputBefore && inputBefore.admitted_at === null && inputBefore.disposition === "pending",
    );
    if (variant === "reassign")
      stale = await change("reassignTaskFn", stale, {
        targetChatId: destination.id,
        startNow: false,
      });
    if (variant === "cancel") stale = await change("cancelTaskFn", stale);
    if (variant === "member-remove") {
      const governance = await call("getChatFn", { chatId: staleChat.id });
      await call("removeGroupMemberFn", {
        chatId: staleChat.id,
        member: { kind: "agent", id: idle.id },
        expectedRevision: governance.governanceRevision,
      });
    }
    configure({ readyTag: null });
    release(tag);
    await settled(staleChat.id);
    const inputAfter = inputs().find((input) => input.message_id === start.startDelivery.messageId);
    assert.equal(inputAfter.disposition, "cancelled");
    assert.equal(inputAfter.cancel_reason, "task_context_changed");
    assert.equal(inputAfter.admitted_at, null);
    assert(!sent().some((row) => row.value.messageId === start.startDelivery.messageId));
    assert.equal(runs(destination.id).length, 0);
    assert.equal(allRuns().filter((run) => run.agent_profile_id === newAgent.id).length, 0);
    pass(`stale start ${variant}: unadmitted input cancelled before synchronous send`, {
      runId: inputAfter.run_id,
      messageId: inputAfter.message_id,
      reason: inputAfter.cancel_reason,
      newOwnerRuns: 0,
    });
  }

  // Preserve an admitted row even when its real ACK is withheld across cancellation.
  let admitted = await create("Admitted cancellation");
  const admittedChat = await group("Admitted cancellation", idle);
  configure({
    modelGate: { text: admitted.task.id, tag: "admitted-model" },
    ackGate: { text: admitted.task.id, tag: "admitted-ack" },
  });
  const admitStart = await mutate("assignTaskFn", admitted, {
    targetChatId: admittedChat.id,
    startNow: true,
  });
  admitted = unwrap(admitStart);
  await modelHeld("admitted-model");
  await until(
    () => wire().some((row) => row.direction === "held" && row.tag === "admitted-ack"),
    "real admitted ACK held",
  );
  const beforeCancel = inputs().find(
    (input) => input.message_id === admitStart.startDelivery.messageId,
  );
  assert(beforeCancel.admitted_at !== null && beforeCancel.disposition === "pending");
  admitted = await change("cancelTaskFn", admitted);
  assert.deepEqual(
    inputs().find((input) => input.message_id === beforeCancel.message_id),
    beforeCancel,
  );
  arm("status", taskPrefix(admitted.task.id), []);
  configure({ modelGate: null, ackGate: null });
  await releaseForwarded("admitted-ack");
  await until(
    () =>
      inputs().find((input) => input.message_id === beforeCancel.message_id).disposition ===
      "delivered",
    "forwarded real ACK persisted as delivered before model release",
  );
  release("admitted-model");
  await settled(admittedChat.id);
  assert.equal(runs(admittedChat.id)[0].status, "completed");
  modelFixture?.assertHealthy();
  assert.equal((await detail(admitted.task.id)).task.status, "canceled");
  assert.equal(
    inputs().find((input) => input.message_id === beforeCancel.message_id).disposition,
    "delivered",
  );
  assert.equal(sent().filter((row) => row.value.messageId === beforeCancel.message_id).length, 1);
  assert.equal(
    wire().filter(
      (row) =>
        row.direction === "forwarded" &&
        row.value.type === "input_delivered" &&
        row.value.messageId === beforeCancel.message_id,
    ).length,
    1,
  );
  assert.equal(runs(admittedChat.id).length, 1);
  assert.equal(inputs().filter((input) => input.message_id === beforeCancel.message_id).length, 1);
  pass("admitted start survives Task cancellation, real ACK delivered exactly once", {
    messageId: beforeCancel.message_id,
    admittedAt: beforeCancel.admitted_at,
  });

  // A local HTTP rendezvous collects both requests before forwarding either to
  // production. Both carry the same revision; there is no timing-based sleep race.
  let raced = await create("Concurrent append and complete");
  raced = await change("assignTaskFn", raced, { targetChatId: chat.id, startNow: false });
  raced = await change("appendTaskRecordFn", raced, { body: "pre-race result" });
  const arrived: string[] = [];
  let releasePair!: () => void;
  const both = new Promise<void>((done) => {
    releasePair = done;
  });
  const raceServer = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { name, data } = JSON.parse(body);
    arrived.push(name);
    if (arrived.length === 2) releasePair();
    await both;
    try {
      response.end(JSON.stringify(await rawCall(name, data)));
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise<void>((done) => raceServer.listen(0, "127.0.0.1", done));
  const raceAddress = raceServer.address();
  assert(raceAddress && typeof raceAddress !== "string");
  let raceResults: any[];
  try {
    raceResults = await Promise.all(
      ["appendTaskRecordFn", "completeTaskFn"].map(async (name) => {
        const response = await fetch(`http://127.0.0.1:${raceAddress.port}`, {
          method: "POST",
          body: JSON.stringify({
            name,
            data: {
              ...command(raced),
              ...(name === "appendTaskRecordFn" ? { body: "race append winner" } : {}),
            },
          }),
          signal: AbortSignal.timeout(20000),
        });
        assert.equal(response.status, 200);
        return response.json();
      }),
    );
  } finally {
    raceServer.closeAllConnections();
    await new Promise<void>((done) => raceServer.close(() => done()));
  }
  assert.equal(arrived.length, 2);
  assert.equal(raceResults.filter((result) => result.ok).length, 1);
  const rejected = raceResults.find((result) => !result.ok);
  assert(["conflict", "task_invalid_transition"].includes(rejected.error.code));
  raced = await detail(raced.task.id);
  if (raced.task.status === "assigned") raced = await change("completeTaskFn", raced);
  assert.equal(
    raced.completionRecord.seq,
    Math.max(...raced.records.map((record: any) => record.seq)),
  );
  pass(
    "same-revision append/complete rendezvous admits exactly one writer and preserves maximum result seq",
    { arrived, rejected: rejected.error.code, resultSeq: raced.completionRecord.seq },
  );

  // Both tokens below come from real open commands of active SDK sessions.
  const oldChat = await group("Old record Chat", oldAgent);
  const newChat = await group("New responsible Chat", newAgent);
  let scoped = await create("Cross Chat scope");
  scoped = await change("assignTaskFn", scoped, { targetChatId: oldChat.id, startNow: false });
  scoped = await change("appendTaskRecordFn", scoped, { body: "OLD_CHAT_SECRET_RECORD" });
  const secret = scoped.lastRecord;
  configure({ modelGate: { text: scoped.task.id, tag: "old-grant" } });
  scoped = await change("startTaskFn", scoped);
  await modelHeld("old-grant");
  const oldRun = runs(oldChat.id)[0];
  scoped = await change("reassignTaskFn", scoped, { targetChatId: newChat.id, startNow: false });
  const denied = await remote(oldRun.id, "task_get", { taskId: scoped.task.id });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "not_found");
  arm("chatUnmentioned", taskPrefix(scoped.task.id), []);
  configure({ modelGate: null });
  release("old-grant");
  await settled(oldChat.id);
  configure({ modelGate: { text: scoped.task.id, tag: "new-grant" } });
  scoped = await change("startTaskFn", scoped);
  await modelHeld("new-grant");
  const newRun = runs(newChat.id)[0];
  const redacted = await remote(newRun.id, "task_get", { taskId: scoped.task.id });
  assert.equal(redacted.ok, true, JSON.stringify(redacted));
  const restricted = redacted.data.records.find((record: any) => record.seq === secret.seq);
  assert.deepEqual(restricted, {
    taskId: scoped.task.id,
    seq: secret.seq,
    chatId: oldChat.id,
    visibility: "restricted",
  });
  assert(!JSON.stringify(redacted).includes("OLD_CHAT_SECRET_RECORD"));
  const forbidden = await remote(newRun.id, "task_mutate", {
    action: "record_append",
    ...command(scoped),
    body: "cross Chat reference",
    referenceMessageId: secret.messageId,
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, "task_reference_forbidden");
  arm("operator", taskPrefix(scoped.task.id), []);
  configure({ modelGate: null });
  release("new-grant");
  await settled(newChat.id);
  pass(
    "real grants enforce old Chat not_found, new Chat restricted record, forbidden old reference",
    { oldRunId: oldRun.id, newRunId: newRun.id, restricted, writeError: forbidden.error.code },
  );

  // Fault belongs to the model HTTP fixture, not a fake runner settlement.
  let errorTask = await create("Model failure independence");
  const errorChat = await group("Model failure Chat", errorAgent);
  configure({ modelError: errorTask.task.id });
  errorTask = await change("assignTaskFn", errorTask, {
    targetChatId: errorChat.id,
    startNow: true,
  });
  await settled(errorChat.id);
  const errorRun = runs(errorChat.id)[0];
  assert.equal(errorRun.error_code, "model_error");
  assert.equal((await detail(errorTask.task.id)).task.status, "assigned");
  configure({ modelError: null });
  pass("real runner model_error leaves Task assigned", {
    runId: errorRun.id,
    errorCode: errorRun.error_code,
  });
  modelFixture?.assertDrained();
  if (modelFixture) pass("loopback fixture drained; paid-model-calls=0", modelFixture.metadata());
} catch (error) {
  failure = error;
  console.error(error);
}
await finish();
