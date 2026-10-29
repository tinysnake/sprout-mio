import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { RemoteReport } from "../../src/contracts/remote";
import { sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import {
  createMachine,
  getMachine,
  saveMachineRootDirectory,
  saveProjectMachineBinding,
} from "../../src/domain/machine";
import { acquireLease, type AgentRemoteContext } from "../../src/server/lease";
import { detachMachine, rejoinProjectMachine } from "../../src/server/membership";
import {
  getExecution,
  listProjectExecutions,
  readExecutionLog,
  requestExecution,
} from "../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { config } from "../../src/lib/config";
import { issueRemoteToolGrant, remoteAgentResponse } from "../../src/server/remote-agent-gateway";
import { runtimeSnapshot, startRuntime, shutdownRuntime } from "../../src/server/runtime";
import { seedRemoteActor } from "./remote-actors";

migrateDatabase();
await startRuntime();
const id = () => newId(ID_PREFIXES.request);
const projectId = newId(ID_PREFIXES.project);
const bootId = runtimeSnapshot().bootId!;
const now = () => new Date();
const human = () => ({ userId: "acceptance-owner", bootId, now: now(), requestId: id() });
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('acceptance-owner','Acceptance','acceptance@example.test',0,1,1)",
  )
  .run();
sqlite
  .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Acceptance','acceptance-owner')")
  .run(projectId);
