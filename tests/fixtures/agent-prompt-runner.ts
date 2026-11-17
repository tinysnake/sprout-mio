import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startModelFixture } from "../../scripts/verify/lib/model-fixture.mjs";
import type { Situation } from "../../src/contracts/prompt";

const root = resolve(import.meta.dirname, "../..");
const directory = mkdtempSync(join(tmpdir(), "agent-prompt-runner-"));
const persona = "Fixture persona: report concrete evidence.";
const runnerPath = join(root, "scripts/pi-host-runner.mjs");
const guide = readFileSync(runnerPath, "utf8").match(
  /const HTML_ARTIFACT_GUIDE = `([\s\S]*?)`;/,
)?.[1];
assert(guide, "existing HTML guide is present");
const legacyPrompt =
  persona +
  guide +
  `

<cwd>
${directory}
</cwd>`;
const crewTools = ["start", "input", "cancel", "list"].map((name) => `sprout_delegation_${name}`);
const reportTools = ["complete", "block"].map((name) => `sprout_delegation_${name}`);
const leaseTools = [
  "escrow", "wait", "claim", "revoke_grant", "escrow_cancel",
  "grant", "handoff", "acquire", "release", "get",
].map((name) => `sprout_lease_${name}`);
const fixture = await startModelFixture({ privateDir: directory });

