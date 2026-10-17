import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect";
import { isMainThread, threadId } from "node:worker_threads";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { APP_VERSION } from "../contracts/version";
import type { DatabaseConnection } from "../db/connection";

export type RuntimePhase =
  | "starting"
  | "migrating"
  | "recovering"
  | "ready"
  | "stopping"
  | "stopped";
type PhaseResult = {
  phase: RuntimePhase;
  startedAt: string;
  completedAt?: string;
  result: "running" | "ok" | "failed";
  error?: string;
};

class RuntimeDatabase extends Context.Service<RuntimeDatabase, DatabaseConnection>()(
  "sprout/RuntimeDatabase",
) {}

type RuntimeState = {
  bootId: string | null;
  phase: RuntimePhase;
  history: PhaseResult[];
  moduleEvals: number;
  constructions: number;
  activeResources: number;
  connection: DatabaseConnection | null;
  managed: ManagedRuntime.ManagedRuntime<RuntimeDatabase, never> | null;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: unknown) => void;
  startup: Promise<void> | null;
  shutdown: Promise<void> | null;
  databaseUrl: string | null;
};

const processScope = globalThis as typeof globalThis & { sproutRuntime?: RuntimeState };
function createState(): RuntimeState {
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  return {
    bootId: null,
    phase: "starting",
    history: [],
    moduleEvals: 0,
    constructions: 0,
    activeResources: 0,
    connection: null,
    managed: null,
    ready,
    resolveReady,
    rejectReady,
    startup: null,
    shutdown: null,
    databaseUrl: null,
  };
}
const state = (processScope.sproutRuntime ??= createState());
state.moduleEvals += 1;
console.log(
  "[runtime] module",
  JSON.stringify({
    moduleEvals: state.moduleEvals,
    bootId: state.bootId,
    constructions: state.constructions,
    activeResources: state.activeResources,
    threadId,
  }),
);

export const runtimeReady = state.ready;

export function runtimeSnapshot() {
  return {
    bootId: state.bootId,
    phase: state.phase,
    ready: state.phase === "ready",
    version: APP_VERSION,
    pid: process.pid,
    isMainThread,
    threadId,
    moduleEvals: state.moduleEvals,
    constructions: state.constructions,
    activeResources: state.activeResources,
    activeBackgroundTasks: 0,
    history: state.history.map((entry) => ({ ...entry })),
  };
}

function transition(phase: RuntimePhase) {
  const previous = state.history.at(-1);
  if (previous?.result === "running") {
    previous.result = "ok";
    previous.completedAt = new Date().toISOString();
  }
  state.phase = phase;
  state.history.push({ phase, startedAt: new Date().toISOString(), result: "running" });
  console.log(
    "[runtime] phase",
    JSON.stringify({ phase, bootId: state.bootId, at: state.history.at(-1)?.startedAt }),
  );
}

function failPhase(error: unknown) {
  const current = state.history.at(-1);
  if (current) {
    current.result = "failed";
    current.completedAt = new Date().toISOString();
    current.error = error instanceof Error ? error.message : "未知错误";
  }
  console.error("[runtime] 失败", state.phase, error instanceof Error ? error.message : "未知错误");
}

export function startRuntime(): Promise<void> {
  if (state.startup) return state.startup;
  state.startup = initializeRuntime();
  return state.startup;
}

async function initializeRuntime() {
  transition("starting");
  try {
    const { config } = await import("../lib/config");
    state.databaseUrl = config.DATABASE_URL;
    await import("../lib/auth");
    transition("migrating");
    const { migrateDatabase } = await import("../db/migrate");
    migrateDatabase();
    const connection = await import("../db");
    const layer = Layer.effect(
      RuntimeDatabase,
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        state.activeResources += 1;
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            connection.sqlite.close();
            state.activeResources -= 1;
            console.log(
              "[runtime] scope-disposed",
              JSON.stringify({ bootId: state.bootId, activeResources: state.activeResources }),
            );
          }),
        );
        return { sqlite: connection.sqlite, db: connection.db };
      }),
    );
    state.managed = ManagedRuntime.make(layer);
    state.constructions += 1;
    state.connection = await state.managed.runPromise(RuntimeDatabase);
    transition("recovering");
    const { recordDiagnostic } = await import("./diagnostics");
    const requestId = newId(ID_PREFIXES.request);
    const sqlite = state.connection.sqlite;
    const bootId = newId(ID_PREFIXES.boot);
    sqlite.transaction(() => {
      const interrupted = sqlite
        .prepare(
          "SELECT id, phase, pid FROM runtime_boot WHERE phase IN ('starting', 'ready', 'stopping')",
        )
        .all() as { id: string; phase: string; pid: number }[];
      for (const old of interrupted) {
        sqlite.prepare("UPDATE runtime_boot SET phase = 'interrupted' WHERE id = ?").run(old.id);
        if (
          !recordDiagnostic({
            level: "warn",
            event: "runtime.interrupted",
            requestId,
            message: "恢复上次未正常关闭的 runtime",
            data: { bootId: old.id, previousPhase: old.phase, pid: old.pid },
          })
        ) {
          throw new Error("恢复诊断写入失败");
        }
      }
      sqlite
        .prepare(
          "INSERT INTO runtime_boot (id, started_at, phase, pid, app_version) VALUES (?, unixepoch(), 'starting', ?, ?)",
        )
        .run(bootId, process.pid, APP_VERSION);
    })();
    state.bootId = bootId;
    sqlite.prepare("UPDATE runtime_boot SET phase = 'ready' WHERE id = ?").run(bootId);
    transition("ready");
    recordDiagnostic({
      level: "info",
      event: "runtime.ready",
      requestId,
      message: "runtime 已就绪",
      data: { bootId, pid: process.pid, history: runtimeSnapshot().history },
    });
    state.resolveReady();
  } catch (error) {
    failPhase(error);
    state.rejectReady(error);
    await state.managed?.dispose();
    throw error;
  }
}

export function databaseHealth(): { ok: boolean; migrationApplied: boolean } {
  try {
    const sqlite = state.connection?.sqlite;
    if (!sqlite?.open) return { ok: false, migrationApplied: false };
    const probe = sqlite.prepare("SELECT 1 AS ok").get() as { ok: number };
    const migration = sqlite
      .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
      .get() as { count: number };
    return { ok: probe.ok === 1, migrationApplied: migration.count > 0 };
  } catch {
    return { ok: false, migrationApplied: false };
  }
}

export function shutdownRuntime(reason: string): Promise<void> {
  if (state.shutdown) return state.shutdown;
  state.shutdown = stopRuntime(reason);
  return state.shutdown;
}

async function stopRuntime(reason: string) {
  await state.startup;
  transition("stopping");
  try {
    state.connection?.sqlite
      .prepare("UPDATE runtime_boot SET phase = 'stopping' WHERE id = ?")
      .run(state.bootId);
    console.log("[runtime] shutdown", JSON.stringify({ reason, bootId: state.bootId }));
    await state.managed?.dispose();
    if (state.bootId && state.databaseUrl) {
      const { openDatabase } = await import("../db/connection");
      const { sqlite } = openDatabase(state.databaseUrl);
      try {
        sqlite
          .prepare(
            "UPDATE runtime_boot SET phase = 'stopped', stopped_at = unixepoch() WHERE id = ?",
          )
          .run(state.bootId);
      } finally {
        sqlite.close();
      }
    }
    transition("stopped");
    const current = state.history.at(-1)!;
    current.completedAt = new Date().toISOString();
    current.result = "ok";
  } catch (error) {
    failPhase(error);
    throw error;
  }
}
