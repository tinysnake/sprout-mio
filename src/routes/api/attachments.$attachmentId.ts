import { createFileRoute } from "@tanstack/react-router";
import { readAttachmentBoundary } from "../../server/functions/attachment";
import { getRequestContext, REQUEST_ID_HEADER } from "../../server/request-context";

// 读取路由要保留边界给出的状态：未登录是 401，越权是 403，缺失是 404。
const STATUS_BY_CODE: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
};

export async function attachmentReadResponse(
  request: Request,
  attachmentId: string,
): Promise<Response> {
  const { requestId } = getRequestContext(request);
  const headers = { [REQUEST_ID_HEADER]: requestId, "cache-control": "private, max-age=300" };
  const result = await readAttachmentBoundary(attachmentId, request.headers, requestId);
  if (!result.ok)
    return Response.json(result, { status: STATUS_BY_CODE[result.error.code] ?? 500, headers });
  return new Response(result.data.bytes, {
    headers: {
      ...headers,
      "content-type": result.data.contentType,
      "content-length": String(result.data.byteSize),
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(result.data.filename)}`,
      "x-content-type-options": "nosniff",
    },
  });
}

export const Route = createFileRoute("/api/attachments/$attachmentId")({
  server: {
    handlers: {
      GET: ({ request, params }) => attachmentReadResponse(request, params.attachmentId),
    },
  },
});
