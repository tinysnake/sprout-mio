import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { rekeyShortIds } from "../scripts/maintenance/rekey-short-ids";
import type { RekeyResult } from "../scripts/maintenance/rekey-short-ids";

const PROJECT_OLD = "prj_b9594a03-60e7-425a-8197-5ea47b20a3d3";
const PROJECT_NEW = "prj_b9594a03";
const PROJECT_TAKEN = "prj_ab12cd34";
const COLLIDE_A = "prj_ab12cd34-1111-4111-8111-111111111111";
const COLLIDE_B = "prj_ab12cd34-2222-4222-8222-222222222222";
const TASK_OLD = "tsk_604bb2e1-58c5-4759-bd7e-76734fd3c52f";
const TASK_NEW = "tsk_aaaaaaaa";
const CHAT_OLD = "cnv_8553ba23-01fc-4a06-b5e7-521cb0bc3dfa";
const MESSAGE_OLD = "msg_9e1a135b-3a9f-4f9f-96eb-2d29b36a1775";
const RUN_OLD = "run_880e4e27-3ae6-4afb-97e9-417055b47087";
const PROFILE_OLD = "agp_d161d7f1-117f-436d-8687-1764474b95f4";
const INSTANCE_OLD = "ins_76d96b85-400a-4ce0-9109-baf7344ac489";
const UNKNOWN_ID = "pmb_11112222-3333-4444-8555-666677778888";
const BARE_USER_ID = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const BETTER_AUTH_SESSION_ID = "f1e2d3c4b5a69788796a5b4c3d2e1f00";
const BODY = `请把 ${PROJECT_OLD} 拉下来，再问 ${PROFILE_OLD}`;

const SCHEMA = `
  CREATE TABLE project (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    legacy_ref TEXT
  );
  CREATE TABLE task (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_by TEXT,
    FOREIGN KEY (project_id) REFERENCES project(id)
  );
  CREATE TABLE chat (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES project(id)
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY NOT NULL,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    body TEXT NOT NULL,
    payload TEXT,
    FOREIGN KEY (chat_id) REFERENCES chat(id)
  );
  CREATE TABLE session (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL
  );
  CREATE TABLE audit (note TEXT NOT NULL);
  CREATE TRIGGER chat_identity_immutable BEFORE UPDATE ON chat
    WHEN NEW.id <> OLD.id
    BEGIN SELECT RAISE(ABORT, 'chat_identity_immutable'); END;
  CREATE TRIGGER chat_touch AFTER UPDATE ON chat
    BEGIN INSERT INTO audit (note) VALUES (NEW.id); END;
`;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(): { directory: string; dbPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "sprout-rekey-"));
  directories.push(directory);
  const dbPath = join(directory, "sprout.sqlite");
  const sqlite = new Database(dbPath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(SCHEMA);
  const project = sqlite.prepare("INSERT INTO project (id, name, legacy_ref) VALUES (?, ?, ?)");
  project.run(PROJECT_OLD, "sprout", `未知家族 ${UNKNOWN_ID}`);
  project.run(PROJECT_TAKEN, "taken", null);
  project.run(COLLIDE_A, "collide-a", null);
  project.run(COLLIDE_B, "collide-b", null);
  sqlite
    .prepare("INSERT INTO task (id, project_id, title, created_by) VALUES (?, ?, ?, ?)")
    .run(TASK_OLD, PROJECT_OLD, "t1", PROFILE_OLD);
  sqlite
    .prepare("INSERT INTO task (id, project_id, title, created_by) VALUES (?, ?, ?, ?)")
    .run(TASK_NEW, PROJECT_OLD, "t2", BARE_USER_ID);
  sqlite
    .prepare("INSERT INTO chat (id, project_id, owner_id, instance_id) VALUES (?, ?, ?, ?)")
    .run(CHAT_OLD, PROJECT_OLD, PROFILE_OLD, INSTANCE_OLD);
  sqlite
    .prepare("INSERT INTO message (id, chat_id, sender_id, body, payload) VALUES (?,?,?,?,?)")
    .run(
      MESSAGE_OLD,
      CHAT_OLD,
      PROFILE_OLD,
      BODY,
      JSON.stringify({ projectId: PROJECT_OLD, runId: RUN_OLD, note: `chat ${CHAT_OLD}` }),
    );
  sqlite
    .prepare("INSERT INTO session (id, user_id) VALUES (?, ?)")
    .run(BETTER_AUTH_SESSION_ID, BARE_USER_ID);
  sqlite.close();
  return { directory, dbPath };
}

function query<T>(dbPath: string, sql: string, ...parameters: unknown[]): T[] {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return sqlite.prepare(sql).all(...parameters) as T[];
  } finally {
    sqlite.close();
  }
}

function mappingOf(result: RekeyResult): Map<string, string> {
  return new Map(result.mapping.map((entry) => [entry.oldId, entry.newId]));
}

function snapshot(dbPath: string): string {
  return readFileSync(dbPath).toString("base64");
}

