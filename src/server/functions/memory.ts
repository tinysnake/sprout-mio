import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { saveMemoryConfigInput, type MemorySettingsView } from "../../contracts/memory";
import { fieldErrorsFrom, projectIdInput, type ProjectResult } from "../../contracts/project";
import { fail, ok, toAppError } from "../../contracts/result";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

async function serverDeps() {
  const [authModule, access, domain, settings, database, environment, installer] =
    await Promise.all([
      import("../session"),
      import("../../domain/access"),
      import("../../domain/memory-config"),
      import("../memory-settings"),
      import("../../db"),
      import("../../lib/config"),
      import("../memory-install"),
    ]);
  return {
    requireSession: authModule.requireSession,
    ...access,
    ...domain,
    ...settings,
    settingsDeps: {
      db: database.db,
      machineId: environment.config.SPROUT_PI_MACHINE_ID ?? null,
      dataDir: environment.config.SPROUT_PI_DATA_DIR,
      now: Date.now,
      provision: installer.provisionMemoryExtension,
    },
  };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;

async function memoryBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
  save: boolean,
): Promise<ProjectResult<MemorySettingsView>> {
  let recordDiagnostic: ((input: DiagnosticInput) => boolean) | undefined;
  try {
    ({ recordDiagnostic } = await import("../diagnostics"));
    const deps: ServerDeps = await serverDeps();
    const session = await deps.requireSession(headers, requestId);
    if (!session.ok) return session;
    const context = { userId: session.data.userId, requestId };
    deps.assertMemoryConfigHuman(context);
    const input = save ? saveMemoryConfigInput.parse(raw) : projectIdInput.parse(raw);
    deps.assertProjectAccess(context, input.projectId);
    return ok(
      save
        ? deps.saveMemorySettings(deps.settingsDeps, input, context)
        : deps.getMemorySettings(deps.settingsDeps, input.projectId),
      requestId,
    );
  } catch (error) {
    if (error instanceof z.ZodError)
      return { ...fail(toAppError(error, requestId)), fieldErrors: fieldErrorsFrom(error) };
    const { MemoryConfigError } = await import("../../domain/memory-config");
    if (error instanceof MemoryConfigError)
      return fail({ code: error.code, message: error.message, requestId });
    const mapped = await toDomainAppError(error, requestId);
    if (mapped) return fail(mapped);
    console.error("[memory] 设置请求失败", { requestId });
    recordDiagnostic?.({
      level: "error",
      event: "memory.request_failed",
      requestId,
      message: "记忆设置请求失败",
      data: { code: "internal" },
    });
    return fail({ code: "internal", message: "内部错误", requestId });
  }
}

export function getMemoryConfigBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<MemorySettingsView>> {
  return memoryBoundary(raw, headers, requestId, false);
}

export function saveMemoryConfigBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<MemorySettingsView>> {
  return memoryBoundary(raw, headers, requestId, true);
}

export const getMemoryConfigFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(({ data }) =>
    getMemoryConfigBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const saveMemoryConfigFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(({ data }) =>
    saveMemoryConfigBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
