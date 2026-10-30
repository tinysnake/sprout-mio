import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { newId, ID_PREFIXES } from "../src/contracts/ids";
import {
  detachMachineInputSchema,
  membershipViewSchema,
  pendingFactViewSchema,
  rejoinProjectMachineInputSchema,
} from "../src/contracts/membership";
import {
  membershipCauseId,
  runResourceNoticePayloadSchema,
  runResourceNoticeSchema,
} from "../src/contracts/notice";
import { executionViewSchema } from "../src/contracts/remote";
import { APP_ERROR_CODES } from "../src/contracts/result";

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: { tag: string }[];
};
const migrations = journal.entries.map((entry) => ({
  tag: entry.tag,
  statements: readFileSync(`drizzle/${entry.tag}.sql`, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean),
}));
const membershipMigrationIndex = migrations.findIndex(
  (migration) => migration.tag === "0020_p4d_membership_notices",
);
if (membershipMigrationIndex < 0) throw new Error("journal 缺少 0020_p4d_membership_notices");

const directories: string[] = [];

function temporaryDatabase(name: string): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), "sprout-p4d-"));
  directories.push(directory);
  const sqlite = new Database(join(directory, `${name}.sqlite`));
  sqlite.pragma("journal_mode = WAL");
  return sqlite;
}

function apply(sqlite: Database.Database, index: number): void {
  for (const statement of migrations[index].statements) sqlite.exec(statement);
}

/** 迁移 SQL 自带 PRAGMA foreign_keys=OFF/ON；连接级关闭与生产迁移器一致。 */
function applyRange(sqlite: Database.Database, from: number, to: number): void {
  sqlite.pragma("foreign_keys = OFF");
  for (let index = from; index <= to; index += 1) apply(sqlite, index);
  sqlite.pragma("foreign_keys = ON");
}

function foreignKeyViolations(sqlite: Database.Database): unknown[] {
  return sqlite.pragma("foreign_key_check") as unknown[];
}

function tableSql(sqlite: Database.Database, name: string): string {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(name) as { sql: string } | undefined;
  if (!row) throw new Error(`缺少表 ${name}`);
  return row.sql;
}

