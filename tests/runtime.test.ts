import { beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

type Health = {
  status: number;
  body: {
    ok: boolean;
    ready: boolean;
    phase: string;
    bootId: string | null;
    requestId: string;
    activeBackgroundTasks: number;
    database: { ok: boolean; migrationApplied: boolean };
  };
};
type Evidence = {
  before: Health;
  after: Health;
  unhealthy: Health;
  stopped: Health;
  sameStartup: boolean;
  sameReady: boolean;
  sameShutdown: boolean;
  hostSnapshots: Record<
    "before" | "ready" | "stopping" | "disposed",
    { enabled: boolean; stopping: boolean; active: unknown[] }
  >;
  abortSignals: boolean[];
  snapshot: {
    constructions: number;
    activeResources: number;
    activeBackgroundTasks: number;
    bootId: string;
    history: { phase: string; result: string }[];
  };
  recovered: { phase: string };
  bootCount: number;
  recoveryEvents: number;
  finalBoot: { phase: string; stopped_at: number };
};
let evidence: Evidence;

beforeAll(() => {
  mkdirSync(".verify", { recursive: true });
  const directory = mkdtempSync(resolve(".verify/runtime-test-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      const runtime = await import("./src/server/runtime.ts");
      const { healthResponse } = await import("./src/routes/api/health.ts");
      const { initializeRequestContext } = await import("./src/server/request-context.ts");
      const health = async () => {
        const request = new Request("http://localhost/api/health");
        initializeRequestContext(request);
        const response = healthResponse(request);
        const body = await response.json();
        if (response.headers.get("x-sprout-request-id") !== body.requestId) throw Error("requestId 不一致");
        return { status: response.status, body };
      };
      const before = await health();
      const beforeHost = runtime.piHostSnapshot();
      const beforeAbort = runtime.signalRunAbort("missing");
      if (runtime.runtimeSnapshot().constructions !== 0) throw Error("HTTP 初始化了 runtime");
      const { migrateDatabase } = await import("./src/db/migrate.ts");
      migrateDatabase();
      const { sqlite } = await import("./src/db/index.ts");
      sqlite.prepare("INSERT INTO runtime_boot (id, started_at, phase, pid, app_version) VALUES ('boot_old', 1, 'ready', 2147483647, 'test')").run();
      const first = runtime.startRuntime();
      const second = runtime.startRuntime();
      await first;
      const reloaded = await import("./src/server/runtime.ts?reload=1");
      await reloaded.startRuntime();
      const snapshot = runtime.runtimeSnapshot();
      const recovered = sqlite.prepare("SELECT phase FROM runtime_boot WHERE id = 'boot_old'").get();
      const bootCount = sqlite.prepare("SELECT count(*) AS count FROM runtime_boot").get().count;
      const recoveryEvents = sqlite.prepare("SELECT count(*) AS count FROM diagnostic_event WHERE event = 'runtime.interrupted'").get().count;
      const after = await health();
      const readyHost = reloaded.piHostSnapshot();
      const readyAbort = reloaded.signalRunAbort("missing");
      sqlite.exec("ALTER TABLE __drizzle_migrations RENAME TO migration_probe");
      const unhealthy = await health();
      sqlite.exec("ALTER TABLE migration_probe RENAME TO __drizzle_migrations");
      await Promise.all([runtime.beginRuntimeShutdown("test"), reloaded.beginRuntimeShutdown("test again")]);
      const stoppingHost = runtime.piHostSnapshot();
      const firstShutdown = runtime.shutdownRuntime("test");
      const secondShutdown = reloaded.shutdownRuntime("test again");
      await firstShutdown;
      const { openDatabase } = await import("./src/db/connection.ts");
      const finalConnection = openDatabase(process.env.DATABASE_URL);
      const finalBoot = finalConnection.sqlite.prepare("SELECT phase, stopped_at FROM runtime_boot WHERE id = ?").get(snapshot.bootId);
      finalConnection.sqlite.close();
      console.log("EVIDENCE " + JSON.stringify({ before, after, unhealthy, stopped: await health(), sameStartup: first === second, sameReady: runtime.runtimeReady === reloaded.runtimeReady, sameShutdown: firstShutdown === secondShutdown, hostSnapshots: { before: beforeHost, ready: readyHost, stopping: stoppingHost, disposed: runtime.piHostSnapshot() }, abortSignals: [beforeAbort, readyAbort, runtime.signalRunAbort("missing")], snapshot, recovered, bootCount, recoveryEvents, finalBoot }));
    `,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "runtime.sqlite"),
          BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
          NODE_ENV: "test",
          SPROUT_PI_ENABLED: "true",
        },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    evidence = JSON.parse(
      output
        .split("\n")
        .find((line) => line.startsWith("EVIDENCE "))!
        .slice(9),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 35000);

describe("宿主 runtime 的可观察行为", () => {
  it("入口重复启动和模块重新求值复用同一个 runtime", () => {
    expect(evidence.sameStartup).toBe(true);
    expect(evidence.sameReady).toBe(true);
    expect(evidence.snapshot.constructions).toBe(1);
    expect(evidence.snapshot.activeResources).toBe(1);
    expect(evidence.bootCount).toBe(2);
  });

  it("遗留 ready boot 只恢复一次，并留下诊断", () => {
    expect(evidence.recovered).toEqual({ phase: "interrupted" });
    expect(evidence.recoveryEvents).toBe(1);
  });

  it("health 在入口启动前返回 503，就绪后返回真实数据库检查与 200", () => {
    expect(evidence.before).toMatchObject({
      status: 503,
      body: { ok: false, ready: false, database: { ok: false, migrationApplied: false } },
    });
    expect(evidence.after).toMatchObject({
      status: 200,
      body: {
        ok: true,
        ready: true,
        phase: "ready",
        database: { ok: true, migrationApplied: true },
      },
    });
    expect(evidence.after.body.bootId).toMatch(/^boot_/);
    expect(evidence.after.body.requestId).toMatch(/^req_/);
    expect(evidence.unhealthy).toMatchObject({
      status: 503,
      body: { ok: false, ready: true, database: { ok: false, migrationApplied: false } },
    });
  });

  it("活跃后台任务数由常驻服务导出，不是常量", () => {
    expect(evidence.snapshot.activeBackgroundTasks).toBe(
      evidence.hostSnapshots.ready.active.length,
    );
    expect(evidence.after.body.activeBackgroundTasks).toBe(evidence.snapshot.activeBackgroundTasks);
    expect(evidence.stopped.body.activeBackgroundTasks).toBe(
      evidence.hostSnapshots.disposed.active.length,
    );
  });

  it("关闭幂等，Scope 释放后持久化 stopped 并拒绝健康状态", () => {
    expect(evidence.sameShutdown).toBe(true);
    expect(evidence.hostSnapshots).toEqual({
      before: { enabled: true, stopping: false, active: [] },
      ready: { enabled: true, stopping: false, active: [] },
      stopping: { enabled: true, stopping: true, active: [] },
      disposed: { enabled: true, stopping: false, active: [] },
    });
    expect(evidence.abortSignals).toEqual([false, false, false]);
    expect(evidence.finalBoot.phase).toBe("stopped");
    expect(evidence.finalBoot.stopped_at).toBeGreaterThan(0);
    expect(evidence.stopped).toMatchObject({
      status: 503,
      body: { ok: false, ready: false, phase: "stopped" },
    });
  });
});
