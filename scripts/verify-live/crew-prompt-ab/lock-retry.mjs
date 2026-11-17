import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalizeVerdict } from "./core.mjs";

export function lockFailureIn(text) {
  return /SQLITE_BUSY|database is locked/i.test(text);
}

function lockedFailure(row, directory) {
  return (
    ["errored", "timeout", "failed"].includes(row.status) &&
    readdirSync(directory, { withFileTypes: true }).some(
      (entry) =>
        entry.isFile() &&
        /^(?:service|fixture-worktree-.+|worker-.+)\.log$/.test(entry.name) &&
        lockFailureIn(readFileSync(join(directory, entry.name), "utf8")),
    )
  );
}

function excludeLockFailure(row, directory) {
  row.status = "errored";
  row.passed = null;
  row.reason = "SQLite lock conflict";
  saveResult(row, directory);
}

function saveResult(row, directory) {
  finalizeVerdict(row);
  writeFileSync(join(directory, "result.json"), JSON.stringify(row, null, 2) + "\n");
}

export async function runTaskWithLockRetry(options, run) {
  const first = await run(options);
  if (options.signal?.aborted || !lockedFailure(first, options.directory)) return first;
  excludeLockFailure(first, options.directory);
  const directory = mkdtempSync(`${options.directory}-lock-retry-`);
  const row = await run({ ...options, directory });
  row.retriedForLock = true;
  if (lockedFailure(row, directory)) excludeLockFailure(row, directory);
  else saveResult(row, directory);
  return row;
}
