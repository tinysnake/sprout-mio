import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase, type DatabaseConnection } from "../src/db/connection";

const state = vi.hoisted(() => ({ current: undefined as DatabaseConnection | undefined }));
vi.mock("../src/db", () => ({
  get db() {
    return state.current!.db;
  },
  get sqlite() {
    return state.current!.sqlite;
  },
}));

async function setup() {
  const connection = openDatabase(":memory:");
  connection.sqlite.pragma("foreign_keys = OFF");
  migrate(connection.db, { migrationsFolder: "drizzle" });
  for (const id of ["human", "other-human"])
    connection.sqlite
      .prepare(
        "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
      )
      .run(id, id, `${id}@example.test`);
  connection.sqlite.pragma("foreign_keys = ON");
  connection.sqlite.exec(
    "INSERT INTO project(id,name,created_by) VALUES ('project','Project','human'),('other-project','Other','human')",
  );
  const fixture = {
    ...connection,
    ids: { human: "human", otherHuman: "other-human" },
    dispose: () => connection.sqlite.close(),
  };
  state.current = fixture;
  vi.resetModules();
  const domain = await import("../src/domain/channel-config");
  return { fixture, domain };
}
const appId = "cli_1234567890abcdef";
const draft = {
  projectId: "project",
  kind: "feishu" as const,
  enabled: false,
  revision: 0,
  settings: { origin: "https://open.feishu.cn", appId },
};
let dispose: (() => void) | undefined;
afterEach(() => dispose?.());

describe("Project channel configuration", () => {
  it("creates, updates and enables a config without returning its secret", async () => {
    const { fixture, domain } = await setup();
    dispose = fixture.dispose;
    expect(domain.toChannelConfigView(undefined, draft.projectId)).toMatchObject({
      kind: "feishu",
      enabled: false,
      configured: false,
      revision: 0,
      hasAppSecret: false,
    });
    expect(domain.channelRuntimeConfig(undefined)).toBeNull();
    const saved = domain.saveChannelConfig(
      { ...draft, appSecret: "private-secret" },
      fixture.ids.human,
    );
    expect(saved).toMatchObject({
      configured: true,
      enabled: false,
      revision: 1,
      hasAppSecret: true,
    });
    expect(JSON.stringify(saved)).not.toContain("private-secret");
    expect(saved).not.toHaveProperty("secrets");
    expect(saved).not.toHaveProperty("appSecret");
    expect(
      domain.channelRuntimeConfig(domain.loadChannelConfigRow(draft.projectId, "feishu")),
    ).toBeNull();
    const enabled = domain.saveChannelConfig(
      { ...draft, revision: 1, enabled: true },
      fixture.ids.human,
    );
    expect(enabled).toMatchObject({
      revision: 2,
      configured: true,
      updatedByHumanId: fixture.ids.human,
    });
    expect(
      domain.channelRuntimeConfig(domain.loadChannelConfigRow(draft.projectId, "feishu")),
    ).toEqual({
      enabled: true,
      appId,
      appSecret: "private-secret",
      origin: draft.settings.origin,
    });
    domain.saveChannelConfig(
      { ...draft, revision: 2, appSecret: "replacement" },
      fixture.ids.human,
    );
    expect(domain.loadChannelConfigRow(draft.projectId, "feishu")?.secrets).toEqual({
      appSecret: "replacement",
    });
  });

  it("rejects stale writes and incomplete enabled configs without mutating the row", async () => {
    const { fixture, domain } = await setup();
    dispose = fixture.dispose;
    expect(() => domain.saveChannelConfig({ ...draft, enabled: true }, fixture.ids.human)).toThrow(
      "必填",
    );
    expect(domain.loadChannelConfigRow(draft.projectId, "feishu")).toBeUndefined();
    domain.saveChannelConfig(draft, fixture.ids.human);
    expect(() => domain.saveChannelConfig(draft, fixture.ids.human)).toThrow("已变化");
    expect(() =>
      domain.saveChannelConfig({ ...draft, revision: 1, enabled: true }, fixture.ids.human),
    ).toThrow("必填");
    expect(
      domain.toChannelConfigView(
        domain.loadChannelConfigRow(draft.projectId, "feishu"),
        draft.projectId,
      ),
    ).toMatchObject({ revision: 1, configured: false });
    expect(() =>
      domain.saveChannelConfig(
        {
          ...draft,
          revision: 1,
          enabled: true,
          settings: { ...draft.settings, appId: "" },
          appSecret: "secret",
        },
        fixture.ids.human,
      ),
    ).toThrow("必填");
    expect(domain.loadChannelConfigRow(draft.projectId, "feishu")?.revision).toBe(1);
  });

  it("validates kinds, app ids and secret-bearing origins at the input boundary", async () => {
    const { fixture, domain } = await setup();
    dispose = fixture.dispose;
    const { saveChannelConfigInput } = await import("../src/contracts/channel");
    expect(saveChannelConfigInput.safeParse({ ...draft, kind: "unknown" }).success).toBe(false);
    expect(
      saveChannelConfigInput.safeParse({ ...draft, settings: { ...draft.settings, appId: "bad" } })
        .success,
    ).toBe(false);
    for (const origin of [
      "https://evil.example",
      "https://open.feishu.cn.evil.example",
      "http://open.feishu.cn",
      "http://192.168.1.2",
      "https://open.feishu.cn/",
    ]) {
      expect(
        saveChannelConfigInput.safeParse({ ...draft, settings: { ...draft.settings, origin } })
          .success,
      ).toBe(false);
    }
    for (const origin of [
      "https://open.feishu.cn",
      "https://open.larksuite.com",
      "http://127.0.0.1:9999",
      "http://[::1]:9999",
    ]) {
      expect(
        saveChannelConfigInput.safeParse({ ...draft, settings: { ...draft.settings, origin } })
          .success,
      ).toBe(true);
    }
    expect(() =>
      domain.saveChannelConfig({ ...draft, kind: "unknown" }, fixture.ids.human),
    ).toThrow();
    expect(domain.loadChannelConfigRow(draft.projectId, "feishu")).toBeUndefined();
  });

  it("isolates Project configs, rejects duplicate apps and denies non-Human access", async () => {
    const { fixture, domain } = await setup();
    dispose = fixture.dispose;
    domain.saveChannelConfig({ ...draft, appSecret: "secret" }, "human");
    expect(() =>
      domain.saveChannelConfig({ ...draft, projectId: "other-project" }, "human"),
    ).toThrow("其他 Project");
    expect(domain.loadChannelConfigRow("other-project", "feishu")).toBeUndefined();
    const other = domain.saveChannelConfig(
      {
        ...draft,
        projectId: "other-project",
        settings: { ...draft.settings, appId: "cli_Zz9Xy8Wv7Ut6Sr5Q" },
      },
      "human",
    );
    expect(other.revision).toBe(1);
    expect(domain.loadChannelConfigRow("project", "feishu")?.revision).toBe(1);
    expect(() => domain.saveChannelConfig({ ...draft, revision: 1 }, "other-human")).toThrow();
    expect(() =>
      domain.assertChannelConfigHuman({
        userId: "human",
        requestId: "agent",
        agent: {},
      } as Parameters<typeof domain.assertChannelConfigHuman>[0]),
    ).toThrow("只有 Human");
  });
});
