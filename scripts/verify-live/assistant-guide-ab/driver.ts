import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { cases, checkCase, diagnose } from "./checks.mjs";

const directory = process.env.ASSISTANT_AB_DIR!;
const dry = process.env.AB_DRY === "1";
mkdirSync(directory, { recursive: true, mode: 0o700 });
let guides: string[] = [];
let fixture:
  | Awaited<ReturnType<typeof import("../../verify/lib/model-fixture.mjs").startModelFixture>>
  | undefined;
if (dry) {
  const { startModelFixture } = await import("../../verify/lib/model-fixture.mjs");
  const source = readFileSync("scripts/pi-host-runner.mjs", "utf8");
  guides = ["ASSISTANT_GUIDE", "HTML_ARTIFACT_GUIDE"].map((name) =>
    source.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"))![1].trim(),
  );
  fixture = await startModelFixture({ privateDir: directory });
}
const model = dry ? fixture?.model("status") : process.env.SPROUT_VERIFY_PI_MODEL;
assert(model, "SPROUT_VERIFY_PI_MODEL provider/model is required for paid live");
let dispatch: (request: Request) => Promise<Response>;
let initialize: (request: Request) => unknown;
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = new Request(`${origin}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      body: Buffer.concat(chunks),
    });
    initialize(request);
    const response = await dispatch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  } catch (error) {
    outgoing.writeHead(500);
    outgoing.end(String(error));
  }
});
await new Promise<void>((done) => server.listen(0, "0.0.0.0", done));
const address = server.address();
assert(address && typeof address !== "string");
const hostname = Object.values(networkInterfaces())
  .flat()
  .find((a) => a?.family === "IPv4" && !a.internal)?.address;
assert(hostname, "LAN IPv4 required for the temporary assistant gateway");
const origin = `http://${hostname}:${address.port}`;
Object.assign(process.env, {
  DATABASE_URL: join(directory, "app.sqlite"),
  ...(fixture ? { PI_CODING_AGENT_DIR: fixture.agentDir } : {}),
  PI_TELEMETRY: "0",
  SPROUT_PI_ENABLED: "true",
  SPROUT_PI_DATA_DIR: join(directory, "pi"),
  SPROUT_REPO_DIR: join(directory, "repos"),
  SPROUT_PI_INHERIT_HOST_RESOURCES: "false",
  SPROUT_MEMORY_ENABLED: "false",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  PORT: String(address.port),
  APP_ORIGIN: origin,
});
const { migrateDatabase } = await import("../../../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../../../src/db");
const { startRuntime, shutdownRuntime } = await import("../../../src/server/runtime");
({ remoteAgentResponse: dispatch } = await import("../../../src/server/remote-agent-gateway"));
({ initializeRequestContext: initialize } = await import("../../../src/server/request-context"));
const { createProject } = await import("../../../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../../../src/domain/agent");
const { createDirectChat, sendMessage } = await import("../../../src/domain/chat");
const ctx = { userId: "assistant-ab-human", requestId: "req_11111111" };
const results = [];
let failed = false;
try {
  await startRuntime();
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(ctx.userId, "Human", "assistant-ab@example.test");
  const project = createProject({ name: "Assistant guide A/B" }, ctx);
  for (const test of cases) {
    const role = test.artifact ? "status" : "chatOwner";
    const caseModel = fixture ? fixture.model(role) : model;
    const helper = createAgentProfile(
      {
        name: `Assistant ${test.id}`,
        purpose: "assistant",
        model: caseModel,
        effort: process.env.AB_EFFORT ?? "off",
      },
      ctx,
    );
    addProjectMember(project.id, helper.id, ctx);
    const chat = createDirectChat(project.id, helper.id, ctx).chat;
    if (fixture) {
      let reply = test.artifact
        ? '已整理趋势与总计。\n\n```html\n<style>body{margin:0;color:var(--foreground);font-family:var(--font-body)}.report{background:var(--card);color:var(--card-foreground);border:1px solid var(--border-soft)}h1{font-family:var(--font-display)}strong{background:var(--primary);color:var(--primary-foreground)}em{color:var(--accent-foreground)}</style>\n<main class="report"><h1>三日数据</h1><p>12 → 18 → 15</p><strong>总计 45</strong><em>先升后降</em></main>\n```'
        : "总和是 45。";
      if (process.env.AB_FIXTURE_CDN === "1" && test.artifact)
        reply = reply.replace(
          "<main",
          '<script src="https://cdn.example/chart.js"></script>\n<main',
        );
      fixture.arm(role, {
        expectedUserText: test.prompt,
        expectedUserPrefix: test.prompt,
        steps: [],
        reply,
      });
    }
    sendMessage(chat.id, { senderKind: "human", senderId: ctx.userId, body: test.prompt }, ctx);
    const deadline = Date.now() + Number(process.env.AB_TURN_TIMEOUT_MS ?? 180000);
    let run: any;
    while (Date.now() < deadline) {
      fixture?.assertHealthy();
      run = sqlite
        .prepare(
          "SELECT * FROM agent_run WHERE chat_id=? AND status IN ('completed','failed','aborted') ORDER BY rowid DESC LIMIT 1",
        )
        .get(chat.id);
      if (run) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert(run, `assistant ${test.id} timed out; inspect ${directory}/pi`);
    writeFileSync(join(directory, `${test.id}-run.json`), JSON.stringify(run, null, 2));
    assert.equal(run.status, "completed", run.error_message ?? "completed actual Pi run");
    const snapshot = JSON.parse(run.config_snapshot);
    assert.equal(
      snapshot.profile.purpose,
      "assistant",
      "DM alone does not prove assistant guide loading",
    );
    const transcript = readFileSync(snapshot.sessionFile, "utf8");
    const transcriptFile = join(directory, `${test.id}-transcript.jsonl`);
    writeFileSync(transcriptFile, transcript);
    const messages = transcript
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.message?.role === "assistant")
      .map((entry) => entry.message);
    const texts = messages.map((m) =>
      (m.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join(""),
    );
    const reply = (
      sqlite.prepare("SELECT body FROM message WHERE id=?").get(run.assistant_message_id) as {
        body: string;
      }
    ).body;
    assert.equal(
      texts.at(-1),
      reply,
      "persisted final reply must equal final transcript assistant text",
    );
    const replyFile = join(directory, `${test.id}-reply.md`);
    writeFileSync(replyFile, reply);
    // 每条 assistant 文本另存纯文本，让中间输出的 HTML 也能定位到真实行号。
    const theme = readFileSync("src/theme.css", "utf8");
    const issues = checkCase(test, reply, [reply], theme);
    let caseFailed = issues.length > 0;
    for (const [i, text] of texts.entries()) {
      if (test.artifact || text === reply) continue;
      const file = join(directory, `${test.id}-assistant-${i}.md`);
      writeFileSync(file, text);
      for (const issue of checkCase({ ...test, maxChars: Infinity }, text, [text], theme)) {
        caseFailed = true;
        console.error(diagnose(file, issue));
      }
    }
    for (const issue of issues) console.error(diagnose(replyFile, issue));
    failed ||= caseFailed;
    const result = {
      case: test.id,
      status: caseFailed ? "FAIL" : "PASS",
      replyFile,
      transcriptFile,
      runId: run.id,
      sessionId: run.session_id,
      model: caseModel,
    };
    results.push(result);
    console.log(`${result.status} ${test.id} ${replyFile}:1 transcript=${transcriptFile}`);
  }
  fixture?.assertDrained();
  if (fixture) {
    const requests = fixture.receivedRequests();
    assert(requests.length >= cases.length, "each task reached the actual model fixture");
    for (const input of requests) {
      const system = input.messages
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      for (const guide of guides)
        assert(
          system.includes(guide),
          "selected ref guide must reach the actual Pi assistant model request",
        );
    }
    writeFileSync(
      join(directory, "fixture.json"),
      JSON.stringify({ ...fixture.metadata(), exactGuidesVerified: true }, null, 2),
    );
  }
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify(
      { mode: dry ? "local-model-fixture" : "paid-live", cwd: resolve("."), results },
      null,
      2,
    ),
  );
  if (failed) process.exitCode = 1;
} finally {
  await shutdownRuntime("assistant-guide-ab complete");
  await new Promise<void>((done) => server.close(() => done()));
  await fixture?.close();
}
