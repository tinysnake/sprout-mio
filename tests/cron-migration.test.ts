import { expect, it } from "vite-plus/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../src/db/migrate";
import { openDatabase } from "../src/db/connection";

it("0041 preserves populated webhook rows/identities and enforces source/config/receipt invariants", () => {
  const directory = mkdtempSync(join(tmpdir(), "cron-upgrade-"));
  const file = join(directory, "upgrade.sqlite");
  const oldFolder = join(directory, "old");
  mkdirSync(join(oldFolder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 40);
  for (const entry of journal.entries)
    copyFileSync(join("drizzle", `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`));
  writeFileSync(join(oldFolder, "meta", "_journal.json"), JSON.stringify(journal));
  migrateDatabase(file, oldFolder);
  const before = openDatabase(file);
  before.sqlite.exec(`
    INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('human','Human','cron-migrate@test.example',0,1,1);
    INSERT INTO project(id,name,created_by) VALUES ('project','Project','human');
    INSERT INTO agent_profile(id,name,created_by) VALUES ('agent','Agent','human');
    INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES ('chat','project','group','human','human','human');
    INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES ('instance','agent','chat','project');
    INSERT INTO webhook_rule VALUES ('rule','project','human','Webhook',1,3,'Instruction','{"kind":"group_owner","chatId":"chat"}','${"a".repeat(64)}',1,1);
    BEGIN IMMEDIATE;
    PRAGMA defer_foreign_keys=ON;
    INSERT INTO webhook_trigger VALUES ('receipt','rule','project','live','live-event','fingerprint','{"revision":3,"instruction":"Instruction","action":{"kind":"group_owner","chatId":"chat"},"enabled":true,"createdBy":"human"}','accepted',NULL,'chat','agent','source',1);
    INSERT INTO message(id,chat_id,sender_kind,sender_id,body,automation_trigger_id) VALUES ('source','chat','automation','receipt','{"instruction":"Instruction","event":{}}','receipt');
    COMMIT;
    INSERT INTO webhook_trigger VALUES ('trial','rule','project','trial','trial-event','fingerprint','{}','skipped','rule_disabled',NULL,NULL,NULL,1);
    INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,session_id) VALUES ('run','instance','chat','project','request','queued','instance');
    INSERT INTO agent_run_input(run_id,message_id) VALUES ('run','source');
    INSERT INTO task(id,project_id,title,created_by,created_at,updated_at) VALUES ('task','project','Task','human',1,1);
  `);
  const rows = (sqlite: typeof before.sqlite, table: string) =>
    sqlite.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all();
  const old = Object.fromEntries(
    ["webhook_rule", "webhook_trigger", "message", "agent_run_input", "agent_run", "task"].map(
      (table) => [table, rows(before.sqlite, table)],
    ),
  );
  before.sqlite.close();
  try {
    migrateDatabase(file);
    migrateDatabase(file);
    const { sqlite } = openDatabase(file);
    try {
      for (const table of ["message", "agent_run_input", "agent_run", "task"])
        expect(rows(sqlite, table)).toEqual(
          table === "message"
            ? old[table].map((row) => ({
                ...(row as object),
                assistant_event_id: null,
                assistant_proposal_id: null,
              }))
            : table === "agent_run_input"
              ? old[table].map((row) => ({
                  ...(row as object),
                  assistant_context: null,
                  assistant_context_submitted_at: null,
                }))
              : old[table],
        );
      expect(rows(sqlite, "webhook_rule")).toEqual(
        old.webhook_rule.map((row) => ({
          ...(row as object),
          source: "webhook",
          recoverable_secret: null,
          expression: null,
          timezone: null,
          next_at: null,
        })),
      );
      expect(rows(sqlite, "webhook_trigger")).toEqual(
        old.webhook_trigger.map((row) => ({ ...(row as object), source: "webhook" })),
      );
      const insert = sqlite.prepare(
        "INSERT INTO webhook_rule(id,project_id,created_by,name,enabled,revision,instruction,action,source,secret_digest,expression,timezone,next_at,created_at,updated_at) VALUES ('cron','project','human','Cron',?,0,'Instruction','{\"kind\":\"group_owner\",\"chatId\":\"chat\"}',?,?,?,?,?,1,1)",
      );
      for (const args of [
        [1, "cron", null, null, "UTC", 1],
        [1, "cron", null, "* * * * *", null, 1],
        [1, "cron", null, "* * * * *", "UTC", null],
        [0, "cron", null, "* * * * *", "UTC", 1],
        [1, "cron", "a".repeat(64), "* * * * *", "UTC", 1],
        [1, "webhook", null, null, null, null],
        [1, "webhook", "a".repeat(64), "* * * * *", null, null],
        [1, "unknown", null, null, null, null],
      ])
        expect(() => insert.run(...args)).toThrow(/CHECK/);
      insert.run(1, "cron", null, "* * * * *", "UTC", 1);
      expect(() =>
        sqlite.prepare("UPDATE webhook_rule SET source='webhook' WHERE id='cron'").run(),
      ).toThrow(/source_immutable/);
      const receipt = sqlite.prepare(
        "INSERT INTO webhook_trigger(id,rule_id,project_id,mode,event_id,fingerprint,snapshot,source,decision,reason,created_at) VALUES ('cron-receipt',?,'project','trial','event','fp',?,?,'skipped','rule_disabled',1)",
      );
      const snapshot = JSON.stringify({
        cron: { expression: "* * * * *", timezone: "UTC", scheduledAt: null },
      });
      expect(() => receipt.run("cron", snapshot, "webhook")).toThrow(/source_invalid/);
      expect(() => receipt.run("rule", snapshot, "cron")).toThrow(/source_invalid/);
      expect(() => receipt.run("cron", "{}", "cron")).toThrow(/source_invalid/);
      receipt.run("cron", snapshot, "cron");
      expect(() =>
        sqlite.prepare("UPDATE webhook_trigger SET source='webhook' WHERE id='cron-receipt'").run(),
      ).toThrow(/immutable/);
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      sqlite.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
