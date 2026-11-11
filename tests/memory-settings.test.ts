import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { HINDSIGHT_EXTENSION_VERSION, memoryDefaults } from "../src/contracts/memory";
import { openDatabase, type DatabaseConnection } from "../src/db/connection";
import { memoryConfig } from "../src/db/schema";
import { saveMemoryConfig } from "../src/domain/memory-config";
import { readMemoryInstall } from "../src/server/memory-install";
import {
  getMemorySettings,
  provisionEnabledMemories,
  saveMemorySettings,
  type MemorySettingsDependencies,
} from "../src/server/memory-settings";

let connection: DatabaseConnection;
let dataDir: string;
afterEach(() => {
  connection?.sqlite.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function setup() {
  connection = openDatabase(":memory:");
  connection.sqlite.pragma("foreign_keys = OFF");
  migrate(connection.db, { migrationsFolder: "drizzle" });
  connection.sqlite.exec(`
    INSERT INTO user(id,name,email,email_verified,created_at,updated_at)
      VALUES ('human','Human','human@example.test',0,1,1),
             ('other','Other','other@example.test',0,1,1);
    INSERT INTO project(id,name,created_by)
      VALUES ('project','Project','human'), ('second','Second','human'),
             ('disabled','Disabled','human');
    INSERT INTO machine(id,name,created_by,created_at,updated_at)
      VALUES ('machine','Machine','human',1,1);
  `);
  connection.sqlite.pragma("foreign_keys = ON");
  dataDir = mkdtempSync(join(tmpdir(), "memory-settings-"));
  vi.stubEnv("SPROUT_HINDSIGHT_API_URL", "");
  const provision = vi.fn<MemorySettingsDependencies["provision"]>();
  const deps: MemorySettingsDependencies = {
    db: connection.db,
    machineId: "machine",
    dataDir,
    now: () => 100,
    provision,
  };
  return { deps, provision };
}
const context = { userId: "human", requestId: "req_memory" };
const draft = {
  projectId: "project",
  provider: "hindsight",
  enabled: true,
  settings: {},
  revision: 0,
};
function status(value: "installing" | "failed" | "ready", error: string | null = null) {
  connection.sqlite
    .prepare(`INSERT INTO memory_install(machine_id,component,status,version,error,updated_at_ms)
      VALUES ('machine','hindsight-extension',?,?,?,100)
      ON CONFLICT(machine_id,component) DO UPDATE SET status=excluded.status,error=excluded.error`)
    .run(value, HINDSIGHT_EXTENSION_VERSION, error);
}
function bundle() {
  const path = join(
    dataDir,
    "extensions",
    "hindsight",
    HINDSIGHT_EXTENSION_VERSION,
    "package/dist/pi.js",
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "export default () => {};\n");
  return path;
}

// The fake models the installer's public status-before-await / status-before-reject contract.
describe("memory settings", () => {
  it("returns defaults without creating a row and explains an unbound Machine", () => {
    const { deps } = setup();
    const view = getMemorySettings({ ...deps, machineId: null }, "project");
    expect(view).toMatchObject({
      config: null,
      defaults: memoryDefaults,
      extensionVersion: HINDSIGHT_EXTENSION_VERSION,
      bankPreview: { kind: "namespaced", bankId: "sprout::project" },
      machineId: null,
      install: null,
      effectiveState: { state: "unavailable", reason: "machine_offline" },
    });
    expect(view.message).toContain("SPROUT_PI_MACHINE_ID");
    expect(deps.db.select().from(memoryConfig).all()).toEqual([]);
    expect(getMemorySettings(deps, "project").effectiveState).toEqual({
      state: "unavailable",
      reason: "not_installed",
    });
  });

  it("masks tokens even when ready and resolves explicit banks", () => {
    const { deps } = setup();
    saveMemoryConfig(
      deps.db,
      {
        ...draft,
        settings: { bankPrefix: "", bankName: "shared" },
        secrets: { apiToken: "private-memory-token" },
      },
      "human",
      1,
    );
    status("ready");
    const path = bundle();
    const view = getMemorySettings(deps, "project");
    expect(view.config).toMatchObject({ hasToken: true, revision: 1 });
    expect(view.bankPreview).toEqual({ kind: "bare", bankId: "shared" });
    expect(view.effectiveState).toEqual({ state: "ready", bank: "shared" });
    expect(view.install).toEqual({
      status: "ready",
      version: HINDSIGHT_EXTENSION_VERSION,
      error: null,
    });
    expect(JSON.stringify(view)).not.toMatch(/private-memory-token|apiToken|secrets|bundlePath/);
    rmSync(path);
    expect(getMemorySettings(deps, "project").effectiveState).toEqual({
      state: "unavailable",
      reason: "not_installed",
    });
  });

  it("preserves blank tokens, increments revision and leaves stale writes untouched", () => {
    const { deps, provision } = setup();
    const input = {
      ...draft,
      enabled: false,
      settings: {
        apiUrl: "https://memory.example.test",
        bankPrefix: "team",
        bankName: "shared",
        autoIndexCommits: false,
        refreshPages: false,
      },
      secrets: { apiToken: "private-token" },
    };
    expect(saveMemorySettings(deps, input, context).config).toMatchObject({
      revision: 1,
      hasToken: true,
    });
    expect(
      saveMemorySettings(deps, { ...input, revision: 1, secrets: { apiToken: "  " } }, context)
        .config,
    ).toMatchObject({ revision: 2, hasToken: true });
    const before = deps.db.select().from(memoryConfig).get();
    expect(before?.secrets).toEqual({ apiToken: "private-token" });
    expect(getMemorySettings(deps, "project").config?.settings).toEqual(input.settings);
    expect(() => saveMemorySettings(deps, { ...input, enabled: true }, context)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(deps.db.select().from(memoryConfig).get()).toEqual(before);
    expect(provision).not.toHaveBeenCalled();
    expect(getMemorySettings(deps, "project").effectiveState).toEqual({ state: "disabled" });
  });

  it("rejects Agents and other Humans before writing or provisioning", () => {
    const { deps, provision } = setup();
    expect(() =>
      saveMemorySettings(deps, draft, {
        ...context,
        agent: { runId: "run", instanceId: "instance", agentProfileId: "profile" },
      }),
    ).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => saveMemorySettings(deps, draft, { ...context, userId: "other" })).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(deps.db.select().from(memoryConfig).all()).toEqual([]);
    expect(provision).not.toHaveBeenCalled();
  });

  it("starts exactly one installation synchronously without waiting for its completion", async () => {
    const { deps, provision } = setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    provision.mockImplementation(() => {
      status("installing");
      return pending;
    });
    const view = saveMemorySettings(deps, draft, context);
    expect(view.effectiveState).toEqual({ state: "unavailable", reason: "installing" });
    expect(view.install?.status).toBe("installing");
    expect(provision).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        db: deps.db,
        machineId: "machine",
        dataDir,
        now: deps.now,
      }),
    );
    finish();
    await pending;
  });

  it.each([false, true])("does not install with enabled=%s when no Machine is bound", (enabled) => {
    const { deps, provision } = setup();
    const view = saveMemorySettings({ ...deps, machineId: null }, { ...draft, enabled }, context);
    expect(view.effectiveState).toEqual(
      enabled ? { state: "unavailable", reason: "machine_offline" } : { state: "disabled" },
    );
    expect(provision).not.toHaveBeenCalled();
  });

  it("keeps the save and exposes failed installation after a rejected provision", async () => {
    const { deps, provision } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, rejectPromise) => {
      reject = rejectPromise;
    });
    provision.mockImplementation(() => {
      status("installing");
      return pending;
    });
    const saved = saveMemorySettings(deps, draft, context);
    status("failed", "download failed");
    reject(new Error("download failed"));
    await pending.catch(() => {});
    const view = getMemorySettings(deps, "project");
    expect(view.config).toEqual(saved.config);
    expect(view.install).toMatchObject({ status: "failed", error: "download failed" });
    expect(view.effectiveState).toEqual({ state: "unavailable", reason: "install_failed" });
  });

  it("sweeps enabled Projects, skips missing Machines, shares installation and is idempotent", async () => {
    const { deps, provision } = setup();
    saveMemoryConfig(deps.db, { ...draft, projectId: "disabled", enabled: false }, "human", 1);
    provision.mockImplementation(async () => {
      status("ready");
      bundle();
    });
    await provisionEnabledMemories(deps);
    expect(provision).not.toHaveBeenCalled();
    for (const projectId of ["project", "second"])
      saveMemoryConfig(deps.db, { ...draft, projectId }, "human", 1);
    await provisionEnabledMemories({ ...deps, machineId: null });
    expect(provision).not.toHaveBeenCalled();
    await provisionEnabledMemories(deps);
    await provisionEnabledMemories(deps);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(getMemorySettings(deps, "disabled").effectiveState).toEqual({ state: "disabled" });
  });

  it("continues the boot sweep after one Project's rejected provision", async () => {
    const { deps, provision } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const projectId of ["project", "second"])
      saveMemoryConfig(deps.db, { ...draft, projectId }, "human", 1);
    provision
      .mockImplementationOnce(async () => {
        status("failed", "offline");
        throw new Error("offline");
      })
      .mockImplementationOnce(async () => {
        status("ready");
        bundle();
      });
    await expect(provisionEnabledMemories(deps)).resolves.toBeUndefined();
    expect(provision).toHaveBeenCalledTimes(2);
    expect(readMemoryInstall(deps.db, "machine")?.status).toBe("ready");
  });
});
