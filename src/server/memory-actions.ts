import { and, eq } from "drizzle-orm";
import {
  clearMemoryInput,
  memorySecretsSchema,
  memorySettingsSchema,
  resolveApiUrl,
  resolveBankTarget,
  type ClearMemoryResult,
  type MemoryActionFailure,
  type RetryMemoryInstallResult,
  type TestMemoryConnectionResult,
} from "../contracts/memory";
import { memoryConfig, project } from "../db/schema";
import type { ProjectContext } from "../domain/access";
import { assertMemoryConfigHuman, MemoryConfigError } from "../domain/memory-config";
import { readMemoryInstall } from "./memory-install";
import type { MemorySettingsDependencies } from "./memory-settings";

export type MemoryActionsDependencies = MemorySettingsDependencies & {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function authorize(deps: MemorySettingsDependencies, projectId: string, context: ProjectContext) {
  assertMemoryConfigHuman(context);
  const row = deps.db.select().from(project).where(eq(project.id, projectId)).get();
  if (!row || row.createdBy !== context.userId)
    throw new MemoryConfigError("forbidden", "无权访问此 Project");
  return row;
}

function target(deps: MemoryActionsDependencies, projectId: string) {
  const row = deps.db
    .select()
    .from(memoryConfig)
    .where(and(eq(memoryConfig.projectId, projectId), eq(memoryConfig.provider, "hindsight")))
    .get();
  const settings = memorySettingsSchema.parse(row?.settings ?? {});
  const { apiToken } = memorySecretsSchema.parse(row?.secrets ?? {});
  const headers: Record<string, string> = apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
  return {
    apiUrl: resolveApiUrl(settings, process.env).replace(/\/+$/, ""),
    bankPath: `/v1/default/banks/${encodeURIComponent(resolveBankTarget(settings, projectId).bankId)}`,
    headers,
  };
}

function httpFailure(status: number): MemoryActionFailure {
  if (status === 401)
    return { ok: false, code: "unauthorized", status, message: "记忆服务鉴权失败" };
  if (status === 403) return { ok: false, code: "forbidden", status, message: "记忆服务拒绝访问" };
  return { ok: false, code: "server_error", status, message: "记忆服务请求失败" };
}

async function withRequests<T>(
  deps: MemoryActionsDependencies,
  projectId: string,
  timeoutMs: number,
  operation: (
    request: (path: string, method?: string) => Promise<Response>,
    bankPath: string,
  ) => Promise<T>,
): Promise<T | MemoryActionFailure> {
  const { apiUrl, bankPath, headers } = target(deps, projectId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? timeoutMs);
  try {
    return await operation(
      (path, method = "GET") =>
        (deps.fetch ?? fetch)(`${apiUrl}${path}`, {
          method,
          headers: method === "PUT" ? { ...headers, "Content-Type": "application/json" } : headers,
          ...(method === "PUT" ? { body: "{}" } : {}),
          signal: controller.signal,
        }),
      bankPath,
    );
  } catch {
    return { ok: false, code: "unreachable", message: "无法连接记忆服务或请求已超时" };
  } finally {
    clearTimeout(timer);
  }
}

export async function testMemoryConnection(
  deps: MemoryActionsDependencies,
  projectId: string,
  context: ProjectContext,
): Promise<TestMemoryConnectionResult> {
  authorize(deps, projectId, context);
  return withRequests(deps, projectId, 5_000, async (request, bankPath) => {
    const version = await request("/version");
    if (!version.ok) return httpFailure(version.status);
    const bank = await request(bankPath);
    if (bank.ok) return { ok: true, bankExists: true, created: false };
    if (bank.status !== 404) return httpFailure(bank.status);
    const created = await request(bankPath, "PUT");
    if (!created.ok) return httpFailure(created.status);
    const confirmed = await request(bankPath);
    if (!confirmed.ok) return httpFailure(confirmed.status);
    return { ok: true, bankExists: true, created: true };
  });
}

export async function clearMemory(
  deps: MemoryActionsDependencies,
  raw: unknown,
  context: ProjectContext,
): Promise<ClearMemoryResult> {
  assertMemoryConfigHuman(context);
  const input = clearMemoryInput.parse(raw);
  const row = authorize(deps, input.projectId, context);
  if (input.confirmName !== row.name)
    throw new MemoryConfigError("validation_failed", "确认名称必须与 Project 名称一致");
  return withRequests(deps, input.projectId, 10_000, async (request, bankPath) => {
    const deleted = await request(bankPath, "DELETE");
    if (!deleted.ok && deleted.status !== 404) return httpFailure(deleted.status);
    const created = await request(bankPath, "PUT");
    return created.ok ? { ok: true } : httpFailure(created.status);
  });
}

export function retryMemoryInstall(
  deps: MemorySettingsDependencies,
  projectId: string,
  context: ProjectContext,
): RetryMemoryInstallResult {
  authorize(deps, projectId, context);
  if (!deps.machineId)
    throw new MemoryConfigError(
      "validation_failed",
      "当前服务未绑定 Machine，无法重试安装记忆组件",
    );
  try {
    void deps
      .provision({ db: deps.db, machineId: deps.machineId, dataDir: deps.dataDir, now: deps.now })
      .catch(() => console.error("[memory] 重试安装失败", { machineId: deps.machineId }));
  } catch {
    console.error("[memory] 重试安装启动失败", { machineId: deps.machineId });
  }
  const install = readMemoryInstall(deps.db, deps.machineId);
  return {
    machineId: deps.machineId,
    install: install
      ? { status: install.status, version: install.version, error: install.error }
      : null,
  };
}
