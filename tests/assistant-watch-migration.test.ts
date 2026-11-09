import { expect, it } from "vite-plus/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../src/db/migrate";
import { openDatabase } from "../src/db/connection";

it("0044 preserves old consent, baselines existing content and resolves only processed/superseded watch intents", () => {
  const directory = mkdtempSync(join(tmpdir(), "assistant-watch-upgrade-"));
  const file = join(directory, "upgrade.sqlite");
  const oldFolder = join(directory, "old");
  mkdirSync(join(oldFolder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 43);
  for (const entry of journal.entries)
    copyFileSync(join("drizzle", `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`));
  writeFileSync(join(oldFolder, "meta", "_journal.json"), JSON.stringify(journal));
  migrateDatabase(file, oldFolder);
  const before = openDatabase(file);
  try {
    before.sqlite.exec(`
      INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('human','Human','watch-upgrade@test.example',0,1,1);
      INSERT INTO project(id,name,created_by) VALUES ('project','Project','human');
      INSERT INTO agent_profile(id,name,purpose,created_by) VALUES ('assistant','Assistant','assistant','human'),('worker','Worker','worker','human');
      INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES ('dm','project','dm','human','human','human'),('target','project','group','human','human','human');
      INSERT INTO assistant_watch(id,assistant_chat_id,target_project_id,target_chat_id,consented_by,interval_seconds,consented_at) VALUES ('live','dm','project','target','human',60,2000);
      INSERT INTO message(id,chat_id,sender_kind,sender_id,body) VALUES ('old-message','target','human','human','Do not backfill this history');
      INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES ('instance','worker','target','project');
      INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,settled_at,session_id) VALUES ('old-run','instance','target','project','req','aborted',1,'instance');
      INSERT INTO assistant_interest VALUES ('dm','old-run','watch','live');
      INSERT INTO assistant_run_cursor(assistant_chat_id,run_id,next_due_at) VALUES ('dm','old-run',1000);
    `);
    const insert = before.sqlite.prepare(
      "INSERT INTO assistant_event(id,assistant_chat_id,event_key,fact,created_at) VALUES (?,'dm',?,?,?)",
    );
    const intent = (targetChatId: string) =>
      JSON.stringify({
        kind: "decision",
        watchIntent: true,
        targetProjectId: "project",
        targetChatId,
        intervalSeconds: 60,
        body: "Approve watch?",
      });
    insert.run("consumed", "consumed", intent("target"), 1000);
    insert.run("new-for-same-target", "new-for-same-target", intent("target"), 3000);
    insert.run("superseded", "superseded", intent("other-target"), 4000);
    insert.run("latest", "latest", intent("other-target"), 4000);
    insert.run(
      "pending-legacy-run",
      "pending-legacy-run",
      JSON.stringify({
        kind: "intervention",
        runId: "old-run",
        targetProjectId: "project",
        targetChatId: "target",
        body: "Legacy immediate result",
      }),
      4000,
    );
    const consent = before.sqlite.prepare("SELECT * FROM assistant_watch").all();
    const history = before.sqlite.prepare("SELECT rowid,* FROM message").all();
    const terminal = before.sqlite.prepare("SELECT * FROM agent_run").all();
    before.sqlite.close();
    migrateDatabase(file);
    migrateDatabase(file);
    const { sqlite } = openDatabase(file);
    try {
      expect(sqlite.prepare("SELECT * FROM assistant_watch").all()).toEqual(consent);
      expect(sqlite.prepare("SELECT rowid,* FROM message").all()).toEqual(history);
      expect(sqlite.prepare("SELECT * FROM agent_run").all()).toEqual(terminal);
      const cursor = sqlite
        .prepare("SELECT * FROM assistant_watch_cursor WHERE watch_id='live'")
        .get() as { window_started_at: number; next_due_at: number; message_rowid: number };
      expect(cursor.window_started_at).toBeGreaterThan(4000);
      expect(cursor.next_due_at - cursor.window_started_at).toBe(60000);
      expect(cursor.message_rowid).toBe(1);
      const events = sqlite
        .prepare("SELECT id,decision_resolved_at FROM assistant_event ORDER BY rowid")
        .all() as { id: string; decision_resolved_at: number | null }[];
      expect(
        events
          .filter((e) => e.decision_resolved_at === null && e.id !== "pending-legacy-run")
          .map((e) => e.id),
      ).toEqual(["new-for-same-target", "latest"]);
      const captured = sqlite
        .prepare("SELECT terminal_captured_at FROM assistant_run_cursor")
        .get() as { terminal_captured_at: number };
      expect(captured.terminal_captured_at).toBeGreaterThanOrEqual(cursor.window_started_at - 1000);
      expect(captured.terminal_captured_at).toBeLessThanOrEqual(cursor.window_started_at);
      expect(() =>
        sqlite.prepare("UPDATE assistant_watch SET consented_at=3000 WHERE id='live'").run(),
      ).toThrow(/consent is immutable/);
      const suppressed = sqlite
        .prepare(
          "SELECT message_id,suppressed_at FROM assistant_event WHERE id='pending-legacy-run'",
        )
        .get() as { message_id: string | null; suppressed_at: number };
      expect(suppressed.message_id).toBeNull();
      expect(suppressed.suppressed_at).toBeGreaterThanOrEqual(cursor.window_started_at - 1000);
      expect(suppressed.suppressed_at).toBeLessThanOrEqual(cursor.window_started_at);
      expect(sqlite.prepare("SELECT * FROM assistant_watch_summary").all()).toEqual([]);
      expect(
        sqlite
          .prepare("SELECT count(*) n FROM assistant_event WHERE decision_rejected_at IS NOT NULL")
          .get(),
      ).toEqual({ n: 0 });
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      sqlite.close();
    }
  } finally {
    if (before.sqlite.open) before.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
