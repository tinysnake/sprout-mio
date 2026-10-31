// F8b：在可声明的日志体量下，用现有 cursor 读取路径分页读完整日志，并测量 Worker outbox
// 高/低水位回落。数据体量固定为产品保留上限 512 帧 × 1 KiB = 512 KiB；不新造协议。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { ID_PREFIXES, newId } from "../../../src/contracts/ids";
import { sqlite } from "../../../src/db";
import { migrateDatabase } from "../../../src/db/migrate";
import { createMachine, saveProjectMachineBinding } from "../../../src/domain/machine";
import { acquireLease } from "../../../src/server/lease";
import { readExecutionLog, requestExecution } from "../../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../../src/server/worker-gateway";
import { ExecutionLog } from "../../../src/worker/execution-log";
import { seedRemoteActor } from "../../../tests/fixtures/remote-actors";

const FRAME_COUNT = 512;
const FRAME_BYTES = 1024;
const LIMIT_BYTES = 65_536;
const ROUNDS = 3;

function percentile(values: number[], percent: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
  return Math.round(sorted[index]! * 1000) / 1000;
}

migrateDatabase();
const userId = "usr_measure_logs";
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(userId, "measure", "measure-logs@sprout.test");
const projectId = newId(ID_PREFIXES.project);
sqlite
  .prepare("INSERT INTO project(id,name,created_by) VALUES (?,?,?)")
  .run(projectId, "日志测量", userId);
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'measure-logs')",
  )
  .run(bootId);
const remote = seedRemoteActor(sqlite, userId, projectId, bootId);
const machine = createMachine({ name: "日志测量 Machine" }, remote);
const machineId = machine.detail.machine.id;
saveProjectMachineBinding(
  { projectId, machineId, description: "measure logs", expectedRevision: null },
  remote,
);
const lease = acquireLease(
  {
    projectId,
    machineId,
    action: "acquire",
    requestId: newId(ID_PREFIXES.request),
    expectedGeneration: 0,
  },
  remote,
);
const authorizationGeneration = lease.completedGeneration ?? 1;
const secret = "m".repeat(43);
const wire = { machineId, secret, version: 3 as const, requestId: newId(ID_PREFIXES.request) };
enrollWorker({ ...wire, ticket: machine.ticket }, remote);
const session = openWorker({ ...wire, attemptId: randomUUID() }, remote).session;
let seq = 0;
const exchange = () =>
  exchangeWorker(
    {
      version: 3,
      requestId: wire.requestId,
      secret,
      session,
      seq: ++seq,
      mode: "normal",
      capability: {
        platform: "darwin",
        arch: "arm64",
        workerVersion: "measure-logs",
        shells: [
          {
            path: "/bin/sh",
            kind: "sh",
            version: null,
            checkedAt: remote.now.toISOString(),
            probe: { kind: "success" },
          },
        ],
        remoteOperations: ["shell", "file_read", "file_write", "process_list", "process_signal"],
      },
      observations: [],
      remote: { results: [], fenceAcks: [], mcp: [], mcpCursors: [] },
    } as Parameters<typeof exchangeWorker>[0],
    remote,
  );
exchange();
const submitted = requestExecution(
  {
    projectId,
    machineId,
    requestId: newId(ID_PREFIXES.request),
    authorizationGeneration,
    operation: { kind: "shell", command: "printf measure", cwd: "/tmp", waitMs: 1000 },
  },
  remote,
);
exchange();

const insertFrame = sqlite.prepare(
  `INSERT INTO execution_log_frame(execution_id, sequence, project_id, machine_id,
     authorization_generation, holder_instance_id, stream, byte_start, byte_end,
     payload_bytes, checksum, durable_at)
   VALUES (?, ?, ?, ?, ?, ?, 'stdout', ?, ?, ?, ?, ?)`,
);
const insertFrames = sqlite.transaction(() => {
  let start = 0;
  for (let sequence = 1; sequence <= FRAME_COUNT; sequence += 1) {
    const text = `frame ${String(sequence).padStart(4, "0")} `.padEnd(FRAME_BYTES, "x");
    const payload = Buffer.from(text, "utf8");
    assert.equal(payload.byteLength, FRAME_BYTES);
    insertFrame.run(
      submitted.executionId,
      sequence,
      projectId,
      machineId,
      authorizationGeneration,
      remote.instanceId,
      start,
      start + payload.byteLength,
      payload,
      createHash("sha256").update(payload).digest("hex"),
      1,
    );
    start += payload.byteLength;
  }
  sqlite
    .prepare(
      "UPDATE remote_execution SET produced_through_seq = ?, acknowledged_through_seq = ?, log_state = 'full', log_sealed = 1 WHERE id = ?",
    )
    .run(FRAME_COUNT, FRAME_COUNT, submitted.executionId);
});
insertFrames();

