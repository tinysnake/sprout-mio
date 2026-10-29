// I-P5a live gate: production HTTP, private SQLite, one real Worker and real Pi models.
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

const scenario = process.argv[2];
assert(scenario === "group" || scenario === "channel", "expected group or channel");
const directory = resolve(
  process.env.SPROUT_P5A_EVIDENCE_DIR ?? `.verify/p5a-live-${Date.now()}-${scenario}`,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
console.log(`EVIDENCE ${directory}`);
const model = process.env.SPROUT_VERIFY_PI_MODEL ?? "deepseek/deepseek-flash";
const children: ChildProcess[] = [];
const checks: unknown[] = [];
const facts: Record<string, unknown> = {
  scenario,
  model,
  directory,
  startedAt: new Date().toISOString(),
};
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
async function call<T = any>(name: string, data: unknown): Promise<T> {
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
let sampler: ReturnType<typeof setInterval> | undefined;
const deadline = setTimeout(() => {
  failure = new Error("live fixture total timeout (600s)");
  void finish();
}, 600000);
let finishing = false;
async function finish() {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  if (sampler) clearInterval(sampler);
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
  writeFileSync(join(directory, "result.json"), JSON.stringify(facts, null, 2));
  for (const child of [...children].reverse()) await stop(child);
  db?.close();
  console.log(`${failure ? "FAIL" : "PASS"} LIVE p5a-${scenario}; evidence ${directory}`);
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
  assert.equal(process.platform, "darwin", "real macOS Worker required");
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
  assert(
    existsSync(join(agentDir, "auth.json")),
    "real Pi credentials missing; live gate is not PASS",
  );
  launch([".output/server/index.mjs"], "service.log");
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
      email: `p5a-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "P5a live human",
    }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(signup.status, 200);
  cookie = signup.headers
    .getSetCookie()
    .find((value) => value.includes("session_token="))!
    .split(";")[0]!;
  const account = (await signup.json()) as { user: { id: string } };
  const project = await call("createProjectFn", { name: `P5a live ${scenario}` });
  facts.projectId = project.id;
  const agents: { id: string; name: string }[] = [];
  for (const name of ["LiveAlpha", "LiveBeta"]) {
    const profile = await call("createAgentProfileFn", {
      name,
      model,
      effort: "off",
      persona: `You are ${name}. Follow the user's exact Sprout tool instructions. Never use host bash/read/edit. Reply with your own name and a concise result; never mention another agent or repeat the user's mentions. Do not delegate, ask questions, or send chat messages through tools.`,
    });
    await call("addProjectMemberFn", { projectId: project.id, agentProfileId: profile.id });
    agents.push(profile);
  }
  facts.agents = agents.map(({ id, name }) => ({ id, name }));
  db = new Database(environment.DATABASE_URL!, { readonly: true });
  db.pragma("busy_timeout = 5000");
  if (scenario === "group") {
    const group = await call("createGroupChatFn", {
      projectId: project.id,
      title: "Real model fanout",
      members: [
        { kind: "human", id: account.user.id },
        ...agents.map((a) => ({ kind: "agent", id: a.id })),
      ],
      initialOwner: { kind: "agent", id: agents[0].id },
      wakePolicy: "owner_led",
    });
    chatId = group.id;
    assert.equal(group.owner.id, agents[0].id);
    pass("group has two Agent members and Agent owner", {
      chatId,
      owner: group.owner,
      members: await call("listChatMembersFn", { chatId }),
    });
  } else {
    const channels = rows(
      "SELECT * FROM chat WHERE project_id=? AND kind='public_channel'",
      project.id,
    );
    assert.equal(channels.length, 1);
    chatId = channels[0].id;
    const actual = (await call<any[]>("listChatMembersFn", { chatId }))
      .map((m) => `${m.memberKind}:${m.memberId}`)
      .sort();
    const expected = [
      `human:${account.user.id}`,
      ...rows("SELECT agent_profile_id FROM project_member WHERE project_id=?", project.id).map(
        (m) => `agent:${m.agent_profile_id}`,
      ),
    ].sort();
    assert.deepEqual(actual, expected);
    assert.equal(rows("SELECT * FROM chat_member WHERE chat_id=?", chatId).length, 0);
    pass("channel members derive exactly from Project", {
      chatId,
      members: actual,
      materializedRows: 0,
    });
  }
  facts.chatId = chatId;
  const enrollment = await call("createMachineFn", { name: `P5a ${scenario} macOS` });
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
    description: "P5a real model evidence",
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
  pass("one real Worker online with accessible Project directory", { machineId, model });
  sampler = setInterval(() => {
    const current = runs();
    samples.push({
      observedAtMs: Date.now(),
      runs: current.map((r) => ({ id: r.id, instanceId: r.instance_id, status: r.status })),
    });
  }, 50);
  const marker = `P5A_${scenario.toUpperCase()}_${randomUUID().replaceAll("-", "")}`;
  const toolInstructions = [
    `Only LiveAlpha: call sprout_lease_acquire once with ${JSON.stringify({ machineId, expectedGeneration: 0, requestId: `req_${randomUUID()}` })}.`,
    `Then call sprout_remote_shell once with ${JSON.stringify({ machineId, authorizationGeneration: 1, requestId: `req_${randomUUID()}`, command: `printf '${marker}\\n'`, cwd: join(root, project.id), waitMs: 1000 })}.`,
    "After the tools reply briefly with your own name and the shell output. Never mention any other agent.",
  ].join("\n");
  const body =
    scenario === "group"
      ? `@LiveAlpha @LiveBeta please each reply once in this conversation. LiveBeta: reply only with your own name and READY; do not call tools.\n${toolInstructions}`
      : `@LiveAlpha please run this real Worker check and reply once.\n${toolInstructions}`;
  const sentAtMs = Date.now();
  const human = await call("sendMessageFn", { chatId, body });
  facts.humanMessage = human;
  const expectedCount = scenario === "group" ? 2 : 1;
  await until(
    () =>
      runs().length === expectedCount &&
      runs().every((r) => !["queued", "running"].includes(r.status)),
    "initial real model runs settle",
    240000,
  );
  const initialRuns = runs();
  assert.equal(initialRuns.length, expectedCount);
  const initialInputs = inputs();
  assert.equal(initialInputs.length, expectedCount);
  assert(
    initialInputs.every((input) => input.message_id === human.id),
    "each run is linked to the same human message",
  );
  if (scenario === "channel") {
    assert.equal(initialRuns[0].agent_profile_id, agents[0].id);
    assert.equal(initialRuns.filter((run) => run.agent_profile_id === agents[1].id).length, 0);
    const quietDeadline = Date.now() + 3000;
    while (Date.now() < quietDeadline) {
      assert.equal(runs().length, 1);
      await sleep(100);
    }
    pass("d18 only mentioned Agent woke; unmentioned Agent has zero runs", {
      mentioned: agents[0].id,
      unmentioned: agents[1].id,
      unmentionedRuns: 0,
      quietObservationMs: 3000,
    });
  }
  assert(
    initialRuns.every((r) => r.status === "completed"),
    JSON.stringify(
      initialRuns.map((r) => ({ id: r.id, status: r.status, error: r.error_message })),
    ),
  );
  const replies = rows(
    "SELECT m.*, i.agent_profile_id FROM agent_run r JOIN agent_instance i ON i.id=r.instance_id JOIN message m ON m.id=r.assistant_message_id WHERE r.chat_id=?",
    chatId,
  );
  assert.equal(replies.length, expectedCount);
  for (const reply of replies) {
    assert.equal(reply.chat_id, chatId);
    assert.equal(reply.sender_kind, "agent");
    assert.equal(reply.sender_id, reply.agent_profile_id);
  }
  assert.equal(new Set(replies.map((r) => r.sender_id)).size, expectedCount);
  const starts = initialRuns.map((r) => r.started_at * 1000);
  const observedStart = (samples as any[]).find((s) =>
    s.runs.some((r: any) => r.status === "running"),
  )?.observedAtMs;
  pass("real model replies share chat with correct distinct senders", {
    replies: replies.map((r) => ({ id: r.id, senderId: r.sender_id, body: r.body })),
    humanToFirstRunMs: Math.min(...starts) - sentAtMs,
    humanToObservedRunningMs: observedStart ? observedStart - sentAtMs : null,
    dbTimestampResolutionMs: 1000,
    completionGapMs:
      Math.max(...initialRuns.map((r) => r.settled_at)) * 1000 -
      Math.min(...initialRuns.map((r) => r.settled_at)) * 1000,
  });
  const executions = rows("SELECT * FROM remote_execution WHERE project_id=?", project.id);
  assert.equal(executions.length, 1, "exactly one real remote shell execution");
  await until(
    () =>
      rows("SELECT * FROM remote_execution WHERE id=?", executions[0].id)[0]?.state === "succeeded",
    "remote shell complete",
  );
  const frames = rows("SELECT * FROM execution_log_frame WHERE execution_id=?", executions[0].id);
  const output = frames.map((frame) => Buffer.from(frame.payload_bytes).toString("utf8")).join("");
  assert(output.includes(marker), "real Worker log must contain requested marker");
  pass("real model called remote shell and real Worker returned marker", {
    executionId: executions[0].id,
    marker,
    output,
    frameCount: frames.length,
  });
  if (scenario === "group") {
    const first = await call("sendMessageFn", {
      chatId,
      body: "@LiveAlpha Give a thoughtful two sentence explanation of how serial task processing works. Use no tools and mention no other agent.",
    });
    const running = await until(
      () => runs().find((r) => r.agent_profile_id === agents[0].id && r.status === "running"),
      "serial first run starts",
    );
    const second = await call("sendMessageFn", {
      chatId,
      body: "@LiveAlpha Also acknowledge SERIAL_SECOND in your response. Use no tools and mention no other agent.",
    });
    facts.serialMessages = { first, second };
    const linked = inputs().filter((i) => i.message_id === second.id);
    assert.equal(linked.length, 1, "second human input assigned once");
    await until(
      () =>
        runs().every((r) => !["queued", "running"].includes(r.status)) &&
        inputs().every((i) => i.disposition !== "pending"),
      "serial messages settle",
      240000,
    );
    const relevant = runs().filter((r) => r.agent_profile_id === agents[0].id);
    assert(
      relevant.every((r) => r.status === "completed"),
      "serial runs completed",
    );
    for (const sample of samples as any[]) {
      const counts = new Map<string, number>();
      for (const r of sample.runs.filter((r: any) => ["queued", "running"].includes(r.status)))
        counts.set(r.instanceId, (counts.get(r.instanceId) ?? 0) + 1);
      assert(
        [...counts.values()].every((count) => count <= 1),
        "no two active runs per instance in samples",
      );
    }
    for (let i = 1; i < relevant.length; i++)
      assert(
        relevant[i].started_at >= relevant[i - 1].settled_at,
        "run intervals must not overlap",
      );
    const serialInputs = inputs().filter(
      (i) => i.message_id === first.id || i.message_id === second.id,
    );
    assert(
      serialInputs.every((i) => i.disposition === "delivered"),
      "both serial inputs delivered",
    );
    pass("same Agent human inputs serialize without overlapping active runs", {
      firstRunningRunId: running.id,
      secondAssignedRunId: linked[0].run_id,
      sameRun: running.id === linked[0].run_id,
      serialInputs,
      runs: relevant.map((r) => ({ id: r.id, startedAt: r.started_at, settledAt: r.settled_at })),
      samples: samples.length,
    });
  }
  const transcripts = collectTranscripts();
  assert(transcripts.length > 0, "real Pi session transcripts retained");
  assert(
    transcripts.every((session) => `${session.provider}/${session.model}` === model),
    "actual model matches selected live model",
  );
  const toolCalls = transcripts.flatMap((session) =>
    session.assistantMessages.flatMap((entry) =>
      entry.message.content
        .filter((part: { type: string }) => part.type === "toolCall")
        .map((part: { name: string }) => part.name),
    ),
  );
  assert(
    toolCalls.includes("sprout_lease_acquire") && toolCalls.includes("sprout_remote_shell"),
    "Pi transcript proves real model requested Worker execution",
  );
  pass("real Pi transcripts retained", { sessions: transcripts.length, model, toolCalls });
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  await finish();
}
