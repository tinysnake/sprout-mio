import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../src/db/migrate";
import { openDatabase } from "../src/db/connection";
import { appIdPattern, ID_PREFIXES, newId } from "../src/contracts/ids";
import * as mcp from "../src/contracts/mcp";
import { remoteAgentRequestSchema } from "../src/contracts/remote";
import { capabilitySnapshotSchema } from "../src/contracts/machine";
import { workerExchangeInput, WORKER_PROTOCOL_VERSION } from "../src/contracts/worker";

type Row = Record<string, string | number | null>;
const pass = (name: string) => console.log(`PASS ${name}`);

function sqliteProbe() {
  const url = process.env.DATABASE_URL;
  assert(url && url !== ":memory:", "isolated DATABASE_URL required");
  migrateDatabase(url);
  const { sqlite } = openDatabase(url);
  const insert = (table: string, row: Row) => {
    const keys = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...Object.values(row));
  };
  const rollback = (operation: () => void) => {
    sqlite.exec("SAVEPOINT probe");
    try {
      operation();
    } finally {
      sqlite.exec("ROLLBACK TO probe; RELEASE probe");
    }
  };
  const rejects = (name: string, table: string, good: Row, bad: Row, pattern = /CHECK/) => {
    rollback(() => insert(table, good));
    rollback(() => assert.throws(() => insert(table, { ...good, ...bad }), pattern));
    pass(name);
  };
  try {
    insert("user", {
      id: "owner",
      name: "Owner",
      email: "mcp-owner@example.test",
      email_verified: 0,
      created_at: 1,
      updated_at: 1,
    });
    insert("agent_profile", { id: "profile", name: "Agent", created_by: "owner" });
    insert("machine", {
      id: "machine",
      name: "Machine",
      created_by: "owner",
      created_at: 1,
      updated_at: 1,
    });
    insert("runtime_boot", {
      id: "boot",
      started_at: 1,
      phase: "ready",
      pid: 1,
      app_version: "test",
    });
    insert("machine_connection", {
      machine_id: "machine",
      generation: 1,
      attempt_id: "attempt",
      boot_id: "boot",
      status: "open",
      opened_at: 1,
      last_seen_at: 1,
    });
    for (const p of ["a", "b"]) {
      insert("project", { id: p, name: p, created_by: "owner" });
      insert("chat", { id: `chat-${p}`, project_id: p, kind: "dm", created_by: "owner" });
      insert("agent_instance", {
        id: `instance-${p}`,
        agent_profile_id: "profile",
        chat_id: `chat-${p}`,
        project_id: p,
      });
      insert("agent_run", {
        id: `run-${p}`,
        instance_id: `instance-${p}`,
        project_id: p,
        chat_id: `chat-${p}`,
        request_id: `request-${p}`,
        status: "running",
        started_at: 1,
        session_id: `pi-${p}`,
      });
      insert("project_machine", {
        project_id: p,
        machine_id: "machine",
        created_by: "owner",
        revision: 1,
        created_at: 1,
        updated_at: 1,
      });
      insert("machine_lease", {
        project_id: p,
        machine_id: "machine",
        generation: 1,
        state: "held",
        holder_instance_id: `instance-${p}`,
        changed_at: 10,
      });
      insert("lease_authorization", {
        project_id: p,
        machine_id: "machine",
        generation: 1,
        holder_instance_id: `instance-${p}`,
        state: "active",
        issued_at: 10,
        reason: "acquire",
      });
      insert("remote_tool_grant", {
        id: `grant-${p}`,
        secret_hash: (p === "a" ? "a" : "b").repeat(64),
        user_id: "owner",
        project_id: p,
        chat_id: `chat-${p}`,
        instance_id: `instance-${p}`,
        run_id: `run-${p}`,
        issued_at: 10,
        expires_at: 1000,
      });
    }
    const registration: Row = {
      id: "registration",
      revision: 1,
      project_id: "a",
      machine_id: "machine",
      name: "everything",
      transport: "stdio",
      config_ref: "everything",
      config_hash: "a".repeat(64),
      config_json: JSON.stringify({
        transport: "stdio",
        command: "/usr/bin/true",
        args: [],
        cwd: "/tmp",
        envRefs: {},
        roots: [],
        toolAllowlist: ["echo"],
        exposeResources: false,
        exposeSampling: false,
        exposeElicitation: false,
        requestTimeoutMs: 120000,
      }),
      created_at: 10,
      retired_at: null,
    };
    rejects("registration retired_at precedes creation", "mcp_server_registration", registration, {
      retired_at: 9,
    });
    rejects(
      "registration JSON must be object",
      "mcp_server_registration",
      registration,
      { config_json: "[]" },
      /mcp_registration_config_object/,
    );
    rejects(
      "registration JSON transport must match",
      "mcp_server_registration",
      registration,
      { config_json: '{"transport":"streamableHttp"}' },
      /mcp_registration_config_transport/,
    );
    rejects(
      "registration JSON missing transport rejects NULL extraction",
      "mcp_server_registration",
      registration,
      { config_json: "{}" },
    );
    rejects("registration malformed JSON", "mcp_server_registration", registration, {
      config_json: "{",
    });
    insert("mcp_server_registration", registration);
    rollback(() => {
      assert.throws(
        () => insert("mcp_server_registration", { ...registration, id: "duplicate" }),
        /UNIQUE/,
      );
      sqlite.prepare("UPDATE mcp_server_registration SET retired_at=11").run();
      insert("mcp_server_registration", { ...registration, id: "replacement" });
      assert.equal(
        (sqlite.prepare("SELECT count(*) AS n FROM mcp_server_registration").get() as { n: number })
          .n,
        2,
      );
    });
    pass("live name unique; retired plus live same name allowed");
    const processRow: Row = {
      id: "process",
      project_id: "a",
      machine_id: "machine",
      registration_id: "registration",
      registration_revision: 1,
      transport: "stdio",
      config_hash: "a".repeat(64),
      worker_incarnation_id: "incarnation",
      launch_nonce: "nonce",
      state: "running",
      pid: 42,
      endpoint: null,
      started_at: 10,
      last_observed_at: 10,
      ended_at: null,
      stop_reason: null,
      state_revision: 1,
      state_hash: "b".repeat(64),
    };
    rejects("running process needs pid or endpoint", "mcp_server_process", processRow, {
      pid: null,
    });
    rejects("process pid bound", "mcp_server_process", processRow, { pid: 0 });
    rejects("process observed timestamp bound", "mcp_server_process", processRow, {
      last_observed_at: 9,
    });
    rejects(
      "process registration FK exact project",
      "mcp_server_process",
      processRow,
      { project_id: "b" },
      /FOREIGN KEY/,
    );
    const stopped = { ...processRow, state: "stopped", ended_at: 11, stop_reason: "exit" };
    const stoppedRejections: Row[] = [
      { ended_at: null },
      { stop_reason: null },
      { ended_at: 9 },
      { stop_reason: "" },
    ];
    for (const bad of stoppedRejections)
      rejects(
        `process terminal rejects ${Object.keys(bad)[0]}=${JSON.stringify(Object.values(bad)[0])}`,
        "mcp_server_process",
        stopped,
        bad,
      );
    insert("mcp_server_registration", {
      ...registration,
      id: "http-registration",
      name: "http",
      transport: "streamableHttp",
      config_json: JSON.stringify({
        transport: "streamableHttp",
        url: "http://127.0.0.1:32145/mcp",
        headerRefs: {},
        roots: [],
        toolAllowlist: ["echo"],
        exposeResources: false,
        exposeSampling: false,
        exposeElicitation: false,
        requestTimeoutMs: 120000,
      }),
    });
    rollback(() =>
      insert("mcp_server_process", {
        ...processRow,
        registration_id: "http-registration",
        transport: "streamableHttp",
        pid: null,
        endpoint: "http://127.0.0.1:32145/mcp",
      }),
    );
    rejects(
      "HTTP running process requires endpoint",
      "mcp_server_process",
      {
        ...processRow,
        registration_id: "http-registration",
        transport: "streamableHttp",
        pid: null,
        endpoint: "http://127.0.0.1:32145/mcp",
      },
      { endpoint: null },
    );
    insert("mcp_server_process", processRow);
    const session: Row = {
      id: "session",
      project_id: "a",
      machine_id: "machine",
      registration_id: "registration",
      registration_revision: 1,
      process_id: "process",
      authorization_generation: 1,
      holder_instance_id: "instance-a",
      grant_id: "grant-a",
      run_id: "run-a",
      chat_id: "chat-a",
      open_request_id: "open",
      open_fingerprint: "a".repeat(64),
      worker_boot_id: "boot",
      worker_connection_generation: 1,
      worker_attempt_id: "attempt",
      worker_incarnation_id: "incarnation",
      protocol_version: null,
      state: "connecting",
      reason: null,
      created_at: 10,
      initialized_at: null,
      closed_at: null,
      host_ack_server_seq: 0,
      client_accepted_through: 0,
      server_accepted_through: 0,
      client_high_water: 0,
      server_high_water: 0,
      worker_state_revision: 0,
      worker_state_hash: null,
    };
    rejects(
      "session cannot borrow cross Project process",
      "mcp_session",
      session,
      {
        project_id: "b",
        holder_instance_id: "instance-b",
        grant_id: "grant-b",
        run_id: "run-b",
        chat_id: "chat-b",
      },
      /FOREIGN KEY/,
    );
    rejects(
      "session authorization generation must exist",
      "mcp_session",
      session,
      { authorization_generation: 2 },
      /FOREIGN KEY/,
    );
    rejects(
      "session Worker four tuple must exist",
      "mcp_session",
      session,
      { worker_attempt_id: "other-attempt" },
      /FOREIGN KEY/,
    );
    rejects(
      "session grant five tuple must exist",
      "mcp_session",
      session,
      { grant_id: "grant-b" },
      /FOREIGN KEY/,
    );
    rejects(
      "session process incarnation must match",
      "mcp_session",
      session,
      { worker_incarnation_id: "other-incarnation" },
      /FOREIGN KEY/,
    );
    rejects("session protocol length", "mcp_session", session, { protocol_version: "" });
    rejects("session initialized timestamp", "mcp_session", session, { initialized_at: 9 });
    rejects(
      "session worker revision requires hash",
      "mcp_session",
      { ...session, worker_state_revision: 1, worker_state_hash: "c".repeat(64) },
      { worker_state_hash: null },
    );
    rejects("session worker zero revision forbids hash", "mcp_session", session, {
      worker_state_hash: "c".repeat(64),
    });
    rejects(
      "session worker hash format",
      "mcp_session",
      { ...session, worker_state_revision: 1, worker_state_hash: "c".repeat(64) },
      { worker_state_hash: "z".repeat(64) },
    );
    const active = {
      ...session,
      state: "active",
      initialized_at: 11,
      protocol_version: "negotiated",
    };
    rejects("active session requires protocol", "mcp_session", active, { protocol_version: null });
    rejects("active session requires initialized timestamp", "mcp_session", active, {
      initialized_at: null,
    });
    const closed = { ...session, state: "closed", closed_at: 11, reason: "client_closed" };
    rejects("terminal session requires closed timestamp", "mcp_session", closed, {
      closed_at: null,
    });
    rejects("terminal session requires reason", "mcp_session", closed, { reason: null });
    rejects("terminal session timestamp bound", "mcp_session", closed, { closed_at: 9 });
    for (const field of [
      "host_ack_server_seq",
      "client_accepted_through",
      "server_accepted_through",
    ])
      rejects(`session cursor ${field} cannot exceed high water`, "mcp_session", session, {
        [field]: 1,
      });
    insert("mcp_session", session);
    rollback(() =>
      assert.throws(
        () => insert("mcp_session", { ...session, id: "session-two", open_request_id: "open-two" }),
        /UNIQUE.*process_id/,
      ),
    );
    pass("one session per process lifetime");
    const frame: Row = {
      id: "frame",
      session_id: "session",
      direction: "client_to_server",
      seq: 1,
      payload_base64: "e30=",
      payload_bytes: 2,
      payload_hash: "a".repeat(64),
      state: "queued",
      created_at: 10,
      expires_at: 20,
      sent_at: null,
      terminal_at: null,
      terminal_reason: null,
    };
    rejects("frame payload bytes zero", "mcp_frame", frame, { payload_bytes: 0 });
    rejects(
      "frame payload exceeds 128 KiB",
      "mcp_frame",
      { ...frame, payload_bytes: 131072, payload_base64: Buffer.alloc(131072).toString("base64") },
      { payload_bytes: 131073 },
    );
    rejects("frame base64 illegal characters", "mcp_frame", frame, { payload_base64: "e3?=" });
    rejects("frame queued cannot have sent timestamp", "mcp_frame", frame, { sent_at: 11 });
    rejects("frame queued requires payload", "mcp_frame", frame, { payload_base64: null });
    rejects(
      "frame sent requires payload",
      "mcp_frame",
      { ...frame, state: "sent", sent_at: 11 },
      { payload_base64: null },
    );
    rejects(
      "frame sent requires sent timestamp",
      "mcp_frame",
      { ...frame, state: "sent", sent_at: 11 },
      { sent_at: null },
    );
    const acked = { ...frame, state: "acked", sent_at: 11, terminal_at: 12, payload_base64: null };
    rejects("frame acked requires terminal timestamp", "mcp_frame", acked, { terminal_at: null });
    rejects("frame acked requires sent timestamp", "mcp_frame", acked, { sent_at: null });
    rejects("frame succeeded is not a relay state", "mcp_frame", frame, { state: "succeeded" });
    rejects(
      "frame sent timestamp bound",
      "mcp_frame",
      { ...frame, state: "sent", sent_at: 11 },
      { sent_at: 9 },
    );
    rejects("frame terminal timestamp bound", "mcp_frame", acked, { terminal_at: 9 });
    const cancelled = {
      ...frame,
      state: "cancelled",
      payload_base64: null,
      terminal_at: 11,
      terminal_reason: "cancel",
    };
    rejects("frame cancelled requires reason", "mcp_frame", cancelled, { terminal_reason: null });
    rejects("frame cancelled requires terminal timestamp", "mcp_frame", cancelled, {
      terminal_at: null,
    });
    rejects(
      "frame dropped requires reason",
      "mcp_frame",
      { ...cancelled, state: "dropped" },
      { terminal_reason: null },
    );
    insert("mcp_frame", frame);
    rollback(() => {
      assert.throws(
        () => insert("mcp_frame", { ...frame, id: "duplicate" }),
        /UNIQUE.*session_id.*direction.*seq/,
      );
      insert("mcp_frame", { ...frame, id: "opposite", direction: "server_to_client" });
      insert("mcp_frame", { ...frame, id: "next", seq: 2 });
    });
    pass("frame session direction seq unique with legal opposite and next controls");
    // Each weak predicate below actually admits NULL in SQLite. The named real
    // table probes above reject the corresponding NULL-required state.
    const weak: [string, string][] = [
      ["process running pid", "'running'<>'running' OR NULL>0"],
      ["process running HTTP endpoint", "'running'<>'running' OR length(NULL)>0"],
      ["process terminal ended_at", "'stopped'<>'stopped' OR NULL>=10"],
      ["process terminal stop_reason", "'stopped'<>'stopped' OR length(NULL)>0"],
      ["session active protocol", "'active'<>'active' OR length(NULL)>0"],
      ["session active initialized_at", "'active'<>'active' OR NULL>=10"],
      ["session terminal closed_at", "'closed'<>'closed' OR NULL>=10"],
      ["session terminal reason", "'closed'<>'closed' OR length(NULL)>0"],
      ["session worker hash", "1=0 OR length(NULL)=64"],
      ["frame queued payload", "'queued'<>'queued' OR length(NULL)>0"],
      ["frame sent payload", "'sent'<>'sent' OR length(NULL)>0"],
      ["frame sent sent_at", "'sent'<>'sent' OR NULL>=10"],
      ["frame acked sent_at", "'acked'<>'acked' OR NULL>=10"],
      ["frame acked terminal_at", "'acked'<>'acked' OR NULL>=10"],
      ["frame cancelled terminal_at", "'cancelled'<>'cancelled' OR NULL>=10"],
      ["frame cancelled reason", "'cancelled'<>'cancelled' OR length(NULL)>0"],
      ["frame dropped reason", "'dropped'<>'dropped' OR length(NULL)>0"],
      ["registration JSON transport", "NULL='stdio'"],
    ];
    for (const [name, predicate] of weak) {
      sqlite.exec(
        `CREATE TEMP TABLE weak_probe (n INTEGER CHECK (${predicate})); INSERT INTO weak_probe VALUES (1); DROP TABLE weak_probe`,
      );
      pass(`SO28 weak NULL CHECK admits invalid ${name}; actual constraint rejects`);
    }
    rollback(() => {
      sqlite.exec("DELETE FROM mcp_frame; DELETE FROM mcp_session");
      assert.equal(
        (sqlite.prepare("SELECT state FROM mcp_server_process").get() as { state: string }).state,
        "running",
      );
    });
    pass("deleting session leaves independent process alive");
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    pass("migration applies to empty SQLite and foreign_key_check clean");
  } finally {
    sqlite.close();
  }
}

