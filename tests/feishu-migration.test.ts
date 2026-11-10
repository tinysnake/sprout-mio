import { expect, it } from "vite-plus/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../src/db/migrate";
import { openDatabase } from "../src/db/connection";

it("0049/0050 preserve native data and initialize existing routes without admitting their old history", () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-upgrade-"));
  const file = join(directory, "upgrade.sqlite");
  function migrationsBefore(index: number, name: string) {
    const folder = join(directory, name);
    mkdirSync(join(folder, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < index);
    for (const entry of journal.entries)
      copyFileSync(join("drizzle", `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
    return folder;
  }
  migrateDatabase(file, migrationsBefore(49, "before"));
  const before = openDatabase(file);
  try {
    before.sqlite.exec(`
      INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('human','Human','feishu-upgrade@example.test',0,1,1);
      INSERT INTO project(id,name,created_by) VALUES ('project','Project','human');
      INSERT INTO agent_profile(id,name,purpose,created_by) VALUES ('assistant','Assistant','assistant','human');
      INSERT INTO project_member(project_id,agent_profile_id,added_by) VALUES ('project','assistant','human');
      INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES ('dm','project','dm','human','human','human'),('group','project','group','human','human','human');
      INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES ('dm','human','human'),('dm','agent','assistant');
      INSERT INTO message(id,chat_id,sender_kind,sender_id,body) VALUES ('old-message','dm','human','human','Keep native history');
      INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES ('instance','assistant','dm','project');
      INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,settled_at,session_id) VALUES ('old-run','instance','dm','project','req','aborted',1,'instance');
      INSERT INTO agent_run_input(run_id,message_id) VALUES ('old-run','old-message');
      INSERT INTO assistant_watch(id,assistant_chat_id,target_project_id,target_chat_id,consented_by,interval_seconds,consented_at) VALUES ('watch','dm','project','group','human',60,2000);
    `);
    const tableNames = (
      before.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'__drizzle_migrations' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const nativeRows = tableNames.map((name) =>
      before.sqlite.prepare(`SELECT * FROM "${name}"`).all(),
    );
    const foreignKeys = tableNames.map((name) =>
      before.sqlite.pragma(`foreign_key_list("${name}")`),
    );
    before.sqlite.close();
    migrateDatabase(file, migrationsBefore(50, "f1"));
    const established = openDatabase(file);
    try {
      established.sqlite.exec(`
        INSERT INTO feishu_identity_slot(human_id,revision,app_id,tenant_key,open_id) VALUES ('human',2,'app','tenant','account');
        INSERT INTO feishu_route(id,human_id,revision,app_id,tenant_key,open_id,project_id,chat_id) VALUES ('route-existing','human',2,'app','tenant','account','project','dm');
      `);
    } finally {
      established.sqlite.close();
    }
    const activationBoundary = Date.now();
    const through0051 = migrationsBefore(52, "through0051");
    migrateDatabase(file, through0051);
    migrateDatabase(file, through0051);
    const after = openDatabase(file);
    try {
      expect(
        tableNames.map((name) => after.sqlite.prepare(`SELECT * FROM "${name}"`).all()),
      ).toEqual(nativeRows);
      expect(tableNames.map((name) => after.sqlite.pragma(`foreign_key_list("${name}")`))).toEqual(
        foreignKeys,
      );
      const added = after.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'feishu_%' ORDER BY name",
        )
        .all() as { name: string }[];
      expect(added.map((row) => row.name)).toEqual([
        "feishu_challenge",
        "feishu_connection_epoch",
        "feishu_identity_slot",
        "feishu_inbound_receipt",
        "feishu_route",
      ]);
      for (const { name } of added)
        expect(after.sqlite.prepare(`SELECT count(*) n FROM ${name}`).get()).toEqual({
          n: name === "feishu_identity_slot" || name === "feishu_route" ? 1 : 0,
        });
      const route = after.sqlite.prepare("SELECT * FROM feishu_route").get() as {
        opened_at_ms: number;
      };
      expect(route).toMatchObject({
        id: "route-existing",
        human_id: "human",
        revision: 2,
        app_id: "app",
        tenant_key: "tenant",
        open_id: "account",
        project_id: "project",
        chat_id: "dm",
        closed_at_ms: null,
      });
      expect(route.opened_at_ms).toBeGreaterThanOrEqual(activationBoundary);
      expect(route.opened_at_ms).toBeLessThanOrEqual(Date.now());
      expect(() => after.sqlite.prepare("UPDATE feishu_route SET opened_at_ms=1").run()).toThrow(
        "feishu route is immutable",
      );
      expect(() =>
        after.sqlite
          .prepare(
            "INSERT INTO feishu_route(id,human_id,revision,app_id,tenant_key,open_id,project_id,chat_id) VALUES ('missing-time','human',3,'app','tenant','account','project','dm')",
          )
          .run(),
      ).toThrow("feishu route activation required");
      expect(() =>
        after.sqlite
          .prepare(
            "INSERT INTO feishu_identity_slot(human_id,revision,app_id) VALUES ('human',1,'partial-identity')",
          )
          .run(),
      ).toThrow(/feishu_slot_identity/);
      expect(() =>
        after.sqlite
          .prepare("INSERT INTO feishu_identity_slot(human_id) VALUES ('missing-human')")
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
