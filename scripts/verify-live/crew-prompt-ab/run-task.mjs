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
import { fileURLToPath } from "node:url";
import { startModelFixture } from "../../verify/lib/model-fixture.mjs";
import { createCrewFixture } from "../../../tests/fixtures/crew-live.mjs";
import {
  seedFixture,
  fixtureDefinition,
  judge,
  classifyRuns,
  unknownEvidence,
  recordTaskError,
  preserveOutcome,
  finalizeVerdict,
} from "./core.mjs";
import { artifactAssertions, parallelReportSignals } from "./artifacts.mjs";
import { machineFixtureCount } from "./fixtures.mjs";
import { readEvidence, settled, factsFrom, systemPromptEvidence } from "./evidence.mjs";
import { createSettlementCheck } from "./settlement.mjs";

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
    category: task.category ?? "primary",
    oracleConfig: task.oracleConfig ?? {},
    artifactCommands: fixtureDefinition(task.fixture).expected.artifactCommands ?? {},
    projectContext: task.projectContext ?? null,
    repeat,
    ref,
    head,
    testedRef: ref,
    model,
    dry,
    oracle: task.oracle,
    thinkingRequested: "low",
    thinkingEffective: null,
    machineScopes: [],
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
    latest,
    initial;
  function collectArtifactAssertions() {
    const root = row.fixtureWorktree;
    if (task.oracle === "delegate_parallel") {
      row.reportSignals = parallelReportSignals(row.leadFinalReplyText ?? "");
    }
    row.artifactAssertions = artifactAssertions(task, root, row, { corrected: false });
    row.artifactAssertionsCorrected = artifactAssertions(task, root, row, { corrected: true });
  }
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
    }
    const seed = join(directory, "seed");
    mkdirSync(seed, { recursive: true });
    initial = seedFixture(task.fixture, seed);
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
    env.AB_EXCHANGE_LOG = join(directory, "machine-exchanges.jsonl");
    const trace = fileURLToPath(new URL("./exchange-trace.mjs", import.meta.url));
    const server = launch(["--import", trace, ".output/server/index.mjs"], "service.log");
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
    const project = await call("createProjectFn", {
      name: `AB ${task.id} ${repeat}`,
      ...(task.projectContext ? { description: task.projectContext } : {}),
    });
    await call("updateProjectProfileFn", {
      projectId: project.id,
      gitRemote: "file://" + remote,
      defaultBranch: "main",
    });
    const agents = [];
    const members =
      task.members ??
      Array.from({ length: Math.max(2, machineFixtureCount(task.oracle)) }, (_, index) => ({
        name: ["ABWorkerOne", "ABWorkerTwo", "ABWorkerThree"][index],
        description: "Follow the human task and report concrete results concisely.",
      }));
    for (const [index, member] of [
      {
        name: "ABLead",
        description: "Follow the human task and report concrete results concisely.",
      },
      ...members,
    ].entries()) {
      const { name, description } = member;
      const agent = await call("createAgentProfileFn", {
        name,
        model: fixture ? fixture.model(index === 0 ? "chatOwner" : "chatMentioned") : model,
        effort: process.env.AB_THINKING ?? "low",
        persona: description,
      });
      await call("addProjectMemberFn", { projectId: project.id, agentProfileId: agent.id });
      agents.push(agent);
    }
    row.expectedWorkerProfileId =
      task.expectedWorkerIndex == null ? null : agents[task.expectedWorkerIndex + 1].id;
    const crew = await createCrewFixture(call, env.DATABASE_URL, {
      projectId: project.id,
      title: "Crew prompt AB",
      members: [{ kind: "human", id: userId }, ...agents.map((a) => ({ kind: "agent", id: a.id }))],
      initialOwner: { kind: "agent", id: agents[0].id },
    });
    input = { chatId: crew.id, projectId: project.id, userId };
    mkdirSync(env.SPROUT_REPO_DIR, { recursive: true });
    await call("updateProjectProfileFn", { projectId: project.id, workDirectory: project.id });
    for (let index = 0; index < machineFixtureCount(task.oracle); index++) {
      const enrollment = await call("createMachineFn", { name: `AB isolated Worker ${index + 1}` });
      const machineId = enrollment.detail.machine.id;
      const machineDirectory = join(directory, `machine-${index + 1}`);
      const root = join(machineDirectory, "machine-root");
      mkdirSync(root, { recursive: true });
      const worktree =
        index === 0 ? join(env.SPROUT_REPO_DIR, project.id) : join(machineDirectory, project.id);
      if (index === 0) row.fixtureWorktree = worktree;
      await fixtureGit(["clone", "-q", remote, worktree], `fixture-worktree-${index + 1}.log`);
      symlinkSync(worktree, join(root, project.id), "dir");
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
      const ticket = join(machineDirectory, "ticket");
      writeFileSync(ticket, enrollment.ticket, { mode: 0o600 });
      const state = join(machineDirectory, "worker-state");
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
        `worker-init-${index + 1}.log`,
      );
      await until(() => init.exitCode !== null, "Worker enrollment", 60000);
      assert.equal(init.exitCode, 0);
      launch(["dist/worker/main.js", "run", "--state-dir", state], `worker-${index + 1}.log`);
      let readyMachine;
      await until(
        async () => {
          const machine = await call("getMachineFn", { machineId, projectId: project.id });
          readyMachine = machine;
          return (
            machine.connection.kind === "online" &&
            machine.bindings[0]?.observation?.fact?.result?.kind === "accessible"
          );
        },
        "Worker accessible",
        60000,
      );
      const Database = createRequire(join(process.cwd(), "package.json"))("better-sqlite3");
      const database = new Database(env.DATABASE_URL, { readonly: true });
      let membership;
      try {
        membership = database
          .prepare(
            "SELECT epoch FROM project_machine_membership WHERE project_id=? AND machine_id=? AND state='active'",
          )
          .get(project.id, machineId);
      } finally {
        database.close();
      }
      assert(membership, "fixture Machine must have active project membership");
      const scope = {
        machineId,
        membershipEpoch: membership.epoch,
        directoryRealPath: readyMachine.bindings[0].observation.fact.result.realPath,
        directoryRevision: readyMachine.machine.rootRevision,
        operations: ["shell", "file_read", "file_write"],
      };
      row.machineScopes.push({
        ...scope,
        workerProfileId: machineFixtureCount(task.oracle) > 1 ? agents[index + 1].id : null,
        worktree,
      });
    }
    const scope = row.machineScopes[0];
    row.machineScope = scope;
    env.AB_RESOURCE_FIXTURE = join(directory, "resource-fixture.json");
    writeFileSync(env.AB_RESOURCE_FIXTURE, JSON.stringify({ ...input, scopes: row.machineScopes }));
    const resourceFixture = launch(
      ["--import", "tsx", fileURLToPath(new URL("./resource-fixture.mjs", import.meta.url))],
      "resource-fixture.log",
    );
    await until(
      () => {
        assert(
          resourceFixture.exitCode === null,
          "resource fixture exited; see resource-fixture.log",
        );
        return readFileSync(join(directory, "resource-fixture.log"), "utf8").includes(
          "AB_RESOURCE_FIXTURE_READY",
        );
      },
      "resource fixture ready",
      30000,
    );
    row.resourceFixturePolicy =
      "approve and allocate delegated Machine scopes atomically through frozen domain APIs as the current lead; service retains reconciliation and drain";
    const prompt =
      task.prompt +
      "\n\nFixture execution environment (identical in both arms):\n" +
      (task.projectContext ? `Project context: ${task.projectContext}\n` : "") +
      (task.members
        ? `Team responsibilities: ${JSON.stringify(members.map((member, index) => ({ ...member, profileId: agents[index + 1].id })))}\n`
        : "") +
      `The writable repositories are on the Crew Machines. Local host tools are read-only. ` +
      `The fixture coordinator registers and approves the assigned Machine scope for each worker profile: ${JSON.stringify(row.machineScopes)}. Use the scope assigned to that workerProfileId (a null profile permits any worker), include its directoryRealPath and resource scope in the worker request. Each machine has an independent clone of the same fixture. ` +
      "The worker must use the approved Crew resource authorization from info_hub to run remote file/shell tools; never use sprout_lease_acquire, handoff or grant. If authorization is not active yet, inspect resource status before running. Use relative file paths within the approved directory. " +
      "For work kept by the lead, request and approve a lead_run resource through sprout_resource_request and sprout_resource_approve.";
    writeFileSync(join(directory, "task-prompt.txt"), prompt);
    if (fixture)
      fixture.arm("chatOwner", {
        expectedUserText: prompt,
        expectedUserPrefix: prompt,
        steps: [],
        reply:
          "automatic continuation (auto_continuation); cerebellum continuation (cerebellum_continuation). Local harness transport finished.",
      });
    next("sendTask");
    row.taskSentAtMs = Date.now();
    await call("sendMessageFn", { chatId: crew.id, body: prompt });
    next("settle");
    const settlementCheck = createSettlementCheck();
    await until(() => {
      assert.equal(
        resourceFixture.exitCode,
        null,
        "resource fixture exited; see resource-fixture.log",
      );
      latest = readEvidence(env, input, remaining());
      if (latest.evidenceProbe) row.evidenceProbe = latest.evidenceProbe;
      return settlementCheck(latest);
    }, "Crew settle");
    next("judge");
    Object.assign(
      row,
      factsFrom(
        latest,
        crew.id,
        [
          ...new Set([
            ...Object.keys(initial),
            ...(fixtureDefinition(task.fixture).expected.delegationArtifacts ?? []),
          ]),
        ],
        fixtureDefinition(task.fixture).expected.delegationArtifacts ?? [],
      ),
    );
    collectArtifactAssertions();
    assert(row.runs.length > 0, "missing actual execution evidence");
    if (fixture) {
      fixture.assertHealthy();
      fixture.assertDrained();
    }
    row.passed = judge(task.oracle, row);
    row.status = row.passed ? "passed" : "failed";
  } catch (error) {
    recordTaskError(row, error, signal?.aborted);
    if (env && input) {
      try {
        latest = readEvidence(env, input, 5000);
      } catch (e) {
        row.evidenceError = e.message;
        if (e.code?.startsWith("AB_EVIDENCE_PROBE_"))
          row.evidenceProbe ??= {
            status: e.code === "AB_EVIDENCE_PROBE_TIMEOUT" ? "timeout" : "error",
            reason: e.message,
          };
      }
      if (latest) {
        try {
          Object.assign(
            row,
            factsFrom(
              latest,
              input.chatId,
              [
                ...new Set([
                  ...Object.keys(initial ?? {}),
                  ...(fixtureDefinition(task.fixture).expected.delegationArtifacts ?? []),
                ]),
              ],
              fixtureDefinition(task.fixture).expected.delegationArtifacts ?? [],
            ),
          );
          const observationTimeout = ["AB_TIMEOUT", "AB_EVIDENCE_PROBE_TIMEOUT"].includes(
            error.code,
          );
          if (observationTimeout && settled(latest) && !classifyRuns(latest.runs)) {
            collectArtifactAssertions();
            row.passed = judge(task.oracle, row);
            row.status = row.passed ? "passed" : "failed";
            row.recoveredOutcome = true;
          }
        } catch (e) {
          row.evidenceError = e.message;
        }
      }
    }
  } finally {
    preserveOutcome(row, task.oracle, latest?.delegations.length ?? row.delegatedCount);
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
      preserveOutcome(row, task.oracle, row.delegatedCount, e);
    }
    const levels = [...new Set((row.runs ?? []).map((run) => run.thinkingEffective))];
    row.thinkingEffective = levels.length === 1 ? levels[0] : null;
    finalizeVerdict(row);
    writeFileSync(join(directory, "result.json"), JSON.stringify(row, null, 2) + "\n");
  }
  return row;
}
