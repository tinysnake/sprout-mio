// Production domain/SQLite observations. Worker exchange is an explicit protocol fixture;
// it does not claim that a native process ran (the multiround gate covers that boundary).
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname, cpus, totalmem } from "node:os";

const mode = process.argv[2];
const phase = process.argv[3];
const evidence = process.env.SPROUT_P7_LOOP_EVIDENCE_DIR!;
assert(evidence);
const factsFile = join(evidence, "restart-facts.json");
if (mode === "restart" && !phase) {
  async function child(stage: string, crash = false) {
    const worker = fork(resolve("tests/fixtures/p7-loop-domain.ts"), ["restart", stage], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const timer = setTimeout(() => worker.kill("SIGKILL"), 60000);
    try {
      if (crash) {
        await new Promise<void>((done, reject) => {
          worker.once("message", () => {
            worker.kill("SIGKILL");
            done();
          });
          worker.once("error", reject);
          worker.once("exit", (code, signal) => {
            if (signal !== "SIGKILL")
              reject(new Error(`seed exited before crash: ${code}/${signal}`));
          });
        });
      }
      const result = await new Promise<{ code: number | null; signal: string | null }>(
        (done, reject) => {
          worker.once("exit", (code, signal) => done({ code, signal }));
          worker.once("error", reject);
        },
      );
      assert.deepEqual(
        result,
        crash ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null },
      );
    } finally {
      clearTimeout(timer);
    }
  }
  await child("seed", true);
  await child("probe");
  await child("probe-again");
  console.log(
    "PASS F9a real crash, migration startup, same run IDs, terminal recovery and second-restart idempotence",
  );
} else {
  const { sqlite } = await import("../../src/db");
  const runtime = await import("../../src/server/runtime");
  const runs = await import("../../src/domain/agent-run");
  const chats = await import("../../src/domain/chat");
  const agents = await import("../../src/domain/agent");
  const machines = await import("../../src/domain/machine");
  const leases = await import("../../src/server/lease");
  const workers = await import("../../src/server/worker-gateway");
  const { requestExecution } = await import("../../src/server/remote");
  const { createProject } = await import("../../src/domain/project");
  const { createGroupChatInput } = await import("../../src/contracts/chat");
  const { WORKER_STALE_AFTER_MS } = await import("../../src/contracts/worker");
  const { WORKER_RECOVERY_GRACE_MS } = await import("../../src/server/lease");
  const { newId, ID_PREFIXES } = await import("../../src/contracts/ids");
  const req = () => newId(ID_PREFIXES.request);
  const observations: unknown[] = [];
  const pass = (name: string, detail: unknown = {}) => {
    observations.push({ name, detail });
    console.log(`PASS ${name} ${JSON.stringify(detail)}`);
  };
  const row = (sql: string, ...args: any[]): any => sqlite.prepare(sql).get(...args);
  const all = (sql: string, ...args: any[]): any[] => sqlite.prepare(sql).all(...args);
  const fails = (code: string) => (error: any) => error?.code === code;
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  await runtime.startRuntime();
  const rt = await runtime.machineRuntimeContext();
  try {
    if (mode === "restart" && phase !== "seed") {
      const saved = JSON.parse(readFileSync(factsFile, "utf8"));
      for (const id of saved.activeIds) {
        const current = row("SELECT * FROM agent_run WHERE id=?", id);
        assert.equal(
          current.status,
          "interrupted",
          "F9a restart never promotes unfinished work to success",
        );
        assert.equal(current.error_code, "host_interrupted");
        assert.equal(current.assistant_message_id, null);
        assert(current.settled_at !== null);
        const diagnostics = all(
          "SELECT * FROM diagnostic_event WHERE run_id=? AND event='agent_run.interrupted'",
          id,
        );
        assert.equal(
          diagnostics.length,
          1,
          "F9a second restart cannot interrupt or advance the same run twice",
        );
        assert.equal(diagnostics[0].chat_id, current.chat_id);
        assert.equal(diagnostics[0].instance_id, current.instance_id);
      }
      assert.equal(
        row("SELECT status FROM agent_run WHERE id=?", saved.abortedId).status,
        "aborted",
      );
      assert.equal(row("SELECT COUNT(*) n FROM agent_run").n, saved.runCount);
      assert.equal(row("SELECT COUNT(*) n FROM agent_run_input").n, saved.inputCount);
      assert.equal(
        row("SELECT phase FROM runtime_boot WHERE id=?", saved.bootId).phase,
        "interrupted",
      );
      assert.notEqual(rt.bootId, saved.bootId);
      assert.deepEqual(
        row("SELECT config_snapshot FROM agent_run WHERE id=?", saved.activeIds[0]),
        saved.snapshot,
      );
      assert.equal(readFileSync(saved.artifact, "utf8"), "pre-crash transcript marker\n");
      pass("F9a recovery", {
        phase,
        beforeBootId: saved.bootId,
        afterBootId: rt.bootId,
        runIds: saved.activeIds,
      });
    } else {
      const userId = "usr_p7_loop";
      sqlite
        .prepare(
          "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
        )
        .run(userId, "P7 loop", "p7-loop@example.test");
      const ctx = { userId, requestId: req() };
      const human = { kind: "human" as const, userId, ctx };
      const project = createProject({ name: "P7 loop evidence" }, ctx);
      const profileA = agents.createAgentProfile({ name: "P7 A", persona: "", harness: "pi" }, ctx);
      const profileB = agents.createAgentProfile({ name: "P7 B", persona: "", harness: "pi" }, ctx);
      const profileC = agents.createAgentProfile({ name: "P7 C", persona: "", harness: "pi" }, ctx);
      for (const profile of [profileA, profileB, profileC])
        agents.addProjectMember(project.id, profile.id, ctx);
      const dmA = chats.createDirectChat(project.id, profileA.id, ctx).chat;
      const dmB = chats.createDirectChat(project.id, profileB.id, ctx).chat;
      const group = chats.createGroupChat(
        project.id,
        createGroupChatInput.parse({
          projectId: project.id,
          title: "P7 group",
          initialOwner: { kind: "agent", id: profileA.id },
          wakePolicy: "owner_led",
          members: [
            { kind: "human", id: userId },
            { kind: "agent", id: profileA.id },
            { kind: "agent", id: profileB.id },
          ],
        }),
        human,
      );
      const send = (chatId: string, body: string) =>
        chats.sendMessage(chatId, { senderKind: "human", senderId: userId, body }, ctx);
      function active(chatId: string, agentId: string) {
        const instance = chats.ensureInstance(chatId, agentId, ctx);
        return all(
          "SELECT * FROM agent_run WHERE instance_id=? AND status IN ('queued','running') ORDER BY rowid",
          instance.id,
        )[0];
      }
      function running(chatId: string, profile: typeof profileA) {
        let current = active(chatId, profile.id);
        if (!current) {
          send(chatId, "P7 fixture input");
          current = active(chatId, profile.id);
        }
        if (current.status === "queued")
          runs.transitionAgentRun(
            current.id,
            "running",
            {
              configSnapshot: {
                provider: "protocol-fixture",
                model: "no-model",
                thinking: "off",
                tools: [],
                extensions: [],
                sessionId: current.session_id,
                sessionFile: join(evidence, current.id + ".jsonl"),
                cwd: evidence,
                sdkVersion: "fixture",
                profile: {
                  id: profile.id,
                  name: profile.name,
                  persona: profile.persona,
                  harness: "pi",
                  model: profile.model,
                  effort: profile.effort,
                  updatedAt: profile.updatedAt,
                },
              },
            },
            ctx,
          );
        // Fixture boundary: bind a private grant row to this real production run/instance.
        // Direct domain lease calls below do not pretend to authenticate a live Pi process.
        const existingGrant = all("SELECT id FROM remote_tool_grant WHERE run_id=?", current.id)[0];
        const grantId = existingGrant?.id ?? newId(ID_PREFIXES.remoteToolGrant);
        if (!existingGrant) {
          // One grant per run: the fixture never issues a second identity for the same execution.
          sqlite
            .prepare(
              "INSERT INTO remote_tool_grant(id,secret_hash,user_id,project_id,chat_id,instance_id,run_id,issued_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
            )
            .run(
              grantId,
              createHash("sha256").update(grantId).digest("hex"),
              userId,
              project.id,
              chatId,
              current.instance_id,
              current.id,
              Date.now(),
              Date.now() + 3600000,
            );
        }
        return {
          ...ctx,
          ...rt,
          now: new Date(),
          projectId: project.id,
          chatId,
          instanceId: current.instance_id,
          runId: current.id,
          grantId,
        };
      }
      if (mode === "restart") {
        const a = running(dmA.id, profileA);
        send(dmB.id, "queued at crash");
        const queued = active(dmB.id, profileB.id);
        send(group.id, "abort before crash");
        const aborted = active(group.id, profileA.id);
        runs.abortAgentRun(aborted.id, ctx);
        const artifact = join(evidence, "pre-crash-transcript.jsonl");
        writeFileSync(artifact, "pre-crash transcript marker\n");
        writeFileSync(
          factsFile,
          JSON.stringify(
            {
              bootId: rt.bootId,
              activeIds: all("SELECT id FROM agent_run WHERE status IN ('queued','running')").map(
                (value) => value.id,
              ),
              abortedId: aborted.id,
              runCount: row("SELECT COUNT(*) n FROM agent_run").n,
              inputCount: row("SELECT COUNT(*) n FROM agent_run_input").n,
              snapshot: row("SELECT config_snapshot FROM agent_run WHERE id=?", a.runId),
              artifact,
            },
            null,
            2,
          ),
        );
        assert(queued.status === "queued");
        process.send?.({ seeded: true });
        await new Promise(() => {});
      } else {
        // Naming both Agents is the only way `owner_led` fans out to both: the policy wakes the
        // owner by default and every named Agent when the body names one.
        const first = send(group.id, `P7 fanout handoff request ${profileA.name} ${profileB.name}`);
        const groupA = running(group.id, profileA);
        const groupB = running(group.id, profileB);
        const links = all(
          "SELECT r.instance_id, x.message_id FROM agent_run_input x JOIN agent_run r ON r.id=x.run_id WHERE x.message_id=?",
          first.id,
        );
        assert.deepEqual(
          links.map((value) => value.instance_id).sort(byCodeUnit),
          [groupA.instanceId, groupB.instanceId].sort(byCodeUnit),
        );
        assert.equal(links.length, 2, "F5a group fanout exactly once per Agent");
        const actorA = running(dmA.id, profileA);
        send(dmA.id, "P7 private DM secret");
        const actorB = running(dmB.id, profileB);
        const otherCtx = {
          ...ctx,
          agent: {
            agentProfileId: profileA.id,
            instanceId: actorA.instanceId,
            runId: actorA.runId,
          },
        };
        // The agent execution identity is (run, instance, chat): a second DM is out of scope and the
        // product refuses with the same not_found it uses for every inaccessible object, so the
        // refusal itself does not leak whether the foreign Chat exists.
        assert.throws(
          () => chats.listMessages(dmB.id, otherCtx),
          fails("not_found"),
          "F5b cross-DM body read rejected",
        );
        assert.throws(
          () => chats.getChat(dmB.id, otherCtx),
          fails("not_found"),
          "F5b cross-DM Chat read rejected",
        );
        assert.throws(
          () => runs.listAgentRuns(dmB.id, otherCtx),
          fails("not_found"),
          "F5b cross-DM run listing rejected",
        );
        assert.throws(
          () => runs.listAgentRunInputs(actorB.runId, otherCtx),
          fails("not_found"),
          "F5b cross-DM run input read rejected",
        );
        assert.throws(
          () =>
            chats.sendMessage(
              dmB.id,
              { senderKind: "agent", senderId: profileA.id, body: "P7 cross-DM write" },
              otherCtx,
            ),
          (error: any) => ["not_found", "forbidden"].includes(error?.code),
          "F5b cross-DM agent write rejected",
        );
        assert.equal(
          all(
            "SELECT COUNT(*) n FROM message WHERE chat_id=? AND body LIKE '%private DM secret%'",
            dmA.id,
          )[0].n,
          1,
          "F5b secret lives only in its own DM",
        );
        assert.equal(
          all(
            "SELECT COUNT(*) n FROM message WHERE chat_id=? AND body LIKE '%private DM secret%'",
            dmB.id,
          )[0].n,
          0,
          "F5b the other DM never receives the body",
        );
        const workersByMachine: any[] = [];
        function worker(name: string) {
          const machine = machines.createMachine({ name }, { ...ctx, ...rt, now: new Date() });
          const machineId = machine.detail.machine.id;
          machines.saveProjectMachineBinding(
            { projectId: project.id, machineId, description: name, expectedRevision: null },
            { ...ctx, ...rt, now: new Date() },
          );
          const secret = randomUUID().replaceAll("-", "").repeat(2).slice(0, 43);
          const wire = { machineId, secret, version: 3 as const, requestId: req() };
          const workerCtx = { ...rt, now: new Date() };
          workers.enrollWorker({ ...wire, ticket: machine.ticket }, workerCtx);
          const session = workers.openWorker(
            { ...wire, attemptId: randomUUID() },
            workerCtx,
          ).session;
          let seq = 0;
          const exchange = (remote: any = {}, now = workerCtx.now) =>
            workers.exchangeWorker(
              {
                version: 3,
                requestId: req(),
                secret,
                session,
                seq: ++seq,
                mode: "normal",
                capability: {
                  platform: "darwin",
                  arch: "arm64",
                  workerVersion: "p7-protocol-fixture",
                  shells: [
                    {
                      path: "/bin/sh",
                      kind: "sh",
                      version: null,
                      checkedAt: now.toISOString(),
                      probe: { kind: "success" },
                    },
                  ],
                  remoteOperations: ["file_write"],
                },
                observations: [],
                remote: { results: [], fenceAcks: [], mcp: [], mcpCursors: [], ...remote },
              },
              { ...workerCtx, now },
            );
          exchange();
          const result = {
            machineId,
            key: { projectId: project.id, machineId },
            session,
            exchange,
            workerCtx,
            wire,
          };
          workersByMachine.push(result);
          return result;
        }
        const m1 = worker("P7 machine one");
        const m2 = worker("P7 machine two");
        if (mode === "collaboration") {
          const acquired = leases.acquireLease(
            { ...m1.key, action: "acquire", expectedGeneration: 0, requestId: req() },
            groupA,
          );
          assert.equal(acquired.completedGeneration, 1);
          assert.throws(
            () =>
              leases.acquireLease(
                { ...m1.key, action: "acquire", expectedGeneration: 1, requestId: req() },
                groupB,
              ),
            fails("lease_conflict"),
            "F6a second Agent cannot acquire the held Machine lease",
          );
          const execution = requestExecution(
            {
              ...m1.key,
              authorizationGeneration: 1,
              requestId: req(),
              operation: {
                kind: "file_write",
                path: "/tmp/p7-protocol-fixture",
                content: "fixture",
                mode: "overwrite",
              },
            },
            groupA,
          );
          m1.exchange();
          const pending = leases.handoffLease(
            {
              ...m1.key,
              action: "handoff",
              expectedGeneration: 1,
              requestId: req(),
              targetInstanceId: groupB.instanceId,
            },
            groupA,
          );
          assert.equal(pending.state, "pending");
          const blockers = agents.collectProjectMemberRemovalBlockers(project.id, profileB.id);
          assert(
            JSON.stringify(blockers).includes("handoff_target"),
            "F5a target responsibility blocks removal while draining",
          );
          const fence = m1.exchange().remote.fences[0];
          assert(fence);
          m1.exchange({ fenceAcks: [{ ...fence, dispatchSession: m1.session }] });
          const lease = leases.getLease(m1.key, groupB).lease;
          assert.equal(lease.holderInstanceId, groupB.instanceId, "F5a handoff changes holder");
          assert.equal(lease.generation, 2);
          assert.equal(
            row(
              "SELECT state FROM lease_authorization WHERE project_id=? AND machine_id=? AND generation=1",
              project.id,
              m1.machineId,
            ).state,
            "revoked",
          );
          assert.throws(
            () =>
              requestExecution(
                {
                  ...m1.key,
                  authorizationGeneration: 1,
                  requestId: req(),
                  operation: {
                    kind: "file_write",
                    path: "/tmp/p7-never",
                    content: "forbidden",
                    mode: "overwrite",
                  },
                },
                groupA,
              ),
            fails("lease_stale_generation"),
          );
          assert.throws(
            () =>
              leases.releaseLease(
                { ...m1.key, action: "release", expectedGeneration: 2, requestId: req() },
                groupA,
              ),
            fails("lease_not_holder"),
            "F5a the old Agent no longer owns any lease action",
          );
          assert.throws(
            () =>
              leases.acquireLease(
                { ...m1.key, action: "acquire", expectedGeneration: 2, requestId: req() },
                actorA,
              ),
            fails("lease_conflict"),
            "F5a a different Chat's Agent cannot inherit the handed-off lease",
          );
          assert.equal(
            leases.getLease(m1.key, groupA).lease.holderInstanceId,
            groupB.instanceId,
            "F5a the handoff receipt names the new holder for both Agents",
          );
          const identifiers = all(
            "SELECT id, run_id, instance_id FROM remote_tool_grant WHERE chat_id=? AND revoked_at IS NULL",
            group.id,
          );
          assert.equal(
            new Set(identifiers.map((value) => value.instance_id)).size,
            2,
            "F5a each participant holds its own grant identity",
          );
          pass("F5a group fanout and completed handoff", {
            group: group.id,
            oldHolder: groupA.instanceId,
            holder: groupB.instanceId,
            mutationId: pending.mutationId,
            executionId: execution.executionId,
          });
          pass("F5b DM body boundary", {
            code: "not_found",
            denied: ["listMessages", "getChat", "listAgentRuns", "listAgentRunInputs"],
            source: dmA.id,
            target: dmB.id,
            sharedInfoHub:
              "Project Task/lease summaries intentionally visible (docs/tasks-decisions)",
          });
        } else {
          const admissionA = {
            ...m1.key,
            action: "acquire" as const,
            expectedGeneration: 0,
            requestId: req(),
          };
          const admissionB = {
            ...m2.key,
            action: "acquire" as const,
            expectedGeneration: 0,
            requestId: req(),
          };
          const one = leases.acquireLease(admissionA, actorA);
          const two = leases.acquireLease(admissionB, actorB);
          assert.equal(one.completedGeneration, 1);
          assert.equal(two.completedGeneration, 1);
          assert.notEqual(m1.key.machineId, m2.key.machineId);
          assert.equal(
            row("SELECT project_id FROM agent_run WHERE id=?", actorA.runId).project_id,
            row("SELECT project_id FROM agent_run WHERE id=?", actorB.runId).project_id,
            "F6a both Agents work in the same Project",
          );
          assert.notEqual(actorA.chatId, actorB.chatId, "F6a each Agent owns a different Chat");
          assert.equal(leases.getLease(m1.key, actorA).lease.holderInstanceId, actorA.instanceId);
          assert.equal(leases.getLease(m2.key, actorB).lease.holderInstanceId, actorB.instanceId);
          assert.throws(
            () =>
              leases.acquireLease(
                { ...m1.key, action: "acquire", expectedGeneration: 1, requestId: req() },
                actorB,
              ),
            fails("lease_conflict"),
          );
          assert.deepEqual(
            leases.acquireLease(admissionA, actorA),
            one,
            "F6b identical request replays the same receipt",
          );

          // F6b: one real dispatched execution, then a silent heartbeat gap, a reconnect and the
          // recovery grace. Every step is observed through production lease/worker code.
          const execution = requestExecution(
            {
              ...m1.key,
              authorizationGeneration: 1,
              requestId: req(),
              operation: {
                kind: "file_write",
                path: join(evidence, "p7-worker-exec.txt"),
                content: "p7",
                mode: "overwrite",
              },
            },
            actorA,
          );
          m1.exchange();
          assert.equal(
            row(
              "SELECT dispatch_connection_generation d FROM remote_execution WHERE id=?",
              execution.executionId,
            ).d,
            1,
          );
          const future = new Date(Date.now() + WORKER_STALE_AFTER_MS + 1000);
          const connection = machines.getMachine(
            { machineId: m1.machineId },
            { ...ctx, ...rt, now: future },
          ).connection;
          assert.equal(
            connection.kind,
            "offline",
            "F6b heartbeat timeout changes connection state",
          );
          assert.equal(
            leases.getLease(m1.key, { ...actorA, now: future }).lease.state,
            "held",
            "F6b contract: timeout alone never frees a lease",
          );
          assert.throws(
            () => m1.exchange({}, future),
            fails("stale"),
            "F6b a silent Worker cannot advance an execution or a lease",
          );
          const staged = row(
            "SELECT state, terminal_at, failure_reason FROM remote_execution WHERE id=?",
            execution.executionId,
          );
          assert.equal(
            staged.state,
            "dispatched",
            "F6b an unreported execution is never rewritten as success",
          );
          assert.equal(staged.terminal_at, null);
          assert.notEqual(staged.state, "succeeded");
          // A new Worker boot opens the next connection generation; the old session is fenced and
          // the unreported execution only becomes an explained `unknown` after the recovery grace.
          const reopened = workers.openWorker(
            {
              version: 3,
              requestId: req(),
              machineId: m1.machineId,
              secret: m1.wire.secret,
              attemptId: randomUUID(),
            },
            { ...rt, now: future },
          ).session;
          assert.equal(reopened.generation, 2, "F6b reconnect opens exactly one new generation");
          assert.throws(
            () => m1.exchange({}, future),
            fails("superseded"),
            "F6b the previous session is fenced after reconnect",
          );
          const afterGrace = new Date(future.getTime() + WORKER_RECOVERY_GRACE_MS + 1000);
          const recovered = leases.getLease(m1.key, { ...actorA, now: afterGrace }).lease;
          const lost = row(
            "SELECT state, failure_reason FROM remote_execution WHERE id=?",
            execution.executionId,
          );
          assert.equal(
            lost.state,
            "unknown",
            "F6b unreported Worker work ends as an explained unknown",
          );
          assert.equal(lost.failure_reason, "worker_lost");
          assert.equal(
            recovered.generation,
            1,
            "F6b recovery never advances the lease generation twice",
          );
          assert.equal(
            recovered.holderInstanceId,
            actorA.instanceId,
            "F6b an interrupted Worker never promotes its run or loses the lease silently",
          );
          assert.equal(
            row("SELECT status FROM agent_run WHERE id=?", actorA.runId).status,
            "running",
            "F6b a lost Worker run is never recorded as success",
          );
          assert.equal(
            row(
              "SELECT COUNT(*) n FROM agent_run WHERE id=? AND status IN ('completed','failed')",
              actorA.runId,
            ).n,
            0,
          );
          pass("F6a/F6b isolated leases, conflict, timeout and replay", {
            machineIds: [m1.machineId, m2.machineId],
            chats: [dmA.id, dmB.id],
            project: project.id,
            conflict: "lease_conflict",
            timeoutMs: WORKER_STALE_AFTER_MS,
            staleRefusal: "stale",
            fencedAfterReconnect: "superseded",
            execution: { state: lost.state, failureReason: lost.failure_reason },
            leaseAfterLoss: { generation: recovered.generation, state: recovered.state },
          });

          // F9e: measured bounds. A Chat keeps one in-flight run per instance and every extra
          // message merges into it; the database refuses a second concurrent run outright.
          const before = row("SELECT COUNT(*) n FROM agent_run").n;
          for (let index = 0; index < 32; index++) send(dmA.id, "P7 capacity " + index);
          assert.equal(
            row("SELECT COUNT(*) n FROM agent_run").n,
            before,
            "F9e 32 inputs merge into one active instance run",
          );
          const activeA = row("SELECT * FROM agent_run WHERE id=?", actorA.runId);
          assert.throws(
            () =>
              sqlite
                .prepare(
                  "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,session_id) VALUES (?,?,?,?,?,'queued',?)",
                )
                .run(
                  "run_" + randomUUID(),
                  activeA.instance_id,
                  activeA.chat_id,
                  activeA.project_id,
                  req(),
                  activeA.session_id,
                ),
            (error: any) => error.code === "SQLITE_CONSTRAINT_UNIQUE",
            "F9e second in-flight run for same instance is explicitly rejected",
          );
          assert.equal(
            row(
              "SELECT COUNT(*) n FROM agent_run WHERE instance_id=? AND status IN ('queued','running')",
              actorA.instanceId,
            ).n,
            1,
          );
          // Fan-out is one run per named Agent; the same fan-out repeated eight times must not
          // duplicate runs, only inputs.
          const groupRunsBefore = row(
            "SELECT COUNT(*) n FROM agent_run WHERE chat_id=?",
            group.id,
          ).n;
          const groupInputsBefore = row(
            "SELECT COUNT(*) n FROM agent_run_input x JOIN agent_run r ON r.id=x.run_id WHERE r.chat_id=?",
            group.id,
          ).n;
          for (let index = 0; index < 8; index++)
            send(group.id, `P7 fanout repeat ${index} ${profileA.name} ${profileB.name}`);
          assert.equal(
            row("SELECT COUNT(*) n FROM agent_run WHERE chat_id=?", group.id).n,
            groupRunsBefore,
            "F9e repeated fan-out never opens extra runs",
          );
          assert.equal(
            row(
              "SELECT COUNT(*) n FROM agent_run_input x JOIN agent_run r ON r.id=x.run_id WHERE r.chat_id=?",
              group.id,
            ).n,
            groupInputsBefore + 16,
            "F9e eight fan-outs land once per named Agent",
          );
          pass("F9e measured instance admission and fan-out bounds", {
            activeRunsPerInstance: 1,
            simultaneousDomainRuns: 4,
            appendedInputs: 32,
            overflow: "SQLITE_CONSTRAINT_UNIQUE",
            fanoutPerMessage: 2,
            fanoutMessages: 8,
            fanoutInputs: 16,
            machine: {
              hostname: hostname(),
              platform: process.platform,
              arch: process.arch,
              cpu: cpus()[0]?.model,
              logicalCpus: cpus().length,
              ramBytes: totalmem(),
            },
            limitation:
              "no global Agent-count or fan-out cap exists in the product; the measured bound is one in-flight run per instance plus the message body limit enforced at the HTTP boundary (p7-loop-multiround)",
          });

          // F4b: from idle the automation itself opens a run; a human message then fills that run
          // instead of a second one, and `off` stops new automation runs.
          const automation = await import("../../src/domain/chat-automation");
          const schedule = await import("../../src/domain/chat-schedule");
          const delivery = await import("../../src/domain/continuation-delivery");
          const { createAutomationScheduler } =
            await import("../../src/server/automation-scheduler");
          const task = await import("../../src/domain/task");
          const dmAuto = chats.createDirectChat(project.id, profileC.id, ctx).chat;
          schedule.controlFor(dmAuto.id);
          const autoTask = task.createTask(
            { projectId: project.id, title: "P7 autonomous continuation" },
            ctx,
          ).detail;
          task.assignTask(
            {
              taskId: autoTask.task.id,
              expectedRevision: autoTask.task.revision,
              targetChatId: dmAuto.id,
            },
            ctx,
          );
          let clockNow = new Date(
            row("SELECT next_due_at FROM chat_schedule WHERE chat_id=?", dmAuto.id).next_due_at,
          );
          const wake = async (input: any) => ({
            decision: "continue" as const,
            reason: "fixture: the owner has a next step",
            reasonCode: "fixture_continue" as const,
            recipients: input.candidates.map((candidate: any) => ({
              recipient: candidate.recipient,
              decision: "yes" as const,
              reason: "current owner",
              probability: null,
            })),
            selectedRecipients: input.candidates.map((candidate: any) => candidate.recipient),
            probability: null,
            provider: input.policy.provider,
            model: input.policy.model,
            version: input.policy.thresholdVersion,
            snapshotHash: input.snapshotHash,
            errorCode: null,
          });
          const scheduler = createAutomationScheduler({
            clock: { now: () => clockNow, setTimeout: () => 0, clearTimeout: () => {} },
            evaluateWake: wake,
          });
          const runsBeforeAuto = row(
            "SELECT COUNT(*) n FROM agent_run WHERE chat_id=?",
            dmAuto.id,
          ).n;
          assert.equal(
            runsBeforeAuto,
            0,
            "F4b the Chat starts idle: no run before the automatic check",
          );
          scheduler.start();
          await scheduler.advance();
          await scheduler.settled();
          const autoRun = row(
            "SELECT * FROM agent_run WHERE chat_id=? ORDER BY rowid DESC LIMIT 1",
            dmAuto.id,
          );
          assert(autoRun, "F4b an idle Chat produces a new run from the automatic continuation");
          assert.equal(
            runsBeforeAuto + 1,
            row("SELECT COUNT(*) n FROM agent_run WHERE chat_id=?", dmAuto.id).n,
            "F4b automatic continuation opens exactly one run",
          );
          assert.equal(
            row("SELECT COUNT(*) n FROM agent_run_input WHERE run_id=?", autoRun.id).n,
            0,
            "F4b the automatic run exists before any human input",
          );
          const autoDelivery = row(
            "SELECT * FROM continuation_delivery WHERE chat_id=? ORDER BY created_at DESC LIMIT 1",
            dmAuto.id,
          );
          assert.equal(autoDelivery.state, "bound");
          assert.equal(
            autoDelivery.run_id,
            autoRun.id,
            "F4b the automatic delivery is bound to the run it opened",
          );
          const humanInAuto = send(dmAuto.id, "P7 human insert while idle automation runs");
          assert.equal(
            row("SELECT COUNT(*) n FROM agent_run WHERE chat_id=?", dmAuto.id).n,
            runsBeforeAuto + 1,
            "F4b a human message never duplicates the automatic run",
          );
          assert.equal(
            row("SELECT run_id FROM agent_run_input WHERE message_id=?", humanInAuto.id).run_id,
            autoRun.id,
            "F4b the human message fills the automatic run instead of racing it",
          );
          const autoActor = running(dmAuto.id, profileC);
          const pendingAuto = delivery.pendingContinuations(autoRun.id);
          assert.equal(
            pendingAuto.length,
            1,
            "F4b one bound continuation is pending for the running run",
          );
          const delivered: any[] = [];
          const admittedAt = new Date();
          delivery.admitContinuation(autoDelivery.id, autoRun.id, admittedAt, (envelope: any) =>
            delivered.push(envelope),
          );
          assert.equal(delivered.length, 1, "F4b the automatic instruction is admitted once");
          assert.equal(delivered[0].deliveryId, autoDelivery.id);
          assert.equal(
            delivery.admitContinuation(autoDelivery.id, autoRun.id, admittedAt, (envelope: any) =>
              delivered.push(envelope),
            ),
            undefined,
            "F4b admission is idempotent",
          );
          assert.equal(delivered.length, 1);
          assert.equal(
            row("SELECT state FROM continuation_delivery WHERE id=?", autoDelivery.id).state,
            "admitted",
          );
          assert(autoActor.runId === autoRun.id);
          // Human `off` removes the schedule: no further automatic run may appear.
          const automationView: any = automation.getChatAutomation(project.id, dmAuto.id, ctx);
          automation.applyChatAutomationCommand(
            {
              projectId: project.id,
              chatId: dmAuto.id,
              action: "disable",
              expectedRevision: automationView.view.revision,
              requestId: req(),
              reason: "P7 human pause",
            },
            ctx,
            new Date(),
          );
          assert.equal(
            row("SELECT COUNT(*) n FROM chat_schedule WHERE chat_id=?", dmAuto.id).n,
            0,
            "F4b human pause removes the automatic schedule",
          );
          const evaluationsBefore = row(
            "SELECT COUNT(*) n FROM wake_evaluation WHERE chat_id=?",
            dmAuto.id,
          ).n;
          const runsAfterAuto = row(
            "SELECT COUNT(*) n FROM agent_run WHERE chat_id=?",
            dmAuto.id,
          ).n;
          clockNow = new Date(clockNow.getTime() + schedule.INTERVAL_MS * 2);
          await scheduler.advance();
          await scheduler.settled();
          scheduler.stop();
          assert.equal(
            row("SELECT COUNT(*) n FROM wake_evaluation WHERE chat_id=?", dmAuto.id).n,
            evaluationsBefore,
            "F4b a paused Chat is never checked again",
          );
          assert.equal(
            row("SELECT COUNT(*) n FROM agent_run WHERE chat_id=?", dmAuto.id).n,
            runsAfterAuto,
            "F4b automation never races a human pause",
          );
          // F4c stop: a settled run cannot be stopped twice; the refusal is an explicit conflict
          // rather than a silent no-op that would look like a successful stop.
          const stopChat = chats.createDirectChat(project.id, profileB.id, ctx).chat;
          const stopActor = running(stopChat.id, profileB);
          assert.equal(runs.abortAgentRun(stopActor.runId, ctx).status, "aborted");
          assert.throws(
            () => runs.abortAgentRun(stopActor.runId, ctx),
            fails("conflict"),
            "F4c stopping a settled run fails explicitly",
          );
          assert.equal(
            row("SELECT status FROM agent_run WHERE id=?", stopActor.runId).status,
            "aborted",
          );
          assert.equal(
            row("SELECT assistant_message_id FROM agent_run WHERE id=?", stopActor.runId)
              .assistant_message_id,
            null,
            "F4c a stopped run never gains a reply",
          );
          pass("F4c stop refusal on an already settled run", {
            runId: stopActor.runId,
            code: "conflict",
          });
          pass("F4b idle automatic continuation and human insertion", {
            chatId: dmAuto.id,
            automatedRun: autoRun.id,
            delivery: autoDelivery.id,
            humanInput: humanInAuto.id,
            pause: "chat_schedule removed, zero further evaluations",
          });
        }
      }
    }
  } finally {
    writeFileSync(
      join(evidence, `${mode}-${phase ?? "main"}-evidence.json`),
      JSON.stringify({ observations }, null, 2),
    );
    await runtime.shutdownRuntime("p7-loop-domain-complete");
    sqlite.close();
  }
}
