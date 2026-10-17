import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDatabase } from "../src/db/connection";
import type { DatabaseConnection } from "../src/db/connection";
import { migrateDatabase } from "../src/db/migrate";
import { parseConfig } from "../src/lib/config";

mkdirSync(".verify", { recursive: true });
const directory = mkdtempSync(resolve(".verify/data-auth-test-"));
const databaseUrl = join(directory, "test.sqlite");
const testEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  NODE_ENV: "test",
};
let connection: DatabaseConnection;

beforeAll(() => {
  migrateDatabase(databaseUrl);
  connection = openDatabase(databaseUrl);
});
afterAll(() => {
  connection?.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("持久层与认证边界", () => {
  it("从空库迁移创建全部表，重复迁移保留已有业务数据", () => {
    const tables = connection.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "project",
        "diagnostic_event",
        "runtime_boot",
        "user",
        "session",
        "account",
        "verification",
      ]),
    );
    connection.sqlite
      .prepare(
        "INSERT INTO runtime_boot (id, started_at, phase, pid, app_version) VALUES (?, ?, ?, ?, ?)",
      )
      .run("boot_test", 1700000000, "ready", 1, "test");
    migrateDatabase(databaseUrl);
    expect(
      connection.sqlite.prepare("SELECT phase FROM runtime_boot WHERE id = ?").get("boot_test"),
    ).toEqual({ phase: "ready" });
    expect(connection.sqlite.prepare("SELECT count(*) AS count FROM project").get()).toEqual({
      count: 0,
    });
  });

  it("每条新连接启用外键与 WAL，并拒绝引用不存在 Human 的 Project", () => {
    const other = openDatabase(databaseUrl);
    try {
      for (const { sqlite } of [connection, other]) {
        expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
        expect(() =>
          sqlite
            .prepare("INSERT INTO project (id, name, created_by) VALUES (?, ?, ?)")
            .run("prj_orphan", "Orphan", "missing-human"),
        ).toThrow(/FOREIGN KEY/);
      }
    } finally {
      other.sqlite.close();
    }
  });

  it("允许 debug 诊断，拒绝非法日志级别和 runtime phase", () => {
    const insert = connection.sqlite.prepare(
      "INSERT INTO diagnostic_event (id, at, level, event, request_id, message) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("diag_debug", 1700000000, "debug", "test", "req_test", "debug accepted");
    expect(() =>
      insert.run("diag_bad", 1700000000, "fatal", "test", "req_test", "invalid"),
    ).toThrow(/CHECK/);
    expect(() =>
      connection.sqlite.prepare("UPDATE runtime_boot SET phase = 'unknown'").run(),
    ).toThrow(/CHECK/);
  });

  it("未登录读取真实认证 session 返回 null", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'const { readSession } = await import("./src/server/session.ts"); console.log(JSON.stringify(await readSession(new Headers())));',
      ],
      { env: testEnv, encoding: "utf8", timeout: 30000 },
    );
    expect(output.trim()).toBe("null");
  });

  it("配置拒绝必填字段的空值与非法值", () => {
    for (const env of [
      { DATABASE_URL: "" },
      { APP_ORIGIN: "https://example.test/path" },
      { PORT: "invalid" },
      { BETTER_AUTH_SECRET: "short" },
    ]) {
      expect(() => parseConfig(env)).toThrow(/环境变量校验失败/);
    }
  });

  it("认证入口拒绝缺失 secret 和示例占位值，并以非零码退出", () => {
    for (const secret of [undefined, "local-development-only-replace-with-a-random-secret"]) {
      const env: NodeJS.ProcessEnv = { ...testEnv };
      if (secret === undefined) delete env.BETTER_AUTH_SECRET;
      else env.BETTER_AUTH_SECRET = secret;
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", 'await import("./src/lib/auth.ts");'],
        { env, encoding: "utf8", timeout: 30000 },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("BETTER_AUTH_SECRET 必须设置");
    }
  });
});
