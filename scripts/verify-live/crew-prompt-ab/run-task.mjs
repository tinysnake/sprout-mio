import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  openSync,
  closeSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { startModelFixture } from "../../verify/lib/model-fixture.mjs";
import { createCrewFixture } from "../../../tests/fixtures/crew-live.mjs";
import { seedFixture, judge, classifyRuns, unknownEvidence } from "./core.mjs";
import { artifactAssertions } from "./artifacts.mjs";
import { readEvidence, settled, factsFrom, systemPromptEvidence } from "./evidence.mjs";

export async function runTask({
  task,
  repeat,
  arm,
  ref,
  head,
  model,
  directory,
  timeoutMs,
  dry,
  command,
  signal,
}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const phases = { prepare: 0, startup: 0, sendTask: 0, settle: 0, judge: 0 };
  const row = {
    ...unknownEvidence,
    childProcesses: [],
    arm,
    task: task.id,
    repeat,
    ref,
    head,
    testedRef: ref,
    model,
    dry,
    oracle: task.oracle,
    status: "errored",
    passed: null,
    wallClockPerPhase: phases,
    evidenceDirectory: directory,
  };
  let phase = "prepare",
    at = Date.now(),
    fixture,
    env,
    input,
    latest;
  const promptHashes = new Map();
  const children = [];
  function next(name) {
    signal?.throwIfAborted();
    phases[phase] += Date.now() - at;
    phase = name;
    at = Date.now();
  }
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
  function launch(args, log) {
    const fd = openSync(join(directory, log), "w", 0o600);
    const child = spawn(process.execPath, args, { env, detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    const record = {
      executable: process.execPath,
      args,
      startedAtMs: Date.now(),
      exitCode: null,
      signal: null,
      log: join(directory, log),
    };
    row.childProcesses.push(record);
    child.done = new Promise((resolve) => {
      child.once("error", (error) => {
        child.spawnError = error.message;
        record.error = error.message;
        resolve({ error: error.message });
      });
      child.once("exit", (code, signal) => {
        record.exitCode = code;
        record.signal = signal;
        record.settledAtMs = Date.now();
        resolve({ code, signal });
      });
    });
    children.push(child);
    return child;
  }
  async function until(probe, label, max = timeoutMs) {
    const deadline = Math.min(started + timeoutMs, Date.now() + max);
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const result = await probe();
      if (result) return result;
      if (children.some((child) => child.spawnError)) throw new Error("child spawn failed");
      await new Promise((done) => setTimeout(done, 100));
    }
    const error = new Error(`${label} exceeded bounded budget`);
    error.code = "AB_TIMEOUT";
    throw error;
  }
  async function fixtureGit(args, name) {
    return command("git", args, join(directory, name), Math.min(30000, remaining()));
  }
  try {
    const listener = createServer();
    await new Promise((done) => listener.listen(0, "0.0.0.0", done));
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    const host = Object.values(networkInterfaces())
      .flat()
      .find((address) => address.family === "IPv4" && !address.internal)?.address;
    assert(host, "temporary fixture requires a LAN IPv4 address");
    const base = `http://${host}:${port}`;
    env = {
      ...process.env,
      NO_PROXY: `localhost,127.0.0.1,::1,${host}`,
      no_proxy: `localhost,127.0.0.1,::1,${host}`,
      DATABASE_URL: join(directory, "private.sqlite"),
      APP_ORIGIN: base,
      HOST: "0.0.0.0",
      NITRO_HOST: "0.0.0.0",
      PORT: String(port),
      NITRO_PORT: String(port),
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      SPROUT_PI_ENABLED: "true",
      SPROUT_PI_INHERIT_HOST_RESOURCES: "0",
      SPROUT_PI_DATA_DIR: join(directory, "pi-data"),
      SPROUT_REPO_DIR: join(directory, "repos"),
    };
    delete env.SPROUT_PI_RUNNER;
    if (dry) {
      fixture = await startModelFixture({
        privateDir: join(directory, "model-fixture"),
        onRequest(request) {
          const observed = systemPromptEvidence(request);
          if (!observed) return;
          const hashes = promptHashes.get(observed.runId) ?? new Set();
          hashes.add(observed.hash);
          promptHashes.set(observed.runId, hashes);
          writeFileSync(
            join(directory, "system-prompt-hashes.json"),
            JSON.stringify(
              Object.fromEntries([...promptHashes].map(([runId, values]) => [runId, [...values]])),
              null,
              2,
            ),
          );
        },
      });
      env.PI_CODING_AGENT_DIR = fixture.agentDir;
      row.effectiveModel = fixture.model("chatOwner");
      row.dryLimitation =
        "Scripted local lead answer exercises transport and evidence; delegation behaviour is not a model quality measurement. Positive delegation tasks may fail their oracle.";
      fixture.arm("chatOwner", {
        expectedUserText: task.prompt,
        expectedUserPrefix: task.prompt,
        steps: [],
        reply:
          "automatic continuation (auto_continuation); cerebellum continuation (cerebellum_continuation). Local harness transport finished.",
      });
    }
    const seed = join(directory, "seed");
    mkdirSync(seed, { recursive: true });
    const initial = seedFixture(task.fixture, seed);
    await fixtureGit(["init", "-q", "-b", "main", seed], "git-init.log");
    await fixtureGit(["-C", seed, "add", "."], "git-add.log");
    await fixtureGit(
      [
        "-C",
        seed,
        "-c",
        "user.name=AB Fixture",
        "-c",
        "user.email=ab@example.test",
        "commit",
        "-qm",
        "seed task sandbox",
      ],
      "git-commit.log",
    );
    const remote = join(directory, "remote.git");
    await fixtureGit(["clone", "-q", "--bare", seed, remote], "git-clone.log");
    next("startup");
    const server = launch([".output/server/index.mjs"], "service.log");
    await until(
      async () => {
        if (server.exitCode !== null) throw new Error("service exited; see service.log");
        try {
          return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
          return false;
        }
      },
      "service health",
      60000,
    );
    const require = createRequire(join(process.cwd(), "package.json"));
    const startRequire = createRequire(require.resolve("@tanstack/react-start/package.json"));
    const clientRequire = createRequire(
      startRequire.resolve("@tanstack/start-client-core/package.json"),
    );
    const { fromCrossJSON, toCrossJSON } = clientRequire("seroval");
    function walk(path) {
      return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(path, e.name))
          : e.name.endsWith(".mjs")
            ? [join(path, e.name)]
            : [],
      );
    }
    const source = walk(".output/server")
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const ids = Object.fromEntries(
      [...source.matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)].map((m) => [m[2], m[1]]),
    );
    const signup = await fetch(base + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { Origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Crew AB",
        email: `ab-${randomUUID()}@example.test`,
        password: randomBytes(24).toString("base64url"),
      }),
      signal: AbortSignal.timeout(Math.min(20000, remaining())),
    });
    assert.equal(signup.status, 200, "signup");
    const cookie = signup.headers
      .getSetCookie()
      .find((v) => v.includes("session_token="))
      .split(";")[0];
    const userId = (await signup.json()).user.id;
    async function call(name, data) {
      assert(ids[name], `built server function missing ${name}`);
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
        signal: AbortSignal.timeout(Math.min(20000, remaining())),
      });
      const text = await response.text();
      assert.equal(response.status, 200, `${name}: ${text.slice(0, 300)}`);
      const { result } = fromCrossJSON(JSON.parse(text), { refs: new Map() });
      assert(result.ok, `${name}: ${JSON.stringify(result)}`);
      return result.data;
    }
    const project = await call("createProjectFn", { name: `AB ${task.id} ${repeat}` });
    await call("updateProjectProfileFn", {
      projectId: project.id,
      gitRemote: "file://" + remote,
      defaultBranch: "main",
    });
    const agents = [];
    for (const [index, name] of ["ABLead", "ABWorkerOne", "ABWorkerTwo"].entries()) {
      const agent = await call("createAgentProfileFn", {
        name,
        model: fixture ? fixture.model(index === 0 ? "chatOwner" : "chatMentioned") : model,
        effort: "off",
        persona: "Follow the human task and report concrete results concisely.",
      });
      await call("addProjectMemberFn", { projectId: project.id, agentProfileId: agent.id });
      agents.push(agent);
    }
    const crew = await createCrewFixture(call, env.DATABASE_URL, {
      projectId: project.id,
      title: "Crew prompt AB",
      members: [{ kind: "human", id: userId }, ...agents.map((a) => ({ kind: "agent", id: a.id }))],
      initialOwner: { kind: "agent", id: agents[0].id },
    });
    input = { chatId: crew.id, projectId: project.id, userId };
    const enrollment = await call("createMachineFn", { name: "AB isolated Worker" });
    const machineId = enrollment.detail.machine.id;
    const root = join(directory, "machine-root");
    mkdirSync(root, { recursive: true });
    mkdirSync(env.SPROUT_REPO_DIR, { recursive: true });
    row.fixtureWorktree = join(env.SPROUT_REPO_DIR, project.id);
    await fixtureGit(["clone", "-q", remote, row.fixtureWorktree], "fixture-worktree.log");
    await call("updateProjectProfileFn", {
      projectId: project.id,
      workDirectory: project.id,
    });
    symlinkSync(row.fixtureWorktree, join(root, project.id), "dir");
    await call("saveMachineRootDirectoryFn", {
      machineId,
      directory: root,
      expectedRevision: enrollment.detail.machine.rootRevision,
    });
    await call("saveProjectMachineBindingFn", {
      machineId,
      projectId: project.id,
      description: "AB sandbox",
      expectedRevision: null,
    });
    const ticket = join(directory, "ticket");
    writeFileSync(ticket, enrollment.ticket, { mode: 0o600 });
    const state = join(directory, "worker-state");
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
        "--allow-http",
        base,
      ],
      "worker-init.log",
    );
    await until(() => init.exitCode !== null, "Worker enrollment", 60000);
    assert.equal(init.exitCode, 0);
    launch(["dist/worker/main.js", "run", "--state-dir", state], "worker.log");
    await until(
      async () => {
        const machine = await call("getMachineFn", { machineId, projectId: project.id });
        return (
          machine.connection.kind === "online" &&
          machine.bindings[0]?.observation?.fact?.result?.kind === "accessible"
        );
      },
      "Worker accessible",
      60000,
    );
    next("sendTask");
    await call("sendMessageFn", { chatId: crew.id, body: task.prompt });
    next("settle");
    let stableSince = 0,
      signature = "";
    await until(() => {
      latest = readEvidence(env, input, Math.min(30000, remaining()));
      const terminalFailure = classifyRuns(latest.runs);
      if (terminalFailure) {
        const error = new Error(`agent run terminated ${terminalFailure}`);
        error.runClassification = terminalFailure;
        throw error;
      }
      const nextSignature = JSON.stringify(latest);
      if (!settled(latest) || signature !== nextSignature) {
        stableSince = Date.now();
        signature = nextSignature;
        return false;
      }
      return Date.now() - stableSince >= 1000;
    }, "Crew settle");
    next("judge");
    Object.assign(row, factsFrom(latest, crew.id, Object.keys(initial)));
    row.artifactAssertions = artifactAssertions(task, row.fixtureWorktree, row);
    assert(
      row.runs.some((r) => r.startedAt && r.transcript && r.tokens !== null),
      "missing actual lead execution/token evidence",
    );
    if (fixture) {
      fixture.assertHealthy();
      fixture.assertDrained();
    }
    row.passed = judge(task.oracle, row);
    row.status = row.passed ? "passed" : "failed";
  } catch (error) {
    row.status =
      error.runClassification ??
      (signal?.aborted
        ? "interrupted"
        : error.code === "AB_TIMEOUT" || Date.now() - started >= timeoutMs
          ? "timeout"
          : "errored");
    row.passed = null;
    row.error = { message: error.message, stack: error.stack };
    if (env && input) {
      try {
        latest = readEvidence(env, input, 5000);
        Object.assign(row, factsFrom(latest, input.chatId));
      } catch (e) {
        row.evidenceError = e.message;
      }
    }
  } finally {
    for (const run of row.runs ?? [])
      run.systemPromptHashes = dry ? [...(promptHashes.get(run.runId) ?? [])] : null;
    phases[phase] += Date.now() - at;
    row.settleMs = phases.settle;
    row.totalMs = Date.now() - started;
    if (latest)
      writeFileSync(join(directory, "domain-evidence.json"), JSON.stringify(latest, null, 2));
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 5000);
      await child.done.catch(() => {});
      clearTimeout(timer);
    }
    row.modelFixture = fixture?.metadata();
    try {
      await fixture?.close();
    } catch (e) {
      if (!["aborted", "interrupted", "timeout"].includes(row.status)) row.status = "errored";
      row.passed = null;
      row.cleanupError = e.message;
    }
    writeFileSync(join(directory, "result.json"), JSON.stringify(row, null, 2) + "\n");
  }
  return row;
}
