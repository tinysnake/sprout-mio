// P7 存储恢复门禁：整体迁移事实、在线一致备份、全新目录恢复、升级/重启恢复边界与诊断关联链。
// 运行前由 shell 入口准备生产 server 产物；本脚本只负责真实 SQLite、真实迁移与真实 HTTP 进程。
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDatabase } from "./snapshot";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = mkdtempSync(join(tmpdir(), "p7-storage-recovery-"));
const journal = JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string; when: number }[];
};
const latestTag = journal.entries.at(-1)!.tag;
const password = "snapshot-password-9f4c";
const authSecret = randomBytes(32).toString("base64url");
const checks: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

function pass(name: string, evidence: unknown = {}) {
  checks.push(name);
  console.log(`PASS ${name} ${JSON.stringify(evidence)}`);
}

function runNode(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 300_000,
  });
}

function parseMarker(output: string, marker: string) {
  const line = output
    .split("\n")
    .find((entry) => entry.startsWith(`${marker} `));
  if (!line) throw new Error(`找不到 ${marker} 输出:\n${output}`);
  return JSON.parse(line.slice(marker.length + 1));
}

function raw(file: string) {
  return new Database(file);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("没有端口"));
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch {
      // server 还没监听或请求被连接重置，继续等。
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`等待超时 ${timeoutMs}ms`);
}

type RunningServer = {
  base: string;
  port: number;
  child: ReturnType<typeof spawn>;
  log: string;
  stop: () => Promise<number>;
};

async function startServer(database: string, label: string): Promise<RunningServer> {
  const port = await freePort();
  const log = join(directory, `${label}.log`);
  const descriptor = openSync(log, "w");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: database,
    PORT: String(port),
    NITRO_PORT: String(port),
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    BETTER_AUTH_SECRET: authSecret,
    SPROUT_PI_ENABLED: "false",
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  };
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", descriptor, descriptor],
  });
  closeSync(descriptor);
  children.push(child);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const base = `http://127.0.0.1:${port}`;
  const health = async () => {
    const response = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  try {
    await waitFor(async () => {
      if (exited) throw new Error(`server 提前退出，日志: ${readFileSync(log, "utf8")}`);
      const response = await health();
      return response.status === 200 && response.body.ready === true;
    }, 60_000);
  } catch (error) {
    console.error(readFileSync(log, "utf8"));
    throw error;
  }
  const stop = async () => {
    if (exited) return 0;
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await waitFor(() => exited, 10_000).catch(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    });
    return (child.exitCode ?? 0) as number;
  };
  return { base, port, child, log, stop };
}

async function httpJson(
  url: string,
  options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {},
) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function signIn(base: string, email: string) {
  const response = await httpJson(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    body: { email, password },
    origin: base,
  });
  assert.equal(response.status, 200, response.text);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert(cookie.length > 0, "登录必须返回会话 cookie");
  return cookie;
}

function expectedMigrationCount() {
  return journal.entries.length;
}

function migrationRows(file: string) {
  const sqlite = raw(file);
  try {
    return sqlite.prepare("SELECT * FROM __drizzle_migrations ORDER BY id").all();
  } finally {
    sqlite.close();
  }
}

function assertHealthyDatabase(file: string) {
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
    assert.equal(sqlite.pragma("integrity_check", { simple: true }), "ok");
    const migrations = sqlite
      .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
      .get() as { count: number };
    assert.equal(migrations.count, expectedMigrationCount());
  } finally {
    sqlite.close();
  }
}