async function request(
  situation: Situation,
  label: string,
  resume?: { sessionFile: string; sessionId: string },
  projectKind = "coding",
) {
  const sessionId = resume?.sessionId ?? randomUUID();
  const sessionFile = resume?.sessionFile;
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_TELEMETRY: "0" },
  });
  let stderr = "";
  let buffer = "";
  const events: Record<string, any>[] = [];
  const waiters = new Set<() => void>();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        events.push(JSON.parse(raw));
      } catch {}
    }
    for (const wake of waiters) wake();
  });
  const waitFor = (type: string) =>
    new Promise<Record<string, any>>((done, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`${label}: timed out waiting for ${type}: ${stderr}`)),
        25000,
      );
      const finish = (error?: Error, event?: Record<string, any>) => {
        clearTimeout(timer);
        waiters.delete(check);
        child.off("exit", exited);
        if (error) reject(error);
        else done(event!);
      };
      const check = () => {
        const failure = events.find((event) => event.type === "failure");
        if (failure) return finish(new Error(`${label}: ${JSON.stringify(failure)} ${stderr}`));
        const event = events.find((event) => event.type === type);
        if (event) finish(undefined, event);
      };
      const exited = () => finish(new Error(`${label}: runner exited ${stderr}`));
      child.once("exit", exited);
      waiters.add(check);
      check();
    });
  const send = (command: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify(command)}\n`);
  try {
    send({
      type: "open",
      id: "run_00000000",
      instanceId: "ins_00000000",
      sessionId,
      sessionDirectory: join(directory, "sessions"),
      ...(sessionFile ? { sessionFile } : {}),
      cwd: directory,
      agentDir: fixture.agentDir,
      extensionPath: join(root, "pi/sprout-extension.ts"),
      purpose: "worker",
      situation,
      projectContext: { kind: projectKind },
      resources: { kind: "disabled" },
      memory: { state: "disabled" },
      profile: {
        id: "cfg_00000000-0000-4000-8000-000000000000",
        name: "Prompt fixture",
        persona,
        description: "[[STEP3-DESC-MARKER]] 只负责验证",
        harness: "pi",
        model: fixture.model("status"),
        updatedAt: "2026-10-24T00:00:00.000Z",
      },
      remote: {
        endpoint: "http://127.0.0.1:1/api/remote/agent",
        secret: randomBytes(32).toString("base64url"),
        projectId: "prj_00000000",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
    const { snapshot } = await waitFor("ready");
    assert.deepEqual(snapshot.projectContext, { kind: "coding" });
    assert.equal(snapshot.profile.description, "[[STEP3-DESC-MARKER]] 只负责验证");
    if (sessionFile)
      assert.equal(snapshot.sessionFile, sessionFile, "resume opens the same session file");
    const text = `PROMPT_FIXTURE_${label}`;
    fixture.arm("status", {
      expectedUserPrefix: text,
      isolated: true,
      steps: [],
      reply: "Fixture completed.",
    });
    const before = fixture.receivedRequests().length;
    send({
      type: "prompt",
      id: "run_00000000",
      messageId: `message-${label}`,
      text,
      turnContext: {
        runId: "run_00000000",
        serializedText: text,
        contentHash: createHash("sha256").update(text).digest("hex"),
      },
    });
    await waitFor("settled");
    fixture.assertDrained();
    const requests = fixture.receivedRequests().slice(before);
    assert.equal(requests.length, 1, `${label}: one actual HTTP request`);
    const input = requests[0]!;
    if (resume) {
      const users = input.messages.filter((message) => message.role === "user");
      assert.equal(users.length, 2, "resumed request includes persisted history");
      assert(JSON.stringify(users[0]).includes("PROMPT_FIXTURE_dm"));
    }
    const systems = input.messages.filter((message) => message.role === "system");
    assert.equal(systems.length, 1, `${label}: one system message`);
    const system = systems[0]!.content;
    const tools = input.tools
      .map((tool) => tool.function.name)
      .filter((name) => name.startsWith("sprout_delegation_"));
    const expected =
      situation.kind === "crew_lead"
        ? crewTools
        : situation.kind === "delegation_worker"
          ? reportTools
          : [];
    assert.deepEqual(tools.sort(), [...expected].sort(), `${label}: exact delegation tool surface`);
    const isCrew = situation.kind === "crew_lead" || situation.kind === "delegation_worker";
    const leases = input.tools
      .map((tool) => tool.function.name)
      .filter((name) => name.startsWith("sprout_lease_"));
    assert.deepEqual(
      leases.sort(),
      isCrew ? [] : [...leaseTools].sort(),
      `${label}: crew uses execution resources; DM keeps all legacy lease tools`,
    );
    if (situation.kind === "crew_lead" || situation.kind === "delegation_worker") {
      assert(system.includes("## 工作描述\n[[STEP3-DESC-MARKER]] 只负责验证"));
      assert(system.includes("## 项目背景\n这是一个编程项目。"));
      assert(system.includes("以下补充要求与本节默认指引冲突时，以补充要求为准"));
      assert(system.indexOf("## 工作描述") < system.indexOf("## 项目背景"));
      assert(system.indexOf("## 项目背景") < system.indexOf("## 说话风格"));
      assert(system.length <= 4000);
    }
    if (situation.kind === "delegation_worker") {
      const block = input.tools.find((tool) => tool.function.name === "sprout_delegation_block");
      assert(block?.function.description.includes("Human 或 Crew lead"));
    }
    if (situation.kind === "crew_lead") {
      assert(system.includes(situation.crewName!), `${label}: crew name reaches provider`);
      for (const name of crewTools) assert(system.includes(name), `${label}: prompt names ${name}`);
      assert(system.includes("结束这一轮就是等待"), `${label}: waiting rule reaches provider`);
      assert(system.includes("循环调用 sprout_delegation_list 都是错的"));
      for (const name of reportTools)
        assert(!system.includes(name), `${label}: no worker role instructions`);
    } else if (situation.kind === "delegation_worker") {
      assert(system.includes(situation.delegationId!), `${label}: delegationId reaches provider`);
      for (const name of reportTools)
        assert(system.includes(name), `${label}: prompt names ${name}`);
      assert(system.includes("Human 或 Crew lead"), `${label}: needs_input decision authority`);
      for (const name of crewTools)
        assert(!system.includes(name), `${label}: no lead role instructions`);
    } else {
      assert.equal(system, legacyPrompt, `${label}: legacy system composition`);
    }
    const exited = once(child, "exit");
    send({ type: "close", id: "run_00000000" });
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert(existsSync(snapshot.sessionFile), "session persisted on disk");
    console.log(`${label}: PASS`);
    return { sessionFile: snapshot.sessionFile as string, sessionId };
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
}

try {
  await request({ kind: "crew_lead", crewName: "阿尔法小队" }, "crew");
  await request(
    { kind: "delegation_worker", delegationId: "dlg_0123456789", leadName: "Fixture lead" },
    "delegation",
  );
  const dmFile = await request({ kind: "dm_worker" }, "dm");
  await request({ kind: "crew_lead", crewName: "恢复后的小队" }, "resumed-crew", dmFile);
  await assert.rejects(
    () => request({ kind: "crew_lead" }, "invalid-project", undefined, "invalid"),
    /Invalid option/,
  );
  assert.equal(fixture.receivedRequests().length, 4);
  fixture.assertHealthy();
  console.log("agent prompt runner: 4 requests PASS; paidModelCalls=0");
} finally {
  await fixture.close();
  rmSync(directory, { recursive: true, force: true });
}