function wireProbe() {
  for (const prefix of [
    ID_PREFIXES.mcpRegistration,
    ID_PREFIXES.mcpProcess,
    ID_PREFIXES.mcpSession,
    ID_PREFIXES.mcpFrame,
  ])
    assert(appIdPattern(prefix).test(newId(prefix)));
  assert.equal(ID_PREFIXES.mcpProcess, "mpr");
  const key = {
    projectId: newId(ID_PREFIXES.project),
    machineId: newId(ID_PREFIXES.machine),
    authorizationGeneration: 1,
  };
  const requestId = newId(ID_PREFIXES.request);
  const sessionId = newId(ID_PREFIXES.mcpSession);
  const calls = [
    { type: "mcp_catalog_get", input: key },
    {
      type: "mcp_session_open",
      input: {
        ...key,
        requestId,
        registrationId: newId(ID_PREFIXES.mcpRegistration),
        registrationRevision: 1,
        processId: newId(ID_PREFIXES.mcpProcess),
        expectedWorkerIncarnationId: crypto.randomUUID(),
      },
    },
    {
      type: "mcp_session_exchange",
      input: {
        ...key,
        sessionId,
        frames: [],
        ackServerSeq: 0,
        cancelClientSeqs: [],
        protocolVersion: null,
        confirmInitialized: false,
        holdMs: 0,
      },
    },
    { type: "mcp_session_close", input: { ...key, sessionId, requestId, reason: "client_closed" } },
  ];
  for (const call of calls) {
    assert(remoteAgentRequestSchema.safeParse({ version: 2, call }).success);
    for (const authorizationGeneration of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined])
      assert(
        !remoteAgentRequestSchema.safeParse({
          version: 2,
          call: { ...call, input: { ...call.input, authorizationGeneration } },
        }).success,
      );
    assert(
      !remoteAgentRequestSchema.safeParse({
        version: 2,
        call: { ...call, input: { ...call.input, extra: true } },
      }).success,
    );
    assert(!remoteAgentRequestSchema.safeParse({ version: 1, call }).success);
  }
  const exchange = calls[2]!;
  for (const bad of [
    { holdMs: 2001 },
    { frames: [{}, {}, {}] },
    { protocolVersion: "" },
    { cancelClientSeqs: [1, 1] },
  ])
    assert(
      !remoteAgentRequestSchema.safeParse({
        version: 2,
        call: { ...exchange, input: { ...exchange.input, ...bad } },
      }).success,
    );
  const relay = { version: 1, transports: ["stdio"], maxMessageBytes: 131072 };
  const capability = {
    platform: "darwin",
    arch: "arm64",
    workerVersion: "test",
    shells: [],
    remoteOperations: [],
    mcpRelay: relay,
  };
  assert(capabilitySnapshotSchema.safeParse(capability).success);
  for (const mcpRelay of [null, undefined])
    assert(capabilitySnapshotSchema.safeParse({ ...capability, mcpRelay }).success);
  for (const mcpRelay of [
    { ...relay, extra: true },
    { ...relay, version: 2 },
    { ...relay, maxMessageBytes: 1 },
    { ...relay, transports: ["stdio", "stdio"] },
  ])
    assert(!capabilitySnapshotSchema.safeParse({ ...capability, mcpRelay }).success);
  const workerSession = {
    machineId: key.machineId,
    generation: 1,
    bootId: newId(ID_PREFIXES.boot),
    attemptId: crypto.randomUUID(),
  };
  const envelope = {
    version: WORKER_PROTOCOL_VERSION,
    requestId,
    secret: "x".repeat(43),
    session: workerSession,
    mode: "normal",
    seq: 1,
    capability,
    observations: [],
    remote: { results: [], fenceAcks: [], mcp: [], mcpCursors: [] },
  };
  assert(workerExchangeInput.safeParse(envelope).success);
  assert(!workerExchangeInput.safeParse({ ...envelope, version: 2 }).success);
  assert(
    !workerExchangeInput.safeParse({ ...envelope, remote: { ...envelope.remote, mcp: [{}] } })
      .success,
  );
  const frame = {
    frameId: newId(ID_PREFIXES.mcpFrame),
    seq: 1,
    payloadBase64: "e30=",
    payloadBytes: 2,
    payloadHash: "a".repeat(64),
    expiresAt: 20,
  };
  assert(mcp.mcpHostOutboundFrameSchema.safeParse(frame).success);
  for (const bad of [
    { payloadBytes: 0 },
    { payloadBytes: 3 },
    { payloadBase64: "?30=" },
    { frameId: newId(ID_PREFIXES.mcpSession) },
  ])
    assert(!mcp.mcpHostOutboundFrameSchema.safeParse({ ...frame, ...bad }).success);
  const binding = {
    ...key,
    holderInstanceId: newId(ID_PREFIXES.instance),
    processId: newId(ID_PREFIXES.mcpProcess),
    sessionId,
    workerSession,
  };
  const config = {
    transport: "stdio",
    command: "/usr/bin/true",
    args: [],
    cwd: "/tmp",
    envRefs: {},
    roots: [],
    toolAllowlist: ["echo"],
    exposeResources: false,
    exposeSampling: false,
    exposeElicitation: false,
    requestTimeoutMs: 120000,
  };
  const registration = {
    id: newId(ID_PREFIXES.mcpRegistration),
    revision: 1,
    projectId: key.projectId,
    machineId: key.machineId,
    name: "everything",
    transport: "stdio",
    configRef: "everything",
    configHash: "a".repeat(64),
    configJson: config,
    createdAt: 10,
    retiredAt: null,
  };
  const process = {
    id: binding.processId,
    projectId: key.projectId,
    machineId: key.machineId,
    registrationId: registration.id,
    registrationRevision: 1,
    transport: "stdio",
    configHash: registration.configHash,
    workerIncarnationId: crypto.randomUUID(),
    launchNonce: crypto.randomUUID(),
    state: "running",
    pid: 42,
    endpoint: null,
    startedAt: 10,
    lastObservedAt: 10,
    endedAt: null,
    stopReason: null,
    stateRevision: 1,
    stateHash: "a".repeat(64),
  };
  const session = {
    id: sessionId,
    projectId: key.projectId,
    machineId: key.machineId,
    registrationId: registration.id,
    registrationRevision: 1,
    processId: binding.processId,
    authorizationGeneration: 1,
    holderInstanceId: binding.holderInstanceId,
    grantId: newId(ID_PREFIXES.remoteToolGrant),
    runId: `run_${crypto.randomUUID()}`,
    chatId: newId(ID_PREFIXES.chat),
    openRequestId: requestId,
    openFingerprint: "a".repeat(64),
    workerBootId: workerSession.bootId,
    workerConnectionGeneration: workerSession.generation,
    workerAttemptId: workerSession.attemptId,
    workerIncarnationId: process.workerIncarnationId,
    protocolVersion: null,
    state: "connecting",
    reason: null,
    createdAt: 10,
    initializedAt: null,
    closedAt: null,
    hostAckServerSeq: 0,
    clientAcceptedThrough: 0,
    serverAcceptedThrough: 0,
    clientHighWater: 0,
    serverHighWater: 0,
    workerStateRevision: 0,
    workerStateHash: null,
  };
  const fence = {
    projectId: key.projectId,
    machineId: key.machineId,
    authorizationGeneration: 1,
    holderInstanceId: binding.holderInstanceId,
    workerSession,
    mutationId: newId(ID_PREFIXES.leaseMutation),
    sessions: [{ sessionId, processId: binding.processId }],
  };
  const workerItems = [
    { type: "registration_fact", registration },
    {
      type: "registration_retire",
      registrationId: registration.id,
      revision: 1,
      configHash: registration.configHash,
    },
    { type: "process_fact", process },
    {
      type: "session_fact",
      ...binding,
      state: "attached",
      reason: null,
      stateRevision: 1,
      stateHash: "a".repeat(64),
    },
    { type: "session_fence_ack", ...fence, detached: true },
    { type: "frame", ...binding, ...frame, direction: "server_to_client" },
  ];
  const serverItems = [
    { type: "session_attach", ...binding, session, configHash: registration.configHash },
    { type: "session_protocol", ...binding, protocolVersion: "negotiated" },
    { type: "session_detach", ...binding, reason: "client_closed" },
    { type: "session_fence", ...fence },
    {
      type: "cancel_frames",
      ...binding,
      tombstones: [{ clientSeq: 1, frameId: frame.frameId, payloadHash: frame.payloadHash }],
    },
    { type: "frame", ...binding, ...frame, direction: "client_to_server" },
  ];
  for (const [schema, items] of [
    [mcp.mcpWorkerItemSchema, workerItems],
    [mcp.mcpServerItemSchema, serverItems],
  ] as const) {
    for (const item of items) {
      assert(schema.safeParse(item).success, `valid ${item.type}`);
      assert(!schema.safeParse({ ...item, extra: true }).success);
    }
  }
  const catalogEntry = {
    registrationId: registration.id,
    registrationRevision: 1,
    projectId: key.projectId,
    machineId: key.machineId,
    name: "everything",
    transport: "stdio",
    configHash: registration.configHash,
    roots: [],
    toolAllowlist: ["echo"],
    exposeResources: false,
    exposeSampling: false,
    exposeElicitation: false,
    requestTimeoutMs: 120000,
    processes: [
      {
        processId: binding.processId,
        workerIncarnationId: process.workerIncarnationId,
        lastObservedAt: 10,
      },
    ],
  };
  assert(mcp.mcpCatalogViewSchema.safeParse({ registrations: [catalogEntry] }).success);
  assert(
    !mcp.mcpCatalogViewSchema.safeParse({
      registrations: [{ ...catalogEntry, command: "/usr/bin/true" }],
    }).success,
  );
  assert(
    !mcp.mcpCatalogViewSchema.safeParse({
      registrations: Array.from({ length: 65 }, () => catalogEntry),
    }).success,
  );
  assert(
    !mcp.mcpCatalogViewSchema.safeParse({
      registrations: [
        { ...catalogEntry, processes: Array.from({ length: 9 }, () => catalogEntry.processes[0]) },
      ],
    }).success,
  );
  const httpConfig = {
    transport: "streamableHttp",
    url: "http://127.0.0.1:32145/mcp",
    headerRefs: {},
    roots: [],
    toolAllowlist: ["echo"],
    exposeResources: false,
    exposeSampling: false,
    exposeElicitation: false,
    requestTimeoutMs: 120000,
  };
  assert(mcp.mcpConfigSchema.safeParse(httpConfig).success);
  for (const url of [
    "https://external.example/mcp",
    "http://user@127.0.0.1:32145/mcp",
    "http://127.0.0.1:32145/mcp?bad=1",
  ])
    assert(!mcp.mcpConfigSchema.safeParse({ ...httpConfig, url }).success);
  assert(!mcp.mcpConfigSchema.safeParse({ ...config, env: {} }).success);
  assert(!mcp.mcpConfigSchema.safeParse({ ...config, command: "relative" }).success);
  assert(
    !mcp.mcpServerItemSchema.safeParse({
      ...serverItems[0],
      sessionId: newId(ID_PREFIXES.mcpSession),
    }).success,
  );
  assert(
    !mcp.mcpWorkerItemSchema.safeParse({ ...workerItems[5], direction: "client_to_server" })
      .success,
  );
  assert(
    !mcp.mcpServerItemSchema.safeParse({ ...serverItems[5], direction: "server_to_client" })
      .success,
  );
  const cursor = { ...binding, clientAcceptedThrough: 0, serverAcceptedThrough: 0 };
  assert(mcp.mcpSessionCursorSchema.safeParse(cursor).success);
  assert(
    !mcp.mcpSessionCursorSchema.safeParse({
      ...cursor,
      workerSession: { ...workerSession, machineId: newId(ID_PREFIXES.machine) },
    }).success,
  );
  const { capability: _capability, observations: _observations, ...drainBase } = envelope;
  const drain = {
    ...drainBase,
    mode: "drain",
    remote: { ...envelope.remote, mcp: workerItems.slice(3), mcpCursors: [cursor] },
  };
  assert(workerExchangeInput.safeParse(drain).success);
  assert(
    !workerExchangeInput.safeParse({
      ...drain,
      remote: { ...drain.remote, mcp: workerItems.slice(0, 1) },
    }).success,
  );
  assert(
    !workerExchangeInput.safeParse({
      ...envelope,
      remote: {
        ...envelope.remote,
        mcp: [
          {
            ...workerItems[3],
            workerSession: { ...workerSession, attemptId: crypto.randomUUID() },
          },
        ],
      },
    }).success,
  );
  assert(
    !workerExchangeInput.safeParse({
      ...envelope,
      remote: { ...envelope.remote, mcp: Array.from({ length: 65 }, () => workerItems[1]) },
    }).success,
  );
  pass("strict MCP wire shapes IDs versions capability and bounded frames");
  pass("all MCP item variants strict; exact Worker identity; directional frames; drain admission");
}

function run() {
  wireProbe();
  const directory = mkdtempSync(join(tmpdir(), "sprout-mcp-contracts-"));
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "tests/mcp-contracts.test.ts", "--sqlite-probe"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          VITEST: "",
          NODE_ENV: "test",
          DATABASE_URL: join(directory, "contracts.sqlite"),
        },
        encoding: "utf8",
        timeout: 60000,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert(child.stdout.includes("PASS SO28"));
    process.stdout.write(child.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv.includes("--sqlite-probe")) sqliteProbe();
else if (process.env.VITEST) {
  const { it } = await import("vite-plus/test");
  it("MCP wire contracts and real isolated SQLite counterexamples", run);
} else run();