function count(sqlite: Database.Database, table: string): number {
  return (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** 0020 之前就存在的每张表的逐行逐列快照：迁移后必须逐列不变（新表另算）。 */
function snapshotTables(sqlite: Database.Database): Record<string, unknown[]> {
  const tables = (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const snapshot: Record<string, unknown[]> = {};
  for (const table of tables)
    snapshot[table] = sqlite.prepare(`SELECT * FROM \`${table}\` ORDER BY rowid`).all();
  return snapshot;
}

const insert = (sqlite: Database.Database, table: string, values: Record<string, unknown>) => {
  const columns = Object.keys(values);
  sqlite
    .prepare(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...Object.values(values));
};

const rejects = (
  sqlite: Database.Database,
  table: string,
  values: Record<string, unknown>,
  pattern: RegExp = /CHECK|NOT NULL|FOREIGN KEY|UNIQUE/,
) => {
  sqlite.exec("SAVEPOINT probe");
  try {
    expect(() => insert(sqlite, table, values)).toThrow(pattern);
  } finally {
    sqlite.exec("ROLLBACK TO probe; RELEASE probe");
  }
};

type Scope = { project: string; machine: string; instance: string; chat: string; run: string };

function seedScope(sqlite: Database.Database, project: string, machine: string): Scope {
  const scope = {
    project,
    machine,
    instance: `ins-${project}`,
    chat: `chat-${project}`,
    run: `run-${project}`,
  };
  insert(sqlite, "project", { id: project, name: project, created_by: "owner" });
  insert(sqlite, "chat", {
    id: scope.chat,
    project_id: project,
    kind: "dm",
    created_by: "owner",
  });
  insert(sqlite, "agent_instance", {
    id: scope.instance,
    agent_profile_id: "profile",
    chat_id: scope.chat,
    project_id: project,
  });
  insert(sqlite, "agent_run", {
    id: scope.run,
    instance_id: scope.instance,
    project_id: project,
    chat_id: scope.chat,
    request_id: `request-${project}`,
    status: "running",
    started_at: 1,
    session_id: `session-${project}`,
  });
  insert(sqlite, "machine", {
    id: machine,
    name: machine,
    created_by: "owner",
    created_at: 1,
    updated_at: 1,
  });
  insert(sqlite, "project_machine", {
    project_id: project,
    machine_id: machine,
    created_by: "owner",
    revision: 1,
    created_at: 100,
    updated_at: 100,
  });
  insert(sqlite, "machine_lease", {
    project_id: project,
    machine_id: machine,
    generation: 1,
    state: "free",
    holder_instance_id: null,
    changed_at: 100,
  });
  insert(sqlite, "lease_authorization", {
    project_id: project,
    machine_id: machine,
    generation: 1,
    holder_instance_id: null,
    state: "free",
    issued_at: 100,
    reason: "initial",
  });
  insert(sqlite, "lease_mutation", {
    id: `lmu-${project}`,
    project_id: project,
    machine_id: machine,
    actor_kind: "human",
    actor_id: "owner",
    request_id: `reclaim-${project}`,
    payload_hash: "a".repeat(64),
    action: "reclaim",
    expected_generation: 1,
    state: "pending",
    created_at: 100,
  });
  return scope;
}

const membershipColumns = {
  requested_by: "owner",
  request_id: "req_detach",
  payload_hash: "b".repeat(64),
  requested_at: 120,
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("P4d membership 与通知数据约束", () => {
  it("空白库迁移后两表存在，remote_execution 保留延迟外键与 scope 索引", () => {
    const sqlite = temporaryDatabase("blank");
    try {
      applyRange(sqlite, 0, migrations.length - 1);
      expect(count(sqlite, "project_machine_membership")).toBe(0);
      expect(count(sqlite, "run_resource_notice")).toBe(0);
      expect(foreignKeyViolations(sqlite)).toEqual([]);
      expect(tableSql(sqlite, "remote_execution")).toMatch(
        /REFERENCES `worker_exchange_frame`[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
      );
      expect(tableSql(sqlite, "remote_execution")).not.toMatch(/custody/);
      expect(tableSql(sqlite, "message")).not.toMatch(/\bsystem\b/);
      const indexes = sqlite
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")
        .all() as { name: string }[];
      expect(indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining([
          "remote_execution_scope_idx",
          "project_machine_membership_one_live_epoch",
          "project_machine_membership_actor_request_unique",
          "run_resource_notice_kind_cause_id_run_id_unique",
          "run_resource_notice_undelivered_idx",
        ]),
      );
    } finally {
      sqlite.close();
    }
  });

  it("含既有绑定与执行的旧库迁移后逐列不变、回填唯一 epoch=1/active、外键干净", () => {
    const sqlite = temporaryDatabase("legacy");
    try {
      applyRange(sqlite, 0, membershipMigrationIndex - 1);
      insert(sqlite, "user", {
        id: "owner",
        name: "Owner",
        email: "p4d-owner@example.test",
        email_verified: 0,
        created_at: 1,
        updated_at: 1,
      });
      insert(sqlite, "agent_profile", { id: "profile", name: "Agent", created_by: "owner" });
      const scope = seedScope(sqlite, "prj_legacy", "mch_legacy");
      // 第二个既有 binding：回填必须对每个 binding 各建一条，且不串号。
      const second = seedScope(sqlite, "prj_legacy_b", "mch_legacy_b");
      insert(sqlite, "runtime_boot", {
        id: "boot",
        started_at: 1,
        phase: "ready",
        pid: 1,
        app_version: "test",
      });
      insert(sqlite, "machine_connection", {
        machine_id: scope.machine,
        generation: 1,
        attempt_id: "attempt",
        boot_id: "boot",
        status: "open",
        opened_at: 1,
        last_seen_at: 1,
        seq: 0,
      });
      // 让既有执行引用一段真实授权：回填后执行行必须逐列不变。
      sqlite
        .prepare(
          "UPDATE machine_lease SET state='held', holder_instance_id=?, changed_at=150 WHERE project_id=? AND machine_id=?",
        )
        .run(scope.instance, scope.project, scope.machine);
      sqlite
        .prepare(
          "UPDATE lease_authorization SET state='active', holder_instance_id=?, issued_at=150 WHERE project_id=? AND machine_id=?",
        )
        .run(scope.instance, scope.project, scope.machine);
      insert(sqlite, "remote_execution", {
        id: "exe_legacy",
        project_id: scope.project,
        machine_id: scope.machine,
        authorization_generation: 1,
        holder_instance_id: scope.instance,
        run_id: scope.run,
        chat_id: scope.chat,
        request_id: "req_legacy",
        payload_hash: "c".repeat(64),
        operation_json: JSON.stringify({ kind: "shell", command: "true" }),
        state: "queued",
        created_at: 200,
        dispatch_deadline_at: 300,
      });
      // 既有的执行日志、执行结果与 MCP 历史都要逐列活过 0020。
      insert(sqlite, "execution_log_frame", {
        execution_id: "exe_legacy",
        sequence: 1,
        project_id: scope.project,
        machine_id: scope.machine,
        authorization_generation: 1,
        holder_instance_id: scope.instance,
        stream: "stdout",
        byte_start: 0,
        byte_end: 4,
        payload_bytes: Buffer.from("true", "utf8"),
        checksum: "d".repeat(64),
        durable_at: 210,
      });
      insert(sqlite, "execution_result", {
        execution_id: "exe_legacy",
        project_id: scope.project,
        machine_id: scope.machine,
        authorization_generation: 1,
        holder_instance_id: scope.instance,
        payload_hash: "e".repeat(64),
        outcome: "succeeded",
        payload_json: JSON.stringify({ kind: "shell", exitCode: 0 }),
        recorded_at: 220,
      });
      insert(sqlite, "mcp_server_registration", {
        id: "mcpr_legacy",
        revision: 1,
        project_id: scope.project,
        machine_id: scope.machine,
        name: "legacy",
        transport: "stdio",
        config_ref: "legacy-ref",
        config_hash: "f".repeat(64),
        config_json: JSON.stringify({ transport: "stdio" }),
        created_at: 230,
      });
      const tablesBefore = snapshotTables(sqlite);
      const executionBefore = sqlite
        .prepare("SELECT * FROM remote_execution WHERE id = 'exe_legacy'")
        .get();
      const bindingBefore = sqlite
        .prepare("SELECT * FROM project_machine WHERE project_id = 'prj_legacy'")
        .get();

      apply(sqlite, membershipMigrationIndex);

      expect(foreignKeyViolations(sqlite)).toEqual([]);
      expect(
        sqlite.prepare("SELECT * FROM remote_execution WHERE id = 'exe_legacy'").get(),
      ).toEqual(executionBefore);
      expect(
        sqlite.prepare("SELECT * FROM project_machine WHERE project_id = 'prj_legacy'").get(),
      ).toEqual(bindingBefore);
      for (const bound of [scope, second])
        expect(
          sqlite
            .prepare(
              "SELECT epoch, state, joined_at FROM project_machine_membership WHERE project_id = ?",
            )
            .all(bound.project),
          bound.project,
        ).toEqual([{ epoch: 1, state: "active", joined_at: 100 }]);
      expect(tableSql(sqlite, "remote_execution")).toMatch(
        /REFERENCES `worker_exchange_frame`[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
      );
      // 0019 前存在的每张表逐行逐列不变；只新增两张表，没有重建或改名。
      const tablesAfter = snapshotTables(sqlite);
      expect(Object.keys(tablesAfter)).toEqual(
        [...Object.keys(tablesBefore), "project_machine_membership", "run_resource_notice"].sort(),
      );
      for (const table of Object.keys(tablesBefore))
        expect({ table, rows: tablesAfter[table] }).toEqual({ table, rows: tablesBefore[table] });
      expect(tableSql(sqlite, "remote_execution")).not.toMatch(/custody|system/i);
    } finally {
      sqlite.close();
    }
  });

  it("拒绝非法 epoch/state、缺 receipt 的 detaching、缺时间或代次的 removed 与 NULL 绕过", () => {
    const sqlite = temporaryDatabase("membership-checks");
    try {
      applyRange(sqlite, 0, migrations.length - 1);
      insert(sqlite, "user", {
        id: "owner",
        name: "Owner",
        email: "p4d-checks@example.test",
        email_verified: 0,
        created_at: 1,
        updated_at: 1,
      });
      insert(sqlite, "agent_profile", { id: "profile", name: "Agent", created_by: "owner" });
      const a = seedScope(sqlite, "prj_a", "mch_a");
      const b = seedScope(sqlite, "prj_b", "mch_b");
      const c = seedScope(sqlite, "prj_c", "mch_c");

      insert(sqlite, "project_machine_membership", {
        project_id: a.project,
        machine_id: a.machine,
        epoch: 1,
        state: "active",
        joined_at: 100,
      });
      insert(sqlite, "project_machine_membership", {
        project_id: b.project,
        machine_id: b.machine,
        epoch: 1,
        state: "detaching",
        joined_at: 100,
        ...membershipColumns,
        request_id: "req_detach_b",
        removal_mutation_id: "lmu-prj_b",
      });
      insert(sqlite, "project_machine_membership", {
        project_id: c.project,
        machine_id: c.machine,
        epoch: 1,
        state: "removed",
        joined_at: 100,
        ...membershipColumns,
        request_id: "req_detach_c",
        removal_mutation_id: "lmu-prj_c",
        removed_at: 130,
        revoked_generation: 1,
      });

      for (const epoch of [0, 9007199254740992])
        rejects(sqlite, "project_machine_membership", {
          project_id: a.project,
          machine_id: a.machine,
          epoch,
          state: "active",
          joined_at: 100,
        });
      rejects(sqlite, "project_machine_membership", {
        project_id: a.project,
        machine_id: a.machine,
        epoch: 2,
        state: "paused",
        joined_at: 100,
      });
      // detaching 缺 receipt。
      rejects(sqlite, "project_machine_membership", {
        project_id: c.project,
        machine_id: c.machine,
        epoch: 2,
        state: "detaching",
        joined_at: 100,
        ...membershipColumns,
        request_id: "req_missing_receipt",
        removal_mutation_id: null,
      });
      // removed 缺时间。
      rejects(sqlite, "project_machine_membership", {
        project_id: a.project,
        machine_id: a.machine,
        epoch: 2,
        state: "removed",
        joined_at: 100,
        ...membershipColumns,
        request_id: "req_missing_time",
        removed_at: null,
        revoked_generation: 1,
      });
      // removed 缺代次。
      rejects(sqlite, "project_machine_membership", {
        project_id: a.project,
        machine_id: a.machine,
        epoch: 2,
        state: "removed",
        joined_at: 100,
        ...membershipColumns,
        request_id: "req_missing_generation",
        removed_at: 130,
        revoked_generation: null,
      });
      // NULL 不能绕过 detaching 参与项检查。
      rejects(sqlite, "project_machine_membership", {
        project_id: a.project,
        machine_id: a.machine,
        epoch: 2,
        state: "detaching",
        joined_at: 100,
        ...membershipColumns,
        request_id: "req_null_requested_at",
        requested_at: null,
        removal_mutation_id: "lmu-prj_a",
      });
      // 同 scope 双 live epoch。
      rejects(sqlite, "project_machine_membership", {
        project_id: a.project,
        machine_id: a.machine,
        epoch: 2,
        state: "detaching",
        joined_at: 100,
        ...membershipColumns,
        request_id: "req_double_live",
        removal_mutation_id: "lmu-prj_a",
      });
      // 同 actor 与 requestId 重复。
      rejects(sqlite, "project_machine_membership", {
        project_id: c.project,
        machine_id: c.machine,
        epoch: 2,
        state: "detaching",
        joined_at: 100,
        ...membershipColumns,
        request_id: "req_detach_b",
        removal_mutation_id: "lmu-prj_c",
      });
      // 正常样本仍然可写。
      insert(sqlite, "project_machine_membership", {
        project_id: c.project,
        machine_id: c.machine,
        epoch: 2,
        state: "active",
        joined_at: 140,
      });
    } finally {
      sqlite.close();
    }
  });

  it("拒绝重复的 cause/run 通知、非法 kind 与倒序投递时间", () => {
    const sqlite = temporaryDatabase("notice-checks");
    try {
      applyRange(sqlite, 0, migrations.length - 1);
      insert(sqlite, "user", {
        id: "owner",
        name: "Owner",
        email: "p4d-notice@example.test",
        email_verified: 0,
        created_at: 1,
        updated_at: 1,
      });
      insert(sqlite, "agent_profile", { id: "profile", name: "Agent", created_by: "owner" });
      const a = seedScope(sqlite, "prj_a", "mch_a");
      const notice = {
        id: "ntc_one",
        project_id: a.project,
        machine_id: a.machine,
        run_id: a.run,
        instance_id: a.instance,
        chat_id: a.chat,
        kind: "lease_released",
        cause_id: "lmu-prj_a",
        payload_json: JSON.stringify({
          kind: "lease_released",
          machineId: a.machine,
          generation: 1,
          executions: [],
          revocation: "confirmed",
        }),
        created_at: 200,
      };
      insert(sqlite, "run_resource_notice", notice);
      rejects(sqlite, "run_resource_notice", { ...notice, id: "ntc_two" });
      rejects(sqlite, "run_resource_notice", { ...notice, id: "ntc_three", kind: "lease_ended" });
      rejects(sqlite, "run_resource_notice", {
        ...notice,
        id: "ntc_four",
        cause_id: "lmu-other",
        delivered_at: 199,
      });
      // 已投递样本与同 run 的第二条不同 cause 都合法。
      insert(sqlite, "run_resource_notice", {
        ...notice,
        id: "ntc_five",
        cause_id: "lmu-second",
        delivered_at: 210,
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("P4d 共享契约", () => {
  const projectId = newId(ID_PREFIXES.project);
  const machineId = newId(ID_PREFIXES.machine);
  const instanceId = newId(ID_PREFIXES.instance);
  const at = "2026-11-01T00:00:00.000Z";

  it("DetachInput/RejoinInput 要求 confirm:true 且拒绝多余字段", () => {
    const detach = {
      projectId,
      machineId,
      requestId: newId(ID_PREFIXES.request),
      expectedEpoch: 1,
      expectedRevision: 1,
      expectedGeneration: 0,
      confirm: true,
    };
    expect(detachMachineInputSchema.safeParse(detach).success).toBe(true);
    expect(detachMachineInputSchema.safeParse({ ...detach, confirm: false }).success).toBe(false);
    expect(detachMachineInputSchema.safeParse({ ...detach, confirm: "true" }).success).toBe(false);
    const { confirm: _confirm, ...missing } = detach;
    expect(detachMachineInputSchema.safeParse(missing).success).toBe(false);
    expect(detachMachineInputSchema.safeParse({ ...detach, extra: 1 }).success).toBe(false);

    const rejoin = {
      projectId,
      machineId,
      requestId: newId(ID_PREFIXES.request),
      expectedEpoch: 1,
      expectedRevision: 1,
      confirm: true,
    };
    expect(rejoinProjectMachineInputSchema.safeParse(rejoin).success).toBe(true);
    expect(rejoinProjectMachineInputSchema.safeParse({ ...rejoin, confirm: false }).success).toBe(
      false,
    );
    expect(
      rejoinProjectMachineInputSchema.safeParse({ ...rejoin, expectedGeneration: 0 }).success,
    ).toBe(false);
  });

  it("MembershipView 只在 detaching 带 membership_detaching pending", () => {
    const base = {
      projectId,
      machineId,
      epoch: 1,
      joinedAt: at,
      requestedAt: null,
      removedAt: null,
      removalMutationId: null,
      revokedGeneration: null,
      revocation: null,
      pending: null,
    };
    expect(membershipViewSchema.safeParse({ ...base, state: "active" }).success).toBe(true);
    const pending = {
      kind: "membership_detaching",
      since: "2026-11-01T00:00:10.000Z",
      elapsedMs: 5000,
      thresholdMs: 15000,
      overdue: false,
      workerOnline: true,
      evidence: "awaiting_ack",
      canForceReclaim: false,
    };
    expect(pendingFactViewSchema.safeParse(pending).success).toBe(true);
    expect(pendingFactViewSchema.safeParse({ ...pending, overdue: true }).success).toBe(false);
    expect(pendingFactViewSchema.safeParse({ ...pending, thresholdMs: 1000 }).success).toBe(false);
    const detaching = {
      ...base,
      state: "detaching",
      requestedAt: pending.since,
      removalMutationId: newId(ID_PREFIXES.leaseMutation),
      revocation: "pending",
      pending,
    };
    expect(membershipViewSchema.safeParse(detaching).success).toBe(true);
    expect(
      membershipViewSchema.safeParse({ ...detaching, pending: null, revocation: null }).success,
    ).toBe(false);
    expect(
      membershipViewSchema.safeParse({
        ...base,
        state: "removed",
        requestedAt: pending.since,
        removedAt: "2026-11-01T00:00:20.000Z",
        revokedGeneration: 1,
        revocation: "confirmed",
      }).success,
    ).toBe(true);
    expect(
      membershipViewSchema.safeParse({
        ...base,
        state: "removed",
        requestedAt: pending.since,
        removedAt: null,
        revokedGeneration: 1,
        revocation: "confirmed",
      }).success,
    ).toBe(false);
  });

  it("通知 payload 按 kind 判别，正文事实与 cause 形状被约束", () => {
    const payload = {
      kind: "machine_removed" as const,
      machineId,
      generation: 2,
      executions: [{ executionId: newId(ID_PREFIXES.execution), lastKnownState: "unknown" }],
      revocation: "unconfirmed" as const,
      membershipEpoch: 3,
    };
    expect(runResourceNoticePayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      runResourceNoticePayloadSchema.safeParse({
        ...payload,
        executions: [payload.executions[0], payload.executions[0]],
      }).success,
    ).toBe(false);
    const notice = {
      id: newId(ID_PREFIXES.notice),
      projectId,
      machineId,
      runId: `run_${crypto.randomUUID()}`,
      instanceId,
      chatId: newId(ID_PREFIXES.chat),
      kind: "machine_removed" as const,
      causeId: membershipCauseId(projectId, machineId, 3),
      payload,
      createdAt: at,
      deliveredAt: null,
    };
    expect(runResourceNoticeSchema.safeParse(notice).success).toBe(true);
    expect(
      runResourceNoticeSchema.safeParse({ ...notice, causeId: newId(ID_PREFIXES.leaseMutation) })
        .success,
    ).toBe(false);
    expect(
      runResourceNoticeSchema.safeParse({
        ...notice,
        payload: { ...payload, membershipEpoch: undefined },
      }).success,
    ).toBe(false);
    expect(runResourceNoticeSchema.safeParse({ ...notice, kind: "lease_released" }).success).toBe(
      false,
    );
  });

  it("executionView 的授权角色与当前代次必须成对且与 origin 相符", () => {
    const view = {
      projectId,
      machineId,
      executionId: newId(ID_PREFIXES.execution),
      authorizationGeneration: 2,
      holderInstanceId: instanceId,
      runId: `run_${crypto.randomUUID()}`,
      chatId: newId(ID_PREFIXES.chat),
      requestId: newId(ID_PREFIXES.request),
      operation: { kind: "shell", command: "true" },
      state: "succeeded",
      createdAt: at,
      dispatchDeadlineAt: "2026-11-01T00:00:10.000Z",
      runtimeDeadlineAt: null,
      maxRuntimeMs: null,
      dispatchConnectionGeneration: 1,
      dispatchSeq: 1,
      dispatchedAt: "2026-11-01T00:00:01.000Z",
      drainedAt: at,
      payloadHash: "a".repeat(64),
      terminalAt: at,
      failureReason: null,
      recoveryReason: null,
      result: {
        kind: "shell",
        pid: 1,
        exited: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
      },
      logState: "none",
      producedThroughSequence: null,
      acknowledgedThroughSequence: null,
      availableFromSequence: null,
      cancellation: null,
    };
    // 接入后两个字段都必填；缺省或只给一个字段必须拒绝。
    expect(executionViewSchema.safeParse(view).success).toBe(false);
    expect(
      executionViewSchema.safeParse({
        ...view,
        authority: "inherited",
        currentAuthorizationGeneration: 3,
      }).success,
    ).toBe(true);
    expect(
      executionViewSchema.safeParse({
        ...view,
        authority: "history",
        currentAuthorizationGeneration: null,
      }).success,
    ).toBe(true);
    expect(
      executionViewSchema.safeParse({
        ...view,
        authority: "holder",
        currentAuthorizationGeneration: null,
      }).success,
    ).toBe(false);
    expect(
      executionViewSchema.safeParse({
        ...view,
        authority: "history",
        currentAuthorizationGeneration: 3,
      }).success,
    ).toBe(false);
    expect(
      executionViewSchema.safeParse({ ...view, currentAuthorizationGeneration: 3 }).success,
    ).toBe(false);
    expect(
      executionViewSchema.safeParse({
        ...view,
        authority: "holder",
        currentAuthorizationGeneration: 1,
      }).success,
    ).toBe(false);
  });

  it("两个领域错误码已登记，供映射层原码透出", () => {
    expect(APP_ERROR_CODES).toEqual(
      expect.arrayContaining(["detach_pending", "membership_removed"]),
    );
  });
});
