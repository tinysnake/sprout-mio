import { expect, it } from "vite-plus/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../src/db/migrate";
import { openDatabase } from "../src/db/connection";

it("0043 preserves rule receipts and Human watch consent, adopts legacy intervals and retains immutable-source guards", () => {
  const directory = mkdtempSync(join(tmpdir(), "feedback-upgrade-"));
  const file = join(directory, "upgrade.sqlite");
  const oldFolder = join(directory, "old");
  mkdirSync(join(oldFolder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 42);
  for (const entry of journal.entries)
    copyFileSync(join("drizzle", `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`));
  writeFileSync(join(oldFolder, "meta/_journal.json"), JSON.stringify(journal));
  try {
    migrateDatabase(file, oldFolder);
    const before = openDatabase(file);
    before.sqlite.exec(`
      INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('human','Human','feedback@test.example',0,1,1);
      INSERT INTO project(id,name,created_by) VALUES ('project','Project','human');
      INSERT INTO agent_profile(id,name,created_by) VALUES ('worker','Worker','human');
      INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES ('source','project','dm','human','human','human'),('target','project','group','human','human','human'),('source2','project','dm','human','human','human');
      INSERT INTO webhook_rule(id,project_id,created_by,name,enabled,revision,instruction,action,source,secret_digest,created_at,updated_at) VALUES ('rule','project','human','Existing webhook',1,3,'Instruction','{"kind":"group_owner","chatId":"target"}','webhook','${"a".repeat(64)}',1,2);
      INSERT INTO webhook_trigger(id,rule_id,project_id,mode,event_id,fingerprint,snapshot,source,decision,reason,created_at) VALUES ('receipt','rule','project','trial','event','fp','{}','webhook','skipped','rule_disabled',1);
      INSERT INTO assistant_preferences VALUES ('source',120);
      INSERT INTO assistant_watch VALUES ('watch','source','project','target','human',1000,NULL),('revoked-watch','source2','project','target','human',1000,2000);
    `);
    const originalRule = before.sqlite.prepare("SELECT * FROM webhook_rule").get();
    const originalReceipt = before.sqlite.prepare("SELECT * FROM webhook_trigger").get();
    const originalWatch = before.sqlite.prepare("SELECT * FROM assistant_watch").get();
    before.sqlite.close();
    migrateDatabase(file);
    migrateDatabase(file);
    const { sqlite } = openDatabase(file);
    try {
      expect(sqlite.prepare("SELECT * FROM webhook_rule").get()).toEqual({
        ...(originalRule as object),
        recoverable_secret: null,
      });
      expect(sqlite.prepare("SELECT * FROM webhook_trigger").get()).toEqual(originalReceipt);
      expect(sqlite.prepare("SELECT * FROM assistant_watch").get()).toEqual({
        ...(originalWatch as object),
        interval_seconds: 120,
      });
      expect(
        sqlite
          .prepare(
            "SELECT interval_seconds,revoked_at FROM assistant_watch WHERE id='revoked-watch'",
          )
          .get(),
      ).toEqual({ interval_seconds: 300, revoked_at: 2000 });
      sqlite
        .prepare("UPDATE webhook_rule SET action=? WHERE id='rule'")
        .run(JSON.stringify({ kind: "dm_agent", agentProfileId: "worker" }));
      sqlite.exec("UPDATE assistant_watch SET interval_seconds=60 WHERE id='watch'");
      for (const assignment of [
        "target_chat_id='source'",
        "consented_by='other'",
        "consented_at=2000",
        "assistant_chat_id='target'",
      ])
        expect(() =>
          sqlite.exec(`UPDATE assistant_watch SET ${assignment} WHERE id='watch'`),
        ).toThrow(/consent is immutable/);
      for (const interval of [0, 59, 86401, 120.5])
        expect(() =>
          sqlite
            .prepare("UPDATE assistant_watch SET interval_seconds=? WHERE id='watch'")
            .run(interval),
        ).toThrow(/CHECK/);
      expect(() => sqlite.exec("UPDATE webhook_rule SET source='cron' WHERE id='rule'")).toThrow(
        /source_immutable/,
      );
      expect(() =>
        sqlite.exec("UPDATE webhook_trigger SET source='cron' WHERE id='receipt'"),
      ).toThrow(/immutable/);
      expect(() =>
        sqlite.exec(
          "INSERT INTO webhook_trigger(id,rule_id,project_id,mode,event_id,fingerprint,snapshot,source,decision,reason,created_at) VALUES ('forged','rule','project','trial','forged','fp','{}','cron','skipped','rule_disabled',1)",
        ),
      ).toThrow(/source_invalid/);
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      sqlite.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
