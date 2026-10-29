import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

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
const rebuild = migrations[migrations.length - 1];
const earlier = migrations.slice(0, -1);

const directories: string[] = [];

function temporaryDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), "sprout-migration-"));
  directories.push(directory);
  const sqlite = new Database(join(directory, "rebuild.sqlite"));
  sqlite.pragma("journal_mode = WAL");
  return sqlite;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("表重建迁移", () => {
  it(`${rebuild.tag} 保留既有执行与子表行，并接受新的取消归因`, () => {
    const sqlite = temporaryDatabase();
    try {
      for (const migration of earlier) {
        for (const statement of migration.statements) sqlite.exec(statement);
      }

      sqlite.pragma("foreign_keys = OFF");
      sqlite
        .prepare(
          `INSERT INTO remote_execution (id, project_id, machine_id, authorization_generation,
             holder_instance_id, run_id, chat_id, request_id, payload_hash, operation_json, state,
             created_at, dispatch_deadline_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          "exe_rebuild",
          "prj_rebuild",
          "mch_rebuild",
          1,
          "ins_rebuild",
          "run_rebuild",
          "cht_rebuild",
          "req_rebuild",
          "a".repeat(64),
          JSON.stringify({ kind: "shell", command: "true", cwd: "/tmp", waitMs: 1000 }),
          1,
          2,
        );
      sqlite
        .prepare(
          `INSERT INTO execution_log_frame (execution_id, sequence, project_id, machine_id,
             authorization_generation, holder_instance_id, stream, byte_start, byte_end,
             payload_bytes, checksum, durable_at)
           VALUES ('exe_rebuild', 1, 'prj_rebuild', 'mch_rebuild', 1, 'ins_rebuild', 'stdout', 0, 1, x'61', ?, 3)`,
        )
        .run("b".repeat(64));
      sqlite
        .prepare(
          `INSERT INTO execution_result (execution_id, project_id, machine_id,
             authorization_generation, holder_instance_id, payload_hash, outcome, payload_json, recorded_at)
           VALUES ('exe_rebuild', 'prj_rebuild', 'mch_rebuild', 1, 'ins_rebuild', ?, 'succeeded', '{}', 4)`,
        )
        .run("c".repeat(64));
      sqlite
        .prepare(
          `INSERT INTO execution_cancellation (id, execution_id, request_id, project_id, machine_id,
             authorization_generation, holder_instance_id, actor_kind, actor_id, state, requested_at)
           VALUES ('cnl_rebuild', 'exe_rebuild', 'cancel:human:rebuild', 'prj_rebuild', 'mch_rebuild',
             1, 'ins_rebuild', 'human', 'usr_rebuild', 'requested', 5)`,
        )
        .run();

      sqlite.exec("BEGIN");
      for (const statement of rebuild.statements) sqlite.exec(statement);
      sqlite.exec("COMMIT");

      const count = (table: string) =>
        (
          sqlite.prepare(`SELECT count(*) AS row_count FROM ${table}`).get() as {
            row_count: number;
          }
        ).row_count;
      expect(count("remote_execution")).toBe(1);
      expect(count("execution_log_frame")).toBe(1);
      expect(count("execution_result")).toBe(1);
      expect(count("execution_cancellation")).toBe(1);

      sqlite
        .prepare(
          "UPDATE remote_execution SET state = 'failed', terminal_at = 6, failure_reason = 'cancelled' WHERE id = ?",
        )
        .run("exe_rebuild");
      expect(
        (
          sqlite
            .prepare("SELECT failure_reason FROM remote_execution WHERE id = ?")
            .get("exe_rebuild") as {
            failure_reason: string;
          }
        ).failure_reason,
      ).toBe("cancelled");
      expect(() =>
        sqlite
          .prepare("UPDATE remote_execution SET failure_reason = 'because' WHERE id = ?")
          .run("exe_rebuild"),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      sqlite.close();
    }
  });

  it("重建 SQL 保留投递帧外键的 DEFERRABLE 修饰", () => {
    const sql = rebuild.statements.join("\n");
    expect(sql).toMatch(/REFERENCES `worker_exchange_frame`[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  });
});