try {
  // 0. 迁移清单本身：编号连续、文件存在、最新 tag 与门禁声明一致。
  journal.entries.forEach((entry, index) => assert.equal(entry.idx, index));
  assert.equal(new Set(journal.entries.map((entry) => entry.tag)).size, journal.entries.length);
  for (const entry of journal.entries)
    assert(existsSync(join(root, "drizzle", `${entry.tag}.sql`)), `缺少迁移 ${entry.tag}`);
  assert.equal(latestTag, "0028_p6b_turn_context");
  pass("migration journal contiguous and latest is 0028", {
    migrations: journal.entries.length,
    latestTag,
  });

  // 1. 空库到最新，再跑一次必须幂等。
  const empty = join(directory, "empty.sqlite");
  runNode(["src/db/migrate.ts"], { DATABASE_URL: empty });
  assertHealthyDatabase(empty);
  const emptyMigrations = migrationRows(empty);
  runNode(["src/db/migrate.ts"], { DATABASE_URL: empty });
  assert.deepEqual(migrationRows(empty), emptyMigrations);
  assertHealthyDatabase(empty);
  pass("empty database migrates to latest and replay is a no-op", {
    migrations: emptyMigrations.length,
  });

  // 2. 0025 历史库：真实生产启动时先应用 0026-0028，再恢复上次未关闭的 run。
  const historical = join(directory, "historical.sqlite");
  const oldFolder = join(directory, "old-drizzle");
  mkdirSync(join(oldFolder, "meta"), { recursive: true });
  const oldJournal = {
    ...journal,
    entries: journal.entries.filter((entry) => entry.idx <= 25),
  };
  for (const entry of oldJournal.entries)
    copyFileSync(
      join(root, "drizzle", `${entry.tag}.sql`),
      join(oldFolder, `${entry.tag}.sql`),
    );
  writeFileSync(join(oldFolder, "meta", "_journal.json"), JSON.stringify(oldJournal));
  // 用真实 migrator 停在 0025；生产启动（而非门禁手工）负责应用 0026-0028。
  const { migrateDatabase } = (await import("../../../src/db/migrate")) as typeof import("../../../src/db/migrate");
  migrateDatabase(historical, oldFolder);
  const history = new Database(historical);
  try {
    history.pragma("journal_mode = WAL");
    history.exec(`
      INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('usr_hist','历史用户','history@sprout.test',0,1,1);
      INSERT INTO project(id,name,created_by) VALUES ('prj_hist','历史 Project','usr_hist');
      INSERT INTO agent_profile(id,name,created_by) VALUES ('agt_hist','历史 Agent','usr_hist');
      INSERT INTO project_member(project_id,agent_profile_id,added_by) VALUES ('prj_hist','agt_hist','usr_hist');
      INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES ('cht_hist','prj_hist','group','human','usr_hist','usr_hist');
      INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES ('cht_hist','human','usr_hist'),('cht_hist','agent','agt_hist');
      INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES ('ins_hist','agt_hist','cht_hist','prj_hist');
      INSERT INTO message(id,chat_id,sender_kind,sender_id,body) VALUES ('msg_hist_human','cht_hist','human','usr_hist','历史输入必须原样保留'),('msg_hist_agent','cht_hist','agent','agt_hist','历史回复必须原样保留');
      INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,session_id,started_at) VALUES ('run_hist','ins_hist','cht_hist','prj_hist','req_hist','running','ins_hist',1);
      INSERT INTO agent_run_input(run_id,message_id,disposition,delivered_at) VALUES ('run_hist','msg_hist_human','delivered',2);
      INSERT INTO task(id,project_id,title,description,constraints,completion_requirements,revision,assignment_revision,created_by,created_at,updated_at) VALUES ('tsk_hist','prj_hist','历史任务','旧描述','','',1,0,'usr_hist',1000,1000);
      INSERT INTO task_event(id,task_id,project_id,seq,action,actor_kind,actor_id,to_status,created_at) VALUES ('tev_hist','tsk_hist','prj_hist',1,'create','human','usr_hist','proposed',1000);
      INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES ('boot_hist','1','ready',2147483647,'0025');
    `);
    assert.equal(
      (history.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get() as { count: number })
        .count,
      26,
    );
  } finally {
    history.close();
  }
  const historyBefore = (() => {
    const sqlite = new Database(historical, { readonly: true });
    try {
      return {
        messages: sqlite.prepare("SELECT id, body FROM message ORDER BY id").all(),
        run: sqlite.prepare("SELECT * FROM agent_run WHERE id = 'run_hist'").get(),
        task: sqlite.prepare("SELECT * FROM task WHERE id = 'tsk_hist'").get(),
        taskEvent: sqlite.prepare("SELECT * FROM task_event WHERE id = 'tev_hist'").get(),
      };
    } finally {
      sqlite.close();
    }
  })();

  const upgraded = await startServer(historical, "upgrade-boot");
  const upgradedHealth = await httpJson(`${upgraded.base}/api/health`);
  assert.equal(upgradedHealth.status, 200);
  assert.equal(upgradedHealth.body.ready, true);
  assert.deepEqual(upgradedHealth.body.database, { ok: true, migrationApplied: true });
  assertHealthyDatabase(historical);
  const historyAfter = new Database(historical, { readonly: true });
  try {
    assert.deepEqual(
      historyAfter.prepare("SELECT id, body FROM message ORDER BY id").all(),
      historyBefore.messages,
    );
    assert.deepEqual(historyAfter.prepare("SELECT * FROM task WHERE id = 'tsk_hist'").get(), historyBefore.task);
    assert.deepEqual(
      historyAfter.prepare("SELECT * FROM task_event WHERE id = 'tev_hist'").get(),
      historyBefore.taskEvent,
    );
    const run = historyAfter.prepare("SELECT status, error_code, settled_at FROM agent_run WHERE id = 'run_hist'").get() as {
      status: string;
      error_code: string | null;
      settled_at: number | null;
    };
    assert.equal(run.status, "interrupted");
    assert.equal(run.error_code, "host_interrupted");
    assert(run.settled_at !== null);
    const oldBoot = historyAfter
      .prepare("SELECT phase FROM runtime_boot WHERE id = 'boot_hist'")
      .get() as { phase: string };
    assert.equal(oldBoot.phase, "interrupted");
    const readyBoots = historyAfter
      .prepare("SELECT count(*) AS count FROM runtime_boot WHERE phase = 'ready'")
      .get() as { count: number };
    assert.equal(readyBoots.count, 1);
    const interruptedDiagnostics = historyAfter
      .prepare(
        "SELECT count(*) AS count FROM diagnostic_event WHERE event = 'agent_run.interrupted' AND run_id = 'run_hist'",
      )
      .get() as { count: number };
    assert.equal(interruptedDiagnostics.count, 1);
    assert.equal(
      (
        historyAfter
          .prepare(
            "SELECT count(*) AS count FROM diagnostic_event WHERE event = 'runtime.interrupted' AND data LIKE '%boot_hist%'",
          )
          .get() as { count: number }
      ).count,
      1,
    );
    const wakePolicyColumn = historyAfter
      .prepare("SELECT count(*) AS count FROM pragma_table_info('project') WHERE name = 'wake_policy'")
      .get() as { count: number };
    assert.equal(wakePolicyColumn.count, 1, "0026 的新列必须已应用");
  } finally {
    historyAfter.close();
  }
  const upgradedBootId = String(upgradedHealth.body.bootId);
  assert.match(upgradedBootId, /^boot_/);
  assert.equal(await upgraded.stop(), 0);
  const stoppedHistory = new Database(historical, { readonly: true });
  try {
    assert.equal(
      (
        stoppedHistory
          .prepare("SELECT phase FROM runtime_boot WHERE id = ?")
          .get(upgradedBootId) as { phase: string }
      ).phase,
      "stopped",
    );
  } finally {
    stoppedHistory.close();
  }
  const migratedOnce = migrationRows(historical);
  const countsOnce = inspectDatabase(historical).tables;
  migrateDatabase(historical, join(root, "drizzle"));
  assert.deepEqual(migrationRows(historical), migratedOnce);
  assert.deepEqual(inspectDatabase(historical).tables, countsOnce);
  pass("0025 history upgrades on first boot, preserves rows and recovers in-flight run", {
    migrations: migratedOnce.length,
    run: "interrupted",
    boot: { old: "interrupted", current: "stopped" },
  });

  // 3. 备份前先造一份真实库；并发写入与备份独立进程。
  const live = join(directory, "live.sqlite");
  const seeded = parseMarker(
    runNode(["scripts/p7/storage/seed-live.ts"], {
      DATABASE_URL: live,
      BETTER_AUTH_SECRET: authSecret,
      NODE_ENV: "test",
      SPROUT_PI_ENABLED: "false",
      SEED_EMAIL: "snapshot@sprout.test",
      SEED_PASSWORD: password,
    }),
    "SEED",
  ) as {
    userId: string;
    email: string;
    projectId: string;
    chatId: string;
    messageBody: string;
    taskId: string;
    taskTitle: string;
    runId: string;
    executionId: string;
    executionRequestId: string;
    bootId: string;
    lease: { machineId: string; generation: number; holderInstanceId: string };
  };
  const liveConnection = new Database(live);
  liveConnection.pragma("busy_timeout = 5000");
  liveConnection.pragma("wal_autocheckpoint = 0");
  liveConnection.pragma("wal_checkpoint(TRUNCATE)");
  const stopFile = join(directory, "writer.stop");
  const readyFile = join(directory, "writer.ready");
  const writerLog = join(directory, "writer.log");
  const writerDescriptor = openSync(writerLog, "w");
  const writer = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/p7/storage/writer.ts",
      live,
      seeded.chatId,
      seeded.projectId,
      stopFile,
      readyFile,
    ],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", writerDescriptor, writerDescriptor],
    },
  );
  closeSync(writerDescriptor);
  children.push(writer);
  try {
    await waitFor(() => {
      if (!existsSync(readyFile)) return false;
      const count = liveConnection
        .prepare("SELECT count(*) AS count FROM diagnostic_event WHERE event = 'probe.pair'")
        .get() as { count: number };
      return count.count >= 8;
    }, 30_000);
    const backup = join(directory, "snapshot.sqlite");
    const backupReport = JSON.parse(
      runNode([
        "scripts/p7/storage/snapshot.ts",
        "backup",
        "--database",
        live,
        "--out",
        backup,
      ]),
    ) as { path: string; tables: Record<string, number>; integrity: string };
    assert.equal(backupReport.integrity, "ok");
    const snapshot = new Database(backup, { readonly: true });
    let pairCount: number;
    try {
      pairCount = (
        snapshot
          .prepare("SELECT count(*) AS count FROM diagnostic_event WHERE event = 'probe.pair'")
          .get() as { count: number }
      ).count;
      const probeMessages = (
        snapshot
          .prepare("SELECT count(*) AS count FROM message WHERE body LIKE 'probe-%'")
          .get() as { count: number }
      ).count;
      assert(pairCount > 0, "备份必须包含并发写入的提交");
      assert.equal(probeMessages, pairCount, "同一事务的 message 与 diagnostic 不能只看到一半");
      assert.equal(
        (
          snapshot
            .prepare("SELECT count(*) AS count FROM diagnostic_event WHERE event = 'backup.required'")
            .get() as { count: number }
        ).count,
        1,
      );
    } finally {
      snapshot.close();
    }
    const copiedMainFile = join(directory, "copied-main.sqlite");
    copyFileSync(live, copiedMainFile);
    const copied = new Database(copiedMainFile, { readonly: true, fileMustExist: true });
    try {
      assert.equal(
        (
          copied
            .prepare("SELECT count(*) AS count FROM diagnostic_event WHERE event = 'backup.required'")
            .get() as { count: number }
        ).count,
        0,
        "直接复制主库文件必须漏掉 WAL 中未 checkpoint 的提交",
      );
      assert.equal(
        (
          copied
            .prepare("SELECT count(*) AS count FROM diagnostic_event WHERE event = 'probe.pair'")
            .get() as { count: number }
        ).count,
        0,
      );
    } finally {
      copied.close();
    }
    pass("online backup is consistent under concurrent writes; copying main file is not", {
      pairRowsInSnapshot: pairCount,
    });
    writeFileSync(stopFile, "stop\n");
    await waitFor(() => writer.exitCode !== null, 10_000);
    const writerResult = JSON.parse(readFileSync(writerLog, "utf8").trim().split("\n").at(-1)!) as {
      commits: number;
      errors: string[];
    };
    assert.equal(writerResult.errors.length, 0);
    assert(writerResult.commits >= 8);

    const restoredDirectory = join(directory, "restored");
    const restoredDatabase = join(restoredDirectory, "sprout.sqlite");
    const restoreReport = JSON.parse(
      runNode([
        "scripts/p7/storage/snapshot.ts",
        "restore",
        "--backup",
        backup,
        "--database",
        restoredDatabase,
      ]),
    ) as { path: string; tables: Record<string, number>; restoredFrom: string };
    assert.equal(restoreReport.path, restoredDatabase);
    assert.equal(restoreReport.tables.message, backupReport.tables.message);
    assert.equal(restoreReport.tables.project, backupReport.tables.project);
    assert.equal(restoreReport.tables.task, backupReport.tables.task);
    assert.equal(restoreReport.tables.machine_lease, backupReport.tables.machine_lease);
    assertHealthyDatabase(restoredDatabase);
    const restoredSnapshot = new Database(restoredDatabase, { readonly: true });
    try {
      assert.equal(
        (
          restoredSnapshot
            .prepare("SELECT body FROM message WHERE id = 'msg_probe_1'")
            .get() as { body: string }
        ).body,
        "probe-1",
      );
      assert.equal(
        (
          restoredSnapshot
            .prepare("SELECT body FROM message WHERE chat_id = ? AND body = ?")
            .get(seeded.chatId, seeded.messageBody) as { body: string }
        ).body,
        seeded.messageBody,
      );
      assert.equal(
        (
          restoredSnapshot.prepare("SELECT title FROM task WHERE id = ?").get(seeded.taskId) as {
            title: string;
          }
        ).title,
        seeded.taskTitle,
      );
      assert.deepEqual(
        restoredSnapshot
          .prepare(
            "SELECT state, generation, holder_instance_id FROM machine_lease WHERE project_id = ? AND machine_id = ?",
          )
          .get(seeded.projectId, seeded.lease.machineId),
        {
          state: "held",
          generation: seeded.lease.generation,
          holder_instance_id: seeded.lease.holderInstanceId,
        },
      );
      assert.equal(
        (
          restoredSnapshot
            .prepare("SELECT status FROM agent_run WHERE id = ?")
            .get(seeded.runId) as { status: string }
        ).status,
        "running",
      );
      assert.notEqual(
        (
          restoredSnapshot
            .prepare("SELECT state FROM remote_execution WHERE id = ?")
            .get(seeded.executionId) as { state: string }
        ).state,
        "succeeded",
      );
    } finally {
      restoredSnapshot.close();
    }

    // 4. 全新目录启动备份库：恢复在途事实，但不把 run/execution 伪造成成功。
    const restoredServer = await startServer(restoredDatabase, "restored-boot");
    const restoredHealth = await httpJson(`${restoredServer.base}/api/health`);
    assert.equal(restoredHealth.status, 200);
    assert.equal(restoredHealth.body.ready, true);
    const restoredBootId = String(restoredHealth.body.bootId);
    assert.notEqual(restoredBootId, seeded.bootId);
    const recovered = new Database(restoredDatabase, { readonly: true });
    try {
      const run = recovered
        .prepare("SELECT status, error_code FROM agent_run WHERE id = ?")
        .get(seeded.runId) as { status: string; error_code: string | null };
      assert.equal(run.status, "interrupted");
      assert.equal(run.error_code, "host_interrupted");
      const execution = recovered
        .prepare("SELECT state, failure_reason FROM remote_execution WHERE id = ?")
        .get(seeded.executionId) as { state: string; failure_reason: string | null };
      assert.notEqual(execution.state, "succeeded");
      assert.equal(
        (
          recovered
            .prepare("SELECT count(*) AS count FROM execution_result WHERE execution_id = ? AND outcome = 'succeeded'")
            .get(seeded.executionId) as { count: number }
        ).count,
        0,
      );
      assert.equal(
        (
          recovered
            .prepare("SELECT phase FROM runtime_boot WHERE id = ?")
            .get(seeded.bootId) as { phase: string }
        ).phase,
        "interrupted",
      );
      assert.equal(
        (
          recovered
            .prepare("SELECT phase FROM runtime_boot WHERE id = ?")
            .get(restoredBootId) as { phase: string }
        ).phase,
        "ready",
      );
    } finally {
      recovered.close();
    }
    pass("restored backup boots in a fresh directory and keeps unknown/in-flight facts non-success", {
      boot: restoredBootId,
      run: "interrupted",
      executionPreserved: true,
    });

    // 5. 诊断关联链：request -> project/chat/instance/run/execution 都必须落到真实行。
    const cookie = await signIn(restoredServer.base, seeded.email);
    const byRequest = await httpJson(
      `${restoredServer.base}/api/diagnostics?requestId=${seeded.executionRequestId}&limit=200`,
      { cookie },
    );
    assert.equal(byRequest.status, 200);
    const requestEvents = byRequest.body!.data as Record<string, unknown>[];
    const executionEvent = requestEvents.find(
      (event) => event.executionId === seeded.executionId,
    );
    assert(executionEvent, "按 requestId 必须查到带 executionId 的诊断");
    const byProject = await httpJson(
      `${restoredServer.base}/api/diagnostics?projectId=${seeded.projectId}&limit=200`,
      { cookie },
    );
    assert.equal(byProject.status, 200);
    assert(
      (byProject.body!.data as Record<string, unknown>[]).some(
        (event) => event.executionId === seeded.executionId,
      ),
      "按 Project 必须能查到同一条执行诊断",
    );
    const chain = new Database(restoredDatabase, { readonly: true });
    try {
      const linked = chain
        .prepare(
          `SELECT d.id, d.project_id, d.chat_id, d.instance_id, d.run_id, d.execution_id
             FROM diagnostic_event d WHERE d.request_id = ? AND d.execution_id = ?`,
        )
        .get(seeded.executionRequestId, seeded.executionId) as {
        id: string;
        project_id: string;
        chat_id: string;
        instance_id: string;
        run_id: string;
        execution_id: string;
      };
      assert(linked, "诊断行必须存在");
      assert.deepEqual(
        chain
          .prepare(
            `SELECT c.project_id FROM chat c
               JOIN project p ON p.id = c.project_id
              WHERE c.id = ? AND p.id = ?`,
          )
          .get(linked.chat_id, linked.project_id),
        { project_id: linked.project_id },
      );
      assert.deepEqual(
        chain
          .prepare(
            `SELECT r.project_id, r.chat_id, i.project_id AS instance_project, i.chat_id AS instance_chat
               FROM agent_run r JOIN agent_instance i ON i.id = r.instance_id
              WHERE r.id = ?`,
          )
          .get(linked.run_id),
        {
          project_id: linked.project_id,
          chat_id: linked.chat_id,
          instance_project: linked.project_id,
          instance_chat: linked.chat_id,
        },
      );
      assert.deepEqual(
        chain
          .prepare("SELECT project_id, chat_id, run_id FROM remote_execution WHERE id = ?")
          .get(linked.execution_id),
        {
          project_id: linked.project_id,
          chat_id: linked.chat_id,
          run_id: linked.run_id,
        },
      );
    } finally {
      chain.close();
    }
    pass("diagnostics chain resolves request, Project, Chat, instance, run and execution", {
      executionEvent: executionEvent.id,
    });

    // 6. 恢复后的库能接受新的真实写入；随后重启保留恢复边界与 boot 事实。
    const newEmail = `restored-new-${Date.now()}@sprout.test`;
    const signup = await httpJson(`${restoredServer.base}/api/auth/sign-up/email`, {
      method: "POST",
      body: { email: newEmail, password, name: "Restored New Human" },
      origin: restoredServer.base,
    });
    assert.equal(signup.status, 200, signup.text);
    const afterWrite = new Database(restoredDatabase, { readonly: true });
    try {
      assert.equal(
        (
          afterWrite
            .prepare("SELECT count(*) AS count FROM user WHERE email = ?")
            .get(newEmail) as { count: number }
        ).count,
        1,
      );
      assert.equal(
        (
          afterWrite
            .prepare(
              "SELECT count(*) AS count FROM project WHERE created_by = (SELECT id FROM user WHERE email = ?)",
            )
            .get(newEmail) as { count: number }
        ).count,
        1,
      );
      assert.equal(
        (
          afterWrite
            .prepare("SELECT body FROM message WHERE chat_id = ? AND body = ?")
            .get(seeded.chatId, seeded.messageBody) as { body: string }
        ).body,
        seeded.messageBody,
      );
    } finally {
      afterWrite.close();
    }
    assert.equal(await restoredServer.stop(), 0);
    const afterFirstStop = new Database(restoredDatabase, { readonly: true });
    let stoppedFirstBoot: string;
    try {
      stoppedFirstBoot = (
        afterFirstStop
          .prepare("SELECT phase FROM runtime_boot WHERE id = ?")
          .get(restoredBootId) as { phase: string }
      ).phase;
      assert.equal(stoppedFirstBoot, "stopped");
    } finally {
      afterFirstStop.close();
    }
    const migrationsBeforeRestart = migrationRows(restoredDatabase);
    const restarted = await startServer(restoredDatabase, "restart-boot");
    const restartedHealth = await httpJson(`${restarted.base}/api/health`);
    assert.equal(restartedHealth.status, 200);
    assert.notEqual(restartedHealth.body.bootId, restoredBootId);
    const restartedBootId = String(restartedHealth.body.bootId);
    const afterRestart = new Database(restoredDatabase, { readonly: true });
    try {
      const boots = afterRestart
        .prepare("SELECT id, phase FROM runtime_boot WHERE id IN (?, ?)")
        .all(restoredBootId, restartedBootId) as { id: string; phase: string }[];
      assert.deepEqual(Object.fromEntries(boots.map((boot) => [boot.id, boot.phase])), {
        [restoredBootId]: "stopped",
        [restartedBootId]: "ready",
      });
      assert.equal(
        (
          afterRestart
            .prepare("SELECT status FROM agent_run WHERE id = ?")
            .get(seeded.runId) as { status: string }
        ).status,
        "interrupted",
      );
      assert.notEqual(
        (
          afterRestart
            .prepare("SELECT state FROM remote_execution WHERE id = ?")
            .get(seeded.executionId) as { state: string }
        ).state,
        "succeeded",
      );
    } finally {
      afterRestart.close();
    }
    assert.deepEqual(migrationRows(restoredDatabase), migrationsBeforeRestart);
    assert.equal(await restarted.stop(), 0);
    pass("same-version restart keeps boot ids, recovery boundary and migration state", {
      firstBoot: restoredBootId,
      secondBoot: restartedBootId,
      stoppedFirstBoot,
      migrations: migrationsBeforeRestart.length,
    });

    writeFileSync(
      join(directory, "evidence.json"),
      `${JSON.stringify(
        {
          latestTag,
          migrations: expectedMigrationCount(),
          checks,
          backup: backupReport,
          restore: restoreReport,
          writer: writerResult,
          boots: { upgraded: upgradedBootId, restored: restoredBootId, restarted: restartedBootId },
        },
        null,
        2,
      )}\n`,
    );
    console.log(`EVIDENCE ${join(directory, "evidence.json")}`);
  } finally {
    if (!existsSync(stopFile)) writeFileSync(stopFile, "stop\n");
    liveConnection.close();
  }
  pass("p7-storage-recovery all checks passed", { evidence: join(directory, "evidence.json") });
} catch (error) {
  console.error("FAIL p7-storage-recovery", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
}
