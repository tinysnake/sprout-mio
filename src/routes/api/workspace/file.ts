import { createFileRoute } from "@tanstack/react-router";
import { readWorkspaceFileBoundary } from "../../../server/functions/workspace";
import { getRequestContext, REQUEST_ID_HEADER } from "../../../server/request-context";

const STATUS_BY_CODE: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
};

/**
 * 自己写出来的 HTML/SVG 里可能有脚本。响应带 `sandbox` 指令后浏览器用独立源渲染它，
 * 脚本拿不到 app 的 cookie 与同源接口；不注入这一条，直接打开文件就等于把 XSS 交给工作区作者。
 */
const SANDBOXED_CSP =
  "sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

export async function workspaceFileResponse(request: Request): Promise<Response> {
  const { requestId } = getRequestContext(request);
  const url = new URL(request.url);
  const result = await readWorkspaceFileBoundary(
    {
      projectId: url.searchParams.get("projectId") ?? "",
      ...(url.searchParams.get("chatId")
        ? { chatId: url.searchParams.get("chatId") as string }
        : {}),
      path: url.searchParams.get("path") ?? "",
    },
    request.headers,
    requestId,
  );
  if (!result.ok)
    return Response.json(result, {
      status: STATUS_BY_CODE[result.error.code] ?? 500,
      headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "private, no-store" },
    });
  const file = result.data;
  const sandboxed =
    file.contentType.startsWith("text/html") || file.contentType === "image/svg+xml";
  return new Response(file.body as BodyInit, {
    status: file.status,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      "content-type": file.contentType,
      "content-length": String(file.length),
      "cache-control": "private, no-cache",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
      ...(file.contentRange ? { "content-range": file.contentRange } : {}),
      ...(sandboxed ? { "content-security-policy": SANDBOXED_CSP } : {}),
    },
  });
}

export const Route = createFileRoute("/api/workspace/file")({
  server: { handlers: { GET: ({ request }) => workspaceFileResponse(request) } },
});
