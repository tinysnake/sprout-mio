import { afterAll, expect, it, vi } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "memory-boundary-"));
vi.stubEnv("DATABASE_URL", join(directory, "test.sqlite"));
vi.stubEnv("SPROUT_PI_ENABLED", "false");
vi.stubEnv("SPROUT_PI_DATA_DIR", directory);
vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../src/db");
const { auth } = await import("../src/lib/auth");
const { createProject } = await import("../src/domain/project");
const settings = await import("../src/server/memory-settings");
const functions = await import("../src/server/functions/memory");
const diagnostics = await import("../src/server/diagnostics");

async function human(name: string) {
  const result = await auth.api.signUpEmail({
    body: { name, email: `${name}@example.test`, password: "memory-test-password" },
    returnHeaders: true,
  });
  const cookie = result.headers.get("set-cookie")!.split(";")[0]!;
  return { userId: result.response.user.id, headers: new Headers({ cookie }) };
}
const owner = await human("memory-owner");
const other = await human("memory-other");
const project = createProject({ name: "Memory" }, { userId: owner.userId, requestId: "req_setup" });
const draft = {
  projectId: project.id,
  provider: "hindsight",
  enabled: false,
  settings: {},
  revision: 0,
  secrets: { apiToken: "private-boundary-token" },
};

afterAll(() => {
  vi.restoreAllMocks();
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("requires a Human session for reads and saves, including Agent Bearer callers", async () => {
  for (const headers of [new Headers(), new Headers({ authorization: "Bearer agent-token" })]) {
    for (const boundary of [
      functions.getMemoryConfigBoundary,
      functions.saveMemoryConfigBoundary,
    ]) {
      expect(await boundary(draft, headers, "req_denied")).toMatchObject({
        ok: false,
        error: { code: "unauthorized", requestId: "req_denied" },
      });
    }
  }
  expect(await functions.saveMemoryConfigBoundary(draft, other.headers, "req_other")).toMatchObject(
    { ok: false, error: { code: "not_found" } },
  );
  expect(
    await functions.getMemoryConfigBoundary({ projectId: project.id }, other.headers, "req_other"),
  ).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(sqlite.prepare("SELECT count(*) AS n FROM memory_config").get()).toEqual({ n: 0 });
});

it("returns a masked view and preserves domain conflict codes at the boundary", async () => {
  expect(
    await functions.getMemoryConfigBoundary({ projectId: project.id }, owner.headers, "req_read"),
  ).toMatchObject({ ok: true, data: { config: null } });
  const saved = await functions.saveMemoryConfigBoundary(draft, owner.headers, "req_save");
  expect(saved).toMatchObject({ ok: true, data: { config: { hasToken: true, revision: 1 } } });
  expect(JSON.stringify(saved)).not.toMatch(/private-boundary-token|apiToken|secrets/);
  expect(await functions.saveMemoryConfigBoundary(draft, owner.headers, "req_stale")).toMatchObject(
    { ok: false, error: { code: "conflict", requestId: "req_stale" } },
  );
  expect(sqlite.prepare("SELECT revision FROM memory_config").get()).toEqual({ revision: 1 });
});

it("reports field validation errors and diagnoses unknown failures without echoing secrets", async () => {
  expect(
    await functions.saveMemoryConfigBoundary(
      { ...draft, revision: -1 },
      owner.headers,
      "req_invalid",
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
    fieldErrors: expect.any(Object),
  });
  const record = vi.spyOn(diagnostics, "recordDiagnostic");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(settings, "getMemorySettings").mockImplementationOnce(() => {
    throw new Error("private-boundary-token");
  });
  const failed = await functions.getMemoryConfigBoundary(
    { projectId: project.id },
    owner.headers,
    "req_failed",
  );
  expect(failed).toMatchObject({ ok: false, error: { code: "internal", requestId: "req_failed" } });
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({ event: "memory.request_failed", requestId: "req_failed" }),
  );
  expect(JSON.stringify([failed, record.mock.calls, consoleError.mock.calls])).not.toContain(
    "private-boundary-token",
  );
});
