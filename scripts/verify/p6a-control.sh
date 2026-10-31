#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export P6A_EVIDENCE_DIR="${P6A_EVIDENCE_DIR:-$PWD/.verify/p6a-control}"
mkdir -p "$P6A_EVIDENCE_DIR"
export DATABASE_URL="$P6A_EVIDENCE_DIR/control-model.sqlite"
rm -f "$DATABASE_URL" "$DATABASE_URL-wal" "$DATABASE_URL-shm" "$P6A_EVIDENCE_DIR/control-model-result.json"
node --import tsx --input-type=module <<'CONTROL_MODEL'
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString("hex");
const { migrateDatabase } = await import("./src/db/migrate.ts");
const { openDatabase } = await import("./src/db/connection.ts");
const evidence = process.env.P6A_EVIDENCE_DIR;
const assertions = [];
function prove(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  assertions.push(label);
}

// Use the real migrator and its journal, with populated 0026 data rather than a fresh table.
const migrationDirectory = mkdtempSync(join(tmpdir(), "p6a-upgrade-0026-"));
let modeDistribution;
try {
  const oldFolder = join(migrationDirectory, "old-drizzle");
  mkdirSync(join(oldFolder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((entry) => entry.idx <= 26);
  for (const entry of journal.entries)
    copyFileSync(join("drizzle", `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`));
  writeFileSync(join(oldFolder, "meta/_journal.json"), JSON.stringify(journal));
  const file = join(migrationDirectory, "upgrade.sqlite");
  migrateDatabase(file, oldFolder);
  const before = openDatabase(file);
  before.sqlite.exec(`
    INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('usr_upgrade','Upgrade','upgrade@p6a.test',0,1,1);
    INSERT INTO project(id,name,created_by) VALUES('prj_upgrade','Upgrade','usr_upgrade');
    INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES
      ('cht_enabled','prj_upgrade','group','human','usr_upgrade','usr_upgrade'),
      ('cht_paused','prj_upgrade','group','human','usr_upgrade','usr_upgrade'),
      ('cht_stopped','prj_upgrade','group','human','usr_upgrade','usr_upgrade');
    INSERT INTO chat_automation_control(chat_id,mode,epoch,revision,changed_by,changed_at,reason) VALUES
      ('cht_enabled','enabled',2,3,'usr_upgrade',1000,'enabled audit'),
      ('cht_paused','paused',4,5,'usr_upgrade',2000,'paused audit'),
      ('cht_stopped','stopped',6,7,'usr_upgrade',3000,'stopped audit');
  `);
  const original = before.sqlite.prepare("SELECT * FROM chat_automation_control ORDER BY chat_id").all();
  const distributionBefore = before.sqlite.prepare("SELECT mode,count(*) AS n FROM chat_automation_control GROUP BY mode ORDER BY mode").all();
  before.sqlite.close();
  migrateDatabase(file);
  migrateDatabase(file);
  const after = openDatabase(file);
  try {
    prove("0026 populated upgrade maps paused/stopped to off and preserves epoch/revision/audit", after.sqlite.prepare("SELECT * FROM chat_automation_control ORDER BY chat_id").all(), original.map((row) => ({ ...row, mode: row.mode === "enabled" ? "enabled" : "off" })));
    for (const mode of ["paused", "stopped"])
      assert.throws(() => after.sqlite.prepare("UPDATE chat_automation_control SET mode=? WHERE chat_id='cht_enabled'").run(mode), /CHECK/);
    prove("upgraded database retains foreign keys", after.sqlite.pragma("foreign_keys", { simple: true }), 1);
    prove("upgrade has no FK violations", after.sqlite.pragma("foreign_key_check"), []);
    prove("upgrade integrity", after.sqlite.pragma("integrity_check", { simple: true }), "ok");
    modeDistribution = { before: distributionBefore, after: after.sqlite.prepare("SELECT mode,count(*) AS n FROM chat_automation_control GROUP BY mode ORDER BY mode").all() };
  } finally {
    after.sqlite.close();
  }
} finally {
  rmSync(migrationDirectory, { recursive: true, force: true });
}

migrateDatabase();
const { sqlite } = await import("./src/db/index.ts");
try {
  const { newId, ID_PREFIXES } = await import("./src/contracts/ids.ts");
  const { createProject, updateProjectWakePolicy } = await import("./src/domain/project.ts");
  const { createAgentProfile, addProjectMember } = await import("./src/domain/agent.ts");
  const { createGroupChat } = await import("./src/domain/chat.ts");
  const task = await import("./src/domain/task.ts");
  const schedule = await import("./src/domain/chat-schedule.ts");
  const delivery = await import("./src/domain/continuation-delivery.ts");
  const automation = await import("./src/domain/chat-automation.ts");
  const ctx = { userId: "usr_control_model", requestId: newId(ID_PREFIXES.request) };
  sqlite.prepare("INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,0,1,1)").run(ctx.userId, "Control Model", "control-model@p6a.test");
  const project = createProject({ name: "Control model regression" }, ctx);
  const profiles = ["Alpha", "Beta"].map((name) => {
    const profile = createAgentProfile({ name, persona: "执行任务", harness: "pi" }, ctx);
    addProjectMember(project.id, profile.id, ctx);
    return profile;
  });
  updateProjectWakePolicy({ projectId: project.id, provider: "small_brain", expectedConfigRevision: 1, requestId: newId(ID_PREFIXES.request) }, ctx, { model: "fixture", thresholdVersion: "fixture-v1" }, new Date());
  const command = (chatId, action, runId) => automation.applyChatAutomationCommand({ projectId: project.id, chatId, action, ...(runId === undefined ? {} : { runId }), expectedRevision: schedule.controlFor(chatId).revision, requestId: newId(ID_PREFIXES.request) }, ctx, new Date());
  const state = (runId) => schedule.one("SELECT status FROM agent_run WHERE id=?", runId).status;
  function group() {
    return createGroupChat(project.id, { projectId: project.id, title: "Control test", wakePolicy: "owner_led", members: [{ kind: "human", id: ctx.userId }, ...profiles.map((p) => ({ kind: "agent", id: p.id }))], initialOwner: { kind: "agent", id: profiles[0].id } }, { kind: "human", userId: ctx.userId, ctx });
  }
  function assign(chatId) {
    const created = task.createTask({ projectId: project.id, title: "Continue" }, ctx).detail;
    task.assignTask({ taskId: created.task.id, expectedRevision: created.task.revision, targetChatId: chatId }, ctx);
  }
  function queued(chatId, profile) {
    let instance = schedule.one("SELECT id FROM agent_instance WHERE chat_id=? AND agent_profile_id=?", chatId, profile.id);
    if (!instance) {
      const instanceId = newId(ID_PREFIXES.instance);
      schedule.write("INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES(?,?,?,?)", instanceId, profile.id, chatId, project.id);
      instance = { id: instanceId };
    }
    const id = newId(ID_PREFIXES.run);
    schedule.write("INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,session_id) VALUES(?,?,?,?,?,'queued',?)", id, instance.id, chatId, project.id, newId(ID_PREFIXES.request), instance.id);
    return id;
  }
  async function pendingDelivery(chatId) {
    const now = new Date(schedule.one("SELECT next_due_at FROM chat_schedule WHERE chat_id=?", chatId).next_due_at);
    const internal = { now, workerId: "control-model", requestId: newId(ID_PREFIXES.request) };
    const evaluation = schedule.claimDueEvaluation(internal);
    assert.equal(evaluation.chat_id, chatId);
    await delivery.evaluateClaim(evaluation, async (input) => ({ decision: "continue", reason: "继续任务", reasonCode: "control_test", recipients: input.candidates.map((c) => ({ recipient: c.recipient, decision: "yes", reason: "负责人", probability: null })), selectedRecipients: input.candidates.map((c) => c.recipient), probability: null, provider: input.policy.provider, model: input.policy.model, version: input.policy.thresholdVersion, snapshotHash: input.snapshotHash, errorCode: null }), internal);
    return schedule.one("SELECT * FROM continuation_delivery WHERE chat_id=? ORDER BY created_at DESC LIMIT 1", chatId);
  }
  const chat = group();
  assign(chat.id);
  const run = queued(chat.id, profiles[0]);
  const epoch = schedule.controlFor(chat.id).epoch;
  command(chat.id, "disable");
  prove("disable leaves the queued run active and increments the epoch", [state(run), schedule.controlFor(chat.id).mode, schedule.controlFor(chat.id).epoch], ["queued", "off", epoch + 1]);
  command(chat.id, "enable");
  prove("enable preserves the existing run and reschedules its continuation", [state(run), schedule.controlFor(chat.id).mode, !!schedule.one("SELECT 1 FROM chat_schedule WHERE chat_id=? AND next_due_at IS NOT NULL", chat.id)], ["queued", "enabled", true]);
  const otherRun = queued(chat.id, profiles[1]);
  const beforeAbort = schedule.controlFor(chat.id);
  command(chat.id, "abort", run);
  prove("abort with runId aborts only one run and leaves mode/epoch unchanged", [state(run), state(otherRun), schedule.controlFor(chat.id).mode, schedule.controlFor(chat.id).epoch], ["aborted", "queued", "enabled", beforeAbort.epoch]);
  for (const invalid of [run, queued(group().id, profiles[0])]) {
    const beforeInvalid = schedule.controlFor(chat.id);
    assert.throws(() => command(chat.id, "abort", invalid), (error) => error.code === "not_found");
    prove("terminal/other-Chat run rejection preserves the control", schedule.controlFor(chat.id), beforeInvalid);
  }
  const pending = await pendingDelivery(chat.id);
  assert.equal(pending.state, "pending");
  const beforeAll = schedule.controlFor(chat.id);
  command(chat.id, "abort");
  prove("abort without runId turns mode off, increments epoch, aborts all Chat runs and records human_aborted", [schedule.controlFor(chat.id).mode, schedule.controlFor(chat.id).epoch, schedule.all("SELECT status FROM agent_run WHERE chat_id=? ORDER BY id", chat.id).map((r) => r.status), schedule.one("SELECT state,cancel_reason FROM continuation_delivery WHERE id=?", pending.id)], ["off", beforeAll.epoch + 1, ["aborted", "aborted"], { state: "canceled", cancel_reason: "human_aborted" }]);
  const retained = schedule.one("SELECT id,status FROM agent_run WHERE chat_id<>?", chat.id);
  prove("abort all does not abort another Chat", retained.status, "queued");
  const result = { assertions, modeDistribution };
  writeFileSync(join(evidence, "control-model-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  sqlite.close();
}
CONTROL_MODEL
export DATABASE_URL="$P6A_EVIDENCE_DIR/verification.sqlite"
rm -f "$DATABASE_URL" "$DATABASE_URL-wal" "$DATABASE_URL-shm" "$P6A_EVIDENCE_DIR/control-result.json"
node --import tsx tests/fixtures/p6a-schedule.ts control
