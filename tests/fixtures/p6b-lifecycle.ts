// Production HTTP + private SQLite + the installed Pi SDK/runner + a real Worker.
// The only stand-in is the model endpoint: a loopback fixture that answers the armed
// tool steps. Everything else is the production path — the built server (server
// functions over HTTP, the Pi host, the automation scheduler), the real runner child,
// the real Worker child, and one private SQLite file. The observer wrapper only records
// and (for one request) delays original bytes; it never synthesizes runner events,
// domain results or tool payloads.
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
import { infoHubQuerySchema, infoHubToolInputSchemas } from "../../src/contracts/info-hub-query";
import { INFO_HUB_CAPABILITIES } from "../../src/contracts/info-hub-capabilities";

// The runner prepends the turn snapshot, so every production model request starts with it.
const TURN_CONTEXT_PREFIX = '{"channel":"sprout_turn_context"';
/** Every assertion in this gate goes through one counter, so the report can state its weight. */
let assertionCount = 0;
const counted =
  (target: (...args: never[]) => unknown) =>
  (...args: never[]) => {
    assertionCount++;
    return target(...args);
  };
const A: typeof assert = new Proxy(assert, {
  get(target, key) {
    const value = (target as unknown as Record<string | symbol, unknown>)[key];
    return typeof value === "function" ? counted(value as (...args: never[]) => unknown) : value;
  },
  apply(target, thisArg, args) {
    assertionCount++;
    return Reflect.apply(target as (...args: never[]) => unknown, thisArg, args);
  },
});

