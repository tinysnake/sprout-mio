import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { newId, ID_PREFIXES } from "../src/contracts/ids";
import {
  leaseMutationInputSchema,
  leaseMutationViewSchema,
  leaseViewSchema,
} from "../src/contracts/lease";
import { capabilitySnapshotSchema } from "../src/contracts/machine";
import {
  executionSubmitInputSchema,
  executionViewSchema,
  remoteAgentRequestSchema,
  remoteCommandSchema,
  remoteExchangeOutputSchema,
  remoteReportSchema,
  remoteResultPayloadSchema,
  remoteToolGrantSchema,
  remoteToolInputSchemas,
  REMOTE_ERROR_CODES,
} from "../src/contracts/remote";
import { workerExchangeInput, workerExchangeResponseSchema } from "../src/contracts/worker";
import * as humanContracts from "../src/contracts";

const projectId = newId(ID_PREFIXES.project);
const machineId = newId(ID_PREFIXES.machine);
const instanceId = newId(ID_PREFIXES.instance);
const requestId = newId(ID_PREFIXES.request);
const executionId = newId(ID_PREFIXES.execution);
const mutationId = newId(ID_PREFIXES.leaseMutation);
const key = { projectId, machineId };
const at = "2026-10-24T00:00:00.000Z";
const session = {
  machineId,
  generation: 1,
  bootId: newId(ID_PREFIXES.boot),
  attemptId: crypto.randomUUID(),
};
const identity = {
  ...key,
  executionId,
  authorizationGeneration: 1,
  holderInstanceId: instanceId,
  dispatchSession: session,
  dispatchSeq: 1,
  fingerprint: "a".repeat(64),
};
const result = {
  kind: "shell" as const,
  pid: 1,
  exited: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  truncated: false,
};
const remote = { authorizations: [], commands: [], fences: [], resultAcks: [], fenceAcks: [] };
const capability = {
  platform: "darwin",
  arch: "arm64",
  workerVersion: "test",
  shells: [],
  remoteOperations: ["file_read"],
};

