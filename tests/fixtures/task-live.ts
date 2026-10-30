// Task admission through production HTTP, the real Pi SDK/runner and a real Worker.
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
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { startModelFixture } from "../../scripts/verify/lib/model-fixture.mjs";

if (process.argv[2] === "--service") {
  // Same private IPC boundary seam as execution-live-service.ts: authenticated
  // server boundaries only; no domain function or database write is exposed.
  const task = await import("../../src/server/functions/task");
  const { newId, ID_PREFIXES } = await import("../../src/contracts/ids");
  const boundaries = {
    createTaskFn: task.createTaskBoundary,
    getTaskDetailFn: task.getTaskDetailBoundary,
    assignTaskFn: task.assignTaskBoundary,
    updateTaskFn: task.updateTaskBoundary,
    cancelTaskFn: task.cancelTaskBoundary,
  };
  process.on(
    "message",
    async (message: {
      id: string;
      name: keyof typeof boundaries;
      data: unknown;
      cookie: string;
    }) => {
      try {
        const boundary = boundaries[message.name];
        assert(boundary, "unknown private Task boundary");
        const result = await boundary(
          message.data,
          new Headers({ cookie: message.cookie }),
          newId(ID_PREFIXES.request),
        );
        process.send?.({ id: message.id, result });
      } catch (error) {
        process.send?.({ id: message.id, error: String(error) });
      }
    },
  );
  await import(new URL("../../.output/server/index.mjs", import.meta.url).href);
} else {
  const scenario = "task";
  const chatMode = process.env.SPROUT_VERIFY_CHAT_MODE ?? "model-fixture";
  assert(["model-fixture", "live"].includes(chatMode), "expected model-fixture or live chat mode");
  const directory = resolve(
    process.env.SPROUT_TASK_EVIDENCE_DIR ?? `.verify/task-live-${Date.now()}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  console.log(`EVIDENCE ${directory}`);
  const model = chatMode === "live" ? process.env.SPROUT_VERIFY_PI_MODEL : undefined;
  function requireLiveModel() {
    assert(model, "SPROUT_VERIFY_PI_MODEL is unset: a live run must name its model");
    return model;
  }
  let modelFixture: Awaited<ReturnType<typeof startModelFixture>> | undefined;
  const children: ChildProcess[] = [];
  const checks: unknown[] = [];
  const facts: Record<string, unknown> = {
    scenario,
    mode: chatMode,
    model: chatMode === "live" ? model : undefined,
    directory,
    startedAt: new Date().toISOString(),
  };
  let actualModels: { provider: string; model: string; thinking: string }[] = [];
  let db: Database.Database | undefined;
  let failure: unknown;
  let chatId = "";
  const samples: unknown[] = [];
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  function pass(name: string, detail: unknown = {}) {
    checks.push({ name, detail });
    console.log(`PASS LIVE ${name} ${JSON.stringify(detail)}`);
  }
  async function until<T>(
    check: () => T | Promise<T>,
    label: string,
    timeout = 60000,
  ): Promise<NonNullable<T>> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value as NonNullable<T>;
      await sleep(100);
    }
    throw new Error(`Timeout: ${label}`);
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
    children.push(child);
    child.on("error", (error) => {
      facts[`${log}SpawnError`] = String(error);
    });
    return child;
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    try {
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        "process termination",
        10000,
      );
    } catch {
      child.kill("SIGKILL");
      await until(() => child.exitCode !== null || child.signalCode !== null, "process kill", 5000);
    }
  }
  const startRequire = createRequire(import.meta.resolve("@tanstack/react-start"));
  const clientRequire = createRequire(
    startRequire.resolve("@tanstack/start-client-core/package.json"),
  );
  const { fromCrossJSON, toCrossJSON } = clientRequire("seroval");
  function files(path: string): string[] {
    if (!existsSync(path)) return [];
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
  let cookie = "";
  let service: ChildProcess;
  const taskCalls = new Map<string, (value: any) => void>();
  async function call<T = any>(name: string, data: unknown): Promise<T> {
    if (
      ["createTaskFn", "getTaskDetailFn", "assignTaskFn", "updateTaskFn", "cancelTaskFn"].includes(
        name,
      )
    ) {
      const id = randomUUID();
      const result: any = await new Promise((done, reject) => {
        const timer = setTimeout(() => {
          taskCalls.delete(id);
          reject(new Error(`Task boundary timeout: ${name}`));
        }, 20000);
        taskCalls.set(id, (reply) => {
          clearTimeout(timer);
          done(reply);
        });
        service.send!({ id, name, data, cookie });
      });
      assert(!result.error, result.error);
      assert(result.result.ok, `${name}: ${JSON.stringify(result.result)}`);
      const taskData = result.result.data;
      return taskData.detail
        ? { ...taskData.detail, startDelivery: taskData.startDelivery }
        : taskData;
    }
    assert(ids[name], `built server function missing: ${name}`);
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
    assert.equal(response.status, 200, `${name}: HTTP ${response.status} ${body.slice(0, 400)}`);
    const { result } = fromCrossJSON(JSON.parse(body), { refs: new Map() });
    assert(result.ok, `${name}: ${JSON.stringify(result)}`);
    return result.data;
  }
  const rows = (sql: string, ...params: unknown[]): any[] => db!.prepare(sql).all(...params);
  const runs = () =>
    rows(
      "SELECT r.*, i.agent_profile_id FROM agent_run r JOIN agent_instance i ON i.id=r.instance_id WHERE r.chat_id=? ORDER BY r.rowid",
      chatId,
    );
  const inputs = () =>
    rows(
      "SELECT x.* FROM agent_run_input x JOIN agent_run r ON r.id=x.run_id WHERE r.chat_id=?",
      chatId,
    );
  function collectTranscripts() {
    const current = runs();
    const seen = new Set<string>();
    return current.flatMap((run) => {
      const snapshot = run.config_snapshot ? JSON.parse(run.config_snapshot) : undefined;
      const path = snapshot?.sessionFile;
      if (!path || seen.has(path) || !existsSync(path)) return [];
      seen.add(path);
      const messages = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.message?.role === "assistant");
      return [
        {
          runIds: current
            .filter((r) => r.config_snapshot && JSON.parse(r.config_snapshot).sessionFile === path)
            .map((r) => r.id),
          sessionFile: path,
          provider: snapshot.provider,
          model: snapshot.model,
          assistantMessages: messages,
        },
      ];
    });
  }
  const deadline = setTimeout(() => {
    failure = new Error("live fixture total timeout (600s)");
    void finish();
  }, 600000);
  let finishing = false;
  async function finish() {
    if (finishing) return;
    finishing = true;
    clearTimeout(deadline);
    facts.checks = checks;
    facts.error =
      failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure;
    facts.finishedAt = new Date().toISOString();
    if (db) {
      facts.runs = runs();
      facts.inputs = inputs();
      facts.messages = rows("SELECT * FROM message WHERE chat_id=? ORDER BY rowid", chatId);
      facts.executions = rows("SELECT * FROM remote_execution");
      facts.logFrames = rows("SELECT * FROM execution_log_frame");
      facts.tasks = rows("SELECT * FROM task");
      facts.effectiveMembers = rows("SELECT * FROM chat_effective_member WHERE chat_id=?", chatId);
      facts.materializedMembers = rows("SELECT * FROM chat_member WHERE chat_id=?", chatId);
      facts.projectMembers = rows(
        "SELECT * FROM project_member WHERE project_id=?",
        facts.projectId ?? "",
      );
      facts.grants = rows(
        "SELECT id, run_id, instance_id, issued_at, revoked_at FROM remote_tool_grant WHERE chat_id=?",
        chatId,
      );
      facts.diagnostics = rows(
        "SELECT * FROM diagnostic_event WHERE chat_id=? ORDER BY rowid",
        chatId,
      );
      writeFileSync(
        join(directory, "transcripts.json"),
        JSON.stringify(collectTranscripts(), null, 2),
      );
      writeFileSync(join(directory, "rows.json"), JSON.stringify(facts, null, 2));
      await db.backup(join(directory, "snapshot.sqlite"));
    }
    writeFileSync(join(directory, "samples.json"), JSON.stringify(samples, null, 2));
    if (db && chatId && actualModels.length === 0) {
      try {
        actualModels = rows(
          "SELECT config_snapshot FROM agent_run WHERE chat_id=? AND config_snapshot IS NOT NULL ORDER BY queued_at",
          chatId,
        ).map((row) => {
          const snapshot = JSON.parse(row.config_snapshot);
          return {
            provider: snapshot.provider,
            model: snapshot.model,
            thinking: snapshot.thinking,
          };
        });
      } catch {}
    }
    const modelMetadata = {
      ...(modelFixture?.metadata() ?? {
        mode: chatMode,
        requestCount: null,
        completedPlans: null,
        unusedSteps: null,
      }),
      scenario,
      actualModels,
    };
    writeFileSync(join(directory, "model-mode.json"), JSON.stringify(modelMetadata, null, 2));
    console.log(`CHAT metadata ${JSON.stringify(modelMetadata)}`);
    if (chatMode === "model-fixture") console.log("paid-model-calls=0");
    writeFileSync(join(directory, "result.json"), JSON.stringify(facts, null, 2));
    for (const child of [...children].reverse()) await stop(child);
    db?.close();
    await modelFixture?.close();
    console.log(`${failure ? "FAIL" : "PASS"} LIVE task; evidence ${directory}`);
    process.exitCode = failure ? 1 : 0;
  }
  process.once("SIGTERM", () => {
    failure = new Error("SIGTERM");
    void finish();
  });
  process.once("SIGINT", () => {
    failure = new Error("SIGINT");
    void finish();
  });

  // The observer forwards the production wire byte for byte, except for one withheld
  // ACK. It never constructs prompts, tool results or SDK session records.
  const observer = join(directory, "runner-observer.mjs");
  const preload = join(directory, "observe-http.mjs");
  const trace = join(directory, "runner-wire.jsonl");
  const network = join(directory, "runner-http.jsonl");
  const controls = join(directory, "controls.json");
  writeFileSync(
    preload,
    `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
const record = (data) => appendFileSync(${JSON.stringify(network)}, JSON.stringify({ at: Date.now(), ...data }) + '\\n');
const originalRequest = http.request;
http.request = function(url, options, callback) {
  if (String(url).includes('/api/remote/agent')) {
    let body = '';
    const req = originalRequest.call(this, url, options, response => {
      let result = '';
      response.on('data', chunk => { result += chunk; });
      response.on('end', () => record({ kind: 'remote', url: String(url), body: JSON.parse(body), status: response.statusCode, result: JSON.parse(result) }));
      callback(response);
    });
    const end = req.end;
    req.end = function(chunk, ...args) { body += chunk ?? ''; return end.call(this, chunk, ...args); };
    return req;
  }
  return originalRequest.call(this, url, options, callback);
};
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
const released = new Set();
globalThis.fetch = async function(url, options) {
  const body = typeof options?.body === 'string' ? options.body : '';
  if (body && !String(url).includes('/api/remote/agent')) {
    let input;
    try { input = JSON.parse(body); } catch {}
    if (input) {
      record({ kind: 'model', url: String(url), input });
      const config = JSON.parse(readFileSync(${JSON.stringify(controls)}, 'utf8'));
      const gate = body.includes(config.cancel) ? undefined : body.includes(config.steer) ? 'steer' : body.includes(config.first) ? 'first' : undefined;
      if (gate && !released.has(gate)) {
        released.add(gate);
        while (!existsSync(${JSON.stringify(directory)} + '/release-' + gate)) await new Promise(done => setTimeout(done, 25));
      }
    }
  }
  return originalFetch.call(this, url, options);
};
`,
    { mode: 0o600 },
  );
  writeFileSync(
    observer,
    `
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const child = spawn(process.execPath, ['--import', ${JSON.stringify(preload)}, ${JSON.stringify(resolve("scripts/pi-host-runner.mjs"))}], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const record = (direction, value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ at: Date.now(), direction, value }) + '\\n');
const held = new Set();
createInterface({ input: process.stdin }).on('line', raw => {
  const value = JSON.parse(raw);
  if (value.type === 'steer' && JSON.stringify(value).includes(JSON.parse(readFileSync(${JSON.stringify(controls)}, 'utf8')).cancel)) held.add(value.messageId);
  record('command', value.type === 'open' ? { type: value.type, id: value.id } : value);
  child.stdin.write(raw + '\\n');
}).on('close', () => child.stdin.end());
createInterface({ input: child.stdout }).on('line', raw => {
  const value = JSON.parse(raw);
  const hold = value.type === 'input_delivered' && held.has(value.messageId);
  record(hold ? 'withheld-ack' : 'event', value);
  if (!hold) process.stdout.write(raw + '\\n');
});
child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
`,
    { mode: 0o700 },
  );
  environment.SPROUT_PI_RUNNER = observer;
  function jsonLines(path: string): any[] {
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
  const commands = () =>
    jsonLines(trace).filter(
      (row) => row.direction === "command" && ["prompt", "steer"].includes(row.value.type),
    );
  const modelRequests = () => jsonLines(network).filter((row) => row.kind === "model");
  const textOf = (value: any): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(textOf).join("\n");
    return value?.text ?? (value?.content ? textOf(value.content) : "");
  };
  function requestMessages(input: any): any[] {
    const messages = input.messages ?? input.input ?? input.contents;
    return Array.isArray(messages) ? messages : [];
  }
  function requestTaskText(input: any): string {
    return (
      requestMessages(input)
        .filter((message) => message.role === "user")
        .map((message) => textOf(message.content ?? message.parts))
        .findLast((text) => text.startsWith("已分配并请求立即开始\nTask：")) ?? ""
    );
  }
  function requestToolTexts(input: any): string[] {
    return requestMessages(input).flatMap((message) => {
      if (message.role === "tool") return [textOf(message.content)];
      if (message.type === "function_call_output") return [message.output];
      const parts = message.content ?? message.parts;
      if (!Array.isArray(parts)) return [];
      return parts.flatMap((part: any) =>
        part.type === "tool_result"
          ? [textOf(part.content)]
          : part.functionResponse
            ? [JSON.stringify(part.functionResponse.response)]
            : [],
      );
    });
  }
  function sessionEntries() {
    const run = runs()[0];
    const path = run?.config_snapshot && JSON.parse(run.config_snapshot).sessionFile;
    return path ? jsonLines(path) : [];
  }
  async function observations(label: string, count: number) {
    const observe = () => ({
      at: Date.now(),
      label,
      commands: commands(),
      requests: modelRequests(),
      inputs: inputs(),
      users: sessionEntries().filter((entry) => entry.message?.role === "user"),
    });
    const first = observe();
    const start = Date.now();
    await until(() => Date.now() - start >= 500, "adjacent observation window", 2000);
    const second = observe();
    assert.equal(first.commands.length, count);
    assert.equal(
      first.users.length,
      count - 1,
      "SDK has consumed the prefix and queued the newest steer",
    );
    assert.equal(second.users.length, count - 1);
    assert.equal(first.requests.length, count - 1);
    assert.equal(second.requests.length, count - 1);
    assert.equal(second.commands.length, count);
    assert.deepEqual(
      first.commands,
      second.commands,
      "adjacent command prefix must remain unchanged",
    );
    assert.deepEqual(
      first.requests,
      second.requests,
      "no extra model request while response barrier held",
    );
    assert.deepEqual(
      first.users,
      second.users,
      "no duplicate SDK prompt while response barrier held",
    );
    samples.push(first, second);
    return { first, second };
  }
  try {
    assert.equal(process.platform, "darwin", "real macOS Worker required");
    if (chatMode === "model-fixture") {
      modelFixture = await startModelFixture({ privateDir: join(directory, "model-fixture") });
      environment.PI_CODING_AGENT_DIR = modelFixture.agentDir;
    } else {
      requireLiveModel();
      assert(
        existsSync(
          join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), "auth.json"),
        ),
        "real Pi credentials missing",
      );
    }
    const serviceLog = openSync(join(directory, "service.log"), "w", 0o600);
    service = spawn(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/task-live.ts", "--service"],
      { env: environment, stdio: ["ignore", serviceLog, serviceLog, "ipc"] },
    );
    closeSync(serviceLog);
    children.push(service);
    service.on("message", (reply: any) => {
      taskCalls.get(reply.id)?.(reply);
      taskCalls.delete(reply.id);
    });
    await until(async () => {
      try {
        return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    }, "production service health");
    const signup = await fetch(base + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        email: `task-live-${randomUUID()}@example.test`,
        password: randomBytes(24).toString("base64url"),
        name: "Task live human",
      }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(signup.status, 200);
    cookie = signup.headers
      .getSetCookie()
      .find((value) => value.includes("session_token="))!
      .split(";")[0]!;
    const account = (await signup.json()) as { user: { id: string } };
    const project = await call("createProjectFn", { name: "Task live admission" });
    facts.projectId = project.id;
    const agent = await call("createAgentProfileFn", {
      name: "TaskLiveOwner",
      model: modelFixture ? modelFixture.model("chatOwner") : requireLiveModel(),
      effort: "off",
      persona:
        "Follow each Task's explicit instructions. Use only the named Sprout tools. Do not change Task status or send messages with tools. Reply briefly after finishing.",
    });
    await call("addProjectMemberFn", { projectId: project.id, agentProfileId: agent.id });
    const dm = await call("createDirectChatFn", {
      projectId: project.id,
      agentProfileId: agent.id,
    });
    chatId = dm.chat.id;
    facts.chatId = chatId;
    db = new Database(environment.DATABASE_URL!, { readonly: true });
    db.pragma("busy_timeout = 5000");
    const otherChat = await call("createGroupChatFn", {
      projectId: project.id,
      title: "Private other Chat",
      members: [{ kind: "human", id: account.user.id }],
      initialOwner: { kind: "human", id: account.user.id },
      wakePolicy: "owner_led",
    });
    const foreignDetail = await call("createTaskFn", {
      projectId: project.id,
      title: "FOREIGN_SECRET_TASK",
      description: "FOREIGN_SECRET_DETAIL",
      constraints: "private",
      completionRequirements: "private",
      checklist: [],
    });
    await call("assignTaskFn", {
      taskId: foreignDetail.task.id,
      expectedRevision: foreignDetail.task.revision,
      targetChatId: otherChat.id,
      startNow: false,
    });
    const foreign = foreignDetail.task;
    facts.foreignTask = foreign;
    const enrollment = await call("createMachineFn", { name: "Task live macOS" });
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
      description: "Task real runner evidence",
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
    launch(["dist/worker/main.js", "run", "--state-dir", stateDir], "worker.log");
    await until(
      async () =>
        (await call("getMachineFn", { machineId, projectId: project.id })).connection.kind ===
        "online",
      "Worker online",
    );
    await until(
      async () =>
        (await call("getMachineFn", { machineId, projectId: project.id })).bindings[0]?.observation
          ?.fact?.result?.kind === "accessible",
      "Worker directory accessible",
    );
    const marker = `TASK_WORKER_${randomUUID().replaceAll("-", "")}`;
    const lease = { machineId, expectedGeneration: 0, requestId: `req_${randomUUID()}` };
    const shell = {
      machineId,
      authorizationGeneration: 1,
      requestId: `req_${randomUUID()}`,
      command: `printf '${marker}\\n'`,
      cwd: join(root, project.id),
      waitMs: 1000,
    };
    const tasks: any[] = [];
    for (const name of ["FIRST", "STEER", "CANCEL"]) {
      const data = {
        projectId: project.id,
        title: `TASK_${name}_TITLE`,
        description: `GOAL_${name}: Acknowledge this Task snapshot.`,
        constraints: `CONSTRAINT_${name}: Use no host tools.`,
        completionRequirements: `DONE_${name}: Preserve this checklist.`,
        checklist: [`CHECK_${name}_one`, `CHECK_${name}_two`],
      };
      const task = await call("createTaskFn", data);
      tasks.push({ ...task.task, expected: data });
    }
    const [first, steer, cancel] = tasks;
    facts.taskIds = tasks.map((task) => task.id);
    const steps = [
      { name: "sprout_task_get", arguments: { taskId: first.id } },
      { name: "sprout_task_get", arguments: { taskId: foreign.id } },
      { name: "sprout_lease_acquire", arguments: lease },
      { name: "sprout_remote_shell", arguments: shell },
    ];
    const finalInstructions = `GOAL_CANCEL: Call these tools exactly once in this order, including the forbidden lookup (report its error and continue): ${steps.map((step) => `${step.name} ${JSON.stringify(step.arguments)}`).join("; ")}. Then reply TASK_LIVE_DONE. Do not mutate Tasks.`;
    await call("updateTaskFn", {
      taskId: cancel.id,
      expectedRevision: cancel.revision,
      description: finalInstructions,
    });
    cancel.expected.description = finalInstructions;
    writeFileSync(
      controls,
      JSON.stringify({ first: first.id, steer: steer.id, cancel: cancel.id }),
    );
    if (modelFixture) {
      for (const [index, task] of tasks.entries())
        modelFixture.arm("chatOwner", {
          expectedUserPrefix: `已分配并请求立即开始\nTask：${task.id}\n`,
          steps: index === 2 ? steps : [],
          reply: index === 2 ? "TASK_LIVE_DONE" : `TASK_${index}_ACK`,
          queued: index > 0,
        });
    }
    async function assign(task: any) {
      const detail = await call("getTaskDetailFn", { taskId: task.id });
      task.assignRequestedAt = Date.now();
      const assigned = await call("assignTaskFn", {
        taskId: task.id,
        expectedRevision: detail.task.revision,
        targetChatId: chatId,
        startNow: true,
      });
      task.startDelivery = assigned.startDelivery;
      facts.startActions = tasks
        .filter((item) => item.startDelivery)
        .map((item) => ({
          taskId: item.id,
          requestedAt: item.assignRequestedAt,
          delivery: item.startDelivery,
        }));
      return assigned;
    }
    await assign(first);
    await until(() => modelRequests().length >= 1, "first real SDK model request");
    assert.equal(runs().length, 1);
    const runId = runs()[0].id;
    assert.equal(runs()[0].status, "running");
    await until(() => inputs()[0]?.disposition === "delivered", "first prompt ACK");
    await assign(steer);
    await until(() => commands().length === 2, "real runner steer receives second Task");
    assert.equal(runs().length, 1);
    assert(inputs().every((input) => input.run_id === runId));
    await until(() => inputs().every((input) => input.disposition === "delivered"), "steer ACK");
    const steerObservation = await observations("steer-queued-on-first-model-request", 2);
    writeFileSync(join(directory, "release-first"), "release\n");
    await until(
      () => modelRequests().some((row) => requestTaskText(row.input).includes(steer.id)),
      "steer reaches model request",
    );
    await assign(cancel);
    await until(
      () => jsonLines(trace).some((row) => row.direction === "withheld-ack"),
      "real SDK produced cancellation-target ACK",
    );
    const beforeCancel = inputs().find(
      (input) => input.message_id === commands()[2].value.messageId,
    );
    assert(beforeCancel?.admitted_at != null);
    assert.equal(beforeCancel.disposition, "pending");
    assert.equal(beforeCancel.delivered_at, null);
    const cancelDetail = await call("getTaskDetailFn", { taskId: cancel.id });
    const cancelled = await call("cancelTaskFn", {
      taskId: cancel.id,
      expectedRevision: cancelDetail.task.revision,
    });
    assert.equal(cancelled.task.status, "canceled");
    assert.deepEqual(
      inputs().find((input) => input.message_id === beforeCancel.message_id),
      beforeCancel,
      "attempted input must not be rewritten as cancelled",
    );
    const cancelObservation = await observations("cancelled-after-send-before-ack", 3);
    writeFileSync(join(directory, "release-steer"), "release\n");
    await until(
      () => runs().every((run) => !["queued", "running"].includes(run.status)),
      "real runner settles",
      240000,
    );
    assert.equal(runs().length, 1, "no replacement run for an attempted input");
    assert.equal(runs()[0].status, "completed", JSON.stringify(runs()));
    assert.equal(commands().length, 3, "each Task sent once across the complete run");
    assert.deepEqual(
      inputs().find((input) => input.message_id === beforeCancel.message_id),
      beforeCancel,
      "unacknowledged input remains an attempted delivery after settle",
    );
    const entries = sessionEntries();
    writeFileSync(join(directory, "session-entries.json"), JSON.stringify(entries, null, 2));
    const users = entries.filter((entry) => entry.message?.role === "user");
    assert.equal(users.length, 3, "real SDK retained exactly three user inputs");
    for (const [index, task] of tasks.entries()) {
      const command = commands()[index];
      const wire = command.value;
      assert.equal(
        wire.messageId,
        task.startDelivery.messageId,
        "runner ACK key is the original start action messageId",
      );
      assert.equal(task.startDelivery.runId, runId);
      const message = rows("SELECT * FROM message WHERE id=?", wire.messageId)[0];
      const input = inputs().find((row) => row.message_id === wire.messageId);
      assert(message, "runner command must carry the original persisted start message ID");
      assert.equal(message.chat_id, chatId);
      assert.equal(input.run_id, runId);
      assert(input.admitted_at != null);
      assert(
        input.admitted_at >= task.assignRequestedAt && input.admitted_at <= command.at,
        "millisecond admission falls between the start action and actual runner receipt",
      );
      assert.equal(wire.type, index === 0 ? "prompt" : "steer");
      const wireText = wire.text;
      const sessionText = textOf(users[index].message.content);
      assert.equal(wireText, message.body, "original start message body is forwarded verbatim");
      const model = modelRequests().find((row) => requestTaskText(row.input).includes(task.id));
      assert(model, `Task ${task.id} must reach the model as the current user input`);
      const modelText = requestTaskText(model.input);
      for (const field of [
        task.id,
        task.expected.title,
        task.expected.description,
        task.expected.constraints,
        task.expected.completionRequirements,
        ...task.expected.checklist.map((body: string) => `- [ ] ${body}`),
      ]) {
        assert(wireText.includes(field), `wire missing ${field}`);
        assert(sessionText.includes(field), `SDK session missing ${field}`);
        assert(modelText.includes(field), `model request missing ${field}`);
      }
      pass(
        index === 0
          ? "original start message reaches first real model prompt"
          : "original start message reaches same-run real model steer",
        {
          taskId: task.id,
          runId,
          messageId: wire.messageId,
          wireText,
          sessionUserIndex: index,
          modelRequestAt: model.at,
          admittedAt: input.admitted_at,
          runnerReceivedAt: command.at,
        },
      );
    }
    pass("adjacent observations prove stable command prefixes and no duplicate prompts", {
      steer: [steerObservation.first.at, steerObservation.second.at],
      cancel: [cancelObservation.first.at, cancelObservation.second.at],
      commands: 3,
      sdkUsers: users.length,
    });
    pass("cancellation after real send and before ACK preserves original admission", {
      beforeCancel,
      afterSettle: inputs().find((input) => input.message_id === beforeCancel.message_id),
      withheldAck: jsonLines(trace).find((row) => row.direction === "withheld-ack"),
    });
    const remote = jsonLines(network).filter((row) => row.kind === "remote");
    const ownGet = remote.find(
      (row) => row.body.call.type === "task_get" && row.body.call.input.taskId === first.id,
    );
    const foreignGet = remote.find(
      (row) => row.body.call.type === "task_get" && row.body.call.input.taskId === foreign.id,
    );
    assert(
      ownGet && foreignGet,
      "model tools must actually POST both requests through /api/remote/agent",
    );
    assert.equal(ownGet.status, 200);
    assert.equal(ownGet.result.ok, true);
    assert.equal(ownGet.result.data.task.id, first.id);
    assert.equal(ownGet.result.data.task.chatId, chatId);
    assert.equal(foreignGet.status, 200);
    assert.equal(foreignGet.result.ok, false);
    assert.equal(
      foreignGet.result.error.code,
      "not_found",
      "cross-Chat Tasks are hidden by the domain scope contract",
    );
    assert(!JSON.stringify(foreignGet.result).includes("FOREIGN_SECRET"));
    const toolCalls = entries.flatMap((entry) =>
      Array.isArray(entry.message?.content)
        ? entry.message.content.filter((part: any) => part.type === "toolCall")
        : [],
    );
    assert.equal(toolCalls.filter((part) => part.name === "sprout_task_get").length, 2);
    const taskResults = entries.filter(
      (entry) =>
        entry.message?.role === "toolResult" && entry.message.toolName === "sprout_task_get",
    );
    assert.equal(taskResults.length, 2);
    assert.deepEqual(JSON.parse(textOf(taskResults[0].message.content)), ownGet.result);
    assert.deepEqual(JSON.parse(textOf(taskResults[1].message.content)), foreignGet.result);
    const modelTools = modelRequests().flatMap((row) => requestToolTexts(row.input));
    assert(
      modelTools.some((text) => text.includes(first.id) && text.includes(chatId)),
      "scoped Task detail returned to model",
    );
    assert(
      modelTools.some((text) => text.includes('"not_found"')),
      "cross-Chat denial returned to model",
    );
    assert(!modelTools.some((text) => text.includes("FOREIGN_SECRET")));
    const snapshot = JSON.parse(runs()[0].config_snapshot);
    assert(
      snapshot.tools.includes("sprout_task_get"),
      "real SDK active allowlist contains Task tool",
    );
    const actual = `${snapshot.provider}/${snapshot.model}`;
    assert.equal(actual, modelFixture ? modelFixture.model("chatOwner") : requireLiveModel());
    const execution = rows("SELECT * FROM remote_execution WHERE project_id=?", project.id);
    assert.equal(execution.length, 1);
    await until(
      () =>
        rows("SELECT state FROM remote_execution WHERE id=?", execution[0].id)[0]?.state ===
        "succeeded",
      "real Worker shell succeeded",
    );
    const output = rows(
      "SELECT payload_bytes FROM execution_log_frame WHERE execution_id=?",
      execution[0].id,
    )
      .map((row) => Buffer.from(row.payload_bytes).toString("utf8"))
      .join("");
    assert(output.includes(marker));
    assert(
      rows("SELECT * FROM diagnostic_event WHERE chat_id=?", chatId).some((row) =>
        JSON.stringify(row).includes("task_delivery_unconfirmed"),
      ),
    );
    modelFixture?.assertDrained();
    pass("real runner Task allowlist, scoped HTTP tools and real Worker execution", {
      runId,
      actualModel: actual,
      ownGet: { url: ownGet.url, taskId: first.id, chatId, status: ownGet.status },
      foreignGet: {
        url: foreignGet.url,
        taskId: foreign.id,
        status: foreignGet.status,
        error: foreignGet.result.error.code,
      },
      executionId: execution[0].id,
      marker,
      output,
    });
  } catch (error) {
    failure = error;
    console.error(error);
  } finally {
    await finish();
  }
}
