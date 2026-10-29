import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrateDatabase } from "../../src/db/migrate";

const directory = mkdtempSync(join(tmpdir(), "p4d-acceptance-upgrade-"));
const databasePath = join(directory, "legacy.sqlite");
const legacyMigrations = join(directory, "migrations");
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: { tag: string }[];
};
const index = journal.entries.findIndex((entry) => entry.tag === "0020_p4d_membership_notices");
assert.ok(index > 0);
const previousEntries = journal.entries.slice(0, index);
mkdirSync(join(legacyMigrations, "meta"), { recursive: true });
writeFileSync(
  join(legacyMigrations, "meta/_journal.json"),
  JSON.stringify({ ...journal, entries: previousEntries }),
);
for (const entry of previousEntries)
  copyFileSync(resolve("drizzle", `${entry.tag}.sql`), join(legacyMigrations, `${entry.tag}.sql`));
try {
  migrateDatabase(databasePath, legacyMigrations);
  const legacy = new Database(databasePath);
  legacy.pragma("foreign_keys = ON");
  const insert = (table: string, values: Record<string, string | number | null>) => {
    const columns = Object.keys(values);
    legacy
      .prepare(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .run(...Object.values(values));
  };
  insert("user", {
    id: "owner",
    name: "Owner",
    email: "migration@example.test",
    email_verified: 0,
    created_at: 1,
    updated_at: 1,
  });
  insert("agent_profile", { id: "profile", name: "Agent", created_by: "owner" });
  insert("machine", {
    id: "machine",
    name: "Machine",
    created_by: "owner",
    created_at: 1,
    updated_at: 1,
  });
  insert("runtime_boot", {
    id: "boot",
    started_at: 1,
    phase: "ready",
    pid: 1,
    app_version: "legacy",
  });
  insert("machine_connection", {
    machine_id: "machine",
    generation: 1,
    attempt_id: "attempt",
    boot_id: "boot",
    status: "open",
    opened_at: 1,
    last_seen_at: 1,
    seq: 0,
  });
  for (const project of ["P", "Q", "R"]) {
    insert("project", { id: project, name: project, created_by: "owner" });
    insert("chat", { id: `chat-${project}`, project_id: project, kind: "dm", created_by: "owner" });
    insert("agent_instance", {
      id: `instance-${project}`,
      agent_profile_id: "profile",
      chat_id: `chat-${project}`,
      project_id: project,
    });
    insert("agent_run", {
      id: `run-${project}`,
      instance_id: `instance-${project}`,
      project_id: project,
      chat_id: `chat-${project}`,
      request_id: `req-${project}`,
      status: "running",
      started_at: 1,
      session_id: `session-${project}`,
    });
    insert("project_machine", {
      project_id: project,
      machine_id: "machine",
      created_by: "owner",
      revision: 1,
      created_at: 123,
      updated_at: 124,
    });
    insert("machine_lease", {
      project_id: project,
      machine_id: "machine",
      generation: 1,
      state: "held",
      holder_instance_id: `instance-${project}`,
      changed_at: 123,
    });
    insert("lease_authorization", {
      project_id: project,
      machine_id: "machine",
      generation: 1,
      holder_instance_id: `instance-${project}`,
      state: "active",
      issued_at: 123,
      reason: "acquire",
    });
    insert("remote_execution", {
      id: `execution-${project}`,
      project_id: project,
      machine_id: "machine",
      authorization_generation: 1,
      holder_instance_id: `instance-${project}`,
      run_id: `run-${project}`,
      chat_id: `chat-${project}`,
      request_id: `execution-request-${project}`,
      payload_hash: "a".repeat(64),
      operation_json: JSON.stringify({ kind: "file_read", path: "/tmp/acceptance" }),
      state: "queued",
      created_at: 200,
      dispatch_deadline_at: 300,
    });
  }
  const tables = (
    legacy
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='__drizzle_migrations' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const rowsBefore = Object.fromEntries(
    tables.map((name) => [name, legacy.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
  );
  const executionSqlBefore = (
    legacy.prepare("SELECT sql FROM sqlite_schema WHERE name='remote_execution'").get() as {
      sql: string;
    }
  ).sql;
  assert.deepEqual(legacy.pragma("foreign_key_check"), []);
  legacy.close();

  migrateDatabase(databasePath);
  migrateDatabase(databasePath);
  const upgraded = new Database(databasePath);
  try {
    upgraded.pragma("foreign_keys = ON");
    const rowsAfter = Object.fromEntries(
      tables.map((name) => [name, upgraded.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
    );
    assert.deepEqual(
      rowsAfter,
      rowsBefore,
      "all legacy table rows and columns must survive production migration and replay",
    );
    assert.deepEqual(
      upgraded
        .prepare(
          "SELECT project_id,machine_id,epoch,state,joined_at FROM project_machine_membership ORDER BY project_id",
        )
        .all(),
      ["P", "Q", "R"].map((project_id) => ({
        project_id,
        machine_id: "machine",
        epoch: 1,
        state: "active",
        joined_at: 123,
      })),
    );
    assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
    const executionSqlAfter = (
      upgraded.prepare("SELECT sql FROM sqlite_schema WHERE name='remote_execution'").get() as {
        sql: string;
      }
    ).sql;
    assert.equal(
      executionSqlAfter,
      executionSqlBefore,
      "0020 must preserve the real table definition exactly",
    );

    upgraded.exec("BEGIN");
    upgraded
      .prepare(
        "UPDATE remote_execution SET state='dispatched', dispatch_connection_generation=1, dispatch_seq=1, dispatched_at=210 WHERE id='execution-P'",
      )
      .run();
    assert.equal(
      (upgraded.pragma("foreign_key_check") as unknown[]).length,
      1,
      "missing dispatch frame exists temporarily inside transaction",
    );
    upgraded
      .prepare(
        "INSERT INTO worker_exchange_frame(machine_id,connection_generation,seq,payload_hash,response_json,created_at) VALUES ('machine',1,1,?,'{}',210)",
      )
      .run("b".repeat(64));
    upgraded.exec("COMMIT");
    assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
    upgraded.exec("BEGIN");
    upgraded
      .prepare(
        "UPDATE remote_execution SET state='dispatched', dispatch_connection_generation=1, dispatch_seq=2, dispatched_at=210 WHERE id='execution-Q'",
      )
      .run();
    assert.throws(
      () => upgraded.exec("COMMIT"),
      /FOREIGN KEY/,
      "unresolved deferred FK must still reject commit",
    );
    upgraded.exec("ROLLBACK");
    assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
    console.log(
      "PASS production 0019-to-0020 migration and replay: 3 shared-Machine bindings, all legacy rows unchanged, one epoch per binding, deferred dispatch FK proven by transaction and failed commit, foreign_key_check empty",
    );
  } finally {
    upgraded.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
