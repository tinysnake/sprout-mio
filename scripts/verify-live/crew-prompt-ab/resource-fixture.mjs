import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { sqlite } = await import(pathToFileURL(resolve("src/db/index.ts")).href);
const { requestCrewResource, approveCrewResource, advanceCrewResources } = await import(
  pathToFileURL(resolve("src/domain/crew-resource.ts")).href
);

const { chatId, projectId, scope } = JSON.parse(
  readFileSync(process.env.AB_RESOURCE_FIXTURE, "utf8"),
);
const leadRun = sqlite.prepare(
  "SELECT r.id, r.instance_id FROM agent_run r JOIN agent_instance i ON i.id=r.instance_id JOIN chat c ON c.id=r.chat_id WHERE r.chat_id=? AND r.status='running' AND i.agent_profile_id=c.lead_profile_id ORDER BY r.rowid DESC LIMIT 1",
);
const workers = sqlite.prepare(
  "SELECT d.id, d.attempt, d.crew_epoch, r.id AS run_id FROM delegation d JOIN agent_run r ON r.chat_id=d.child_chat_id WHERE d.parent_crew_chat_id=? AND d.status='running' AND r.status IN ('queued','running') AND NOT EXISTS (SELECT 1 FROM crew_resource_request cr WHERE cr.run_id=r.id AND cr.machine_id=?)",
);
const approveWorkers = sqlite.transaction(() => {
  const lead = leadRun.get(chatId);
  if (!lead) return;
  for (const worker of workers.all(chatId, scope.machineId)) {
    const actor = { projectId, instanceId: lead.instance_id, runId: lead.id };
    const request = requestCrewResource(
      {
        ...scope,
        crewChatId: chatId,
        crewEpoch: worker.crew_epoch,
        subjectKind: "delegation",
        delegationId: worker.id,
        attempt: worker.attempt,
        runId: worker.run_id,
        clientRequestId: `ab-fixture:${worker.run_id}:${scope.machineId}`,
      },
      actor,
    );
    const approved = approveCrewResource(
      {
        resourceRequestId: request.id,
        crewEpoch: request.crewEpoch,
        expectedRevision: request.revision,
      },
      actor,
    );
    advanceCrewResources();
    const allocated = sqlite
      .prepare(
        "SELECT revision, state, generation, grant_id AS grantId, mutation_id AS mutationId FROM crew_resource_request WHERE id=?",
      )
      .get(approved.id);
    console.log(
      JSON.stringify({
        kind: "fixture_resource_approved",
        delegationId: worker.id,
        workerRunId: worker.run_id,
        leadRunId: lead.id,
        resource: { ...approved, ...allocated },
      }),
    );
  }
});
const timer = setInterval(() => {
  try {
    approveWorkers.immediate();
  } catch (error) {
    console.error(JSON.stringify({ kind: "fixture_resource_error", message: error.message }));
    process.exitCode = 1;
    clearInterval(timer);
    sqlite.close();
  }
}, 50);
console.log("AB_RESOURCE_FIXTURE_READY");
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    clearInterval(timer);
    sqlite.close();
    process.exit();
  });
