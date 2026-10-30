import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Fiber } from "effect";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import {
  WORKER_PROTOCOL_VERSION,
  workerExchangeInput,
  workerOpenInput,
  workerCloseInput,
} from "../../src/contracts/worker";
import { migrateDatabase } from "../../src/db/migrate";
import { sqlite } from "../../src/db";
import { createProject } from "../../src/domain/project";
import {
  createMachine,
  saveMachineRootDirectory,
  saveProjectMachineBinding,
  getMachine,
} from "../../src/domain/machine";
import { detachMachine, rejoinProjectMachine } from "../../src/server/membership";
import {
  enrollWorker,
  openWorker,
  exchangeWorker,
  closeWorker,
} from "../../src/server/worker-gateway";
import { workerProgram } from "../../src/worker/client";

assert(
  process.env.DATABASE_URL,
  "run with DATABASE_URL pointing to an isolated temporary database",
);
migrateDatabase();
const directory = mkdtempSync(join(tmpdir(), "p4d-r2-directory-"));
const root = join(directory, "root");
const userId = "r2-directory-owner";
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'r2')",
  )
  .run(bootId);
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(userId, userId, `${userId}@example.test`);
const human = () => ({ userId, bootId, requestId: newId(ID_PREFIXES.request), now: new Date() });
const requestId = () => newId(ID_PREFIXES.request);
const projectId = createProject({ name: "directory recovery" }, human()).id;
const created = createMachine({ name: "directory recovery" }, human());
const machineId = created.detail.machine.id;
const key = { projectId, machineId };
mkdirSync(join(root, projectId), { recursive: true });
saveMachineRootDirectory({ machineId, expectedRevision: 1, directory: root }, human());
saveProjectMachineBinding({ ...key, description: "first", expectedRevision: null }, human());
const identity = {
  version: 1 as const,
  server: "http://r2.invalid",
  allowHttpOrigins: ["http://r2.invalid"],
  machineId,
  secret: "r".repeat(43),
};
enrollWorker(
  {
    version: WORKER_PROTOCOL_VERSION,
    requestId: requestId(),
    machineId,
    secret: identity.secret,
    ticket: created.ticket,
  },
  human(),
);
const originalFetch = globalThis.fetch;
const events: object[] = [];
let phase = 0;
let captured: any;
let failure: unknown;
let done: (() => void) | undefined;
const completion = new Promise<void>((resolve) => {
  done = resolve;
});
const current = () => getMachine({ machineId, projectId }, human()).bindings[0]!.observation;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  assert(typeof url === "string");
  assert(typeof init?.body === "string");
  const operation = url.split("/").at(-1)!;
  const input = JSON.parse(init.body);
  try {
    if (operation === "exchange" && input.mode === "normal" && input.observations.length > 0) {
      if (phase === 1) {
        saveProjectMachineBinding(
          { ...key, description: "changed while probing", expectedRevision: 1 },
          human(),
        );
        assert.equal(current(), null);
        phase = 2;
      } else if (phase === 3) {
        const removed = detachMachine(
          {
            ...key,
            requestId: requestId(),
            expectedEpoch: 1,
            expectedRevision: 2,
            expectedGeneration: 0,
            confirm: true,
          },
          human(),
        );
        assert.equal(removed.state, "removed");
        assert.equal(current(), null);
        assert.throws(
          () => exchangeWorker({ ...input, requestId: requestId() }, human()),
          (error: any) => error.code === "conflict",
        );
        rejoinProjectMachine(
          { ...key, requestId: requestId(), expectedEpoch: 1, expectedRevision: 2, confirm: true },
          human(),
        );
        assert.equal(current(), null);
        // A committed pre-removal frame can be replayed, but cannot reinsert its observation.
        exchangeWorker(captured, human());
        assert.equal(current(), null);
        phase = 4;
      } else if (phase === 5) {
        openWorker(
          {
            version: WORKER_PROTOCOL_VERSION,
            requestId: requestId(),
            machineId,
            secret: identity.secret,
            attemptId: randomUUID(),
          },
          human(),
        );
        phase = 6;
      }
    }
    const data =
      operation === "open"
        ? openWorker(workerOpenInput.parse(input), human())
        : operation === "close"
          ? closeWorker(workerCloseInput.parse(input), human())
          : exchangeWorker(workerExchangeInput.parse(input), human());
    events.push({
      operation,
      mode: input.mode,
      generation: input.session?.generation,
      seq: input.seq,
      phase,
      ok: true,
    });
    if (operation === "exchange" && input.mode === "normal" && input.observations.length > 0) {
      const observation = current();
      assert.equal(observation?.current, true);
      assert.equal(observation?.fact.result.kind, "accessible");
      assert.equal(observation?.fact.generation, input.session.generation);
      if (phase === 0) {
        captured = structuredClone(input);
        phase = 1;
      } else if (phase === 2) {
        assert.equal(observation?.fact.bindingRevision, 2);
        captured = structuredClone(input);
        phase = 3;
      } else if (phase === 4) {
        assert.equal(observation?.fact.bindingRevision, 3);
        phase = 5;
      } else if (phase === 6) {
        phase = 7;
        done!();
      }
    }
    return Response.json({
      version: WORKER_PROTOCOL_VERSION,
      requestId: input.requestId,
      ok: true,
      data: operation === "open" ? { ...data, pollIntervalMs: 50 } : data,
    });
  } catch (error: any) {
    if (!error.code) {
      failure = error;
      done!();
    }
    const code = error.code ?? "internal";
    events.push({
      operation,
      mode: input.mode,
      generation: input.session?.generation,
      seq: input.seq,
      phase,
      ok: false,
      code,
    });
    return Response.json(
      {
        version: WORKER_PROTOCOL_VERSION,
        requestId: input.requestId,
        ok: false,
        error: { code, message: code },
      },
      { status: 400 },
    );
  }
}) as typeof fetch;
const fiber = Effect.runFork(workerProgram(identity, [], join(directory, "state")));
let deadline: ReturnType<typeof setTimeout>;
try {
  await Promise.race([
    completion,
    new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`recovery timeout phase=${phase}`)), 30000);
    }),
    Effect.runPromise(Fiber.join(fiber)).then(() => {
      throw new Error("Worker exited before recovery");
    }),
  ]);
  if (failure) throw failure;
  assert.equal(phase, 7);
  assert(events.filter((e: any) => !e.ok && e.code === "conflict").length >= 2);
  assert(events.some((e: any) => !e.ok && e.code === "superseded"));
  assert(events.filter((e: any) => e.operation === "open" && e.ok).length >= 4);
  console.log(
    JSON.stringify({
      verdict: "PASS",
      scenarios: [
        "binding CAS conflict recovery",
        "removed/rejoin same-root identity",
        "cached-frame replay cannot restore facts",
        "connection supersession recovery",
      ],
      events,
    }),
  );
} finally {
  clearTimeout(deadline!);
  await Effect.runPromise(Fiber.interrupt(fiber));
  globalThis.fetch = originalFetch;
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
}
