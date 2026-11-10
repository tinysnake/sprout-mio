import { expect, it } from "vite-plus/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../src/db/migrate";
import { openDatabase } from "../src/db/connection";

function legacyDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "channel-config-upgrade-"));
  const file = join(directory, "upgrade.sqlite");
  const folder = join(directory, "before");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 49);
  for (const entry of journal.entries)
    copyFileSync(join("drizzle", `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  migrateDatabase(file, folder);
  const before = openDatabase(file);
  before.sqlite.exec(`
    INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('human','Human','upgrade@test.example',0,1,1);
    INSERT INTO project(id,name,created_by) VALUES ('project','Project','human'),('other','Other','human');
    INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES ('dm','project','dm','human','human','human'),('dm-other','other','dm','human','human','human');
    INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES ('dm','human','human'),('dm-other','human','human');
    INSERT INTO message(id,chat_id,sender_kind,sender_id,body) VALUES ('native','dm','human','human','Keep native history');
    INSERT INTO feishu_identity_slot(human_id,revision,app_id,tenant_key,open_id) VALUES ('human',3,'app','tenant','open');
  `);
  return { directory, file, before };
}

it("upgrades 0048 preserving bindings, history and durable delivery and dropping transient challenges", () => {
  const { directory, file, before } = legacyDatabase();
  try {
    before.sqlite.exec(`
      INSERT INTO feishu_route(id,human_id,revision,app_id,tenant_key,open_id,project_id,chat_id,opened_at_ms,closed_at_ms) VALUES ('old-route','human',1,'old-app','tenant','old-open','other','dm-other',1,2),('route','human',3,'app','tenant','open','project','dm',3,NULL);
      INSERT INTO feishu_challenge(hash,human_id,revision,project_id,chat_id,expires_at_ms) VALUES ('hash','human',3,'other','dm-other',999999);
      INSERT INTO feishu_connection_epoch(id,app_id,opened_at_ms,opened_by) VALUES ('epoch','app',1,'ready');
      INSERT INTO feishu_inbound_receipt(app_id,platform_message_id,route_id,epoch_id,message_id,created_at_ms) VALUES ('app','platform','route','epoch','native',3);
      INSERT INTO channel_delivery(id,adapter,message_id,route,envelope,state,uuid,created_at_ms,due_at_ms,deadline_ms) VALUES ('delivery','feishu','native','{}','{}','ready','uuid',1,1,100);
    `);
    const preserved = [
      "message",
      "chat",
      "feishu_route",
      "feishu_connection_epoch",
      "feishu_inbound_receipt",
      "channel_delivery",
    ];
    const rows = preserved.map((name) => before.sqlite.prepare(`SELECT * FROM ${name}`).all());
    before.sqlite.close();
    migrateDatabase(file);
    migrateDatabase(file);
    const after = openDatabase(file);
    try {
      expect(preserved.map((name) => after.sqlite.prepare(`SELECT * FROM ${name}`).all())).toEqual(
        rows,
      );
      // 0051 给挑战码加明文列，所以先丢掉十分钟内的临时码，不猜旧码的明文。
      expect(after.sqlite.prepare("SELECT * FROM feishu_challenge").all()).toHaveLength(0);
      expect(
        after.sqlite.prepare("SELECT * FROM feishu_identity_slot ORDER BY project_id").all(),
      ).toEqual([
        {
          human_id: "human",
          project_id: "other",
          revision: 3,
          app_id: null,
          tenant_key: null,
          open_id: null,
        },
        {
          human_id: "human",
          project_id: "project",
          revision: 3,
          app_id: "app",
          tenant_key: "tenant",
          open_id: "open",
        },
      ]);
      expect(after.sqlite.prepare("SELECT * FROM channel_config").all()).toEqual([]);
      expect(() =>
        after.sqlite.prepare("UPDATE feishu_route SET chat_id='dm-other' WHERE id='route'").run(),
      ).toThrow("feishu route is immutable");
      after.sqlite.exec(
        "INSERT INTO feishu_route(id,human_id,revision,app_id,tenant_key,open_id,project_id,chat_id,opened_at_ms) VALUES ('new-other','human',3,'other-app','tenant','other-open','other','dm-other',4)",
      );
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

it("refuses an unattributable legacy slot without losing or inventing data", () => {
  const { directory, file, before } = legacyDatabase();
  before.sqlite.close();
  try {
    expect(() => migrateDatabase(file)).toThrow("__feishu_project_attribution_guard");
    const after = openDatabase(file);
    try {
      expect(
        after.sqlite.prepare("SELECT human_id,app_id FROM feishu_identity_slot").all(),
      ).toEqual([{ human_id: "human", app_id: "app" }]);
      expect(after.sqlite.prepare("SELECT count(*) n FROM __drizzle_migrations").get()).toEqual({
        n: 49,
      });
      expect(
        after.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='channel_config'").get(),
      ).toBeUndefined();
    } finally {
      after.sqlite.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
