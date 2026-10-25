import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { ID_PREFIXES, newId } from "../src/contracts/ids";
import type { CapabilitySnapshot } from "../src/contracts/machine";
import { remoteExchangeInputSchema, remoteReportSchema } from "../src/contracts/remote";
import type { RemoteCommand, RemoteExchangeOutput, RemoteReport } from "../src/contracts/remote";
import { workerExchangeInput, WORKER_PROTOCOL_VERSION } from "../src/contracts/worker";
import { RemoteDispatcher } from "../src/worker/remote";

const MAX_BYTES = 1048576;
function fixture() {
  const key = {
    projectId: newId(ID_PREFIXES.project),
    machineId: newId(ID_PREFIXES.machine),
    holderInstanceId: newId(ID_PREFIXES.instance),
  };
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
    remoteOperations: ["shell", "file_read", "process_list"],
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
  const remote = (commands: RemoteCommand[] = []): RemoteExchangeOutput => ({
    commands,
    authorizations: [{ ...key, generation: 1, state: "active" }],
    fences: [],
    resultAcks: [],
    fenceAcks: [],
  });
  const apply = (seq: number, output: RemoteExchangeOutput) =>
    dispatcher.accept(
      {
        mode: "normal",
        session,
        seq,
        configuration: { root: null, rootRevision: 1, bindings: [] },
        remote: output,
      },
      seq,
      [],
    );
  const command = (operation: RemoteCommand["operation"], seq = 1): RemoteCommand => ({
    ...key,
    executionId: newId(ID_PREFIXES.execution),
    requestId: newId(ID_PREFIXES.request),
    dispatchSession: session,
    dispatchSeq: seq,
    authorizationGeneration: 1,
    fingerprint: "a".repeat(64),
    directoryRevision: null,
    deadlineAt: new Date(Date.now() + 30000).toISOString(),
    operation,
  });
  return { key, session, dispatcher, remote, apply, command };
}
async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw new Error("metadata condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function terminal(f: ReturnType<typeof fixture>, command: RemoteCommand) {
  let report: RemoteReport | undefined;
  await until(() => {
    report = f.dispatcher.outgoing().results.find((r) => r.executionId === command.executionId);
    return report?.phase === "terminal";
  });
  if (report?.phase !== "terminal") throw new Error("terminal report missing");
  return report;
}

