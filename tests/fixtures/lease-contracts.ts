import assert from "node:assert/strict";
import { migrateDatabase } from "../../src/db/migrate";
import { openDatabase } from "../../src/db/connection";

const databaseUrl = process.env.DATABASE_URL;
assert(databaseUrl && databaseUrl !== ":memory:", "isolated DATABASE_URL is required");
migrateDatabase(databaseUrl);
const { sqlite } = openDatabase(databaseUrl);
type Row = Record<string, string | number | null>;
const insert = (table: string, values: Row) => {
  const columns = Object.keys(values);
  sqlite
    .prepare(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...Object.values(values));
};
const rollback = (operation: () => void) => {
  sqlite.exec("SAVEPOINT probe");
  try {
    operation();
  } finally {
    sqlite.exec("ROLLBACK TO probe; RELEASE probe");
  }
};
const rejects = (table: string, row: Row, pattern: RegExp = /CHECK|NOT NULL|FOREIGN KEY|UNIQUE/) =>
  rollback(() => assert.throws(() => insert(table, row), pattern));
try {
  insert("user", {
    id: "owner",
    name: "Owner",
    email: "lease-owner@example.test",
    email_verified: 0,
    created_at: 1,
    updated_at: 1,
  });
  insert("agent_profile", { id: "profile", name: "Agent", created_by: "owner" });
  for (const p of ["a", "b"]) {
    insert("project", { id: p, name: p, created_by: "owner" });
    insert("chat", {
      id: `chat-${p}`,
      project_id: p,
      kind: "dm",
      owner_kind: "human",
      owner_id: "owner",
      created_by: "owner",
    });
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
      session_id: `session-${p}`,
    });
  }
  insert("machine", {
    id: "machine",
    name: "Machine",
    created_by: "owner",
    created_at: 1,
    updated_at: 1,
  });
  for (const p of ["a", "b"])
    insert("project_machine", {
      project_id: p,
      machine_id: "machine",
      created_by: "owner",
      revision: 1,
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
    seq: 0,
  });
  const lease = {
    project_id: "a",
    machine_id: "machine",
    generation: 1,
    state: "held",
    holder_instance_id: "instance-a",
    changed_at: 10,
  };
  insert("machine_lease", lease);
  rejects("machine_lease", lease, /UNIQUE/);
  insert("machine_lease", { ...lease, project_id: "b", holder_instance_id: "instance-b" });
  assert.equal(
    (sqlite.prepare("SELECT count(*) AS n FROM machine_lease").get() as { n: number }).n,
    2,
  );
  console.log("PASS N1/N2 same Project × Machine duplicate rejected; distinct Projects coexist");
  const authorization = {
    project_id: "a",
    machine_id: "machine",
    generation: 1,
    holder_instance_id: "instance-a",
    state: "active",
    issued_at: 10,
    revoked_at: null,
    reason: "acquire",
  };
  insert("lease_authorization", authorization);
  rejects("lease_authorization", { ...authorization, generation: 2 }, /UNIQUE/);
  rejects("machine_lease", { ...lease, project_id: "missing" }, /FOREIGN KEY/);
  rollback(() => {
    assert.throws(
      () =>
        sqlite
          .prepare(
            "UPDATE machine_lease SET holder_instance_id = 'instance-b' WHERE project_id = 'a'",
          )
          .run(),
      /FOREIGN KEY/,
    );
    for (const generation of [0, 3])
      assert.throws(
        () =>
          sqlite
            .prepare("UPDATE machine_lease SET generation = ? WHERE project_id = 'a'")
            .run(generation),
        /lease generation/,
      );
    sqlite.prepare("UPDATE machine_lease SET generation = 2 WHERE project_id = 'a'").run();
    sqlite.prepare("UPDATE machine_lease SET generation = 2 WHERE project_id = 'a'").run();
  });
  const authorizationRejections: Row[] = [
    { state: "free", holder_instance_id: "instance-a" },
    { state: "active", holder_instance_id: null },
    { state: "revoked", revoked_at: null },
    { state: "revoked", revoked_at: 9 },
    { state: "revoked", revoked_at: 10.5 },
    { state: "active", revoked_at: 11 },
    // I-P8a：挂靠中的授权同样必须挂在某个持有者身上，且不能是已撤销的形态。
    { state: "escrowed", holder_instance_id: null },
    { state: "escrowed", revoked_at: 11 },
    { state: "invented" },
    { reason: "invented" },
  ];
  for (const changes of authorizationRejections)
    rollback(() => {
      const columns = Object.keys(changes);
      assert.throws(
        () =>
          sqlite
            .prepare(
              `UPDATE lease_authorization SET ${columns.map((column) => `${column} = ?`).join(",")} WHERE project_id = 'a'`,
            )
            .run(...Object.values(changes)),
        /CHECK/,
      );
    });
  rollback(() => {
    sqlite
      .prepare(
        "UPDATE machine_lease SET state = 'free', holder_instance_id = NULL, generation = 2 WHERE project_id = 'b'",
      )
      .run();
    insert("lease_authorization", {
      ...authorization,
      project_id: "b",
      generation: 2,
      state: "free",
      holder_instance_id: null,
      reason: "release",
    });
    assert.throws(
      () =>
        insert("lease_authorization", {
          ...authorization,
          project_id: "b",
          generation: 3,
          holder_instance_id: "instance-b",
        }),
      /UNIQUE/,
    );
  });
  rollback(() => {
    // I-P8a：escrowed 是挂靠中的授权态，escrow/claim/escrow_cancel 是它的收据理由；
    // 挂靠中的授权同样占用唯一一个 live authorization 名额。
    sqlite
      .prepare(
        "UPDATE lease_authorization SET state = 'revoked', revoked_at = 11 WHERE project_id = 'a'",
      )
      .run();
    insert("lease_authorization", {
      ...authorization,
      generation: 2,
      state: "escrowed",
      reason: "escrow",
      issued_at: 11,
    });
    assert.throws(
      () =>
        insert("lease_authorization", {
          ...authorization,
          generation: 3,
          state: "active",
          reason: "claim",
        }),
      /UNIQUE/,
    );
    sqlite
      .prepare(
        "UPDATE lease_authorization SET state = 'revoked', revoked_at = 12 WHERE project_id = 'a'",
      )
      .run();
    insert("lease_authorization", {
      ...authorization,
      generation: 3,
      state: "active",
      reason: "claim",
      issued_at: 12,
    });
    sqlite
      .prepare(
        "UPDATE lease_authorization SET state = 'revoked', revoked_at = 13 WHERE project_id = 'a'",
      )
      .run();
    insert("lease_authorization", {
      ...authorization,
      generation: 4,
      state: "active",
      reason: "escrow_cancel",
      issued_at: 13,
    });
  });
  console.log(
    "PASS escrowed authorization state and escrow/claim/escrow_cancel reasons hold one live authorization",
  );
  const execution = {
    id: "execution",
    project_id: "a",
    machine_id: "machine",
    authorization_generation: 1,
    holder_instance_id: "instance-a",
    run_id: "run-a",
    chat_id: "chat-a",
    request_id: "operation-request",
    payload_hash: "a".repeat(64),
    operation_json: "{}",
    directory_revision: null,
    state: "queued",
    created_at: 10,
    dispatch_deadline_at: 20,
  };
  rejects("remote_execution", { ...execution, authorization_generation: 0 }, /CHECK/);
  rejects("remote_execution", { ...execution, authorization_generation: 2 }, /FOREIGN KEY/);
  rejects("remote_execution", { ...execution, holder_instance_id: "instance-b" }, /FOREIGN KEY/);
  rejects("remote_execution", { ...execution, project_id: "b" }, /FOREIGN KEY/);
  rejects("remote_execution", { ...execution, run_id: "run-b", chat_id: "chat-b" }, /FOREIGN KEY/);
  insert("remote_execution", execution);
  console.log(
    "PASS N5 invalid/nonexistent generation and cross-boundary delivery identities rejected by CHECK/FK",
  );
  rollback(() => {
    sqlite
      .prepare(
        "UPDATE lease_authorization SET state = 'revoked', revoked_at = 11 WHERE project_id = 'a'",
      )
      .run();
    sqlite.prepare("UPDATE machine_lease SET generation = 2 WHERE project_id = 'a'").run();
    insert("lease_authorization", { ...authorization, generation: 2, issued_at: 11 });
    insert("remote_execution", {
      ...execution,
      id: "historical-execution",
      request_id: "historical-request",
    });
  });
  console.log(
    "PASS historical FK intentionally permits existing revoked generation; current-generation rejection requires domain transaction",
  );
  const mutation = {
    id: "mutation",
    project_id: "a",
    machine_id: "machine",
    actor_kind: "agent",
    actor_id: "instance-a",
    request_id: "mutation-request",
    payload_hash: "b".repeat(64),
    action: "release",
    expected_generation: 1,
    target_instance_id: null,
    state: "pending",
    completed_generation: null,
    created_at: 10,
    completed_at: null,
  };
  insert("lease_mutation", mutation);
  rejects(
    "lease_mutation",
    { ...mutation, id: "second-mutation", request_id: "second-request" },
    /UNIQUE/,
  );
  const mutationRejections: Row[] = [
    { action: "acquire" },
    { actor_kind: "human" },
    { action: "handoff" },
    { target_instance_id: "instance-b" },
    { completed_at: 11 },
    { completed_generation: 2 },
    { state: "completed", completed_at: null, completed_generation: 1 },
    { state: "completed", completed_at: 11, completed_generation: null },
    { state: "completed", completed_at: 9, completed_generation: 1 },
  ];
  for (const changes of mutationRejections)
    rejects("lease_mutation", { ...mutation, ...changes }, /CHECK/);
  const frame = {
    machine_id: "machine",
    connection_generation: 1,
    seq: 1,
    payload_hash: "c".repeat(64),
    response_json: "{}",
    created_at: 10,
  };
  const grant = {
    id: "grant",
    secret_hash: "d".repeat(64),
    user_id: "owner",
    project_id: "a",
    chat_id: "chat-a",
    instance_id: "instance-a",
    run_id: "run-a",
    issued_at: 10,
    expires_at: 20,
    revoked_at: null,
  };
  insert("remote_tool_grant", grant);
  rejects(
    "remote_tool_grant",
    { ...grant, id: "other-grant", secret_hash: "e".repeat(64) },
    /UNIQUE/,
  );
  rejects(
    "remote_tool_grant",
    { ...grant, id: "other-grant", secret_hash: "e".repeat(64), run_id: "run-b" },
    /FOREIGN KEY/,
  );
  const result = {
    execution_id: "execution",
    project_id: "a",
    machine_id: "machine",
    authorization_generation: 1,
    holder_instance_id: "instance-a",
    payload_hash: "f".repeat(64),
    outcome: "rejected",
    payload_json: "{}",
    recorded_at: 10,
  };
  rejects("execution_result", { ...result, authorization_generation: 2 }, /FOREIGN KEY/);
  rejects("execution_result", { ...result, project_id: "b" }, /FOREIGN KEY/);
  insert("execution_result", result);
  rollback(() =>
    assert.throws(() => sqlite.exec("UPDATE execution_result SET outcome = 'invented'"), /CHECK/),
  );
  rejects("execution_result", result, /UNIQUE/);
  console.log(
    "PASS live authorization/pending mutation/result/grant uniqueness and composite identity constraints",
  );
  const escrow = {
    id: "escrow",
    project_id: "a",
    machine_id: "machine",
    state: "escrowed",
    chat_id: "chat-a",
    target_agent_profile_id: null,
    escrowed_by_instance_id: "instance-a",
    escrowed_at: 10,
    escrow_request_id: "escrow-request",
    escrow_payload_hash: "b".repeat(64),
    escrow_generation: 1,
    claimed_by_instance_id: null,
    claimed_at: null,
    claimed_generation: null,
    claim_request_id: null,
    claim_payload_hash: null,
    closed_at: null,
  };
  // I-P8a：挂靠目标只能落在同一个 Project 的 chat 上，分身与 Agent 也必须在同一 Project。
  rejects("lease_escrow", { ...escrow, state: "invented" }, /CHECK/);
  rejects("lease_escrow", { ...escrow, escrow_payload_hash: "short" }, /CHECK/);
  rejects("lease_escrow", { ...escrow, escrow_generation: 0 }, /CHECK/);
  rejects("lease_escrow", { ...escrow, escrowed_at: -1 }, /CHECK/);
  rejects("lease_escrow", { ...escrow, chat_id: "chat-b" }, /FOREIGN KEY/);
  rejects("lease_escrow", { ...escrow, chat_id: "missing" }, /FOREIGN KEY/);
  rejects("lease_escrow", { ...escrow, target_agent_profile_id: "missing" }, /FOREIGN KEY/);
  rejects("lease_escrow", { ...escrow, escrowed_by_instance_id: "instance-b" }, /FOREIGN KEY/);
  rejects("lease_escrow", { ...escrow, machine_id: "missing" }, /FOREIGN KEY/);
  rejects("lease_escrow", { ...escrow, project_id: "b", chat_id: "chat-a" }, /FOREIGN KEY/);
  // 活跃挂靠不能带领取痕迹，也不能带 closed_at。
  rejects(
    "lease_escrow",
    {
      ...escrow,
      claimed_by_instance_id: "instance-a",
      claimed_at: 11,
      claimed_generation: 2,
      claim_request_id: "claim-request",
      claim_payload_hash: "c".repeat(64),
    },
    /CHECK/,
  );
  rejects("lease_escrow", { ...escrow, closed_at: 11 }, /CHECK/);
  // 领取痕迹三者同生同灭，且领取代次必须大于挂靠代次。
  const claimed = {
    ...escrow,
    id: "escrow-claimed",
    // 领取收据是另一行（真实实现里是同一行被更新），因此有自己的挂靠请求身份。
    escrow_request_id: "escrow-request-claimed",
    state: "claimed",
    claimed_by_instance_id: "instance-a",
    claimed_at: 11,
    claimed_generation: 2,
    claim_request_id: "claim-request",
    claim_payload_hash: "c".repeat(64),
    closed_at: 11,
  };
  rejects("lease_escrow", { ...claimed, claimed_at: null }, /CHECK/);
  rejects("lease_escrow", { ...claimed, claim_request_id: null }, /CHECK/);
  rejects("lease_escrow", { ...claimed, claim_payload_hash: "d".repeat(63) }, /CHECK/);
  rejects("lease_escrow", { ...claimed, claimed_generation: 1 }, /CHECK/);
  rejects("lease_escrow", { ...claimed, claimed_generation: null }, /CHECK/);
  rejects("lease_escrow", { ...claimed, closed_at: null }, /CHECK/);
  rejects("lease_escrow", { ...claimed, closed_at: 9 }, /CHECK/);
  rejects("lease_escrow", { ...claimed, claimed_at: 9 }, /CHECK/);
  // 已撤销/已取代的挂靠也不能带领取者的身份字段。
  rejects("lease_escrow", { ...claimed, state: "cancelled", claimed_generation: 2 }, /CHECK/);
  rejects(
    "lease_escrow",
    { ...claimed, state: "superseded", claimed_by_instance_id: "instance-a" },
    /CHECK/,
  );
  // 同一机器上只能有一条活跃挂靠。
  insert("lease_escrow", escrow);
  rejects("lease_escrow", { ...escrow, id: "escrow-live-2" }, /UNIQUE/);
  // 挂靠请求与领取请求各自按身份幂等。
  rejects(
    "lease_escrow",
    { ...escrow, id: "escrow-superseded", state: "superseded", closed_at: 11 },
    /UNIQUE/,
  );
  insert("lease_escrow", claimed);
  rejects("lease_escrow", { ...claimed, id: "escrow-claimed-2" }, /UNIQUE/);
  console.log(
    "PASS lease escrow targets stay inside one project, one live escrow per machine, and claimed receipts advance the generation",
  );
  rollback(() => {
    sqlite.exec("UPDATE agent_run SET status = 'aborted', settled_at = 11 WHERE id = 'run-a'");
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT state, generation, holder_instance_id FROM machine_lease WHERE project_id = 'a'",
        )
        .get(),
      { state: "held", generation: 1, holder_instance_id: "instance-a" },
    );
    assert.throws(() => sqlite.exec("DELETE FROM agent_run WHERE id = 'run-a'"), /FOREIGN KEY/);
  });
  console.log("PASS run settlement preserves lease and execution history; no cascade deletion");
  const fresh = (row: Row): Row => ({
    ...row,
    ...(row.id ? { id: "probe" } : {}),
    ...(row.execution_id ? { execution_id: "missing" } : {}),
  });
  const checkRows: [string, Row, string[]][] = [
    ["machine_lease", lease, ["generation", "changed_at"]],
    ["lease_authorization", authorization, ["generation", "issued_at"]],
    ["lease_mutation", mutation, ["expected_generation", "created_at"]],
    ["worker_exchange_frame", frame, ["connection_generation", "seq", "created_at"]],
    [
      "remote_execution",
      execution,
      ["authorization_generation", "created_at", "dispatch_deadline_at"],
    ],
    ["execution_result", result, ["recorded_at"]],
    ["remote_tool_grant", grant, ["issued_at", "expires_at"]],
  ];
  for (const [table, row, columns] of checkRows)
    for (const column of columns)
      for (const value of [null, -1, 0.5, "bad"]) {
        rollback(() => {
          if (table === "worker_exchange_frame") insert(table, row);
          const where =
            table === "worker_exchange_frame"
              ? "seq = 1"
              : table === "execution_result"
                ? "execution_id = 'execution'"
                : table === "machine_lease" || table === "lease_authorization"
                  ? "project_id = 'a'"
                  : "id = '" + row.id + "'";
          assert.throws(
            () => sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where}`).run(value),
            /CHECK|NOT NULL|lease generation/,
          );
        });
      }
  for (const [table, column] of [
    ["machine_lease", "generation"],
    ["lease_authorization", "generation"],
    ["lease_mutation", "expected_generation"],
    ["worker_exchange_frame", "connection_generation"],
    ["worker_exchange_frame", "seq"],
    ["remote_execution", "authorization_generation"],
    ["remote_execution", "directory_revision"],
  ]) {
    rejects(
      table,
      {
        ...fresh(
          table === "machine_lease"
            ? lease
            : table === "lease_authorization"
              ? authorization
              : table === "lease_mutation"
                ? mutation
                : table === "worker_exchange_frame"
                  ? frame
                  : execution,
        ),
        [column]: 9007199254740992,
      },
      /CHECK|lease generation/,
    );
  }
  for (const [table, row, column] of [
    ["worker_exchange_frame", frame, "connection_generation"],
    ["worker_exchange_frame", frame, "seq"],
    [
      "remote_execution",
      { ...execution, id: "probe", request_id: "probe-request" },
      "authorization_generation",
    ],
  ] as [string, Row, string][])
    rejects(table, { ...row, [column]: 0 }, /CHECK/);
  for (const value of [-1, 0, 0.5, "bad"])
    rejects(
      "remote_execution",
      { ...execution, id: "probe", request_id: "probe-request", directory_revision: value },
      /CHECK/,
    );
  for (const value of [9, 0.5, "bad"])
    rejects(
      "remote_tool_grant",
      { ...grant, id: "probe", secret_hash: "e".repeat(64), run_id: "run-b", revoked_at: value },
      /CHECK/,
    );
  const executionRejections: Row[] = [
    { state: "succeeded", terminal_at: null },
    { state: "failed", terminal_at: 11, failure_reason: null },
    { state: "running", dispatch_connection_generation: null },
    { dispatch_connection_generation: 1, dispatch_seq: null, dispatched_at: 11 },
    { dispatch_connection_generation: null, dispatch_seq: 1, dispatched_at: 11 },
    { dispatch_connection_generation: 1, dispatch_seq: 1, dispatched_at: null },
    { drained_at: 11 },
    { terminal_at: 11 },
    { state: "invented" },
  ];
  for (const changes of executionRejections)
    rejects(
      "remote_execution",
      { ...execution, id: "probe", request_id: "probe-request", ...changes },
      /CHECK/,
    );
  for (const [table, row, column] of [
    ["worker_exchange_frame", frame, "response_json"],
    [
      "remote_execution",
      { ...execution, id: "probe", request_id: "probe-request" },
      "operation_json",
    ],
    ["execution_result", { ...result, execution_id: "missing" }, "payload_json"],
  ] as [string, Row, string][])
    for (const value of ["{", "null", "[]", '"text"'])
      rejects(table, { ...row, [column]: value }, /CHECK/);
  console.log(
    "PASS NULL-safe timestamps, optional columns, positive/safe integers, closed states and object JSON CHECKs",
  );
  sqlite.transaction(() => {
    sqlite
      .prepare(
        "UPDATE remote_execution SET state = 'running', dispatch_connection_generation = 1, dispatch_seq = 1, dispatched_at = 11 WHERE id = 'execution'",
      )
      .run();
    insert("worker_exchange_frame", frame);
  })();
  assert.throws(
    () =>
      sqlite.transaction(() => {
        sqlite.prepare("UPDATE remote_execution SET dispatch_seq = 2 WHERE id = 'execution'").run();
      })(),
    /FOREIGN KEY/,
  );
  assert.equal(
    (
      sqlite.prepare("SELECT dispatch_seq FROM remote_execution WHERE id = 'execution'").get() as {
        dispatch_seq: number;
      }
    ).dispatch_seq,
    1,
  );
  console.log("PASS delivery frame FK is deferred until COMMIT and missing frame rolls back");
  migrateDatabase(databaseUrl);
  assert.equal(
    (sqlite.prepare("SELECT count(*) AS n FROM machine_lease").get() as { n: number }).n,
    2,
  );
  assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  console.log(
    "PASS all seven tables migrate on real SQLite; rerun preserves rows and FK integrity",
  );
} finally {
  sqlite.close();
}
