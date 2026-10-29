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
// 不假设重建是最后一条迁移；后续迁移追加在它之后也要能定位最近一次重建。
let rebuildIndex = -1;
for (const [index, migration] of migrations.entries())
  if (migration.statements.some((statement) => statement.includes("`__new_remote_execution`")))
    rebuildIndex = index;
if (rebuildIndex < 0) throw new Error("找不到重建 remote_execution 的迁移");
const rebuild = migrations[rebuildIndex];
const earlier = migrations.slice(0, rebuildIndex);

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

// 迁移按 tag 定位，不假设 I-P5a 的重建永远是最后一条。
function indexOfTag(tag: string): number {
  const index = migrations.findIndex((migration) => migration.tag === tag);
  if (index < 0) throw new Error(`找不到迁移 ${tag}`);
  return index;
}
const multichatIndex = indexOfTag("0021_p5a_multichat_schema");
const backfillIndex = indexOfTag("0022_p5a_public_channel_backfill");
const multichat = migrations[multichatIndex];
const backfill = migrations[backfillIndex];

function applyRange(sqlite: Database.Database, from: number, to: number) {
  for (const migration of migrations.slice(from, to))
    for (const statement of migration.statements) sqlite.exec(statement);
}

/** 迁移执行器把整个文件包在一个事务里，文件内的 PRAGMA foreign_keys 因此无效；测试同样如此。 */
function applyRangeInTransaction(sqlite: Database.Database, from: number, to: number) {
  sqlite.exec("BEGIN");
  try {
    applyRange(sqlite, from, to);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

/** 0020 结束时的既有事实：一条 DM、两名成员、一条消息、一个分身与一次排队中的 run。 */
function seedLegacyRows(sqlite: Database.Database) {
  sqlite.pragma("foreign_keys = OFF");
  sqlite
    .prepare(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
       VALUES ('usr_legacy', 'legacy', 'u@e.com', 0, 1, 1),
              ('usr_second', 'second', '{{EMAIL_zcwcuhgzhx}}', 0, 1, 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO project (id, name, created_by, created_at, updated_at)
       VALUES ('prj_legacy', 'legacy', 'usr_legacy', 1, 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO agent_profile (id, name, persona, harness, created_by, created_at, updated_at)
       VALUES ('agp_legacy', 'legacy', 'persona', 'pi', 'usr_legacy', 1, 1),
              ('agp_second', 'second', 'persona', 'pi', 'usr_legacy', 1, 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO project_member (project_id, agent_profile_id, added_by, added_at)
       VALUES ('prj_legacy', 'agp_legacy', 'usr_legacy', 1),
              ('prj_legacy', 'agp_second', 'usr_legacy', 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO chat (id, project_id, kind, created_by, created_at, updated_at)
       VALUES ('cnv_legacy', 'prj_legacy', 'dm', 'usr_legacy', 2, 2)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO chat_member (chat_id, member_kind, member_id, added_at)
       VALUES ('cnv_legacy', 'human', 'usr_legacy', 2), ('cnv_legacy', 'agent', 'agp_legacy', 2)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO agent_instance (id, agent_profile_id, chat_id, project_id, created_at, updated_at)
       VALUES ('ins_legacy', 'agp_legacy', 'cnv_legacy', 'prj_legacy', 2, 2),
              ('ins_second', 'agp_second', 'cnv_legacy', 'prj_legacy', 2, 2)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO message (id, chat_id, sender_kind, sender_id, body, created_at)
       VALUES ('msg_legacy', 'cnv_legacy', 'human', 'usr_legacy', 'hello', 3)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO agent_run (id, instance_id, chat_id, project_id, request_id, status, queued_at, session_id)
       VALUES ('run_legacy', 'ins_legacy', 'cnv_legacy', 'prj_legacy', 'req_legacy', 'queued', 3, 'ins_legacy'),
              ('run_second', 'ins_second', 'cnv_legacy', 'prj_legacy', 'req_second', 'queued', 3, 'ins_second')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO agent_run_input (message_id, run_id, disposition)
       VALUES ('msg_legacy', 'run_legacy', 'pending')`,
    )
    .run();
}

describe("I-P5a 多人 Chat 结构迁移", () => {
  it(`${multichat.tag} 回填 DM 所有者并保留成员、消息与输入行`, () => {
    const sqlite = temporaryDatabase();
    try {
      applyRange(sqlite, 0, multichatIndex);
      seedLegacyRows(sqlite);
      applyRangeInTransaction(sqlite, multichatIndex, backfillIndex);
      applyRangeInTransaction(sqlite, backfillIndex, backfillIndex + 1);

      expect(
        sqlite
          .prepare(
            `SELECT kind, owner_kind, owner_id, wake_policy, governance_revision, created_at, updated_at
             FROM chat WHERE id = 'cnv_legacy'`,
          )
          .get(),
      ).toEqual({
        kind: "dm",
        owner_kind: "human",
        owner_id: "usr_legacy",
        wake_policy: "owner_led",
        governance_revision: 0,
        created_at: 2,
        updated_at: 2,
      });
      expect(
        sqlite.prepare(`SELECT count(*) AS n FROM chat_member WHERE chat_id = 'cnv_legacy'`).get(),
      ).toEqual({ n: 2 });
      expect(sqlite.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 1 });
      expect(
        sqlite
          .prepare(
            `SELECT run_id, message_id, disposition, delivered_at, cancelled_at, cancel_reason
             FROM agent_run_input`,
          )
          .all(),
      ).toEqual([
        {
          run_id: "run_legacy",
          message_id: "msg_legacy",
          disposition: "pending",
          delivered_at: null,
          cancelled_at: null,
          cancel_reason: null,
        },
      ]);
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
      sqlite.pragma("foreign_keys = ON");
    } finally {
      sqlite.close();
    }
  });

  it(`${multichat.tag} 的新主键允许一条消息扇出给多条 run`, () => {
    const sqlite = temporaryDatabase();
    try {
      applyRange(sqlite, 0, multichatIndex);
      seedLegacyRows(sqlite);
      applyRangeInTransaction(sqlite, multichatIndex, backfillIndex);
      sqlite.pragma("foreign_keys = ON");

      sqlite
        .prepare(
          `INSERT INTO agent_run_input (run_id, message_id, disposition)
           VALUES ('run_second', 'msg_legacy', 'pending')`,
        )
        .run();
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO agent_run_input (run_id, message_id, disposition)
             VALUES ('run_second', 'msg_legacy', 'pending')`,
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed: agent_run_input\.run_id, agent_run_input\.message_id/);
      sqlite
        .prepare(
          `UPDATE agent_run_input SET disposition = 'cancelled', cancelled_at = 5,
             cancel_reason = 'membership_revoked'
           WHERE run_id = 'run_second' AND message_id = 'msg_legacy'`,
        )
        .run();
      expect(
        sqlite
          .prepare(
            `SELECT disposition, cancelled_at, cancel_reason FROM agent_run_input
             WHERE run_id = 'run_second'`,
          )
          .get(),
      ).toEqual({ disposition: "cancelled", cancelled_at: 5, cancel_reason: "membership_revoked" });
      // 取消态必须同时带上时间与原因，缺一个就被 CHECK 拒绝。
      expect(() =>
        sqlite
          .prepare(
            `UPDATE agent_run_input SET disposition = 'cancelled', cancelled_at = NULL
             WHERE run_id = 'run_second'`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed: agent_run_input_disposition_check/);
      expect(() =>
        sqlite
          .prepare(
            `UPDATE agent_run_input SET disposition = 'pending', delivered_at = 6
             WHERE run_id = 'run_second'`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed: agent_run_input_disposition_check/);
    } finally {
      sqlite.close();
    }
  });

  it(`${multichat.tag} 的触发器与视图守住派生成员和不可变身份`, () => {
    const sqlite = temporaryDatabase();
    try {
      applyRange(sqlite, 0, multichatIndex);
      seedLegacyRows(sqlite);
      applyRangeInTransaction(sqlite, multichatIndex, migrations.length);
      sqlite.pragma("foreign_keys = ON");
      const channelId = String(
        (
          sqlite.prepare(`SELECT id FROM chat WHERE kind = 'public_channel'`).get() as {
            id: string;
          }
        ).id,
      );

      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO chat (id, project_id, kind, owner_kind, owner_id, created_by)
             VALUES ('cnv_group', 'prj_legacy', 'group', 'agent', 'agp_second', 'usr_legacy')`,
          )
          .run(),
      ).not.toThrow();
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO chat (id, project_id, kind, owner_kind, owner_id, created_by)
             VALUES ('cnv_bad_owner', 'prj_legacy', 'dm', 'agent', 'agp_legacy', 'usr_legacy')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed: chat_dm_owner_check/);
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO chat (id, project_id, kind, owner_kind, owner_id, created_by)
             VALUES ('cnv_bad_kind', 'prj_legacy', 'channel', 'human', 'usr_legacy', 'usr_legacy')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed: chat_kind_check/);
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO chat (id, project_id, kind, owner_kind, owner_id, created_by, archived_at)
             VALUES ('cnv_archived', 'prj_legacy', 'public_channel', 'human', 'usr_legacy', 'usr_legacy', 9)`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed: chat_public_channel_archived_check/);
      expect(() =>
        sqlite.prepare(`UPDATE chat SET kind = 'group' WHERE id = 'cnv_legacy'`).run(),
      ).toThrow(/chat_identity_immutable/);
      expect(() =>
        sqlite
          .prepare(`UPDATE chat SET title = '改名', updated_at = 7 WHERE id = 'cnv_legacy'`)
          .run(),
      ).not.toThrow();
      expect(() =>
        sqlite.prepare(`UPDATE chat_member SET added_at = 9 WHERE chat_id = 'cnv_legacy'`).run(),
      ).toThrow(/chat_member_identity_immutable/);
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO chat_member (chat_id, member_kind, member_id) VALUES (?, 'human', 'usr_second')`,
          )
          .run(channelId),
      ).toThrow(/public_channel_members_derived/);
      expect(() =>
        sqlite.prepare(`DELETE FROM chat_member WHERE chat_id = 'cnv_legacy'`).run(),
      ).not.toThrow();

      expect(
        sqlite
          .prepare(
            `SELECT member_kind, member_id, source FROM chat_effective_member WHERE chat_id = ?
             ORDER BY member_kind, member_id`,
          )
          .all(channelId),
      ).toEqual([
        { member_kind: "agent", member_id: "agp_legacy", source: "project_member" },
        { member_kind: "agent", member_id: "agp_second", source: "project_member" },
        { member_kind: "human", member_id: "usr_legacy", source: "project_owner" },
      ]);
      // 移出项目后，同一连接的下次读取立刻失去该分身；不留双写窗口。
      sqlite.prepare(`DELETE FROM project_member WHERE agent_profile_id = 'agp_legacy'`).run();
      expect(
        sqlite
          .prepare(
            `SELECT count(*) AS n FROM chat_effective_member
             WHERE chat_id = ? AND member_id = 'agp_legacy'`,
          )
          .get(channelId),
      ).toEqual({ n: 0 });
      // 每个 Project 只能有一条公共频道。
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO chat (id, project_id, kind, owner_kind, owner_id, created_by)
             VALUES ('cnv_channel2', 'prj_legacy', 'public_channel', 'human', 'usr_legacy', 'usr_legacy')`,
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed: chat\.project_id/);
    } finally {
      sqlite.close();
    }
  });

  it(`${backfill.tag} 幂等，且回填 id 仍满足契约的 chatId 形状`, () => {
    const sqlite = temporaryDatabase();
    try {
      applyRange(sqlite, 0, multichatIndex);
      seedLegacyRows(sqlite);
      applyRangeInTransaction(sqlite, multichatIndex, backfillIndex);
      applyRange(sqlite, backfillIndex, backfillIndex + 1);
      applyRange(sqlite, backfillIndex, backfillIndex + 1);
      sqlite.pragma("foreign_keys = ON");

      const channels = sqlite
        .prepare(`SELECT id, title, archived_at, owner_kind, owner_id, wake_policy, governance_revision
                  FROM chat WHERE kind = 'public_channel'`)
        .all() as {
        id: string;
        title: string | null;
        archived_at: number | null;
        owner_kind: string;
        owner_id: string;
        wake_policy: string;
        governance_revision: number;
      }[];
      expect(channels).toHaveLength(1);
      const [{ id: channelId, ...channelFacts }] = channels;
      expect(channelFacts).toEqual({
        title: null,
        archived_at: null,
        owner_kind: "human",
        owner_id: "usr_legacy",
        wake_policy: "owner_led",
        governance_revision: 0,
      });
      expect(channelId).toMatch(
        /^cnv_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(
        sqlite
          .prepare(`SELECT count(*) AS n FROM chat_member cm
                    JOIN chat c ON c.id = cm.chat_id WHERE c.kind = 'public_channel'`)
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("重建后的表继续以外键引用父表", () => {
    const sqlite = temporaryDatabase();
    try {
      applyRange(sqlite, 0, migrations.length);
      sqlite.pragma("foreign_keys = ON");
      const ddl = new Map<string, string>(
        ["chat", "chat_member", "agent_run_input"].map((table) => [
          table,
          String(
            (
              sqlite
                .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
                .get(table) as { sql: string }
            ).sql,
          ),
        ]),
      );
      expect(ddl.get("chat")).toContain("FOREIGN KEY (`project_id`) REFERENCES `project`(`id`)");
      expect(ddl.get("chat")).toContain("FOREIGN KEY (`created_by`) REFERENCES `user`(`id`)");
      expect(ddl.get("chat_member")).toContain("FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`)");
      expect(ddl.get("agent_run_input")).toContain(
        "FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`)",
      );
      expect(ddl.get("agent_run_input")).toContain(
        "FOREIGN KEY (`message_id`) REFERENCES `message`(`id`)",
      );
      expect(
        (
          sqlite
            .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
            .get("chat_public_channel_project_unique") as { sql: string }
        ).sql,
      ).toMatch(/WHERE "chat"\."kind" = 'public_channel'/);
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO chat (id, project_id, kind, owner_kind, owner_id, created_by)
             VALUES ('cnv_ghost', 'prj_ghost', 'group', 'human', 'usr_ghost', 'usr_ghost')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      sqlite.close();
    }
  });
});
