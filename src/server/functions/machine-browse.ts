import { fail, ok } from "../../contracts/result";
import type { AppResult } from "../../contracts/result";
import { machineBrowseInput } from "../../contracts/machine-browse";
import type { MachineFile } from "../machine-browse";
import type { MachineTree } from "../../contracts/machine-browse";
import { machineRuntimeContext } from "../runtime";

/**
 * 浏览走会话与 Project 双重鉴权，和租约无关：租约围的是远端副作用，
 * 审核发生在 agent 结束之后，那时不该还有租约存在。
 */
async function context(projectId: string, headers: Headers, requestId: string) {
  const { requireSession } = await import("../session");
  const runtime = await machineRuntimeContext();
  const authenticated = await requireSession(headers, requestId);
  if (!authenticated.ok) return authenticated;
  return ok(
    {
      ctx: {
        userId: authenticated.data.userId,
        requestId,
        bootId: runtime.bootId,
        now: runtime.now,
      },
      projectId,
    },
    requestId,
  );
}

export async function listMachineTreeBoundary(
  input: unknown,
  headers: Headers,
  requestId: string,
): Promise<AppResult<MachineTree>> {
  try {
    const parsed = machineBrowseInput.safeParse(input);
    if (!parsed.success) return fail({ code: "validation_failed", message: "参数无效", requestId });
    const authorized = await context(parsed.data.projectId, headers, requestId);
    if (!authorized.ok) return authorized;
    const { readMachineTree } = await import("../machine-browse");
    const tree = await readMachineTree(authorized.data.ctx, parsed.data);
    return ok(tree, requestId);
  } catch (error) {
    return await toFailure(error, requestId);
  }
}

export async function readMachineFileBoundary(
  input: unknown,
  headers: Headers,
  requestId: string,
  rangeHeader: string | null,
): Promise<AppResult<MachineFile>> {
  try {
    const parsed = machineBrowseInput.safeParse(input);
    if (!parsed.success) return fail({ code: "validation_failed", message: "参数无效", requestId });
    const authorized = await context(parsed.data.projectId, headers, requestId);
    if (!authorized.ok) return authorized;
    const { openMachineFile } = await import("../machine-browse");
    const file = await openMachineFile(authorized.data.ctx, parsed.data, rangeHeader);
    return ok(file, requestId);
  } catch (error) {
    return await toFailure(error, requestId);
  }
}

async function toFailure(error: unknown, requestId: string): Promise<AppResult<never>> {
  const { MachineFileTooLargeError, MachineRangeError } = await import("../machine-browse");
  // 越界与超限由路由翻译成 416/413：它们是 HTTP 语义，不是应用的错误码。
  if (error instanceof MachineRangeError || error instanceof MachineFileTooLargeError) throw error;
  const { toDomainAppError } = await import("./domain-errors");
  const mapped = await toDomainAppError(error, requestId);
  if (mapped) return fail(mapped);
  console.error("[machine-browse] 读取失败", { requestId, error });
  return fail({ code: "internal", message: "内部错误", requestId });
}
