import assert from "node:assert/strict";
import { migrateDatabase } from "../../src/db/migrate";
import { openDatabase } from "../../src/db/connection";

const databaseUrl = process.env.DATABASE_URL;
assert(databaseUrl && databaseUrl !== ":memory:", "isolated DATABASE_URL is required");
migrateDatabase(databaseUrl);
const { sqlite } = openDatabase(databaseUrl);
type Row = Record<string, string | number | null | Buffer>;
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
const update = (sql: string, ...params: unknown[]) =>
  rollback(() => assert.throws(() => sqlite.prepare(sql).run(...params), /CHECK|NOT NULL/));

try {
  insert("user", {
    id: "owner",
    name: "Owner",
    email: "execution-log-owner@example.test",
    email_verified: 0,
    created_at: 1,
    updated_at: 1,
  });
  insert("agent_profile", { id: "profile", name: "Agent", created_by: "owner" });
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
  insert("machine", {
    id: "other-machine",
    name: "Other",
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
  insert("runtime_boot", { id: "boot", started_at: 1, phase: "ready", pid: 1, app_version: "t" });
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
  insert("worker_exchange_frame", {
    machine_id: "machine",
    connection_generation: 1,
    seq: 1,
    payload_hash: "c".repeat(64),
    response_json: "{}",
    created_at: 10,
  });
  insert("machine_lease", {
    project_id: "a",
    machine_id: "machine",
    generation: 1,
    state: "held",
    holder_instance_id: "instance-a",
    changed_at: 10,
  });
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
    dispatch_deadline_at: 40,
    runtime_deadline_at: null,
    max_runtime_ms: null,
    runner_token: null,
    log_state: "none",
    produced_through_seq: null,
    acknowledged_through_seq: null,
    available_from_seq: null,
    dispatch_connection_generation: null,
    dispatch_seq: null,
    dispatched_at: null,
    drained_at: null,
    terminal_at: null,
    failure_reason: null,
  };
  insert("remote_execution", execution);
  console.log("PASS remote_execution accepts the queued baseline with dispatch_deadline_at");

  // 1. 下发窗口与运行上限是两个独立事实。
  rejects("remote_execution", { ...execution, runtime_deadline_at: 50 }, /CHECK/);
  rejects(
    "remote_execution",
    { ...execution, max_runtime_ms: 60000, runtime_deadline_at: 50 },
    /CHECK/,
  );
  rollback(() => {
    sqlite
      .prepare(
        `UPDATE remote_execution
         SET state = 'dispatched', dispatch_connection_generation = 1, dispatch_seq = 1,
             dispatched_at = 20, max_runtime_ms = 60000, runtime_deadline_at = 80020,
             runner_token = ? WHERE id = 'execution'`,
      )
      .run("b".repeat(32));
  });
  console.log(
    "PASS dispatch window and runtime cap are separate columns: runtime cap requires a dispatch",
  );

  // 2. runner token 必须是 32 hex，否则无法作为恢复证据。
  for (const token of ["b".repeat(31), "B".repeat(32), "g".repeat(32)])
    update("UPDATE remote_execution SET runner_token = ? WHERE id = 'execution'", token);
  console.log("PASS runner_token CHECK rejects non 32-hex evidence");

  // 3. log_state 与执行状态正交：succeeded + truncated 合法，full 缺 ack 非法。
  rollback(() => {
    sqlite
      .prepare(
        `UPDATE remote_execution
         SET state = 'succeeded', dispatch_connection_generation = 1, dispatch_seq = 1,
             dispatched_at = 20, drained_at = 30, terminal_at = 30,
             log_state = 'truncated', produced_through_seq = 9, available_from_seq = 2
         WHERE id = 'execution'`,
      )
      .run();
  });
  update(
    "UPDATE remote_execution SET log_state='full', produced_through_seq=9 WHERE id='execution'",
  );
  update("UPDATE remote_execution SET log_state='partial' WHERE id='execution'");
  update(
    "UPDATE remote_execution SET acknowledged_through_seq=5, produced_through_seq=4 WHERE id='execution'",
  );
  update(
    "UPDATE remote_execution SET produced_through_seq=4, available_from_seq=6 WHERE id='execution'",
  );
  rollback(() => {
    sqlite
      .prepare(
        "UPDATE remote_execution SET log_state='full', produced_through_seq=9, acknowledged_through_seq=9 WHERE id='execution'",
      )
      .run();
  });
  console.log(
    "PASS log_state is orthogonal to execution state; full requires acknowledged prefix and ack cannot exceed produced",
  );

  // 4. 带 token 的恢复归约在 schema 层可行；不带 token 的行不得进入终态归约。
  rollback(() => {
    // 先造一行 unknown（失联），保留可恢复标记与 token 证据。
    sqlite
      .prepare(
        `UPDATE remote_execution
         SET state = 'unknown', dispatch_connection_generation = 1, dispatch_seq = 1,
             dispatched_at = 20, terminal_at = 30, failure_reason = 'worker_lost',
             runner_token = ?, log_state = 'partial', produced_through_seq = 4
         WHERE id = 'execution'`,
      )
      .run("b".repeat(32));
    // 带 token 的归约：unknown -> succeeded，单向，不回退。
    sqlite
      .prepare(
        `UPDATE remote_execution
         SET state = 'succeeded', failure_reason = NULL, drained_at = 40, terminal_at = 40,
             acknowledged_through_seq = 4, log_state = 'full'
         WHERE id = 'execution' AND runner_token = ?`,
      )
      .run("b".repeat(32));
    assert.deepEqual(
      sqlite
        .prepare("SELECT state, failure_reason FROM remote_execution WHERE id='execution'")
        .get(),
      { state: "succeeded", failure_reason: null },
    );
  });
  // 不带 token 的行不能被归约：条件更新命中 0 行，unknown 保持。
  rollback(() => {
    sqlite
      .prepare(
        `UPDATE remote_execution
         SET state = 'unknown', dispatch_connection_generation = 1, dispatch_seq = 1,
             dispatched_at = 20, terminal_at = 30, failure_reason = 'worker_lost'
         WHERE id = 'execution'`,
      )
      .run();
    const changed = sqlite
      .prepare(
        `UPDATE remote_execution
         SET state = 'succeeded', failure_reason = NULL, drained_at = 40, terminal_at = 40
         WHERE id = 'execution' AND runner_token = ?`,
      )
      .run("b".repeat(32));
    assert.equal(changed.changes, 0);
    assert.deepEqual(
      sqlite.prepare("SELECT state FROM remote_execution WHERE id='execution'").get(),
      { state: "unknown" },
    );
  });
  console.log(
    "PASS token-bearing recovery reduces unknown to succeeded; missing token and cross-Machine writes are rejected",
  );

  // 5. 跨 Project / 跨 Machine 的执行身份不能借日志表或取消表越过外键。
  const frame = {
    execution_id: "execution",
    sequence: 1,
    project_id: "a",
    machine_id: "machine",
    authorization_generation: 1,
    holder_instance_id: "instance-a",
    stream: "stdout",
    byte_start: 0,
    byte_end: 5,
    payload_bytes: Buffer.from("hello"),
    checksum: "d".repeat(64),
    gap_from_seq: null,
    gap_to_seq: null,
    durable_at: 20,
  };
  // 每例换一个 sequence，避免主键冲突掩盖外键反证。
  insert("execution_log_frame", frame);
  rejects(
    "execution_log_frame",
    { ...frame, sequence: 11, execution_id: "missing" },
    /FOREIGN KEY/,
  );
  rejects("execution_log_frame", { ...frame, sequence: 12, project_id: "b" }, /FOREIGN KEY/);
  rejects(
    "execution_log_frame",
    { ...frame, sequence: 13, machine_id: "other-machine" },
    /FOREIGN KEY/,
  );
  rejects(
    "execution_log_frame",
    { ...frame, sequence: 14, authorization_generation: 2 },
    /FOREIGN KEY/,
  );
  rejects(
    "execution_log_frame",
    { ...frame, sequence: 15, holder_instance_id: "instance-b" },
    /FOREIGN KEY/,
  );
  console.log(
    "PASS log frame identity columns reject cross Project/Machine/generation/holder writes",
  );

  // 6. 帧与 gap 二选一，且正文与位点有上限。
  const gap = {
    ...frame,
    sequence: 2,
    payload_bytes: null,
    gap_from_seq: 2,
    gap_to_seq: 5,
  };
  insert("execution_log_frame", gap);
  rejects("execution_log_frame", { ...frame, sequence: 3, gap_to_seq: 5 }, /CHECK/);
  rejects("execution_log_frame", { ...gap, sequence: 4, payload_bytes: Buffer.from("x") }, /CHECK/);
  rejects("execution_log_frame", { ...gap, sequence: 5, gap_from_seq: null }, /CHECK/);
  rejects(
    "execution_log_frame",
    { ...frame, sequence: 6, payload_bytes: Buffer.alloc(16385) },
    /CHECK/,
  );
  rejects("execution_log_frame", { ...frame, sequence: 7, byte_end: -1 }, /CHECK/);
  rejects("execution_log_frame", { ...frame, sequence: 8, checksum: "D".repeat(64) }, /CHECK/);
  rejects("execution_log_frame", { ...frame, sequence: 1 }, /UNIQUE|PRIMARY/);
  console.log(
    "PASS log frame payload/gap CHECK, 16384 byte cap, byte monotonicity and sequence uniqueness",
  );

  // 7. 取消表：内部命名空间、六态与时间字段一致性。
  const cancellation = {
    id: "cancel-row",
    execution_id: "execution",
    request_id: "cancel:instance-a:req_11111111-1111-4111-8111-111111111111",
    project_id: "a",
    machine_id: "machine",
    authorization_generation: 1,
    holder_instance_id: "instance-a",
    actor_kind: "agent",
    actor_id: "instance-a",
    state: "requested",
    signal_outcome: "none",
    policy: "term_then_kill",
    term_wait_ms: 2000,
    requested_at: 20,
    delivered_at: null,
    exited_at: null,
    failure_reason: null,
  };
  insert("execution_cancellation", cancellation);
  rejects("execution_cancellation", { ...cancellation, request_id: "req_public" }, /CHECK/);
  rejects("execution_cancellation", { ...cancellation, request_id: "cancel:" }, /CHECK/);
  // 9. 取消策略与宽限期是落库事实，不是下发时的常量。
  rejects("execution_cancellation", { ...cancellation, policy: "kill_all" }, /CHECK/);
  rejects("execution_cancellation", { ...cancellation, term_wait_ms: 0 }, /CHECK/);
  rejects("execution_cancellation", { ...cancellation, term_wait_ms: 10001 }, /CHECK/);
  rollback(() =>
    insert("execution_cancellation", {
      ...cancellation,
      id: "cancel-kill",
      request_id: "cancel:instance-a:req_kill",
      policy: "kill",
      term_wait_ms: 1,
    }),
  );
  console.log(
    "PASS cancellation policy and term wait are stored facts with CHECK ranges (kill/1 accepted, bogus/0/10001 rejected)",
  );
  rejects(
    "execution_cancellation",
    {
      ...cancellation,
      id: "duplicate",
      execution_id: "execution",
    },
    /UNIQUE/,
  );
  rejects(
    "execution_cancellation",
    { ...cancellation, id: "cross-project", project_id: "b", request_id: "cancel:a:req_cross1" },
    /FOREIGN KEY/,
  );
  rejects(
    "execution_cancellation",
    {
      ...cancellation,
      id: "cross-machine",
      machine_id: "other-machine",
      request_id: "cancel:a:req_cross2",
    },
    /FOREIGN KEY/,
  );
  // 取消发起者的两种 actor 共用列形状：非法 kind 与空 id 都由 CHECK 拒绝。
  rejects(
    "execution_cancellation",
    {
      ...cancellation,
      id: "bad-actor-kind",
      actor_kind: "system",
      request_id: "cancel:a:req_actor1",
    },
    /CHECK/,
  );
  rejects(
    "execution_cancellation",
    {
      ...cancellation,
      id: "empty-actor-id",
      actor_id: "",
      request_id: "cancel:a:req_actor2",
    },
    /CHECK/,
  );
  rejects(
    "execution_cancellation",
    {
      ...cancellation,
      id: "cross-generation",
      authorization_generation: 2,
      request_id: "cancel:a:req_gen2",
    },
    /FOREIGN KEY/,
  );
  // 幂等键命名空间：公开 req_ 与内部 cancel: 前缀在同一 holder 下并存且互不相撞。
  rollback(() => {
    const insertCancellation = (id: string, requestId: string) =>
      sqlite
        .prepare(
          `INSERT INTO execution_cancellation
             (id, execution_id, request_id, project_id, machine_id, authorization_generation,
              holder_instance_id, actor_kind, actor_id, state, signal_outcome, policy, term_wait_ms,
              requested_at, delivered_at, exited_at, failure_reason)
           VALUES (?, 'execution', ?, 'a', 'machine', 1, 'instance-a', 'agent', 'instance-a',
                   'requested', 'none', 'term_then_kill', 2000, 20, NULL, NULL, NULL)`,
        )
        .run(id, requestId);
    // 内部命名空间可落库。
    insertCancellation("namespace-probe", "cancel:instance-a:operation-request");
    // 同一 holder 下把公开 req_ 值当取消键会被 CHECK 拒绝。
    assert.throws(() => insertCancellation("namespace-public", "operation-request"), /CHECK/);
    // 同一 holder 同一取消键只能落一行。
    assert.throws(
      () => insertCancellation("namespace-dup", "cancel:instance-a:operation-request"),
      /UNIQUE/,
    );
    // 公开 req_ 幂等键仍单独受 remote_execution 的唯一键约束。
    assert.throws(
      () =>
        insert("remote_execution", {
          ...execution,
          id: "second-execution",
          payload_hash: "9".repeat(64),
          dispatch_deadline_at: 41,
        }),
      /UNIQUE/,
    );
  });
  console.log("PASS cancel: namespace cannot collide with public req_ keys under one holder");
  for (const changes of [
    { state: "delivered", delivered_at: null },
    { state: "delivered", delivered_at: 15 },
    { state: "requested", delivered_at: 20 },
    { state: "requested", signal_outcome: "term_delivered" },
    { state: "exited_observed", delivered_at: 21, exited_at: null },
    { state: "exited_observed", delivered_at: 21, exited_at: 20 },
    { state: "already_exited", delivered_at: 21, exited_at: 22, failure_reason: "signal_failed" },
    { state: "failed", delivered_at: 21, exited_at: null, failure_reason: null },
    { state: "failed", delivered_at: null, failure_reason: "signal_failed" },
    { state: "unknown", failure_reason: null },
    { state: "unknown", delivered_at: 21, exited_at: 22, failure_reason: "delivery_unconfirmed" },
  ] as Row[])
    rejects(
      "execution_cancellation",
      { ...cancellation, id: "probe", request_id: "cancel:a:req_probe", ...changes },
      /CHECK/,
    );
  for (const accepted of [
    { state: "delivered", delivered_at: 21, signal_outcome: "term_delivered" },
    { state: "exited_observed", delivered_at: 21, exited_at: 22, signal_outcome: "kill_delivered" },
    { state: "already_exited", delivered_at: 21, exited_at: 22, signal_outcome: "term_delivered" },
    { state: "failed", delivered_at: 21, failure_reason: "signal_failed" },
    { state: "unknown", failure_reason: "delivery_unconfirmed" },
  ] as Row[])
    rollback(() =>
      insert("execution_cancellation", {
        ...cancellation,
        id: `accept-${String(accepted.state)}`,
        request_id: `cancel:a:req_accept_${String(accepted.state)}`,
        ...accepted,
      }),
    );
  console.log(
    "PASS cancellation namespace, six states, delivered-without-exited legality and identity FKs",
  );

  // 8. 裁剪只推进 available_from_seq，不新建第三张表。
  assert.deepEqual(
    (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name),
    ["execution_cancellation", "execution_log_frame", "execution_result"],
  );
  console.log("PASS trims add no third execution table");

  // 9. 迁移重放保持可用且外键完整。
  migrateDatabase(databaseUrl);
  assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  assert.deepEqual(sqlite.prepare("SELECT count(*) AS n FROM execution_log_frame").get(), { n: 2 });
  console.log("PASS 0013 replays without duplication and keeps FK integrity");
} finally {
  sqlite.close();
}