describe("id 短格式重写迁移", () => {
  it("干跑只报告，不建表也不写库", () => {
    const { dbPath } = fixture();
    const before = snapshot(dbPath);
    const result = rekeyShortIds({ dbPath, apply: false, fs: false });
    expect(result.status).toBe("dry-run");
    expect(snapshot(dbPath)).toBe(before);
    expect(query(dbPath, "SELECT name FROM sqlite_master WHERE name = 'id_map'")).toHaveLength(0);
    expect(mappingOf(result).get(PROJECT_OLD)).toBe(PROJECT_NEW);
    expect(result.tables.find((table) => table.table === "project")?.idRows).toBe(3);
    expect(result.proseReferences).toBe(2);
  });

  it("改写后外键关系、载荷与散文各就各位", () => {
    const { dbPath } = fixture();
    const result = rekeyShortIds({ dbPath, apply: true, fs: false });
    expect(result.status).toBe("applied");
    const mapping = mappingOf(result);
    expect(mapping.get(PROJECT_OLD)).toBe(PROJECT_NEW);
    expect(mapping.get(CHAT_OLD)).toBe("cnv_8553ba23");
    expect(mapping.get(TASK_OLD)).toBe("tsk_604bb2e1");
    expect(mapping.get(PROFILE_OLD)).toBe("agp_d161d7f1");

    expect(query(dbPath, "PRAGMA foreign_key_check")).toHaveLength(0);
    const joined = query<{ project_id: string; project: string | null }>(
      dbPath,
      `SELECT task.project_id, project.id AS project FROM task JOIN project ON project.id = task.project_id
        WHERE task.title = 't1'`,
    );
    expect(joined).toEqual([{ project_id: PROJECT_NEW, project: PROJECT_NEW }]);
    const message = query<{
      id: string;
      chat_id: string;
      sender_id: string;
      body: string;
      payload: string;
    }>(dbPath, "SELECT id, chat_id, sender_id, body, payload FROM message")[0];
    expect(message.id).toBe("msg_9e1a135b");
    expect(message.chat_id).toBe(mapping.get(CHAT_OLD));
    expect(message.sender_id).toBe(mapping.get(PROFILE_OLD));

    const payload = JSON.parse(message.payload) as {
      projectId: string;
      runId: string;
      note: string;
    };
    expect(payload.projectId).toBe(PROJECT_NEW);
    expect(payload.runId).toBe(mapping.get(RUN_OLD));
    expect(payload.note).toBe(`chat ${mapping.get(CHAT_OLD)}`);
    expect(message.payload).not.toContain(PROJECT_OLD);
    expect(message.payload).not.toContain(CHAT_OLD);

    expect(message.body).toBe(BODY);

    const mixed = query<{ created_by: string }>(
      dbPath,
      "SELECT created_by FROM task ORDER BY title",
    );
    expect(mixed).toEqual([{ created_by: mapping.get(PROFILE_OLD) }, { created_by: BARE_USER_ID }]);
    expect(query(dbPath, "SELECT id, user_id FROM session")).toEqual([
      { id: BETTER_AUTH_SESSION_ID, user_id: BARE_USER_ID },
    ]);
  });

  it("同前缀撞车延长位数，已存在的短 id 不被占用", () => {
    const { dbPath } = fixture();
    const result = rekeyShortIds({ dbPath, apply: true, fs: false });
    const mapping = mappingOf(result);
    expect(mapping.get(COLLIDE_A)).toBe("prj_ab12cd3411");
    expect(mapping.get(COLLIDE_B)).toBe("prj_ab12cd3422");
    expect(result.collisions.map((entry) => entry.newId).sort()).toEqual([
      "prj_ab12cd3411",
      "prj_ab12cd3422",
    ]);
    const ids = query<{ id: string }>(dbPath, "SELECT id FROM project ORDER BY id").map(
      (row) => row.id,
    );
    expect(ids).toEqual([PROJECT_NEW, PROJECT_TAKEN, "prj_ab12cd3411", "prj_ab12cd3422"].sort());
    expect(query(dbPath, "SELECT id FROM task WHERE title = 't2'")).toEqual([{ id: TASK_NEW }]);
    expect(query(dbPath, "SELECT count(*) AS n FROM id_map")).toEqual([
      { n: result.mapping.length },
    ]);
  });

  it("身份触发器在改写期间摘掉，写完装回且不触发副作用", () => {
    const { dbPath } = fixture();
    rekeyShortIds({ dbPath, apply: true, fs: false });
    expect(query(dbPath, "SELECT note FROM audit")).toHaveLength(0);
    expect(
      query(dbPath, "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"),
    ).toEqual([{ name: "chat_identity_immutable" }, { name: "chat_touch" }]);
    const sqlite = new Database(dbPath);
    try {
      sqlite.pragma("foreign_keys = OFF");
      expect(() => sqlite.prepare("UPDATE chat SET id = 'cnv_00000000'").run()).toThrow(
        /chat_identity_immutable/,
      );
    } finally {
      sqlite.close();
    }
  });

  it("未知前缀被报告而不是被改写或静默丢弃", () => {
    const { dbPath } = fixture();
    const result = rekeyShortIds({ dbPath, apply: true, fs: false });
    const unknown = result.unknown.find((entry) => entry.prefix === "pmb");
    expect(unknown?.count).toBe(1);
    expect(unknown?.tables).toContain("project");
    expect(unknown?.samples).toContain(UNKNOWN_ID);
    expect(query(dbPath, "SELECT legacy_ref FROM project WHERE id = ?", PROJECT_NEW)).toEqual([
      { legacy_ref: `未知家族 ${UNKNOWN_ID}` },
    ]);
    expect(mappingOf(result).has(UNKNOWN_ID)).toBe(false);
  });

  it("第二次 apply 不写入任何东西", () => {
    const { dbPath } = fixture();
    const first = rekeyShortIds({ dbPath, apply: true, fs: false });
    expect(first.status).toBe("applied");
    const afterFirst = snapshot(dbPath);
    const second = rekeyShortIds({ dbPath, apply: true, fs: false });
    expect(second.status).toBe("already-applied");
    expect(second.remainingOldIds).toBe(0);
    expect(second.proseReferences).toBe(2);
    expect(second.mapping).toHaveLength(first.mapping.length);
    expect(snapshot(dbPath)).toBe(afterFirst);
  });

  it("文件系统按 id_map 重命名目录与会话文件，内容一起改，workspace 不动", () => {
    const { directory, dbPath } = fixture();
    const repoRoot = join(directory, "repos");
    const piRoot = join(directory, "pi");
    mkdirSync(join(repoRoot, PROJECT_OLD), { recursive: true });
    writeFileSync(join(repoRoot, PROJECT_OLD, "README.md"), "# repo");
    const instanceDirectory = join(piRoot, INSTANCE_OLD);
    const sessions = join(instanceDirectory, "sessions");
    mkdirSync(sessions, { recursive: true });
    const sessionFile = join(sessions, `1760000000_${INSTANCE_OLD}.jsonl`);
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ projectId: PROJECT_OLD, instanceId: INSTANCE_OLD })}\n`,
    );
    const workspace = join(instanceDirectory, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "note.md"), PROJECT_OLD);

    const predicted = rekeyShortIds({
      dbPath,
      apply: false,
      fs: true,
      repoRoot,
      piDataRoot: piRoot,
    });
    const mapping = mappingOf(predicted);
    // 仓库目录、实例目录、会话文件名各一处。
    expect(predicted.fs?.renames).toHaveLength(3);
    expect(predicted.fs?.rewrites).toHaveLength(1);
    expect(readdirSync(repoRoot)).toEqual([PROJECT_OLD]);
    expect(readFileSync(sessionFile, "utf8")).toContain(PROJECT_OLD);

    const applied = rekeyShortIds({
      dbPath,
      apply: true,
      fs: true,
      repoRoot,
      piDataRoot: piRoot,
    });
    expect(applied.status).toBe("applied");
    expect(readdirSync(repoRoot)).toEqual([mapping.get(PROJECT_OLD)]);
    expect(readdirSync(piRoot)).toEqual([mapping.get(INSTANCE_OLD)]);
    const newSessions = join(piRoot, mapping.get(INSTANCE_OLD)!, "sessions");
    const sessionNames = readdirSync(newSessions);
    expect(sessionNames).toEqual([`1760000000_${mapping.get(INSTANCE_OLD)}.jsonl`]);
    const content = readFileSync(join(newSessions, sessionNames[0]), "utf8");
    expect(content).toContain(mapping.get(PROJECT_OLD)!);
    expect(content).toContain(mapping.get(INSTANCE_OLD)!);
    expect(content).not.toContain(PROJECT_OLD);
    expect(content).not.toContain(INSTANCE_OLD);
    expect(
      readFileSync(join(piRoot, mapping.get(INSTANCE_OLD)!, "workspace", "note.md"), "utf8"),
    ).toBe(PROJECT_OLD);

    const again = rekeyShortIds({
      dbPath,
      apply: true,
      fs: true,
      repoRoot,
      piDataRoot: piRoot,
    });
    expect(again.status).toBe("already-applied");
    expect(again.fs?.renames).toHaveLength(0);
    expect(again.fs?.rewrites).toHaveLength(0);
    expect(readdirSync(repoRoot)).toEqual([mapping.get(PROJECT_OLD)]);
  });

  it("数据库已提交、文件系统阶段中断后，单独重跑 --fs 仍会把目录改过来", () => {
    const { directory, dbPath } = fixture();
    const repoRoot = join(directory, "repos");
    mkdirSync(join(repoRoot, PROJECT_OLD), { recursive: true });

    const first = rekeyShortIds({ dbPath, apply: true, fs: false, repoRoot });
    expect(first.status).toBe("applied");
    expect(readdirSync(repoRoot)).toEqual([PROJECT_OLD]);

    const recovery = rekeyShortIds({ dbPath, apply: true, fs: true, repoRoot });
    expect(recovery.status).toBe("already-applied");
    expect(readdirSync(repoRoot)).toEqual([mappingOf(first).get(PROJECT_OLD)]);
  });
});
