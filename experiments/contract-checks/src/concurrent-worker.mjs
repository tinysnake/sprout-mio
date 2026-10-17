import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const { dbPath, sql, params, start } = workerData;
const sqlite = new Database(dbPath);
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

try {
  Atomics.wait(new Int32Array(start), 0, 0);
  sqlite.prepare(sql).run(...params);
  parentPort.postMessage({ ok: true, code: 'INSERTED' });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error.code, message: error.message });
} finally {
  sqlite.close();
}
