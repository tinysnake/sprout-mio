import { expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      expect(() =>
        db.sqlite
          .prepare(
            "INSERT INTO memory_config(project_id,provider,secrets,updated_at_ms) VALUES ('project','broken-secret','not-json',14)",
          )
          .run(),
      ).toThrow(/CHECK/);
      expect(() =>
        db.sqlite
          .prepare(
            "INSERT INTO memory_config(project_id,provider,revision,updated_at_ms) VALUES ('project','broken-revision',-1,15)",
          )
          .run(),
      ).toThrow(/CHECK/);
      expect(() =>
        db.sqlite
          .prepare(
            "INSERT INTO memory_config(project_id,provider,updated_at_ms,updated_by_human_id) VALUES ('project','ghost',16,'ghost')",
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);

      expect(
        db.sqlite
          .prepare("SELECT name FROM pragma_table_info('memory_install') ORDER BY cid")
          .all(),
      ).toEqual([
        { name: "component" },
        { name: "version" },
        { name: "status" },
        { name: "error" },
        { name: "updated_at_ms" },
      ]);

      db.sqlite
        .prepare(
          "INSERT INTO memory_install(component,version,status,updated_at_ms) VALUES ('hindsight-extension','0.8.7','ready',20)",
        )
        .run();
      expect(
        db.sqlite.prepare("SELECT component,version,status,error FROM memory_install").all(),
      ).toEqual([
        {
          component: "hindsight-extension",
          version: "0.8.7",
          status: "ready",
          error: null,
        },
      ]);
      expect(() =>
        db.sqlite
          .prepare(
            "INSERT INTO memory_install(component,version,status,updated_at_ms) VALUES ('hindsight-extension','0.8.7','failed',21)",
          )
          .run(),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.sqlite
          .prepare(
            "INSERT INTO memory_install(component,version,status,updated_at_ms) VALUES ('other','0.8.7','bogus',21)",
          )
          .run(),
      ).toThrow(/CHECK/);

      expect(db.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(db.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.sqlite.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("migrates Machine installs to one row per component, keeping the newest", () => {
  const db = openDatabase(":memory:");
  try {
    db.sqlite.exec(`
      CREATE TABLE machine(id text PRIMARY KEY NOT NULL);
      CREATE TABLE memory_install(
        machine_id text NOT NULL,
        component text NOT NULL,
        version text NOT NULL,
        status text NOT NULL,
        error text,
        updated_at_ms integer NOT NULL,
        PRIMARY KEY(machine_id, component),
        FOREIGN KEY (machine_id) REFERENCES machine(id),
        CONSTRAINT "memory_install_status_check" CHECK(status in ('missing','installing','ready','failed'))
      );
      INSERT INTO machine(id) VALUES ('m1'), ('m2');
      INSERT INTO memory_install(machine_id,component,version,status,updated_at_ms) VALUES
        ('m1','hindsight-extension','0.8.7','ready',20),
        ('m2','hindsight-extension','0.8.7','failed',30),
        ('m1','other','0.8.7','ready',10),
        ('m2','other','0.8.6','installing',10);
    `);
    for (const statement of readFileSync("drizzle/0057_host_memory_install.sql", "utf8").split(
      "--> statement-breakpoint",
    ))
      db.sqlite.exec(statement);

    expect(
      db.sqlite
        .prepare(
          "SELECT component,version,status,updated_at_ms FROM memory_install ORDER BY component",
        )
        .all(),
    ).toEqual([
      { component: "hindsight-extension", version: "0.8.7", status: "failed", updated_at_ms: 30 },
      { component: "other", version: "0.8.6", status: "installing", updated_at_ms: 10 },
    ]);
    expect(() =>
      db.sqlite
        .prepare(
          "INSERT INTO memory_install(component,version,status,updated_at_ms) VALUES ('other','0.8.7','ready',40)",
        )
        .run(),
    ).toThrow(/UNIQUE/);
  } finally {
    db.sqlite.close();
  }
});
