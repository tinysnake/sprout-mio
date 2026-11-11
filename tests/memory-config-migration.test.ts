import { expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../src/db/migrate";
import { openDatabase } from "../src/db/connection";

it("creates both memory tables with defaults, keys and checks", () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-config-"));
  const file = join(directory, "memory.sqlite");
  try {
    migrateDatabase(file);
    const db = openDatabase(file);
    try {
      db.sqlite.exec(`
        INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('human','Human','memory@test.example',0,1,1);
        INSERT INTO project(id,name,created_by) VALUES ('project','Project','human');
        INSERT INTO machine(id,name,created_by,created_at,updated_at) VALUES ('machine','Machine','human',1,1);
      `);

      expect(
        db.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memory_config','memory_install') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "memory_config" }, { name: "memory_install" }]);

      db.sqlite
        .prepare(
          "INSERT INTO memory_config(project_id,provider,updated_at_ms) VALUES ('project','hindsight',10)",
        )
        .run();
      expect(
        db.sqlite
          .prepare(
            "SELECT enabled,settings,secrets,revision,updated_by_human_id FROM memory_config WHERE project_id='project'",
          )
          .get(),
      ).toEqual({
        enabled: 1,
        settings: "{}",
        secrets: "{}",
        revision: 0,
        updated_by_human_id: null,
      });

      expect(() =>
        db.sqlite
          .prepare(
            "INSERT INTO memory_config(project_id,provider,updated_at_ms) VALUES ('project','hindsight',11)",
          )
          .run(),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.sqlite
          .prepare(
            "INSERT INTO memory_config(project_id,provider,enabled,updated_at_ms) VALUES ('project','other',2,12)",
          )
          .run(),
      ).toThrow(/CHECK/);
      expect(() =>
        db.sqlite
          .prepare(
            "INSERT INTO memory_config(project_id,provider,settings,updated_at_ms) VALUES ('project','broken','not-json',13)",
          )
          .run(),
      ).toThrow(/CHECK/);

      db.sqlite
        .prepare(
          "INSERT INTO memory_install(machine_id,component,version,status,updated_at_ms) VALUES ('machine','hindsight-extension','0.8.7','ready',20)",
        )
        .run();
      expect(
        db.sqlite
          .prepare(
            "SELECT machine_id,component,version,status,error FROM memory_install",
          )
          .all(),
      ).toEqual([
        {
          machine_id: "machine",
          component: "hindsight-extension",
          version: "0.8.7",
          status: "ready",
          error: null,
        },
      ]);
      expect(() =>
        db.sqlite
          .prepare(
            "INSERT INTO memory_install(machine_id,component,version,status,updated_at_ms) VALUES ('machine','other','0.8.7','bogus',21)",
          )
          .run(),
      ).toThrow(/CHECK/);
      expect(() =>
        db.sqlite
          .prepare(
            "INSERT INTO memory_install(machine_id,component,version,status,updated_at_ms) VALUES ('missing','other','0.8.7','ready',22)",
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);

      expect(db.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(db.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.sqlite.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
