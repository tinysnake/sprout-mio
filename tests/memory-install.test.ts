import { afterEach, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  HINDSIGHT_EXTENSION_INTEGRITY,
  HINDSIGHT_EXTENSION_VERSION,
} from "../src/contracts/memory";
import { openDatabase, type DatabaseConnection } from "../src/db/connection";
import {
  MemoryInstallError,
  provisionMemoryExtension,
  readMemoryInstall,
  type MemoryFetch,
} from "../src/server/memory-install";

let connection: DatabaseConnection | undefined;
let dataDir: string | undefined;

afterEach(() => {
  connection?.sqlite.close();
  connection = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

/** 用系统 tar 打包一个最小扩展 fixture；内容仍是子进程，与被验安装路径一致。 */
function buildFixture(options: { includePi?: boolean; version?: string } = {}): {
  tarball: Buffer;
  integrity: string;
} {
  const root = mkdtempSync(join(tmpdir(), "memory-install-fixture-"));
  try {
    mkdirSync(join(root, "package", "dist"), { recursive: true });
    writeFileSync(
      join(root, "package", "package.json"),
      JSON.stringify({
        name: "@vectorize-io/hindsight-coding-agents",
        version: options.version ?? HINDSIGHT_EXTENSION_VERSION,
      }),
    );
    if (options.includePi !== false)
      writeFileSync(join(root, "package", "dist", "pi.js"), "export default {};\n");
    const archive = join(root, "fixture.tgz");
    execFileSync("tar", ["-czf", archive, "package"], { cwd: root });
    const tarball = readFileSync(archive);
    return {
      tarball,
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 把 tarball 包成响应体；Buffer 的 ArrayBufferLike 泛型不能直接当 BodyInit。 */
function responseOf(tarball: Buffer): Response {
  return new Response(Uint8Array.from(tarball));
}

/** 迁移好的内存库；`memory_install.machine_id` 需要先有一台 machine。 */
function setup(): DatabaseConnection["db"] {
  connection = openDatabase(":memory:");
  connection.sqlite.pragma("foreign_keys = OFF");
  migrate(connection.db, { migrationsFolder: "drizzle" });
  connection.sqlite.exec(`
    INSERT INTO user(id,name,email,email_verified,created_at,updated_at)
      VALUES ('human','Human','memory-install@example.test',0,1,1);
    INSERT INTO machine(id,name,created_by,created_at,updated_at)
      VALUES ('machine','Machine','human',1,1);
  `);
  connection.sqlite.pragma("foreign_keys = ON");
  dataDir = mkdtempSync(join(tmpdir(), "memory-install-"));
  return connection.db;
}

const targetDir = () => join(dataDir!, "extensions", "hindsight", HINDSIGHT_EXTENSION_VERSION);
const entryPath = () => join(targetDir(), "package", "dist", "pi.js");
const lockPath = () =>
  join(dataDir!, "extensions", "hindsight", `${HINDSIGHT_EXTENSION_VERSION}.lock`);

describe("provisionMemoryExtension", () => {
  it("installs the bundle, records ready, and skips the second fetch", async () => {
    const db = setup();
    const fixture = buildFixture();
    let fetches = 0;
    const fetchImpl: MemoryFetch = async () => {
      fetches += 1;
      return responseOf(fixture.tarball);
    };

    const result = await provisionMemoryExtension({
      db,
      machineId: "machine",
      dataDir,
      fetchImpl,
      integrity: fixture.integrity,
    });

    expect(result).toEqual({ path: entryPath(), version: HINDSIGHT_EXTENSION_VERSION });
    expect(existsSync(entryPath())).toBe(true);
    const row = readMemoryInstall(db, "machine");
    expect(row).toMatchObject({
      machineId: "machine",
      component: "hindsight-extension",
      version: HINDSIGHT_EXTENSION_VERSION,
      status: "ready",
      error: null,
    });

    const second = await provisionMemoryExtension({
      db,
      machineId: "machine",
      dataDir,
      fetchImpl,
      integrity: fixture.integrity,
    });
    expect(second.path).toBe(entryPath());
    expect(fetches).toBe(1);
  });

  it("installs from a local tarball without fetching", async () => {
    const db = setup();
    const fixture = buildFixture();
    const tarballPath = join(dataDir!, "fixture.tgz");
    writeFileSync(tarballPath, fixture.tarball);
    const fetchImpl: MemoryFetch = async () => {
      throw new Error("must not fetch");
    };

    const result = await provisionMemoryExtension({
      db,
      machineId: "machine",
      dataDir,
      tarballPath,
      fetchImpl,
      integrity: fixture.integrity,
    });

    expect(result.path).toBe(entryPath());
    expect(readMemoryInstall(db, "machine")?.status).toBe("ready");
  });

  it("replaces a corrupt target instead of failing with ENOTEMPTY", async () => {
    const db = setup();
    const fixture = buildFixture();
    mkdirSync(join(targetDir(), "package"), { recursive: true });
    writeFileSync(join(targetDir(), "package", "package.json"), "{not json");

    const result = await provisionMemoryExtension({
      db,
      machineId: "machine",
      dataDir,
      fetchImpl: async () => responseOf(fixture.tarball),
      integrity: fixture.integrity,
    });

    expect(result.path).toBe(entryPath());
    expect(readMemoryInstall(db, "machine")?.status).toBe("ready");
  });

  it("cancels the response body when the download is rejected early", async () => {
    const db = setup();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl: MemoryFetch = async () => new Response(body, { status: 500 });

    await expect(
      provisionMemoryExtension({
        db,
        machineId: "machine",
        dataDir,
        fetchImpl,
        integrity: HINDSIGHT_EXTENSION_INTEGRITY,
      }),
    ).rejects.toMatchObject({ code: "fetch_failed" });
    expect(canceled).toBe(true);
  });

  it("shares one deadline across lock wait and download", async () => {
    const db = setup();
    const fixture = buildFixture();
    mkdirSync(lockPath(), { recursive: true });
    const release = setTimeout(() => rmSync(lockPath(), { recursive: true, force: true }), 20);
    const fetchImpl: MemoryFetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return responseOf(fixture.tarball);
    };

    const started = Date.now();
    await expect(
      provisionMemoryExtension({
        db,
        machineId: "machine",
        dataDir,
        fetchImpl,
        integrity: fixture.integrity,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    clearTimeout(release);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("fails with integrity_mismatch, records failed, and leaves no target", async () => {
    const db = setup();
    const fixture = buildFixture();
    const fetchImpl: MemoryFetch = async () => responseOf(fixture.tarball);
    const wrongIntegrity = `sha512-${Buffer.alloc(64).toString("base64")}`;

    const rejection = provisionMemoryExtension({
      db,
      machineId: "machine",
      dataDir,
      fetchImpl,
      integrity: wrongIntegrity,
    });
    await expect(rejection).rejects.toBeInstanceOf(MemoryInstallError);
    await expect(rejection).rejects.toMatchObject({ code: "integrity_mismatch" });

    expect(existsSync(targetDir())).toBe(false);
    const row = readMemoryInstall(db, "machine");
    expect(row?.status).toBe("failed");
    expect(row?.error).toBeTruthy();
  });

  it("fails with extract_failed when the archive has no pi entry and cleans the temp dir", async () => {
    const db = setup();
    const fixture = buildFixture({ includePi: false });
    const fetchImpl: MemoryFetch = async () => responseOf(fixture.tarball);

    await expect(
      provisionMemoryExtension({
        db,
        machineId: "machine",
        dataDir,
        fetchImpl,
        integrity: fixture.integrity,
      }),
    ).rejects.toMatchObject({ code: "extract_failed" });

    expect(existsSync(targetDir())).toBe(false);
    expect(readMemoryInstall(db, "machine")?.status).toBe("failed");
    expect(
      readdirSync(join(dataDir!, "extensions")).filter((name) =>
        name.startsWith("hindsight-install-"),
      ),
    ).toEqual([]);
  });

  it("shares one fetch between concurrent calls", async () => {
    const db = setup();
    const fixture = buildFixture();
    let fetches = 0;
    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl: MemoryFetch = async () => {
      fetches += 1;
      return gate;
    };

    const first = provisionMemoryExtension({
      db,
      machineId: "machine",
      dataDir,
      fetchImpl,
      integrity: fixture.integrity,
    });
    const second = provisionMemoryExtension({
      db,
      machineId: "machine",
      dataDir,
      fetchImpl,
      integrity: fixture.integrity,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release(responseOf(fixture.tarball));

    const [a, b] = await Promise.all([first, second]);
    expect(fetches).toBe(1);
    expect(a.path).toBe(b.path);
    expect(readMemoryInstall(db, "machine")?.status).toBe("ready");
  });

  it("times out on a hanging fetch and records failed", async () => {
    const db = setup();
    const fixture = buildFixture();
    const fetchImpl: MemoryFetch = () => new Promise<Response>(() => {});

    await expect(
      provisionMemoryExtension({
        db,
        machineId: "machine",
        dataDir,
        fetchImpl,
        integrity: fixture.integrity,
        timeoutMs: 80,
      }),
    ).rejects.toMatchObject({ code: "timeout" });

    expect(existsSync(targetDir())).toBe(false);
    expect(readMemoryInstall(db, "machine")?.status).toBe("failed");
  });

  it("takes over a stale lock and proceeds", async () => {
    const db = setup();
    const fixture = buildFixture();
    const fetchImpl: MemoryFetch = async () => responseOf(fixture.tarball);
    mkdirSync(lockPath(), { recursive: true });
    const stale = new Date(Date.now() - 11 * 60_000);
    utimesSync(lockPath(), stale, stale);

    const result = await provisionMemoryExtension({
      db,
      machineId: "machine",
      dataDir,
      fetchImpl,
      integrity: fixture.integrity,
      timeoutMs: 5000,
    });

    expect(existsSync(result.path)).toBe(true);
    expect(readMemoryInstall(db, "machine")?.status).toBe("ready");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("waits for a fresh lock and then honors it", async () => {
    const db = setup();
    const fixture = buildFixture();
    const fetchImpl: MemoryFetch = async () => responseOf(fixture.tarball);
    mkdirSync(lockPath(), { recursive: true });
    const started = Date.now();
    const timer = setTimeout(() => rmSync(lockPath(), { recursive: true, force: true }), 150);

    try {
      const result = await provisionMemoryExtension({
        db,
        machineId: "machine",
        dataDir,
        fetchImpl,
        integrity: fixture.integrity,
        timeoutMs: 5000,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      expect(existsSync(result.path)).toBe(true);
      expect(readMemoryInstall(db, "machine")?.status).toBe("ready");
    } finally {
      clearTimeout(timer);
    }
  });

  it("fails with locked when a fresh lock never releases", async () => {
    const db = setup();
    const fixture = buildFixture();
    const fetchImpl: MemoryFetch = async () => responseOf(fixture.tarball);
    mkdirSync(lockPath(), { recursive: true });

    try {
      await expect(
        provisionMemoryExtension({
          db,
          machineId: "machine",
          dataDir,
          fetchImpl,
          integrity: fixture.integrity,
          timeoutMs: 120,
        }),
      ).rejects.toMatchObject({ code: "locked" });
      expect(readMemoryInstall(db, "machine")?.status).toBe("failed");
    } finally {
      rmSync(lockPath(), { recursive: true, force: true });
    }
  });

  it("returns null when no install row exists", () => {
    const db = setup();
    expect(readMemoryInstall(db, "machine")).toBeNull();
  });

  it("rejects an installed directory whose package version drifted", async () => {
    const db = setup();
    const fixture = buildFixture({ version: "0.8.6" });
    const fetchImpl: MemoryFetch = async () => responseOf(fixture.tarball);

    await expect(
      provisionMemoryExtension({
        db,
        machineId: "machine",
        dataDir,
        fetchImpl,
        integrity: fixture.integrity,
      }),
    ).rejects.toMatchObject({ code: "extract_failed" });
  });
});
