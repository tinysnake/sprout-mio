import assert from "node:assert/strict";
import { migrateDatabase } from "../../src/db/migrate";
import { openDatabase } from "../../src/db/connection";

const databaseUrl = process.env.DATABASE_URL;
assert(databaseUrl && databaseUrl !== ":memory:", "isolated DATABASE_URL is required");
migrateDatabase(databaseUrl);
const { sqlite } = openDatabase(databaseUrl);
try {
  const insert = (table: string, values: Record<string, string | number | null>) => {
    const columns = Object.keys(values);
    return sqlite
      .prepare(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .run(...Object.values(values));
  };
  for (const id of ["owner", "other"])
    insert("user", {
      id,
      name: id,
      email: `${id}@example.test`,
      email_verified: 0,
      created_at: 1,
      updated_at: 1,
    });
  for (const [id, owner] of [
    ["p", "owner"],
    ["other-p", "other"],
  ])
    insert("project", { id, name: id, created_by: owner });
  for (const [id, owner] of [
    ["m", "owner"],
    ["other-m", "other"],
  ])
    insert("machine", { id, name: id, created_by: owner, created_at: 1, updated_at: 1 });
  insert("runtime_boot", {
    id: "boot",
    started_at: 1,
    phase: "ready",
    pid: 1,
    app_version: "test",
  });
  insert("machine_connection_counter", { machine_id: "m", high_water: 1 });
  const binding = {
    project_id: "p",
    machine_id: "m",
    created_by: "owner",
    revision: 1,
    created_at: 1,
    updated_at: 1,
  };
  insert("project_machine", binding);
  const connection = {
    machine_id: "m",
    generation: 1,
    attempt_id: "attempt-1",
    boot_id: "boot",
    status: "open",
    opened_at: 1,
    last_seen_at: 1,
    seq: 0,
  };
  insert("machine_connection", connection);
  const observation = {
    machine_id: "m",
    generation: 1,
    project_id: "p",
    revision: 1,
    seq: 1,
    checked_at: 1,
    kind: "accessible",
    real_path: "/tmp",
  };
  insert("directory_observation", observation);
  const scenario = process.argv[2] ?? "all";
  if (scenario === "all" || scenario === "identity") {
    for (const bad of [
      { ...binding, machine_id: "other-m" },
      { ...binding, project_id: "other-p" },
      { ...binding, created_by: "other" },
    ])
      assert.throws(() => insert("project_machine", bad), /FOREIGN KEY|UNIQUE/);
    assert.throws(() => insert("machine_connection", { ...connection, generation: 2 }), /UNIQUE/);
    assert.throws(
      () =>
        insert("machine_connection", {
          ...connection,
          generation: 2,
          attempt_id: "a2",
          boot_id: "missing",
        }),
      /FOREIGN KEY/,
    );
    assert.throws(
      () => insert("directory_observation", { ...observation, generation: 2 }),
      /FOREIGN KEY/,
    );
    assert.throws(
      () => insert("directory_observation", { ...observation, project_id: "other-p" }),
      /FOREIGN KEY/,
    );
    const credential = {
      machine_id: "m",
      ticket_hash: "a".repeat(64),
      ticket_expires_at: 10,
      secret_hash: "b".repeat(64),
      activated_at: 1,
    };
    insert("machine_credential", credential);
    assert.throws(
      () => insert("machine_credential", { ...credential, machine_id: "other-m" }),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        insert("machine_credential", {
          ...credential,
          machine_id: "other-m",
          ticket_hash: "c".repeat(64),
        }),
      /UNIQUE/,
    );
  }
  if (scenario === "all" || scenario === "history") {
    sqlite
      .prepare("UPDATE machine SET root_revision = 2, root_directory = '/new' WHERE id = 'm'")
      .run();
    sqlite
      .prepare("UPDATE machine_connection_counter SET high_water = 2 WHERE machine_id = 'm'")
      .run();
    insert("machine_connection", { ...connection, generation: 2, attempt_id: "attempt-2" });
    insert("directory_observation", { ...observation, generation: 2, revision: 2 });
    assert.deepEqual(
      sqlite
        .prepare("SELECT generation, revision FROM directory_observation ORDER BY generation")
        .all(),
      [
        { generation: 1, revision: 1 },
        { generation: 2, revision: 2 },
      ],
    );
    migrateDatabase(databaseUrl);
    assert.deepEqual(sqlite.prepare("SELECT count(*) AS n FROM machine_connection").get(), {
      n: 2,
    });
  }
  if (scenario === "all" || scenario === "checks") {
    for (const value of [-1, 0.5, 9007199254740992]) {
      assert.throws(
        () => sqlite.prepare("UPDATE machine_connection_counter SET high_water = ?").run(value),
        /CHECK/,
      );
    }
    sqlite
      .prepare("UPDATE machine_connection_counter SET high_water = ?")
      .run(Number.MAX_SAFE_INTEGER);
    for (const value of [0, -1, 1.5, 9007199254740992]) {
      assert.throws(
        () => sqlite.prepare("UPDATE project_machine SET revision = ?").run(value),
        /CHECK/,
      );
      assert.throws(
        () => sqlite.prepare("UPDATE machine_connection SET generation = ?").run(value),
        /CHECK/,
      );
      assert.throws(
        () => sqlite.prepare("UPDATE directory_observation SET seq = ?").run(value),
        /CHECK/,
      );
    }
    for (const clause of [
      "status = 'closed'",
      "seq = 1",
      "seq = 1, capability = '{}'",
      "seq = 1, capability = 'null', last_payload_hash = '" + "a".repeat(64) + "'",
      "seq = 1, capability = 'bad json', last_payload_hash = '" + "a".repeat(64) + "'",
      "seq = -1",
      "seq = 0.5",
    ]) {
      assert.throws(() => sqlite.exec(`UPDATE machine_connection SET ${clause}`), /CHECK/);
    }
    sqlite
      .prepare("UPDATE machine_connection SET seq = 1, capability = '{}', last_payload_hash = ?")
      .run("a".repeat(64));
    sqlite.exec("UPDATE machine_connection SET status = 'closed', closed_at = 2");
    for (const clause of [
      "real_path = NULL",
      "kind = 'unavailable', real_path = NULL, reason = NULL",
      "kind = 'unavailable', real_path = NULL, reason = 'secret error'",
      "real_path = 'relative'",
      "real_path = '/ok' || char(0) || 'bad'",
    ]) {
      assert.throws(() => sqlite.exec(`UPDATE directory_observation SET ${clause}`), /CHECK/);
    }
    sqlite.exec(
      "UPDATE directory_observation SET kind = 'unavailable', real_path = NULL, reason = 'denied'",
    );
    assert(
      !(sqlite.pragma("table_info(project_machine)") as { name: string }[]).some(
        (column) => column.name === "directory",
      ),
    );
    assert.deepEqual(
      sqlite.prepare("SELECT root_directory, root_revision FROM machine WHERE id = 'm'").get(),
      {
        root_directory: scenario === "all" ? "/new" : null,
        root_revision: scenario === "all" ? 2 : 1,
      },
    );
    for (const value of [0, -1, 1.5, 9007199254740992, null])
      assert.throws(
        () => sqlite.prepare("UPDATE machine SET root_revision = ?").run(value),
        /CHECK|NOT NULL/,
      );
    for (const directory of ["", "~/work", "relative", "/ok\0bad", "/" + "a".repeat(4096)])
      assert.throws(
        () => sqlite.prepare("UPDATE machine SET root_directory = ?").run(directory),
        /CHECK/,
      );
    sqlite.exec("UPDATE machine SET root_directory = NULL");
    const credential = { machine_id: "m", ticket_hash: "d".repeat(64), ticket_expires_at: 10 };
    if (scenario !== "all") insert("machine_credential", credential);
    for (const clause of [
      "secret_hash = '" + "e".repeat(64) + "', activated_at = NULL",
      "secret_hash = NULL, activated_at = 1",
      "ticket_hash = 'invalid'",
    ])
      assert.throws(() => sqlite.exec(`UPDATE machine_credential SET ${clause}`), /CHECK/);
  }
  assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  console.log(`PASS machine contracts SQLite ${scenario}`);
} finally {
  sqlite.close();
}
