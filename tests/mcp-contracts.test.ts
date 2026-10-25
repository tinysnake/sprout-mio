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
    const probe = (value: Row) => {
      // Remove only test fixture children inside the rollback savepoint so a
      // previously persisted control row cannot mask the intended constraint.
      if (table === "mcp_server_process")
        sqlite.exec(
          "DELETE FROM mcp_frame; DELETE FROM mcp_session; DELETE FROM mcp_server_process",
        );
      else if (table === "mcp_session")
        sqlite.exec("DELETE FROM mcp_frame; DELETE FROM mcp_session");
      else if (table === "mcp_frame") sqlite.exec("DELETE FROM mcp_frame");
      insert(table, value);
    };
    rollback(() => probe(good));
    rollback(() => assert.throws(() => probe({ ...good, ...bad }), pattern));
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
    const config = {
      transport: "stdio",
      command: "node",
      args: [],
      workingDirectory: "/tmp",
      launch: "configured_service",
      autostart: true,
      exposure: "wire",
      roots: [],
      exposeSampling: false,
      elicitation: "absent",
    };
    const registration: Row = {
      id: "registration",
      revision: 1,
      project_id: "a",
      machine_id: "machine",
      name: "everything",
      transport: "stdio",
      config_ref: "everything",
      config_hash: "a".repeat(64),
      config_json: JSON.stringify(config),
      created_at: 10,
      retired_at: null,
    };
    rejects("registration retired_at precedes creation", "mcp_server_registration", registration, {
      retired_at: 9,
    });
    rejects(
      "registration JSON object CHECK",
      "mcp_server_registration",
      registration,
      { config_json: "[]" },
      /mcp_registration_config_object/,
    );
    rejects(
      "registration JSON transport CHECK",
      "mcp_server_registration",
      registration,
      { config_json: '{"transport":"streamableHttp"}' },
      /mcp_registration_config_transport/,
    );
    rejects(
      "registration JSON missing transport rejects NULL",
      "mcp_server_registration",
      registration,
      { config_json: "{}" },
      /mcp_registration_config_transport/,
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
    });
    pass("live registration name unique; retired plus new live name legal");
    const processRow: Row = {
      id: "process",
      registration_id: "registration",
      registration_revision: 1,
      project_id: "a",
      machine_id: "machine",
      transport: "stdio",
      config_hash: "a".repeat(64),
      worker_incarnation_id: "incarnation",
      launch_nonce: "nonce",
      pid: 42,
      process_started_at: 9,
      endpoint: null,
      state: "running",
      state_revision: 1,
      state_hash: "a".repeat(64),
      created_at: 10,
      last_observed_at: 10,
      ended_at: null,
      exit_code: null,
      end_reason: null,
    };
    rejects("running without PID or HTTP endpoint", "mcp_server_process", processRow, {
      pid: null,
    });
    rejects("process PID positive integer", "mcp_server_process", processRow, { pid: 0 });
    rejects("stdio cannot have endpoint", "mcp_server_process", processRow, {
      endpoint: "http://127.0.0.1:32145/mcp",
    });
    rejects(
      "process registration project FK",
      "mcp_server_process",
      processRow,
      { project_id: "b" },
      /FOREIGN KEY/,
    );
    insert("mcp_server_registration", {
      ...registration,
      id: "http-registration",
      name: "http",
      transport: "streamableHttp",
      config_json: JSON.stringify({
        transport: "streamableHttp",
        url: "http://127.0.0.1:32145/mcp",
        launch: "owner_managed",
        autostart: false,
        exposure: "wire",
        roots: [],
        exposeSampling: false,
        elicitation: "absent",
      }),
    });
    const http = {
      ...processRow,
      registration_id: "http-registration",
      transport: "streamableHttp",
      pid: null,
      endpoint: "http://127.0.0.1:32145/mcp",
    };
    rejects("HTTP without PID requires endpoint", "mcp_server_process", http, { endpoint: null });
    const exited = {
      ...processRow,
      state: "exited",
      ended_at: 11,
      exit_code: 0,
      end_reason: "exited",
    };
    rejects("process end reason closed enum", "mcp_server_process", exited, {
      end_reason: "invented",
    });
    rejects("running cannot report exit code", "mcp_server_process", processRow, { exit_code: 0 });
    const stopping = { ...processRow, state: "stopping" };
    rollback(() => insert("mcp_server_process", stopping));
    pass("stopping with all end fields NULL and PID accepted");
    rejects("stopping cannot report end time", "mcp_server_process", stopping, { ended_at: 11 });
    rejects("stopping cannot report end reason", "mcp_server_process", stopping, {
      end_reason: "owner_stopped",
    });
    rejects("stopping cannot report exit code", "mcp_server_process", stopping, { exit_code: 0 });
    insert("mcp_server_process", processRow);
    const session: Row = {
      id: "session",
      process_id: "process",
      project_id: "a",
      machine_id: "machine",
      registration_id: "registration",
      registration_revision: 1,
      transport: "stdio",
      config_hash: "a".repeat(64),
      worker_incarnation_id: "incarnation",
      run_id: "run-a",
      holder_instance_id: "instance-a",
      authorization_generation: 1,
      grant_id: "grant-a",
      chat_id: "chat-a",
      open_request_id: "open",
      open_hash: "a".repeat(64),
      state: "connecting",
      created_at: 10,
      attached_at: null,
      connected_at: null,
      ended_at: null,
      end_reason: null,
      protocol_version: null,
      client_high_water: 0,
      worker_ack_client_seq: 0,
      server_high_water: 0,
      host_ack_server_seq: 0,
      worker_state_revision: 0,
      worker_state_hash: null,
      worker_detached_at: null,
      fence_mutation_id: null,
      worker_connection_generation: 1,
      server_boot_id: "boot",
      worker_attempt_id: "attempt",
    };
    rejects(
      "session cross Project process FK",
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
      "session nonexistent authorization generation FK",
      "mcp_session",
      session,
      { authorization_generation: 2 },
      /FOREIGN KEY/,
    );
    for (const changes of [
      { worker_attempt_id: "other" },
      { server_boot_id: "other" },
      { worker_connection_generation: 2 },
    ] as Row[])
      rejects(
        "session Worker four tuple " + Object.keys(changes)[0],
        "mcp_session",
        session,
        changes,
        /FOREIGN KEY/,
      );
    rejects(
      "session grant five tuple FK",
      "mcp_session",
      session,
      { grant_id: "grant-b" },
      /FOREIGN KEY/,
    );
    rejects(
      "session Agent run four tuple FK",
      "mcp_session",
      session,
      { run_id: "run-b" },
      /FOREIGN KEY/,
    );
    rejects(
      "session process seven tuple transport FK",
      "mcp_session",
      session,
      { transport: "streamableHttp" },
      /FOREIGN KEY/,
    );
    rejects(
      "session process seven tuple incarnation FK",
      "mcp_session",
      session,
      { worker_incarnation_id: "other" },
      /FOREIGN KEY/,
    );
    const connected = {
      ...session,
      state: "connected",
      attached_at: 11,
      connected_at: 12,
      protocol_version: "negotiated",
    };
    const closed = { ...connected, state: "closed", ended_at: 13, end_reason: "client_closed" };
    rejects("session attached timestamp precedes creation", "mcp_session", session, {
      attached_at: 9,
    });
    rejects("session connecting cannot be connected", "mcp_session", connected, {
      state: "connecting",
    });
    rejects("session ended timestamp precedes connected", "mcp_session", closed, { ended_at: 11 });
    rejects("session protocol length", "mcp_session", session, { protocol_version: "" });
    rejects("session end reason closed enum", "mcp_session", closed, { end_reason: "invented" });
    rejects(
      "session worker hash format",
      "mcp_session",
      { ...session, worker_state_revision: 1, worker_state_hash: "a".repeat(64) },
      { worker_state_hash: "z".repeat(64) },
    );
    for (const field of ["worker_ack_client_seq", "host_ack_server_seq"])
      rejects("session cursor exceeds high water " + field, "mcp_session", session, { [field]: 1 });
    insert("mcp_session", session);
    rollback(() =>
      assert.throws(
        () => insert("mcp_session", { ...session, id: "two", open_request_id: "two" }),
        /UNIQUE.*process_id/,
      ),
    );
    pass("one session per process lifetime");
    const frame: Row = {
      id: "frame",
      session_id: "session",
      project_id: "a",
      machine_id: "machine",
      authorization_generation: 1,
      holder_instance_id: "instance-a",
      process_id: "process",
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
      disposition_reason: null,
    };
    rejects("frame payload_bytes zero", "mcp_frame", frame, { payload_bytes: 0 });
    rejects(
      "frame payload_bytes above 131072",
      "mcp_frame",
      { ...frame, payload_bytes: 131072, payload_base64: Buffer.alloc(131072).toString("base64") },
      { payload_bytes: 131073 },
    );
    rejects("frame base64 illegal character", "mcp_frame", frame, { payload_base64: "e3?=" });
    rejects("queued frame cannot have sent_at", "mcp_frame", frame, { sent_at: 11 });
    rejects("frame succeeded state forbidden", "mcp_frame", frame, { state: "succeeded" });
    rejects("frame cancelled state forbidden", "mcp_frame", frame, { state: "cancelled" });
    rejects("frame expired before creation", "mcp_frame", frame, { expires_at: 9 });
    rejects(
      "frame sent timestamp precedes creation",
      "mcp_frame",
      { ...frame, state: "sent", sent_at: 11 },
      { sent_at: 9 },
    );
    const acked = { ...frame, state: "acked", sent_at: 11, terminal_at: 12, payload_base64: null };
    const dropped = {
      ...frame,
      state: "dropped",
      terminal_at: 12,
      disposition_reason: "expired",
      payload_base64: null,
    };
    rejects("frame disposition closed enum", "mcp_frame", dropped, {
      disposition_reason: "invented",
    });
    for (const field of [
      "session_id",
      "project_id",
      "machine_id",
      "authorization_generation",
      "holder_instance_id",
      "process_id",
    ])
      rejects(
        "frame composite identity FK " + field,
        "mcp_frame",
        frame,
        { [field]: field === "authorization_generation" ? 2 : "other" },
        /FOREIGN KEY/,
      );
    const nullCases: [string, string, Row, Row, string][] = [
      ["process running PID", "mcp_server_process", processRow, { pid: null }, "NULL>0"],
      ["process HTTP endpoint", "mcp_server_process", http, { endpoint: null }, "length(NULL)>0"],
      ["process exited ended_at", "mcp_server_process", exited, { ended_at: null }, "NULL>=0"],
      [
        "process exited end_reason",
        "mcp_server_process",
        exited,
        { end_reason: null },
        "length(NULL)>0",
      ],
      [
        "session connected_at requires attached_at",
        "mcp_session",
        connected,
        { attached_at: null },
        "12>=NULL",
      ],
      [
        "session connected_at requires protocol",
        "mcp_session",
        connected,
        { protocol_version: null },
        "length(NULL)>0",
      ],
      [
        "session connected requires timestamp",
        "mcp_session",
        connected,
        { connected_at: null },
        "NULL>=11",
      ],
      ["session closed requires ended_at", "mcp_session", closed, { ended_at: null }, "NULL>=12"],
      [
        "session closed requires end_reason",
        "mcp_session",
        closed,
        { end_reason: null },
        "length(NULL)>0",
      ],
      [
        "session worker revision requires hash",
        "mcp_session",
        { ...session, worker_state_revision: 1, worker_state_hash: "a".repeat(64) },
        { worker_state_hash: null },
        "length(NULL)=64",
      ],
      ["frame queued payload", "mcp_frame", frame, { payload_base64: null }, "length(NULL)>0"],
      [
        "frame sent payload",
        "mcp_frame",
        { ...frame, state: "sent", sent_at: 11 },
        { payload_base64: null },
        "length(NULL)>0",
      ],
      [
        "frame sent sent_at",
        "mcp_frame",
        { ...frame, state: "sent", sent_at: 11 },
        { sent_at: null },
        "NULL>=10",
      ],
      ["frame acked sent_at", "mcp_frame", acked, { sent_at: null }, "NULL>=10"],
      ["frame acked terminal_at", "mcp_frame", acked, { terminal_at: null }, "NULL>=10"],
      ["frame dropped terminal_at", "mcp_frame", dropped, { terminal_at: null }, "NULL>=10"],
      [
        "frame dropped disposition",
        "mcp_frame",
        dropped,
        { disposition_reason: null },
        "length(NULL)>0",
      ],
      [
        "frame unknown terminal_at",
        "mcp_frame",
        { ...dropped, state: "unknown" },
        { terminal_at: null },
        "NULL>=10",
      ],
      [
        "frame unknown disposition",
        "mcp_frame",
        { ...dropped, state: "unknown" },
        { disposition_reason: null },
        "length(NULL)>0",
      ],
    ];
    for (const [name, table, good, bad, weak] of nullCases) {
      sqlite.exec(
        "CREATE TEMP TABLE weak_probe (n INTEGER CHECK (" +
          weak +
          ")); INSERT INTO weak_probe VALUES (1); DROP TABLE weak_probe",
      );
      rejects("SO28 weak NULL admits but actual rejects " + name, table, good, bad);
    }
    sqlite.exec(
      "CREATE TEMP TABLE weak_json (n INTEGER CHECK (NULL='stdio')); INSERT INTO weak_json VALUES (1); DROP TABLE weak_json",
    );
    pass("SO28 json_extract NULL admitted by equals but IS rejects");
    const nullableScalars: [string, Row, string[]][] = [
      [
        "mcp_server_process",
        { ...processRow, state: "starting", pid: null, process_started_at: null },
        ["pid", "process_started_at", "ended_at", "exit_code"],
      ],
      ["mcp_session", session, ["attached_at", "connected_at", "ended_at", "worker_detached_at"]],
      ["mcp_frame", frame, ["sent_at", "terminal_at"]],
    ];
    for (const [table, good, fields] of nullableScalars)
      for (const field of fields)
        rejects("nullable integer guard " + table + "." + field, table, good, { [field]: 1.5 });
    insert("mcp_frame", frame);
    rollback(() => {
      assert.throws(
        () => insert("mcp_frame", { ...frame, id: "duplicate" }),
        /UNIQUE.*session_id.*direction.*seq/,
      );
      insert("mcp_frame", { ...frame, id: "opposite", direction: "server_to_client" });
      insert("mcp_frame", { ...frame, id: "next", seq: 2 });
    });
    pass("frame session direction seq unique; opposite and next legal");
    rollback(() => {
      sqlite.exec("DELETE FROM mcp_frame; DELETE FROM mcp_session");
      assert.equal(
        (
          sqlite.prepare("SELECT state FROM mcp_server_process WHERE id='process'").get() as {
            state: string;
          }
        ).state,
        "running",
      );
    });
    pass("session deletion does not delete independent process record");
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    pass("empty SQLite migrations and FK integrity");
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
  const requestId = newId(ID_PREFIXES.request),
    sessionId = newId(ID_PREFIXES.mcpSession);
  const workerSession = {
    machineId: key.machineId,
    generation: 1,
    bootId: newId(ID_PREFIXES.boot),
    attemptId: crypto.randomUUID(),
  };
  const bound = {
    ...key,
    sessionId,
    processId: newId(ID_PREFIXES.mcpProcess),
    holderInstanceId: newId(ID_PREFIXES.instance),
    workerSession,
  };
  const config = {
    transport: "stdio",
    command: "node",
    args: [],
    workingDirectory: "/tmp",
    launch: "configured_service",
    autostart: true,
    exposure: "wire",
    roots: [],
    exposeSampling: false,
    elicitation: "absent",
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
  const processRow = {
    id: bound.processId,
    registrationId: registration.id,
    registrationRevision: 1,
    projectId: key.projectId,
    machineId: key.machineId,
    transport: "stdio",
    configHash: registration.configHash,
    workerIncarnationId: crypto.randomUUID(),
    launchNonce: crypto.randomUUID(),
    pid: 42,
    processStartedAt: 9,
    endpoint: null,
    state: "running",
    stateRevision: 1,
    stateHash: "a".repeat(64),
    createdAt: 10,
    lastObservedAt: 10,
    endedAt: null,
    exitCode: null,
    endReason: null,
  };
  const session = {
    id: sessionId,
    processId: bound.processId,
    projectId: key.projectId,
    machineId: key.machineId,
    registrationId: registration.id,
    registrationRevision: 1,
    transport: "stdio",
    configHash: registration.configHash,
    workerIncarnationId: processRow.workerIncarnationId,
    runId: newId(ID_PREFIXES.run),
    holderInstanceId: bound.holderInstanceId,
    authorizationGeneration: 1,
    grantId: newId(ID_PREFIXES.remoteToolGrant),
    chatId: newId(ID_PREFIXES.chat),
    openRequestId: requestId,
    openHash: "a".repeat(64),
    state: "connecting",
    createdAt: 10,
    attachedAt: null,
    connectedAt: null,
    endedAt: null,
    endReason: null,
    protocolVersion: null,
    clientHighWater: 0,
    workerAckClientSeq: 0,
    serverHighWater: 0,
    hostAckServerSeq: 0,
    workerStateRevision: 0,
    workerStateHash: null,
    workerDetachedAt: null,
    fenceMutationId: null,
    workerConnectionGeneration: 1,
    serverBootId: workerSession.bootId,
    workerAttemptId: workerSession.attemptId,
  };
  const frame = {
    frameId: newId(ID_PREFIXES.mcpFrame),
    seq: 1,
    payloadBase64: "e30=",
    payloadBytes: 2,
    payloadHash: "a".repeat(64),
    expiresAt: 20,
  };
  const calls = [
    { type: "mcp_catalog_get", input: key },
    {
      type: "mcp_session_open",
      input: {
        ...key,
        requestId,
        registrationId: registration.id,
        registrationRevision: 1,
        processId: bound.processId,
        expectedWorkerIncarnationId: processRow.workerIncarnationId,
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
    for (const authorizationGeneration of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined])
      assert(
        !remoteAgentRequestSchema.safeParse({
          version: 2,
          call: { ...call, input: { ...call.input, authorizationGeneration } },
        }).success,
      );
    assert(!remoteAgentRequestSchema.safeParse({ version: 1, call }).success);
    assert(
      !remoteAgentRequestSchema.safeParse({
        version: 2,
        call: { ...call, input: { ...call.input, extra: true } },
      }).success,
    );
  }
  for (const bad of [
    { holdMs: 2001 },
    { protocolVersion: "" },
    { cancelClientSeqs: [1, 1] },
    { frames: [frame, frame, frame] },
  ])
    assert(
      !remoteAgentRequestSchema.safeParse({
        version: 2,
        call: { ...calls[2], input: { ...calls[2]!.input, ...bad } },
      }).success,
    );
  const fence = {
    ...key,
    holderInstanceId: bound.holderInstanceId,
    workerSession,
    mutationId: newId(ID_PREFIXES.leaseMutation),
    sessions: [{ sessionId, processId: bound.processId }],
  };
  const workerItems = [
    { type: "registration_fact", registration },
    {
      type: "registration_retire",
      registrationId: registration.id,
      revision: 1,
      configHash: registration.configHash,
    },
    { type: "process_fact", process: processRow },
    {
      type: "session_fact",
      ...bound,
      state: "attached",
      reason: null,
      stateRevision: 1,
      stateHash: "a".repeat(64),
    },
    { type: "session_fence_ack", ...fence, detached: true },
    { type: "frame", ...bound, ...frame, direction: "server_to_client" },
  ];
  const serverItems = [
    { type: "session_attach", ...bound, session, configHash: registration.configHash },
    { type: "session_protocol", ...bound, protocolVersion: "negotiated" },
    { type: "session_detach", ...bound, reason: "client_closed" },
    { type: "session_fence", ...fence },
    {
      type: "cancel_frames",
      ...bound,
      tombstones: [{ clientSeq: 1, frameId: frame.frameId, payloadHash: frame.payloadHash }],
    },
    { type: "frame", ...bound, ...frame, direction: "client_to_server" },
  ];
  for (const [schema, items] of [
    [mcp.mcpWorkerItemSchema, workerItems],
    [mcp.mcpServerItemSchema, serverItems],
  ] as const)
    for (const item of items) {
      assert(schema.safeParse(item).success, "valid " + item.type);
      assert(!schema.safeParse({ ...item, extra: true }).success);
    }
  assert(mcp.mcpServerProcessSchema.safeParse(processRow).success);
  assert(!mcp.mcpServerProcessSchema.safeParse({ ...processRow, pid: null }).success);
  assert(mcp.mcpSessionSchema.safeParse(session).success);
  assert(!mcp.mcpSessionSchema.safeParse({ ...session, workerStateRevision: 1 }).success);
  for (const bad of [
    { payloadBytes: 0 },
    { payloadBytes: 3 },
    { payloadBase64: "?30=" },
    { frameId: sessionId },
  ])
    assert(!mcp.mcpHostOutboundFrameSchema.safeParse({ ...frame, ...bad }).success);
  const capability = {
    platform: "darwin",
    arch: "arm64",
    workerVersion: "test",
    shells: [],
    remoteOperations: [],
    mcpRelay: { version: 1, transports: ["stdio"], maxMessageBytes: 131072 },
  };
  assert(capabilitySnapshotSchema.safeParse(capability).success);
  for (const mcpRelay of [null, undefined])
    assert(capabilitySnapshotSchema.safeParse({ ...capability, mcpRelay }).success);
  for (const mcpRelay of [
    { ...capability.mcpRelay, extra: true },
    { ...capability.mcpRelay, version: 2 },
    { ...capability.mcpRelay, maxMessageBytes: 1 },
    { ...capability.mcpRelay, transports: ["stdio", "stdio"] },
  ])
    assert(!capabilitySnapshotSchema.safeParse({ ...capability, mcpRelay }).success);
  const envelope = {
    version: WORKER_PROTOCOL_VERSION,
    requestId,
    secret: "x".repeat(43),
    session: workerSession,
    mode: "normal",
    seq: 1,
    capability,
    observations: [],
    remote: { results: [], fenceAcks: [], mcp: workerItems, mcpCursors: [] },
  };
  assert(workerExchangeInput.safeParse(envelope).success);
  assert(!workerExchangeInput.safeParse({ ...envelope, version: 2 }).success);
  assert(
    !workerExchangeInput.safeParse({
      ...envelope,
      remote: { ...envelope.remote, mcp: Array.from({ length: 65 }, () => workerItems[1]) },
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
  const { capability: _capability, observations: _observations, ...drainBase } = envelope;
  assert(
    workerExchangeInput.safeParse({
      ...drainBase,
      mode: "drain",
      remote: { ...envelope.remote, mcp: workerItems.slice(3) },
    }).success,
  );
  assert(!workerExchangeInput.safeParse({ ...drainBase, mode: "drain" }).success);
  const http = {
    transport: "streamableHttp",
    url: "http://127.0.0.1:32145/mcp",
    launch: "owner_managed",
    autostart: false,
    exposure: "resources",
    roots: [],
    exposeSampling: false,
    elicitation: "cancel",
  };
  assert(mcp.mcpConfigSchema.safeParse(http).success);
  for (const url of [
    "http://user@127.0.0.1:32145/mcp",
    "http://127.0.0.1:32145/mcp?bad=1",
    "http://127.0.0.1:32145/mcp?",
    "http://127.0.0.1:32145/mcp#",
  ])
    assert(!mcp.mcpConfigSchema.safeParse({ ...http, url }).success);
  assert.equal(mcp.mcpConfigSchema.parse(config).requestTimeoutMs, 120000);
  assert(!mcp.mcpConfigSchema.safeParse({ ...config, envRefs: {} }).success);
  assert(!mcp.mcpConfigSchema.safeParse({ ...config, workingDirectory: "relative" }).success);
  assert(
    !mcp.mcpWorkerItemSchema.safeParse({ ...workerItems[5], direction: "client_to_server" })
      .success,
  );
  assert(
    !mcp.mcpServerItemSchema.safeParse({ ...serverItems[5], direction: "server_to_client" })
      .success,
  );
  assert(
    !mcp.mcpServerItemSchema.safeParse({
      ...serverItems[0],
      sessionId: newId(ID_PREFIXES.mcpSession),
    }).success,
  );
  const cursor = { ...bound, clientAcceptedThrough: 0, serverAcceptedThrough: 0 };
  assert(mcp.mcpSessionCursorSchema.safeParse(cursor).success);
  assert(
    !mcp.mcpSessionCursorSchema.safeParse({
      ...cursor,
      workerSession: { ...workerSession, machineId: newId(ID_PREFIXES.machine) },
    }).success,
  );
  const catalogEntry = {
    registrationId: registration.id,
    registrationRevision: 1,
    projectId: key.projectId,
    machineId: key.machineId,
    name: registration.name,
    transport: "stdio",
    configHash: registration.configHash,
    exposure: "wire",
    roots: [],
    toolAllowlist: ["echo"],
    requestTimeoutMs: 120000,
    exposeSampling: false,
    elicitation: "absent",
    processes: [
      {
        processId: bound.processId,
        workerIncarnationId: processRow.workerIncarnationId,
        lastObservedAt: 10,
      },
    ],
  };
  assert(mcp.mcpCatalogViewSchema.safeParse({ registrations: [catalogEntry] }).success);
  assert(
    !mcp.mcpCatalogViewSchema.safeParse({ registrations: [{ ...catalogEntry, command: "node" }] })
      .success,
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
  assert(
    !mcp.mcpConfigSchema.safeParse({
      ...config,
      toolAllowlist: Array.from({ length: 65 }, (_, index) => "tool_" + index),
    }).success,
  );
  const persistedFrame = {
    id: frame.frameId,
    sessionId,
    ...key,
    holderInstanceId: bound.holderInstanceId,
    processId: bound.processId,
    direction: "client_to_server",
    seq: frame.seq,
    payloadBase64: frame.payloadBase64,
    payloadBytes: frame.payloadBytes,
    payloadHash: frame.payloadHash,
    state: "queued",
    createdAt: 10,
    expiresAt: 20,
    sentAt: null,
    terminalAt: null,
    dispositionReason: null,
  };
  assert(mcp.mcpFrameSchema.safeParse(persistedFrame).success);
  assert(
    mcp.mcpFrameSchema.safeParse({
      ...persistedFrame,
      state: "unknown",
      payloadBase64: null,
      terminalAt: 12,
      dispositionReason: "worker_lost",
    }).success,
  );
  assert(!mcp.mcpFrameSchema.safeParse({ ...persistedFrame, state: "acked", sentAt: 11 }).success);
  assert(!mcp.mcpFrameSchema.safeParse({ ...persistedFrame, terminalReason: null }).success);
  pass("strict frozen MCP records calls item variants directions and Worker drain");
  pass("bounded MCP frames capability and explicit configuration");
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
