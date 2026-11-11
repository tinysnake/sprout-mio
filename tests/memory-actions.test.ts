import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HINDSIGHT_EXTENSION_VERSION } from "../src/contracts/memory";
import { saveMemoryConfig } from "../src/domain/memory-config";
import type { MemoryActionsDependencies } from "../src/server/memory-actions";

const directory = mkdtempSync(join(tmpdir(), "memory-actions-"));
vi.stubEnv("DATABASE_URL", join(directory, "test.sqlite"));
vi.stubEnv("SPROUT_PI_ENABLED", "false");
vi.stubEnv("SPROUT_PI_DATA_DIR", directory);
vi.stubEnv("SPROUT_PI_MACHINE_ID", undefined);
vi.stubEnv("SPROUT_HINDSIGHT_API_URL", "");
vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
const { clearMemory, retryMemoryInstall, testMemoryConnection } =
  await import("../src/server/memory-actions");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { db, sqlite } = await import("../src/db");
const { auth } = await import("../src/lib/auth");
const functions = await import("../src/server/functions/memory");
const diagnostics = await import("../src/server/diagnostics");

async function human(name: string) {
  const result = await auth.api.signUpEmail({
    body: { name, email: `${name}@example.test`, password: "memory-actions-password-123" },
    returnHeaders: true,
  });
  return {
    userId: result.response.user.id,
    headers: new Headers({ cookie: result.headers.get("set-cookie")!.split(";")[0]! }),
  };
}
const owner = await human("memory-actions-owner");
const other = await human("memory-actions-other");
sqlite
  .prepare("INSERT INTO project(id,name,created_by) VALUES ('prj_deadbeef','Sprout Mio',?)")
  .run(owner.userId);
sqlite
  .prepare(
    "INSERT INTO machine(id,name,created_by,created_at,updated_at) VALUES ('machine','Machine',?,1,1)",
  )
  .run(owner.userId);
const context = { userId: owner.userId, requestId: "req_actions" };
const bankUrl = "https://memory.example.test/v1/default/banks/project%3A%3Aprj_deadbeef";
const fetchMock = vi.fn<typeof fetch>();
const provision = vi.fn<MemoryActionsDependencies["provision"]>();
const deps: MemoryActionsDependencies = {
  db,
  machineId: "machine",
  dataDir: directory,
  now: () => 100,
  fetch: fetchMock,
  provision,
};

beforeEach(() => {
  sqlite.exec("DELETE FROM memory_config; DELETE FROM memory_install;");
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => {
    throw new Error("Unexpected fetch");
  });
  provision.mockReset();
  provision.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchMock);
  saveMemoryConfig(
    db,
    {
      projectId: "prj_deadbeef",
      provider: "hindsight",
      revision: 0,
      enabled: false,
      settings: { apiUrl: "https://memory.example.test/", bankPrefix: "project" },
      secrets: { apiToken: "private-action-token" },
    },
    owner.userId,
    1,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function responses(...statuses: number[]) {
  for (const status of statuses) fetchMock.mockResolvedValueOnce(new Response(null, { status }));
}
function requests() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    method: init?.method,
    body: init?.body,
    headers: init?.headers,
  }));
}
const getVersion = {
  url: "https://memory.example.test/version",
  method: "GET",
  body: undefined,
  headers: { Authorization: "Bearer private-action-token" },
};
const getBank = { ...getVersion, url: bankUrl };
const putBank = {
  ...getBank,
  method: "PUT",
  body: "{}",
  headers: { ...getVersion.headers, "Content-Type": "application/json" },
};
const clearInput = { projectId: "prj_deadbeef", confirmName: "Sprout Mio" };

