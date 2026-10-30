import { describe, expect, it } from "vite-plus/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../src/db/migrate";
import { openDatabase, type DatabaseConnection } from "../src/db/connection";

const triggers = [
  "task_insert_proposed",
  "task_status_transition",
  "task_revision_monotone",
  "task_finished_record",
  "message_task_append_guard",
  "message_task_no_update",
  "message_task_no_delete",
  "task_event_no_update",
  "task_event_no_delete",
  "task_event_boundary",
  "agent_run_no_task_assistant",
  "agent_run_no_task_assistant_update",
  "task_input_admission_guard",
  "task_input_admission_guard_insert",
  "task_checklist_append_position",
  "task_checklist_identity_immutable",
  "task_checklist_no_delete",
];
function seed({ sqlite }: DatabaseConnection) {
  sqlite.exec(`INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('usr_seed','Seed','seed@migration.test',0,1,1);
    INSERT INTO project(id,name,created_by) VALUES ('prj_seed','Seed','usr_seed'),('prj_other','Other','usr_seed');
    INSERT INTO agent_profile(id,name,created_by) VALUES ('agt_seed','Seed Agent','usr_seed');
    INSERT INTO project_member(project_id,agent_profile_id,added_by) VALUES ('prj_seed','agt_seed','usr_seed');
    INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES ('cht_seed','prj_seed','group','human','usr_seed','usr_seed'),('cht_other','prj_seed','group','human','usr_seed','usr_seed');
    INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES ('cht_seed','human','usr_seed'),('cht_seed','agent','agt_seed');
    INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES ('ins_seed','agt_seed','cht_seed','prj_seed');
    INSERT INTO message(id,chat_id,sender_kind,sender_id,body) VALUES ('msg_seed','cht_seed','human','usr_seed','old input'),('msg_assistant','cht_seed','agent','agt_seed','old assistant'),('msg_other','cht_other','human','usr_seed','other chat');
    INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,session_id,started_at,settled_at,stop_reason,config_snapshot,assistant_message_id) VALUES ('run_seed','ins_seed','cht_seed','prj_seed','req_seed','completed','ins_seed',1,2,'stop','{}','msg_assistant');
    INSERT INTO agent_run_input(run_id,message_id,disposition,delivered_at) VALUES ('run_seed','msg_seed','delivered',2);`);
}
function fresh<T>(test: (connection: DatabaseConnection, file: string, directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "p5b-task-migration-"));
  const file = join(directory, "migration.sqlite");
  migrateDatabase(file);
  const connection = openDatabase(file);
  try {
    seed(connection);
    return test(connection, file, directory);
  } finally {
    connection.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
function rawTask(connection: DatabaseConnection, id = "tsk_seed") {
  connection.sqlite
    .prepare(
      "INSERT INTO task(id,project_id,title,created_by,created_at,updated_at) VALUES (?,'prj_seed','Task','usr_seed',1000,1000)",
    )
    .run(id);
  connection.sqlite
    .prepare(
      "UPDATE task SET status='assigned', chat_id='cht_seed', revision=2, assignment_revision=1 WHERE id=?",
    )
    .run(id);
}
function record(connection: DatabaseConnection, kind = "progress", id = "msg_record", seq = 1) {
  connection.sqlite
    .prepare(
      "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,task_id,task_project_id,task_record_seq,task_record_kind) VALUES (?,'cht_seed','human','usr_seed','record body','tsk_seed','prj_seed',?,?)",
    )
    .run(id, seq, kind);
}

describe("0025 Task migration from zero and populated 0024", () => {
  it("migrates from zero, remains idempotent and installs every trigger with FK/integrity checks", () =>
    fresh(({ sqlite }, file) => {
      const before = sqlite.prepare("SELECT * FROM message ORDER BY id").all();
      const migrations = sqlite.prepare("SELECT * FROM __drizzle_migrations ORDER BY id").all();
      expect(migrations).toHaveLength(
        JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries.length,
      );
      migrateDatabase(file);
      expect(sqlite.prepare("SELECT * FROM __drizzle_migrations ORDER BY id").all()).toEqual(
        migrations,
      );
      expect(sqlite.prepare("SELECT * FROM message ORDER BY id").all()).toEqual(before);
      const names = (
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      expect(names).toEqual(expect.arrayContaining(triggers));
      expect(names).toContain("chat_member_no_channel_insert");
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    }));

  it("preserves old message bodies, same-Chat assistant FK and input disposition; every new column starts NULL", () => {
    const directory = mkdtempSync(join(tmpdir(), "p5b-upgrade-0024-"));
    const file = join(directory, "upgrade.sqlite");
    const oldFolder = join(directory, "old-drizzle");
    mkdirSync(join(oldFolder, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 24);
    for (const entry of journal.entries)
      copyFileSync(join("drizzle", `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`));
    writeFileSync(join(oldFolder, "meta", "_journal.json"), JSON.stringify(journal));
    migrateDatabase(file, oldFolder);
    const before = openDatabase(file);
    seed(before);
    const oldMessages = before.sqlite.prepare("SELECT * FROM message ORDER BY id").all() as Record<
      string,
      unknown
    >[];
    const oldRuns = before.sqlite.prepare("SELECT * FROM agent_run ORDER BY id").all();
    const oldInputs = before.sqlite
      .prepare("SELECT * FROM agent_run_input ORDER BY run_id,message_id")
      .all() as Record<string, unknown>[];
    before.sqlite.close();
    migrateDatabase(file);
    const after = openDatabase(file);
    try {
      const messages = after.sqlite.prepare("SELECT * FROM message ORDER BY id").all() as Record<
        string,
        unknown
      >[];
      for (const [index, old] of oldMessages.entries()) {
        expect(messages[index]).toMatchObject(old);
        expect(
          Object.entries(messages[index]!)
            .filter(([key]) => key.startsWith("task_"))
            .map(([, value]) => value),
        ).toEqual(Array(9).fill(null));
      }
      expect(after.sqlite.prepare("SELECT * FROM agent_run ORDER BY id").all()).toEqual(oldRuns);
      expect(
        after.sqlite.prepare("SELECT * FROM agent_run_input ORDER BY run_id,message_id").all(),
      ).toEqual(oldInputs.map((row) => ({ ...row, admitted_at: null })));
      expect(() =>
        after.sqlite
          .prepare("UPDATE agent_run SET assistant_message_id='msg_other' WHERE id='run_seed'")
          .run(),
      ).toThrow(/FOREIGN KEY/);
      expect(after.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(after.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      after.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("direct SQL counterexamples for frozen Task invariants", () => {
  it("rejects non-proposed inserts, illegal state edges and non-monotone revisions; CHECK independently rejects impossible four-state/Chat combinations", () =>
    fresh((connection) => {
      const { sqlite } = connection;
      const insert = sqlite.prepare(
        "INSERT INTO task(id,project_id,chat_id,status,title,created_by,created_at,updated_at) VALUES (?,'prj_seed',?,?,'Task','usr_seed',1000,1000)",
      );
      expect(() => insert.run("tsk_illegal", "cht_seed", "assigned")).toThrow(
        /task_invalid_transition/,
      );
      rawTask(connection);
      expect(() => sqlite.exec("UPDATE task SET revision=2 WHERE id='tsk_seed'")).toThrow(
        /task_revision_conflict/,
      );
      expect(() =>
        sqlite.exec("UPDATE task SET revision=3,assignment_revision=0 WHERE id='tsk_seed'"),
      ).toThrow(/task_revision_conflict/);
      sqlite.exec("SAVEPOINT lifecycle_check; DROP TRIGGER task_insert_proposed;");
      try {
        for (const [status, chatId] of [
          ["proposed", "cht_seed"],
          ["assigned", null],
          ["finished", null],
          ["started", null],
        ] as const)
          expect(() => insert.run(`tsk_bad_${status}`, chatId, status)).toThrow(/CHECK/);
        for (const [status, chatId] of [
          ["proposed", null],
          ["assigned", "cht_seed"],
          ["finished", "cht_seed"],
          ["canceled", null],
          ["canceled", "cht_seed"],
        ] as const)
          expect(() =>
            insert.run(`tsk_good_${status}_${chatId ?? "none"}`, chatId, status),
          ).not.toThrow();
      } finally {
        sqlite.exec("ROLLBACK TO lifecycle_check; RELEASE lifecycle_check;");
      }
      sqlite.exec(
        "UPDATE task SET status='canceled',revision=3,assignment_revision=2 WHERE id='tsk_seed'",
      );
      expect(() =>
        sqlite.exec("UPDATE task SET status='finished',revision=4 WHERE id='tsk_seed'"),
      ).toThrow(/task_invalid_transition|task_record_required/);
      expect(() =>
        sqlite.exec(
          "UPDATE task SET status='proposed',revision=4,chat_id=NULL WHERE id='tsk_seed'",
        ),
      ).toThrow(/task_invalid_transition/);
    }));

  it("requires a progress/correction result and permanently freezes record bodies and event boundaries", () =>
    fresh((connection) => {
      const { sqlite } = connection;
      rawTask(connection);
      expect(() =>
        sqlite.exec("UPDATE task SET status='finished',revision=3 WHERE id='tsk_seed'"),
      ).toThrow(/task_record_required/);
      expect(() => record(connection, "progress", "msg_gap", 2)).toThrow(/task_record_invalid/);
      record(connection);
      expect(() => sqlite.exec("UPDATE message SET body='changed' WHERE id='msg_record'")).toThrow(
        /task_record_immutable/,
      );
      expect(() => sqlite.exec("UPDATE message SET task_id=NULL WHERE id='msg_record'")).toThrow(
        /task_record_immutable/,
      );
      expect(() =>
        sqlite.exec("UPDATE message SET task_id='tsk_seed' WHERE id='msg_seed'"),
      ).toThrow(/task_record_immutable/);
      expect(() => sqlite.exec("DELETE FROM message WHERE id='msg_record'")).toThrow(
        /task_record_immutable/,
      );
      const event = sqlite.prepare(
        "INSERT INTO task_event(id,task_id,project_id,seq,action,actor_kind,actor_id,from_status,to_status,from_chat_id,to_chat_id,record_seq_at_event,created_at) VALUES (?,'tsk_seed','prj_seed',?,'record_append','human','usr_seed','assigned',?,'cht_seed',?, ?,1000)",
      );
      expect(() => event.run("tev_bad_seq", 99, "assigned", "cht_seed", 1)).toThrow(
        /task_event_invalid/,
      );
      expect(() => event.run("tev_bad_boundary", 2, "assigned", "cht_seed", null)).toThrow(
        /task_event_invalid/,
      );
      expect(() => event.run("tev_bad_chat", 2, "assigned", "cht_other", 1)).toThrow(
        /task_event_invalid/,
      );
      event.run("tev_valid", 2, "assigned", "cht_seed", 1);
      expect(() =>
        sqlite.exec("UPDATE task_event SET actor_id='someone' WHERE id='tev_valid'"),
      ).toThrow(/task_event_immutable/);
      expect(() => sqlite.exec("DELETE FROM task_event WHERE id='tev_valid'")).toThrow(
        /task_event_immutable/,
      );
      sqlite.exec(
        "UPDATE task SET status='finished',revision=3,assignment_revision=2 WHERE id='tsk_seed'",
      );
      expect(() => record(connection, "progress", "msg_terminal", 2)).toThrow(
        /task_record_invalid/,
      );
      record(connection, "correction", "msg_correction", 2);
      expect(() => sqlite.exec("UPDATE task SET revision=4 WHERE id='tsk_seed'")).not.toThrow();
      expect(() => sqlite.exec("DELETE FROM task WHERE id='tsk_seed'")).toThrow(/FOREIGN KEY/);
    }));

  it("guards Agent author identity/activity, current Chat and references; a Task record cannot become a run assistant", () =>
    fresh((connection) => {
      const { sqlite } = connection;
      rawTask(connection);
      const agentRecord = sqlite.prepare(
        "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,task_id,task_project_id,task_record_seq,task_record_kind,task_author_run_id) VALUES (?,'cht_seed','agent',?,'Agent record','tsk_seed','prj_seed',1,'progress',?)",
      );
      expect(() => agentRecord.run("msg_inactive", "agt_seed", "run_seed")).toThrow(
        /task_record_invalid/,
      );
      sqlite.exec(
        "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,session_id) VALUES ('run_active','ins_seed','cht_seed','prj_seed','req_active','queued','ins_seed')",
      );
      expect(() => agentRecord.run("msg_spoof", "agt_other", "run_active")).toThrow(
        /task_record_invalid/,
      );
      expect(() =>
        sqlite.exec(
          "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,task_id,task_project_id,task_record_seq,task_record_kind) VALUES ('msg_wrongchat','cht_other','human','usr_seed','wrong chat','tsk_seed','prj_seed',1,'progress')",
        ),
      ).toThrow(/task_record_invalid/);
      expect(() =>
        sqlite.exec(
          "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,task_id,task_project_id,task_record_seq,task_record_kind,task_reference_message_id) VALUES ('msg_badref','cht_seed','human','usr_seed','bad ref','tsk_seed','prj_seed',1,'progress','msg_other')",
        ),
      ).toThrow(/FOREIGN KEY/);
      agentRecord.run("msg_agent", "agt_seed", "run_active");
      expect(() =>
        sqlite.exec("UPDATE agent_run SET assistant_message_id='msg_agent' WHERE id='run_active'"),
      ).toThrow(/task_record_not_assistant/);
      expect(() =>
        sqlite.exec(
          "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,session_id,assistant_message_id) VALUES ('run_invalid','ins_seed','cht_seed','prj_seed','req_bad','queued','ins_seed','msg_agent')",
        ),
      ).toThrow(/task_record_not_assistant/);
      expect(() =>
        sqlite.exec(
          "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,task_id,task_project_id,task_record_seq,task_record_kind) VALUES ('msg_missingrun','cht_seed','agent','agt_seed','bad author','tsk_seed','prj_seed',2,'progress')",
        ),
      ).toThrow(/CHECK|task_record_invalid/);
      expect(() =>
        sqlite.exec("UPDATE task SET project_id='prj_other',revision=3 WHERE id='tsk_seed'"),
      ).toThrow(/FOREIGN KEY/);
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    }));

  it("keeps checklist positions stable across soft deletion and prevents bypass/reuse", () =>
    fresh((connection) => {
      const { sqlite } = connection;
      rawTask(connection);
      const insert = sqlite.prepare(
        "INSERT INTO task_checklist_item(id,task_id,position,body,created_at,updated_at) VALUES (?,'tsk_seed',?,'item',1000,1000)",
      );
      insert.run("tci_one", 1);
      expect(() => insert.run("tci_gap", 3)).toThrow(/task_checklist_invalid/);
      expect(() =>
        sqlite.exec("UPDATE task_checklist_item SET position=2 WHERE id='tci_one'"),
      ).toThrow(/task_checklist_invalid/);
      sqlite.exec(
        "UPDATE task_checklist_item SET removed_at=1001,updated_at=1001 WHERE id='tci_one'",
      );
      expect(() =>
        sqlite.exec("UPDATE task_checklist_item SET removed_at=NULL WHERE id='tci_one'"),
      ).toThrow(/task_checklist_invalid/);
      expect(() => sqlite.exec("DELETE FROM task_checklist_item WHERE id='tci_one'")).toThrow(
        /task_checklist_invalid/,
      );
      expect(() => insert.run("tci_reuse", 1)).toThrow(/task_checklist_invalid|UNIQUE/);
      insert.run("tci_two", 2);
      expect(
        sqlite.prepare("SELECT position FROM task_checklist_item ORDER BY position").all(),
      ).toEqual([{ position: 1 }, { position: 2 }]);
    }));

  it("admits only start records and forbids clearing/changing the attempted boundary", () =>
    fresh((connection) => {
      const { sqlite } = connection;
      rawTask(connection);
      record(connection);
      sqlite.exec(
        "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,session_id) VALUES ('run_active','ins_seed','cht_seed','prj_seed','req_active','queued','ins_seed')",
      );
      expect(() =>
        sqlite.exec("UPDATE agent_run_input SET admitted_at=1000 WHERE message_id='msg_seed'"),
      ).toThrow(/task_input_invalid/);
      expect(() =>
        sqlite.exec(
          "INSERT INTO agent_run_input(run_id,message_id,admitted_at) VALUES ('run_active','msg_record',1000)",
        ),
      ).toThrow(/task_input_invalid/);
      sqlite.exec(
        "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,task_id,task_project_id,task_record_seq,task_record_kind,task_assignment_revision,task_governance_revision,task_start_recipient_id) VALUES ('msg_start','cht_seed','human','usr_seed','start','tsk_seed','prj_seed',2,'start',1,0,'agt_seed'); INSERT INTO agent_run_input(run_id,message_id) VALUES ('run_active','msg_start'); UPDATE agent_run_input SET admitted_at=1000 WHERE message_id='msg_start';",
      );
      expect(() =>
        sqlite.exec("UPDATE agent_run_input SET admitted_at=NULL WHERE message_id='msg_start'"),
      ).toThrow(/task_input_invalid/);
      expect(() =>
        sqlite.exec("UPDATE agent_run_input SET admitted_at=1001 WHERE message_id='msg_start'"),
      ).toThrow(/task_input_invalid/);
      expect(() =>
        sqlite.exec(
          "UPDATE agent_run_input SET disposition='delivered',delivered_at=2 WHERE message_id='msg_start'",
        ),
      ).not.toThrow();
      expect(() =>
        sqlite.exec("UPDATE task SET status='finished',revision=3 WHERE id='tsk_seed'"),
      ).toThrow(/task_record_required/);
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    }));
});