let failures = 0;
function checkCode(label: string, expected: string, call: () => unknown) {
  let actual = "returned_success";
  try {
    call();
  } catch (error) {
    actual = String((error as { code?: string }).code ?? error);
  }
  console.log(JSON.stringify({ label, expected, actual, pass: actual === expected }));
  if (actual !== expected) failures++;
}
function setup() {
  const actor = seedRemoteActor(sqlite, "acceptance-owner", projectId, bootId, false);
  const grant = issueRemoteToolGrant(actor.runId, { pid: process.pid } as never, human());
  actor.grantId = (
    sqlite.prepare("SELECT id FROM remote_tool_grant WHERE run_id=?").get(actor.runId) as {
      id: string;
    }
  ).id;
  const created = createMachine({ name: "Acceptance" }, human());
  const machineId = created.detail.machine.id;
  const root = saveMachineRootDirectory(
    { machineId, expectedRevision: created.detail.machine.rootRevision, directory: "/tmp" },
    human(),
  );
  saveProjectMachineBinding(
    {
      projectId,
      machineId,
      expectedRevision: null,
      description: "",
    },
    human(),
  );
  const key = { projectId, machineId };
  acquireLease({ ...key, action: "acquire", requestId: id(), expectedGeneration: 0 }, actor);
  const secret = randomBytes(32).toString("base64url");
  const wire = { version: 3 as const, requestId: id(), machineId, secret };
  enrollWorker({ ...wire, ticket: created.ticket }, human());
  const session = openWorker({ ...wire, attemptId: randomUUID() }, human()).session;
  let seq = 0;
  const exchange = (results: RemoteReport[] = [], observe = false) => {
    const next = seq + 1;
    const output = exchangeWorker(
      {
        version: 3,
        requestId: id(),
        secret,
        session,
        seq: next,
        mode: "normal",
        capability: {
          platform: "darwin",
          arch: "arm64",
          workerVersion: "acceptance",
          shells: [],
          remoteOperations: ["file_write", "file_read"],
        },
        observations: observe
          ? [
              {
                machineId,
                generation: session.generation,
                projectId,
                revision: root.revision,
                seq: next,
                checkedAt: now().toISOString(),
                result: { kind: "accessible", realPath: "/tmp" },
              },
            ]
          : [],
        remote: { results, fenceAcks: [], mcp: [], mcpCursors: [] },
      },
      human(),
    );
    seq = next;
    return output;
  };
  exchange();
  const execution = requestExecution(
    {
      ...key,
      requestId: id(),
      authorizationGeneration: 1,
      operation: {
        kind: "file_write",
        path: "/tmp/acceptance-marker",
        content: "fixture",
        mode: "overwrite",
      },
    },
    actor,
  );
  const dispatched = exchange();
  assert.equal(dispatched.remote.commands[0]?.executionId, execution.executionId);
  return { key, actor, execution, grant, exchange, command: dispatched.remote.commands[0]! };
}
const { key, actor, execution, grant, exchange } = setup();
exchange([], true);
assert.equal(
  getMachine({ machineId: key.machineId, projectId }, human()).bindings[0]?.observation?.current,
  true,
);
const readKey = { ...key, executionId: execution.executionId };
const actorNow = (): AgentRemoteContext => ({ ...actor, now: now(), requestId: id() });
assert.equal(getExecution(readKey, actorNow()).state, "dispatched");
const receipt = detachMachine(
  {
    ...key,
    requestId: id(),
    expectedEpoch: 1,
    expectedRevision: 1,
    expectedGeneration: 1,
    confirm: true,
  },
  human(),
);
assert.equal(receipt.state, "detaching");
for (const state of ["detaching", "removed"] as const) {
  if (state === "removed") {
    const { forceReclaimLease } = await import("../../src/server/lease");
    forceReclaimLease(
      {
        ...key,
        action: "force_reclaim",
        mutationId: receipt.removalMutationId!,
        expectedGeneration: 1,
        confirm: true,
      },
      human(),
    );
  }
  checkCode(`${state}: execution_get`, "lease_not_holder", () => getExecution(readKey, actorNow()));
  checkCode(`${state}: execution_list`, "lease_not_holder", () =>
    listProjectExecutions(key, actorNow()),
  );
  checkCode(`${state}: execution_log_read`, "lease_not_holder", () =>
    readExecutionLog({ ...readKey, cursor: null, limitBytes: 65536 }, actorNow()),
  );
  for (const [type, input] of [
    ["execution_get", readKey],
    ["execution_list", { ...key, limit: 20 }],
    ["execution_log_read", { ...readKey, cursor: null, limitBytes: 65536 }],
  ] as const) {
    const response = await remoteAgentResponse(
      new Request(new URL("/api/remote/agent", config.APP_ORIGIN), {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.secret}`,
          "content-type": "application/json",
          "x-sprout-request-id": id(),
        },
        body: JSON.stringify({ version: 2, call: { type, input } }),
      }),
    );
    const body = (await response.json()) as { error?: { code: string } };
    console.log(
      JSON.stringify({
        label: `${state}: HTTP ${type}`,
        expected: "lease_not_holder",
        actual: body.error?.code,
        status: response.status,
        pass: body.error?.code === "lease_not_holder",
      }),
    );
    if (body.error?.code !== "lease_not_holder") failures++;
  }
  if (state === "detaching") {
    const beforeObservation = sqlite
      .prepare("SELECT seq FROM directory_observation WHERE machine_id=? AND project_id=?")
      .get(key.machineId, projectId) as { seq: number };
    try {
      exchange([], true);
    } catch (error) {
      console.log(
        JSON.stringify({
          label: "directory observation refusal",
          code: (error as { code?: string }).code,
        }),
      );
    }
    const afterObservation = sqlite
      .prepare("SELECT seq FROM directory_observation WHERE machine_id=? AND project_id=?")
      .get(key.machineId, projectId) as { seq: number };
    const accepted = afterObservation.seq > beforeObservation.seq;
    console.log(
      JSON.stringify({
        label: "directory observation during detaching",
        expectedAccepted: false,
        actualAccepted: accepted,
        beforeSeq: beforeObservation.seq,
        afterSeq: afterObservation.seq,
      }),
    );
    if (accepted) failures++;
  }
  assert.equal(
    getExecution(readKey, human()).executionId,
    execution.executionId,
    "Human history remains readable",
  );
}
const rejoined = rejoinProjectMachine(
  { ...key, requestId: id(), expectedEpoch: 1, expectedRevision: 1, confirm: true },
  human(),
);
assert.equal(rejoined.epoch, 2);
const bindingAfterRejoin = getMachine({ machineId: key.machineId, projectId }, human())
  .bindings[0]!;
assert.equal(bindingAfterRejoin.intent.revision, 2);
console.log(
  JSON.stringify({
    label: "pre-rejoin observation after binding revision changes",
    expectedCurrent: false,
    actualCurrent: bindingAfterRejoin.observation?.current,
    bindingRevision: bindingAfterRejoin.intent.revision,
    observationRootRevision: bindingAfterRejoin.observation?.fact.revision,
  }),
);
if (bindingAfterRejoin.observation?.current) failures++;
const unproven = setup();
const originalFrame = sqlite
  .prepare(
    "SELECT response_json FROM worker_exchange_frame WHERE machine_id=? AND connection_generation=? AND seq=?",
  )
  .get(
    unproven.key.machineId,
    unproven.command.dispatchSession.generation,
    unproven.command.dispatchSeq,
  ) as { response_json: string };
sqlite
  .prepare(
    "UPDATE worker_exchange_frame SET response_json=json_set(response_json,'$.remote.commands',json('[]')) WHERE machine_id=? AND connection_generation=? AND seq=?",
  )
  .run(
    unproven.key.machineId,
    unproven.command.dispatchSession.generation,
    unproven.command.dispatchSeq,
  );
const report: RemoteReport = {
  executionId: unproven.command.executionId,
  projectId: unproven.command.projectId,
  machineId: unproven.command.machineId,
  authorizationGeneration: unproven.command.authorizationGeneration,
  holderInstanceId: unproven.command.holderInstanceId,
  fingerprint: unproven.command.fingerprint,
  dispatchSession: unproven.command.dispatchSession,
  dispatchSeq: unproven.command.dispatchSeq,
  phase: "terminal",
  drained: true,
  outcome: "succeeded",
  payload: { kind: "file_write", bytesWritten: 7 },
};
let ack: unknown;
checkCode("terminal report without frame command proof", "not_found", () => {
  ack = unproven.exchange([report]).remote.resultAcks;
});
const afterUnproven = sqlite
  .prepare("SELECT state,failure_reason FROM remote_execution WHERE id=?")
  .get(unproven.execution.executionId);
console.log(
  JSON.stringify({
    label: "unproven terminal side effects",
    resultAcks: ack,
    execution: afterUnproven,
  }),
);
sqlite
  .prepare(
    "UPDATE worker_exchange_frame SET response_json=? WHERE machine_id=? AND connection_generation=? AND seq=?",
  )
  .run(
    originalFrame.response_json,
    unproven.key.machineId,
    unproven.command.dispatchSession.generation,
    unproven.command.dispatchSeq,
  );
unproven.exchange([report]);
console.log(
  JSON.stringify({
    label: "restored proof cannot repair forged terminal",
    state: getExecution({ ...unproven.key, executionId: unproven.execution.executionId }, human())
      .state,
  }),
);
assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
await shutdownRuntime("acceptance-complete");
sqlite.close();
process.exitCode = failures > 0 ? 1 : 0;
