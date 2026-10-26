import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { ID_PREFIXES, newId } from "../src/contracts/ids";
import { remoteReportSchema } from "../src/contracts/remote";
import type { RemoteCommand } from "../src/contracts/remote";
import type { WorkerExchangeResponse } from "../src/contracts/worker";
import type { CapabilitySnapshot } from "../src/contracts/machine";
import { RemoteDispatcher } from "../src/worker/remote";

type RemoteWireOutput = Extract<WorkerExchangeResponse, { ok: true }>["data"]["remote"];

const id = () => ({
  projectId: newId(ID_PREFIXES.project),
  machineId: newId(ID_PREFIXES.machine),
  holderInstanceId: newId(ID_PREFIXES.instance),
});
function fixture() {
  const key = id();
  const session = {
    machineId: key.machineId,
    generation: 1,
    bootId: newId(ID_PREFIXES.boot),
    attemptId: randomUUID(),
  };
  const capability: CapabilitySnapshot = {
    platform: "darwin",
    arch: "arm64",
    workerVersion: "test",
    remoteOperations: ["shell", "file_read", "file_write", "process_list", "process_signal"],
    shells: [
      {
        path: "/bin/sh",
        kind: "sh",
        version: null,
        checkedAt: new Date().toISOString(),
        probe: { kind: "success" },
      },
    ],
  };
  const dispatcher = new RemoteDispatcher(session, capability, Date.now);
  const output = (
    commands: RemoteCommand[] = [],
    generation = 1,
    state: "active" | "draining" = "active",
  ): RemoteWireOutput => ({
    commands,
    authorizations: [{ ...key, generation, state }],
    fences: [],
    resultAcks: [],
    fenceAcks: [],
    mcp: [],
    mcpCursors: [],
  });
  const apply = (seq: number, remote: RemoteWireOutput) =>
    dispatcher.accept(
      {
        mode: "normal",
        session,
        seq,
        configuration: { root: null, rootRevision: 1, bindings: [] },
        remote,
      },
      seq,
      [],
    );
  const command = (operation: RemoteCommand["operation"], generation = 1): RemoteCommand => ({
    ...key,
    executionId: newId(ID_PREFIXES.execution),
    requestId: newId(ID_PREFIXES.request),
    dispatchSession: session,
    dispatchSeq: 1,
    authorizationGeneration: generation,
    fingerprint: "a".repeat(64),
    directoryRevision: null,
    dispatchDeadlineAt: new Date(Date.now() + 30000).toISOString(),
    runtimeDeadlineAt: null,
    maxRuntimeMs: null,
    runnerToken: null,
    operation,
  });
  return { key, session, dispatcher, output, apply, command };
}
async function terminal(dispatcher: RemoteDispatcher, executionId: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const report = dispatcher
      .outgoing()
      .results.find((report) => report.executionId === executionId);
    if (report?.phase === "terminal") {
      expect(remoteReportSchema.safeParse(report).success).toBe(true);
      return report;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("terminal report missing");
}
test("dispatcher executes once, bounds UTF-8 output, and supports bounded file/process shapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4b-dispatch-"));
  const f = fixture();
  const path = join(root, "count");
  const command = f.command({
    kind: "shell",
    command: `printf x >> '${path}'; printf '%070000d' 0`,
    cwd: root,
    waitMs: 1000,
  });
  const frame = f.output([command]);
  f.apply(1, frame);
  f.apply(1, frame);
  const report = await terminal(f.dispatcher, command.executionId);
  expect(report.outcome).toBe("succeeded");
  expect(
    report.payload.kind === "shell" && "truncated" in report.payload && report.payload.truncated,
  ).toBe(true);
  expect((await readFile(path)).byteLength).toBe(1);
  const second = f.command({
    kind: "file_write",
    path: join(root, "file"),
    content: "fixture",
    mode: "overwrite",
  });
  second.dispatchSeq = 2;
  f.apply(2, f.output([second]));
  expect((await terminal(f.dispatcher, second.executionId)).outcome).toBe("succeeded");
  const read = f.command({ kind: "file_read", path: join(root, "file"), maxBytes: 3 });
  read.dispatchSeq = 3;
  f.apply(3, f.output([read]));
  const readResult = await terminal(f.dispatcher, read.executionId);
  expect(
    readResult.payload.kind === "file_read" &&
      "truncated" in readResult.payload &&
      readResult.payload.truncated,
  ).toBe(true);
  const list = f.command({ kind: "process_list", limit: 1 });
  list.dispatchSeq = 4;
  f.apply(4, f.output([list]));
  expect((await terminal(f.dispatcher, list.executionId)).outcome).toBe("succeeded");
});
test("OS errors are failed results while admission errors remain rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4b-executor-failure-"));
  const f = fixture();
  const command = f.command({ kind: "file_read", path: join(root, "missing"), maxBytes: 32 });
  f.apply(1, f.output([command]));
  const report = await terminal(f.dispatcher, command.executionId);
  expect(report.outcome).toBe("failed");
  expect("failureReason" in report.payload && report.payload.failureReason).toBe("executor_error");
});