describe("P4b shared contracts", () => {
  it("requires explicit targets/generations and distinguishes reclaim from Agent actions", () => {
    const acquire = { ...key, action: "acquire", requestId, expectedGeneration: 0 };
    expect(leaseMutationInputSchema.safeParse(acquire).success).toBe(true);
    const { machineId: _machine, ...missingMachine } = acquire;
    expect(leaseMutationInputSchema.safeParse(missingMachine).success).toBe(false);
    for (const expectedGeneration of [0, -1, 1.5, 9007199254740992, undefined]) {
      expect(
        leaseMutationInputSchema.safeParse({ ...acquire, action: "release", expectedGeneration })
          .success,
      ).toBe(false);
      expect(
        executionSubmitInputSchema.safeParse({
          ...key,
          requestId,
          authorizationGeneration: expectedGeneration,
          operation: { kind: "process_list" },
        }).success,
      ).toBe(false);
    }
    const reclaim = { ...acquire, action: "reclaim", expectedGeneration: 1, confirm: true };
    expect(leaseMutationInputSchema.safeParse(reclaim).success).toBe(true);
    expect(
      remoteAgentRequestSchema.safeParse({
        version: 2,
        call: { type: "lease_mutate", input: reclaim },
      }).success,
    ).toBe(false);
    for (const schema of Object.values(remoteToolInputSchemas))
      expect(schema.safeParse({}).success).toBe(false);
    expect(new Set(REMOTE_ERROR_CODES).size).toBe(25);
    expect([...REMOTE_ERROR_CODES]).toEqual([...humanContracts.APP_ERROR_CODES]);
  });

  it("enforces lease/tombstone and pending/completed receipt invariants", () => {
    const lease = {
      ...key,
      generation: 0,
      state: "free",
      holderInstanceId: null,
      changedAt: at,
      pendingMutationId: null,
    };
    expect(leaseViewSchema.safeParse(lease).success).toBe(true);
    expect(
      leaseViewSchema.safeParse({ ...lease, state: "held", holderInstanceId: instanceId }).success,
    ).toBe(false);
    expect(
      leaseViewSchema.safeParse({
        ...lease,
        state: "fencing",
        generation: 1,
        holderInstanceId: instanceId,
        pendingMutationId: mutationId,
      }).success,
    ).toBe(true);
    const receipt = {
      ...key,
      mutationId,
      action: "release",
      state: "pending",
      expectedGeneration: 1,
      completedGeneration: null,
      targetInstanceId: null,
      createdAt: at,
      completedAt: null,
    };
    expect(leaseMutationViewSchema.safeParse(receipt).success).toBe(true);
    for (const changes of [
      { state: "completed" },
      { action: "acquire" },
      { action: "handoff" },
      { completedGeneration: 2 },
      { completedAt: at },
    ])
      expect(leaseMutationViewSchema.safeParse({ ...receipt, ...changes }).success).toBe(false);
  });

  it("normalizes operation defaults and bounds UTF-8 bytes rather than code units", () => {
    expect(
      executionSubmitInputSchema.parse({
        ...key,
        requestId,
        authorizationGeneration: 1,
        operation: { kind: "shell", command: "true" },
      }).operation,
    ).toEqual({ kind: "shell", command: "true", waitMs: 1000 });
    for (const [name, input, expected] of [
      ["sprout_remote_file_read", { path: "/tmp/example" }, { maxBytes: 65536 }],
      ["sprout_remote_file_write", { path: "/tmp/example", content: "" }, { mode: "overwrite" }],
      ["sprout_remote_process_list", {}, { limit: 100 }],
    ] as const)
      expect(
        remoteToolInputSchemas[name].parse({
          machineId,
          requestId,
          authorizationGeneration: 1,
          ...input,
        }),
      ).toMatchObject(expected);
    const shell = {
      machineId,
      requestId,
      authorizationGeneration: 1,
      command: "界".repeat(21845) + "a",
    };
    expect(remoteToolInputSchemas.sprout_remote_shell.safeParse(shell).success).toBe(true);
    for (const command of [shell.command + "a", "bad\0command"])
      expect(
        remoteToolInputSchemas.sprout_remote_shell.safeParse({ ...shell, command }).success,
      ).toBe(false);
    expect(
      remoteToolInputSchemas.sprout_remote_file_read.safeParse({
        machineId,
        requestId,
        authorizationGeneration: 1,
        path: "relative",
      }).success,
    ).toBe(false);
    expect(capabilitySnapshotSchema.safeParse(capability).success).toBe(true);
    expect(
      capabilitySnapshotSchema.safeParse({ ...capability, remoteOperations: ["shell", "shell"] })
        .success,
    ).toBe(false);
    expect(
      capabilitySnapshotSchema.safeParse({ ...capability, remoteOperations: "not_implemented" })
        .success,
    ).toBe(false);
  });

  it("rejects invented execution/outcome states and inconsistent terminal payloads", () => {
    const report = {
      ...identity,
      phase: "terminal",
      drained: true,
      outcome: "succeeded",
      payload: result,
    };
    expect(remoteReportSchema.safeParse(report).success).toBe(true);
    for (const changes of [
      { outcome: "invented" },
      { phase: "running" },
      { drained: false },
      { payload: { ...result, exitCode: 1 } },
      { payload: { ...result, exited: false } },
    ])
      expect(remoteReportSchema.safeParse({ ...report, ...changes }).success).toBe(false);
    expect(
      remoteReportSchema.safeParse({
        ...report,
        outcome: "timed_out",
        payload: { kind: "shell", failureReason: "deadline", partial: result },
      }).success,
    ).toBe(true);
    expect(
      remoteReportSchema.safeParse({
        ...report,
        outcome: "timed_out",
        payload: { kind: "shell", failureReason: "executor_error" },
      }).success,
    ).toBe(false);
    expect(
      remoteResultPayloadSchema.safeParse({
        kind: "file_read",
        failureReason: "executor_error",
        partial: result,
      }).success,
    ).toBe(false);
    const view = {
      ...key,
      executionId,
      authorizationGeneration: 1,
      holderInstanceId: instanceId,
      authority: "holder",
      currentAuthorizationGeneration: 1,
      runId: `run_${crypto.randomUUID()}`,
      chatId: newId(ID_PREFIXES.chat),
      requestId,
      operation: { kind: "shell", command: "true" },
      state: "succeeded",
      createdAt: at,
      dispatchDeadlineAt: "2026-10-24T00:00:10.000Z",
      runtimeDeadlineAt: null,
      maxRuntimeMs: null,
      dispatchConnectionGeneration: 1,
      dispatchSeq: 1,
      dispatchedAt: "2026-10-24T00:00:01.000Z",
      drainedAt: at,
      payloadHash: "a".repeat(64),
      terminalAt: at,
      failureReason: null,
      recoveryReason: null,
      result,
      logState: "none",
      producedThroughSequence: null,
      acknowledgedThroughSequence: null,
      availableFromSequence: null,
      cancellation: null,
    };
    expect(executionViewSchema.safeParse(view).success).toBe(true);
    for (const state of ["invented", "running", "failed"])
      expect(executionViewSchema.safeParse({ ...view, state }).success).toBe(false);
    expect(executionViewSchema.safeParse({ ...view, secret: "forbidden" }).success).toBe(false);
  });

  it("separates normal/drain frames and validates delivery session/seq and total byte budget", () => {
    const frame = {
      version: 3,
      requestId,
      secret: "x".repeat(43),
      mode: "normal",
      session,
      seq: 1,
      capability,
      observations: [],
      remote: { results: [], fenceAcks: [], mcp: [], mcpCursors: [] },
    };
    expect(workerExchangeInput.safeParse(frame).success).toBe(true);
    const { capability: _capability, observations: _observations, ...base } = frame;
    expect(workerExchangeInput.safeParse({ ...base, mode: "drain" }).success).toBe(true);
    expect(workerExchangeInput.safeParse({ ...frame, mode: "drain" }).success).toBe(false);
    expect(workerExchangeInput.safeParse({ ...frame, version: 1 }).success).toBe(false);
    const command = {
      ...identity,
      requestId,
      operation: { kind: "shell", command: "true", cwd: "/tmp" },
      directoryRevision: 1,
      dispatchDeadlineAt: at,
    };
    expect(remoteCommandSchema.safeParse(command).success).toBe(true);
    expect(
      remoteCommandSchema.safeParse({ ...command, operation: { kind: "shell", command: "true" } })
        .success,
    ).toBe(false);
    const data = {
      mode: "normal",
      session,
      seq: 1,
      configuration: { root: null, rootRevision: 1, bindings: [] },
      remote: { ...remote, commands: [command], mcp: [], mcpCursors: [] },
    };
    const response = { version: 3, requestId, ok: true, data };
    expect(workerExchangeResponseSchema.safeParse(response).success).toBe(true);
    expect(
      workerExchangeResponseSchema.safeParse({ ...response, data: { ...data, seq: 2 } }).success,
    ).toBe(false);
    expect(
      workerExchangeResponseSchema.safeParse({
        ...response,
        data: { ...data, mode: "drain", configuration: null },
      }).success,
    ).toBe(false);
    expect(
      workerExchangeResponseSchema.safeParse({
        ...response,
        data: {
          ...data,
          mode: "drain",
          configuration: null,
          remote: { ...remote, mcp: [], mcpCursors: [] },
        },
      }).success,
    ).toBe(true);
    const payload = { kind: "file_read", content: "x".repeat(262144), truncated: false };
    const reports = Array.from({ length: 4 }, () => ({
      ...identity,
      executionId: newId(ID_PREFIXES.execution),
      phase: "terminal",
      drained: true,
      outcome: "succeeded",
      payload,
    }));
    expect(
      workerExchangeInput.safeParse({
        ...frame,
        remote: { results: reports.slice(0, 3), fenceAcks: [], mcp: [], mcpCursors: [] },
      }).success,
    ).toBe(true);
    expect(
      workerExchangeInput.safeParse({
        ...frame,
        remote: { results: reports, fenceAcks: [], mcp: [], mcpCursors: [] },
      }).success,
    ).toBe(false);
    expect(
      // 用基座 schema 而非 workerExchangeOutputRemoteSchema：此处验的是 generation: 0
      // 的 authorization 语义，不是 remote 形状；换成超集会让断言失去意义。
      remoteExchangeOutputSchema.safeParse({
        ...remote,
        authorizations: [{ ...key, generation: 0, state: "active", holderInstanceId: instanceId }],
      }).success,
    ).toBe(false);
  });

  it("keeps private transport credentials out of the Human barrel", () => {
    for (const name of [
      "remoteToolGrantSchema",
      "workerSecretSchema",
      "workerSessionSchema",
      "workerExchangeInput",
      "remoteAgentRequestSchema",
      "mcpWorkerItemSchema",
      "mcpServerItemSchema",
      "mcpSessionSchema",
      "mcpConfigSchema",
    ])
      expect(name in humanContracts).toBe(false);
    const grant = {
      endpoint: "https://example.test/api/remote/agent",
      secret: "x".repeat(43),
      expiresAt: at,
      projectId,
    };
    expect(remoteToolGrantSchema.safeParse(grant).success).toBe(true);
    for (const endpoint of [
      "https://example.test/api/remote/agent?secret=x",
      "https://example.test/other",
      "file:///api/remote/agent",
    ])
      expect(remoteToolGrantSchema.safeParse({ ...grant, endpoint }).success).toBe(false);
    expect(
      leaseViewSchema.safeParse({
        ...key,
        generation: 0,
        state: "free",
        holderInstanceId: null,
        pendingMutationId: null,
        changedAt: at,
        secretHash: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("enforces migration constraints on real isolated SQLite including deferred commit", () => {
    const directory = mkdtempSync(join(tmpdir(), "sprout-lease-test-"));
    try {
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "tests/fixtures/lease-contracts.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: "test",
            DATABASE_URL: join(directory, "contracts.sqlite"),
          },
          encoding: "utf8",
          timeout: 60000,
        },
      );
      expect(child.status, child.stderr || child.stdout).toBe(0);
      expect(child.stdout).toContain("PASS N1/N2");
      expect(child.stdout).toContain("PASS delivery frame FK is deferred until COMMIT");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
