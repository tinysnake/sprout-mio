import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  MCP_MAX_MESSAGE_BYTES,
  mcpServerRegistrationSchema,
  type McpServerRegistration,
  type McpServerProcess,
  type McpSession,
  type ServerMcpItem,
  type WorkerMcpItem,
  type SessionCursor,
} from "../contracts/mcp";
import type { WorkerSession } from "../contracts/worker-session";
import { McpHttpConnection, probeMcpHttp } from "./mcp-http";
import type { RemoteExchangeOutput } from "../contracts/remote";
import { mcpBound, mcpHash, mcpPayloadHash, mcpSameBound } from "../domain/mcp/protocol";

type RemoteAuthorization = RemoteExchangeOutput["authorizations"][number];

type Bound = ReturnType<typeof mcpBound>;
type Control = Exclude<WorkerMcpItem, { type: "frame" }>;
type ProcessEntry = {
  fact: McpServerProcess;
  child: ChildProcessWithoutNullStreams | null;
  buffer: Buffer;
  requestTimeoutMs: number;
  probe?: Promise<void>;
};
type SessionEntry = {
  session: McpSession;
  clientAck: number;
  serverSeq: number;
  serverAck: number;
  revision: number;
  frames: Extract<WorkerMcpItem, { type: "frame" }>[];
  seen: Map<number, string>;
  active: boolean;
  http?: McpHttpConnection;
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const liveProcess = (fact: McpServerProcess) =>
  ["starting", "running", "stopping"].includes(fact.state);
const sameWorker = (a: WorkerSession, b: WorkerSession) => mcpHash(a) === mcpHash(b);

/** Machine services outlive relay attachments and Worker connection attempts. */
export class McpRuntime {
  readonly incarnationId = randomUUID();
  private processes = new Map<string, ProcessEntry>();
  private sessions = new Map<string, SessionEntry>();
  private controls = new Map<string, Control>();
  private deliveredControls = new Map<string, string>();
  private workerSession: WorkerSession | undefined;
  private draining = false;
  private authorizations = new Map<string, RemoteAuthorization>();
  private closing = new Set<Promise<void>>();
  private probeAbort = new AbortController();
  constructor(
    private registrations: McpServerRegistration[] = [],
    private now = Date.now,
  ) {}
  async start() {
    this.registrations = this.registrations.map((raw) => {
      const registration = mcpServerRegistrationSchema.parse(raw);
      if (bytes({ type: "registration_fact", registration }) > 65536)
        throw new Error("MCP registration exceeds relay control budget");
      if (registration.configHash !== mcpHash(registration.configJson))
        throw new Error("MCP config hash mismatch");
      return registration;
    });
    await Promise.all(
      this.registrations.map((registration) => this.startRegistration(registration)),
    );
  }
  private async startRegistration(registration: McpServerRegistration) {
    this.controls.set(`registration:${registration.id}:${registration.revision}`, {
      type: "registration_fact",
      registration,
    });
    const config = registration.configJson;
    if (
      registration.retiredAt !== null ||
      (config.launch === "configured_service" && !config.autostart)
    )
      return;
    const createdAt = this.now();
    const fact: McpServerProcess = {
      id: newId(ID_PREFIXES.mcpProcess),
      projectId: registration.projectId,
      machineId: registration.machineId,
      registrationId: registration.id,
      registrationRevision: registration.revision,
      transport: config.transport,
      configHash: registration.configHash,
      workerIncarnationId: this.incarnationId,
      launchNonce: randomUUID(),
      pid: null,
      processStartedAt: null,
      endpoint: config.transport === "streamableHttp" ? config.url : null,
      state: "starting",
      stateRevision: 1,
      stateHash: "0".repeat(64),
      createdAt,
      lastObservedAt: createdAt,
      endedAt: null,
      exitCode: null,
      endReason: null,
    };
    const entry: ProcessEntry = {
      fact,
      child: null,
      buffer: Buffer.alloc(0),
      requestTimeoutMs: config.requestTimeoutMs,
    };
    this.processes.set(fact.id, entry);
    this.publishProcess(entry);
    const service =
      config.transport === "stdio"
        ? config
        : config.launch === "configured_service"
          ? config.service
          : undefined;
    if (service?.envRef || (config.transport === "streamableHttp" && config.headerRef)) {
      this.ended(entry, null, config.launch === "owner_managed" ? "unreachable" : "spawn_failed");
      return;
    }
    if (service) {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(service.command, service.args, {
          cwd: service.workingDirectory,
          stdio: "pipe",
          detached: true,
        });
      } catch {
        this.ended(entry, null, "spawn_failed");
        return;
      }
      entry.child = child;
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => this.failAttached(entry, "transport_error"));
      child.stdout.on("data", (chunk: Buffer) => {
        if (config.transport === "stdio") this.receive(entry, chunk);
      });
      child.on("error", () => this.ended(entry, null, "spawn_failed"));
      child.on("exit", (code, signal) =>
        this.ended(entry, code, signal || code !== 0 ? "crashed" : "exited"),
      );
      await new Promise<void>((resolve) => {
        child.once("error", () => resolve());
        child.once("spawn", () => {
          fact.pid = config.transport === "stdio" ? child.pid! : null;
          fact.processStartedAt = this.now();
          resolve();
        });
      });
      if (!liveProcess(fact)) return;
    }
    if (config.transport === "streamableHttp") {
      const deadline = this.now() + config.requestTimeoutMs;
      while (liveProcess(fact) && !this.probeAbort.signal.aborted) {
        try {
          await probeMcpHttp(
            config.url,
            Math.max(1, deadline - this.now()),
            this.probeAbort.signal,
          );
          break;
        } catch {
          if (!service || this.now() >= deadline) {
            this.ended(entry, null, "unreachable");
            await this.stopProcess(fact.id);
            return;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(50, Math.max(1, deadline - this.now()))),
          );
        }
      }
    }
    if (fact.state === "starting" && !this.probeAbort.signal.aborted) {
      fact.state = "running";
      this.publishProcess(entry);
    }
  }
  bind(session: WorkerSession) {
    if (this.registrations.some((r) => r.machineId !== session.machineId))
      throw new Error("MCP configuration belongs to another Machine");
    if (this.workerSession && !sameWorker(session, this.workerSession)) this.disconnect();
    this.workerSession = session;
    this.draining = false;
    this.authorizations.clear();
    this.sessions.clear();
    this.controls.clear();
    for (const registration of this.registrations)
      this.controls.set(`registration:${registration.id}:${registration.revision}`, {
        type: "registration_fact",
        registration,
      });
    for (const entry of this.processes.values())
      this.controls.set(`process:${entry.fact.id}`, {
        type: "process_fact",
        process: { ...entry.fact },
      });
  }
  private publishProcess(entry: ProcessEntry) {
    const fact = entry.fact;
    fact.stateRevision++;
    fact.lastObservedAt = this.now();
    const { stateHash: _, ...state } = fact;
    fact.stateHash = mcpHash(state);
    this.controls.set(`process:${fact.id}`, { type: "process_fact", process: { ...fact } });
  }
  private ended(entry: ProcessEntry, code: number | null, reason: McpServerProcess["endReason"]) {
    if (!liveProcess(entry.fact)) return;
    if (entry.fact.state === "stopping") reason = "owner_stopped";
    entry.fact.state = reason === "owner_stopped" || reason === "exited" ? "exited" : "failed";
    entry.fact.endedAt = this.now();
    entry.fact.exitCode = code;
    entry.fact.endReason = reason;
    this.publishProcess(entry);
    this.failAttached(entry, "target_lost");
  }
  private failAttached(process: ProcessEntry, reason: NonNullable<McpSession["endReason"]>) {
    for (const entry of this.sessions.values())
      if (entry.active && entry.session.processId === process.fact.id)
        this.endSession(entry, "failed", reason);
  }
  private state(
    entry: SessionEntry,
    state: McpSession["state"],
    endReason: McpSession["endReason"] = null,
  ) {
    entry.revision++;
    entry.session.state = state;
    entry.session.endReason = endReason;
    const value = {
      type: "session_fact" as const,
      ...mcpBound(entry.session),
      state: (state === "failed"
        ? "failed"
        : state === "closed" || state === "disconnected"
          ? "detached"
          : "attached") as "failed" | "detached" | "attached",
      stateRevision: entry.revision,
      reason: endReason,
    };
    const item = { ...value, stateHash: mcpHash(value) };
    this.controls.set(`session:${entry.session.id}`, item);
  }
  private endSession(
    entry: SessionEntry,
    state: "closed" | "disconnected" | "failed",
    reason: NonNullable<McpSession["endReason"]>,
  ) {
    if (!entry.active) return;
    entry.active = false;
    if (entry.http) {
      const closing = entry.http
        .close()
        .catch(() => {
          entry.session.state = "failed";
          entry.session.endReason = "transport_error";
          if (this.sessions.get(entry.session.id) === entry)
            this.state(entry, "failed", "transport_error");
        })
        .finally(() => this.closing.delete(closing));
      this.closing.add(closing);
    }
    entry.frames = [];
    entry.session.endedAt = this.now();
    this.state(entry, state, reason);
  }
  disconnect() {
    this.draining = true;
    for (const entry of this.sessions.values())
      this.endSession(entry, "disconnected", "worker_lost");
  }
  accept(items: ServerMcpItem[], cursors: SessionCursor[], authorizations: RemoteAuthorization[]) {
    for (const [key, hash] of this.deliveredControls)
      if (this.controls.has(key) && mcpHash(this.controls.get(key)) === hash)
        this.controls.delete(key);
    this.deliveredControls.clear();
    for (const [id, entry] of this.sessions)
      if (!entry.active && !this.controls.has(`session:${id}`)) this.sessions.delete(id);
    for (const auth of authorizations) {
      const old = this.authorizations.get(auth.projectId);
      if (
        !old ||
        auth.generation > old.generation ||
        (auth.generation === old.generation && old.state === "active")
      )
        this.authorizations.set(auth.projectId, auth);
    }
    for (const entry of this.sessions.values())
      if (entry.active && !this.authorized(mcpBound(entry.session)))
        this.endSession(entry, "closed", "authorization_revoked");
    for (const cursor of cursors) {
      const entry = this.sessions.get(cursor.sessionId);
      if (!entry || !mcpSameBound(cursor, mcpBound(entry.session))) continue;
      if (
        cursor.serverAcceptedThrough > entry.serverSeq ||
        cursor.clientAcceptedThrough > entry.clientAck
      )
        throw new Error("MCP cursor ahead of delivery");
      entry.serverAck = Math.max(entry.serverAck, cursor.serverAcceptedThrough);
      entry.frames = entry.frames.filter((frame) => frame.seq > entry.serverAck);
    }
    for (const item of items) this.acceptItem(item);
  }
  private authorized(bound: Bound) {
    const auth = this.authorizations.get(bound.projectId);
    return (
      !this.draining &&
      this.workerSession &&
      sameWorker(bound.workerSession, this.workerSession) &&
      bound.machineId === this.workerSession.machineId &&
      auth?.machineId === bound.machineId &&
      auth.state === "active" &&
      auth.generation === bound.authorizationGeneration &&
      auth.holderInstanceId === bound.holderInstanceId
    );
  }
  private acceptItem(item: ServerMcpItem) {
    if (item.type === "session_reconcile") {
      if (
        !this.workerSession ||
        item.machineId !== this.workerSession.machineId ||
        !sameWorker(item.workerSession, this.workerSession) ||
        item.sessions.some(
          (bound) =>
            bound.machineId !== item.machineId ||
            !sameWorker(bound.workerSession, item.workerSession) ||
            !this.authorized(bound),
        )
      )
        throw new Error("MCP reconciliation identity rejected");
      const retained = new Map(item.sessions.map((bound) => [bound.sessionId, bound]));
      for (const [id, entry] of this.sessions) {
        const bound = retained.get(id);
        if (bound && !mcpSameBound(bound, mcpBound(entry.session)))
          throw new Error("MCP reconciliation session identity rejected");
      }
      for (const [id, entry] of this.sessions)
        if (!retained.has(id)) this.endSession(entry, "closed", "client_closed");
      this.controls.set("reconcile", { ...item, type: "session_reconcile_ack" });
      return;
    }
    if (item.type === "session_fence") {
      if (!this.workerSession || !sameWorker(item.workerSession, this.workerSession))
        throw new Error("MCP stale fence");
      for (const target of item.sessions) {
        const entry = this.sessions.get(target.sessionId);
        if (
          entry &&
          (entry.session.processId !== target.processId ||
            entry.session.projectId !== item.projectId ||
            entry.session.machineId !== item.machineId ||
            entry.session.authorizationGeneration !== item.authorizationGeneration ||
            entry.session.holderInstanceId !== item.holderInstanceId)
        )
          throw new Error("MCP fence identity mismatch");
        if (entry) this.endSession(entry, "closed", "authorization_revoked");
      }
      this.controls.set(`fence:${item.mutationId}`, {
        ...item,
        type: "session_fence_ack",
        detached: true,
      });
      return;
    }
    if (item.type === "session_attach") {
      const session = item.session;
      const bound = mcpBound(session);
      if (
        item.configHash !== session.configHash ||
        !mcpSameBound(item, bound) ||
        !this.authorized(bound)
      )
        throw new Error("MCP session authorization rejected");
      const old = this.sessions.get(session.id);
      if (old) {
        if (
          old.session.openHash !== session.openHash ||
          !mcpSameBound(bound, mcpBound(old.session))
        )
          throw new Error("MCP session identity conflict");
        return;
      }
      const process = this.processes.get(session.processId);
      if (
        !process ||
        [...this.sessions.values()].some(
          (s) => s.active && s.session.processId === process.fact.id,
        ) ||
        process.fact.state !== "running" ||
        process.fact.projectId !== session.projectId ||
        process.fact.machineId !== session.machineId ||
        process.fact.configHash !== session.configHash ||
        process.fact.registrationId !== session.registrationId ||
        process.fact.registrationRevision !== session.registrationRevision ||
        process.fact.workerIncarnationId !== session.workerIncarnationId ||
        session.transport !== process.fact.transport
      )
        throw new Error("MCP exact process unavailable");
      if ([...this.sessions.values()].filter((s) => s.active).length >= 8)
        throw new Error("MCP session limit");
      const entry: SessionEntry = {
        session: { ...session, attachedAt: this.now() },
        clientAck: 0,
        serverSeq: 0,
        serverAck: 0,
        revision: 0,
        frames: [],
        seen: new Map(),
        active: true,
      };
      if (process.fact.transport === "streamableHttp") {
        entry.http = new McpHttpConnection(
          process.fact.endpoint!,
          process.requestTimeoutMs,
          (payload) => this.receivePayload(entry, payload),
          () => this.ended(process, null, "unreachable"),
        );
      }
      this.sessions.set(session.id, entry);
      this.state(entry, "connecting");
      return;
    }
    const entry = this.sessions.get(item.sessionId);
    if (!entry && item.type === "session_detach") {
      if (
        !this.workerSession ||
        item.machineId !== this.workerSession.machineId ||
        !sameWorker(item.workerSession, this.workerSession)
      )
        throw new Error("MCP session identity rejected");
      return;
    }
    if (!entry || !mcpSameBound(item, mcpBound(entry.session)))
      throw new Error("MCP session identity rejected");
    if (item.type === "session_detach") {
      this.endSession(entry, "closed", item.reason as NonNullable<McpSession["endReason"]>);
      return;
    }
    if (!entry.active || !this.authorized(item)) throw new Error("MCP stale authorization");
    if (item.type === "session_protocol") {
      if (entry.session.protocolVersion && entry.session.protocolVersion !== item.protocolVersion)
        throw new Error("MCP protocol changed");
      entry.session.protocolVersion = item.protocolVersion;
      entry.http?.setProtocolVersion(item.protocolVersion);
      entry.session.connectedAt ??= this.now();
      this.state(entry, "connected");
      return;
    }
    if (item.type === "cancel_frames") {
      for (const tombstone of [...item.tombstones].sort((a, b) => a.clientSeq - b.clientSeq)) {
        const identity = `${tombstone.frameId}:${tombstone.payloadHash}`;
        const seen = entry.seen.get(tombstone.clientSeq);
        if (seen && seen !== identity) throw new Error("MCP cancel identity conflict");
        if (!seen && tombstone.clientSeq !== entry.clientAck + 1)
          throw new Error("MCP cancel sequence gap");
        entry.seen.set(tombstone.clientSeq, identity);
        entry.clientAck = Math.max(entry.clientAck, tombstone.clientSeq);
      }
      return;
    }
    const old = entry.seen.get(item.seq);
    if (old) {
      if (old !== `${item.frameId}:${item.payloadHash}`)
        throw new Error("MCP frame replay conflict");
      return;
    }
    if (item.seq !== entry.clientAck + 1 || item.expiresAt <= this.now())
      throw new Error("MCP frame sequence or expiry rejected");
    const payload = Buffer.from(item.payloadBase64, "base64");
    if (
      payload.length !== item.payloadBytes ||
      payload.length > MCP_MAX_MESSAGE_BYTES ||
      mcpPayloadHash(payload) !== item.payloadHash ||
      payload.includes(10) ||
      payload.includes(13)
    )
      throw new Error("MCP invalid stdio frame");
    const processEntry = this.processes.get(item.processId);
    if (
      !processEntry ||
      processEntry.fact.state !== "running" ||
      (processEntry.child && (processEntry.child.killed || processEntry.child.exitCode !== null))
    ) {
      this.endSession(entry, "failed", "target_lost");
      throw new Error("MCP exact process lost");
    }
    if (entry.http) {
      try {
        entry.http.enqueue(payload);
      } catch {
        this.endSession(entry, "failed", "overflow");
        return;
      }
    } else {
      const child = processEntry.child!;
      if (child.stdin.writableLength + payload.length > 524288) {
        this.endSession(entry, "failed", "overflow");
        return;
      }
      child.stdin.write(Buffer.concat([payload, Buffer.from("\n")]));
    }
    entry.clientAck = item.seq;
    entry.seen.set(item.seq, `${item.frameId}:${item.payloadHash}`);
    if (entry.seen.size > 128) entry.seen.delete(entry.seen.keys().next().value!);
  }
  private receive(process: ProcessEntry, chunk: Buffer) {
    process.buffer = Buffer.concat([process.buffer, chunk]);
    let index: number;
    while ((index = process.buffer.indexOf(10)) !== -1) {
      const payload = process.buffer.subarray(0, index);
      process.buffer = process.buffer.subarray(index + 1);
      const entry = [...this.sessions.values()].find(
        (s) => s.active && s.session.processId === process.fact.id,
      );
      if (!entry) continue;
      this.receivePayload(entry, payload);
    }
    if (process.buffer.length > MCP_MAX_MESSAGE_BYTES) {
      process.buffer = Buffer.alloc(0);
      this.failAttached(process, "overflow");
    }
  }
  private receivePayload(entry: SessionEntry, payload: Buffer) {
    if (!entry.active) return;
    if (!this.authorized(mcpBound(entry.session))) {
      this.endSession(entry, "closed", "authorization_revoked");
      return;
    }
    if (
      !payload.length ||
      payload.length > MCP_MAX_MESSAGE_BYTES ||
      entry.frames.reduce((n, f) => n + f.payloadBytes, payload.length) > 1048576 ||
      entry.frames.length >= 64
    ) {
      this.endSession(entry, "failed", "overflow");
      return;
    }
    entry.frames.push({
      type: "frame",
      direction: "server_to_client",
      ...mcpBound(entry.session),
      frameId: newId(ID_PREFIXES.mcpFrame),
      seq: ++entry.serverSeq,
      payloadBase64: payload.toString("base64"),
      payloadBytes: payload.length,
      payloadHash: mcpPayloadHash(payload),
      expiresAt: this.now() + 120000,
    });
  }
  outgoing(maxBytes = 1048576): { mcp: WorkerMcpItem[]; mcpCursors: SessionCursor[] } {
    for (const entry of this.processes.values()) {
      if (entry.fact.state !== "running" || this.now() - entry.fact.lastObservedAt < 10000)
        continue;
      if (entry.fact.transport === "stdio") this.publishProcess(entry);
      else if (!entry.probe && !this.draining && !this.probeAbort.signal.aborted) {
        entry.probe = probeMcpHttp(
          entry.fact.endpoint!,
          entry.requestTimeoutMs,
          this.probeAbort.signal,
        )
          .then(() => {
            if (entry.fact.state === "running" && !this.probeAbort.signal.aborted)
              this.publishProcess(entry);
          })
          .catch(() => {
            if (!this.probeAbort.signal.aborted) this.ended(entry, null, "unreachable");
          })
          .finally(() => {
            entry.probe = undefined;
          });
      }
    }
    const result: { mcp: WorkerMcpItem[]; mcpCursors: SessionCursor[] } = {
      mcp: [],
      mcpCursors: [],
    };
    let controlBytes = 0,
      frameBytes = 0;
    const add = (item: WorkerMcpItem) => {
      const cost = bytes(item);
      if (
        result.mcp.length >= 64 ||
        (item.type === "frame" ? frameBytes + cost > 524288 : controlBytes + cost > 65536) ||
        bytes(result) + cost + 1 > maxBytes
      )
        return false;
      result.mcp.push(item);
      if (item.type === "frame") frameBytes += cost;
      else controlBytes += cost;
      return true;
    };
    for (const entry of this.sessions.values()) {
      const cursor = {
        ...mcpBound(entry.session),
        clientAcceptedThrough: entry.clientAck,
        serverAcceptedThrough: entry.serverAck,
      };
      if (result.mcpCursors.length < 8 && bytes(result) + bytes(cursor) + 1 <= maxBytes)
        result.mcpCursors.push(cursor);
    }
    for (const [key, item] of this.controls) {
      if (
        this.draining &&
        ["registration_fact", "registration_retire", "process_fact"].includes(item.type)
      )
        continue;
      if (add(item)) this.deliveredControls.set(key, mcpHash(item));
    }
    for (const entry of this.sessions.values()) {
      if (entry.active && entry.frames.some((frame) => frame.expiresAt <= this.now()))
        this.endSession(entry, "failed", "timeout");
      for (const frame of entry.frames) if (!add(frame)) break;
    }
    return result;
  }
  get drained() {
    return (
      ![...this.controls.values()].some(
        (item) => item.type === "session_fact" || item.type === "session_fence_ack",
      ) && [...this.sessions.values()].every((entry) => !entry.frames.length)
    );
  }
  async stopProcess(processId: string) {
    const entry = this.processes.get(processId);
    if (!entry?.child?.pid || entry.child.exitCode !== null || entry.child.signalCode !== null)
      return;
    const child = entry.child;
    if (liveProcess(entry.fact)) {
      entry.fact.state = "stopping";
      this.publishProcess(entry);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 2000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        this.ended(entry, code, "owner_stopped");
        resolve();
      });
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        clearTimeout(timer);
        this.ended(entry, null, "owner_stopped");
        resolve();
      }
    });
  }
  async stop() {
    this.probeAbort.abort();
    this.disconnect();
    const probes = [...this.processes.values()].flatMap((entry) =>
      entry.probe ? [entry.probe] : [],
    );
    await Promise.all(probes);
    await Promise.all(this.closing);
    await Promise.all([...this.processes.keys()].map((id) => this.stopProcess(id)));
  }
}

export async function readMcpConfig(path: string, machineId: string) {
  const registrations = z
    .array(mcpServerRegistrationSchema)
    .max(64)
    .parse(JSON.parse(await readFile(path, "utf8")));
  if (
    registrations.some((r) => r.machineId !== machineId) ||
    new Set(registrations.map((r) => `${r.id}:${r.revision}`)).size !== registrations.length
  )
    throw new Error("Invalid Machine MCP configuration");
  return registrations;
}
