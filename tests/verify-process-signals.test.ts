import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { reportSignalFailure, signalProcessGroup } from "../scripts/verify/lib/process-signals.mjs";

function failure(code: string) {
  const error = new Error(`kill ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

function recorder() {
  const calls: Array<{ pid: number; signal: string; code: string | undefined }> = [];
  return {
    calls,
    report: (pid: number, signal: string, error: { message: string; code?: string }): void => {
      calls.push({ pid, signal, code: error.code });
    },
  };
}

test("信号发给整个进程组，成功时不报告", () => {
  const sent: Array<{ pid: number; signal: string }> = [];
  const { calls, report } = recorder();
  const result = signalProcessGroup(4242, "SIGTERM", {
    kill: (pid, signal) => sent.push({ pid, signal }),
    report,
  });

  assert.deepEqual(sent, [{ pid: -4242, signal: "SIGTERM" }]);
  assert.deepEqual(result, { delivered: true, reported: false });
  assert.deepEqual(calls, []);
});

test("进程组已经退出（ESRCH）时不报告——这是中断运行里的正常情形", () => {
  const { calls, report } = recorder();
  const result = signalProcessGroup(4242, "SIGKILL", {
    kill: () => {
      throw failure("ESRCH");
    },
    report,
  });

  assert.deepEqual(result, { delivered: false, reported: false });
  assert.deepEqual(calls, []);
});

test("EPERM 且组内只剩僵尸时不报告（macOS 对已消失的组回 EPERM）", () => {
  const { calls, report } = recorder();
  const result = signalProcessGroup(4242, "SIGKILL", {
    kill: () => {
      throw failure("EPERM");
    },
    group: () => false,
    report,
  });

  assert.deepEqual(result, { delivered: false, reported: false });
  assert.deepEqual(calls, []);
});

test("EPERM 而探针自己也跑不动（null）时报告一次，不抛出", () => {
  const { calls, report } = recorder();
  const result = signalProcessGroup(4242, "SIGKILL", {
    kill: () => {
      throw failure("EPERM");
    },
    group: () => null,
    report,
  });

  assert.deepEqual(result, { delivered: false, reported: true });
  assert.deepEqual(calls, [{ pid: 4242, signal: "SIGKILL", code: "EPERM" }]);
});

test("EPERM 但组内仍有活进程时报告一次——漏杀残留进程比打断 runner 更可接受", () => {
  const { calls, report } = recorder();
  const result = signalProcessGroup(4242, "SIGKILL", {
    kill: () => {
      throw failure("EPERM");
    },
    group: () => true,
    report,
  });

  assert.deepEqual(result, { delivered: false, reported: true });
  assert.deepEqual(calls, [{ pid: 4242, signal: "SIGKILL", code: "EPERM" }]);
});

test("其它 errno（如 EINVAL）也只报告：曾经在这里抛出过，把 SIGTERM 中断的退出码从 143 变成 1", () => {
  const { calls, report } = recorder();
  const result = signalProcessGroup(4242, "SIGTERM", {
    kill: () => {
      throw failure("EINVAL");
    },
    group: () => true,
    report,
  });

  assert.deepEqual(result, { delivered: false, reported: true });
  assert.deepEqual(calls, [{ pid: 4242, signal: "SIGTERM", code: "EINVAL" }]);
});

test("失败行写进 stderr 文本：带上信号、进程号与原因，并提示残留进程要手工清理", () => {
  const lines: string[] = [];
  const line = reportSignalFailure(4242, "SIGKILL", failure("EPERM"), {
    write: (value) => lines.push(value),
  });

  assert.deepEqual(lines, [line]);
  assert.match(line, /verify: signal SIGKILL to process 4242 failed: kill EPERM/);
  assert.match(line, /残留进程需手工清理/);
  assert.ok(line.endsWith("\n"));
});
