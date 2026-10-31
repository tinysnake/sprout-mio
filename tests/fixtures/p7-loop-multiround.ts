// P7: real Pi SDK turns, human stop, Task ownership and Worker artifacts.
// The service/HTTP harness follows task-live.ts; observations never synthesize SDK events.
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
  const scenario = "p7-loop";
  // P7 never spends money: this gate is model-fixture only, so the paid path is not a branch.
  assert.equal(
    process.env.SPROUT_VERIFY_CHAT_MODE ?? "model-fixture",
    "model-fixture",
    "P7 never permits paid model calls",
  );
  const chatMode = "model-fixture";
  const directory = resolve(
    process.env.SPROUT_P7_LOOP_EVIDENCE_DIR ?? `.verify/task-live-${Date.now()}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  console.log(`EVIDENCE ${directory}`);
  let modelFixture: Awaited<ReturnType<typeof startModelFixture>> | undefined;
  const children: ChildProcess[] = [];
  const checks: unknown[] = [];
  const facts: Record<string, unknown> = {
    scenario,
    mode: chatMode,
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
  // `abortAgentRunFn` and `getChatRunStateFn` deliberately stay on HTTP: stop must be observed
  // through the same boundary the UI calls, including its error mapping.
  const boundaryNames = [
    "createTaskFn",
    "getTaskDetailFn",
    "assignTaskFn",
    "updateTaskFn",
    "cancelTaskFn",
  ];
  /** Raw boundary result: negative paths must observe the refusal instead of asserting success. */
  async function callResult(name: string, data: unknown): Promise<any> {
    if (boundaryNames.includes(name)) {
      const id = randomUUID();
      return new Promise((done, reject) => {
        const timer = setTimeout(() => {
          taskCalls.delete(id);
          reject(new Error(`Task boundary timeout: ${name}`));
        }, 20000);
        taskCalls.set(id, (reply) => {
          clearTimeout(timer);
          done(reply.result ?? reply);
        });
        service.send!({ id, name, data, cookie });
      });
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
    return result;
  }
  async function callRaw(name: string, data: unknown): Promise<any> {
    return callResult(name, data);
  }
  async function call<T = any>(name: string, data: unknown): Promise<T> {
    const result = await callResult(name, data);
    assert(result.ok, `${name}: ${JSON.stringify(result)}`);
    const taskData = result.data;
    // Only the private Task boundary wraps its payload in `detail`; HTTP functions keep theirs.
    return boundaryNames.includes(name) && taskData?.detail
      ? { ...taskData.detail, startDelivery: taskData.startDelivery }
      : taskData;
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

  const requestsFile = join(directory, "requests.jsonl");
  const preload = join(directory, "barrier.mjs");
  writeFileSync(
    preload,
    `
import { appendFileSync, existsSync } from 'node:fs';
const originalFetch = globalThis.fetch;
const tokens = ['P7_FIRST', 'P7_APPEND', 'P7_REDIRECT', 'P7_CORRECTION', 'P7_QUESTION'];
const hold = async (path, signal) => {
  while (!existsSync(path)) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    await new Promise((done) => setTimeout(done, 25));
  }
};
globalThis.fetch = async (url, options) => {
  let input;
  try { input = JSON.parse(options?.body); } catch {}
  if (Array.isArray(input?.messages)) {
    const latestIndex = input.messages.findLastIndex((m) => m.role === 'user');
    const latest = input.messages[latestIndex];
    const text = JSON.stringify(latest);
    const index = tokens.findIndex((token) => text.includes(token));
    // Results of the current turn only: earlier turns' tool results stay in the transcript.
    const results = input.messages.slice(latestIndex + 1).filter((m) => m.role === 'tool').length;
    appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify({ at: Date.now(), index, results, input }) + '\\n');
    // A turn's tool call runs freely; its final reply request parks here and announces itself.
    // Only then does the gate persist and delivery-ACK the NEXT human message, so that message is
    // steered into the live session AFTER this reply was requested: the reply finishes the turn and
    // the steer becomes the next turn of the same run. The last reply is never released.
    if (index >= 0 && results >= 1) {
      appendFileSync(${JSON.stringify(directory)} + '/awaiting-' + index + '-' + results, '');
      await hold(${JSON.stringify(directory)} + '/release-' + index, options?.signal);
    }
    if (index === 4 && results >= 4) await hold(${JSON.stringify(directory)} + '/release-final', options?.signal);
  }
  return originalFetch(url, options);
};
`,
  );
  environment.NODE_OPTIONS = [environment.NODE_OPTIONS, "--import=" + preload]
    .filter(Boolean)
    .join(" ");
  const requests = (): any[] =>
    existsSync(requestsFile)
      ? readFileSync(requestsFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  try {
    assert.equal(process.platform, "darwin", "real macOS Worker required");
    modelFixture = await startModelFixture({ privateDir: join(directory, "model-fixture") });
    environment.PI_CODING_AGENT_DIR = modelFixture.agentDir;
    const serviceLog = openSync(join(directory, "service.log"), "w", 0o600);
    service = spawn(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/p7-loop-multiround.ts", "--service"],
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
      model: modelFixture.model("chatOwner"),
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

    const detail = await call("createTaskFn", {
      projectId: project.id,
      title: "P7_FIRST",
      description: "Preserve this Task and context across all turns.",
      constraints: "Use only the specified remote tools.",
      completionRequirements: "Human decides when to stop.",
      checklist: ["retain context"],
    });
    facts.taskId = detail.task.id;
    const ownRead = { name: "sprout_task_get", arguments: { taskId: detail.task.id } };

    // F4a/F4c: five human interventions inside ONE run. Every turn begins with a real tool call and
    // its reply is held until the next human message is acknowledged, so each intervention becomes a
    // new turn of the same run (`pi` steers a live session) instead of opening a second run.
    modelFixture!.arm("chatOwner", {
      expectedUserPrefix: "已分配并请求立即开始\nTask：",
      steps: [ownRead],
      reply: "P7_FIRST_REPLY",
    });
    const startedTask = await call("assignTaskFn", {
      taskId: detail.task.id,
      expectedRevision: detail.task.revision,
      targetChatId: chatId,
      startNow: true,
    });
    await until(() => requests().some((row) => row.index === 0), "first real SDK request");
    const runId = runs()[0].id;
    await until(() => runs()[0]?.config_snapshot, "run config snapshot");
    const snapshotOf = (run: any) => JSON.parse(run.config_snapshot);
    let snapshot = snapshotOf(runs()[0]);
    const transcript = () =>
      readFileSync(snapshot.sessionFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const stops = () =>
      transcript().filter(
        (entry: any) => entry.message?.role === "assistant" && entry.message.stopReason === "stop",
      ).length;

    const awaiting = (...parts: (string | number)[]) =>
      until(
        () => existsSync(join(directory, `awaiting-${parts.join("-")}`)),
        `turn is parked waiting for the next human input: ${parts.join("-")}`,
        120000,
      );

    /**
     * One human intervention: wait until the current turn's reply request is parked, persist the new
     * message, wait for the runner's delivery ACK, then release the parked turn. `gates` names the
     * release files this intervention unlocks.
     */
    async function intervene(gates: number[], body: string, arm: () => void) {
      arm();
      await awaiting(gates[0], 1);
      const message = await call("sendMessageFn", { chatId, body });
      await until(
        () => inputs().find((row) => row.message_id === message.id)?.delivered_at != null,
        `human input acknowledged by the runner: ${body.slice(0, 20)}`,
        30000,
      );
      assert.equal(
        rows("SELECT run_id FROM agent_run_input WHERE message_id=?", message.id)[0].run_id,
        runId,
        "F4a every intervention stays on the same run",
      );
      for (const gate of gates) writeFileSync(join(directory, "release-" + gate), "release");
      return message;
    }

    const appendix = await intervene(
      [0],
      "P7_APPEND: Also keep the checklist intact while you explain.",
      () =>
        modelFixture!.arm("chatOwner", {
          queued: true,
          expectedUserPrefix: "P7_APPEND",
          steps: [ownRead],
          reply: "P7_APPEND_REPLY",
        }),
    );
    await until(
      () => requests().some((row) => row.index === 1 && row.results === 0),
      "append turn reached the model",
    );
    const redirect = await intervene(
      [1],
      "P7_REDIRECT: Change the goal to explain the existing Task; keep its identity.",
      () =>
        modelFixture!.arm("chatOwner", {
          queued: true,
          expectedUserPrefix: "P7_REDIRECT",
          steps: [ownRead],
          reply: "P7_REDIRECT_REPLY",
        }),
    );
    await until(
      () => requests().some((row) => row.index === 2 && row.results === 0),
      "redirect turn reached the model",
    );
    const correction = await intervene(
      [2],
      "P7_CORRECTION: Replace my previous input goal with a shorter explanation.",
      () =>
        modelFixture!.arm("chatOwner", {
          queued: true,
          expectedUserPrefix: "P7_CORRECTION",
          steps: [ownRead],
          reply: "P7_CORRECTION_REPLY",
        }),
    );
    await until(
      () => requests().some((row) => row.index === 3 && row.results === 0),
      "correction turn reached the model",
    );
    const question = await intervene(
      [3, 4],
      "P7_QUESTION: Which Task and goal did I just ask about?",
      () =>
        modelFixture!.arm("chatOwner", {
          queued: true,
          expectedUserPrefix: "P7_QUESTION",
          reply: "P7_QUESTION_REPLY",
          steps: [
            ownRead,
            { name: "sprout_task_get", arguments: { taskId: foreign.id } },
            { name: "sprout_lease_acquire", arguments: lease },
            { name: "sprout_remote_shell", arguments: shell },
          ],
        }),
    );
    await awaiting(4, 4);
    // Wait for the Worker's own receipt before stopping: the stop must be observed on a run whose
    // remote work really finished, not on a race that leaves `dispatched` behind.
    await until(
      () => rows("SELECT state FROM remote_execution")[0]?.state === "succeeded",
      "real Worker execution receipt",
      60000,
    );

    assert.equal(runs().length, 1, "F4a all turns belong to one run");
    snapshot = snapshotOf(runs()[0]);
    const entries = transcript();
    const userEntries = entries.filter((row: any) => row.message?.role === "user");
    assert.equal(userEntries.length, 5, "F4a five SDK user turns entered the same session");
    for (const body of [appendix.body, redirect.body, correction.body, question.body])
      assert(
        JSON.stringify(userEntries).includes(body),
        "F4c every intervention is preserved verbatim in the SDK session",
      );
    assert(stops() >= 4, "F4a four completed model turns before the stop");
    assert(
      entries.filter((row: any) => row.message?.role === "assistant").length >= 5,
      "F4a the stopped run produced at least five assistant turns",
    );
    const turnRequests = requests().filter((row) => row.index >= 1);
    assert(
      JSON.stringify(turnRequests[0].input).includes("P7_FIRST_REPLY"),
      "F4a the second turn's request carries the first reply: context survives",
    );
    assert(
      JSON.stringify(requests().at(-1).input).includes(detail.task.id),
      "F4a the Task id is still in the final request",
    );
    assert.equal(
      rows("SELECT chat_id FROM task WHERE id=?", detail.task.id)[0].chat_id,
      chatId,
      "F4a Task ownership stays on this Chat",
    );
    assert.equal(
      rows(
        "SELECT COUNT(*) n FROM message WHERE chat_id=? AND body LIKE '%FOREIGN_SECRET%'",
        chatId,
      )[0].n,
      0,
      "F4a the foreign Task detail never entered this Chat",
    );
    const allInputs = inputs();
    assert.equal(allInputs.length, 5, "F4c all five human inputs are recorded once");
    assert(
      allInputs.every((row) => row.run_id === runId),
      "F4c every intervention stayed on the same run",
    );
    assert(
      allInputs.every((row) => row.disposition === "delivered"),
      "F4c every intervention was delivered",
    );
    assert.equal(
      rows("SELECT body FROM message WHERE id=?", redirect.id)[0].body,
      "P7_REDIRECT: Change the goal to explain the existing Task; keep its identity.",
      "F4c a corrected instruction never rewrites the replaced one",
    );
    pass("F4a/F4c five same-run interventions and four completed turns", {
      runId,
      taskId: detail.task.id,
      modelTurns: requests().length,
      bodies: [appendix.body, redirect.body, correction.body, question.body],
    });

    // Explicit refusals: malformed human input is rejected with a field error and never queued.
    const oversized = await callRaw("sendMessageFn", { chatId, body: "x".repeat(8001) });
    assert.equal(oversized.ok, false, "F9e an oversized message is explicitly rejected");
    assert.equal(oversized.error.code, "validation_failed");
    assert(oversized.fieldErrors?.body, "F9e the rejection names the body field");
    const empty = await callRaw("sendMessageFn", { chatId, body: "   " });
    assert.equal(empty.ok, false, "F4c an empty message is rejected, not silently dropped");
    assert(empty.fieldErrors?.body);
    assert.equal(inputs().length, 5, "F9e rejected messages never become run inputs");

    // F4c stop: the human stops the run while its last turn is still in flight.
    const stopped = await call("abortAgentRunFn", { runId });
    assert.equal(stopped.status, "aborted", "F4a human stop is never success");
    await until(
      () =>
        rows("SELECT * FROM remote_tool_grant WHERE run_id=? AND revoked_at IS NULL", runId)
          .length === 0,
      "stop revokes grant",
    );
    const settledAtStop = runs()[0].settled_at;
    const before = inputs().filter((row) => row.run_id === runId);
    modelFixture!.arm("chatOwner", {
      queued: true,
      expectedUserPrefix: "P7_AFTER",
      steps: [],
      reply: "P7_NEW_RUN_REPLY",
    });
    const afterMessage = await call("sendMessageFn", {
      chatId,
      body: "P7_AFTER: A new request after stopping the previous run.",
    });
    await until(
      () => runs().length === 2 && runs()[1].status === "completed",
      "new request settles in a new run",
    );
    assert.equal(runs()[0].status, "aborted", "F4a stopped run remains terminal");
    assert.deepEqual(
      inputs().filter((row) => row.run_id === runId),
      before,
      "F4a stopped run accepts no subsequent input",
    );
    assert.equal(
      rows("SELECT run_id FROM agent_run_input WHERE message_id=?", afterMessage.id)[0].run_id,
      runs()[1].id,
    );
    assert.equal(
      runs()[0].settled_at,
      settledAtStop,
      "F4a the stopped run is never re-settled or advanced",
    );
    assert.equal(
      rows(
        "SELECT COUNT(*) n FROM agent_run_input x JOIN agent_run r ON r.id=x.run_id WHERE r.id=? AND x.delivered_at IS NULL",
        runId,
      )[0].n,
      0,
      "F4a the stopped run has no undelivered input left to advance",
    );
    pass("F4a stop prevents subsequent rounds", {
      stoppedRun: runId,
      nextRun: runs()[1].id,
      completedTurnsBeforeStop: stops() - 1,
    });

    // F9d: one Chat's execution history — ordered rounds, status, elapsed time and the failure fact.
    const history = await call("getChatRunStateFn", { chatId });
    assert.deepEqual(
      history.runs.map((row: any) => row.id),
      runs().map((row) => row.id),
      "F9d API history is ordered",
    );
    assert.deepEqual(
      history.runs.map((row: any) => row.status),
      ["aborted", "completed"],
    );
    for (const run of history.runs) {
      assert(
        Date.parse(run.startedAt) >= Date.parse(run.queuedAt),
        "F9d start never precedes the queue",
      );
      assert(
        Date.parse(run.settledAt) >= Date.parse(run.startedAt),
        "F9d nonnegative elapsed time",
      );
    }
    assert.equal(
      history.runs[0].stopReason,
      "aborted",
      "F9d the interrupted round carries its stop reason",
    );
    assert.equal(
      history.runs[0].assistantMessageId,
      undefined,
      "F9d interrupted run has no successful result",
    );
    assert.equal(
      history.runs[1].errorCode,
      undefined,
      "F9d a completed round carries no error code",
    );
    assert.equal(
      history.runs.filter((row: any) => row.status === "completed").length,
      1,
      "F9d one success out of two rounds",
    );
    assert.equal(history.inputs.length, 1, "F9d inputs are reported for the latest run only");
    pass(
      "F9d API run history",
      history.runs.map((row: any) => ({
        id: row.id,
        status: row.status,
        stopReason: row.stopReason,
        startedAt: row.startedAt,
        settledAt: row.settledAt,
      })),
    );

    // F9b: artifacts are real files reachable from the API, and a success claim is backed by them.
    const executions = rows("SELECT * FROM remote_execution");
    assert.equal(executions.length, 1);
    assert.equal(executions[0].state, "succeeded", "F9b actual Worker execution succeeded");
    const frames = rows(
      "SELECT * FROM execution_log_frame WHERE execution_id=? ORDER BY sequence",
      executions[0].id,
    );
    assert(
      frames
        .map((frame) => Buffer.from(frame.payload_bytes).toString("utf8"))
        .join("")
        .includes(marker),
      "F9b real Worker output is readable",
    );
    assert(
      existsSync(snapshot.sessionFile) && readFileSync(snapshot.sessionFile, "utf8").length > 0,
      "F9b session artifact exists and is readable",
    );
    const completedRun = history.runs[1];
    assert.equal(
      completedRun.configSnapshot.sessionFile,
      snapshot.sessionFile,
      "F9b API locates the session artifact",
    );
    assert(completedRun.assistantMessageId, "F9b a completed run names its reply message");
    assert.equal(
      rows("SELECT id FROM message WHERE id=?", completedRun.assistantMessageId).length,
      1,
      "F9b the named reply really exists",
    );
    assert(
      existsSync(completedRun.configSnapshot.sessionFile),
      "F9b the success claim is backed by a readable artifact",
    );
    assert(
      existsSync(history.runs[0].configSnapshot.sessionFile),
      "F9b the stopped run keeps the transcript it really produced",
    );
    pass("F9b session artifact and Worker output", {
      sessionFile: snapshot.sessionFile,
      executionId: executions[0].id,
      frames: frames.length,
    });

    // The aborted turn's reply stays unused; everything else was consumed exactly once.
    const chatOwner = modelFixture!
      .metadata()
      .models.find((row: any) => row.model === "chat-owner")!;
    assert.equal(chatOwner.unusedSteps, 0, "F4a every planned tool step really ran");
    assert.equal(chatOwner.unusedPlans, 1, "F4c only the aborted turn's reply is unused");
    modelFixture!.assertHealthy();
    facts.stoppedRunId = runId;
    facts.taskStart = startedTask.startDelivery;
  } catch (error) {
    failure = error;
    console.error(error);
  } finally {
    await finish();
  }
}
