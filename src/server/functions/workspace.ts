import { fail, ok } from "../../contracts/result";
import type { AppResult } from "../../contracts/result";
import { workspaceFileInput, workspaceTreeInput } from "../../contracts/workspace";
import type { WorkspaceTree } from "../../contracts/workspace";
import type { ActiveWorkspaceRoot, WorkspaceFile } from "../../domain/workspace";
import type { ProjectContext } from "../../domain/access";

/**
 * 浏览走路由会话与 Project 双重鉴权，和租约无关：租约围的是远端副作用，
 * 而这里读的是服务端自己磁盘上的工作区。跨 Project 一律当作不存在。
 */
async function authorize(
  projectId: string,
  chatId: string | undefined,
  headers: Headers,
  requestId: string,
): Promise<AppResult<{ root: ActiveWorkspaceRoot; ctx: ProjectContext }>> {
  const [runtime, session, workspace] = await Promise.all([
    import("../runtime"),
    import("../session"),
    import("../../domain/workspace"),
  ]);
  await runtime.runtimeReady;
  const authenticated = await session.requireSession(headers, requestId);
  if (!authenticated.ok) return authenticated;
  const ctx = { userId: authenticated.data.userId, requestId };
  const root = workspace.resolveWorkspaceRoot(projectId, chatId, ctx);
  if (!root) return fail({ code: "not_found", message: "这个对话还没有工作区", requestId });
  return ok({ root, ctx }, requestId);
}

export async function listWorkspaceBoundary(
  input: unknown,
  headers: Headers,
  requestId: string,
): Promise<AppResult<WorkspaceTree>> {
  try {
    const parsed = workspaceTreeInput.safeParse(input);
    if (!parsed.success) return fail({ code: "validation_failed", message: "参数无效", requestId });
    const authorized = await authorize(
      parsed.data.projectId,
      parsed.data.chatId,
      headers,
      requestId,
    );
    if (!authorized.ok) return authorized;
    const { listWorkspaceTree } = await import("../../domain/workspace");
    const tree = await listWorkspaceTree(authorized.data.root, parsed.data.path);
    return ok(tree, requestId);
  } catch (error) {
    return await toFailure(error, requestId);
  }
}

export async function readWorkspaceFileBoundary(
  input: unknown,
  headers: Headers,
  requestId: string,
): Promise<AppResult<WorkspaceFile>> {
  try {
    const parsed = workspaceFileInput.safeParse(input);
    if (!parsed.success) return fail({ code: "validation_failed", message: "参数无效", requestId });
    const authorized = await authorize(
      parsed.data.projectId,
      parsed.data.chatId,
      headers,
      requestId,
    );
    if (!authorized.ok) return authorized;
    const { openWorkspaceFile } = await import("../../domain/workspace");
    const file = await openWorkspaceFile(
      authorized.data.root,
      parsed.data.path,
      headers.get("range"),
    );
    return ok(file, requestId);
  } catch (error) {
    return await toFailure(error, requestId);
  }
}

async function toFailure(error: unknown, requestId: string): Promise<AppResult<never>> {
  const { toDomainAppError } = await import("./domain-errors");
  const mapped = await toDomainAppError(error, requestId);
  if (mapped) return fail(mapped);
  console.error("[workspace] 读取失败", { requestId, error });
  return fail({ code: "internal", message: "内部错误", requestId });
}
