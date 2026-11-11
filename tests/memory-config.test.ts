import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  HINDSIGHT_EXTENSION_VERSION,
  memoryProviderSchema,
  memorySecretsSchema,
  memorySettingsSchema,
  resolveApiUrl,
  resolveBankTarget,
  saveMemoryConfigInput,
  type MemoryInstallStatus,
} from "../src/contracts/memory";
import { openDatabase, type DatabaseConnection } from "../src/db/connection";
import { memoryConfig } from "../src/db/schema";
import {
  assertMemoryConfigHuman,
  loadMemoryConfig,
  resolveEffectiveMemoryState,
  saveMemoryConfig,
} from "../src/domain/memory-config";

let connection: DatabaseConnection | undefined;
afterEach(() => {
  connection?.sqlite.close();
  connection = undefined;
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
      VALUES ('project','Project','human'), ('other-project','Other','other');
  `);
  connection.sqlite.pragma("foreign_keys = ON");
  vi.stubEnv("SPROUT_HINDSIGHT_API_URL", "");
  return connection.db;
}

const draft = {
  projectId: "project",
  provider: "hindsight",
  enabled: true,
  settings: {},
  revision: 0,
};

describe("memory contract", () => {
  it("keeps deployment defaults out of stored settings", () => {
    expect(memoryProviderSchema.parse("hindsight")).toBe("hindsight");
    expect(memoryProviderSchema.safeParse("other").success).toBe(false);
    expect(memorySettingsSchema.parse({})).toEqual({
      apiUrl: "",
      bankPrefix: "sprout",
      bankName: "",
      autoIndexCommits: true,
      refreshPages: true,
    });
    expect(memorySecretsSchema.parse({})).toEqual({ apiToken: "" });
    expect(saveMemoryConfigInput.parse(draft).secrets).toBeUndefined();
  });

  it.each([
    ["", "shared", "bare", "shared"],
    ["sprout", "", "namespaced", "sprout::project"],
    ["sprout", "shared", "namespaced", "sprout::shared"],
    ["team_1", "Team-1.v2", "namespaced", "team_1::Team-1.v2"],
  ])("resolves bank %s / %s", (bankPrefix, bankName, kind, bankId) => {
    expect(resolveBankTarget({ bankPrefix, bankName }, "project")).toEqual({ kind, bankId });
  });

  it.each([
    ["", ""],
    ["sprout::other", "bank"],
    ["sprout", "other::bank"],
    ["BAD", "bank"],
    ["sprout", "bad/name"],
    ["a".repeat(33), "bank"],
    ["sprout", "a".repeat(97)],
    ["a".repeat(32), "b".repeat(95)],
  ])("rejects invalid bank %s / %s", (bankPrefix, bankName) => {
    expect(() => resolveBankTarget({ bankPrefix, bankName }, "project")).toThrow();
    expect(memorySettingsSchema.safeParse({ bankPrefix, bankName }).success).toBe(false);
  });

  it("validates the final bank including a default Project name", () => {
    expect(
      resolveBankTarget({ bankPrefix: "a".repeat(32), bankName: "b".repeat(94) }, "p").bankId,
    ).toHaveLength(128);
    expect(() => resolveBankTarget({ bankPrefix: "sprout", bankName: "" }, "p::other")).toThrow();
    expect(() =>
      resolveBankTarget({ bankPrefix: "a".repeat(32), bankName: "" }, "p".repeat(95)),
    ).toThrow();
  });

  it.each([
    "https://public.example:8888/base",
    "https://8.8.8.8",
    "http://localhost:8888",
    "http://memory.localhost:8888",
    "http://hindsight.local:8888",
    "http://[::1]:8888",
    "http://127.0.0.2:8888",
    "http://10.0.8.130:8888",
    "http://192.168.0.1:8888",
    "http://172.16.0.1:8888",
    "http://172.31.255.254:8888",
    "http://169.254.1.1:8888",
    "http://100.64.0.1:8888",
    "http://100.127.255.254:8888",
  ])("accepts secure or internal address %s", (apiUrl) => {
    expect(resolveApiUrl({ apiUrl: ` ${apiUrl} ` }, {})).toBe(apiUrl);
  });

  it.each([
    "http://public.example:8888",
    "http://8.8.8.8",
    "http://172.15.0.1",
    "http://172.32.0.1",
    "http://100.63.0.1",
    "http://100.128.0.1",
    "http://localhost.evil.example",
    "ftp://127.0.0.1",
    "https://token@public.example",
    "invalid",
  ])("rejects unsafe address %s", (apiUrl) => {
    expect(() => resolveApiUrl({ apiUrl }, {})).toThrow();
    expect(memorySettingsSchema.safeParse({ apiUrl }).success).toBe(false);
  });

  it("resolves explicit URL, deployment URL, then loopback without hiding invalid overrides", () => {
    const env = { SPROUT_HINDSIGHT_API_URL: " http://10.0.8.130:8888 " };
    expect(resolveApiUrl({ apiUrl: " https://explicit.example " }, env)).toBe(
      "https://explicit.example",
    );
    expect(resolveApiUrl({ apiUrl: " " }, env)).toBe("http://10.0.8.130:8888");
    expect(resolveApiUrl({ apiUrl: "" }, {})).toBe("http://127.0.0.1:8888");
    expect(resolveApiUrl({ apiUrl: "" }, { SPROUT_HINDSIGHT_API_URL: " " })).toBe(
      "http://127.0.0.1:8888",
    );
    expect(() =>
      resolveApiUrl({ apiUrl: "" }, { SPROUT_HINDSIGHT_API_URL: "http://public.example" }),
    ).toThrow();
  });
});

describe("Project memory configuration", () => {
  it("redacts saved and loaded tokens, preserves blank tokens, and replaces explicit tokens", () => {
    const db = setup();
    expect(loadMemoryConfig(db, "project", "hindsight")).toBeNull();
    const saved = saveMemoryConfig(
      db,
      { ...draft, secrets: { apiToken: "private-token" } },
      "human",
      1,
    );
    expect(saved).toMatchObject({
      enabled: true,
      hasToken: true,
      revision: 1,
      updatedByHumanId: "human",
    });
    for (const view of [saved, loadMemoryConfig(db, "project", "hindsight")]) {
      expect(JSON.stringify(view)).not.toContain("private-token");
      expect(view).not.toHaveProperty("secrets");
      expect(view).not.toHaveProperty("apiToken");
    }
    let previous = saved;
    for (const secrets of [undefined, {}, { apiToken: "" }, { apiToken: "   " }]) {
      const updated = saveMemoryConfig(
        db,
        { ...draft, revision: previous.revision, secrets },
        "human",
        1,
      );
      expect(db.select().from(memoryConfig).get()?.secrets).toEqual({ apiToken: "private-token" });
      expect(updated.hasToken).toBe(true);
      expect(updated.updatedAtMs).toBeGreaterThan(previous.updatedAtMs);
      previous = updated;
    }
    saveMemoryConfig(
      db,
      { ...draft, revision: previous.revision, secrets: { apiToken: "replacement" } },
      "human",
      1,
    );
    expect(db.select().from(memoryConfig).get()?.secrets).toEqual({ apiToken: "replacement" });
  });

  it("rejects stale creates and updates without changing configuration or secrets", () => {
    const db = setup();
    expect(() => saveMemoryConfig(db, { ...draft, revision: 1 }, "human", 1)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(loadMemoryConfig(db, "project", "hindsight")).toBeNull();
    saveMemoryConfig(db, { ...draft, secrets: { apiToken: "private-token" } }, "human", 1);
    const before = db.select().from(memoryConfig).get();
    expect(() =>
      saveMemoryConfig(
        db,
        { ...draft, enabled: false, secrets: { apiToken: "stale" } },
        "human",
        1,
      ),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(db.select().from(memoryConfig).get()).toEqual(before);
  });

  it("validates before writing and keeps invalid updates atomic", () => {
    const db = setup();
    expect(saveMemoryConfig(db, draft, "human", 1).hasToken).toBe(false);
    const before = db.select().from(memoryConfig).get();
    for (const settings of [
      { bankPrefix: "", bankName: "" },
      { apiUrl: "http://public.example" },
    ]) {
      expect(() => saveMemoryConfig(db, { ...draft, revision: 1, settings }, "human", 1)).toThrow();
      expect(db.select().from(memoryConfig).get()).toEqual(before);
    }
    vi.stubEnv("SPROUT_HINDSIGHT_API_URL", "http://public.example");
    expect(() => saveMemoryConfig(db, { ...draft, revision: 1 }, "human", 1)).toThrow();
    expect(db.select().from(memoryConfig).get()).toEqual(before);
  });

  it("enforces Human ownership and isolates Projects", () => {
    const db = setup();
    assertMemoryConfigHuman({ userId: "human", requestId: "human" });
    expect(() =>
      assertMemoryConfigHuman({
        userId: "human",
        requestId: "agent",
        agent: {},
      } as Parameters<typeof assertMemoryConfigHuman>[0]),
    ).toThrow("只有 Human");
    for (const humanId of ["other", "agent", "missing"]) {
      expect(() => saveMemoryConfig(db, draft, humanId, 1)).toThrow(
        expect.objectContaining({ code: "forbidden" }),
      );
    }
    saveMemoryConfig(db, draft, "human", 1);
    expect(loadMemoryConfig(db, "other-project", "hindsight")).toBeNull();
    expect(
      saveMemoryConfig(db, { ...draft, projectId: "other-project", enabled: false }, "other", 1),
    ).toMatchObject({ enabled: false, hasToken: false, revision: 1 });
    expect(loadMemoryConfig(db, "project", "hindsight")?.enabled).toBe(true);
  });
});

describe("effective memory state", () => {
  const ready = {
    enabled: true,
    configValid: true,
    machineOnline: true,
    install: { status: "ready" as MemoryInstallStatus, version: HINDSIGHT_EXTENSION_VERSION },
  };
  it("gives the hard off switch priority over every unavailable condition", () => {
    expect(
      resolveEffectiveMemoryState({
        ...ready,
        enabled: false,
        configValid: false,
        machineOnline: false,
        install: null,
      }),
    ).toEqual({ state: "disabled" });
  });
  it("checks invalid config before the machine and the machine before installation", () => {
    expect(
      resolveEffectiveMemoryState({
        ...ready,
        configValid: false,
        machineOnline: false,
        install: null,
      }),
    ).toEqual({ state: "unavailable", reason: "invalid_config" });
    expect(resolveEffectiveMemoryState({ ...ready, machineOnline: false, install: null })).toEqual({
      state: "unavailable",
      reason: "machine_offline",
    });
    expect(resolveEffectiveMemoryState({ ...ready, install: null })).toEqual({
      state: "unavailable",
      reason: "not_installed",
    });
  });
  it.each([
    ["missing", "not_installed"],
    ["installing", "installing"],
    ["failed", "install_failed"],
  ] as const)("reports component %s as %s", (status, reason) => {
    expect(
      resolveEffectiveMemoryState({ ...ready, install: { ...ready.install, status } }),
    ).toEqual({ state: "unavailable", reason });
  });
  it("requires the pinned version before ready", () => {
    expect(
      resolveEffectiveMemoryState({ ...ready, install: { status: "ready", version: "0.8.6" } }),
    ).toEqual({ state: "unavailable", reason: "not_installed" });
    expect(resolveEffectiveMemoryState(ready)).toEqual({ state: "ready" });
  });
});
