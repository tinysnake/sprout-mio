import { describe, expect, it } from "vite-plus/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../src/db/migrate";
import { openDatabase, type DatabaseConnection } from "../src/db/connection";

function seed({ sqlite }: DatabaseConnection) {
  sqlite.exec(`
    INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('human','Human','migration@webhook.test',0,1,1);
    INSERT INTO project(id,name,created_by) VALUES ('project','Project','human'),('other','Other','human');
    INSERT INTO agent_profile(id,name,created_by) VALUES ('agent','Agent','human');
    INSERT INTO project_member(project_id,agent_profile_id,added_by) VALUES ('project','agent','human');
    INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES ('chat','project','group','human','human','human'),('otherchat','other','group','human','human','human');
    INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES ('chat','human','human'),('chat','agent','agent');
    INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES ('instance','agent','chat','project');
    INSERT INTO message(id,chat_id,sender_kind,sender_id,body) VALUES ('input','chat','human','human','Human input'),('assistant','chat','agent','agent','Agent result');
    INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,session_id,started_at,settled_at,stop_reason,config_snapshot,assistant_message_id) VALUES ('run','instance','chat','project','request','completed','instance',1,2,'stop','{}','assistant');
    INSERT INTO agent_run_input(run_id,message_id,disposition,delivered_at) VALUES ('run','input','delivered',2);
    INSERT INTO task(id,project_id,title,created_by,created_at,updated_at) VALUES ('task','project','Task','human',1,1);
    UPDATE task SET status='assigned',chat_id='chat',revision=2,assignment_revision=1 WHERE id='task';
    INSERT INTO message(id,chat_id,sender_kind,sender_id,body,task_id,task_project_id,task_record_seq,task_record_kind) VALUES ('progress','chat','human','human','Task progress','task','project',1,'progress');
    UPDATE task SET status='finished',revision=3 WHERE id='task';
    INSERT INTO message(id,chat_id,sender_kind,sender_id,body,task_id,task_project_id,task_record_seq,task_record_kind,task_reference_message_id) VALUES ('correction','chat','human','human','Task correction','task','project',2,'correction','progress');
  `);
}
function fixture(test: (connection: DatabaseConnection) => void) {
  const directory = mkdtempSync(join(tmpdir(), "webhook-sql-"));
  const file = join(directory, "database.sqlite");
  migrateDatabase(file);
  const connection = openDatabase(file);
  try {
    seed(connection);
    test(connection);
  } finally {
    connection.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
function seedRule({ sqlite }: DatabaseConnection) {
  sqlite
    .prepare(
      "INSERT INTO webhook_rule(id,project_id,created_by,name,enabled,revision,instruction,action,secret_digest,created_at,updated_at) VALUES ('rule','project','human','Rule',1,0,'Instruction',?,?,1,1)",
    )
    .run(
      JSON.stringify({ kind: "group_agent", chatId: "chat", agentProfileId: "agent" }),
      "a".repeat(64),
    );
}

describe("0037 webhook migration: populated upgrade and SQL counterexamples", () => {
  it("preserves Human/Agent, Task references, input dispositions and triggers from populated 0036", () => {
    const directory = mkdtempSync(join(tmpdir(), "webhook-upgrade-"));
    const file = join(directory, "upgrade.sqlite");
    const oldFolder = join(directory, "old");
    mkdirSync(join(oldFolder, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 36);
    for (const entry of journal.entries)
      copyFileSync(join("drizzle", `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`));
    writeFileSync(join(oldFolder, "meta", "_journal.json"), JSON.stringify(journal));
    migrateDatabase(file, oldFolder);
    const before = openDatabase(file);
    seed(before);
    const rows = (connection: DatabaseConnection, table: string) =>
      connection.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const messages = rows(before, "message");
    const inputs = rows(before, "agent_run_input");
    const runs = rows(before, "agent_run");
    const tasks = rows(before, "task");
    const triggers = before.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all();
    before.sqlite.close();
    try {
      migrateDatabase(file);
      migrateDatabase(file);
      const after = openDatabase(file);
      try {
        expect(rows(after, "message")).toEqual(
          messages.map((row) => ({
            ...(row as object),
            automation_trigger_id: null,
            assistant_event_id: null,
            assistant_proposal_id: null,
          })),
        );
        expect(rows(after, "agent_run_input")).toEqual(inputs);
        expect(rows(after, "agent_run")).toEqual(runs);
        expect(
          after.sqlite.prepare("SELECT purpose FROM agent_profile WHERE id='agent'").get(),
        ).toEqual({ purpose: "worker" });
        expect(rows(after, "task")).toEqual(tasks);
        expect(
          after.sqlite
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
            .all(),
        ).toEqual(expect.arrayContaining(triggers));
        expect(() =>
          after.sqlite.prepare("UPDATE message SET body='corrupt' WHERE id='progress'").run(),
        ).toThrow(/task_record_immutable/);
        expect(() =>
          after.sqlite.prepare("DELETE FROM message WHERE id='correction'").run(),
        ).toThrow(/task_record_immutable/);
        expect(() =>
          after.sqlite
            .prepare("UPDATE agent_run SET assistant_message_id='progress' WHERE id='run'")
            .run(),
        ).toThrow(/task_record_not_assistant/);
        expect(() =>
          after.sqlite.prepare("UPDATE agent_run_input SET admitted_at=1 WHERE run_id='run'").run(),
        ).toThrow(/task_input_invalid/);
        expect(after.sqlite.pragma("foreign_key_check")).toEqual([]);
        expect(after.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally {
        after.sqlite.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects NULL-bypassed actions and receipt shapes; preserves memberKind and source/FK binding", () =>
    fixture((connection) => {
      const { sqlite } = connection;
      seedRule(connection);
      const action = sqlite.prepare("UPDATE webhook_rule SET action=? WHERE id='rule'");
      for (const invalid of [
        {},
        { kind: "group_agent", chatId: "chat" },
        { kind: "dm_agent", chatId: null, agentProfileId: "agent" },
        { kind: "group_owner" },
        { kind: null, chatId: "chat" },
      ])
        expect(() => action.run(JSON.stringify(invalid))).toThrow(/CHECK/);
      const trigger = sqlite.prepare(
        "INSERT INTO webhook_trigger(id,rule_id,project_id,mode,event_id,fingerprint,snapshot,decision,reason,chat_id,agent_profile_id,message_id,created_at) VALUES (?,'rule',?,'live',?,'fingerprint','{}',?,?,?,?,?,1)",
      );
      for (const [decision, reason, chatId, agentId, messageId] of [
        ["accepted", null, null, "agent", "input"],
        ["accepted", null, "chat", null, "input"],
        ["accepted", null, "chat", "agent", null],
        ["accepted", "why", "chat", "agent", "input"],
        ["skipped", null, null, null, null],
        ["skipped", "", null, null, null],
        ["skipped", "disabled", null, null, "input"],
        [null, null, null, null, null],
      ])
        expect(() =>
          trigger.run("bad", "project", "event", decision, reason, chatId, agentId, messageId),
        ).toThrow(/CHECK|NOT NULL/);
      expect(() =>
        trigger.run("bad", "other", "foreign", "skipped", "disabled", null, null, null),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        trigger.run(
          "bad",
          "project",
          "foreignchat",
          "accepted",
          null,
          "otherchat",
          "agent",
          "input",
        ),
      ).toThrow(/FOREIGN KEY/);
      trigger.run("skip", "project", "skip", "skipped", "disabled", null, null, null);
      expect(() =>
        trigger.run("duplicate", "project", "skip", "skipped", "disabled", null, null, null),
      ).toThrow(/UNIQUE/);
      const source = sqlite.prepare(
        "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,automation_trigger_id) VALUES (?,'chat',?,?, 'source',?)",
      );
      expect(() => source.run("source", "automation", "skip", null)).toThrow(/CHECK/);
      expect(() => source.run("source", "automation", "skip", "skip")).toThrow(/FOREIGN KEY/);
      expect(() => source.run("source", "human", "human", "skip")).toThrow(/CHECK/);
      expect(() => source.run("source", "automation", "missing", "missing")).toThrow(/FOREIGN KEY/);
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES ('chat','automation','skip')",
          )
          .run(),
      ).toThrow(/CHECK/);
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    }));
});