const rounds: Array<{
  pages: number[];
  totalMs: number;
  frameCount: number;
  firstSequence: number;
  lastSequence: number;
  uniqueSequences: boolean;
  logState: string;
}> = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const pageDurations: number[] = [];
  const sequences: number[] = [];
  let cursor: { executionId: string; nextSequence: number } | null = null;
  let pageCount = 0;
  let logState = "none";
  const started = performance.now();
  for (;;) {
    const pageStarted = performance.now();
    const page = readExecutionLog(
      {
        projectId,
        machineId,
        executionId: submitted.executionId,
        cursor,
        limitBytes: LIMIT_BYTES,
      },
      remote,
    );
    pageDurations.push(performance.now() - pageStarted);
    pageCount += 1;
    logState = page.logState;
    sequences.push(...page.frames.map((frame) => frame.sequence));
    cursor = page.nextCursor;
    if (!page.hasMore) break;
    assert(pageCount < 100, "分页游标不能停在同一页");
  }
  assert.equal(sequences.length, FRAME_COUNT);
  assert.deepEqual(
    sequences,
    Array.from({ length: FRAME_COUNT }, (_, index) => index + 1),
  );
  rounds.push({
    pages: pageDurations.map((duration) => Math.round(duration * 1000) / 1000),
    totalMs: Math.round((performance.now() - started) * 1000) / 1000,
    frameCount: sequences.length,
    firstSequence: sequences[0]!,
    lastSequence: sequences.at(-1)!,
    uniqueSequences: new Set(sequences).size === sequences.length,
    logState,
  });
}

const allPages = rounds.flatMap((round) => round.pages);
const pagination = {
  frameCount: FRAME_COUNT,
  frameBytes: FRAME_BYTES,
  totalBytes: FRAME_COUNT * FRAME_BYTES,
  limitBytes: LIMIT_BYTES,
  rounds: rounds.length,
  pagesPerRound: rounds.map((round) => round.pages.length),
  pageLatencyMs: {
    samples: allPages.length,
    p50: percentile(allPages, 50),
    p95: percentile(allPages, 95),
    max: Math.round(Math.max(...allPages) * 1000) / 1000,
  },
  fullReadMs: {
    p50: percentile(
      rounds.map((round) => round.totalMs),
      50,
    ),
    p95: percentile(
      rounds.map((round) => round.totalMs),
      95,
    ),
  },
  integrity: {
    everyRoundComplete: rounds.every(
      (round) => round.frameCount === FRAME_COUNT && round.logState === "full",
    ),
    firstSequence: 1,
    lastSequence: FRAME_COUNT,
    noDuplicates: rounds.every((round) => round.uniqueSequences),
  },
};

// Worker outbox：4 MiB 高水位暂停读取，确认后低于 1 MiB 低水位恢复；这是积压回落的现有条件。
let paused = 0;
let resumed = 0;
const outbox = new ExecutionLog();
outbox.bind({
  stdout: { pause: () => (paused += 1), resume: () => (resumed += 1) },
  stderr: { pause: () => (paused += 1), resume: () => (resumed += 1) },
});
const chunk = Buffer.alloc(16 * 1024, 0x61);
while (outbox.backlogBytes <= 4 * 1024 * 1024) outbox.append("stdout", chunk);
const pausedAtBytes = outbox.backlogBytes;
assert.equal(paused, 2, "超过 4 MiB 时两个流闸门各暂停一次");
outbox.acknowledge(outbox.producedThrough - 40, null);
const resumedAtBytes = outbox.backlogBytes;
assert.equal(resumed, 2, "确认到低于 1 MiB 时两个流闸门各恢复一次");
assert(resumedAtBytes < 1024 * 1024);
const outboxResult = {
  highWaterBytes: 4 * 1024 * 1024,
  lowWaterBytes: 1024 * 1024,
  pausedAtBytes,
  resumedAtBytes,
  paused,
  resumed,
  remainingFrames: outbox.frames.length,
};

console.log(
  "RESULT " +
    JSON.stringify({
      declaredVolume: {
        frames: FRAME_COUNT,
        bytesPerFrame: FRAME_BYTES,
        totalBytes: FRAME_COUNT * FRAME_BYTES,
        note: "产品单执行保留上限 512 帧 / 1 MiB 以内",
      },
      pagination,
      outbox: outboxResult,
    }),
);
sqlite.close();
