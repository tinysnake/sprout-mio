// 备份期间的真实并发写入进程：每个事务同时写一条 message 和一条 diagnostic_event。
// 快照必须看到成对的两行，或两行都不看到；主库文件复制会漏掉整个事务。
import Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [databaseArg, chatId, projectId, stopFileArg, readyFileArg] = process.argv.slice(2);
if (!databaseArg || !chatId || !projectId || !stopFileArg || !readyFileArg)
  throw new Error("用法: writer.ts <database> <chatId> <projectId> <stopFile> <readyFile>");
const database = resolve(databaseArg);
const stopFile = resolve(stopFileArg);
const readyFile = resolve(readyFileArg);
const sqlite = new Database(database);
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("wal_autocheckpoint = 0");
sqlite.pragma("synchronous = NORMAL");
const insert = sqlite.transaction((n: number) => {
  sqlite
    .prepare("INSERT INTO message(id, chat_id, sender_kind, sender_id, body) VALUES (?, ?, 'human', 'usr_probe', ?)")
    .run(`msg_probe_${n}`, chatId, `probe-${n}`);
  sqlite
    .prepare(
      "INSERT INTO diagnostic_event(id, at, level, event, request_id, project_id, chat_id, message) VALUES (?, unixepoch(), 'info', 'probe.pair', ?, ?, ?, ?)",
    )
    .run(`diag_probe_${n}`, `req_probe_${n}`, projectId, chatId, `并发写入 ${n}`);
  if (n === 1)
    sqlite
      .prepare(
        "INSERT INTO diagnostic_event(id, at, level, event, request_id, project_id, chat_id, message) VALUES ('diag_backup_required', unixepoch(), 'info', 'backup.required', 'req_backup_required', ?, ?, '必须进入快照的提交')",
      )
      .run(projectId, chatId);
});
let commits = 0;
const errors: string[] = [];
writeFileSync(readyFile, "ready\n");
try {
  while (!existsSync(stopFile)) {
    try {
      commits += 1;
      insert(commits);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown");
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
} finally {
  sqlite.close();
}
const observed = readFileSync(readyFile, "utf8").length > 0;
console.log(JSON.stringify({ commits, errors, ready: observed, stopped: existsSync(stopFile) }));
