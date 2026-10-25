import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import type { CapabilitySnapshot, DirectoryObservation } from "../contracts/machine";
import { remoteReportSchema } from "../contracts/remote";
import type {
  RemoteCommand,
  RemoteExchangeInput,
  RemoteExchangeOutput,
  RemoteFenceAck,
  RemoteReport,
  RemoteResultPayload,
} from "../contracts/remote";
import type { WorkerSession } from "../contracts/worker-session";
import type { WorkerExchangeResponse } from "../contracts/worker";

type Frame = Extract<WorkerExchangeResponse, { ok: true }>["data"];
type Outcome = Extract<RemoteReport, { phase: "terminal" }>["outcome"];
type Entry = {
  command: RemoteCommand;
  controller: AbortController;
  report: RemoteReport;
  done: boolean;
};
const sameSession = (a: WorkerSession, b: WorkerSession) =>
  a.machineId === b.machineId &&
  a.generation === b.generation &&
  a.bootId === b.bootId &&
  a.attemptId === b.attemptId;
type BoundedText = { text: string; truncated: boolean };
const MAX_EXCHANGE_BYTES = 1048576;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
// Decoding invalid input can expand it; bound the encoded text as well as the raw input.
function boundedText(buffer: Buffer, limit: number): BoundedText {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const decoded = decoder.decode(buffer.subarray(0, limit), { stream: true });
  const incomplete = decoder.decode().length > 0;
  const encoded = Buffer.from(decoded.replaceAll("\0", ""), "utf8");
  return {
    text: new TextDecoder().decode(encoded.subarray(0, limit), { stream: true }),
    truncated:
      buffer.length > limit || encoded.length > limit || incomplete || decoded.includes("\0"),
  };
}
function degradedReport(
  report: Extract<RemoteReport, { phase: "terminal" }>,
  minimal = false,
): RemoteReport {
  const original = "failureReason" in report.payload ? report.payload.partial : report.payload;
  let partial = original;
  if (original?.kind === "shell") {
    partial = {
      ...original,
      stdout: minimal ? "" : boundedText(Buffer.from(original.stdout), 65536).text,
      stderr: minimal ? "" : boundedText(Buffer.from(original.stderr), 8192).text,
      truncated: true,
    };
  } else if (original?.kind === "file_read") {
    // Leave room for worst-case JSON escaping and the rest of the exchange envelope.
    partial = {
      ...original,
      content: minimal ? "" : boundedText(Buffer.from(original.content), 65536).text,
      truncated: true,
    };
  } else if (original?.kind === "process_list") {
    partial = {
      ...original,
      items: minimal
        ? []
        : original.items.slice(0, 200).map((item) => ({
            ...item,
            command: boundedText(Buffer.from(item.command), 256).text,
          })),
      truncated: true,
    };
  }
  const failure = {
    ...report,
    outcome: "failed" as const,
    payload: {
      kind: report.payload.kind,
      failureReason: "executor_error" as const,
      ...(partial ? { partial } : {}),
    },
  };
  return remoteReportSchema.safeParse(failure).success
    ? failure
    : { ...failure, payload: { kind: report.payload.kind, failureReason: "executor_error" } };
}
class AdmissionError extends Error {
  constructor(
    readonly reason:
      | "stale_generation"
      | "authorization_revoked"
      | "deadline"
      | "directory_unavailable"
      | "capability_unavailable",
  ) {
    super(reason);
  }
}
/** One dispatcher per connection; a closed session can drain but never regain admission. */
export class RemoteDispatcher {
  private highWater = 0;
  private closed = false;
  private authorizations = new Map<string, RemoteExchangeOutput["authorizations"][number]>();
  private entries = new Map<string, Entry>();
  private seen = new Map<string, RemoteCommand>();
  private fences = new Map<string, RemoteFenceAck>();
  private configuration: Frame["configuration"] = null;
  private observations: DirectoryObservation[] = [];
  constructor(
    readonly session: WorkerSession,
    private capability: CapabilitySnapshot,
    private now: () => number,
  ) {}
  get admissionClosed() {
    return this.closed;
  }
  get drained() {
    return (
      [...this.entries.values()].every((entry) => entry.done) &&
      this.fences.size === 0 &&
      this.entries.size === 0
    );
  }
  disconnect() {
    this.closed = true;
    for (const entry of this.entries.values()) if (!entry.done) entry.controller.abort();
  }
  rejectReports(batch: RemoteExchangeInput) {
    for (const report of batch.results) {
      const entry = this.entries.get(report.executionId);
      if (entry?.report.phase === "terminal") entry.report = degradedReport(entry.report, true);
    }
  }
  outgoing(maxBytes = MAX_EXCHANGE_BYTES): RemoteExchangeInput {
    const batch: RemoteExchangeInput = { results: [], fenceAcks: [] };
    let used = jsonBytes(batch);
    const entries = [...this.entries.values()].sort(
      (a, b) =>
        a.command.dispatchSeq - b.command.dispatchSeq ||
        (a.command.executionId < b.command.executionId
          ? -1
          : a.command.executionId === b.command.executionId
            ? 0
            : 1),
    );
    for (const entry of entries) {
      if (batch.results.length === 64) break;
      if (
        entry.report.phase === "terminal" &&
        (!remoteReportSchema.safeParse(entry.report).success ||
          jsonBytes(entry.report) + jsonBytes({ results: [], fenceAcks: [] }) > maxBytes)
      )
        entry.report = degradedReport(entry.report);
      if (
        entry.report.phase === "terminal" &&
        jsonBytes(entry.report) + jsonBytes({ results: [], fenceAcks: [] }) > maxBytes
      )
        entry.report = degradedReport(entry.report, true);
      const cost = jsonBytes(entry.report) + (batch.results.length ? 1 : 0);
      if (used + cost > maxBytes) break;
      batch.results.push(entry.report);
      used += cost;
    }
    const fences = [...this.fences.values()].sort((a, b) =>
      a.mutationId < b.mutationId ? -1 : a.mutationId === b.mutationId ? 0 : 1,
    );
    for (const ack of fences) {
      if (batch.fenceAcks.length === 64) break;
      if (!ack.executionIds.every((id) => !this.entries.has(id) || this.entries.get(id)!.done))
        continue;
      const ordered = { ...ack, executionIds: [...ack.executionIds].sort() };
      const cost = jsonBytes(ordered) + (batch.fenceAcks.length ? 1 : 0);
      if (used + cost > maxBytes) break;
      batch.fenceAcks.push(ordered);
      used += cost;
    }
    return batch;
  }
  accept(frame: Frame, expectedSeq: number, observations: DirectoryObservation[]) {
    if (
      !sameSession(frame.session, this.session) ||
      frame.seq !== expectedSeq ||
      frame.seq < this.highWater
    )
      throw new AdmissionError("stale_generation");
    if (frame.seq === this.highWater) return; // Original-frame retry is acknowledgement only.
    this.highWater = frame.seq;
    for (const fence of frame.remote.fences) {
      if (fence.machineId !== this.session.machineId) throw new AdmissionError("stale_generation");
      const old = this.authorizations.get(fence.projectId);
      if (old && old.generation === fence.authorizationGeneration)
        this.authorizations.set(fence.projectId, { ...old, state: "draining" });
      const current = this.fences.get(fence.mutationId);
      this.fences.set(fence.mutationId, {
        ...fence,
        executionIds: [...new Set([...(current?.executionIds ?? []), ...fence.executionIds])],
        dispatchSession: this.session,
      });
      for (const entry of this.entries.values())
        if (
          entry.command.projectId === fence.projectId &&
          entry.command.authorizationGeneration <= fence.authorizationGeneration &&
          !entry.done
        )
          entry.controller.abort();
    }
    for (const auth of frame.remote.authorizations) {
      if (auth.machineId !== this.session.machineId) throw new AdmissionError("stale_generation");
      const old = this.authorizations.get(auth.projectId);
      if (
        old &&
        (auth.generation < old.generation ||
          (auth.generation === old.generation &&
            old.state === "draining" &&
            auth.state === "active"))
      )
        continue;
      this.authorizations.set(auth.projectId, auth);
      for (const entry of this.entries.values())
        if (
          !entry.done &&
          entry.command.projectId === auth.projectId &&
          (auth.generation !== entry.command.authorizationGeneration ||
            auth.state !== "active" ||
            auth.holderInstanceId !== entry.command.holderInstanceId)
        )
          entry.controller.abort();
    }
    for (const ack of frame.remote.resultAcks) this.entries.delete(ack.executionId);
    for (const ack of frame.remote.fenceAcks) {
      const pending = this.fences.get(ack.mutationId);
      if (pending) {
        pending.executionIds = pending.executionIds.filter((id) => !ack.executionIds.includes(id));
        if (pending.executionIds.length === 0) this.fences.delete(ack.mutationId);
      }
    }
    if (frame.mode === "drain") {
      this.disconnect();
      return;
    }
    this.configuration = frame.configuration;
    this.observations = observations;
    for (const command of frame.remote.commands) {
      if (
        command.machineId !== this.session.machineId ||
        !sameSession(command.dispatchSession, this.session) ||
        command.dispatchSeq !== frame.seq
      )
        throw new AdmissionError("stale_generation");
      const seen = this.seen.get(command.executionId);
      if (seen) {
        if (JSON.stringify(seen) !== JSON.stringify(command))
          throw new AdmissionError("stale_generation");
        continue;
      }
      this.seen.set(command.executionId, command);
      const {
        requestId: _requestId,
        operation: _operation,
        directoryRevision: _revision,
        deadlineAt: _deadline,
        ...identity
      } = command;
      const entry: Entry = {
        command,
        controller: new AbortController(),
        done: false,
        report: { ...identity, phase: "running", drained: false },
      };
      this.entries.set(command.executionId, entry);
      // Registration is synchronous; side effects begin after the entire frame has closed gates.
      void Promise.resolve().then(() => this.execute(entry));
    }
  }
  private gate(entry: Entry) {
    const command = entry.command;
    if (this.closed || entry.controller.signal.aborted)
      throw new AdmissionError("authorization_revoked");
    const auth = this.authorizations.get(command.projectId);
    if (
      command.machineId !== this.session.machineId ||
      !sameSession(command.dispatchSession, this.session) ||
      command.dispatchSeq > this.highWater ||
      !auth ||
      auth.generation !== command.authorizationGeneration
    )
      throw new AdmissionError("stale_generation");
    if (auth.state !== "active" || auth.holderInstanceId !== command.holderInstanceId)
      throw new AdmissionError("authorization_revoked");
    if (Date.parse(command.deadlineAt) <= this.now()) throw new AdmissionError("deadline");
    if (!this.capability.remoteOperations.includes(command.operation.kind))
      throw new AdmissionError("capability_unavailable");
    if (
      command.directoryRevision !== null &&
      (this.configuration?.rootRevision !== command.directoryRevision ||
        !this.observations.some(
          (observation) =>
            observation.projectId === command.projectId &&
            observation.revision === command.directoryRevision &&
            observation.result.kind === "accessible" &&
            command.operation.kind === "shell" &&
            observation.result.realPath === command.operation.cwd,
        ))
    )
      throw new AdmissionError("directory_unavailable");
  }
  private async execute(entry: Entry) {
    let outcome: Outcome = "succeeded";
    let payload: RemoteResultPayload;
    const operation = entry.command.operation;
    let started = false;
    const deadline = setTimeout(
      () => entry.controller.abort(),
      Math.max(0, Date.parse(entry.command.deadlineAt) - this.now()),
    );
    try {
      this.gate(entry);
      if (operation.kind === "shell") {
        const shell = this.capability.shells.find((shell) => shell.probe.kind === "success");
        if (!shell) throw new AdmissionError("capability_unavailable");
        this.gate(entry);
        const child = spawn(shell.path, ["-lc", operation.command], {
          cwd: operation.cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        started = true;
        child.unref();
        let stdout = Buffer.alloc(0),
          stderr = Buffer.alloc(0),
          truncated = false,
          exited = false,
          exitCode: number | null = null;
        let collecting = true;
        const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
          if (!collecting) return;
          const cap = stream === "stdout" ? 65536 : 8192;
          const old = stream === "stdout" ? stdout : stderr;
          if (old.length + chunk.length > cap) truncated = true;
          const next = Buffer.concat([old, chunk.subarray(0, Math.max(0, cap - old.length))]);
          if (stream === "stdout") stdout = next;
          else stderr = next;
        };
        child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
        child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            entry.controller.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, operation.waitMs);
          entry.controller.signal.addEventListener("abort", finish, { once: true });
          child.once("error", reject);
          child.once("exit", (code, signal) => {
            exited = true;
            exitCode = code ?? (signal ? 128 : 1);
          });
          child.once("close", finish);
          if (entry.controller.signal.aborted) finish();
        });
        collecting = false; // Keep consuming/discarding pipes; never close or signal the child.
        const output = boundedText(stdout, 65536);
        const errorOutput = boundedText(stderr, 8192);
        payload = {
          kind: "shell",
          pid: child.pid!,
          exited,
          exitCode,
          stdout: output.text,
          stderr: errorOutput.text,
          truncated: truncated || output.truncated || errorOutput.truncated,
        };
        if (exited && exitCode !== 0) {
          outcome = "failed";
          payload = { kind: "shell", failureReason: "executor_error", partial: payload };
        }
      } else if (operation.kind === "file_read") {
        this.gate(entry);
        const file = await open(operation.path, "r");
        started = true;
        try {
          this.gate(entry);
          const buffer = Buffer.alloc(operation.maxBytes + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const content = boundedText(buffer.subarray(0, bytesRead), operation.maxBytes);
          payload = {
            kind: "file_read",
            content: content.text,
            truncated: content.truncated,
          };
        } finally {
          await file.close();
        }
      } else if (operation.kind === "file_write") {
        this.gate(entry);
        const file = await open(operation.path, operation.mode === "append" ? "a" : "w");
        started = true;
        try {
          this.gate(entry);
          await file.writeFile(operation.content, "utf8");
          payload = { kind: "file_write", bytesWritten: Buffer.byteLength(operation.content) };
        } finally {
          await file.close();
        }
      } else if (operation.kind === "process_signal") {
        this.gate(entry);
        process.kill(operation.pid, `SIG${operation.signal}`);
        started = true;
        payload = { ...operation, delivered: true };
      } else {
        this.gate(entry);
        const child = spawn("/bin/ps", ["-axo", "pid=,comm="], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        started = true;
        let buffer = Buffer.alloc(0),
          truncated = false;
        child.stdout.on("data", (chunk: Buffer) => {
          if (buffer.length + chunk.length > 262144) truncated = true;
          buffer = Buffer.concat([buffer, chunk.subarray(0, Math.max(0, 262144 - buffer.length))]);
        });
        child.stderr.resume();
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve() : reject(new Error("executor_error")),
          );
        });
        const items = buffer
          .toString("utf8")
          .split("\n")
          .flatMap((line) => {
            const match = /^\s*(\d+)\s+(.+)$/.exec(line);
            if (!match) return [];
            const command = boundedText(Buffer.from(match[2]), 1024);
            truncated ||= command.truncated;
            return [{ pid: Number(match[1]), command: command.text }];
          });
        payload = {
          kind: "process_list",
          items: items.slice(0, operation.limit),
          truncated: truncated || items.length > operation.limit,
        };
      }
      this.gate(entry); // No success can escape a revoked gate, even after an irreversible OS call.
    } catch (error) {
      const reason =
        error instanceof AdmissionError
          ? error.reason
          : entry.controller.signal.aborted
            ? "authorization_revoked"
            : "executor_error";
      const expired = this.now() >= Date.parse(entry.command.deadlineAt);
      outcome = expired
        ? started
          ? "unknown"
          : "timed_out"
        : reason === "executor_error"
          ? "failed"
          : started && reason === "authorization_revoked"
            ? "unknown"
            : "rejected";
      payload = { kind: operation.kind, failureReason: expired ? "deadline" : reason };
    } finally {
      clearTimeout(deadline);
    }
    entry.done = true;
    const {
      requestId: _requestId,
      operation: _operation,
      directoryRevision: _revision,
      deadlineAt: _deadline,
      ...identity
    } = entry.command;
    entry.report = { ...identity, phase: "terminal", drained: true, outcome, payload };
  }
}