test("invalid UTF-8 shell and file output obey encoded limits and mark truncation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4b-report-bytes-"));
  try {
    const f = fixture();
    const shell = f.command({
      kind: "shell",
      cwd: directory,
      waitMs: 1000,
      command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.alloc(65536,255));process.stderr.write(Buffer.alloc(8192,255))'`,
    });
    f.apply(1, f.remote([shell]));
    const shellReport = await terminal(f, shell);
    expect(remoteReportSchema.safeParse(shellReport).success).toBe(true);
    expect(shellReport.outcome).toBe("succeeded");
    if (shellReport.payload.kind !== "shell" || !("stdout" in shellReport.payload))
      throw new Error("shell metadata missing");
    expect(Buffer.byteLength(shellReport.payload.stdout)).toBeLessThanOrEqual(65536);
    expect(Buffer.byteLength(shellReport.payload.stderr)).toBeLessThanOrEqual(8192);
    expect(shellReport.payload.truncated).toBe(true);
    expect(shellReport.payload.stdout.endsWith("\ufffd")).toBe(true);
    for (const [index, bytes] of [
      Buffer.alloc(262144, 255),
      Buffer.from("🙂".repeat(65536)),
    ].entries()) {
      const path = join(directory, `input-${index}`);
      await writeFile(path, bytes);
      const read = f.command(
        { kind: "file_read", path, maxBytes: index === 0 ? 262144 : 65535 },
        index + 2,
      );
      f.apply(index + 2, f.remote([read]));
      const report = await terminal(f, read);
      expect(remoteReportSchema.safeParse(report).success).toBe(true);
      if (report.payload.kind !== "file_read" || !("content" in report.payload))
        throw new Error("file metadata missing");
      expect(Buffer.byteLength(report.payload.content)).toBeLessThanOrEqual(
        read.operation.kind === "file_read" ? read.operation.maxBytes : 0,
      );
      expect(report.payload.truncated).toBe(true);
      if (index === 1) expect(report.payload.content.includes("\ufffd")).toBe(false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports and fence acknowledgements share a stable encoded batch budget without loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4b-report-batch-"));
  try {
    const path = join(directory, "input");
    await writeFile(path, Buffer.alloc(262144, 92));
    const f = fixture();
    const commands = Array.from({ length: 8 }, () =>
      f.command({ kind: "file_read", path, maxBytes: 262144 }),
    );
    f.apply(1, f.remote(commands));
    // File reads finish independently; wait for the OS work before testing the queued batch.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = f.remote();
    output.fences = commands.map((command) => ({
      projectId: f.key.projectId,
      machineId: f.key.machineId,
      mutationId: newId(ID_PREFIXES.leaseMutation),
      authorizationGeneration: 1,
      executionIds: [command.executionId],
    }));
    f.apply(2, output);
    const seen: string[] = [],
      fences: string[] = [];
    for (let seq = 3; !f.dispatcher.drained && seq < 30; seq++) {
      const batch = f.dispatcher.outgoing();
      expect(remoteExchangeInputSchema.safeParse(batch).success).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(MAX_BYTES);
      expect(batch.results.every((r) => r.phase === "terminal" && r.outcome === "succeeded")).toBe(
        true,
      );
      seen.push(...batch.results.map((r) => r.executionId));
      fences.push(...batch.fenceAcks.map((ack) => ack.mutationId));
      const ack = f.remote();
      ack.resultAcks = batch.results.map((r) => ({
        executionId: r.executionId,
        disposition: "accepted",
      }));
      ack.fenceAcks = batch.fenceAcks.map(({ mutationId, executionIds }) => ({
        mutationId,
        executionIds,
      }));
      f.apply(seq, ack);
    }
    expect(seen).toEqual(commands.map((c) => c.executionId).sort());
    expect(new Set(fences).size).toBe(8);
    expect(f.dispatcher.drained).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a single JSON-expanded result degrades to an explicit valid failure instead of blocking the queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4b-report-expanded-"));
  try {
    const path = join(directory, "input");
    await writeFile(path, Buffer.alloc(262144, 1));
    const f = fixture();
    const command = f.command({ kind: "file_read", path, maxBytes: 262144 });
    f.apply(1, f.remote([command]));
    const report = await terminal(f, command);
    expect(Buffer.byteLength(JSON.stringify(f.dispatcher.outgoing()))).toBeLessThanOrEqual(
      MAX_BYTES,
    );
    expect(remoteReportSchema.safeParse(report).success).toBe(true);
    expect(report.outcome).toBe("failed");
    expect("failureReason" in report.payload && report.payload.failureReason).toBe(
      "executor_error",
    );
    expect(
      "partial" in report.payload &&
        report.payload.partial &&
        "truncated" in report.payload.partial &&
        report.payload.partial.truncated,
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const rejection of [
  "schema",
  "malformed",
  "remote_limit",
  "remote_conflict",
  "lost_response",
  "budget",
] as const) {
  test(`real Worker preserves bounded reports and execution identity after ${rejection}`, async () => {
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), "p4b-report-http-"));
    const counter = join(directory, "counter");
    const command = f.command({
      kind: "shell",
      cwd: directory,
      waitMs: 1000,
      command: `${JSON.stringify(process.execPath)} -e 'require("node:fs").appendFileSync(${JSON.stringify(counter)},"x");process.stdout.write(Buffer.alloc(65536,${rejection === "budget" ? 1 : 255}));process.stderr.write(Buffer.alloc(8192,1))'`,
    });
    const commands =
      rejection === "budget"
        ? Array.from({ length: 8 }, () => ({
            ...command,
            executionId: newId(ID_PREFIXES.execution),
            requestId: newId(ID_PREFIXES.request),
          }))
        : [command];
    let dispatched = false,
      rejected = false,
      acknowledged = false,
      validBeforeRejection = false,
      degraded = false,
      exchanges = 0;
    const accepted = new Set<string>();
    let originalResponse: string | undefined;
    let originalFrame: string | undefined;
    let replayUnchanged = false;
    let maxFrameBytes = 0;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(Buffer.from(part));
      const raw = Buffer.concat(chunks);
      const input = JSON.parse(raw.toString());
      const envelope = { version: WORKER_PROTOCOL_VERSION, requestId: input.requestId, ok: true };
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/open")) {
        f.session.attemptId = input.attemptId;
        res.end(
          JSON.stringify({
            ...envelope,
            data: { session: f.session, pollIntervalMs: 20, staleAfterMs: 15000 },
          }),
        );
        return;
      }
      if (req.url?.endsWith("/close")) {
        res.end(JSON.stringify({ ...envelope, data: { closed: true } }));
        return;
      }
      exchanges++;
      maxFrameBytes = Math.max(maxFrameBytes, raw.byteLength);
      const reports = input.remote.results as RemoteReport[];
      const report = reports.find((r) => r.phase === "terminal");
      if (originalResponse) {
        const { requestId: _requestId, ...frame } = input;
        replayUnchanged = originalFrame === JSON.stringify(frame);
        acknowledged = true;
        originalResponse = JSON.stringify({
          ...JSON.parse(originalResponse),
          requestId: input.requestId,
        });
        res.end(originalResponse);
        originalResponse = undefined;
        return;
      }
      if (report && !rejected && rejection !== "budget" && rejection !== "lost_response") {
        rejected = true;
        validBeforeRejection = workerExchangeInput.safeParse(input).success;
        res.statusCode = 400;
        res.end(
          rejection === "malformed"
            ? "{"
            : JSON.stringify({
                ...envelope,
                ok: false,
                error: {
                  code: rejection === "schema" ? "validation_failed" : rejection,
                  message: "report rejected",
                },
              }),
        );
        return;
      }
      const output = f.remote();
      if (!dispatched && input.mode === "normal") {
        dispatched = true;
        commands.forEach((item) => {
          item.dispatchSeq = input.seq;
        });
        output.commands = commands;
      }
      if (input.mode === "drain") output.authorizations = [];
      if (
        report?.phase === "terminal" &&
        (rejected || rejection === "budget" || rejection === "lost_response")
      ) {
        degraded =
          report.outcome === "failed" &&
          "failureReason" in report.payload &&
          report.payload.failureReason === "executor_error" &&
          "partial" in report.payload &&
          report.payload.partial?.kind === "shell" &&
          report.payload.partial.truncated;
        validBeforeRejection ||= workerExchangeInput.safeParse(input).success;
        const terminalReports = reports.filter((r) => r.phase === "terminal");
        terminalReports.forEach((r) => accepted.add(r.executionId));
        acknowledged =
          accepted.size === commands.length &&
          terminalReports.every((r) => remoteReportSchema.safeParse(r).success);
        output.resultAcks = terminalReports.map((r) => ({
          executionId: r.executionId,
          disposition: "accepted",
        }));
      }
      const responseBody = JSON.stringify({
        ...envelope,
        data: {
          mode: input.mode,
          session: f.session,
          seq: input.seq,
          configuration:
            input.mode === "drain" ? null : { root: null, rootRevision: 1, bindings: [] },
          remote: output,
        },
      });
      if (report && rejection === "lost_response" && !rejected) {
        rejected = true;
        acknowledged = false;
        originalResponse = responseBody;
        const { requestId: _requestId, ...frame } = input;
        originalFrame = JSON.stringify(frame);
        res.end("{");
        return;
      }
      res.end(responseBody);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing listener");
    const identity = {
      server: `http://127.0.0.1:${address.port}`,
      machineId: f.key.machineId,
      secret: "x".repeat(43),
    };
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        "import { runWorker } from './src/worker/client.ts'; await runWorker(JSON.parse(process.env.P4B_TEST_IDENTITY));",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NO_PROXY: "localhost,127.0.0.1,::1",
          no_proxy: "localhost,127.0.0.1,::1",
          P4B_TEST_IDENTITY: JSON.stringify(identity),
        },
        stdio: "ignore",
      },
    );
    try {
      await until(() => acknowledged || child.exitCode !== null, 10000);
      // Keep failed assertions limited to booleans/lengths; never print execution output.
      console.log(
        JSON.stringify({
          rejection,
          workerExitCode: child.exitCode,
          acknowledged,
          validBeforeRejection,
          degraded,
          exchanges,
          maxFrameBytes,
        }),
      );
      expect(child.exitCode).toBe(null);
      expect(acknowledged).toBe(true);
      expect(validBeforeRejection).toBe(true);
      expect(degraded).toBe(rejection !== "budget" && rejection !== "lost_response");
      if (rejection === "lost_response") expect(replayUnchanged).toBe(true);
      expect((await stat(counter)).size).toBe(commands.length);
      expect(maxFrameBytes).toBeLessThanOrEqual(MAX_BYTES);
    } finally {
      child.kill("SIGTERM");
      await until(() => child.exitCode !== null || child.signalCode !== null);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
}