describe("memory actions", () => {
  it("checks version then the encoded bank even when memory is disabled", async () => {
    responses(200, 200);
    expect(await testMemoryConnection(deps, "prj_deadbeef", context)).toEqual({
      ok: true,
      bankExists: true,
      created: false,
    });
    expect(requests()).toEqual([getVersion, getBank]);
  });
  it("creates a missing bank and confirms it with GET", async () => {
    responses(200, 404, 201, 200);
    expect(await testMemoryConnection(deps, "prj_deadbeef", context)).toEqual({
      ok: true,
      bankExists: true,
      created: true,
    });
    expect(requests()).toEqual([getVersion, getBank, putBank, getBank]);
  });
  it.each([
    { status: 401, code: "unauthorized" },
    { status: 403, code: "forbidden" },
    { status: 503, code: "server_error" },
  ])("classifies $status at every connection step and stops", async ({ status, code }) => {
    for (const prefix of [[], [200], [200, 404], [200, 404, 201]]) {
      fetchMock.mockClear();
      responses(...prefix, status);
      expect(await testMemoryConnection(deps, "prj_deadbeef", context)).toMatchObject({
        ok: false,
        code,
        status,
        message: expect.any(String),
      });
      expect(fetchMock).toHaveBeenCalledTimes(prefix.length + 1);
    }
  });
  it("reports unreachable without echoing fetch errors or tokens", async () => {
    fetchMock.mockRejectedValueOnce(new Error("private-action-token"));
    const result = await testMemoryConnection(deps, "prj_deadbeef", context);
    expect(result).toMatchObject({ ok: false, code: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("private-action-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("omits Authorization for empty tokens and resolves the configured environment URL", async () => {
    sqlite.exec("UPDATE memory_config SET settings='{}',secrets='{}'");
    vi.stubEnv("SPROUT_HINDSIGHT_API_URL", "https://environment.example.test/");
    try {
      responses(200, 200);
      await testMemoryConnection(deps, "prj_deadbeef", context);
      expect(requests()).toEqual([
        {
          url: "https://environment.example.test/version",
          method: "GET",
          body: undefined,
          headers: {},
        },
        {
          url: "https://environment.example.test/v1/default/banks/sprout%3A%3Aprj_deadbeef",
          method: "GET",
          body: undefined,
          headers: {},
        },
      ]);
    } finally {
      vi.stubEnv("SPROUT_HINDSIGHT_API_URL", "");
    }
  });
  it.each([200, 404])("deletes ($status) and rebuilds an empty bank", async (status) => {
    responses(status, 201);
    expect(await clearMemory(deps, clearInput, context)).toEqual({ ok: true });
    expect(requests()).toEqual([{ ...getBank, method: "DELETE" }, putBank]);
  });
  it("rejects a mismatched confirmation before fetch", async () => {
    await expect(
      clearMemory(deps, { ...clearInput, confirmName: "Sprout Mio " }, context),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("stops on delete failure and reports rebuild failure", async () => {
    responses(403);
    expect(await clearMemory(deps, clearInput, context)).toMatchObject({
      ok: false,
      code: "forbidden",
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    responses(204, 500);
    expect(await clearMemory(deps, clearInput, context)).toMatchObject({
      ok: false,
      code: "server_error",
      status: 500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it.each([
    { action: "connection", timeout: 5_000 },
    { action: "clear", timeout: 10_000 },
  ])("aborts $action after its default timeout", async ({ action, timeout }) => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const result =
      action === "connection"
        ? testMemoryConnection(deps, "prj_deadbeef", context)
        : clearMemory(deps, clearInput, context);
    const signal = fetchMock.mock.calls[0]![1]!.signal!;
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(await result).toMatchObject({ ok: false, code: "unreachable" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("starts provision once for the bound Machine and returns before it settles", () => {
    provision.mockImplementationOnce(async () => {
      sqlite
        .prepare(
          "INSERT INTO memory_install(machine_id,component,status,version,updated_at_ms) VALUES ('machine','hindsight-extension','installing',?,100)",
        )
        .run(HINDSIGHT_EXTENSION_VERSION);
      await new Promise(() => {});
    });
    expect(retryMemoryInstall(deps, "prj_deadbeef", context)).toEqual({
      machineId: "machine",
      install: { status: "installing", version: HINDSIGHT_EXTENSION_VERSION, error: null },
    });
    expect(provision).toHaveBeenCalledExactlyOnceWith({
      db,
      machineId: "machine",
      dataDir: directory,
      now: deps.now,
    });
  });
  it("rejects an unbound Machine and handles an asynchronous install failure", async () => {
    expect(() => retryMemoryInstall({ ...deps, machineId: null }, "prj_deadbeef", context)).toThrow(
      "未绑定 Machine",
    );
    expect(provision).not.toHaveBeenCalled();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    provision.mockRejectedValueOnce(new Error("private-action-token"));
    retryMemoryInstall(deps, "prj_deadbeef", context);
    await Promise.resolve();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-action-token");
  });
});

describe("memory action boundaries", () => {
  const boundaries = [
    functions.testMemoryConnectionBoundary,
    functions.clearMemoryBoundary,
    functions.retryMemoryInstallBoundary,
  ];
  it("denies unauthenticated and Agent Bearer callers and other Projects before side effects", async () => {
    for (const boundary of boundaries) {
      for (const headers of [
        new Headers(),
        new Headers({ authorization: "Bearer agent-token" }),
        other.headers,
      ]) {
        expect(await boundary(clearInput, headers, "req_denied")).toMatchObject({
          ok: false,
          error: { code: headers === other.headers ? "not_found" : "unauthorized" },
        });
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });
  it("returns action data, validates confirmation and reports an unbound Machine", async () => {
    responses(200, 200);
    expect(
      await functions.testMemoryConnectionBoundary(
        { projectId: "prj_deadbeef" },
        owner.headers,
        "req_test",
      ),
    ).toMatchObject({ ok: true, data: { ok: true, bankExists: true, created: false } });
    responses(404, 201);
    expect(
      await functions.clearMemoryBoundary(clearInput, owner.headers, "req_clear"),
    ).toMatchObject({ ok: true, data: { ok: true } });
    expect(
      await functions.clearMemoryBoundary(
        { ...clearInput, confirmName: "wrong" },
        owner.headers,
        "req_clear",
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    expect(
      await functions.retryMemoryInstallBoundary(
        { projectId: "prj_deadbeef" },
        owner.headers,
        "req_retry",
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "validation_failed", message: expect.stringContaining("未绑定 Machine") },
    });
    expect(
      await functions.clearMemoryBoundary(
        { projectId: "prj_deadbeef" },
        owner.headers,
        "req_invalid",
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
      fieldErrors: expect.any(Object),
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it("records remote failure diagnostics without response bodies or credentials", async () => {
    const record = vi.spyOn(diagnostics, "recordDiagnostic");
    fetchMock.mockResolvedValueOnce(new Response("private-action-token", { status: 401 }));
    const result = await functions.testMemoryConnectionBoundary(
      { projectId: "prj_deadbeef" },
      owner.headers,
      "req_diagnostic",
    );
    expect(result).toMatchObject({
      ok: true,
      data: { ok: false, code: "unauthorized", status: 401 },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "memory.action_failed",
        requestId: "req_diagnostic",
        projectId: "prj_deadbeef",
        data: { action: "testMemoryConnection", code: "unauthorized", status: 401 },
      }),
    );
    expect(JSON.stringify([result, record.mock.calls])).not.toContain("private-action-token");
  });
});