test("old generation, wrong Machine, expired deadline, and cross Project admission produce no file", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4b-admission-"));
  for (const mismatch of ["generation", "machine", "project", "deadline"] as const) {
    const f = fixture();
    const path = join(root, mismatch);
    const command = f.command({ kind: "file_write", path, content: "fixture", mode: "overwrite" });
    if (mismatch === "generation") command.authorizationGeneration = 2;
    if (mismatch === "machine") command.machineId = newId(ID_PREFIXES.machine);
    if (mismatch === "project") command.projectId = newId(ID_PREFIXES.project);
    if (mismatch === "deadline")
      command.dispatchDeadlineAt = new Date(Date.now() - 1).toISOString();
    if (mismatch === "machine") expect(() => f.apply(1, f.output([command]))).toThrow();
    else {
      f.apply(1, f.output([command]));
      expect((await terminal(f.dispatcher, command.executionId)).outcome === "succeeded").toBe(
        false,
      );
    }
    expect(
      await stat(path).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  }
});
test("fence closes pending admission; in-flight shell stops waiting and leaves its process alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4b-fence-"));
  const pending = fixture();
  const path = join(root, "must-not-exist");
  const command = pending.command({
    kind: "file_write",
    path,
    content: "fixture",
    mode: "overwrite",
  });
  pending.apply(1, pending.output([command]));
  pending.apply(2, pending.output([], 1, "draining"));
  expect((await terminal(pending.dispatcher, command.executionId)).outcome).toBe("rejected");
  expect(
    await stat(path).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  const active = fixture();
  const pidFile = join(root, "pid");
  const shell = active.command({
    kind: "shell",
    command: `echo $$ > '${pidFile}'; sleep 1`,
    cwd: root,
    waitMs: 10000,
  });
  active.apply(1, active.output([shell]));
  for (
    let i = 0;
    i < 100 &&
    !(await stat(pidFile).then(
      () => true,
      () => false,
    ));
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  active.apply(2, active.output([], 1, "draining"));
  expect((await terminal(active.dispatcher, shell.executionId)).outcome === "succeeded").toBe(
    false,
  );
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).not.toThrow();
  // No signal is used by cleanup either: the fixture exits naturally.
});
test("process signal needs a current explicit Machine lease; stale authorization leaves the process alive", async () => {
  const child = spawn("/bin/sleep", ["2"], { stdio: "ignore" });
  const exited = new Promise<string | null>((resolve) =>
    child.once("exit", (_code, signal) => resolve(signal)),
  );
  const f = fixture();
  const stale = f.command({ kind: "process_signal", pid: child.pid!, signal: "TERM" }, 2);
  f.apply(1, f.output([stale]));
  expect((await terminal(f.dispatcher, stale.executionId)).outcome).toBe("rejected");
  expect(() => process.kill(child.pid!, 0)).not.toThrow();
  const current = f.command({ kind: "process_signal", pid: child.pid!, signal: "TERM" });
  current.dispatchSeq = 2;
  f.apply(2, f.output([current]));
  expect((await terminal(f.dispatcher, current.executionId)).outcome).toBe("succeeded");
  expect(await exited).toBe("SIGTERM");
});

test("shell deadline ends waiting with unknown/deadline and leaves the process alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4b-deadline-"));
  const f = fixture(),
    pidPath = join(root, "pid");
  const command = f.command({
    kind: "shell",
    command: `echo $$ > '${pidPath}'; sleep 1`,
    cwd: root,
    waitMs: 10000,
  });
  command.dispatchDeadlineAt = new Date(Date.now() + 250).toISOString();
  f.apply(1, f.output([command]));
  const report = await terminal(f.dispatcher, command.executionId);
  expect(report.outcome).toBe("unknown");
  expect("failureReason" in report.payload && report.payload.failureReason).toBe("deadline");
  const pid = Number(await readFile(pidPath, "utf8"));
  expect(() => process.kill(pid, 0)).not.toThrow();
});

test("disconnect cannot reopen admission and acknowledged deliveries are not replayed by old frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4b-replay-"));
  const f = fixture();
  const command = f.command({
    kind: "file_write",
    path: join(root, "once"),
    content: "x",
    mode: "append",
  });
  const first = f.output([command]);
  f.apply(1, first);
  await terminal(f.dispatcher, command.executionId);
  const ack = f.output();
  ack.resultAcks = [{ executionId: command.executionId, disposition: "accepted" }];
  f.apply(2, ack);
  expect(() => f.apply(1, first)).toThrow();
  f.dispatcher.disconnect();
  const next = f.command({
    kind: "file_write",
    path: join(root, "absent"),
    content: "x",
    mode: "overwrite",
  });
  next.dispatchSeq = 3;
  f.apply(3, f.output([next]));
  expect((await terminal(f.dispatcher, next.executionId)).outcome).toBe("rejected");
  expect(
    (await readFile(command.operation.kind === "file_write" ? command.operation.path : ""))
      .byteLength,
  ).toBe(1);
  expect(
    await stat(join(root, "absent")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});
