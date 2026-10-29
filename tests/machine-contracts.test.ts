import { describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMachineInput,
  machineDetailSchema,
  macosAbsolutePathSchema,
  positiveSafeIntegerSchema,
  saveMachineRootDirectoryInput,
  projectWorkingPath,
  saveProjectMachineBindingInput,
} from "../src/contracts/machine";
import { ID_PREFIXES, newId } from "../src/contracts/ids";
import * as humanContracts from "../src/contracts";
import { workerExchangeInput, workerExchangeResponseSchema } from "../src/contracts/worker";

const machineId = newId(ID_PREFIXES.machine);
const projectId = newId(ID_PREFIXES.project);
const capability = {
  platform: "darwin",
  arch: "arm64",
  workerVersion: "0.1.0",
  shells: [],
  remoteOperations: ["file_read"],
  mcpRelay: { version: 1, transports: ["stdio"], maxMessageBytes: 131072 },
};
const session = {
  machineId,
  generation: 1,
  bootId: newId(ID_PREFIXES.boot),
  attemptId: crypto.randomUUID(),
};
const fact = {
  machineId,
  generation: 1,
  projectId,
  bindingRevision: 1,
  revision: 1,
  seq: 1,
  checkedAt: "2026-01-01T00:00:00Z",
  result: { kind: "accessible", realPath: "/tmp" },
};
const exchange = {
  version: 3,
  requestId: newId(ID_PREFIXES.request),
  secret: "a".repeat(43),
  mode: "normal",
  session,
  seq: 1,
  capability,
  observations: [fact],
  remote: { results: [], fenceAcks: [], mcp: [], mcpCursors: [] },
};

describe("Machine public and wire boundaries", () => {
  it("normalizes names and rejects paths and revisions that cannot be persisted", () => {
    expect(createMachineInput.parse({ name: " Mac " })).toEqual({ name: "Mac" });
    for (const name of [" ", "x".repeat(81)])
      expect(createMachineInput.safeParse({ name }).success).toBe(false);
    for (const path of ["~/work", "$HOME/work", "relative", "/ok\0bad", "/" + "a".repeat(4096)])
      expect(macosAbsolutePathSchema.safeParse(path).success).toBe(false);
    expect(
      saveMachineRootDirectoryInput.parse({
        machineId,
        directory: null,
        expectedRevision: null,
      }).directory,
    ).toBeNull();
    expect(projectWorkingPath("/tmp/root", projectId)).toBe(`/tmp/root/${projectId}`);
    expect(
      saveProjectMachineBindingInput.safeParse({
        machineId,
        projectId,
        description: "",
        directory: null,
        expectedRevision: null,
      }).success,
    ).toBe(false);
    for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(positiveSafeIntegerSchema.safeParse(value).success).toBe(false);
  });

  it("Human detail accepts historical facts and rejects private identity fields", () => {
    const detail = {
      enrollmentStatus: "active",
      machine: {
        id: machineId,
        name: "Mac",
        rootDirectory: null,
        rootRevision: 1,
        createdBy: "owner",
        createdAt: fact.checkedAt,
        updatedAt: fact.checkedAt,
      },
      connection: {
        kind: "offline",
        generation: 1,
        lastSeenAt: fact.checkedAt,
        reason: "host_restarted",
      },
      capability: { generation: 1, current: false, snapshot: capability },
      bindings: [
        {
          intent: { projectId, machineId, description: "", revision: 2 },
          observation: { current: false, fact },
        },
      ],
    };
    expect(machineDetailSchema.parse(detail)).toEqual(detail);
    expect(
      machineDetailSchema.parse({ ...detail, enrollmentStatus: "pending" }).enrollmentStatus,
    ).toBe("pending");
    expect(machineDetailSchema.safeParse({ ...detail, enrollmentStatus: "revoked" }).success).toBe(
      false,
    );
    expect(machineDetailSchema.safeParse({ ...detail, secretHash: "private" }).success).toBe(false);
    expect(
      machineDetailSchema.safeParse({
        ...detail,
        machine: { ...detail.machine, secret: "private" },
      }).success,
    ).toBe(false);
    expect(humanContracts).not.toHaveProperty("workerSecretSchema");
    expect(humanContracts).not.toHaveProperty("workerExchangeInput");
  });

  it("wire binds observations to the envelope and rejects unsupported or contradictory payloads", () => {
    expect(workerExchangeInput.parse(exchange)).toEqual(exchange);
    for (const change of [
      { version: 1 },
      { seq: 2 },
      { session: { ...session, generation: 2 } },
      { observations: [fact, fact] },
      { capability: { ...capability, remoteOperations: "not_implemented" } },
      { secret: "short" },
      { mode: "drain", capability },
      { remote: { results: [{}], fenceAcks: [] } },
    ])
      expect(workerExchangeInput.safeParse({ ...exchange, ...change }).success).toBe(false);
    const data = {
      mode: "normal",
      session,
      seq: 1,
      configuration: { root: null, rootRevision: 1, bindings: [] },
      remote: {
        authorizations: [],
        commands: [],
        fences: [],
        resultAcks: [],
        fenceAcks: [],
        mcp: [],
        mcpCursors: [],
      },
    };
    expect(
      workerExchangeResponseSchema.safeParse({
        version: 3,
        requestId: exchange.requestId,
        ok: true,
        data,
      }).success,
    ).toBe(true);
    expect(
      workerExchangeResponseSchema.safeParse({
        version: 3,
        requestId: exchange.requestId,
        ok: true,
        data,
        error: { code: "internal", message: "bad" },
      }).success,
    ).toBe(false);
    expect(
      workerExchangeResponseSchema.safeParse({
        version: 1,
        requestId: exchange.requestId,
        ok: true,
        data,
      }).success,
    ).toBe(false);
    for (const contradiction of [
      { ...data, configuration: null },
      { ...data, mode: "drain" },
      { ...data, remote: { ...data.remote, commands: [{ machineId }] } },
    ])
      expect(
        workerExchangeResponseSchema.safeParse({
          version: 3,
          requestId: exchange.requestId,
          ok: true,
          data: contradiction,
        }).success,
      ).toBe(false);
  });

  it.each(["identity", "history", "checks"])(
    "SQLite migrations protect %s invariants through direct SQL",
    (scenario) => {
      const directory = mkdtempSync(join(tmpdir(), "sprout-machine-contracts-"));
      try {
        const output = execFileSync(
          process.execPath,
          ["--import", "tsx", "tests/fixtures/machine-contracts.ts", scenario],
          {
            env: {
              ...process.env,
              DATABASE_URL: join(directory, "contracts.sqlite"),
              NODE_ENV: "test",
            },
            encoding: "utf8",
            timeout: 30000,
          },
        );
        expect(output).toContain(`PASS machine contracts SQLite ${scenario}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
