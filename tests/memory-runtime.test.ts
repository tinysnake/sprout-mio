import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  filterMemorySkillPaths,
  HINDSIGHT_EXTENSION_VERSION,
  memoryExtensionConfig,
  memorySnapshotSchema,
  type MemoryRuntime,
} from "../src/contracts/memory";
import { openDatabase, type DatabaseConnection } from "../src/db/connection";
import { resolveMemoryRuntime } from "../src/server/memory-runtime";

let connection: DatabaseConnection;
let dataDir: string;
afterEach(() => {
  connection?.sqlite.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  connection = openDatabase(":memory:");
  connection.sqlite.pragma("foreign_keys = OFF");
  migrate(connection.db, { migrationsFolder: "drizzle" });
  connection.sqlite.exec(`
    INSERT INTO user(id,name,email,email_verified,created_at,updated_at)
      VALUES ('human','Human','memory-runtime@example.test',0,1,1);
    INSERT INTO project(id,name,created_by) VALUES ('project','Project','human');
    INSERT INTO machine(id,name,created_by,created_at,updated_at)
      VALUES ('machine','Machine','human',1,1);
  `);
  connection.sqlite.pragma("foreign_keys = ON");
  dataDir = mkdtempSync(join(tmpdir(), "memory-runtime-"));
  return {
    db: connection.db,
    projectId: "project",
    dataDir,
    env: {},
  };
}
function install(status = "ready", version = HINDSIGHT_EXTENSION_VERSION) {
  connection.sqlite
    .prepare(`INSERT INTO memory_install(component,status,version,updated_at_ms)
    VALUES ('hindsight-extension',?,?,1)`)
    .run(status, version);
}
function configure(enabled: boolean, settings = "{}", secrets = "{}") {
  connection.sqlite
    .prepare(`INSERT INTO memory_config(project_id,provider,enabled,settings,secrets,revision,updated_at_ms)
    VALUES ('project','hindsight',?,?,?,0,1)`)
    .run(Number(enabled), settings, secrets);
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

describe("memory runtime resolver", () => {
  it("honours the off switch even with broken config", () => {
    const input = setup();
    configure(false, '{"apiUrl":"invalid"}');
    expect(resolveMemoryRuntime(input)).toEqual({ state: "disabled" });
  });
  it("uses shared defaults and requires a real bundle file", () => {
    const input = setup();
    install();
    expect(resolveMemoryRuntime(input)).toEqual({ state: "unavailable", reason: "not_installed" });
    const bundlePath = bundle();
    expect(resolveMemoryRuntime(input)).toEqual({
      state: "ready",
      apiUrl: "http://127.0.0.1:8888",
      bank: "sprout::project",
      apiToken: "",
      bundlePath,
    });
    rmSync(bundlePath);
    mkdirSync(bundlePath);
    expect(resolveMemoryRuntime(input)).toEqual({ state: "unavailable", reason: "not_installed" });
  });
  it("resolves the URL override, explicit bank and private token through the existing helpers", () => {
    const input = setup();
    install();
    const bundlePath = bundle();
    configure(
      true,
      JSON.stringify({ bankPrefix: "", bankName: "shared" }),
      JSON.stringify({ apiToken: "private-token" }),
    );
    expect(
      resolveMemoryRuntime({
        ...input,
        env: { SPROUT_HINDSIGHT_API_URL: "https://memory.example.test" },
      }),
    ).toEqual({
      state: "ready",
      apiUrl: "https://memory.example.test",
      bank: "shared",
      apiToken: "private-token",
      bundlePath,
    });
  });
  it("reports invalid stored config before reachability", () => {
    const input = setup();
    configure(true, '{"apiUrl":"http://public.example.test"}');
    expect(resolveMemoryRuntime(input)).toEqual({
      state: "unavailable",
      reason: "invalid_config",
    });
  });
  it.each([
    { status: undefined, reason: "not_installed" },
    { status: "missing", reason: "not_installed" },
    { status: "installing", reason: "installing" },
    { status: "failed", reason: "install_failed" },
    { status: "ready", version: "old", reason: "not_installed" },
  ])(
    "preserves the existing state precedence: $status / $version",
    ({ status, version, reason }) => {
      const input = setup();
      if (status) install(status, version);
      expect(resolveMemoryRuntime(input)).toEqual({ state: "unavailable", reason });
    },
  );
  it("uses the local install without a Machine binding", () => {
    const input = setup();
    install();
    bundle();
    expect(resolveMemoryRuntime(input)).toMatchObject({ state: "ready" });
  });
});

const ready: Extract<MemoryRuntime, { state: "ready" }> = {
  state: "ready",
  apiUrl: "https://memory.example.test",
  bank: "sprout::project",
  apiToken: "private-token",
  bundlePath: "/private/pi.js",
};
describe("memory boundary helpers", () => {
  const paths = [
    "/home/skills/hindsight-coding-agent/SKILL.md",
    "/home/skills/hindsight-coding-agent",
    "C:\\skills\\hindsight-coding-agent\\SKILL.md",
    "/home/skills/ordinary/SKILL.md",
    "/home/skills/hindsight-coding-agent-extra/SKILL.md",
  ];
  it.each(["disabled", "unavailable"] as const)(
    "filters only the companion skill for %s",
    (state) => {
      expect(filterMemorySkillPaths(paths, state)).toEqual(paths.slice(3));
      expect(paths).toHaveLength(5);
    },
  );
  it("keeps every inherited path when ready", () => {
    expect(filterMemorySkillPaths(paths, "ready")).toEqual(paths);
  });
  it("writes only the frozen config fields, leaving autoInject at its package default", () => {
    expect(JSON.parse(JSON.stringify(memoryExtensionConfig(ready)))).toEqual({
      serverMode: "self-hosted",
      apiUrl: ready.apiUrl,
      bankId: ready.bank,
      dynamicBankId: false,
      autoUpdate: false,
      autoSeed: false,
    });
  });
  it("strips execution-only credentials and paths from snapshots", () => {
    expect(memorySnapshotSchema.parse(ready)).toEqual({ state: "ready", bank: ready.bank });
    expect(
      memorySnapshotSchema.parse({
        ...ready,
        state: "unavailable",
        reason: "extension_load_failed",
      }),
    ).toEqual({ state: "unavailable", bank: ready.bank, reason: "extension_load_failed" });
  });
});
