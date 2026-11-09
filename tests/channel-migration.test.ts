import { expect, it } from "vite-plus/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../src/db/migrate";
import { openDatabase } from "../src/db/connection";

it("0048 is additive, preserves native/F1 rows and FKs, and never seeds historical delivery", () => {
  const directory = mkdtempSync(join(tmpdir(), "channel-upgrade-"));
  const file = join(directory, "upgrade.sqlite");
  const folder = join(directory, "before");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 48);
  for (const entry of journal.entries)
    copyFileSync(join("drizzle", `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  migrateDatabase(file, folder);
  const before = openDatabase(file);
  try {
    before.sqlite.exec(`
      INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('human','Human','channel@test.example',0,1,1);
      INSERT INTO project(id,name,created_by) VALUES ('project','Project','human');
      INSERT INTO agent_profile(id,name,purpose,created_by) VALUES ('assistant','Assistant','assistant','human');
      INSERT INTO project_member(project_id,agent_profile_id,added_by) VALUES ('project','assistant','human');
      INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES ('dm','project','dm','human','human','human');
      INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES ('dm','human','human'),('dm','agent','assistant');
      INSERT INTO message(id,chat_id,sender_kind,sender_id,body) VALUES ('history','dm','agent','assistant','Persist old output');
      INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES ('instance','assistant','dm','project');
      INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,settled_at,session_id) VALUES ('run','instance','dm','project','req','aborted',1,'instance');
      INSERT INTO feishu_identity_slot(human_id,revision,app_id,tenant_key,open_id) VALUES ('human',1,'app','tenant','open');
      INSERT INTO feishu_route(id,human_id,revision,app_id,tenant_key,open_id,project_id,chat_id,opened_at_ms) VALUES ('route','human',1,'app','tenant','open','project','dm',1000);
      INSERT INTO feishu_connection_epoch(id,app_id,opened_at_ms,opened_by) VALUES ('epoch','app',1000,'ready');
      INSERT INTO feishu_inbound_receipt(app_id,platform_message_id,route_id,epoch_id,message_id,created_at_ms) VALUES ('app','platform-old','route','epoch','history',1000);
    `);
    const tables = (
      before.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'__drizzle_migrations' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const oldRows = tables.map((name) => before.sqlite.prepare(`SELECT * FROM "${name}"`).all());
    const oldFKs = tables.map((name) => before.sqlite.pragma(`foreign_key_list("${name}")`));
    before.sqlite.close();
    migrateDatabase(file);
    migrateDatabase(file);
    const after = openDatabase(file);
    try {
      expect(tables.map((name) => after.sqlite.prepare(`SELECT * FROM "${name}"`).all())).toEqual(
        oldRows,
      );
      expect(tables.map((name) => after.sqlite.pragma(`foreign_key_list("${name}")`))).toEqual(
        oldFKs,
      );
      for (const name of [
        "channel_delivery",
        "channel_attempt",
        "channel_action_grant",
        "channel_action_receipt",
      ])
        expect(after.sqlite.prepare(`SELECT count(*) n FROM ${name}`).get()).toEqual({ n: 0 });
      expect(() =>
        after.sqlite
          .prepare(
            "INSERT INTO channel_attempt(id,delivery_id,number,armed_at_ms,outcome) VALUES ('a','missing',1,1,'armed')",
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);
      expect(after.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(after.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      after.sqlite.close();
    }
  } finally {
    if (before.sqlite.open) before.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