if (process.argv[2] === "--service") {
  // The service process is the production server plus one private seam: a single
  // read transaction that returns the four Info Hub views next to the raw rows.
  // It exposes no domain write and no database mutation.
  void (await import(new URL("../../.output/server/index.mjs", import.meta.url).href));
  const { db, sqlite } = await import("../../src/db");
  const info = await import("../../src/domain/info-hub");
  const { infoHubQuerySchema } = await import("../../src/contracts/info-hub-query");
  const { machineRuntimeContext } = await import("../../src/server/runtime");
  const query = (raw: unknown) => infoHubQuerySchema.parse(raw);
  const rows = (sql: string, ...params: unknown[]) =>
    sqlite.prepare(sql).all(...params) as Record<string, unknown>[];
  // One transaction owns every view and every source row, so no fact can drift
  // between the two reads.
  const snapshot = async (message: {
    userId: string;
    projectId: string;
    chatId: string;
    agentProfileId: string;
    machineId: string;
  }) => {
    const runtime = await machineRuntimeContext();
    const ctx = {
      userId: message.userId,
      requestId: `req_${randomUUID()}`,
      ...runtime,
    };
    return db.transaction(() => ({
      project: info.getProjectInfoHub(message.projectId, ctx),
      projectAgents: info.getInfoHub(
        message.projectId,
        query({ view: "project", section: "agents" }),
        ctx,
      ),
      projectChats: info.getInfoHub(
        message.projectId,
        query({ view: "project", section: "chats" }),
        ctx,
      ),
      projectTasks: info.getInfoHub(
        message.projectId,
        query({ view: "project", section: "tasks" }),
        ctx,
      ),
      projectMachines: info.getInfoHub(
        message.projectId,
        query({ view: "project", section: "machines" }),
        ctx,
      ),
      chat: info.getChatInfo(message.chatId, ctx),
      agent: info.getAgentInfo(message.projectId, message.agentProfileId, ctx),
      machine: info.getInfoHub(
        message.projectId,
        query({ view: "machine", machineId: message.machineId }),
        ctx,
      ),
      sql: {
        tasks: rows(
          "SELECT id, title, status, revision, chat_id FROM task WHERE project_id=? ORDER BY rowid",
          message.projectId,
        ),
        taskCounts: rows(
          "SELECT status, count(*) AS n FROM task WHERE project_id=? GROUP BY status",
          message.projectId,
        ),
        chatTasks: rows(
          "SELECT id, status, revision FROM task WHERE chat_id=? ORDER BY rowid",
          message.chatId,
        ),
        projectMembers: rows(
          "SELECT agent_profile_id FROM project_member WHERE project_id=? ORDER BY agent_profile_id",
          message.projectId,
        ),
        instances: rows(
          "SELECT id, chat_id, agent_profile_id FROM agent_instance WHERE project_id=? ORDER BY id",
          message.projectId,
        ),
        activeRuns: rows(
          "SELECT id, chat_id, instance_id, status FROM agent_run WHERE project_id=? AND status IN ('queued','running') ORDER BY id",
          message.projectId,
        ),
        chatRunStatus: rows(
          "SELECT status, count(*) AS n FROM agent_run WHERE chat_id=? GROUP BY status",
          message.chatId,
        ),
        chatActiveRuns: rows(
          "SELECT id FROM agent_run WHERE chat_id=? AND status IN ('queued','running') ORDER BY id",
          message.chatId,
        ),
        chats: rows(
          "SELECT id, kind, owner_kind, owner_id, archived_at FROM chat WHERE project_id=? ORDER BY id",
          message.projectId,
        ),
        chatEffectiveMembers: rows(
          "SELECT member_kind, member_id FROM chat_effective_member WHERE chat_id=? ORDER BY member_kind, member_id",
          message.chatId,
        ),
        chatRow: rows(
          "SELECT id, owner_kind, owner_id, archived_at, governance_revision FROM chat WHERE id=?",
          message.chatId,
        ),
        machines: rows(
          "SELECT machine_id FROM project_machine WHERE project_id=? ORDER BY machine_id",
          message.projectId,
        ),
        leases: rows(
          "SELECT machine_id, generation, state, holder_instance_id, changed_at FROM machine_lease WHERE project_id=? ORDER BY machine_id",
          message.projectId,
        ),
      },
    }));
  };
  process.on("message", async (message: { id: string; name: string; data: unknown }) => {
    try {
      if (message.name !== "snapshot") throw new Error("unknown private seam");
      const result = await snapshot(message.data as Parameters<typeof snapshot>[0]);
      process.send?.({ id: message.id, result });
    } catch (error) {
      process.send?.({ id: message.id, error: String(error) });
    }
  });
} else {
  const directory = resolve(
    process.env.SPROUT_P6B_EVIDENCE_DIR ?? `.verify/p6b-lifecycle-${Date.now()}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  console.log(`EVIDENCE ${directory}`);
  const children: ChildProcess[] = [];
  const checks: unknown[] = [];
  const facts: Record<string, unknown> = {
    scenario: "p6b-lifecycle",
    directory,
    startedAt: new Date().toISOString(),
  };
  let db: Database.Database | undefined;
  let modelFixture: Awaited<ReturnType<typeof startModelFixture>> | undefined;
  let failure: unknown;
  let cookie = "";
  let accountId = "";
  let projectId = "";
  let sideProjectId = "";
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const stamp = () => `${Date.now()}-${Math.round(performance.now())}`;
  let countedUpTo = 0;
  function pass(name: string, detail: unknown = {}) {
    const weight = assertionCount - countedUpTo;
    countedUpTo = assertionCount;
    checks.push({ name, detail, assertions: weight, at: Date.now() });
    console.log(`PASS ${name} ${JSON.stringify(detail)} [assertions=${weight}]`);
  }
  async function until<T>(
    check: () => T | Promise<T>,
    label: string,
    timeout = 90000,
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
  A(address && typeof address !== "string");
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
  delete environment.SPROUT_VERIFY_CHAT_MODE;
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
  const built = files(".output/server")
    .filter((path) => path.endsWith(".mjs"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const ids = Object.fromEntries(
    [...built.matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)].map((m) => [m[2], m[1]]),
  );
  // The production build declares these reads as GET server functions; everything else
  // on this gate's surface is POST.
  const getFunctions = new Set(["getTaskDetailFn", "getProjectTasksFn"]);
  async function callRaw(name: string, data: unknown): Promise<any> {
    A(ids[name], `built server function missing: ${name}`);
    const payload = JSON.stringify({ t: toCrossJSON({ data }), f: 127, m: [] });
    const method = getFunctions.has(name) ? "GET" : "POST";
    const response = await fetch(
      `${base}/_serverFn/${ids[name]}${method === "GET" ? `?payload=${encodeURIComponent(payload)}` : ""}`,
      {
        method,
        headers: {
          Origin: base,
          Cookie: cookie,
          "content-type": "application/json",
          "x-tsr-serverfn": "true",
          accept: "application/json",
        },
        ...(method === "POST" ? { body: payload } : {}),
        signal: AbortSignal.timeout(30000),
      },
    );
    const body = await response.text();
    A.equal(response.status, 200, `${name}: HTTP ${response.status} ${body.slice(0, 400)}`);
    const { result } = fromCrossJSON(JSON.parse(body), { refs: new Map() });
    return result;
  }
  async function call<T = any>(name: string, data: unknown): Promise<T> {
    const result = await callRaw(name, data);
    A(result.ok, `${name}: ${JSON.stringify(result)}`);
    return result.data as T;
  }
  /** Task commands answer `{detail, startDelivery?}`; task reads answer the detail itself. */
  const unwrap = <T = any>(value: any): T => (value?.detail ?? value) as T;
  const byText = (left: string, right: string) => left.localeCompare(right);
  const rows = (sql: string, ...params: unknown[]): any[] =>
    db!.prepare(sql).all(...params) as any[];
  function rowMap(table: string, key = "id", where = "") {
    const map = new Map<string, string>();
    for (const row of rows(`SELECT rowid AS _rowid, * FROM ${table} ${where}`))
      map.set(String(row[key] ?? row._rowid), JSON.stringify(row));
    return map;
  }
  function rowDiff(before: Map<string, string>, after: Map<string, string>) {
    const added = [...after.keys()].filter((key) => !before.has(key));
    const removed = [...before.keys()].filter((key) => !after.has(key));
    const changed = [...after.keys()].filter(
      (key) => before.has(key) && before.get(key) !== after.get(key),
    );
    return { added, removed, changed };
  }
  /** Every write the Info Hub machinery must not perform, in one comparable dump. */
  function sideEffectDump() {
    return {
      message: rowMap("message"),
      agent_run: rowMap("agent_run"),
      agent_run_input: rowMap("agent_run_input", "rowid"),
      agent_instance: rowMap("agent_instance"),
      machine_lease: rowMap("machine_lease", "rowid"),
      chat: rowMap("chat"),
      chat_member: rowMap("chat_member", "rowid"),
      chat_schedule: rowMap("chat_schedule", "chat_id"),
      task: rowMap("task"),
    };
  }
  function sideEffectDiff(
    before: ReturnType<typeof sideEffectDump>,
    after: ReturnType<typeof sideEffectDump>,
  ) {
    return Object.fromEntries(
      Object.keys(before).map((table) => [
        table,
        rowDiff(before[table as keyof typeof before], after[table as keyof typeof after]),
      ]),
    ) as Record<string, { added: string[]; removed: string[]; changed: string[] }>;
  }
  // The observer records the production wire byte for byte and delays exactly one
  // model request. It never builds a prompt, a tool result or a runner event.
  const observer = join(directory, "runner-observer.mjs");
  const preload = join(directory, "observe-runner.mjs");
  const trace = join(directory, "runner-wire.jsonl");
  const wire = join(directory, "runner-http.jsonl");
  const controls = join(directory, "controls.json");
  writeFileSync(controls, "{}", { mode: 0o600 });
  writeFileSync(
    preload,
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
const DIRECTORY = ${JSON.stringify(directory)};
const CONTROLS = ${JSON.stringify(controls)};
const record = (data) => appendFileSync(${JSON.stringify(wire)}, JSON.stringify({ at: Date.now(), ...data }) + '\\n');
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
globalThis.fetch = async function(url, options) {
  const body = typeof options?.body === 'string' ? options.body : '';
  if (body && !String(url).includes('/api/remote/agent')) {
    let input;
    try { input = JSON.parse(body); } catch {}
    if (input) {
      record({ kind: 'model', url: String(url), input });
      let config = {};
      try { config = JSON.parse(readFileSync(CONTROLS, 'utf8')); } catch {}
      const marker = DIRECTORY + '/held-once';
      if (config.hold && body.includes(config.hold) && !existsSync(marker)) {
        writeFileSync(marker, String(Date.now()), { mode: 0o600 });
        record({ kind: 'model-held', hold: config.hold });
        while (!existsSync(DIRECTORY + '/release-model')) await new Promise(done => setTimeout(done, 20));
        record({ kind: 'model-released', hold: config.hold });
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
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const child = spawn(process.execPath, ['--import', ${JSON.stringify(preload)}, ${JSON.stringify(resolve("scripts/pi-host-runner.mjs"))}], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const record = (direction, value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ at: Date.now(), direction, value }) + '\\n');
createInterface({ input: process.stdin }).on('line', raw => {
  const value = JSON.parse(raw);
  record('command', value);
  child.stdin.write(raw + '\\n');
}).on('close', () => child.stdin.end());
createInterface({ input: child.stdout }).on('line', raw => {
  record('event', JSON.parse(raw));
  process.stdout.write(raw + '\\n');
});
child.on('exit', code => process.exit(code ?? 1));
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
  const commands = (type?: string) =>
    jsonLines(trace).filter(
      (row) => row.direction === "command" && (!type || row.value.type === type),
    );
  const hints = () =>
    commands("info_hub_hint").map((row) => ({ at: row.at as number, hint: row.value.hint }));
  const remoteCalls = () => jsonLines(wire).filter((row) => row.kind === "remote");
  const modelRequests = () => jsonLines(wire).filter((row) => row.kind === "model");
  const serviceCalls = new Map<string, (value: any) => void>();
  let service: ChildProcess;
  async function snapshot(data: Record<string, unknown>): Promise<any> {
    const id = randomUUID();
    const reply: any = await new Promise((done, reject) => {
      const timer = setTimeout(() => {
        serviceCalls.delete(id);
        reject(new Error("snapshot seam timeout"));
      }, 30000);
      serviceCalls.set(id, (value) => {
        clearTimeout(timer);
        done(value);
      });
      service.send!({ id, name: "snapshot", data });
    });
    A(!reply.error, reply.error);
    return reply.result;
  }
  async function runCountFor(chatId: string) {
    return rows("SELECT count(*) AS n FROM agent_run WHERE chat_id=?", chatId)[0].n as number;
  }
  async function settle(chatId: string, timeout = 240000) {
    return until(
      () => {
        const current = rows(
          "SELECT * FROM agent_run WHERE chat_id=? ORDER BY rowid",
          chatId,
        ) as any[];
        return (
          current.length > 0 &&
          current.every((run) => !["queued", "running"].includes(run.status)) &&
          current
        );
      },
      `runs settled in ${chatId}`,
      timeout,
    );
  }
  const deadline = setTimeout(() => {
    failure = new Error("p6b lifecycle total timeout (600s)");
    void finish();
  }, 600000);
  let finishing = false;
  async function finish() {
    if (finishing) return;
    finishing = true;
    clearTimeout(deadline);
    facts.checks = checks;
    facts.assertions = assertionCount;
    facts.checks = checks.length;
    facts.elapsedMs = Date.now() - Date.parse(String(facts.startedAt));
    facts.error =
      failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure;
    facts.finishedAt = new Date().toISOString();
    if (db) {
      writeFileSync(
        join(directory, "rows.json"),
        JSON.stringify(
          {
            runs: rows("SELECT * FROM agent_run ORDER BY rowid"),
            inputs: rows("SELECT * FROM agent_run_input ORDER BY rowid"),
            messages: rows(
              "SELECT id, chat_id, task_record_kind, created_at FROM message ORDER BY rowid",
            ),
            leases: rows("SELECT * FROM machine_lease"),
            tasks: rows("SELECT * FROM task ORDER BY rowid"),
            turnContexts: rows(
              "SELECT run_id, delivery_state, content_hash, submitted_at, length(serialized_text) AS bytes FROM turn_context ORDER BY rowid",
            ),
          },
          null,
          2,
        ),
      );
      try {
        await db.backup(join(directory, "snapshot.sqlite"));
      } catch (error) {
        facts.backupError = String(error);
      }
    }
    try {
      modelFixture?.assertHealthy();
    } catch (error) {
      facts.modelFailure = String(error);
      console.error(`MODEL FAILURE ${String(error)}`);
    }
    const metadata = modelFixture?.metadata() ?? { mode: "none" };
    writeFileSync(join(directory, "model-mode.json"), JSON.stringify(metadata, null, 2));
    console.log(`MODEL metadata ${JSON.stringify(metadata)}`);
    writeFileSync(join(directory, "result.json"), JSON.stringify(facts, null, 2));
    for (const child of [...children].reverse()) await stop(child);
    db?.close();
    await modelFixture?.close();
    console.log(`${failure ? "FAIL" : "PASS"} p6b lifecycle; evidence ${directory}`);
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

  try {
    A.equal(process.platform, "darwin", "real macOS Worker required");
    A(!process.env.SPROUT_PI_RUNNER, "the lifecycle gate requires the real Pi runner");
    modelFixture = await startModelFixture({ privateDir: join(directory, "model-fixture") });
    environment.PI_CODING_AGENT_DIR = modelFixture.agentDir;
    const serviceLog = openSync(join(directory, "service.log"), "w", 0o600);
    service = spawn(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/p6b-lifecycle.ts", "--service"],
      { env: environment, stdio: ["ignore", serviceLog, serviceLog, "ipc"] },
    );
    closeSync(serviceLog);
    children.push(service);
    service.on("message", (reply: any) => {
      serviceCalls.get(reply.id)?.(reply);
      serviceCalls.delete(reply.id);
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
        email: `p6b-lifecycle-${randomUUID()}@example.test`,
        password: randomBytes(24).toString("base64url"),
        name: "Lifecycle human",
      }),
      signal: AbortSignal.timeout(20000),
    });
    A.equal(signup.status, 200);
    cookie = signup.headers
      .getSetCookie()
      .find((value) => value.includes("session_token="))!
      .split(";")[0]!;
    accountId = ((await signup.json()) as { user: { id: string } }).user.id;
    facts.accountId = accountId;

    // ---- fixtures through the production boundaries -------------------------
    const project = await call("createProjectFn", { name: "Lifecycle main" });
    projectId = project.id;
    const sideProject = await call("createProjectFn", { name: "Lifecycle side" });
    sideProjectId = sideProject.id;
    facts.projectId = projectId;
    facts.sideProjectId = sideProjectId;
    const alpha = await call("createAgentProfileFn", {
      name: "LifecycleAlpha",
      model: modelFixture.model("chatOwner"),
      effort: "off",
      persona:
        "Use only the named Sprout tools with exactly the arguments you are given, then reply briefly. Never invent identifiers.",
    });
    const beta = await call("createAgentProfileFn", {
      name: "LifecycleBeta",
      model: modelFixture.model("chatMentioned"),
      effort: "off",
      persona: "Reply briefly.",
    });
    const sideOnly = await call("createAgentProfileFn", {
      name: "LifecycleSideOnly",
      model: modelFixture.model("status"),
      effort: "off",
      persona: "Reply briefly.",
    });
    // The same profile is a member of both Projects on purpose: it owns an idle DM in each
    // Project and only the side Project leases the Machine.
    const gamma = await call("createAgentProfileFn", {
      name: "LifecycleGamma",
      model: modelFixture.model("operator"),
      effort: "off",
      persona:
        "Use only the named Sprout tools with exactly the arguments you are given, then reply briefly. Never invent identifiers.",
    });
    for (const [target, profile] of [
      [projectId, alpha],
      [projectId, beta],
      [projectId, gamma],
      [sideProjectId, gamma],
      [sideProjectId, sideOnly],
    ] as const)
      await call("addProjectMemberFn", { projectId: target, agentProfileId: profile.id });
    const group = await call("createGroupChatFn", {
      projectId,
      title: "Lifecycle group",
      members: [
        { kind: "human", id: accountId },
        { kind: "agent", id: alpha.id },
        { kind: "agent", id: beta.id },
      ],
      initialOwner: { kind: "agent", id: beta.id },
      wakePolicy: "owner_led",
    });
    const dm = await call("createDirectChatFn", { projectId, agentProfileId: alpha.id });
    const idleDm = await call("createDirectChatFn", { projectId, agentProfileId: gamma.id });
    const crossChat = await call("createGroupChatFn", {
      projectId,
      title: "Lifecycle cross chat",
      members: [
        { kind: "human", id: accountId },
        { kind: "agent", id: beta.id },
      ],
      initialOwner: { kind: "agent", id: beta.id },
      wakePolicy: "owner_led",
    });
    const sideDm = await call("createDirectChatFn", {
      projectId: sideProjectId,
      agentProfileId: gamma.id,
    });
    facts.chats = {
      group: group.id,
      dm: dm.chat.id,
      idleDm: idleDm.chat.id,
      crossChat: crossChat.id,
      sideDm: sideDm.chat.id,
    };
    const crossTask = unwrap(
      await call("createTaskFn", {
        projectId,
        title: "Cross chat task",
        description: "CROSS_CHAT_SECRET_BODY",
        constraints: "private",
        completionRequirements: "private",
        checklist: [],
      }),
    );
    await call("assignTaskFn", {
      taskId: crossTask.task.id,
      expectedRevision: crossTask.task.revision,
      targetChatId: crossChat.id,
      startNow: false,
    });
    const visibleTask = unwrap(
      await call("createTaskFn", {
        projectId,
        title: "Visible task v1",
        description: "VISIBLE_SECRET_BODY",
        constraints: "",
        completionRequirements: "",
        checklist: [],
      }),
    );
    const machineEnrollment = await call("createMachineFn", { name: "Lifecycle macOS" });
    const machineId = machineEnrollment.detail.machine.id as string;
    const foreignEnrollment = await call("createMachineFn", { name: "Lifecycle side only" });
    const foreignMachineId = foreignEnrollment.detail.machine.id as string;
    const root = join(directory, "machine-root");
    mkdirSync(join(root, projectId), { recursive: true });
    mkdirSync(join(root, sideProjectId), { recursive: true });
    await call("saveMachineRootDirectoryFn", {
      machineId,
      directory: root,
      expectedRevision: machineEnrollment.detail.machine.rootRevision,
    });
    for (const target of [projectId, sideProjectId])
      await call("saveProjectMachineBindingFn", {
        machineId,
        projectId: target,
        description: "Lifecycle real runner evidence",
        expectedRevision: null,
      });
    await call("saveProjectMachineBindingFn", {
      machineId: foreignMachineId,
      projectId: sideProjectId,
      description: "Side project only",
      expectedRevision: null,
    });
    const ticketFile = join(directory, "private-ticket");
    writeFileSync(ticketFile, machineEnrollment.ticket as string, { mode: 0o600 });
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
    await until(() => init.exitCode !== null, "Worker enrollment", 120000);
    A.equal(init.exitCode, 0, "worker enrollment failed");
    launch(["dist/worker/main.js", "run", "--state-dir", stateDir], "worker.log");
    await until(
      async () =>
        (await call("getMachineFn", { machineId, projectId })).connection.kind === "online",
      "Worker online",
    );
    await until(
      async () =>
        (await call("getMachineFn", { machineId, projectId })).bindings[0]?.observation?.fact
          ?.result?.kind === "accessible",
      "Worker directory accessible",
    );
    db = new Database(environment.DATABASE_URL!, { readonly: true });
    db.pragma("busy_timeout = 5000");
    const sideProjectChatIds = new Set<string>(
      rows("SELECT id FROM chat WHERE project_id=?", sideProjectId).map((row) => row.id as string),
    );

    // ---- run 1: the real grant reads and is denied operations ----------------
    // Production identity is not passed in: every tool call below is resolved from the
    // live grant the Pi host issued for this run.
    const run1Text = `RUN1_LEASE_AND_INFO_HUB ${stamp()}`;
    const request1 = `req_${randomUUID()}`;
    modelFixture.arm("chatOwner", {
      expectedUserPrefix: TURN_CONTEXT_PREFIX,
      steps: [
        { name: "sprout_lease_get", arguments: { machineId } },
        {
          name: "sprout_lease_acquire",
          arguments: { machineId, expectedGeneration: 0, requestId: request1 },
        },
        { name: "sprout_info_hub_get", arguments: { view: "project", section: "agents" } },
        { name: "sprout_info_hub_get", arguments: { view: "project", section: "tasks" } },
        {
          name: "sprout_info_hub_get",
          arguments: { view: "chat", chatId: crossChat.id, section: "members" },
        },
        { name: "sprout_info_hub_get", arguments: { view: "machine", machineId } },
        {
          name: "sprout_info_hub_get",
          arguments: { view: "machine", machineId: foreignMachineId },
        },
        {
          name: "sprout_info_hub_get",
          arguments: { view: "agent", agentProfileId: sideOnly.id, section: "summary" },
        },
        {
          name: "sprout_task_update",
          arguments: {
            taskId: crossTask.task.id,
            expectedRevision: crossTask.task.revision,
            title: "Hijacked title",
          },
        },
        { name: "sprout_chat_send", arguments: { body: "Hijacked chat body" } },
      ],
      reply: "RUN1_DONE",
    });
    await call("sendMessageFn", { chatId: dm.chat.id, body: run1Text });
    const run1 = await until(
      () => rows("SELECT * FROM agent_run WHERE chat_id=? ORDER BY rowid", dm.chat.id)[0],
      "run 1 admitted",
    );
    await settle(dm.chat.id);
    const run1Row = rows("SELECT * FROM agent_run WHERE id=?", run1.id)[0];
    A.equal(run1Row.status, "completed", JSON.stringify(run1Row));
    const instanceA = run1Row.instance_id as string;
    A(
      modelRequests().some((row) => JSON.stringify(row.input).includes(run1Text)),
      "the driver's message reached the real model request after the turn snapshot",
    );

    // Invariant 1 — the turn snapshot is captured per runId, before the first prompt.
    const snapshot1 = await call("readTurnContextFn", { projectId, runId: run1.id });
    A.equal(snapshot1.kind, "captured", JSON.stringify(snapshot1));
    const record1 = snapshot1.record;
    A.equal(record1.runId, run1.id);
    A.equal(record1.instanceId, instanceA);
    A.equal(record1.agentProfileId, alpha.id);
    A.equal(record1.projectId, projectId);
    A(
      ["prepared", "submitted"].includes(record1.deliveryState),
      `snapshot delivery state: ${record1.deliveryState}`,
    );
    A.equal(record1.contentHash.length, 64);
    const snapshot1Again = await call("readTurnContextFn", { projectId, runId: run1.id });
    A.deepEqual(snapshot1Again, snapshot1, "same runId reads the same snapshot field by field");
    const confirmed = rows("SELECT * FROM turn_context WHERE run_id=?", run1.id)[0];
    A.equal(confirmed.delivery_state, "submitted");
    A(confirmed.submitted_at > 0, "the real confirmTurnContext path wrote a submission receipt");
    A.equal(confirmed.content_hash, record1.contentHash);
    const snapshotText1 = record1.serializedText as string;
    for (const forbidden of [
      sideProjectId,
      sideDm.chat.id,
      foreignMachineId,
      sideOnly.id,
      "SECRET",
      "Hijacked",
      "private",
    ])
      A(!snapshotText1.includes(forbidden), `snapshot leaked ${forbidden}`);
    A.equal(JSON.parse(snapshotText1).projectId, projectId);
    facts.turnSnapshots = {
      run1: { runId: run1.id, state: record1.deliveryState, bytes: snapshotText1.length },
    };
    pass("invariant 1a: host captured an immutable per-run snapshot before the first prompt", {
      runId: run1.id,
      instanceId: instanceA,
      deliveryState: record1.deliveryState,
      contentHash: record1.contentHash,
      bytes: Buffer.byteLength(snapshotText1),
    });

    // Invariant 4 — a visible status does not grant bodies or operations.
    const remote = remoteCalls();
    A(remote.length >= 10, `real runner used the remote HTTP boundary ${remote.length} times`);
    const agentView = remote.find(
      (row) => row.body?.call?.type === "info_hub_get" && row.body.call.input.section === "agents",
    );
    const projectTasks = remote.find(
      (row) =>
        row.body?.call?.type === "info_hub_get" &&
        row.body.call.input.view === "project" &&
        row.body.call.input.section === "tasks",
    );
    const crossChatFacts = remote.find(
      (row) => row.body?.call?.type === "info_hub_get" && row.body.call.input.view === "chat",
    );
    const ownMachine = remote.find(
      (row) =>
        row.body?.call?.type === "info_hub_get" &&
        row.body.call.input.view === "machine" &&
        row.body.call.input.machineId === machineId,
    );
    const foreignMachine = remote.find(
      (row) =>
        row.body?.call?.type === "info_hub_get" &&
        row.body.call.input.view === "machine" &&
        row.body.call.input.machineId === foreignMachineId,
    );
    const foreignAgent = remote.find(
      (row) => row.body?.call?.type === "info_hub_get" && row.body.call.input.view === "agent",
    );
    const taskUpdate = remote.find((row) => row.body?.call?.type === "task_mutate");
    const chatSend = remote.find((row) => row.body?.call?.type === "chat_send");
    A(agentView && projectTasks && crossChatFacts && ownMachine, "info hub reads must be real");
    A(foreignMachine && foreignAgent, "cross-Project probes must reach the server");
    A(taskUpdate && chatSend, "operation attempts must reach the server");
    A.equal(agentView.status, 200);
    A.equal(agentView.result.ok, true);
    A(
      agentView.result.data.data.some(
        (entry: any) => entry.agentProfileId === alpha.id && entry.agentProfileId !== sideOnly.id,
      ),
      "Agent view answers for the acting Project",
    );
    A.equal(projectTasks.result.ok, true);
    A(
      projectTasks.result.data.data.some((task: any) => task.taskId === crossTask.task.id),
      "the cross-chat Task summary is visible as a Project fact",
    );
    A.equal(crossChatFacts.result.ok, true);
    A(
      crossChatFacts.result.data.data.some((member: any) => member.memberId === beta.id),
      "the cross-chat member list is visible as a Project fact",
    );
    A.equal(ownMachine.result.ok, true);
    A.equal(ownMachine.result.data.data.lease.holderInstanceId, instanceA);
    A.deepEqual(
      [foreignMachine.status, foreignMachine.result.ok, foreignMachine.result.error.code],
      [200, false, "not_found"],
      "a Machine bound to another Project must not leak its existence",
    );
    A.deepEqual(
      [foreignAgent.status, foreignAgent.result.ok, foreignAgent.result.error.code],
      [200, false, "not_found"],
      "an Agent outside this Project must not leak its existence",
    );
    A.equal(taskUpdate.status, 200);
    A.equal(taskUpdate.result.ok, false, "Task writes must be refused");
    A(
      ["forbidden", "not_found", "task_revision_conflict"].includes(taskUpdate.result.error.code),
      `explainable Task denial: ${JSON.stringify(taskUpdate.result.error)}`,
    );
    // A Chat write has no target argument at all: the transport only ever speaks as this
    // run's own instance in its own Chat, so seeing another Chat grants no way to write it.
    A.equal(chatSend.status, 200);
    A.equal(chatSend.result.ok, true);
    A.equal(
      chatSend.result.data.chatId,
      dm.chat.id,
      "a Chat write can only land in the run's own Chat",
    );
    A.equal(chatSend.result.data.message.senderKind, "agent");
    A.deepEqual(
      Object.keys(infoHubToolInputSchemas),
      ["sprout_info_hub_get"],
      "the Info Hub surface exposes one read tool and no mutation verb",
    );
    A.equal(INFO_HUB_CAPABILITIES["hint.deliver"].agent, "never");
    A.equal(INFO_HUB_CAPABILITIES["turn_snapshot.capture"].agent, "never");
    for (const forgery of [
      { view: "project", section: "agents", body: "x" },
      { view: "project", section: "messages" },
      { view: "chat", chatId: dm.chat.id, section: "messages" },
      { view: "project", section: "agents", runId: run1.id },
      { view: "task", taskId: crossTask.task.id },
    ])
      A.equal(
        infoHubQuerySchema.safeParse(forgery).success,
        false,
        `the Info Hub query has no ${JSON.stringify(forgery)} form`,
      );
    const readablePayloads = [agentView, projectTasks, crossChatFacts, ownMachine].map((row) =>
      JSON.stringify(row.result),
    );
    A(
      readablePayloads.every((payload) => !payload.includes("SECRET")),
      "no Info Hub payload carries a Chat or Task body",
    );
    A(
      !readablePayloads.some((payload) => payload.includes("CROSS_CHAT_SECRET_BODY")),
      "the cross-chat Task body stays invisible",
    );
    A.equal(
      rows("SELECT title FROM task WHERE id=?", crossTask.task.id)[0].title,
      "Cross chat task",
      "the refused Task write changed nothing",
    );
    A.equal(
      rows("SELECT count(*) AS n FROM message WHERE chat_id=?", crossChat.id)[0].n,
      0,
      "the cross-chat write never happened",
    );
    facts.invariant4 = {
      reads: [
        { view: "project/agents", ok: agentView.result.ok },
        { view: "project/tasks", ok: projectTasks.result.ok },
        { view: "chat/members", ok: crossChatFacts.result.ok },
        { view: "machine", ok: ownMachine.result.ok, holder: instanceA },
      ],
      crossProject: {
        machine: foreignMachine.result.error.code,
        agent: foreignAgent.result.error.code,
      },
      operations: {
        task_update: taskUpdate.result.error.code,
        chat_send_scope: chatSend.result.data.chatId === dm.chat.id ? "own_chat_only" : "leaked",
        info_hub_tools: Object.keys(infoHubToolInputSchemas),
      },
    };
    pass("invariant 4: a real grant reads Project facts and is refused bodies and operations", {
      reads: facts.invariant4 && (facts.invariant4 as any).reads,
      crossProject: (facts.invariant4 as any).crossProject,
      operations: (facts.invariant4 as any).operations,
    });

    // The lease acquisition above is a real Worker round trip; carry it as evidence.
    const leaseRow = rows(
      "SELECT * FROM machine_lease WHERE project_id=? AND machine_id=?",
      projectId,
      machineId,
    )[0];
    A(leaseRow, "the real Worker must have acquired the lease");
    A.equal(leaseRow.state, "held");
    A.equal(leaseRow.holder_instance_id, instanceA);
    A.equal(leaseRow.generation, 1);

    // Invariant 1b — a different run gets its own snapshot, and the first one never moves.
    const titleAfterRun1 = `Lifecycle group v2 ${stamp()}`;
    await call("updateChatTitleFn", { chatId: group.id, title: titleAfterRun1 });
    const snapshot1AfterChange = await call("readTurnContextFn", { projectId, runId: run1.id });
    A.deepEqual(
      snapshot1AfterChange,
      snapshot1,
      "the persisted snapshot must not follow later visible facts",
    );
    A(!snapshotText1.includes(titleAfterRun1));

    // ---- run 2: hints merge while the run is live ----------------------------
    const run2Text = `RUN2_HINT_WINDOW ${stamp()}`;
    writeFileSync(controls, JSON.stringify({ hold: run2Text }), { mode: 0o600 });
    modelFixture.arm("chatMentioned", {
      expectedUserPrefix: TURN_CONTEXT_PREFIX,
      steps: [],
      reply: "RUN2_DONE",
    });
    // Product-initiated hint turns arrive as their own user message; one repeat plan
    // answers them without inventing anything.
    modelFixture.arm("chatMentioned", {
      expectedUserPrefix: '{"channel":"sprout_info_hub_hint"',
      steps: [],
      reply: "HINT_ACK",
      repeat: true,
      queued: true,
    });
    await call("sendMessageFn", { chatId: group.id, body: run2Text });
    const run2 = await until(
      () => rows("SELECT * FROM agent_run WHERE chat_id=? ORDER BY rowid", group.id)[0],
      "run 2 admitted",
    );
    await until(
      () =>
        existsSync(join(directory, "held-once")) &&
        jsonLines(wire).some((row) => row.kind === "model-held"),
      "the first model request is held at the model boundary",
      60000,
    );
    const heldAt = Date.now();
    const snapshot2 = await call("readTurnContextFn", { projectId, runId: run2.id });
    A.equal(snapshot2.kind, "captured");
    A.equal(snapshot2.record.runId, run2.id);
    A.notEqual(
      snapshot2.record.contentHash,
      record1.contentHash,
      "a second run carries its own snapshot",
    );
    A(
      snapshot2.record.serializedText.includes(titleAfterRun1),
      "the second snapshot sees the facts visible at its own capture",
    );
    A(!snapshot2.record.serializedText.includes("SECRET"));
    facts.turnSnapshots = {
      ...(facts.turnSnapshots as object),
      run2: {
        runId: run2.id,
        state: snapshot2.record.deliveryState,
        bytes: snapshot2.record.serializedText.length,
      },
    };
    pass("invariant 1b: a second run captures its own snapshot while the first stays frozen", {
      run1Hash: record1.contentHash,
      run2Hash: snapshot2.record.contentHash,
      firstStillFrozen: true,
    });

    // Five visible facts change while the run is live. Two are outside this run's hint
    // scope on purpose: a Task and a Chat elsewhere in the Project.
    const beforeChanges = sideEffectDump();
    const created: string[] = [];
    for (const suffix of ["a", "b"]) {
      const extra = unwrap(
        await call("createTaskFn", {
          projectId,
          title: `Window task ${suffix} ${stamp()}`,
          description: "",
          constraints: "",
          completionRequirements: "",
          checklist: [],
        }),
      );
      created.push(extra.task.id);
      await sleep(320);
    }
    const crossTitle = `Lifecycle cross chat v2 ${stamp()}`;
    await call("updateChatTitleFn", { chatId: crossChat.id, title: crossTitle });
    await sleep(320);
    await call("removeGroupMemberFn", {
      chatId: group.id,
      member: { kind: "agent", id: alpha.id },
      expectedRevision: (await call("getChatFn", { chatId: group.id })).governanceRevision,
    });
    await until(() => hints().length >= 1, "first merged hint", 30000);
    const firstHint = hints()[0]!;
    const afterFirstHint = sideEffectDump();
    const firstHintDiff = sideEffectDiff(beforeChanges, afterFirstHint);
    A(
      firstHint.at - heldAt >= 1800,
      `the merge window must delay the first hint (${firstHint.at - heldAt}ms)`,
    );
    A.equal(firstHint.hint.runId, run2.id);
    A.equal(firstHint.hint.chatId, group.id);
    A(
      firstHint.hint.changes.length >= 2,
      `merged hint must carry several changes: ${JSON.stringify(firstHint.hint.changes)}`,
    );
    A.deepEqual(
      [...new Set<string>(firstHint.hint.changes.map((change: any) => String(change.kind)))].sort(
        byText,
      ),
      ["agent_status", "chat_members"],
      "the merged hint carries exactly the in-scope fact kinds",
    );
    A(
      firstHint.hint.changes.every((change: any) => change.chatId === group.id),
      "every hint change names this run's Chat, never another one",
    );
    A(
      !JSON.stringify(firstHint.hint).includes(crossChat.id) &&
        !JSON.stringify(firstHint.hint).includes(crossTask.task.id) &&
        !JSON.stringify(firstHint.hint).includes(crossTitle),
      "facts changed in another Chat never enter this run's hint",
    );
    A(Buffer.byteLength(JSON.stringify(firstHint.hint)) <= 1024, "hint stays inside budget");
    for (const table of [
      "message",
      "agent_run",
      "agent_run_input",
      "machine_lease",
      "chat_schedule",
    ])
      A.deepEqual(
        firstHintDiff[table],
        { added: [], removed: [], changed: [] },
        `hint delivery must not write ${table}`,
      );
    A.deepEqual(
      [...firstHintDiff.task.added].sort(byText),
      [...created].sort(byText),
      "only the deliberate Task writes appear in the Task table",
    );
    A.deepEqual(firstHintDiff.task.removed, []);
    A.deepEqual(
      firstHintDiff.task.changed.filter((id) => !created.includes(id)),
      [],
      "no pre-existing Task row changed",
    );
    A.deepEqual(
      firstHintDiff.chat_member.changed,
      [],
      "the deliberate membership edits are the only membership changelog",
    );
    pass("invariant 2a: visible changes merge into one bounded, side-effect-free hint", {
      hintAt: firstHint.at,
      heldAt,
      changes: firstHint.hint.changes,
      visibleChanges: 5,
      deliberateTaskIds: created,
      sideEffectTables: Object.keys(firstHintDiff),
    });

    // A later in-scope change still has to wait for the minimum interval.
    const beforeInterval = Date.now();
    const windowTask = unwrap(
      await call("createTaskFn", {
        projectId,
        title: `Window task assigned ${stamp()}`,
        description: "",
        constraints: "",
        completionRequirements: "",
        checklist: [],
      }),
    );
    await call("assignTaskFn", {
      taskId: windowTask.task.id,
      expectedRevision: windowTask.task.revision,
      targetChatId: group.id,
      startNow: false,
    });
    const beforeSecondHint = sideEffectDump();
    await until(() => hints().length >= 2, "second hint after the minimum interval", 30000);
    const secondHint = hints()[1]!;
    A(
      secondHint.at - firstHint.at >= 4800,
      `the minimum interval must space hints (${secondHint.at - firstHint.at}ms)`,
    );
    A(secondHint.at - beforeInterval <= 12000, "the interval must not be unbounded");
    const secondHintDiff = sideEffectDiff(beforeSecondHint, sideEffectDump());
    for (const table of [
      "message",
      "agent_run",
      "agent_run_input",
      "machine_lease",
      "chat_member",
      "chat",
      "task",
    ])
      A.deepEqual(
        secondHintDiff[table],
        { added: [], removed: [], changed: [] },
        `the second hint must not write ${table}`,
      );
    A.equal(await runCountFor(group.id), 1, "hints never open a second run");
    const inputsForRun = rows("SELECT * FROM agent_run_input WHERE run_id=?", run2.id);
    A.equal(inputsForRun.length, 1, "hints are not admitted as run inputs");
    const chatMessages = rows("SELECT count(*) AS n FROM message WHERE chat_id=?", group.id)[0]
      .n as number;
    A.equal(
      chatMessages,
      1,
      "hints are not written as Chat messages (only the human's own message exists)",
    );
    A.equal(
      rows("SELECT count(*) AS n FROM run_resource_notice WHERE run_id=?", run2.id)[0].n,
      0,
      "hints enqueue no notice",
    );
    pass("invariant 2b: the minimum interval spaces hints and hints write nothing durable", {
      firstHintAt: firstHint.at,
      secondHintAt: secondHint.at,
      gapMs: secondHint.at - firstHint.at,
      totalHints: hints().length,
      visibleChanges: 6,
    });

    writeFileSync(join(directory, "release-model"), "release\n");
    await settle(group.id);
    const run2Row = rows("SELECT * FROM agent_run WHERE id=?", run2.id)[0];
    A.equal(run2Row.status, "completed", JSON.stringify(run2Row));
    A.equal(hints().length, 2, "the run ends with exactly the two observed hints");
    pass("run 2 settles after the held prompt is released", {
      runId: run2.id,
      status: run2Row.status,
      hints: hints().length,
      modelRequests: modelRequests().length,
    });

    // ---- run 3: the same Agent profile in a second Project -------------------
    const run3Text = `RUN3_SIDE_LEASE ${stamp()}`;
    const request3 = `req_${randomUUID()}`;
    modelFixture.arm("operator", {
      expectedUserPrefix: TURN_CONTEXT_PREFIX,
      steps: [
        { name: "sprout_lease_get", arguments: { machineId } },
        {
          name: "sprout_lease_acquire",
          arguments: { machineId, expectedGeneration: 0, requestId: request3 },
        },
        { name: "sprout_info_hub_get", arguments: { view: "project", section: "machines" } },
      ],
      reply: "RUN3_DONE",
    });
    await call("sendMessageFn", { chatId: sideDm.chat.id, body: run3Text });
    await settle(sideDm.chat.id);
    const run3Row = rows("SELECT * FROM agent_run WHERE chat_id=?", sideDm.chat.id)[0];
    A.equal(run3Row.status, "completed", JSON.stringify(run3Row));
    const sideLease = rows(
      "SELECT * FROM machine_lease WHERE project_id=? AND machine_id=?",
      sideProjectId,
      machineId,
    )[0];
    A(sideLease, "the side Project must hold its own lease on the same Machine");
    A.equal(sideLease.state, "held");
    A.equal(sideLease.holder_instance_id, run3Row.instance_id);
    A(
      sideLease.holder_instance_id !== leaseRow.holder_instance_id,
      "each Project leases the same Machine with its own holder",
    );

    // ---- invariant 5: Agent status only summarises its own Project ----------
    // LifecycleGamma is a member of both Projects, owns an idle DM in each, and only the
    // side DM ever ran — so the two Agent views describe the same profile with disjoint facts.
    const gammaMain = await call("getAgentInfoHubFn", { projectId, agentProfileId: gamma.id });
    const gammaSide = await call("getAgentInfoHubFn", {
      projectId: sideProjectId,
      agentProfileId: gamma.id,
    });
    const mainChatIds = new Set<string>(
      (gammaMain.instances as any[]).map((instance) => instance.chatId),
    );
    const sideChatIds = new Set<string>(
      (gammaSide.instances as any[]).map((instance) => instance.chatId),
    );
    A(mainChatIds.has(idleDm.chat.id), "the main Project lists its own instance");
    A(sideChatIds.has(sideDm.chat.id), "the side Project lists its own instance");
    A(!mainChatIds.has(sideDm.chat.id), "the main Project hides the side Project Chat");
    A(!sideChatIds.has(idleDm.chat.id), "the side Project hides the main Project Chats");
    A.deepEqual(
      [...mainChatIds].filter((chatId) => !sideProjectChatIds.has(chatId)),
      [...mainChatIds],
      "no main Agent instance points at a side Project Chat",
    );
    const mainLeaseMachines = (gammaMain.instances as any[]).flatMap((instance) =>
      instance.leases.map((lease: any) => `${lease.projectId}:${lease.machineId}`),
    );
    const sideLeaseMachines = (gammaSide.instances as any[]).flatMap((instance) =>
      instance.leases.map((lease: any) => `${lease.projectId}:${lease.machineId}`),
    );
    A.deepEqual(mainLeaseMachines, [], "the main Project shows this Agent no lease");
    A.deepEqual(sideLeaseMachines, [`${sideProjectId}:${machineId}`]);
    A(
      [...gammaMain.runs.active, ...gammaMain.runs.recent].every(
        (run: any) =>
          rows("SELECT project_id FROM agent_run WHERE id=?", run.runId)[0]?.project_id ===
          projectId,
      ),
      "every run in the main Agent view belongs to the main Project",
    );
    A.equal(gammaSide.runs.recent.length, 1, "the side Agent view owns its one run");
    A.equal(gammaMain.runs.recent.length, 0, "the main Agent view never borrows it");
    const mainMachines = await call("getInfoHubFn", {
      projectId,
      view: "project",
      section: "machines",
    });
    A(
      mainMachines.data.some((machine: any) => machine.machineId === machineId),
      "the main Machine view lists the shared Machine",
    );
    A(
      !mainMachines.data.some((machine: any) => machine.machineId === foreignMachineId),
      "the main Machine view hides the side-only Machine",
    );
    const sideMachineView = await call("getInfoHubFn", {
      projectId: sideProjectId,
      view: "machine",
      machineId,
    });
    const mainMachineView = await call("getInfoHubFn", {
      projectId,
      view: "machine",
      machineId,
    });
    A.equal(mainMachineView.data.lease.holderInstanceId, leaseRow.holder_instance_id);
    A.equal(
      sideMachineView.data.lease.holderInstanceId,
      sideLease.holder_instance_id,
      "the same Machine reports each Project its own lease holder",
    );
    A.equal(mainMachineView.data.lease.holder?.agentProfileId, alpha.id);
    A.equal(sideMachineView.data.lease.holder?.agentProfileId, gamma.id);
    const sideOnlyProfile = await callRaw("getAgentInfoHubFn", {
      projectId,
      agentProfileId: sideOnly.id,
    });
    A.equal(sideOnlyProfile.ok, false);
    A.equal(sideOnlyProfile.error.code, "not_found");
    const sideChatIdsInMainView = JSON.stringify(
      await call("getInfoHubFn", { projectId, view: "project", section: "chats" }),
    );
    A(
      !sideChatIdsInMainView.includes(sideDm.chat.id),
      "the main Chat list never names a side Project Chat",
    );
    facts.invariant5 = {
      mainInstances: [...mainChatIds],
      sideInstances: [...sideChatIds],
      mainLeases: mainLeaseMachines,
      sideLeases: sideLeaseMachines,
      mainRunCount: gammaMain.runs.recent.length,
      sideRunCount: gammaSide.runs.recent.length,
      crossProfile: sideOnlyProfile.error.code,
    };
    pass("invariant 5: Agent status and Machine views stay inside one Project", {
      mainChats: [...mainChatIds],
      sideChats: [...sideChatIds],
      mainLeases: mainLeaseMachines,
      sideLeases: sideLeaseMachines,
      crossProjectProfile: sideOnlyProfile.error.code,
    });

    // ---- invariant 3: ordinary change never wakes an idle instance ----------
    const idleBefore = sideEffectDump();
    const idleRunsBefore = await runCountFor(idleDm.chat.id);
    A.equal(idleRunsBefore, 0, "the idle Chat starts with no run");
    A.equal(
      rows("SELECT count(*) AS n FROM chat_schedule")[0].n > 0,
      true,
      "an assigned Task elsewhere keeps the automation scheduler armed",
    );
    const revisionBefore = (
      await call("getInfoHubFn", { projectId, view: "project", section: "chats" })
    ).revision;
    // Ordinary visible facts: a Task write, a membership edit, and the schedule row.
    await call("updateTaskFn", {
      taskId: visibleTask.task.id,
      expectedRevision: (await call("getTaskDetailFn", { taskId: visibleTask.task.id })).task
        .revision,
      title: `Visible task v3 ${stamp()}`,
    });
    await call("addProjectMemberFn", { projectId, agentProfileId: sideOnly.id });
    await call("removeProjectMemberFn", { projectId, agentProfileId: sideOnly.id });
    // The page keeps polling; polling is a read.
    let polledChanges = 0;
    for (let i = 0; i < 3; i++) {
      const refreshed = await call("refreshInfoHubFn", {
        projectId,
        query: { view: "project", section: "chats" },
        knownRevision: revisionBefore,
      });
      if (refreshed.kind === "changed") polledChanges++;
      await sleep(900);
    }
    const idleAfter = sideEffectDump();
    const idleDiff = sideEffectDiff(idleBefore, idleAfter);
    A(polledChanges > 0, "the page sees the change through its normal refresh path");
    A.deepEqual(
      idleDiff.agent_run,
      { added: [], removed: [], changed: [] },
      "ordinary change must not admit a run",
    );
    A.deepEqual(
      idleDiff.agent_run_input,
      { added: [], removed: [], changed: [] },
      "ordinary change must not admit a run input",
    );
    A.deepEqual(
      idleDiff.agent_instance,
      { added: [], removed: [], changed: [] },
      "ordinary change must not create a new session",
    );
    A.deepEqual(idleDiff.message, { added: [], removed: [], changed: [] });
    A.deepEqual(idleDiff.task.added, [], "the only Task write is the deliberate title update");
    A.deepEqual(
      idleDiff.task.changed,
      [visibleTask.task.id],
      "the deliberate title edit is the only Task row that moved",
    );
    A.equal(await runCountFor(idleDm.chat.id), 0);
    A.equal(
      rows(
        "SELECT count(*) AS n FROM agent_run_input WHERE run_id IN (SELECT id FROM agent_run WHERE chat_id=?)",
        idleDm.chat.id,
      )[0].n,
      0,
    );
    facts.invariant3 = {
      idleChatId: idleDm.chat.id,
      runsAdded: idleDiff.agent_run.added.length,
      inputsAdded: idleDiff.agent_run_input.added.length,
      sessionsAdded: idleDiff.agent_instance.added.length,
      polledChanges,
      schedulesArmed: rows("SELECT count(*) AS n FROM chat_schedule")[0].n,
    };
    pass("invariant 3: ordinary visible change never wakes an idle instance", facts.invariant3);

    // ---- invariant 6: four views agree with the source rows in one transaction
    const pinned = await snapshot({
      userId: accountId,
      projectId,
      chatId: group.id,
      agentProfileId: beta.id,
      machineId,
    });
    writeFileSync(join(directory, "snapshot-views.json"), JSON.stringify(pinned, null, 2));
    const sql = pinned.sql;
    const taskIds = (pinned.projectTasks.data as any[])
      .map((task) => String(task.taskId))
      .sort(byText);
    A.deepEqual(
      taskIds,
      (sql.tasks as any[]).map((task) => task.id).sort(byText),
      "Project Task items equal the Task rows",
    );
    for (const task of pinned.projectTasks.data as any[]) {
      const row = (sql.tasks as any[]).find((entry) => entry.id === task.taskId);
      A.equal(task.status, row.status, `Task status for ${task.taskId}`);
      A.equal(task.revision, row.revision, `Task revision for ${task.taskId}`);
      A.equal(task.title, row.title, `Task title for ${task.taskId}`);
    }
    A.deepEqual(
      pinned.project.tasks.counts,
      Object.fromEntries(
        ["proposed", "assigned", "finished", "canceled"].map((status) => [
          status,
          (sql.taskCounts as any[]).find((entry) => entry.status === status)?.n ?? 0,
        ]),
      ),
      "Project Task counts equal the grouped Task rows",
    );
    A.deepEqual(
      (pinned.projectAgents.data as any[]).map((agent) => agent.agentProfileId).sort(byText),
      (sql.projectMembers as any[]).map((member) => member.agent_profile_id).sort(byText),
      "Project Agents equal the Project member rows",
    );
    A.deepEqual(
      pinned.project.agents.runs.active.map((run: any) => run.runId).sort(byText),
      (sql.activeRuns as any[]).map((run: any) => run.id).sort(byText),
      "Project active runs equal the queued/running rows",
    );
    A.deepEqual(
      (pinned.projectChats.data as any[]).map((chat) => chat.chatId).sort(byText),
      (sql.chats as any[]).map((chat: any) => chat.id).sort(byText),
      "Project Chats equal the Chat rows",
    );
    for (const chat of pinned.projectChats.data as any[]) {
      const row = (sql.chats as any[]).find((entry) => entry.id === chat.chatId);
      A.equal(chat.owner.kind, row.owner_kind, `Chat owner kind for ${chat.chatId}`);
      A.equal(chat.owner.id, row.owner_id, `Chat owner id for ${chat.chatId}`);
      A.equal(chat.archived, row.archived_at !== null, `Chat archived for ${chat.chatId}`);
      A.deepEqual(
        [...chat.activeRunIds].sort(byText),
        (sql.chatActiveRuns as any[])
          .map((run: any) => run.id)
          .sort(byText)
          .includes(chat.chatId)
          ? [...chat.activeRunIds]
          : [],
        `Chat active run ids for ${chat.chatId}`,
      );
    }
    A.deepEqual(
      pinned.chat.runs.active.map((run: any) => run.runId).sort(byText),
      (sql.chatActiveRuns as any[]).map((run: any) => run.id).sort(byText),
      "Chat active runs equal the queued/running rows for that Chat",
    );
    A.deepEqual(
      pinned.chat.members
        .map((member: any) => `${member.memberKind}:${member.memberId}`)
        .sort(byText),
      (sql.chatEffectiveMembers as any[]).map(
        (member: any) => `${member.member_kind}:${member.member_id}`,
      ),
      "Chat members equal the effective member rows",
    );
    A.deepEqual(
      pinned.chat.tasks.items.map((task: any) => task.taskId).sort(byText),
      (sql.chatTasks as any[]).map((task: any) => task.id).sort(byText),
      "Chat Task items equal the Task rows for that Chat",
    );
    A.deepEqual(
      (pinned.agent.instances as any[]).map((instance) => instance.instanceId).sort(byText),
      (sql.instances as any[])
        .filter((instance: any) => instance.agent_profile_id === beta.id)
        .map((instance: any) => instance.id)
        .sort(byText),
      "Agent instances equal the instance rows for that profile",
    );
    A.equal(pinned.agent.projectId, projectId);
    A.equal(pinned.agent.agent.agentProfileId, beta.id);
    A(
      (pinned.agent.instances as any[]).every((instance) => instance.chatId === group.id),
      "the pinned Agent view stays on the one Chat of this profile in this Project",
    );
    const leaseSource = (sql.leases as any[]).find((lease) => lease.machine_id === machineId);
    A.equal(pinned.machine.data.lease.holderInstanceId, leaseSource.holder_instance_id);
    A.equal(pinned.machine.data.lease.generation, leaseSource.generation);
    A.equal(pinned.machine.data.lease.state, leaseSource.state);
    A.deepEqual(
      (pinned.projectMachines.data as any[]).map((machine) => machine.machineId).sort(byText),
      (sql.machines as any[]).map((machine: any) => machine.machine_id).sort(byText),
      "Project Machines equal the binding rows",
    );
    A.deepEqual(
      (pinned.project.machines as any[]).map((machine) => machine.machineId).sort(byText),
      (sql.machines as any[]).map((machine: any) => machine.machine_id).sort(byText),
    );
    // The HTTP path must serve the same production read, not a copy of it.
    const httpProjectAgents = await call("getInfoHubFn", {
      projectId,
      view: "project",
      section: "agents",
    });
    const httpProjectChats = await call("getInfoHubFn", {
      projectId,
      view: "project",
      section: "chats",
    });
    const httpChat = await call("getChatInfoFn", { chatId: group.id });
    const httpAgent = await call("getAgentInfoHubFn", { projectId, agentProfileId: beta.id });
    const httpMachine = await call("getInfoHubFn", { projectId, view: "machine", machineId });
    A.deepEqual(httpProjectAgents.data, pinned.projectAgents.data);
    A.deepEqual(httpProjectAgents.revision, pinned.projectAgents.revision);
    A.deepEqual(httpProjectChats.data, pinned.projectChats.data);
    A.deepEqual(httpProjectChats.revision, pinned.projectChats.revision);
    A.deepEqual(httpChat, pinned.chat, "the Chat view served over HTTP equals the pinned view");
    A.deepEqual(httpAgent, pinned.agent, "the Agent view served over HTTP equals the pinned view");
    A.deepEqual(httpMachine.data, pinned.machine.data);
    A.deepEqual(httpMachine.revision, pinned.machine.revision);
    facts.invariant6 = {
      pinnedAt: new Date().toISOString(),
      tasks: taskIds.length,
      activeRuns: pinned.project.agents.runs.active.length,
      leases: (sql.leases as any[]).length,
      chatMembers: pinned.chat.members.length,
      httpMatchesPinned: true,
    };
    pass(
      "invariant 6: the four views equal their source rows inside one transaction",
      facts.invariant6,
    );

    modelFixture.assertDrained();
    const metadata = modelFixture.metadata();
    A.equal(metadata.failed, false, JSON.stringify(metadata));
    A.equal(metadata.paidModelCalls, 0);
    facts.model = metadata;
    pass("model boundary stayed deterministic and free", metadata);
  } catch (error) {
    failure = error;
    console.error(error);
  } finally {
    await finish();
  }
}
