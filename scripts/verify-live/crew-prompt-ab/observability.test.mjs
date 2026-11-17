import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTaskError, serviceFailureOf, serviceFailureFor } from "./core.mjs";
import { rejudgeRow, backfillFailureDetail } from "./rejudge.mjs";

// The service prints the failing run pretty-printed; a single-line JSON variant exists too.
const PRETTY = [
  "[pi-host] Run 执行失败 {",
  "  level: 'error',",
  "  event: 'pi_host.run_failed',",
  "  requestId: 'delegation-delivery-prj_2376029f',",
  "  message: 'Agent run 执行失败',",
  "  data: {",
  "    errorName: 'PiHostFailure',",
  "    errorCode: 'model_error',",
  "    cause: 'Pi 模型未正常完成本轮'",
].join("\n");

const JSON_LINE = JSON.stringify({
  level: "error",
  event: "pi_host.run_failed",
  errorName: "PiHostFailure",
  errorCode: "model_error",
  message: "Agent run 执行失败",
});

test("service failure is read from both log shapes", () => {
  for (const text of [PRETTY, `2026-01-01 INFO boot\n${JSON_LINE}\n`]) {
    assert.deepEqual(serviceFailureOf(text), {
      event: "pi_host.run_failed",
      errorName: "PiHostFailure",
      errorCode: "model_error",
      message: "Agent run 执行失败",
    });
  }
});

test("clean or unrelated logs yield no service failure", () => {
  assert.equal(
    serviceFailureOf("➜ Listening on: http://localhost:1/\n[runtime] phase ready\n"),
    null,
  );
  assert.equal(serviceFailureOf(""), null);
  assert.equal(serviceFailureFor(null), null);
});

test("service failure is read from a cell directory, and missing logs are tolerated", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-service-log-"));
  writeFileSync(join(dir, "service.log"), `${PRETTY}\n`);
  assert.equal(serviceFailureFor(dir)?.errorCode, "model_error");
  assert.equal(serviceFailureFor(join(dir, "absent")), null);
  rmSync(dir, { recursive: true, force: true });
});

test("errored rows carry code, name and JSON-safe detail", () => {
  const row = { status: "errored", passed: null };
  recordTaskError(row, new Error("agent run terminated errored"), false, {
    event: "pi_host.run_failed",
    errorName: "PiHostFailure",
    errorCode: "model_error",
    message: "Agent run 执行失败",
  });
  assert.equal(row.status, "errored");
  assert.equal(row.errorCode, "model_error");
  assert.equal(row.errorName, "PiHostFailure");
  assert.equal(row.error.code, "model_error");
  const serialized = JSON.stringify(row);
  assert.doesNotMatch(serialized, /\[object Object\]/);
  assert.match(serialized, /model_error/);
});

test("a thrown code wins over the log, and a clean error keeps null codes", () => {
  const row = { status: "errored", passed: null };
  const error = Object.assign(new Error("clarify exceeded bounded budget"), {
    code: "AB_TIMEOUT",
  });
  recordTaskError(row, error);
  assert.equal(row.status, "timeout");
  assert.equal(row.errorCode, "AB_TIMEOUT");
  assert.equal(row.errorName, "Error");
  assert.equal(row.serviceFailure, undefined);
});

test("rejudge backfills the failure from the cell log", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-rejudge-observability-"));
  writeFileSync(join(dir, "service.log"), PRETTY);
  try {
    const row = backfillFailureDetail({
      status: "errored",
      passed: null,
      evidenceDirectory: dir,
    });
    assert.equal(row.errorCode, "model_error");
    assert.equal(row.errorName, "PiHostFailure");
    assert.equal(row.serviceFailure?.message, "Agent run 执行失败");
    assert.equal(
      backfillFailureDetail({ status: "passed", passed: true, evidenceDirectory: dir }).errorCode,
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejudge keeps a diagnosis it already has", () => {
  const row = backfillFailureDetail({
    status: "errored",
    passed: null,
    errorCode: "model_error",
    evidenceDirectory: "/nonexistent",
  });
  assert.equal(row.errorCode, "model_error");
  assert.equal(row.serviceFailure, undefined);
  assert.equal(typeof rejudgeRow, "function");
});
