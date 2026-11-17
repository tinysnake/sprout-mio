import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFailureIn, runTaskWithLockRetry } from "./lock-retry.mjs";

function cell(t, arm = "A") {
  const root = mkdtempSync(join(tmpdir(), "ab-lock-retry-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    directory: join(root, "cell"),
    arm,
    repeat: 1,
    task: { id: "delegate-parallel-two", oracle: "delegate_parallel" },
    ref: `frozen-${arm}`,
    head: arm.repeat(40),
  };
}

function result(options, status) {
  mkdirSync(options.directory, { recursive: true });
  return {
    arm: options.arm,
    repeat: options.repeat,
    task: options.task.id,
    oracle: options.task.oracle,
    head: options.head,
    status,
    passed: status === "passed" ? true : status === "failed" ? false : null,
    evidenceDirectory: options.directory,
  };
}

function saved(directory) {
  return JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
}

test("lock detection recognizes the recorded SQLite failure and both lock markers", () => {
  for (const text of [
    "[pi-host] Run 执行失败 { data: { errorName: 'SqliteError', errorCode: 'SQLITE_BUSY', cause: 'database is locked' } }",
    "SqliteError: SQLITE_BUSY",
    "SqliteError: database is locked",
    "errorCode: SQLITE_BUSY_SNAPSHOT",
  ])
    assert.equal(lockFailureIn(text), true, text);
  for (const text of ["", "SQLITE_CONSTRAINT", "database is closed", "model request failed"])
    assert.equal(lockFailureIn(text), false, text);
});

test("both arms retry lock failures in service, fixture and worker logs in a fresh directory", async (t) => {
  for (const arm of ["A", "B"]) {
    for (const log of ["service.log", "fixture-worktree-2.log", "worker-1.log"]) {
      await t.test(`${arm} ${log}`, async (t) => {
        const options = cell(t, arm);
        const directories = [];
        const row = await runTaskWithLockRetry(options, async (attempt) => {
          assert.deepEqual({ ...attempt, directory: options.directory }, options);
          directories.push(attempt.directory);
          if (directories.length === 1) {
            const row = result(attempt, "errored");
            writeFileSync(join(attempt.directory, log), "SqliteError: database is locked");
            writeFileSync(join(attempt.directory, "stale-state"), "old state");
            return row;
          }
          assert.deepEqual(readdirSync(attempt.directory), [], "retry directory starts empty");
          return result(attempt, "passed");
        });
        assert.equal(directories.length, 2);
        assert.notEqual(directories[0], directories[1]);
        assert.equal(row.status, "passed");
        assert.equal(row.passed, true);
        assert.equal(row.retriedForLock, true);
        assert.equal(row.verdict.evaluated, true);
        assert.equal(row.evidenceDirectory, directories[1]);
        assert.deepEqual(saved(directories[1]), row);
        assert.equal(readFileSync(join(options.directory, "stale-state"), "utf8"), "old state");
      });
    }
  }
});

test("a second lock failure is excluded as errored, even if an oracle marked it failed", async (t) => {
  const options = cell(t);
  let attempts = 0;
  const row = await runTaskWithLockRetry(options, async (attempt) => {
    attempts++;
    const row = result(attempt, "failed");
    writeFileSync(join(attempt.directory, "service.log"), "SQLITE_BUSY");
    return row;
  });
  assert.equal(attempts, 2, "never attempt a third run");
  assert.equal(row.retriedForLock, true);
  assert.equal(row.status, "errored");
  assert.equal(row.passed, null);
  assert.equal(row.verdict.evaluated, false);
  assert.equal(row.verdict.passed, null);
  assert.equal(row.verdictCorrected.outcome, "errored");
  assert.equal(row.verdictCorrected.passed, null);
  assert.deepEqual(saved(row.evidenceDirectory), row);
  assert.equal(saved(options.directory).status, "errored");
});

test("ordinary failures, successful cells and interrupted cells do not retry", async (t) => {
  for (const [status, log, text] of [
    ["errored", "service.log", "SQLITE_CONSTRAINT"],
    ["failed", "service.log", "oracle failed"],
    ["errored", "unrelated.log", "SQLITE_BUSY"],
    ["passed", "service.log", "SQLITE_BUSY"],
    ["interrupted", "service.log", "SQLITE_BUSY"],
    ["aborted", "service.log", "SQLITE_BUSY"],
  ]) {
    const options = cell(t);
    let attempts = 0;
    const row = await runTaskWithLockRetry(options, async (attempt) => {
      attempts++;
      const row = result(attempt, status);
      writeFileSync(join(attempt.directory, log), text);
      return row;
    });
    assert.equal(attempts, 1, `${status}: ${log}: ${text}`);
    assert.equal(row.status, status);
    assert.equal(row.retriedForLock, undefined);
  }
});

test("cancellation after a lock failure prevents a retry", async (t) => {
  const controller = new AbortController();
  const options = { ...cell(t), signal: controller.signal };
  let attempts = 0;
  await runTaskWithLockRetry(options, async (attempt) => {
    attempts++;
    const row = result(attempt, "errored");
    writeFileSync(join(attempt.directory, "worker-init-1.log"), "SQLITE_BUSY");
    controller.abort();
    return row;
  });
  assert.equal(attempts, 1);
});

test("a timed out lock failure retries, and an ordinary retry failure remains measured", async (t) => {
  const options = cell(t);
  let attempts = 0;
  const row = await runTaskWithLockRetry(options, async (attempt) => {
    attempts++;
    const row = result(attempt, attempts === 1 ? "timeout" : "failed");
    if (attempts === 1) writeFileSync(join(attempt.directory, "service.log"), "SQLITE_BUSY");
    return row;
  });
  assert.equal(attempts, 2);
  assert.equal(row.status, "failed");
  assert.equal(row.passed, false);
  assert.equal(row.retriedForLock, true);
  assert.equal(row.verdict.evaluated, true);
});
