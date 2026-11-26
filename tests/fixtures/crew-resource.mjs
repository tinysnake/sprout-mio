import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/**
 * Live gates grant a Crew lead its machine authority through the real coordinator: the
 * fixture submits the lead's own `lead_run` request, approves it as that lead instance and
 * advances the queue, so the lease and grant rows are produced by src/domain/crew-resource.ts
 * instead of hand-written rows.
 */
export function provisionCrewResource(database, input) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import { sqlite } from "./src/db/index.ts";
      import {
        requestCrewResource,
        approveCrewResource,
        advanceCrewResources,
      } from "./src/domain/crew-resource.ts";
      const input = JSON.parse(process.env.CREW_RESOURCE_INPUT);
      const chat = sqlite
        .prepare("SELECT id, project_id, crew_epoch, lead_profile_id FROM chat WHERE id=?")
        .get(input.crewChatId);
      if (!chat) throw new Error("crew chat missing");
      const run = sqlite
        .prepare(
          "SELECT r.id, r.instance_id FROM agent_run r JOIN agent_instance i ON i.id=r.instance_id WHERE r.chat_id=? AND i.agent_profile_id=? AND r.status IN ('queued','running') ORDER BY r.queued_at DESC, r.rowid DESC LIMIT 1",
        )
        .get(chat.id, chat.lead_profile_id);
      if (!run) throw new Error("running lead run missing");
      const membership = sqlite
        .prepare(
          "SELECT epoch FROM project_machine_membership WHERE project_id=? AND machine_id=? AND state='active' ORDER BY epoch DESC LIMIT 1",
        )
        .get(chat.project_id, input.machineId);
      if (!membership) throw new Error("machine membership missing");
      const machine = sqlite
        .prepare("SELECT root_revision FROM machine WHERE id=?")
        .get(input.machineId);
      const connection = sqlite
        .prepare(
          "SELECT generation FROM machine_connection WHERE machine_id=? ORDER BY generation DESC LIMIT 1",
        )
        .get(input.machineId);
      if (!machine || !connection) throw new Error("machine connection missing");
      const observation = sqlite
        .prepare(
          "SELECT real_path FROM directory_observation WHERE machine_id=? AND project_id=? AND generation=? AND revision=? AND kind='accessible'",
        )
        .get(input.machineId, chat.project_id, connection.generation, machine.root_revision);
      if (!observation) throw new Error("directory observation missing");
      const actor = {
        projectId: chat.project_id,
        instanceId: run.instance_id,
        runId: run.id,
      };
      const requested = requestCrewResource(
        {
          crewChatId: chat.id,
          crewEpoch: chat.crew_epoch,
          subjectKind: "lead_run",
          runId: run.id,
          clientRequestId: input.clientRequestId ?? "harness:lead-run",
          machineId: input.machineId,
          membershipEpoch: membership.epoch,
          directoryRealPath: observation.real_path,
          directoryRevision: machine.root_revision,
          operations: input.operations,
        },
        actor,
      );
      approveCrewResource(
        { resourceRequestId: requested.id, crewEpoch: chat.crew_epoch, expectedRevision: 0 },
        actor,
      );
      advanceCrewResources();
      const current = sqlite
        .prepare(
          "SELECT id, state, approval, generation, grant_id FROM crew_resource_request WHERE id=?",
        )
        .get(requested.id);
      console.log(
        JSON.stringify({
          id: current.id,
          state: current.state,
          approval: current.approval,
          generation: current.generation,
          grantId: current.grant_id,
          runId: run.id,
          instanceId: run.instance_id,
        }),
      );
      sqlite.close();
    `,
    ],
    {
      env: { ...process.env, DATABASE_URL: database, CREW_RESOURCE_INPUT: JSON.stringify(input) },
      encoding: "utf8",
      timeout: 60000,
    },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
